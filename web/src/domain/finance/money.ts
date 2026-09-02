/**
 * Sprint 14 — LA REPRESENTACIÓN DEL DINERO. El cimiento de todo lo demás.
 *
 * Tres reglas que no se negocian y que este archivo hace CUMPLIR, no recuerda:
 *
 *  1. EL DINERO NO PASA POR COMA FLOTANTE. Todo monto es un `bigint` de
 *     unidades menores (pesos en CLP, centavos en USD/EUR) más su moneda.
 *     `number` no aparece en ningún monto: 0.1 + 0.2 !== 0.3 y un peso perdido
 *     por lote se multiplica por cada lote de la despensa.
 *
 *  2. DESCONOCIDO NO ES CERO. `MoneyOrUnknown` no tiene una rama `null`: el
 *     desconocido viaja SIEMPRE con su motivo, porque una pantalla que dice
 *     "$0 desperdiciado" cuando no hay precios está mintiendo. Y al revés:
 *     "me lo regalaron" es `{ known: true, amount: 0 }` — un cero de verdad,
 *     que NO es lo mismo que "no sé cuánto costó". Los dos existen.
 *
 *  3. CONSERVACIÓN. `apportion` (mayor resto / Hamilton) reparte un total
 *     entero sin perder ni un peso: Σ partes === total, por construcción y
 *     verificado adentro. Es la única forma legítima de repartir dinero.
 *
 * Motor puro y versionado: sin reloj, sin red, sin base. Mismos insumos,
 * misma salida, siempre.
 */

export const MONEY_ENGINE_VERSION = "money/1.0.0";

// ---------------------------------------------------------------------------
// Monedas: el espejo exacto de public.currency_units (migración 0042)
// ---------------------------------------------------------------------------

export const CURRENCY_CODES = ["CLP", "USD", "EUR"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface CurrencyUnit {
  readonly code: CurrencyCode;
  /** Cuántos decimales tiene la unidad menor. CLP = 0: el peso es el átomo. */
  readonly minorExponent: number;
  /** Descuadre tolerado en una boleta completa, en unidades menores. */
  readonly reconciliationToleranceMinor: bigint;
  /** Descuadre tolerado en UNA línea de boleta. */
  readonly reconciliationTolerancePerLineMinor: bigint;
}

/**
 * Esta tabla es un ESPEJO de la base, no una segunda fuente: el test de
 * integración `sprint14-dinero.test.ts` compara fila por fila contra
 * `public.currency_units`. Si alguien agrega una moneda en un solo lado, ese
 * test falla — que es exactamente lo que tiene que pasar.
 */
export const CURRENCY_UNITS: Readonly<Record<CurrencyCode, CurrencyUnit>> = {
  CLP: {
    code: "CLP",
    minorExponent: 0,
    reconciliationToleranceMinor: 5n,
    reconciliationTolerancePerLineMinor: 1n,
  },
  USD: {
    code: "USD",
    minorExponent: 2,
    reconciliationToleranceMinor: 2n,
    reconciliationTolerancePerLineMinor: 1n,
  },
  EUR: {
    code: "EUR",
    minorExponent: 2,
    reconciliationToleranceMinor: 2n,
    reconciliationTolerancePerLineMinor: 1n,
  },
};

export function isCurrencyCode(valor: string): valor is CurrencyCode {
  return (CURRENCY_CODES as readonly string[]).includes(valor);
}

/**
 * Rango representable, en unidades menores.
 *
 * Escrito como literal entero completo y NO como `1e15`: en Postgres `1e15` es
 * un literal `double precision`, así que un `check (amount_minor between -1e15
 * and 1e15)` compara el bigint EN COMA FLOTANTE — la guarda escrita para
 * impedir el float haciendo, ella misma, aritmética de float. Acá vale lo
 * mismo: `1e15` en TypeScript es un `number`. Los dos lados usan el entero.
 */
export const MONEY_MAX_MINOR = 1000000000000000n;
export const MONEY_MIN_MINOR = -1000000000000000n;

// ---------------------------------------------------------------------------
// Los tipos
// ---------------------------------------------------------------------------

export interface Money {
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

export const UNKNOWN_REASONS = [
  /** Nunca se registró precio para esto. */
  "NO_PRICE_RECORDED",
  /** El lote entró a la despensa sin boleta. */
  "LOT_VALUE_UNKNOWN",
  /** K-19: una parte de la fusión era desconocida, y el desconocido domina. */
  "MIXED_UNKNOWN_MERGE",
  /** Se consumió algo que no tenía lote de origen (consumption_shortfalls). */
  "CONSUMPTION_WITHOUT_LOT",
  /** La boleta va a llegar después: hoy todavía no se puede reconocer. */
  "NOT_YET_RECOGNIZED",
  /** No se puede llevar a $/kg sin inventar un factor de conversión. */
  "UNIT_NOT_NORMALIZABLE",
  /** La política de asignación no corre con estos datos. */
  "POLICY_NOT_APPLICABLE",
] as const;

export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/**
 * Un monto que puede no saberse. NO existe `Money | null`.
 *
 * Un `null` suelto se lee como "vacío" y termina en un `?? 0` tres capas más
 * arriba. Acá el desconocido carga SIEMPRE su motivo, así la pantalla puede
 * decir "valor desconocido: este lote entró sin boleta" en vez de un guion.
 */
export type MoneyOrUnknown =
  | { readonly known: true; readonly amount: Money }
  | { readonly known: false; readonly reason: UnknownReason };

export type MoneyErrorCode =
  | "MONEDA_DISTINTA"
  | "FUERA_DE_RANGO"
  | "DIVISOR_CERO"
  | "REPARTO_NO_CONSERVA"
  | "SUBTOTAL_SIN_FALTANTES";

/**
 * Falla de PROGRAMACIÓN, no condición de los datos.
 *
 * Sumar CLP con USD o dividir por cero son bugs: tienen que reventar fuerte y
 * temprano. Lo que SÍ es una condición legítima de los datos —una boleta cuyas
 * líneas no tienen valor con qué repartir— no lanza: devuelve un bloqueo
 * tipado (ver `apportion`).
 */
export class MoneyError extends Error {
  constructor(
    readonly codigo: MoneyErrorCode,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = "MoneyError";
  }
}

// ---------------------------------------------------------------------------
// Construcción y aritmética exacta
// ---------------------------------------------------------------------------

function enRango(minor: bigint): boolean {
  return minor >= MONEY_MIN_MINOR && minor <= MONEY_MAX_MINOR;
}

/** Único constructor. Un bigint desbordado es tan venenoso como un NaN. */
export function money(currency: CurrencyCode, minor: bigint): Money {
  if (!enRango(minor)) {
    throw new MoneyError(
      "FUERA_DE_RANGO",
      `el monto ${minor.toString()} se salió del rango de dinero representable`,
    );
  }
  return { currency, minor };
}

export function zero(currency: CurrencyCode): Money {
  return { currency, minor: 0n };
}

export function isZero(m: Money): boolean {
  return m.minor === 0n;
}

function mismaMoneda(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      "MONEDA_DISTINTA",
      `no se opera ${a.currency} con ${b.currency}: son escalas distintas`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  mismaMoneda(a, b);
  return money(a.currency, a.minor + b.minor);
}

export function subtract(a: Money, b: Money): Money {
  mismaMoneda(a, b);
  return money(a.currency, a.minor - b.minor);
}

export function negate(m: Money): Money {
  return money(m.currency, -m.minor);
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/** −1, 0 o 1. Revienta si las monedas difieren: comparar escalas distintas no significa nada. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  mismaMoneda(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Lectura de índice SIN relleno: si el índice no existe es un bug, no un cero. */
function pesoEn(weights: readonly bigint[], i: number): bigint {
  const w = weights[i];
  if (w === undefined) {
    throw new MoneyError("REPARTO_NO_CONSERVA", `el peso ${i} no existe`);
  }
  return w;
}

/**
 * `m * num / den` con redondeo BANCARIO (half-even) y sin coma flotante.
 *
 * Half-even y no "half-up" porque un half-up sistemático sesga hacia arriba
 * cada mitad exacta, y en una despensa donde se costean cientos de movimientos
 * chicos ese sesgo se acumula en una dirección sola.
 *
 * REGLA DE USO (la escribimos porque conviven dos repartidores):
 *   - `apportion` para repartir un total conocido DE UNA SOLA VEZ (cargos de
 *     boleta, partición de un lote). Conserva por construcción.
 *   - `mulDiv` solo para extracciones INCREMENTALES cuyo residuo sea
 *     recuperable — costear un consumo contra el remanente de un lote. Quien
 *     lo use está obligado a cerrar el lote con el residuo exacto cuando el
 *     lote se cierra por cualquier vía (llegar a 0, archivarse, fusionarse):
 *     si no, el residuo queda flotando como valor de un lote sin cantidad.
 */
export function mulDiv(m: Money, num: bigint, den: bigint): Money {
  if (den === 0n) {
    throw new MoneyError("DIVISOR_CERO", "no se divide dinero por cero");
  }
  const producto = m.minor * num;
  const negativo = producto < 0n !== den < 0n;
  const p = abs(producto);
  const d = abs(den);
  let q = p / d;
  const resto = p - q * d;
  const doble = resto * 2n;
  if (doble > d || (doble === d && (q & 1n) === 1n)) q += 1n;
  return money(m.currency, negativo ? -q : q);
}

// ---------------------------------------------------------------------------
// Reparto por mayor resto (Hamilton): la conservación es por construcción
// ---------------------------------------------------------------------------

export type ApportionBlockReason =
  /** Nadie a quien repartir. */
  | "SIN_PARTES"
  /** Un peso negativo: un descuento de línea mayor que la línea, típicamente. */
  | "PESO_NEGATIVO"
  /** Un peso nulo o no entero llegó desde afuera. */
  | "PESO_INVALIDO"
  /** Todos los pesos son cero: una boleta de puras líneas en $0 más el despacho. */
  | "PESOS_SUMAN_CERO";

export interface ApportionBlocked {
  readonly ok: false;
  readonly reason: ApportionBlockReason;
  /** Cómo se cuenta este bloqueo cuando llega a una pantalla de dinero. */
  readonly unknownReason: UnknownReason;
  readonly detalle: string;
}

export type ApportionResult =
  | { readonly ok: true; readonly parts: readonly Money[] }
  | ApportionBlocked;

function bloqueo(reason: ApportionBlockReason, detalle: string): ApportionBlocked {
  return { ok: false, reason, unknownReason: "POLICY_NOT_APPLICABLE", detalle };
}

/**
 * Reparte `total` entre `weights` proporcionalmente, sin perder ni un peso.
 *
 * Por qué devuelve un resultado tipado y no lanza: los pesos vienen de líneas
 * de boleta reales. Una promo que imprime $0 da peso 0, una boleta entera de
 * líneas en $0 da Σpesos = 0, y un descuento de línea mayor que la línea da
 * peso negativo. Eso NO es un bug del programa: es una boleta del supermercado.
 * Reventar ahí bota la confirmación completa de la boleta; devolver el bloqueo
 * deja que el que llama muestre "no se pudo repartir el despacho" y siga.
 *
 * Totales NEGATIVOS (descuentos de orden, cupones) son el caso normal, no el
 * raro: se reparte el valor absoluto y se repone el signo. Así
 * `apportion(-t, w) === apportion(t, w)` cambiado de signo, exactamente, y la
 * postcondición Σ = total se cumple igual en los dos lados del cero. La versión
 * ingenua —truncar hacia cero y "sumar de a 1 al de mayor resto"— reparte para
 * el lado equivocado con negativos y deja el total sin cuadrar.
 *
 * Un peso 0 recibe EXACTAMENTE 0: el sobrante a repartir siempre es menor que
 * la cantidad de pesos con resto positivo, así que nunca alcanza a los ceros.
 */
export function apportion(total: Money, weights: readonly bigint[]): ApportionResult {
  if (weights.length === 0) {
    return bloqueo("SIN_PARTES", "no hay partes entre las cuales repartir");
  }

  let sumaPesos = 0n;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    if (typeof w !== "bigint") {
      return bloqueo("PESO_INVALIDO", `el peso ${i} no es un entero`);
    }
    if (w < 0n) {
      return bloqueo("PESO_NEGATIVO", `el peso ${i} es negativo (${w.toString()})`);
    }
    sumaPesos += w;
  }
  if (sumaPesos === 0n) {
    return bloqueo("PESOS_SUMAN_CERO", "todos los pesos son cero: no hay proporción que aplicar");
  }

  const negativo = total.minor < 0n;
  const magnitud = abs(total.minor);

  // Cada parte viaja con su índice y su resto en el mismo objeto: leer los
  // restos por índice obligaría a un `?? 0n` de relleno, que es justo el
  // patrón que este módulo existe para que no aparezca en ninguna parte.
  const partes: Array<{ readonly indice: number; piso: bigint; readonly resto: bigint }> = [];
  let repartido = 0n;
  for (let i = 0; i < weights.length; i += 1) {
    const w = pesoEn(weights, i);
    const producto = magnitud * w;
    const piso = producto / sumaPesos; // magnitud >= 0 → división entera == floor
    partes.push({ indice: i, piso, resto: producto - piso * sumaPesos });
    repartido += piso;
  }

  // El sobrante se reparte de a UNA unidad menor, a los de mayor resto
  // fraccionario, desempatando por índice ascendente: determinismo byte a byte.
  let sobrante = magnitud - repartido;
  const porResto = [...partes].sort((a, b) =>
    a.resto === b.resto ? a.indice - b.indice : b.resto > a.resto ? 1 : -1,
  );
  for (const parte of porResto) {
    if (sobrante <= 0n) break;
    parte.piso += 1n;
    sobrante -= 1n;
  }

  const parts = partes.map((p) => money(total.currency, negativo ? -p.piso : p.piso));

  // Postcondición verificada acá adentro, no en un test: si esto falla, el
  // resto del sprint está sumando plata que no existe.
  let control = 0n;
  for (const p of parts) control += p.minor;
  if (control !== total.minor) {
    throw new MoneyError(
      "REPARTO_NO_CONSERVA",
      `el reparto sumó ${control.toString()} y el total era ${total.minor.toString()}`,
    );
  }

  return { ok: true, parts };
}

/**
 * `apportion` para los repartos INTERNOS donde un bloqueo sería un bug del
 * programa y no un dato del mundo (partir un lote: las cantidades son > 0 por
 * las guardas del ledger). Lanza con el motivo adentro.
 */
export function apportionOrThrow(total: Money, weights: readonly bigint[]): readonly Money[] {
  const resultado = apportion(total, weights);
  if (!resultado.ok) {
    throw new MoneyError(
      "REPARTO_NO_CONSERVA",
      `no se pudo repartir (${resultado.reason}): ${resultado.detalle}`,
    );
  }
  return resultado.parts;
}

// ---------------------------------------------------------------------------
// Conocido / desconocido
// ---------------------------------------------------------------------------

export function known(amount: Money): MoneyOrUnknown {
  return { known: true, amount };
}

export function unknown(reason: UnknownReason): MoneyOrUnknown {
  return { known: false, reason };
}

/**
 * "Me lo regalaron" — un cero de verdad, conocido.
 *
 * Existe con nombre propio para que nadie lo escriba como `unknown(...)` ni al
 * revés: "ya lo tengo" NO significa "es gratis", y "no sé cuánto costó" NO
 * significa "$0". Son tres cosas distintas y el tipo las distingue.
 */
export function free(currency: CurrencyCode): MoneyOrUnknown {
  return { known: true, amount: zero(currency) };
}

export function isFree(valor: MoneyOrUnknown): boolean {
  return valor.known && valor.amount.minor === 0n;
}

/**
 * Precedencia de motivos, de más accionable a menos.
 *
 * `sumStrict` devuelve UN motivo, y elegir "el primero que apareció" haría que
 * la misma despensa mostrara mensajes distintos según el orden en que la base
 * devolvió las filas. Con una precedencia declarada, reordenar los insumos no
 * cambia la salida. Si necesitas SABER todo lo que falta —y casi siempre lo
 * necesitas— usa `sumPartial`, que se lleva la lista completa con identidad.
 */
export const UNKNOWN_REASON_PRECEDENCE: readonly UnknownReason[] = [
  "NO_PRICE_RECORDED",
  "LOT_VALUE_UNKNOWN",
  "NOT_YET_RECOGNIZED",
  "MIXED_UNKNOWN_MERGE",
  "CONSUMPTION_WITHOUT_LOT",
  "UNIT_NOT_NORMALIZABLE",
  "POLICY_NOT_APPLICABLE",
];

function dominante(motivos: readonly UnknownReason[]): UnknownReason {
  for (const candidato of UNKNOWN_REASON_PRECEDENCE) {
    if (motivos.includes(candidato)) return candidato;
  }
  // Inalcanzable mientras UnknownReason y la precedencia no se separen; el
  // test estructural verifica que la lista cubra el tipo entero.
  return "POLICY_NOT_APPLICABLE";
}

/**
 * Suma TODO O NADA: si un solo sumando es desconocido, el resultado es
 * desconocido.
 *
 * Es `wasteCost30` (stock/engine.ts) generalizado y con nombre: ahí ya se
 * había aprendido que un subtotal parcial mostrado al lado de una cantidad
 * total es un número que miente.
 *
 * OJO con la lista VACÍA: devuelve cero conocido, porque la suma de nada es
 * cero y eso es cierto. Lo que NO puede pasar es que una consulta que FALLÓ
 * llegue acá como lista vacía — error no es vacío, y esa distinción se sostiene
 * en la capa de datos, no acá.
 */
export function sumStrict(xs: readonly MoneyOrUnknown[], currency: CurrencyCode): MoneyOrUnknown {
  const motivos: UnknownReason[] = [];
  let total = 0n;
  for (const x of xs) {
    if (!x.known) {
      motivos.push(x.reason);
      continue;
    }
    if (x.amount.currency !== currency) {
      throw new MoneyError(
        "MONEDA_DISTINTA",
        `la suma es en ${currency} y llegó un monto en ${x.amount.currency}`,
      );
    }
    total += x.amount.minor;
  }
  if (motivos.length > 0) return unknown(dominante(motivos));
  return known(money(currency, total));
}

// ---------------------------------------------------------------------------
// Suma parcial DECLARADA
// ---------------------------------------------------------------------------

export interface MoneyEntry {
  /** Identidad de la cosa que se está sumando (lote, línea, producto). */
  readonly id: string;
  /** Cómo se llama en pantalla. "3 productos sin precio" sin nombrarlos es inarreglable. */
  readonly label: string;
  readonly value: MoneyOrUnknown;
}

export interface MissingValue {
  readonly id: string;
  readonly label: string;
  readonly reason: UnknownReason;
}

/**
 * Un subtotal que NO es un `Money`, a propósito.
 *
 * Si `sumPartial` devolviera `Money`, sería estructuralmente idéntico a un
 * total y cualquier pantalla podría pintarlo con el formateador de montos:
 * "$121.900" donde la verdad es "al menos $121.900, y faltan 6 productos". La
 * disciplina quedaría apoyada en el nombre de la variable. Acá el campo se
 * llama `minorAtLeast` y el tipo no encaja en `Money`: para sacar el monto hay
 * que pasar por `atLeastAmount`, que EXIGE la lista de faltantes.
 */
export interface KnownSubtotal {
  readonly kind: "KnownSubtotal";
  readonly currency: CurrencyCode;
  readonly minorAtLeast: bigint;
  /** Cuántos sumandos sí tenían valor. Distingue "todo conocido y da $0" de "no había nada". */
  readonly knownCount: number;
  readonly missingCount: number;
}

export interface PartialSum {
  readonly subtotal: KnownSubtotal;
  /** Los que faltan, CON identidad: sin esto no hay nada que arreglar. */
  readonly missing: readonly MissingValue[];
}

/**
 * Suma lo que se sabe y se lleva aparte lo que falta, con nombre y apellido.
 *
 * El retorno obliga a cargar las dos mitades juntas: no se puede usar el
 * subtotal sin tener a mano lo que le falta.
 */
export function sumPartial(entries: readonly MoneyEntry[], currency: CurrencyCode): PartialSum {
  let total = 0n;
  let conocidos = 0;
  const missing: MissingValue[] = [];
  for (const entrada of entries) {
    if (!entrada.value.known) {
      missing.push({ id: entrada.id, label: entrada.label, reason: entrada.value.reason });
      continue;
    }
    if (entrada.value.amount.currency !== currency) {
      throw new MoneyError(
        "MONEDA_DISTINTA",
        `la suma es en ${currency} y "${entrada.label}" viene en ${entrada.value.amount.currency}`,
      );
    }
    total += entrada.value.amount.minor;
    conocidos += 1;
  }
  if (!enRango(total)) {
    throw new MoneyError(
      "FUERA_DE_RANGO",
      `el subtotal ${total.toString()} se salió del rango de dinero representable`,
    );
  }
  return {
    subtotal: {
      kind: "KnownSubtotal",
      currency,
      minorAtLeast: total,
      knownCount: conocidos,
      missingCount: missing.length,
    },
    missing,
  };
}

/** ¿El subtotal es, de hecho, el total? Solo entonces puede pintarse como total. */
export function isComplete(subtotal: KnownSubtotal): boolean {
  return subtotal.missingCount === 0;
}

/**
 * La ÚNICA salida de `KnownSubtotal` hacia `Money`, y cobra peaje: hay que
 * traer la lista de faltantes. Un componente que quiera mostrar el número
 * grande tiene que tener en la mano —y por lo tanto puede mostrar— lo que
 * falta. Si la lista no calza con lo que el subtotal declara, revienta: alguien
 * está mostrando "al menos $X" con una lista de faltantes de otra consulta.
 */
export function atLeastAmount(subtotal: KnownSubtotal, missing: readonly MissingValue[]): Money {
  if (missing.length !== subtotal.missingCount) {
    throw new MoneyError(
      "SUBTOTAL_SIN_FALTANTES",
      `este subtotal declara ${subtotal.missingCount} faltantes y se entregaron ${missing.length}`,
    );
  }
  return money(subtotal.currency, subtotal.minorAtLeast);
}

/**
 * Cierra el subtotal a un valor completo cuando de verdad no falta nada.
 * Si falta algo, el resultado es DESCONOCIDO — no el pedazo conocido.
 */
export function closePartial(suma: PartialSum): MoneyOrUnknown {
  if (suma.missing.length === 0) {
    return known(money(suma.subtotal.currency, suma.subtotal.minorAtLeast));
  }
  return unknown(dominante(suma.missing.map((m) => m.reason)));
}

// ---------------------------------------------------------------------------
// El borde: texto crudo → bigint, sin inventar
// ---------------------------------------------------------------------------

export type MinorParse =
  | { readonly ok: true; readonly minor: bigint }
  | { readonly ok: false; readonly problema: string };

const SOLO_ENTERO = /^-?\d+$/;

/**
 * Convierte lo que llega de la base (PostgREST entrega `bigint` como STRING) a
 * un `bigint`, validando ANTES de transformar.
 *
 * Cada rechazo de acá es un bug real que ya se vio:
 *  - `BigInt("")` y `BigInt(" ")` devuelven **0n**: una celda vacía entraría
 *    como CERO PESOS sin que nada se queje. Es el desconocido convertido en
 *    plata, en la pantalla donde más caro sale.
 *  - `BigInt("12.5")` lanza `SyntaxError` — no un error de validación, una
 *    excepción cruda que se escapa del `safeParse` y termina en el `catch` de
 *    más arriba, o peor, en un valor por defecto.
 *  - Un `1234.5` dentro del rango seguro pasaría cualquier chequeo de
 *    `isSafeInteger` sobre el truncado y perdería plata en silencio. Acá el
 *    no-entero se RECHAZA, no se trunca: si llegó un decimal, el esquema está
 *    mal y hay que verlo.
 */
export function parseMinor(bruto: unknown): MinorParse {
  if (typeof bruto === "bigint") {
    if (!enRango(bruto)) return { ok: false, problema: "monto fuera del rango representable" };
    return { ok: true, minor: bruto };
  }
  if (typeof bruto === "number") {
    if (!Number.isInteger(bruto)) {
      return { ok: false, problema: `el monto ${bruto} no es entero: no se trunca dinero` };
    }
    if (!Number.isSafeInteger(bruto)) {
      return { ok: false, problema: "monto fuera del rango seguro de JavaScript" };
    }
    const convertido = BigInt(bruto);
    if (!enRango(convertido)) return { ok: false, problema: "monto fuera del rango representable" };
    return { ok: true, minor: convertido };
  }
  if (typeof bruto === "string") {
    if (!SOLO_ENTERO.test(bruto)) {
      return {
        ok: false,
        problema: `"${bruto}" no es un entero de unidades menores`,
      };
    }
    const convertido = BigInt(bruto);
    if (!enRango(convertido)) return { ok: false, problema: "monto fuera del rango representable" };
    return { ok: true, minor: convertido };
  }
  return { ok: false, problema: "el monto llegó en un tipo que no es texto ni entero" };
}
