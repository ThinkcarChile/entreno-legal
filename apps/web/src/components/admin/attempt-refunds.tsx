"use client";

import { useState, useTransition } from "react";

import { Undo2 } from "lucide-react";

import { OpenRefund } from "@/components/admin/open-refund";
import { newRequestId } from "@/components/admin/payment-actions";
import { Alert } from "@/components/ui/feedback";
import { Button, Field, Overlay, Textarea } from "@/components/ui";
import { requestAttemptRefundAction } from "@/lib/actions/finance";
import type { AdminReviewAttempt } from "@/lib/data/repositories";
import { formatDateTime } from "@/lib/utils/datetime";
import { formatMoney } from "@/lib/utils/money";

/**
 * Los cobros de un pago que NO son el del trabajo: un cobro duplicado (otro
 * intento autorizado cuando el pago ya tenía su dinero) o un intento que salió
 * de la ventana con indicios de cobro.
 *
 * Cada uno se devuelve aquí, contra la transacción de SU intento y por su
 * cobro entero. El botón «Devolver» del pago no sirve para esto: actúa sobre
 * el cobro que pagó el trabajo, y usarlo devolvería el dinero bueno.
 *
 * Ya devuelto, el intento deja de contar como pendiente y queda como
 * constancia. Una devolución sin respuesta en firme se explica y se cierra
 * igual que la de un pago (`OpenRefund`).
 */
export function AttemptRefunds({ attempts }: { attempts: readonly AdminReviewAttempt[] }) {
  return (
    <div className="space-y-3">
      {attempts.map((attempt) => (
        <AttemptRefund key={attempt.attemptId} attempt={attempt} />
      ))}
    </div>
  );
}

const FAILURE_REASONS: Record<string, string> = {
  provider_rejected: "el banco la rechazó",
  not_sent: "la petición no llegó a salir",
  not_dispatched: "la petición no llegó a salir",
  missing_token: "el intento no tiene token",
  manual_not_executed: "se revisó en el portal de Transbank y no estaba hecha",
  not_executed_per_status: "la consulta de estado mostró que no se hizo",
};

function explainFailure(code: string | null): string {
  if (!code) return "el banco no la hizo";
  if (FAILURE_REASONS[code]) return FAILURE_REASONS[code];
  const http = /^provider_http_(\d{3})$/.exec(code);
  if (http) return `el banco la rechazó (HTTP ${http[1]})`;
  return code;
}

function AttemptRefund({ attempt }: { attempt: AdminReviewAttempt }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: "success" | "info" | "warning" | "danger";
    text: string;
  } | null>(null);

  const amount = formatMoney({ amount: attempt.amount, currency: "CLP" });
  const refund = attempt.refund;

  if (refund?.status === "CONFIRMED") {
    return (
      <Alert tone="success" title={`Cobro del intento ${attempt.attempt} devuelto`}>
        Se devolvieron {formatMoney({ amount: refund.amount, currency: "CLP" })} al cliente
        {refund.kind === "REVERSED" ? " (reversa)" : refund.kind === "NULLIFIED" ? " (anulación)" : ""}
        {refund.settledAt ? ` el ${formatDateTime(refund.settledAt)}` : ""}, contra la orden de
        compra <code>{attempt.buyOrder}</code>. No queda nada pendiente con este cobro.
      </Alert>
    );
  }

  function openDialog() {
    setMessage(null);
    setDialogError(null);
    setReason("");
    setRequestId(newRequestId());
    setOpen(true);
  }

  function submit() {
    if (!requestId) return;
    setDialogError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof requestAttemptRefundAction>>;
      try {
        result = await requestAttemptRefundAction({
          attemptId: attempt.attemptId,
          reason,
          requestId,
        });
      } catch {
        // Sin respuesta no se sabe si la petición llegó: se conserva el
        // identificador y confirmar otra vez no la duplica.
        setDialogError(
          "No supimos si la petición llegó. Puedes volver a confirmar: no se devolverá dos veces.",
        );
        return;
      }
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }

      setRequestId(null);
      setOpen(false);
      setReason("");
      switch (result.data.state) {
        case "CONFIRMED":
          setMessage({
            tone: "success",
            text: `Devolución confirmada por el proveedor: ${formatMoney({
              amount: result.data.refundedAmount,
              currency: "CLP",
            })}.`,
          });
          break;
        case "FAILED":
          setMessage({
            tone: "danger",
            text: "El proveedor rechazó la devolución. No se devolvió nada: puedes volver a pedirla.",
          });
          break;
        case "UNKNOWN":
          setMessage({
            tone: "warning",
            text:
              "El banco no dio una respuesta en firme y puede que la devolución se haya hecho. " +
              "Queda por confirmar: no se puede pedir otra sobre este cobro hasta resolverla.",
          });
          break;
        default:
          setMessage({
            tone: "info",
            text: "Esta devolución ya se está procesando. Espera su resultado antes de volver a intentarlo.",
          });
      }
    });
  }

  const duplicate = attempt.status === "DOUBLE_CHARGE";
  const what = duplicate
    ? "quedó autorizado cuando el pago ya tenía el dinero de otro intento: es un cobro duplicado"
    : "salió de la ventana de conciliación con indicios de cobro (se pidió su confirmación o el banco lo dio por autorizado)";
  const inFlight = refund?.status === "REQUESTED" || refund?.status === "UNKNOWN";

  // El intento vigente de un pago en revisión: su dinero ES el del pago, y se
  // devuelve con «Devolver», sobre el pago. Por los dos lados, dos veces.
  if (attempt.backsPayment && !refund) {
    return (
      <Alert tone="warning" title={`Intento ${attempt.attempt} en revisión`}>
        El intento {attempt.attempt} (orden de compra <code>{attempt.buyOrder}</code>) {what}, y
        es el que respalda este pago, que quedó en revisión. Si hubo cobro, se devuelve con
        «Devolver», sobre el pago: contrástalo antes en el portal de Transbank.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <Alert
        tone="danger"
        title={`${duplicate ? "Cobro duplicado" : "Cobro"} del intento ${attempt.attempt} por devolver`}
      >
        El intento {attempt.attempt} (orden de compra <code>{attempt.buyOrder}</code>) {what}. Ese
        dinero, {amount}, no es parte del pago del trabajo: se devuelve aquí, entero, contra la
        transacción de ese intento. El botón «Devolver» del pago actúa sobre el cobro que pagó el
        trabajo y no sirve para esto.
        {refund?.status === "FAILED" &&
          ` La última devolución pedida no salió: ${explainFailure(refund.failureReason)}. Se puede volver a pedir.`}
      </Alert>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {refund && inFlight && (
        <OpenRefund
          scope="attempt"
          refund={{
            refundId: refund.refundId,
            status: refund.status === "UNKNOWN" ? "UNKNOWN" : "REQUESTED",
            amount: refund.amount,
            requestedAt: refund.requestedAt,
            unknownReason: refund.unknownReason,
            lastCheckedAt: refund.lastCheckedAt,
            lastCheckResult: refund.lastCheckResult,
          }}
          paymentAmount={attempt.amount}
          alreadyRefunded={0}
        />
      )}

      {!inFlight && (
        <Button variant="danger" size="sm" onClick={openDialog} disabled={pending}>
          <Undo2 size={15} aria-hidden="true" />
          Devolver este cobro
        </Button>
      )}

      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        title={duplicate ? "Devolver el cobro duplicado" : "Devolver el cobro del intento"}
        description="Esta operación va al proveedor y no se deshace."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={submit}
              loading={pending}
              disabled={reason.trim().length < 10}
            >
              Devolver {amount}
            </Button>
          </div>
        }
      >
        <dl className="space-y-1.5 rounded-[var(--radius-control)] bg-canvas p-4 text-small">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-600">Intento</dt>
            <dd className="font-medium text-ink-950">{attempt.attempt}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-600">Orden de compra</dt>
            <dd className="font-mono text-ink-950">{attempt.buyOrder}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-line pt-1.5">
            <dt className="text-ink-600">Se devuelve</dt>
            <dd className="font-semibold text-ink-950 tabular-nums">{amount}</dd>
          </div>
        </dl>
        <p className="mt-3 text-small text-ink-600">
          Siempre el cobro entero de este intento. El pago del trabajo y el pago al trabajador no
          cambian.
        </p>

        {dialogError && (
          <Alert tone="danger" className="mt-4">
            {dialogError}
          </Alert>
        )}

        <div className="mt-4">
          <Field
            label="Motivo"
            htmlFor={`motivo-intento-${attempt.attemptId}`}
            hint="Queda en la auditoría junto a tu nombre. Al menos 10 caracteres."
            required
          >
            <Textarea
              id={`motivo-intento-${attempt.attemptId}`}
              value={reason}
              rows={3}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </Overlay>
    </div>
  );
}
