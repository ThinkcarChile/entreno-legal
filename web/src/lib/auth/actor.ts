import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";
import type { RolePermissions } from "@/domain/family/types";
import { parseRow, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";

/**
 * ÚNICA respuesta a "¿quién está actuando y qué puede hacer?".
 *
 * Cicatriz Gate 0→10 [F-1]: `loadCurrentMembership` elige el hogar más antiguo
 * cuando nadie dice cuál. Ese desempate es correcto para pintar la portada de
 * alguien que recién entra, y es peligroso para el asistente: si el turno habla
 * de un lote, de una comida o de una restricción, el hogar ya quedó determinado
 * por el dato, no por el orden de `created_at`. Caer al hogar más antiguo ahí
 * significa leer —o peor, escribir— en la casa equivocada.
 *
 * Por eso acá `householdId` es un parámetro OBLIGATORIO y no existe ninguna
 * consulta de respaldo: si quien llama no sabe de qué hogar habla, la respuesta
 * es un error, no una adivinanza.
 *
 * Segunda regla: el capability set lo calcula la BASE (`assistant_capabilities`,
 * migración 0050), no TypeScript. El asistente no decide si puede: pregunta. La
 * RLS sigue siendo la garantía; esto es la cortesía que permite responder "no
 * puedes" sin intentar la escritura.
 */

export type MedicalPermission = "READ_LABS" | "VIEW_CLINICAL_RESTRICTIONS" | "CONFIRM_LABS";

/**
 * Los roles que `assistant_capabilities` (0050) sabe responder.
 * `canManageMembers` NO está: la base no lo devuelve y el asistente no
 * administra integrantes. Declarar una capacidad que nadie sabe evaluar es peor
 * que no tenerla — parece un candado y no cierra.
 */
export type RoleFlag = Exclude<keyof RolePermissions, "canManageMembers">;

/**
 * Lo que una herramienta EXIGE para correr. Es un dato, no una función: así el
 * runtime lo compara contra el `Actor` antes de tocar la base, y la
 * `AssistantProposal` lo guarda para revalidarlo contra QUIEN ACEPTA, que puede
 * no ser quien propuso.
 */
export type Capability =
  | { k: "HOUSEHOLD" }
  | { k: "ROLE"; flag: RoleFlag }
  | { k: "MEDICAL"; owner: string; permission: MedicalPermission }
  | { k: "FINANCE_HOUSEHOLD" }
  | { k: "FINANCE_MEMBER"; owner: string };

export interface MedicalAccess {
  readonly readLabs: boolean;
  readonly restrictions: boolean;
  readonly confirmLabs: boolean;
}

export interface Actor {
  readonly householdId: string;
  /** Ficha de esta persona EN ESTE hogar. En la otra casa es otro integrante. */
  readonly memberId: string;
  readonly timezone: string;
  /**
   * Día civil del hogar, resuelto por `app.household_today`. Ninguna herramienta
   * llama a `new Date()`: el servidor puede estar en otro huso y "hoy" es una
   * afirmación del hogar, no del datacenter.
   */
  readonly today: string;
  readonly isAdmin: boolean;
  readonly canEditPlan: boolean;
  readonly canManageShopping: boolean;
  readonly canCook: boolean;
  /** Solo los integrantes que se pidieron en `members`. Ausencia ≠ permiso. */
  readonly medical: Readonly<Record<string, MedicalAccess>>;
}

export type ActorFailure = "HOGAR_NO_INDICADO" | "HOGAR_INVALIDO" | "NO_ES_MIEMBRO";

/**
 * No es un `DataAccessError`: la consulta funcionó perfecto y la respuesta fue
 * "no". Se distingue porque el runtime los traduce distinto — uno es
 * `NOT_PERMITTED`, el otro es `UNAVAILABLE{LECTURA_FALLIDA}`. Confundirlos es
 * exactamente el bug de contestar "no tienes restricciones" cuando en realidad
 * no se pudieron leer.
 */
export class ActorError extends Error {
  readonly motivo: ActorFailure;

  constructor(motivo: ActorFailure, detalle: string) {
    super(detalle);
    this.name = "ActorError";
    this.motivo = motivo;
  }
}

/**
 * Puerto mínimo: solo el RPC del capability set. Se declara chico acá, en vez de
 * recibir un `SupabaseClient` completo, para que este módulo no tenga forma de
 * escribir aunque alguien lo edite distraído.
 */
export interface CapabilitiesRpc {
  rpc(
    fn: "assistant_capabilities",
    args: { p_household: string; p_members: string[] },
  ): PromiseLike<{ data: unknown; error: PostgrestError | null }>;
}

const accesoMedicoSchema = z.object({
  read_labs: z.boolean(),
  restrictions: z.boolean(),
  confirm_labs: z.boolean(),
});

/**
 * `member: false` es la única forma legítima de "no". Todo lo demás es
 * obligatorio: si la base no mandó `today` o `timezone`, es `DataShapeError` y
 * no un `today` inventado con el reloj del servidor.
 */
const capacidadesSchema = z.discriminatedUnion("member", [
  z.object({ member: z.literal(false) }),
  z.object({
    member: z.literal(true),
    member_id: uuid,
    timezone: z.string().min(1),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    is_admin: z.boolean(),
    can_edit_plan: z.boolean(),
    can_shop: z.boolean(),
    can_cook: z.boolean(),
    medical: z.record(z.string(), accesoMedicoSchema),
  }),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param householdId de qué hogar habla este turno. Obligatorio y sin respaldo.
 * @param members integrantes cuyos permisos médicos hacen falta en ESTE turno.
 *   Pedir de más es divulgar de más: la respuesta solo trae los que se piden.
 */
export async function requireActor(
  db: CapabilitiesRpc,
  householdId: string,
  members: readonly string[] = [],
): Promise<Actor> {
  if (householdId.length === 0) {
    throw new ActorError(
      "HOGAR_NO_INDICADO",
      "Falta el hogar: el asistente no elige uno por su cuenta.",
    );
  }
  if (!UUID.test(householdId)) {
    throw new ActorError("HOGAR_INVALIDO", "El hogar indicado no es un identificador válido.");
  }
  for (const m of members) {
    if (!UUID.test(m)) {
      throw new ActorError("HOGAR_INVALIDO", "Un integrante pedido no es un identificador válido.");
    }
  }

  const { data, error } = await db.rpc("assistant_capabilities", {
    p_household: householdId,
    p_members: [...members],
  });
  // ERROR != VACÍO: una falla de la consulta no puede convertirse en "no puede".
  if (error) throw new DataAccessError("capacidades del actor", error);

  const fila = parseRow(capacidadesSchema, data, "capacidades del actor");
  if (!fila.member) {
    throw new ActorError("NO_ES_MIEMBRO", "No perteneces a este hogar.");
  }

  const medical: Record<string, MedicalAccess> = {};
  for (const [id, acceso] of Object.entries(fila.medical)) {
    medical[id] = {
      readLabs: acceso.read_labs,
      restrictions: acceso.restrictions,
      confirmLabs: acceso.confirm_labs,
    };
  }

  return {
    householdId,
    memberId: fila.member_id,
    timezone: fila.timezone,
    today: fila.today,
    isAdmin: fila.is_admin,
    canEditPlan: fila.can_edit_plan,
    canManageShopping: fila.can_shop,
    canCook: fila.can_cook,
    medical,
  };
}

/**
 * Compara una capacidad contra el actor. Un integrante que no se pidió en
 * `members` no tiene entrada en `medical`, y eso NO es "no tiene permiso": es
 * "no lo pregunté". Devuelve `false` igual —negar es lo seguro— pero el llamador
 * puede distinguir el caso con `capacidadNoConsultada` para no reportar "no
 * tienes acceso" cuando en realidad nunca consultó.
 */
export function tieneCapacidad(actor: Actor, cap: Capability): boolean {
  switch (cap.k) {
    case "HOUSEHOLD":
      return true; // requireActor ya falló si no es miembro del hogar.
    case "ROLE":
      if (actor.isAdmin) return true;
      switch (cap.flag) {
        case "isAdmin":
          return actor.isAdmin;
        case "canEditPlan":
          return actor.canEditPlan;
        case "canManageShopping":
          return actor.canManageShopping;
        case "canCook":
          return actor.canCook;
      }
      return false;
    case "MEDICAL": {
      const acceso = actor.medical[cap.owner];
      if (acceso === undefined) return false;
      switch (cap.permission) {
        case "READ_LABS":
          return acceso.readLabs;
        case "VIEW_CLINICAL_RESTRICTIONS":
          return acceso.restrictions;
        case "CONFIRM_LABS":
          return acceso.confirmLabs;
      }
      return false;
    }
    // Sprint 14. Mientras no exista el motor de finanzas nadie tiene la
    // capacidad: negar es la respuesta honesta, no "todavía no sé".
    case "FINANCE_HOUSEHOLD":
    case "FINANCE_MEMBER":
      return false;
  }
}

/** Distingue "no tiene permiso" de "no lo consulté" (ver `tieneCapacidad`). */
export function capacidadNoConsultada(actor: Actor, cap: Capability): boolean {
  return cap.k === "MEDICAL" && actor.medical[cap.owner] === undefined;
}

/** La primera capacidad que falta, o `null` si están todas. */
export function faltaCapacidad(actor: Actor, caps: readonly Capability[]): Capability | null {
  for (const cap of caps) {
    if (!tieneCapacidad(actor, cap)) return cap;
  }
  return null;
}

/** Los integrantes cuyos permisos médicos hay que pedirle a la base este turno. */
export function integrantesDeCapacidades(caps: readonly Capability[]): string[] {
  const ids = new Set<string>();
  for (const cap of caps) {
    if (cap.k === "MEDICAL" || cap.k === "FINANCE_MEMBER") ids.add(cap.owner);
  }
  return [...ids];
}

/**
 * La misma capacidad, en el vocabulario que evalúa `app.capabilities_ok` (0050).
 *
 * `AssistantProposal.requires` se guarda como jsonb y quien decide de verdad es
 * la política de RLS, no este archivo. Si la app escribe `{"k":"ROLE",...}` y la
 * base espera `{"k":"PLAN"}`, la base NIEGA (una `k` desconocida niega a
 * propósito) y la tarjeta queda invisible para todos: un solo dueño del dato
 * exige una sola traducción, y es esta.
 *
 * `HOUSEHOLD` no se serializa: la lista vacía ya significa "cualquier integrante
 * del hogar". Las de finanzas se serializan con su `k` propia, que la base
 * todavía no entiende y por lo tanto niega — que es la respuesta correcta
 * mientras el Sprint 14 no exista.
 */
export function capabilityParaLaBase(
  cap: Capability,
): { k: string; owner?: string; permission?: MedicalPermission } | null {
  switch (cap.k) {
    case "HOUSEHOLD":
      return null;
    case "ROLE":
      switch (cap.flag) {
        case "isAdmin":
          return { k: "ADMIN" };
        case "canEditPlan":
          return { k: "PLAN" };
        case "canManageShopping":
          return { k: "SHOP" };
        case "canCook":
          return { k: "COOK" };
      }
      return null;
    case "MEDICAL":
      return { k: "MEDICAL", owner: cap.owner, permission: cap.permission };
    case "FINANCE_HOUSEHOLD":
      return { k: "FINANCE_HOUSEHOLD" };
    case "FINANCE_MEMBER":
      return { k: "FINANCE_MEMBER", owner: cap.owner };
  }
}

/** Las capacidades que se guardan en la fila, ya traducidas. */
export function requiresParaLaBase(
  caps: readonly Capability[],
): { k: string; owner?: string; permission?: MedicalPermission }[] {
  const out: { k: string; owner?: string; permission?: MedicalPermission }[] = [];
  for (const cap of caps) {
    const fila = capabilityParaLaBase(cap);
    if (fila !== null) out.push(fila);
  }
  return out;
}
