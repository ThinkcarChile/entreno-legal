/**
 * BbqQuantityEstimator — `bbq-quantity/1.0.0`.
 *
 * Contesta "vienen 11 personas el sábado: ¿cuánto compro?" sin inventar nada.
 *
 * PURO Y DETERMINISTA: no lee el reloj (la fecha del evento entra por input),
 * no toca la red ni la base, y con los mismos insumos entrega el mismo
 * resultado byte a byte. Eso es lo que permite congelar la estimación en una
 * `EventPlanRevision` y que un evento viejo conserve su número aunque mañana
 * cambie la política (§93-95).
 *
 * LAS CINCO COSAS QUE ESTE MOTOR SE NIEGA A HACER, y por qué:
 *
 *  1. Tratar UNKNOWN como "normal". Un invitado del que no sabemos el apetito
 *     NO puede aportar el mismo número que uno declarado NORMAL. Acá la
 *     contribución de cada persona es un RANGO: el dato conocido lo angosta, el
 *     dato ausente lo deja en la envolvente completa de la política. La
 *     confianza sale del ANCHO del rango, no al revés — antes era una etiqueta
 *     de semáforo pegada encima de un número que no cambiaba nunca.
 *
 *  2. Componer factores de merma sin saber de qué tramo son. Cada factor
 *     declara su etapa (§12) y su dueño (`YIELD_STAGE_OWNER`): así el hueso no
 *     se descuenta dos veces ni se olvida. Dos fuentes para el mismo tramo =
 *     conflicto declarado, no desempate silencioso.
 *
 *  3. Convertir un rendimiento observado del hogar en algo que no midió. Una
 *     observación sin etapa ni método declarados queda fuera del estimador: es
 *     historia, no señal (un "5.000 → 3.550" que incluye hueso no es merma de
 *     cocción).
 *
 *  4. Inventar la merma de cocción de un corte. Sin factor validado, la línea
 *     dice UNKNOWN y pide revisión. Nunca 1:1 — 1:1 significaría que la carne
 *     no pierde agua al asarse, que es sencillamente falso y hace comprar de
 *     menos justo el sábado.
 *
 *  5. Leer "no trae banderas dietarias" como "puede comer todo el menú". Las
 *     banderas culinarias sólo existen para los invitados; de la familia la app
 *     sabe más, y por ingrediente. Por eso cada participante puede traer
 *     `recordedBlocks` —qué items del menú tiene bloqueados según la ficha del
 *     hogar y las restricciones clínicas confirmadas—, y esa persona NO recibe
 *     su porción de esos cortes. El motor recibe el QUÉ, nunca el porqué: el
 *     motivo se queda en la base y no puede terminar dibujado en una pantalla
 *     que se mira entre invitados.
 *
 * Lo que sí hace: primero la demanda TOTAL servible del grupo, después la
 * distribución entre cortes (§20, jamás multiplicar por la cantidad de carnes),
 * y todo con sus supuestos escritos en `reasons` para el botón "¿POR QUÉ ESTA
 * CANTIDAD?" (§34).
 */

import { signature } from "@/domain/nutrition/profile";
import {
  YIELD_STAGES,
  YIELD_STAGE_OWNER,
  type BbqAgeGroup,
  type BbqAppetite,
  type BbqAttendanceStatus,
  type BbqBatches,
  type BbqChainStageReport,
  type BbqConfidence,
  type BbqCutDefinitionInput,
  type BbqCutPlan,
  type BbqDataCoverage,
  type BbqDemandLines,
  type BbqEquipmentInput,
  type BbqHeadcount,
  type BbqIngredientYieldInput,
  type BbqInventoryLotInput,
  type BbqInventoryUse,
  type BbqMenuItemInput,
  type BbqObservedYieldInput,
  type BbqParticipantInput,
  type BbqQuantityInput,
  type BbqQuantityPolicy,
  type BbqQuantityResult,
  type BbqReason,
  type BbqReasonCode,
  type BbqReasonParams,
  type BbqReview,
  type Range,
  type RangeOrUnknown,
  type WeightStage,
  type YieldSource,
  type YieldStage,
} from "./types";

export const BBQ_QUANTITY_VERSION = "bbq-quantity/1.0.0";
export const BBQ_QUANTITY_POLICY_VERSION = "bbq-quantity-policy/1.0.0";

/** Tolerancia de comparación de factores: dos fuentes "iguales" hasta acá. */
const EPS = 1e-6;

/* ========================================================================== */
/* POLÍTICA DE PRODUCTO (§17: ningún número mágico escondido en el código)     */
/* ========================================================================== */

/**
 * Cada número de acá es PRODUCT POLICY, no requisito médico ni nutricional
 * (§17, §78). Son la convención parrillera chilena de cuánta carne servir, del
 * mismo orden que usa cualquier carnicería para responder "¿cuánto llevo?".
 * Viven en un objeto versionado para que una `EventPlanRevision` pueda
 * congelarlos y para que cambiarlos mañana no reescriba la historia (§95).
 */
export const DEFAULT_BBQ_QUANTITY_POLICY: BbqQuantityPolicy = {
  version: BBQ_QUANTITY_POLICY_VERSION,
  source:
    "PRODUCT POLICY: convención parrillera chilena (gramos servibles por adulto). " +
    "No es una recomendación nutricional ni un requisito médico.",
  // Rango, no número: dos adultos declarados NORMAL igual comen distinto.
  gramsServablePerAdult: { min: 250, base: 320, max: 400 },
  ageFactor: {
    CHILD_SMALL: pt(0.35),
    CHILD: pt(0.5),
    TEEN: pt(0.9),
    ADULT: pt(1),
    OLDER_ADULT: pt(0.85),
    // §77: sin datos se usa la base de adulto (baseline de producto), pero la
    // envolvente admite que podría ser un niño. Hacia arriba no se abre: nadie
    // come más que un adulto por el solo hecho de que no sepamos su edad.
    UNKNOWN: { min: 0.5, base: 1, max: 1 },
  },
  appetiteFactor: {
    LOW: pt(0.75),
    NORMAL: pt(1),
    HIGH: pt(1.25),
    VERY_HIGH: pt(1.45),
    // El corazón del arreglo: UNKNOWN abre la envolvente completa LOW..VERY_HIGH.
    UNKNOWN: { min: 0.75, base: 1, max: 1.45 },
  },
  attendanceWeight: {
    CONFIRMED: pt(1),
    ATTENDED: pt(1),
    // "Tal vez" es binario en la realidad: viene o no viene. 0,5 seco escondería
    // que el resultado puede ser cualquiera de los dos extremos.
    MAYBE: { min: 0, base: 0.5, max: 1 },
    INVITED: { min: 0.5, base: 0.8, max: 1 },
    DECLINED: pt(0),
    NO_SHOW: pt(0),
  },
  mealContextFactor: {
    FIRST_MAJOR_MEAL: pt(1),
    AFTER_LUNCH: pt(0.6),
    EVENING_WITH_SNACKS: pt(0.8),
    FULL_DAY_EVENT: pt(1.2),
    OTHER: { min: 0.6, base: 1, max: 1.2 },
    UNKNOWN: { min: 0.6, base: 1, max: 1.2 },
  },
  sidesFactor: {
    NONE: pt(1.1),
    LIGHT: pt(1),
    MEDIUM: pt(0.9),
    ABUNDANT: pt(0.75),
    UNKNOWN: { min: 0.75, base: 1, max: 1.1 },
  },
  longEventHours: 4,
  longEventFactor: 1.1,
  durationUnknownFactor: { min: 1, base: 1, max: 1.1 },
  anthropometrics: { referenceAdultWeightKg: 70, maxAdjust: 0.1 },
  band: {
    variationExponent: 0.5,
    minVariationScale: 0.35,
    ignoranceExponent: 0.25,
    minIgnoranceScale: 0.5,
  },
  desiredLeftover: { smallBufferServings: 1 },
  observedYield: { minObservations: 3, maxWeight: 0.5, fullTrustObservations: 6 },
  distribution: { auto: "EQUAL_SHARE", pctTolerance: 0.01 },
  dietaryRules: {
    // Una alergia REPORTADA no dice a qué: no se puede excluir automáticamente
    // nada, y por eso exige revisión humana (§23). "No sé el alérgeno" jamás
    // puede leerse como "es seguro servirle".
    ALLERGY_REPORTED: { allowOnly: null, exclude: null, review: true },
    VEGETARIAN: { allowOnly: ["VEGETARIANO"], exclude: null, review: false },
    VEGAN: { allowOnly: ["VEGETARIANO"], exclude: null, review: false },
    // En Chile los embutidos de asado (longaniza, prietas, chorizo) son de
    // cerdo: quien no come cerdo tampoco los come.
    NO_PORK: { allowOnly: null, exclude: ["CERDO", "EMBUTIDOS"], review: false },
    NO_BEEF: { allowOnly: null, exclude: ["VACUNO"], review: false },
    NO_FISH: { allowOnly: null, exclude: ["PESCADO"], review: false },
    OTHER_DIETARY_NOTE: { allowOnly: null, exclude: null, review: true },
  },
  confidence: {
    highMaxRelativeWidth: 0.2,
    mediumMaxRelativeWidth: 0.5,
    minDietaryCoverageHigh: 0.8,
    minDietaryCoverageMedium: 0.5,
  },
};

/* ========================================================================== */
/* Utilidades numéricas                                                        */
/* ========================================================================== */

function pt(value: number): Range {
  return { min: value, base: value, max: value };
}

function g(value: number): number {
  // Gramos enteros: el medio gramo en un asado es falsa precisión pura.
  return Math.round(value);
}

function roundRange(r: Range): Range {
  return { min: g(r.min), base: g(r.base), max: g(r.max) };
}

function scaleRange(r: Range, factor: number): Range {
  return { min: r.min * factor, base: r.base * factor, max: r.max * factor };
}

/** Multiplica rango por rango: min con min, max con max. */
function mulRange(r: Range, other: Range): Range {
  return { min: r.min * other.min, base: r.base * other.base, max: r.max * other.max };
}

function addRange(r: Range, other: Range): Range {
  return { min: r.min + other.min, base: r.base + other.base, max: r.max + other.max };
}

function subtractFlat(r: Range, amount: number): Range {
  return {
    min: Math.max(0, r.min - amount),
    base: Math.max(0, r.base - amount),
    max: Math.max(0, r.max - amount),
  };
}

function divideRange(r: Range, factor: number): Range {
  return { min: r.min / factor, base: r.base / factor, max: r.max / factor };
}

/**
 * Contracción de la banda del grupo. Redondeada a 1e-6 a propósito: `Math.pow`
 * puede diferir en el último bit entre motores y este resultado tiene que ser
 * idéntico byte a byte para que la firma de idempotencia sirva.
 */
function bandScale(n: number, exponent: number, floor: number): number {
  const raw = Math.pow(Math.max(1, n), -exponent);
  return Math.max(floor, Math.round(raw * 1e6) / 1e6);
}

/**
 * Formateo propio en vez de `toLocaleString`: el ICU del entorno puede cambiar
 * el separador y el texto de una razón forma parte de la salida congelada.
 */
function fmt(value: number): string {
  const total = Math.round(Math.abs(value) * 10);
  const entero = Math.floor(total / 10);
  const decimal = total % 10;
  const miles = String(entero).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cuerpo = decimal > 0 ? `${miles},${decimal}` : miles;
  return value < 0 ? `-${cuerpo}` : cuerpo;
}

function pct(value: number): string {
  return `${fmt(value * 100)}%`;
}

/* ========================================================================== */
/* Razones y revisiones                                                        */
/* ========================================================================== */

const TEXTOS: Record<BbqReasonCode, (p: BbqReasonParams) => string> = {
  BASE_POLICY: (p) =>
    `Base de producto: ${fmt(Number(p.base))} g servibles por adulto (rango ${fmt(Number(p.min))}–${fmt(Number(p.max))} g), política ${p.policy}.`,
  HEADCOUNT_MIX: (p) =>
    `${p.adultos} adulto(s), ${p.ninos} niño(s) y ${p.desconocidos} sin edad declarada.`,
  ATTENDANCE_UNCERTAIN: (p) =>
    `${p.cantidad} persona(s) sin asistencia confirmada: el rango incluye que vengan y que no.`,
  AGE_UNKNOWN: (p) =>
    `${p.cantidad} invitado(s) sin edad declarada: cuentan como adulto para la referencia, pero el rango deja abierto que sean niños.`,
  APPETITE_KNOWN: (p) => `${p.cantidad} persona(s) con apetito declarado ${p.detalle}.`,
  APPETITE_UNKNOWN: (p) =>
    `${p.cantidad} persona(s) sin apetito conocido: por eso el rango es más ancho, no porque coman más.`,
  ANTHROPOMETRIC_ADJUST: (p) =>
    `${p.cantidad} persona(s) con peso declarado ajustan su porción como máximo ${pct(Number(p.tope))} (nunca se calcula IMC ni se diagnostica nada).`,
  MEAL_CONTEXT_APPLIED: (p) => `Contexto ${p.contexto}: factor ${p.factor} sobre la demanda.`,
  MEAL_CONTEXT_UNKNOWN: () =>
    "No se declaró si el asado es la comida principal o viene después de otra: el rango cubre las dos situaciones.",
  SIDES_APPLIED: (p) => `Acompañamientos ${p.nivel}: factor ${p.factor} sobre la demanda de carne.`,
  SIDES_UNKNOWN: () =>
    "No se declaró el nivel de acompañamientos: el rango cubre desde sin acompañamientos hasta abundantes.",
  DURATION_LONG: (p) => `Evento de ${p.horas} h: factor ${p.factor} por duración larga.`,
  DURATION_UNKNOWN: () => "Duración no declarada: el rango cubre que el asado se estire.",
  GROUP_BAND: (p) =>
    `Banda grupal para ${p.personas} persona(s): ±${pct(Number(p.ancho))} sobre la referencia (los apetitos individuales se compensan en grupo).`,
  DESIRED_LEFTOVER: (p) => `Sobrante pedido (${p.tipo}): ${fmt(Number(p.gramos))} g servibles. ${p.detalle}`,
  EXTRA_MEAL_PEOPLE_UNKNOWN: () =>
    "Pediste una comida extra de sobrante, pero no hay miembros del hogar en la lista de participantes: no se puede saber para cuántas personas es.",
  SAFETY_BUFFER: (p) => `Margen de seguridad ${pct(Number(p.pct))}: ${fmt(Number(p.gramos))} g, separado del sobrante pedido.`,
  SAFETY_BUFFER_NOT_SET: () => "Sin margen de seguridad declarado: se usó 0%.",
  DISTRIBUTION_PCT: (p) => `Distribución declarada por corte: ${p.detalle}.`,
  DISTRIBUTION_AUTO: (p) => `Distribución AUTO: partes iguales entre ${p.cantidad} corte(s).`,
  DISTRIBUTION_PCT_INVALID: (p) =>
    `Los porcentajes por corte no suman 100 (suman ${fmt(Number(p.suma))}) o están incompletos: se repartió en partes iguales y queda para revisar.`,
  DISTRIBUTION_SEGMENTED: (p) =>
    `${p.sinRestriccion} persona(s) comen de todo y ${p.conRestriccion} tienen restricción declarada: su porción se calculó solo sobre lo que sí pueden comer (${fmt(Number(p.gramosAlternativa))} g).`,
  MENU_CATEGORY_UNKNOWN: (p) =>
    `${p.cantidad} item(s) del menú sin categoría: no se pueden ofrecer a quien tiene restricciones, porque no se puede probar que sean compatibles.`,
  NO_MEAT_ITEMS: () => "El menú no tiene carnes: la demanda servible queda calculada, pero no hay cómo distribuirla.",
  NO_COMPATIBLE_ITEM: (p) =>
    `${p.cantidad} persona(s) no tienen ningún item compatible en el menú: su porción (${fmt(Number(p.gramos))} g) queda sin cubrir a propósito.`,
  DIETARY_INFO_MISSING: (p) =>
    `${p.cantidad} invitado(s) sin información de restricciones — considera preguntar antes de comprar. Sin información no es "sin restricciones".`,
  RECORDED_RESTRICTIONS_APPLIED: (p) =>
    `${p.cantidad} persona(s) de la casa tienen restricciones ya registradas en la aplicación: su porción se calculó sólo sobre lo que sí pueden comer. Acá no se dice de quién ni por qué.`,
  ALLERGY_ITEM_EXCLUDED: (p) =>
    `${p.cantidad} persona(s) de la casa tienen alergia registrada a algo de este menú: ese plato quedó fuera de su porción. Ojo igual con la parrilla y los utensilios compartidos.`,
  ALLERGY_REVIEW_REQUIRED: (p) =>
    `${p.cantidad} invitado(s) reportaron alergia: hay que revisar a mano si el menú permite servirles con seguridad.`,
  OTHER_DIETARY_NOTE_REVIEW: (p) =>
    `${p.cantidad} invitado(s) tienen una nota dietaria libre: no se puede decidir automáticamente, revísala.`,
  YIELD_CHAIN_COMPLETE: (p) =>
    `${p.corte}: cadena completa comprado→comestible→cocido→servible (${p.detalle}).`,
  YIELD_UNKNOWN: (p) =>
    `${p.corte}: falta el factor de ${p.tramo}. No se puede decir cuánto comprar sin inventarlo, así que la línea queda para revisar.`,
  YIELD_STAGE_CONFLICT: (p) =>
    `${p.corte}: dos fuentes distintas dan un factor para ${p.tramo} (${p.detalle}). El motor no desempata: el tramo queda desconocido.`,
  YIELD_STAGE_NOT_OWNED: (p) =>
    `${p.corte}: la ficha del corte trae un factor de ${p.tramo}, pero ese tramo lo manda ${p.dueno}. No se usa; muévelo a la tabla que corresponde.`,
  OBSERVED_YIELD_BLENDED: (p) =>
    `${p.corte}: ${p.observaciones} observación(es) del hogar (${p.metodo}) mezcladas con la referencia al ${pct(Number(p.peso))}.`,
  OBSERVED_YIELD_SOLE_SOURCE: (p) =>
    `${p.corte}: el único factor de ${p.tramo} son ${p.observaciones} observación(es) del hogar. Sirve, pero baja la confianza.`,
  OBSERVED_YIELD_IGNORED: (p) =>
    `${p.cantidad} observación(es) del hogar quedaron fuera del cálculo (${p.motivo}): siguen siendo historia, no señal.`,
  INVENTORY_NETTED: (p) =>
    `${p.corte}: se descontaron ${fmt(Number(p.gramos))} g que ya tienes (convertidos a peso de compra con los mismos factores).`,
  INVENTORY_YIELD_UNKNOWN: (p) =>
    `${p.corte}: tienes ${fmt(Number(p.gramos))} g en inventario pero falta el factor para saber cuánto rinden. La compra se muestra entre "cubre todo lo que pesa" y "no cubre nada".`,
  INVENTORY_FROZEN: (p) => `${p.corte}: ${fmt(Number(p.gramos))} g están congelados y hay que descongelarlos.`,
  EQUIPMENT_CAPACITY_UNKNOWN: (p) =>
    `${p.corte}: sin capacidad declarada de la parrilla no se pueden contar las tandas.`,
  EQUIPMENT_UNIT_MISMATCH: (p) =>
    `${p.corte}: la capacidad del equipo está en ${p.unidad} y la carne se mide en gramos. No se convierte solo.`,
  BATCHES_RANGE: (p) => `${p.corte}: entre ${p.min} y ${p.max} tanda(s) según cuánto termines cocinando.`,
  BATCHES_FROM_ACCEPTED_PLAN: (p) => `${p.corte}: ${p.tandas} tanda(s) sobre el plan aceptado.`,
  LEFTOVERS_BEFORE_ROUNDING: () =>
    "El sobrante estimado es ANTES del redondeo comercial: si el proveedor vende por caja, la sobra real será mayor y la vista de compras la recalcula.",
  PURCHASE_UNKNOWN_TOTAL: (p) =>
    `${p.cantidad} corte(s) sin cadena de rendimiento completa: no hay total de compra, solo el subtotal de lo que sí se pudo estimar.`,
};

function reason(code: BbqReasonCode, params: BbqReasonParams = {}): BbqReason {
  return { code, params, text: TEXTOS[code](params) };
}

function review(
  code: BbqReasonCode,
  scope: BbqReview["scope"],
  ref: string | null,
  params: BbqReasonParams = {},
): BbqReview {
  return { code, scope, ref, text: TEXTOS[code](params) };
}

const NOMBRE_TRAMO: Record<YieldStage, string> = {
  RAW_PURCHASE_TO_EDIBLE_RAW: "hueso y limpieza (comprado→comestible)",
  EDIBLE_RAW_TO_COOKED: "cocción (comestible→cocido)",
  COOKED_TO_SERVABLE: "porcionado (cocido→servible)",
};

const NOMBRE_FUENTE: Record<YieldSource, string> = {
  CUT_DEFINITION: "la ficha del corte",
  INGREDIENT_YIELD: "la tabla de rendimientos del alimento",
  HOUSEHOLD_OBSERVED: "las observaciones del hogar",
};

/* ========================================================================== */
/* Cadena de rendimientos: un tramo, un dueño                                  */
/* ========================================================================== */

interface ChainInputs {
  cutRef: string | null;
  cookingMethod: string | null;
  displayName: string;
  itemId: string;
  cutDefinitions: readonly BbqCutDefinitionInput[];
  ingredientYields: readonly BbqIngredientYieldInput[];
  observedYields: readonly BbqObservedYieldInput[];
  policy: BbqQuantityPolicy;
}

export interface ChainResult {
  stages: BbqChainStageReport[];
  reasons: BbqReason[];
  reviews: BbqReview[];
  factors: Partial<Record<YieldStage, number>>;
  conflicts: Set<YieldStage>;
}

interface Candidato {
  stage: YieldStage;
  source: YieldSource;
  factor: number;
}

/**
 * Resuelve los tres tramos de un corte aplicando la regla de precedencia
 * declarada en `YIELD_STAGE_OWNER`.
 *
 * Se exporta a propósito: la regla tiene que poder testearse sola, sin armar un
 * evento completo. Una regla de precedencia que solo existe adentro de un
 * pipeline de diez pasos no es verificable, y era exactamente el problema (dos
 * dueños para el mismo factor físico, sin regla escrita).
 */
export function resolveYieldChain(inputs: ChainInputs): ChainResult {
  const { cutRef, cookingMethod, displayName, itemId, policy } = inputs;
  const reasons: BbqReason[] = [];
  const reviews: BbqReview[] = [];
  const factors: Partial<Record<YieldStage, number>> = {};
  const conflicts = new Set<YieldStage>();
  const stages: BbqChainStageReport[] = [];

  const candidatos: Candidato[] = [];
  if (cutRef !== null) {
    const def = inputs.cutDefinitions.find((d) => d.cutRef === cutRef);
    if (def) {
      if (esFactor(def.rawPurchaseToEdibleRaw)) {
        candidatos.push({
          stage: "RAW_PURCHASE_TO_EDIBLE_RAW",
          source: "CUT_DEFINITION",
          factor: def.rawPurchaseToEdibleRaw,
        });
      }
      if (esFactor(def.cookedToServable)) {
        candidatos.push({
          stage: "COOKED_TO_SERVABLE",
          source: "CUT_DEFINITION",
          factor: def.cookedToServable,
        });
      }
      if (esFactor(def.edibleRawToCooked)) {
        // Intruso: la columna existe en la 0041, pero el tramo no es suyo.
        candidatos.push({
          stage: "EDIBLE_RAW_TO_COOKED",
          source: "CUT_DEFINITION",
          factor: def.edibleRawToCooked,
        });
      }
    }
    const especifico =
      cookingMethod === null
        ? undefined
        : inputs.ingredientYields.find(
            (y) => y.cutRef === cutRef && y.cookingMethod === cookingMethod,
          );
    // Igual que en la 0009: la fila con método le gana a la genérica.
    const generico = inputs.ingredientYields.find(
      (y) => y.cutRef === cutRef && y.cookingMethod === null,
    );
    const elegido = especifico ?? generico;
    if (elegido && esFactor(elegido.factor)) {
      candidatos.push({
        stage: "EDIBLE_RAW_TO_COOKED",
        source: "INGREDIENT_YIELD",
        factor: elegido.factor,
      });
    }
  }

  // Observaciones del hogar: solo entran las que declaran etapa Y método, y con
  // suficientes repeticiones. Una parrillada suelta no reemplaza la referencia.
  const delCorte = cutRef === null ? [] : inputs.observedYields.filter((o) => o.cutRef === cutRef);
  const utiles: BbqObservedYieldInput[] = [];
  const descartadas: { obs: BbqObservedYieldInput; motivo: string }[] = [];
  for (const obs of delCorte) {
    if (obs.stage === null) {
      descartadas.push({ obs, motivo: "sin etapa declarada" });
    } else if (obs.cookingMethod === null) {
      descartadas.push({ obs, motivo: "sin método de cocción declarado" });
    } else if (obs.cookingMethod !== cookingMethod) {
      descartadas.push({ obs, motivo: "de otro método de cocción" });
    } else if (obs.observations < policy.observedYield.minObservations) {
      descartadas.push({ obs, motivo: "con menos observaciones que el mínimo de la política" });
    } else if (!esFactor(obs.factor)) {
      descartadas.push({ obs, motivo: "con un factor no utilizable" });
    } else {
      utiles.push(obs);
    }
  }
  if (descartadas.length > 0) {
    const motivos = [...new Set(descartadas.map((d) => d.motivo))].sort().join("; ");
    reasons.push(
      reason("OBSERVED_YIELD_IGNORED", { cantidad: descartadas.length, motivo: motivos }),
    );
  }

  for (const stage of YIELD_STAGES) {
    const dueno = YIELD_STAGE_OWNER[stage];
    const propios = candidatos.filter((c) => c.stage === stage && c.source === dueno);
    const ajenos = candidatos.filter((c) => c.stage === stage && c.source !== dueno);

    let factor: number | null = null;
    let source: YieldSource | null = null;
    let conflicto = false;

    const primero = propios[0];
    if (primero) {
      const discrepan = propios.some((c) => Math.abs(c.factor - primero.factor) > EPS);
      if (discrepan) {
        conflicto = true;
      } else {
        factor = primero.factor;
        source = dueno;
      }
    }

    const ajeno = ajenos[0];
    if (ajeno) {
      if (factor !== null && Math.abs(ajeno.factor - factor) > EPS) {
        conflicto = true;
        factor = null;
        source = null;
      } else if (factor === null) {
        // Hay un número, pero viene de una fuente que no manda en este tramo.
        // Usarlo sería volver a tener dos dueños; se declara y no se usa.
        reasons.push(
          reason("YIELD_STAGE_NOT_OWNED", {
            corte: displayName,
            tramo: NOMBRE_TRAMO[stage],
            dueno: NOMBRE_FUENTE[dueno],
          }),
        );
        reviews.push(
          review("YIELD_STAGE_NOT_OWNED", "CUT", itemId, {
            corte: displayName,
            tramo: NOMBRE_TRAMO[stage],
            dueno: NOMBRE_FUENTE[dueno],
          }),
        );
      } else {
        reasons.push(
          reason("YIELD_STAGE_NOT_OWNED", {
            corte: displayName,
            tramo: NOMBRE_TRAMO[stage],
            dueno: NOMBRE_FUENTE[dueno],
          }),
        );
      }
    }

    if (conflicto) {
      const detalle = [...propios, ...ajenos]
        .map((c) => `${NOMBRE_FUENTE[c.source]}: ${c.factor}`)
        .join(" vs ");
      conflicts.add(stage);
      reasons.push(
        reason("YIELD_STAGE_CONFLICT", { corte: displayName, tramo: NOMBRE_TRAMO[stage], detalle }),
      );
      reviews.push(
        review("YIELD_STAGE_CONFLICT", "CUT", itemId, {
          corte: displayName,
          tramo: NOMBRE_TRAMO[stage],
          detalle,
        }),
      );
      stages.push({ stage, factor: null, source: null, observations: 0, conflict: true });
      continue;
    }

    let observaciones = 0;
    const delTramo = utiles.filter((o) => o.stage === stage);
    if (delTramo.length > 0) {
      const totalObs = delTramo.reduce((acc, o) => acc + o.observations, 0);
      const media = delTramo.reduce((acc, o) => acc + o.factor * o.observations, 0) / totalObs;
      const peso =
        policy.observedYield.maxWeight *
        Math.min(1, totalObs / policy.observedYield.fullTrustObservations);
      observaciones = totalObs;
      if (factor !== null) {
        factor = factor * (1 - peso) + media * peso;
        reasons.push(
          reason("OBSERVED_YIELD_BLENDED", {
            corte: displayName,
            observaciones: totalObs,
            metodo: cookingMethod ?? "sin método",
            peso,
          }),
        );
      } else {
        factor = media;
        source = "HOUSEHOLD_OBSERVED";
        reasons.push(
          reason("OBSERVED_YIELD_SOLE_SOURCE", {
            corte: displayName,
            tramo: NOMBRE_TRAMO[stage],
            observaciones: totalObs,
          }),
        );
      }
    }

    if (factor !== null) factors[stage] = factor;
    stages.push({ stage, factor, source, observations: observaciones, conflict: false });
  }

  return { stages, reasons, reviews, factors, conflicts };
}

function esFactor(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/* ========================================================================== */
/* Demanda por persona                                                         */
/* ========================================================================== */

/** Un corte del menú con su peso de distribución y la porción que le tocó. */
interface Reparto {
  item: BbqMenuItemInput;
  weight: number;
  share: number;
}

interface DemandaPersona {
  participant: BbqParticipantInput;
  /** Con las bases de cada envolvente: la variación que SÍ conocemos. */
  known: Range;
  /** Con las envolventes completas: incluye lo que no sabemos. */
  full: Range;
}

function anthropometricFactor(p: BbqParticipantInput, policy: BbqQuantityPolicy): number {
  // §16/§78: el peso es una señal de escala acotada, nada más. No se calcula
  // IMC, no se cruza con la altura y no se diagnostica absolutamente nada.
  if (p.approxWeightKg === null || !Number.isFinite(p.approxWeightKg) || p.approxWeightKg <= 0) {
    return 1;
  }
  const ref = policy.anthropometrics.referenceAdultWeightKg;
  const desvio = (p.approxWeightKg - ref) / ref;
  const acotado = Math.max(-1, Math.min(1, desvio));
  return 1 + acotado * policy.anthropometrics.maxAdjust;
}

function demandaPersona(p: BbqParticipantInput, policy: BbqQuantityPolicy): DemandaPersona {
  const gramos = policy.gramsServablePerAdult;
  const edad = policy.ageFactor[p.ageGroup];
  const apetito = policy.appetiteFactor[p.appetite];
  const asistencia = policy.attendanceWeight[p.attendance];
  const antro = anthropometricFactor(p, policy);

  const baseComun = gramos.base * edad.base * apetito.base * asistencia.base * antro;
  const known: Range = {
    min: gramos.min * edad.base * apetito.base * asistencia.base * antro,
    base: baseComun,
    max: gramos.max * edad.base * apetito.base * asistencia.base * antro,
  };
  const full: Range = {
    min: gramos.min * edad.min * apetito.min * asistencia.min * antro,
    base: baseComun,
    max: gramos.max * edad.max * apetito.max * asistencia.max * antro,
  };
  return { participant: p, known, full };
}

/* ========================================================================== */
/* Motor                                                                       */
/* ========================================================================== */

export function estimateBbqQuantity(input: BbqQuantityInput): BbqQuantityResult {
  const policy = input.policy;
  const reasons: BbqReason[] = [];
  const reviews: BbqReview[] = [];

  /* ---------------------------------------------------------------------- */
  /* 1. Headcount                                                            */
  /* ---------------------------------------------------------------------- */

  const demandas = input.participants.map((p) => demandaPersona(p, policy));
  const activos = demandas.filter((d) => policy.attendanceWeight[d.participant.attendance].max > 0);

  const byAttendance: Record<BbqAttendanceStatus, number> = {
    INVITED: 0,
    CONFIRMED: 0,
    MAYBE: 0,
    DECLINED: 0,
    ATTENDED: 0,
    NO_SHOW: 0,
  };
  for (const p of input.participants) byAttendance[p.attendance] += 1;

  const NINOS: BbqAgeGroup[] = ["CHILD_SMALL", "CHILD", "TEEN"];
  const adultos = activos.filter(
    (d) => d.participant.ageGroup === "ADULT" || d.participant.ageGroup === "OLDER_ADULT",
  ).length;
  const ninos = activos.filter((d) => NINOS.includes(d.participant.ageGroup)).length;
  const edadDesconocida = activos.filter((d) => d.participant.ageGroup === "UNKNOWN").length;

  const efectivo: Range = activos.reduce<Range>(
    (acc, d) => addRange(acc, policy.attendanceWeight[d.participant.attendance]),
    { min: 0, base: 0, max: 0 },
  );

  const headcount: BbqHeadcount = {
    participants: input.participants.length,
    counted: activos.length,
    adults: adultos,
    children: ninos,
    unknownAge: edadDesconocida,
    householdMembers: activos.filter((d) => d.participant.kind === "HOUSEHOLD_MEMBER").length,
    guests: activos.filter((d) => d.participant.kind === "GUEST").length,
    byAttendance,
    effective: {
      min: Math.round(efectivo.min * 100) / 100,
      base: Math.round(efectivo.base * 100) / 100,
      max: Math.round(efectivo.max * 100) / 100,
    },
  };

  reasons.push(
    reason("BASE_POLICY", {
      base: policy.gramsServablePerAdult.base,
      min: policy.gramsServablePerAdult.min,
      max: policy.gramsServablePerAdult.max,
      policy: policy.version,
    }),
  );
  reasons.push(
    reason("HEADCOUNT_MIX", { adultos, ninos, desconocidos: edadDesconocida }),
  );

  /* ---------------------------------------------------------------------- */
  /* 2. Demanda servible del grupo: banda de variación + banda de ignorancia  */
  /* ---------------------------------------------------------------------- */

  let sumaBase = 0;
  let sumaKnownMin = 0;
  let sumaKnownMax = 0;
  let ignoranciaBaja = 0;
  let ignoranciaAlta = 0;
  for (const d of activos) {
    sumaBase += d.known.base;
    sumaKnownMin += d.known.min;
    sumaKnownMax += d.known.max;
    ignoranciaBaja += Math.max(0, d.known.min - d.full.min);
    ignoranciaAlta += Math.max(0, d.full.max - d.known.max);
  }

  const n = Math.max(1, activos.length);
  const kVar = bandScale(n, policy.band.variationExponent, policy.band.minVariationScale);
  const kIgn = bandScale(n, policy.band.ignoranceExponent, policy.band.minIgnoranceScale);

  const subtotal: Range = {
    min: Math.max(0, sumaBase - (sumaBase - sumaKnownMin) * kVar - ignoranciaBaja * kIgn),
    base: sumaBase,
    max: sumaBase + (sumaKnownMax - sumaBase) * kVar + ignoranciaAlta * kIgn,
  };

  // Los factores de CONTEXTO no se contraen con el headcount: no saber si el
  // asado es la comida principal es un error que apunta para el mismo lado en
  // las once personas a la vez. Solo la variación individual se compensa.
  const contexto = policy.mealContextFactor[input.mealContext ?? "UNKNOWN"];
  const sides = policy.sidesFactor[input.sidesLevel ?? "UNKNOWN"];
  const duracion =
    input.durationHours === null
      ? policy.durationUnknownFactor
      : input.durationHours > policy.longEventHours
        ? pt(policy.longEventFactor)
        : pt(1);

  const participantes = mulRange(mulRange(mulRange(subtotal, contexto), sides), duracion);

  if (input.mealContext === null) reasons.push(reason("MEAL_CONTEXT_UNKNOWN"));
  else {
    reasons.push(
      reason("MEAL_CONTEXT_APPLIED", { contexto: input.mealContext, factor: contexto.base }),
    );
  }
  if (input.sidesLevel === null) reasons.push(reason("SIDES_UNKNOWN"));
  else reasons.push(reason("SIDES_APPLIED", { nivel: input.sidesLevel, factor: sides.base }));
  if (input.durationHours === null) reasons.push(reason("DURATION_UNKNOWN"));
  else if (input.durationHours > policy.longEventHours) {
    reasons.push(
      reason("DURATION_LONG", { horas: input.durationHours, factor: policy.longEventFactor }),
    );
  }

  const apetitosDesconocidos = activos.filter((d) => d.participant.appetite === "UNKNOWN").length;
  const apetitosConocidos = activos.length - apetitosDesconocidos;
  if (apetitosConocidos > 0) {
    const detalle = resumenApetitos(activos.map((d) => d.participant));
    reasons.push(reason("APPETITE_KNOWN", { cantidad: apetitosConocidos, detalle }));
  }
  if (apetitosDesconocidos > 0) {
    reasons.push(reason("APPETITE_UNKNOWN", { cantidad: apetitosDesconocidos }));
  }
  if (edadDesconocida > 0) reasons.push(reason("AGE_UNKNOWN", { cantidad: edadDesconocida }));
  const sinConfirmar = activos.filter(
    (d) => d.participant.attendance === "INVITED" || d.participant.attendance === "MAYBE",
  ).length;
  if (sinConfirmar > 0) reasons.push(reason("ATTENDANCE_UNCERTAIN", { cantidad: sinConfirmar }));
  const conPeso = activos.filter((d) => d.participant.approxWeightKg !== null).length;
  if (conPeso > 0) {
    reasons.push(
      reason("ANTHROPOMETRIC_ADJUST", { cantidad: conPeso, tope: policy.anthropometrics.maxAdjust }),
    );
  }
  const anchoRelativo =
    participantes.base > 0 ? (participantes.max - participantes.min) / participantes.base : 0;
  reasons.push(
    reason("GROUP_BAND", { personas: activos.length, ancho: Math.round((anchoRelativo / 2) * 1000) / 1000 }),
  );

  /* ---------------------------------------------------------------------- */
  /* 3. Sobrante pedido y margen de seguridad: DOS líneas distintas (§25-26)  */
  /* ---------------------------------------------------------------------- */

  const miembrosHogar = headcount.householdMembers;
  let sobranteGramos = 0;
  let detalleSobrante = "";
  switch (input.desiredLeftover.kind) {
    case "NONE":
      break;
    case "SMALL_BUFFER":
      sobranteGramos =
        policy.gramsServablePerAdult.base * policy.desiredLeftover.smallBufferServings;
      detalleSobrante = `${policy.desiredLeftover.smallBufferServings} porción(es) adulta(s) de ${fmt(policy.gramsServablePerAdult.base)} g.`;
      break;
    case "ONE_EXTRA_MEAL":
      // §17 otra vez: "una comida extra" tiene que estar definida en gramos o
      // es un número mágico. Acá es una comida para los miembros del hogar que
      // participan del evento — son ellos los que se comen las sobras.
      if (miembrosHogar > 0) {
        sobranteGramos = policy.gramsServablePerAdult.base * miembrosHogar;
        detalleSobrante = `${miembrosHogar} persona(s) del hogar × ${fmt(policy.gramsServablePerAdult.base)} g.`;
      } else {
        reasons.push(reason("EXTRA_MEAL_PEOPLE_UNKNOWN"));
        reviews.push(review("EXTRA_MEAL_PEOPLE_UNKNOWN", "EVENT", null));
      }
      break;
    case "CUSTOM":
      sobranteGramos = Math.max(0, input.desiredLeftover.grams);
      detalleSobrante = "Cantidad declarada por ti.";
      break;
  }
  if (sobranteGramos > 0) {
    reasons.push(
      reason("DESIRED_LEFTOVER", {
        tipo: input.desiredLeftover.kind,
        gramos: sobranteGramos,
        detalle: detalleSobrante,
      }),
    );
  }

  const bufferPct = input.safetyBufferPct;
  const buffer: Range =
    bufferPct === null || bufferPct <= 0 ? pt(0) : scaleRange(participantes, bufferPct / 100);
  if (bufferPct === null) reasons.push(reason("SAFETY_BUFFER_NOT_SET"));
  else if (bufferPct > 0) {
    reasons.push(
      reason("SAFETY_BUFFER", { pct: bufferPct / 100, gramos: Math.round(buffer.base) }),
    );
  }

  const total = addRange(addRange(participantes, buffer), pt(sobranteGramos));

  const demand: BbqDemandLines = {
    participants: roundRange(participantes),
    desiredLeftoverGrams: g(sobranteGramos),
    safetyBuffer: roundRange(buffer),
    total: roundRange(total),
  };

  /* ---------------------------------------------------------------------- */
  /* 4. Distribución por corte, SEGMENTADA por compatibilidad                 */
  /* ---------------------------------------------------------------------- */

  const carnes = input.menu.filter((m) => m.kind === "MEAT");
  const reparto = repartoDeDistribucion(carnes, policy, reasons, reviews);

  const sinCategoria = carnes.filter((m) => m.category === null).length;
  if (sinCategoria > 0) reasons.push(reason("MENU_CATEGORY_UNKNOWN", { cantidad: sinCategoria }));

  let shareSinCubrir = 0;
  let conRestriccion = 0;
  let sinRestriccion = 0;
  let sinInformacion = 0;
  let conAlergia = 0;
  let conNotaLibre = 0;
  let sinCompatible = 0;
  let conFichaBloqueada = 0;
  let conAlergiaRegistrada = 0;

  const baseTotalPersonas = activos.reduce((acc, d) => acc + d.known.base, 0);
  for (const d of activos) {
    const share = baseTotalPersonas > 0 ? d.known.base / baseTotalPersonas : 0;
    const flags = d.participant.dietaryFlags;
    const ficha = d.participant.recordedBlocks;
    // "No sabemos" es SÓLO cuando nadie miró: ni banderas declaradas ni ficha
    // del hogar. Un integrante cuya ficha sí se consultó no es un desconocido,
    // y contarlo como tal le bajaba la confianza a la estimación por datos que
    // la aplicación tiene guardados hace meses.
    if (flags === null && ficha === null) sinInformacion += 1;
    if (flags !== null && flags.includes("ALLERGY_REPORTED")) conAlergia += 1;
    if (flags !== null && flags.includes("OTHER_DIETARY_NOTE")) conNotaLibre += 1;
    if (ficha !== null && ficha.blockedItemIds.length > 0) conFichaBloqueada += 1;
    if (ficha !== null && ficha.allergyItemIds.length > 0) conAlergiaRegistrada += 1;

    const permitidos = itemsCompatibles(d.participant, reparto, policy);
    const restringido = permitidos.length !== reparto.length;
    if (restringido) conRestriccion += 1;
    else sinRestriccion += 1;

    if (permitidos.length === 0) {
      // No se le reparte carne que no puede comer: se declara sin cubrir.
      shareSinCubrir += share;
      sinCompatible += 1;
      continue;
    }
    const sumaPesos = permitidos.reduce((acc, r) => acc + r.weight, 0);
    for (const r of permitidos) {
      const peso = sumaPesos > 0 ? r.weight / sumaPesos : 1 / permitidos.length;
      r.share += share * peso;
    }
  }

  if (carnes.length === 0) reasons.push(reason("NO_MEAT_ITEMS"));
  if (conRestriccion > 0) {
    const gramosAlternativa = reparto
      .filter((r) => r.item.category === "VEGETARIANO")
      .reduce((acc, r) => acc + total.base * r.share, 0);
    reasons.push(
      reason("DISTRIBUTION_SEGMENTED", {
        sinRestriccion,
        conRestriccion,
        gramosAlternativa: Math.round(gramosAlternativa),
      }),
    );
  }
  // Lo que la casa ya sabía se DICE, pero en conteo y sin nombres: el asado se
  // mira entre invitados, y de quién es la restricción no es conversación de
  // pantalla compartida.
  if (conFichaBloqueada > 0) {
    reasons.push(reason("RECORDED_RESTRICTIONS_APPLIED", { cantidad: conFichaBloqueada }));
  }
  if (conAlergiaRegistrada > 0) {
    reasons.push(reason("ALLERGY_ITEM_EXCLUDED", { cantidad: conAlergiaRegistrada }));
  }
  // Sin información NO es "sin restricciones": se dice siempre y pesa en la
  // confianza. Un invitado con dietary_flags NULL pasaba en silencio.
  if (sinInformacion > 0) {
    reasons.push(reason("DIETARY_INFO_MISSING", { cantidad: sinInformacion }));
  }
  if (conAlergia > 0) {
    reasons.push(reason("ALLERGY_REVIEW_REQUIRED", { cantidad: conAlergia }));
    reviews.push(review("ALLERGY_REVIEW_REQUIRED", "PARTICIPANTS", null, { cantidad: conAlergia }));
  }
  if (conNotaLibre > 0) {
    reasons.push(reason("OTHER_DIETARY_NOTE_REVIEW", { cantidad: conNotaLibre }));
    reviews.push(review("OTHER_DIETARY_NOTE_REVIEW", "PARTICIPANTS", null, { cantidad: conNotaLibre }));
  }
  const sinCubrir = shareSinCubrir > 0 ? scaleRange(total, shareSinCubrir) : null;
  if (sinCubrir) {
    reasons.push(
      reason("NO_COMPATIBLE_ITEM", { cantidad: sinCompatible, gramos: Math.round(sinCubrir.base) }),
    );
    reviews.push(
      review("NO_COMPATIBLE_ITEM", "PARTICIPANTS", null, {
        cantidad: sinCompatible,
        gramos: Math.round(sinCubrir.base),
      }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 5-8. Cadena por corte, neteo de inventario, compra y tandas              */
  /* ---------------------------------------------------------------------- */

  const byCut: BbqCutPlan[] = [];
  let cortesConCadena = 0;
  let subtotalCompra: Range = { min: 0, base: 0, max: 0 };
  let cortesSinCadena = 0;

  for (const linea of reparto) {
    const item = linea.item;
    const servable = scaleRange(total, linea.share);
    const flags: BbqReasonCode[] = [];

    const cadena = resolveYieldChain({
      cutRef: item.cutRef,
      cookingMethod: item.cookingMethod,
      displayName: item.displayName,
      itemId: item.id,
      cutDefinitions: input.cutDefinitions,
      ingredientYields: input.ingredientYields,
      observedYields: input.observedYields,
      policy,
    });
    reasons.push(...cadena.reasons);
    reviews.push(...cadena.reviews);
    for (const r of cadena.reasons) if (!flags.includes(r.code)) flags.push(r.code);

    const fServable = cadena.factors.COOKED_TO_SERVABLE;
    const fCoccion = cadena.factors.EDIBLE_RAW_TO_COOKED;
    const fHueso = cadena.factors.RAW_PURCHASE_TO_EDIBLE_RAW;

    const faltante = (tramo: YieldStage): RangeOrUnknown => {
      const code: BbqReasonCode = cadena.conflicts.has(tramo)
        ? "YIELD_STAGE_CONFLICT"
        : "YIELD_UNKNOWN";
      if (code === "YIELD_UNKNOWN") {
        const params = { corte: item.displayName, tramo: NOMBRE_TRAMO[tramo] };
        reasons.push(reason("YIELD_UNKNOWN", params));
        reviews.push(review("YIELD_UNKNOWN", "CUT", item.id, params));
        if (!flags.includes("YIELD_UNKNOWN")) flags.push("YIELD_UNKNOWN");
      }
      return { known: false, reason: code };
    };

    // Cadena hacia atrás: servible → cocido → crudo comestible → crudo comprado.
    // Cada división necesita SU factor. Sin él, la línea se declara desconocida.
    // Ojo: tampoco se asume 1,0 para un corte sin hueso — la merma de limpieza
    // existe igual y suponerla cero es inventar.
    const cooked: RangeOrUnknown =
      fServable === undefined
        ? faltante("COOKED_TO_SERVABLE")
        : { known: true, value: divideRange(servable, fServable) };
    const rawEdible: RangeOrUnknown = !cooked.known
      ? cooked
      : fCoccion === undefined
        ? faltante("EDIBLE_RAW_TO_COOKED")
        : { known: true, value: divideRange(cooked.value, fCoccion) };
    const rawPurchase: RangeOrUnknown = !rawEdible.known
      ? rawEdible
      : fHueso === undefined
        ? faltante("RAW_PURCHASE_TO_EDIBLE_RAW")
        : { known: true, value: divideRange(rawEdible.value, fHueso) };

    if (rawPurchase.known) {
      cortesConCadena += 1;
      reasons.push(
        reason("YIELD_CHAIN_COMPLETE", {
          corte: item.displayName,
          detalle: cadena.stages
            .map((s) => `${s.stage}=${s.factor === null ? "?" : Math.round(s.factor * 1000) / 1000}`)
            .join(" · "),
        }),
      );
    }

    /* Neteo del inventario: EN LA MISMA BASE que la demanda (§29). Un lote de
     * costillar congelado pesa CON hueso; una sobra cocida pesa ya cocida.
     * Restarlos de frentón contra el crudo de compra sobreestima la cobertura y
     * el sábado falta carne. */
    const lotes = input.inventory.filter((l) => item.cutRef !== null && l.cutRef === item.cutRef);
    const inventoryToUse = netearInventario(lotes, cadena.factors);
    if (inventoryToUse.known && inventoryToUse.grams > 0) {
      reasons.push(
        reason("INVENTORY_NETTED", { corte: item.displayName, gramos: Math.round(inventoryToUse.grams) }),
      );
      if (inventoryToUse.frozenGrams > 0) {
        reasons.push(
          reason("INVENTORY_FROZEN", {
            corte: item.displayName,
            gramos: Math.round(inventoryToUse.frozenGrams),
          }),
        );
      }
    }
    if (!inventoryToUse.known) {
      const params = { corte: item.displayName, gramos: Math.round(inventoryToUse.faceValueGrams) };
      reasons.push(reason("INVENTORY_YIELD_UNKNOWN", params));
      reviews.push(review("INVENTORY_YIELD_UNKNOWN", "CUT", item.id, params));
      if (!flags.includes("INVENTORY_YIELD_UNKNOWN")) flags.push("INVENTORY_YIELD_UNKNOWN");
    }

    let purchaseRequired: RangeOrUnknown;
    if (!rawPurchase.known) {
      purchaseRequired = rawPurchase;
      cortesSinCadena += 1;
    } else if (inventoryToUse.known) {
      purchaseRequired = { known: true, value: subtractFlat(rawPurchase.value, inventoryToUse.grams) };
      subtotalCompra = addRange(subtotalCompra, purchaseRequired.value);
    } else {
      // No se sabe cuánto rinde lo que hay. Se declara el intervalo entre "cubre
      // todo lo que pesa" y "no cubre nada", y la referencia se queda en el
      // extremo caro: faltar carne el sábado cuesta mucho más que sobrar.
      purchaseRequired = {
        known: true,
        value: {
          min: Math.max(0, rawPurchase.value.min - inventoryToUse.faceValueGrams),
          base: rawPurchase.value.base,
          max: rawPurchase.value.max,
        },
      };
      subtotalCompra = addRange(subtotalCompra, purchaseRequired.value);
    }

    const batches = calcularTandas(item, rawEdible, input, reasons, reviews);

    byCut.push({
      itemId: item.id,
      cutRef: item.cutRef,
      displayName: item.displayName,
      category: item.category,
      servable: roundRange(servable),
      cooked: redondearEstimacion(cooked),
      rawEdible: redondearEstimacion(rawEdible),
      rawPurchase: redondearEstimacion(rawPurchase),
      inventoryToUse: redondearInventario(inventoryToUse),
      purchaseRequired: redondearEstimacion(purchaseRequired),
      batches,
      chain: cadena.stages,
      flags,
    });
  }

  const totalPurchaseRequired: RangeOrUnknown =
    cortesSinCadena > 0
      ? { known: false, reason: "PURCHASE_UNKNOWN_TOTAL" }
      : { known: true, value: roundRange(subtotalCompra) };
  if (cortesSinCadena > 0) {
    reasons.push(reason("PURCHASE_UNKNOWN_TOTAL", { cantidad: cortesSinCadena }));
    reviews.push(review("PURCHASE_UNKNOWN_TOTAL", "EVENT", null, { cantidad: cortesSinCadena }));
  }

  /* ---------------------------------------------------------------------- */
  /* 9. Sobrante esperado — ANTES del redondeo comercial                      */
  /* ---------------------------------------------------------------------- */

  const expectedLeftovers = {
    range: roundRange({
      min: Math.max(0, total.base - participantes.max),
      base: Math.max(0, total.base - participantes.base),
      max: Math.max(0, total.base - participantes.min),
    }),
    basis: "BEFORE_COMMERCIAL_ROUNDING" as const,
  };
  reasons.push(reason("LEFTOVERS_BEFORE_ROUNDING"));

  /* ---------------------------------------------------------------------- */
  /* 10. Cobertura de datos → ancho del rango → confianza                     */
  /* ---------------------------------------------------------------------- */

  const denominador = Math.max(1, activos.length);
  const coverage: BbqDataCoverage = {
    appetiteKnown: redondear2(apetitosConocidos / denominador),
    ageKnown: redondear2((activos.length - edadDesconocida) / denominador),
    dietaryInfoKnown: redondear2((activos.length - sinInformacion) / denominador),
    attendanceConfirmed: redondear2(
      activos.filter(
        (d) => d.participant.attendance === "CONFIRMED" || d.participant.attendance === "ATTENDED",
      ).length / denominador,
    ),
    cutsWithFullChain: carnes.length === 0 ? 0 : redondear2(cortesConCadena / carnes.length),
  };

  const anchoTotal = total.base > 0 ? (total.max - total.min) / total.base : 0;
  const confidence = calcularConfianza(anchoTotal, coverage, reviews.length > 0, policy);

  return {
    engineVersion: BBQ_QUANTITY_VERSION,
    policyVersion: policy.version,
    policySource: policy.source,
    inputSignature: signature({ engine: BBQ_QUANTITY_VERSION, input }),
    headcount,
    demand,
    totalServableDemand: roundRange(total),
    byCut,
    uncoveredServableDemand: sinCubrir === null ? null : roundRange(sinCubrir),
    expectedLeftovers,
    knownPurchaseSubtotal: roundRange(subtotalCompra),
    totalPurchaseRequired,
    coverage,
    confidence,
    reasons,
    reviewRequired: reviews,
  };
}

/* ========================================================================== */
/* Auxiliares del motor                                                        */
/* ========================================================================== */

function redondear2(value: number): number {
  return Math.round(value * 100) / 100;
}

function redondearEstimacion(e: RangeOrUnknown): RangeOrUnknown {
  return e.known ? { known: true, value: roundRange(e.value) } : e;
}

function redondearInventario(uso: BbqInventoryUse): BbqInventoryUse {
  return uso.known
    ? { known: true, grams: g(uso.grams), frozenGrams: g(uso.frozenGrams), lotIds: uso.lotIds }
    : { known: false, reason: uso.reason, faceValueGrams: g(uso.faceValueGrams), lotIds: uso.lotIds };
}

function resumenApetitos(participantes: readonly BbqParticipantInput[]): string {
  const conteo: Record<BbqAppetite, number> = {
    LOW: 0,
    NORMAL: 0,
    HIGH: 0,
    VERY_HIGH: 0,
    UNKNOWN: 0,
  };
  for (const p of participantes) conteo[p.appetite] += 1;
  const orden: BbqAppetite[] = ["LOW", "NORMAL", "HIGH", "VERY_HIGH"];
  return orden
    .filter((a) => conteo[a] > 0)
    .map((a) => `${a}×${conteo[a]}`)
    .join(", ");
}

/**
 * §21: porcentajes por corte o modo AUTO. Si los porcentajes están a medias o
 * no suman 100, no se "arregla" el número en silencio: se reparte parejo y
 * queda anotado para revisar.
 *
 * Devuelve un arreglo (no un mapa por id) a propósito: cada corte lleva SU peso
 * y SU porción acumulada encima, así el reparto no necesita buscar por clave y
 * no existe el `?? 0` que taparía un corte perdido en el camino.
 */
function repartoDeDistribucion(
  carnes: readonly BbqMenuItemInput[],
  policy: BbqQuantityPolicy,
  reasons: BbqReason[],
  reviews: BbqReview[],
): Reparto[] {
  if (carnes.length === 0) return [];

  const conPct = carnes
    .map((item) => ({ item, pct: item.distributionPct }))
    .filter((x): x is { item: BbqMenuItemInput; pct: number } => x.pct !== null);

  if (conPct.length === 0) {
    reasons.push(reason("DISTRIBUTION_AUTO", { cantidad: carnes.length }));
    return carnes.map((item) => ({ item, weight: 1 / carnes.length, share: 0 }));
  }

  const suma = conPct.reduce((acc, x) => acc + x.pct, 0);
  const completo = conPct.length === carnes.length;
  if (!completo || Math.abs(suma - 100) > policy.distribution.pctTolerance) {
    reasons.push(reason("DISTRIBUTION_PCT_INVALID", { suma }));
    reviews.push(review("DISTRIBUTION_PCT_INVALID", "EVENT", null, { suma }));
    return carnes.map((item) => ({ item, weight: 1 / carnes.length, share: 0 }));
  }

  reasons.push(
    reason("DISTRIBUTION_PCT", {
      detalle: conPct.map((x) => `${x.item.displayName} ${fmt(x.pct)}%`).join(", "),
    }),
  );
  return conPct.map((x) => ({ item: x.item, weight: x.pct / 100, share: 0 }));
}

/**
 * Qué items del menú puede comer esta persona.
 *
 * Dos fuentes, en este orden:
 *
 *  1. `recordedBlocks` — lo que la casa YA SABE, por ITEM. No depende de que el
 *     menú tenga bien puesta la categoría, y es lo único que cierra el caso del
 *     integrante con una alergia registrada: sus banderas culinarias son `null`
 *     (esas existen sólo para los invitados) y sin esto el motor le repartía el
 *     menú entero, incluido el corte que no puede comer.
 *  2. Las banderas declaradas, por CATEGORÍA. Un item sin categoría NO se
 *     considera compatible para quien tiene restricciones declaradas: no se
 *     puede PROBAR que lo sea, y "no sé" jamás puede transformarse en "sí
 *     puede".
 *
 * Para quien no declaró restricciones y no tiene nada bloqueado en la ficha, el
 * menú entero está disponible.
 */
function itemsCompatibles(
  participant: BbqParticipantInput,
  reparto: readonly Reparto[],
  policy: BbqQuantityPolicy,
): Reparto[] {
  const flags = participant.dietaryFlags;
  const ficha = participant.recordedBlocks;
  const bloqueados = ficha === null ? [] : ficha.blockedItemIds;

  let permitidos = [...reparto];
  let hayRestriccionDeMenu = false;

  if (bloqueados.length > 0) {
    hayRestriccionDeMenu = true;
    permitidos = permitidos.filter((r) => !bloqueados.includes(r.item.id));
  }

  if (flags !== null) {
    for (const flag of flags) {
      const regla = policy.dietaryRules[flag];
      if (regla.allowOnly !== null) {
        hayRestriccionDeMenu = true;
        const permitidas = regla.allowOnly;
        permitidos = permitidos.filter(
          (r) => r.item.category !== null && permitidas.includes(r.item.category),
        );
      }
      if (regla.exclude !== null) {
        hayRestriccionDeMenu = true;
        const excluidas = regla.exclude;
        permitidos = permitidos.filter(
          (r) => r.item.category !== null && !excluidas.includes(r.item.category),
        );
      }
    }
  }

  if (!hayRestriccionDeMenu) return [...reparto];
  return permitidos;
}

/**
 * Convierte cada lote a PESO DE COMPRA con los mismos factores del corte y
 * suma. Si a algún lote le falta un factor, la línea completa queda UNKNOWN:
 * el §13 vale para los dos lados de la resta, no solo para la demanda.
 */
function netearInventario(
  lotes: readonly BbqInventoryLotInput[],
  factors: Partial<Record<YieldStage, number>>,
): BbqInventoryUse {
  const lotIds = lotes.map((l) => l.lotId);
  const faceValue = lotes.reduce((acc, l) => acc + Math.max(0, l.availableG), 0);
  if (lotes.length === 0) {
    // Array vacío = la consulta dijo que no hay. Quien no pudo consultar tiene
    // prohibido pasar [] (§97: ERROR no es VACÍO).
    return { known: true, grams: 0, frozenGrams: 0, lotIds: [] };
  }

  let total = 0;
  let congelado = 0;
  for (const lote of lotes) {
    const convertido = aPesoDeCompra(Math.max(0, lote.availableG), lote.stage, factors);
    if (convertido === null) {
      return {
        known: false,
        reason: "INVENTORY_YIELD_UNKNOWN",
        faceValueGrams: faceValue,
        lotIds,
      };
    }
    total += convertido;
    if (lote.frozen) congelado += convertido;
  }
  return { known: true, grams: total, frozenGrams: congelado, lotIds };
}

function aPesoDeCompra(
  cantidad: number,
  stage: WeightStage | null,
  factors: Partial<Record<YieldStage, number>>,
): number | null {
  // Base física no mapeable a las etapas del §12: no se sabe qué mide ese peso,
  // así que no puede restarse de la demanda. Esto es lo que evita que un lote
  // "AS_PACKAGED" se netee 1:1 contra crudo comestible.
  if (stage === null) return null;
  const fHueso = factors.RAW_PURCHASE_TO_EDIBLE_RAW;
  const fCoccion = factors.EDIBLE_RAW_TO_COOKED;
  const fServible = factors.COOKED_TO_SERVABLE;
  switch (stage) {
    case "RAW_PURCHASE":
      return cantidad;
    case "EDIBLE_RAW":
      return fHueso === undefined ? null : cantidad / fHueso;
    case "COOKED":
      return fHueso === undefined || fCoccion === undefined
        ? null
        : cantidad / fCoccion / fHueso;
    case "SERVABLE":
      return fHueso === undefined || fCoccion === undefined || fServible === undefined
        ? null
        : cantidad / fServible / fCoccion / fHueso;
  }
}

/**
 * §39. Las tandas se cuentan sobre el CRUDO COMESTIBLE, que es lo que ocupa la
 * parrilla: contarlas sobre el peso cocido subcuenta tandas (la carne pesa
 * menos después, pero se cocina antes). Con plan aceptado el número es exacto;
 * sin plan aceptado es un rango, porque ceil(min) y ceil(max) no son lo mismo.
 */
function calcularTandas(
  item: BbqMenuItemInput,
  rawEdible: RangeOrUnknown,
  input: BbqQuantityInput,
  reasons: BbqReason[],
  reviews: BbqReview[],
): BbqBatches {
  const equipos = input.equipment;
  const equipo: BbqEquipmentInput | undefined =
    item.equipmentId !== null
      ? equipos.find((e) => e.id === item.equipmentId)
      : // Un solo equipo declarado no es ambigüedad: es el único que hay.
        equipos.length === 1
        ? equipos[0]
        : undefined;

  if (!equipo || equipo.maxBatch === null || equipo.maxBatch <= 0) {
    reasons.push(reason("EQUIPMENT_CAPACITY_UNKNOWN", { corte: item.displayName }));
    return { known: false, reason: "EQUIPMENT_CAPACITY_UNKNOWN" };
  }
  if (equipo.maxBatchUnit !== "G") {
    // Una parrilla configurada en UNIT no puede dividir gramos, y convertir sin
    // regla sería inventar. Se declara y se pide revisión.
    const params = { corte: item.displayName, unidad: equipo.maxBatchUnit ?? "sin unidad" };
    reasons.push(reason("EQUIPMENT_UNIT_MISMATCH", params));
    reviews.push(review("EQUIPMENT_UNIT_MISMATCH", "CUT", item.id, params));
    return { known: false, reason: "EQUIPMENT_UNIT_MISMATCH" };
  }
  if (!rawEdible.known) return { known: false, reason: rawEdible.reason };

  const aceptado = input.acceptedPlanRawEdibleG?.[item.id];
  if (aceptado !== undefined && aceptado > 0) {
    const tandas = Math.ceil(aceptado / equipo.maxBatch);
    reasons.push(reason("BATCHES_FROM_ACCEPTED_PLAN", { corte: item.displayName, tandas }));
    return { known: true, kind: "EXACT", batches: tandas };
  }
  const min = Math.ceil(rawEdible.value.min / equipo.maxBatch);
  const max = Math.ceil(rawEdible.value.max / equipo.maxBatch);
  reasons.push(reason("BATCHES_RANGE", { corte: item.displayName, min, max }));
  return { known: true, kind: "RANGE", min, max };
}

/**
 * La confianza sale del ANCHO RELATIVO del rango y de la cobertura de datos —
 * no de una etiqueta puesta a mano. Antes el semáforo se movía mientras el
 * número quedaba igual, que es falsa precisión con otro nombre.
 */
function calcularConfianza(
  anchoRelativo: number,
  coverage: BbqDataCoverage,
  hayRevisiones: boolean,
  policy: BbqQuantityPolicy,
): BbqConfidence {
  if (hayRevisiones) return "LOW";
  if (
    anchoRelativo <= policy.confidence.highMaxRelativeWidth &&
    coverage.dietaryInfoKnown >= policy.confidence.minDietaryCoverageHigh &&
    coverage.cutsWithFullChain === 1
  ) {
    return "HIGH";
  }
  if (
    anchoRelativo <= policy.confidence.mediumMaxRelativeWidth &&
    coverage.dietaryInfoKnown >= policy.confidence.minDietaryCoverageMedium
  ) {
    return "MEDIUM";
  }
  return "LOW";
}
