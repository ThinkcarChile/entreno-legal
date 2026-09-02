"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { uuid } from "@/lib/supabase/rows";
import {
  entradaEstimacionSchema,
  salidaEstimacionSchema,
  type EntradaEstimacion,
} from "./contrato-estimacion";
import { estimarAsado } from "./motor";
import { cargarInsumosFisicos } from "./insumos";
import {
  AsistenciaDesconocida,
  ClaseDeItemDesconocida,
  congelarMenu,
  congelarParticipantes,
  normalizarEntrada,
} from "./revisiones";
import {
  cargarBloqueosDelMenu,
  cargarEvento,
  cargarMenu,
  cargarParticipantes,
} from "./queries";
import { MEAL_TYPES } from "@/domain/recipes/types";
import {
  APETITOS,
  ASISTENCIAS,
  CATEGORIAS_MENU,
  CONTEXTOS_COMIDA,
  EDADES_INFANTILES,
  EDAD_DEL_ATAJO,
  ESTADOS_EVENTO,
  NIVELES_ACOMPANAMIENTO,
  SOBRANTES_DESEADOS,
  TIPOS_EVENTO,
  TIPOS_ITEM_MENU,
} from "./vocabulario";

/**
 * Las escrituras de la superficie de eventos.
 *
 * REGLA DE ESTE ARCHIVO: EL ERROR DEL SERVIDOR SE MUESTRA TAL CUAL.
 *
 * Los mensajes que vienen de la base dicen QUÉ pasó —"el evento está
 * bloqueado", "no tienes permiso para editar el plan", "ese invitado ya está en
 * el evento"— y taparlos con un "algo salió mal" deja a la persona parada
 * frente a un muro sin saber qué apretar. Se muestran completos; lo único que
 * se agrega es el sujeto cuando el mensaje solo no dice de qué hablaba.
 *
 * Y una segunda regla, que es la que sostiene todo el sprint: NINGUNA de estas
 * acciones toca el inventario. Las compras del evento entran por los RPC de
 * recepción que ya existen y las sobras por los de lotes; un evento no abre una
 * segunda puerta a la despensa.
 */

export interface ResultadoAccion {
  ok: boolean;
  error?: string;
  message?: string;
}

async function cliente(): Promise<SupabaseClient> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/eventos");
  return supabase;
}

function refrescar(eventoId?: string) {
  revalidatePath("/eventos");
  if (eventoId) revalidatePath(`/eventos/${eventoId}`);
}

/**
 * El texto de un error de PostgREST, entero.
 *
 * `message` primero porque es el que escribieron las migraciones para que una
 * persona lo lea; `details` y `hint` se suman cuando existen porque muchas
 * veces son ellos los que dicen qué hacer.
 */
function textoDelError(error: { message: string; details?: string | null; hint?: string | null }): string {
  const partes = [error.message, error.details, error.hint].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return partes.join(" — ");
}

// ---------------------------------------------------------------------------
// El evento
// ---------------------------------------------------------------------------

const nuevoEventoSchema = z.object({
  householdId: uuid,
  titulo: z.string().trim().min(1).max(120),
  tipo: z.enum(TIPOS_EVENTO),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * QUÉ COMIDA DEL PLAN REEMPLAZA (H20). Opcional y sin valor por omisión: si
   * no viene, el evento nace SIN declarar la comida y no releva nada, que es
   * la verdad. Poner 'LUNCH' por si acaso relevaría el almuerzo de un asado de
   * la noche y dejaría a la familia sin comer ese día.
   */
  comida: z.enum(MEAL_TYPES).nullable().optional(),
});

/**
 * Crea el evento en BORRADOR.
 *
 * Nace en DRAFT y no en PLANNED a propósito: hasta que no tenga participantes y
 * menú no hay nada que planificar, y DRAFT es el único estado desde el que el
 * evento se puede borrar de verdad. Después de PLANNED la única salida es
 * cancelarlo, porque un evento con compras hechas no puede desaparecer.
 */
export async function crearEvento(entrada: unknown): Promise<ResultadoAccion & { id?: string }> {
  const validado = nuevoEventoSchema.safeParse(entrada);
  if (!validado.success) {
    return { ok: false, error: "Faltan datos del evento: revisa el título y la fecha." };
  }
  const supabase = await cliente();

  const { data, error } = await supabase
    .from("nutrition_events")
    .insert({
      household_id: validado.data.householdId,
      title: validado.data.titulo,
      event_type: validado.data.tipo,
      event_date: validado.data.fecha,
      // `undefined` no viaja a PostgREST: si el paso 1 no preguntó la comida,
      // la columna queda NULL y el tablero la pide antes de confirmar.
      meal_type: validado.data.comida ?? null,
      // Este armador no pregunta quién de la CASA come en el evento, así que el
      // evento nace sin saberlo. Y no saberlo no es "toda la familia": dejarlo
      // en el valor de siempre le relajaba los objetivos del día a los cuatro
      // integrantes por el solo hecho de haber creado un asado para invitados.
      // La marca la corrige sola la base en cuanto se agrega al primer
      // integrante (app.sync_event_nutrition_members).
      member_scope: "UNDECLARED",
      status: "DRAFT",
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: `No se pudo crear el evento — ${textoDelError(error)}` };

  refrescar();
  const id = z.object({ id: uuid }).safeParse(data);
  if (!id.success) return { ok: false, error: "El evento se creó pero la base no devolvió su id." };
  return { ok: true, id: id.data.id, message: "Evento creado." };
}

const configuracionSchema = z.object({
  eventoId: uuid,
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  titulo: z.string().trim().min(1).max(120).optional(),
  /**
   * La comida del plan que el evento reemplaza. Es la LLAVE del relevo
   * (`app.apply_event_meal_coverage` la compara contra `meal_assignments`), y
   * hasta este sprint ninguna ruta de la aplicación la escribía: todo evento
   * nacía con NULL, el relevo no se intentaba nunca y la compra salía doble.
   */
  comida: z.enum(MEAL_TYPES).nullable().optional(),
  enCasa: z.boolean().optional(),
  lugar: z.string().trim().max(200).nullable().optional(),
  /** "HH:MM". `null` cuando la persona no la sabe todavía — no se rellena. */
  horaDeServir: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  duracionHoras: z.number().positive().max(24).nullable().optional(),
  contextoComida: z.enum(CONTEXTOS_COMIDA).nullable().optional(),
  nivelAcompanamiento: z.enum(NIVELES_ACOMPANAMIENTO).nullable().optional(),
  sobranteDeseado: z.enum(SOBRANTES_DESEADOS).nullable().optional(),
  sobranteDeseadoG: z.number().nonnegative().max(100000).nullable().optional(),
  bufferSeguridadPct: z.number().min(0).max(50).nullable().optional(),
  presupuestoClp: z.number().int().nonnegative().nullable().optional(),
});

/** Guarda un paso del armador. Cada paso escribe solo lo suyo. */
export async function guardarConfiguracion(entrada: unknown): Promise<ResultadoAccion> {
  const validado = configuracionSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Ese valor no es válido para este campo." };
  const { eventoId, ...campos } = validado.data;
  const supabase = await cliente();

  const fila: Record<string, unknown> = {};
  if (campos.fecha !== undefined) fila.event_date = campos.fecha;
  if (campos.titulo !== undefined) fila.title = campos.titulo;
  if (campos.enCasa !== undefined) fila.location_kind = campos.enCasa ? "HOME" : "AWAY";
  if (campos.lugar !== undefined) fila.location_note = campos.lugar;
  if (campos.horaDeServir !== undefined) fila.serving_time = campos.horaDeServir;
  if (campos.duracionHoras !== undefined) fila.duration_hours = campos.duracionHoras;
  if (campos.comida !== undefined) fila.meal_type = campos.comida;
  if (campos.contextoComida !== undefined) fila.meal_context = campos.contextoComida;
  if (campos.nivelAcompanamiento !== undefined) fila.sides_level = campos.nivelAcompanamiento;
  if (campos.sobranteDeseado !== undefined) fila.desired_leftover_kind = campos.sobranteDeseado;
  if (campos.sobranteDeseadoG !== undefined) fila.desired_leftover_g = campos.sobranteDeseadoG;
  if (campos.bufferSeguridadPct !== undefined) fila.safety_buffer_pct = campos.bufferSeguridadPct;
  if (campos.presupuestoClp !== undefined) fila.budget_clp = campos.presupuestoClp;

  if (Object.keys(fila).length === 0) return { ok: true, message: "Nada que guardar." };

  const { error } = await supabase.from("nutrition_events").update(fila).eq("id", eventoId);
  if (error) return { ok: false, error: `No se pudo guardar — ${textoDelError(error)}` };

  refrescar(eventoId);
  return { ok: true, message: "Guardado." };
}

const cambioEstadoSchema = z.object({ eventoId: uuid, estado: z.enum(ESTADOS_EVENTO) });

export async function cambiarEstado(entrada: unknown): Promise<ResultadoAccion> {
  const validado = cambioEstadoSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Ese estado no existe." };
  const supabase = await cliente();

  const { error } = await supabase
    .from("nutrition_events")
    .update({ status: validado.data.estado })
    .eq("id", validado.data.eventoId);
  // El guard de transiciones vive en la base: si dice que no se puede pasar de
  // COMPLETED a PLANNED, ese mensaje es el que la persona tiene que leer.
  if (error) return { ok: false, error: textoDelError(error) };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Estado actualizado." };
}

// ---------------------------------------------------------------------------
// Participantes e invitados
// ---------------------------------------------------------------------------

const participanteMiembroSchema = z.object({ eventoId: uuid, memberId: uuid });

export async function agregarMiembro(entrada: unknown): Promise<ResultadoAccion> {
  const validado = participanteMiembroSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Falta el integrante." };
  const supabase = await cliente();

  const { error } = await supabase.from("event_participants").insert({
    event_id: validado.data.eventoId,
    participant_type: "HOUSEHOLD_MEMBER",
    member_id: validado.data.memberId,
    attendance_status: "CONFIRMED",
  });
  if (error) return { ok: false, error: `No se pudo agregar — ${textoDelError(error)}` };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Agregado al evento." };
}

const participanteInvitadoSchema = z.object({ eventoId: uuid, guestId: uuid });

export async function agregarInvitadoExistente(entrada: unknown): Promise<ResultadoAccion> {
  const validado = participanteInvitadoSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Falta el invitado." };
  const supabase = await cliente();

  const { error } = await supabase.from("event_participants").insert({
    event_id: validado.data.eventoId,
    participant_type: "GUEST",
    guest_id: validado.data.guestId,
    attendance_status: "INVITED",
  });
  if (error) return { ok: false, error: `No se pudo agregar — ${textoDelError(error)}` };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Invitado agregado." };
}

/**
 * El alta rápida de invitado: tres campos y listo.
 *
 * Es la operación más usada de toda la superficie —"ah, y viene el primo"— y si
 * pide un formulario la gente deja de anotar gente, que es peor que anotarla
 * incompleta. Por eso el nombre es opcional, el apetito es opcional, y las
 * restricciones NO SE PREGUNTAN acá.
 *
 * Que no se pregunten significa que quedan en NULL, y NULL es "no sabemos": el
 * motor lo cuenta como información faltante y la pantalla muestra "Sin
 * información". Lo que NO puede pasar —y por eso no hay un valor por omisión—
 * es que un invitado del que nadie preguntó nada aparezca como "sin
 * restricciones", que es una afirmación que nadie hizo.
 *
 * El atajo adulto/niño se traduce con `EDAD_DEL_ATAJO`, que está escrito y
 * documentado: "niño" es CHILD, y el mismo panel deja afinar a niño chico o
 * adolescente. La diferencia entre esos tres casi dobla la porción, así que no
 * puede quedar implícita.
 */
const invitadoRapidoSchema = z.object({
  eventoId: uuid,
  householdId: uuid,
  nombre: z.string().trim().max(80).nullable(),
  atajoEdad: z.enum(["ADULTO", "NINO"]),
  /** Solo se acepta si el atajo dijo "niño": afina cuál de los tres es. */
  edadFina: z.enum(["CHILD_SMALL", "CHILD", "TEEN"]).nullable(),
  apetito: z.enum(APETITOS),
  /** `true` cuando se agrega el día del evento porque llegó alguien más (§43). */
  esExtra: z.boolean(),
});

export async function agregarInvitadoRapido(entrada: unknown): Promise<ResultadoAccion> {
  const validado = invitadoRapidoSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Faltan datos del invitado." };
  const { eventoId, householdId, nombre, atajoEdad, edadFina, apetito, esExtra } = validado.data;
  const supabase = await cliente();

  const grupoEdad =
    atajoEdad === "NINO" && edadFina !== null && EDADES_INFANTILES.includes(edadFina)
      ? edadFina
      : EDAD_DEL_ATAJO[atajoEdad];

  const { data, error } = await supabase
    .from("guest_profiles")
    .insert({
      household_id: householdId,
      name: nombre === null || nombre.length === 0 ? null : nombre,
      age_group: grupoEdad,
      appetite: apetito,
      // Sin declaración: no sabemos. Ver el comentario largo de arriba.
      dietary_flags: null,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: `No se pudo crear el invitado — ${textoDelError(error)}` };

  const invitado = z.object({ id: uuid }).safeParse(data);
  if (!invitado.success) {
    return { ok: false, error: "El invitado se creó pero la base no devolvió su id." };
  }

  const { error: errorParticipante } = await supabase.from("event_participants").insert({
    event_id: eventoId,
    participant_type: "GUEST",
    guest_id: invitado.data.id,
    // Quien llega el día del evento ya llegó: no se marca "invitado".
    attendance_status: esExtra ? "ATTENDED" : "CONFIRMED",
    is_extra: esExtra,
  });
  if (errorParticipante) {
    return {
      ok: false,
      error: `El invitado quedó creado pero no se pudo sumar al evento — ${textoDelError(errorParticipante)}`,
    };
  }

  refrescar(eventoId);
  return { ok: true, message: esExtra ? "Sumado al evento." : "Invitado agregado." };
}

const quitarSchema = z.object({ eventoId: uuid, participanteId: uuid });

export async function quitarParticipante(entrada: unknown): Promise<ResultadoAccion> {
  const validado = quitarSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Falta el participante." };
  const supabase = await cliente();

  const { error } = await supabase
    .from("event_participants")
    .delete()
    .eq("id", validado.data.participanteId);
  if (error) return { ok: false, error: `No se pudo quitar — ${textoDelError(error)}` };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Ya no está en el evento." };
}

const apetitoSchema = z.object({
  eventoId: uuid,
  participanteId: uuid,
  apetito: z.enum(APETITOS).nullable(),
});

/**
 * El apetito SOLO para este evento.
 *
 * Escribe `appetite_override` y no toca la ficha del invitado: el §7 es
 * explícito en que un perfil no cambia por una comida. Que Juan haya comido
 * como campeón en un asado no lo convierte en "come harto" para siempre; eso lo
 * propone el aprendizaje, con varios eventos, y lo confirma una persona.
 */
export async function ajustarApetito(entrada: unknown): Promise<ResultadoAccion> {
  const validado = apetitoSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Ese apetito no existe." };
  const supabase = await cliente();

  const { error } = await supabase
    .from("event_participants")
    .update({ appetite_override: validado.data.apetito })
    .eq("id", validado.data.participanteId);
  if (error) return { ok: false, error: `No se pudo ajustar — ${textoDelError(error)}` };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Apetito ajustado para este evento." };
}

const asistenciaSchema = z.object({
  eventoId: uuid,
  participanteId: uuid,
  asistencia: z.enum(ASISTENCIAS),
});

/**
 * Marcar quién llegó y quién no (§42).
 *
 * Pasa por el RPC `record_event_attendance` y no por un `update` directo porque
 * la asistencia real es un hecho que se audita y que emite evento de dominio, y
 * porque marcarla el día del asado la hace normalmente quien está en la
 * parrilla —que puede tener permiso de cocina y no de editar el plan—. Esa
 * decisión de permisos vive en la base, no acá.
 *
 * Marcar asistencia NO reescribe la compra: lo que se compró se compró, y el
 * resumen después muestra la diferencia. Esa es toda la gracia.
 */
export async function marcarAsistencia(entrada: unknown): Promise<ResultadoAccion> {
  const validado = asistenciaSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Esa marca de asistencia no existe." };
  const supabase = await cliente();

  const { error } = await supabase.rpc("record_event_attendance", {
    p_participant_id: validado.data.participanteId,
    p_attendance_status: validado.data.asistencia,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Asistencia registrada." };
}

// ---------------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------------

const itemMenuSchema = z.object({
  eventoId: uuid,
  tipo: z.enum(TIPOS_ITEM_MENU),
  categoria: z.enum(CATEGORIAS_MENU).nullable(),
  nombre: z.string().trim().min(1).max(120),
  ingredientId: uuid.nullable(),
  productId: uuid.nullable(),
  porcentaje: z.number().min(0).max(100).nullable(),
});

export async function agregarItemMenu(entrada: unknown): Promise<ResultadoAccion> {
  const validado = itemMenuSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Faltan datos de ese item del menú." };
  const supabase = await cliente();

  const { error } = await supabase.from("event_menu_items").insert({
    event_id: validado.data.eventoId,
    kind: validado.data.tipo,
    category: validado.data.categoria,
    display_name: validado.data.nombre,
    ingredient_id: validado.data.ingredientId,
    product_id: validado.data.productId,
    distribution_pct: validado.data.porcentaje,
  });
  if (error) return { ok: false, error: `No se pudo agregar al menú — ${textoDelError(error)}` };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Agregado al menú." };
}

const quitarItemSchema = z.object({ eventoId: uuid, itemId: uuid });

export async function quitarItemMenu(entrada: unknown): Promise<ResultadoAccion> {
  const validado = quitarItemSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Falta el item." };
  const supabase = await cliente();

  const { error } = await supabase.from("event_menu_items").delete().eq("id", validado.data.itemId);
  if (error) return { ok: false, error: `No se pudo quitar — ${textoDelError(error)}` };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Fuera del menú." };
}

const distribucionSchema = z.object({
  eventoId: uuid,
  /** `porcentaje: null` en TODAS las carnes = modo AUTO (§21). */
  reparto: z.array(z.object({ itemId: uuid, porcentaje: z.number().min(0).max(100).nullable() })),
});

/**
 * La distribución por corte.
 *
 * O están todas en AUTO, o los porcentajes suman 100. Un reparto que suma 87
 * significa que trece por ciento de la carne no se compra y nadie lo dijo; y
 * uno que suma 140 significa comprar cuarenta por ciento de más. Se rechaza acá
 * antes de guardar, con el número que falta escrito en el mensaje.
 */
export async function guardarDistribucion(entrada: unknown): Promise<ResultadoAccion> {
  const validado = distribucionSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Ese reparto no es válido." };
  const { eventoId, reparto } = validado.data;

  const conValor = reparto.filter((r) => r.porcentaje !== null);
  if (conValor.length > 0 && conValor.length !== reparto.length) {
    return {
      ok: false,
      error: "O dejas todas las carnes en automático, o le pones porcentaje a todas.",
    };
  }
  if (conValor.length > 0) {
    const suma = conValor.reduce((acc, r) => acc + (r.porcentaje as number), 0);
    // Un punto de tolerancia por el redondeo de los decimales que escribe la
    // persona (33,3 + 33,3 + 33,3 = 99,9 y eso es un reparto legítimo).
    if (Math.abs(suma - 100) > 1) {
      return {
        ok: false,
        error: `Los porcentajes suman ${suma.toLocaleString("es-CL")} % y tienen que sumar 100 %.`,
      };
    }
  }

  const supabase = await cliente();
  for (const linea of reparto) {
    const { error } = await supabase
      .from("event_menu_items")
      .update({ distribution_pct: linea.porcentaje })
      .eq("id", linea.itemId);
    if (error) return { ok: false, error: `No se pudo guardar el reparto — ${textoDelError(error)}` };
  }

  refrescar(eventoId);
  return { ok: true, message: "Reparto guardado." };
}

// ---------------------------------------------------------------------------
// La estimación: calcular y CONGELAR
// ---------------------------------------------------------------------------

/**
 * Arma la entrada del motor desde la base.
 *
 * Es una función aparte porque la usan dos caminos —calcular y comparar contra
 * la revisión anterior— y porque así la firma se calcula siempre sobre lo mismo.
 */
async function armarEntrada(
  supabase: SupabaseClient,
  eventoId: string,
): Promise<{ ok: true; entrada: EntradaEstimacion } | { ok: false; error: string }> {
  const evento = await cargarEvento(supabase, eventoId);
  if (evento === null) return { ok: false, error: "Ese evento no existe o no es de tu hogar." };

  const [participantes, menu, bloqueos] = await Promise.all([
    cargarParticipantes(supabase, eventoId, evento.fecha),
    cargarMenu(supabase, eventoId),
    // Lo que la casa ya sabe que alguien no puede comer. Va al motor, no a la
    // pantalla: si esto no viajara, un integrante con alergia registrada
    // recibiría su porción del corte que no puede comer.
    cargarBloqueosDelMenu(supabase, eventoId),
  ]);

  if (participantes.length === 0) {
    return { ok: false, error: "Todavía no hay nadie en el evento: no hay para cuántos calcular." };
  }
  if (menu.filter((i) => i.tipo === "MEAT").length === 0) {
    return { ok: false, error: "Todavía no hay carnes en el menú: no hay qué repartir." };
  }

  // Congelar puede negarse: un valor de enum que la app no conoce —una marca de
  // asistencia, una clase de item— no se adivina. El `catch` no traga nada:
  // traduce ESOS dos casos a un mensaje y deja pasar cualquier otro error.
  let participantesCongelados;
  let menuCongelado;
  try {
    participantesCongelados = congelarParticipantes(participantes, bloqueos);
    menuCongelado = congelarMenu(menu);
  } catch (e) {
    if (e instanceof AsistenciaDesconocida || e instanceof ClaseDeItemDesconocida) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  const entrada = entradaEstimacionSchema.safeParse({
    eventDate: evento.fecha,
    durationHours: evento.duracionHoras,
    mealContext: evento.contextoComida,
    sidesLevel: evento.nivelAcompanamiento,
    desiredLeftover: {
      kind: evento.sobranteDeseado,
      customG: evento.sobranteDeseadoG,
    },
    safetyBufferPct: evento.bufferSeguridadPct,
    participants: participantesCongelados,
    menu: menuCongelado,
    // La política y los rendimientos se completan al calcular, con lo que el
    // motor efectivamente usó. Acá viajan vacíos porque todavía no se sabe qué
    // factores se van a aplicar, y poner números en este lugar sería sembrar
    // factores sin fuente.
    yieldInputs: {},
    policy: {},
  });
  if (!entrada.success) {
    return {
      ok: false,
      error: `Los datos del evento no arman una estimación válida: ${entrada.error.issues[0]?.message ?? "revisa participantes y menú"}.`,
    };
  }
  return { ok: true, entrada: entrada.data };
}

const calcularSchema = z.object({ eventoId: uuid });

/**
 * CALCULAR: estimar y congelar la revisión.
 *
 * La idempotencia (§93) descansa en UN solo árbitro: el índice único
 * `(event_id, input_signature)` de la base. Leer antes de escribir no sirve
 * contra dos personas apretando "calcular" al mismo tiempo — las dos leen "no
 * existe" y las dos escriben —, así que acá no se intenta: se calcula, se manda
 * al RPC y el RPC devuelve la revisión que quedó, sea la nueva o la que ya
 * estaba.
 *
 * Calcular es puro y barato, así que recalcular para descubrir que no cambió
 * nada no cuesta nada. Cambió cualquier cosa —un invitado más, otro corte, otro
 * margen, un factor de rendimiento distinto— y la firma cambia: revisión NUEVA.
 * La vieja queda. Cambiar la política del motor mañana no reescribe ninguna de
 * las dos.
 */
export async function calcularEstimacion(
  peticion: unknown,
): Promise<ResultadoAccion & { revisionId?: string }> {
  const validado = calcularSchema.safeParse(peticion);
  if (!validado.success) return { ok: false, error: "Falta el evento." };
  const eventoId = validado.data.eventoId;
  const supabase = await cliente();

  const armada = await armarEntrada(supabase, eventoId);
  if (!armada.ok) return { ok: false, error: armada.error };

  // Ordenada ANTES de calcular: la firma del motor es sensible al orden y
  // PostgREST no promete ninguno. Sin esto, dos consultas con el mismo
  // contenido en distinto orden crearían dos revisiones del mismo plan.
  const entrada = normalizarEntrada(armada.entrada);

  const { data: hogar, error: errorHogar } = await supabase
    .from("nutrition_events")
    .select("household_id")
    .eq("id", eventoId)
    .maybeSingle();
  if (errorHogar) throw new DataAccessError("hogar del evento", errorHogar);
  const hogarId = z.object({ household_id: uuid }).safeParse(hogar);
  if (!hogarId.success) return { ok: false, error: "Ese evento no existe o no es de tu hogar." };

  // El menú viaja al cargador porque los cortes deciden QUÉ se lee de la
  // despensa y de las tablas de rendimiento: traerse el catálogo entero para un
  // asado de dos cortes es una consulta que crece con la biblioteca.
  const insumos = await cargarInsumosFisicos(
    supabase,
    hogarId.data.household_id,
    entrada.eventDate,
    entrada.menu,
  );
  if (!insumos.ok) return { ok: false, error: insumos.motivo };

  // El contexto se arma campo por campo y no con un `rest`: así la columna
  // `plan_context` guarda exactamente los seis datos del armador, y si mañana
  // la entrada gana un campo nuevo no se cuela solo dentro del contexto.
  const { participants, menu } = entrada;
  const contexto = {
    eventDate: entrada.eventDate,
    durationHours: entrada.durationHours,
    mealContext: entrada.mealContext,
    sidesLevel: entrada.sidesLevel,
    desiredLeftover: entrada.desiredLeftover,
    safetyBufferPct: entrada.safetyBufferPct,
  };

  const resultado = estimarAsado({
    contexto,
    participantes: participants,
    menu,
    insumos: insumos.insumos,
  });
  if (!resultado.ok) return { ok: false, error: resultado.motivo };

  // La salida del motor se valida antes de congelarla: una revisión con una
  // forma distinta a la del contrato es una revisión que después nadie puede
  // leer, y las revisiones no se corrigen.
  const salida = salidaEstimacionSchema.safeParse(resultado.salida);
  if (!salida.success) {
    return {
      ok: false,
      error: `El motor devolvió una estimación con una forma que no se puede guardar: ${salida.error.issues[0]?.path.join(".")} ${salida.error.issues[0]?.message}`,
    };
  }

  // LA FIRMA ES LA DEL MOTOR. Cubre todo lo que el motor consumió —incluidos
  // los rendimientos y el inventario—, así que un factor de corte que cambió
  // produce una revisión nueva. Una firma calculada acá, sobre lo que la
  // pantalla ve, habría dicho "no cambió nada".
  //
  // Y el árbitro final es la base: `save_event_estimate_revision` resuelve por
  // el índice único `(event_id, input_signature)`. Leer antes de escribir no
  // sirve contra dos personas apretando el botón al mismo tiempo — las dos leen
  // "no existe" y las dos escriben.
  const { data, error } = await supabase.rpc("save_event_estimate_revision", {
    p_event_id: eventoId,
    p_input_signature: salida.data.inputSignature,
    p_engine_version: salida.data.engineVersion,
    p_policy_version: salida.data.policyVersion,
    p_plan_context: contexto,
    p_participants_snapshot: participants,
    p_menu: menu,
    p_policy: resultado.politica,
    p_yield_inputs: insumos.insumos,
    p_estimate_output: salida.data,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  refrescar(eventoId);
  const id = z.string().uuid().safeParse(data);
  return {
    ok: true,
    revisionId: id.success ? id.data : undefined,
    message: "Estimación calculada y guardada.",
  };
}

const overrideSchema = z.object({
  eventoId: uuid,
  revisionId: uuid,
  /** `null` vuelve a la recomendación del motor. */
  gramos: z.number().nonnegative().max(200000).nullable(),
  nota: z.string().trim().max(280).nullable(),
});

/**
 * "Yo quiero comprar otra cantidad" (§79-80).
 *
 * Se guarda al lado de la recomendación, nunca encima: la pantalla sigue
 * mostrando RECOMENDADO y TU PLAN, y el aprendizaje después puede distinguir
 * entre "el motor estimó de más" y "la familia decidió comprar más". Si se
 * pisara el número del motor, esa diferencia se perdería para siempre y el
 * sistema aprendería del ajuste manual como si fuera un error suyo.
 *
 * La nota es libre y opcional —"mi familia come mucho", "quiero que sobre para
 * el domingo"— y no cambia ninguna política global.
 *
 * OJO: hoy la 0041 protege `event_plan_revisions` contra TODO update (trigger
 * `event_plan_revisions_append_only`), así que esta escritura rebota con el
 * mensaje de la base. Está escrita igual y el mensaje se muestra entero, sin
 * disfrazarlo: la salida es que la migración deje pasar el cambio cuando SOLO
 * tocan `override_grams`/`override_note` —que no son parte de la estimación,
 * sino la decisión de la persona al lado de ella— o que publique un RPC para
 * eso.
 */
export async function guardarOverride(entrada: unknown): Promise<ResultadoAccion> {
  const validado = overrideSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Esa cantidad no es válida." };
  const supabase = await cliente();

  const { error } = await supabase
    .from("event_plan_revisions")
    .update({
      override_grams: validado.data.gramos,
      override_note: validado.data.nota,
    })
    .eq("id", validado.data.revisionId);
  if (error) return { ok: false, error: `No se pudo guardar tu cantidad — ${textoDelError(error)}` };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Guardamos tu cantidad." };
}
