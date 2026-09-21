import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ChevronLeft } from "lucide-react";

import { ProtectedPaymentPanel } from "@/components/payments/protected-payment-panel";
import { Amount, Avatar, Card, CardContent } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { site } from "@/config/site";
import { requireOnboardedUser } from "@/lib/auth/session";
import { isPaymentSimulationEnabled } from "@/lib/actions/payments";
import { getData } from "@/lib/data";
import { PaymentStatus } from "@/lib/domain/enums";
import { isPayable } from "@/lib/domain/job-actions";
import { formatDate, formatDuration, formatTime } from "@/lib/utils/datetime";
import { formatPercent } from "@/lib/utils/format";

export const metadata: Metadata = {
  title: "Pago Protegido",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pago?: string }>;
}

export default async function ProtectedPaymentPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { pago } = await searchParams;

  const session = await requireOnboardedUser(`/pagar/${id}`);
  const detail = await getData().jobs.getAssignment(id);

  if (!detail) notFound();
  // Solo el cliente paga. Cambiar el identificador en la URL no sirve de nada.
  if (detail.assignment.clientId !== session.id) redirect("/mis-trabajos/publicados");

  if (detail.payment?.status === PaymentStatus.PAID) {
    redirect(`/mis-trabajos/${id}?pago=ok`);
  }

  // Con la cancelación en verificación, o ya cancelado, aquí no hay nada que
  // pagar: la pantalla del trabajo explica en qué estado está.
  if (!isPayable(detail.job.status)) {
    redirect(`/mis-trabajos/${id}`);
  }

  const { settlement, job, worker } = detail;
  const simulationEnabled = await isPaymentSimulationEnabled();

  return (
    <div className="container-page max-w-2xl py-6 sm:py-10">
      <Link
        href={`/mis-trabajos/publicados/${job.id}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Volver al trabajo
      </Link>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
        {site.protectedPaymentLabel}
      </h1>
      <p className="mt-2 text-ink-600">
        Confirma el pago para que el trabajo pueda comenzar. El dinero queda asociado a este
        servicio hasta que se complete.
      </p>

      {pago === "rechazado" && (
        <Alert tone="danger" className="mt-6" title="El pago no se completó">
          No se realizó ningún cobro. Puedes intentarlo otra vez.
        </Alert>
      )}

      <Card className="mt-6">
        <CardContent>
          <div className="flex items-center gap-3.5 border-b border-ink-100 pb-5">
            <Avatar src={worker.profile.avatarUrl} name={worker.profile.displayName} />
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-900">{job.title}</p>
              <p className="mt-0.5 text-sm text-ink-500">
                {worker.profile.displayName} · {formatDate(job.startsAt, job.timezone)} a las{" "}
                {formatTime(job.startsAt, job.timezone)} ·{" "}
                {formatDuration(detail.assignment.agreedDurationMinutes)}
              </p>
            </div>
          </div>

          <dl className="mt-5 space-y-3 text-sm">
            <Row label="Valor del trabajo" value={<Amount value={settlement.serviceAmount} />} />
            {settlement.bonusAmount.amount > 0 && (
              <Row
                label="Bono potencial por objetivo"
                value={<Amount value={settlement.bonusAmount} />}
                hint="Se paga solo si el objetivo se cumple."
              />
            )}
            <Row
              label={`Tarifa ${site.shortName} (${formatPercent(settlement.commissionBps / 10000, 0)})`}
              value={<Amount value={settlement.commissionAmount} />}
              hint="Se descuenta de lo que recibe el trabajador."
            />
          </dl>

          <div className="mt-5 space-y-3 border-t border-ink-100 pt-5">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-ink-600">El trabajador recibe</span>
              <span className="font-semibold text-ink-900">
                <Amount value={settlement.workerReceives} />
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-base font-medium text-ink-900">Total a pagar</span>
              <span className="text-2xl font-semibold text-ink-900">
                <Amount value={settlement.clientTotal} />
              </span>
            </div>
          </div>

          <div className="mt-6">
            <ProtectedPaymentPanel assignmentId={id} simulationEnabled={simulationEnabled} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-ink-600">{label}</dt>
        <dd className="font-medium text-ink-900 tabular-nums">{value}</dd>
      </div>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
