import type {
  BbqCutPlan,
  BbqQuantityResult,
  Range,
  RangeOrUnknown,
} from "@/domain/events/bbq/types";
import { BASE_DE_COMPRA_DEL_EVENTO } from "./bases";

/**
 * DE LA ESTIMACIÓN A LA LISTA DE COMPRAS. Función PURA: sin base, sin reloj.
 *
 * Lo que hace y lo que NO hace:
 *
 *  - NO vuelve a calcular nada. La cantidad a comprar la decidió el motor
 *    `bbq-quantity` y ya viene neteada contra la despensa y expresada en la
 *    etapa RAW_PURCHASE. Acá sólo se AGRUPA por identidad de alimento y se le
 *    pone la ropa de una línea de compra.
 *  - NO redondea a presentación comercial. Eso es del ProcurementEngine (§28) y
 *    tener dos redondeos daría dos números distintos para la misma compra.
 *  - NO convierte un desconocido en cero. Si el motor no pudo estimar un corte,
 *    la línea sale marcada `sinCantidad` con el motivo escrito, que en
 *    `shopping_list_items` es exactamente lo que significan `unresolved` y
 *    `unresolved_reason`.
 *
 * POR QUÉ SE AGRUPA POR IDENTIDAD Y NO POR ITEM DE MENÚ: la clave de línea
 * (`line_key`) es única por lista, y dos renglones del menú pueden apuntar al
 * mismo alimento ("sobrecostilla para la parrilla" y "sobrecostilla al vacío").
 * Si cada uno escribiera su propia línea con la misma clave, la segunda
 * PISARÍA a la primera y se compraría la mitad de la carne. Agrupadas, la
 * línea pide la suma y la procedencia detalla los dos renglones.
 */

/** La identidad real del corte, que el resultado del motor ya no distingue. */
export interface IdentidadDeItem {
  itemId: string;
  ingredientId: string | null;
  productId: string | null;
}

/**
 * Una entrada de procedencia de una línea nacida de un evento.
 *
 * Es una forma DISTINTA de la procedencia del plan semanal ({assignmentId,
 * date, mealType, members}) y por eso lleva `kind`: la lista de compras muestra
 * "por qué necesito esto" leyendo este arreglo, y un asado no tiene ni
 * asignación ni tipo de comida que mostrar. Sin el discriminante, la pantalla
 * leería `p.mealType` como `undefined` y dibujaría una fila en blanco.
 */
export interface ProcedenciaEvento {
  kind: "EVENT";
  eventId: string;
  title: string;
  date: string;
  itemId: string;
  cut: string;
  /** Gramos de compra que aporta este corte. `null` = el motor no pudo estimarlo. */
  quantity: number | null;
  min: number | null;
  max: number | null;
}

export interface LineaCompraEvento {
  lineKey: string;
  ingredientId: string | null;
  productId: string | null;
  label: string;
  unit: "G";
  purchaseBasis: typeof BASE_DE_COMPRA_DEL_EVENTO;
  /**
   * Gramos de PESO DE COMPRA. `null` = ningún corte de esta línea se pudo
   * estimar. Nunca 0 por desconocimiento: 0 en una lista de compras es la
   * instrucción "no compres nada", que es una mentira con consecuencias.
   */
  cantidad: number | null;
  /** El rango completo, para que la pantalla no muestre un número seco (§27). */
  rango: Range | null;
  /** true = a esta línea le falta al menos un corte por estimar. */
  sinCantidad: boolean;
  motivo: string | null;
  procedencia: ProcedenciaEvento[];
}

export interface PlanDeCompraDelEvento {
  lineas: LineaCompraEvento[];
  /** §33: "necesitamos X servibles / tenemos Y / comprar Z". */
  resumen: {
    servible: Range;
    /** Gramos de despensa que el motor pudo netear (etapa de compra). */
    inventarioNeteado: number;
    /**
     * Gramos que existen en la despensa pero cuya base física no se pudo
     * convertir. NO se restaron de la compra y se muestran aparte: son kilos
     * de verdad de los que no se puede afirmar cuánto llega al plato.
     */
    inventarioSinBase: number;
    compra: RangeOrUnknown;
  };
  /** Cortes que no se pueden comprar bien porque les falta identidad. */
  avisos: string[];
}

/** Identidad de compra: el alimento manda; si no hay, el producto; si no, el item. */
function identidadDe(id: IdentidadDeItem): string {
  if (id.ingredientId !== null) return `ing:${id.ingredientId}`;
  if (id.productId !== null) return `prod:${id.productId}`;
  return `item:${id.itemId}`;
}

function sumarRango(a: Range, b: Range): Range {
  return { min: a.min + b.min, base: a.base + b.base, max: a.max + b.max };
}

function redondear(valor: number): number {
  return Math.round(valor * 1000) / 1000;
}

function procedenciaDe(
  evento: { eventoId: string; titulo: string; fecha: string },
  corte: BbqCutPlan,
  valor: Range | null,
): ProcedenciaEvento {
  return {
    kind: "EVENT",
    eventId: evento.eventoId,
    title: evento.titulo,
    date: evento.fecha,
    itemId: corte.itemId,
    cut: corte.displayName,
    quantity: valor === null ? null : redondear(valor.base),
    min: valor === null ? null : redondear(valor.min),
    max: valor === null ? null : redondear(valor.max),
  };
}

export function planDeCompraDelEvento(entrada: {
  eventoId: string;
  titulo: string;
  fecha: string;
  salida: BbqQuantityResult;
  identidades: readonly IdentidadDeItem[];
}): PlanDeCompraDelEvento {
  const { eventoId, titulo, fecha, salida } = entrada;
  const porItem = new Map(entrada.identidades.map((i) => [i.itemId, i]));

  const acumulado = new Map<
    string,
    {
      identidad: IdentidadDeItem;
      label: string;
      rango: Range | null;
      faltantes: string[];
      procedencia: ProcedenciaEvento[];
    }
  >();
  const avisos: string[] = [];
  let inventarioNeteado = 0;
  let inventarioSinBase = 0;

  for (const corte of salida.byCut) {
    const identidad = porItem.get(corte.itemId);
    if (identidad === undefined) {
      // La revisión congelada nombra un item de menú que ya no existe. No se
      // inventa una identidad para poder comprarlo: se dice, porque comprar a
      // ciegas para un renglón borrado es peor que no comprarlo.
      avisos.push(
        `"${corte.displayName}" venía en la estimación pero ya no está en el menú: ` +
          "vuelve a calcular antes de mandar esto a la compra.",
      );
      continue;
    }
    if (identidad.ingredientId === null && identidad.productId === null) {
      avisos.push(
        `"${corte.displayName}" no tiene un alimento del catálogo asociado: la línea se agrega ` +
          "igual para que no falte, pero el proveedor no puede netearla contra lo que ya pediste.",
      );
    }

    if (corte.inventoryToUse.known) {
      inventarioNeteado += corte.inventoryToUse.grams;
    } else {
      inventarioSinBase += corte.inventoryToUse.faceValueGrams;
    }

    const clave = identidadDe(identidad);
    const previo = acumulado.get(clave) ?? {
      identidad,
      label: corte.displayName,
      rango: null,
      faltantes: [],
      procedencia: [],
    };

    const compra = corte.purchaseRequired;
    if (compra.known) {
      previo.rango = previo.rango === null ? compra.value : sumarRango(previo.rango, compra.value);
      previo.procedencia.push(procedenciaDe({ eventoId, titulo, fecha }, corte, compra.value));
    } else {
      previo.faltantes.push(corte.displayName);
      previo.procedencia.push(procedenciaDe({ eventoId, titulo, fecha }, corte, null));
    }
    acumulado.set(clave, previo);
  }

  const lineas: LineaCompraEvento[] = [...acumulado.entries()].map(([clave, acc]) => ({
    // La clave lleva el evento adelante para que no choque jamás con una línea
    // del plan semanal, y la identidad + unidad + base atrás porque es lo que
    // hace que "volver a mandar a comprar" ACTUALICE la línea en vez de crear
    // una segunda. El índice único (list_id, line_key) es el árbitro (§92).
    lineKey: `event:${eventoId}::${clave}::G::${BASE_DE_COMPRA_DEL_EVENTO}`,
    ingredientId: acc.identidad.ingredientId,
    productId: acc.identidad.productId,
    label: acc.label,
    unit: "G" as const,
    purchaseBasis: BASE_DE_COMPRA_DEL_EVENTO,
    cantidad: acc.rango === null ? null : redondear(acc.rango.base),
    rango: acc.rango,
    sinCantidad: acc.faltantes.length > 0,
    motivo:
      acc.faltantes.length === 0
        ? null
        : acc.rango === null
          ? `No se pudo estimar cuánto comprar de ${acc.faltantes.join(", ")}: falta el ` +
            "rendimiento de ese corte. La cantidad la tienes que poner tú."
          : `La cantidad cubre sólo parte de esta línea: falta estimar ${acc.faltantes.join(", ")}, ` +
            "que no tiene rendimiento anotado.",
    procedencia: acc.procedencia,
  }));

  // Orden estable por clave: dos corridas con los mismos datos escriben las
  // mismas líneas en el mismo orden, y el diff de la lista no baila solo.
  lineas.sort((a, b) => a.lineKey.localeCompare(b.lineKey));

  return {
    lineas,
    resumen: {
      servible: salida.totalServableDemand,
      inventarioNeteado: redondear(inventarioNeteado),
      inventarioSinBase: redondear(inventarioSinBase),
      compra: salida.totalPurchaseRequired,
    },
    avisos,
  };
}

/* -------------------------------------------------------------------------- */
/* Sobrante DESPUÉS del redondeo comercial                                     */
/* -------------------------------------------------------------------------- */

/**
 * El defecto que cierra: el motor rotula su `expectedLeftovers` como "antes de
 * presentación comercial" —y hace bien, porque el redondeo vive río abajo en el
 * ProcurementEngine (§28)—. Pero el hogar no compra "8,4 kg": compra dos cajas
 * de 5 y se lleva 10. Esos 1,6 kg de más terminan en la mesa o en el
 * congelador, y si la pantalla de compras no los cuenta, la estimación dice
 * "sobrará ~0,9 kg" mientras la lista dice "10 kg" y los dos números se
 * contradicen a ojos de quien los mira. Peor: el aprendizaje le echaría al
 * apetito de los invitados una sobra que causó la caja de 5 kg.
 *
 * Acá se DERIVA el sobrante final. No es un segundo motor: es la resta entre lo
 * que se va a comprar de verdad y lo que el motor recomendó, convertida a la
 * base del sobrante estimado con LOS MISMOS FACTORES que el motor ya publicó en
 * `chain`.
 *
 * Y JAMÁS se suman gramos de compra con gramos servibles. El extra viene en
 * peso de compra (con hueso, con lo que se pierde al cocinar) y el sobrante del
 * motor viene en peso servible: sumarlos de frentón es la resta ilegal de
 * siempre. Si a un corte le falta un tramo de la cadena, su extra NO se
 * convierte y el total se declara como piso.
 */
export type SobranteFinal =
  | {
      conocido: true;
      /** Sobrante servible estimado, ya con el redondeo comercial adentro. */
      rango: Range;
      /** Gramos de compra comprometidos por encima de lo recomendado. */
      extraDeCompra: number;
    }
  | {
      conocido: false;
      /** Lo que sí se pudo convertir, como piso. */
      alMenos: Range;
      motivo: string;
      cortesSinCadena: string[];
    };

/**
 * @param comprometido gramos de compra que la lista pide HOY, por item de menú.
 *   Es lo que se va a comprar de verdad: la cantidad redondeada por el
 *   proveedor, o la que la persona editó a mano (§79).
 */
export function sobranteDespuesDelRedondeo(
  salida: BbqQuantityResult,
  comprometido: Readonly<Record<string, number>>,
): SobranteFinal {
  let extraServable: Range = { min: 0, base: 0, max: 0 };
  let extraDeCompra = 0;
  const sinCadena: string[] = [];

  for (const corte of salida.byCut) {
    const compradoG = comprometido[corte.itemId];
    if (compradoG === undefined) continue;
    if (!corte.purchaseRequired.known) {
      // No hay contra qué comparar: no se sabe cuánto era lo recomendado, así
      // que tampoco cuánto de lo comprado es "de más".
      sinCadena.push(corte.displayName);
      continue;
    }
    const extra = compradoG - corte.purchaseRequired.value.base;
    if (extra <= 0) continue;
    extraDeCompra += extra;

    const factores = new Map(corte.chain.map((c) => [c.stage, c.factor]));
    const hueso = factores.get("RAW_PURCHASE_TO_EDIBLE_RAW") ?? null;
    const coccion = factores.get("EDIBLE_RAW_TO_COOKED") ?? null;
    const servible = factores.get("COOKED_TO_SERVABLE") ?? null;
    if (hueso === null || coccion === null || servible === null) {
      sinCadena.push(corte.displayName);
      continue;
    }
    const enPlato = extra * hueso * coccion * servible;
    extraServable = {
      min: extraServable.min + enPlato,
      base: extraServable.base + enPlato,
      max: extraServable.max + enPlato,
    };
  }

  const base = salida.expectedLeftovers.range;
  const total: Range = {
    min: redondear(base.min + extraServable.min),
    base: redondear(base.base + extraServable.base),
    max: redondear(base.max + extraServable.max),
  };

  if (sinCadena.length > 0) {
    return {
      conocido: false,
      alMenos: total,
      motivo:
        "Vas a comprar más de lo recomendado, pero de " +
        `${sinCadena.join(", ")} no hay rendimiento anotado: no se puede decir cuánto de esa ` +
        "carne de más llega al plato. Lo que ves es el piso, no el total.",
      cortesSinCadena: sinCadena,
    };
  }

  return { conocido: true, rango: total, extraDeCompra: redondear(extraDeCompra) };
}
