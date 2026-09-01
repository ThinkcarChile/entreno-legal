import type { NutrientKey } from "@/domain/catalog/types";
import { addDays } from "@/domain/nutrition/calendar";
import {
  GOAL_LABELS,
  GOAL_TYPES,
  type GoalRange,
  type GoalType,
} from "@/domain/nutrition/types";

import {
  goalTypeToNutrientKey,
  nutrientKeyToGoalType,
  ROLLING_WINDOW_DAYS,
  type NutrientBalance,
  type RollingBalance,
  type RollingWindow,
} from "./rolling";
import {
  ADAPTIVE_ENGINE_VERSION,
  DEFAULT_ADAPTIVE_PARAMS,
  frozenAdaptiveConfig,
  REASON_CODES_SIN_NUTRIENTE,
  type AdaptiveAdjustment,
  type AdaptiveInput,
  type AdaptiveMissingData,
  type AdaptiveParams,
  type AdaptiveReason,
  type AdaptiveReasonCode,
  type AdaptiveReview,
  type AdaptiveVerdict,
  type ClinicalCeiling,
  type ClinicalFloor,
  type ClinicalOverride,
  type UnverifiedCeiling,
} from "./types";

/**
 * adaptive-nutrition/1.0.0 — puro, determinista, sin reloj, sin red, sin IA,
 * sin base de datos. `JSON.stringify(review(i)) === JSON.stringify(review(i))`
 * byte a byte, y por eso las claves se escriben siempre en el mismo orden y los
 * arreglos salen ordenados por un criterio fijo.
 *
 * QUÉ PROPONE, EN UNA LÍNEA: mover el rango de un objetivo unos pocos días
 * hacia lo que de verdad viene pasando. Si comiste sostenidamente BAJO tu
 * objetivo, propone subirlo (para que el plan te sirva más comida); si comiste
 * sostenidamente SOBRE él, propone apretarlo. Las dos direcciones tienen tope
 * duro, y la de subir es la que un techo clínico tiene que poder frenar.
 *
 * ORDEN DE DECISIÓN (la primera regla que aplica gana; ninguna posterior la
 * revierte):
 *
 *  1. El contexto clínico no se pudo leer (`clinicalContextResolved === false`,
 *     o alguno de los contadores en `null`) → REVIEW_REQUIRED,
 *     CLINICAL_CONTEXT_UNRESOLVED, `adjustments: []`. Un arreglo vacío jamás
 *     puede significar "no hay restricciones": puede significar "no tengo
 *     permiso para verlas", y el motor no puede distinguirlo solo.
 *  2. `pendingClinicalReviews > 0` → REVIEW_REQUIRED, CLINICAL_REVIEW_PENDING.
 *  3. `clinicalStatus` en ('CLINICALLY_INVALIDATED','REVIEW_REQUIRED') →
 *     REVIEW_REQUIRED, CLINICAL_STATUS_BLOCKS_PROPOSAL.
 *  4. Hay restricciones vigentes y el día NO fue evaluado (`clinicalStatus`
 *     null o NOT_ASSESSED) → REVIEW_REQUIRED, CLINICAL_STATUS_UNKNOWN. "No
 *     evaluada" no es "compatible".
 *  5. `trackingMode === 'OFF'` → INSUFFICIENT_DATA, TRACKING_MODE_OFF.
 *  6. Cobertura insuficiente → INSUFFICIENT_DATA, DATA_COVERAGE_INSUFFICIENT.
 *     Un día incompleto NO produce una recomendación débil: produce "no sé",
 *     con `missingData` diciendo qué faltó.
 *  7. `eventEffect.kind === 'UNTRACKED'` → NO_CHANGE, DAY_UNTRACKED_BY_EVENT.
 *     Un día que la persona decidió no medir no genera compensación al otro día.
 *  8. Subconsumo sostenido bajo el piso de implausibilidad → REVIEW_REQUIRED,
 *     SUSTAINED_UNDEREATING, `adjustments: []`. Comer muy poco varios días
 *     seguidos no es un objetivo mal calibrado; es algo que mira una persona.
 *  9. Nutriente por nutriente: sin objetivo declarado (NO_TARGET_DECLARED),
 *     desvío dentro de la banda de ruido (WITHIN_NOISE_BAND), desvío de un solo
 *     día sin respaldo en D3/D7 (SINGLE_DAY_DEVIATION), historia corta
 *     (HISTORY_TOO_SHORT) o suma en cota inferior con conclusión de déficit
 *     (LOWER_BOUND_CANNOT_SUSTAIN_DEFICIT) ⇒ ese nutriente no propone nada.
 * 10. Con ajustes: RECOMMENDED_ADJUSTMENT si la cobertura de la ventana que lo
 *     sostiene llega a `minCoverageForRecommendation`; si no, OPTIONAL.
 *     Sin ajustes: INSUFFICIENT_DATA si algo no se pudo mirar, NO_CHANGE si se
 *     miró todo y no había nada que mover.
 *
 * ENERGÍA Y trackingMode: con 'BASIC' ("objetivos sin exigir registro
 * detallado") no se propone NINGÚN ajuste de ENERGY_KCAL y se emite
 * TRACKING_MODE_BASIC.
 *
 * CÓMO SE RESPETA EL LÍMITE CLÍNICO (composición, no negociación):
 *   a) Propuesta cruda: `factor = 1 − deltaRatio`, aplicado a los tres bordes.
 *   b) Topes de parámetros, borde por borde y en las DOS direcciones:
 *        to.b = min(max(crudo.b, from.b · maxDecreaseRatio), from.b · maxIncreaseRatio)
 *      y después `to.minimum = max(to.minimum, from.minimum)`: el mínimo
 *      declarado nunca baja. Acá se redondea, y solo acá.
 *   c) Composición clínica: `applyClinicalCeilings` usa SOLO `Math.min` y
 *      `applyClinicalFloors` SOLO `Math.max`. No hay un solo camino por el que
 *      una propuesta adaptativa pueda ENSANCHAR un límite clínico.
 *   d) Si el techo clínico ya está bajo el mínimo declarado, o el piso clínico
 *      sobre el máximo propuesto, el ajuste se DESCARTA entero
 *      (CLINICAL_CEILING_BLOCKS_PROPOSAL / CLINICAL_FLOOR_BLOCKS_PROPOSAL). Se
 *      cae lo adaptativo, jamás lo clínico: eso no es un conflicto que el motor
 *      resuelva, es una contradicción que sube a decisión humana.
 *   e) Una cota CONFIRMADA sin cifra, o en una unidad que no es la del
 *      catálogo, no se descarta: BLOQUEA (CLINICAL_LIMIT_UNUSABLE). "Hay un
 *      límite y no sabemos cuál" nunca es "no hay límite".
 *   f) Cualquier bloqueo clínico deja el veredicto en REVIEW_REQUIRED y vacía
 *      TODOS los ajustes, igual que hace `create_adaptive_review` (0040) al
 *      encontrar cualquier descarte. Aplicar la mitad de una propuesta cuya
 *      otra mitad chocó con una indicación de salud es peor que no aplicar
 *      nada.
 *
 * ANTI-COMPENSACIÓN EXTREMA, como topes estructurales y no como intenciones:
 *   · `maxDecreaseRatio` 0.9 acota cualquier apriete a −10%, borde por borde,
 *     incluso cuando el objetivo no declara mínimo ni máximo.
 *   · `minimumFloorPolicy` hace imposible proponer bajo el mínimo declarado.
 *   · Un desvío de DÉFICIT nunca baja ningún borde: proponer apretar después de
 *     que la persona comió de menos es exactamente la compensación que este
 *     sprint prohíbe. Hay una verificación que revienta si eso ocurriera.
 *   · `fastingPolicy`: el tipo `AdaptiveAdjustment` no puede expresar
 *     "desactivar una comida" —solo lleva un `GoalRange` sobre un `GoalType`—,
 *     así que NO_FASTING_ALLOWED no tiene ninguna regla que lo emita: existe
 *     para que el contrato diga qué no se puede pedir.
 *   · `compensationPolicy`: el motor no recibe ni emite actividad, gasto
 *     energético ni ejercicio. "Quemar lo comido" no es expresable acá.
 *   · `maxValidityDays` 3: un ajuste que dura más es un cambio de objetivo, y
 *     ese camino pasa por `nutrition_goals` con decisión humana.
 *
 * EL MOTOR NO ESCRIBE NADA. Devuelve `AdaptiveReview`; la server action la
 * persiste con `create_adaptive_review` en estado PENDING, y solo
 * `resolve_adaptive_review` —con un humano detrás— la convierte en
 * `member_temporary_targets`.
 */

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida forma Y calendario. `addDays` normaliza en silencio ("2026-02-30" sale
 * como "2026-03-02"), así que el ida y vuelta es la prueba de que la fecha
 * existe. La aritmética se delega a `nutrition/calendar`: sumar días tiene un
 * solo dueño en este proyecto.
 */
function assertDateOnly(value: string, campo: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(`${campo} debe ser una fecha 'YYYY-MM-DD', llegó "${value}"`);
  }
  if (addDays(value, 0) !== value) {
    throw new RangeError(`${campo} no es una fecha del calendario: "${value}"`);
  }
  return value;
}

/**
 * La unidad canónica de un nutriente. Tiene DOS gemelas que se tienen que
 * mover juntas: `unidadDeNutriente` en `domain/clinical/engine.ts` y
 * `app.adaptive_nutrient_unit` en la migración 0040. Si se separan, un techo
 * clínico expresado en gramos pasa a compararse contra miligramos y nadie se
 * entera. Hay un test que compara las tres.
 */
export function unidadDeNutriente(key: NutrientKey): string {
  if (key === "energy_kcal") return "kcal";
  if (key.endsWith("_mg")) return "mg";
  return "g";
}

/**
 * Dos decimales, y el −0 normalizado a 0. El redondeo ocurre ANTES de componer
 * con las cotas clínicas a propósito: redondear después podría subir un borde
 * un centésimo por encima de un techo, que es justo lo que este motor promete
 * que no puede pasar.
 */
function redondear(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

const ORDEN_VENTANA: readonly RollingWindow[] = ["D7", "D3", "W24H"];

function capitalizar(texto: string): string {
  return texto.length === 0 ? texto : `${texto.slice(0, 1).toUpperCase()}${texto.slice(1)}`;
}

// ---------------------------------------------------------------------------
// Composición clínica
// ---------------------------------------------------------------------------

export interface ClinicalComposition {
  /** `null` = el ajuste se descarta entero. */
  range: GoalRange | null;
  /** Qué lo bloqueó. `null` si no se bloqueó. */
  blockedBy: AdaptiveReasonCode | null;
  overrides: readonly ClinicalOverride[];
}

/** Una cota utilizable: ya pasó el filtro de cifra presente y unidad correcta. */
interface CotaUsable {
  restrictionId: string;
  valor: number;
}

function clasificarCotas(
  cotas: readonly { nutrient: NutrientKey; restrictionId: string; unit: string | null }[],
  valores: readonly (number | null)[],
  nutrient: NutrientKey,
): { usables: CotaUsable[]; hayInservible: boolean } {
  const usables: CotaUsable[] = [];
  let hayInservible = false;
  const unidad = unidadDeNutriente(nutrient);
  for (let i = 0; i < cotas.length; i += 1) {
    const cota = cotas[i];
    if (cota === undefined) continue;
    if (cota.nutrient !== nutrient) continue;
    const valor = valores[i];
    // Sin cifra, o en otra unidad: la cota se respeta NEGÁNDOSE, no ignorándose.
    if (valor === null || valor === undefined || cota.unit !== unidad) {
      hayInservible = true;
      continue;
    }
    usables.push({ restrictionId: cota.restrictionId, valor });
  }
  // Orden fijo por id: dos cotas con el mismo valor tienen que salir siempre en
  // el mismo orden o el motor deja de ser determinista byte a byte.
  usables.sort((a, b) => (a.restrictionId < b.restrictionId ? -1 : a.restrictionId > b.restrictionId ? 1 : 0));
  return { usables, hayInservible };
}

/**
 * LA PRIMITIVA DE "LO CLÍNICO SIEMPRE GANA", mitad techo.
 *
 * Esta función compone EXCLUSIVAMENTE con `Math.min`. No hay ningún `Math.max`
 * en su cuerpo, y hay un test estructural que lee este archivo para
 * comprobarlo: mientras eso se cumpla, es matemáticamente imposible que la
 * salida quede sobre el techo clínico, sin importar qué le entre.
 */
export function applyClinicalCeilings(
  proposed: GoalRange,
  ceilings: readonly ClinicalCeiling[],
  nutrient: NutrientKey,
): ClinicalComposition {
  const { usables, hayInservible } = clasificarCotas(
    ceilings,
    ceilings.map((c) => c.max),
    nutrient,
  );
  if (hayInservible) {
    return { range: null, blockedBy: "CLINICAL_LIMIT_UNUSABLE", overrides: [] };
  }
  if (usables.length === 0) return { range: proposed, blockedBy: null, overrides: [] };

  let techo = Number.POSITIVE_INFINITY;
  for (const cota of usables) techo = Math.min(techo, cota.valor);

  const bindings: ClinicalOverride[] = usables
    .filter((c) => c.valor === techo)
    .map((c) => ({ restrictionId: c.restrictionId, nutrient, kind: "CEILING" as const, cappedAt: techo }));

  // El techo clínico ya está BAJO el mínimo que la persona declaró. Bajarle el
  // mínimo en silencio para que "quepa" sería resolver a mano una contradicción
  // entre una indicación de salud y una decisión de la persona.
  if (proposed.minimum !== null && techo < proposed.minimum) {
    return { range: null, blockedBy: "CLINICAL_CEILING_BLOCKS_PROPOSAL", overrides: bindings };
  }

  const maximum = proposed.maximum === null ? techo : Math.min(proposed.maximum, techo);
  const preferred = proposed.preferred === null ? null : Math.min(proposed.preferred, techo);
  const range: GoalRange = { minimum: proposed.minimum, preferred, maximum };
  const recorto = maximum !== proposed.maximum || preferred !== proposed.preferred;
  return { range, blockedBy: null, overrides: recorto ? bindings : [] };
}

/**
 * La mitad simétrica: los `NUTRIENT_MIN` confirmados. Compone EXCLUSIVAMENTE
 * con `Math.max` y nunca toca el máximo — un piso no ensancha un techo.
 *
 * Existe porque `minimumFloorPolicy` protege el mínimo que declaró la PERSONA,
 * que no es el que indicó un profesional: sin este canal, un superávit
 * sostenido podía apretar la proteína bajo un mínimo clínico vigente.
 */
export function applyClinicalFloors(
  proposed: GoalRange,
  floors: readonly ClinicalFloor[],
  nutrient: NutrientKey,
): ClinicalComposition {
  const { usables, hayInservible } = clasificarCotas(
    floors,
    floors.map((f) => f.min),
    nutrient,
  );
  if (hayInservible) {
    return { range: null, blockedBy: "CLINICAL_LIMIT_UNUSABLE", overrides: [] };
  }
  if (usables.length === 0) return { range: proposed, blockedBy: null, overrides: [] };

  let piso = Number.NEGATIVE_INFINITY;
  for (const cota of usables) piso = Math.max(piso, cota.valor);

  const bindings: ClinicalOverride[] = usables
    .filter((c) => c.valor === piso)
    .map((c) => ({ restrictionId: c.restrictionId, nutrient, kind: "FLOOR" as const, cappedAt: piso }));

  if (proposed.maximum !== null && piso > proposed.maximum) {
    return { range: null, blockedBy: "CLINICAL_FLOOR_BLOCKS_PROPOSAL", overrides: bindings };
  }

  const minimum = proposed.minimum === null ? piso : Math.max(proposed.minimum, piso);
  const preferred = proposed.preferred === null ? null : Math.max(proposed.preferred, piso);
  const range: GoalRange = { minimum, preferred, maximum: proposed.maximum };
  const subio = minimum !== proposed.minimum || preferred !== proposed.preferred;
  return { range, blockedBy: null, overrides: subio ? bindings : [] };
}

/**
 * Techo y piso juntos, en ese orden, y con el `preferred` re-encajado DESPUÉS
 * de los dos recortes.
 *
 * El orden importa: si el preferido se clampeara antes de aplicar el techo, la
 * salida podía quedar `{maximum: 70, preferred: 90}` — o sea proponiendo como
 * ideal un valor sobre el límite clínico, y de paso violando el
 * `goal_range_ordered` de `nutrition_goals`.
 */
export function applyClinicalBounds(
  proposed: GoalRange,
  ceilings: readonly ClinicalCeiling[],
  floors: readonly ClinicalFloor[],
  nutrient: NutrientKey,
): ClinicalComposition {
  const conTecho = applyClinicalCeilings(proposed, ceilings, nutrient);
  if (conTecho.range === null) return conTecho;

  const conPiso = applyClinicalFloors(conTecho.range, floors, nutrient);
  const overrides = [...conTecho.overrides, ...conPiso.overrides];
  if (conPiso.range === null) return { range: null, blockedBy: conPiso.blockedBy, overrides };

  const r = conPiso.range;
  if (r.minimum !== null && r.maximum !== null && r.minimum > r.maximum) {
    // UN RANGO DESORDENADO NO ES SIEMPRE UNA INDICACIÓN DE SALUD.
    //
    // Este `return` decía CLINICAL_CEILING_BLOCKS_PROPOSAL pasara lo que
    // pasara, y un ataque mostró lo que eso produce: con las dos listas
    // clínicas VACÍAS y cero restricciones activas, a una familia sin un solo
    // dato de salud se le decía «una indicación de salud no deja espacio para
    // este ajuste». Inventar una indicación médica que no existe es peor que
    // no explicar nada — y en este proyecto lo clínico se CITA, no se supone.
    //
    // Si ninguna cota tocó este nutriente, el desorden viene de los parámetros
    // del propio motor (o del rango que traía la propuesta), y eso tiene su
    // código: ADJUSTMENT_CAPPED_BY_PARAMS. El bloqueo clínico se reserva para
    // cuando de verdad hubo una cota, que es exactamente lo que `overrides`
    // registra.
    const huboCota =
      overrides.length > 0 ||
      ceilings.some((c) => c.nutrient === nutrient) ||
      floors.some((f) => f.nutrient === nutrient);
    return {
      range: null,
      blockedBy: huboCota ? "CLINICAL_CEILING_BLOCKS_PROPOSAL" : "ADJUSTMENT_CAPPED_BY_PARAMS",
      overrides,
    };
  }
  let preferred = r.preferred;
  if (preferred !== null && r.minimum !== null) preferred = Math.max(preferred, r.minimum);
  if (preferred !== null && r.maximum !== null) preferred = Math.min(preferred, r.maximum);
  return { range: { minimum: r.minimum, preferred, maximum: r.maximum }, blockedBy: null, overrides };
}

// ---------------------------------------------------------------------------
// Textos: los lee una persona
// ---------------------------------------------------------------------------

/**
 * Ningún texto lleva juicio de valor ni lenguaje diagnóstico. "Comiste de más"
 * no; "los últimos tres días quedaste sobre el rango que declaraste" sí. La
 * diferencia no es de tono: un registro que se lee como una nota que se aprueba
 * termina anotando lo que queda bien en vez de lo que pasó.
 */
function textoDe(code: AdaptiveReasonCode, nutrient: NutrientKey | null, dias: number | null): string {
  const goalType = nutrient === null ? null : nutrientKeyToGoalType(nutrient);
  const nombre = goalType === null ? "este objetivo" : GOAL_LABELS[goalType].label.toLowerCase();
  const enDias = dias === null ? "estos días" : dias === 1 ? "este día" : `los últimos ${dias} días`;
  switch (code) {
    case "DATA_COVERAGE_INSUFFICIENT":
      return "Todavía faltan comidas por anotar en estos días, así que no se saca ninguna conclusión.";
    case "NUTRIENT_UNKNOWN":
      return `No hay información suficiente de ${nombre} en estos días.`;
    case "NUTRIENT_PARTIAL":
      return `La suma de ${nombre} está incompleta: es un piso, no el total.`;
    case "LOWER_BOUND_CANNOT_SUSTAIN_DEFICIT":
      return `La suma de ${nombre} está incompleta, y lo que falta solo puede sumar: con eso no se puede afirmar que hayas quedado bajo el rango.`;
    case "NO_TARGET_DECLARED":
      return `No tienes un objetivo declarado de ${nombre}, y no se te inventa uno.`;
    case "NO_COMPARABLE_TARGET_DAYS":
      return (
        `Hay días con ${nombre} anotado y días con objetivo, pero no son los mismos días: ` +
        `no se pueden restar sin inventar un desvío. Por eso acá no se dice nada.`
      );
    case "TRACKING_MODE_OFF":
      return "Tienes el seguimiento desactivado, así que no se calcula nada con tus registros.";
    case "TRACKING_MODE_BASIC":
      return "Tu seguimiento es básico y no pide registro detallado, así que no se propone nada sobre la energía.";
    case "HISTORY_TOO_SHORT":
      return `Todavía hay pocos días medidos de ${nombre} para sostener un cambio.`;
    case "DAY_UNTRACKED_BY_EVENT":
      return "Este día lo marcaste sin conteo, así que no se ajusta nada por lo que haya pasado.";
    case "WITHIN_NOISE_BAND":
      return `Lo de ${enDias} quedó dentro del rango que declaraste para ${nombre}.`;
    case "SUSTAINED_SURPLUS":
      return `${capitalizar(enDias)} quedaste sobre el rango que declaraste para ${nombre}.`;
    case "SUSTAINED_DEFICIT":
      return `${capitalizar(enDias)} quedaste bajo el rango que declaraste para ${nombre}.`;
    case "SUSTAINED_UNDEREATING":
      return "Lo registrado en estos días queda bastante bajo lo que declaraste. Esto lo mira una persona; el sistema no lo ajusta solo.";
    case "SINGLE_DAY_DEVIATION":
      return `Este día se salió del rango de ${nombre}, y un día solo no sostiene un cambio de objetivo.`;
    case "ADJUSTMENT_CAPPED_BY_PARAMS":
      return `La propuesta de ${nombre} se recortó al máximo que el sistema puede mover un objetivo.`;
    case "FLOOR_MINIMUM_ENFORCED":
      return `La propuesta de ${nombre} no baja del mínimo que declaraste.`;
    case "NO_FASTING_ALLOWED":
      return "El sistema no propone saltarse comidas.";
    case "NO_ACTIVITY_COMPENSATION":
      return "El sistema no propone compensar lo comido con ejercicio.";
    case "EVENT_EFFECT_RESPECTED":
      return "Los objetivos de este día ya venían con el margen del evento, y la propuesta parte de ahí.";
    case "NO_CEILING_INVENTED":
      return `No declaraste máximo para ${nombre}, y no se te crea uno.`;
    case "CLINICAL_CEILING_APPLIED":
      return "Parte de esta propuesta quedó acotada por una indicación de salud.";
    case "CLINICAL_CEILING_BLOCKS_PROPOSAL":
    case "CLINICAL_FLOOR_BLOCKS_PROPOSAL":
      return "Una indicación de salud no deja espacio para este ajuste, así que no se propone. Lo revisa una persona.";
    case "CLINICAL_LIMIT_UNUSABLE":
      return "Hay una indicación de salud que no se puede aplicar tal como está guardada, así que no se propone nada. Lo revisa una persona.";
    case "CLINICAL_CEILING_UNVERIFIED":
      return "Hay una indicación de salud que este cálculo no puede verificar, así que la propuesta queda como opcional.";
    case "CLINICAL_REVIEW_PENDING":
      return "Hay una revisión de salud pendiente. Mientras tanto no se propone ningún ajuste.";
    case "CLINICAL_STATUS_BLOCKS_PROPOSAL":
      return "Este día quedó marcado para revisión, así que no se propone ningún ajuste.";
    case "CLINICAL_STATUS_UNKNOWN":
      return "Este día todavía no se revisa, así que no se propone ningún ajuste.";
    case "CLINICAL_CONTEXT_UNRESOLVED":
      return "No se pudo leer la información de salud de esta persona. Que no se pueda ver no significa que no exista, así que no se propone nada.";
  }
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

interface Acumulador {
  reasons: AdaptiveReason[];
  missingData: AdaptiveMissingData[];
}

function agregarRazon(
  acc: Acumulador,
  code: AdaptiveReasonCode,
  nutrient: NutrientKey | null,
  params: Record<string, string | number | null>,
  dias: number | null = null,
): void {
  // Los códigos clínicos JAMÁS nombran el nutriente: `reasons` se guarda en la
  // superficie del hogar y decir "tu objetivo de potasio quedó acotado" publica
  // la condición aunque no se nombre ninguna enfermedad.
  const visible = REASON_CODES_SIN_NUTRIENTE.includes(code) ? null : nutrient;
  if (acc.reasons.some((r) => r.code === code && r.nutrient === visible)) return;
  acc.reasons.push({ code, nutrient: visible, text: textoDe(code, visible, dias), params });
}

function ordenarMissing(a: AdaptiveMissingData, b: AdaptiveMissingData): number {
  const clave = (m: AdaptiveMissingData) => `${m.kind}|${m.target}|${m.detail}`;
  return clave(a) < clave(b) ? -1 : clave(a) > clave(b) ? 1 : 0;
}

function salida(
  input: AdaptiveInput,
  params: AdaptiveParams,
  verdict: AdaptiveVerdict,
  window: RollingWindow | null,
  referencia: RollingBalance,
  acc: Acumulador,
  adjustments: readonly AdaptiveAdjustment[],
  clinicalOverrides: readonly ClinicalOverride[],
  unverifiedCeilings: readonly UnverifiedCeiling[],
): AdaptiveReview {
  if (acc.reasons.length === 0) {
    // Ningún veredicto sale sin razón: un motor que dice "no cambies" sin decir
    // por qué es indistinguible de un motor roto.
    throw new RangeError("adaptive-nutrition: se llegó a un veredicto sin ninguna razón declarada");
  }
  if (verdict !== "OPTIONAL_ADJUSTMENT" && verdict !== "RECOMMENDED_ADJUSTMENT" && adjustments.length > 0) {
    throw new RangeError(`adaptive-nutrition: ${verdict} no puede llevar ajustes`);
  }
  return {
    engineVersion: ADAPTIVE_ENGINE_VERSION,
    verdict,
    window,
    adjustments,
    reasons: acc.reasons,
    missingData: [...acc.missingData].sort(ordenarMissing),
    clinicalOverrides,
    unverifiedCeilings,
    coverage: referencia.coverage,
    confidence: referencia.confidence,
    frozen: frozenAdaptiveConfig(params),
  };
}

export function reviewAdaptiveNutrition(input: AdaptiveInput): AdaptiveReview {
  const params = input.params === undefined ? DEFAULT_ADAPTIVE_PARAMS : input.params;
  const date = assertDateOnly(input.date, "date");

  // --- La entrada se valida a gritos: un cargador con un bug no se tapa acá ---
  const porVentana = new Map<RollingWindow, RollingBalance>();
  for (const balance of input.balances) {
    if (porVentana.has(balance.window)) {
      throw new RangeError(`balances trae dos veces la ventana ${balance.window}`);
    }
    if (balance.endDate !== date) {
      throw new RangeError(
        `la ventana ${balance.window} termina en ${balance.endDate} y la revisión es del ${date}: son días distintos`,
      );
    }
    porVentana.set(balance.window, balance);
  }
  const base = porVentana.get("W24H");
  if (base === undefined) {
    throw new RangeError("balances tiene que incluir la ventana W24H: sin el día no hay nada que explicar");
  }
  // La ventana más larga disponible es la que sostiene cualquier conclusión.
  let referencia: RollingBalance = base;
  for (const w of ORDEN_VENTANA) {
    const b = porVentana.get(w);
    if (b !== undefined) {
      referencia = b;
      break;
    }
  }

  const acc: Acumulador = { reasons: [], missingData: [] };
  const sinAjustes: readonly AdaptiveAdjustment[] = [];
  const sinOverrides: readonly ClinicalOverride[] = [];

  // --- Techos sobre nutrientes que ningún objetivo puede expresar ---
  // Sodio, potasio y fósforo llevan los techos clínicos reales y no tienen
  // GoalType: subir la energía sube el sodio, y acá no hay nada que recortar.
  // Declararlo es la única forma de que `clinicalOverrides: []` no se lea como
  // "lo clínico no tuvo nada que decir" cuando la verdad es "no se verificó".
  //
  // LÍMITE DECLARADO, NO ESCONDIDO: el caso espejo —un PISO clínico sobre un
  // nutriente sin GoalType, con una propuesta que APRIETA— no está cubierto por
  // esta lista. Se declara acá en vez de fingir que no existe.
  const unverifiedCeilings: UnverifiedCeiling[] = [
    ...input.clinicalCeilings.filter((c) => nutrientKeyToGoalType(c.nutrient) === null),
    ...input.clinicalUnusableLimits.filter((u) => nutrientKeyToGoalType(u.nutrient) === null),
  ]
    .map((c) => ({
      restrictionId: c.restrictionId,
      nutrient: c.nutrient,
      reason: "NO_GOAL_TYPE_FOR_NUTRIENT" as const,
    }))
    // La clave tiene que ser TOTAL. Ordenar solo por `restrictionId` deja el
    // orden de dos cotas de la misma restricción sobre nutrientes distintos
    // —sodio y potasio, que es justo el par que aparece junto— a merced del
    // orden de entrada, y este motor promete salida idéntica byte a byte.
    .sort((a, b) => {
      const ka = `${a.restrictionId}|${a.nutrient}`;
      const kb = `${b.restrictionId}|${b.nutrient}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  // --- Regla 1: el canal clínico no se pudo leer ---
  if (
    !input.clinicalContextResolved ||
    input.pendingClinicalReviews === null ||
    input.activeClinicalRestrictions === null
  ) {
    agregarRazon(acc, "CLINICAL_CONTEXT_UNRESOLVED", null, {
      context_resolved: input.clinicalContextResolved ? "true" : "false",
    });
    return salida(input, params, "REVIEW_REQUIRED", null, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 2: revisión de salud pendiente ⇒ el motor se calla ---
  if (input.pendingClinicalReviews > 0) {
    agregarRazon(acc, "CLINICAL_REVIEW_PENDING", null, { pending: input.pendingClinicalReviews });
    return salida(input, params, "REVIEW_REQUIRED", null, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 3: veredicto clínico que bloquea ---
  if (input.clinicalStatus === "CLINICALLY_INVALIDATED" || input.clinicalStatus === "REVIEW_REQUIRED") {
    agregarRazon(acc, "CLINICAL_STATUS_BLOCKS_PROPOSAL", null, {});
    return salida(input, params, "REVIEW_REQUIRED", null, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 4: hay restricciones vigentes y el día no fue evaluado ---
  if (
    input.activeClinicalRestrictions > 0 &&
    (input.clinicalStatus === null || input.clinicalStatus === "NOT_ASSESSED")
  ) {
    agregarRazon(acc, "CLINICAL_STATUS_UNKNOWN", null, {});
    return salida(input, params, "REVIEW_REQUIRED", null, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 5: seguimiento apagado ---
  if (input.trackingMode === "OFF") {
    agregarRazon(acc, "TRACKING_MODE_OFF", null, {});
    return salida(input, params, "INSUFFICIENT_DATA", null, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 6: cobertura ---
  const mealRatio = referencia.coverage.mealRatio;
  if (mealRatio === null || mealRatio < params.minCoverageForAnyVerdict) {
    agregarRazon(acc, "DATA_COVERAGE_INSUFFICIENT", null, {
      meal_ratio: mealRatio,
      minimo: params.minCoverageForAnyVerdict,
    });
    for (const dia of referencia.coverage.missing) {
      acc.missingData.push({
        kind: "DAY",
        target: dia.date,
        detail:
          dia.mealsMissing === null
            ? `${dia.reason}: no hay historia de ese día`
            : `${dia.reason}: faltan ${dia.mealsMissing} comidas`,
      });
    }
    if (referencia.coverage.mealsExpected === 0) {
      acc.missingData.push({
        kind: "MEAL",
        target: referencia.window,
        detail: "el patrón no declara comidas en esta ventana",
      });
    }
    return salida(input, params, "INSUFFICIENT_DATA", referencia.window, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 7: el día se marcó sin conteo ---
  if (input.eventEffect.kind === "UNTRACKED") {
    agregarRazon(acc, "DAY_UNTRACKED_BY_EVENT", null, {
      event: input.eventEffect.event === null ? null : input.eventEffect.event.title,
    });
    return salida(input, params, "NO_CHANGE", referencia.window, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 8: subconsumo sostenido ---
  // Se exige lectura COMPLETA: con una suma parcial, "menos de la mitad" no
  // está establecido —lo que falta solo puede sumar— y afirmarlo sería inventar
  // una alarma. Sin datos completos el camino correcto es INSUFFICIENT_DATA.
  const energia = referencia.balances.energy_kcal;
  if (
    energia.deltaRatio !== null &&
    energia.completeness === "COMPLETE" &&
    !energia.isLowerBound &&
    energia.daysCounted >= params.underEatingMinDays &&
    energia.deltaRatio <= params.underEatingRatio - 1
  ) {
    agregarRazon(acc, "SUSTAINED_UNDEREATING", null, {
      dias: energia.daysCounted,
      ventana: referencia.window,
    });
    return salida(input, params, "REVIEW_REQUIRED", referencia.window, referencia, acc, sinAjustes, sinOverrides, unverifiedCeilings);
  }

  // --- Regla 9: nutriente por nutriente ---
  const adjustments: AdaptiveAdjustment[] = [];
  const clinicalOverrides: ClinicalOverride[] = [];
  let bloqueoClinico = false;
  let faltaronDatos = false;
  let ventanaSostenedora: RollingWindow | null = null;
  let coberturaSostenedora: number | null = null;
  let huboAumento = false;

  const validFrom = date;
  // Tres días de vigencia son hoy, mañana y pasado. `maxValidityDays` cuenta
  // días vividos, no saltos de calendario.
  const validUntil = addDays(validFrom, Math.max(params.maxValidityDays - 1, 0));

  for (const goalType of GOAL_TYPES) {
    const key = goalTypeToNutrientKey(goalType);

    // BASIC = "objetivos sin exigir registro detallado". La energía de esos
    // días es la menos confiable que existe: no se propone nada sobre ella.
    if (input.trackingMode === "BASIC" && goalType === "ENERGY_KCAL") {
      agregarRazon(acc, "TRACKING_MODE_BASIC", key, {});
      continue;
    }

    // Cota que la BASE ya marcó inservible: llega por un canal aparte, porque
    // `app.adaptive_clinical_context` no la manda entre los techos usables. Sin
    // mirar acá, una restricción CONFIRMED sin cifra desaparecía del cálculo —
    // que es exactamente convertir "hay un límite y no sabemos cuál" en "no hay
    // límite".
    if (input.clinicalUnusableLimits.some((u) => u.nutrient === key)) {
      agregarRazon(acc, "CLINICAL_LIMIT_UNUSABLE", key, {});
      bloqueoClinico = true;
      continue;
    }

    const from = input.resolvedTargets[goalType];
    const balanceBase = base.balances[key];

    if (from === undefined || from.preferred === null) {
      // Solo se declara la falta de objetivo cuando SÍ hay comida medida: decir
      // "no declaraste objetivo de fibra" a alguien que tampoco registró fibra
      // es ruido, y el ruido esconde lo que sí importa.
      if (balanceBase.actual !== null) {
        agregarRazon(acc, "NO_TARGET_DECLARED", key, {});
        acc.missingData.push({ kind: "TARGET", target: goalType, detail: "sin objetivo declarado para el día" });
      }
      continue;
    }

    if (balanceBase.deltaRatio === null && balanceBase.completeness === "UNKNOWN") {
      agregarRazon(acc, "NUTRIENT_UNKNOWN", key, {});
      acc.missingData.push({ kind: "NUTRIENT", target: key, detail: "sin valor conocido en la ventana del día" });
      faltaronDatos = true;
      continue;
    }

    // Ventana que SOSTIENE: la más larga con desvío real. W24H nunca sostiene
    // un ajuste — sirve para explicar el día, no para cambiar un objetivo.
    let sostenedora: RollingBalance | null = null;
    let balanceSostenedor: NutrientBalance | null = null;
    // NO ES LO MISMO "no hubo desvío" QUE "no pude comparar", y durante un rato
    // este bucle los trató igual: los dos salían por el mismo `continue`.
    //
    // `rollingBalance` deja `deltaRatio` en null por DOS motivos distintos: o no
    // hay valor conocido, o los días con comida y los días con objetivo no son
    // los mismos (`daysCounted !== daysComparable`), y restar sumas de universos
    // distintos fabrica un desvío que nadie vivió. Ese segundo caso llega acá
    // con `completeness: "COMPLETE"`, así que el guard de más arriba —que exige
    // UNKNOWN— no lo ataja.
    //
    // Consecuencia real, reproducida por un ataque: alguien come 50 % sobre su
    // objetivo seis días seguidos, D3 y D7 quedan incomparables, y el motor sale
    // con NO_CHANGE diciendo «quedó dentro del rango que declaraste», con
    // `missingData` vacío. UNKNOWN nunca significa NORMAL.
    const incomparables: RollingWindow[] = [];
    for (const w of ORDEN_VENTANA) {
      if (w === "W24H") continue;
      const b = porVentana.get(w);
      if (b === undefined) continue;
      const nb = b.balances[key];
      if (nb.deltaRatio === null) {
        incomparables.push(w);
        continue;
      }
      if (Math.abs(nb.deltaRatio) <= params.noiseBandRatio) continue;
      sostenedora = b;
      balanceSostenedor = nb;
      break;
    }

    const desvioHoy =
      balanceBase.deltaRatio !== null && Math.abs(balanceBase.deltaRatio) > params.noiseBandRatio;

    if (sostenedora === null || balanceSostenedor === null) {
      // Si alguna ventana quedó incomparable, se dice — pase lo que pase con el
      // día de hoy. Un veredicto que se apoya solo en las últimas 24 horas
      // mientras los 3 y los 7 días no se pudieron comparar no está informado,
      // y la persona tiene derecho a saberlo.
      if (incomparables.length > 0) {
        agregarRazon(acc, "NO_COMPARABLE_TARGET_DAYS", key, {
          ventanas: incomparables.join(", "),
        });
        acc.missingData.push({
          kind: "TARGET",
          target: goalType,
          detail: `sin objetivo declarado en todos los días de ${incomparables.join(" y ")}`,
        });
        faltaronDatos = true;
      }
      if (desvioHoy) agregarRazon(acc, "SINGLE_DAY_DEVIATION", key, { delta_ratio: balanceBase.deltaRatio });
      else if (incomparables.length === 0) {
        // "Quedaste dentro del rango" es una AFIRMACIÓN, y solo se dice cuando
        // de verdad hubo con qué compararla.
        agregarRazon(acc, "WITHIN_NOISE_BAND", key, { delta_ratio: balanceBase.deltaRatio }, 1);
      }
      continue;
    }

    const deltaRatio = balanceSostenedor.deltaRatio;
    if (deltaRatio === null) continue; // inalcanzable: el filtro de arriba ya lo garantiza
    const esDeficit = deltaRatio < 0;

    // El día de hoy contradice a la ventana: no se toca nada.
    if (desvioHoy && balanceBase.deltaRatio !== null && (balanceBase.deltaRatio < 0) !== esDeficit) {
      agregarRazon(acc, "SINGLE_DAY_DEVIATION", key, { delta_ratio: balanceBase.deltaRatio });
      continue;
    }

    // Una suma parcial es una COTA INFERIOR: lo que falta solo puede sumar. Eso
    // sostiene "quedaste sobre el rango" y JAMÁS "quedaste bajo el rango".
    if (esDeficit && balanceSostenedor.isLowerBound) {
      agregarRazon(acc, "LOWER_BOUND_CANNOT_SUSTAIN_DEFICIT", key, { ventana: sostenedora.window });
      acc.missingData.push({ kind: "NUTRIENT", target: key, detail: "suma parcial: cota inferior" });
      faltaronDatos = true;
      continue;
    }

    // Superávit sostenido por una suma parcial: la conclusión SE SOSTIENE (lo
    // que falta solo puede sumar), pero el número que la respalda es un piso y
    // eso se dice.
    if (balanceSostenedor.isLowerBound) agregarRazon(acc, "NUTRIENT_PARTIAL", key, {});

    if (balanceSostenedor.daysCounted < params.minClosedDaysForAnyAdjustment) {
      agregarRazon(acc, "HISTORY_TOO_SHORT", key, {
        dias_medidos: balanceSostenedor.daysCounted,
        minimo: params.minClosedDaysForAnyAdjustment,
      });
      continue;
    }

    // --- (a) propuesta cruda ---
    const factor = 1 - deltaRatio;
    const cappedBy: ("PARAMS" | "MINIMUM_FLOOR" | "CLINICAL_CEILING" | "CLINICAL_FLOOR")[] = [];

    // --- (b) topes de parámetros, borde por borde y en las dos direcciones ---
    const acotar = (borde: number | null): number | null => {
      if (borde === null) return null;
      if (borde < 0) {
        throw new RangeError(`objetivo de ${goalType} con borde negativo (${borde}): eso no es un objetivo`);
      }
      const crudo = borde * factor;
      const piso = borde * params.maxDecreaseRatio;
      const techo = borde * params.maxIncreaseRatio;
      const acotado = Math.min(Math.max(crudo, piso), techo);
      if (acotado !== crudo) cappedBy.push("PARAMS");
      return redondear(acotado);
    };

    let minimum = acotar(from.minimum);
    let preferred = acotar(from.preferred);
    const maximum = acotar(from.maximum);

    // El mínimo DECLARADO nunca baja: un objetivo que se aprieta no se paga
    // recortando el piso que la persona se puso.
    if (from.minimum !== null && minimum !== null && minimum < from.minimum) {
      minimum = from.minimum;
      cappedBy.push("MINIMUM_FLOOR");
    }
    if (preferred !== null && minimum !== null) preferred = Math.max(preferred, minimum);
    if (preferred !== null && maximum !== null) preferred = Math.min(preferred, maximum);

    if (from.maximum === null) {
      // No se crea un borde que la persona nunca declaró. Se deja constancia
      // porque un máximo ausente cambia lo que significa el ajuste.
      agregarRazon(acc, "NO_CEILING_INVENTED", key, {});
    }

    const propuesta: GoalRange = { minimum, preferred, maximum };
    if (
      propuesta.minimum === from.minimum &&
      propuesta.preferred === from.preferred &&
      propuesta.maximum === from.maximum
    ) {
      agregarRazon(acc, "WITHIN_NOISE_BAND", key, { delta_ratio: deltaRatio }, ROLLING_WINDOW_DAYS[sostenedora.window]);
      continue;
    }

    // Un déficit JAMÁS baja un borde. Si esto se rompe, se rompió la doctrina
    // entera del sprint y el motor tiene que caerse, no seguir proponiendo.
    if (esDeficit) {
      for (const borde of ["minimum", "preferred", "maximum"] as const) {
        const antes = from[borde];
        const despues = propuesta[borde];
        if (antes !== null && despues !== null && despues < antes) {
          throw new RangeError(
            `adaptive-nutrition: un déficit de ${goalType} bajó ${borde} de ${antes} a ${despues}; apretar después de comer de menos es la compensación que este motor no puede proponer`,
          );
        }
      }
    }

    // --- (c)(d)(e) composición clínica ---
    const compuesto = applyClinicalBounds(propuesta, input.clinicalCeilings, input.clinicalFloors, key);
    for (const o of compuesto.overrides) clinicalOverrides.push(o);
    if (compuesto.range === null) {
      const code = compuesto.blockedBy === null ? "CLINICAL_CEILING_BLOCKS_PROPOSAL" : compuesto.blockedBy;
      agregarRazon(acc, code, key, {});
      bloqueoClinico = true;
      continue;
    }
    if (compuesto.overrides.length > 0) {
      agregarRazon(acc, "CLINICAL_CEILING_APPLIED", key, {});
      for (const o of compuesto.overrides) {
        cappedBy.push(o.kind === "CEILING" ? "CLINICAL_CEILING" : "CLINICAL_FLOOR");
      }
    }

    const to = compuesto.range;
    verificarInvariantes(goalType, key, from, to, input.clinicalCeilings, input.clinicalFloors);

    const reasonCode: AdaptiveReasonCode = esDeficit ? "SUSTAINED_DEFICIT" : "SUSTAINED_SURPLUS";
    agregarRazon(acc, reasonCode, key, {
      delta_ratio: deltaRatio,
      ventana: sostenedora.window,
    }, ROLLING_WINDOW_DAYS[sostenedora.window]);
    if (cappedBy.includes("PARAMS")) agregarRazon(acc, "ADJUSTMENT_CAPPED_BY_PARAMS", key, {});
    if (cappedBy.includes("MINIMUM_FLOOR")) agregarRazon(acc, "FLOOR_MINIMUM_ENFORCED", key, {});
    if (input.eventEffect.kind === "RELAXED" || input.eventEffect.kind === "LIGHTER") {
      agregarRazon(acc, "EVENT_EFFECT_RESPECTED", null, { kind: input.eventEffect.kind });
    }

    if (esDeficit) huboAumento = true;

    adjustments.push({
      goalType,
      nutrient: key,
      scope: "TEMPORARY_DAY",
      validFrom,
      validUntil,
      from: { minimum: from.minimum, preferred: from.preferred, maximum: from.maximum },
      to,
      reasonCode,
      // Orden fijo y sin repetidos: el mismo ajuste tiene que serializarse igual
      // las dos veces que se calcule.
      cappedBy: (["PARAMS", "MINIMUM_FLOOR", "CLINICAL_CEILING", "CLINICAL_FLOOR"] as const).filter((c) =>
        cappedBy.includes(c),
      ),
      window: sostenedora.window,
    });

    if (
      ventanaSostenedora === null ||
      ROLLING_WINDOW_DAYS[sostenedora.window] > ROLLING_WINDOW_DAYS[ventanaSostenedora]
    ) {
      ventanaSostenedora = sostenedora.window;
      coberturaSostenedora = sostenedora.coverage.mealRatio;
    }
  }

  clinicalOverrides.sort((a, b) => {
    const ka = `${a.restrictionId}|${a.kind}`;
    const kb = `${b.restrictionId}|${b.kind}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // --- (f) cualquier bloqueo clínico vacía TODA la propuesta ---
  if (bloqueoClinico) {
    return salida(
      input, params, "REVIEW_REQUIRED", referencia.window, referencia, acc,
      sinAjustes, clinicalOverrides, unverifiedCeilings,
    );
  }

  if (adjustments.length === 0) {
    const verdict: AdaptiveVerdict = faltaronDatos ? "INSUFFICIENT_DATA" : "NO_CHANGE";
    if (acc.reasons.length === 0) {
      agregarRazon(acc, "WITHIN_NOISE_BAND", null, {}, ROLLING_WINDOW_DAYS[referencia.window]);
    }
    return salida(
      input, params, verdict, referencia.window, referencia, acc,
      sinAjustes, clinicalOverrides, unverifiedCeilings,
    );
  }

  // --- Regla 10: fuerza del veredicto ---
  let verdict: AdaptiveVerdict =
    coberturaSostenedora !== null && coberturaSostenedora >= params.minCoverageForRecommendation
      ? "RECOMMENDED_ADJUSTMENT"
      : "OPTIONAL_ADJUSTMENT";

  // Hay un techo clínico sobre un nutriente que ningún objetivo puede expresar
  // y la propuesta AUMENTA la ingesta: nadie verificó ese techo. La propuesta
  // no se recomienda, queda como opcional y se dice por qué.
  if (unverifiedCeilings.length > 0 && huboAumento) {
    verdict = "OPTIONAL_ADJUSTMENT";
    agregarRazon(acc, "CLINICAL_CEILING_UNVERIFIED", null, {});
  }

  return salida(
    input, params, verdict, ventanaSostenedora, referencia, acc,
    adjustments, clinicalOverrides, unverifiedCeilings,
  );
}

/**
 * La última pared, y a propósito revienta en vez de corregir: si acá algo no
 * cuadra, el error está en el cálculo de arriba y taparlo devolviendo un rango
 * "arreglado" haría que el bug viviera para siempre.
 */
function verificarInvariantes(
  goalType: GoalType,
  key: NutrientKey,
  from: GoalRange,
  to: GoalRange,
  ceilings: readonly ClinicalCeiling[],
  floors: readonly ClinicalFloor[],
): void {
  if (to.minimum === null && to.preferred === null && to.maximum === null) {
    throw new RangeError(`adaptive-nutrition: el ajuste de ${goalType} quedó sin ningún borde`);
  }
  if (to.minimum !== null && to.preferred !== null && to.minimum > to.preferred) {
    throw new RangeError(`adaptive-nutrition: ${goalType} quedó con mínimo sobre el preferido`);
  }
  if (to.preferred !== null && to.maximum !== null && to.preferred > to.maximum) {
    throw new RangeError(`adaptive-nutrition: ${goalType} quedó con preferido sobre el máximo`);
  }
  if (to.minimum !== null && to.maximum !== null && to.minimum > to.maximum) {
    throw new RangeError(`adaptive-nutrition: ${goalType} quedó con mínimo sobre el máximo`);
  }
  if (from.minimum !== null && to.minimum !== null && to.minimum < from.minimum) {
    throw new RangeError(`adaptive-nutrition: ${goalType} bajó del mínimo declarado`);
  }
  for (const c of ceilings) {
    if (c.nutrient !== key || c.max === null || c.unit !== unidadDeNutriente(key)) continue;
    for (const borde of ["minimum", "preferred", "maximum"] as const) {
      const v = to[borde];
      if (v !== null && v > c.max) {
        throw new RangeError(
          `adaptive-nutrition: ${goalType} salió con ${borde} sobre un techo clínico (${v} > ${c.max})`,
        );
      }
    }
  }
  for (const f of floors) {
    if (f.nutrient !== key || f.min === null || f.unit !== unidadDeNutriente(key)) continue;
    for (const borde of ["minimum", "preferred"] as const) {
      const v = to[borde];
      if (v !== null && v < f.min) {
        throw new RangeError(
          `adaptive-nutrition: ${goalType} salió con ${borde} bajo un piso clínico (${v} < ${f.min})`,
        );
      }
    }
  }
}
