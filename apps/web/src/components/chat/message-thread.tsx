"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";

import { Send } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button, Input } from "@/components/ui";
import { markConversationReadAction, sendMessageAction } from "@/lib/actions/chat";
import { MessageType } from "@/lib/domain/enums";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { formatTime } from "@/lib/utils/datetime";

import type { Message } from "@/lib/domain/types";

/**
 * Hilo de conversación.
 *
 * Realtime de Supabase para los mensajes entrantes. Se suscribe a la tabla y la
 * fila solo llega si RLS la deja pasar, así que un tercero no recibe nada aunque
 * conozca el identificador.
 */
export function MessageThread({
  conversationId,
  initialMessages,
  currentUserId,
  counterpartName,
  realtimeEnabled,
}: {
  conversationId: string;
  initialMessages: readonly Message[];
  currentUserId: string;
  counterpartName: string;
  realtimeEnabled: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([...initialMessages]);
  const [optimistic, addOptimistic] = useOptimistic(
    messages,
    (current: Message[], next: Message) => [...current, next],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Marcar como leído al abrir es una acción del usuario (abrir el hilo),
  // no un efecto derivado de estado.
  useEffect(() => {
    void markConversationReadAction(conversationId);
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [optimistic.length]);

  useEffect(() => {
    if (!realtimeEnabled) return;

    const supabase = createClient();
    const channel = supabase
      .channel(`conversation:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          setMessages((current) => {
            const id = String(row.id);
            if (current.some((m) => m.id === id)) return current;
            return [
              ...current,
              {
                id,
                conversationId,
                senderId: (row.sender_id as string | null) ?? null,
                type: row.message_type as Message["type"],
                body: (row.body as string | null) ?? null,
                imageUrl: (row.image_url as string | null) ?? null,
                readAt: null,
                createdAt: String(row.created_at),
              },
            ];
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId, realtimeEnabled]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("body") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;

    setError(null);
    input.value = "";

    startTransition(async () => {
      addOptimistic({
        id: `temp-${Date.now()}`,
        conversationId,
        senderId: currentUserId,
        type: MessageType.TEXT,
        body: text,
        imageUrl: null,
        readAt: null,
        createdAt: new Date().toISOString(),
      });

      const result = await sendMessageAction(conversationId, text);
      if (!result.ok) {
        setError(result.error);
        input.value = text;
        return;
      }
      // El mensaje propio se añade siempre con el id que devolvió el servidor.
      //
      // Antes esto dependía de `realtimeEnabled`, que solo dice si hay
      // credenciales de Supabase, no si el socket está vivo. Con credenciales
      // pero sin socket —red que no deja pasar WebSocket, proxy corporativo,
      // túnel caído— el mensaje se guardaba, el optimista se revertía al
      // terminar la transición y quien lo escribió veía la conversación vacía.
      //
      // Si Realtime sí funciona, el evento trae el mismo id y el bloque de
      // abajo lo descarta por duplicado.
      setMessages((current) => {
        if (current.some((m) => m.id === result.data.id)) return current;
        return [
          ...current,
          {
            id: result.data.id,
            conversationId,
            senderId: currentUserId,
            type: MessageType.TEXT,
            body: text,
            imageUrl: null,
            readAt: null,
            createdAt: result.data.createdAt,
          },
        ];
      });
    });
  }

  return (
    <div className="flex h-[70dvh] flex-col rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5">
        {optimistic.length === 0 && (
          <p className="py-10 text-center text-small text-ink-500">
            Todavía no hay mensajes. Escribe para coordinar con {counterpartName}.
          </p>
        )}

        {optimistic.map((message) => {
          if (message.type === MessageType.SYSTEM) {
            return (
              <p
                key={message.id}
                className="mx-auto max-w-md rounded-full bg-ink-100 px-3.5 py-1.5 text-center text-caption text-ink-600"
              >
                {message.body}
              </p>
            );
          }

          const mine = message.senderId === currentUserId;
          return (
            <div key={message.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-small",
                  mine
                    ? "rounded-br-md bg-brand-600 text-white"
                    : "rounded-bl-md bg-ink-100 text-ink-950",
                )}
              >
                <p className="whitespace-pre-wrap">{message.body}</p>
                <time
                  dateTime={message.createdAt}
                  className={cn("mt-1 block text-[0.6875rem]", mine ? "text-brand-100" : "text-ink-500")}
                >
                  {formatTime(message.createdAt)}
                </time>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="px-4 pb-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-ink-100 p-3"
      >
        <Input
          name="body"
          autoComplete="off"
          placeholder={`Escribe a ${counterpartName}…`}
          aria-label="Mensaje"
          maxLength={4000}
        />
        <Button type="submit" disabled={pending} aria-label="Enviar">
          <Send size={16} aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}
