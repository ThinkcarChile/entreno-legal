import type { ConfirmedObservation } from "./types";

/**
 * Tendencias DESCRIPTIVAS (§13): matemática simple sobre las últimas
 * mediciones, en lenguaje descriptivo. Jamás un diagnóstico: la pendiente de
 * cuatro puntos no dice nada sobre un órgano.
 *
 * Series con unidades incompatibles NO se mezclan (§12): sin conversión
 * validada, cada unidad es su propia serie.
 */

export interface BiomarkerSeries {
  /** null = unidad desconocida: su propia serie, jamás fusionada. */
  unit: string | null;
  points: { date: string; value: number; observationId: string }[];
  trend: "ASCENDENTE" | "DESCENDENTE" | "ESTABLE" | "SIN_TENDENCIA";
  /** Comparación con la medición anterior, descriptiva. */
  lastComparison: "MAYOR" | "MENOR" | "IGUAL" | null;
}

export function biomarkerSeries(
  observations: readonly ConfirmedObservation[],
  biomarkerCode: string,
  lastN = 4,
): BiomarkerSeries[] {
  const propias = observations.filter(
    (o) => o.biomarkerCode === biomarkerCode && o.collectedDate !== null,
  );
  const porUnidad = new Map<string | null, ConfirmedObservation[]>();
  for (const o of propias) {
    const arr = porUnidad.get(o.unit) ?? [];
    arr.push(o);
    porUnidad.set(o.unit, arr);
  }

  return [...porUnidad.entries()]
    .map(([unit, obs]) => {
      const points = obs
        .sort((a, b) => (a.collectedDate! < b.collectedDate! ? -1 : 1))
        .map((o) => ({ date: o.collectedDate!, value: o.value, observationId: o.id }));
      const ultimos = points.slice(-lastN);

      let trend: BiomarkerSeries["trend"] = "SIN_TENDENCIA";
      if (ultimos.length >= 3) {
        const subidas = ultimos.slice(1).filter((p, i) => p.value > ultimos[i]!.value).length;
        const bajadas = ultimos.slice(1).filter((p, i) => p.value < ultimos[i]!.value).length;
        trend =
          subidas === ultimos.length - 1
            ? "ASCENDENTE"
            : bajadas === ultimos.length - 1
              ? "DESCENDENTE"
              : "ESTABLE";
      }

      const [antepenultima, ultima] = points.slice(-2);
      const lastComparison: BiomarkerSeries["lastComparison"] =
        antepenultima && ultima && points.length >= 2
          ? ultima.value > antepenultima.value
            ? "MAYOR"
            : ultima.value < antepenultima.value
              ? "MENOR"
              : "IGUAL"
          : null;

      return { unit, points, trend, lastComparison };
    })
    .sort((a, b) => (a.unit ?? "~").localeCompare(b.unit ?? "~"));
}
