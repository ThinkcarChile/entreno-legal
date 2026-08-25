"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SuggestedPackage } from "@/domain/prep/types";
import { completeTask, createLabelsForTask, skipTask } from "../actions";
import type { PrepPlanView, PrepTaskView } from "../queries";

/**
 * Modo cocina (§16, §58): UN paso por vez, tipografía y botones GRANDES,
 * poco texto, para usar de pie con las manos ocupadas. La cantidad REAL que
 * digita la persona manda sobre la planificada (§18).
 */
export function StepMode({
  plan,
  locations,
}: {
  plan: PrepPlanView;
  locations: { id: string; name: string; kind: "PANTRY" | "FRIDGE" | "FREEZER" | "OTHER" }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cantidadReal, setCantidadReal] = useState("");
  const [paquetesReales, setPaquetesReales] = useState<Record<number, string>>({});
  const [paqueteUbicacion, setPaqueteUbicacion] = useState<Record<number, string>>({});
  const [paqueteVacio, setPaqueteVacio] = useState<Record<number, boolean>>({});

  const tareas = plan.batch_prep_tasks;
  const pendientes = tareas.filter((t) => t.status === "PENDING");
  const actual = pendientes[0] ?? null;
  const paso = actual ? tareas.findIndex((t) => t.id === actual.id) + 1 : tareas.length;

  const params = (actual?.params ?? {}) as {
    equipmentName?: string | null;
    cutLabel?: string | null;
    manualAlternative?: string | null;
    batches?: number;
    packages?: SuggestedPackage[];
    safety?: { verdict: string; source?: string | null };
    reasons?: string[];
  };

  const dependenciaLista = useMemo(() => {
    if (!actual?.depends_on) return true;
    const dep = tareas.find((t) => t.id === actual.depends_on);
    return dep == null || dep.status === "DONE" || dep.status === "SKIPPED";
  }, [actual, tareas]);

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "No se pudo completar.");
        return;
      }
      if (r.message) setMessage(r.message);
      setCantidadReal("");
      setPaquetesReales({});
      router.refresh();
    });
  }

  function ubicacionPara(storage: string | undefined): string | null {
    const kind = storage === "FREEZE" ? "FREEZER" : storage === "REFRIGERATE" ? "FRIDGE" : null;
    if (!kind) return null;
    return locations.find((l) => l.kind === kind)?.id ?? null;
  }

  function confirmar() {
    if (!actual) return;
    const esTransform = ["PEEL", "TRIM", "CUT", "SHRED", "SLICE", "DICE"].includes(actual.task_type);
    const esPortion = ["PORTION", "PACK"].includes(actual.task_type);

    if (cantidadReal.trim() !== "" && !Number.isFinite(Number(cantidadReal))) {
      setError("La cantidad no se entiende: revisa el número.");
      return;
    }
    const real = cantidadReal.trim() === "" ? null : Number(cantidadReal);

    if (esPortion) {
      const sugeridos = params.packages ?? [];
      const paquetes = sugeridos.map((p, i) => {
        const texto = paquetesReales[i]?.trim() ?? "";
        const q = texto === "" ? p.quantity : Number(texto);
        return {
          quantity: q,
          // §19: la ubicación CONCRETA la elige la persona; la sugerida es el default.
          location_id: paqueteUbicacion[i] || ubicacionPara(p.storage),
          // §74: el sellado es EMPAQUE — el RPC no toca temperatura ni fechas.
          vacuum: paqueteVacio[i] ?? false,
          intended_use_date: p.intendedUseDate,
          intended_assignment_id: p.intendedAssignmentId,
        };
      });
      if (paquetes.some((p) => !Number.isFinite(p.quantity) || p.quantity <= 0)) {
        setError("Cada paquete necesita una cantidad mayor que cero.");
        return;
      }
      run(() => completeTask({ taskId: actual.id, actualQuantity: real, outputs: { packages: paquetes } }));
      return;
    }
    if (esTransform) {
      run(() => completeTask({ taskId: actual.id, actualQuantity: real, outputs: null }));
      return;
    }
    run(() => completeTask({ taskId: actual.id, actualQuantity: real }));
  }

  if (!actual) {
    const conEtiquetas = tareas.filter(
      (t) => t.status === "DONE" && ((t.result as { child_lot_ids?: string[] })?.child_lot_ids?.length ?? 0) > 0,
    );
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-10 text-center">
        <p className="text-5xl">✅</p>
        <h1 className="text-2xl font-semibold">Plan terminado</h1>
        <p className="text-sm text-[var(--ink)]/60">
          {tareas.filter((t) => t.status === "DONE").length} tareas hechas ·{" "}
          {tareas.filter((t) => t.status === "SKIPPED").length} saltadas
        </p>
        {conEtiquetas.map((t) => (
          <LabelButtons key={t.id} task={t} pending={pending} run={run} />
        ))}
        <Link href="/prep" className="rounded-2xl bg-[var(--accent)] px-6 py-4 text-lg font-semibold text-white">
          Volver a preparación
        </Link>
        {message && <p className="text-sm text-[var(--ink)]/70">{message}</p>}
        {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      </main>
    );
  }

  const esPortion = ["PORTION", "PACK"].includes(actual.task_type);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col px-5 py-6">
      <header className="mb-4 flex items-center justify-between text-xs text-[var(--ink)]/50">
        <Link href="/prep" className="underline">← Salir</Link>
        <span>
          PASO {paso} DE {tareas.length}
        </span>
      </header>

      <section className="flex flex-1 flex-col gap-4">
        {actual.block_label && (
          <span className="w-fit rounded-full bg-[var(--paper)] px-3 py-1 text-xs font-medium text-[var(--ink)]/70">
            {actual.block_label}
          </span>
        )}
        <h1 className="text-3xl font-bold leading-tight">{actual.label}</h1>

        {actual.planned_quantity != null && (
          <p className="text-xl">
            Preparar: <strong>{actual.planned_quantity} {(actual.unit ?? "").toLowerCase()}</strong>
          </p>
        )}
        {params.cutLabel && (
          <p className="text-lg">
            Corte: <strong>{params.cutLabel}</strong>
          </p>
        )}
        {params.equipmentName && (
          <p className="text-lg">
            Equipo: <strong>{params.equipmentName}</strong>
            {params.batches && params.batches > 1 && <> · {params.batches} tandas</>}
          </p>
        )}
        {params.manualAlternative && (
          <p className="text-sm text-[var(--ink)]/60">Alternativa: {params.manualAlternative}</p>
        )}
        {(params.reasons ?? []).map((r) => (
          <p key={r} className="text-sm text-[var(--ink)]/60">· {r}</p>
        ))}
        {params.safety?.verdict === "REVIEW_REQUIRED" && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            ⚠ Sin regla de seguridad validada para este guardado: decide tú.
          </p>
        )}

        {esPortion && (params.packages ?? []).length > 0 && (
          <div className="space-y-2">
            {(params.packages ?? []).map((p, i) => (
              <div key={i} className="flex items-center gap-2 rounded-xl border border-[var(--ink)]/10 bg-white p-3">
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">
                    {p.intendedUseDate ? `Para el ${p.intendedUseDate}` : "Reserva"}
                    {p.mealType && ` · ${p.mealType.toLowerCase()}`}
                  </p>
                  <p className="text-xs text-[var(--ink)]/60">
                    {p.storage === "FREEZE" ? "Congelar" : p.storage === "REFRIGERATE" ? "Refrigerar" : "Guardado: revisar"}
                  </p>
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--ink)]/60">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={paqueteVacio[i] ?? false}
                      onChange={(e) => setPaqueteVacio((prev) => ({ ...prev, [i]: e.target.checked }))}
                    />
                    Sellado al vacío
                  </label>
                  <select
                    value={paqueteUbicacion[i] ?? ubicacionPara(p.storage) ?? ""}
                    onChange={(e) => setPaqueteUbicacion((prev) => ({ ...prev, [i]: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-[var(--ink)]/15 bg-white px-2 py-1.5 text-xs"
                  >
                    <option value="">Sin mover</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder={String(p.quantity)}
                  value={paquetesReales[i] ?? ""}
                  onChange={(e) => setPaquetesReales((prev) => ({ ...prev, [i]: e.target.value }))}
                  className="w-24 rounded-xl border border-[var(--ink)]/20 px-3 py-3 text-right text-lg"
                />
              </div>
            ))}
            <p className="text-[10px] text-[var(--ink)]/40">
              Ajusta los gramos si la realidad fue distinta: lo que digites es lo que queda registrado.
            </p>
          </div>
        )}

        {!esPortion && actual.planned_quantity != null && (
          <label className="text-sm text-[var(--ink)]/60">
            ¿Preparaste otra cantidad? (opcional)
            <input
              type="number"
              inputMode="decimal"
              placeholder={String(actual.planned_quantity)}
              value={cantidadReal}
              onChange={(e) => setCantidadReal(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--ink)]/20 bg-white px-4 py-3 text-lg"
            />
          </label>
        )}
      </section>

      {message && <p className="mb-2 text-sm text-[var(--ink)]/70">{message}</p>}
      {error && (
        <p className="mb-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {!dependenciaLista && (
        <p className="mb-2 text-sm text-amber-700">Primero completa el paso del que depende esta tarea.</p>
      )}

      <footer className="mt-4 space-y-2">
        <button
          type="button"
          disabled={pending || !dependenciaLista}
          onClick={confirmar}
          className="w-full rounded-2xl bg-[var(--accent)] px-6 py-5 text-2xl font-bold text-white disabled:opacity-50"
        >
          LISTO
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => skipTask(actual.id))}
          className="w-full rounded-2xl border border-[var(--ink)]/20 px-6 py-3 text-sm text-[var(--ink)]/70 disabled:opacity-50"
        >
          Saltar este paso
        </button>
      </footer>
    </main>
  );
}

function LabelButtons({
  task,
  pending,
  run,
}: {
  task: PrepTaskView;
  pending: boolean;
  run: (a: () => Promise<{ ok: boolean; error?: string; message?: string; jobIds?: string[] }>) => void;
}) {
  const [jobs, setJobs] = useState<string[]>([]);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          run(async () => {
            const r = await createLabelsForTask(task.id);
            if (r.ok && r.jobIds) setJobs(r.jobIds);
            return r;
          })
        }
        className="w-full rounded-2xl border border-[var(--accent)] px-6 py-3 text-base font-medium text-[var(--accent)] disabled:opacity-50"
      >
        Generar etiquetas de {task.label}
      </button>
      {jobs.length > 0 && (
        <a
          href={`/api/labels?jobs=${jobs.join(",")}`}
          target="_blank"
          rel="noreferrer"
          className="block w-full rounded-2xl bg-[var(--ink)] px-6 py-3 text-base font-medium text-white"
        >
          Abrir PDF ({jobs.length} etiquetas)
        </a>
      )}
    </div>
  );
}
