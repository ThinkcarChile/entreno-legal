import { JobObjectiveType } from "./enums";
import type { JobObjective } from "./types";

/**
 * El objetivo del trabajo en una frase, igual en todas las pantallas.
 *
 * Las páginas privadas mostraban `description ?? "Mantener el lugar en la
 * fila."`: un trabajo «lo más adelante posible» o «dentro de los primeros N»
 * no trae descripción, así que el cliente, el trabajador y la administración
 * leían un objetivo distinto del que se publicó (y del que ve la página
 * pública). Para los objetivos de fila manda el tipo; la descripción solo
 * cuenta en una gestión o un objetivo personalizado.
 */
export function objectiveSummary(objective: Pick<JobObjective, "type" | "targetPosition" | "description">): string {
  switch (objective.type) {
    case JobObjectiveType.HOLD_PLACE:
      return "Mantener el lugar en la fila hasta que llegue el cliente.";
    case JobObjectiveType.AS_FRONT_AS_POSSIBLE:
      return "Quedar lo más adelante posible en la fila.";
    case JobObjectiveType.WITHIN_FIRST_N:
      return `Quedar dentro de los primeros ${objective.targetPosition ?? "—"} de la fila.`;
    case JobObjectiveType.COMPLETE_ERRAND:
      return objective.description ?? "Completar la gestión encargada.";
    default:
      return objective.description ?? "Objetivo personalizado.";
  }
}
