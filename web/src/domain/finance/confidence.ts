/**
 * Sprint 14 — LA CONFIANZA DE UN NÚMERO DE PLATA.
 *
 * Los dos motores de dinero (`recipe-cost-engine.ts`, `forecast-engine.ts`)
 * tienen que responder algo más difícil que "cuánto": tienen que responder
 * "cuánto de esto sé de verdad". De esa respuesta cuelgan las dos decisiones
 * más caras de la pantalla: si el copy dice «costará» o «al menos», y si el
 * semáforo del presupuesto puede ponerse verde.
 *
 * Dos cosas que el diseño original hacía con `number` y acá NO:
 *
 *  [H18] `knownFraction >= 1` DECIDÍA "KNOWN" EN COMA FLOTANTE. Sumar
 *        fracciones de cantidad en `double` da 0.9999999999999999 con TODOS los
 *        precios presentes —y el total pasaba a desconocido sin faltar un peso—
 *        o redondea a 1 faltando un componente chico, y entonces se declaraba
 *        KNOWN con un ingrediente sin precio. Acá `KNOWN` NO se decide por
 *        fracción: es «no falta ninguno», un conteo entero. La fracción solo
 *        sirve para los escalones intermedios, y se compara en `bigint` contra
 *        puntos base (9000 = 90 %), nunca contra un literal 0.90.
 *
 *  [H19] MEDIR LA COBERTURA SOBRE "MASA CANÓNICA" MEZCLABA G, ML Y UNIT.
 *        500 ml de aceite + 500 g de arroz daban un denominador de "1000 de
 *        nada", y esa conversión implícita 1 ml = 1 g es exactamente la que el
 *        gate [B-1] y el bloqueo `BASIS_MISMATCH` del §6.3 prohíben. Acá la
 *        cobertura se mide POR DIMENSIÓN y se combina tomando la PEOR de las
 *        tres: un hogar no puede quedar en verde porque los líquidos, que pesan
 *        poco en gramos, taparon la falta de precio de la carne.
 *
 * Motor puro: sin reloj, sin red, sin base.
 */

export const CONFIDENCE_VERSION = "confidence/1.0.0";

export type CostConfidence = "KNOWN" | "MOSTLY_KNOWN" | "PARTIAL" | "INSUFFICIENT_DATA";

/** Las tres dimensiones físicas que NO se convierten entre sí sin factor anotado. */
export const DIMENSIONS = ["MASS", "VOLUME", "COUNT"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type Unit = "G" | "ML" | "UNIT";

export function dimensionOf(unit: Unit): Dimension {
  if (unit === "G") return "MASS";
  if (unit === "ML") return "VOLUME";
  return "COUNT";
}

/**
 * Cantidad en MILÉSIMAS, en `bigint`.
 *
 * El ledger guarda las cantidades como `numeric(12,3)`, así que tres decimales
 * es toda la precisión que existe y cabe exacta en un entero. La cobertura se
 * acumula acá y no en `number` porque es la que decide el color del semáforo.
 */
export type QuantityMilli = bigint;

/** Un decimal de a lo más 3 cifras. Nada de exponentes ni de precisión inventada. */
const DECIMAL_HASTA_MILESIMAS = /^(-?)(\d+)(?:\.(\d{1,3}))?$/;

/**
 * `number` → milésimas exactas, POR TEXTO y sin una sola multiplicación.
 *
 * `Math.round(q * 1000)` parece inocente y no lo es: `4.005 * 1000` da
 * 4004.9999999999995 en IEEE-754. Acá se lee la representación decimal del
 * número y se rellenan los ceros que falten, así que 4.005 da 4005n siempre.
 *
 * Devuelve `null` cuando el número NO cabe en tres decimales (o viene en
 * notación exponencial): eso no es un cero, es una cantidad que este módulo no
 * puede comparar, y el que llama la cuenta como INCOMPARABLE.
 */
export function milliDe(cantidad: number): QuantityMilli | null {
  if (!Number.isFinite(cantidad)) return null;
  const m = DECIMAL_HASTA_MILESIMAS.exec(cantidad.toString());
  if (m === null) return null;
  const signo = m[1] === "-" ? -1n : 1n;
  const entero = m[2];
  if (entero === undefined) return null;
  const decimales = (m[3] ?? "").padEnd(3, "0");
  return signo * (BigInt(entero) * 1000n + BigInt(decimales));
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * `a * num / den` en enteros, con redondeo BANCARIO (half-even).
 *
 * Vive acá y no en `money.ts` porque lo que redondea son CANTIDADES, no plata:
 * llevar 800 g de pollo cocido a su equivalente crudo con un factor 7/10 no es
 * una operación monetaria y no debe pasar por el constructor de `Money` (que
 * valida rango de dinero y exige moneda). Es el mismo algoritmo, a propósito:
 * `confidence.test.ts` verifica que dé exactamente lo mismo que `mulDiv` sobre
 * los mismos números, porque dos redondeos distintos en el mismo cálculo
 * producirían un costo por kilo que no cuadra con el costo total.
 */
export function mulDivHalfEven(a: bigint, num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("no se divide una cantidad por cero");
  const producto = a * num;
  const negativo = producto < 0n !== den < 0n;
  const p = abs(producto);
  const d = abs(den);
  let q = p / d;
  const resto = p - q * d;
  const doble = resto * 2n;
  if (doble > d || (doble === d && (q & 1n) === 1n)) q += 1n;
  return negativo ? -q : q;
}

export interface DimensionCoverage {
  /** Cantidad con costo conocido, en milésimas. */
  readonly knownMilli: QuantityMilli;
  /** Cantidad total comparable, en milésimas. NO incluye los incomparables. */
  readonly totalMilli: QuantityMilli;
}

/**
 * La cobertura, sin ninguna fracción única cross-dimensión.
 *
 * `incomparableItems` son los ítems cuya cantidad no se puede llevar a una
 * dimensión (una unidad sin peso declarado, un `numeric` con más decimales de
 * los que existen). NO entran a ningún denominador: taparlos en el denominador
 * los convertiría en cobertura conocida, que es la mentira que este archivo
 * existe para impedir.
 */
export interface Coverage {
  readonly byDimension: Readonly<Record<Dimension, DimensionCoverage>>;
  readonly knownItems: number;
  readonly unknownItems: number;
  readonly incomparableItems: number;
  readonly totalItems: number;
}

/** Umbrales en PUNTOS BASE (`bigint`), jamás 0.90 / 0.50 en `double`. */
export interface CoverageThresholds {
  readonly mostlyKnownBps: bigint; // 9000
  readonly partialBps: bigint; // 5000
}

export const UMBRALES_POR_DEFECTO: CoverageThresholds = {
  mostlyKnownBps: 9000n,
  partialBps: 5000n,
};

export function coverageVacia(): Coverage {
  return {
    byDimension: {
      MASS: { knownMilli: 0n, totalMilli: 0n },
      VOLUME: { knownMilli: 0n, totalMilli: 0n },
      COUNT: { knownMilli: 0n, totalMilli: 0n },
    },
    knownItems: 0,
    unknownItems: 0,
    incomparableItems: 0,
    totalItems: 0,
  };
}

/** Acumulador mutable interno; la salida es un `Coverage` congelado. */
export class CoverageBuilder {
  private readonly dims: Record<Dimension, { known: bigint; total: bigint }> = {
    MASS: { known: 0n, total: 0n },
    VOLUME: { known: 0n, total: 0n },
    COUNT: { known: 0n, total: 0n },
  };
  private knownItems = 0;
  private unknownItems = 0;
  private incomparableItems = 0;

  /**
   * Suma un ítem. `cantidad` en milésimas; `null` = no se pudo comparar.
   *
   * Un ítem incomparable se cuenta como incomparable Y —si su costo tampoco se
   * sabe— como desconocido: son dos defectos distintos y ocultar uno detrás del
   * otro deja la pantalla sin qué nombrar.
   */
  agregar(unit: Unit, cantidad: QuantityMilli | null, costoConocido: boolean): void {
    if (costoConocido) this.knownItems += 1;
    else this.unknownItems += 1;
    if (cantidad === null || cantidad <= 0n) {
      this.incomparableItems += 1;
      return;
    }
    const d = this.dims[dimensionOf(unit)];
    d.total += cantidad;
    if (costoConocido) d.known += cantidad;
  }

  /**
   * Ítems que se cuentan UNO A UNO y no tienen cantidad con la cual pesarse.
   *
   * Existe para las asignaciones de costo del período: `cost_allocations` no
   * guarda la UNIDAD de su `quantity`, así que llevarlas a una dimensión exige
   * inventarles una —«todo es gramos»— y ahí vuelve el defecto [H19] por la
   * puerta de atrás: 500 ml + 500 g = 1000 de nada. Acá esas filas se miden por
   * CONTEO, que es lo único que se sabe de verdad.
   *
   * La asimetría es deliberada y es la mitad del punto:
   *
   *   - un ítem CONOCIDO no suma incomparable: no falta nada de él, así que no
   *     hay peso que estimar. Si no falta ninguno, el período queda `KNOWN`.
   *   - un ítem DESCONOCIDO sí suma incomparable: no sabemos cuánto vale NI
   *     cuánto pesa dentro del total, así que no se puede decir «falta poco».
   *     `classify` lo topa en PARTIAL y, sin ninguna dimensión medible, en
   *     INSUFFICIENT_DATA. Un desconocido sin peso jamás deja el semáforo verde.
   */
  contarSinCantidad(conocidos: number, desconocidos: number): void {
    if (!Number.isInteger(conocidos) || !Number.isInteger(desconocidos)) {
      throw new Error("los conteos de cobertura son enteros: no se cuentan ítems a medias");
    }
    if (conocidos < 0 || desconocidos < 0) {
      throw new Error("un conteo de cobertura negativo no existe");
    }
    this.knownItems += conocidos;
    this.unknownItems += desconocidos;
    this.incomparableItems += desconocidos;
  }

  construir(): Coverage {
    return {
      byDimension: {
        MASS: { knownMilli: this.dims.MASS.known, totalMilli: this.dims.MASS.total },
        VOLUME: { knownMilli: this.dims.VOLUME.known, totalMilli: this.dims.VOLUME.total },
        COUNT: { knownMilli: this.dims.COUNT.known, totalMilli: this.dims.COUNT.total },
      },
      knownItems: this.knownItems,
      unknownItems: this.unknownItems,
      incomparableItems: this.incomparableItems,
      totalItems: this.knownItems + this.unknownItems,
    };
  }
}

/**
 * La PEOR cobertura de las tres dimensiones, en puntos base.
 *
 * Devuelve `null` cuando no hay ninguna dimensión con cantidad comparable: eso
 * NO es 0 % (que se leería como "no sé nada de nada" y es un dato) sino "no hay
 * sobre qué medir", y el que llama tiene que decidirlo a la cara.
 */
export function peorCoberturaBps(c: Coverage): bigint | null {
  let peor: bigint | null = null;
  for (const d of DIMENSIONS) {
    const dim = c.byDimension[d];
    if (dim.totalMilli <= 0n) continue;
    const bps = (dim.knownMilli * 10000n) / dim.totalMilli;
    if (peor === null || bps < peor) peor = bps;
  }
  return peor;
}

/**
 * El veredicto.
 *
 * `KNOWN` es un CONTEO, no una fracción: no falta ningún ítem y no hay ninguno
 * incomparable. Es la única forma de que «costará $X» aparezca en pantalla.
 */
export function classify(c: Coverage, t: CoverageThresholds): CostConfidence {
  if (c.totalItems === 0) return "INSUFFICIENT_DATA";
  if (c.unknownItems === 0 && c.incomparableItems === 0) return "KNOWN";

  const bps = peorCoberturaBps(c);
  // Todo lo que hay es incomparable (o de cantidad cero): no hay cobertura que
  // medir, y llamar a eso "parcial" sería inventarle un piso.
  if (bps === null) return "INSUFFICIENT_DATA";

  // Un incomparable nunca deja pasar de PARTIAL: su cantidad no está en ningún
  // denominador, así que la fracción de arriba lo ignora y se ve mejor de lo
  // que es. El tope lo pone acá y no en la fracción.
  if (c.incomparableItems > 0) {
    return bps >= t.partialBps ? "PARTIAL" : "INSUFFICIENT_DATA";
  }
  if (bps >= t.mostlyKnownBps) return "MOSTLY_KNOWN";
  if (bps >= t.partialBps) return "PARTIAL";
  return "INSUFFICIENT_DATA";
}

/** ¿Este veredicto habilita a mostrar un total cerrado y un semáforo de color? */
export function coberturaSuficiente(c: CostConfidence): boolean {
  return c === "KNOWN" || c === "MOSTLY_KNOWN";
}
