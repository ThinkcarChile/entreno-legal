import { UserRole } from "./enums";

import type { DisputeEvidence } from "./types";

/**
 * Pruebas de una disputa: lo que la pantalla necesita saber de cada una sin
 * recibir la ruta del archivo.
 */

/**
 * Qué archivo es, por la extensión de su ruta. La extensión la pone la
 * aplicación al subirlo a partir del tipo comprobado (`buildEvidencePath`),
 * nunca el nombre que traía el archivo, así que basta para elegir el icono.
 */
export function disputeFileKind(storagePath: string | null): DisputeEvidence["file"] {
  if (!storagePath) return null;
  return storagePath.toLowerCase().endsWith(".pdf") ? "pdf" : "image";
}

const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.CLIENT]: "Cliente",
  [UserRole.WORKER]: "Trabajador",
  [UserRole.ADMIN]: "Administración",
};

/** «Cliente · Paula C.», o solo el papel si el nombre no se puede leer. */
export function disputeEvidenceAuthor(
  evidence: Pick<DisputeEvidence, "authorRole" | "authorName">,
): string {
  const role = evidence.authorRole ? ROLE_LABELS[evidence.authorRole] : "Participante";
  return evidence.authorName ? `${role} · ${evidence.authorName}` : role;
}

/** «Sin pruebas», «1 prueba», «3 pruebas»; o que no se pudieron contar. */
export function disputeEvidenceCountLabel(count: number | null): string {
  if (count === null) return "No se pudieron contar las pruebas";
  if (count === 0) return "Sin pruebas aportadas";
  return count === 1 ? "1 prueba aportada" : `${count} pruebas aportadas`;
}
