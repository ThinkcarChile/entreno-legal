import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "@/integration/harness";
import {
  construirDeclaracionServida,
  VERSION_MOTOR_EXTENT,
  type Extent,
  type RenglonServido,
} from "./extent";

/**
 * EL CONTRATO ENTRE LA PANTALLA Y LA 0038, MEDIDO CONTRA POSTGRES DE VERDAD.
 *
 * El motor puede producir un JSON precioso y la base rechazarlo igual: los
 * renglones declarados pasan por seis CHECK y un trigger (`intake_item_guard`)
 * que no se leen desde TypeScript. Esta prueba manda EXACTAMENTE lo que manda
 * la pantalla y mira qué quedó guardado.
 *
 * Lo que se está defendiendo, y por qué duele si se rompe:
 *   · un «no comió» que se guarde como 0 g le da al motor una medición que
 *     nadie hizo;
 *   · un número derivado sin su versión de motor es un número que mañana no se
 *     puede reinterpretar;
 *   · una versión de motor que la base no acepte deja el camino de un toque
 *     —el de todos los días— reventando en producción.
 */

const USER = "00000000-0000-0000-0000-0000000000e1";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;

/** Un servido real: lote con existencias por el libro mayor + `serve_off_plan`. */
async function servir(gramos: number, etiqueta: string): Promise<string> {
  const lote = await h.comoAdmin(async () => {
    const creado = (await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, unit, quantity, weight_basis, status)
       values ($1, $2, $3, 'G', 0, 'RAW', 'AVAILABLE')
       returning id`,
      [hogar.householdId, polloId, etiqueta],
    ))!.id;
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1, $2, 'PURCHASE', 1000)`,
      [hogar.householdId, creado],
    );
    return creado;
  });

  return h.como(USER, async () => {
    const record = (await h.fila<{ serve_off_plan: string }>(
      "select public.serve_off_plan($1, $2, $3, null::public.meal_type, $4)",
      [hogar.memberId, lote, gramos, etiqueta],
    ))!.serve_off_plan;
    return record;
  });
}

/** El renglón servido tal como lo lee la pantalla, con sus numeric ya en número. */
async function renglonDe(recordId: string): Promise<RenglonServido> {
  const fila = (await h.como(USER, () =>
    h.fila<{
      id: string;
      label: string;
      ingredient_id: string | null;
      product_id: string | null;
      served_quantity: string;
      served_unit: "G" | "ML" | "UNIT";
      served_weight_basis: "RAW";
      deducted_quantity: string;
      discarded_quantity: string;
      sort_order: number;
    }>(
      `select id, label, ingredient_id, product_id, served_quantity, served_unit,
              served_weight_basis, deducted_quantity, discarded_quantity, sort_order
       from public.meal_serving_record_items where record_id = $1`,
      [recordId],
    ),
  ))!;

  return {
    servingRecordItemId: fila.id,
    label: fila.label,
    ingredientId: fila.ingredient_id,
    productId: fila.product_id,
    servido: Number(fila.served_quantity),
    entregado: Number(fila.deducted_quantity),
    botado: Number(fila.discarded_quantity),
    unidad: fila.served_unit,
    baseFisica: fila.served_weight_basis,
    sortOrder: fila.sort_order,
  };
}

/** Manda al RPC exactamente lo que arma la pantalla. */
async function declarar(
  recordId: string,
  renglon: RenglonServido,
  extent: Extent,
  cantidadExacta: number | null = null,
): Promise<string> {
  const armado = construirDeclaracionServida([{ servido: renglon, extent, cantidadExacta }]);
  if (!armado.ok) throw new Error(armado.problemas.join(" / "));
  return (await h.como(USER, () =>
    h.fila<{ log_intake: string }>("select public.log_intake($1, $2::jsonb)", [
      recordId,
      JSON.stringify(armado.items),
    ]),
  ))!.log_intake;
}

async function renglonesGuardados(logId: string) {
  return h.como(USER, () =>
    h.filas<{
      extent: string;
      quantity: string | null;
      unit: string | null;
      quantity_is_declared: boolean;
      extent_engine_version: string | null;
    }>(
      `select extent, quantity, unit, quantity_is_declared, extent_engine_version
       from public.intake_log_items where log_id = $1 order by sort_order`,
      [logId],
    ),
  );
}

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar de la pantalla /comi", "Elena");
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("lo que manda /comi es lo que la 0038 acepta", () => {
  it("«la mitad» guarda un número derivado, marcado como no declarado y con su motor", async () => {
    const record = await servir(200, "Pollo mitad");
    const renglon = await renglonDe(record);
    const log = await declarar(record, renglon, "HALF");

    const [item] = await renglonesGuardados(log);
    expect(item!.extent).toBe("HALF");
    expect(Number(item!.quantity)).toBeCloseTo(100, 3);
    expect(item!.quantity_is_declared).toBe(false);
    expect(item!.extent_engine_version).toBe(VERSION_MOTOR_EXTENT);
  });

  it("«nada» NO se guarda como cero gramos: se guarda sin número", async () => {
    const record = await servir(200, "Pollo nada");
    const renglon = await renglonDe(record);
    const log = await declarar(record, renglon, "NONE");

    const [item] = await renglonesGuardados(log);
    expect(item!.extent).toBe("NONE");
    // Si esto fuera 0, el motor leería una medición donde solo hubo una
    // afirmación — y "nada" pasaría a competir con los gramos de verdad.
    expect(item!.quantity).toBeNull();
  });

  it("«no sé» guarda el hueco explícito, que tampoco es cero", async () => {
    const record = await servir(200, "Pollo no sé");
    const renglon = await renglonDe(record);
    const log = await declarar(record, renglon, "UNKNOWN");

    const [item] = await renglonesGuardados(log);
    expect(item!.extent).toBe("UNKNOWN");
    expect(item!.quantity).toBeNull();
  });

  it("la cantidad exacta queda como dicha por una persona y sin motor detrás", async () => {
    const record = await servir(200, "Pollo exacto");
    const renglon = await renglonDe(record);
    const log = await declarar(record, renglon, "EXACT", 120);

    const [item] = await renglonesGuardados(log);
    expect(Number(item!.quantity)).toBeCloseTo(120, 3);
    expect(item!.quantity_is_declared).toBe(true);
    expect(item!.extent_engine_version).toBeNull();
  });

  it("el número derivado nunca pasa el techo del trigger, ni con merma de por medio", async () => {
    const record = await servir(200, "Pollo con merma");
    const renglonInicial = await renglonDe(record);
    await h.como(USER, () =>
      h.db.query("select public.discard_serving($1, $2, $3)", [
        renglonInicial.servingRecordItemId,
        50,
        "se cayó al suelo",
      ]),
    );

    // Se relee el renglón porque lo botado cambió el techo: 200 servidos menos
    // 50 botados = 150 comibles, y «todo» no puede significar 200.
    const renglon = await renglonDe(record);
    const log = await declarar(record, renglon, "ALL");

    const [item] = await renglonesGuardados(log);
    expect(Number(item!.quantity)).toBeCloseTo(150, 3);
  });

  it("el camino de un toque acepta la versión de motor que manda la pantalla", async () => {
    const record = await servir(200, "Pollo asumido");
    const log = (await h.como(USER, () =>
      h.fila<{ assume_intake_from_plan: string }>(
        "select public.assume_intake_from_plan($1, $2)",
        [record, VERSION_MOTOR_EXTENT],
      ),
    ))!.assume_intake_from_plan;

    const fila = (await h.como(USER, () =>
      h.fila<{ source: string }>("select source from public.consumption_logs where id = $1", [log]),
    ))!;
    // El supuesto queda ETIQUETADO como supuesto: es lo que separa "alguien lo
    // declaró" de "nadie dijo nada y lo dimos por hecho".
    expect(fila.source).toBe("ASSUMED_FROM_PLAN");

    const [item] = await renglonesGuardados(log);
    expect(item!.quantity_is_declared).toBe(false);
    expect(item!.extent_engine_version).toBe(VERSION_MOTOR_EXTENT);
  });

  it("corregir con lo que arma la pantalla supera la versión anterior sin borrarla", async () => {
    const record = await servir(200, "Pollo corregido");
    const renglon = await renglonDe(record);
    const primero = await declarar(record, renglon, "ALL");

    const armado = construirDeclaracionServida([
      { servido: renglon, extent: "HALF", cantidadExacta: null },
    ]);
    if (!armado.ok) throw new Error(armado.problemas.join(" / "));

    const segundo = (await h.como(USER, () =>
      h.fila<{ correct_intake_log: string }>(
        "select public.correct_intake_log($1, $2::jsonb, $3, $4)",
        [
          primero,
          JSON.stringify(armado.items),
          "en realidad comió la mitad",
          "11111111-1111-4111-8111-111111111111",
        ],
      ),
    ))!.correct_intake_log;

    const estados = await h.como(USER, () =>
      h.filas<{ id: string; status: string; supersedes_log_id: string | null }>(
        "select id, status, supersedes_log_id from public.consumption_logs where id in ($1, $2)",
        [primero, segundo],
      ),
    );
    expect(estados.find((e) => e.id === primero)!.status).toBe("CORRECTED");
    expect(estados.find((e) => e.id === segundo)!.status).toBe("ACTIVE");
    expect(estados.find((e) => e.id === segundo)!.supersedes_log_id).toBe(primero);

    const [item] = await renglonesGuardados(segundo);
    expect(item!.extent).toBe("HALF");
    expect(Number(item!.quantity)).toBeCloseTo(100, 3);
  });
});
