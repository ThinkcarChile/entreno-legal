import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { resolvePermissions } from "@/domain/family/permissions";
import { effectiveDate, weekStart } from "@/domain/nutrition/calendar";
import { parseMaybeRow, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { noSabido, sabido } from "./pasos";
import type { Adorno, HechosEsenciales, HechosOnboarding, IntegranteOnboarding } from "./pasos";

/**
 * Lee el estado REAL de la puesta en marcha.
 *
 * Todas las consultas son las mismas tablas que usa la aplicación para trabajar
 * —no hay una tabla `onboarding` ni una columna `paso_actual`— justamente para
 * que el avance no pueda quedar desfasado de lo que la persona hizo. Si mañana
 * borra un integrante, el paso 3 vuelve solo a "pendiente".
 *
 * Y como en el resto de la capa de datos: un error de consulta NUNCA se traduce
 * en "no hay nada". Un cero inventado acá sería peor que una pantalla en blanco:
 * mandaría a alguien a rehacer lo que ya hizo, o peor, le diría que está listo.
 *
 * La lectura viene partida en dos, y la costura importa:
 *
 *  - `cargarHechosEsenciales` lee lo mínimo para decidir dónde entra la persona
 *    (hogar + fichas + seguimiento declarado). Es lo único que corre en la
 *    portada `/`, que es el punto de entrada de TODA la aplicación.
 *  - `cargarHechosOnboarding` agrega los ADORNOS de la pantalla de pasos
 *    (nombre del hogar, invitaciones, comidas de la semana). Ninguno decide
 *    nada, así que ninguno puede tumbar la pantalla: si no se pueden leer,
 *    vuelven como `no sabido` CON su motivo y el paso lo muestra.
 *
 * El problema real que lo puso así: la portada pasó de ser un redirect de una
 * línea a caerse si fallaba cualquiera de unas diez consultas, la mitad de las
 * cuales el redirect descartaba. Pedir lo que no se necesita para decidir no es
 * gratis: es superficie de falla en la puerta de entrada.
 */

type Db = SupabaseClient;

const trackingRowSchema = z.object({ member_id: uuid });

const rolEmbebido = z.object({
  is_admin: z.boolean(),
  can_manage_members: z.boolean(),
  can_edit_plan: z.boolean(),
  can_manage_shopping: z.boolean(),
  can_cook: z.boolean(),
});
// PostgREST devuelve el embed como objeto o como lista según la relación; la
// misma normalización que ya hace /family con los roles.
const oneRol = z
  .union([rolEmbebido, z.array(rolEmbebido), z.null()])
  .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));
const asignacionSchema = z.object({ household_roles: oneRol });

const invitacionRowSchema = z.object({
  accepted_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  expires_at: z.string(),
});

const idRowSchema = z.object({ id: uuid });

const hogarRowSchema = z.object({ name: z.string(), timezone: z.string() });

/**
 * Lo mínimo indispensable: hogar, fichas activas y quiénes ya respondieron.
 *
 * Son tres consultas (membresía, integrantes, seguimiento) y ninguna es
 * opcional: las dos preguntas esenciales —¿hay hogar? ¿están los perfiles
 * declarados?— se contestan justo con eso. Si alguna falla, revienta: no hay
 * forma honesta de mandar a alguien a `/family` o a `/onboarding` sin saber.
 */
export async function cargarHechosEsenciales(db: Db): Promise<HechosEsenciales> {
  // La regla "cuál hogar es el mío" tiene un solo dueño (`current-household`,
  // vía `loadHouseholdMembers`): el más antiguo, determinista, Gate 0→10 [F-1].
  // La portada ya fue una de las que la copió a mano y volvió a mandar a la
  // gente de dos casas a la casa equivocada; acá no se reimplementa.
  const { householdId, members } = await loadHouseholdMembers(db);

  if (!householdId) {
    // Sin hogar no hay nada que contar: estas listas vacías no son "no sabemos",
    // son que las tablas todavía no tienen dónde colgar una fila.
    return { hogarId: null, integrantes: [], seguimientoDeclarado: [] };
  }

  const integrantes: IntegranteOnboarding[] = members.map((m) => ({
    id: m.id,
    nombre: m.displayName,
    esYo: m.isMe,
  }));

  return {
    hogarId: householdId,
    integrantes,
    seguimientoDeclarado: await cargarSeguimientoDeclarado(
      db,
      integrantes.map((m) => m.id),
    ),
  };
}

/** Lo esencial MÁS los adornos que solo se muestran en la pantalla de pasos. */
export async function cargarHechosOnboarding(db: Db): Promise<HechosOnboarding> {
  const esenciales = await cargarHechosEsenciales(db);

  if (esenciales.hogarId === null) {
    const sinHogar = "Todavía no hay hogar del cual leerlo.";
    return {
      ...esenciales,
      nombreHogar: null,
      invitaciones: noSabido(sinHogar),
      comidasEstaSemana: noSabido(sinHogar),
    };
  }

  const hogarRow = await leerHogar(db, esenciales.hogarId);
  const yo = esenciales.integrantes.find((m) => m.esYo) ?? null;

  const [invitaciones, comidasEstaSemana] = await Promise.all([
    leerInvitaciones(db, esenciales.hogarId, yo),
    leerComidasEstaSemana(db, esenciales.hogarId, hogarRow?.timezone ?? null),
  ]);

  return {
    ...esenciales,
    nombreHogar: hogarRow?.name ?? null,
    invitaciones,
    comidasEstaSemana,
  };
}

/**
 * Ficha del hogar. `null` = no volvió (RLS, o la fila se borró entre consultas).
 *
 * Acá vivía un `?? "Mi hogar"` que le hacía AFIRMAR a la pantalla un nombre que
 * nadie escribió nunca. El nombre es adorno —ningún paso se decide con él— así
 * que un fallo de lectura tampoco puede tumbar la pantalla: se declara sin
 * saber y el paso 1 lo dice con todas sus letras.
 */
async function leerHogar(
  db: Db,
  householdId: string,
): Promise<{ name: string; timezone: string } | null> {
  const { data, error } = await db
    .from("households")
    .select("name, timezone")
    .eq("id", householdId)
    .maybeSingle();
  // El error tampoco se pierde: vuelve como el mismo `null` de "no volvió la
  // fila", y el paso 1 dice que no pudo leer la ficha en vez de inventarle un
  // nombre. Lo que NO puede pasar es que la portada se caiga por esto.
  if (error) return null;
  return parseMaybeRow(hogarRowSchema, data, "ficha del hogar");
}

/**
 * Quiénes ya declararon su modo de seguimiento.
 *
 * Se pregunta por la EXISTENCIA de la fila, no por su valor: `mode = 'OFF'` es
 * una respuesta ("no llevo seguimiento") y la ausencia de fila es silencio. El
 * perfil los trata igual —los dos terminan en `OFF`— pero el onboarding no
 * puede, porque su trabajo es justamente pedir la respuesta que falta.
 */
async function cargarSeguimientoDeclarado(db: Db, memberIds: string[]): Promise<string[]> {
  if (memberIds.length === 0) return [];
  const { data, error } = await db
    .from("member_tracking_settings")
    .select("member_id")
    .in("member_id", memberIds);
  if (error) throw new DataAccessError("seguimiento declarado del hogar", error);
  return parseRows(trackingRowSchema, data, "seguimiento declarado del hogar").map(
    (r) => r.member_id,
  );
}

/**
 * Envuelve la lectura de un adorno.
 *
 * Solo atrapa `DataAccessError` —la consulta no se pudo hacer— y lo convierte
 * en un desconocido CON motivo, que es lo que la pantalla muestra. Cualquier
 * otra excepción (una fila con forma distinta, por ejemplo) sigue de largo: eso
 * es un defecto nuestro y tiene que hacer ruido, no quedar como "no se sabe".
 */
async function adorno<T>(que: string, leer: () => Promise<T>): Promise<Adorno<T>> {
  try {
    return sabido(await leer());
  } catch (e) {
    if (e instanceof DataAccessError) {
      return noSabido(`No pudimos leer ${que}: la base respondió ${e.code}.`);
    }
    throw e;
  }
}

/**
 * Invitaciones del hogar, si es que las podemos ver.
 *
 * Un integrante común no ve la tabla (RLS `invitations_admin`) y le vuelve
 * vacía. Preguntar igual y contar cero le diría "no invitaste a nadie" a
 * alguien que quizás sí fue invitado por otro: eso es UNKNOWN disfrazado de
 * dato, y por eso el "no soy administrador" viaja como desconocido explícito.
 */
async function leerInvitaciones(
  db: Db,
  householdId: string,
  yo: IntegranteOnboarding | null,
): Promise<Adorno<{ vigentes: number; aceptadas: number }>> {
  if (!yo) {
    return noSabido(
      "No encontramos tu ficha en el hogar, así que no sabemos si puedes ver las invitaciones.",
    );
  }

  const puedoVerlas = await adorno("tus roles en el hogar", () => esAdministrador(db, yo.id));
  if (!puedoVerlas.conocido) return noSabido(puedoVerlas.porque);
  if (!puedoVerlas.valor) {
    return noSabido(
      "Las invitaciones las ve solo quien administra el hogar, así que no podemos decirte si hay alguna en curso.",
    );
  }
  return adorno("las invitaciones", () => cargarInvitaciones(db, householdId));
}

/** Una persona puede tener varios roles: manda la unión de sus permisos. */
async function esAdministrador(db: Db, memberId: string): Promise<boolean> {
  const { data, error } = await db
    .from("member_role_assignments")
    .select(
      "household_roles ( is_admin, can_manage_members, can_edit_plan, can_manage_shopping, can_cook )",
    )
    .eq("member_id", memberId);
  if (error) throw new DataAccessError("roles del integrante", error);

  const roles = parseRows(asignacionSchema, data, "roles del integrante")
    .map((a) => a.household_roles)
    .filter((r) => r !== null)
    .map((r) => ({
      isAdmin: r.is_admin,
      canManageMembers: r.can_manage_members,
      canEditPlan: r.can_edit_plan,
      canManageShopping: r.can_manage_shopping,
      canCook: r.can_cook,
    }));
  return resolvePermissions(roles).isAdmin;
}

async function cargarInvitaciones(
  db: Db,
  householdId: string,
): Promise<{ vigentes: number; aceptadas: number }> {
  const { data, error } = await db
    .from("invitations")
    .select("accepted_at, revoked_at, expires_at")
    .eq("household_id", householdId);
  if (error) throw new DataAccessError("invitaciones del hogar", error);

  const filas = parseRows(invitacionRowSchema, data, "invitaciones del hogar");
  const ahora = Date.now();
  return {
    vigentes: filas.filter(
      (i) => i.accepted_at === null && i.revoked_at === null && Date.parse(i.expires_at) > ahora,
    ).length,
    aceptadas: filas.filter((i) => i.accepted_at !== null).length,
  };
}

/**
 * Comidas planificadas en la semana en curso.
 *
 * La semana se ancla al día del HOGAR, no al de UTC: a las 22:30 en Santiago
 * todavía es hoy, y un domingo en la noche no puede pasar a contar la semana
 * siguiente antes de tiempo.
 */
function leerComidasEstaSemana(
  db: Db,
  householdId: string,
  timezone: string | null,
): Promise<Adorno<number>> {
  return adorno("la semana en curso", async () => {
    // Mismo rodeo que /plan cuando la zona del hogar no está a mano: se cuenta
    // con la hora de Chile. Corre el día como mucho unas horas y solo afecta el
    // conteo de un paso que no decide nada.
    const inicio = weekStart(effectiveDate(new Date(), timezone ?? "America/Santiago"));

    const { data: plan, error: planError } = await db
      .from("weekly_plans")
      .select("id")
      .eq("household_id", householdId)
      .eq("week_start", inicio)
      .maybeSingle();
    if (planError) throw new DataAccessError("plan de la semana", planError);
    if (!plan) return 0;

    const { data: dias, error: diasError } = await db
      .from("weekly_plan_days")
      .select("id")
      .eq("plan_id", plan.id);
    if (diasError) throw new DataAccessError("días de la semana", diasError);

    const diaIds = parseRows(idRowSchema, dias, "días de la semana").map((d) => d.id);
    if (diaIds.length === 0) return 0;

    // Se traen los ids y se cuentan acá en vez de pedir un `count` a PostgREST:
    // un conteo puede volver `null` y no hay forma de distinguir ese null de un
    // cero. Son 35 filas como máximo (7 días × 5 comidas), no vale la pena la
    // ambigüedad.
    const { data: comidas, error: comidasError } = await db
      .from("meal_assignments")
      .select("id")
      .in("day_id", diaIds);
    if (comidasError) throw new DataAccessError("comidas de la semana", comidasError);

    return parseRows(idRowSchema, comidas, "comidas de la semana").length;
  });
}
