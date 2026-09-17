"use client";

import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button } from "@/components/ui";
import { setAccountModesAction } from "@/lib/actions/account";
import { cn } from "@/lib/utils/cn";

/** Interruptores de modo. La cuenta siempre debe conservar al menos uno. */
export function AccountModes({ isClient, isWorker }: { isClient: boolean; isWorker: boolean }) {
  const [client, setClient] = useState(isClient);
  const [worker, setWorker] = useState(isWorker);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = client !== isClient || worker !== isWorker;

  function save() {
    setError(null);
    setSaved(false);

    if (!client && !worker) {
      setError("Tu cuenta debe mantener al menos un modo activo.");
      return;
    }

    startTransition(async () => {
      const result = await setAccountModesAction(client, worker);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle
          active={client}
          onToggle={() => setClient((v) => !v)}
          title="Necesito ayuda"
          description="Publicar filas, trámites y encargos."
        />
        <Toggle
          active={worker}
          onToggle={() => setWorker((v) => !v)}
          title="Quiero ganar dinero"
          description="Enviar ofertas y tomar trabajos."
        />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {saved && !dirty && <Alert tone="success">Listo, guardamos tu preferencia.</Alert>}

      {dirty && (
        <Button onClick={save} disabled={pending}>
          {pending ? "Guardando…" : "Guardar cambios"}
        </Button>
      )}
    </div>
  );
}

function Toggle({
  active,
  onToggle,
  title,
  description,
}: {
  active: boolean;
  onToggle: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onToggle}
      className={cn(
        "rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors",
        active
          ? "border-brand-600 bg-brand-50/60 ring-1 ring-brand-600"
          : "border-ink-200 bg-white hover:border-brand-200",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink-900">{title}</span>
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
            active ? "bg-brand-600" : "bg-ink-200",
          )}
        >
          <span
            className={cn(
              "h-4 w-4 rounded-full bg-white transition-transform",
              active && "translate-x-4",
            )}
          />
        </span>
      </span>
      <span className="mt-0.5 block text-xs text-ink-500">{description}</span>
    </button>
  );
}
