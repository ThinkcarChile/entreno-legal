import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChevronLeft } from "lucide-react";

import { MessageThread } from "@/components/chat/message-thread";
import { Avatar, Badge } from "@/components/ui";
import { requireOnboardedUser } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { hasSupabaseCredentials } from "@/lib/env";
import { jobStatusLabels } from "@/lib/domain/labels";

export const metadata: Metadata = {
  title: "Conversación",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationPage({ params }: PageProps) {
  const { id } = await params;
  const session = await requireOnboardedUser(`/mensajes/${id}`);

  // RLS impide leer conversaciones ajenas: si no viene nada, no existe para
  // quien pregunta.
  const detail = await getData().conversations.getById(id);
  if (!detail) notFound();

  const status = jobStatusLabels[detail.conversation.jobStatus];

  return (
    <div className="container-page max-w-3xl py-6 sm:py-10">
      <Link
        href="/mensajes"
        className="inline-flex items-center gap-1.5 text-small font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Mensajes
      </Link>

      <header className="mt-5 flex items-center gap-3.5">
        <Avatar
          src={detail.conversation.counterpartAvatarUrl}
          name={detail.conversation.counterpartName}
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-ink-950">
            {detail.conversation.counterpartName}
          </h1>
          <Link
            href={
              detail.viewerRole === "client"
                ? `/mis-trabajos/publicados/${detail.conversation.jobId}`
                : `/trabajos/${detail.conversation.jobId}`
            }
            className="truncate text-small text-ink-500 hover:text-brand-700"
          >
            {detail.conversation.jobTitle}
          </Link>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </header>

      <div className="mt-5">
        <MessageThread
          conversationId={id}
          initialMessages={detail.messages}
          currentUserId={session.id}
          counterpartName={detail.conversation.counterpartName}
          realtimeEnabled={hasSupabaseCredentials}
        />
      </div>
    </div>
  );
}
