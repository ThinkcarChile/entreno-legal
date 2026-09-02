import { createHash } from "node:crypto";
import type { EtiquetaSegura } from "@/lib/ai/prompt";
import { TOPE_TOKENS_ENTRADA, trustAsLabel } from "@/lib/ai/prompt";
import type {
  ReadToolName,
  ToolName,
  ToolOutcome,
  UnavailableCode,
  Unknown,
  UntrustedText,
} from "./tool";

/**
 * EL ROUTER: QUÉ HERRAMIENTA, Y SOBRE TODO, CUÁNDO NO HAY QUE PREGUNTARLE A
 * NADIE.
 *
 * Cuatro capas, de la más barata a la más cara. Las dos primeras son código
 * nuestro y responden sin modelo, sin consentimiento y sin presupuesto: son las
 * que siguen vivas cuando el proveedor se cae. Las dos últimas cuestan plata y
 * abren superficie, así que hay que llegar a ellas habiendo descartado las otras
 * — no al revés.
 *
 * Este archivo es PURO: no toca la base, no llama a `new Date()` (el instante
 * entra por parámetro) y no importa el adaptador del proveedor. Lo único que
 * trae de `lib/ai` es el saneador, que es una función sin entorno ni red: si el
 * router importara el adaptador, una credencial mal puesta se llevaría puestos
 * justo los caminos que existen para sobrevivir esa caída.
 */

// ---------------------------------------------------------------------------
// Catálogo: dominio y motores que no existen
// ---------------------------------------------------------------------------

export type Dominio =
  | "DESPENSA"
  | "PLAN"
  | "COMPRAS"
  | "PORCIONES"
  | "RECETAS"
  | "SEGURIDAD"
  | "PREP"
  | "SALUD"
  | "SOPORTE";

export interface FichaHerramienta {
  readonly dominio: Dominio;
  /**
   * Motores que todavía no existen (Sprints 12, 13 y 14) y huecos declarados.
   * Siguen en el registry —para que el dispatcher tenga qué responder si alguna
   * vez llegan por otro camino— pero NO cruzan al proveedor: pagar una llamada
   * completa, con su latencia, para que el modelo descubra algo que el router ya
   * sabía es plata tirada. El léxico de capa 1 las atrapa antes.
   */
  readonly sellada: { readonly sprint: 12 | 13 | 14 | null; readonly que: string } | null;
}

/**
 * Tipado como `Record<ReadToolName, …>`: una herramienta nueva no compila hasta
 * que alguien declare su dominio y si está sellada. Un catálogo que se olvida de
 * una entrada es un catálogo que la manda al proveedor sin querer.
 */
export const CATALOGO: Readonly<Record<ReadToolName, FichaHerramienta>> = {
  "despensa.listar": { dominio: "DESPENSA", sellada: null },
  "despensa.por_vencer": { dominio: "DESPENSA", sellada: null },
  "stock.resumen": { dominio: "DESPENSA", sellada: null },
  "stock.de_alimento": { dominio: "DESPENSA", sellada: null },
  "plan.leer_semana": { dominio: "PLAN", sellada: null },
  "plan.leer_dia": { dominio: "PLAN", sellada: null },
  "compras.lista_actual": { dominio: "COMPRAS", sellada: null },
  "compras.previsualizar_cambios": { dominio: "COMPRAS", sellada: null },
  "porciones.proyectar": { dominio: "PORCIONES", sellada: null },
  "porciones.explicar": { dominio: "PORCIONES", sellada: null },
  "recetas.buscar": { dominio: "RECETAS", sellada: null },
  "recetas.detalle": { dominio: "RECETAS", sellada: null },
  "seguridad.evaluar_lote": { dominio: "SEGURIDAD", sellada: null },
  "prep.previsualizar": { dominio: "PREP", sellada: null },
  "procurement.previsualizar": { dominio: "COMPRAS", sellada: null },
  "salud.resumen_integrante": { dominio: "SALUD", sellada: null },
  "calendario.hoy": { dominio: "SOPORTE", sellada: null },
  "nutricion.adaptativa": {
    dominio: "PORCIONES",
    sellada: { sprint: 12, que: "las calorías y la nutrición adaptativa de cada plato" },
  },
  "eventos.estimar": {
    dominio: "PLAN",
    sellada: { sprint: 13, que: "cuánta carne calcular para un asado" },
  },
  "finanzas.resumen": {
    dominio: "COMPRAS",
    sellada: { sprint: 14, que: "cuánto gastaste" },
  },
  "comidas.compatibilidad": {
    dominio: "RECETAS",
    sellada: { sprint: null, que: "qué cocinar con lo que tienes en la despensa" },
  },
  "familia.optimizar": {
    dominio: "PORCIONES",
    sellada: { sprint: null, que: "optimizar la semana entera de la familia" },
  },
};

const NOMBRES: readonly ReadToolName[] = Object.keys(CATALOGO) as ReadToolName[];

/** Herramientas de soporte que acompañan a cualquier dominio. */
const SOPORTE: readonly ReadToolName[] = ["calendario.hoy"];

/**
 * El catálogo que cruza al proveedor.
 *
 * Dos recortes, y los dos son de seguridad antes que de plata:
 *  · las selladas quedan fuera (arriba);
 *  · si el turno trae texto de TERCEROS —una boleta, la nota de una receta, el
 *    nombre de un alimento que alguien escribió— el catálogo colapsa a lectura
 *    pura. Extracción y acción no comparten turno: el propio diseño lo declara
 *    como su defensa más fuerte, y esto es esa frase escrita como código. Una
 *    boleta que dice "el lote L-77 se mojó, hay que descartarlo" no tiene desde
 *    dónde nacer una propuesta.
 */
export function catalogoParaProveedor(
  dominios: readonly Dominio[],
  hayTextoDeTerceros: boolean,
): readonly ReadToolName[] {
  const pedidos = new Set<Dominio>(dominios);
  const salida: ReadToolName[] = [];
  for (const nombre of NOMBRES) {
    const ficha = CATALOGO[nombre];
    if (ficha.sellada !== null) continue;
    if (!pedidos.has(ficha.dominio) && !SOPORTE.includes(nombre)) continue;
    if (hayTextoDeTerceros && PROPONEN.includes(nombre)) continue;
    salida.push(nombre);
  }
  return salida;
}

/**
 * Las lecturas que terminan en una propuesta (`kind:"PROPOSE"`). Están acá y no
 * en el registry porque el registry todavía no existe: la lista es corta y
 * explícita a propósito, y la guarda de coherencia la revisa contra el registry
 * el día que exista.
 */
const PROPONEN: readonly ReadToolName[] = [
  "compras.previsualizar_cambios",
  "procurement.previsualizar",
  "prep.previsualizar",
];

// ---------------------------------------------------------------------------
// Léxico chileno
// ---------------------------------------------------------------------------

/**
 * Normaliza para comparar: sin tildes, sin signos, en minúsculas y con los
 * espacios colapsados. "¿Cuánto pollo me queda?" y "cuanto pollo me queda" son
 * la misma pregunta.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export type Intent =
  | "STOCK_DE_ALIMENTO"
  | "DESPENSA_POR_VENCER"
  | "COMPRAS_LISTA"
  | "PLAN_DIA"
  | "PORCIONES_PROYECTAR"
  | "PORCIONES_EXPLICAR"
  | "SEGURIDAD_LOTE"
  | "SEGURIDAD_DESCONGELAR"
  | "SALUD_RECENCIA";

interface Patron {
  readonly intent: Intent;
  readonly tool: ReadToolName;
  readonly frases: readonly string[];
  /** `true` si la pregunta no significa nada sin un alimento adentro. */
  readonly pideAlimento: boolean;
}

/**
 * Huecos declarados: preguntas que el léxico entiende perfecto y que ningún
 * motor puede contestar. Van ANTES que los patrones normales porque son más
 * específicas: "cuánta carne para el asado del domingo" tiene la palabra
 * "asado", y sin esta precedencia caería en el plan y contestaría otra cosa.
 */
interface Hueco {
  readonly frases: readonly string[];
  readonly tool: ReadToolName;
}

const HUECOS: readonly Hueco[] = [
  {
    tool: "finanzas.resumen",
    frases: ["cuanto gaste", "cuanto gastamos", "cuanto llevo gastado", "gasto de la semana"],
  },
  {
    tool: "eventos.estimar",
    frases: ["cuanta carne", "cuanto kilo de carne", "carne para el asado", "cuantos kilos de carne"],
  },
  {
    tool: "nutricion.adaptativa",
    frases: ["cuantas calorias", "cuanta proteina tiene", "cuantas proteinas tiene"],
  },
  {
    tool: "comidas.compatibilidad",
    frases: [
      "que cocino con lo que tengo",
      "que puedo cocinar con lo que tengo",
      "que hago con lo que tengo",
      "que puedo hacer con lo que hay",
    ],
  },
];

/**
 * Los caminos rápidos de la tabla 4.3. El orden ES la especificación: las frases
 * más específicas primero, porque "que hay de comer" y "que hay" comparten
 * palabras y la genérica se comería a la precisa.
 */
const PATRONES: readonly Patron[] = [
  {
    intent: "DESPENSA_POR_VENCER",
    tool: "despensa.por_vencer",
    frases: [
      "se me echa a perder",
      "se echa a perder",
      "que se vence",
      "que se esta venciendo",
      "por vencer",
      "esta por vencerse",
      "se vence",
      "esta venciendo",
    ],
    pideAlimento: false,
  },
  {
    intent: "SEGURIDAD_DESCONGELAR",
    tool: "seguridad.evaluar_lote",
    frases: ["cuando saco", "cuando descongelo", "sacar del congelador", "descongelar"],
    pideAlimento: false,
  },
  {
    intent: "SEGURIDAD_LOTE",
    tool: "seguridad.evaluar_lote",
    frases: [
      "puedo congelar",
      "se puede congelar",
      "recongelar",
      "volver a congelar",
      "todavia sirve",
      "todavia esta bueno",
    ],
    pideAlimento: false,
  },
  {
    intent: "COMPRAS_LISTA",
    tool: "compras.lista_actual",
    frases: [
      "que tengo que comprar",
      "que hay que comprar",
      "que compro",
      "que falta comprar",
      "lista de compras",
      "para la feria",
    ],
    pideAlimento: false,
  },
  {
    intent: "PORCIONES_EXPLICAR",
    tool: "porciones.explicar",
    frases: ["por que mi plato", "por que me toco", "por que salio distinto", "por que mi porcion"],
    pideAlimento: false,
  },
  {
    intent: "PORCIONES_PROYECTAR",
    tool: "porciones.proyectar",
    frases: ["cuanto cocino", "cuanto preparo", "cuanto hago de", "para cuantos alcanza"],
    pideAlimento: true,
  },
  {
    intent: "SALUD_RECENCIA",
    tool: "salud.resumen_integrante",
    frases: ["cuando me toca control", "cuando le toca control", "cuando fue el ultimo examen"],
    pideAlimento: false,
  },
  {
    intent: "PLAN_DIA",
    tool: "plan.leer_dia",
    frases: [
      "que hay de comer",
      "que comemos",
      "que se cocina",
      "que toca comer",
      "que hay para la once",
      "que hay de almuerzo",
      "que hay de cena",
    ],
    pideAlimento: false,
  },
  {
    intent: "STOCK_DE_ALIMENTO",
    tool: "stock.de_alimento",
    // Ojo con lo que NO está: "tengo" a secas. Se comía "tengo suficiente para
    // el cumpleaños", que no es una pregunta de stock de un alimento, y la
    // mandaba a un camino que exige alimento para después no encontrarlo.
    frases: ["cuanto queda", "me queda", "me quedan", "cuanto tengo de", "queda", "quedan"],
    pideAlimento: true,
  },
];

/** Palabras del dominio, para detectar cuándo una pregunta cruza dos mundos. */
const PALABRAS_DE_DOMINIO: Readonly<Record<Dominio, readonly string[]>> = {
  DESPENSA: ["queda", "quedan", "despensa", "congelador", "vence", "stock", "tengo"],
  PLAN: ["comer", "almuerzo", "cena", "once", "plan", "semana", "domingo", "asado", "menu"],
  COMPRAS: ["comprar", "compro", "feria", "supermercado", "lista", "alcanza"],
  PORCIONES: ["porcion", "porciones", "cocino", "gramos", "plato", "sirvo"],
  RECETAS: ["receta", "recetas", "preparacion"],
  SEGURIDAD: ["congelar", "recongelar", "descongelar", "vencido", "malo"],
  PREP: ["preparar", "adelantar", "batch"],
  SALUD: ["examen", "control", "restriccion", "sodio", "presion"],
  SOPORTE: [],
};

export function dominiosMencionados(textoNormalizado: string): readonly Dominio[] {
  const palabras = new Set(textoNormalizado.split(" "));
  const salida: Dominio[] = [];
  for (const [dominio, claves] of Object.entries(PALABRAS_DE_DOMINIO)) {
    if (claves.some((c) => palabras.has(c))) salida.push(dominio as Dominio);
  }
  return salida;
}

// ---------------------------------------------------------------------------
// El extractor de alimento
// ---------------------------------------------------------------------------

export interface OpcionAlimento {
  readonly id: string;
  readonly nombre: UntrustedText | string;
}

export interface RefLegible {
  readonly id: string;
  readonly etiqueta: EtiquetaSegura;
}

/**
 * Un dato desconocido presentado como conocido es peor que no responder, y acá
 * no hay modelo de por medio que lo suavice.
 *
 * Una casa con "pollo entero", "pollo trutro" y "pollo pechuga" que pregunta
 * "cuánto pollo me queda" NO recibe la respuesta de uno de los tres con cara de
 * certeza: recibe los tres, nombrados. Y "cuánta quinoa me queda" en una casa
 * sin quinoa recibe "no encontré ningún alimento que se llame así", que es la
 * verdad — no un parecido difuso con "quinoto".
 */
export type Coincidencia =
  | { readonly match: "UNICO"; readonly ref: RefLegible }
  | { readonly match: "AMBIGUO"; readonly candidatos: readonly RefLegible[] }
  | { readonly match: "NINGUNO" };

/** Palabras que no identifican comida. Sin esto, "de" haría match con todo. */
const VACIAS = new Set([
  "cuanto", "cuanta", "cuantos", "cuantas", "me", "queda", "quedan", "tengo", "hay", "de", "del",
  "la", "el", "los", "las", "un", "una", "que", "para", "en", "y", "o", "con", "mi", "mis", "se",
  "esta", "estan", "cocino", "preparo", "hago", "todavia", "aun", "por", "al",
]);

function tokens(texto: string): string[] {
  return normalizar(texto)
    .split(" ")
    .filter((t) => t.length > 0);
}

function significativos(texto: string): string[] {
  return tokens(texto).filter((t) => !VACIAS.has(t) && t.length > 2);
}

/**
 * Comparación por TOKEN EXACTO, nunca por parecido. Nada de distancia de
 * edición ni de trigramas: "quinoto" no puede convertirse en "quinoa" porque el
 * costo de equivocarse (responder por otro alimento con cara de certeza) es más
 * caro que el de decir "no encontré".
 */
export function extraerAlimento(
  pregunta: string,
  opciones: readonly OpcionAlimento[],
): Coincidencia {
  const enLaPregunta = new Set(significativos(pregunta));
  if (enLaPregunta.size === 0) return { match: "NINGUNO" };

  const fuertes: { opcion: OpcionAlimento; peso: number }[] = [];
  const debiles: OpcionAlimento[] = [];

  for (const opcion of opciones) {
    const propios = significativos(opcion.nombre);
    if (propios.length === 0) continue;
    const calzan = propios.filter((t) => enLaPregunta.has(t));
    if (calzan.length === propios.length) fuertes.push({ opcion, peso: propios.length });
    else if (calzan.length > 0) debiles.push(opcion);
  }

  const ref = (o: OpcionAlimento): RefLegible => ({ id: o.id, etiqueta: trustAsLabel(o.nombre) });

  if (fuertes.length > 0) {
    // "pollo entero" gana sobre "pollo" cuando la pregunta dice las dos
    // palabras: el nombre más específico que entra completo en la pregunta.
    let mejor = 0;
    for (const f of fuertes) if (f.peso > mejor) mejor = f.peso;
    const empatados = fuertes.filter((f) => f.peso === mejor);
    const unico = empatados.length === 1 ? empatados[0] : undefined;
    if (unico !== undefined) return { match: "UNICO", ref: ref(unico.opcion) };
    return { match: "AMBIGUO", candidatos: empatados.map((f) => ref(f.opcion)) };
  }

  const unicoDebil = debiles.length === 1 ? debiles[0] : undefined;
  if (unicoDebil !== undefined) return { match: "UNICO", ref: ref(unicoDebil) };
  if (debiles.length > 1) return { match: "AMBIGUO", candidatos: debiles.map(ref) };
  return { match: "NINGUNO" };
}

// ---------------------------------------------------------------------------
// Las rutas
// ---------------------------------------------------------------------------

export type RazonSinModelo =
  | "SIN_CONSENTIMIENTO"
  | "PROVEEDOR_NO_DISPONIBLE"
  | "PRESUPUESTO_AGOTADO"
  | "CIRCUITO_ABIERTO";

/**
 * Ojo con lo que NO está: la `confianza` léxica. En el diseño viajaba en la
 * ruta, y de ahí al payload y al texto hay un paso. La confianza es de
 * ENRUTAMIENTO: sirve para elegir capa y muere ahí. Un "85% seguro de que
 * hablabas del pollo entero" en una respuesta es una certeza inventada.
 */
export type Ruta =
  | { readonly capa: 0; readonly tipo: "COMANDO"; readonly tool: ReadToolName; readonly args: unknown }
  | {
      readonly capa: 1;
      readonly tipo: "PATRON";
      readonly intent: Intent;
      readonly tool: ReadToolName;
      readonly args: unknown;
    }
  | {
      readonly capa: 1;
      readonly tipo: "ELEGIR";
      readonly intent: Intent;
      readonly tool: ReadToolName;
      readonly candidatos: readonly RefLegible[];
    }
  | { readonly capa: 1; readonly tipo: "NO_ENCONTRADO"; readonly intent: Intent }
  | {
      readonly capa: 2;
      readonly tipo: "MODELO_SELECTOR";
      readonly catalogo: readonly ReadToolName[];
    }
  | { readonly capa: 3; readonly tipo: "MODELO_PLAN"; readonly catalogo: readonly ReadToolName[] }
  | {
      readonly capa: 9;
      readonly tipo: "SIN_MOTOR";
      readonly tool: ReadToolName;
      readonly sprint: 12 | 13 | 14 | null;
      readonly que: string;
    }
  | { readonly capa: 9; readonly tipo: "SIN_MODELO"; readonly razon: RazonSinModelo }
  | { readonly capa: 9; readonly tipo: "FUERA_DE_ALCANCE" };

export interface EntradaRouter {
  /** Lo que la persona escribió. */
  readonly texto: string;
  /** Chip del inbox o atajo: herramienta y argumentos ya fijos, cero modelo. */
  readonly comando?: { readonly tool: ReadToolName; readonly args: unknown };
  readonly alimentos: readonly OpcionAlimento[];
  /**
   * `true` si el turno arrastra texto guardado o de un OCR. Apaga la capa 3 y
   * saca del catálogo lo que propone.
   */
  readonly hayTextoDeTerceros: boolean;
  readonly consentimiento: boolean;
  readonly proveedorDisponible: boolean;
  readonly presupuestoDisponible: boolean;
  readonly circuitoAbierto: boolean;
}

function huecoDe(texto: string): Hueco | null {
  for (const hueco of HUECOS) {
    if (hueco.frases.some((f) => texto.includes(f))) return hueco;
  }
  return null;
}

export function enrutar(entrada: EntradaRouter): Ruta {
  if (entrada.comando !== undefined) {
    return { capa: 0, tipo: "COMANDO", tool: entrada.comando.tool, args: entrada.comando.args };
  }

  const texto = normalizar(entrada.texto);
  if (texto.length === 0) return { capa: 9, tipo: "FUERA_DE_ALCANCE" };

  // Los huecos primero: cero tokens para descubrir lo que ya sabíamos.
  const hueco = huecoDe(texto);
  if (hueco !== null) {
    const ficha = CATALOGO[hueco.tool];
    if (ficha.sellada === null) throw new Error(`${hueco.tool} está en HUECOS y no está sellada`);
    return {
      capa: 9,
      tipo: "SIN_MOTOR",
      tool: hueco.tool,
      sprint: ficha.sellada.sprint,
      que: ficha.sellada.que,
    };
  }

  for (const patron of PATRONES) {
    if (!patron.frases.some((f) => texto.includes(f))) continue;
    if (!patron.pideAlimento) {
      return { capa: 1, tipo: "PATRON", intent: patron.intent, tool: patron.tool, args: {} };
    }
    const alimento = extraerAlimento(entrada.texto, entrada.alimentos);
    if (alimento.match === "UNICO") {
      return {
        capa: 1,
        tipo: "PATRON",
        intent: patron.intent,
        tool: patron.tool,
        args: { ingredientId: alimento.ref.id },
      };
    }
    if (alimento.match === "AMBIGUO") {
      return {
        capa: 1,
        tipo: "ELEGIR",
        intent: patron.intent,
        tool: patron.tool,
        candidatos: alimento.candidatos,
      };
    }
    // NINGUNO no cae a la capa 2 esperando que el modelo adivine: el modelo no
    // tiene más información que nosotros sobre qué alimentos hay en esta casa.
    return { capa: 1, tipo: "NO_ENCONTRADO", intent: patron.intent };
  }

  // De acá para abajo se paga.
  if (!entrada.consentimiento) {
    return { capa: 9, tipo: "SIN_MODELO", razon: "SIN_CONSENTIMIENTO" };
  }
  if (entrada.circuitoAbierto) return { capa: 9, tipo: "SIN_MODELO", razon: "CIRCUITO_ABIERTO" };
  if (!entrada.proveedorDisponible) {
    return { capa: 9, tipo: "SIN_MODELO", razon: "PROVEEDOR_NO_DISPONIBLE" };
  }
  if (!entrada.presupuestoDisponible) {
    return { capa: 9, tipo: "SIN_MODELO", razon: "PRESUPUESTO_AGOTADO" };
  }

  const dominios = dominiosMencionados(texto);
  const catalogo = catalogoParaProveedor(
    dominios.length === 0 ? ["DESPENSA", "PLAN", "COMPRAS"] : dominios,
    entrada.hayTextoDeTerceros,
  );

  // La capa 3 encadena y por eso es la que más superficie abre. Con texto de
  // terceros adentro del turno, no se enciende: la cadena podría terminar en una
  // propuesta que decidió el que escribió la boleta.
  if (dominios.length >= 2 && !entrada.hayTextoDeTerceros) {
    return { capa: 3, tipo: "MODELO_PLAN", catalogo };
  }
  return { capa: 2, tipo: "MODELO_SELECTOR", catalogo };
}

// ---------------------------------------------------------------------------
// Los topes del turno
// ---------------------------------------------------------------------------

export interface LimitesTurno {
  readonly maxLlamadas: number;
  readonly maxRondas: number;
  /** Tope por HERRAMIENTA, sin importar los argumentos. Ver `permitirHerramienta`. */
  readonly maxPorHerramienta: number;
  /** El costo verdadero de las capas 1 a 3 no son tokens: son consultas. */
  readonly maxConsultasDb: number;
  readonly maxTokensEntrada: number;
  readonly maxTokensSalida: number;
  readonly maxMs: number;
  /** No se empieza una llamada nueva si queda menos que esto. */
  readonly reservaMs: number;
  /** Cuántos payloads con contenido clínico puede cruzar UN turno. */
  readonly maxDivulgacionClinica: number;
  readonly maxReintentos: number;
}

/**
 * Los números, y por qué:
 *
 * `maxMs` = 20 s con un límite de plataforma de 30 s. El margen no es paranoia:
 * si el turno se pasa, el usuario ve el error genérico de la plataforma en vez
 * de la respuesta parcial honesta, que es justo el modo de falla que todo este
 * archivo intenta evitar. Y es UN presupuesto descendente para todo el turno —
 * proveedor y herramientas — no un timeout por llamada: con timeout por llamada,
 * dos rondas de 20 s son 40 s.
 *
 * `maxConsultasDb` = 40: `loadStockInput` son ~10 consultas, así que cuatro
 * cargadores pesados llenan el turno. Sin este tope, el modelo pide la misma
 * herramienta con ocho alimentos distintos —ocho huellas legítimas— y dispara
 * ~50 consultas sin que ningún límite se entere.
 */
export const LIMITES_POR_OMISION: LimitesTurno = {
  maxLlamadas: 5,
  maxRondas: 2,
  maxPorHerramienta: 2,
  maxConsultasDb: 40,
  // Un solo dueño del número: el tope de entrada lo fija el ensamblador, que es
  // el que sabe cuánto pesa el prompt de verdad.
  maxTokensEntrada: TOPE_TOKENS_ENTRADA,
  maxTokensSalida: 700,
  maxMs: 20_000,
  reservaMs: 3_000,
  maxDivulgacionClinica: 1,
  maxReintentos: 1,
};

export type MotivoDeCorte =
  | "HUELLA_REPETIDA"
  | "SIN_PROGRESO"
  | "MAX_LLAMADAS"
  | "MAX_POR_HERRAMIENTA"
  | "MAX_RONDAS"
  | "MAX_CONSULTAS_DB"
  | "MAX_REINTENTOS"
  | "TIEMPO_AGOTADO"
  | "SIN_MARGEN"
  | "TOKENS_ENTRADA"
  | "DIVULGACION_CLINICA";

export type Permiso = { readonly ok: true } | { readonly ok: false; readonly motivo: MotivoDeCorte };

const PERMITIDO: Permiso = { ok: true };

export function huella(tool: ToolName, args: unknown): string {
  return createHash("sha1").update(`${tool} ${JSON.stringify(args)}`).digest("hex");
}

/**
 * El contador del turno. Es un objeto y no una cuenta suelta porque las cuatro
 * monedas —llamadas, consultas, tiempo y tokens— se agotan de a una y todas
 * cortan igual: lo que no puede pasar es que el turno termine y NADIE sepa que
 * quedó incompleto.
 *
 * El reloj entra por parámetro: este archivo no llama a `new Date()`, y así el
 * test del deadline no depende de dormir de verdad.
 */
export class ContadorTurno {
  private readonly limites: LimitesTurno;
  private readonly reloj: () => number;
  private readonly inicio: number;
  private readonly huellas = new Set<string>();
  private readonly porHerramienta = new Map<ToolName, number>();
  private readonly idsVistos = new Set<string>();
  private readonly herramientasVistas = new Set<ToolName>();
  private llamadas = 0;
  private rondas = 0;
  private consultas = 0;
  private reintentos = 0;
  private divulgacionClinica = 0;
  private tokensEntrada = 0;
  private tokensSalida = 0;
  private llamadasProveedor = 0;
  private novedadDeLaRonda = false;
  private corte: MotivoDeCorte | null = null;

  constructor(reloj: () => number, limites: LimitesTurno = LIMITES_POR_OMISION) {
    this.reloj = reloj;
    this.limites = limites;
    this.inicio = reloj();
  }

  get motivoDeCorte(): MotivoDeCorte | null {
    return this.corte;
  }

  get totales(): {
    llamadasProveedor: number;
    llamadasHerramienta: number;
    consultasDb: number;
    tokensEntrada: number;
    tokensSalida: number;
    ms: number;
  } {
    return {
      llamadasProveedor: this.llamadasProveedor,
      llamadasHerramienta: this.llamadas,
      consultasDb: this.consultas,
      tokensEntrada: this.tokensEntrada,
      tokensSalida: this.tokensSalida,
      ms: this.reloj() - this.inicio,
    };
  }

  msRestantes(): number {
    return this.limites.maxMs - (this.reloj() - this.inicio);
  }

  private cortar(motivo: MotivoDeCorte): Permiso {
    if (this.corte === null) this.corte = motivo;
    return { ok: false, motivo };
  }

  private margen(): Permiso {
    const quedan = this.msRestantes();
    if (quedan <= 0) return this.cortar("TIEMPO_AGOTADO");
    // Empezar una llamada que no alcanza a terminar es gastar el plazo en algo
    // que igual se va a tirar, y encima deja la consulta viva en la base.
    if (quedan < this.limites.reservaMs) return this.cortar("SIN_MARGEN");
    return PERMITIDO;
  }

  /**
   * Tres topes, no uno. La huella exacta no basta: pedir `stock.de_alimento` con
   * ocho ingredientes distintos son ocho huellas nuevas, ocho llamadas legítimas
   * y ninguna repetición. Por eso también hay tope por herramienta y contador
   * real de consultas.
   */
  permitirHerramienta(tool: ToolName, args: unknown): Permiso {
    const margen = this.margen();
    if (!margen.ok) return margen;
    if (this.llamadas >= this.limites.maxLlamadas) return this.cortar("MAX_LLAMADAS");
    if (this.consultas >= this.limites.maxConsultasDb) return this.cortar("MAX_CONSULTAS_DB");
    const usos = this.porHerramienta.get(tool);
    if (usos !== undefined && usos >= this.limites.maxPorHerramienta) {
      return this.cortar("MAX_POR_HERRAMIENTA");
    }
    if (this.huellas.has(huella(tool, args))) return this.cortar("HUELLA_REPETIDA");
    return PERMITIDO;
  }

  registrarHerramienta(
    tool: ToolName,
    args: unknown,
    datos: {
      readonly consultasDb: number;
      readonly divulgacionClinica: 0 | 1;
      readonly idsAmbito: readonly string[];
    },
  ): Permiso {
    this.llamadas += 1;
    this.huellas.add(huella(tool, args));
    const usos = this.porHerramienta.get(tool);
    this.porHerramienta.set(tool, usos === undefined ? 1 : usos + 1);
    this.consultas += datos.consultasDb;

    if (!this.herramientasVistas.has(tool)) {
      this.herramientasVistas.add(tool);
      this.novedadDeLaRonda = true;
    }
    for (const id of datos.idsAmbito) {
      if (!this.idsVistos.has(id)) {
        this.idsVistos.add(id);
        this.novedadDeLaRonda = true;
      }
    }

    this.divulgacionClinica += datos.divulgacionClinica;
    if (this.divulgacionClinica > this.limites.maxDivulgacionClinica) {
      // Un chat es, por diseño, un motor de correlación: cada herramienta pasa
      // su `redact()` sola y la suma reconstruye lo que ninguna reveló.
      return this.cortar("DIVULGACION_CLINICA");
    }
    return PERMITIDO;
  }

  permitirProveedor(tokensEntradaEstimados: number): Permiso {
    const margen = this.margen();
    if (!margen.ok) return margen;
    if (this.rondas >= this.limites.maxRondas) return this.cortar("MAX_RONDAS");
    if (tokensEntradaEstimados > this.limites.maxTokensEntrada) {
      return this.cortar("TOKENS_ENTRADA");
    }
    return PERMITIDO;
  }

  registrarProveedor(tokensEntrada: number, tokensSalida: number): void {
    this.llamadasProveedor += 1;
    this.tokensEntrada += tokensEntrada;
    this.tokensSalida += tokensSalida;
  }

  /**
   * El reintento por salida inválida cuesta lo mismo que la llamada original:
   * cuenta como ronda, descuenta presupuesto y respeta el plazo. Insistir cuando
   * el proveedor devuelve basura es exactamente cuando conviene frenar.
   */
  permitirReintento(): Permiso {
    if (this.reintentos >= this.limites.maxReintentos) return this.cortar("MAX_REINTENTOS");
    return this.margen();
  }

  registrarReintento(): void {
    this.reintentos += 1;
  }

  /** Una ronda que no agrega ninguna herramienta nueva ni ningún id nuevo. */
  cerrarRonda(): Permiso {
    this.rondas += 1;
    const hubo = this.novedadDeLaRonda;
    this.novedadDeLaRonda = false;
    if (!hubo) return this.cortar("SIN_PROGRESO");
    if (this.rondas >= this.limites.maxRondas) return this.cortar("MAX_RONDAS");
    return PERMITIDO;
  }
}

// ---------------------------------------------------------------------------
// El estado del turno: lo que no salió NO puede desaparecer
// ---------------------------------------------------------------------------

export type MotivoParcial =
  | { readonly tipo: "SIN_MOTOR"; readonly tool: ToolName; readonly sprint: 12 | 13 | 14; readonly que: string }
  | { readonly tipo: "LECTURA_FALLIDA"; readonly tool: ToolName; readonly codigo: UnavailableCode }
  | { readonly tipo: "SIN_PERMISO"; readonly tool: ToolName }
  | { readonly tipo: "ENTRADA_INVALIDA"; readonly tool: ToolName }
  | { readonly tipo: "NO_CONFIRMADO"; readonly tool: ToolName }
  | { readonly tipo: "DESACTUALIZADO"; readonly tool: ToolName }
  | { readonly tipo: "VALOR_INCIERTO"; readonly tool: ToolName; readonly unknown: Unknown }
  | { readonly tipo: "CORTE"; readonly motivo: MotivoDeCorte }
  | { readonly tipo: "TRUNCADO"; readonly unknown: Unknown };

export interface EstadoDelTurno {
  readonly parcial: boolean;
  readonly motivos: readonly MotivoParcial[];
}

export interface SalidaDeHerramienta {
  readonly tool: ToolName;
  readonly outcome: ToolOutcome<unknown>;
}

/**
 * Recibe el arreglo COMPLETO de salidas del turno, no solo las que salieron
 * bien. Esa firma es la corrección: un turno de tres herramientas donde una dio
 * OK, otra `NOT_BUILT` y otra `UNAVAILABLE` termina normal, y el modelo redacta
 * una respuesta fluida y afirmativa sobre la parte fácil. Omitir es su falla más
 * natural y la más invisible, así que la decisión no se le delega: lo que no
 * salió se compone acá, con código, y el renderer lo pinta sí o sí.
 *
 * Los `unknowns` viajan por el mismo camino y por la misma razón: un motor que
 * dice UNRESOLVED y un asistente que redacta alrededor es peor que no tener
 * asistente.
 */
export function estadoDelTurno(
  salidas: readonly SalidaDeHerramienta[],
  extras: {
    readonly motivoDeCorte: MotivoDeCorte | null;
    readonly truncados: readonly Unknown[];
  } = { motivoDeCorte: null, truncados: [] },
): EstadoDelTurno {
  const motivos: MotivoParcial[] = [];

  for (const { tool, outcome } of salidas) {
    switch (outcome.status) {
      case "OK":
        for (const u of outcome.payload.unknowns) {
          motivos.push({ tipo: "VALOR_INCIERTO", tool, unknown: u });
        }
        break;
      case "NOT_BUILT":
        motivos.push({ tipo: "SIN_MOTOR", tool, sprint: outcome.sprint, que: outcome.que });
        break;
      case "UNAVAILABLE":
        motivos.push({ tipo: "LECTURA_FALLIDA", tool, codigo: outcome.codigo });
        break;
      case "NOT_PERMITTED":
        motivos.push({ tipo: "SIN_PERMISO", tool });
        break;
      case "INVALID_INPUT":
        motivos.push({ tipo: "ENTRADA_INVALIDA", tool });
        break;
      case "NOT_CONFIRMED":
        motivos.push({ tipo: "NO_CONFIRMADO", tool });
        break;
      case "STALE":
        motivos.push({ tipo: "DESACTUALIZADO", tool });
        break;
    }
  }

  for (const u of extras.truncados) motivos.push({ tipo: "TRUNCADO", unknown: u });
  if (extras.motivoDeCorte !== null) {
    motivos.push({ tipo: "CORTE", motivo: extras.motivoDeCorte });
  }

  return { parcial: motivos.length > 0, motivos };
}
