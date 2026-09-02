import {
  CURRENCY_UNITS,
  MoneyError,
  UNKNOWN_REASON_PRECEDENCE,
  atLeastAmount,
  money,
  type CurrencyCode,
  type KnownSubtotal,
  type MissingValue,
  type Money,
  type MoneyOrUnknown,
  type UnknownReason,
} from "@/domain/finance/money";

/**
 * Sprint 14 — CÓMO SE ESCRIBE UN MONTO SIN MENTIR.
 *
 * Este archivo y `<Monto>` son el único camino de un `bigint` a un pixel. Están
 * separados de las primitivas de `ui.tsx` porque no son decoración: son las
 * cuatro ramas que un monto puede tener en pantalla, y omitir cualquiera de
 * ellas es la falla más cara de la app.
 *
 *   CONOCIDO      «$25.000»                  hay un número y es cierto.
 *   DESCONOCIDO   «Valor desconocido: …»     NO es $0 (regla dura del sprint).
 *   ERROR         «No pudimos cargar …»      la consulta falló. NO es $0.
 *   SIN PERMISO   «No tienes permiso …»      [H17] RLS devuelve CERO FILAS a
 *                 quien no tiene FINANCE_VIEW, y un loader que suma cero filas
 *                 pinta «$0 gastado»: indistinguible de un hogar que no gastó
 *                 nada. La cuarta rama existe porque el vacío por permiso no lo
 *                 atrapa el test que vigila `DataAccessError`.
 *
 * NADA DE `Intl.NumberFormat` sobre el monto: su `format()` tipado recibe
 * `number | bigint`, y para una moneda con decimales habría que dividir el
 * entero — o sea meter la coma flotante justo en el último paso. Acá el
 * agrupado se arma con texto sobre el `bigint`, exacto por construcción.
 */

interface FormatoMoneda {
  readonly simbolo: string;
  readonly separadorMiles: string;
  readonly separadorDecimal: string;
  /** El símbolo va pegado al número (CLP: «$1.000») o separado («US$ 10,00»). */
  readonly pegado: boolean;
}

const FORMATOS: Readonly<Record<CurrencyCode, FormatoMoneda>> = {
  CLP: { simbolo: "$", separadorMiles: ".", separadorDecimal: ",", pegado: true },
  USD: { simbolo: "US$", separadorMiles: ".", separadorDecimal: ",", pegado: false },
  EUR: { simbolo: "€", separadorMiles: ".", separadorDecimal: ",", pegado: false },
};

function agrupar(digitos: string, separador: string): string {
  let salida = "";
  for (let i = 0; i < digitos.length; i += 1) {
    const desdeElFinal = digitos.length - i;
    if (i > 0 && desdeElFinal % 3 === 0) salida += separador;
    salida += digitos[i];
  }
  return salida;
}

/**
 * `Money` → texto. La ÚNICA función que produce un monto pintable.
 *
 * No acepta `KnownSubtotal` a propósito ([H23]): ese tipo tiene `kind` y
 * `minorAtLeast` en vez de `minor`, así que no encaja acá ni por estructura ni
 * por accidente. Para mostrarlo hay que pasar por `formatAtLeast`, que exige la
 * lista de faltantes.
 */
export function formatMoney(m: Money): string {
  const f = FORMATOS[m.currency];
  const exponente = CURRENCY_UNITS[m.currency].minorExponent;
  const negativo = m.minor < 0n;
  const magnitud = (negativo ? -m.minor : m.minor).toString();

  let cuerpo: string;
  if (exponente === 0) {
    cuerpo = agrupar(magnitud, f.separadorMiles);
  } else {
    const rellenado = magnitud.padStart(exponente + 1, "0");
    const corte = rellenado.length - exponente;
    cuerpo =
      agrupar(rellenado.slice(0, corte), f.separadorMiles) +
      f.separadorDecimal +
      rellenado.slice(corte);
  }
  const signo = negativo ? "−" : "";
  return f.pegado ? `${signo}${f.simbolo}${cuerpo}` : `${signo}${f.simbolo} ${cuerpo}`;
}

/** Con el signo `+` explícito adelante: para variaciones (caja − consumo). */
export function formatDelta(m: Money): string {
  if (m.minor > 0n) return `+${formatMoney(m)}`;
  return formatMoney(m);
}

/**
 * Por qué no se sabe, en español chileno y accionable.
 *
 * Cada texto nombra la CAUSA, no el síntoma: «faltan precios» sin decir de qué
 * es tan inarreglable como no decir nada.
 */
const MOTIVOS: Readonly<Record<UnknownReason, string>> = {
  NO_PRICE_RECORDED: "nunca se registró un precio para esto",
  LOT_VALUE_UNKNOWN: "este lote entró a la despensa sin boleta",
  MIXED_UNKNOWN_MERGE: "se juntó con otro lote que no tenía valor conocido",
  CONSUMPTION_WITHOUT_LOT: "se consumió sin un lote de origen al que cobrarle",
  NOT_YET_RECOGNIZED: "la boleta todavía no llega",
  UNIT_NOT_NORMALIZABLE: "no se puede llevar a precio por kilo sin inventar un peso",
  POLICY_NOT_APPLICABLE: "no se pudo repartir el costo con estos datos",
};

export function describeUnknown(reason: UnknownReason): string {
  return MOTIVOS[reason];
}

/**
 * De varios motivos, el que se le muestra a la persona: el MÁS ACCIONABLE.
 *
 * Elegir «el primero que vino» haría que la misma despensa mostrara mensajes
 * distintos según el orden en que la base devolvió las filas. La precedencia
 * está declarada en `money.ts` y es la misma que usa la suma del dominio.
 */
export function motivoDominante(motivos: readonly UnknownReason[]): UnknownReason {
  for (const candidato of UNKNOWN_REASON_PRECEDENCE) {
    if (motivos.includes(candidato)) return candidato;
  }
  // Lista vacía: no se sabe POR QUÉ no se sabe. Se dice eso, no se inventa una
  // causa que mandaría a la persona a arreglar lo que no está roto.
  return "POLICY_NOT_APPLICABLE";
}

/**
 * El estado COMPLETO de un monto en pantalla.
 *
 * `ERROR` y `SIN_PERMISO` no son variantes de `MoneyOrUnknown` porque no son
 * hechos del dinero: son hechos de la CARGA. Mezclarlos ahí haría que un motor
 * puro tuviera que hablar de permisos y de PostgREST.
 */
export type MontoEstado =
  | { readonly estado: "DATO"; readonly valor: MoneyOrUnknown }
  | { readonly estado: "ERROR"; readonly que: string }
  | { readonly estado: "SIN_PERMISO" };

export interface MontoVista {
  readonly rama: "CONOCIDO" | "DESCONOCIDO" | "ERROR" | "SIN_PERMISO";
  /** Lo que se pinta grande. En las tres ramas que no son CONOCIDO, NUNCA un número. */
  readonly texto: string;
  /** La explicación al lado. Siempre presente salvo en CONOCIDO. */
  readonly detalle: string | null;
}

/**
 * La decisión de qué se pinta, separada del JSX para que se pueda probar en
 * Node sin montar un DOM. `<Monto>` no decide nada: lee esto.
 */
export function describeMonto(m: MontoEstado): MontoVista {
  if (m.estado === "ERROR") {
    return {
      rama: "ERROR",
      texto: "No pudimos cargarlo",
      detalle: `Falló la consulta de ${m.que}. Reintenta en un momento.`,
    };
  }
  if (m.estado === "SIN_PERMISO") {
    return {
      rama: "SIN_PERMISO",
      texto: "Sin permiso",
      detalle: "No tienes permiso para ver los montos de este hogar.",
    };
  }
  if (m.valor.known) {
    return { rama: "CONOCIDO", texto: formatMoney(m.valor.amount), detalle: null };
  }
  return {
    rama: "DESCONOCIDO",
    texto: "Valor desconocido",
    detalle: describeUnknown(m.valor.reason),
  };
}

export interface VistaAlMenos {
  /** «al menos» va en la tipografía del número, no en una nota al pie (§7.4). */
  readonly prefijo: "al menos";
  readonly texto: string;
  readonly faltan: readonly MissingValue[];
  /** «3 productos sin precio: pollo entero, cilantro, pan amasado» */
  readonly detalle: string;
}

/**
 * Un subtotal se pinta SOLO junto a lo que le falta, y nombrándolo.
 *
 * `atLeastAmount` revienta si la lista no calza con lo que el subtotal declara:
 * eso ataja el caso de mostrar «al menos $X» con los faltantes de otra
 * consulta, que se vería perfectamente bien y sería falso.
 */
export function formatAtLeast(
  subtotal: KnownSubtotal,
  missing: readonly MissingValue[],
): VistaAlMenos {
  const monto = atLeastAmount(subtotal, missing);
  const nombres = missing.map((f) => f.label);
  const cuantos = missing.length;
  const detalle =
    cuantos === 0
      ? "No falta ningún precio."
      : `${cuantos} ${cuantos === 1 ? "producto" : "productos"} sin precio: ${nombres.join(", ")}`;
  return { prefijo: "al menos", texto: formatMoney(monto), faltan: missing, detalle };
}

export interface FaltantesContados {
  readonly cuantos: number;
  /** Cómo se llaman en pantalla: «movimientos sin costear», «cargos sin asignar». */
  readonly que: string;
  readonly motivo: UnknownReason;
}

export interface VistaAlMenosContada {
  readonly prefijo: "al menos";
  readonly texto: string;
  readonly faltan: FaltantesContados;
  readonly detalle: string;
}

/**
 * «Al menos» cuando lo que falta se sabe CONTADO y no NOMBRADO.
 *
 * `formatAtLeast` exige la lista de faltantes con identidad, y para la
 * proyección de la compra eso es lo correcto: son productos que la persona
 * puede ir a mirar uno por uno. Pero las cifras del período salen de vistas
 * AGREGADAS (`finance_period_accruals`, `unknown_value_inventory`), donde la
 * granularidad que existe de verdad es «3 asignaciones sin costear, motivo
 * LOT_VALUE_UNKNOWN». Inventarles un `id` y un `label` a esas tres filas para
 * poder pasar por `formatAtLeast` sería fabricar identidad —exactamente lo que
 * `MissingValue` existe para impedir—, y renderizarlas con `formatMoney` a
 * secas sería pintar un subtotal disfrazado de total.
 *
 * El peaje se mantiene: hay que declarar CUÁNTOS faltan y el número tiene que
 * calzar con lo que el subtotal dice, o revienta. Y con cero faltantes también
 * revienta: eso no es un «al menos», es un total, y va por `<Monto>`.
 */
export function formatAtLeastCounted(
  subtotal: KnownSubtotal,
  faltan: FaltantesContados,
): VistaAlMenosContada {
  if (faltan.cuantos !== subtotal.missingCount) {
    throw new MoneyError(
      "SUBTOTAL_SIN_FALTANTES",
      `este subtotal declara ${subtotal.missingCount} faltantes y se contaron ${faltan.cuantos}`,
    );
  }
  if (faltan.cuantos <= 0) {
    throw new MoneyError(
      "SUBTOTAL_SIN_FALTANTES",
      "«al menos» sin faltantes es un total: se muestra con <Monto>, no con este formato",
    );
  }
  return {
    prefijo: "al menos",
    texto: formatMoney(money(subtotal.currency, subtotal.minorAtLeast)),
    faltan,
    detalle: `${faltan.cuantos} ${faltan.que}: ${describeUnknown(faltan.motivo)}`,
  };
}
