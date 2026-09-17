"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Input } from "@/components/ui";
import { reviewVerificationAction } from "@/lib/actions/admin";

/** Aprobar o rechazar una verificación. Rechazar exige un motivo entendible. */
export function VerificationReview({ verificationId }: { verificationId: string }) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function resolve(status: "VERIFIED" | "REJECTED") {
    setError(null);
    if (status === "REJECTED" && reason.trim().length < 5) {
      setError("Escribe un motivo: la persona lo verá para poder corregirlo.");
      return;
    }

    startTransition(async () => {
      const result = await reviewVerificationAction(verificationId, status, reason || undefined);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="w-full sm:w-auto">
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}

      {rejecting ? (
        <div className="space-y-2 sm:w-72">
          <Input
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Motivo del rechazo"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={() => resolve("REJECTED")} disabled={pending}>
              {pending ? "Guardando…" : "Rechazar"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)} disabled={pending}>
              Volver
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => resolve("VERIFIED")} disabled={pending}>
            {pending ? "Guardando…" : "Aprobar"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={pending}>
            Rechazar
          </Button>
        </div>
      )}
    </div>
  );
}
