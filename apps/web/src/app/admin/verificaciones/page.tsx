import type { Metadata } from "next";

import { BadgeCheck } from "lucide-react";

import { VerificationReview } from "@/components/admin/verification-review";
import { Avatar, Badge, Card, CardContent, EmptyState } from "@/components/ui";
import { requireAdmin } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { VerificationStatus } from "@/lib/domain/enums";
import { verificationStatusLabels } from "@/lib/domain/labels";
import { formatRelative } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Verificaciones",
  robots: { index: false, follow: false },
};

/**
 * Cola de verificación.
 *
 * Es la herramienta con la que el equipo aprueba o rechaza una identidad. No hay
 * proveedor biométrico todavía: la decisión la toma una persona, y queda
 * registrada en la bitácora de auditoría como cualquier acción administrativa.
 */
export default async function AdminVerificationsPage() {
  await requireAdmin("/admin/verificaciones");

  const data = getData();
  const [pending, resolved] = await Promise.all([
    data.admin.listVerifications(VerificationStatus.PENDING),
    data.admin.listVerifications(),
  ]);

  const history = resolved.filter((v) => v.status !== VerificationStatus.PENDING).slice(0, 20);

  return (
    <div className="container-page py-8 sm:py-10">
      <header>
        <h1 className="text-h2 text-ink-950">Verificaciones</h1>
        <p className="mt-1 text-ink-600">
          Solo un trabajador verificado puede enviar ofertas y ser asignado a un trabajo.
        </p>
      </header>

      <section className="mt-8">
        <h2 className="text-small font-semibold tracking-wide text-ink-500 uppercase">
          Pendientes ({pending.length})
        </h2>

        <div className="mt-3">
          {pending.length === 0 ? (
            <EmptyState
              icon={<BadgeCheck size={28} aria-hidden="true" />}
              title="No hay solicitudes pendientes"
              description="Cuando alguien solicite verificar su identidad, aparecerá aquí."
            />
          ) : (
            <ul className="space-y-3">
              {pending.map((request) => (
                <li key={request.id}>
                  <Card>
                    <CardContent>
                      <div className="flex flex-wrap items-start gap-4">
                        <Avatar src={request.avatarUrl} name={request.displayName} />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-ink-950">{request.displayName}</p>
                          <p className="mt-0.5 text-small text-ink-500">
                            Solicitado {formatRelative(request.createdAt)} ·{" "}
                            {request.documentType ?? "Sin documento declarado"}
                          </p>
                          <p className="mt-2 text-caption text-ink-500">
                            Los archivos viven en el bucket privado y no se exponen aquí hasta
                            integrar la vista segura de documentos.
                          </p>
                        </div>
                        <VerificationReview verificationId={request.id} />
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {history.length > 0 && (
        <section className="mt-10">
          <h2 className="text-small font-semibold tracking-wide text-ink-500 uppercase">
            Resueltas recientemente
          </h2>
          <ul className="mt-3 space-y-2">
            {history.map((request) => {
              const label = verificationStatusLabels[request.status];
              return (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-5 py-3"
                >
                  <Avatar src={request.avatarUrl} name={request.displayName} size="sm" />
                  <span className="font-medium text-ink-950">{request.displayName}</span>
                  <Badge tone={label.tone}>{label.label}</Badge>
                  {request.rejectionReason && (
                    <span className="text-small text-ink-500">{request.rejectionReason}</span>
                  )}
                  {request.reviewedAt && (
                    <span className="ml-auto text-caption text-ink-500">
                      {formatRelative(request.reviewedAt)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
