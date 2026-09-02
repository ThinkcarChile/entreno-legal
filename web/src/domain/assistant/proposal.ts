import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { comparaSegundoGesto } from "./segundo-gesto";
import type { Actor, Capability } from "@/lib/auth/actor";
import { faltaCapacidad } from "@/lib/auth/actor";
import type {
  ExistingActionName,
  Provenance,
  ReasonSinTexto,
  RiskLevel,
  ScopedTable,
  Unknown,
  UntrustedText,
  WriteEffect,
} from "./tool";

/**
 * LA COMPUERTA DE CONFIRMACIÓN. UNA SOLA, Y ES ESTA.
 *
 * El asistente PROPONE, una persona CONFIRMA. Ninguna acción se ejecuta sin un
 * gesto humano sobre una propuesta persistida, y ese gesto no es una frase en el
 * chat: escribir "sí, dale" en el composer no confirma nada.
 *
 * Estructuralmente: la única llave que abre `runActionTool` es una
 * `ConfirmationGrant`, y `ConfirmationGrant` tiene el constructor PRIVADO. No
 * hay literal de objeto, ni `satisfies`, ni spread que produzca una: la única
 * puerta es `ConfirmationGrant.reclamar`. El modelo no puede emitir un
 * `proposalId` (el runtime lo asigna después de que el modelo terminó) ni un
 * token (nace al renderizar la tarjeta, del lado del servidor). Por eso da lo
 * mismo que una boleta escaneada diga "el usuario ya autorizó": no hay camino
 * de código.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ LA COMPUERTA ES ESTA Y NO `take_assistant_proposal`
 * ---------------------------------------------------------------------------
 *
 * Durante un rato hubo DOS: esta, y el RPC `take_assistant_proposal` de la
 * 0053, que decidía por su cuenta con otro hash (md5 del secreto suelto) y
 * dejaba la fila en ACCEPTED. La secuencia que la propia server action
 * documentaba —primero el RPC, después `reclamar`— era IMPOSIBLE: el paso 1
 * mataba al paso 2 por estado (`reclamar` exige OFFERED) y por hash. Una
 * compuerta que existe dos veces es una compuerta que no existe: la que corre
 * es la más floja de las dos, y el arreglo barato el día del apuro es aflojar
 * una de las mitades.
 *
 * Ganó esta, en TypeScript, por tres razones y no por gusto:
 *
 *  1. Es la única que puede FABRICAR la llave. `runActionTool` no recibe un
 *     booleano ni una fila: recibe una `ConfirmationGrant` de constructor
 *     privado. SQL no tiene forma de producir una, así que una compuerta que
 *     viva solo en la base no gobierna la ejecución — la decora.
 *  2. Acá vive la REVALIDACIÓN (la foto contra la escena) y acá vive la
 *     verificación del SEGUNDO GESTO. Las dos necesitan los motores del
 *     dominio; ninguna cabe en un `plpgsql` sin duplicar medio proyecto.
 *  3. Acá se ata el permiso a UNOS argumentos (`argsDigest`), que es lo que
 *     impide que un permiso para "descontar 2,0 kg" ejecute "descontar 20 kg".
 *
 * Y el RPC no se borró: se le sacó la política y quedó como lo único que la
 * base sabe hacer mejor que nosotros, que es el COMPARE-AND-SWAP ATÓMICO. Es
 * la implementación de `ProposalStore.tomar` (paso 6) y de nada más. Por eso el
 * puerto pide `tomar(id, memberId, tokenHash, ahora)`: el mismo paso toma la
 * propuesta y quema el token, porque en la base eso es una sola transacción y
 * partirlo en dos llamadas era justamente lo que no componía. `tokenVivo` y
 * `quemarToken` ya no existen como pasos separados a propósito: eran la mitad
 * de la compuerta que corría en el lado equivocado.
 */

// ---------------------------------------------------------------------------
// La propuesta
// ---------------------------------------------------------------------------

export type ProposalStatus =
  | "OFFERED" // creada y mostrada
  | "ACCEPTING" // tomada por un actor; revalidando o ejecutando
  | "EXECUTED" // la acción existente devolvió ok
  | "REJECTED" // descartada por una persona
  | "EXPIRED" // pasó expiresAt sin decisión
  | "SUPERSEDED" // el estado cambió: nació una propuesta nueva
  | "REVALIDATION_FAILED" // el estado cambió y NO se pudo recalcular
  | "FAILED" // la acción existente devolvió error, sin escribir
  /**
   * La acción se llamó y no sabemos si escribió (timeout, corte de red). No es
   * FAILED: decir "no se hizo" cuando puede haberse hecho es la peor de las dos
   * mentiras. ERROR != VACÍO también aplica a las escrituras.
   */
  | "EXECUTION_UNKNOWN";

export type Assertion =
  | { k: "DISPONIBLE"; ingredientId: string; unit: string; weightBasis: string; minimo: number }
  | { k: "LOTE_DISPONIBLE"; lotId: string; minimo: number; estado: "AVAILABLE" }
  | { k: "ENTRANTE"; ingredientId: string; esperado: number }
  | { k: "PENDIENTE_EN_LISTA"; ingredientId: string; esperado: number }
  | { k: "ESTADO"; table: ScopedTable; id: string; campo: string; esperado: string }
  | { k: "FECHA_NO_PASADA"; fecha: string }
  | { k: "PORCION_NO_SERVIDA"; assignmentId: string }
  /**
   * Ningún camino físico revalida solo lo físico: si la comida tiene bloqueo
   * clínico o veredicto de seguridad pendiente, la foto tiene que incluirlo.
   */
  | { k: "SIN_BLOQUEO_CLINICO"; assignmentId: string }
  | { k: "SIN_REVISION_DE_SEGURIDAD"; lotId: string };

export interface ProposalBasis {
  readonly householdId: string;
  readonly capturedAt: string;
  readonly today: string;
  readonly engineVersions: Readonly<Record<string, string>>;
  /** NIVEL 1 — sellos de fila. Barato: un RPC, cero motores. */
  readonly rows: readonly { table: ScopedTable; id: string; stamp: string }[];
  /** NIVEL 2 — firma de entrada del motor. */
  readonly signatures: Readonly<Record<string, string>>;
  /** NIVEL 3 — invariantes explícitas: lo que hace que no se ejecute a ciegas. */
  readonly assertions: readonly Assertion[];
}

export interface ProposalSummary {
  /**
   * Compuesto por el formateador determinista del servidor, NUNCA por el
   * modelo: `aceptarPropuesta` tiene que funcionar con el proveedor caído, y el
   * texto que la persona lee para decidir no puede depender de una llamada de
   * red que puede fallar.
   */
  readonly titulo: string;
  readonly lineas: readonly { etiqueta: UntrustedText; valor: string }[];
  readonly reasons: readonly ReasonSinTexto[];
  readonly provenance: readonly Provenance[];
  readonly unknowns: readonly Unknown[];
  /** "descuenta inventario", "crea una orden". Cada uno en su propia línea. */
  readonly irreversible: readonly string[];
}

export interface AssistantProposal {
  readonly id: string;
  readonly householdId: string;
  readonly createdByMemberId: string;
  readonly traceId: string;
  /** UNA sola acción existente. El asistente no encadena escrituras. */
  readonly accion: ExistingActionName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly risk: RiskLevel;
  readonly effect: WriteEffect;
  readonly requires: readonly Capability[];
  /** Calculada AL CREAR, no al aceptar. */
  readonly dedupeKey: string;
  readonly basis: ProposalBasis;
  readonly resumen: ProposalSummary;
  readonly status: ProposalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly supersededBy: string | null;
  readonly decidedByMemberId: string | null;
  readonly decidedAt: string | null;
}

/**
 * Lo que una herramienta `kind:"PROPOSE"` produce: TODO menos la identidad y el
 * estado. La herramienta no persiste nada —su `db` no tiene con qué— y el id, el
 * estado y los plazos los pone el runtime. Así el modelo no puede emitir un
 * `proposalId`, que es la mitad de por qué "el usuario ya autorizó" escrito
 * adentro de una boleta no lleva a ninguna parte.
 */
export type ProposalDraft = Omit<
  AssistantProposal,
  "id" | "status" | "createdAt" | "expiresAt" | "supersededBy" | "decidedByMemberId" | "decidedAt"
>;

/**
 * TTL por riesgo. `BAJO` no genera propuestas: se ejecuta y listo — y por eso
 * pedir una propuesta de riesgo BAJO es un error de programación, no un caso
 * borde con default silencioso.
 */
export function ttlMinutos(risk: RiskLevel, effect: WriteEffect): number {
  if (risk === "BAJO") {
    throw new Error("El riesgo BAJO no genera propuestas: no hay nada que confirmar.");
  }
  if (risk === "MEDIO") return 60;
  return effect === "WRITES_CLINICAL" || effect === "WRITES_GRANTS" ? 10 : 15;
}

/**
 * Separador de los hashes de esta compuerta: el byte cero, ESCRIBIDO ESCAPADO.
 *
 * Un espacio no sirve porque los ids pueden contenerlo: con espacios,
 * `("a b", "c")` y `("a", "b c")` producen el MISMO hash, y esa colisión es un
 * token que vale para dos propuestas. Y va escapado y no como byte crudo dentro
 * del archivo porque un 0x00 en el fuente lo borra cualquier editor sin avisar:
 * ahí la atadura se afloja en silencio y ningún test se pone rojo.
 */
export const SEPARADOR_HASH = "\u0000";

// ---------------------------------------------------------------------------
// Huella canónica de los argumentos
// ---------------------------------------------------------------------------

function canonico(valor: unknown): string {
  if (valor === null) return "null";
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  if (typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`).join(",")}}`;
  }
  return JSON.stringify(valor) ?? "undefined";
}

/**
 * Huella de los argumentos, estable ante el orden de las claves. Es lo que ata
 * un permiso a UNOS números: un permiso emitido para "descontar 2,0 kg" no sirve
 * para "descontar 20 kg" aunque venga con el token correcto.
 */
export function digestoDeArgumentos(accion: ExistingActionName, args: unknown): string {
  return createHash("sha256").update([accion, canonico(args)].join(SEPARADOR_HASH)).digest("hex");
}

// ---------------------------------------------------------------------------
// El token de confirmación
// ---------------------------------------------------------------------------

/** Secreto que viaja a la tarjeta y vuelve una sola vez. Solo su hash se guarda. */
export function generarConfirmationToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * El hash ATA el secreto a la propuesta y al integrante. Por eso un token
 * emitido para la propuesta A no valida en la B ni aunque el secreto se filtre:
 * el hash se recalcula con el id de la propuesta que se está intentando
 * confirmar, y no calza.
 *
 * Las tres partes van con su largo delante (`atar`), así que la concatenación
 * es inyectiva: sin eso, `("a b", "c")` y `("a", "b c")` producen el MISMO hash
 * con cualquier separador que los ids puedan contener, y ese hash compartido es
 * un token que vale para dos propuestas.
 *
 * MISMA FÓRMULA EN LA BASE: `register_proposal_token` (0053) recibe este hash
 * ya calculado. La base no vuelve a hashear nada; si lo hiciera con su propia
 * receta volveríamos a tener dos compuertas que no componen.
 */
function atar(...partes: readonly string[]): string {
  // Con largo delante, la concatenación es INYECTIVA: sin él, `("a b", "c")` y
  // `("a", "b c")` dan la misma cadena con cualquier separador que los ids
  // puedan contener, y eso es un token que vale para dos propuestas.
  return partes.map((parte) => `${parte.length}:${parte}`).join(SEPARADOR_HASH);
}

export function hashConfirmationToken(
  token: string,
  proposalId: string,
  memberId: string,
): string {
  return createHash("sha256").update(atar(proposalId, memberId, token)).digest("hex");
}

/**
 * Vigencia, y falla CERRADA. `Date.parse` de una fecha ilegible devuelve NaN, y
 * `NaN >= NaN` es `false`: comparada a mano, una fecha corrupta se leía como
 * "todavía no vence". Era la única comparación de la compuerta que fallaba
 * abierta. Acá una fecha que no se entiende cuenta como vencida.
 */
export function vencido(ahora: string, limite: string): boolean {
  const a = Date.parse(ahora);
  const l = Date.parse(limite);
  if (!Number.isFinite(a) || !Number.isFinite(l)) return true;
  return a >= l;
}

function hashesIguales(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// El almacén
// ---------------------------------------------------------------------------

export interface TokenVivo {
  readonly proposalId: string;
  readonly memberId: string;
  /** `hashConfirmationToken(secreto, proposalId, memberId)`. El secreto no se guarda. */
  readonly hash: string;
  readonly expiraEn: string;
}

/**
 * Por qué NO se tomó. Es el vocabulario de `take_assistant_proposal` (0053),
 * palabra por palabra, porque ese RPC es la implementación de `tomar` sobre
 * Postgres y un puerto que no habla el idioma de su implementación es el
 * comienzo de la segunda compuerta.
 */
export type MotivoNoTomada =
  | "NO_EXISTE"
  | "YA_DECIDIDA"
  | "EN_VUELO"
  | "VENCIDA"
  /** No hay token vivo para ese par, o el hash no calza. Las dos cosas se ven igual. */
  | "SIN_CONFIRMACION"
  | "NO_AUTORIZADO";

export type Toma =
  | { readonly tomada: true; readonly propuesta: AssistantProposal }
  | { readonly tomada: false; readonly motivo: MotivoNoTomada };

/**
 * Puerto del almacén. La implementación sobre Postgres (migración 0053) tiene
 * que cumplir tres cosas que acá son contrato:
 *  · `tomar` es UN SOLO paso atómico que hace las dos cosas juntas: el
 *    compare-and-swap `OFFERED -> ACCEPTED` y la quema del token. Partirlo en
 *    "leer el token" + "quemarlo" + "tomar la propuesta" fue exactamente lo que
 *    no componía: la base hace esas tres cosas en una transacción y no tiene
 *    forma de devolver el hash guardado (la tabla de tokens no tiene política
 *    de lectura, a propósito). Cero filas significa "ya se decidió", nunca
 *    "reintentar".
 *  · `crear` respeta el índice único parcial `(household_id, dedupe_key) where
 *    status='OFFERED'`: la segunda creación marca SUPERSEDED la anterior, jamás
 *    inserta una segunda. Preguntar ocho veces lo mismo no puede dejar ocho
 *    propuestas vivas ni ocho ítems de inbox.
 *  · `guardarToken` recibe el hash YA calculado por `hashConfirmationToken`. La
 *    base no hashea: si tuviera su propia receta, habría dos.
 */
export interface ProposalStore {
  leer(proposalId: string): Promise<AssistantProposal | null>;
  crear(propuesta: AssistantProposal): Promise<AssistantProposal>;
  tomar(
    proposalId: string,
    actorMemberId: string,
    tokenHash: string,
    ahora: string,
  ): Promise<Toma>;
  marcar(
    proposalId: string,
    status: ProposalStatus,
    extra?: { supersededBy?: string },
  ): Promise<void>;
  guardarToken(token: TokenVivo): Promise<void>;
}

/** Almacén en memoria para pruebas. Emula el CAS y el índice único parcial. */
export function crearAlmacenEnMemoria(): ProposalStore & {
  todas(): readonly AssistantProposal[];
  /** Solo para las pruebas: ¿queda un token vivo para ese par? */
  hayTokenVivo(proposalId: string, memberId: string): boolean;
} {
  const propuestas = new Map<string, AssistantProposal>();
  const tokens = new Map<string, TokenVivo>();
  const clave = (p: string, m: string) => `${p}|${m}`;

  return {
    todas: () => [...propuestas.values()],
    hayTokenVivo: (p, m) => tokens.has(clave(p, m)),

    async leer(id) {
      return propuestas.get(id) ?? null;
    },

    async crear(propuesta) {
      for (const [id, p] of propuestas) {
        if (
          p.householdId === propuesta.householdId &&
          p.dedupeKey === propuesta.dedupeKey &&
          p.status === "OFFERED"
        ) {
          propuestas.set(id, { ...p, status: "SUPERSEDED", supersededBy: propuesta.id });
        }
      }
      propuestas.set(propuesta.id, propuesta);
      return propuesta;
    },

    /**
     * El mismo orden y los mismos motivos que `take_assistant_proposal`. Si esto
     * y el plpgsql se separan, la compuerta vuelve a estar construida dos veces.
     */
    async tomar(id, actorMemberId, tokenHash, ahora) {
      const p = propuestas.get(id);
      if (p === undefined) return { tomada: false, motivo: "NO_EXISTE" };
      if (p.status === "ACCEPTING") return { tomada: false, motivo: "EN_VUELO" };
      if (p.status !== "OFFERED") return { tomada: false, motivo: "YA_DECIDIDA" };
      if (vencido(ahora, p.expiresAt)) {
        propuestas.set(id, { ...p, status: "EXPIRED", decidedAt: ahora });
        return { tomada: false, motivo: "VENCIDA" };
      }

      const vivo = tokens.get(clave(id, actorMemberId));
      if (vivo === undefined) return { tomada: false, motivo: "SIN_CONFIRMACION" };
      if (vencido(ahora, vivo.expiraEn)) return { tomada: false, motivo: "SIN_CONFIRMACION" };
      if (!hashesIguales(vivo.hash, tokenHash)) {
        return { tomada: false, motivo: "SIN_CONFIRMACION" };
      }

      // Quemar y tomar, juntos: es lo que la base hace en una transacción.
      tokens.delete(clave(id, actorMemberId));
      const tomada: AssistantProposal = {
        ...p,
        status: "ACCEPTING",
        decidedByMemberId: actorMemberId,
        decidedAt: ahora,
      };
      propuestas.set(id, tomada);
      return { tomada: true, propuesta: tomada };
    },

    async marcar(id, status, extra) {
      const p = propuestas.get(id);
      if (p === undefined) return;
      propuestas.set(id, {
        ...p,
        status,
        supersededBy: extra?.supersededBy ?? p.supersededBy,
      });
    },

    async guardarToken(token) {
      // Uno solo vivo por par: recargar la tarjeta reemplaza el anterior, no
      // acumula confirmaciones que nadie miró.
      tokens.set(clave(token.proposalId, token.memberId), token);
    },
  };
}

/**
 * Emite el token de un solo uso al RENDERIZAR la tarjeta para ese actor.
 * Devuelve el secreto una vez; el almacén se queda con el hash. Sin esto, un
 * POST repetido con el mismo `proposalId` es indistinguible de una persona
 * tocando el botón.
 */
export async function emitirConfirmationToken(
  store: ProposalStore,
  proposalId: string,
  actor: Actor,
  expiraEn: string,
): Promise<string> {
  const token = generarConfirmationToken();
  await store.guardarToken({
    proposalId,
    memberId: actor.memberId,
    hash: hashConfirmationToken(token, proposalId, actor.memberId),
    expiraEn,
  });
  return token;
}

// ---------------------------------------------------------------------------
// EL SEGUNDO GESTO — probado en el servidor, no en el navegador
// ---------------------------------------------------------------------------

/**
 * La doble confirmación de las acciones de riesgo alto (§3.4: dar y quitar
 * accesos, crear restricciones clínicas, merma mayor) se comprobaba SOLO en
 * `ActionCard.onConfirmar`, o sea en el navegador. Un cliente no es un control
 * de seguridad: es una comodidad para quien usa la app. `confirmarPropuesta` es
 * un endpoint HTTP y el mismo argumento con el que se justificó el token —"nada
 * distingue a una persona de un POST repetido"— aplica palabra por palabra al
 * segundo gesto. Dar acceso a los exámenes de otra persona terminaba siendo un
 * gesto y no dos.
 *
 * Así que el gesto viaja PROBADO y el servidor lo verifica contra lo que él
 * mismo exige. Dos tipos distintos a propósito:
 *  · `PruebaSegundoGesto` es lo que DICE el navegador. Es un dato, jamás una
 *    autorización: que venga `{k:"NINGUNO"}` no significa que no haga falta.
 *  · `ExigenciaSegundoGesto` la calcula el servidor desde la propuesta
 *    persistida y el estado vivo. Es la que manda.
 */
export type PruebaSegundoGesto =
  | { readonly k: "NINGUNO" }
  | { readonly k: "NOMBRE_INTEGRANTE"; readonly memberIdTocado: string }
  /** Lo escrito se COMPARA y no alimenta nada: la acción usa los args de la propuesta. */
  | { readonly k: "ESCRIBIR_CANTIDAD"; readonly escrito: string };

export type ExigenciaSegundoGesto =
  | { readonly k: "NINGUNO" }
  | { readonly k: "NOMBRE_INTEGRANTE"; readonly memberId: string }
  | { readonly k: "ESCRIBIR_CANTIDAD"; readonly valor: number; readonly unidad: string }
  /**
   * No se pudo determinar qué exigir (no se pudo leer el lote, falta el dueño
   * del dato clínico). UNKNOWN != NINGUNO: no saber qué pedir no es no pedir
   * nada, y por eso esto NO confirma.
   */
  | {
      readonly k: "INDETERMINADA";
      /** El mismo vocabulario con el que la tarjeta se declara no confirmable. */
      readonly motivo: "FALTA_EL_INTEGRANTE" | "FALTA_LA_CANTIDAD";
    };

/**
 * La comparación vive en `./segundo-gesto`, que no importa nada. UNA sola
 * implementación para los dos lados —el control en el servidor y el aviso sin
 * red en la tarjeta— porque dos serían la trampa de las dos compuertas en
 * chico. Está en su propio archivo y no acá porque este importa `node:crypto`
 * en la primera línea, y la tarjeta es "use client": un módulo que arrastra
 * `node:crypto` al bundle del navegador no compila.
 */
export { comparaSegundoGesto } from "./segundo-gesto";
export type { VeredictoSegundoGesto } from "./segundo-gesto";

export type FalloSegundoGesto =
  | "FALTA" // el navegador no mandó ninguna prueba
  | "OTRA_NATURALEZA" // mandó un gesto, pero no el que se exige
  | "NO_CALZA"
  | "INDETERMINADO"; // el servidor no pudo saber qué exigir

/**
 * El juez. Nota lo que NO hace: no mira la prueba para decidir qué exigir. La
 * exigencia se calcula antes, del lado del servidor, y acá solo se contrasta.
 */
export function verificarSegundoGesto(
  exigencia: ExigenciaSegundoGesto,
  prueba: PruebaSegundoGesto,
): { ok: true } | { ok: false; motivo: FalloSegundoGesto } {
  if (exigencia.k === "INDETERMINADA") return { ok: false, motivo: "INDETERMINADO" };
  if (exigencia.k === "NINGUNO") return { ok: true };
  if (exigencia.k === "NOMBRE_INTEGRANTE") {
    if (prueba.k === "NINGUNO") return { ok: false, motivo: "FALTA" };
    if (prueba.k !== "NOMBRE_INTEGRANTE") return { ok: false, motivo: "OTRA_NATURALEZA" };
    return prueba.memberIdTocado === exigencia.memberId
      ? { ok: true }
      : { ok: false, motivo: "NO_CALZA" };
  }
  if (prueba.k === "NINGUNO") return { ok: false, motivo: "FALTA" };
  if (prueba.k !== "ESCRIBIR_CANTIDAD") return { ok: false, motivo: "OTRA_NATURALEZA" };
  const veredicto = comparaSegundoGesto(prueba.escrito, exigencia);
  return veredicto.ok ? { ok: true } : { ok: false, motivo: "NO_CALZA" };
}

// ---------------------------------------------------------------------------
// Revalidación
// ---------------------------------------------------------------------------

export type Revalidacion =
  | { veredicto: "IGUAL" }
  | { veredicto: "CAMBIO_RECALCULABLE"; motivo: readonly ReasonSinTexto[] }
  | { veredicto: "CAMBIO_BLOQUEANTE"; motivo: readonly ReasonSinTexto[] };

/**
 * Compara la foto con la escena. Es obligatorio: una propuesta es una foto, la
 * ejecución exige la escena. Sin este parámetro no hay forma de llamar a
 * `reclamar`, así que no existe la ruta "aceptar sin revalidar".
 */
export type Revalidador = (propuesta: AssistantProposal) => Promise<Revalidacion>;

export type ClaimFailure =
  /** Mismo motivo para "no existe" y "es de otro hogar": sin oráculo de existencia. */
  | "NO_EXISTE"
  | "YA_DECIDIDA"
  | "VENCIDA"
  | "TOKEN_INVALIDO"
  | "SIN_CAPACIDAD"
  /** El segundo gesto no vino, vino de otra naturaleza, o no calza. */
  | "SEGUNDO_GESTO"
  /** El servidor no pudo saber qué segundo gesto exigir. UNKNOWN != NINGUNO. */
  | "SEGUNDO_GESTO_INDETERMINADO"
  | "CAMBIO_RECALCULABLE"
  | "CAMBIO_BLOQUEANTE";

export type ClaimOutcome =
  | { ok: true; grant: ConfirmationGrant; propuesta: AssistantProposal }
  | {
      ok: false;
      motivo: ClaimFailure;
      propuesta: AssistantProposal | null;
      cambios: readonly ReasonSinTexto[];
    };

export interface ClaimInput {
  readonly proposalId: string;
  readonly acceptedByMemberId: string;
  readonly confirmationToken: string;
  /**
   * Lo que la persona hizo ADEMÁS de tocar el botón. Obligatorio en el tipo,
   * incluso cuando la acción no pide segundo gesto (`{k:"NINGUNO"}`): un campo
   * opcional se olvida en el llamador nuevo y ahí la doble confirmación
   * desaparece sin que nada se ponga rojo.
   */
  readonly segundoGesto: PruebaSegundoGesto;
}

export interface ClaimOptions {
  readonly store: ProposalStore;
  readonly actor: Actor;
  readonly revalidar: Revalidador;
  /**
   * Qué segundo gesto EXIGE esta propuesta, calculado del lado del servidor
   * (acción + dueño del dato clínico + estado vivo del lote). Es obligatorio por
   * la misma razón que `revalidar`: sin este parámetro no hay forma de llamar a
   * `reclamar`, así que no existe la ruta "confirmar sin comprobar el gesto".
   */
  readonly exigirSegundoGesto: ExigenciaDeGesto;
  /** Instante del hogar, inyectado. Nadie acá llama a `new Date()`. */
  readonly ahora: string;
}

export type ExigenciaDeGesto = (
  propuesta: AssistantProposal,
) => Promise<ExigenciaSegundoGesto>;

// ---------------------------------------------------------------------------
// La llave
// ---------------------------------------------------------------------------

/**
 * La única llave que abre `runActionTool`.
 *
 * Constructor PRIVADO a propósito: no se puede fabricar con un literal, ni con
 * un cast simple, ni copiando la forma. La única puerta es `reclamar`, que corre
 * la compuerta completa. Y se consume una sola vez: `usar()` devuelve `false` a
 * la segunda, así que ni siquiera el mismo objeto en memoria sirve para ejecutar
 * dos veces.
 */
export class ConfirmationGrant {
  readonly proposalId: string;
  readonly acceptedByMemberId: string;
  readonly householdId: string;
  readonly accion: ExistingActionName;
  /** Ata el permiso a UNOS argumentos, no solo a una acción. */
  readonly argsDigest: string;
  readonly dedupeKey: string;
  readonly otorgadoEn: string;
  private usado = false;

  private constructor(propuesta: AssistantProposal, acceptedByMemberId: string, ahora: string) {
    this.proposalId = propuesta.id;
    this.acceptedByMemberId = acceptedByMemberId;
    this.householdId = propuesta.householdId;
    this.accion = propuesta.accion;
    this.argsDigest = digestoDeArgumentos(propuesta.accion, propuesta.args);
    this.dedupeKey = propuesta.dedupeKey;
    this.otorgadoEn = ahora;
  }

  /**
   * Un permiso confirma una vez. La segunda llamada devuelve `false`.
   *
   * Esta línea es la ÚNICA defensa contra dos `runActionTool` concurrentes con la
   * misma llave: el chequeo de `revisarPermiso` corre antes del primer `await`,
   * así que dos llamadas en paralelo lo pasan las dos. Acá se decide cuál
   * escribe.
   */
  usar(): boolean {
    if (this.usado) return false;
    this.usado = true;
    return true;
  }

  get yaUsado(): boolean {
    return this.usado;
  }

  /**
   * LA COMPUERTA, en orden y con la razón de cada paso. Es la única que hay:
   * `take_assistant_proposal` es el paso 6 y nada más.
   *
   *  1. Existencia y hogar. "De otro hogar" y "no existe" devuelven lo mismo.
   *  2. Estado. Solo se toma una propuesta OFFERED.
   *  3. Vigencia. Vencida es vencida: no se ejecuta ni se recalcula en silencio.
   *  4. Capacidad DE QUIEN ACEPTA (puede no ser quien propuso). Si le falta, la
   *     propuesta queda OFFERED: no se quema.
   *  5. SEGUNDO GESTO, contra la exigencia que calculó el servidor. Va antes del
   *     compare-and-swap para que un POST con el gesto malo no queme la
   *     confirmación viva de la persona que sí la iba a tocar.
   *  6. Compare-and-swap OFFERED -> ACCEPTING + quema del token, EN UN SOLO
   *     PASO. Acá se compara el token, dentro de la misma transacción que lo
   *     quema: comparar antes y quemar después es la carrera que deja pasar dos.
   *     Dos toques simultáneos: uno solo pasa, el otro recibe "ya se decidió" y
   *     NUNCA reintenta solo.
   *  7. Revalidación. Cambió algo: SUPERSEDED, sin ejecutar nada.
   */
  static async reclamar(entrada: ClaimInput, opciones: ClaimOptions): Promise<ClaimOutcome> {
    const { store, actor, revalidar, exigirSegundoGesto, ahora } = opciones;
    const fallo = (
      motivo: ClaimFailure,
      propuesta: AssistantProposal | null,
      cambios: readonly ReasonSinTexto[] = [],
    ): ClaimOutcome => ({ ok: false, motivo, propuesta, cambios });

    const propuesta = await store.leer(entrada.proposalId);
    if (propuesta === null) return fallo("NO_EXISTE", null);
    if (propuesta.householdId !== actor.householdId) return fallo("NO_EXISTE", null);
    if (entrada.acceptedByMemberId !== actor.memberId) return fallo("NO_EXISTE", null);
    if (propuesta.status !== "OFFERED") return fallo("YA_DECIDIDA", propuesta);

    if (vencido(ahora, propuesta.expiresAt)) {
      await store.marcar(propuesta.id, "EXPIRED");
      return fallo("VENCIDA", propuesta);
    }

    const falta = faltaCapacidad(actor, propuesta.requires);
    if (falta !== null) return fallo("SIN_CAPACIDAD", propuesta);

    // 5. El segundo gesto, del lado que no se puede tocar desde la consola del
    // navegador. La exigencia la calcula el servidor; lo que mandó el cliente es
    // solo la prueba de lo que dice haber hecho.
    const exigencia = await exigirSegundoGesto(propuesta);
    const gesto = verificarSegundoGesto(exigencia, entrada.segundoGesto);
    if (!gesto.ok) {
      return fallo(
        gesto.motivo === "INDETERMINADO" ? "SEGUNDO_GESTO_INDETERMINADO" : "SEGUNDO_GESTO",
        propuesta,
      );
    }

    // 6. El único paso que escribe. Toma la propuesta y quema el token juntos.
    const toma = await store.tomar(
      propuesta.id,
      actor.memberId,
      hashConfirmationToken(entrada.confirmationToken, propuesta.id, actor.memberId),
      ahora,
    );
    if (!toma.tomada) {
      return fallo(MOTIVO_DE_TOMA[toma.motivo], propuesta);
    }
    const tomada = toma.propuesta;

    // 7. Revalidación. CUALQUIER cambio corta, no solo el bloqueante: una
    // propuesta cuya base cambió pero se puede recalcular sigue siendo una foto
    // vieja, y ejecutarla es ejecutar números que nadie volvió a mirar. La
    // recalculable muere igual y nace otra con lo de ahora — la diferencia entre
    // las dos está en lo que se le dice a la persona, no en si se ejecuta.
    const revalidacion = await revalidar(tomada);
    if (revalidacion.veredicto !== "IGUAL") {
      await store.marcar(tomada.id, "SUPERSEDED");
      return fallo(revalidacion.veredicto, tomada, revalidacion.motivo);
    }

    return {
      ok: true,
      grant: new ConfirmationGrant(tomada, actor.memberId, ahora),
      propuesta: tomada,
    };
  }
}

/**
 * Del vocabulario del almacén al de la compuerta. `EN_VUELO` y `YA_DECIDIDA`
 * colapsan a propósito: para quien toca el botón, las dos son "esto ya se
 * decidió, no lo toques de nuevo".
 */
const MOTIVO_DE_TOMA: Readonly<Record<MotivoNoTomada, ClaimFailure>> = {
  NO_EXISTE: "NO_EXISTE",
  YA_DECIDIDA: "YA_DECIDIDA",
  EN_VUELO: "YA_DECIDIDA",
  VENCIDA: "VENCIDA",
  SIN_CONFIRMACION: "TOKEN_INVALIDO",
  NO_AUTORIZADO: "SIN_CAPACIDAD",
};

/** Alias legible del único camino que produce una `ConfirmationGrant`. */
export function claimProposal(
  entrada: ClaimInput,
  opciones: ClaimOptions,
): Promise<ClaimOutcome> {
  return ConfirmationGrant.reclamar(entrada, opciones);
}
