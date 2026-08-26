import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NutritionFact } from "../domain/catalog/types";
import { buildProfile } from "../domain/nutrition/profile";
import { projectFamilyServings } from "../domain/portions/family";
import type { PortionComponent } from "../domain/portions/optimizer";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * AUDITORÍA POST-11.5 · DEFECTO 3 — EL FALSO-SEGURO CLÍNICO.
 *
 * La regla que gobierna el Sprint 11 es una sola: **UNKNOWN NUNCA SIGNIFICA
 * NORMAL**. Una comida que nadie evaluó no se puede mostrar igual que una
 * comida evaluada y limpia.
 *
 * Hoy se muestra exactamente igual, por cuatro piezas desconectadas:
 *
 *  1. `assessMeal` (web/src/app/health/actions.ts) no tiene ni un llamador;
 *  2. `FamilyProjectionInput` ni siquiera declara `clinicalCeilings`, así que
 *     `input.clinicalCeilings ?? []` en optimizer.ts es SIEMPRE lista vacía y
 *     una restricción HARD confirmada no limita nada de lo que se guarda;
 *  3. el único camino que escribe `clinical_status` es reactivo
 *     (`resolve_clinical_impact_review`): toda porción confirmada nace NULL;
 *  4. la pantalla y el tablero sólo reaccionan a CLINICALLY_INVALIDATED y
 *     REVIEW_REQUIRED, así que NULL se ve idéntico a "evaluada y limpia".
 *
 * Este archivo es la regresión de las cuatro. Datos 100% sintéticos.
 */

const USER = "00000000-0000-0000-0000-0000000fa001";
const WEB_SRC = path.resolve(__dirname, "..");

/** Los cuatro estados que significan "alguien MIRÓ esta comida". */
const ESTADOS_EVALUADOS = [
  "COMPATIBLE",
  "COMPATIBLE_WITH_CAUTION",
  "REVIEW_REQUIRED",
  "CLINICALLY_INVALIDATED",
] as const;

/** Los dos que además significan "y salió limpia": jamás pueden ser el default. */
const ESTADOS_LIMPIOS = ["COMPATIBLE", "COMPATIBLE_WITH_CAUTION"] as const;

// ===========================================================================
// PARTE 1 — la base: una porción confirmada sin evaluar tiene que DECIRLO
// ===========================================================================

describe("§UNKNOWN≠NORMAL — una porción confirmada sin evaluación clínica no pasa por limpia", () => {
  let h: Harness;
  let hogar: { householdId: string; memberId: string };
  let proyeccionSinEvaluar: string;
  let proyeccionEvaluada: string;
  let etiquetas: string[];

  beforeAll(async () => {
    h = await levantarBase();
    hogar = await crearHogar(h, USER, "Falso Seguro", "Ana");

    etiquetas = (
      await h.filas<{ enumlabel: string }>(
        `select e.enumlabel
         from pg_enum e join pg_type t on t.oid = e.enumtypid
         where t.typname = 'clinical_assessment_status'
         order by e.enumsortorder`,
      )
    ).map((f) => f.enumlabel);

    await h.como(USER, async () => {
      const version = (await h.fila<{ id: string; template_id: string }>(
        "select id, template_id from public.meal_template_versions where status = 'PUBLISHED' limit 1",
      ))!;
      const perfil = (await h.fila<{ publish_nutrition_profile: string }>(
        `select public.publish_nutrition_profile($1, 'BASIC', 'firma-falso-seguro', '{}'::jsonb,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'falso-seguro')`,
        [hogar.memberId],
      ))!.publish_nutrition_profile;
      const plan = (await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
        [hogar.householdId],
      ))!.ensure_weekly_plan;
      const dias = await h.filas<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 2",
        [plan],
      );

      const confirmar = async (diaId: string, meal: string) => {
        const asignacion = (await h.fila<{ id: string }>(
          `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
           values ($1, $2::public.meal_type, 'RECIPE', $3, $4) returning id`,
          [diaId, meal, version.template_id, version.id],
        ))!.id;
        // El payload dice fit = COMPATIBLE: eso es el encaje NUTRICIONAL, que no
        // tiene NADA que ver con lo clínico. Confundir los dos es justamente el
        // falso-seguro que este archivo persigue.
        await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          asignacion,
          JSON.stringify([
            {
              member_id: hogar.memberId,
              version_id: version.id,
              profile_id: perfil,
              optimizer_version: "portion-optimizer/1.0.0",
              meal_type: meal,
              serving_date: "2026-08-25",
              fit: "COMPATIBLE",
              adaptation_level: 0,
              score: 90,
              nutrition: {},
              completeness: {},
              reasons: [],
              unmet_constraints: [],
              components: [],
              substitutions: [],
            },
          ]),
        ]);
        return (await h.fila<{ id: string }>(
          "select id from public.member_serving_projections where assignment_id = $1",
          [asignacion],
        ))!.id;
      };

      proyeccionSinEvaluar = await confirmar(dias[0]!.id, "LUNCH");
      proyeccionEvaluada = await confirmar(dias[1]!.id, "DINNER");

      // A ésta SÍ la miró el motor clínico y salió limpia.
      await h.db.query("select public.set_serving_clinical_status($1, 'COMPATIBLE', null)", [
        proyeccionEvaluada,
      ]);
    });
  }, 120000);

  afterAll(async () => {
    await h?.cerrar();
  });

  it("el vocabulario clínico puede decir «todavía nadie la evaluó»", () => {
    const sinEvaluar = etiquetas.filter(
      (e) => !(ESTADOS_EVALUADOS as readonly string[]).includes(e),
    );
    expect(
      sinEvaluar.length,
      `clinical_assessment_status sólo sabe decir ${etiquetas.join(", ")}: no tiene cómo ` +
        "expresar «no evaluada», así que la ausencia de evaluación se guarda como NULL " +
        "y NULL se lee como normal",
    ).toBeGreaterThanOrEqual(1);
  });

  it("una porción recién confirmada NO queda con el estado clínico en NULL", async () => {
    const fila = await h.como(USER, () =>
      h.fila<{ clinical_status: string | null }>(
        "select clinical_status::text from public.member_serving_projections where id = $1",
        [proyeccionSinEvaluar],
      ),
    );
    expect(
      fila!.clinical_status,
      "la porción nació sin evaluar y sin decirlo: NULL no es un estado, es un silencio",
    ).not.toBeNull();
  });

  it("ese estado es un VALOR propio, y ninguno de los cuatro «ya la miré»", async () => {
    const fila = await h.como(USER, () =>
      h.fila<{ clinical_status: string | null }>(
        "select clinical_status::text from public.member_serving_projections where id = $1",
        [proyeccionSinEvaluar],
      ),
    );
    const estado = fila!.clinical_status;
    expect(estado, "sigue siendo NULL: un silencio, no un estado").not.toBeNull();
    expect(
      (ESTADOS_EVALUADOS as readonly string[]).includes(estado ?? ""),
      "una comida que nadie miró se está presentando como una comida evaluada",
    ).toBe(false);
  });

  it("sin evaluar y evaluada-limpia son DISTINGUIBLES en la misma consulta", async () => {
    const filas = await h.como(USER, () =>
      h.filas<{ id: string; clinical_status: string | null }>(
        `select id, clinical_status::text
         from public.member_serving_projections
         where id = any($1::uuid[])`,
        [[proyeccionSinEvaluar, proyeccionEvaluada]],
      ),
    );
    const sin = filas.find((f) => f.id === proyeccionSinEvaluar)!;
    const con = filas.find((f) => f.id === proyeccionEvaluada)!;
    expect(con.clinical_status).toBe("COMPATIBLE");
    expect(sin.clinical_status, "la porción sin evaluar sigue sin decir nada").not.toBeNull();
    expect(
      sin.clinical_status,
      "las dos porciones se ven iguales: la que nadie evaluó y la que salió limpia",
    ).not.toBe(con.clinical_status);
  });

  it("el tablero de la semana la cuenta como PENDIENTE, no como resuelta", async () => {
    // Misma regla que debería usar /plan: «requiere atención» es todo lo que NO
    // está evaluado y limpio. Escrita por COMPLEMENTO y sin rama especial para
    // NULL, a propósito: si el estado no se basta a sí mismo, cada pantalla
    // tiene que acordarse de tratar el silencio, y tarde o temprano una se
    // olvida. Eso es exactamente lo que pasa hoy en plan/queries.ts:191.
    const pendientes = await h.como(USER, () =>
      h.fila<{ n: string }>(
        `select count(*)::text as n
         from public.member_serving_projections
         where id = $1 and clinical_status::text <> all($2::text[])`,
        [proyeccionSinEvaluar, [...ESTADOS_LIMPIOS]],
      ),
    );
    expect(
      pendientes!.n,
      "el estado no se basta solo: con NULL la comparación da NULL y la porción " +
        "sin evaluar desaparece del conteo de pendientes",
    ).toBe("1");
  });
});

// ===========================================================================
// PARTE 2 — el motor: un techo clínico CONFIRMADO limita la porción guardada
// ===========================================================================

const POLLO: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: 110, protein_g: 23, carbohydrates_g: 0, fat_g: 1.8, phosphorus_mg: 210 },
};
const ARROZ: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: 360, protein_g: 6.6, carbohydrates_g: 79, fat_g: 0.6, phosphorus_mg: 60 },
};
const ENSALADA: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: 18, protein_g: 0.9, carbohydrates_g: 3.9, fat_g: 0.2, phosphorus_mg: 24 },
};

/** Pollo + arroz + ensalada, receta base para 5. */
function receta(): PortionComponent[] {
  return [
    {
      id: "c-pollo", slotId: "s-protein", label: "Pollo", slotType: "PROTEIN", quantity: 900,
      unit: "G", weightBasis: "RAW", nutrition: POLLO, cookingMethod: "BAKED",
      adjustability: "ADJUSTABLE", minQuantity: 500, maxQuantity: 1400, ingredientId: "ing-pollo",
      productId: null, categoryId: "cat-aves", isOptional: false, role: "MAIN",
    },
    {
      id: "c-arroz", slotId: "s-carbo", label: "Arroz", slotType: "CARBOHYDRATE", quantity: 375,
      unit: "G", weightBasis: "RAW", nutrition: ARROZ, cookingMethod: "BOILED",
      adjustability: "ADJUSTABLE", minQuantity: 150, maxQuantity: 600, ingredientId: "ing-arroz",
      productId: null, categoryId: "cat-granos", isOptional: false, role: "MAIN",
    },
    {
      id: "c-ensalada", slotId: "s-salad", label: "Ensalada", slotType: "SALAD", quantity: 570,
      unit: "G", weightBasis: "RAW", nutrition: ENSALADA, cookingMethod: "RAW",
      adjustability: "ADJUSTABLE", minQuantity: 300, maxQuantity: 900,
      ingredientId: "ing-tomate", productId: null, categoryId: "cat-verduras", isOptional: false,
      role: "MAIN",
    },
  ];
}

/** Francisco: proteína 50–80 por almuerzo (ideal 65) y tope de 800 kcal. */
function francisco() {
  return buildProfile({
    memberId: "m-francisco",
    memberName: "Francisco",
    trackingMode: "FULL",
    goals: [
      { goalType: "PROTEIN_G", scope: "PER_MEAL", mealType: "LUNCH", minimum: 50, preferred: 65, maximum: 80, priority: 10 },
      { goalType: "ENERGY_KCAL", scope: "PER_MEAL", mealType: "LUNCH", minimum: null, preferred: null, maximum: 800, priority: 20 },
    ],
    pattern: {
      usesFastingPattern: false,
      firstMealType: null,
      feedingWindowStart: null,
      feedingWindowEnd: null,
      meals: [
        { mealType: "LUNCH", availability: "ENABLED", isFirstMeal: false, saladPreference: "NEUTRAL", priority: 10 },
      ],
    },
    preferences: [],
    cookingPreferences: [],
    addedFatStance: "AVOID",
  });
}

const familia = (clinicalCeilings?: { nutrient: "protein_g" | "energy_kcal"; max: number; restrictionId: string }[]) =>
  projectFamilyServings({
    versionId: "v-falso-seguro",
    components: receta(),
    baseServings: 5,
    mealType: "LUNCH",
    members: [{ profile: francisco(), clinicalCeilings }],
  });

const gramosTotales = (p: ReturnType<typeof familia>) =>
  p.servings[0]!.components.reduce((suma, c) => suma + c.proposedQuantity, 0);

describe("§31/§74 — una restricción clínica HARD confirmada SÍ limita la porción calculada", () => {
  /**
   * El techo es POR PERSONA, no por receta: una restricción clínica pertenece a
   * quien la tiene, y dos personas en la misma mesa pueden tener techos
   * distintos (o ninguno). Por eso el contrato es `members[].clinicalCeilings`
   * y no un campo suelto arriba, que obligaría a proyectar la familia una vez
   * por integrante y volvería imposible el total para cocinar (§33/§34).
   */

  it("el proyector de familia ACEPTA los techos de cada integrante y se los pasa al motor", () => {
    // Línea base: sin techo esta persona come tranquila. Si esto ya fuera un
    // conflicto, el test de más abajo pasaría por la razón equivocada.
    expect(familia().servings[0]!.fit).not.toBe("TARGET_CONFLICT");

    const conTecho = familia([{ nutrient: "protein_g", max: 40, restrictionId: "rest-prot" }]);
    const serving = conTecho.servings[0]!;
    // Techo médico 40 g contra un mínimo deportivo de 50 g: eso es un conflicto
    // declarado, jamás un promedio silencioso (AI NEVER OVERRIDES CLINICAL RULES).
    expect(
      serving.fit,
      "el techo clínico llegó vacío al motor: la porción se calculó como si nadie tuviera restricción",
    ).toBe("TARGET_CONFLICT");
    expect(serving.reasons.some((r) => r.code === "CLINICAL_CONFLICT")).toBe(true);
  });

  it("esa persona aparece en needsAttention: quien cocina se entera de que algo pasa", () => {
    const conTecho = familia([{ nutrient: "protein_g", max: 40, restrictionId: "rest-prot" }]);
    expect(conTecho.needsAttention.map((n) => n.memberName)).toContain("Francisco");
  });

  it("un techo de energía alcanzable RECORTA de verdad los gramos que se van a cocinar", () => {
    const sinTecho = familia();
    const kcalBase = sinTecho.servings[0]!.nutrition.values.energy_kcal ?? 0;
    expect(kcalBase, "la receta base tiene que aportar energía para que el caso tenga sentido").toBeGreaterThan(100);

    const techo = Math.round(kcalBase) - 60;
    const conTecho = familia([{ nutrient: "energy_kcal", max: techo, restrictionId: "rest-kcal" }]);
    const kcalConTecho = conTecho.servings[0]!.nutrition.values.energy_kcal ?? 0;

    expect(
      kcalConTecho <= techo + 1e-6 || conTecho.servings[0]!.fit === "TARGET_CONFLICT",
      `la porción quedó en ${kcalConTecho} kcal con un techo médico de ${techo} kcal, y encima ` +
        "se presenta como compatible",
    ).toBe(true);
    expect(kcalConTecho).toBeLessThan(kcalBase);
  });

  it("y el TOTAL para cocinar —lo que después va a la lista de compras— baja con él", () => {
    const sinTecho = familia();
    const kcalBase = sinTecho.servings[0]!.nutrition.values.energy_kcal ?? 0;
    const conTecho = familia([
      { nutrient: "energy_kcal", max: Math.round(kcalBase) - 60, restrictionId: "rest-kcal" },
    ]);
    expect(
      gramosTotales(conTecho),
      "el techo clínico no movió ni un gramo del total: se compra y se cocina lo mismo de siempre",
    ).toBeLessThan(gramosTotales(sinTecho));

    const totalCon = conTecho.totals.reduce((s, t) => s + t.total, 0);
    const totalSin = sinTecho.totals.reduce((s, t) => s + t.total, 0);
    expect(totalCon).toBeLessThan(totalSin);
  });

  it("el techo es de UNA persona: no se le contagia a quien está sentado al lado", () => {
    const mesa = projectFamilyServings({
      versionId: "v-falso-seguro",
      components: receta(),
      baseServings: 5,
      mealType: "LUNCH",
      members: [
        { profile: francisco() },
        {
          profile: { ...francisco(), memberId: "m-paula", memberName: "Paula" },
          clinicalCeilings: [{ nutrient: "protein_g", max: 40, restrictionId: "rest-paula" }],
        },
      ],
    });
    const [sinRestriccion, conRestriccion] = mesa.servings;
    expect(conRestriccion!.fit).toBe("TARGET_CONFLICT");
    expect(
      sinRestriccion!.fit,
      "la restricción de una persona se le aplicó a toda la mesa",
    ).not.toBe("TARGET_CONFLICT");
    expect(mesa.needsAttention.map((n) => n.memberName)).toEqual(["Paula"]);
  });

  it("sin techos, nada cambia: el candado clínico no altera el caso sano", () => {
    expect(JSON.stringify(familia())).toBe(JSON.stringify(familia(undefined)));
    expect(familia().servings[0]!.fit).not.toBe("TARGET_CONFLICT");
  });
});

// ===========================================================================
// PARTE 3 — la capa clínica tiene que estar ENCHUFADA, no sólo construida
// ===========================================================================

/** Todos los .ts/.tsx bajo web/src, sin node_modules ni artefactos. */
function fuentes(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === "node_modules" || entrada.startsWith(".")) continue;
    const completo = path.join(dir, entrada);
    if (statSync(completo).isDirectory()) salida.push(...fuentes(completo));
    else if (/\.tsx?$/.test(entrada)) salida.push(completo);
  }
  return salida;
}

/**
 * Un comentario que NOMBRA una función no la ejecuta. Sin quitar comentarios,
 * este archivo daba verde porque otro módulo mencionaba `assessMeal` en su
 * encabezado: el falso-seguro del falso-seguro.
 */
function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("§30 — el evaluador clínico no puede ser código muerto", () => {
  it("el camino que CONFIRMA una comida pasa por la evaluación clínica", () => {
    // Confirmar es el único momento en que nacen porciones de verdad. Si el
    // motor clínico no está en ese camino, todo lo demás es decorado: la
    // porción se guarda sin que nadie la haya mirado.
    const confirmacion = sinComentarios(
      readFileSync(path.resolve(WEB_SRC, "app/plan/actions.ts"), "utf8"),
    );
    const señales = ["assess-service", "evaluateMeal", "assessClinical", "clinicalCeilings"];
    expect(
      señales.filter((s) => confirmacion.includes(s)),
      "la confirmación de una comida no toca la capa clínica por ningún lado: " +
        "el motor está construido, probado y desconectado",
    ).not.toHaveLength(0);
  });

  it("la evaluación de una comida tiene llamadores reales, no menciones en comentarios", () => {
    const propios = ["app/health/assess-service.ts", "app/health/actions.ts"].map((p) =>
      path.resolve(WEB_SRC, p),
    );
    const llamadores = fuentes(WEB_SRC).filter((archivo) => {
      if (propios.includes(path.resolve(archivo))) return false;
      if (archivo.endsWith("salud-falso-seguro.test.ts")) return false;
      const codigo = sinComentarios(readFileSync(archivo, "utf8"));
      return /\b(assessMeal|evaluateMeal)\s*\(/.test(codigo) || /assess-service/.test(codigo);
    });
    expect(
      llamadores.map((a) => path.relative(WEB_SRC, a)),
      "nadie llama a la evaluación clínica: existe en el repo, no en el producto",
    ).not.toHaveLength(0);
  });

  it("el tipo de TypeScript conoce TODOS los estados que la base puede guardar", async () => {
    const h = await levantarBase({ conSeeds: false });
    try {
      const enBase = (
        await h.filas<{ enumlabel: string }>(
          `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
           where t.typname = 'clinical_assessment_status'`,
        )
      ).map((f) => f.enumlabel);

      const tipos = readFileSync(path.resolve(WEB_SRC, "domain/clinical/types.ts"), "utf8");
      const union = /export type ClinicalAssessmentStatus\s*=([\s\S]*?);/.exec(tipos);
      expect(union, "no se encontró ClinicalAssessmentStatus en domain/clinical/types.ts").not.toBeNull();
      const enTipo = [...union![1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);

      // Si la base aprende una palabra nueva y el tipo no, la pantalla se queda
      // sin rama para ella y vuelve a mostrar «nada» donde debería mostrar algo.
      expect(enBase.filter((e) => !enTipo.includes(e))).toEqual([]);
      expect(enTipo.filter((e) => !enBase.includes(e))).toEqual([]);
    } finally {
      await h.cerrar();
    }
  }, 120000);

  it("la pantalla de la comida tiene una rama para cada estado que NO es «limpio»", async () => {
    const h = await levantarBase({ conSeeds: false });
    try {
      const enBase = (
        await h.filas<{ enumlabel: string }>(
          `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
           where t.typname = 'clinical_assessment_status'`,
        )
      ).map((f) => f.enumlabel);

      const pagina = readFileSync(
        path.resolve(WEB_SRC, "app/plan/comida/[assignmentId]/page.tsx"),
        "utf8",
      );
      const sinRama = enBase
        .filter((e) => !(ESTADOS_LIMPIOS as readonly string[]).includes(e))
        .filter((e) => !pagina.includes(e));

      expect(
        sinRama,
        "la pantalla no dice nada para estos estados, así que se ven idénticos a una " +
          "porción evaluada y limpia",
      ).toEqual([]);
    } finally {
      await h.cerrar();
    }
  }, 120000);
});
