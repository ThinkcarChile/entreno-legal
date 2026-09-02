import { parseMinor } from "./money";

/**
 * En qué base viene el precio unitario IMPRESO. Gemelo del enum
 * `public.unit_price_basis` (0043). `null` = la boleta no lo dijo, y entonces la
 * aritmética de la línea no corre: no se inventa una base.
 */
export const UNIT_PRICE_BASES = ["PER_KG", "PER_L", "PER_UNIT", "PER_100G"] as const;
export type UnitPriceBasis = (typeof UNIT_PRICE_BASES)[number];

/**
 * FRONTERA DE EXTRACCIÓN DE BOLETAS — la capa que PROPONE y jamás decide.
 *
 * Mismo contrato que el extractor clínico (`domain/clinical/extraction.ts`):
 * función PURA, determinista, sin reloj, sin red y sin base. Su salida son
 * CANDIDATOS que un humano revisa; no hay ninguna puerta desde acá hacia el
 * inventario, los precios ni la plata. Esa puerta es
 * `public.confirm_receipt_extraction`, y la abre una persona.
 *
 * Ante una foto o un PDF sin extractor real devuelve FAILED honesto, jamás un
 * OCR improvisado: un candidato inventado con confianza alta es peor que no
 * tener candidato, porque se confirma sin resistencia.
 *
 * Lo que este módulo NO hace, a propósito:
 *  · no rellena la unidad con la canónica del catálogo cuando la boleta no la
 *    trae (eso sería inventar);
 *  · no "corrige" ninguno de los tres números de una línea cuando no cuadran —
 *    precio, cantidad y total son los tres datos LEÍDOS y el sistema no sabe
 *    cuál está malo. Mide el descuadre y deja decidir a la persona;
 *  · no convierte un campo ilegible en 0. Un campo que no se pudo leer viaja
 *    como `null` y con su confianza baja.
 */

export const RECEIPT_PARSER_VERSION = "receipt-parser/1.0.0";

/** Confianza bajo la cual una lectura es dudosa. El mismo umbral que el servidor. */
export const CONFIDENCE_THRESHOLD = 0.85;

/** Los campos cuya legibilidad se declara por separado (§H40). */
export const CONFIDENCE_FIELDS = ["quantity", "unit_price", "line_total", "barcode"] as const;
export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];

export interface ReceiptCandidate {
  readonly raw_line_text: string;
  readonly original_snippet: string;
  /** `null` = la boleta no la traía. Nunca se rellena con la del catálogo. */
  readonly quantity: string | null;
  readonly unit: "G" | "ML" | "UNIT" | null;
  readonly unit_price_minor: string | null;
  readonly unit_price_basis: UnitPriceBasis | null;
  /** `null` = sin total de línea. La línea no se puede confirmar así. */
  readonly line_total_minor: string | null;
  readonly discount_minor: string | null;
  readonly barcode: string | null;
  readonly match_method: "BARCODE" | "FUZZY_NAME" | "NONE";
  readonly match_score: number | null;
  readonly extraction_confidence: number;
  /** Confianza POR CAMPO: una boleta térmica se lee bien en el texto y mal en el monto. */
  readonly field_confidences: Readonly<Partial<Record<ConfidenceField, number>>>;
}

export interface ReceiptHeader {
  readonly merchant_name: string | null;
  readonly receipt_date: string | null;
  readonly receipt_number: string | null;
  /** `null` = el total impreso NO se leyó. Jamás cero. */
  readonly declared_total_minor: string | null;
  readonly total_source: "PRINTED" | "UNKNOWN";
}

export type ReceiptExtractionResult =
  | {
      readonly ok: true;
      readonly processorVersion: string;
      readonly header: ReceiptHeader;
      readonly candidates: readonly ReceiptCandidate[];
    }
  | { readonly ok: false; readonly processorVersion: string; readonly error: string };

// ---------------------------------------------------------------------------
// Dígito verificador del código de barras
// ---------------------------------------------------------------------------

/**
 * EAN-8 / UPC-A / EAN-13 / GTIN-14.
 *
 * Gemelo exacto de `app.ean_check_digit_ok` (0045). Existe porque
 * `match_method='BARCODE'` es la vía de mayor confianza del sistema y la que
 * menos escrutinio recibía: un dígito mal leído puede matchear OTRO producto
 * real del catálogo, con score 1.0 y sin ninguna señal de alarma. Esta
 * aritmética es gratis.
 *
 * Devuelve `false` —no una excepción y no `null`— ante basura: un código que no
 * es un código no valida, y quien pregunta necesita una respuesta, no un throw.
 */
export function eanCheckDigitOk(code: string | null): boolean {
  if (code === null) return false;
  const limpio = code.trim();
  if (!/^[0-9]+$/.test(limpio)) return false;
  const largo = limpio.length;
  if (largo !== 8 && largo !== 12 && largo !== 13 && largo !== 14) return false;

  let suma = 0;
  // De derecha a izquierda SIN contar el verificador: el primero pesa 3 y desde
  // ahí alternan. La regla vale igual para los cuatro largos.
  for (let i = 1; i < largo; i += 1) {
    const digito = Number(limpio[largo - 1 - i]);
    suma += digito * (i % 2 === 1 ? 3 : 1);
  }
  return (10 - (suma % 10)) % 10 === Number(limpio[largo - 1]);
}

// ---------------------------------------------------------------------------
// La aritmética de la línea
// ---------------------------------------------------------------------------

/**
 * Descuadre entre `precio unitario × cantidad` y el total de la línea.
 *
 * Gemelo de `app.line_price_mismatch_minor` (0043). Es la ÚNICA red que atrapa
 * «1 kg» leído donde decía «10 kg» y «$499» donde decía «$4.990».
 *
 * Devuelve `null` —DESCONOCIDO, no cero— cuando falta cualquiera de los datos o
 * cuando la base del precio no habla de la misma dimensión física que la unidad
 * del lote: un pesable chileno imprime $/kg y el lote va en gramos, así que sin
 * la base declarada el chequeo NI SE PUEDE ESCRIBIR.
 *
 * MIDE; jamás corrige. Los tres números son datos leídos.
 */
export function lineMismatchMinor(entrada: {
  readonly unitPriceMinor: bigint | null;
  readonly unitPriceBasis: UnitPriceBasis | null;
  readonly quantity: number | null;
  readonly unit: "G" | "ML" | "UNIT" | null;
  readonly lineTotalMinor: bigint | null;
}): bigint | null {
  const { unitPriceMinor, unitPriceBasis, quantity, unit, lineTotalMinor } = entrada;
  if (
    unitPriceMinor === null ||
    unitPriceBasis === null ||
    quantity === null ||
    unit === null ||
    lineTotalMinor === null
  ) {
    return null;
  }

  // Milésimas para no dividir en punto flotante antes de tiempo: la cantidad
  // llega en gramos/ml/unidades con hasta tres decimales, igual que en la base.
  const milesimas = BigInt(Math.round(quantity * 1000));
  let esperadoMilesimas: bigint;
  if (unitPriceBasis === "PER_KG" && unit === "G") {
    esperadoMilesimas = unitPriceMinor * milesimas / 1000n;
  } else if (unitPriceBasis === "PER_100G" && unit === "G") {
    esperadoMilesimas = unitPriceMinor * milesimas / 100n;
  } else if (unitPriceBasis === "PER_L" && unit === "ML") {
    esperadoMilesimas = unitPriceMinor * milesimas / 1000n;
  } else if (unitPriceBasis === "PER_UNIT" && unit === "UNIT") {
    esperadoMilesimas = unitPriceMinor * milesimas;
  } else {
    // Base y unidad de dimensiones distintas: no hay chequeo posible, y decirlo
    // es la respuesta correcta. Devolver 0 diría "cuadra".
    return null;
  }
  return lineTotalMinor - esperadoMilesimas / 1000n;
}

// ---------------------------------------------------------------------------
// El parser
// ---------------------------------------------------------------------------

const BASES: Readonly<Record<string, UnitPriceBasis>> = {
  PER_KG: "PER_KG",
  PER_L: "PER_L",
  PER_UNIT: "PER_UNIT",
  PER_100G: "PER_100G",
  KG: "PER_KG",
  L: "PER_L",
  UN: "PER_UNIT",
};

const UNIDADES: Readonly<Record<string, "G" | "ML" | "UNIT">> = {
  G: "G",
  GR: "G",
  ML: "ML",
  UNIT: "UNIT",
  UN: "UNIT",
};

/** Un campo que no se pudo leer NO es cero: es `null` con su confianza baja. */
interface CampoLeido {
  readonly valor: string | null;
  readonly confianza: number;
}

function leerMinor(bruto: string): CampoLeido {
  const limpio = bruto.trim();
  if (limpio === "") return { valor: null, confianza: 0 };
  // El separador de miles chileno se saca antes de mirar el número; una coma
  // decimal en una boleta en pesos es un dato roto, no un decimal.
  const sinPuntos = limpio.replace(/\./g, "");
  const leido = parseMinor(sinPuntos);
  if (!leido.ok) return { valor: null, confianza: 0 };
  return { valor: leido.minor.toString(), confianza: 1 };
}

function leerFecha(bruto: string): string | null {
  const limpio = bruto.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(limpio) ? limpio : null;
}

/**
 * Parser de la boleta en texto estructurado (el formato de exportación del
 * comercio y el de la boleta sintética de demo):
 *
 *   COMERCIO: Supermercado Los Aromos
 *   FECHA: 2026-08-20
 *   BOLETA: 1234567
 *   TOTAL: 8.677
 *   --
 *   descripcion;cantidad;unidad;precio;base;total;descuento;codigo
 *   POLLO ENTERO;1340;G;4990;PER_KG;6687;;
 *   ARROZ 1KG;1;UNIT;1990;PER_UNIT;1990;;7801234567890
 *
 * Determinista: el mismo texto da exactamente los mismos candidatos, en el
 * mismo orden. Eso es lo que permite que un segundo pase de extracción se pueda
 * comparar con el primero en vez de adivinar.
 */
export function extractReceiptFromText(
  content: string,
  mimeType: string,
): ReceiptExtractionResult {
  if (!mimeType.startsWith("text/")) {
    return {
      ok: false,
      processorVersion: RECEIPT_PARSER_VERSION,
      error:
        "Este extractor solo lee boletas en texto estructurado. Una foto o un PDF necesitan un " +
        "extractor real: la boleta queda para revisión manual y no se inventa ninguna línea.",
    };
  }

  let merchant: string | null = null;
  let fecha: string | null = null;
  let folio: string | null = null;
  let total: string | null = null;
  const candidates: ReceiptCandidate[] = [];

  for (const bruta of content.split(/\r?\n/)) {
    const linea = bruta.trim();
    if (linea === "" || linea.startsWith("#") || /^-{2,}$/.test(linea)) continue;

    const encabezado = /^([A-Za-zÁÉÍÓÚÑáéíóúñ ]+):\s*(.*)$/.exec(linea);
    if (encabezado !== null) {
      const clave = encabezado[1]!.trim().toUpperCase();
      const valor = encabezado[2]!.trim();
      if (clave === "COMERCIO") merchant = valor === "" ? null : valor;
      else if (clave === "FECHA") fecha = leerFecha(valor);
      else if (clave === "BOLETA" || clave === "FOLIO") folio = valor === "" ? null : valor;
      else if (clave === "TOTAL") total = leerMinor(valor).valor;
      continue;
    }

    const campos = linea.split(";");
    if (campos.length < 6) continue;
    const descripcion = campos[0]!.trim();
    if (descripcion === "" || descripcion.toLowerCase() === "descripcion") continue;

    const cantidadBruta = campos[1]!.trim();
    const cantidad = /^\d+(\.\d+)?$/.test(cantidadBruta) ? cantidadBruta : null;
    const unidad = UNIDADES[campos[2]!.trim().toUpperCase()] ?? null;
    const precio = leerMinor(campos[3]!);
    const base = BASES[campos[4]!.trim().toUpperCase()] ?? null;
    const totalLinea = leerMinor(campos[5]!);
    const descuento = campos.length > 6 ? leerMinor(campos[6]!) : { valor: null, confianza: 0 };
    const codigoBruto = campos.length > 7 ? campos[7]!.trim() : "";
    const codigo = /^[0-9]{8,14}$/.test(codigoBruto) ? codigoBruto : null;
    const codigoValido = eanCheckDigitOk(codigo);

    // Las confianzas se declaran SOLO de los campos que la boleta traía. Un
    // campo ausente no lleva confianza 0 fabricada: lleva su `null` y el
    // servidor lo marca dudoso por "sin total de línea" o por lo que
    // corresponda. Este parser es determinista, así que lo que lee, lo lee bien.
    const confianzas: Partial<Record<ConfidenceField, number>> = {};
    if (cantidad !== null) confianzas.quantity = 1;
    if (precio.valor !== null) confianzas.unit_price = precio.confianza;
    if (totalLinea.valor !== null) confianzas.line_total = totalLinea.confianza;
    if (codigo !== null) confianzas.barcode = codigoValido ? 1 : 0;

    candidates.push({
      raw_line_text: descripcion.slice(0, 500),
      original_snippet: linea.slice(0, 500),
      quantity: cantidad,
      unit: unidad,
      unit_price_minor: precio.valor,
      unit_price_basis: base,
      line_total_minor: totalLinea.valor,
      discount_minor: descuento.valor,
      barcode: codigo,
      // Un barcode que NO valida no es vía de match: se degrada, no se usa con
      // confianza máxima. El servidor vuelve a hacer esta misma degradación
      // porque las guardas no pueden ser disciplina del cliente.
      match_method: codigo !== null && codigoValido ? "BARCODE" : "NONE",
      match_score: codigo !== null && codigoValido ? 1 : null,
      extraction_confidence: 1,
      field_confidences: confianzas,
    });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      processorVersion: RECEIPT_PARSER_VERSION,
      error:
        "No se encontró ninguna línea legible en esta boleta. Revísala a mano: " +
        "una boleta sin líneas no es una compra vacía, es una lectura fallida.",
    };
  }

  return {
    ok: true,
    processorVersion: RECEIPT_PARSER_VERSION,
    header: {
      merchant_name: merchant,
      receipt_date: fecha,
      receipt_number: folio,
      declared_total_minor: total,
      // Si el total no se leyó, se dice UNKNOWN. Nunca 0, que es exactamente
      // como se ve un OCR que no leyó nada.
      total_source: total === null ? "UNKNOWN" : "PRINTED",
    },
    candidates,
  };
}
