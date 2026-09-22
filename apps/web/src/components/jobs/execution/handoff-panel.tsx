"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { KeyRound, Lock } from "lucide-react";

import { Button, Input } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import {
  generateHandoffCodeAction,
  getHandoffCodeAction,
  requestHandoffCodeAction,
  verifyHandoffCodeAction,
} from "@/lib/actions/assignment";

/**
 * Código de entrega.
 *
 * Es la prueba de que las dos personas estuvieron en el mismo lugar al mismo
 * tiempo. Por eso el cliente lo ve y el trabajador lo escribe, nunca al revés,
 * y nunca viaja por el chat ni por una notificación: si lo hiciera, dejaría de
 * probar presencia y pasaría a probar solo que alguien leyó un mensaje.
 */

export function ClientHandoffPanel({
  assignmentId,
  canGenerate,
}: {
  assignmentId: string;
  canGenerate: boolean;
}) {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<{ verified: boolean; expired: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reveal() {
    setError(null);
    startTransition(async () => {
      const existing = await getHandoffCodeAction(assignmentId);
      if (existing.ok && existing.data.exists && existing.data.code) {
        setCode(existing.data.code);
        setState({ verified: existing.data.verified, expired: existing.data.expired });
        return;
      }
      if (existing.ok && existing.data.verified) {
        setState({ verified: true, expired: false });
        return;
      }
      const created = await generateHandoffCodeAction(assignmentId);
      if (!created.ok) {
        setError(created.error);
        return;
      }
      setCode(created.data.code);
      setState({ verified: false, expired: false });
      router.refresh();
    });
  }

  if (state?.verified) {
    return (
      <Alert tone="success" title="Entrega confirmada">
        El trabajador validó el código. El trabajo quedó entregado.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}

      {code ? (
        <>
          <p className="text-sm text-ink-600">
            Dale este código al trabajador solo cuando te entregue lo acordado.
          </p>
          <div className="flex gap-2" aria-label="Código de entrega">
            {code.split("").map((digit, index) => (
              <span
                key={index}
                className="flex h-14 w-12 items-center justify-center rounded-[var(--radius-control)] border border-ink-200 bg-white text-2xl font-semibold tabular-nums text-ink-900"
              >
                {digit}
              </span>
            ))}
          </div>
          <p className="text-xs text-ink-500">
            No lo envíes por el chat. Vale una sola vez y caduca en 12 horas.
          </p>
        </>
      ) : (
        <>
          <p className="flex gap-2 text-sm text-ink-600">
            <Lock size={15} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
            El código aparece solo cuando lo pides, y solo para ti.
          </p>
          <Button variant="outline" fullWidth onClick={reveal} disabled={pending || !canGenerate}>
            {pending ? "Preparando…" : "Ver el código de entrega"}
            <KeyRound size={15} aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  );
}

export function WorkerHandoffPanel({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [pending, startTransition] = useTransition();

  function ask() {
    setError(null);
    startTransition(async () => {
      const result = await requestHandoffCodeAction(assignmentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAsked(true);
    });
  }

  function verify() {
    setError(null);
    startTransition(async () => {
      const result = await verifyHandoffCodeAction(assignmentId, value);
      if (!result.ok) {
        setError(result.error);
        setValue("");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      {asked && !error && (
        <Alert tone="info">Le avisamos al cliente que estás listo para entregar.</Alert>
      )}

      <p className="text-sm text-ink-600">
        Pídele el código al cliente en el momento de la entrega y escríbelo aquí.
      </p>

      <Input
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        value={value}
        onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))}
        placeholder="0000"
        aria-label="Código de entrega de cuatro dígitos"
        className="text-center text-2xl tracking-[0.5em] tabular-nums"
      />

      <Button fullWidth onClick={verify} disabled={pending || value.length !== 4}>
        {pending ? "Validando…" : "Confirmar entrega"}
      </Button>
      <Button variant="ghost" size="sm" fullWidth onClick={ask} disabled={pending}>
        Pedirle el código al cliente
      </Button>
      <p className="text-xs text-ink-500">
        Tienes cinco intentos. Un código equivocado no cierra el trabajo.
      </p>
    </div>
  );
}
