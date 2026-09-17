import type { Metadata } from "next";
import Link from "next/link";

import { MessageCircle } from "lucide-react";

import { Avatar, ButtonLink, Card, CardContent, EmptyState } from "@/components/ui";
import { getViewer } from "@/lib/auth/session";
import { getData, isDemoMode } from "@/lib/data";
import { formatRelative } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Mensajes",
  robots: { index: false, follow: false },
};

export default async function MessagesPage() {
  const session = await getViewer();

  if (!session) {
    return (
      <div className="container-page py-8 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Mensajes</h1>
        <p className="mt-2 max-w-2xl text-ink-600">
          Cada trabajo tiene su propia conversación entre el cliente y el trabajador. Nadie más
          puede leerla.
        </p>
        <EmptyState
          className="mt-8"
          icon={<MessageCircle size={28} aria-hidden="true" />}
          title={isDemoMode() ? "No hay mensajes en modo demostración" : "Entra para ver tus mensajes"}
          description={
            isDemoMode()
              ? "Configura Supabase para usar el chat con datos reales."
              : "Tus conversaciones aparecen aquí cuando ofertas o recibes una oferta."
          }
          action={<ButtonLink href="/entrar">Entrar</ButtonLink>}
        />
      </div>
    );
  }

  const conversations = await getData().conversations.listMine();

  return (
    <div className="container-page max-w-3xl py-8 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">Mensajes</h1>
      <p className="mt-2 text-ink-600">
        Una conversación por trabajo y persona. Solo ustedes dos pueden leerla.
      </p>

      <div className="mt-8">
        {conversations.length === 0 ? (
          <EmptyState
            icon={<MessageCircle size={28} aria-hidden="true" />}
            title="Todavía no tienes conversaciones"
            description="El chat se abre cuando envías una oferta o cuando alguien oferta por tu trabajo."
            action={<ButtonLink href="/trabajos">Ver trabajos disponibles</ButtonLink>}
          />
        ) : (
          <ul className="space-y-3">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link href={`/mensajes/${conversation.id}`} className="block">
                  <Card className="transition-colors hover:border-brand-200">
                    <CardContent className="flex items-center gap-3.5 py-4">
                      <Avatar
                        src={conversation.counterpartAvatarUrl}
                        name={conversation.counterpartName}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="truncate font-medium text-ink-900">
                            {conversation.counterpartName}
                          </p>
                          {conversation.lastMessageAt && (
                            <span className="shrink-0 text-xs text-ink-400">
                              {formatRelative(conversation.lastMessageAt)}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-sm text-ink-500">{conversation.jobTitle}</p>
                        {conversation.lastMessage && (
                          <p className="mt-0.5 truncate text-sm text-ink-600">
                            {conversation.lastMessage}
                          </p>
                        )}
                      </div>
                      {conversation.unreadCount > 0 && (
                        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white tabular-nums">
                          {conversation.unreadCount}
                        </span>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
