import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NUTRIENT_KEYS } from "@/domain/catalog/types";
import { addDays } from "@/domain/nutrition/calendar";
import { rollingBalance } from "@/domain/nutrition/adaptive/rolling";
import { crearHogar, levantarBase, type Harness } from "@/integration/harness";
import { clienteSobrePGlite } from "./cliente-pglite";
import {
  diaCivilDelHogar,
  loadHistoriaDeConsumo,
  sumarVectoresCongelados,
  vectorCongelado,
} from "./historia-queries";

/**
 * EL LECTOR DEL EJE DE CONSUMO REAL, MEDIDO CONTRA POSTGRES DE VERDAD.
 *
 * Lo que se está defendiendo acá es UNA distinción, y es la que justifica el
 * sprint entero:
 *
 *   · un día SIN ningún registro tiene `actual = null`;
 *   · un día CON registro y sin nutrición congelada tiene `actual` con los diez
 *     nutrientes en UNKNOWN y sus valores en null;
 *   · un día en que la persona todavía no existía NO APARECE en la lista.
 *
 * Los tres se ven parecido desde lejos y significan cosas opuestas. Si el
 * primero se colapsara a un objeto de ceros, el motor adaptativo leería un
 * déficit que nadie vivió y propondría bajarle la meta a alguien que
 * simplemente no anotó. Ese es el bug que estas pruebas existen para impedir.
 *
 * Se prueba contra PGlite —Postgres real— y no con filas armadas a mano: el
 * hueco que tumbó /pantry en la demo viva del Sprint 10 nació justamente de un
 * cargador que ningún test ejercitaba de punta a punta.
 */

const USER = "00000000-0000-0000-0000-0000000000d1";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let db: SupabaseClient;
let polloId: string;
/** El día civil del hogar según la BASE, que es el que usan los RPC. */
let hoyReal: string;

// ---------------------------------------------------------------------------
// Andamiaje
// ---------------------------------------------------------------------------

/** Un lote con existencias reales: el stock entra por el LIBRO MAYOR. */
async function crearLote(etiqueta: string, gramos: number): Promise<string> {
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

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar Historia", "Fran");
  db = clienteSobrePGlite(h);
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  hoyReal = (await h.fila<{ hoy: string }>("select app.household_today($1)::text as hoy", [
    hogar.householdId,
  ]))!.hoy;

  await h.comoAdmin(async () => {
    // La persona existe desde hace cinco días: así la ventana puede pedir días
    // ANTERIORES a su historia y verse que se distinguen de un día sin registro.
    // A MEDIODÍA EN LA ZONA DEL HOGAR, no `$2::date` a secas. Un DATE convertido
    // a timestamptz cae a la MEDIANOCHE de la zona de la SESIÓN de Postgres: en
    // esta máquina (Santiago) daba el día pedido, y en CI (UTC) daba las 00:00Z,
    // que en Santiago todavía es el día ANTERIOR — el motor, que convierte con la
    // zona del hogar, respondía 27 donde el test esperaba 28. Verde acá, rojo en
    // CI, sin que el motor tuviera nada malo. Con mediodía en la zona del hogar
    // la fecha es la misma se mire desde donde se mire.
    await h.db.query(
      "update public.household_members set created_at = ($2::date + time '12:00') at time zone 'America/Santiago' where id = $1",
      [hogar.memberId, addDays(hoyReal, -5)],
    );
    await h.db.query(
      `insert into public.member_tracking_settings (member_id, mode) values ($1, 'FULL')
       on conflict (member_id) do update set mode = 'FULL'`,
      [hogar.memberId],
    );
    const patron = (await h.fila<{ id: string }>(
      "insert into public.meal_patterns (member_id) values ($1) returning id",
      [hogar.memberId],
    ))!.id;
    // Tres comidas esperadas, y una CUARTA en OPTIONAL que NO entra al
    // denominador: no registrar lo opcional no es un hueco.
    await h.db.query(
      `insert into public.meal_pattern_slots (pattern_id, meal_type, availability, sort_order)
       values ($1, 'BREAKFAST', 'ENABLED', 1), ($1, 'LUNCH', 'ENABLED', 2),
              ($1, 'DINNER', 'ENABLED', 3), ($1, 'SNACK', 'OPTIONAL', 4)`,
      [patron],
    );
  });

  await h.como(USER, async () => {
    // hoyReal − 2: desayuno declarado SIN número ("no sé cuánto").
    await h.db.query(
      `select public.log_intake_off_plan($1, $2::jsonb, $3::date, 'BREAKFAST'::public.meal_type)`,
      [
        hogar.memberId,
        JSON.stringify([{ label: "Pan con palta", extent: "UNKNOWN", sort_order: 1 }]),
        addDays(hoyReal, -2),
      ],
    );

    // hoyReal − 1: una colación SIN comida asignada. Registro real que no cae
    // en ninguna comida del patrón.
    await h.db.query(
      `select public.log_intake_off_plan($1, $2::jsonb, $3::date, null::public.meal_type)`,
      [
        hogar.memberId,
        JSON.stringify([{ label: "Fruta", extent: "ALL", sort_order: 1 }]),
        addDays(hoyReal, -1),
      ],
    );

    // hoyReal: se sirve un almuerzo de verdad y se declara la mitad.
    const lote = await crearLote("Pollo historia", 1000);
    const record = (await h.fila<{ serve_off_plan: string }>(
      "select public.serve_off_plan($1, $2, 200, 'LUNCH'::public.meal_type, $3)",
      [hogar.memberId, lote, "Pollo del almuerzo"],
    ))!.serve_off_plan;
    const renglon = (await h.fila<{ id: string }>(
      "select id from public.meal_serving_record_items where record_id = $1",
      [record],
    ))!.id;
    await h.db.query("select public.log_intake($1, $2::jsonb)", [
      record,
      JSON.stringify([
        {
          serving_record_item_id: renglon,
          label: "Pollo del almuerzo",
          extent: "HALF",
          quantity: 100,
          unit: "G",
          weight_basis: "RAW",
          quantity_is_declared: false,
          extent_engine_version: "intake-extent/1.0.0",
          sort_order: 1,
        },
      ]),
    ]);
  });
}, 60000);

afterAll(async () => {
  await h.cerrar();
});

// ---------------------------------------------------------------------------
// Lo puro
// ---------------------------------------------------------------------------

describe("vectorCongelado: lo que no está, no está", () => {
  it("`{}` no es cero: ningún nutriente queda declarado", () => {
    const v = vectorCongelado({}, {});
    expect(v.values).toEqual({});
    expect(v.completeness).toEqual({});
  });

  it("desenvuelve la forma anidada del mundo viejo", () => {
    const v = vectorCongelado(
      { values: { energy_kcal: 500 }, completeness: { energy_kcal: "COMPLETE" } },
      {},
    );
    expect(v.values.energy_kcal).toBe(500);
    expect(v.completeness.energy_kcal).toBe("COMPLETE");
  });

  it("un valor que no es número NO se convierte en cero", () => {
    const v = vectorCongelado({ energy_kcal: "no sé" }, { energy_kcal: "COMPLETE" });
    expect(v.values.energy_kcal).toBeNull();
  });
});

describe("sumarVectoresCongelados: UNKNOWN nunca es cero", () => {
  it("cero vectores deja los diez nutrientes en UNKNOWN con valor null", () => {
    const { agregado, avisos } = sumarVectoresCongelados([], "vacío");
    expect(avisos).toEqual([]);
    for (const key of NUTRIENT_KEYS) {
      expect(agregado.completeness[key]).toBe("UNKNOWN");
      expect(agregado.values[key]).toBeNull();
    }
    expect(agregado.contributors).toBe(0);
  });

  it("un vector que declara UNKNOWN no aporta y no ensucia al que sí sabe", () => {
    const { agregado } = sumarVectoresCongelados(
      [
        { values: { energy_kcal: 400 }, completeness: { energy_kcal: "COMPLETE" } },
        { values: { energy_kcal: null }, completeness: { energy_kcal: "UNKNOWN" } },
      ],
      "mixto",
    );
    // Uno de dos aportó: la suma es una COTA INFERIOR y se dice PARTIAL.
    expect(agregado.values.energy_kcal).toBe(400);
    expect(agregado.completeness.energy_kcal).toBe("PARTIAL");
  });

  it("un PARTIAL con número contamina la suma aunque todos aporten", () => {
    const { agregado } = sumarVectoresCongelados(
      [
        { values: { protein_g: 30 }, completeness: { protein_g: "COMPLETE" } },
        { values: { protein_g: 10 }, completeness: { protein_g: "PARTIAL" } },
      ],
      "parcial",
    );
    expect(agregado.values.protein_g).toBe(40);
    // Deducir la completitud del `null` habría dicho COMPLETE: los dos traen
    // número. La completitud es un dato, no una inferencia.
    expect(agregado.completeness.protein_g).toBe("PARTIAL");
  });

  it("una fila que se contradice se degrada y se DICE, no se calla", () => {
    const { agregado, avisos } = sumarVectoresCongelados(
      [{ values: {}, completeness: { fat_g: "COMPLETE" } }],
      "contradictorio",
    );
    expect(agregado.completeness.fat_g).toBe("UNKNOWN");
    expect(agregado.values.fat_g).toBeNull();
    expect(avisos.join(" ")).toContain("fat_g");
  });

  it("es determinista byte a byte", () => {
    const entrada = [
      { values: { energy_kcal: 100, protein_g: 5 }, completeness: { energy_kcal: "COMPLETE" } },
    ] as const;
    const a = JSON.stringify(sumarVectoresCongelados([...entrada], "x"));
    const b = JSON.stringify(sumarVectoresCongelados([...entrada], "x"));
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// El día civil
// ---------------------------------------------------------------------------

describe("el día civil sale del hogar, no del servidor", () => {
  it("a las 23:50 de Santiago todavía es el día de acá aunque en UTC sea mañana", async () => {
    const { hoy, timeZone } = await h.como(USER, () =>
      diaCivilDelHogar(db, hogar.householdId, new Date("2026-09-01T03:50:00Z")),
    );
    expect(timeZone).toBe("America/Santiago");
    expect(hoy).toBe("2026-08-31");
  });
});

// ---------------------------------------------------------------------------
// El lector
// ---------------------------------------------------------------------------

describe("loadHistoriaDeConsumo: los tres ejes, por separado", () => {
  it("un día sin ningún registro tiene actual NULL, no un objeto de ceros", async () => {
    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: hoyReal,
        dias: 4,
        // `hoy` un día más adelante: así los cuatro días de la ventana están
        // CERRADOS y ninguno queda a medio vivir.
        hoy: addDays(hoyReal, 1),
      }),
    );

    expect(historia.dias.map((d) => d.date)).toEqual([
      addDays(hoyReal, -3),
      addDays(hoyReal, -2),
      addDays(hoyReal, -1),
      hoyReal,
    ]);
    expect(historia.diasFueraDeHistoria).toEqual([]);
    expect(historia.avisos).toEqual([]);

    const vacio = historia.dias[0]!;
    expect(vacio.actual).toBeNull();
    expect(vacio.served).toBeNull();
    expect(vacio.planned).toBeNull();
    expect(vacio.mealsLogged).toBe(0);
    expect(vacio.unknownQuantityItems).toBe(0);
  });

  it("un día CON registro y sin nutrición congelada NO es un día vacío", async () => {
    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: hoyReal,
        dias: 4,
        hoy: addDays(hoyReal, 1),
      }),
    );

    const desayuno = historia.dias.find((d) => d.date === addDays(hoyReal, -2))!;
    // Hay registro: `actual` NO es null...
    expect(desayuno.actual).not.toBeNull();
    // ...y aun así no se sabe una sola caloría, porque la 0038 guarda `'{}'`.
    for (const key of NUTRIENT_KEYS) {
      expect(desayuno.actual!.completeness[key]).toBe("UNKNOWN");
      expect(desayuno.actual!.values[key]).toBeNull();
    }
    expect(desayuno.actual!.contributors).toBe(1);
    expect(desayuno.mealsLogged).toBe(1);
    expect(desayuno.mealsExpected).toBe(3);
    // "No sé cuánto" declarado: baja la confianza y tiene que llegar al motor.
    expect(desayuno.unknownQuantityItems).toBe(1);
    expect(desayuno.unassignedLogs).toBe(0);
  });

  it("la colación sin comida asignada se informa aparte y no hunde la cobertura", async () => {
    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: hoyReal,
        dias: 4,
        hoy: addDays(hoyReal, 1),
      }),
    );

    const colacion = historia.dias.find((d) => d.date === addDays(hoyReal, -1))!;
    expect(colacion.actual).not.toBeNull();
    expect(colacion.mealsLogged).toBe(0);
    expect(colacion.unassignedLogs).toBe(1);
    // Un renglón LIBRE nunca trae número: `extent.ts` se niega —con razón— a
    // pedir gramos de algo que no salió de esta despensa ("200 de algo" no es
    // un número). Así que aunque diga «Todo», para el motor sigue siendo una
    // cantidad desconocida, y eso tiene que llegarle.
    expect(colacion.unknownQuantityItems).toBe(1);
  });

  it("lo servido y lo declarado son ejes distintos y ninguno se deriva del otro", async () => {
    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: hoyReal,
        dias: 4,
        hoy: addDays(hoyReal, 1),
      }),
    );

    const almuerzo = historia.dias.find((d) => d.date === hoyReal)!;
    expect(almuerzo.served).not.toBeNull();
    expect(almuerzo.actual).not.toBeNull();
    // Fuera de plan no hay plan congelado: la nutrición de lo servido es
    // desconocida, y desconocida NO es cero.
    expect(almuerzo.served!.values.energy_kcal).toBeNull();
    expect(almuerzo.served!.completeness.energy_kcal).toBe("UNKNOWN");
    // Nunca hubo plan: el tercer eje falta entero, y eso se dice con null.
    expect(almuerzo.planned).toBeNull();
    expect(almuerzo.mealsServed).toBe(1);
    expect(almuerzo.mealsLogged).toBe(1);
    // La mitad declarada SÍ trae número: no es un hueco.
    expect(almuerzo.unknownQuantityItems).toBe(0);
  });

  it("los días anteriores a que la persona existiera NO son días sin registro", async () => {
    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: hoyReal,
        dias: 8,
        hoy: addDays(hoyReal, 1),
      }),
    );

    expect(historia.primerDiaDeHistoria).toBe(addDays(hoyReal, -5));
    expect(historia.diasFueraDeHistoria).toEqual([addDays(hoyReal, -7), addDays(hoyReal, -6)]);
    // Y NO aparecen entre los días: el motor los cuenta como NOT_IN_HISTORY.
    expect(historia.dias.map((d) => d.date)).not.toContain(addDays(hoyReal, -7));
    expect(historia.dias).toHaveLength(6);
  });

  it("el día en curso se marca sin cerrar: la cena todavía no ocurre", async () => {
    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: hoyReal,
        dias: 2,
        hoy: hoyReal,
      }),
    );
    expect(historia.dias.map((d) => d.isClosed)).toEqual([true, false]);
  });

  it("una ventana que termina en el futuro se rechaza, no se recorta en silencio", async () => {
    await expect(
      h.como(USER, () =>
        loadHistoriaDeConsumo(db, {
          householdId: hogar.householdId,
          memberId: hogar.memberId,
          hasta: addDays(hoyReal, 3),
          dias: 2,
          hoy: hoyReal,
        }),
      ),
    ).rejects.toThrow(/futuro/);
  });

  it("una persona de otro hogar no se lee: revienta en vez de devolver vacío", async () => {
    await expect(
      h.como(USER, () =>
        loadHistoriaDeConsumo(db, {
          householdId: "00000000-0000-0000-0000-0000000000ff",
          memberId: hogar.memberId,
          hasta: hoyReal,
          dias: 2,
          hoy: hoyReal,
        }),
      ),
    ).rejects.toThrow(/no es de este hogar/);
  });
});

describe("un evento SKIP_TRACKING saca comidas del denominador", () => {
  it("el día del evento no espera ninguna comida y queda marcado sin conteo", async () => {
    const dia = addDays(hoyReal, -3);
    await h.comoAdmin(async () => {
      await h.db.query(
        `insert into public.nutrition_events
           (household_id, event_date, event_type, meal_type, strategy, title)
         values ($1, $2::date, 'OTHER', null, 'SKIP_TRACKING', 'Cumpleaños')`,
        [hogar.householdId, dia],
      );
    });

    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: hoyReal,
        dias: 4,
        hoy: addDays(hoyReal, 1),
      }),
    );

    const feriado = historia.dias.find((d) => d.date === dia)!;
    expect(feriado.skipTracking).toBe(true);
    // Contar comidas que nadie pidió medir convierte una celebración en un
    // déficit: el denominador queda en cero, no en tres.
    expect(feriado.mealsExpected).toBe(0);

    // Los otros días siguen esperando sus tres comidas.
    const otro = historia.dias.find((d) => d.date === addDays(hoyReal, -2))!;
    expect(otro.skipTracking).toBe(false);
    expect(otro.mealsExpected).toBe(3);
  });
});

describe("lo que sale de acá entra derecho al motor", () => {
  it("rollingBalance corre sobre los días reales sin inventar un solo número", async () => {
    const historia = await h.como(USER, () =>
      loadHistoriaDeConsumo(db, {
        householdId: hogar.householdId,
        memberId: hogar.memberId,
        hasta: addDays(hoyReal, -1),
        dias: 3,
        hoy: hoyReal,
      }),
    );

    const balance = rollingBalance({
      window: "D3",
      endDate: addDays(hoyReal, -1),
      days: historia.dias,
      targetsByDate: Object.fromEntries(
        historia.dias.map((d) => [d.date, { ENERGY_KCAL: { minimum: 1800, preferred: 2000, maximum: 2400 } }]),
      ),
    });

    // Nadie congeló nutrición: el motor NO puede afirmar nada de energía.
    expect(balance.balances.energy_kcal.actual).toBeNull();
    expect(balance.balances.energy_kcal.delta).toBeNull();
    expect(balance.balances.energy_kcal.completeness).toBe("UNKNOWN");
    expect(balance.confidence.level).toBe("NONE");
    // Y los dos "no sé cuánto" (el desayuno y la fruta) viajaron enteros hasta
    // la cobertura: ninguno se perdió por el camino.
    expect(balance.coverage.unknownQuantityItems).toBe(2);
    expect(balance.coverage.unassignedLogs).toBe(1);
  });
});
