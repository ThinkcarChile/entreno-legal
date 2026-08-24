import type { MealTemplateVersion, TemplateStatus } from "./types";

/**
 * Versionado inmutable (§1, §6, K-21). Una versión publicada es historia: se
 * edita creando la siguiente, nunca reescribiendo la anterior. La base lo
 * refuerza con triggers; estas funciones evitan que la UI siquiera lo intente.
 */

export function canEditInPlace(status: TemplateStatus): boolean {
  return status === "DRAFT";
}

export function assertEditable(status: TemplateStatus): void {
  if (!canEditInPlace(status)) {
    throw new Error(
      status === "PUBLISHED"
        ? "Una versión publicada no se edita: crea una nueva versión."
        : "Una versión archivada no se edita.",
    );
  }
}

export function nextVersionNumber(existing: readonly { versionNumber: number }[]): number {
  return existing.reduce((max, v) => Math.max(max, v.versionNumber), 0) + 1;
}

/**
 * Proyecta el borrador que nacería al editar una versión publicada. Copia el
 * contenido y deja claro que la versión anterior queda intacta.
 */
export function draftFromVersion(
  version: MealTemplateVersion,
  existing: readonly { versionNumber: number }[],
): MealTemplateVersion {
  return {
    ...version,
    versionNumber: nextVersionNumber(existing),
    status: "DRAFT",
    slots: version.slots.map((s) => ({ ...s })),
    components: version.components.map((c) => ({
      ...c,
      nutrition: c.nutrition ? { ...c.nutrition, values: { ...c.nutrition.values } } : null,
    })),
    steps: version.steps.map((s) => ({ ...s })),
  };
}
