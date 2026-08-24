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

/**
 * §0A del Sprint 6 — los parámetros de la estrategia son configuración
 * VERSIONADA, no constantes enterradas. Cada porción confirmada guarda la
 * configuración efectiva con la que se calculó (`event_effect` en la base):
 * cambiar estos defaults mañana no reescribe ninguna semana histórica.
 */
export const EVENT_STRATEGY_VERSION = "event-strategy/1.0.0";

export interface EventStrategyParams {
  /** Cuánto se ensancha el techo en la comida del evento. */
  energyCeilingMultiplier: number;
  /** Cuánto se aprieta el resto del día. */
  aroundTargetMultiplier: number;
  /** Ningún ajuste baja del mínimo declarado: un asado no se paga con ayuno. */
  minimumFloorPolicy: "NEVER_BELOW_DECLARED_MINIMUM";
}

export const DEFAULT_EVENT_STRATEGY: EventStrategyParams = {
  energyCeilingMultiplier: 1.25,
  aroundTargetMultiplier: 0.9,
  minimumFloorPolicy: "NEVER_BELOW_DECLARED_MINIMUM",
};

/**
 * Lo que se congela junto a la porción confirmada cuando un evento afectó su
 * cálculo. `null` cuando ningún evento tocó esta comida.
 */
export interface FrozenEventEffect {
  strategy_version: string;
  kind: Exclude<EventEffect["kind"], "NONE">;
  event_id: string | null;
  event_title: string | null;
  params: {
    energy_ceiling_multiplier: number;
    around_target_multiplier: number;
    minimum_floor_policy: string;
  };
}

export function frozenEffectConfig(
  effect: EventEffect,
  params: EventStrategyParams = DEFAULT_EVENT_STRATEGY,
): FrozenEventEffect | null {
  if (effect.kind === "NONE") return null;
  return {
    strategy_version: EVENT_STRATEGY_VERSION,
    kind: effect.kind,
    event_id: effect.event?.id ?? null,
    event_title: effect.event?.title ?? null,
    params: {
      energy_ceiling_multiplier: params.energyCeilingMultiplier,
      around_target_multiplier: params.aroundTargetMultiplier,
      minimum_floor_policy: params.minimumFloorPolicy,
    },
  };
}

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
export function applyEventEffect(
  targets: TargetSet,
  effect: EventEffect,
  params: EventStrategyParams = DEFAULT_EVENT_STRATEGY,
): TargetSet {
  if (effect.kind === "NONE") return targets;
  if (effect.kind === "UNTRACKED") return {};

  const factor =
    effect.kind === "RELAXED" ? params.energyCeilingMultiplier : params.aroundTargetMultiplier;
  const apretar = effect.kind === "LIGHTER";

  const salida: TargetSet = {};
  for (const [clave, range] of Object.entries(targets) as [GoalType, GoalRange | undefined][]) {
    if (!range) continue;
    salida[clave] = escalar(range, factor, apretar);
  }
  return salida;
}
