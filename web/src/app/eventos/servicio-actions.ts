"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { uuid } from "@/lib/supabase/rows";
import { loadSafetyRules } from "@/app/prep/queries";
import { diaCivilDelHogar } from "@/app/comi/historia-queries";
import { assessStorage } from "@/domain/prep/safety";
import type { LotFacts } from "@/domain/prep/types";

/**
 * Las escrituras de los HECHOS del evento: servir, guardar la sobra, declarar
 * el balance y anotar cuánto comió cada comensal.
 *
 * LAS TRES REGLAS DE ESTE ARCHIVO:
 *
 *  1. NINGUNA de estas acciones toca el inventario por su cuenta. Todas pasan
 *     por un RPC que escribe el libro mayor append-only; el descuento físico
 *     ocurre UNA vez, a nivel del evento, y cuelga del renglón servido.
 *
 *  2. El error del servidor se muestra ENTERO. Los mensajes de la 0041 dicen
 *     qué pasó y qué hacer ("no puede volver más comida de la que salió", "te
 *     falta el permiso para cocinar"); taparlos con "algo salió mal" deja a
 *     alguien parado frente a la parrilla sin saber qué apretar.
 *
 *  3. Ninguna fecha de conservación se inventa. La sobra que vuelve al
 *     refrigerador nace SIN fecha; el motor `storage-safety/1.0.0` la calcula
 *     sólo si hay una regla con fuente que calce, y si no la hay, el lote queda
 *     rotulado para revisión. Eso es §57 y §21 a la vez.
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

function refrescar(eventoId: string) {
  revalidatePath(`/eventos/${eventoId}`);
  revalidatePath(`/eventos/${eventoId}/dia`);
  revalidatePath(`/eventos/${eventoId}/resumen`);
  revalidatePath("/despensa");
}

function textoDelError(error: {
  message: string;
  details?: string | null;
  hint?: string | null;
}): string {
  const partes = [error.message, error.details, error.hint].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return partes.join(" — ");
}

/** Gramos: número finito y positivo. Un `NaN` que llegue del formulario rebota acá. */
const gramos = z
  .number()
  .positive()
  .refine((n) => Number.isFinite(n), "esa cantidad no es un número");

// ---------------------------------------------------------------------------
// Servir
// ---------------------------------------------------------------------------

const servirSchema = z.object({
  eventoId: uuid,
  itemMenuId: uuid.nullable(),
  ingredientId: uuid.nullable(),
  etiqueta: z.string().trim().min(1).max(160),
  cantidad: gramos,
  base: z.enum(["COOKED", "RAW"]),
  tanda: z.number().int().positive().nullable(),
  /**
   * Clave del INTENTO, no del contenido: el mismo botón apretado dos veces
   * sirve una vez, y dos fuentes iguales servidas de verdad son dos renglones.
   * La compone la pantalla (una por intento, se suelta cuando el servidor
   * confirmó) y el servidor la ancla al evento. `null` = sin idempotencia.
   */
  clave: z.string().trim().min(1).max(120).nullable(),
});

export interface ResultadoServido extends ResultadoAccion {
  renglonId?: string;
  /** Cuánto de lo servido NO salió de un lote registrado. */
  faltante?: number;
  /** El servidor reconoció este intento y NO escribió nada nuevo. */
  repetido?: boolean;
}

/**
 * "Salieron 1,4 kg de lomo a la mesa."
 *
 * El faltante que devuelve el RPC no es un error: significa que esa carne no
 * salió de un lote conocido —se compró suelta, la trajo alguien, nadie la
 * registró—. Se informa tal cual, porque la alternativa (redondearlo a cero)
 * haría creer que la despensa está más vacía de lo que está.
 */
export async function servirEnElEvento(entrada: unknown): Promise<ResultadoServido> {
  const validado = servirSchema.safeParse(entrada);
  if (!validado.success) {
    return { ok: false, error: "Faltan datos para anotar lo que se sirvió (qué y cuánto)." };
  }
  const supabase = await cliente();
  const v = validado.data;

  const { data, error } = await supabase.rpc("serve_event_item", {
    p_event_id: v.eventoId,
    p_label: v.etiqueta,
    p_quantity: v.cantidad,
    p_unit: "G",
    p_weight_basis: v.base,
    p_menu_item_id: v.itemMenuId,
    p_ingredient_id: v.ingredientId,
    p_product_id: null,
    p_batch_number: v.tanda,
    p_dedupe_key: v.clave,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  const salida = z
    .object({
      item_id: uuid,
      served: z.coerce.number(),
      deducted: z.coerce.number(),
      shortfall: z.coerce.number(),
      repetido: z.boolean(),
    })
    .safeParse(data);
  if (!salida.success) {
    return { ok: false, error: "El servido se guardó, pero la respuesta llegó en un formato que no reconozco." };
  }

  refrescar(v.eventoId);
  const faltante = salida.data.shortfall;
  // `repetido` NO se descarta: decir "anotado y descontado" cuando el servidor
  // reconoció el intento y no escribió nada haría creer que salieron dos
  // fuentes cuando salió una.
  if (salida.data.repetido) {
    return {
      ok: true,
      renglonId: salida.data.item_id,
      faltante,
      repetido: true,
      message: "Esto ya estaba anotado: se guardó una sola vez y no se volvió a descontar.",
    };
  }
  return {
    ok: true,
    renglonId: salida.data.item_id,
    faltante,
    repetido: false,
    message:
      faltante > 0
        ? `Anotado. ${faltante} g de lo que serviste no salieron de un lote registrado: la despensa no los tenía anotados.`
        : "Anotado y descontado de la despensa.",
  };
}

// ---------------------------------------------------------------------------
// La sobra que vuelve
// ---------------------------------------------------------------------------

const sobraSchema = z.object({
  eventoId: uuid,
  renglonId: uuid,
  cantidad: gramos,
  etiqueta: z.string().trim().min(1).max(200).nullable(),
  ubicacionId: uuid.nullable(),
  /**
   * §58: "¿quieres usar estas sobras en la planificación?". Es una INTENCIÓN
   * sobre el lote (`intended_use_date`, 0015) y no una escritura en la semana:
   * la comida del martes no se reemplaza sola porque alguien guardó carne el
   * sábado. `null` = déjala en el inventario y ya.
   */
  usarEl: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /**
   * Clave del INTENTO. Dos táperes de 800 g del mismo renglón son DOS sobras;
   * lo único que esta clave colapsa es el mismo botón apretado dos veces.
   */
  clave: z.string().trim().min(1).max(120).nullable(),
});

export interface ResultadoSobra extends ResultadoAccion {
  loteId?: string;
  /** Qué dijo el motor de conservación. Nunca una fecha inventada. */
  seguridad?: { veredicto: string; hasta: string | null; motivo: string | null };
}

/**
 * "Guardé 800 g del lomo."
 *
 * Dos pasos y en este orden: primero el lote (que es el hecho físico y está
 * topado por lo que ese renglón sirvió), después el veredicto de conservación.
 * Si el motor no encuentra regla con fuente, el lote se queda SIN fecha y la
 * pantalla lo dice: una sobra sin fecha es un problema conocido; una sobra con
 * fecha inventada es un problema que nadie ve.
 */
export async function guardarSobra(entrada: unknown): Promise<ResultadoSobra> {
  const validado = sobraSchema.safeParse(entrada);
  if (!validado.success) {
    return { ok: false, error: "Falta decir de qué renglón es la sobra y cuántos gramos son." };
  }
  const supabase = await cliente();
  const v = validado.data;

  const { data, error } = await supabase.rpc("save_event_leftover", {
    p_serving_item_id: v.renglonId,
    p_quantity: v.cantidad,
    p_location_id: v.ubicacionId,
    p_label: v.etiqueta,
    p_intended_use_date: v.usarEl,
    p_dedupe_key: v.clave,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  const salida = z.object({ lot_id: uuid, repetido: z.boolean() }).safeParse(data);
  if (!salida.success) {
    return { ok: false, error: "La sobra se guardó, pero la respuesta llegó en un formato que no reconozco." };
  }
  const loteId = salida.data.lot_id;

  // La sobra cambió lo que la pantalla del día tiene que mostrar (cuánto queda
  // por guardar de esa fuente), así que se revalida apenas el RPC contestó y no
  // en cada uno de los seis retornos de más abajo.
  refrescar(v.eventoId);

  // REINTENTO RECONOCIDO: no se guardó nada nuevo, y por eso el camino se corta
  // ACÁ. Seguir de largo volvería a correr el motor de conservación con
  // `storedSince = hoy` sobre un lote que entró antes, corriéndole hacia
  // adelante la fecha de consumo de comida que lleva días en el refrigerador.
  if (salida.data.repetido) {
    return {
      ok: true,
      loteId,
      message:
        "Esa sobra ya estaba guardada: no se creó un lote nuevo ni se le movió la fecha de consumo.",
    };
  }

  // El veredicto de conservación, con el motor de siempre. Si acá se cae algo,
  // el lote YA existe y eso está bien: la comida está en el refrigerador aunque
  // el sistema no sepa hasta cuándo dura.
  const { data: lote, error: errorLote } = await supabase
    .from("inventory_lots")
    .select(
      "id, ingredient_id, processing_state, temperature_state, vacuum_sealed, household_id, ingredients(category_id)",
    )
    .eq("id", loteId)
    .maybeSingle();
  if (errorLote || lote === null) {
    return {
      ok: true,
      loteId,
      message:
        "Sobra guardada. No pude leer el lote para calcular hasta cuándo dura: revísalo en la despensa.",
    };
  }

  const fila = z
    .object({
      household_id: uuid,
      ingredient_id: uuid.nullable(),
      processing_state: z.string(),
      temperature_state: z.string(),
      vacuum_sealed: z.boolean(),
      ingredients: z
        .union([
          z.object({ category_id: uuid.nullable() }),
          z.array(z.object({ category_id: uuid.nullable() })),
          z.null(),
        ])
        .optional(),
    })
    .safeParse(lote);
  if (!fila.success) {
    return { ok: true, loteId, message: "Sobra guardada. Revisa su conservación en la despensa." };
  }

  const embebido = Array.isArray(fila.data.ingredients)
    ? fila.data.ingredients[0]
    : fila.data.ingredients;

  const reglas = await loadSafetyRules(supabase, fila.data.household_id);
  // El día CIVIL DEL HOGAR, no el del servidor: a las 22:30 de Santiago la
  // sobra se guarda con la fecha de hoy y no con la de mañana en UTC.
  const { hoy } = await diaCivilDelHogar(supabase, fila.data.household_id, new Date());

  const hechos: LotFacts = {
    ingredientId: fila.data.ingredient_id,
    categoryId: embebido === null || embebido === undefined ? null : embebido.category_id,
    processingState: fila.data.processing_state as LotFacts["processingState"],
    temperatureState: fila.data.temperature_state as LotFacts["temperatureState"],
    vacuumSealed: fila.data.vacuum_sealed,
    // La sobra empieza a contar HOY: es el instante en que entró al
    // refrigerador, y es lo único que se puede afirmar de ella.
    storedSince: hoy,
  };

  const veredicto = assessStorage(hechos, reglas, hoy);

  if (
    (veredicto.verdict === "SAFE" || veredicto.verdict === "USE_SOON") &&
    veredicto.safeUseBy !== null
  ) {
    // `set_lot_safety` EXIGE la regla fuente junto con la fecha: sin fuente no
    // hay fecha, ni siquiera pasando por acá.
    const { error: errorFecha } = await supabase.rpc("set_lot_safety", {
      p_lot_id: loteId,
      p_use_by: veredicto.safeUseBy,
      p_basis: veredicto.source,
    });
    if (errorFecha) {
      return {
        ok: true,
        loteId,
        seguridad: { veredicto: veredicto.verdict, hasta: null, motivo: textoDelError(errorFecha) },
        message: "Sobra guardada. No se pudo escribir la fecha de consumo: revísala en la despensa.",
      };
    }
    return {
      ok: true,
      loteId,
      seguridad: {
        veredicto: veredicto.verdict,
        hasta: veredicto.safeUseBy,
        motivo: veredicto.source,
      },
      message: `Sobra guardada. Según la regla usada, consúmela hasta el ${veredicto.safeUseBy}.`,
    };
  }

  return {
    ok: true,
    loteId,
    seguridad: {
      veredicto: veredicto.verdict,
      hasta: null,
      motivo:
        veredicto.verdict === "SAFETY_REVIEW_REQUIRED" ? veredicto.reason : veredicto.source,
    },
    message:
      "Sobra guardada SIN fecha de consumo: no hay una regla validada que calce con este alimento. Revísala antes de usarla.",
  };
}

// ---------------------------------------------------------------------------
// Lo que se botó, y el renglón mal anotado
// ---------------------------------------------------------------------------

const botarSchema = z.object({
  eventoId: uuid,
  renglonId: uuid,
  cantidad: gramos,
  motivo: z.string().trim().min(1).max(200).nullable(),
  clave: z.string().trim().min(1).max(120).nullable(),
});

/**
 * "De esa fuente se botaron 300 g."
 *
 * Existe porque su ausencia no dejaba la merma en desconocido: la dejaba en
 * CERO. `renglon.botado` se mostraba como un hecho medido y decidía cuánto más
 * te deja guardar la pantalla, cuando en realidad nadie había medido nada.
 *
 * No vuelve a descontar del lote —esos gramos ya salieron al servirse— pero sí
 * gasta el saldo de esa fuente: lo que está en la basura no puede volver
 * también al refrigerador.
 */
export async function botarDelEvento(entrada: unknown): Promise<ResultadoAccion> {
  const validado = botarSchema.safeParse(entrada);
  if (!validado.success) {
    return { ok: false, error: "Falta decir de qué fuente y cuántos gramos se botaron." };
  }
  const supabase = await cliente();
  const v = validado.data;

  const { data, error } = await supabase.rpc("discard_event_serving", {
    p_serving_item_id: v.renglonId,
    p_quantity: v.cantidad,
    p_reason: v.motivo,
    p_dedupe_key: v.clave,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  const salida = z.object({ repetido: z.boolean() }).safeParse(data);
  if (!salida.success) {
    return {
      ok: false,
      error: "La merma se anotó, pero la respuesta llegó en un formato que no reconozco.",
    };
  }

  refrescar(v.eventoId);
  return {
    ok: true,
    message: salida.data.repetido
      ? "Esa merma ya estaba anotada: no se contó dos veces."
      : "Anotado como botado. No se descuenta de nuevo de la despensa: esos gramos ya habían salido al servir.",
  };
}

const anularSchema = z.object({
  eventoId: uuid,
  renglonId: uuid,
  motivo: z.string().trim().min(1).max(200),
});

/**
 * "Ese servido está mal: no fue así."
 *
 * Devuelve al lote, con un ajuste de despensa que dice por qué, los gramos que
 * el libro mayor le había sacado a ese renglón. El motivo es OBLIGATORIO y el
 * mensaje del servidor sube entero: si la fuente ya tiene sobra guardada o
 * merma declarada, el RPC explica por qué no se puede anular y qué hacer en su
 * lugar, y taparlo con "algo salió mal" dejaría a alguien sin salida.
 */
export async function anularServido(entrada: unknown): Promise<ResultadoAccion> {
  const validado = anularSchema.safeParse(entrada);
  if (!validado.success) {
    return { ok: false, error: "Para anular un servido hay que decir cuál es y por qué." };
  }
  const supabase = await cliente();
  const v = validado.data;

  const { data, error } = await supabase.rpc("void_event_serving_item", {
    p_serving_item_id: v.renglonId,
    p_reason: v.motivo,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  const salida = z.object({ devuelto_al_lote: z.coerce.number() }).safeParse(data);
  if (!salida.success) {
    return {
      ok: false,
      error: "El servido se anuló, pero la respuesta llegó en un formato que no reconozco.",
    };
  }

  refrescar(v.eventoId);
  const devuelto = salida.data.devuelto_al_lote;
  return {
    ok: true,
    message:
      devuelto > 0
        ? `Servido anulado. Volvieron ${devuelto} g a los lotes de los que habían salido, con el motivo anotado.`
        : "Servido anulado. No había gramos que devolver: esa fuente no salió de ningún lote registrado.",
  };
}

// ---------------------------------------------------------------------------
// El balance de masa declarado
// ---------------------------------------------------------------------------

/** Cada destino es opcional. `null` = nadie lo midió, y así se guarda. */
const opcional = z
  .number()
  .min(0)
  .refine((n) => Number.isFinite(n), "ese número no es un número")
  .nullable();

const balanceSchema = z.object({
  eventoId: uuid,
  itemMenuId: uuid.nullable(),
  etiqueta: z.string().trim().min(1).max(200),
  crudoQueEntro: opcional,
  servido: opcional,
  sobraComestible: opcional,
  mermaDePlato: opcional,
  mermaDeLimpieza: opcional,
  hueso: opcional,
  echadoAPerder: opcional,
});

/**
 * "De este corte entraron 5 kg crudos, salieron 3,55 kg a la mesa y quedaron
 * 350 g."
 *
 * Lo que NO se sabe se manda como `null` y se guarda como `null`. Un cero acá
 * significa "medí y no había"; el vacío significa "nadie midió", y el resumen
 * los muestra distinto porque llevan a decisiones distintas.
 */
export async function registrarBalance(entrada: unknown): Promise<ResultadoAccion> {
  const validado = balanceSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Falta decir de qué corte es este balance." };
  const supabase = await cliente();
  const v = validado.data;

  const { error } = await supabase.rpc("record_event_consumption", {
    p_event_id: v.eventoId,
    p_label: v.etiqueta,
    p_menu_item_id: v.itemMenuId,
    p_ingredient_id: null,
    p_product_id: null,
    p_unit: "G",
    p_raw_input: v.crudoQueEntro,
    p_served: v.servido,
    p_consumed_min: null,
    p_consumed_max: null,
    p_edible_leftover: v.sobraComestible,
    p_plate_waste: v.mermaDePlato,
    p_trim_waste: v.mermaDeLimpieza,
    p_bone_discard: v.hueso,
    p_spoiled: v.echadoAPerder,
    p_confidence: "LOW",
    p_reasons: [],
  });
  if (error) return { ok: false, error: textoDelError(error) };

  refrescar(v.eventoId);
  return { ok: true, message: "Balance anotado." };
}

// ---------------------------------------------------------------------------
// Cuánto comió cada comensal (el único hecho del §52)
// ---------------------------------------------------------------------------

const observacionSchema = z.object({
  eventoId: uuid,
  participanteId: uuid,
  extension: z.enum(["ATE_LITTLE", "ATE_NORMAL", "ATE_A_LOT"]),
  nota: z.string().trim().max(500).nullable(),
});

/**
 * "Juan comió harto."
 *
 * ORDINAL Y A MANO, y de ahí no se mueve. Es el único hecho del que puede salir
 * la sugerencia de apetito del §52: el total del asado dividido entre los
 * asistentes NO es un dato de nadie, y si esta acción no se usa, la sugerencia
 * simplemente no aparece. Sin hecho no hay aprendizaje.
 */
export async function observarComensal(entrada: unknown): Promise<ResultadoAccion> {
  const validado = observacionSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Esa observación no existe." };
  const supabase = await cliente();

  const { error } = await supabase.rpc("record_event_guest_observation", {
    p_participant_id: validado.data.participanteId,
    p_intake_extent: validado.data.extension,
    p_estimated_serving_g: null,
    p_note: validado.data.nota,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  refrescar(validado.data.eventoId);
  return { ok: true, message: "Anotado." };
}

// ---------------------------------------------------------------------------
// El FoodLog de un integrante que sí quiere seguimiento (§46, §49)
// ---------------------------------------------------------------------------

const miPorcionSchema = z.object({
  eventoId: uuid,
  memberId: uuid,
  etiqueta: z.string().trim().min(1).max(160),
  extension: z.enum(["ALL", "MOST", "HALF", "LITTLE", "NONE", "UNKNOWN"]),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// SIN `export`: este archivo es "use server" y Next solo deja exportar de ahi
// funciones async — todo lo exportado se vuelve un punto de entrada llamable
// desde el navegador, y una constante no puede serlo. El build entero moria
// con "Only async functions are allowed to be exported in a use server file".
// Los `interface` y `type` que si se exportan mas arriba no molestan porque se
// borran al compilar; esto no. Y no hace falta exportarla: se usa dos veces,
// las dos en este mismo archivo.
const EVENT_PORTION_ESTIMATE_VERSION = "event-portion-estimate/1.0.0";

/**
 * Un integrante del hogar declara lo que comió en el asado.
 *
 * VA POR EL EJE DEL SPRINT 12 Y SIN EFECTO FÍSICO. `log_intake_off_plan`
 * escribe una declaración con `affects_inventory = false`: el descuento ya
 * ocurrió UNA vez cuando la fuente salió a la mesa, y volver a descontarlo acá
 * sería cobrar dos veces la misma carne (§46, demo K).
 *
 * Y la cantidad va SIN declarar (`quantity_is_declared: false`) con la
 * extensión que la persona eligió: nadie pesó su plato en el asado. El motor
 * adaptativo recibe eso con su confianza propia y no como un dato exacto
 * (§60) — sin segundo motor de compensación.
 */
export async function declararMiPorcionDelEvento(entrada: unknown): Promise<ResultadoAccion> {
  const validado = miPorcionSchema.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Falta decir quién y cuánto comió." };
  const supabase = await cliente();
  const v = validado.data;

  // ¿YA HABÍA DECLARADO? Esto NO es la defensa contra el doble clic —esa es la
  // clave de idempotencia del RPC, que es el único árbitro válido contra dos
  // pestañas a la vez—. Es para no mentirle a alguien que viene a CORREGIR: el
  // RPC devolvería en silencio la declaración vieja y la pantalla diría
  // "guardado" sin haber guardado nada. Corregir una declaración tiene su
  // propio camino en "Lo que comí" (correct_intake_log, 0038), y ese camino
  // deja la versión anterior a la vista.
  const { data: previas, error: errorPrevias } = await supabase
    .from("consumption_logs")
    .select("id, intake_log_items!inner(extent, extent_engine_version)")
    .eq("member_id", v.memberId)
    .eq("consumed_on", v.fecha)
    .eq("status", "ACTIVE")
    .eq("intake_log_items.extent_engine_version", EVENT_PORTION_ESTIMATE_VERSION);
  if (errorPrevias) return { ok: false, error: textoDelError(errorPrevias) };
  if (Array.isArray(previas) && previas.length > 0) {
    return {
      ok: false,
      error:
        "Ya declaraste tu porción de este evento. Para corregirla, entra a Lo que comí: ahí la versión anterior queda a la vista y la nueva la reemplaza sin borrarla.",
    };
  }

  const { error } = await supabase.rpc("log_intake_off_plan", {
    p_member_id: v.memberId,
    p_items: [
      {
        label: v.etiqueta,
        extent: v.extension,
        quantity: null,
        quantity_is_declared: false,
        extent_engine_version: EVENT_PORTION_ESTIMATE_VERSION,
      },
    ],
    p_consumed_on: v.fecha,
    p_meal_type: null,
    p_notes: "Comida del evento",
    p_dedupe_key: `EVENT:${v.eventoId}:${v.memberId}`,
  });
  if (error) return { ok: false, error: textoDelError(error) };

  refrescar(v.eventoId);
  return { ok: true, message: "Declarado en tu registro de comidas." };
}
