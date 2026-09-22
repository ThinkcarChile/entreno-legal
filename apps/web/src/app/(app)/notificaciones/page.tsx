import type { Metadata } from "next";
import Link from "next/link";

import { Bell } from "lucide-react";

import { MarkAllRead } from "@/components/notifications/mark-all-read";
import { ButtonLink, Card, CardContent, EmptyState } from "@/components/ui";
import { getViewer } from "@/lib/auth/session";
import { getData, isDemoMode } from "@/lib/data";
import { formatRelative } from "@/lib/utils/datetime";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = {
  title: "Notificaciones",
  robots: { index: false, follow: false },
};

export default async function NotificationsPage() {
  const session = await getViewer();

  if (!session) {
    return (
      <div className="container-page max-w-2xl py-8 sm:py-12">
        <h1 className="text-h2 text-ink-950">Notificaciones</h1>
        <EmptyState
          className="mt-8"
          icon={<Bell size={28} aria-hidden="true" />}
          title={isDemoMode() ? "Sin notificaciones en modo demostración" : "Entra para ver tus avisos"}
          description="Aquí llegan las ofertas, los mensajes y los cambios de estado de tus trabajos."
          action={<ButtonLink href="/entrar">Entrar</ButtonLink>}
        />
      </div>
    );
  }

  const notifications = await getData().notifications.listMine(40);
  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="container-page max-w-2xl py-8 sm:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-h2 text-ink-950 sm:text-h1">
            Notificaciones
          </h1>
          <p className="mt-2 text-ink-600">
            {unread > 0 ? `Tienes ${unread} sin leer.` : "Estás al día."}
          </p>
        </div>
        {unread > 0 && <MarkAllRead />}
      </header>

      <div className="mt-8">
        {notifications.length === 0 ? (
          <EmptyState
            icon={<Bell size={28} aria-hidden="true" />}
            title="Todavía no tienes avisos"
            description="Te avisamos cuando recibas una oferta, un mensaje o cuando cambie el estado de un trabajo."
          />
        ) : (
          <ul className="space-y-2.5">
            {notifications.map((notification) => {
              const content = (
                <Card
                  className={cn(
                    "transition-colors",
                    notification.readAt ? "" : "border-brand-200 bg-brand-50/40",
                  )}
                >
                  <CardContent className="py-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="font-medium text-ink-950">{notification.title}</p>
                      <span className="shrink-0 text-caption text-ink-500">
                        {formatRelative(notification.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-small text-ink-600">{notification.body}</p>
                  </CardContent>
                </Card>
              );

              return (
                <li key={notification.id}>
                  {notification.href ? (
                    <Link href={notification.href} className="block">
                      {content}
                    </Link>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
