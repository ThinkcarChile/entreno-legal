"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { MessageSquare } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button } from "@/components/ui";
import { openConversationAction } from "@/lib/actions/chat";
import { acceptOfferAction } from "@/lib/actions/offers";

/**
 * Acciones del cliente sobre una oferta.
 *
 * Aceptar tiene confirmación porque es el punto sin retorno del flujo: fija el
 * precio, descarta al resto y abre el pago.
 */
export function OfferActions({
  offerId,
  jobId,
  workerId,
  workerName,
  total,
}: {
  offerId: string;
  jobId: string;
  workerId: string;
  workerName: string;
  total: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptOfferAction(offerId);
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // Aceptar lleva directo al pago: sin pago confirmado el trabajo no arranca.
      router.push(`/pagar/${result.data.assignmentId}`);
    });
  }

  function chat() {
    setError(null);
    startTransition(async () => {
      const result = await openConversationAction(jobId, workerId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/mensajes/${result.data.conversationId}`);
    });
  }

  if (confirming) {
    return (
      <div className="w-full space-y-3 rounded-[var(--radius-control)] border border-brand-200 bg-brand-50/60 p-4">
        <p className="text-small text-ink-800">
          Vas a contratar a <strong className="font-medium">{workerName}</strong> por{" "}
          <strong className="font-medium">{total}</strong>. Las demás ofertas quedarán
          rechazadas y el siguiente paso es el pago.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex gap-2">
          <Button size="sm" onClick={accept} disabled={pending}>
            {pending ? "Aceptando…" : "Confirmar y pagar"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
            Volver
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={chat} disabled={pending}>
          <MessageSquare size={15} aria-hidden="true" />
          Conversar
        </Button>
        <Button size="sm" onClick={() => setConfirming(true)} disabled={pending}>
          Aceptar oferta
        </Button>
      </div>
    </div>
  );
}
