"use client";

import { useEffect, useState } from "react";

import { Clock } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Tiempo transcurrido del trabajo.
 *
 * El contador se reconstruye desde `startedAt`, que es hora del servidor, en
 * cada render y en cada recarga. No se guarda nada en el cliente: si el estado
 * viviera en React, bastaría con recargar la página para que el trabajo pareciera
 * empezar de nuevo, y ese número acaba delante de alguien que discute una hora.
 */
export function WorkTimer({
  startedAt,
  expectedEndAt,
  completedAt,
}: {
  startedAt: string;
  expectedEndAt: string | null;
  /** Si el trabajo ya terminó, el contador se congela ahí. */
  completedAt?: string | null;
}) {
  const start = new Date(startedAt).getTime();
  const end = expectedEndAt ? new Date(expectedEndAt).getTime() : null;
  const frozen = completedAt ? new Date(completedAt).getTime() : null;

  const [now, setNow] = useState(() => frozen ?? Date.now());

  useEffect(() => {
    if (frozen) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [frozen]);

  const elapsed = Math.max(0, Math.floor((now - start) / 1000));
  const total = end ? Math.max(1, Math.floor((end - start) / 1000)) : null;
  const percent = total ? Math.min(100, Math.round((elapsed / total) * 100)) : null;
  const overtime = total != null && elapsed > total;

  return (
    <div
      className={cn(
        "rounded-[var(--radius-control)] p-4",
        overtime ? "bg-danger-50" : "bg-brand-50/70",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Clock
          size={18}
          className={overtime ? "text-danger-600" : "text-brand-600"}
          aria-hidden="true"
        />
        <div>
          <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">
            {frozen ? "Tiempo trabajado" : "Tiempo transcurrido"}
          </p>
          <p
            className="text-2xl font-semibold tabular-nums text-ink-900"
            aria-live="off"
            suppressHydrationWarning
          >
            {formatElapsed(elapsed)}
          </p>
        </div>
      </div>

      {percent != null && (
        <div className="mt-3">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-white"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Avance del tiempo acordado"
          >
            <div
              className={cn("h-full rounded-full", overtime ? "bg-danger-500" : "bg-brand-500")}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-600">
            {overtime
              ? "Se pasó del tiempo acordado. Se puede pedir más tiempo al cliente."
              : `${percent} % del tiempo acordado`}
          </p>
        </div>
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
