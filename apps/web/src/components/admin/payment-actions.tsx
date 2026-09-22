"use client";

import { useState, useTransition } from "react";

import { RefreshCw, Undo2 } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input, Overlay, Textarea } from "@/components/ui";
import {
  flagPaymentForReviewAction,
  reconcilePaymentsAction,
  requestRefundAction,
} from "@/lib/actions/finance";
import { formatMoney } from "@/lib/utils/money";

/**
 * Acciones sobre un pago, desde administración.
 *
 * Tres cosas y ninguna más: consultar el estado real en el proveedor, marcar
 * el pago para revisión, y devolver. La devolución pide confirmación explícita
 * con el importe escrito a mano, porque es la única de las tres que mueve
 * dinero y no se deshace.
 *
 * Ninguna de estas pantallas ve ni el token ni credenciales.
 */
export function PaymentActions({
  paymentId,
  amount,
  refunded,
  refundable,
  disputeId,
  canRefund,
}: {
  paymentId: string;
  amount: number;
  refunded: number;
  refundable: number;
  disputeId: string | null;
  /** El pago está en un estado que admite devolución y hay saldo. */
  canRefund: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(
    null,
  );
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState(String(refundable));
  const [reason, setReason] = useState("");

  function reconcile() {
    setMessage(null);
    startTransition(async () => {
      const result = await reconcilePaymentsAction(paymentId);
      setMessage(
        result.ok
          ? {
              tone: "success",
              text:
                result.data.changed > 0
                  ? "El estado cambió tras consultar al proveedor."
                  : "Consultado: el proveedor dice lo mismo que teníamos.",
            }
          : { tone: "danger", text: result.error },
      );
    });
  }

  function flag() {
    setMessage(null);
    startTransition(async () => {
      const result = await flagPaymentForReviewAction(
        paymentId,
        "Marcado manualmente desde administración",
      );
      setMessage(
        result.ok
          ? { tone: "success", text: "El pago quedó en revisión." }
          : { tone: "danger", text: result.error },
      );
    });
  }

  function refund() {
    setMessage(null);
    const parsed = Number(refundAmount);
    startTransition(async () => {
      const result = await requestRefundAction({
        paymentId,
        amount: Number.isFinite(parsed) ? Math.trunc(parsed) : 0,
        reason,
        disputeId: disputeId ?? undefined,
      });
      if (result.ok) {
        setRefundOpen(false);
        setReason("");
        setMessage({
          tone: "success",
          text: `Devolución confirmada por el proveedor (${
            result.data.kind === "REVERSED" ? "reversa" : "anulación"
          }): ${formatMoney({ amount: result.data.refundedAmount, currency: "CLP" })}.`,
        });
      } else {
        setMessage({ tone: "danger", text: result.error });
      }
    });
  }

  return (
    <div className="space-y-3">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={reconcile} loading={pending}>
          <RefreshCw size={15} aria-hidden="true" />
          Consultar al proveedor
        </Button>
        <Button variant="ghost" size="sm" onClick={flag} disabled={pending}>
          Poner en revisión
        </Button>
        {canRefund && (
          <Button variant="danger" size="sm" onClick={() => setRefundOpen(true)} disabled={pending}>
            <Undo2 size={15} aria-hidden="true" />
            Devolver
          </Button>
        )}
      </div>

      <Overlay
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        title="Devolver dinero al cliente"
        description="Esta operación va al proveedor y no se deshace."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRefundOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={refund}
              loading={pending}
              disabled={reason.trim().length < 10}
            >
              Confirmar devolución
            </Button>
          </div>
        }
      >
        <dl className="space-y-1.5 rounded-[var(--radius-control)] bg-canvas p-4 text-small">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-600">Cobrado</dt>
            <dd className="font-medium text-ink-950 tabular-nums">
              {formatMoney({ amount, currency: "CLP" })}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-600">Ya devuelto</dt>
            <dd className="font-medium text-ink-950 tabular-nums">
              {formatMoney({ amount: refunded, currency: "CLP" })}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-line pt-1.5">
            <dt className="text-ink-600">Saldo devolvible</dt>
            <dd className="font-semibold text-ink-950 tabular-nums">
              {formatMoney({ amount: refundable, currency: "CLP" })}
            </dd>
          </div>
        </dl>

        <div className="mt-4 space-y-4">
          <Field
            label="Importe a devolver"
            htmlFor="refund-amount"
            hint="En pesos, sin puntos. Por el total es una reversa; por menos, una anulación parcial."
          >
            <Input
              id="refund-amount"
              type="number"
              inputMode="numeric"
              min={1}
              max={refundable}
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
            />
          </Field>

          <Field
            label="Motivo"
            htmlFor="refund-reason"
            hint="Queda en la auditoría junto a tu nombre. Al menos 10 caracteres."
            required
          >
            <Textarea
              id="refund-reason"
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
