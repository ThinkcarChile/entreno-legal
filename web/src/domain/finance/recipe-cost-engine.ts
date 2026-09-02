import {
  atLeastAmount,
  known,
  money,
  mulDiv,
  sumPartial,
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
  UMBRALES_POR_DEFECTO,
  classify,
  milliDe,
  mulDivHalfEven,
  type Coverage,
  type CostConfidence,
  type CoverageThresholds,
  type Unit,
} from "./confidence";

/**
 * Sprint 14 — CUÁNTO CUESTA COCINAR ESTO.
 *
 * Motor puro, determinista y versionado: sin reloj (el «hoy» ya viene cocinado
 * en `staleDays`), sin red, sin base. Mismos insumos, misma salida, siempre.
 *
 * LAS DOS REGLAS QUE LE DAN SENTIDO
 *
 *  1. «YA LO TENGO» NO SIGNIFICA «ES GRATIS». Lo que está en la despensa SUMA
 *     al costo de preparar y NO suma a lo que hay que comprar. Son dos cifras
 *     distintas y las dos salen de acá ([H11]): sin eso, el mismo plan parece
 *     barato con la despensa llena y caro con la despensa vacía, aunque la
 *     familia coma exactamente lo mismo.
 *
 *  2. NO SE REVALORIZA LA DESPENSA A PRECIO DE MERCADO ([H8]). El diseño tenía
 *     un `valuationOrder = [LOT_ACTUAL, LAST_PURCHASE, PRICE_OBSERVATION]` que
 *     no distinguía «no hay lote» de «hay lote y su valor es desconocido»: en
 *     el segundo caso caía a un precio de vitrina y ese monto terminaba dentro
 *     de `fromPantry`, o sea inventario histórico mostrado a precio de hoy. Con
 *     la inflación de alimentos en Chile, el «ahorro» del hogar habría sido un
 *     artefacto del IPC. Acá la política está PARTIDA EN DOS Y EL TIPO LO HACE
 *     IMPOSIBLE DE MEZCLAR: si el componente sale de un lote, su única
 *     valorización posible es el costo de ESE lote; si el lote no tiene valor,
 *     la línea queda DESCONOCIDA, jamás estimada. Las estimaciones de mercado
 *     solo valorizan lo que hay que SALIR A COMPRAR, que es caja futura y ahí sí
 *     corresponde el precio de hoy.
 *
 * Y la línea roja clínica: este motor NO ELIGE INGREDIENTES. No tiene ninguna
 * salida de tipo «esta receta te sale más barata». Recibe el costo como dato y
 * lo devuelve como dato. Las finanzas nunca pasan por encima del motor clínico
 * ni de la seguridad alimentaria.
 */

export const RECIPE_COST_ENGINE_VERSION = "recipe-cost/1.0.0";

export type WeightBasis = "RAW" | "COOKED" | "DRAINED" | "EDIBLE_PORTION" | "AS_PACKAGED";

/** De dónde salió el número. */
export type ValuationSource = "LOT_ACTUAL" | "LAST_PURCHASE" | "PRICE_OBSERVATION";

/**
 * QUÉ CLASE de número es. Es la distinción que impide revalorizar la despensa:
 * `fromPantry` suma EXCLUSIVAMENTE líneas `HISTORICAL_COST`.
 */
export type ValuationKind = "HISTORICAL_COST" | "MARKET_ESTIMATE";

/**
 * Conversión de base física como FRACCIÓN EXACTA, no como `number`.
 *
 * Un factor 0.7 en `double` multiplicado contra un `bigint` obliga a un
 * `Number(minor) * 0.7` — la coma flotante entrando por la puerta de servicio
 * al cálculo de un monto ([H24]). Como fracción, `mulDiv` la aplica con
 * redondeo bancario y sin salir de los enteros.
 *
 * `null` NO existe acá: la ausencia de factor se representa NO trayendo el
 * campo, y entonces la línea queda desconocida. Jamás un 1:1 implícito.
 */
export interface BasisConversion {
  readonly num: bigint;
  readonly den: bigint;
}

/** El lote de la despensa que cubre este componente. Única fuente de costo histórico. */
export interface PantryLotValuation {
  readonly lotId: string;
  /** Valor que le queda al lote. DESCONOCIDO si entró sin boleta: no hay fallback. */
  readonly remaining: MoneyOrUnknown;
  /** Cantidad que le queda, en la unidad y base del lote. */
  readonly remainingQuantity: number;
  readonly unit: Unit;
  readonly weightBasis: WeightBasis;
}

/** Una estimación de mercado, para lo que hay que ir a comprar. */
export interface MarketEstimate {
  readonly source: Exclude<ValuationSource, "LOT_ACTUAL">;
  readonly referenceId: string;
  /** DATE-only del hogar. */
  readonly observedOn: string;
  /**
   * Precio NORMALIZADO en unidades menores: por KILO (`G`), por LITRO (`ML`) o
   * por UNIDAD (`UNIT`). Son exactamente las tres columnas
   * `price_observations.normalized_per_kg_minor` / `_per_l_minor` /
   * `_per_unit_minor` — un solo dueño de la escala en los dos lados.
   *
   * No es «por gramo» a propósito: en CLP el peso es el átomo y un pollo a
   * $4.500 el kilo daría 4,5 por gramo, o sea un decimal en el camino del
   * dinero. Por kilo cabe entero y la división se hace una sola vez, al final.
   */
  readonly normalizedValueMinor: bigint;
  readonly unit: Unit;
  readonly weightBasis: WeightBasis;
  /** Cuántos días tiene la observación. Lo calcula la capa de datos: el motor no tiene reloj. */
  readonly staleDays: number;
}

export interface RecipeCostComponentInput {
  readonly componentId: string;
  readonly label: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly weightBasis: WeightBasis;
  /** Un opcional que no se puede costear NO degrada la confianza del plato. */
  readonly optional: boolean;
  /**
   * El lote que lo cubre, si está en la despensa. Si viene, manda: no se cae a
   * mercado ni aunque su valor sea desconocido.
   */
  readonly pantry: PantryLotValuation | null;
  /** Candidatas de mercado, en el orden en que el hogar las prefiere. */
  readonly market: readonly MarketEstimate[];
  /**
   * Factor ANOTADO para llevar la cantidad del componente a la base de la
   * valorización. Ausente = no hay factor: se prohíbe el 1:1 implícito.
   */
  readonly basisConversion?: BasisConversion;
}

export interface RecipeCostPolicy {
  /**
   * FIJO y no configurable: lo de la despensa vale lo que costó. Está acá para
   * que se lea en el tipo, no para que alguien lo cambie por configuración.
   */
  readonly pantryValuationOrder: readonly ["LOT_ACTUAL"];
  readonly purchaseEstimationOrder: readonly ("LAST_PURCHASE" | "PRICE_OBSERVATION")[];
  /** Más viejo que esto NO se usa: un precio de hace ocho meses es un recuerdo. */
  readonly staleAfterDays: number;
  readonly thresholds: CoverageThresholds;
}

export const POLITICA_POR_DEFECTO: RecipeCostPolicy = {
  pantryValuationOrder: ["LOT_ACTUAL"],
  purchaseEstimationOrder: ["LAST_PURCHASE", "PRICE_OBSERVATION"],
  staleAfterDays: 90,
  thresholds: UMBRALES_POR_DEFECTO,
};

export interface RecipeCostInput {
  readonly currency: CurrencyCode;
  readonly recipeId: string;
  readonly recipeVersionId: string;
  readonly servings: number;
  readonly components: readonly RecipeCostComponentInput[];
  readonly policy: RecipeCostPolicy;
}

export interface RecipeCostLine {
  readonly componentId: string;
  readonly label: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly cost: MoneyOrUnknown;
  readonly valuationSource: ValuationSource | "NONE";
  readonly valuationKind: ValuationKind | "NONE";
  readonly staleDays: number | null;
  /** «ya está en la despensa» != «es gratis»: esto NO altera `cost`. */
  readonly requiresCashToday: boolean;
  readonly optional: boolean;
}

export interface RecipeCostResult {
  readonly engineVersion: typeof RECIPE_COST_ENGINE_VERSION;
  readonly currency: CurrencyCode;
  readonly confidence: CostConfidence;
  readonly coverage: Coverage;
  /** Subtotal de lo CONOCIDO. Se llama subtotal a propósito: no es el total. */
  readonly knownSubtotal: KnownSubtotal;
  /** Los que faltan, CON identidad: sin esto no hay nada que arreglar. */
  readonly missing: readonly MissingValue[];
  /** `known:true` SÓLO si `confidence === "KNOWN"`. */
  readonly total: MoneyOrUnknown;
  readonly perServing: MoneyOrUnknown;
  readonly lines: readonly RecipeCostLine[];
  /** Valor que YA está en la despensa: no requiere caja hoy, pero SÍ tiene costo. */
  readonly fromPantry: MoneyOrUnknown;
  readonly requiresPurchase: MoneyOrUnknown;
}

/** Lo que hace falta para valorizar una cantidad contra una base. */
function convertir(
  cantidadMilli: bigint,
  desde: WeightBasis,
  hasta: WeightBasis,
  conversion: BasisConversion | undefined,
): bigint | null {
  if (desde === hasta) return cantidadMilli;
  if (conversion === undefined || conversion.den === 0n) return null;
  // Fracción exacta: nada de 0.7 en coma flotante. El redondeo es half-even
  // porque el mismo componente se puede costear cientos de veces.
  return mulDivHalfEven(cantidadMilli, conversion.num, conversion.den);
}

interface Costeo {
  readonly cost: MoneyOrUnknown;
  readonly source: ValuationSource | "NONE";
  readonly kind: ValuationKind | "NONE";
  readonly staleDays: number | null;
  readonly requiresCashToday: boolean;
}

function desconocido(reason: UnknownReason, requiresCashToday: boolean): Costeo {
  return {
    cost: unknown(reason),
    source: "NONE",
    kind: "NONE",
    staleDays: null,
    requiresCashToday,
  };
}

function costearComponente(
  c: RecipeCostComponentInput,
  currency: CurrencyCode,
  policy: RecipeCostPolicy,
): Costeo {
  const cantidad = milliDe(c.quantity);
  if (cantidad === null || cantidad <= 0n) {
    // Cantidad no comparable (más decimales de los que el ledger guarda, o
    // cero): no se estima, se declara.
    return desconocido("UNIT_NOT_NORMALIZABLE", c.pantry === null);
  }

  if (c.pantry !== null) {
    const lote = c.pantry;
    // LO DE LA DESPENSA VALE LO QUE COSTÓ. Sin fallback de mercado ni aunque
    // el valor falte: ese fallback era la puerta por la que se revalorizaba.
    if (!lote.remaining.known) {
      return {
        cost: unknown("LOT_VALUE_UNKNOWN"),
        source: "LOT_ACTUAL",
        kind: "HISTORICAL_COST",
        staleDays: null,
        requiresCashToday: false,
      };
    }
    if (lote.unit !== c.unit) {
      return {
        cost: unknown("UNIT_NOT_NORMALIZABLE"),
        source: "LOT_ACTUAL",
        kind: "HISTORICAL_COST",
        staleDays: null,
        requiresCashToday: false,
      };
    }
    const enBase = convertir(cantidad, c.weightBasis, lote.weightBasis, c.basisConversion);
    if (enBase === null) {
      return {
        cost: unknown("UNIT_NOT_NORMALIZABLE"),
        source: "LOT_ACTUAL",
        kind: "HISTORICAL_COST",
        staleDays: null,
        requiresCashToday: false,
      };
    }
    const restanteMilli = milliDe(lote.remainingQuantity);
    if (restanteMilli === null || restanteMilli <= 0n) {
      return {
        cost: unknown("LOT_VALUE_UNKNOWN"),
        source: "LOT_ACTUAL",
        kind: "HISTORICAL_COST",
        staleDays: null,
        requiresCashToday: false,
      };
    }
    return {
      cost: known(mulDiv(lote.remaining.amount, enBase, restanteMilli)),
      source: "LOT_ACTUAL",
      kind: "HISTORICAL_COST",
      staleDays: null,
      requiresCashToday: false,
    };
  }

  // No está en la despensa: hay que comprarlo, y ahí SÍ manda el precio de hoy.
  for (const preferida of policy.purchaseEstimationOrder) {
    for (const est of c.market) {
      if (est.source !== preferida) continue;
      if (est.staleDays > policy.staleAfterDays) continue;
      if (est.unit !== c.unit) continue;
      const enBase = convertir(cantidad, c.weightBasis, est.weightBasis, c.basisConversion);
      if (enBase === null) continue;
      // La cantidad viene en MILÉSIMAS de la unidad canónica. Un kilo son un
      // millón de milésimas de gramo; una unidad son mil milésimas de unidad.
      // La división es una sola y con redondeo bancario; nunca se toca un
      // `number`.
      const divisor = est.unit === "UNIT" ? 1000n : 1000000n;
      const normalizado = money(currency, est.normalizedValueMinor);
      return {
        cost: known(mulDiv(normalizado, enBase, divisor)),
        source: est.source,
        kind: "MARKET_ESTIMATE",
        staleDays: est.staleDays,
        requiresCashToday: true,
      };
    }
  }
  return desconocido("NO_PRICE_RECORDED", true);
}

export function costRecipe(input: RecipeCostInput): RecipeCostResult {
  const { currency, policy } = input;
  const lines: RecipeCostLine[] = [];
  const entradas: MoneyEntry[] = [];
  const despensa: MoneyEntry[] = [];
  const compra: MoneyEntry[] = [];
  const cobertura = new CoverageBuilder();

  for (const c of input.components) {
    const costeo = costearComponente(c, currency, policy);
    lines.push({
      componentId: c.componentId,
      label: c.label,
      quantity: c.quantity,
      unit: c.unit,
      cost: costeo.cost,
      valuationSource: costeo.source,
      valuationKind: costeo.kind,
      staleDays: costeo.staleDays,
      requiresCashToday: costeo.requiresCashToday,
      optional: c.optional,
    });

    // Un opcional sin precio no ensucia la confianza del plato: no se cocina si
    // no está. Pero tampoco se cuenta como conocido — se queda fuera del cálculo.
    if (c.optional && !costeo.cost.known) continue;

    const entrada: MoneyEntry = { id: c.componentId, label: c.label, value: costeo.cost };
    entradas.push(entrada);
    if (costeo.kind === "HISTORICAL_COST") despensa.push(entrada);
    else compra.push(entrada);

    if (!c.optional) {
      cobertura.agregar(c.unit, milliDe(c.quantity), costeo.cost.known);
    }
  }

  const suma = sumPartial(entradas, currency);
  const coverage = cobertura.construir();
  const confidence = classify(coverage, policy.thresholds);

  // LA REGLA TRANSVERSAL: `total` es conocido SI Y SÓLO SI la confianza es
  // KNOWN. En cualquier otro caso lo que se entrega es el subtotal JUNTO con la
  // lista de faltantes, en el mismo objeto: es imposible mostrar uno sin el otro.
  const total: MoneyOrUnknown = cerrarTotal(suma.subtotal, suma.missing, confidence, currency);

  // Un `servings` que no es un entero positivo no da «el costo por persona
  // dividido en cero coma algo»: da un desconocido con motivo. La receta está
  // mal declarada y hay que verlo, no repartirlo igual.
  const porcionesEnteras =
    Number.isInteger(input.servings) && input.servings > 0 ? BigInt(input.servings) : null;
  const perServing: MoneyOrUnknown =
    porcionesEnteras === null
      ? unknown("POLICY_NOT_APPLICABLE")
      : total.known
        ? known(mulDiv(total.amount, 1n, porcionesEnteras))
        : total;

  return {
    engineVersion: RECIPE_COST_ENGINE_VERSION,
    currency,
    confidence,
    coverage,
    knownSubtotal: suma.subtotal,
    missing: suma.missing,
    total,
    perServing,
    lines,
    fromPantry: cerrar(despensa, currency),
    requiresPurchase: cerrar(compra, currency),
  };
}

/**
 * De subtotal a total, con la regla transversal escrita una sola vez.
 *
 * Los dos caminos de desconocido son DISTINTOS y se nombran distinto: faltó un
 * precio (hay algo que completar, con nombre y apellido en `missing`) o hubo
 * algo que no se pudo comparar —una unidad sin peso declarado— y entonces el
 * problema es la BASE FÍSICA, no el precio. Colapsar los dos en
 * `NO_PRICE_RECORDED` mandaría a la persona a arreglar lo que no está roto.
 */
function cerrarTotal(
  subtotal: KnownSubtotal,
  missing: readonly MissingValue[],
  confidence: CostConfidence,
  currency: CurrencyCode,
): MoneyOrUnknown {
  if (missing.length > 0) {
    const primero = missing[0];
    return unknown(primero === undefined ? "NO_PRICE_RECORDED" : primero.reason);
  }
  if (confidence !== "KNOWN") return unknown("UNIT_NOT_NORMALIZABLE");
  if (subtotal.knownCount === 0) return known(zero(currency));
  return known(atLeastAmount(subtotal, missing));
}

/** Suma un grupo: si falta uno, el grupo entero es desconocido. Nunca el pedazo. */
function cerrar(entradas: readonly MoneyEntry[], currency: CurrencyCode): MoneyOrUnknown {
  const suma = sumPartial(entradas, currency);
  if (suma.missing.length > 0) {
    const primero = suma.missing[0];
    return unknown(primero === undefined ? "NO_PRICE_RECORDED" : primero.reason);
  }
  const monto: Money =
    entradas.length === 0 ? zero(currency) : atLeastAmount(suma.subtotal, suma.missing);
  return known(monto);
}
