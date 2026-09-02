import { z } from "zod";
import type { PostgrestError } from "@supabase/supabase-js";
import type { Actor, CapabilitiesRpc } from "@/lib/auth/actor";
import type {
  AssistantProposal,
  ExigenciaDeGesto,
  PruebaSegundoGesto,
} from "./proposal";
import { crearAlmacenEnMemoria } from "./proposal";
import type {
  ActionDb,
  ActionResult,
  ActionTool,
  ReadOnlyDb,
  ReadTool,
  ToolPayload,
} from "./tool";
import { AccionRechazada, untrusted } from "./tool";
import type { AuditEntry, ScopeResolver, SesionAccion, SesionLectura } from "./run-tool";

/**
 * Dobles para las pruebas de la compuerta. Viven en `src` (no en un `__mocks__`)
 * porque `tipos-imposibles.ts` los usa y ese archivo tiene que pasar por el
 * `tsc` del proyecto: es ahí donde se demuestra que los saltos a la compuerta no
 * compilan.
 *
 * Solo el borde es falso. La compuerta —tipos, orden de pasos, token, CAS— es la
 * de producción, sin una línea distinta.
 */

export const HOGAR_A = "11111111-1111-4111-8111-111111111111";
export const HOGAR_B = "22222222-2222-4222-8222-222222222222";
export const ANA = "33333333-3333-4333-8333-333333333333";
export const BETO = "44444444-4444-4444-8444-444444444444";
export const LOTE_77 = "55555555-5555-4555-8555-555555555555";

/**
 * Los dos dobles del segundo gesto, para las acciones que NO piden uno.
 *
 * Van con nombre y no como literal en cada llamada porque el día que alguien
 * agregue un caso nuevo tiene que ver que hay algo que decidir acá. Un
 * `{k:"NINGUNO"}` suelto en veinte tests se copia sin mirar.
 */
export const SIN_GESTO: PruebaSegundoGesto = { k: "NINGUNO" };
export const SIN_EXIGENCIA: ExigenciaDeGesto = async () => ({ k: "NINGUNO" });

export function actorDePrueba(over: Partial<Actor> = {}): Actor {
  return {
    householdId: HOGAR_A,
    memberId: ANA,
    timezone: "America/Santiago",
    today: "2026-09-01",
    isAdmin: false,
    canEditPlan: true,
    canManageShopping: true,
    canCook: true,
    medical: {},
    ...over,
  };
}

/** RPC de capacidades que responde lo que la base respondería. */
export function capacidadesFalsas(
  actor: Actor | null,
  error: PostgrestError | null = null,
): CapabilitiesRpc {
  return {
    rpc() {
      if (error !== null) return Promise.resolve({ data: null, error });
      if (actor === null) return Promise.resolve({ data: { member: false }, error: null });
      return Promise.resolve({
        data: {
          member: true,
          member_id: actor.memberId,
          timezone: actor.timezone,
          today: actor.today,
          is_admin: actor.isAdmin,
          can_edit_plan: actor.canEditPlan,
          can_shop: actor.canManageShopping,
          can_cook: actor.canCook,
          medical: Object.fromEntries(
            Object.entries(actor.medical).map(([id, a]) => [
              id,
              { read_labs: a.readLabs, restrictions: a.restrictions, confirm_labs: a.confirmLabs },
            ]),
          ),
        },
        error: null,
      });
    },
  };
}

export function dbLecturaFalsa(filas: readonly unknown[] = []): ReadOnlyDb {
  return {
    modo: "SOLO_LECTURA",
    async select() {
      return filas;
    },
    async rpc() {
      return null;
    },
  };
}

export interface LlamadaAccion {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
}

export function dbAccionFalsa(
  resultado: ActionResult = { ok: true },
): ActionDb & { llamadas: LlamadaAccion[] } {
  const llamadas: LlamadaAccion[] = [];
  return {
    modo: "SOLO_ACCION",
    llamadas,
    async callAction(name, args, dedupeKey) {
      llamadas.push({ name, args, dedupeKey });
      return resultado;
    },
  };
}

export const ambitoAlcanzable: ScopeResolver = async (rows) => rows.map(() => true);
/** De otro hogar y no existe se ven IGUAL desde afuera, y ese es el punto. */
export const ambitoAjeno: ScopeResolver = async (rows) => rows.map(() => false);
export const ambitoInexistente: ScopeResolver = async (rows) => rows.map(() => false);

export function auditoriaFalsa(): { registrar: (e: AuditEntry) => Promise<void>; filas: AuditEntry[] } {
  const filas: AuditEntry[] = [];
  return {
    filas,
    async registrar(e) {
      filas.push(e);
    },
  };
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

export const entradaLectura = z.object({ lotId: z.string().uuid() }).strict();
export type EntradaLectura = z.infer<typeof entradaLectura>;

export const salidaLectura = z.array(z.object({ id: z.string(), gramos: z.number() }).strict());
export type SalidaLectura = z.infer<typeof salidaLectura>;

export function payloadLectura(filas: SalidaLectura): ToolPayload<SalidaLectura> {
  return {
    data: filas,
    provenance: [{ motor: "stock", version: "stock/1.0.0" }],
    unknowns: [],
    reasons: [],
    labels: { [LOTE_77]: untrusted("Pollo del viernes") },
  };
}

export function herramientaLectura(
  over: Partial<ReadTool<EntradaLectura, SalidaLectura>> = {},
): ReadTool<EntradaLectura, SalidaLectura> {
  return {
    name: "stock.de_alimento",
    kind: "READ",
    effect: "NONE",
    risk: "BAJO",
    idempotency: { mode: "PURE" },
    input: entradaLectura,
    output: salidaLectura,
    descripcion: "Cuánto queda de un alimento.",
    limiteFilas: 50,
    veredictoNutricional: false,
    scope: (input) => ({
      householdId: HOGAR_A,
      members: [],
      rows: [{ table: "inventory_lots", id: input.lotId }],
    }),
    requires: () => [{ k: "HOUSEHOLD" }],
    redact: (_actor, payload) => payload,
    run: async () => payloadLectura([{ id: LOTE_77, gramos: 2000 }]),
    ...over,
  };
}

export const entradaAccion = z.object({ lotId: z.string().uuid(), gramos: z.number() }).strict();
export type EntradaAccion = z.infer<typeof entradaAccion>;

export const salidaAccion = z.object({ restante: z.number() }).strict();
export type SalidaAccion = z.infer<typeof salidaAccion>;

export function herramientaAccion(
  over: Partial<ActionTool<EntradaAccion, SalidaAccion>> = {},
): ActionTool<EntradaAccion, SalidaAccion> {
  return {
    name: "accion.qrUseLot",
    kind: "ACT",
    effect: "WRITES_LEDGER",
    risk: "ALTO",
    idempotency: {
      mode: "KEYED",
      key: (input) => `qrUseLot:${input.lotId}:${input.gramos}`,
      indiceUnico: "inventory_movements_dedupe_key_uidx",
      parametroRpc: "p_dedupe_key",
    },
    input: entradaAccion,
    output: salidaAccion,
    descripcion: "Descuenta gramos de un lote.",
    limiteFilas: 1,
    veredictoNutricional: false,
    accion: "qrUseLot",
    scope: (input) => ({
      householdId: HOGAR_A,
      members: [],
      rows: [{ table: "inventory_lots", id: input.lotId }],
    }),
    requires: () => [{ k: "ROLE", flag: "canCook" }],
    redact: (_actor, payload) => payload,
    run: async (ctx, input) => {
      const r = await ctx.db.callAction("qrUseLot", { ...input }, ctx.dedupeKey);
      // Un NO explícito de la acción, que es lo único que hace alcanzable FAILED.
      if (!r.ok) throw new AccionRechazada("qrUseLot", r.mensaje ?? "la acción dijo que no");
      return {
        data: { restante: 0 },
        provenance: [{ motor: "inventory", version: "inventory/1.0.0" }],
        unknowns: [],
        reasons: [],
        labels: {},
      };
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

export function sesionLectura(over: Partial<SesionLectura> = {}): SesionLectura {
  return {
    householdId: HOGAR_A,
    traceId: "traza-1",
    capacidades: capacidadesFalsas(actorDePrueba()),
    resolverAmbito: ambitoAlcanzable,
    auditar: async () => {},
    signal: new AbortController().signal,
    db: dbLecturaFalsa(),
    ...over,
  };
}

export function sesionAccion(over: Partial<SesionAccion> = {}): SesionAccion {
  return {
    householdId: HOGAR_A,
    traceId: "traza-1",
    capacidades: capacidadesFalsas(actorDePrueba()),
    resolverAmbito: ambitoAlcanzable,
    auditar: async () => {},
    signal: new AbortController().signal,
    db: dbAccionFalsa(),
    propuestas: crearAlmacenEnMemoria(),
    ...over,
  };
}

export function propuestaDePrueba(over: Partial<AssistantProposal> = {}): AssistantProposal {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    householdId: HOGAR_A,
    createdByMemberId: BETO,
    traceId: "traza-1",
    accion: "qrUseLot",
    args: { lotId: LOTE_77, gramos: 2000 },
    risk: "ALTO",
    effect: "WRITES_LEDGER",
    requires: [{ k: "ROLE", flag: "canCook" }],
    dedupeKey: "qrUseLot:L-77:2000",
    basis: {
      householdId: HOGAR_A,
      capturedAt: "2026-09-01T20:00:00.000Z",
      today: "2026-09-01",
      engineVersions: { stock: "stock/1.0.0" },
      rows: [{ table: "inventory_lots", id: LOTE_77, stamp: "2026-09-01T19:58Z|v4" }],
      signatures: { stock: "firma-1" },
      assertions: [{ k: "LOTE_DISPONIBLE", lotId: LOTE_77, minimo: 2000, estado: "AVAILABLE" }],
    },
    resumen: {
      titulo: "Usar 2,0 kg de pollo del lote L-77 para la cena del viernes",
      lineas: [{ etiqueta: untrusted("Pollo"), valor: "2,0 kg" }],
      reasons: [],
      provenance: [{ motor: "stock", version: "stock/1.0.0" }],
      unknowns: [],
      irreversible: ["descuenta inventario"],
    },
    status: "OFFERED",
    createdAt: "2026-09-01T20:00:00.000Z",
    expiresAt: "2026-09-01T20:15:00.000Z",
    supersededBy: null,
    decidedByMemberId: null,
    decidedAt: null,
    ...over,
  };
}
