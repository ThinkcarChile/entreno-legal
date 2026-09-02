import {
  UNKNOWN_REASON_PRECEDENCE,
  add,
  atLeastAmount,
  compare,
  known,
  money,
  mulDiv,
  subtract,
  sumPartial,
  sumStrict,
  unknown,
  zero,
  type CurrencyCode,
  type KnownSubtotal,
  type MissingValue,
  type Money,
  type MoneyEntry,
  type MoneyOrUnknown,
  type UnknownReason,
} from "./money";
import {
  CoverageBuilder,
  classify,
  coberturaSuficiente,
  milliDe,
  type Coverage,
  type CostConfidence,
  type CoverageThresholds,
  type Unit,
} from "./confidence";

/**
 * Sprint 14 — CÓMO VA EL MES.
 *
 * Motor puro, determinista y versionado. El «hoy» entra como parámetro
 * (`app.household_today`): el motor NO tiene reloj, así que un informe de julio
 * vuelve a dar lo mismo en septiembre.
 *
 * EL PRINCIPIO CONTABLE, ESCRITO EN LA FORMA DEL RESULTADO
 *
 *   CAJA = lo que salió del bolsillo. Se parte en lo que CAPITALIZÓ (entró a la
 *          despensa como valor) y lo que NO (despacho, propina, redondeo).
 *   CONSUMO ECONÓMICO = lo que efectivamente se comió, se botó o se perdió.
 *   VALOR ALMACENADO = lo que quedó guardado. Y acá está el arreglo grande:
 *
 *   [H12] CAJA − CONSUMO **NO** ES LA VARIACIÓN DEL VALOR ALMACENADO. La caja
 *         incluye el despacho, la propina y el cargo de redondeo, que por
 *         definición nunca entraron a la despensa. Restar el consumo a la caja
 *         completa infla la cifra insignia del sprint todos los meses por
 *         exactamente el monto del despacho. Acá `storedValueDelta` se calcula
 *         contra lo CAPITALIZADO, y el gasto no capitalizado tiene su propia
 *         fila a la vista.
 *
 *   [H7]  El valor almacenado se entrega también como SALDO, no sólo como
 *         variación. «Valor guardado en la despensa +$45.820» se lee como «mi
 *         despensa vale $45.820», y no era ni una cosa ni la otra. Ahora hay
 *         apertura, cierre y variación, y el motor VERIFICA que
 *         `apertura + capitalizado − salidas == cierre`; si no cuadra, el
 *         resultado sale con `STORED_VALUE_DOES_NOT_RECONCILE` en vez de un
 *         número tranquilizador.
 *
 *   [H2]  UN PRESUPUESTO NO DICE SOBRE QUÉ MIDE. El hogar que hace la compra
 *         grande del mes aparecía OVER sin haber consumido nada, y el que se
 *         come una despensa llena aparecía ON_TRACK liquidando $200.000 de
 *         inventario. Acá el presupuesto declara su `basis` (CAJA o CONSUMO
 *         ECONÓMICO) y cada uno tiene su propio semáforo. Si el hogar fijó los
 *         dos, se muestran los dos: jamás uno promediado.
 *
 *   [H24] NADA DE RATIOS EN `double`. `atRiskRatio: 0.85` contra un `bigint`
 *         obliga a un `Number(minor) * 0.85` y ahí entró la coma flotante al
 *         cálculo que decide el color del semáforo. Acá es `atRiskBps: 8500n` y
 *         se aplica con `mulDiv`.
 */

export const FINANCE_FORECAST_ENGINE_VERSION = "finance-forecast/1.0.0";

/**
 * ESPEJO EXACTO de `public.cost_category` (migración 0044).
 *
 * Está completo a propósito ([H9]): la versión del diseño cubría 4 de las
 * categorías y dejaba fuera `ADJUSTMENT_LOSS` y `CORRECTION`, con lo que el
 * valor almacenado quedaba sobreestimado por exactamente esas dos. El test
 * estructural de `forecast-engine.test.ts` compara esta lista contra el enum
 * del archivo SQL y se pone rojo si alguien agrega una categoría sin ubicarla
 * dentro del período.
 */
export const ACCRUAL_CATEGORIES = [
  "CONSUMED",
  "WASTED_AVOIDABLE",
  "WASTED_EXPECTED",
  "WASTED_THIRD_PARTY",
  "ADJUSTMENT_LOSS",
  "CORRECTION",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "NON_CAPITALIZED_EXPENSE",
] as const;

export type AccrualCategory = (typeof ACCRUAL_CATEGORIES)[number];

/**
 * Las categorías que SACAN valor de la despensa.
 *
 * `TRANSFER_OUT`/`TRANSFER_IN` quedan fuera porque se cancelan entre sí: cocinar
 * mueve valor de los lotes de ingredientes al lote de la comida, y contarlo como
 * salida sería declarar consumido lo que está entero en el refrigerador.
 * `NON_CAPITALIZED_EXPENSE` tampoco entra: el despacho nunca estuvo adentro.
 */
export const SALIDAS_DE_DESPENSA: readonly AccrualCategory[] = [
  "CONSUMED",
  "WASTED_AVOIDABLE",
  "WASTED_EXPECTED",
  "WASTED_THIRD_PARTY",
  "ADJUSTMENT_LOSS",
  "CORRECTION",
];

/** Las que suman al CONSUMO ECONÓMICO del período (salidas + gasto que no queda). */
export const CONSUMO_ECONOMICO: readonly AccrualCategory[] = [
  ...SALIDAS_DE_DESPENSA,
  "NON_CAPITALIZED_EXPENSE",
];

export type BudgetBasis = "CASH" | "ECONOMIC_CONSUMPTION";

export type BudgetState = "ON_TRACK" | "AT_RISK" | "OVER" | "NO_BUDGET" | "UNKNOWN_COVERAGE";

/**
 * CON QUÉ SE MIDE LA COBERTURA DE UNA CUBETA, declarado por quien la arma.
 *
 * Antes eran tres campos sueltos (`knownQuantityMilli`, `totalQuantityMilli`,
 * `unit`) y el cargador del panel los llenaba con la MISMA cantidad en los dos
 * lados y `unit: "G"` fijo, porque `cost_allocations` no guarda unidad ni parte
 * la cantidad por estado. Con eso `faltante = total − known` daba 0 siempre: la
 * cobertura salía KNOWN aunque no hubiera ni una asignación costeada, y el
 * semáforo se ponía verde sobre nada. No era un descuido del cargador: era la
 * forma del tipo, que pedía tres números que nadie tenía y no dejaba decir «no
 * los tengo».
 *
 * Ahora hay que ELEGIR, y las dos opciones son verdades distintas:
 *   - POR_CANTIDAD: sé la unidad y sé qué parte de la cantidad está costeada.
 *   - POR_CONTEO:   sólo sé cuántas asignaciones hay con costo y cuántas sin él.
 */
export type BucketCoverage =
  | {
      readonly kind: "POR_CANTIDAD";
      readonly unit: Unit;
      /** Cantidad física con costo conocido / total, en milésimas. */
      readonly knownQuantityMilli: bigint;
      readonly totalQuantityMilli: bigint;
    }
  | { readonly kind: "POR_CONTEO" };

export interface AccrualBucket {
  readonly category: AccrualCategory;
  /**
   * Subtotal de lo conocido. Es un `Money` y no un `MoneyOrUnknown` porque acá
   * el desconocido NO se colapsa: viaja al lado, en `unknownCount` y
   * `unknownReasons`, y nadie puede leer este campo sin verlos ([H22]).
   */
  readonly known: Money;
  /**
   * Cuántas asignaciones SÍ tenían costo. Distingue «todo conocido y suma $0»
   * de «no se pudo costear ni una»: sin este conteo, `known` = $0 se lee igual
   * en los dos casos y la pantalla pinta «−$0» sobre algo 100 % desconocido.
   */
  readonly knownCount: number;
  readonly unknownCount: number;
  readonly unknownReasons: readonly UnknownReason[];
  readonly coverage: BucketCoverage;
}

export interface CashSpendEntry {
  readonly purchaseId: string;
  readonly label: string;
  /** DATE-only del hogar; para una boleta importada, la fecha IMPRESA. */
  readonly purchasedOn: string;
  readonly total: MoneyOrUnknown;
  /** Lo que pasó a valer en la despensa. */
  readonly capitalized: MoneyOrUnknown;
  /**
   * Despacho, propina, redondeo: caja que NO es valor. `MoneyOrUnknown` y no
   * `Money` ([H22]): una boleta con la línea de despacho ilegible no tiene por
   * qué expresarse como cero pesos.
   */
  readonly expensedOnly: MoneyOrUnknown;
}

export interface PlannedLineInput {
  readonly lineKey: string;
  readonly label: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly estimate: MoneyOrUnknown;
  /** `null` cuando no hay estimación con qué medir antigüedad. */
  readonly estimateAgeDays: number | null;
}

export interface HouseholdBudget {
  readonly basis: BudgetBasis;
  readonly amount: Money;
  /** Copia del presupuesto VIGENTE en el período, no el de hoy. */
  readonly validFrom: string;
}

export interface FinanceForecastInput {
  readonly currency: CurrencyCode;
  /** `app.household_today`. El motor NO tiene reloj. */
  readonly today: string;
  readonly period: {
    readonly type: "WEEK" | "MONTH";
    readonly startsOn: string;
    readonly endsOn: string;
  };
  /** Cero, uno o los dos. Vacío = el hogar no fijó presupuesto. */
  readonly budgets: readonly HouseholdBudget[];
  readonly accruals: readonly AccrualBucket[];
  readonly cashSpend: readonly CashSpendEntry[];
  /** Lo que el plan del período pide y todavía no se compra. */
  readonly plannedLines: readonly PlannedLineInput[];
  /** Costo de PREPARAR el plan (incluye lo que ya está en la despensa) — [H11]. */
  readonly plannedConsumptionCost: MoneyOrUnknown;
  /** Saldo del valor de la despensa al abrir y al cerrar el período. */
  readonly openingPantryValue: MoneyOrUnknown;
  readonly closingPantryValue: MoneyOrUnknown;
  readonly lateRecognitions: {
    readonly count: number;
    readonly amount: MoneyOrUnknown;
    /** «$3.200 de agosto reconocidos en septiembre». */
    readonly occurredPeriods: readonly string[];
  };
  readonly thresholds: CoverageThresholds;
  /** Puntos base, `bigint`. 8500 = 85 %. JAMÁS 0.85. */
  readonly atRiskBps: bigint;
  /** Salidas del ledger que quedaron sin costear: se DECLARAN, no se omiten. */
  readonly uncostedOutflows: number;
  readonly staleAfterDays: number;
}

export type ForecastWarning =
  | { readonly code: "UNKNOWN_COVERAGE"; readonly bps: bigint | null; readonly missing: number }
  | { readonly code: "SHORTFALLS_NOT_COSTED"; readonly count: number }
  | { readonly code: "LATE_RECOGNITION"; readonly count: number }
  | { readonly code: "STALE_PRICES"; readonly count: number; readonly maxAgeDays: number }
  | { readonly code: "STORED_VALUE_DOES_NOT_RECONCILE"; readonly diferencia: MoneyOrUnknown };

export interface BudgetVerdict {
  readonly basis: BudgetBasis;
  readonly state: BudgetState;
  readonly budget: Money | null;
  /** Lo gastado/consumido CONOCIDO a la fecha, en el lado que corresponde. */
  readonly actualKnown: Money;
  readonly projectedTotal: MoneyOrUnknown;
  readonly headroom: MoneyOrUnknown;
  /** El texto nombra el lado: «de tu presupuesto de caja», nunca «de tu presupuesto». */
  readonly leyenda: string;
}

export interface FinanceForecastResult {
  readonly engineVersion: typeof FINANCE_FORECAST_ENGINE_VERSION;
  readonly currency: CurrencyCode;
  readonly confidence: CostConfidence;
  readonly coverage: Coverage;

  readonly cash: {
    readonly knownSubtotal: Money;
    readonly total: MoneyOrUnknown;
    readonly capitalized: MoneyOrUnknown;
    readonly expensedOnly: MoneyOrUnknown;
    readonly unknownEntries: number;
    readonly purchases: number;
  };

  /** `total` es EXACTAMENTE la suma de `byCategory`, o los dos son desconocidos. */
  readonly economicConsumption: {
    readonly knownSubtotal: Money;
    readonly total: MoneyOrUnknown;
    readonly byCategory: readonly AccrualBucket[];
  };

  /** El saldo, no sólo el flujo ([H7]). */
  readonly storedValue: {
    readonly openingBalance: MoneyOrUnknown;
    readonly capitalizedIn: MoneyOrUnknown;
    readonly pantryOutflow: MoneyOrUnknown;
    readonly closingBalance: MoneyOrUnknown;
    readonly delta: MoneyOrUnknown;
    readonly reconciles: boolean | null;
  };

  /** `capitalizado − salidas`. NUNCA `caja − consumo` ([H12]). */
  readonly storedValueDelta: MoneyOrUnknown;

  readonly projectedPurchase: {
    /** SIEMPRE «al menos», salvo cobertura KNOWN. */
    readonly subtotal: KnownSubtotal;
    readonly missingPrices: readonly MissingValue[];
    readonly total: MoneyOrUnknown;
    readonly stalePrices: readonly { readonly lineKey: string; readonly ageDays: number }[];
  };

  /** Cuesta preparar el plan, esté o no en la despensa ([H11]). */
  readonly plannedConsumptionCost: MoneyOrUnknown;

  readonly budgets: readonly BudgetVerdict[];
  readonly lateRecognitions: FinanceForecastInput["lateRecognitions"];
  readonly warnings: readonly ForecastWarning[];
}

function sumaDeCubetas(
  cubetas: readonly AccrualBucket[],
  categorias: readonly AccrualCategory[],
  currency: CurrencyCode,
): { conocido: Money; desconocidos: number; motivos: UnknownReason[] } {
  let conocido = zero(currency);
  let desconocidos = 0;
  const motivos: UnknownReason[] = [];
  for (const b of cubetas) {
    if (!categorias.includes(b.category)) continue;
    conocido = add(conocido, b.known);
    desconocidos += b.unknownCount;
    for (const r of b.unknownReasons) if (!motivos.includes(r)) motivos.push(r);
  }
  return { conocido, desconocidos, motivos };
}

/**
 * De varios motivos, el que sale en pantalla: el de MAYOR PRECEDENCIA, jamás el
 * primero que vino.
 *
 * `motivos[0]` hacía que la explicación dependiera del orden en que la base
 * devolvió las filas: el mismo mes, cargado dos veces, podía decir «no se pudo
 * repartir el costo» o «este lote entró sin boleta» según cómo saliera la
 * consulta. La precedencia vive declarada en `money.ts` justamente para que
 * reordenar los insumos no cambie la salida, y hasta acá no llegaba.
 */
function motivoQueSeMuestra(motivos: readonly UnknownReason[]): UnknownReason {
  for (const candidato of UNKNOWN_REASON_PRECEDENCE) {
    if (motivos.includes(candidato)) return candidato;
  }
  // Hay desconocidos y ninguno dijo por qué. Eso NO es «nunca se registró un
  // precio»: una causa inventada manda a la persona a arreglar lo que no está
  // roto. Es que no se sabe por qué no se sabe.
  return "POLICY_NOT_APPLICABLE";
}

function cerrar(
  conocido: Money,
  desconocidos: number,
  motivos: readonly UnknownReason[],
): MoneyOrUnknown {
  if (desconocidos === 0) return known(conocido);
  return unknown(motivoQueSeMuestra(motivos));
}

/** Resta que respeta el desconocido en los dos lados. */
function restar(a: MoneyOrUnknown, b: MoneyOrUnknown): MoneyOrUnknown {
  if (!a.known) return a;
  if (!b.known) return b;
  return known(subtract(a.amount, b.amount));
}

export function forecast(input: FinanceForecastInput): FinanceForecastResult {
  const { currency } = input;
  const warnings: ForecastWarning[] = [];

  // -------------------------------------------------------------------------
  // CAJA
  // -------------------------------------------------------------------------
  const cashTotal = sumStrict(
    input.cashSpend.map((e) => e.total),
    currency,
  );
  const capitalizado = sumStrict(
    input.cashSpend.map((e) => e.capitalized),
    currency,
  );
  const noCapitalizado = sumStrict(
    input.cashSpend.map((e) => e.expensedOnly),
    currency,
  );
  const cajaParcial = sumPartial(
    input.cashSpend.map((e) => ({ id: e.purchaseId, label: e.label, value: e.total })),
    currency,
  );

  // -------------------------------------------------------------------------
  // CONSUMO ECONÓMICO y SALIDAS DE DESPENSA
  // -------------------------------------------------------------------------
  const consumo = sumaDeCubetas(input.accruals, CONSUMO_ECONOMICO, currency);
  const salidas = sumaDeCubetas(input.accruals, SALIDAS_DE_DESPENSA, currency);
  const consumoTotal = cerrar(consumo.conocido, consumo.desconocidos, consumo.motivos);
  const salidasTotal = cerrar(salidas.conocido, salidas.desconocidos, salidas.motivos);

  // -------------------------------------------------------------------------
  // VALOR ALMACENADO: variación Y saldo, con el cuadre verificado
  // -------------------------------------------------------------------------
  const storedValueDelta = restar(capitalizado, salidasTotal);
  const cierreEsperado =
    input.openingPantryValue.known && storedValueDelta.known
      ? known(add(input.openingPantryValue.amount, storedValueDelta.amount))
      : unknown("LOT_VALUE_UNKNOWN");
  let reconciles: boolean | null = null;
  if (cierreEsperado.known && input.closingPantryValue.known) {
    reconciles = compare(cierreEsperado.amount, input.closingPantryValue.amount) === 0;
    if (!reconciles) {
      warnings.push({
        code: "STORED_VALUE_DOES_NOT_RECONCILE",
        diferencia: known(subtract(input.closingPantryValue.amount, cierreEsperado.amount)),
      });
    }
  }

  // -------------------------------------------------------------------------
  // COBERTURA: por dimensión, sobre las cantidades de las cubetas
  // -------------------------------------------------------------------------
  const cobertura = new CoverageBuilder();
  for (const b of input.accruals) {
    if (!CONSUMO_ECONOMICO.includes(b.category)) continue;
    if (b.coverage.kind === "POR_CONTEO") {
      cobertura.contarSinCantidad(b.knownCount, b.unknownCount);
      continue;
    }
    const c = b.coverage;
    if (c.totalQuantityMilli > 0n) {
      cobertura.agregar(c.unit, c.knownQuantityMilli, true);
      const faltante = c.totalQuantityMilli - c.knownQuantityMilli;
      if (faltante > 0n) cobertura.agregar(c.unit, faltante, false);
    } else if (b.unknownCount > 0) {
      cobertura.agregar(c.unit, null, false);
    }
  }
  for (const l of input.plannedLines) {
    cobertura.agregar(l.unit, milliDe(l.quantity), l.estimate.known);
  }
  const coverage = cobertura.construir();
  /**
   * Un período SIN consumo y SIN plan no es un período sin datos: es un período
   * sin nada que costear. `classify` devuelve `INSUFFICIENT_DATA` con la lista
   * vacía —que es lo correcto para una receta sin componentes— y acá eso dejaría
   * al hogar que sólo hizo una compra, con la boleta entera legible, en
   * `UNKNOWN_COVERAGE` para siempre. La condición se decide con la caja: si no
   * falta ni una compra por leer, no falta nada.
   */
  const confidence: CostConfidence =
    coverage.totalItems === 0
      ? cajaParcial.missing.length === 0
        ? "KNOWN"
        : "INSUFFICIENT_DATA"
      : classify(coverage, input.thresholds);

  // -------------------------------------------------------------------------
  // PROYECCIÓN DE LA COMPRA: «al menos», y NOMBRANDO lo que falta
  // -------------------------------------------------------------------------
  const frescas: MoneyEntry[] = [];
  const rancias: { lineKey: string; ageDays: number }[] = [];
  for (const l of input.plannedLines) {
    // Un precio rancio NO entra al «al menos»: estimar el mes con el precio del
    // aceite de hace cinco meses es estimar con ficción. Se declara aparte.
    if (l.estimateAgeDays !== null && l.estimateAgeDays > input.staleAfterDays) {
      rancias.push({ lineKey: l.lineKey, ageDays: l.estimateAgeDays });
      frescas.push({ id: l.lineKey, label: l.label, value: unknown("NO_PRICE_RECORDED") });
      continue;
    }
    frescas.push({ id: l.lineKey, label: l.label, value: l.estimate });
  }
  const proyeccion = sumPartial(frescas, currency);
  const proyeccionTotal: MoneyOrUnknown =
    proyeccion.missing.length === 0
      ? known(atLeastAmount(proyeccion.subtotal, proyeccion.missing))
      : unknown("NO_PRICE_RECORDED");

  // -------------------------------------------------------------------------
  // PRESUPUESTO: un veredicto POR BASE. Nunca uno promediado.
  // -------------------------------------------------------------------------
  const veredictos: BudgetVerdict[] = [];
  for (const basis of ["CASH", "ECONOMIC_CONSUMPTION"] as const) {
    const presupuesto = input.budgets.find((b) => b.basis === basis);
    const realKnown = basis === "CASH" ? cajaSubtotal(cajaParcial) : consumo.conocido;
    const faltantes = basis === "CASH" ? cajaParcial.missing.length : consumo.desconocidos;
    // Proyectar el mes = lo que ya pasó + lo que el plan todavía pide.
    const pendiente: MoneyOrUnknown =
      basis === "CASH" ? proyeccionTotal : input.plannedConsumptionCost;
    const real: MoneyOrUnknown =
      faltantes === 0 ? known(realKnown) : unknown("NO_PRICE_RECORDED");
    const proyectado: MoneyOrUnknown =
      real.known && pendiente.known
        ? known(add(real.amount, pendiente.amount))
        : unknown("NO_PRICE_RECORDED");
    veredictos.push(
      veredicto(basis, presupuesto, realKnown, proyectado, confidence, input.atRiskBps),
    );
  }

  // -------------------------------------------------------------------------
  // AVISOS
  // -------------------------------------------------------------------------
  if (!coberturaSuficiente(confidence)) {
    warnings.push({
      code: "UNKNOWN_COVERAGE",
      bps: null,
      missing: coverage.unknownItems + coverage.incomparableItems,
    });
  }
  if (input.uncostedOutflows > 0) {
    warnings.push({ code: "SHORTFALLS_NOT_COSTED", count: input.uncostedOutflows });
  }
  if (input.lateRecognitions.count > 0) {
    warnings.push({ code: "LATE_RECOGNITION", count: input.lateRecognitions.count });
  }
  if (rancias.length > 0) {
    let maxAgeDays = 0;
    for (const r of rancias) if (r.ageDays > maxAgeDays) maxAgeDays = r.ageDays;
    warnings.push({ code: "STALE_PRICES", count: rancias.length, maxAgeDays });
  }

  return {
    engineVersion: FINANCE_FORECAST_ENGINE_VERSION,
    currency,
    confidence,
    coverage,
    cash: {
      knownSubtotal: cajaSubtotal(cajaParcial),
      total: cashTotal,
      capitalized: capitalizado,
      expensedOnly: noCapitalizado,
      unknownEntries: cajaParcial.missing.length,
      purchases: input.cashSpend.length,
    },
    economicConsumption: {
      knownSubtotal: consumo.conocido,
      total: consumoTotal,
      byCategory: input.accruals.filter((b) => CONSUMO_ECONOMICO.includes(b.category)),
    },
    storedValue: {
      openingBalance: input.openingPantryValue,
      capitalizedIn: capitalizado,
      pantryOutflow: salidasTotal,
      closingBalance: input.closingPantryValue,
      delta: storedValueDelta,
      reconciles,
    },
    storedValueDelta,
    projectedPurchase: {
      subtotal: proyeccion.subtotal,
      missingPrices: proyeccion.missing,
      total: proyeccionTotal,
      stalePrices: rancias,
    },
    plannedConsumptionCost: input.plannedConsumptionCost,
    budgets: veredictos,
    lateRecognitions: input.lateRecognitions,
    warnings,
  };
}

function cajaSubtotal(suma: { subtotal: KnownSubtotal }): Money {
  return money(suma.subtotal.currency, suma.subtotal.minorAtLeast);
}

const LEYENDA: Readonly<Record<BudgetBasis, string>> = {
  CASH: "presupuesto de caja (lo que sale del bolsillo)",
  ECONOMIC_CONSUMPTION: "presupuesto de consumo (lo que efectivamente se come)",
};

/**
 * El semáforo, con la regla dura escrita entera:
 *
 *   - Sin fila vigente ⇒ `NO_BUDGET`. Nunca verde: «no fijaste presupuesto» no
 *     es «vas bien».
 *   - `OVER` se declara con lo CONOCIDO ya por encima del presupuesto, aunque
 *     falten datos: si ya gastaste más que el presupuesto sólo con lo conocido,
 *     gastaste más, punto. Es la única verdad que sobrevive a la mala cobertura.
 *   - Con cobertura PARTIAL o INSUFFICIENT_DATA el estado es `UNKNOWN_COVERAGE`:
 *     un estado propio, ni verde ni rojo. Un semáforo verde calculado sobre la
 *     mitad de los precios le da permiso a la persona para gastar sobre una base
 *     falsa, y eso es peor que no tener semáforo.
 *   - `headroom` es DESCONOCIDO cuando la proyección lo es. No se resta un «al
 *     menos» de un presupuesto y se presenta como holgura.
 */
function veredicto(
  basis: BudgetBasis,
  presupuesto: HouseholdBudget | undefined,
  realKnown: Money,
  proyectado: MoneyOrUnknown,
  confidence: CostConfidence,
  atRiskBps: bigint,
): BudgetVerdict {
  if (presupuesto === undefined) {
    return {
      basis,
      state: "NO_BUDGET",
      budget: null,
      actualKnown: realKnown,
      projectedTotal: proyectado,
      headroom: unknown("POLICY_NOT_APPLICABLE"),
      leyenda: `No fijaste ${LEYENDA[basis]} para este período.`,
    };
  }

  const headroom: MoneyOrUnknown = proyectado.known
    ? known(subtract(presupuesto.amount, proyectado.amount))
    : proyectado;

  // OVER primero: es cierto aunque la cobertura sea mala.
  if (compare(realKnown, presupuesto.amount) > 0) {
    return {
      basis,
      state: "OVER",
      budget: presupuesto.amount,
      actualKnown: realKnown,
      projectedTotal: proyectado,
      headroom,
      leyenda: `Ya pasaste tu ${LEYENDA[basis]}, contando sólo lo que sabemos.`,
    };
  }

  if (!coberturaSuficiente(confidence)) {
    return {
      basis,
      state: "UNKNOWN_COVERAGE",
      budget: presupuesto.amount,
      actualKnown: realKnown,
      projectedTotal: proyectado,
      headroom: unknown("NO_PRICE_RECORDED"),
      leyenda: `No podemos decirte cómo vas con tu ${LEYENDA[basis]}: faltan precios.`,
    };
  }

  if (!proyectado.known) {
    return {
      basis,
      state: "UNKNOWN_COVERAGE",
      budget: presupuesto.amount,
      actualKnown: realKnown,
      projectedTotal: proyectado,
      headroom,
      leyenda: `No podemos proyectar tu ${LEYENDA[basis]}: faltan precios del plan.`,
    };
  }

  const umbral = mulDiv(presupuesto.amount, atRiskBps, 10000n);
  if (compare(proyectado.amount, presupuesto.amount) > 0) {
    return {
      basis,
      state: "OVER",
      budget: presupuesto.amount,
      actualKnown: realKnown,
      projectedTotal: proyectado,
      headroom,
      leyenda: `La proyección supera tu ${LEYENDA[basis]}.`,
    };
  }
  if (compare(proyectado.amount, umbral) >= 0) {
    return {
      basis,
      state: "AT_RISK",
      budget: presupuesto.amount,
      actualKnown: realKnown,
      projectedTotal: proyectado,
      headroom,
      leyenda: `Vas apretado con tu ${LEYENDA[basis]}.`,
    };
  }
  return {
    basis,
    state: "ON_TRACK",
    budget: presupuesto.amount,
    actualKnown: realKnown,
    projectedTotal: proyectado,
    headroom,
    leyenda: `Vas bien con tu ${LEYENDA[basis]}.`,
  };
}
