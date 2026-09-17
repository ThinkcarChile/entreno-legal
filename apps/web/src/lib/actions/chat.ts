"use server";

import { revalidatePath } from "next/cache";

import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Mensajería.
 *
 * Abrir una conversación pasa por `open_job_conversation`, que comprueba que
 * exista una relación real (una oferta o una asignación) entre las dos personas.
 * Sin eso, cualquiera podría abrir un canal directo hacia un cliente.
 */

export async function openConversationAction(
  jobId: string,
  workerId: string,
): Promise<ActionResult<{ conversationId: string }>> {
  try {
    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("open_job_conversation", {
      p_job_id: jobId,
      p_worker_id: workerId,
    });

    if (error) return actionError(error, "No pudimos abrir la conversación.");
    return actionOk({ conversationId: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos abrir la conversación.");
  }
}

/**
 * Envía un mensaje y devuelve la fila creada.
 *
 * Devuelve el identificador a propósito: quien escribe lo añade a su hilo sin
 * esperar a Realtime, y cuando el evento llega se descarta por id. Antes no
 * devolvía nada y el hilo dependía de que el socket contestara; si no lo hacía,
 * el mensaje quedaba guardado pero desaparecía de la pantalla de quien lo
 * escribió hasta recargar.
 */
export async function sendMessageAction(
  conversationId: string,
  body: string,
): Promise<ActionResult<{ id: string; createdAt: string }>> {
  const text = body.trim();
  if (!text) return { ok: false, error: "Escribe un mensaje." };
  if (text.length > 4000) return { ok: false, error: "El mensaje es demasiado largo." };

  try {
    const { supabase, userId } = await requireSession();
    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        sender_id: userId,
        message_type: "TEXT",
        body: text,
      })
      .select("id,created_at")
      .single<{ id: string; created_at: string }>();

    if (error) return actionError(error, "No pudimos enviar el mensaje.");

    revalidatePath(`/mensajes/${conversationId}`);
    return actionOk({ id: data.id, createdAt: data.created_at });
  } catch (error) {
    return actionError(error, "No pudimos enviar el mensaje.");
  }
}

export async function markConversationReadAction(
  conversationId: string,
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("mark_conversation_read", {
      p_conversation_id: conversationId,
    });
    if (error) return actionError(error);
    return actionOk();
  } catch (error) {
    return actionError(error);
  }
}

export async function markNotificationsReadAction(
  ids?: readonly string[],
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("mark_notifications_read", {
      p_ids: ids ? [...ids] : null,
    });
    if (error) return actionError(error);

    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return actionError(error);
  }
}
