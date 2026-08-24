import type {
  ConsumptionRate,
  ForecastConfidence,
  ObservedConsumption,
  ShortfallStat,
  YieldEntry,
} from "./types";

/**
 * DemandForecastEngine (§12-§16) — determinista, sin IA, explicable.
 *
 * El consumo observado es el consumo DECLARADO (X): las porciones que la
 * familia registró como comidas, incluida la parte que la despensa no tenía
 * (shortfall). El consumo no trazado sigue siendo consumo (§7) — se separa
 * trazado/no-trazado solo para auditoría y confianza, nunca para achicar X.
 */

export const FORECAST_ENGINE_VERSION = "demand-forecast/1.0.0";

/** Días entre dos fechas DATE-only (positivo si `hasta` es después). */
export function diasEntre(desde: string, hasta: string): number {
  const [y1, m1, d1] = desde.split("-").map(Number);
  const [y2, m2, d2] = hasta.split("-").map(Number);
  return Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000);
}

/**
 * Convierte una cantidad declarada a la base del BUCKET, solo con conversión
 * explícita. Misma base = directo; COCIDO→CRUDO con rendimiento (el del hogar
 * le gana al global, el del método al genérico); todo lo demás = null.
 * UNKNOWN nunca es 1:1.
 */
export function toBucketQuantity(
  quantity: number,
  weightBasis: string,
  bucketBasis: string,
  cookingMethod: string | null,
  ingredientId: string,
  yields: readonly YieldEntry[],
): number | null {
  if (weightBasis === bucketBasis) return quantity;
  if (bucketBasis === "RAW" && weightBasis === "COOKED") {
    const factor = yieldFactorFor(ingredientId, cookingMethod, yields);
    if (factor === null || factor <= 0) return null;
    return quantity / factor;
  }
  return null;
}

/** Prioridad: hogar+método > global+método > hogar genérico > global genérico. */
export function yieldFactorFor(
  ingredientId: string,
  cookingMethod: string | null,
  yields: readonly YieldEntry[],
): number | null {
  const propios = yields.filter(
    (y) =>
      y.ingredientId === ingredientId &&
      (y.cookingMethod === null || (cookingMethod !== null && y.cookingMethod === cookingMethod)),
  );
  if (propios.length === 0) return null;
  const score = (y: YieldEntry) =>
    (y.cookingMethod !== null ? 2 : 0) + (y.isHousehold ? 1 : 0);
  const mejor = [...propios].sort((a, b) => score(b) - score(a))[0]!;
  return mejor.factor;
}

/** Compatibilidad: a base cruda (el bucket más común). */
export function toRawQuantity(
  quantity: number,
  weightBasis: string,
  cookingMethod: string | null,
  ingredientId: string,
  yields: readonly YieldEntry[],
): number | null {
  return toBucketQuantity(quantity, weightBasis, "RAW", cookingMethod, ingredientId, yields);
}

interface RateInput {
  today: string;
  ingredientId: string;
  unit: string;
  /** Base del bucket: la tasa se expresa en ESTA base. */
  bucketBasis: string;
  consumption: readonly ObservedConsumption[];
  shortfalls: readonly ShortfallStat[];
  yields: readonly YieldEntry[];
}

/**
 * Consumo observado por ventanas de 7/14/30 días, en base cruda.
 *
 * Devuelve también cuánta demanda declarada NO pudo convertirse a base cruda
 * (sin rendimiento): esa cantidad no infla la tasa — degrada la confianza.
 */
export function consumptionRate(input: RateInput): ConsumptionRate & { unresolvedDeclared: number } {
  const propios = input.consumption.filter(
    (c) => c.ingredientId === input.ingredientId && c.unit === input.unit,
  );

  // Serie diaria en base cruda; lo inconvertible se acumula aparte.
  const porDia = new Map<string, number>();
  let unresolved = 0;
  for (const c of propios) {
    const edad = diasEntre(c.date, input.today);
    if (edad < 0 || edad >= 30) continue;
    const enBase = toBucketQuantity(
      c.quantity,
      c.weightBasis,
      input.bucketBasis,
      c.cookingMethod,
      c.ingredientId,
      input.yields,
    );
    if (enBase === null) {
      unresolved += c.quantity;
      continue;
    }
    porDia.set(c.date, (porDia.get(c.date) ?? 0) + enBase);
  }

  const fechas = [...porDia.keys()].sort();
  const observations = fechas.length;

  const enVentana = (dias: number) =>
    [...porDia.entries()]
      .filter(([fecha]) => diasEntre(fecha, input.today) < dias)
      .reduce((acc, [, q]) => acc + q, 0);

  const total7 = enVentana(7);
  const total14 = enVentana(14);
  const total30 = enVentana(30);

  // Historia válida: desde la primera observación hasta hoy, tope 30 días.
  const historyDays =
    observations === 0 ? 0 : Math.min(30, diasEntre(fechas[0]!, input.today) + 1);

  // Ventana elegida: la más larga que la historia realmente respalda. La más
  // larga no siempre es mejor (§13): con 8 días de historia, promediar sobre
  // 30 diluiría el consumo real a un tercio.
  // §14: una o dos observaciones no son un hábito. Sin al menos 3 consumos,
  // no se fabrica tasa (el plan confirmado sigue mandando por su lado): un
  // alimento comido UNA vez hace 3 días no "se consume a 170 g/día".
  let dailyRate: number | null = null;
  let rateWindow: 7 | 14 | 30 | null = null;
  if (observations < 3) {
    // sin tasa
  } else if (historyDays >= 21) {
    rateWindow = 30;
    dailyRate = total30 / Math.min(30, historyDays);
  } else if (historyDays >= 10) {
    rateWindow = 14;
    dailyRate = total14 / Math.min(14, historyDays);
  } else if (historyDays >= 4) {
    rateWindow = 7;
    dailyRate = total7 / Math.min(7, historyDays);
  }

  // Variabilidad (§16): coeficiente de variación sobre cubetas de 7 días.
  // Simple y explicable — no necesitamos ML para decir "tu consumo salta".
  let variability: ConsumptionRate["variability"] = "UNKNOWN";
  if (historyDays >= 14) {
    const cubetas: number[] = [];
    const nCubetas = Math.min(4, Math.floor(historyDays / 7));
    for (let b = 0; b < nCubetas; b += 1) {
      let suma = 0;
      for (const [fecha, q] of porDia.entries()) {
        const edad = diasEntre(fecha, input.today);
        if (edad >= b * 7 && edad < (b + 1) * 7) suma += q;
      }
      cubetas.push(suma);
    }
    const media = cubetas.reduce((a, b) => a + b, 0) / cubetas.length;
    if (media > 0) {
      const varianza =
        cubetas.reduce((acc, x) => acc + (x - media) ** 2, 0) / cubetas.length;
      const cv = Math.sqrt(varianza) / media;
      variability = cv > 0.5 ? "HIGH" : cv > 0.25 ? "MEDIUM" : "LOW";
    }
  }

  // Trazado vs no trazado (§7): el shortfall ES consumo, pero se audita aparte.
  // Se convierte a la base del bucket con la MISMA regla que todo lo demás; un
  // shortfall inconvertible no se resta de un total en otra base — degrada.
  let untracked30 = 0;
  for (const sf of input.shortfalls) {
    if (sf.ingredientId !== input.ingredientId || sf.unit !== input.unit) continue;
    if (sf.date === null) continue;
    const edad = diasEntre(sf.date, input.today);
    if (edad < 0 || edad >= 30) continue;
    const enBase = toBucketQuantity(
      sf.quantity,
      sf.weightBasis,
      input.bucketBasis,
      null,
      sf.ingredientId,
      input.yields,
    );
    if (enBase === null) unresolved += sf.quantity;
    else untracked30 += enBase;
  }

  return {
    last7: historyDays >= 4 ? redondear(total7) : null,
    last14: historyDays >= 10 ? redondear(total14) : null,
    last30: historyDays >= 21 ? redondear(total30) : null,
    dailyRate: dailyRate === null ? null : redondear(dailyRate),
    rateWindow,
    historyDays,
    observations,
    variability,
    tracedTotal30: redondear(Math.max(0, total30 - untracked30)),
    untrackedTotal30: redondear(untracked30),
    unresolvedDeclared: redondear(unresolved),
  };
}

/**
 * Confianza del pronóstico (§15): calidad de datos, determinista, en escalera.
 * No es un "health score" — cada degradación tiene su razón.
 */
export function forecastConfidence(input: {
  rate: ConsumptionRate;
  shortfallRatio: number;
  hasApproximateStock: boolean;
  hasUnresolvedUnits: boolean;
}): { confidence: ForecastConfidence | null; reasons: string[] } {
  const { rate } = input;
  const reasons: string[] = [];

  if (rate.observations === 0) {
    return { confidence: null, reasons: ["Sin consumo registrado todavía."] };
  }

  let nivel: 0 | 1 | 2 = 2; // HIGH
  const bajar = (razon: string) => {
    nivel = Math.max(0, nivel - 1) as 0 | 1 | 2;
    reasons.push(razon);
  };

  if (rate.historyDays < 7 || rate.observations < 3) {
    nivel = 0;
    reasons.push(
      "Tenemos pocos datos. Esta recomendación se basa principalmente en tu planificación confirmada.",
    );
  } else {
    if (rate.historyDays < 21) bajar(`Solo ${rate.historyDays} días de historia válida.`);
    if (rate.variability === "HIGH") bajar("Tu consumo reciente ha sido variable.");
    if (input.shortfallRatio > 0.2) {
      bajar("Una parte importante del consumo no estaba trazada en la despensa.");
    }
    if (input.hasApproximateStock) bajar("Parte del stock está registrado como aproximado.");
    if (input.hasUnresolvedUnits) {
      bajar("Hay cantidades en unidades o bases que no se pudieron convertir.");
    }
  }

  return { confidence: (["LOW", "MEDIUM", "HIGH"] as const)[nivel], reasons };
}

function redondear(n: number): number {
  return Math.round(n * 1000) / 1000;
}
