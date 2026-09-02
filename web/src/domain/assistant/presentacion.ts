import { REASON_CODES, reason } from "@/domain/portions/reasons";
import type { ReasonCode, ReasonParams } from "@/domain/portions/reasons";
import type { Capability } from "@/lib/auth/actor";
import type {
  AssistantProposal,
  ExigenciaSegundoGesto,
  ProposalStatus,
} from "./proposal";
/**
 * La comparación del segundo gesto es UNA sola —la misma que corre dentro de la
 * compuerta— y acá se reexporta para que la tarjeta pueda avisar antes de
 * mandar. Dos implementaciones, una para el botón y otra para el servidor,
 * serían la misma trampa de las dos compuertas en chico: la floja gana.
 *
 * Se reexporta desde `./segundo-gesto` y NO desde `./proposal`: la tarjeta es
 * "use client", y `proposal.ts` importa `node:crypto` en su primera línea. Ese
 * salto habría metido `node:crypto` en el bundle del navegador.
 */
export { comparaSegundoGesto } from "./segundo-gesto";
export type { VeredictoSegundoGesto } from "./segundo-gesto";
import { untrusted } from "./tool";
import type {
  ExistingActionName,
  Provenance,
  ReasonSinTexto,
  RiskLevel,
  Unknown,
  UnknownSymbol,
  UntrustedText,
  WriteEffect,
} from "./tool";

/**
 * LA POLÍTICA DE CONFIRMACIÓN, EN CÓDIGO.
 *
 * Acá vive lo que la tarjeta puede decir y lo que la persona tiene que ver
 * antes de tocar el botón. Está en un módulo puro —sin React, sin base, sin
 * `new Date()`— porque es lo único del asistente que se puede probar de verdad:
 * un componente se mira, una regla se prueba.
 *
 * Las tres reglas que gobiernan este archivo:
 *
 *  1. EL VERBO NO VIENE DE LOS DATOS. El título, las etiquetas y los motivos
 *     salen de filas que escribió una persona (el nombre de un lote, de un
 *     evento, de un invitado). Un atacante que controla ese nombre no ejecuta
 *     nada, pero SÍ controla cómo se ve lo que la víctima confirma: bautizar un
 *     lote "sobras de arroz (botar)" y lograr que la propuesta de descartar la
 *     carne cara se lea como si fuera el arroz. Por eso el verbo, el efecto y
 *     las líneas de irreversibilidad salen de `POLITICA`, un mapa congelado que
 *     no toca la base, y la tarjeta muestra además el nombre CRUDO de la acción.
 *
 *  2. TODO TEXTO AJENO PASA POR `etiquetaSegura`. No para que se vea bonito:
 *     para que no traiga saltos de línea con los que fabricar una línea falsa
 *     ("Ya se aplicaron los cambios al inventario"), ni controles bidi con los
 *     que dar vuelta una frase, ni 4.000 caracteres que empujen el verbo fuera
 *     de la pantalla de 320 px.
 *
 *  3. UNKNOWN != ZERO, ERROR != VACÍO. Una cantidad que nadie pesó no se
 *     escribe con coma decimal, y una tarjeta a la que le falta un elemento
 *     obligatorio no se confirma: se muestra rota, que es la verdad.
 */

// ---------------------------------------------------------------------------
// 1. Texto ajeno
// ---------------------------------------------------------------------------

/**
 * Tope de una etiqueta. 48 caracteres entran completos en la línea de una
 * tarjeta a 320 px; con más, el nombre del lote empuja el verbo fuera de la
 * pantalla y la persona confirma mirando solo el botón.
 */
export const TOPE_ETIQUETA = 48;

/** Lo que se muestra cuando el texto ajeno queda vacío después de limpiarlo. */
export const ETIQUETA_VACIA = "(sin nombre)";

/**
 * Limpia un texto que escribió una persona antes de mostrarlo o de metérselo a
 * una plantilla.
 *
 * Qué saca y por qué:
 *  · Categorías Cc/Cf (controles y formato, incluidos los bidi y el
 *    ancho-cero): con ellos se dan vuelta frases y se esconden palabras.
 *  · Saltos de línea y tabulaciones: una etiqueta de dos líneas puede fingir
 *    ser una línea del sistema.
 *  · `<` y `>`: no porque React los interpole —no lo hace— sino porque el mismo
 *    texto viaja al prompt y al recibo, y ahí sí hay ensambladores que arman
 *    marcado.
 *  · Largo: se trunca CON marca visible, para que nadie crea que el nombre
 *    completo es ese.
 */
export function etiquetaSegura(valor: string): string {
  return saneaTexto(valor, TOPE_ETIQUETA);
}

/**
 * El mismo saneo con otro tope. Existe porque el título de un aviso del inbox
 * es una frase completa ("Faltaron 300 g de arroz en el almuerzo del martes") y
 * cortarla en 48 la deja sin la mitad que importa; lo que NO cambia entre los
 * dos es qué se saca, que es lo que hace de defensa.
 */
export function saneaTexto(valor: string, tope: number): string {
  const normalizado = valor.normalize("NFKC");
  let limpio = "";
  for (const caracter of normalizado) {
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(caracter)) {
      limpio += " ";
      continue;
    }
    if (caracter === "<" || caracter === ">") continue;
    limpio += caracter;
  }
  const colapsado = limpio.replace(/\s+/gu, " ").trim();
  if (colapsado.length === 0) return ETIQUETA_VACIA;
  if (colapsado.length <= tope) return colapsado;
  return `${colapsado.slice(0, tope - 1).trimEnd()}…`;
}

/**
 * Compone la frase de una razón A PARTIR del código y de los parámetros ya
 * limpios.
 *
 * `reason()` interpola crudo, así que si la frase se compusiera antes de
 * limpiar —o si se guardara compuesta y se mostrara tal cual— el texto del
 * atacante entraría al canal de mayor confianza de la pantalla: la explicación
 * del sistema. Por eso el asistente mueve `{code, params}` y la frase se arma
 * acá, del lado del servidor, con los params pasados por `etiquetaSegura`.
 */
export function fraseDeRazon(r: ReasonSinTexto): string {
  const params: ReasonParams = {};
  for (const [clave, valor] of Object.entries(r.params)) {
    params[clave] = typeof valor === "number" ? valor : etiquetaSegura(valor);
  }
  return reason(r.code, params).text;
}

/**
 * Los dos vocabularios cerrados que viajan por jsonb y vuelven como `string`.
 *
 * La forma del espejo importa: es un `Record<UnknownSymbol, true>`, así que el
 * día que `tool.ts` agregue un símbolo esto NO compila. Una lista suelta se
 * habría quedado corta en silencio, y un símbolo que no se reconoce termina
 * mostrado como otro — o peor, descartado, que es el "no sé" convertido en
 * nada.
 */
const ESPEJO_SIMBOLOS: Readonly<Record<UnknownSymbol, true>> = {
  UNRESOLVED: true,
  INSUFFICIENT_DATA: true,
  NO_EXPECTED_DEMAND: true,
  UNVERIFIABLE_CONSTRAINT: true,
  MISSING_DATA: true,
  SAFETY_REVIEW_REQUIRED: true,
  UNRESOLVED_DEMAND: true,
  PREP_UNRESOLVED: true,
  PROCUREMENT_UNRESOLVED: true,
  EXCLUDED_PRODUCT_LOTS: true,
  SCREENING_ONLY: true,
  NO_ENGINE: true,
  TRUNCATED_BY_LIMIT: true,
};

export function esSimboloDesconocido(valor: string): valor is UnknownSymbol {
  return Object.prototype.hasOwnProperty.call(ESPEJO_SIMBOLOS, valor);
}

export function esCodigoDeRazon(valor: string): valor is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(valor);
}

/**
 * Compone una razón GUARDADA, donde el código es un `string` cualquiera porque
 * viene de jsonb. Un código que este build no conoce se dice con todas sus
 * letras: callarlo dejaría el aviso sin explicación y con pinta de completo.
 */
export function fraseDeRazonGuardada(
  code: string,
  params: Readonly<Record<string, string | number>>,
): string {
  if (!esCodigoDeRazon(code)) {
    return `Este motivo viene con un código que esta versión no sabe redactar (${saneaTexto(code, 40)}).`;
  }
  const limpios: Record<string, UntrustedText | number> = {};
  for (const [k, v] of Object.entries(params)) {
    limpios[k] = typeof v === "number" ? v : untrusted(v);
  }
  return fraseDeRazon({ code, params: limpios });
}

// ---------------------------------------------------------------------------
// 2. El mapa congelado de acciones
// ---------------------------------------------------------------------------

/**
 * El segundo gesto de la doble confirmación. Es de OTRA naturaleza que el
 * primero a propósito: dos toques en el mismo lugar son un toque con rebote.
 *
 * `ESCRIBIR_CANTIDAD` no es un campo de entrada: lo que se escribe se COMPARA
 * contra los argumentos de la propuesta y no alimenta nada. Si alimentara, la
 * persona ejecutaría algo distinto de lo que se revalidó y de lo que muestra la
 * tarjeta —teclear 8 donde decía 1,8 descartaría 8 kg— y la revalidación
 * quedaría de adorno.
 */
export type SegundoGesto = "NINGUNO" | "NOMBRE_INTEGRANTE" | "ESCRIBIR_CANTIDAD";

export interface PoliticaAccion {
  /** El verbo real, en español chileno. "Descontar", nunca "aplicar cambios". */
  readonly verbo: string;
  readonly efecto: WriteEffect;
  readonly riesgo: RiskLevel;
  /**
   * Qué queda hecho y no se deshace, cada cosa en su propia línea. Vacío
   * significa reversible, y eso también se dice.
   */
  readonly irreversible: readonly string[];
  readonly segundoGesto: SegundoGesto;
}

const REVERSIBLE: readonly string[] = [];

/**
 * La asignación es acción por acción y no por carpeta: "vive en actions.ts" no
 * clasifica nada — `previewDeltas` es lectura y `assessMeal` escribe en la
 * ficha clínica.
 *
 * El tipo es `Record<ExistingActionName, ...>`: una acción nueva sin política no
 * compila. Es la única forma de que "se me olvidó clasificarla" sea un error de
 * compilación y no una tarjeta que confirma a ciegas.
 */
export const POLITICA: Readonly<Record<ExistingActionName, PoliticaAccion>> = {
  // --- MEDIO: escribe, no mueve materia ni plata, y se puede deshacer -------
  setStockTarget: {
    verbo: "Fijar el mínimo de despensa",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  deleteStockTarget: {
    verbo: "Borrar el mínimo de despensa",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  saveDailyOverride: {
    verbo: "Cambiar los objetivos de un día",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  clearDailyOverride: {
    verbo: "Volver a los objetivos de siempre",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  setCookingPreference: {
    verbo: "Guardar cómo se prefiere preparar",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  setIngredientPreference: {
    verbo: "Guardar un gusto o un rechazo",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  setTrackingMode: {
    verbo: "Cambiar cómo se hace el seguimiento",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  setAddedFatStance: {
    verbo: "Cambiar la postura sobre la grasa añadida",
    efecto: "WRITES_PREFS",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  assignMeal: {
    verbo: "Poner un plato en el plan",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  setMealParticipants: {
    verbo: "Cambiar quién come",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    // El levantamiento la listó entre las escrituras de varios pasos sin
    // transacción: si falla el segundo paso quedan participantes guardados y
    // porciones sin recalcular. La tarjeta lo dice antes, no después.
    irreversible: [
      "Se guarda en dos pasos: si falla el segundo, las porciones quedan sin recalcular.",
    ],
    segundoGesto: "NINGUNO",
  },
  saveSubstitution: {
    verbo: "Guardar un reemplazo de ingrediente",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  clearSubstitution: {
    verbo: "Sacar un reemplazo de ingrediente",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  setItemStatus: {
    verbo: "Marcar un ítem de la lista",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  editPlannedQuantity: {
    verbo: "Cambiar cuánto se compra",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  addManualItem: {
    verbo: "Agregar un ítem a la lista",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  removeManualItem: {
    verbo: "Sacar un ítem de la lista",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  generatePrepPlan: {
    verbo: "Generar el plan de preparación",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  skipTask: {
    verbo: "Saltarse una tarea de cocina",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  createLabelsForTask: {
    verbo: "Crear las etiquetas de una tarea",
    efecto: "WRITES_PLAN",
    riesgo: "MEDIO",
    irreversible: REVERSIBLE,
    segundoGesto: "NINGUNO",
  },
  runExtraction: {
    verbo: "Leer el examen con ayuda de la IA",
    efecto: "WRITES_CLINICAL",
    riesgo: "MEDIO",
    irreversible: [
      "El documento se manda al proveedor de IA: eso no se puede deshacer después.",
    ],
    segundoGesto: "NINGUNO",
  },

  // --- ALTO físico: mueve materia -------------------------------------------
  consumePlannedMeal: {
    verbo: "Descontar de la despensa lo que se sirvió",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Descuenta inventario: los lotes quedan con menos cantidad."],
    segundoGesto: "NINGUNO",
  },
  receiveShoppingList: {
    verbo: "Recibir la compra en la despensa",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Crea lotes nuevos en la despensa."],
    segundoGesto: "NINGUNO",
  },
  adjustLot: {
    verbo: "Corregir la cantidad de un lote",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Deja el lote en la cantidad indicada: la anterior no vuelve sola."],
    // El segundo gesto lo escala `segundoGestoDe` cuando el ajuste es merma.
    segundoGesto: "NINGUNO",
  },
  discardLot: {
    verbo: "Botar un lote",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Es merma: la comida se da por perdida y no vuelve al inventario."],
    segundoGesto: "ESCRIBIR_CANTIDAD",
  },
  addManualLot: {
    verbo: "Anotar un lote nuevo",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Crea un lote en la despensa."],
    segundoGesto: "NINGUNO",
  },
  moveLot: {
    verbo: "Mover un lote de lugar",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Cambia dónde vive el lote y, con eso, su regla de conservación."],
    segundoGesto: "NINGUNO",
  },
  qrUseLot: {
    verbo: "Usar un lote desde el código QR",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Descuenta inventario."],
    segundoGesto: "NINGUNO",
  },
  qrUpdateWeight: {
    verbo: "Corregir el peso desde el código QR",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Deja el lote en el peso indicado."],
    segundoGesto: "NINGUNO",
  },
  qrDiscardLot: {
    verbo: "Botar un lote desde el código QR",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Es merma: la comida se da por perdida."],
    segundoGesto: "ESCRIBIR_CANTIDAD",
  },
  completeTask: {
    verbo: "Dar por hecha una tarea de cocina",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Consume los ingredientes de la tarea."],
    segundoGesto: "NINGUNO",
  },
  recordObservedYield: {
    verbo: "Anotar cuánto rindió de verdad",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Corrige el rendimiento que usan las compras de aquí en adelante."],
    segundoGesto: "NINGUNO",
  },
  resolveShortfall: {
    verbo: "Cerrar un faltante",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["El faltante queda cerrado con el motivo elegido."],
    segundoGesto: "NINGUNO",
  },
  confirmMeal: {
    verbo: "Confirmar que se sirvió",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Congela las porciones servidas."],
    segundoGesto: "NINGUNO",
  },
  unconfirmMeal: {
    verbo: "Deshacer la confirmación de una comida",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["Suelta las porciones congeladas."],
    segundoGesto: "NINGUNO",
  },
  completeList: {
    verbo: "Cerrar la lista de compras",
    efecto: "WRITES_LEDGER",
    riesgo: "ALTO",
    irreversible: ["La lista queda cerrada."],
    segundoGesto: "NINGUNO",
  },

  // --- ALTO financiero -------------------------------------------------------
  approveSuggestion: {
    verbo: "Aprobar una compra sugerida",
    efecto: "WRITES_MONEY",
    riesgo: "ALTO",
    irreversible: ["Compromete plata con un proveedor."],
    segundoGesto: "NINGUNO",
  },
  advanceOrder: {
    verbo: "Avanzar una orden de compra",
    efecto: "WRITES_MONEY",
    riesgo: "ALTO",
    irreversible: ["Cambia el estado de la orden ante el proveedor."],
    segundoGesto: "NINGUNO",
  },
  receiveOrder: {
    verbo: "Recibir una orden de compra",
    efecto: "WRITES_MONEY",
    riesgo: "ALTO",
    irreversible: ["Da la orden por recibida y crea los lotes."],
    segundoGesto: "NINGUNO",
  },
  saveSupplierProduct: {
    verbo: "Guardar el precio de un proveedor",
    efecto: "WRITES_MONEY",
    riesgo: "ALTO",
    irreversible: ["Cambia el precio con el que se calculan las compras."],
    segundoGesto: "NINGUNO",
  },
  savePurchasePolicy: {
    verbo: "Cambiar la política de compra",
    efecto: "WRITES_MONEY",
    riesgo: "ALTO",
    irreversible: ["Cambia cuánto y cada cuánto se compra."],
    segundoGesto: "NINGUNO",
  },

  // --- ALTO clínico ----------------------------------------------------------
  createRestriction: {
    verbo: "Crear una restricción médica",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: [
      "Alimenta al motor clínico, al optimizador y a las compras de toda la casa.",
    ],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  setRestrictionStatus: {
    verbo: "Cambiar el estado de una restricción médica",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: ["Suspenderla deja de bloquear platos que hoy se bloquean."],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  confirmReview: {
    verbo: "Confirmar la revisión de un examen",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: ["Los valores confirmados pasan a mandar sobre las porciones."],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  correctObservation: {
    verbo: "Corregir un valor de examen",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: ["Cambia el dato clínico con el que se calculan los límites."],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  resolveImpact: {
    verbo: "Cerrar una revisión clínica pendiente",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: ["Levanta un bloqueo clínico sobre comidas ya planificadas."],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  assessMeal: {
    verbo: "Evaluar clínicamente una comida",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: ["Guarda el veredicto clínico de esa comida."],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  uploadExam: {
    verbo: "Subir un examen",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: ["Guarda el documento en la ficha de esa persona."],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  setConsent: {
    verbo: "Cambiar el consentimiento de IA de un documento",
    efecto: "WRITES_CLINICAL",
    riesgo: "ALTO",
    irreversible: [
      "Autorizar el envío al proveedor de IA no se deshace después de mandado.",
    ],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },

  // --- ALTO permisos ---------------------------------------------------------
  grantAccess: {
    verbo: "Dar acceso a los exámenes de una persona",
    efecto: "WRITES_GRANTS",
    riesgo: "ALTO",
    irreversible: [
      "Quien recibe el acceso puede ver los exámenes desde este momento.",
      "Quitarlo después no borra lo que ya alcanzó a ver.",
    ],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
  revokeAccess: {
    verbo: "Quitar el acceso a los exámenes de una persona",
    efecto: "WRITES_GRANTS",
    riesgo: "ALTO",
    irreversible: ["Quien lo tenía deja de ver la ficha."],
    segundoGesto: "NOMBRE_INTEGRANTE",
  },
};

// ---------------------------------------------------------------------------
// 3. Cantidades que nadie pesó
// ---------------------------------------------------------------------------

/**
 * Si la cantidad sobre la que se va a actuar está MEDIDA o no.
 *
 * `DESCONOCIDA` existe y se trata igual que `APROXIMADO` a propósito: quien
 * arma la tarjeta y no pudo averiguarlo no puede caer por omisión en el camino
 * cómodo. `InventoryLot.isApproximate` ya existe y el pronóstico lo respeta
 * ("parte del stock está registrado como aproximado"); era la tarjeta de
 * confirmación la que lo perdía justo antes de mover materia.
 */
export type Medicion = "MEDIDO" | "APROXIMADO" | "DESCONOCIDA";

const MARCA_MEDICION: Readonly<Record<Medicion, string | null>> = {
  MEDIDO: null,
  APROXIMADO: "registrado como aproximado",
  DESCONOCIDA: "no sabemos si esto se pesó",
};

/**
 * Un número con decimales dice "esto se midió". Si nadie lo pesó, la coma es
 * una precisión inventada: se redondea y se marca con `≈`.
 *
 * Se aplica NÚMERO POR NÚMERO y no al texto entero porque el mismo tratamiento
 * tiene que servir para una celda ("2,0 kg") y para el título, que es una frase
 * ("Usar 2,0 kg de pollo del lote L-77"). La primera versión marcaba solo la
 * celda, y la cifra exacta seguía apareciendo en el título de la misma tarjeta:
 * quien lee, lee el título.
 *
 * No se hace al revés (mostrar el valor exacto y agregar una nota al pie)
 * porque la nota al pie no la lee nadie con el pulgar sobre el botón.
 */
export function valorSegunMedicion(valor: string, medicion: Medicion): string {
  if (medicion === "MEDIDO") return valor;
  return valor.replace(/\d+[.,]\d+/g, (numero) => {
    const n = Number(numero.replace(",", "."));
    return Number.isFinite(n) ? `≈${Math.round(n)}` : numero;
  });
}

export function marcaDeMedicion(medicion: Medicion): string | null {
  return MARCA_MEDICION[medicion];
}

/**
 * El segundo gesto EFECTIVO. La política da el piso y el contexto lo sube;
 * nunca lo baja.
 *
 * Dos escalones, los dos por la misma razón —el error es caro y silencioso—:
 *  · merma mayor (botar, o bajar más de la mitad de un lote), como pide §3.4;
 *  · cantidad no medida sobre algo que mueve materia: confirmar el traslado de
 *    una cifra que nadie pesó merece el mismo freno que confirmar una merma.
 */
export function segundoGestoDe(
  accion: ExistingActionName,
  contexto: { medicion: Medicion; mermaMayor: boolean },
): SegundoGesto {
  const base = POLITICA[accion];
  if (base.segundoGesto !== "NINGUNO") return base.segundoGesto;
  if (contexto.mermaMayor) return "ESCRIBIR_CANTIDAD";
  if (base.efecto === "WRITES_LEDGER" && contexto.medicion !== "MEDIDO") {
    return "ESCRIBIR_CANTIDAD";
  }
  return "NINGUNO";
}

/**
 * QUÉ SEGUNDO GESTO EXIGE ESTA PROPUESTA. Una sola función, dos lectores.
 *
 * La tarjeta la usa para saber qué pedir y `ConfirmationGrant.reclamar` la usa
 * para saber qué exigir. Si fueran dos cálculos, el del servidor terminaría
 * siendo el flojo —siempre pasa: el que se ve es el que se corrige— y la doble
 * confirmación volvería a vivir en el navegador.
 *
 * `INDETERMINADA` no es `NINGUNO`: si no se sabe a quién afecta o contra qué
 * número comparar, la tarjeta se muestra SIN botón y la compuerta NO confirma.
 * Degradar un segundo gesto que no se puede pedir a un solo toque es exactamente
 * lo que este sprint viene a impedir.
 */
export function exigenciaDeSegundoGesto(
  propuesta: Pick<PropuestaParaTarjeta, "accion" | "requires">,
  entorno: {
    readonly medicion: Medicion;
    readonly mermaMayor: boolean;
    readonly cantidadEsperada: CantidadEsperada | null;
  },
): ExigenciaSegundoGesto {
  const gesto = segundoGestoDe(propuesta.accion, {
    medicion: entorno.medicion,
    mermaMayor: entorno.mermaMayor,
  });
  if (gesto === "NINGUNO") return { k: "NINGUNO" };

  if (gesto === "NOMBRE_INTEGRANTE") {
    const dueno = propuesta.requires.find(
      (c): c is Extract<Capability, { k: "MEDICAL" }> => c.k === "MEDICAL",
    );
    if (dueno === undefined) return { k: "INDETERMINADA", motivo: "FALTA_EL_INTEGRANTE" };
    return { k: "NOMBRE_INTEGRANTE", memberId: dueno.owner };
  }

  if (entorno.cantidadEsperada === null) {
    return { k: "INDETERMINADA", motivo: "FALTA_LA_CANTIDAD" };
  }
  return {
    k: "ESCRIBIR_CANTIDAD",
    valor: entorno.cantidadEsperada.valor,
    unidad: entorno.cantidadEsperada.unidad,
  };
}

// ---------------------------------------------------------------------------
// 4. La tarjeta
// ---------------------------------------------------------------------------

export interface LineaTarjeta {
  /** Texto de la casa: se pinta como dato citado, no como texto del sistema. */
  readonly etiqueta: string;
  readonly valor: string;
}

export interface CantidadEsperada {
  readonly valor: number;
  readonly unidad: string;
}

export interface TarjetaAccion {
  readonly proposalId: string;
  /** El nombre crudo, visible: `discardLot`. Que se pueda buscar y reclamar. */
  readonly accion: ExistingActionName;
  readonly verbo: string;
  readonly efecto: WriteEffect;
  readonly riesgo: RiskLevel;
  readonly titulo: string;
  readonly lineas: readonly LineaTarjeta[];
  readonly irreversible: readonly string[];
  readonly razones: readonly string[];
  readonly unknowns: readonly Unknown[];
  readonly procedencia: readonly string[];
  readonly medicion: Medicion;
  readonly segundoGesto: SegundoGesto;
  /** Solo cuando el segundo gesto es escribir la cantidad. Se COMPARA. */
  readonly cantidadEsperada: CantidadEsperada | null;
  /** Solo cuando el segundo gesto es tocar el nombre. */
  readonly integranteAfectado: { readonly id: string; readonly nombre: string } | null;
  readonly quienConfirma: string;
  readonly quienPropuso: string;
  readonly loPropusoOtro: boolean;
  readonly vence: string;
}

export type MotivoNoConfirmable =
  | "VENCIDA"
  | "YA_DECIDIDA"
  | "SIN_TOKEN"
  | "FALTA_EL_INTEGRANTE"
  | "FALTA_LA_CANTIDAD";

export type ResultadoTarjeta =
  | { estado: "CONFIRMABLE"; tarjeta: TarjetaAccion; token: string }
  | { estado: "SOLO_LECTURA"; tarjeta: TarjetaAccion; motivo: MotivoNoConfirmable };

export interface EntornoTarjeta {
  readonly medicion: Medicion;
  readonly mermaMayor: boolean;
  readonly quienConfirma: { readonly id: string; readonly nombre: string };
  readonly quienPropuso: string;
  /** Nombres del hogar, para resolver el integrante afectado sin mostrar uuid. */
  readonly integrantes: Readonly<Record<string, string>>;
  readonly cantidadEsperada: CantidadEsperada | null;
  /**
   * El token de un solo uso, emitido al renderizar ESTA tarjeta para ESTE
   * actor. `null` significa que no se pudo emitir, y una tarjeta sin token se
   * muestra sin botón: no hay confirmación posible, y decirlo es más honesto
   * que un botón que va a fallar.
   */
  readonly token: string | null;
  readonly ahora: string;
}

const ESTADOS_VIVOS: readonly ProposalStatus[] = ["OFFERED"];

/**
 * Lo que la tarjeta necesita de una propuesta, y nada más.
 *
 * Se pide un `Pick` y no la `AssistantProposal` entera porque el cargador de la
 * pantalla no lee la `basis` —no la muestra, no la revalida: revalidar es de
 * `claimProposal`, del lado del servidor— y obligarlo a traerla lo empujaba a
 * inventar una foto vacía para llenar el tipo. Una `basis` en blanco se parece
 * demasiado a una escena que no cambió.
 */
export type PropuestaParaTarjeta = Pick<
  AssistantProposal,
  | "id"
  | "householdId"
  | "createdByMemberId"
  | "accion"
  | "args"
  | "requires"
  | "resumen"
  | "status"
  | "expiresAt"
>;

function procedenciaLegible(fuentes: readonly Provenance[]): string[] {
  return fuentes.map((p) => p.version);
}

/**
 * Arma la tarjeta a partir de la propuesta PERSISTIDA. Determinista y sin red:
 * aceptar tiene que funcionar con el proveedor caído, así que nada de lo que la
 * persona lee para decidir puede depender de una llamada al modelo.
 */
export function armarTarjeta(
  propuesta: PropuestaParaTarjeta,
  entorno: EntornoTarjeta,
): ResultadoTarjeta {
  const politica = POLITICA[propuesta.accion];
  // La MISMA exigencia que va a comprobar la compuerta. La tarjeta no decide
  // nada por su cuenta: pide lo que el servidor va a exigir.
  const exigencia = exigenciaDeSegundoGesto(propuesta, {
    medicion: entorno.medicion,
    mermaMayor: entorno.mermaMayor,
    cantidadEsperada: entorno.cantidadEsperada,
  });
  const gesto: SegundoGesto = exigencia.k === "INDETERMINADA" ? "NINGUNO" : exigencia.k;

  const integranteId = exigencia.k === "NOMBRE_INTEGRANTE" ? exigencia.memberId : null;
  const nombreIntegrante =
    integranteId === null ? undefined : entorno.integrantes[integranteId];
  const integranteAfectado =
    integranteId !== null && nombreIntegrante !== undefined
      ? { id: integranteId, nombre: etiquetaSegura(nombreIntegrante) }
      : null;

  const tarjeta: TarjetaAccion = {
    proposalId: propuesta.id,
    accion: propuesta.accion,
    verbo: politica.verbo,
    efecto: politica.efecto,
    riesgo: politica.riesgo,
    titulo: valorSegunMedicion(
      etiquetaSegura(propuesta.resumen.titulo),
      entorno.medicion,
    ),
    lineas: propuesta.resumen.lineas.map((l) => ({
      etiqueta: etiquetaSegura(l.etiqueta),
      valor: valorSegunMedicion(etiquetaSegura(l.valor), entorno.medicion),
    })),
    // Del mapa congelado, NO de `resumen.irreversible`: la línea que dice qué
    // no se deshace es justamente la que un atacante querría escribir.
    irreversible: politica.irreversible,
    razones: propuesta.resumen.reasons.map(fraseDeRazon),
    unknowns: propuesta.resumen.unknowns,
    procedencia: procedenciaLegible(propuesta.resumen.provenance),
    medicion: entorno.medicion,
    segundoGesto: gesto,
    cantidadEsperada: gesto === "ESCRIBIR_CANTIDAD" ? entorno.cantidadEsperada : null,
    integranteAfectado: gesto === "NOMBRE_INTEGRANTE" ? integranteAfectado : null,
    quienConfirma: etiquetaSegura(entorno.quienConfirma.nombre),
    quienPropuso: etiquetaSegura(entorno.quienPropuso),
    loPropusoOtro: propuesta.createdByMemberId !== entorno.quienConfirma.id,
    vence: propuesta.expiresAt,
  };

  const soloLectura = (motivo: MotivoNoConfirmable): ResultadoTarjeta => ({
    estado: "SOLO_LECTURA",
    tarjeta,
    motivo,
  });

  if (!ESTADOS_VIVOS.includes(propuesta.status)) return soloLectura("YA_DECIDIDA");
  if (Date.parse(entorno.ahora) >= Date.parse(propuesta.expiresAt)) {
    return soloLectura("VENCIDA");
  }
  if (entorno.token === null) return soloLectura("SIN_TOKEN");
  // Un segundo gesto que la tarjeta no puede pedir es un segundo gesto que no
  // existe. Antes que degradarlo a un solo toque, la tarjeta no se confirma —y
  // la compuerta tampoco, que devuelve SEGUNDO_GESTO_INDETERMINADO por lo mismo.
  if (exigencia.k === "INDETERMINADA") return soloLectura(exigencia.motivo);
  // El nombre no se pudo resolver: hay a quién exigir, pero no cómo mostrarlo.
  if (exigencia.k === "NOMBRE_INTEGRANTE" && tarjeta.integranteAfectado === null) {
    return soloLectura("FALTA_EL_INTEGRANTE");
  }

  return { estado: "CONFIRMABLE", tarjeta, token: entorno.token };
}

/**
 * Los seis elementos obligatorios de una tarjeta de riesgo ALTO (§3.3). Devuelve
 * lo que FALTA: lista vacía es "está completa".
 *
 * Es un chequeo de runtime y no una guarda de CI porque el que arma la tarjeta
 * es el servidor con datos de la casa: la tarjeta incompleta no es un error de
 * programación que se vea en el build, es una fila rara un martes a las nueve.
 */
export function faltantesDeTarjetaAlta(t: TarjetaAccion): string[] {
  if (t.riesgo !== "ALTO") return [];
  const faltan: string[] = [];
  if (t.verbo.trim().length === 0) faltan.push("el verbo de la acción");
  if (t.lineas.length === 0) faltan.push("los números del motor");
  if (t.titulo.trim().length === 0 || t.titulo === ETIQUETA_VACIA) {
    faltan.push("sobre qué es la acción");
  }
  if (t.irreversible.length === 0) faltan.push("qué queda hecho y no se deshace");
  if (t.quienConfirma.trim().length === 0) faltan.push("quién confirma");
  if (t.procedencia.length === 0) faltan.push("con qué motor se calculó");
  return faltan;
}

// ---------------------------------------------------------------------------
// 6. El indicador de pendientes
// ---------------------------------------------------------------------------

/**
 * El badge de la campanita. `DESCONOCIDO` existe porque un fallo de lectura
 * pintado como 0 —o como badge ausente— es visualmente idéntico a "todo en
 * orden", y la campanita es el único elemento de la navegación que la gente
 * mira de verdad.
 *
 * No pasar badge es otra cosa distinta: esta pantalla no preguntó. No se
 * confunde con "pregunté y no pude".
 */
export type BadgeInbox = { kind: "CONTEO"; n: number } | { kind: "DESCONOCIDO" };

export function textoDeBadge(badge: BadgeInbox): { texto: string; aria: string } {
  if (badge.kind === "DESCONOCIDO") {
    return { texto: "?", aria: "No pude revisar tus pendientes" };
  }
  if (badge.n === 0) return { texto: "", aria: "Sin pendientes" };
  return {
    texto: badge.n > 9 ? "9+" : String(badge.n),
    aria: `${badge.n} ${badge.n === 1 ? "pendiente" : "pendientes"}`,
  };
}
