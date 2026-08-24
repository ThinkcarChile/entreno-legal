import type { MealType } from "../recipes/types";
import type { GoalRange, GoalType, TargetSet } from "./types";

/**
 * Efecto real de un evento sobre los objetivos de una persona (§5 del QA).
 *
 * Hasta el QA del Sprint 5 la estrategia de un evento era decorativa: se
 * guardaba, se mostraba una etiqueta linda en el calendario y el motor de
 * porciones jamás la miraba. Un asado marcado "con margen" producía exactamente
 * la misma porción recortada que un martes cualquiera, y la persona veía
 * "porción reducida para cuadrar tus calorías" el día de su cumpleaños.
 *
 * Dos límites que este módulo no cruza:
 *
 *  - **Un asado no se paga con un día de ayuno.** El alivio y la compensación
 *    están acotados (±25% y −10%) y nunca bajan del mínimo declarado.
 *  - **No se inventan bordes.** Si alguien no declaró un máximo, "con margen" no
 *    le crea uno. Relajar un objetivo inexistente no significa nada.
 */

export const EVENT_STRATEGIES = [
  "AS_PLANNED",
  "RELAXED",
  "LIGHTER_AROUND",
  "SKIP_TRACKING",
] as const;
export type EventStrategy = (typeof EVENT_STRATEGIES)[number];

export interface DayEvent {
  id: string;
  /** Fecha DATE-only, `YYYY-MM-DD`. */
  date: string;
  /** Último día inclusive de un evento de varios días (viaje). `null` = un día. */
  endDate: string | null;
  eventType: string;
  /** Comida puntual del evento. `null` = afecta todo el día. */
  mealType: MealType | null;
  strategy: EventStrategy;
  title: string;
  /** Integrantes afectados. VACÍO = el evento es de toda la familia. */
  memberIds: readonly string[];
}

export interface EventEffect {
  /** Qué se le hace a los objetivos de esta comida. */
  kind: "NONE" | "RELAXED" | "LIGHTER" | "UNTRACKED";
  /** Evento responsable, para poder explicarlo en pantalla. */
  event: DayEvent | null;
  text: string;
}

const SIN_EFECTO: EventEffect = { kind: "NONE", event: null, text: "" };

/** Cuánto se ensancha el techo en la comida del evento. */
const MARGEN_EVENTO = 1.25;
/** Cuánto se aprieta el resto del día. Tope duro: nunca más del 10%. */
const AJUSTE_ALREDEDOR = 0.9;

/** Un evento afecta a esta persona si es familiar o si la nombra. */
export function eventIncludes(event: DayEvent, memberId: string): boolean {
  return event.memberIds.length === 0 || event.memberIds.includes(memberId);
}

/**
 * Un evento cubre una fecha si cae en su rango. La comparación es entre strings
 * `YYYY-MM-DD` a propósito: es lexicográfica y correcta, y no pasa por `Date`,
 * que reinterpretaría la fecha en la zona del servidor y movería el día.
 */
export function eventCoversDate(
  event: Pick<DayEvent, "date" | "endDate">,
  date: string,
): boolean {
  if (!event.endDate) return event.date === date;
  return date >= event.date && date <= event.endDate;
}

/**
 * Qué le pasa a UNA comida de UNA persona en UN día.
 *
 * Un evento de comida puntual (almuerzo de cumpleaños) relaja ese almuerzo y,
 * si la estrategia es LIGHTER_AROUND, aprieta las demás comidas del mismo día —
 * "alrededor" es literal. Un evento de día completo aplica a todo el día.
 */
export function effectFor(
  events: readonly DayEvent[],
  memberId: string,
  date: string,
  mealType: MealType,
): EventEffect {
  const delDia = events.filter(
    (e) => eventCoversDate(e, date) && eventIncludes(e, memberId),
  );
  if (delDia.length === 0) return SIN_EFECTO;

  // Si hay varios eventos el mismo día, gana el más permisivo: nadie debería
  // terminar con una porción más apretada por tener DOS motivos para celebrar.
  const orden: EventEffect["kind"][] = ["UNTRACKED", "RELAXED", "LIGHTER", "NONE"];
  let mejor: EventEffect = SIN_EFECTO;

  for (const evento of delDia) {
    const esLaComidaDelEvento = evento.mealType === null || evento.mealType === mealType;
    let efecto: EventEffect = SIN_EFECTO;

    switch (evento.strategy) {
      case "AS_PLANNED":
        efecto = SIN_EFECTO;
        break;
      case "SKIP_TRACKING":
        efecto = esLaComidaDelEvento
          ? { kind: "UNTRACKED", event: evento, text: `Sin conteo por ${evento.title}.` }
          : SIN_EFECTO;
        break;
      case "RELAXED":
        efecto = esLaComidaDelEvento
          ? { kind: "RELAXED", event: evento, text: `Con margen por ${evento.title}.` }
          : SIN_EFECTO;
        break;
      case "LIGHTER_AROUND":
        efecto = esLaComidaDelEvento
          ? { kind: "RELAXED", event: evento, text: `Con margen por ${evento.title}.` }
          : {
              kind: "LIGHTER",
              event: evento,
              text: `Un poco más liviano por ${evento.title}.`,
            };
        break;
    }

    if (orden.indexOf(efecto.kind) < orden.indexOf(mejor.kind)) mejor = efecto;
  }

  return mejor;
}

function escalar(range: GoalRange, factor: number, apretar: boolean): GoalRange {
  const preferred = range.preferred === null ? null : range.preferred * factor;
  const maximum = range.maximum === null ? null : range.maximum * factor;

  if (!apretar) {
    // Aflojar nunca baja el mínimo: el piso de proteína del día sigue siendo el
    // piso aunque haya cumpleaños.
    return {
      minimum: range.minimum,
      preferred: preferred === null ? null : Math.max(preferred, range.minimum ?? preferred),
      maximum: maximum === null ? null : Math.max(maximum, range.minimum ?? maximum),
    };
  }

  // Apretar tiene piso duro en el mínimo declarado.
  const piso = range.minimum;
  return {
    minimum: range.minimum,
    preferred:
      preferred === null ? null : piso === null ? preferred : Math.max(preferred, piso),
    maximum: maximum === null ? null : piso === null ? maximum : Math.max(maximum, piso),
  };
}

/**
 * Aplica el efecto sobre los objetivos ya efectivos (patrón + excepción del día).
 * Devuelve objetivos nuevos: no muta ni el perfil ni la excepción (§19).
 */
export function applyEventEffect(targets: TargetSet, effect: EventEffect): TargetSet {
  if (effect.kind === "NONE") return targets;
  if (effect.kind === "UNTRACKED") return {};

  const factor = effect.kind === "RELAXED" ? MARGEN_EVENTO : AJUSTE_ALREDEDOR;
  const apretar = effect.kind === "LIGHTER";

  const salida: TargetSet = {};
  for (const [clave, range] of Object.entries(targets) as [GoalType, GoalRange | undefined][]) {
    if (!range) continue;
    salida[clave] = escalar(range, factor, apretar);
  }
  return salida;
}
