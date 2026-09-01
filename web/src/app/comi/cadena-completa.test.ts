import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/domain/nutrition/calendar";
import type { EventEffect } from "@/domain/nutrition/events";
import type { TargetSet } from "@/domain/nutrition/types";
import { rollingBalance, type RollingBalance } from "@/domain/nutrition/adaptive/rolling";
import { reviewAdaptiveNutrition } from "@/domain/nutrition/adaptive/engine";
import type { AdaptiveInput } from "@/domain/nutrition/adaptive/types";
import { crearHogar, levantarBase, type Harness } from "@/integration/harness";
import { clienteSobrePGlite } from "./cliente-pglite";
import { construirDeclaracionLibre } from "./extent";
import { loadHistoriaDeConsumo } from "./historia-queries";

/**
 * LA CADENA COMPLETA, DE PUNTA A PUNTA Y SIN UN SOLO VECTOR ARMADO A MANO:
 *
 *   base (RPC de la 0038) → historia-queries → rollingBalance → reviewAdaptiveNutrition
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 *
 * Un ataque a los tests del sprint encontró que TODO el camino feliz de los dos
 * motores se probaba con vectores `actual` fabricados por el propio test
 * (`vector()` en engine.test.ts y rolling.test.ts): expects sobre números que el
 * test se inventó, con una forma que ningún escritor del proyecto produce. El
 * único test de punta a punta que había terminaba en "no se sabe nada" y lo daba
 * por bueno. O sea: nadie había recorrido la cadena entera hasta un ajuste.
 *
 * Acá se recorre. Las comidas se siembran con los RPC de verdad, se leen con el
 * lector de verdad y se pasan por los dos motores de verdad.
 *
 * LO QUE ESTE ARCHIVO DEJA DICHO, Y ES EL HALLAZGO MÁS CARO DEL DÍA
 *
 * Con lo que la aplicación escribe HOY, el motor adaptativo NO PUEDE emitir un
 * ajuste jamás. `app.write_intake_items` congela `frozen_nutrition` con
 * `coalesce(v_x->'nutrition', '{}')` (0038:772) y NINGÚN caller de web/src manda
 * esa clave: ni `construirDeclaracionLibre`, ni `construirDeclaracionServida`,
 * ni `assume_intake_from_plan`. Así que `actual` sale siempre con los diez
 * nutrientes en UNKNOWN, `deltaRatio` en null, y lo único honesto que el motor
 * puede decir es INSUFFICIENT_DATA.
 *
 * Eso NO es un bug de los motores: es la pieza que falta —quien calcule la
 * nutrición de lo que se comió y la congele al declarar—. El bloque 1 de este
 * archivo lo fija tal como está para que nadie lo confunda con un motor roto, y
 * el bloque 2 demuestra que en cuanto ese número existe la cadena sí calza
 * entera: mismos RPC, mismo lector, mismos motores, y sale un ajuste real.
 */

const USER = "00000000-0000-0000-0000-0000000000c1";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let db: SupabaseClient;
/** El día civil del hogar según la BASE, que es el que usan los RPC. */
let hoyReal: string;
let recordAsumido: string;

const SIN_EVENTO: EventEffect = { kind: "NONE", event: null, text: "" };

/** El objetivo de energía de esta persona. Único, para que el veredicto se lea solo. */
const OBJETIVO: TargetSet = {
  ENERGY_KCAL: { minimum: 1800, preferred: 2000, maximum: 2400 },
};

// ---------------------------------------------------------------------------
// Andamiaje
// ---------------------------------------------------------------------------

/**
 * Lo que la pantalla /comi manda HOY al declarar comida de afuera: etiqueta,
 * extensión y nada más. Sale del motor `intake-extent` de verdad, no de un
 * literal escrito acá.
 */
function itemsComoLosEscribeLaApp(label: string): unknown[] {
  const declaracion = construirDeclaracionLibre([{ label, extent: "ALL" }]);
  if (!declaracion.ok) throw new Error(declaracion.problemas.join(" · "));
  return declaracion.items;
}

/** Los mismos renglones, pero con la nutrición congelada que hoy nadie escribe. */
function itemsConNutricion(label: string, kcal: number): unknown[] {
  return itemsComoLosEscribeLaApp(label).map((item) => ({
    ...(item as Record<string, unknown>),
    nutrition: { energy_kcal: kcal },
    nutrition_completeness: { energy_kcal: "COMPLETE" },
  }));
}

async function declararFueraDelPlan(dia: string, items: unknown[]): Promise<void> {
  await h.como(USER, async () => {
    await h.db.query(
      `select public.log_intake_off_plan($1, $2::jsonb, $3::date, 'LUNCH'::public.meal_type)`,
      [hogar.memberId, JSON.stringify(items), dia],
    );
  });
}

/** Lee la historia con el lector real y arma las ventanas con el motor real. */
async function ventanas(
  hasta: string,
  hoy: string,
): Promise<{ balances: RollingBalance[]; historia: Awaited<ReturnType<typeof loadHistoriaDeConsumo>> }> {
  const historia = await h.como(USER, () =>
    loadHistoriaDeConsumo(db, {
      householdId: hogar.householdId,
      memberId: hogar.memberId,
      hasta,
      dias: 3,
      hoy,
    }),
  );

  const targetsByDate: Record<string, TargetSet> = {};
  for (const dia of historia.dias) targetsByDate[dia.date] = OBJETIVO;

  // Cada ventana recibe SOLO sus días: recortar la lista es tarea del cargador
  // y el motor revienta si le llega un día de más (rolling.ts:370).
  const desdeDe = (largo: number) => addDays(hasta, -(largo - 1));
  const balances = [
    rollingBalance({
      window: "W24H",
      endDate: hasta,
      days: historia.dias.filter((d) => d.date >= desdeDe(1)),
      targetsByDate,
    }),
    rollingBalance({
      window: "D3",
      endDate: hasta,
      days: historia.dias.filter((d) => d.date >= desdeDe(3)),
      targetsByDate,
    }),
  ];
  return { balances, historia };
}

/** El resto del `AdaptiveInput`: sin nada clínico y con el canal LEÍDO de verdad. */
function entradaAdaptativa(date: string, balances: readonly RollingBalance[]): AdaptiveInput {
  return {
    date,
    memberId: hogar.memberId,
    trackingMode: "FULL",
    dailyTargets: OBJETIVO,
    resolvedTargets: OBJETIVO,
    eventEffect: SIN_EVENTO,
    balances,
    clinicalContextResolved: true,
    clinicalCeilings: [],
    clinicalFloors: [],
    clinicalUnusableLimits: [],
    clinicalStatus: "COMPATIBLE",
    pendingClinicalReviews: 0,
    activeClinicalRestrictions: 0,
  };
}

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar Cadena", "Fran");
  db = clienteSobrePGlite(h);

  hoyReal = (await h.fila<{ hoy: string }>("select app.household_today($1)::text as hoy", [
    hogar.householdId,
  ]))!.hoy;

  await h.comoAdmin(async () => {
    // La persona existe desde hace diez días: ninguna ventana de este archivo
    // toca días anteriores a su historia.
    await h.db.query("update public.household_members set created_at = $2::date where id = $1", [
      hogar.memberId,
      addDays(hoyReal, -10),
    ]);
    await h.db.query(
      `insert into public.member_tracking_settings (member_id, mode) values ($1, 'FULL')
       on conflict (member_id) do update set mode = 'FULL'`,
      [hogar.memberId],
    );
    const patron = (await h.fila<{ id: string }>(
      "insert into public.meal_patterns (member_id) values ($1) returning id",
      [hogar.memberId],
    ))!.id;
    // UNA sola comida esperada al día: así `mealRatio` se lee sin aritmética.
    await h.db.query(
      `insert into public.meal_pattern_slots (pattern_id, meal_type, availability, sort_order)
       values ($1, 'LUNCH', 'ENABLED', 1)`,
      [patron],
    );
  });

  // --- Bloque 1: tres días declarados COMO LOS ESCRIBE LA APLICACIÓN HOY ---
  for (const salto of [-6, -5, -4]) {
    await declararFueraDelPlan(addDays(hoyReal, salto), itemsComoLosEscribeLaApp("Cazuela"));
  }

  // --- Bloque 2: tres días iguales, pero con la nutrición congelada ---
  for (const salto of [-3, -2, -1]) {
    await declararFueraDelPlan(addDays(hoyReal, salto), itemsConNutricion("Cazuela", 3000));
  }

  // --- Bloque 3: un almuerzo servido de verdad y DADO POR COMIDO de un toque ---
  await h.como(USER, async () => {
    const pollo = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
    ))!.id;
    const lote = await h.comoAdmin(async () => {
      const creado = (await h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, ingredient_id, label, unit, quantity, weight_basis, status)
         values ($1, $2, 'Pollo cadena', 'G', 0, 'RAW', 'AVAILABLE')
         returning id`,
        [hogar.householdId, pollo],
      ))!.id;
      await h.db.query(
        `insert into public.inventory_movements (household_id, lot_id, reason, delta)
         values ($1, $2, 'PURCHASE', 1000)`,
        [hogar.householdId, creado],
      );
      return creado;
    });
    recordAsumido = (await h.fila<{ serve_off_plan: string }>(
      "select public.serve_off_plan($1, $2, 200, 'LUNCH'::public.meal_type, $3)",
      [hogar.memberId, lote, "Pollo del almuerzo"],
    ))!.serve_off_plan;
    // El camino de un toque de la pantalla: nadie miró plato por plato.
    await h.db.query("select public.assume_intake_from_plan($1)", [recordAsumido]);
  });
}, 60000);

afterAll(async () => {
  await h.cerrar();
});

// ---------------------------------------------------------------------------
// 1. La cadena tal como corre HOY en producción
// ---------------------------------------------------------------------------

describe("la cadena entera, con lo que la aplicación escribe hoy", () => {
  it("hay registro los tres días, y aun así el motor NO afirma nada de energía", async () => {
    const hasta = addDays(hoyReal, -4);
    const { balances, historia } = await ventanas(hasta, hoyReal);

    // El lector: los tres días existen y tienen registro vivo.
    expect(historia.dias.map((d) => d.date)).toEqual([
      addDays(hoyReal, -6),
      addDays(hoyReal, -5),
      hasta,
    ]);
    for (const dia of historia.dias) {
      // `actual` NO es null: la fila existe. Y sus diez nutrientes son UNKNOWN:
      // nadie congeló nutrición. Las dos cosas a la vez son el corazón del
      // sprint, y son las que un `?? 0` borraría de un plumazo.
      expect(dia.actual).not.toBeNull();
      expect(dia.actual!.completeness.energy_kcal).toBe("UNKNOWN");
      expect(dia.actual!.values.energy_kcal).toBeNull();
      expect(dia.mealsLogged).toBe(1);
      expect(dia.isClosed).toBe(true);
    }

    // El primer motor: cobertura completa de COMIDAS y cero conocimiento de
    // nutrientes. Son ejes distintos y no se contaminan.
    const d3 = balances[1]!;
    expect(d3.coverage.mealRatio).toBe(1);
    expect(d3.balances.energy_kcal.actual).toBeNull();
    expect(d3.balances.energy_kcal.deltaRatio).toBeNull();
    expect(d3.balances.energy_kcal.completeness).toBe("UNKNOWN");

    // El segundo motor: "no me alcanza para opinar", NUNCA "quedaste bien".
    const review = reviewAdaptiveNutrition(entradaAdaptativa(hasta, balances));
    expect(review.verdict).toBe("INSUFFICIENT_DATA");
    expect(review.adjustments).toEqual([]);
    expect(review.missingData.length).toBeGreaterThan(0);
    expect(review.missingData.some((m) => m.target === "energy_kcal")).toBe(true);
    expect(review.reasons.map((r) => r.code)).toContain("NUTRIENT_UNKNOWN");
    // Y sobre todo: ni una afirmación positiva sobre una comparación que nunca
    // se hizo. INSUFFICIENT_DATA no es NO_CHANGE.
    expect(review.reasons.map((r) => r.code)).not.toContain("WITHIN_NOISE_BAND");
    for (const razon of review.reasons) {
      expect(razon.text).not.toMatch(/dentro del rango/i);
    }
  });

  it("EL HUECO, ESCRITO: ningún escritor de la app congela nutrición al declarar", async () => {
    // Esto no es un test de estilo: es la razón por la que el bloque de arriba
    // no puede terminar en un ajuste. Mientras esta consulta devuelva '{}' para
    // todo lo que escribe la pantalla, el motor adaptativo está desconectado de
    // la realidad por diseño, y conviene que se vea acá y no en producción.
    const filas = await h.comoAdmin(() =>
      h.filas<{ frozen_nutrition: unknown }>(
        `select i.frozen_nutrition
         from public.intake_log_items i
         join public.consumption_logs l on l.id = i.log_id
         where l.member_id = $1 and l.consumed_on <= $2
         order by l.consumed_on, i.sort_order`,
        [hogar.memberId, addDays(hoyReal, -4)],
      ),
    );
    expect(filas.length).toBe(3);
    for (const fila of filas) expect(fila.frozen_nutrition).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 2. La misma cadena cuando el número SÍ existe
// ---------------------------------------------------------------------------

describe("la cadena entera hasta un ajuste de verdad", () => {
  it("tres días 50 % sobre el objetivo terminan en un ajuste recomendado", async () => {
    const hasta = addDays(hoyReal, -1);
    const { balances, historia } = await ventanas(hasta, hoyReal);

    // El lector devuelve el número que la BASE guardó, no uno armado acá.
    for (const dia of historia.dias) {
      expect(dia.actual!.values.energy_kcal).toBe(3000);
      expect(dia.actual!.completeness.energy_kcal).toBe("COMPLETE");
    }

    const d3 = balances[1]!;
    expect(d3.balances.energy_kcal.actual).toBe(9000);
    expect(d3.balances.energy_kcal.target).toBe(6000);
    expect(d3.balances.energy_kcal.deltaRatio).toBe(0.5);
    expect(d3.balances.energy_kcal.isLowerBound).toBe(false);

    const review = reviewAdaptiveNutrition(entradaAdaptativa(hasta, balances));
    expect(review.verdict).toBe("RECOMMENDED_ADJUSTMENT");
    expect(review.adjustments).toHaveLength(1);

    const ajuste = review.adjustments[0]!;
    expect(ajuste.goalType).toBe("ENERGY_KCAL");
    expect(ajuste.reasonCode).toBe("SUSTAINED_SURPLUS");
    expect(ajuste.window).toBe("D3");
    expect(ajuste.from.preferred).toBe(2000);
    // −10 % es el tope de parámetros: el motor NO propone el −50 % crudo.
    expect(ajuste.to.preferred).toBe(1800);
    expect(ajuste.cappedBy).toContain("PARAMS");
    // El mínimo declarado no se toca: apretar no se paga bajando el piso.
    expect(ajuste.to.minimum).toBe(1800);
    expect(ajuste.validFrom).toBe(hasta);
    expect(ajuste.validUntil).toBe(addDays(hasta, 2));
  });

  it("es determinista: dos corridas de la cadena entera dan el mismo JSON", async () => {
    // El lector no ordenaba NINGUNA de sus consultas, y sus filas son los
    // sumandos de una suma en punto flotante, que no es asociativa. Dos
    // corridas iguales podían devolver dos JSON distintos, con el motor de
    // arriba prometiendo determinismo por contrato.
    const hasta = addDays(hoyReal, -1);
    const uno = await ventanas(hasta, hoyReal);
    const dos = await ventanas(hasta, hoyReal);
    expect(JSON.stringify(dos.historia)).toBe(JSON.stringify(uno.historia));
    expect(JSON.stringify(reviewAdaptiveNutrition(entradaAdaptativa(hasta, dos.balances)))).toBe(
      JSON.stringify(reviewAdaptiveNutrition(entradaAdaptativa(hasta, uno.balances))),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Lo ASUMIDO no es lo declarado, y la cadena entera tiene que notarlo
// ---------------------------------------------------------------------------

describe("«Se comió todo» no vale lo mismo que decir cuánto comió", () => {
  it("un supuesto del plan no cubre la comida ni sostiene la cobertura", async () => {
    // La ventana termina HOY y `hoy` se corre un día: así el día de hoy cuenta
    // como cerrado sin tener que esperar a mañana.
    const { historia } = await ventanas(hoyReal, addDays(hoyReal, 1));
    const hoyDia = historia.dias.find((d) => d.date === hoyReal)!;

    // El registro EXISTE —la fila está viva— y por eso `actual` no es null.
    expect(hoyDia.actual).not.toBeNull();
    // Pero nadie lo declaró: la comida sigue faltando por registrar.
    expect(hoyDia.mealsLogged).toBe(0);
    expect(hoyDia.mealsExpected).toBe(1);
    // Y no se cuela por la puerta de al lado: no es un "registro sin comida".
    expect(hoyDia.unassignedLogs).toBe(0);
    // El número que la 0038 le escribe es `deducted_quantity` (0038:1036): un
    // número que nadie observó. Cuenta como "no sé cuánto", que es el único
    // freno que tiene `rolling` para bajar el techo de confianza.
    expect(hoyDia.unknownQuantityItems).toBe(1);

    // Y la procedencia llega hasta arriba con nombre propio, en vez de
    // desaparecer en el camino.
    expect(historia.asumidos).toEqual([
      { date: hoyReal, logs: 1, items: 1, comidas: ["LUNCH"] },
    ]);
  });

  it("un día de un toque NO da cobertura: el motor se declara sin datos, no conforme", async () => {
    // Se mira SOLO la ventana del día, que es la que contiene el supuesto: las
    // ventanas largas de este archivo arrastran los días declarados del bloque
    // anterior y contestarían otra pregunta.
    const { balances } = await ventanas(hoyReal, addDays(hoyReal, 1));
    const w24 = balances[0]!;
    // Cobertura CERO sobre un día que sí tiene registro: es la diferencia entre
    // "alguien lo declaró" y "lo dimos por hecho", y antes valían lo mismo.
    expect(w24.coverage.mealsLogged).toBe(0);
    expect(w24.coverage.mealRatio).toBe(0);
    expect(w24.coverage.kind).toBe("NONE");
    expect(w24.coverage.unknownQuantityItems).toBe(1);
    expect(w24.confidence.level).toBe("NONE");

    const review = reviewAdaptiveNutrition(entradaAdaptativa(hoyReal, [w24]));
    expect(review.verdict).toBe("INSUFFICIENT_DATA");
    expect(review.adjustments).toEqual([]);
    expect(review.reasons.map((r) => r.code)).toContain("DATA_COVERAGE_INSUFFICIENT");
    // Y la falta se NOMBRA: el día aparece en `missingData` con la comida que
    // quedó sin registrar, en vez de salir con la lista vacía.
    expect(review.missingData.some((m) => m.kind === "DAY" && m.target === hoyReal)).toBe(true);
  });

  it("el mismo día, DECLARADO por una persona, sí cuenta como comida registrada", async () => {
    // El control de la mutación: cambia SOLO la procedencia y la respuesta se
    // da vuelta. Sin esto, el test de arriba pasaría también con un lector que
    // no cuenta ninguna comida.
    const dia = addDays(hoyReal, -1);
    const { historia } = await ventanas(dia, hoyReal);
    const declarado = historia.dias.find((d) => d.date === dia)!;
    expect(declarado.mealsLogged).toBe(1);
    expect(declarado.unknownQuantityItems).toBe(1);
    expect(historia.asumidos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. La evidencia de por qué el camino de un toque se corta en el cliente
// ---------------------------------------------------------------------------

describe("un supuesto sobre lo que la despensa no entregó", () => {
  it("el RPC escribe un CERO DURO donde el camino manual deja el número en null", async () => {
    // `deducted + shortfall = served` (invariante de la 0036): con el lote
    // vacío, salió el plato y de la despensa no salió nada. La 0038 ya está
    // aplicada y no se toca, así que esto queda fijado como lo que es —el
    // motivo por el que `puedeDarsePorComida` corta antes, en la pantalla y en
    // la server action— y no como algo que el sistema arregla solo.
    const record = await h.como(USER, async () => {
      const pollo = (await h.fila<{ id: string }>(
        "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
      ))!.id;
      const lote = await h.comoAdmin(async () => {
        const creado = (await h.fila<{ id: string }>(
          `insert into public.inventory_lots
             (household_id, ingredient_id, label, unit, quantity, weight_basis, status)
           values ($1, $2, 'Lote flaco', 'G', 0, 'RAW', 'AVAILABLE')
           returning id`,
          [hogar.householdId, pollo],
        ))!.id;
        await h.db.query(
          `insert into public.inventory_movements (household_id, lot_id, reason, delta)
           values ($1, $2, 'PURCHASE', 200)`,
          [hogar.householdId, creado],
        );
        return creado;
      });
      return (await h.fila<{ serve_off_plan: string }>(
        "select public.serve_off_plan($1, $2, 200, 'DINNER'::public.meal_type, $3)",
        [hogar.memberId, lote, "Pollo sin stock"],
      ))!.serve_off_plan;
    });

    // El faltante de despensa se fabrica acá a mano porque el camino que lo
    // produce de verdad —servir del plan un ingrediente que no tiene lote— pide
    // media planificación semanal. Lo que importa es el ESTADO, que es
    // alcanzable en producción y respeta el invariante de la 0036.
    await h.comoAdmin(async () => {
      await h.db.query(
        `update public.meal_serving_record_items
         set deducted_quantity = 0, shortfall_quantity = served_quantity
         where record_id = $1`,
        [record],
      );
    });

    const renglon = (await h.fila<{
      served_quantity: string;
      deducted_quantity: string;
      shortfall_quantity: string;
      discarded_quantity: string;
    }>(
      `select served_quantity, deducted_quantity, shortfall_quantity, discarded_quantity
       from public.meal_serving_record_items where record_id = $1`,
      [record],
    ))!;
    expect(Number(renglon.deducted_quantity)).toBe(0);
    expect(Number(renglon.shortfall_quantity)).toBe(200);
    // Y la merma es CERO: el único freno que el RPC tiene ni se entera.
    expect(Number(renglon.discarded_quantity)).toBe(0);

    await h.como(USER, async () => {
      await h.db.query("select public.assume_intake_from_plan($1)", [record]);
    });
    const item = (await h.fila<{ quantity: string | null }>(
      `select i.quantity
       from public.intake_log_items i
       join public.consumption_logs l on l.id = i.log_id
       where l.serving_record_id = $1 and l.status = 'ACTIVE'`,
      [record],
    ))!;
    // Acá está el hecho: un 0, que en este proyecto significa "midieron y dio
    // cero", escrito sobre un plato que nadie miró.
    expect(item.quantity).not.toBeNull();
    expect(Number(item.quantity)).toBe(0);
  });
});
