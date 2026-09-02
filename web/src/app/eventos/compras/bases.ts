import type { WeightStage, YieldStage } from "@/domain/events/bbq/types";
import type { WeightBasis } from "@/domain/catalog/types";

/**
 * LA TRADUCCIÓN ENTRE LA BASE FÍSICA DE LA BASE DE DATOS Y LAS ETAPAS DEL §12.
 *
 * El defecto que cierra (hallazgo ALTO del lente de física): el neteo del
 * evento contra la despensa hablaba de "base de peso" sin definir la conversión
 * ni propagar el UNKNOWN del lado del stock. Un costillar congelado está
 * guardado en base de COMPRA (con hueso); la sobra de otro asado está en base
 * COCIDA; y la demanda del evento corre por la cadena servible → cocido →
 * crudo comestible → crudo de compra. Restar 2,3 kg con hueso contra una
 * demanda de crudo comestible sobreestima la cobertura, y el error se paga el
 * sábado a las dos de la tarde con carne de menos.
 *
 * Por eso la traducción vive acá, en una tabla que un test puede leer, y no
 * dentro de un `switch` enterrado en un cargador.
 *
 * DE DÓNDE SALE CADA FILA (no son opiniones, son el significado que estas
 * bases YA tienen en este repo):
 *
 *  - `RAW` es el peso de COMPRA. El ShoppingEngine (domain/shopping/engine.ts,
 *    caso "RAW") compra la cantidad tal cual, sin aplicar porción comestible:
 *    o sea, lo que la balanza del súper marca con hueso y cáscara incluidos.
 *  - `EDIBLE_PORTION` es la porción comestible: el mismo motor la divide por
 *    `edible_portion_factor` para llegar al peso de compra, lo que sólo tiene
 *    sentido si ya viene sin hueso ni cáscara. Es exactamente EDIBLE_RAW.
 *  - `COOKED` es peso cocido, que es la etapa COOKED del §12.
 *  - `DRAINED` (atún escurrido) y `AS_PACKAGED` (como se vende el envase) NO
 *    son ninguna de las cuatro etapas: no se sabe cuánto hueso, cuánto líquido
 *    ni cuánta cocción hay dentro de ese número. Van a `null`, el motor las
 *    deja en UNKNOWN y la compra se muestra como rango. Es la respuesta
 *    correcta: el §13 vale para los dos lados de la resta.
 *
 * SERVABLE no aparece nunca acá a propósito: ningún lote se guarda "en peso de
 * plato servido". Es una etapa de la demanda, no del inventario.
 */
export const ETAPA_DE_BASE_FISICA: Record<WeightBasis, WeightStage | null> = {
  RAW: "RAW_PURCHASE",
  EDIBLE_PORTION: "EDIBLE_RAW",
  COOKED: "COOKED",
  DRAINED: null,
  AS_PACKAGED: null,
};

/**
 * Por qué una base no se puede mapear. Se guarda como texto porque la pantalla
 * lo muestra: "no se netea" sin decir por qué se lee como una falla de la app.
 */
export const MOTIVO_BASE_SIN_ETAPA: Partial<Record<WeightBasis, string>> = {
  DRAINED:
    "está pesado escurrido, y ese peso no dice cuánto rinde en la parrilla: no se puede " +
    "restar de la carne que hay que comprar sin inventar un factor.",
  AS_PACKAGED:
    "está pesado como viene el envase, con líquido y con lo que no se come adentro: ese peso " +
    "no se puede convertir a peso de compra sin inventar un factor.",
};

/**
 * El par (etapa de entrada, etapa de salida) de una observación del hogar se
 * traduce a UN tramo de la cadena, y sólo si son etapas CONTIGUAS.
 *
 * `household_observed_yields` guarda desde la 0041 `basis_in`/`basis_out`. Un
 * par contiguo —EDIBLE_RAW → COOKED— es un factor de cocción y sirve. Un par
 * saltado —RAW_PURCHASE → COOKED— mezcla hueso, desgrase y cocción en un solo
 * número: componerlo con el factor de hueso de la ficha del corte descuenta la
 * misma merma dos veces (la compra se infla ~25 %). Ese par devuelve `null` y
 * la observación queda fuera del estimador: sigue siendo historia, no señal.
 *
 * Y con `null` en cualquiera de los dos lados (todas las filas anteriores a la
 * 0041) también sale `null`, porque la 0015 nunca preguntó qué medía ese peso.
 */
export function tramoDeObservacion(
  entrada: WeightStage | null,
  salida: WeightStage | null,
): YieldStage | null {
  if (entrada === null || salida === null) return null;
  if (entrada === "RAW_PURCHASE" && salida === "EDIBLE_RAW") return "RAW_PURCHASE_TO_EDIBLE_RAW";
  if (entrada === "EDIBLE_RAW" && salida === "COOKED") return "EDIBLE_RAW_TO_COOKED";
  if (entrada === "COOKED" && salida === "SERVABLE") return "COOKED_TO_SERVABLE";
  return null;
}

/**
 * La base de COMPRA de una línea de compra del evento.
 *
 * El motor entrega `purchaseRequired` en la etapa RAW_PURCHASE —es lo que hay
 * que pedirle a la carnicería— y la base de compra que representa esa etapa en
 * `shopping_list_items` es `RAW`. Está escrito acá, con nombre, porque de esta
 * constante depende que el ProcurementEngine netee la línea del evento contra
 * la necesidad del proveedor: su clave de neteo es (alimento, unidad, base), y
 * una línea escrita en otra base se compraría DOS veces, una en el súper y otra
 * al proveedor.
 */
export const BASE_DE_COMPRA_DEL_EVENTO = "RAW" as const;
