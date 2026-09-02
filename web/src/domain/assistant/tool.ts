import type { z } from "zod";
import type { PostgrestError } from "@supabase/supabase-js";
import type { NutritionSource } from "@/domain/clinical/types";
import type { Reason, ReasonCode } from "@/domain/portions/reasons";
import type { Actor, Capability } from "@/lib/auth/actor";
import type { ConfirmationGrant, ProposalDraft } from "./proposal";

/**
 * LA FRONTERA DE HERRAMIENTAS.
 *
 * La regla que gobierna este archivo entero: EL CHAT NO ES EL BOTÓN. Un
 * asistente que puede ejecutar porque alguien se lo pidió en lenguaje natural
 * ejecuta lo que le pida cualquier texto que alcance a leer — incluido el que
 * venga adentro de una receta, de una boleta escaneada o del nombre de un
 * alimento.
 *
 * Por eso LEER y ACTUAR no son dos valores de una bandera: son dos tipos
 * disjuntos. `ReadTool` y `ActionTool` no son asignables entre sí (difieren en
 * `kind`, en `effect`, en el contexto que recibe `run` y en la aridad de `run`),
 * viven en registries distintos y los corren funciones distintas: `runReadTool`
 * —la única que ve el router— y `runActionTool`, que exige una
 * `ConfirmationGrant` que solo `claimProposal` puede fabricar.
 *
 * Lo que acá es imposible, no improbable:
 *  · Una herramienta de lectura no recibe nada con qué escribir: su `db` es
 *    `ReadOnlyDb`, una interfaz PROPIA sin `insert/update/delete/upsert`. No es
 *    un proxy que revienta en producción; es un tipo que no compila.
 *  · Una acción no se puede invocar sin `{proposalId, acceptedByMemberId,
 *    confirmationToken}`: viajan dentro de la `ConfirmationGrant` que
 *    `runActionTool` pide en su firma.
 *  · Una acción no se puede invocar sin clave de idempotencia: `callAction` la
 *    exige como parámetro.
 */

// ---------------------------------------------------------------------------
// Vocabulario cerrado
// ---------------------------------------------------------------------------

export type ReadKind = "READ" | "PROPOSE";
export type ToolKind = ReadKind | "ACT";

/** Efectos que un `ReadTool` puede declarar. Nada de materia, plata ni clínica. */
export type ReadEffect =
  | "NONE" // no escribe nada, ni una fila de auditoría de dominio
  | "PROPOSAL_ONLY"; // escribe solo en assistant_proposals

/** Efectos que solo un `ActionTool` puede declarar. */
export type WriteEffect =
  | "WRITES_PREFS" // objetivos, preferencias, targets: reversible, no físico
  | "WRITES_PLAN" // plan semanal, eventos, participantes
  | "WRITES_LEDGER" // mueve materia: lotes, consumo, recepción, mermas
  | "WRITES_MONEY" // órdenes a proveedor, recepción de órdenes
  | "WRITES_CLINICAL" // restricciones, observaciones, evaluaciones
  | "WRITES_GRANTS"; // permisos médicos o financieros

export type ToolEffect = ReadEffect | WriteEffect;

export type RiskLevel = "BAJO" | "MEDIO" | "ALTO";

/**
 * Tablas cuyo hogar sabe resolver `app.row_scope` (migración 0050). Todo uuid
 * que produce el modelo pasa por acá antes de tocar un RPC: un id es texto
 * ajeno, igual que el de una boleta.
 */
export const SCOPED_TABLES = [
  "household_members",
  "weekly_plans",
  "weekly_plan_days",
  "meal_assignments",
  "shopping_lists",
  "shopping_list_items",
  "procurement_orders",
  "prep_plans",
  "meal_templates",
  "meal_template_versions",
  "inventory_lots",
] as const;

export type ScopedTable = (typeof SCOPED_TABLES)[number];

/**
 * RPC que una herramienta de lectura puede llamar. Lista literal: `.rpc()` con
 * nombre variable está prohibido bajo `src/domain/assistant/**`.
 *
 * Son los nombres del esquema `public`, que es lo único que PostgREST alcanza.
 *
 * `ensure_weekly_plan` NO está y no puede estar: crea una fila en `weekly_plans`
 * y siete en `weekly_plan_days`. Preguntar "¿qué compro para la semana del 15?"
 * no puede inventar una semana que nadie planificó (regla "preguntar nunca
 * ejecuta"). Falta acá `load_week_readonly` —el lector que devuelve `null`
 * cuando la semana no existe— porque todavía no hay migración que lo cree: la
 * lista dice lo que HAY, no lo que nos gustaría.
 *
 * Pertenecer a esta lista no basta: un `security definer` puede escribir igual.
 * La guarda de esquema verifica contra `pg_proc` que cada función acá sea
 * `stable` o `immutable`.
 */
export const READ_RPCS = [
  "assistant_row_stamps",
  "assistant_engine_stamps",
] as const;

export type ReadRpcName = (typeof READ_RPCS)[number];

/**
 * Las server actions que YA existen. El asistente no inventa escrituras: elige
 * una de esta lista o no hay escritura. No existe `execute_sql`, no existe `rpc`
 * genérico, no existe `query`.
 */
export const EXISTING_ACTIONS = [
  // MEDIO — reversible, no mueve materia
  "setStockTarget",
  "deleteStockTarget",
  "saveDailyOverride",
  "clearDailyOverride",
  "setCookingPreference",
  "setIngredientPreference",
  "setTrackingMode",
  "setAddedFatStance",
  "assignMeal",
  "setMealParticipants",
  "saveSubstitution",
  "clearSubstitution",
  "setItemStatus",
  "editPlannedQuantity",
  "addManualItem",
  "removeManualItem",
  "generatePrepPlan",
  "skipTask",
  "createLabelsForTask",
  "runExtraction",
  // ALTO físico
  "consumePlannedMeal",
  "receiveShoppingList",
  "adjustLot",
  "discardLot",
  "addManualLot",
  "moveLot",
  "qrUseLot",
  "qrUpdateWeight",
  "qrDiscardLot",
  "completeTask",
  "recordObservedYield",
  "resolveShortfall",
  "confirmMeal",
  "unconfirmMeal",
  "completeList",
  // ALTO financiero
  "approveSuggestion",
  "advanceOrder",
  "receiveOrder",
  "saveSupplierProduct",
  "savePurchasePolicy",
  // ALTO clínico
  "createRestriction",
  "setRestrictionStatus",
  "confirmReview",
  "correctObservation",
  "resolveImpact",
  "assessMeal",
  "uploadExam",
  "setConsent",
  // ALTO permisos
  "grantAccess",
  "revokeAccess",
] as const;

export type ExistingActionName = (typeof EXISTING_ACTIONS)[number];

/**
 * Nombres de herramienta de LECTURA. Unión literal cerrada: el dispatcher hace
 * `REGISTRY[name]` y un nombre desconocido es `INVALID_INPUT`, jamás un
 * passthrough.
 */
export type ReadToolName =
  | "despensa.listar"
  | "despensa.por_vencer"
  | "stock.resumen"
  | "stock.de_alimento"
  | "plan.leer_semana"
  | "plan.leer_dia"
  | "compras.lista_actual"
  | "compras.previsualizar_cambios"
  | "porciones.proyectar"
  | "porciones.explicar"
  | "recetas.buscar"
  | "recetas.detalle"
  | "seguridad.evaluar_lote"
  | "prep.previsualizar"
  | "procurement.previsualizar"
  | "salud.resumen_integrante"
  | "calendario.hoy"
  // Entradas selladas: existen para que el modelo NO pueda "llamarlas" y
  // rellenar. Devuelven NOT_BUILT sin tocar nada (§1.4).
  | "nutricion.adaptativa"
  | "eventos.estimar"
  | "finanzas.resumen"
  | "comidas.compatibilidad"
  | "familia.optimizar";

/**
 * El nombre de una herramienta de acción se DERIVA de la acción existente que
 * invoca. No hay forma de nombrar una herramienta de acción que no corresponda a
 * una server action ya construida.
 */
export type ActionToolName = `accion.${ExistingActionName}`;

export type ToolName = ReadToolName | ActionToolName;

// ---------------------------------------------------------------------------
// Texto ajeno
// ---------------------------------------------------------------------------

declare const MARCA_AJENA: unique symbol;

/**
 * Todo string que salió de una fila de la base es contenido no confiable: lo
 * escribió una persona (el nombre de un ingrediente, la nota de una receta, el
 * nombre de un invitado) y puede traer adentro delimitadores o algo que se lea
 * como instrucción. La marca es nominal para que el compilador obligue a pasar
 * por `untrusted()` y el ensamblador de prompt sepa qué escapar.
 *
 * La marca NO sanitiza: solo clasifica por ORIGEN. Escapar es trabajo de
 * `lib/ai/prompt.ts`, y este tipo es lo que hace que no pueda olvidarse.
 */
export type UntrustedText = string & { readonly [MARCA_AJENA]: "ajeno" };

export function untrusted(valor: string): UntrustedText {
  return valor as UntrustedText;
}

/**
 * Un `Reason` YA COMPUESTO nunca cruza al proveedor: `TEMPLATES[code](params)`
 * interpola crudo, así que la frase en español lleva adentro el texto del
 * atacante en el canal de mayor confianza. Al modelo se le entrega `{code,
 * params}` con los params marcados como ajenos, y la plantilla se aplica al
 * renderizar en el servidor.
 */
export interface ReasonSinTexto {
  readonly code: ReasonCode;
  readonly params: Readonly<Record<string, UntrustedText | number>>;
}

export function sinTexto(r: Reason): ReasonSinTexto {
  const params: Record<string, UntrustedText | number> = {};
  for (const [k, v] of Object.entries(r.params)) {
    params[k] = typeof v === "number" ? v : untrusted(v);
  }
  return { code: r.code, params };
}

// ---------------------------------------------------------------------------
// Procedencia y desconocidos
// ---------------------------------------------------------------------------

export interface Provenance {
  /** "portion-optimizer" */
  readonly motor: string;
  /** La constante real del módulo: "portion-optimizer/1.0.0". */
  readonly version: string;
  /** Ids de entrada (versionId, profileVersion…), nunca valores. */
  readonly entrada?: Readonly<Record<string, string>>;
}

/**
 * Procedencia de todo lo que afirme algo NUTRICIONAL: un veredicto, un límite o
 * un número de nutriente.
 *
 * `fuenteNutricion` es obligatoria y sin `?`, igual que en
 * `ClinicalAssessmentInput`. El motor clínico ya la trata como obligatoria
 * porque sin ella un "dentro del límite" no distingue la porción de esta persona
 * del promedio de la olla. El asistente era la única capa donde el dato podía
 * evaporarse: `.strict()` de Zod prohíbe campos EXTRA, no exige opcionales, así
 * que una herramienta que omitiera el campo pasaba la validación sin ruido.
 */
export interface ProvenanceNutricional extends Provenance {
  readonly fuenteNutricion: NutritionSource;
}

export function esProvenanceNutricional(p: Provenance): p is ProvenanceNutricional {
  return typeof (p as Partial<ProvenanceNutricional>).fuenteNutricion === "string";
}

/**
 * Vocabulario cerrado de lo que NO se sabe. Ningún resumen puede colapsarlo a 0
 * ni a "todo bien": UNKNOWN != ZERO.
 */
export type UnknownSymbol =
  | "UNRESOLVED"
  | "INSUFFICIENT_DATA"
  | "NO_EXPECTED_DEMAND"
  | "UNVERIFIABLE_CONSTRAINT"
  | "MISSING_DATA"
  | "SAFETY_REVIEW_REQUIRED"
  | "UNRESOLVED_DEMAND"
  | "PREP_UNRESOLVED"
  | "PROCUREMENT_UNRESOLVED"
  | "EXCLUDED_PRODUCT_LOTS"
  | "SCREENING_ONLY"
  | "NO_ENGINE"
  | "TRUNCATED_BY_LIMIT";

export interface Unknown {
  /** "cobertura", "rendimiento", "límite" */
  readonly campo: string;
  readonly simbolo: UnknownSymbol;
  /** Frase en español chileno, ya compuesta por el dominio (no por el modelo). */
  readonly motivo: string;
}

// ---------------------------------------------------------------------------
// Sobre de salida
// ---------------------------------------------------------------------------

export interface ToolPayload<O> {
  readonly data: O;
  readonly provenance: readonly Provenance[];
  readonly unknowns: readonly Unknown[];
  readonly reasons: readonly ReasonSinTexto[];
  /**
   * Etiquetas legibles para los ids que trae `data`: el modelo redacta con esto
   * y los uuid viajan aparte, nunca al texto. Son `UntrustedText` porque su
   * contenido es exactamente lo que un integrante escribió.
   */
  readonly labels: Readonly<Record<string, UntrustedText>>;
  /**
   * Solo `kind:"PROPOSE"`, y obligatorio ahi. La herramienta arma el borrador;
   * quien lo escribe es el runtime. Una herramienta con `effect:"NONE"` que
   * traiga borrador —o una `PROPOSAL_ONLY` que no lo traiga— es FORMA_INVALIDA:
   * el efecto declarado y lo que la salida hace tienen que coincidir.
   */
  readonly propuesta?: ProposalDraft;
}

export type UnavailableCode =
  | "LECTURA_FALLIDA" // DataAccessError propagado, jamás tragado
  | "FORMA_INVALIDA" // DataShapeError
  | "TIEMPO_AGOTADO"
  | "PRESUPUESTO_AGOTADO"
  | "PAYLOAD_EXCESIVO" // más filas de las que la herramienta declaró poder mostrar
  | "SIN_CONSENTIMIENTO"
  /**
   * La acción corrió y dijo que NO, sin escribir. Es distinto de "no sé si
   * escribió": acá sí se sabe, y la respuesta honesta es "no se hizo".
   */
  | "ACCION_RECHAZADA";

/** Por qué una acción no pasó la compuerta. Nunca es "se ejecutó igual". */
export type MotivoSinConfirmacion =
  | "SIN_PROPUESTA" // no hubo gesto humano sobre una propuesta persistida
  | "ACCION_DISTINTA" // el permiso era para otra acción
  | "ARGUMENTOS_DISTINTOS" // el permiso era para otros números
  | "OTRO_HOGAR"
  | "OTRO_ACTOR" // quien confirmó no es quien está ejecutando
  | "PERMISO_YA_USADO"; // un permiso confirma una vez y una sola

/**
 * Falla honesta. ERROR != VACÍO vive acá: no existe un `OK` con lista vacía
 * producido por un `catch`.
 */
export type ToolOutcome<O> =
  | { status: "OK"; payload: ToolPayload<O> }
  /** Mismo texto que "no existe": el chat no puede ser un oráculo de existencia. */
  | { status: "NOT_PERMITTED" }
  | { status: "INVALID_INPUT"; issues: readonly string[] }
  | { status: "NOT_CONFIRMED"; motivo: MotivoSinConfirmacion }
  | { status: "UNAVAILABLE"; codigo: UnavailableCode; retryable: boolean }
  | { status: "STALE"; proposalId: string }
  | { status: "NOT_BUILT"; sprint: 12 | 13 | 14; que: string };

// ---------------------------------------------------------------------------
// Ámbito e idempotencia
// ---------------------------------------------------------------------------

/**
 * Todo id ajeno que entra por el input se declara acá. `members` son los
 * integrantes cuyos permisos médicos hace falta consultar; `rows`, las filas
 * cuyo hogar hay que resolver antes de tocar nada.
 */
export interface ScopeRequest {
  readonly householdId: string;
  readonly members: readonly string[];
  readonly rows: readonly { table: ScopedTable; id: string }[];
}

/** Idempotencia declarada, no supuesta. */
export type ReadIdempotency = { mode: "PURE" } | { mode: "PROPOSAL_KEYED" };

/**
 * Idempotencia de una ACCIÓN. `NOT_IDEMPOTENT` no está en la unión: una acción
 * que no se puede repetir sin duplicar el efecto no entra al registry, entra
 * como `NOT_BUILT` hasta que exista la migración.
 *
 * `KEYED` obliga a nombrar el índice único parcial y el parámetro del RPC. Una
 * clave calculada en TypeScript no evita nada bajo concurrencia: si la base no
 * la respalda, la promesa es de tipo y no de efecto. La guarda de esquema
 * verifica que el RPC declarado acepte `parametroRpc`.
 */
export type ActionIdempotency<I> =
  | { mode: "ABSOLUTE_SET" } // adjust_lot, set_item_status: fija un valor, no suma
  | {
      mode: "KEYED";
      key: (input: I, actor: Actor) => string;
      indiceUnico: string;
      parametroRpc: "p_dedupe_key";
    }
  | { mode: "REENTRANT_GUARDED"; guardia: string }; // confirm_meal_assignment

// ---------------------------------------------------------------------------
// Los dos clientes de base. Disjuntos a propósito.
// ---------------------------------------------------------------------------

export type ValorFiltro = string | number | boolean;

export type Filtro =
  | { op: "eq"; campo: string; valor: ValorFiltro }
  | { op: "in"; campo: string; valores: readonly ValorFiltro[] }
  | { op: "gte"; campo: string; valor: ValorFiltro }
  | { op: "lte"; campo: string; valor: ValorFiltro }
  /**
   * Búsqueda por texto. El valor NO se interpola en una expresión: el adaptador
   * escapa `%`, `_`, `,` y `)` y arma un solo `ilike`. Nunca un `.or(...)` con
   * el término adentro, que es el patrón peligroso que ya existe en el catálogo.
   */
  | { op: "busca"; campo: string; termino: string };

export interface SelectSpec {
  readonly table: string;
  readonly columns: string;
  readonly filtros: readonly Filtro[];
  readonly orden?: { campo: string; asc: boolean };
  /** Obligatorio: una lectura sin tope no es una lectura, es una fuga. */
  readonly limite: number;
}

/**
 * Lo único que una herramienta de lectura tiene para hablar con la base.
 *
 * No es un `SupabaseClient` recortado con un Proxy: es una interfaz propia y
 * mínima. La diferencia importa — con el cliente completo el compilador acepta
 * `.insert(...)` y solo revienta en producción; acá `.insert` no existe como
 * nombre, así que el error es de compilación.
 */
export interface ReadOnlyDb {
  readonly modo: "SOLO_LECTURA";
  select(spec: SelectSpec): Promise<readonly unknown[]>;
  rpc(fn: ReadRpcName, args: Readonly<Record<string, ValorFiltro | readonly string[] | null>>): Promise<unknown>;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly mensaje?: string;
  readonly datos?: unknown;
}

/**
 * Lo único que una herramienta de acción tiene para hablar con la base: una
 * server action existente, por nombre, con clave de dedupe obligatoria. No hay
 * forma de tipo de llegar a una tabla.
 */
export interface ActionDb {
  readonly modo: "SOLO_ACCION";
  callAction(
    name: ExistingActionName,
    args: Readonly<Record<string, unknown>>,
    dedupeKey: string,
  ): Promise<ActionResult>;
}

/**
 * Cliente crudo que el adaptador envuelve. Se declara acá, mínimo, para que
 * `ReadOnlyDb` no herede por estructura toda la superficie de escritura de
 * PostgREST.
 */
export interface ConsultaCruda extends PromiseLike<{ data: unknown; error: PostgrestError | null }> {
  eq(campo: string, valor: ValorFiltro): ConsultaCruda;
  in(campo: string, valores: readonly ValorFiltro[]): ConsultaCruda;
  gte(campo: string, valor: ValorFiltro): ConsultaCruda;
  lte(campo: string, valor: ValorFiltro): ConsultaCruda;
  ilike(campo: string, patron: string): ConsultaCruda;
  order(campo: string, opciones: { ascending: boolean }): ConsultaCruda;
  limit(n: number): ConsultaCruda;
}

export interface ClienteCrudo {
  from(tabla: string): { select(columnas: string): ConsultaCruda };
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: PostgrestError | null }>;
}

// ---------------------------------------------------------------------------
// Contextos
// ---------------------------------------------------------------------------

interface ContextoBase {
  readonly actor: Actor;
  readonly traceId: string;
  /** El today del hogar, ya resuelto. Ninguna herramienta llama a `new Date()`. */
  readonly today: string;
  readonly timezone: string;
  /**
   * El turno tiene un tope de tiempo y la herramienta tiene que poder soltarlo.
   * Sin esto los presupuestos del turno y los de la llamada no cierran entre sí:
   * el turno se corta y la consulta sigue viva en la base.
   */
  readonly signal: AbortSignal;
}

export interface ReadContext extends ContextoBase {
  readonly db: ReadOnlyDb;
}

export interface ActionContext extends ContextoBase {
  readonly db: ActionDb;
  /** Calculada AL CREAR la propuesta, no al aceptar. */
  readonly dedupeKey: string;
  readonly proposalId: string;
  /** Quien tocó el botón. Es el que queda en la auditoría, no quien propuso. */
  readonly acceptedByMemberId: string;
}

// ---------------------------------------------------------------------------
// Las dos herramientas
// ---------------------------------------------------------------------------

interface ToolBase<I, O> {
  readonly risk: RiskLevel;
  /** SIEMPRE `.strict()`, sin `coerce`, sin defaults silenciosos. */
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  /**
   * Lo que ve el modelo. Se valida en CI: sin nombres de motores inexistentes,
   * sin prometer cálculos propios.
   */
  readonly descripcion: string;
  /**
   * Tope de filas que esta herramienta puede devolver. `redact` recorta
   * columnas, no filas: sin un tope declarado, "los lotes de la casa" pueden ser
   * 500 y cruzarían enteros al proveedor.
   */
  readonly limiteFilas: number;
  /**
   * `true` si la salida afirma algo nutricional (un veredicto, un límite, un
   * número de nutriente). Obliga a que TODA la procedencia sea
   * `ProvenanceNutricional`.
   */
  readonly veredictoNutricional: boolean;
  scope(input: I): ScopeRequest;
  requires(input: I): readonly Capability[];
  /** Proyección mínima ANTES de que el modelo vea nada. Debe ser idempotente. */
  redact(actor: Actor, payload: ToolPayload<O>): ToolPayload<O>;
  /** Cuántas filas trae `data`. Por defecto, el largo si es arreglo. */
  contarFilas?(data: O): number;
}

/**
 * Herramienta de LECTURA (o de propuesta). Su `run` recibe `ReadContext`, cuyo
 * `db` no tiene con qué escribir.
 */
export interface ReadTool<I, O> extends ToolBase<I, O> {
  readonly name: ReadToolName;
  readonly kind: ReadKind;
  readonly effect: ReadEffect;
  readonly idempotency: ReadIdempotency;
  run(ctx: ReadContext, input: I): Promise<ToolPayload<O>>;
  /** No hay acción que invocar. Declararla es un error de tipo, no de estilo. */
  readonly accion?: never;
}

/**
 * Herramienta de ACCIÓN. Su `run` exige la `ConfirmationGrant` como tercer
 * parámetro: sin el gesto humano no hay ni forma de llamarla.
 */
export interface ActionTool<I, O> extends ToolBase<I, O> {
  readonly name: ActionToolName;
  readonly kind: "ACT";
  readonly effect: WriteEffect;
  readonly idempotency: ActionIdempotency<I>;
  /** La única acción existente que se invoca, por nombre. */
  readonly accion: ExistingActionName;
  run(ctx: ActionContext, input: I, confirmacion: ConfirmationGrant): Promise<ToolPayload<O>>;
}

/**
 * Unión para catálogos y metadatos (descripción, riesgo, efecto). NO es un
 * runner: para correr hay que elegir `runReadTool` o `runActionTool`, y el
 * segundo pide la confirmación.
 */
export type DomainTool<I = never, O = unknown> = ReadTool<I, O> | ActionTool<I, O>;

/**
 * El registry que ve el router. Su tipo solo admite lecturas: una herramienta
 * `ACT` no compila acá, así que la capa 0 ("comando") y la capa 2 (el modelo
 * elige) no tienen de dónde sacar una escritura aunque quieran.
 */
export type ReadRegistry = Readonly<Record<ReadToolName, ReadTool<never, unknown>>>;

// ---------------------------------------------------------------------------
// Ayudas chicas
// ---------------------------------------------------------------------------

/**
 * Un motor que todavía no existe (Sprints 12, 13 y 14). Las entradas selladas lo
 * lanzan sin tocar nada, y `runReadTool` lo traduce a `NOT_BUILT`.
 *
 * Existen a propósito en el registry: si la herramienta no estuviera, el modelo
 * "llamaría" al motor fantasma y rellenaría el hueco con prosa. Con esto recibe
 * un NO tipado y la respuesta obligatoria es "eso todavía no lo tenemos".
 */
export class NotBuiltError extends Error {
  readonly sprint: 12 | 13 | 14;
  readonly que: string;

  constructor(sprint: 12 | 13 | 14, que: string) {
    super(`Todavía no lo tenemos: ${que}`);
    this.name = "NotBuiltError";
    this.sprint = sprint;
    this.que = que;
  }
}

/**
 * La acción existente corrió y RECHAZÓ, sin escribir nada.
 *
 * Existe para que el estado `FAILED` sea alcanzable. Antes no lo era: cualquier
 * excepción posterior a la llamada caía en `EXECUTION_UNKNOWN`, o sea el sistema
 * decía "no sé si se hizo" incluso cuando la propia acción había contestado que
 * no. De los tres finales que la server action promete, uno era imposible.
 *
 * La regla para lanzarla es estrecha a propósito, y la carga quien la lanza: se
 * usa cuando la acción devolvió un NO explícito y atómico (un `ActionResult` con
 * `ok:false`, un `check_violation` de la base). Ante cualquier otra cosa
 * —timeout, corte de red, error raro— NO se lanza esto: la respuesta correcta
 * sigue siendo "no sé", porque decir "no se hizo" cuando pudo haberse hecho es
 * la peor de las dos mentiras.
 */
export class AccionRechazada extends Error {
  readonly accion: string;

  constructor(accion: string, motivo: string) {
    super(`La acción ${accion} no se aplicó: ${motivo}`);
    this.name = "AccionRechazada";
    this.accion = accion;
  }
}

export function desconocido(campo: string, simbolo: UnknownSymbol, motivo: string): Unknown {
  return { campo, simbolo, motivo };
}

/** Sobre vacío pero honesto: sin datos, con procedencia y con lo que no se sabe. */
export function payloadVacio<O>(
  data: O,
  provenance: readonly Provenance[],
  unknowns: readonly Unknown[],
): ToolPayload<O> {
  return { data, provenance, unknowns, reasons: [], labels: {} };
}
