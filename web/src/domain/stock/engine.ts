import { fefoOrder } from "../inventory/fefo";
import {
  consumptionRate,
  diasEntre,
  FORECAST_ENGINE_VERSION,
  forecastConfidence,
  toBucketQuantity,
} from "./forecast";
import type {
  CoverageStatus,
  FutureDemand,
  HorizonNeed,
  ReorderRecommendation,
  ReorderStatus,
  StockInput,
  StockItem,
  StockLot,
  StockTarget,
} from "./types";

/**
 * Stock Intelligence (Sprint 8) — disponibilidad, reservas lógicas, cobertura
 * y ReorderEngine. Determinista de punta a punta: mismos inputs, misma salida.
 *
 * Principios que no se negocian:
 *  - **No doble conteo** (§2): consumo pasado, demanda confirmada futura y
 *    forecast son tres fuentes; la confirmada GANA sobre el forecast en el
 *    intervalo que cubre la planificación.
 *  - **Reservas lógicas** (§3-§5): una comida confirmada compromete stock por
 *    identidad física compatible; FEFO elige el lote recién al consumir. Los
 *    lotes no se tocan.
 *  - **Bases físicas** (§6): la única conversión es explícita (rendimiento).
 *    g≠ml, g≠UNIT, cocido≠crudo sin factor. UNKNOWN ≠ ZERO → UNRESOLVED con
 *    razón, jamás un promedio inventado.
 */

export const REORDER_ENGINE_VERSION = "reorder-engine/1.0.0";

/** Horizonte por defecto cuando el hogar no declaró objetivo (documentado). */
const DEFAULT_HORIZON_DAYS = 7;

const REVIEW_CYCLE_DAYS: Record<string, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 30,
};

export function analyzeStock(input: StockInput): StockItem[] {
  const metaPorId = new Map(input.ingredients.map((i) => [i.id, i]));
  const targetPorId = new Map(input.targets.map((t) => [t.ingredientId, t]));

  // Identidades presentes: por stock usable O por demanda futura (§40). La
  // identidad incluye la BASE FÍSICA del bucket: el atún escurrido y el crudo
  // son cosas distintas y jamás se suman (§6). La demanda RAW/COOKED vive en
  // el bucket crudo (lo cocido se convierte con rendimiento o queda sin
  // resolver); la demanda DRAINED vive en el bucket escurrido.
  const identidades = new Map<
    string,
    { ingredientId: string; unit: StockItem["unit"]; basis: StockItem["weightBasis"] }
  >();
  const bucketDeLote = (b: string) =>
    (b === "COOKED" ? "COOKED" : b === "DRAINED" ? "DRAINED" : "RAW") as StockItem["weightBasis"];
  const bucketDeDemanda = (b: string) =>
    (b === "DRAINED" ? "DRAINED" : "RAW") as StockItem["weightBasis"];
  const claveDe = (ingredientId: string, unit: string, basis: string) =>
    `${ingredientId}::${unit}::${basis}`;
  for (const lot of input.lots) {
    if (lot.status === "AVAILABLE" && lot.quantity > 0) {
      const basis = bucketDeLote(lot.weightBasis);
      identidades.set(claveDe(lot.ingredientId, lot.unit, basis), {
        ingredientId: lot.ingredientId,
        unit: lot.unit,
        basis,
      });
    }
  }
  for (const d of input.futureDemand) {
    const basis = bucketDeDemanda(d.weightBasis);
    identidades.set(claveDe(d.ingredientId, d.unit, basis), {
      ingredientId: d.ingredientId,
      unit: d.unit,
      basis,
    });
  }

  const items: StockItem[] = [];

  for (const { ingredientId, unit, basis } of identidades.values()) {
    const meta = metaPorId.get(ingredientId);
    // §8: el objetivo aplica solo si habla en la MISMA unidad que este bucket —
    // un mínimo declarado en unidades no se compara con gramos.
    const targetCrudo = targetPorId.get(ingredientId) ?? null;
    const target = targetCrudo && targetCrudo.unit === unit ? targetCrudo : null;

    // ---- Stock físico usable del bucket (§21) ----
    const lotesPropios = input.lots.filter(
      (l) =>
        l.ingredientId === ingredientId && l.unit === unit && bucketDeLote(l.weightBasis) === basis,
    );
    const usables = lotesPropios.filter((l) => lotUsable(l, input.today));
    const onHand = redondear(usables.reduce((acc, l) => acc + l.quantity, 0));
    const hasApproximate = usables.some((l) => l.isApproximate);

    // ---- Reservas lógicas de demanda confirmada futura (§4, §6) ----
    let reserved = 0;
    const unresolvedDemand: StockItem["unresolvedDemand"] = [];
    const demandas = input.futureDemand.filter(
      (d) =>
        d.ingredientId === ingredientId &&
        d.unit === unit &&
        bucketDeDemanda(d.weightBasis) === basis,
    );
    for (const d of demandas) {
      const raw = toBucketQuantity(
        d.quantity,
        d.weightBasis,
        basis,
        d.cookingMethod,
        ingredientId,
        input.yields,
      );
      if (raw === null) {
        unresolvedDemand.push({
          quantity: d.quantity,
          unit: d.unit,
          weightBasis: d.weightBasis,
          reason:
            d.weightBasis === "COOKED"
              ? `No hay rendimiento crudo→cocido para convertir ${d.quantity} ${unidadCorta(unit)} cocidos.`
              : `La base ${d.weightBasis} no tiene conversión declarada a crudo.`,
        });
      } else {
        reserved += raw;
      }
    }
    reserved = redondear(reserved);
    const available = redondear(onHand - reserved);
    const confirmedShortage = available < 0 ? redondear(-available) : 0;

    // ---- Consumo observado (§12, §13) ----
    const rate = consumptionRate({
      today: input.today,
      ingredientId,
      unit,
      bucketBasis: basis,
      consumption: input.consumption,
      shortfalls: input.shortfalls,
      yields: input.yields,
    });

    const shortfallRatio =
      rate.tracedTotal30 + rate.untrackedTotal30 > 0
        ? rate.untrackedTotal30 / (rate.tracedTotal30 + rate.untrackedTotal30)
        : 0;
    const hasUnresolvedUnits = rate.unresolvedDeclared > 0 || unresolvedDemand.length > 0;
    const { confidence, reasons: confidenceReasons } = forecastConfidence({
      rate,
      shortfallRatio,
      hasApproximateStock: hasApproximate,
      hasUnresolvedUnits,
    });

    // ---- Horizontes: confirmado + forecast SOLO en días no cubiertos (§17) ----
    const horizons = ([7, 14, 30] as const).map((dias) =>
      horizonNeed(dias, input.today, demandas, input, ingredientId, basis, rate.dailyRate),
    );

    // ---- Cobertura (§11) ----
    const coverage = coverageOf({
      available,
      dailyRate: rate.dailyRate,
      historyDays: rate.historyDays,
      observations: rate.observations,
      unresolvedDemand: unresolvedDemand.length > 0,
      confirmedShortage,
    });

    // ---- Merma y sobrecompra (§25, §26, §43) ----
    const enVentana = (fecha: string) => {
      const edad = diasEntre(fecha, input.today);
      return edad >= 0 && edad < 30; // una fecha futura no es historia
    };
    const mermasPropias = input.waste.filter(
      (w) => w.ingredientId === ingredientId && w.unit === unit && enVentana(w.date),
    );
    const waste30 = redondear(mermasPropias.reduce((acc, w) => acc + w.quantity, 0));
    // §26: el costo se muestra solo cuando se puede calcular ENTERO. Una suma
    // parcial junto a la cantidad total de merma sería un número que miente.
    const wasteCost30 =
      mermasPropias.length > 0 && mermasPropias.every((w) => w.estimatedCost !== null)
        ? redondear(mermasPropias.reduce((acc, w) => acc + (w.estimatedCost ?? 0), 0))
        : null;
    const purchases30 = redondear(
      input.purchases
        .filter((p) => p.ingredientId === ingredientId && p.unit === unit && enVentana(p.date))
        .reduce((acc, p) => acc + p.quantity, 0),
    );
    const consumo30 = rate.tracedTotal30 + rate.untrackedTotal30;
    // Señal, no corrección automática: compra > consumo Y merma repetida.
    const overbuySignal =
      purchases30 > 0 && waste30 > 0 && purchases30 > consumo30 * 1.2 && waste30 >= purchases30 * 0.15;

    // ---- FEFO / usar primero (§22, §47) ----
    const conFecha = usables.filter((l) => l.useBy !== null || l.expiryDate !== null);
    const primero = conFecha.length > 0 ? fefoOrder(conFecha)[0]! : null;

    // ---- ReorderEngine (§18, §19) ----
    const reorder = recommendReorder({
      unit,
      available,
      onHand,
      confirmedShortage,
      horizons,
      target,
      dailyRate: rate.dailyRate,
      confidence,
      unresolved: unresolvedDemand.length > 0,
      historyDays: rate.historyDays,
    });

    items.push({
      ingredientId,
      label: meta?.label ?? lotesPropios[0]?.label ?? demandas[0]?.label ?? "Alimento",
      categoryCode: meta?.categoryCode ?? null,
      unit,
      weightBasis: basis,
      onHand,
      hasApproximate,
      reserved,
      available,
      confirmedShortage,
      unresolvedDemand,
      rate,
      coverage,
      confidence,
      confidenceReasons,
      horizons,
      reorder,
      target,
      useFirstLotId: primero?.id ?? null,
      useFirstLotLabel: primero?.label ?? null,
      waste30,
      wasteCost30,
      purchases30,
      overbuySignal,
      lots: usables,
    });
  }

  // Orden estable: primero lo urgente.
  const orden: ReorderStatus[] = ["REORDER_NOW", "REORDER_SOON", "WATCH", "UNRESOLVED", "NO_ACTION"];
  return items.sort((a, b) => {
    const oa = orden.indexOf(a.reorder.status);
    const ob = orden.indexOf(b.reorder.status);
    if (oa !== ob) return oa - ob;
    return (
      a.label.localeCompare(b.label, "es") ||
      `${a.ingredientId}${a.unit}${a.weightBasis}`.localeCompare(
        `${b.ingredientId}${b.unit}${b.weightBasis}`,
      )
    );
  });
}

/** ¿Este lote cuenta como stock usable? (§21, §48) */
export function lotUsable(lot: StockLot, today: string): boolean {
  if (lot.status !== "AVAILABLE" || lot.quantity <= 0) return false;
  // Regla segura de expiración: solo con fecha declarada y ya pasada.
  const limite = lot.useBy ?? lot.expiryDate;
  if (limite !== null && limite < today) return false;
  return true;
}

/**
 * Demanda del horizonte (§17): confirmada dentro del horizonte + forecast
 * SOLO para los días del horizonte NO cubiertos por planificación confirmada.
 */
function horizonNeed(
  dias: 7 | 14 | 30,
  today: string,
  demandas: readonly FutureDemand[],
  input: StockInput,
  ingredientId: string,
  bucketBasis: string,
  dailyRate: number | null,
): HorizonNeed {
  let confirmed = 0;
  for (const d of demandas) {
    const offset = diasEntre(today, d.servingDate);
    if (offset >= 0 && offset < dias) {
      const raw = toBucketQuantity(
        d.quantity,
        d.weightBasis,
        bucketBasis,
        d.cookingMethod,
        ingredientId,
        input.yields,
      );
      if (raw !== null) confirmed += raw;
    }
  }

  // Días del horizonte cubiertos por la planificación del hogar: ahí el
  // forecast NO entra — lo confirmado gana (§2). Martes y jueves confirmados
  // no reciben ADEMÁS pollo estadístico.
  let diasCubiertos = 0;
  if (input.planningCoveredUntil !== null) {
    const cobertura = diasEntre(today, input.planningCoveredUntil) + 1;
    diasCubiertos = Math.max(0, Math.min(dias, cobertura));
  }
  const diasSinCubrir = dias - diasCubiertos;
  const forecastUncovered = dailyRate !== null ? redondear(dailyRate * diasSinCubrir) : 0;

  return {
    days: dias,
    confirmed: redondear(confirmed),
    forecastUncovered,
    total: redondear(confirmed + forecastUncovered),
  };
}

function coverageOf(input: {
  available: number;
  dailyRate: number | null;
  historyDays: number;
  observations: number;
  unresolvedDemand: boolean;
  confirmedShortage: number;
}): CoverageStatus {
  if (input.unresolvedDemand) {
    return {
      kind: "UNRESOLVED",
      reason: "Hay demanda en una base o unidad que no se puede convertir sin inventar.",
    };
  }
  if (input.dailyRate === null) {
    // Jamás "∞ días" para esconder falta de datos (§11).
    return { kind: "INSUFFICIENT_DATA" };
  }
  if (input.dailyRate === 0) {
    return { kind: "NO_EXPECTED_DEMAND" };
  }
  const days = Math.max(0, input.available) / input.dailyRate;
  return { kind: "DAYS", days: Math.round(days * 10) / 10 };
}

/**
 * ReorderEngine (§18, §19): políticas claras, testeables, jamás negativas.
 * Recomienda; no compra.
 */
function recommendReorder(input: {
  unit: StockItem["unit"];
  available: number;
  onHand: number;
  confirmedShortage: number;
  horizons: HorizonNeed[];
  target: StockTarget | null;
  dailyRate: number | null;
  confidence: StockItem["confidence"];
  unresolved: boolean;
  historyDays: number;
}): ReorderRecommendation {
  const reasons: string[] = [];
  const base = {
    unit: input.unit,
    confidence: input.confidence,
    engineVersion: REORDER_ENGINE_VERSION,
    forecastVersion: FORECAST_ENGINE_VERSION,
  };

  // Reposición apagada por decisión del hogar (§8): se respeta.
  if (input.target && !input.target.reorderEnabled) {
    return {
      ...base,
      status: "NO_ACTION",
      recommendedQuantity: null,
      horizonDays: 0,
      reasons: ["Pediste no recibir recomendaciones de reposición para este alimento."],
    };
  }

  if (input.unresolved) {
    return {
      ...base,
      status: "UNRESOLVED",
      recommendedQuantity: null,
      horizonDays: 0,
      reasons: ["Hay demanda en una base o unidad sin conversión válida: no se puede recomendar sin inventar."],
    };
  }

  const horizonDays =
    input.target?.targetDaysOfSupply ??
    (input.target?.reviewCycle ? (REVIEW_CYCLE_DAYS[input.target.reviewCycle] ?? DEFAULT_HORIZON_DAYS) : DEFAULT_HORIZON_DAYS);
  const horizonte =
    input.horizons.find((h) => h.days >= horizonDays) ?? input.horizons[input.horizons.length - 1]!;

  // Necesidad del horizonte. Lo confirmado YA está descontado en `available`
  // (reservas lógicas): restarlo de nuevo sería doble conteo del propio motor.
  // necesidad = faltante confirmado + lo que el forecast pide por sobre lo libre.
  const safety = input.target?.safetyStock ?? 0;
  let necesidad =
    input.confirmedShortage +
    Math.max(0, horizonte.forecastUncovered + safety - Math.max(0, input.available));
  if (horizonte.confirmed > 0) {
    reasons.push(
      `Comidas confirmadas ya utilizan ${fmt(horizonte.confirmed, input.unit)} del horizonte de ${horizonDays} días.`,
    );
  }
  if (horizonte.forecastUncovered > 0) {
    reasons.push(
      `Consumo estimado para los días sin planificar: ${fmt(horizonte.forecastUncovered, input.unit)}.`,
    );
  }

  // Piso por mínimo declarado (§8): si lo libre cae bajo el mínimo, reponer
  // apunta al objetivo (o al mínimo si no hay objetivo).
  let bajoMinimo = false;
  if (input.target?.minimumQuantity != null && input.available < input.target.minimumQuantity) {
    bajoMinimo = true;
    const meta = input.target.targetQuantity ?? input.target.minimumQuantity;
    necesidad = Math.max(necesidad, meta - Math.max(0, input.available));
    reasons.push(
      `Quedas bajo tu mínimo declarado (${fmt(input.target.minimumQuantity, input.unit)}).`,
    );
  }

  // Objetivo de cantidad puro (§8): mantener la despensa cerca del objetivo.
  if (input.target?.targetQuantity != null && input.onHand < input.target.targetQuantity) {
    necesidad = Math.max(necesidad, input.target.targetQuantity - input.onHand);
    reasons.push(
      `Tu objetivo es mantener ${fmt(input.target.targetQuantity, input.unit)} en casa.`,
    );
  }

  const recommended = necesidad > 0.001 ? redondear(necesidad) : null;

  // Estado: del faltante confirmado hacia afuera.
  let status: ReorderStatus;
  if (input.confirmedShortage > 0) {
    status = "REORDER_NOW";
    reasons.unshift(
      `El plan confirmado necesita ${fmt(input.confirmedShortage, input.unit)} más de lo que hay libre.`,
    );
  } else if (bajoMinimo) {
    status = "REORDER_NOW";
  } else if (recommended !== null && input.dailyRate !== null && input.dailyRate > 0) {
    const diasLibres = Math.max(0, input.available) / input.dailyRate;
    if (diasLibres < 2) status = "REORDER_NOW";
    else if (diasLibres < horizonDays / 2) status = "REORDER_SOON";
    else status = "WATCH";
    reasons.push(`Lo libre cubre ~${Math.round(diasLibres * 10) / 10} días de tu consumo.`);
  } else if (recommended !== null) {
    // Sin historia: la recomendación nace SOLO del plan confirmado (§40).
    status = horizonte.confirmed > 0 ? "REORDER_SOON" : "WATCH";
    if (input.historyDays < 4) {
      reasons.push("Sin historia de consumo suficiente: esto sale de tu planificación confirmada.");
    }
  } else {
    status = "NO_ACTION";
    if (reasons.length === 0) reasons.push("El stock libre cubre el horizonte configurado.");
  }

  return {
    ...base,
    status,
    recommendedQuantity: recommended,
    horizonDays,
    reasons,
  };
}

function fmt(n: number, unit: string): string {
  if (unit === "UNIT") return `${Math.round(n)} u`;
  if (n >= 1000) return `${Math.round((n / 1000) * 100) / 100} ${unit === "G" ? "kg" : "L"}`;
  return `${Math.round(n * 10) / 10} ${unit === "G" ? "g" : "ml"}`;
}

function unidadCorta(unit: string): string {
  return unit === "G" ? "g" : unit === "ML" ? "ml" : "u";
}

function redondear(n: number): number {
  return Math.round(n * 1000) / 1000;
}
