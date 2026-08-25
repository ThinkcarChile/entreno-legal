"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelPlan, generatePrepPlan } from "./actions";
import type { PrepPlanView } from "./queries";

const ESTADO: Record<string, string> = {
  DRAFT: "borrador",
  READY: "listo para partir",
  IN_PROGRESS: "en curso",
  COMPLETED: "completado",
  CANCELLED: "cancelado",
};

export function PrepHome({ plans }: { plans: PrepPlanView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string; planId?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "No se pudo completar.");
        return;
      }
      if (r.message) setMessage(r.message);
      if (r.planId) router.push(`/prep/${r.planId}`);
      else router.refresh();
    });
  }

  const vivos = plans.filter((p) => ["READY", "IN_PROGRESS", "DRAFT"].includes(p.status));
  const pasados = plans.filter((p) => ["COMPLETED", "CANCELLED"].includes(p.status)).slice(0, 6);

  return (
    <div className="space-y-5">
      {message && (
        <p className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm text-white shadow-lg">
          {message}
        </p>
      )}
      {error && (
        <p
          className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-red-600 px-4 py-2.5 text-sm text-white shadow-lg"
          role="alert"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => run(generatePrepPlan)}
        className="w-full rounded-2xl bg-[var(--accent)] px-6 py-4 text-base font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Calculando…" : "Preparar compra / stock"}
      </button>
      <p className="-mt-3 text-center text-[10px] text-[var(--ink)]/40">
        Genera la sugerencia. Nada cambia en la despensa hasta que confirmes cada paso.
      </p>

      {vivos.length === 0 && pasados.length === 0 && (
        <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-6 text-center text-sm text-[var(--ink)]/60">
          Sin planes todavía. Cuando recibas una compra o tengas stock sin preparar y comidas
          confirmadas, genera el plan acá.
        </p>
      )}

      {vivos.map((p) => (
        <PlanCard key={p.id} plan={p} onCancel={() => run(() => cancelPlan(p.id))} pending={pending} />
      ))}

      {pasados.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Anteriores</h2>
          <ul className="space-y-1.5">
            {pasados.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/prep/${p.id}`}
                  className="block rounded-xl border border-[var(--ink)]/10 bg-white px-4 py-2.5 text-xs text-[var(--ink)]/70"
                >
                  {p.plan_date} · {ESTADO[p.status]} ·{" "}
                  {p.batch_prep_tasks.filter((t) => t.status === "DONE").length}/{p.batch_prep_tasks.length} tareas
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  onCancel,
  pending,
}: {
  plan: PrepPlanView;
  onCancel: () => void;
  pending: boolean;
}) {
  const hechas = plan.batch_prep_tasks.filter((t) => t.status === "DONE").length;
  const summary = plan.summary as {
    estimatedMinutes?: number;
    packages?: number;
    labels?: number;
    foods?: number;
    warnings?: string[];
    leave_whole?: { label: string; quantity: number; unit: string; reason: string }[];
    thaw_suggestions?: { label: string; plan: { kind: string; note?: string; reason?: string } }[];
  };
  const bloques = [...new Set(plan.batch_prep_tasks.map((t) => t.block_label).filter(Boolean))] as string[];

  return (
    <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">Plan del {plan.plan_date}</p>
          <p className="text-xs text-[var(--ink)]/60">
            ~{summary.estimatedMinutes ?? "?"} min · {plan.batch_prep_tasks.length} tareas ·{" "}
            {summary.foods ?? 0} alimentos · {summary.packages ?? 0} paquetes · {summary.labels ?? 0} etiquetas
          </p>
          <p className="text-xs text-[var(--ink)]/60">
            {hechas}/{plan.batch_prep_tasks.length} completadas · {ESTADO[plan.status]}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          <Link
            href={`/prep/${plan.id}`}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-center text-sm font-medium text-white"
          >
            Modo cocina
          </Link>
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="text-xs text-red-700 underline disabled:opacity-50"
          >
            Cancelar plan
          </button>
        </div>
      </div>

      {bloques.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {bloques.map((b) => {
            const del = plan.batch_prep_tasks.filter((t) => t.block_label === b);
            const listas = del.filter((t) => t.status !== "PENDING").length;
            return (
              <span key={b} className="rounded-full bg-[var(--paper)] px-2.5 py-1 text-[10px] text-[var(--ink)]/70">
                {b} {listas}/{del.length}
              </span>
            );
          })}
        </div>
      )}

      {(summary.warnings ?? []).map((w) => (
        <p key={w} className="mt-2 text-xs text-amber-700">
          ⚠ {w}
        </p>
      ))}
      {(summary.leave_whole ?? []).map((l) => (
        <p key={l.label + l.quantity} className="mt-2 rounded-xl bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink)]/70">
          Dejar sin preparar: <strong>{l.quantity} {l.unit.toLowerCase()} de {l.label}</strong> — {l.reason}
        </p>
      ))}
      {(summary.thaw_suggestions ?? []).map((t, i) => (
        <p key={i} className="mt-2 rounded-xl bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink)]/70">
          Descongelar: <strong>{t.label}</strong> —{" "}
          {t.plan.kind === "SCHEDULED" ? t.plan.note : `revisar descongelado (${t.plan.reason ?? "sin regla"})`}
        </p>
      ))}
    </section>
  );
}
