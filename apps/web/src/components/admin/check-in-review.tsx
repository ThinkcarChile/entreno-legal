"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, Input } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { reviewCheckInAction } from "@/lib/actions/admin";

/**
 * Aprobar o rechazar una llegada que no se verificó sola.
 *
 * El motivo es obligatorio en los dos casos y se le muestra al trabajador: una
 * decisión que afecta a si alguien puede o no empezar a trabajar tiene que
 * poder explicarse.
 */
export function CheckInReviewActions({ checkInId }: { checkInId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function resolve(approved: boolean) {
    setError(null);
    if (reason.trim().length < 5) {
      setError("Escribe el motivo: el trabajador lo va a leer.");
      return;
    }
    startTransition(async () => {
      const result = await reviewCheckInAction(checkInId, approved, reason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="w-full space-y-2.5 sm:max-w-sm">
      {error && <Alert tone="danger">{error}</Alert>}
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={300}
        placeholder="Motivo de la decisión"
        aria-label="Motivo de la decisión"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => resolve(true)} disabled={pending}>
          {pending ? "Guardando…" : "Aprobar llegada"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => resolve(false)} disabled={pending}>
          Rechazar
        </Button>
      </div>
    </div>
  );
}
