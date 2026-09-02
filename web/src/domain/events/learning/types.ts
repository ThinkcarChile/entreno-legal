/**
 * `bbq-learning/1.0.0` — tipos de entrada y salida.
 *
 * REGLA QUE ORDENA TODO ESTE ARCHIVO: si no hay hecho, no hay aprendizaje.
 *
 * El §52 pide sugerir "Juan come harto" y el §53 "podrías comprar un poco
 * menos". Las dos sugerencias son útiles y las dos son fáciles de fabricar: la
 * primera dividiendo lo servido entre los asistentes, la segunda leyendo la
 * sobra no declarada como cero. Este motor no puede hacer ninguna de las dos,
 * porque su ENTRADA no tiene forma de expresarlas:
 *
 *   · el consumo por persona sólo llega como observación ORDINAL declarada a
 *     mano (`guestObservations`); no existe un campo "gramos por invitado"
 *     derivable del total;
 *   · la sobra es `{ known: false }` o un número; no hay `leftoverG: number`
 *     que se pueda dejar en 0 "porque nadie declaró".
 *
 * Un tipo que no puede escribir la mentira es más barato de mantener que una
 * regla que prohíbe escribirla.
 */

/** Escala ordinal declarada por quien organizó. Espeja `public.guest_intake_extent`. */
export type GuestIntakeExtent = "ATE_LITTLE" | "ATE_NORMAL" | "ATE_A_LOT";

/** Apetito del catálogo de invitados (§7). Espeja `public.guest_appetite`. */
export type GuestAppetite = "LOW" | "NORMAL" | "HIGH" | "VERY_HIGH" | "UNKNOWN";

/**
 * La sobra comestible de un evento.
 *
 * `known: false` NO es cero. Un asado del que nadie guardó ni declaró sobras
 * puede haber terminado con la fuente pelada o con dos kilos que se comieron el
 * domingo sin que nadie los anotara: son estados distintos y el motor no elige
 * uno. Simplemente saca ese evento de la métrica.
 */
export type LeftoverFact =
  | { known: false }
  | {
      known: true;
      /** Sólo comestible: el hueso y el desgrase NO son sobra (§54). */
      edibleG: number;
      /** LOT = volvió al refrigerador como lote; DECLARED = alguien lo anotó. */
      source: "LOT" | "DECLARED";
    };

/**
 * La asistencia REAL de un evento.
 *
 * `marks` es cuánta gente tiene marca (ATTENDED o NO_SHOW). Cero marcas
 * significa "nadie pasó lista" —el caso normal: el anfitrión estaba asando— y
 * jamás "no llegó nadie". Sin este campo, doce confirmados y cero marcas se
 * leen como 0% de asistencia: una señal catastrófica que ningún dato respalda.
 *
 * Y la lista A MEDIAS es su propio caso: el denominador de la realización son
 * los MARCADOS (`attended + noShow`), no los confirmados. Con tres marcados de
 * doce, dividir por doce inventa nueve ausencias que nadie observó — y el
 * aprendizaje termina diciéndole a la familia que compre para menos gente.
 * Cuánto se alcanzó a mirar se declara aparte (ATTENDANCE_PARTIAL_COVERAGE).
 */
export interface AttendanceFact {
  confirmed: number;
  marks: number;
  attended: number;
  noShow: number;
  /** Gente que llegó sin estar invitada (§43). Cuenta como asistente real. */
  extras: number;
}

export interface GuestObservationFact {
  /** Identidad ESTABLE del invitado entre eventos (guest_profile_id). */
  guestRef: string;
  /** Nombre para la tarjeta. Puede faltar: un invitado no está obligado a darlo. */
  displayName: string | null;
  extent: GuestIntakeExtent;
  /** Apetito que tiene hoy en su ficha: sirve para no sugerir lo que ya está. */
  currentAppetite: GuestAppetite;
}

export interface BbqLearningEventInput {
  eventId: string;
  /** Fecha civil del hogar, 'YYYY-MM-DD'. El motor no tiene reloj. */
  eventDate: string;
  title: string | null;

  attendance: AttendanceFact;

  /**
   * Lo que salió a la mesa, del libro mayor. `null` = no se registró servido
   * en este evento, que no es "no se sirvió nada".
   */
  servedG: number | null;

  /**
   * Lo que la revisión congelada recomendó COMPRAR, antes del redondeo
   * comercial. `null` = el evento no tuvo estimación guardada.
   */
  recommendedPurchaseG: number | null;

  /** Lo que efectivamente se compró, ya redondeado a presentación (§28). */
  purchasedG: number | null;

  leftover: LeftoverFact;

  guestObservations: readonly GuestObservationFact[];
}

export interface BbqLearningPolicy {
  version: string;
  /** De dónde salen estos números. Política de producto, no requisito médico. */
  source: string;
  /** §51: cuántos eventos CON DATOS DE ESA MÉTRICA se exigen antes de sugerir. */
  minEventsPerMetric: number;
  /** §52: cuántas observaciones declaradas de ESE invitado antes de sugerir. */
  minGuestObservations: number;
  /** Techo del ajuste sugerido. Nunca se aplica solo (§51). */
  maxSuggestedAdjustPct: number;
  /** Bajo esta tasa de sobre-estimación no vale la pena molestar a nadie. */
  minOverEstimateRateToSuggest: number;
  /** Proporción de observaciones que tienen que coincidir para sugerir apetito. */
  guestAgreementRatio: number;
}

export const BBQ_LEARNING_VERSION = "bbq-learning/1.0.0";
export const BBQ_LEARNING_POLICY_VERSION = "bbq-learning-policy/1.0.0";

export const DEFAULT_BBQ_LEARNING_POLICY: BbqLearningPolicy = {
  version: BBQ_LEARNING_POLICY_VERSION,
  source:
    "Política de producto del Sprint 13: mínimos de evidencia y techo del ajuste. " +
    "No hay literatura detrás; hay una decisión de no aprender de poco.",
  // Tres eventos CON datos, no tres eventos. Un asado del que no se registró
  // nada no es evidencia de nada.
  minEventsPerMetric: 3,
  minGuestObservations: 3,
  // ±15% y con confirmación. Aprender rápido de un asado grande arruina el
  // asado chico siguiente.
  maxSuggestedAdjustPct: 0.15,
  minOverEstimateRateToSuggest: 0.1,
  guestAgreementRatio: 2 / 3,
};

export const BBQ_LEARNING_REASON_CODES = [
  "NO_EVENTS",
  "NOT_ENOUGH_EVENTS_WITH_DATA",
  "EVENT_WITHOUT_SERVING_RECORD",
  "EVENT_WITHOUT_LEFTOVER_FACT",
  "EVENT_WITHOUT_ATTENDANCE_MARKS",
  "ATTENDANCE_PARTIAL_COVERAGE",
  "ATTENDANCE_EXTRAS",
  "EVENT_WITHOUT_PURCHASE_REFERENCE",
  "LEFTOVER_RATE_MEASURED",
  "LEFTOVER_SPLIT_ROUNDING",
  "LEFTOVER_SPLIT_UNKNOWN",
  "ATTENDANCE_REALIZATION_MEASURED",
  "GUEST_TREND_MEASURED",
  "GUEST_TREND_NOT_ENOUGH_OBSERVATIONS",
  "GUEST_TREND_NO_AGREEMENT",
  "GUEST_APPETITE_ALREADY_SET",
  "SUGGEST_BUY_LESS",
  "SUGGEST_NOTHING_TO_CHANGE",
] as const;

export type BbqLearningReasonCode = (typeof BBQ_LEARNING_REASON_CODES)[number];

export interface BbqLearningReason {
  code: BbqLearningReasonCode;
  params: Record<string, string | number>;
  text: string;
}

/**
 * Una métrica que puede NO existir, y que cuando no existe dice por qué y
 * cuántos eventos le faltaron. `known: false` con `eventsWithData` es lo que
 * permite escribir "te faltan dos asados con datos" en vez de un guion.
 */
export type LearningMetric =
  | {
      known: false;
      reason: BbqLearningReasonCode;
      eventsWithData: number;
      eventsRequired: number;
    }
  | {
      known: true;
      value: number;
      eventsWithData: number;
      eventsRequired: number;
    };

/**
 * La sobra, partida en sus dos causas (§28 + hallazgo de redondeo).
 *
 * Sobrar porque el proveedor vende cajas de 5 kg no es lo mismo que sobrar
 * porque se estimó de más, y sólo la segunda justifica "compra menos". Sin la
 * partición, el aprendizaje le echa la culpa al apetito de la familia de una
 * sobra que causó el envase.
 */
export type LeftoverSplit =
  | { known: false; reason: BbqLearningReasonCode }
  | {
      known: true;
      /** Excedente que ya venía del redondeo comercial. */
      roundingG: number;
      /** Sobra que NO explica el redondeo: esto es lo que se puede corregir. */
      overEstimateG: number;
    };

export interface GuestTrend {
  guestRef: string;
  displayName: string | null;
  observations: number;
  counts: Record<GuestIntakeExtent, number>;
  currentAppetite: GuestAppetite;
  /** Apetito sugerido. `null` = no hay acuerdo suficiente o ya está puesto. */
  suggestedAppetite: GuestAppetite | null;
  reason: BbqLearningReasonCode;
  text: string;
}

export type LearningSuggestionKind = "BUY_LESS" | "GUEST_APPETITE";

export interface LearningSuggestion {
  kind: LearningSuggestionKind;
  /** Invitado al que apunta, si aplica. */
  guestRef: string | null;
  /** Ajuste propuesto sobre la demanda, ya acotado por la política. */
  adjustPct: number | null;
  appetite: GuestAppetite | null;
  text: string;
  /**
   * SIEMPRE false. Está en el tipo para que se lea en la pantalla y en el
   * código: la sugerencia entra al próximo cálculo sólo si una persona la
   * confirma (§51, §52). Ningún camino de este motor la aplica.
   */
  autoApplied: false;
}

export interface BbqLearningResult {
  engineVersion: string;
  policyVersion: string;
  policySource: string;
  eventsConsidered: number;
  /** Tasa de sobra comestible sobre lo servido, cruda (§54). */
  leftoverRate: LearningMetric;
  /** Parte de esa sobra que NO explica el redondeo comercial. */
  overEstimateRate: LearningMetric;
  leftoverSplitByEvent: readonly (LeftoverSplit & { eventId: string })[];
  /** Asistieron / confirmados, sólo sobre eventos donde alguien pasó lista. */
  attendanceRealization: LearningMetric;
  guestTrends: readonly GuestTrend[];
  suggestions: readonly LearningSuggestion[];
  reasons: readonly BbqLearningReason[];
}
