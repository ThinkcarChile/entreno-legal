"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Textarea } from "@/components/ui";
import { cancelJobAction } from "@/lib/actions/jobs";

/** Cancelar pide motivo: queda en la bitácora y explica al trabajador qué pasó. */
export function CancelJobButton({
  jobId,
  hasPaymentInFlight = false,
}: {
  jobId: string;
  /** Hay un pago iniciado en el proveedor y sin respuesta todavía. */
  hasPaymentInFlight?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function cancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelJobAction(jobId, reason || undefined);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Si había un pago en vuelo, el trabajo queda «en verificación» y la
      // página lo explica: se recarga en el sitio en vez de irse a la lista.
      router.refresh();
      if (!hasPaymentInFlight) router.push("/mis-trabajos/publicados");
    });
  }

  if (!confirming) {
    return (
      <Button variant="ghost" fullWidth onClick={() => setConfirming(true)}>
        Cancelar trabajo
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-danger-100 bg-danger-50/60 p-4">
      <p className="text-small text-ink-800">
        {hasPaymentInFlight
          ? "¿Seguro que quieres cancelar? Hay un pago en curso: verificaremos su estado antes de completar la cancelación, y si llegó a cobrarse quedará registrado para devolución."
          : "¿Seguro que quieres cancelar? Se rechazarán las ofertas pendientes."}
      </p>
      <Textarea
        rows={2}
        value={reason}
        maxLength={300}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Motivo (opcional)"
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button variant="danger" size="sm" onClick={cancel} disabled={pending}>
          {pending ? "Cancelando…" : "Sí, cancelar"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
          Volver
        </Button>
      </div>
    </div>
  );
}
