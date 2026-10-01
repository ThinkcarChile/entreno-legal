"use client";

import { useState, useTransition } from "react";

import { RefreshCw, Undo2 } from "lucide-react";

import { OpenRefund } from "@/components/admin/open-refund";
import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input, Overlay, Textarea } from "@/components/ui";
import {
  flagPaymentForReviewAction,
  reconcilePaymentsAction,
  requestRefundAction,
} from "@/lib/actions/finance";
import type { AdminOpenRefund } from "@/lib/data/repositories";
import { formatMoney } from "@/lib/utils/money";

type Tone = "success" | "info" | "warning" | "danger";

/**
 * Identificador de una petición de devolución (un UUID v4).
 *
 * `crypto.randomUUID()` solo existe en contextos seguros; abriendo el panel por
 * HTTP desde otra máquina de la red local no está, y `getRandomValues` sí.
 */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Acciones sobre un pago, desde administración.
 *
 * Tres cosas y ninguna más: consultar el estado real en el proveedor, marcar
 * el pago para revisión, y devolver. La devolución pide confirmación explícita
 * con el importe escrito a mano, porque es la única de las tres que mueve
 * dinero y no se deshace.
 *
 * Cada vez que se abre el formulario de devolución nace un identificador de
 * petición, y cambia en cuanto llega una respuesta. Un doble clic o un reenvío
 * llevan el mismo y no piden dos veces al banco; una segunda devolución, aunque
 * sea del mismo importe, lleva otro y sí ocurre.
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
  openRefund,
}: {
  paymentId: string;
  amount: number;
  refunded: number;
  refundable: number;
  disputeId: string | null;
  /** El pago está en un estado que admite devolución y hay saldo. */
  canRefund: boolean;
  /** Devolución en curso o por confirmar: mientras exista, no se pide otra. */
  openRefund: AdminOpenRefund | null;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState(String(refundable));
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  function reconcile() {
    setMessage(null);
    startTransition(async () => {
      const result = await reconcilePaymentsAction(paymentId);
      setMessage(
        result.ok
          ? {
              tone: "success",
              text:
                result.data.refundsResolved > 0
                  ? "La devolución por confirmar quedó resuelta tras consultar al proveedor."
                  : result.data.changed > 0
                    ? "El estado cambió tras consultar al proveedor."
                    : "Consultado: el proveedor dice lo mismo que teníamos.",
            }
          : { tone: "danger", text: result.error },
      );
    });
  }

  function openRefundDialog() {
    setMessage(null);
    setDialogError(null);
    setRefundAmount(String(refundable));
    setRequestId(newRequestId());
    setRefundOpen(true);
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
    if (!requestId) return;
    setMessage(null);
    setDialogError(null);
    const parsed = Number(refundAmount);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof requestRefundAction>>;
      try {
        result = await requestRefundAction({
          paymentId,
          amount: Number.isFinite(parsed) ? Math.trunc(parsed) : 0,
          reason,
          disputeId: disputeId ?? undefined,
          requestId,
        });
      } catch {
        // Sin respuesta del servidor no se sabe si la petición llegó. Se
        // conserva el identificador: confirmar otra vez no la duplica.
        setDialogError(
          "No supimos si la petición llegó. Puedes volver a confirmar: no se devolverá dos veces.",
        );
        return;
      }

      if (!result.ok) {
        setDialogError(result.error);
        return;
      }

      // Hubo respuesta: la próxima devolución será otra petición.
      setRequestId(null);
      setRefundOpen(false);
      setReason("");
      const money = formatMoney({ amount: result.data.refundedAmount, currency: "CLP" });
      switch (result.data.state) {
        case "CONFIRMED":
          setMessage({
            tone: "success",
            text: `Devolución confirmada por el proveedor (${
              result.data.kind === "REVERSED" ? "reversa" : "anulación"
            }): ${money}.`,
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
              "Queda por confirmar: no se puede pedir otra sobre este pago hasta resolverla.",
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

  return (
    <div className="space-y-3">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {openRefund && (
        <OpenRefund refund={openRefund} paymentAmount={amount} alreadyRefunded={refunded} />
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={reconcile} loading={pending}>
          <RefreshCw size={15} aria-hidden="true" />
          Consultar al proveedor
        </Button>
        <Button variant="ghost" size="sm" onClick={flag} disabled={pending}>
          Poner en revisión
        </Button>
        {canRefund && !openRefund && (
          <Button variant="danger" size="sm" onClick={openRefundDialog} disabled={pending}>
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

        {dialogError && (
          <Alert tone="danger" className="mt-4">
            {dialogError}
          </Alert>
        )}

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
