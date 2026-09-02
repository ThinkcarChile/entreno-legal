/**
 * Sprint 13 — Tipos del motor `bbq-quantity/1.0.0`.
 *
 * El motor es PURO: sin reloj, sin red, sin base. La fecha del evento entra por
 * input. Todo lo que necesita saber viaja en `BbqQuantityInput`, y todo lo que
 * NO se sabe viaja como UNKNOWN explícito — nunca como cero, nunca como
 * "normal".
 *
 * Las tres reglas que dan forma a estos tipos, y por qué existen:
 *
 *  1. UNA ESTIMACIÓN ES UN RANGO (§27). Por eso casi nada acá es `number`:
 *     `Range` lleva {min, base, max}. Un número seco ("8,427 kg") finge una
 *     precisión que no existe y el usuario deja de creerle a la app.
 *
 *  2. RAW ≠ SERVABLE (§12). Un kilo comprado no es un kilo servible: hay
 *     hueso, hay limpieza y hay merma de cocción. Por eso cada factor declara
 *     su ETAPA de origen→destino (`YieldStage`) y su FUENTE (`YieldSource`).
 *     Sin etapa declarada, un factor no se puede componer con otro sin
 *     arriesgarse a descontar la misma merma dos veces.
 *
 *  3. SIN FACTOR NO HAY NÚMERO (§13). `RangeOrUnknown` obliga a quien lee el
 *     resultado a manejar el caso "no puedo estimar esto". Es el tipo el que
 *     impide el `?? 0` y el 1:1 silencioso.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulario del evento                                                      */
/* -------------------------------------------------------------------------- */

/** §8. UNKNOWN es un valor real, no la ausencia de dato. */
export type BbqAgeGroup =
  | "CHILD_SMALL"
  | "CHILD"
  | "TEEN"
  | "ADULT"
  | "OLDER_ADULT"
  | "UNKNOWN";

/** §7. */
export type BbqAppetite = "LOW" | "NORMAL" | "HIGH" | "VERY_HIGH" | "UNKNOWN";

/** §4. */
export type BbqAttendanceStatus =
  | "INVITED"
  | "CONFIRMED"
  | "MAYBE"
  | "DECLINED"
  | "ATTENDED"
  | "NO_SHOW";

/** §6. Banderas culinarias simples: jamás un diagnóstico, jamás un lab. */
export type BbqDietaryFlag =
  | "ALLERGY_REPORTED"
  | "VEGETARIAN"
  | "VEGAN"
  | "NO_PORK"
  | "NO_BEEF"
  | "NO_FISH"
  | "OTHER_DIETARY_NOTE";

/** §10. */
export type BbqMenuCategory =
  | "VACUNO"
  | "POLLO"
  | "CERDO"
  | "EMBUTIDOS"
  | "PESCADO"
  | "VEGETARIANO"
  | "OTRO";

/** §18. Un asado después de un almuerzo completo no se estima como almuerzo. */
export type BbqMealContext =
  | "FIRST_MAJOR_MEAL"
  | "AFTER_LUNCH"
  | "EVENING_WITH_SNACKS"
  | "FULL_DAY_EVENT"
  | "OTHER";

/** §19. Nivel declarado de acompañamientos. */
export type BbqSidesLevel = "NONE" | "LIGHT" | "MEDIUM" | "ABUNDANT";

export type BbqMenuItemKind = "MEAT" | "SIDE" | "BEVERAGE" | "NON_FOOD";

export type BbqEquipmentKind = "GRILL" | "GRIDDLE" | "AIR_FRYER" | "OVEN";

export type BbqUnit = "G" | "ML" | "UNIT";

export type BbqConfidence = "LOW" | "MEDIUM" | "HIGH";

/* -------------------------------------------------------------------------- */
/* Rangos e incertidumbre                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Una estimación con supuestos: `base` es el número de producto (la política
 * declarada), `min`/`max` son la envolvente honesta. Si min === max, es que el
 * dato es un hecho, no una estimación.
 */
export interface Range {
  min: number;
  base: number;
  max: number;
}

/**
 * O hay número, o se declara por qué no lo hay. No existe la tercera opción del
 * `?? 0`: quien consume este tipo tiene que ramificar.
 */
export type RangeOrUnknown =
  | { known: true; value: Range }
  | { known: false; reason: BbqReasonCode };

/* -------------------------------------------------------------------------- */
/* Etapas físicas y dueños de cada factor                                      */
/* -------------------------------------------------------------------------- */

/** §12. Los cuatro pesos que NO son el mismo peso. */
export const WEIGHT_STAGES = ["RAW_PURCHASE", "EDIBLE_RAW", "COOKED", "SERVABLE"] as const;
export type WeightStage = (typeof WEIGHT_STAGES)[number];

/**
 * Cada factor es un tramo entre dos etapas, y siempre es `destino/origen` hacia
 * adelante en la cadena — la misma convención que `ingredient_yields` de la
 * 0009 ("peso cocido = peso crudo × yield_factor").
 */
export const YIELD_STAGES = [
  "RAW_PURCHASE_TO_EDIBLE_RAW",
  "EDIBLE_RAW_TO_COOKED",
  "COOKED_TO_SERVABLE",
] as const;
export type YieldStage = (typeof YIELD_STAGES)[number];

export type YieldSource = "CUT_DEFINITION" | "INGREDIENT_YIELD" | "HOUSEHOLD_OBSERVED";

/**
 * REGLA DE PRECEDENCIA — un tramo, un dueño.
 *
 * El defecto que cierra: el motor recibía `cutDefinitions` Y `ingredient_yields`
 * sin regla, y los dos traen un factor de cocción para el mismo corte. Aplicar
 * los dos descuenta la merma dos veces (compra ~20-30% inflada); elegir uno "el
 * que venga primero" es una regla invisible que nadie puede verificar.
 *
 * Entonces se declara acá, en una tabla que el test puede leer:
 *  - `ingredient_yields` (0009) es el ÚNICO dueño de EDIBLE_RAW→COOKED, por
 *    método de cocción. Es la tabla que ya existe y que ya usa el
 *    ShoppingEngine: dos lectores del mismo hecho, un solo escritor.
 *  - `cut_definitions` aporta SOLO lo que la 0009 no cubre: hueso + limpieza
 *    (RAW_PURCHASE→EDIBLE_RAW) y fracción servible (COOKED→SERVABLE).
 *
 * Un factor que llega desde una fuente que no es la dueña del tramo NO se usa:
 * se declara (`YIELD_STAGE_NOT_OWNED`) y, si además contradice al dueño,
 * `YIELD_STAGE_CONFLICT` deja el tramo en UNKNOWN. El motor jamás desempata
 * solo entre dos números que dicen cosas distintas sobre la misma física.
 */
export const YIELD_STAGE_OWNER: Record<YieldStage, YieldSource> = {
  RAW_PURCHASE_TO_EDIBLE_RAW: "CUT_DEFINITION",
  EDIBLE_RAW_TO_COOKED: "INGREDIENT_YIELD",
  COOKED_TO_SERVABLE: "CUT_DEFINITION",
};

/* -------------------------------------------------------------------------- */
/* Entradas                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * §11. Metadata culinaria del corte. Todos los factores son nullables porque
 * UNKNOWN sigue UNKNOWN: un corte sin fuente citable no tiene número.
 */
export interface BbqCutDefinitionInput {
  /** Clave estable del corte (ingredient_id o product_id ya resuelto arriba). */
  cutRef: string;
  /** null = no se sabe si tiene hueso. No es "sin hueso". */
  boneIn: boolean | null;
  /** Fracción comestible cruda sobre el peso comprado (hueso + limpieza). */
  rawPurchaseToEdibleRaw: number | null;
  /** Fracción servible sobre el peso cocido (lo que se pierde al trozar/servir). */
  cookedToServable: number | null;
  /**
   * La 0041 conserva esta columna, pero el dueño del tramo es
   * `ingredient_yields`. Si viene con valor, el motor lo DECLARA y no lo usa.
   * Está en el tipo justamente para poder detectar el conflicto, no para usarlo.
   */
  edibleRawToCooked: number | null;
  /** Obligatoria: un factor sin procedencia no es un factor validado (§13). */
  source: string;
  confidence: BbqConfidence | null;
}

/** Fila de `ingredient_yields` (0009): cocido = crudo comestible × factor. */
export interface BbqIngredientYieldInput {
  cutRef: string;
  /** null = fila genérica. La fila con método le gana a la genérica (0009). */
  cookingMethod: string | null;
  factor: number;
  source: string;
}

/**
 * §14. Rendimiento observado por el hogar.
 *
 * El defecto que cierra: `household_observed_yields` guarda un factor
 * entrada→salida SIN semántica de etapa. "5.000 g crudo → 3.550 g cocido" no
 * dice si ese 0,71 incluye el hueso, la limpieza o solo la cocción. Mezclarlo
 * con el factor de referencia y ADEMÁS aplicar hueso/limpieza descuenta la
 * misma merma dos veces.
 *
 * Por eso el motor exige que la observación declare `stage` Y `cookingMethod`:
 * sin eso queda fuera del estimador (sigue siendo historia, no señal).
 */
export interface BbqObservedYieldInput {
  cutRef: string;
  /** null = etapa indeterminada ⇒ la observación NO entra al estimador. */
  stage: YieldStage | null;
  /** null = método indeterminado ⇒ tampoco entra: otro método es otra física. */
  cookingMethod: string | null;
  factor: number;
  /** Cuántas observaciones respaldan este factor (§51: una sola no manda). */
  observations: number;
}

/**
 * Lo que la app YA TIENE registrado sobre qué NO puede comer una persona,
 * traducido a items del menú de ESTE evento.
 *
 * El defecto que cierra: los integrantes del hogar entraban al estimador con
 * `dietaryFlags: null` —las banderas culinarias sólo existen para los invitados—
 * y el motor leía null como "no hay restricción declarada", o sea le repartía a
 * cada uno el menú entero. La familia con una alergia registrada EN ESTA MISMA
 * APP recibía su porción del corte que no puede comer.
 *
 * Acá llega el QUÉ y nunca el POR QUÉ: la ficha familiar y las restricciones
 * clínicas confirmadas se resuelven en la base (`public.event_menu_blocks`) y
 * cruzan la frontera como pares (persona, item) más una marca de alergia. El
 * diagnóstico no viaja, así que no puede terminar dibujado en una pantalla que
 * se mira entre invitados.
 */
export interface BbqRecordedBlocks {
  /** Items del menú que esta persona NO puede comer. `[]` = se miró y no hay. */
  blockedItemIds: readonly string[];
  /**
   * De esos, los bloqueados por una ALERGIA registrada. El alérgeno se conoce y
   * el item ya quedó fuera de su porción: por eso no exige revisión humana como
   * la alergia sin alérgeno conocido (§23), pero sí se dice en las razones.
   */
  allergyItemIds: readonly string[];
}

export interface BbqParticipantInput {
  id: string;
  kind: "HOUSEHOLD_MEMBER" | "GUEST";
  ageGroup: BbqAgeGroup;
  /** Apetito EFECTIVO (override del evento ?? perfil), resuelto aguas arriba. */
  appetite: BbqAppetite;
  attendance: BbqAttendanceStatus;
  /**
   * UNKNOWN ≠ ZERO codificado en el tipo: `null` = SIN INFORMACIÓN, `[]` = el
   * invitado declaró que no tiene restricciones. No son lo mismo y el motor no
   * los trata igual (uno baja la confianza, el otro no).
   */
  dietaryFlags: readonly BbqDietaryFlag[] | null;
  /**
   * `null` = esta persona NO tiene ficha en la casa (un invitado): lo único que
   * se sabe de ella es `dietaryFlags`. Con valor, la ficha familiar SÍ se
   * consultó, así que un `dietaryFlags: null` al lado de un `blockedItemIds: []`
   * ya no es "no sabemos": es "se miró y no hay nada anotado".
   */
  recordedBlocks: BbqRecordedBlocks | null;
  /** §16/§78: señal opcional de escala. Jamás IMC, jamás diagnóstico. */
  approxWeightKg: number | null;
}

export interface BbqMenuItemInput {
  id: string;
  kind: BbqMenuItemKind;
  /** null = categoría desconocida: no se puede PROBAR que sea compatible. */
  category: BbqMenuCategory | null;
  cutRef: string | null;
  displayName: string;
  /** §21. null en todos = modo AUTO. */
  distributionPct: number | null;
  /** Elige la fila correcta de `ingredient_yields` (§0009). */
  cookingMethod: string | null;
  /** Equipo donde se cocina, para las tandas (§39). */
  equipmentId: string | null;
}

/**
 * Un lote utilizable del inventario. `availableG` ya viene neteado de reservas
 * por `analyzeStock` (§29: el stock reservado para otra comida no está
 * disponible para el asado); el motor no consulta la base ni decide FEFO —
 * elegir el lote es del SafetyEngine (§30).
 */
export interface BbqInventoryLotInput {
  lotId: string;
  cutRef: string;
  availableG: number;
  /**
   * Base física del peso guardado: un costillar congelado pesa CON hueso y una
   * sobra cocida pesa ya cocida. `null` = la base del lote NO se puede mapear a
   * las etapas del §12 (AS_PACKAGED, DRAINED, o un "crudo" que no dice si es de
   * compra o ya limpio). Ese lote no se netea 1:1: su aporte queda UNKNOWN.
   */
  stage: WeightStage | null;
  frozen: boolean;
}

export interface BbqEquipmentInput {
  id: string;
  kind: BbqEquipmentKind;
  maxBatch: number | null;
  maxBatchUnit: BbqUnit | null;
}

/** §25. Sobrante planificado — NO confundir con el margen de seguridad (§26). */
export type BbqDesiredLeftover =
  | { kind: "NONE" }
  | { kind: "SMALL_BUFFER" }
  | { kind: "ONE_EXTRA_MEAL" }
  | { kind: "CUSTOM"; grams: number };

export interface BbqQuantityInput {
  /** YYYY-MM-DD. El motor no tiene reloj: la fecha del evento entra por acá. */
  eventDate: string;
  participants: readonly BbqParticipantInput[];
  menu: readonly BbqMenuItemInput[];
  /** null = no declarado (UNKNOWN), no "medio". */
  sidesLevel: BbqSidesLevel | null;
  mealContext: BbqMealContext | null;
  /** null = UNKNOWN. Jamás 0: un evento de cero horas no existe. */
  durationHours: number | null;
  desiredLeftover: BbqDesiredLeftover;
  /** §26. null = el usuario no declaró margen ⇒ 0, y se dice en las razones. */
  safetyBufferPct: number | null;
  cutDefinitions: readonly BbqCutDefinitionInput[];
  ingredientYields: readonly BbqIngredientYieldInput[];
  observedYields: readonly BbqObservedYieldInput[];
  inventory: readonly BbqInventoryLotInput[];
  equipment: readonly BbqEquipmentInput[];
  /**
   * §39 + hallazgo de tandas: las tandas se cuentan sobre el CRUDO COMESTIBLE
   * del plan ACEPTADO (TU PLAN post-override, que ya es un compromiso). Sin
   * plan aceptado, las tandas salen como rango; nunca como escalar inventado.
   * Clave = id del item de menú.
   */
  acceptedPlanRawEdibleG: Readonly<Record<string, number>> | null;
  policy: BbqQuantityPolicy;
}

/* -------------------------------------------------------------------------- */
/* Política de producto (§17: nada mágico escondido)                           */
/* -------------------------------------------------------------------------- */

export interface BbqDietaryRule {
  /** Si está, el invitado SOLO puede comer de estas categorías. */
  allowOnly: readonly BbqMenuCategory[] | null;
  exclude: readonly BbqMenuCategory[] | null;
  /** La bandera no permite decidir sola: exige revisión humana (§23). */
  review: boolean;
}

export interface BbqQuantityPolicy {
  version: string;
  /** De dónde sale el número base. Es PRODUCT POLICY, no requisito médico. */
  source: string;
  /** §17. Gramos SERVIBLES por adulto: rango, porque los adultos no son iguales. */
  gramsServablePerAdult: Range;
  /** §76. Política infantil explícita: nada de "medio adulto" implícito. */
  ageFactor: Record<BbqAgeGroup, Range>;
  appetiteFactor: Record<BbqAppetite, Range>;
  attendanceWeight: Record<BbqAttendanceStatus, Range>;
  mealContextFactor: Record<BbqMealContext | "UNKNOWN", Range>;
  sidesFactor: Record<BbqSidesLevel | "UNKNOWN", Range>;
  longEventHours: number;
  longEventFactor: number;
  durationUnknownFactor: Range;
  anthropometrics: {
    referenceAdultWeightKg: number;
    /** §16: como mucho ±10%. El apetito y el historial pesan más. */
    maxAdjust: number;
  };
  /**
   * Cómo se agrega la banda del grupo. Está en la política, con versión, porque
   * es una decisión de producto: sumar rangos persona a persona hace crecer la
   * banda linealmente con el headcount, y físicamente pasa lo contrario (en
   * grupos grandes los apetitos se compensan). Un rango que se vuelve más
   * inútil justo cuando el evento es más grande, el usuario lo ignora.
   *
   * La banda de VARIACIÓN (gente distinta comiendo distinto) se contrae como
   * N^-0.5 — promedio de variables casi independientes. La banda de IGNORANCIA
   * (no sé el apetito de nadie) se contrae mucho menos (N^-0.25): no saber de
   * once personas puede ser un sesgo común, no ruido que se cancele.
   */
  band: {
    variationExponent: number;
    minVariationScale: number;
    ignoranceExponent: number;
    minIgnoranceScale: number;
  };
  desiredLeftover: {
    /** SMALL_BUFFER = esta cantidad de porciones adultas base. */
    smallBufferServings: number;
  };
  observedYield: {
    /** §51: menos observaciones que esto y el hogar no manda sobre la referencia. */
    minObservations: number;
    /** Peso máximo de lo observado frente a la referencia. */
    maxWeight: number;
    /** Con esta cantidad de observaciones se alcanza `maxWeight`. */
    fullTrustObservations: number;
  };
  distribution: {
    auto: "EQUAL_SHARE";
    pctTolerance: number;
  };
  dietaryRules: Record<BbqDietaryFlag, BbqDietaryRule>;
  confidence: {
    highMaxRelativeWidth: number;
    mediumMaxRelativeWidth: number;
    minDietaryCoverageHigh: number;
    minDietaryCoverageMedium: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Explicabilidad (patrón de portions/reasons.ts: código + params + texto)      */
/* -------------------------------------------------------------------------- */

export const BBQ_REASON_CODES = [
  "BASE_POLICY",
  "HEADCOUNT_MIX",
  "ATTENDANCE_UNCERTAIN",
  "AGE_UNKNOWN",
  "APPETITE_KNOWN",
  "APPETITE_UNKNOWN",
  "ANTHROPOMETRIC_ADJUST",
  "MEAL_CONTEXT_APPLIED",
  "MEAL_CONTEXT_UNKNOWN",
  "SIDES_APPLIED",
  "SIDES_UNKNOWN",
  "DURATION_LONG",
  "DURATION_UNKNOWN",
  "GROUP_BAND",
  "DESIRED_LEFTOVER",
  "EXTRA_MEAL_PEOPLE_UNKNOWN",
  "SAFETY_BUFFER",
  "SAFETY_BUFFER_NOT_SET",
  "DISTRIBUTION_PCT",
  "DISTRIBUTION_AUTO",
  "DISTRIBUTION_PCT_INVALID",
  "DISTRIBUTION_SEGMENTED",
  "MENU_CATEGORY_UNKNOWN",
  "NO_MEAT_ITEMS",
  "NO_COMPATIBLE_ITEM",
  "DIETARY_INFO_MISSING",
  "RECORDED_RESTRICTIONS_APPLIED",
  "ALLERGY_ITEM_EXCLUDED",
  "ALLERGY_REVIEW_REQUIRED",
  "OTHER_DIETARY_NOTE_REVIEW",
  "YIELD_CHAIN_COMPLETE",
  "YIELD_UNKNOWN",
  "YIELD_STAGE_CONFLICT",
  "YIELD_STAGE_NOT_OWNED",
  "OBSERVED_YIELD_BLENDED",
  "OBSERVED_YIELD_SOLE_SOURCE",
  "OBSERVED_YIELD_IGNORED",
  "INVENTORY_NETTED",
  "INVENTORY_YIELD_UNKNOWN",
  "INVENTORY_FROZEN",
  "EQUIPMENT_CAPACITY_UNKNOWN",
  "EQUIPMENT_UNIT_MISMATCH",
  "BATCHES_RANGE",
  "BATCHES_FROM_ACCEPTED_PLAN",
  "LEFTOVERS_BEFORE_ROUNDING",
  "PURCHASE_UNKNOWN_TOTAL",
] as const;

export type BbqReasonCode = (typeof BBQ_REASON_CODES)[number];

export type BbqReasonParams = Record<string, string | number>;

export interface BbqReason {
  code: BbqReasonCode;
  params: BbqReasonParams;
  /** Texto compuesto para el botón "¿POR QUÉ ESTA CANTIDAD?" (§34). */
  text: string;
}

export interface BbqReview {
  code: BbqReasonCode;
  scope: "EVENT" | "CUT" | "PARTICIPANTS";
  /** id del item de menú o del grupo afectado; null = todo el evento. */
  ref: string | null;
  text: string;
}

/* -------------------------------------------------------------------------- */
/* Salidas                                                                     */
/* -------------------------------------------------------------------------- */

export interface BbqChainStageReport {
  stage: YieldStage;
  factor: number | null;
  source: YieldSource | null;
  /** Cuántas observaciones del hogar se mezclaron (0 = ninguna). */
  observations: number;
  conflict: boolean;
}

export type BbqBatches =
  | { known: true; kind: "EXACT"; batches: number }
  | { known: true; kind: "RANGE"; min: number; max: number }
  | { known: false; reason: BbqReasonCode };

export type BbqInventoryUse =
  | { known: true; grams: number; frozenGrams: number; lotIds: readonly string[] }
  | { known: false; reason: BbqReasonCode; faceValueGrams: number; lotIds: readonly string[] };

export interface BbqCutPlan {
  itemId: string;
  cutRef: string | null;
  displayName: string;
  category: BbqMenuCategory | null;
  /** Lo que hay que poner en el plato. Siempre conocido: sale de la demanda. */
  servable: Range;
  cooked: RangeOrUnknown;
  rawEdible: RangeOrUnknown;
  rawPurchase: RangeOrUnknown;
  inventoryToUse: BbqInventoryUse;
  purchaseRequired: RangeOrUnknown;
  batches: BbqBatches;
  /** La cadena de factores, tramo por tramo: hace VERIFICABLE la precedencia. */
  chain: readonly BbqChainStageReport[];
  flags: readonly BbqReasonCode[];
}

export interface BbqHeadcount {
  participants: number;
  /** Con peso > 0: los DECLINED/NO_SHOW no comen. */
  counted: number;
  adults: number;
  children: number;
  unknownAge: number;
  householdMembers: number;
  guests: number;
  byAttendance: Record<BbqAttendanceStatus, number>;
  /** Headcount ponderado por asistencia: MAYBE es 0..1, no 0,5 a secas. */
  effective: Range;
}

export interface BbqDataCoverage {
  appetiteKnown: number;
  ageKnown: number;
  dietaryInfoKnown: number;
  attendanceConfirmed: number;
  cutsWithFullChain: number;
}

export interface BbqDemandLines {
  /** Lo que se estima que comen los presentes. */
  participants: Range;
  /** §25. Sobrante que el usuario PIDIÓ. Es un objetivo, no incertidumbre. */
  desiredLeftoverGrams: number;
  /** §26. Margen de incertidumbre, SEPARADO del sobrante planificado. */
  safetyBuffer: Range;
  total: Range;
}

export interface BbqQuantityResult {
  engineVersion: string;
  policyVersion: string;
  policySource: string;
  /** §93. Misma firma ⇒ misma revisión; firma nueva ⇒ revisión nueva. */
  inputSignature: string;
  headcount: BbqHeadcount;
  demand: BbqDemandLines;
  totalServableDemand: Range;
  byCut: readonly BbqCutPlan[];
  /**
   * Demanda de gente que no tiene NINGÚN item compatible en el menú. No se
   * reparte entre cortes que esa persona no puede comer: se declara.
   */
  uncoveredServableDemand: Range | null;
  /**
   * §28 vive aguas abajo (ProcurementEngine redondea a presentación comercial).
   * Por eso este sobrante se rotula: si el proveedor vende cajas de 5 kg, la
   * sobra REAL será mayor que ésta, y la vista de compras la deriva restando.
   */
  expectedLeftovers: { range: Range; basis: "BEFORE_COMMERCIAL_ROUNDING" };
  /** Suma de las líneas con cadena completa. */
  knownPurchaseSubtotal: Range;
  /** UNKNOWN si algún corte no tiene cadena: no se suma lo que no se sabe. */
  totalPurchaseRequired: RangeOrUnknown;
  coverage: BbqDataCoverage;
  confidence: BbqConfidence;
  reasons: readonly BbqReason[];
  reviewRequired: readonly BbqReview[];
}
