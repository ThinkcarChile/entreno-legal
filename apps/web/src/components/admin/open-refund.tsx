"use client";

import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Radio, Textarea } from "@/components/ui";
import { resolveUnknownAttemptRefundAction, resolveUnknownRefundAction } from "@/lib/actions/finance";
import type { AdminOpenRefund } from "@/lib/data/repositories";
import { formatDateTime } from "@/lib/utils/datetime";
import { formatMoney } from "@/lib/utils/money";

/**
 * Una devolución sin resultado final, explicada.
 *
 * Mientras exista, no se puede pedir otra sobre el mismo pago: si el banco hizo
 * la primera, la segunda devolvería el dinero dos veces. Por eso esta pantalla
 * dice por qué sigue abierta y qué hacer con ella.
 *
 * La conciliación la resuelve sola cuando el estado de la transacción en
 * Webpay lo deja claro. Cuando no —fuera de los 7 días en que Webpay contesta,
 * o con un estado que no cuadra—, la cierra una persona con lo que muestra el
 * portal de Transbank.
 *
 * Sirve para las dos devoluciones: la del cobro de un pago (`scope="payment"`)
 * y la del cobro duplicado de un intento (`scope="attempt"`), que se busca en
 * el portal por la orden de compra de ese intento.
 */

/** Por qué no se sabe qué hizo el banco. */
const UNKNOWN_REASONS: Record<string, string> = {
  timeout: "se agotó el tiempo de espera de la respuesta",
  network: "se cortó la conexión con el banco",
  unparsable_response: "la respuesta del banco no se pudo interpretar",
  unknown_error: "la llamada falló de una forma que no sabemos clasificar",
  stale_request: "la petición quedó sin respuesta registrada",
};

/** Qué concluyó la última consulta automática que no pudo decidir. */
const CHECK_RESULTS: Record<string, string> = {
  too_recent_to_rule_out: "todavía es pronto para darla por no hecha; se vuelve a mirar en la siguiente pasada",
  status_without_amount: "la consulta no trajo el importe de la transacción",
  status_amount_mismatch: "el importe de la transacción no coincide con el del pago",
  reversed_does_not_match: "la transacción figura reversada, y eso no cuadra con lo registrado",
  nullified_does_not_match: "la transacción figura anulada, y eso no cuadra con lo registrado",
  nullified_with_balance: "la transacción figura anulada pero con saldo",
  partially_nullified_without_balance: "la transacción figura anulada en parte, sin saldo informado",
  balance_does_not_match: "el saldo de la transacción no cuadra con lo registrado",
  authorized_with_balance: "la transacción figura autorizada con un saldo menor que el total",
  authorized_with_confirmed_refunds:
    "la transacción no muestra anulaciones, pero aquí hay devoluciones confirmadas",
  missing_token: "el pago no tiene token: no se puede consultar",
  provider_without_status: "el proveedor activo no permite consultar el estado",
  stale_request: "la petición quedó sin respuesta registrada",
  reconcile_error: "la conciliación no pudo registrar lo que encontró; revisa el registro de pagos",
};

function explainUnknown(code: string | null): string {
  if (!code) return "el banco no dio una respuesta en firme";
  if (UNKNOWN_REASONS[code]) return UNKNOWN_REASONS[code];
  const http = /^provider_http_(\d{3})$/.exec(code);
  if (http) return `el banco contestó con un error propio (HTTP ${http[1]})`;
  return code;
}

function explainCheck(code: string): string {
  if (CHECK_RESULTS[code]) return CHECK_RESULTS[code];
  if (code.startsWith("status_unavailable")) {
    return "Webpay no contestó la consulta de estado (pasados 7 días ya no lo hace)";
  }
  if (code.startsWith("environment_")) return "la devolución es de otro ambiente de Transbank";
  if (code.startsWith("provider_unavailable")) {
    return "no se pudo preparar la conexión con Transbank (revisa su configuración)";
  }
  if (code.startsWith("status_")) return `estado inesperado de la transacción (${code.slice(7)})`;
  return code;
}

type Resolution = "NULLIFIED" | "REVERSED" | "NOT_DONE";

export function OpenRefund({
  refund,
  paymentAmount,
  alreadyRefunded,
  scope = "payment",
}: {
  refund: AdminOpenRefund;
  /** Importe de la transacción: la del pago, o la del intento. */
  paymentAmount: number;
  alreadyRefunded: number;
  scope?: "payment" | "attempt";
}) {
  const [pending, startTransition] = useTransition();
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(
    null,
  );

  const amount = formatMoney({ amount: refund.amount, currency: "CLP" });
  const requestedAt = formatDateTime(refund.requestedAt);
  const subject = scope === "attempt" ? "este cobro" : "este pago";
  // Una reversa deshace la transacción entera: solo cabe por el total.
  const reversalPossible = alreadyRefunded === 0 && refund.amount === paymentAmount;

  function resolve() {
    if (!resolution) return;
    setMessage(null);
    startTransition(async () => {
      const input = {
        refundId: refund.refundId,
        succeeded: resolution !== "NOT_DONE",
        kind: resolution === "NOT_DONE" ? undefined : resolution,
        note,
      };
      const result =
        scope === "attempt"
          ? await resolveUnknownAttemptRefundAction(input)
          : await resolveUnknownRefundAction(input);
      setMessage(
        result.ok
          ? {
              tone: "success",
              text:
                result.data.refundStatus === "CONFIRMED"
                  ? scope === "attempt"
                    ? "La devolución del cobro quedó confirmada."
                    : "La devolución quedó confirmada y el saldo del pago, actualizado."
                  : "La devolución quedó como no hecha. Ya se puede pedir otra si corresponde.",
            }
          : { tone: "danger", text: result.error },
      );
    });
  }

  if (refund.status === "REQUESTED") {
    return (
      <Alert tone="info" title="Devolución en curso">
        Se pidió al banco una devolución de {amount} el {requestedAt} y todavía no hay respuesta
        registrada. Mientras tanto no se puede pedir otra devolución sobre {subject}. Si sigue así
        pasados 15 minutos, la conciliación la deja «por confirmar» y la contrasta con Webpay.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <Alert tone="warning" title="Devolución por confirmar">
        Se pidió una devolución de {amount} el {requestedAt} y no sabemos si el banco la hizo:{" "}
        {explainUnknown(refund.unknownReason)}. Puede que el dinero haya salido, así que no se
        puede pedir otra devolución sobre {subject} hasta resolver esta. La conciliación la
        contrasta con el estado de la transacción en Webpay
        {refund.lastCheckedAt && refund.lastCheckResult
          ? `; la última consulta (${formatDateTime(refund.lastCheckedAt)}) no pudo decidir: ${explainCheck(refund.lastCheckResult)}`
          : ""}
        . Si no se resuelve sola, revisa la transacción en el portal de Transbank y ciérrala aquí
        con lo que muestre.
      </Alert>

      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <fieldset className="space-y-1 rounded-[var(--radius-control)] border border-line p-4">
        <legend className="px-1 text-small font-medium text-ink-800">
          Lo que muestra el portal de Transbank
        </legend>
        <Radio
          name={`resolucion-${refund.refundId}`}
          label={`La devolución está hecha, como anulación por ${amount}`}
          checked={resolution === "NULLIFIED"}
          onChange={() => setResolution("NULLIFIED")}
        />
        {reversalPossible && (
          <Radio
            name={`resolucion-${refund.refundId}`}
            label="La transacción está reversada (devolución total)"
            checked={resolution === "REVERSED"}
            onChange={() => setResolution("REVERSED")}
          />
        )}
        <Radio
          name={`resolucion-${refund.refundId}`}
          label="No hay ninguna devolución por este importe"
          hint="Queda como no hecha y se puede volver a pedir."
          checked={resolution === "NOT_DONE"}
          onChange={() => setResolution("NOT_DONE")}
        />
      </fieldset>

      <Field
        label="Qué viste en el portal"
        htmlFor={`nota-${refund.refundId}`}
        hint="Queda en la auditoría junto a tu nombre. Al menos 10 caracteres."
        required
      >
        <Textarea
          id={`nota-${refund.refundId}`}
          value={note}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      <Button
        variant="outline"
        size="sm"
        onClick={resolve}
        loading={pending}
        disabled={!resolution || note.trim().length < 10}
      >
        Cerrar la devolución
      </Button>
    </div>
  );
}
