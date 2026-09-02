import { ActorError, requireActor, faltaCapacidad } from "@/lib/auth/actor";
import type { Actor, CapabilitiesRpc, Capability } from "@/lib/auth/actor";
import { DataShapeError } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import type { ConfirmationGrant, ProposalStore } from "./proposal";
import { digestoDeArgumentos } from "./proposal";
import { AccionRechazada, NotBuiltError, esProvenanceNutricional } from "./tool";
import type {
  ActionContext,
  ActionDb,
  ActionTool,
  ReadContext,
  ReadOnlyDb,
  ReadTool,
  ScopeRequest,
  ScopedTable,
  ToolKind,
  ToolName,
  ToolOutcome,
  ToolPayload,
} from "./tool";

/**
 * LOS DOS CAMINOS.
 *
 * `runReadTool` es lo único que ve el router: recibe `ReadTool`, cuyo contexto
 * no tiene con qué escribir. `runActionTool` recibe además una
 * `ConfirmationGrant` — que solo `claimProposal` fabrica — y sin ese cuarto
 * argumento no compila. No hay un `runTool` con bandera: una bandera se puede
 * pasar mal, un parámetro faltante no.
 *
 * Un solo `catch` en cada camino, y ese `catch` no puede devolver `OK`. Es la
 * traducción de ERROR != VACÍO al borde del asistente: si la lectura falló, la
 * respuesta es "no pude verificar", nunca "no tienes nada".
 */

export interface AuditEntry {
  readonly householdId: string;
  readonly tool: ToolName;
  readonly kind: ToolKind;
  readonly traceId: string;
  /** Solo ids de ámbito. Jamás el texto de la pregunta ni los valores. */
  readonly scopeIds: readonly string[];
  readonly status: ToolOutcome<unknown>["status"];
}

/**
 * ¿Esta fila es alcanzable para este actor? Molde: `app.row_reachable` (0050),
 * que resuelve el hogar Y la capacidad clínica EN EL MISMO PASO.
 *
 * Devuelve booleanos, no el hogar dueño, a propósito: "no existe", "es de otra
 * casa" y "es un id clínico que no puedes ver" tienen que ser indistinguibles
 * desde afuera. Un uuid de `member_clinical_restrictions` SÍ es del hogar — si
 * el permiso se dejara para el paso siguiente, un `requires()` olvidado abriría
 * la puerta entera.
 */
export type ScopeResolver = (
  rows: readonly { table: ScopedTable; id: string }[],
) => Promise<readonly boolean[]>;

export type AuditPort = (entrada: AuditEntry) => Promise<void>;

interface SesionBase {
  readonly householdId: string;
  readonly traceId: string;
  /** Cliente para las preguntas DEL RUNTIME. La herramienta nunca lo ve. */
  readonly capacidades: CapabilitiesRpc;
  readonly resolverAmbito: ScopeResolver;
  readonly auditar: AuditPort;
  readonly signal: AbortSignal;
}

export interface SesionLectura extends SesionBase {
  readonly db: ReadOnlyDb;
}

export interface SesionAccion extends SesionBase {
  readonly db: ActionDb;
  readonly propuestas: ProposalStore;
}

const OK_SIN_PERMISO = { status: "NOT_PERMITTED" } as const;

/**
 * Traducción del error al borde. Es la única que existe, y no tiene rama que
 * produzca `OK`: por eso el `catch` no puede mentir aunque alguien lo edite.
 */
function traducirError<O>(e: unknown): ToolOutcome<O> {
  if (e instanceof NotBuiltError) {
    return { status: "NOT_BUILT", sprint: e.sprint, que: e.que };
  }
  if (e instanceof ActorError) {
    // La consulta funcionó y la respuesta fue "no". Mismo texto que "no existe".
    return OK_SIN_PERMISO;
  }
  if (e instanceof AccionRechazada) {
    // La acción contestó que no, sin escribir. `retryable: false`: repetir un
    // rechazo no lo convierte en un sí.
    return { status: "UNAVAILABLE", codigo: "ACCION_RECHAZADA", retryable: false };
  }
  if (e instanceof DataShapeError) {
    return { status: "UNAVAILABLE", codigo: "FORMA_INVALIDA", retryable: false };
  }
  if (e instanceof DataAccessError) {
    return { status: "UNAVAILABLE", codigo: "LECTURA_FALLIDA", retryable: true };
  }
  if (e instanceof Error && e.name === "AbortError") {
    return { status: "UNAVAILABLE", codigo: "TIEMPO_AGOTADO", retryable: true };
  }
  // Desconocido: sigue siendo una falla, nunca un resultado vacío.
  return { status: "UNAVAILABLE", codigo: "LECTURA_FALLIDA", retryable: false };
}

function idsDeAmbito(scope: ScopeRequest): string[] {
  return [...scope.members, ...scope.rows.map((r) => r.id)];
}

/**
 * Pasos 2 a 4, compartidos por los dos caminos: actor, ámbito por id y
 * capacidades. Devuelve el actor o el `ToolOutcome` que corta.
 */
async function verificarAcceso<O>(
  sesion: SesionBase,
  scope: ScopeRequest,
  requiere: readonly Capability[],
): Promise<{ ok: true; actor: Actor } | { ok: false; salida: ToolOutcome<O> }> {
  if (scope.householdId !== sesion.householdId) {
    return { ok: false, salida: OK_SIN_PERMISO };
  }

  const actor = await requireActor(sesion.capacidades, sesion.householdId, scope.members);

  if (scope.rows.length > 0) {
    const alcanzables = await sesion.resolverAmbito(scope.rows);
    if (alcanzables.length !== scope.rows.length) {
      // No se pudo resolver todo: no se asume que era propio.
      return {
        ok: false,
        salida: { status: "UNAVAILABLE", codigo: "LECTURA_FALLIDA", retryable: true },
      };
    }
    // Una sola fila fuera de alcance corta el paso: el chat no puede ser un
    // oráculo que confirme qué ids existen en otras casas.
    if (alcanzables.some((alcanzable) => !alcanzable)) {
      return { ok: false, salida: OK_SIN_PERMISO };
    }
  }

  if (faltaCapacidad(actor, requiere) !== null) {
    return { ok: false, salida: OK_SIN_PERMISO };
  }
  return { ok: true, actor };
}

function contarFilasDe<I, O>(tool: ReadTool<I, O> | ActionTool<I, O>, data: O): number {
  if (tool.contarFilas !== undefined) return tool.contarFilas(data);
  return Array.isArray(data) ? data.length : 1;
}

/**
 * Paso 6: proyección mínima y validación de la salida.
 *
 * Tres cosas que el `.strict()` de Zod NO cubre y acá sí:
 *  · `redact` corre ANTES de validar, así el schema describe lo que el modelo va
 *    a ver de verdad.
 *  · Si la herramienta afirma algo nutricional, toda su procedencia tiene que
 *    traer `fuenteNutricion`. `.strict()` prohíbe campos extra, no exige
 *    opcionales: sin este paso, una herramienta que omitiera la fuente pasaba
 *    sin ruido y "está dentro de tu límite" podía estar hablando del promedio de
 *    la olla en vez de la porción de esa persona.
 *  · El tope de filas: `redact` recorta columnas, no filas.
 */
function proyectarYValidar<I, O>(
  tool: ReadTool<I, O> | ActionTool<I, O>,
  actor: Actor,
  bruto: ToolPayload<O>,
): ToolOutcome<O> {
  const payload = tool.redact(actor, bruto);

  const salida = tool.output.safeParse(payload.data);
  if (!salida.success) throw new DataShapeError(`salida de ${tool.name}`, salida.error.issues);

  if (tool.veredictoNutricional) {
    if (payload.provenance.length === 0 || !payload.provenance.every(esProvenanceNutricional)) {
      return { status: "UNAVAILABLE", codigo: "FORMA_INVALIDA", retryable: false };
    }
  }

  // El efecto declarado gobierna la salida, no al revés: una lectura que trae
  // borrador de propuesta está escribiendo por la puerta de atrás.
  if ((payload.propuesta !== undefined) !== (tool.effect === "PROPOSAL_ONLY")) {
    return { status: "UNAVAILABLE", codigo: "FORMA_INVALIDA", retryable: false };
  }

  if (contarFilasDe(tool, payload.data) > tool.limiteFilas) {
    return { status: "UNAVAILABLE", codigo: "PAYLOAD_EXCESIVO", retryable: false };
  }

  return { status: "OK", payload };
}

// ---------------------------------------------------------------------------
// Camino de LECTURA
// ---------------------------------------------------------------------------

/**
 * Lo único que el router puede llamar. Preguntar nunca ejecuta: el tipo de
 * `tool` no admite `kind: "ACT"` y el `db` del contexto no tiene `insert`,
 * `update`, `delete` ni `upsert` como nombres.
 */
export async function runReadTool<I, O>(
  tool: ReadTool<I, O>,
  rawInput: unknown,
  sesion: SesionLectura,
): Promise<ToolOutcome<O>> {
  let scopeIds: readonly string[] = [];
  let resultado: ToolOutcome<O>;
  try {
    if (sesion.signal.aborted) {
      resultado = { status: "UNAVAILABLE", codigo: "TIEMPO_AGOTADO", retryable: true };
    } else {
      const entrada = tool.input.safeParse(rawInput);
      if (!entrada.success) {
        resultado = {
          status: "INVALID_INPUT",
          issues: entrada.error.issues.map(
            (i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`,
          ),
        };
      } else {
        const input = entrada.data;
        const scope = tool.scope(input);
        scopeIds = idsDeAmbito(scope);
        const acceso = await verificarAcceso<O>(sesion, scope, tool.requires(input));
        if (!acceso.ok) {
          resultado = acceso.salida;
        } else {
          const ctx: ReadContext = {
            actor: acceso.actor,
            traceId: sesion.traceId,
            today: acceso.actor.today,
            timezone: acceso.actor.timezone,
            signal: sesion.signal,
            db: sesion.db,
          };
          resultado = proyectarYValidar(tool, acceso.actor, await tool.run(ctx, input));
        }
      }
    }
  } catch (e) {
    resultado = traducirError<O>(e);
  }

  await sesion.auditar({
    householdId: sesion.householdId,
    tool: tool.name,
    kind: tool.kind,
    traceId: sesion.traceId,
    scopeIds,
    status: resultado.status,
  });
  return resultado;
}

// ---------------------------------------------------------------------------
// Camino de ACCIÓN
// ---------------------------------------------------------------------------

/**
 * Solo la acepta `aceptarPropuesta`. El cuarto parámetro es la compuerta: sin
 * `ConfirmationGrant` esto no compila, y una `ConfirmationGrant` solo existe si
 * una persona tocó el botón de una propuesta viva con su token de un solo uso.
 *
 * Además de tener la llave, la llave tiene que ser DE ESTA puerta: se compara la
 * acción y la huella de los argumentos. Un permiso emitido para "descontar 2,0
 * kg del lote L-77" no ejecuta "descartar el lote L-77" ni "descontar 20 kg".
 */
export async function runActionTool<I, O>(
  tool: ActionTool<I, O>,
  rawInput: unknown,
  sesion: SesionAccion,
  confirmacion: ConfirmationGrant,
): Promise<ToolOutcome<O>> {
  let scopeIds: readonly string[] = [];
  let resultado: ToolOutcome<O>;
  /** Se llegó a llamar a la acción. */
  let ejecutada = false;
  /** La acción VOLVIÓ: la escritura ocurrió, con o sin problemas después. */
  let escribio = false;

  try {
    if (sesion.signal.aborted) {
      resultado = { status: "UNAVAILABLE", codigo: "TIEMPO_AGOTADO", retryable: true };
    } else {
      const entrada = tool.input.safeParse(rawInput);
      if (!entrada.success) {
        resultado = {
          status: "INVALID_INPUT",
          issues: entrada.error.issues.map(
            (i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`,
          ),
        };
      } else {
        const input = entrada.data;
        const gate = revisarPermiso(tool, input, sesion, confirmacion);
        if (gate !== null) {
          resultado = gate;
        } else {
          const scope = tool.scope(input);
          scopeIds = idsDeAmbito(scope);
          const acceso = await verificarAcceso<O>(sesion, scope, tool.requires(input));
          if (!acceso.ok) {
            resultado = acceso.salida;
          } else if (acceso.actor.memberId !== confirmacion.acceptedByMemberId) {
            // Quien confirmó no es quien está ejecutando. La confirmación no se
            // presta ni se hereda.
            resultado = { status: "NOT_CONFIRMED", motivo: "OTRO_ACTOR" };
          } else if (!confirmacion.usar()) {
            // Un permiso confirma una vez. Ni el mismo objeto en memoria sirve
            // para una segunda ejecución.
            resultado = { status: "NOT_CONFIRMED", motivo: "PERMISO_YA_USADO" };
          } else {
            const ctx: ActionContext = {
              actor: acceso.actor,
              traceId: sesion.traceId,
              today: acceso.actor.today,
              timezone: acceso.actor.timezone,
              signal: sesion.signal,
              db: sesion.db,
              dedupeKey: confirmacion.dedupeKey,
              proposalId: confirmacion.proposalId,
              acceptedByMemberId: confirmacion.acceptedByMemberId,
            };
            ejecutada = true;
            const bruto = await tool.run(ctx, input, confirmacion);
            // Volvió sin lanzar: la escritura ocurrió. De acá en adelante nada
            // puede decir "no sé si se hizo", porque sí se sabe.
            escribio = true;
            await sesion.propuestas.marcar(confirmacion.proposalId, "EXECUTED");
            resultado = proyectarYValidar(tool, acceso.actor, bruto);
          }
        }
      }
    }
  } catch (e) {
    if (escribio) {
      // La acción volvió bien y reventó DESPUÉS (la forma de la salida, el tope
      // de filas). La propuesta ya quedó EXECUTED y ahí se queda: lo que falló
      // es mostrar el resultado, no hacerlo. Marcarla EXECUTION_UNKNOWN acá
      // sería mentir en la otra dirección.
      resultado = traducirError<O>(e);
    } else if (ejecutada && e instanceof AccionRechazada) {
      // La acción corrió y dijo que no, sin escribir. Acá sí se puede decir "no
      // se hizo", y por eso `FAILED` existe y es alcanzable.
      await sesion.propuestas.marcar(confirmacion.proposalId, "FAILED");
      resultado = traducirError<O>(e);
    } else if (ejecutada) {
      // Se llamó a la acción y no sabemos si escribió. Decir "no se hizo" cuando
      // pudo haberse hecho es peor que decir "no sé": el recibo miente y alguien
      // lo repite a mano. Y `retryable: false` a propósito — nada reintenta solo
      // una escritura de resultado desconocido.
      await sesion.propuestas.marcar(confirmacion.proposalId, "EXECUTION_UNKNOWN");
      resultado = { status: "UNAVAILABLE", codigo: "LECTURA_FALLIDA", retryable: false };
    } else {
      resultado = traducirError<O>(e);
    }
  }

  await sesion.auditar({
    householdId: sesion.householdId,
    tool: tool.name,
    kind: tool.kind,
    traceId: sesion.traceId,
    scopeIds,
    status: resultado.status,
  });
  return resultado;
}

/** La llave es de esta puerta, de este hogar y de estos números, o no abre. */
function revisarPermiso<I, O>(
  tool: ActionTool<I, O>,
  input: I,
  sesion: SesionAccion,
  confirmacion: ConfirmationGrant,
): ToolOutcome<O> | null {
  if (confirmacion.householdId !== sesion.householdId) {
    return { status: "NOT_CONFIRMED", motivo: "OTRO_HOGAR" };
  }
  if (confirmacion.accion !== tool.accion) {
    return { status: "NOT_CONFIRMED", motivo: "ACCION_DISTINTA" };
  }
  if (confirmacion.yaUsado) {
    return { status: "NOT_CONFIRMED", motivo: "PERMISO_YA_USADO" };
  }
  if (digestoDeArgumentos(tool.accion, input) !== confirmacion.argsDigest) {
    return { status: "NOT_CONFIRMED", motivo: "ARGUMENTOS_DISTINTOS" };
  }
  return null;
}
