import type { Metadata } from "next";
import Link from "next/link";

import { CreditCard } from "lucide-react";

import { PaymentActions } from "@/components/admin/payment-actions";
import { ReconcileAll } from "@/components/admin/reconcile-all";
import { Amount, Card, CardContent, EmptyState, StatusChip } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData, type AdminPaymentFilter } from "@/lib/data";
import { formatDateTime } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Pagos",
  robots: { index: false, follow: false },
};

/**
 * Pagos del cliente hacia la plataforma.
 *
 * Es la pantalla de soporte: cuando alguien escribe «pagué y no aparece», aquí
 * está todo lo que hace falta para responderle sin abrir el portal de
 * Transbank —orden de compra, estado del proveedor, código de respuesta,
 * autorización, últimos cuatro dígitos, cuotas— y el botón para preguntarle al
 * proveedor en ese momento.
 *
 * Lo que no está, y no va a estar: el token y las credenciales.
 */
const FILTERS: readonly { id: AdminPaymentFilter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "review", label: "En revisión" },
  { id: "pending", label: "Sin resolver" },
  { id: "refunded", label: "Devueltos" },
];

const TONES: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  PENDING: "neutral",
  CREATED: "info",
  AUTHORIZED: "info",
  PAID: "success",
  FAILED: "danger",
  UNDER_REVIEW: "warning",
  REFUNDED: "neutral",
  PARTIALLY_REFUNDED: "warning",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Iniciado",
  CREATED: "En el proveedor",
  AUTHORIZED: "Autorizado",
  PAID: "Pagado",
  FAILED: "Fallido",
  UNDER_REVIEW: "En revisión",
  REFUNDED: "Devuelto",
  PARTIALLY_REFUNDED: "Devuelto en parte",
};

const FAILURE_LABELS: Record<string, string> = {
  aborted_by_user: "el cliente canceló en el formulario",
  form_timeout: "se agotó el tiempo del formulario",
  return_conflict: "el retorno llegó con parámetros contradictorios",
  return_without_parameters: "el retorno llegó sin parámetros",
  reconciled_not_authorized: "el proveedor dice que no se autorizó",
  provider_error: "el proveedor no respondió al crear la transacción",
};

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string }>;
}) {
  await requireAdmin("/admin/pagos");
  const { filtro } = await searchParams;
  const filter = (FILTERS.find((f) => f.id === filtro)?.id ?? "all") as AdminPaymentFilter;
  const rows = await getData().admin.listPayments(filter);

  return (
    <div className="container-page py-8 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-h2 text-ink-950">Pagos</h1>
          <p className="mt-1 text-ink-600">
            Lo que pagó cada cliente, con lo que contestó el proveedor.
          </p>
        </div>
        <ReconcileAll />
      </header>

      <Alert tone="info" className="mt-5" title="Webpay Plus no avisa por su cuenta">
        No hay webhooks: si el navegador de quien paga se cae a mitad del retorno, nadie nos
        cuenta lo que pasó. Por eso existe «Conciliar»: pregunta el estado real al proveedor y
        asienta el resultado por la misma vía que el retorno normal.
      </Alert>

      <nav className="mt-6 flex flex-wrap gap-1.5" aria-label="Filtrar pagos">
        {FILTERS.map((option) => (
          <Link
            key={option.id}
            href={option.id === "all" ? "/admin/pagos" : `/admin/pagos?filtro=${option.id}`}
            aria-current={option.id === filter ? "page" : undefined}
            className={
              option.id === filter
                ? "rounded-[var(--radius-pill)] border border-brand-600 bg-brand-600 px-3.5 py-1.5 text-small font-medium text-white"
                : "rounded-[var(--radius-pill)] border border-line bg-surface px-3.5 py-1.5 text-small font-medium text-ink-700 hover:border-brand-300"
            }
          >
            {option.label}
          </Link>
        ))}
      </nav>

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={<CreditCard size={22} aria-hidden="true" />}
            title="Sin pagos que mostrar"
            description="Cuando un cliente pague un trabajo, aparecerá aquí con su detalle."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const refundable =
                row.refundableAmount > 0 &&
                ["PAID", "UNDER_REVIEW", "PARTIALLY_REFUNDED"].includes(row.status);

              return (
                <li key={row.paymentId}>
                  <Card>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusChip tone={TONES[row.status] ?? "neutral"}>
                              {STATUS_LABELS[row.status] ?? row.status}
                            </StatusChip>
                            {row.purpose === "EXTENSION" && (
                              <StatusChip tone="info">Tiempo adicional</StatusChip>
                            )}
                            {row.environment && row.environment !== "production" && (
                              <StatusChip tone="warning">{row.environment}</StatusChip>
                            )}
                          </div>

                          <p className="mt-2.5 font-semibold text-ink-950">
                            <Link
                              href={`/mis-trabajos/publicados/${row.jobId}`}
                              className="hover:text-brand-700"
                            >
                              {row.jobTitle}
                            </Link>
                          </p>
                          <p className="mt-0.5 text-caption text-ink-500">
                            {row.jobReference} · {formatDateTime(row.createdAt)}
                          </p>
                        </div>

                        <div className="text-right">
                          <p className="text-h3 text-ink-950 tabular-nums">
                            <Amount value={{ amount: row.amount, currency: "CLP" }} />
                          </p>
                          {row.refundedAmount > 0 && (
                            <p className="text-caption text-ink-600">
                              Devuelto{" "}
                              <Amount
                                value={{ amount: row.refundedAmount, currency: "CLP" }}
                              />
                            </p>
                          )}
                        </div>
                      </div>

                      {row.reviewReason && (
                        <Alert tone="warning" title="En revisión">
                          Motivo registrado: <code>{row.reviewReason}</code>. El trabajo no se
                          habilitó y no hay pago al trabajador.
                        </Alert>
                      )}
                      {row.failureReason && (
                        <p className="text-small text-ink-600">
                          No se completó porque{" "}
                          {FAILURE_LABELS[row.failureReason] ?? row.failureReason}.
                        </p>
                      )}

                      <dl className="grid gap-x-6 gap-y-1.5 text-caption sm:grid-cols-2 lg:grid-cols-3">
                        <Detail label="Orden de compra" value={row.buyOrder} mono />
                        <Detail label="Estado del proveedor" value={row.providerStatus} />
                        <Detail
                          label="Código de respuesta"
                          value={row.responseCode == null ? null : String(row.responseCode)}
                        />
                        <Detail label="Autorización" value={row.authorizationCode} mono />
                        <Detail
                          label="Tarjeta"
                          value={row.cardLastDigits ? `•••• ${row.cardLastDigits}` : null}
                        />
                        <Detail label="Medio de pago" value={row.paymentTypeCode} />
                        <Detail
                          label="Cuotas"
                          value={row.installments == null ? null : String(row.installments)}
                        />
                        <Detail label="3-D Secure (vci)" value={row.vci} />
                        <Detail label="Intentos" value={String(row.attempt)} />
                        <Detail label="Eventos" value={String(row.eventCount)} />
                        <Detail
                          label="Última conciliación"
                          value={row.reconciledAt ? formatDateTime(row.reconciledAt) : null}
                        />
                        <Detail
                          label="Pago al trabajador"
                          value={row.payoutId ? "creado" : "no"}
                        />
                      </dl>

                      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                        {row.disputeId && (
                          <Link
                            href="/admin/disputas"
                            className="text-small font-medium text-brand-700 hover:underline"
                          >
                            Ver la disputa
                          </Link>
                        )}
                        <PaymentActions
                          paymentId={row.paymentId}
                          amount={row.amount}
                          refunded={row.refundedAmount}
                          refundable={row.refundableAmount}
                          disputeId={row.disputeId}
                          canRefund={refundable}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 sm:block">
      <dt className="text-ink-500">{label}</dt>
      <dd className={mono ? "font-mono text-ink-800" : "text-ink-800"}>{value ?? "—"}</dd>
    </div>
  );
}
