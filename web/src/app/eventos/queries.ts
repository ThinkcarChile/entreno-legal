import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { columnsOf, dateString, nullableNumeric, parseRow, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { MEAL_TYPES, type MealType } from "@/domain/recipes/types";
import type { BbqRecordedBlocks } from "@/domain/events/bbq/types";
import {
  entradaEstimacionSchema,
  salidaEstimacionSchema,
  type Revision,
} from "./contrato-estimacion";
import { grupoEdadDeMiembro } from "./edades";
import {
  APETITOS,
  ASISTENCIAS,
  BANDERAS_DIETARIAS,
  CATEGORIAS_MENU,
  CONTEXTOS_COMIDA,
  ESTADOS_EVENTO,
  GRUPOS_EDAD,
  NIVELES_ACOMPANAMIENTO,
  SOBRANTES_DESEADOS,
  TIPOS_EVENTO,
  TIPOS_ITEM_MENU,
  type Apetito,
  type Asistencia,
  type BanderaDietaria,
  type CategoriaMenu,
  type ContextoComida,
  type EstadoEvento,
  type GrupoEdad,
  type NivelAcompanamiento,
  type SobranteDeseado,
  type TipoEvento,
  type TipoItemMenu,
} from "./vocabulario";

/**
 * Las lecturas de la superficie de eventos.
 *
 * DOS COSAS QUE ESTA CAPA NO HACE, y las dos son deliberadas:
 *
 *  1. No lee NADA clínico. Ni de los integrantes del hogar ni de los invitados.
 *     La pantalla del evento la miran los invitados —está abierta sobre la mesa
 *     mientras se cocina—, así que no muestra diagnósticos, ni límites, ni
 *     etiquetas de salud, y por lo tanto tampoco los pide. El motor clínico
 *     sigue mandando en las porciones del hogar; eso vive en otra superficie.
 *
 *  2. No lee `allergy_note`. La nota es lo que el invitado reportó con sus
 *     palabras y vive solo en su ficha. Para el evento alcanza la bandera
 *     `ALLERGY_REPORTED`, que es lo único que el motor necesita para exigir
 *     revisión si el menú no permite servirle con seguridad.
 *
 * Y como en toda la app: un error de consulta jamás se convierte en "no hay
 * nada". Se lanza `DataAccessError` y la pantalla muestra el error.
 */

type Db = SupabaseClient;

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

const eventoColumnas = z.object({
  id: uuid,
  event_date: dateString,
  end_date: dateString.nullable(),
  event_type: z.string(),
  meal_type: z.string().nullable(),
  status: z.string(),
  title: z.string(),
  location_kind: z.string().nullable(),
  location_note: z.string().nullable(),
  serving_time: z.string().nullable(),
  duration_hours: nullableNumeric,
  meal_context: z.string().nullable(),
  sides_level: z.string().nullable(),
  desired_leftover_kind: z.string().nullable(),
  desired_leftover_g: nullableNumeric,
  safety_buffer_pct: nullableNumeric,
  budget_clp: nullableNumeric,
  locked_at: z.string().nullable(),
  notes: z.string().nullable(),
});

const SELECT_EVENTO = columnsOf(eventoColumnas);

export interface Evento {
  id: string;
  fecha: string;
  fechaFin: string | null;
  /**
   * `null` cuando la base tiene un valor de enum que esta versión de la app
   * todavía no conoce. El texto crudo viaja al lado y la pantalla lo muestra:
   * mejor un código raro que un tipo equivocado con cara de correcto.
   */
  tipo: TipoEvento | null;
  tipoCrudo: string;
  /**
   * LA PRIMERA COMIDA DEL PLAN QUE REEMPLAZA ESTE EVENTO (H20), no la única.
   *
   * Desde la 0061 esta columna es el ESPEJO de `event_covered_meals`: un asado
   * que cubre almuerzo y cena la trae en 'LUNCH'. Para saber TODO lo que cubre
   * hay que usar `cargarComidasCubiertas` — decidir con este campo solo es
   * exactamente cómo se compraba dos veces la cena.
   *
   * `null` = todavía no se declaró ninguna, y eso NO significa "todas": sin esa
   * respuesta el evento no releva nada y el sábado del asado se compra también
   * el almuerzo. La pantalla lo dice con esas palabras en vez de asumir.
   */
  comida: MealType | null;
  comidaCruda: string | null;
  estado: EstadoEvento | null;
  estadoCrudo: string;
  titulo: string;
  enCasa: boolean | null;
  lugar: string | null;
  /** Hora de servir. `null` = no declarada; NUNCA se rellena con las 12:00. */
  horaDeServir: string | null;
  duracionHoras: number | null;
  contextoComida: ContextoComida | null;
  nivelAcompanamiento: NivelAcompanamiento | null;
  sobranteDeseado: SobranteDeseado | null;
  sobranteDeseadoG: number | null;
  bufferSeguridadPct: number | null;
  presupuestoClp: number | null;
  bloqueadoEn: string | null;
  notas: string | null;
}

/**
 * Un valor de enum que la base conoce y esta versión de la app todavía no.
 *
 * Se devuelve `null` y se guarda el texto crudo aparte, en vez de forzarlo al
 * primer valor de la lista. Si mañana la 0042 agrega un tipo de evento, la
 * pantalla muestra el código en vez de mentir diciendo que es un asado.
 */
function comoEnum<T extends string>(valores: readonly T[], crudo: string | null): T | null {
  if (crudo === null) return null;
  return (valores as readonly string[]).includes(crudo) ? (crudo as T) : null;
}

/**
 * Las banderas dietarias que esta versión sabe leer.
 *
 * `null` entra y sale como `null` — es "no sabemos" y no se puede convertir en
 * una lista vacía, que significa "declaró que no tiene restricciones". Una
 * bandera nueva que la app todavía no conoce se descarta de la lista visible;
 * lo que jamás pasa es que un `null` se vuelva `[]` por el camino.
 */
function soloBanderasConocidas(crudas: string[] | null): BanderaDietaria[] | null {
  if (crudas === null) return null;
  return crudas.filter((f): f is BanderaDietaria =>
    (BANDERAS_DIETARIAS as readonly string[]).includes(f),
  );
}

function mapearEvento(fila: z.infer<typeof eventoColumnas>): Evento {
  return {
    id: fila.id,
    fecha: fila.event_date,
    fechaFin: fila.end_date,
    tipo: comoEnum(TIPOS_EVENTO, fila.event_type),
    tipoCrudo: fila.event_type,
    comida: comoEnum(MEAL_TYPES, fila.meal_type),
    comidaCruda: fila.meal_type,
    estado: comoEnum(ESTADOS_EVENTO, fila.status),
    estadoCrudo: fila.status,
    titulo: fila.title,
    enCasa: fila.location_kind === null ? null : fila.location_kind === "HOME",
    lugar: fila.location_note,
    horaDeServir: fila.serving_time,
    duracionHoras: fila.duration_hours,
    contextoComida: comoEnum(CONTEXTOS_COMIDA, fila.meal_context),
    nivelAcompanamiento: comoEnum(NIVELES_ACOMPANAMIENTO, fila.sides_level),
    sobranteDeseado: comoEnum(SOBRANTES_DESEADOS, fila.desired_leftover_kind),
    sobranteDeseadoG: fila.desired_leftover_g,
    bufferSeguridadPct: fila.safety_buffer_pct,
    presupuestoClp: fila.budget_clp,
    bloqueadoEn: fila.locked_at,
    notas: fila.notes,
  };
}

/** Los eventos del hogar, del más próximo al más lejano. */
export async function cargarEventos(db: Db, householdId: string): Promise<Evento[]> {
  const { data, error } = await db
    .from("nutrition_events")
    .select(SELECT_EVENTO)
    .eq("household_id", householdId)
    .order("event_date", { ascending: false });
  if (error) throw new DataAccessError("eventos del hogar", error);
  return parseRows(eventoColumnas, data, "eventos del hogar").map(mapearEvento);
}

export async function cargarEvento(db: Db, eventoId: string): Promise<Evento | null> {
  const { data, error } = await db
    .from("nutrition_events")
    .select(SELECT_EVENTO)
    .eq("id", eventoId)
    .maybeSingle();
  if (error) throw new DataAccessError("evento", error);
  if (data === null) return null;
  return mapearEvento(parseRow(eventoColumnas, data, "evento"));
}

// ---------------------------------------------------------------------------
// Comidas cubiertas (0061)
// ---------------------------------------------------------------------------

/**
 * Qué comidas del plan reemplaza el evento, TODAS.
 *
 * Se lee de `public.event_covered_meals` y no de `nutrition_events.meal_type`,
 * que desde la 0061 es sólo el espejo de la PRIMERA. Un asado que da almuerzo y
 * cena leído por el espejo se ve como si diera sólo almuerzo, y la pantalla que
 * pregunta "¿qué reemplaza?" mostraría media respuesta: la persona vuelve a
 * marcar la cena, no pasa nada visible, y termina comprando igual "por si
 * acaso".
 *
 * Una comida que esta versión de la app no conoce NO se descarta: viaja cruda y
 * la pantalla la muestra tal cual. Descartarla sería mostrar menos cobertura de
 * la que hay, y esa diferencia es lo que alguien compra de más.
 */
export interface ComidaCubierta {
  comida: MealType | null;
  comidaCruda: string;
}

const comidaCubiertaColumnas = z.object({ meal_type: z.string() });

export async function cargarComidasCubiertas(
  db: Db,
  eventoId: string,
): Promise<ComidaCubierta[]> {
  const { data, error } = await db
    .from("event_covered_meals")
    .select(columnsOf(comidaCubiertaColumnas))
    .eq("event_id", eventoId);
  if (error) throw new DataAccessError("comidas que cubre el evento", error);

  const filas = parseRows(comidaCubiertaColumnas, data, "comidas que cubre el evento").map((f) => ({
    comida: (MEAL_TYPES as readonly string[]).includes(f.meal_type)
      ? (f.meal_type as MealType)
      : null,
    comidaCruda: f.meal_type,
  }));

  // En orden de día, que es el del catálogo: la pantalla las lista como
  // transcurre el día y no como PostgREST las devolvió. Las desconocidas van al
  // final, sin inventarles una posición.
  return filas.sort((a, b) => {
    const ia = a.comida === null ? MEAL_TYPES.length : MEAL_TYPES.indexOf(a.comida);
    const ib = b.comida === null ? MEAL_TYPES.length : MEAL_TYPES.indexOf(b.comida);
    return ia - ib || a.comidaCruda.localeCompare(b.comidaCruda);
  });
}

// ---------------------------------------------------------------------------
// Participantes
// ---------------------------------------------------------------------------

const invitadoEmbebido = z
  .union([
    z.object({
      id: uuid,
      name: z.string().nullable(),
      age_group: z.string(),
      appetite: z.string(),
      dietary_flags: z.array(z.string()).nullable(),
      archived_at: z.string().nullable(),
    }),
    z.null(),
  ])
  .transform((v) => v);

const miembroEmbebido = z
  .union([
    z.object({ id: uuid, display_name: z.string(), birth_date: dateString.nullable() }),
    z.null(),
  ])
  .transform((v) => v);

const participanteColumnas = z.object({
  id: uuid,
  event_id: uuid,
  participant_type: z.enum(["HOUSEHOLD_MEMBER", "GUEST"]),
  member_id: uuid.nullable(),
  guest_id: uuid.nullable(),
  attendance_status: z.string(),
  is_extra: z.boolean(),
  appetite_override: z.string().nullable(),
});

const participanteSchema = participanteColumnas.extend({
  guest_profiles: invitadoEmbebido,
  household_members: miembroEmbebido,
});

const SELECT_PARTICIPANTE = columnsOf(
  participanteColumnas,
  "guest_profiles(id, name, age_group, appetite, dietary_flags, archived_at), " +
    "household_members(id, display_name, birth_date)",
);

export interface Participante {
  id: string;
  tipo: "HOUSEHOLD_MEMBER" | "GUEST";
  memberId: string | null;
  guestId: string | null;
  /** `null` cuando el invitado se agregó sin nombre. La pantalla lo rotula. */
  nombre: string | null;
  grupoEdad: GrupoEdad;
  /**
   * El apetito que se usa para ESTE evento: el ajuste del evento manda sobre el
   * del perfil. No al revés y no se mezclan — el §7 prohíbe cambiarle el perfil
   * a alguien por una sola comida.
   */
  apetitoEfectivo: Apetito;
  /** `true` cuando el apetito viene del ajuste del evento y no de la ficha. */
  apetitoAjustado: boolean;
  /** `null` = la base trae una marca que esta versión no conoce (ver `tipo`). */
  asistencia: Asistencia | null;
  asistenciaCruda: string;
  esExtra: boolean;
  /**
   * `null` = NO SABEMOS qué restricciones tiene. `[]` = declaró que no tiene.
   * La pantalla los muestra distinto y el motor los cuenta distinto.
   */
  banderasDietarias: BanderaDietaria[] | null;
}

/**
 * Los participantes del evento.
 *
 * `fechaDelEvento` entra por parámetro porque de ella depende el grupo de edad
 * de los integrantes del hogar: quien cumple años entre hoy y el asado va al
 * asado con la edad nueva.
 */
export async function cargarParticipantes(
  db: Db,
  eventoId: string,
  fechaDelEvento: string,
): Promise<Participante[]> {
  const { data, error } = await db
    .from("event_participants")
    .select(SELECT_PARTICIPANTE)
    .eq("event_id", eventoId);
  if (error) throw new DataAccessError("participantes del evento", error);

  return parseRows(participanteSchema, data, "participantes del evento").map((fila) => {
    const invitado = Array.isArray(fila.guest_profiles) ? fila.guest_profiles[0] : fila.guest_profiles;
    const miembro = Array.isArray(fila.household_members)
      ? fila.household_members[0]
      : fila.household_members;

    const ajuste = comoEnum(APETITOS, fila.appetite_override);
    const delPerfil = comoEnum(APETITOS, invitado?.appetite ?? null);

    return {
      id: fila.id,
      tipo: fila.participant_type,
      memberId: fila.member_id,
      guestId: fila.guest_id,
      nombre: miembro ? miembro.display_name : (invitado?.name ?? null),
      // Sin ficha, sin fecha de nacimiento o con un grupo que no conocemos:
      // UNKNOWN. Jamás ADULT por omisión — contar a un niño como adulto sube la
      // compra medio kilo sin que nadie lo haya dicho.
      grupoEdad: miembro
        ? grupoEdadDeMiembro(miembro.birth_date, fechaDelEvento)
        : (comoEnum(GRUPOS_EDAD, invitado?.age_group ?? null) ?? "UNKNOWN"),
      // El apetito del evento gana; si no hay, el de la ficha; si tampoco, se
      // dice que no se sabe. En ninguna rama aparece NORMAL por omisión.
      apetitoEfectivo: ajuste ?? delPerfil ?? "UNKNOWN",
      apetitoAjustado: ajuste !== null,
      asistencia: comoEnum(ASISTENCIAS, fila.attendance_status),
      asistenciaCruda: fila.attendance_status,
      esExtra: fila.is_extra,
      banderasDietarias: soloBanderasConocidas(
        invitado === null || invitado === undefined ? null : invitado.dietary_flags,
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Lo que la casa YA SABE que alguien no puede comer
// ---------------------------------------------------------------------------

const bloqueoFila = z.object({
  participant_id: uuid,
  menu_item_id: uuid,
  from_allergy: z.boolean(),
});

/**
 * Qué item del menú NO puede comer cada integrante del hogar.
 *
 * El defecto que cierra: las banderas culinarias (`dietary_flags`) sólo existen
 * en la ficha de los INVITADOS, así que todo integrante del hogar llegaba al
 * motor con `null` — y el motor lee `null` como "no hay restricción declarada".
 * Resultado: al papá con la alergia registrada EN ESTA MISMA APP se le repartía
 * su porción del corte que no puede comer, y la pantalla lo contaba entre los
 * que "comen de todo".
 *
 * Viene por RPC y no por `select` a propósito: la restricción clínica confirmada
 * vive detrás del permiso médico (0027) y el anfitrión puede no tenerlo. Si esto
 * pasara por su RLS, el resultado sería "no hay restricciones", que es UNKNOWN
 * leído como "puede comer todo" — en un asado, el error que no se puede cometer.
 *
 * Lo que cruza es SÓLO el qué: pares (participante, item) y si el bloqueo viene
 * de una alergia. Ni el diagnóstico, ni la condición, ni el ingrediente. Por eso
 * esta información puede entrar al cálculo sin poder aparecer en la pantalla.
 *
 * Si la consulta falla, revienta: una lista vacía significaría "nadie tiene
 * restricciones" y ERROR no es VACÍO (§97).
 */
export async function cargarBloqueosDelMenu(
  db: Db,
  eventoId: string,
): Promise<Map<string, BbqRecordedBlocks>> {
  const { data, error } = await db.rpc("event_menu_blocks", { p_event: eventoId });
  if (error) throw new DataAccessError("restricciones registradas del menú", error);

  const porParticipante = new Map<
    string,
    { blockedItemIds: string[]; allergyItemIds: string[] }
  >();
  for (const fila of parseRows(bloqueoFila, data, "restricciones registradas del menú")) {
    let acumulado = porParticipante.get(fila.participant_id);
    if (acumulado === undefined) {
      acumulado = { blockedItemIds: [], allergyItemIds: [] };
      porParticipante.set(fila.participant_id, acumulado);
    }
    acumulado.blockedItemIds.push(fila.menu_item_id);
    if (fila.from_allergy) acumulado.allergyItemIds.push(fila.menu_item_id);
  }
  return porParticipante;
}

// ---------------------------------------------------------------------------
// Invitados del hogar (el selector del builder)
// ---------------------------------------------------------------------------

const invitadoColumnas = z.object({
  id: uuid,
  name: z.string().nullable(),
  age_group: z.string(),
  appetite: z.string(),
  dietary_flags: z.array(z.string()).nullable(),
  archived_at: z.string().nullable(),
});

export interface Invitado {
  id: string;
  nombre: string | null;
  grupoEdad: GrupoEdad;
  apetito: Apetito;
  banderasDietarias: BanderaDietaria[] | null;
  archivado: boolean;
}

/**
 * Las fichas de invitados del hogar.
 *
 * Los archivados quedan fuera por omisión: los "Invitado 3" que nacen de
 * "llegó otra persona" se archivan solos cuando el evento termina, y sin este
 * filtro el selector se llena de filas anónimas que nadie reconoce. Se pueden
 * pedir igual —el anfitrión que después se acuerda de quién era, le pone nombre
 * y la ficha vuelve a servir.
 */
export async function cargarInvitadosDelHogar(
  db: Db,
  householdId: string,
  opciones?: { incluirArchivados?: boolean },
): Promise<Invitado[]> {
  let consulta = db
    .from("guest_profiles")
    .select(columnsOf(invitadoColumnas))
    .eq("household_id", householdId);
  if (opciones?.incluirArchivados !== true) consulta = consulta.is("archived_at", null);

  const { data, error } = await consulta.order("name", { nullsFirst: false });
  if (error) throw new DataAccessError("invitados del hogar", error);

  return parseRows(invitadoColumnas, data, "invitados del hogar").map((fila) => ({
    id: fila.id,
    nombre: fila.name,
    grupoEdad: comoEnum(GRUPOS_EDAD, fila.age_group) ?? "UNKNOWN",
    apetito: comoEnum(APETITOS, fila.appetite) ?? "UNKNOWN",
    banderasDietarias: soloBanderasConocidas(fila.dietary_flags),
    archivado: fila.archived_at !== null,
  }));
}

// ---------------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------------

const itemMenuColumnas = z.object({
  id: uuid,
  event_id: uuid,
  kind: z.string(),
  category: z.string().nullable(),
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  display_name: z.string(),
  distribution_pct: nullableNumeric,
  notes: z.string().nullable(),
});

export interface ItemMenu {
  id: string;
  /**
   * `null` cuando la base trae una clase de item que esta versión no conoce.
   * NO se cae a "acompañamiento": de esa clasificación depende si el item entra
   * o no en el reparto de carne, y adivinarla puede sacar un corte entero de la
   * compra sin que nadie se entere.
   */
  tipo: TipoItemMenu | null;
  tipoCrudo: string;
  categoria: CategoriaMenu | null;
  ingredientId: string | null;
  productId: string | null;
  nombre: string;
  /** `null` = modo AUTO. El motor reparte; no es 0 %. */
  porcentaje: number | null;
  notas: string | null;
}

export async function cargarMenu(db: Db, eventoId: string): Promise<ItemMenu[]> {
  const { data, error } = await db
    .from("event_menu_items")
    .select(columnsOf(itemMenuColumnas))
    .eq("event_id", eventoId);
  if (error) throw new DataAccessError("menú del evento", error);

  return parseRows(itemMenuColumnas, data, "menú del evento").map((fila) => ({
    id: fila.id,
    tipo: comoEnum(TIPOS_ITEM_MENU, fila.kind),
    tipoCrudo: fila.kind,
    categoria: comoEnum(CATEGORIAS_MENU, fila.category),
    ingredientId: fila.ingredient_id,
    productId: fila.product_id,
    nombre: fila.display_name,
    porcentaje: fila.distribution_pct,
    notas: fila.notes,
  }));
}

// ---------------------------------------------------------------------------
// Revisiones congeladas
// ---------------------------------------------------------------------------

/**
 * Las columnas de `event_plan_revisions`. Cada `jsonb` se valida con el
 * contrato: si el motor cambia la forma de su salida, esto revienta al leer en
 * vez de dibujar kilos que ya no significan lo mismo.
 */
const revisionColumnas = z.object({
  id: uuid,
  event_id: uuid,
  revision_number: z.number().int(),
  input_signature: z.string(),
  created_at: z.string(),
  engine_version: z.string(),
  policy_version: z.string(),
  plan_context: z.unknown(),
  participants_snapshot: z.unknown(),
  menu: z.unknown(),
  policy: z.unknown(),
  yield_inputs: z.unknown(),
  estimate_output: z.unknown(),
  override_grams: nullableNumeric,
  override_note: z.string().nullable(),
});

const SELECT_REVISION = columnsOf(revisionColumnas);

/**
 * Arma la entrada congelada desde las cinco columnas en que vive repartida.
 *
 * Están separadas en la base porque cada una tiene un dueño distinto río
 * arriba (los participantes, el menú, la política del motor, los rendimientos y
 * el contexto del plan), y se vuelven a juntar acá, en un solo lugar, para que
 * la pantalla lea un objeto y no cinco.
 */
function armarEntrada(fila: z.infer<typeof revisionColumnas>): unknown {
  return {
    // `plan_context` es NOT NULL en la 0041; si aun así llegara vacío, el
    // esquema de abajo revienta por los campos que faltan en vez de dibujar un
    // evento sin fecha.
    ...(fila.plan_context as Record<string, unknown>),
    participants: fila.participants_snapshot,
    menu: fila.menu,
    policy: fila.policy,
    yieldInputs: fila.yield_inputs,
  };
}

function mapearRevision(fila: z.infer<typeof revisionColumnas>): Revision {
  const entrada = entradaEstimacionSchema.parse(armarEntrada(fila));
  const salida = salidaEstimacionSchema.parse(fila.estimate_output);
  return {
    id: fila.id,
    eventId: fila.event_id,
    numero: fila.revision_number,
    inputSignature: fila.input_signature,
    createdAt: fila.created_at,
    entrada,
    salida,
    overrideG: fila.override_grams,
    overrideNota: fila.override_note,
  };
}

/**
 * La revisión vigente: la última que se calculó.
 *
 * `null` significa que este evento todavía no tiene estimación — que NO es lo
 * mismo que una estimación de cero. La pantalla lo dice con esas palabras.
 */
export async function cargarRevisionVigente(
  db: Db,
  eventoId: string,
): Promise<Revision | null> {
  const { data, error } = await db
    .from("event_plan_revisions")
    .select(SELECT_REVISION)
    .eq("event_id", eventoId)
    .order("revision_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new DataAccessError("estimación del evento", error);
  if (data === null) return null;
  return mapearRevision(parseRow(revisionColumnas, data, "estimación del evento"));
}

/** Todas las revisiones, de la más nueva a la más vieja (§95: la historia queda). */
export async function cargarRevisiones(db: Db, eventoId: string): Promise<Revision[]> {
  const { data, error } = await db
    .from("event_plan_revisions")
    .select(SELECT_REVISION)
    .eq("event_id", eventoId)
    .order("revision_number", { ascending: false });
  if (error) throw new DataAccessError("historial de estimaciones", error);
  return parseRows(revisionColumnas, data, "historial de estimaciones").map(mapearRevision);
}
