"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Textarea } from "@/components/ui";
import { cancelJobAction } from "@/lib/actions/jobs";

/** Cancelar pide motivo: queda en la bitácora y explica al trabajador qué pasó. */
export function CancelJobButton({ jobId }: { jobId: string }) {
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
      router.push("/mis-trabajos/publicados");
      router.refresh();
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
      <p className="text-sm text-ink-800">
        ¿Seguro que quieres cancelar? Se rechazarán las ofertas pendientes.
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
