import type {
  BbqConfidence,
  BbqInventoryUse,
  BbqReasonCode,
  Range,
  RangeOrUnknown,
} from "@/domain/events/bbq/types";
import { SIN_INFORMACION } from "./vocabulario";

/**
 * Cómo se ESCRIBEN los números del evento.
 *
 * Está separado de las pantallas porque son las reglas que más fácil se rompen
 * al copiar y pegar un componente, y porque son las únicas piezas de esta
 * superficie que se pueden probar sin navegador: acá viven los tests que
 * impiden que un desconocido se muestre como cero y que una resta cruce dos
 * bases físicas distintas.
 *
 * Todo en español chileno neutro y con la coma decimal de acá.
 */

/** Un número con coma decimal, sin decimales de adorno. */
function numero(valor: number, decimales: number): string {
  return valor.toLocaleString("es-CL", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

/**
 * Gramos a texto. Bajo el kilo se muestran gramos enteros; sobre el kilo, un
 * decimal — "9,4 kg" es lo que una persona lee en la balanza del súper, y
 * "9,43 kg" es precisión que la estimación no tiene.
 */
export function formatearGramos(gramos: number): string {
  if (!Number.isFinite(gramos)) return SIN_INFORMACION;
  if (gramos < 1000) return `${numero(Math.round(gramos), 0)} g`;
  return `${numero(gramos / 1000, 1)} kg`;
}

/**
 * Un rango se muestra COMO RANGO. El centro va entre paréntesis y con "≈"
 * adelante: es una referencia, no el número exacto que hay que comprar.
 */
export function formatearRango(rango: Range): string {
  if (rango.min === rango.max) return formatearGramos(rango.base);
  const min = rango.min < 1000 ? numero(Math.round(rango.min), 0) : numero(rango.min / 1000, 1);
  return `${min}–${formatearGramos(rango.max)} (≈${formatearGramos(rango.base)})`;
}

/**
 * Qué tan ancho es el rango respecto de su centro. Sirve para decirle a la
 * persona que la estimación es amplia SIN hacerla calcular: un rango de
 * 6–14 kg y uno de 9,5–10,5 kg no se pueden mostrar igual.
 *
 * Devuelve `null` cuando el centro es cero: dividir por cero para inventar un
 * porcentaje sería el mismo pecado que se está evitando.
 */
export function anchoRelativo(rango: Range): number | null {
  if (rango.base === 0) return null;
  return (rango.max - rango.min) / rango.base;
}

/** Sobre este ancho, la pantalla avisa que la estimación es amplia. */
export const ANCHO_AMPLIO = 0.4;

/**
 * El texto de una cantidad que PUEDE ser desconocida.
 *
 * Cuando el motor dijo "no puedo estimar este corte", la pantalla lo dice con
 * esas palabras y muestra el motivo. No rellena, no pone un guión, no pone
 * cero: un cero acá significa "no compres nada" y es una instrucción falsa.
 */
export function formatearCantidad(cantidad: RangeOrUnknown): string {
  return cantidad.known
    ? formatearRango(cantidad.value)
    : `No se puede estimar — ${TEXTO_MOTIVO[cantidad.reason]}`;
}

/**
 * Lo que sale de la despensa.
 *
 * El caso interesante es el segundo: el lote EXISTE y pesa lo que pesa, pero su
 * base física no se puede mapear (un "crudo" que no dice si es de compra o ya
 * limpio, un envase sin escurrir). Ahí hay kilos de verdad y aun así no se
 * puede afirmar cuántos llegan al plato — se muestran los dos hechos y no se
 * netea nada.
 */
export function formatearInventario(uso: BbqInventoryUse): string {
  if (uso.known) return formatearGramos(uso.grams);
  return `${formatearGramos(uso.faceValueGrams)} guardados, pero no se pueden descontar — ${
    TEXTO_MOTIVO[uso.reason]
  }`;
}

/**
 * El motivo de un desconocido, en castellano.
 *
 * El motor entrega CÓDIGOS y no frases —para poder auditarlos y traducirlos—,
 * así que el texto vive de este lado. Están todos: un código sin texto sería
 * exactamente el "error genérico" que este proyecto no acepta, y TypeScript no
 * deja agregar uno al motor sin escribir acá qué significa.
 */
export const TEXTO_MOTIVO: Record<BbqReasonCode, string> = {
  BASE_POLICY: "cantidad base de la política",
  HEADCOUNT_MIX: "mezcla de adultos y niños",
  ATTENDANCE_UNCERTAIN: "hay gente que todavía no confirma",
  AGE_UNKNOWN: "no sabemos la edad de algunas personas",
  APPETITE_KNOWN: "apetito declarado",
  APPETITE_UNKNOWN: "no sabemos cuánto comen algunas personas",
  ANTHROPOMETRIC_ADJUST: "ajuste por datos de tamaño entregados",
  MEAL_CONTEXT_APPLIED: "qué comida del día es",
  MEAL_CONTEXT_UNKNOWN: "no está declarado qué comida del día es",
  SIDES_APPLIED: "nivel de acompañamientos declarado",
  SIDES_UNKNOWN: "no está declarado cuántos acompañamientos habrá",
  DURATION_LONG: "el evento dura varias horas",
  DURATION_UNKNOWN: "no está declarada la duración",
  GROUP_BAND: "tamaño del grupo",
  DESIRED_LEFTOVER: "sobrante que pediste",
  EXTRA_MEAL_PEOPLE_UNKNOWN: "no se sabe para cuántos es la comida extra",
  SAFETY_BUFFER: "margen por si acaso",
  SAFETY_BUFFER_NOT_SET: "no declaraste margen por si acaso",
  DISTRIBUTION_PCT: "reparto por porcentaje",
  DISTRIBUTION_AUTO: "reparto automático entre los cortes",
  DISTRIBUTION_PCT_INVALID: "los porcentajes del reparto no suman 100",
  DISTRIBUTION_SEGMENTED: "reparto separado por restricciones de los invitados",
  MENU_CATEGORY_UNKNOWN: "hay items del menú sin categoría",
  NO_MEAT_ITEMS: "no hay carnes en el menú",
  NO_COMPATIBLE_ITEM: "hay gente sin nada que pueda comer en este menú",
  DIETARY_INFO_MISSING: "hay personas sin información de restricciones",
  // Los dos de abajo se dicen en CONTEO y sin nombres: de quién es la
  // restricción no se cuenta en una pantalla que se pasa de mano en mano.
  RECORDED_RESTRICTIONS_APPLIED: "hay restricciones ya registradas en la aplicación",
  ALLERGY_ITEM_EXCLUDED: "un plato quedó fuera por una alergia registrada",
  ALLERGY_REVIEW_REQUIRED: "una alergia reportada necesita revisión",
  OTHER_DIETARY_NOTE_REVIEW: "una restricción sin clasificar necesita revisión",
  YIELD_CHAIN_COMPLETE: "cadena de rendimientos completa",
  YIELD_UNKNOWN: "no tenemos el rendimiento de este corte",
  YIELD_STAGE_CONFLICT: "dos fuentes dan rendimientos distintos para el mismo tramo",
  YIELD_STAGE_NOT_OWNED: "la fuente no manda en ese tramo de la cadena",
  OBSERVED_YIELD_BLENDED: "se mezcló lo observado en la casa con la referencia",
  OBSERVED_YIELD_SOLE_SOURCE: "solo hay observaciones de la casa",
  OBSERVED_YIELD_IGNORED: "las observaciones de la casa son pocas todavía",
  INVENTORY_NETTED: "se descontó lo que ya tienes",
  INVENTORY_YIELD_UNKNOWN: "no se sabe cuánto rinde lo que tienes guardado",
  INVENTORY_FROZEN: "parte de lo que tienes está congelado",
  EQUIPMENT_CAPACITY_UNKNOWN: "no está declarada la capacidad de la parrilla",
  EQUIPMENT_UNIT_MISMATCH: "la capacidad de la parrilla está en otra unidad",
  BATCHES_RANGE: "las tandas dependen de cuánto se compre",
  BATCHES_FROM_ACCEPTED_PLAN: "tandas calculadas sobre el plan que aceptaste",
  LEFTOVERS_BEFORE_ROUNDING: "sobrante calculado antes del formato de venta",
  PURCHASE_UNKNOWN_TOTAL: "falta el rendimiento de al menos un corte",
};

export const TEXTO_CONFIANZA: Record<BbqConfidence, string> = {
  HIGH: "Estimación con buena información",
  MEDIUM: "Estimación con información parcial",
  LOW: "Estimación con poca información",
};

/**
 * La confianza también se dice con palabras y no solo con color: el semáforo
 * verde/amarillo/rojo no lo distingue todo el mundo, y acá decide una compra.
 */
export const TONO_CONFIANZA: Record<BbqConfidence, "primario" | "atencion" | "peligro"> = {
  HIGH: "primario",
  MEDIUM: "atencion",
  LOW: "peligro",
};

/**
 * Cómo se lee la asistencia real. PERSONA POR PERSONA.
 *
 * El caso normal de un asado es que NADIE pase lista: el anfitrión está en la
 * parrilla. Cero marcas NO significa que no llegó nadie — significa que no se
 * registró. Mostrar "0 asistieron" sobre doce confirmados es una señal
 * catastrófica que ningún dato respalda, y además envenena el aprendizaje.
 *
 * Y hay un tercer caso que antes se veía igual que el conteo completo: la lista
 * A MEDIAS. El anfitrión marca a los tres primeros que llegan y vuelve a la
 * parrilla; el guardia viejo miraba el EVENTO ("¿hay alguna marca?") y con eso
 * daba por cerrada la lista, así que los otros nueve —que sí llegaron— pasaban
 * a contarse como ausentes y el número salía rotulado como HECHO. Acá cada
 * persona cuenta por sí misma: quien no tiene marca no llegó ni faltó, está SIN
 * MIRAR, y eso se dice.
 */
export interface ResumenAsistencia {
  estado: "COMPLETA" | "PARCIAL" | "NO_REGISTRADA";
  texto: string;
  /** Cuántas personas se cuentan para lo que se muestra abajo. */
  personas: number;
  /** `true` cuando el número de arriba es una estimación, no un conteo real. */
  esEstimacion: boolean;
  /** Confirmados que nadie marcó. NO son ausentes: son gente sin mirar. */
  sinMarcar: number;
}

export function resumenAsistencia(entrada: {
  llegaron: number;
  noLlegaron: number;
  /** Confirmados SIN marca. El dato es por persona, no un total del evento. */
  sinMarcar: number;
}): ResumenAsistencia {
  const marcas = entrada.llegaron + entrada.noLlegaron;
  if (marcas === 0) {
    return {
      estado: "NO_REGISTRADA",
      texto: "Asistencia no registrada",
      personas: entrada.sinMarcar,
      esEstimacion: true,
      sinMarcar: entrada.sinMarcar,
    };
  }
  if (entrada.sinMarcar > 0) {
    // "Al menos": el número es un PISO, porque los que faltan por marcar
    // pueden haber llegado igual. Decir "llegaron 3" acá sería inventar nueve
    // ausencias que nadie observó.
    return {
      estado: "PARCIAL",
      texto: `Llegaron al menos ${entrada.llegaron} ${entrada.llegaron === 1 ? "persona" : "personas"}`,
      personas: entrada.llegaron,
      esEstimacion: true,
      sinMarcar: entrada.sinMarcar,
    };
  }
  return {
    estado: "COMPLETA",
    texto: `${entrada.llegaron} ${entrada.llegaron === 1 ? "persona llegó" : "personas llegaron"}`,
    personas: entrada.llegaron,
    esEstimacion: false,
    sinMarcar: 0,
  };
}

/**
 * El contador vivo del día del evento (§90).
 *
 * Lo preparado se anota naturalmente en CRUDO y lo servido en COCIDO. Restar
 * seis kilos crudos menos tres coma ocho cocidos da un número que no existe en
 * el mundo físico, y con ese número se decide si se prende otra tanda.
 *
 * Entonces: la resta aparece SOLO cuando las dos cifras están en la misma base.
 * Si no, se muestran las dos rotuladas y no se resta. Nunca se convierte de una
 * base a otra acá — esa conversión necesita un factor de rendimiento y ese
 * factor es del motor, no de una pantalla.
 */
export type BaseFisica = "RAW" | "COOKED";

export const ETIQUETA_BASE: Record<BaseFisica, string> = {
  RAW: "crudo",
  COOKED: "cocido",
};

export type ContadorDelDia =
  | { estado: "COMPARABLE"; preparadoG: number; servidoG: number; quedaG: number; base: BaseFisica }
  | {
      estado: "BASES_DISTINTAS";
      preparadoG: number;
      basePreparado: BaseFisica;
      servidoG: number;
      baseServido: BaseFisica;
      aviso: string;
    };

export function contadorDelDia(entrada: {
  preparado: { gramos: number; base: BaseFisica };
  servido: { gramos: number; base: BaseFisica };
}): ContadorDelDia {
  if (entrada.preparado.base !== entrada.servido.base) {
    return {
      estado: "BASES_DISTINTAS",
      preparadoG: entrada.preparado.gramos,
      basePreparado: entrada.preparado.base,
      servidoG: entrada.servido.gramos,
      baseServido: entrada.servido.base,
      aviso:
        "No se restan: lo preparado está en crudo y lo servido en cocido. Para saber cuánto queda " +
        "hace falta el rendimiento de ese corte.",
    };
  }
  return {
    estado: "COMPARABLE",
    preparadoG: entrada.preparado.gramos,
    servidoG: entrada.servido.gramos,
    quedaG: Math.max(0, entrada.preparado.gramos - entrada.servido.gramos),
    base: entrada.preparado.base,
  };
}

/**
 * Las restricciones de una persona, en texto.
 *
 * Los tres casos son TRES, no dos: no sabemos / dijo que no tiene / tiene
 * estas. La omisión no es una declaración, y por eso `null` jamás se muestra
 * como "sin restricciones".
 */
export function textoRestricciones(
  banderas: string[] | null,
  etiquetas: Record<string, string>,
): string {
  if (banderas === null) return SIN_INFORMACION;
  if (banderas.length === 0) return "Dijo que no tiene restricciones";
  return banderas.map((b) => etiquetas[b] ?? b).join(" · ");
}

/** Plural sin adivinar: "1 persona" / "11 personas". */
export function personas(cuantas: number): string {
  return `${cuantas} ${cuantas === 1 ? "persona" : "personas"}`;
}
