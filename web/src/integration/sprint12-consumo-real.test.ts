import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 12 - regresiones de los CUATRO hallazgos ALTO del re-ataque final, y
 * del invariante que los gobierna a todos.
 *
 * Los cuatro comparten una misma forma: el sistema sigue en verde mientras el
 * dato se pierde, se duplica o se fabrica. Ninguno revienta. Por eso ninguno
 * tenia test, y por eso los cuatro volverian en el proximo refactor sin estas
 * pruebas puestas encima.
 *
 *   A1 - la dedupe_key se busca SIN filtro de hogar y la manda el cliente: un
 *        hogar puede quemarle la clave a otro, y el eje ACTUAL del vecino se
 *        pierde EN SILENCIO porque la funcion cree que ya escribio.
 *   A2 - anular y volver a declarar no escribe nada y no avisa: la idempotencia
 *        resuelve contra la clave sin mirar el `status`, y anular-y-corregir es
 *        exactamente lo que hace una persona cuando se equivoca.
 *   A3 - la merma de lo servido viaja en `covers_quantity` con delta 0, y el
 *        informe de desperdicio suma por `delta`: se bota comida y el informe
 *        dice cero.
 *   A4 - revertir un DISCARDED_LEFTOVER repone en la despensa comida que esta
 *        fisicamente en la basura.
 *
 * El invariante de cierre (el ultimo describe) es el que importa de verdad: el
 * mismo alimento real no sale del inventario dos veces por NINGUN camino ni
 * combinacion de caminos, y todo gramo que falta en la despensa esta contado
 * exactamente una vez, en la basura o en el plato.
 *
 * Todo se arma con `serve_off_plan` a proposito: es el camino mas corto a un
 * servido REAL, con su renglon y su movimiento CONSUMED detras, sin arrastrar
 * la maquinaria del plan semanal, que no es lo que se esta probando aca.
 */

const USER_A = "00000000-0000-0000-0000-0000000000c1";
const USER_B = "00000000-0000-0000-0000-0000000000c2";
const USER_C = "00000000-0000-0000-0000-0000000000c3";
const USER_D = "00000000-0000-0000-0000-0000000000c4";
const USER_E = "00000000-0000-0000-0000-0000000000c5";

type Hogar = { householdId: string; memberId: string };

let h: Harness;
let hogarA: Hogar;
let hogarB: Hogar;
let hogarC: Hogar;
let hogarD: Hogar;
let hogarE: Hogar;
let polloId: string;

/** Un servido real: lote recibido por el libro mayor + `serve_off_plan`. */
interface Servido {
  loteId: string;
  recordId: string;
  itemId: string;
}

/**
 * Lote con existencias reales. Va como admin porque la RLS de `inventory_lots`
 * solo deja crearlos por los RPC de recepcion: aca el lote es andamiaje, no es
 * lo que se esta probando. El stock entra por el LIBRO MAYOR (un PURCHASE),
 * jamas por un update a mano a la columna.
 */
async function crearLote(
  hogar: Hogar,
  gramos: number,
  etiqueta: string,
): Promise<string> {
  return h.comoAdmin(async () => {
    const lote = (await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, unit, quantity, weight_basis, status)
       values ($1, $2, $3, 'G', 0, 'RAW', 'AVAILABLE')
       returning id`,
      [hogar.householdId, polloId, etiqueta],
    ))!.id;
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1, $2, 'PURCHASE', $3)`,
      [hogar.householdId, lote, gramos],
    );
    return lote;
  });
}

/** Recibe el lote y saca `gramos` a la mesa. Devuelve lote + registro + renglon. */
async function servir(
  user: string,
  hogar: Hogar,
  stock: number,
  gramos: number,
  etiqueta: string,
): Promise<Servido> {
  const loteId = await crearLote(hogar, stock, etiqueta);
  return h.como(user, async () => {
    const recordId = (await h.fila<{ serve_off_plan: string }>(
      "select public.serve_off_plan($1, $2, $3, null::public.meal_type, $4)",
      [hogar.memberId, loteId, gramos, etiqueta],
    ))!.serve_off_plan;
    const itemId = (await h.fila<{ id: string }>(
      "select id from public.meal_serving_record_items where record_id = $1",
      [recordId],
    ))!.id;
    return { loteId, recordId, itemId };
  });
}

/** Lo que la despensa dice tener AHORA en ese lote. */
async function saldo(user: string, loteId: string): Promise<number> {
  const lote = await h.como(user, () =>
    h.fila<{ quantity: string }>(
      "select quantity from public.inventory_lots where id = $1",
      [loteId],
    ),
  );
  return Number(lote!.quantity);
}

/** Lo que el INFORME DE DESPERDICIO dice de este hogar. Neto y firmado. */
async function mermaInformada(user: string, hogar: Hogar): Promise<number> {
  const fila = await h.como(user, () =>
    h.fila<{ total: string | null }>(
      `select coalesce(sum(quantity), 0)::text as total
       from public.waste_movements where household_id = $1`,
      [hogar.householdId],
    ),
  );
  return Number(fila!.total ?? 0);
}

// Los servidos de cada bloque se arman una sola vez: dentro de cada describe,
// los `it` cuentan pasos sucesivos de una misma historia y van en orden.
let a1Directo: Servido;
let a1Asumido: Servido;
let a2Anulado: Servido;
let a2Reintento: Servido;
let a3Merma: Servido;
let a4Reversion: Servido;
let a5Invariante: Servido;

beforeAll(async () => {
  h = await levantarBase();

  hogarA = await crearHogar(h, USER_A, "Hogar consumo A", "Ana");
  hogarB = await crearHogar(h, USER_B, "Hogar consumo B", "Beto");
  hogarC = await crearHogar(h, USER_C, "Hogar consumo C", "Carla");
  hogarD = await crearHogar(h, USER_D, "Hogar consumo D", "Dani");
  hogarE = await crearHogar(h, USER_E, "Hogar consumo E", "Elena");

  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  a1Directo = await servir(USER_A, hogarA, 300, 100, "Pollo A1 declarado");
  a1Asumido = await servir(USER_A, hogarA, 300, 100, "Pollo A1 asumido");
  a2Anulado = await servir(USER_A, hogarA, 300, 100, "Pollo A2 anulado");
  a2Reintento = await servir(USER_A, hogarA, 300, 100, "Pollo A2 reintento");
  a3Merma = await servir(USER_C, hogarC, 500, 200, "Pollo A3 merma");
  a4Reversion = await servir(USER_D, hogarD, 500, 200, "Pollo A4 reversion");
  a5Invariante = await servir(USER_E, hogarE, 500, 200, "Pollo A5 invariante");
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("A1 - la clave de deduplicacion no cruza hogares", () => {
  let squatDirecto: string;
  let logA: string;

  it("el vecino puede QUEMAR la clave natural del otro hogar: la manda el cliente", async () => {
    // Nada le impide a un cliente elegir su propia `dedupe_key`: es un
    // parametro del RPC. Este es el ataque completo, y no necesita adivinar
    // nada mas que un uuid que ya conoce.
    squatDirecto = (await h.como(USER_B, () =>
      h.fila<{ log_intake_off_plan: string }>(
        `select public.log_intake_off_plan($1, $2::jsonb, null::date,
                null::public.meal_type, $3, $4)`,
        [
          hogarB.memberId,
          JSON.stringify([{ label: "torta del vecino", extent: "HALF" }]),
          "sembrando la clave del hogar de al lado",
          `INTAKE:${a1Directo.recordId}`,
        ],
      ),
    ))!.log_intake_off_plan;
    expect(squatDirecto).toBeTruthy();
  });

  it("y aun asi el hogar A escribe SU declaracion: la clave ajena no se la come", async () => {
    logA = (await h.como(USER_A, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [
        a1Directo.recordId,
      ]),
    ))!.log_intake;

    // Sin el filtro por hogar, `log_intake` encuentra la fila del vecino, se
    // cree idempotente y devuelve un id de OTRA CASA. El eje ACTUAL del hogar A
    // no se escribe nunca, y nadie se entera: ni una excepcion, ni un cero.
    expect(logA).not.toBe(squatDirecto);

    const propio = await h.como(USER_A, () =>
      h.fila<{
        household_id: string;
        serving_record_id: string;
        status: string;
      }>(
        `select household_id, serving_record_id, status::text as status
         from public.consumption_logs where id = $1`,
        [logA],
      ),
    );
    expect(propio).not.toBeNull();
    expect(propio!.household_id).toBe(hogarA.householdId);
    expect(propio!.serving_record_id).toBe(a1Directo.recordId);
    expect(propio!.status).toBe("ACTIVE");
  });

  it("la escritura NO se pierde en silencio: el eje ACTUAL tiene renglones", async () => {
    // Devolver un id y no escribir renglones es la falla de verdad: los
    // lectores del eje leen el vacio como un cero y el motor adaptativo
    // aprende que esta persona no comio.
    const renglones = await h.como(USER_A, () =>
      h.filas("select 1 from public.intake_log_items where log_id = $1", [
        logA,
      ]),
    );
    expect(renglones.length).toBeGreaterThan(0);
  });

  it("y la declaracion del vecino queda intacta, en su hogar", async () => {
    const suya = await h.comoAdmin(() =>
      h.fila<{ household_id: string; serving_record_id: string | null }>(
        "select household_id, serving_record_id from public.consumption_logs where id = $1",
        [squatDirecto],
      ),
    );
    expect(suya!.household_id).toBe(hogarB.householdId);
    // Nunca colgo de un servido: no salio de ninguna despensa registrada.
    expect(suya!.serving_record_id).toBeNull();
  });

  it("lo mismo por el camino ASUMIDO, que tiene su propia clave natural", async () => {
    const squatAsumido = (await h.como(USER_B, () =>
      h.fila<{ log_intake_off_plan: string }>(
        `select public.log_intake_off_plan($1, $2::jsonb, null::date,
                null::public.meal_type, null, $3)`,
        [
          hogarB.memberId,
          JSON.stringify([
            { label: "once en la casa del vecino", extent: "MOST" },
          ]),
          `INTAKE-ASSUMED:${a1Asumido.recordId}`,
        ],
      ),
    ))!.log_intake_off_plan;

    const asumido = (await h.como(USER_A, () =>
      h.fila<{ assume_intake_from_plan: string }>(
        "select public.assume_intake_from_plan($1)",
        [a1Asumido.recordId],
      ),
    ))!.assume_intake_from_plan;

    expect(asumido).not.toBe(squatAsumido);
    const fila = await h.como(USER_A, () =>
      h.fila<{ household_id: string; source: string }>(
        `select household_id, source::text as source
         from public.consumption_logs where id = $1`,
        [asumido],
      ),
    );
    expect(fila!.household_id).toBe(hogarA.householdId);
    // Y sigue diciendo lo que es: un supuesto, jamas una declaracion.
    expect(fila!.source).toBe("ASSUMED_FROM_PLAN");
  });
});

// ---------------------------------------------------------------------------
describe("A2 - anular y volver a declarar ESCRIBE", () => {
  let primero: string;
  let segundo: string;

  it("se declara, y despues la persona se da cuenta de que se equivoco", async () => {
    primero = (await h.como(USER_A, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [
        a2Anulado.recordId,
      ]),
    ))!.log_intake;

    await h.como(USER_A, () =>
      h.db.query("select public.void_intake_log($1, $2)", [
        primero,
        "lo anote en la persona equivocada",
      ]),
    );

    const anulado = await h.como(USER_A, () =>
      h.fila<{ status: string }>(
        "select status::text as status from public.consumption_logs where id = $1",
        [primero],
      ),
    );
    expect(anulado!.status).toBe("VOIDED");
  });

  it("volver a declarar LO MISMO escribe una fila nueva, no un id fantasma", async () => {
    segundo = (await h.como(USER_A, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [
        a2Anulado.recordId,
      ]),
    ))!.log_intake;

    // La idempotencia que solo mira la clave devuelve el id de la fila ANULADA
    // y no escribe nada: la persona ve un "listo" y el eje ACTUAL queda
    // huerfano justo en el camino principal, que es anular y corregir.
    expect(segundo).not.toBe(primero);

    const vivo = await h.como(USER_A, () =>
      h.fila<{ status: string; serving_record_id: string }>(
        `select status::text as status, serving_record_id
         from public.consumption_logs where id = $1`,
        [segundo],
      ),
    );
    expect(vivo!.status).toBe("ACTIVE");
    expect(vivo!.serving_record_id).toBe(a2Anulado.recordId);

    const renglones = await h.como(USER_A, () =>
      h.filas("select 1 from public.intake_log_items where log_id = $1", [
        segundo,
      ]),
    );
    expect(renglones.length).toBeGreaterThan(0);
  });

  it("queda UNA sola declaracion viva, y la anulada sigue a la vista", async () => {
    // Historia inmutable: la anulacion no se borra, y tampoco se convierte en
    // un duplicado vivo.
    const vivas = await h.como(USER_A, () =>
      h.filas(
        `select id from public.consumption_logs
         where serving_record_id = $1 and status = 'ACTIVE'`,
        [a2Anulado.recordId],
      ),
    );
    expect(vivas).toHaveLength(1);

    const todas = await h.como(USER_A, () =>
      h.filas(
        "select id from public.consumption_logs where serving_record_id = $1",
        [a2Anulado.recordId],
      ),
    );
    expect(todas).toHaveLength(2);
  });

  it("lo mismo por el camino ASUMIDO: anular no deja el eje sin escritor", async () => {
    const uno = (await h.como(USER_A, () =>
      h.fila<{ assume_intake_from_plan: string }>(
        "select public.assume_intake_from_plan($1)",
        [a1Asumido.recordId],
      ),
    ))!.assume_intake_from_plan;

    await h.como(USER_A, () =>
      h.db.query("select public.void_intake_log($1, $2)", [
        uno,
        "se asumio de mas",
      ]),
    );

    const dos = (await h.como(USER_A, () =>
      h.fila<{ assume_intake_from_plan: string }>(
        "select public.assume_intake_from_plan($1)",
        [a1Asumido.recordId],
      ),
    ))!.assume_intake_from_plan;

    expect(dos).not.toBe(uno);
    const vivo = await h.como(USER_A, () =>
      h.fila<{ status: string }>(
        "select status::text as status from public.consumption_logs where id = $1",
        [dos],
      ),
    );
    expect(vivo!.status).toBe("ACTIVE");
  });

  it("PERO el reintento legitimo sigue siendo idempotente: misma clave, un registro", async () => {
    // Este es el contrapeso, y es la mitad que se rompe si el arreglo se hace a
    // lo bruto (por ejemplo, sacando la deduplicacion). Un cliente con mala
    // senal que reintenta NO puede terminar con dos declaraciones.
    const uno = (await h.como(USER_A, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [
        a2Reintento.recordId,
      ]),
    ))!.log_intake;
    const dos = (await h.como(USER_A, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [
        a2Reintento.recordId,
      ]),
    ))!.log_intake;

    expect(dos).toBe(uno);
    const todas = await h.como(USER_A, () =>
      h.filas(
        "select 1 from public.consumption_logs where serving_record_id = $1",
        [a2Reintento.recordId],
      ),
    );
    expect(todas).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("A3 - la comida botada APARECE en el informe de desperdicio", () => {
  it("el hogar parte sin merma informada, y con el lote ya descontado por servir", async () => {
    expect(await mermaInformada(USER_C, hogarC)).toBe(0);
    expect(await saldo(USER_C, a3Merma.loteId)).toBe(300); // 500 - 200 servidos
  });

  it("se botan 80 de los 200 que salieron a la mesa", async () => {
    await h.como(USER_C, () =>
      h.db.query("select public.discard_serving($1, $2, $3)", [
        a3Merma.itemId,
        80,
        "se cayo al suelo",
      ]),
    );

    const renglon = await h.como(USER_C, () =>
      h.fila<{ discarded_quantity: string }>(
        "select discarded_quantity from public.meal_serving_record_items where id = $1",
        [a3Merma.itemId],
      ),
    );
    expect(Number(renglon!.discarded_quantity)).toBe(80);
  });

  it("el informe de desperdicio los ve", async () => {
    // El movimiento se escribe con delta 0 A PROPOSITO: esos gramos ya salieron
    // del lote al servir y restarlos otra vez seria el doble descuento. Pero la
    // vista sumaba por `delta`, asi que se botaba comida y el informe decia
    // cero: la merma mas cara del sistema -la que ya se pago- era la unica
    // invisible.
    expect(await mermaInformada(USER_C, hogarC)).toBeCloseTo(80, 3);

    const filas = await h.como(USER_C, () =>
      h.filas<{ reason: string; quantity: string; ingredient_id: string }>(
        `select reason, quantity::text as quantity, ingredient_id
         from public.waste_movements where household_id = $1`,
        [hogarC.householdId],
      ),
    );
    expect(filas.some((f) => f.reason === "DISCARDED_LEFTOVER")).toBe(true);
    // Y sigue sabiendo QUE se boto: un informe de merma sin identidad no sirve
    // para dejar de comprarlo.
    expect(filas.some((f) => f.ingredient_id === polloId)).toBe(true);
  });

  it("y el inventario NO se descuenta dos veces", async () => {
    // La otra mitad de la regresion, y la que no se puede sacrificar para
    // arreglar la primera: hacer visible la merma NO puede lograrse poniendole
    // un delta negativo, porque el lote ya pago al servir.
    expect(await saldo(USER_C, a3Merma.loteId)).toBe(300);
  });

  it("anular la merma la saca del informe, sin mover un gramo", async () => {
    await h.como(USER_C, () =>
      h.db.query("select public.undo_discard_serving($1, $2, $3)", [
        a3Merma.itemId,
        80,
        "estaba mal declarada",
      ]),
    );

    // El neto firmado manda: un informe que muestra basura ya desdeclarada
    // miente igual que uno que no la muestra nunca.
    expect(await mermaInformada(USER_C, hogarC)).toBeCloseTo(0, 3);
    expect(await saldo(USER_C, a3Merma.loteId)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
describe("A4 - un ADJUSTMENT no resucita comida que esta en la basura", () => {
  let movimientoMerma: string;
  let movimientoConsumo: string;

  it("se sirven 200 y se botan 50", async () => {
    await h.como(USER_D, () =>
      h.db.query("select public.discard_serving($1, $2, $3)", [
        a4Reversion.itemId,
        50,
        "quedo en el plato",
      ]),
    );
    expect(await saldo(USER_D, a4Reversion.loteId)).toBe(300);

    const movimientos = await h.comoAdmin(() =>
      h.filas<{ id: string; reason: string }>(
        `select id, reason from public.inventory_movements
         where serving_record_item_id = $1`,
        [a4Reversion.itemId],
      ),
    );
    movimientoMerma = movimientos.find(
      (m) => m.reason === "DISCARDED_LEFTOVER",
    )!.id;
    movimientoConsumo = movimientos.find((m) => m.reason === "CONSUMED")!.id;
    expect(movimientoMerma).toBeTruthy();
    expect(movimientoConsumo).toBeTruthy();
  });

  it("revertir la MERMA rebota: esa comida esta en el basurero, no en el lote", async () => {
    // El bloque (6) exigia solo que la razon fuera ADJUSTMENT y que el signo
    // fuera opuesto. Un DISCARDED_LEFTOVER tiene delta 0 y cobertura negativa,
    // asi que pasaba los dos, y con merma PARCIAL tambien pasaba el tope por
    // renglon: la reversion repone gramos que fisicamente NO EXISTEN. Era la
    // ultima forma de fabricar comida que quedaba abierta.
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id,
              covers_quantity, reverses_movement_id)
           values ($1, $2, 'ADJUSTMENT', 50, $3, 50, $4)`,
          [
            hogarD.householdId,
            a4Reversion.loteId,
            a4Reversion.itemId,
            movimientoMerma,
          ],
        ),
      ),
    ).rejects.toThrow();
  });

  it("y el lote quedo intacto: no se fabrico ni un gramo", async () => {
    expect(await saldo(USER_D, a4Reversion.loteId)).toBe(300);
  });

  it("revertir un CONSUMED legitimo SI funciona: eso es devolver al refrigerador", async () => {
    // La pared no puede quedar tan gruesa que tape el camino real. Devolver es
    // exactamente revertir un CONSUMED, y tiene que seguir andando.
    await h.como(USER_D, () =>
      h.db.query("select public.return_serving_to_inventory($1, $2, $3)", [
        a4Reversion.itemId,
        40,
        "volvio al refrigerador",
      ]),
    );
    expect(await saldo(USER_D, a4Reversion.loteId)).toBe(340);

    const reversion = await h.comoAdmin(() =>
      h.fila<{ n: string }>(
        `select count(*)::text as n from public.inventory_movements
         where reverses_movement_id = $1 and reason = 'ADJUSTMENT'`,
        [movimientoConsumo],
      ),
    );
    expect(Number(reversion!.n)).toBeGreaterThan(0);
  });

  it("y a nivel de libro mayor la regla nueva es 'el revertido es un CONSUMED', no 'no se revierte'", async () => {
    // Sin RPC de por medio. Del renglon quedan 200 servidos - 50 botados - 40
    // devueltos = 110 gramos con derecho a volver, asi que estos 10 caben.
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.inventory_movements
           (household_id, lot_id, reason, delta, serving_record_item_id,
            covers_quantity, reverses_movement_id)
         values ($1, $2, 'ADJUSTMENT', 10, $3, 10, $4)`,
        [
          hogarD.householdId,
          a4Reversion.loteId,
          a4Reversion.itemId,
          movimientoConsumo,
        ],
      ),
    );
    expect(await saldo(USER_D, a4Reversion.loteId)).toBe(350);
  });
});

// ---------------------------------------------------------------------------
describe("INVARIANTE - el mismo alimento no sale del inventario dos veces", () => {
  const STOCK = 500;
  const SERVIDO = 200;
  const BOTADO = 50;
  const DEVUELTO = 30;
  const COMIDO = SERVIDO - BOTADO - DEVUELTO; // 120

  /** Los renglones declarados VIVOS del hogar, en gramos. */
  async function comidoDeclarado(): Promise<number> {
    const fila = await h.como(USER_E, () =>
      h.fila<{ total: string }>(
        `select coalesce(sum(i.quantity), 0)::text as total
         from public.intake_log_items i
         join public.consumption_logs l on l.id = i.log_id
         where l.household_id = $1 and l.status = 'ACTIVE'`,
        [hogarE.householdId],
      ),
    );
    return Number(fila!.total);
  }

  const declaracion = () =>
    JSON.stringify([
      {
        serving_record_item_id: a5Invariante.itemId,
        label: "Pollo A5 invariante",
        ingredient_id: polloId,
        extent: "EXACT",
        quantity: COMIDO,
        quantity_is_declared: true,
        unit: "G",
        weight_basis: "RAW",
      },
    ]);

  it("servir descuenta UNA vez", async () => {
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(STOCK - SERVIDO);
  });

  it("botar lo servido no vuelve a descontar: el lote ya pago al servir", async () => {
    await h.como(USER_E, () =>
      h.db.query("select public.discard_serving($1, $2, $3)", [
        a5Invariante.itemId,
        BOTADO,
        "se echo a perder en la mesa",
      ]),
    );
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(STOCK - SERVIDO);
    expect(await mermaInformada(USER_E, hogarE)).toBeCloseTo(BOTADO, 3);
  });

  it("devolver al refrigerador repone SOLO lo que no esta en la basura", async () => {
    await h.como(USER_E, () =>
      h.db.query("select public.return_serving_to_inventory($1, $2, $3)", [
        a5Invariante.itemId,
        DEVUELTO,
        "sobro y volvio entero",
      ]),
    );
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(
      STOCK - SERVIDO + DEVUELTO,
    );
  });

  it("no se puede devolver lo que ya se declaro basura", async () => {
    await expect(
      h.como(USER_E, () =>
        h.db.query("select public.return_serving_to_inventory($1, $2, $3)", [
          a5Invariante.itemId,
          COMIDO + 1,
          "devolviendo de mas",
        ]),
      ),
    ).rejects.toThrow();
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(
      STOCK - SERVIDO + DEVUELTO,
    );
  });

  it("ni botar lo que ya volvio al refrigerador", async () => {
    await expect(
      h.como(USER_E, () =>
        h.db.query("select public.discard_serving($1, $2, $3)", [
          a5Invariante.itemId,
          COMIDO + 1,
          "botando de mas",
        ]),
      ),
    ).rejects.toThrow();
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(
      STOCK - SERVIDO + DEVUELTO,
    );
  });

  it("un SEGUNDO CONSUMED sobre el mismo renglon rebota", async () => {
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
           values ($1, $2, 'CONSUMED', -50, $3, -50)`,
          [hogarE.householdId, a5Invariante.loteId, a5Invariante.itemId],
        ),
      ),
    ).rejects.toThrow();
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(
      STOCK - SERVIDO + DEVUELTO,
    );
  });

  it("declarar el consumo real no mueve un gramo: ni al declarar, ni al anular, ni al re-declarar", async () => {
    const log = (await h.como(USER_E, () =>
      h.fila<{ log_intake: string }>(
        "select public.log_intake($1, $2::jsonb)",
        [a5Invariante.recordId, declaracion()],
      ),
    ))!.log_intake;
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(
      STOCK - SERVIDO + DEVUELTO,
    );

    await h.como(USER_E, () =>
      h.db.query("select public.void_intake_log($1, $2)", [
        log,
        "me equivoque de integrante",
      ]),
    );
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(
      STOCK - SERVIDO + DEVUELTO,
    );

    // Re-declarar lo mismo despues de anular: A2 exige que ESCRIBA, y el
    // invariante exige que al escribir no mueva inventario.
    const otra = (await h.como(USER_E, () =>
      h.fila<{ log_intake: string }>(
        "select public.log_intake($1, $2::jsonb)",
        [a5Invariante.recordId, declaracion()],
      ),
    ))!.log_intake;
    expect(otra).not.toBe(log);
    expect(await saldo(USER_E, a5Invariante.loteId)).toBe(
      STOCK - SERVIDO + DEVUELTO,
    );

    // Y el eje ACTUAL quedo con UNA sola version viva: ni cero ni doble.
    expect(await comidoDeclarado()).toBeCloseTo(COMIDO, 3);
  });

  it("ningun movimiento fisico cuelga JAMAS de una declaracion de consumo", async () => {
    // La pared de la 0038 seccion 3, medida sobre datos reales y no sobre el
    // texto del CHECK: la puerta `consumption_log_id` esta cerrada.
    const colgados = await h.comoAdmin(() =>
      h.filas(
        `select 1 from public.inventory_movements
         where household_id = $1 and consumption_log_id is not null`,
        [hogarE.householdId],
      ),
    );
    expect(colgados).toHaveLength(0);
  });

  it("CIERRE: lo que falta en la despensa esta contado exactamente una vez", async () => {
    // El invariante entero en una linea:
    //
    //     stock inicial - saldo actual  =  merma informada + comido declarado
    //
    // Si un gramo sale dos veces, el lado izquierdo crece y el derecho no. Si
    // un gramo se fabrica (A4), el izquierdo se achica. Si la merma es
    // invisible (A3), el derecho se queda corto. Si la declaracion se pierde en
    // silencio (A1) o no se re-escribe despues de anular (A2), el derecho se
    // queda corto tambien. Las cuatro fallas rompen esta igualdad, y por eso
    // esta es la prueba que las cubre a todas juntas.
    const faltante = STOCK - (await saldo(USER_E, a5Invariante.loteId));
    const merma = await mermaInformada(USER_E, hogarE);
    const comido = await comidoDeclarado();

    expect(faltante).toBeCloseTo(SERVIDO - DEVUELTO, 3);
    expect(merma).toBeCloseTo(BOTADO, 3);
    expect(comido).toBeCloseTo(COMIDO, 3);
    expect(merma + comido).toBeCloseTo(faltante, 3);
  });
});
