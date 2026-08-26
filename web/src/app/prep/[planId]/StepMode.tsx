"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SuggestedPackage } from "@/domain/prep/types";
import { completeTask, createLabelsForTask, skipTask } from "../actions";
import type { PrepPlanView, PrepTaskView } from "../queries";
import { ButtonOutline, Card, Chip, ErrorNote, Icon, LinkButton, Notice } from "@/components/ui";

/**
 * Modo cocina (§16, §58): UN paso por vez, tipografía y botones GRANDES,
 * poco texto, para usar de pie con las manos ocupadas. La cantidad REAL que
 * digita la persona manda sobre la planificada (§18).
 */

/** Campo de formulario del kit: mismo alto de toque en todos lados. */
const FIELD =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

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
      // Gate 0→10 [L-2]: esto NO se limpiaba. Como el estado va por posición
      // (0,1,2…) y `router.refresh()` no desmonta el componente, el "al vacío"
      // y la ubicación del paso anterior se aplicaban solos a los paquetes del
      // paso siguiente. El ledger es append-only: se registraba una mentira que
      // después hay que corregir a mano.
      setPaqueteUbicacion({});
      setPaqueteVacio({});
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
          // §19: la ubicación CONCRETA la elige la persona; la sugerida es el
          // default. Gate 0→10 [L-1]: "Sin mover" vale "" y con `||` se caía al
          // default sugerido — la pantalla decía una cosa y el ledger guardaba
          // otra (el paquete terminaba congelado sin que nadie lo pidiera).
          // Sin tocar = undefined = sugerida. Elegido "Sin mover" = null.
          location_id:
            paqueteUbicacion[i] === undefined
              ? ubicacionPara(p.storage)
              : paqueteUbicacion[i] === ""
                ? null
                : paqueteUbicacion[i]!,
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
      <main className="mx-auto flex min-h-dvh max-w-[36rem] flex-col justify-center gap-lg bg-background px-container-margin py-xl text-center">
        <span className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
          <Icon name="check_circle" filled className="text-[40px]" />
        </span>
        <div>
          <h1 className="font-headline-lg text-headline-lg text-on-surface">Plan terminado</h1>
          <p className="mt-sm font-body-md text-body-md text-on-surface-variant">
            {tareas.filter((t) => t.status === "DONE").length} tareas hechas ·{" "}
            {tareas.filter((t) => t.status === "SKIPPED").length} saltadas
          </p>
        </div>
        {conEtiquetas.map((t) => (
          <LabelButtons key={t.id} task={t} pending={pending} run={run} />
        ))}
        <LinkButton href="/prep" className="w-full">
          <Icon name="arrow_back" className="text-[18px]" />
          Volver a preparación
        </LinkButton>
        {message && (
          <p className="font-body-sm text-body-sm text-on-surface-variant">{message}</p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </main>
    );
  }

  const esPortion = ["PORTION", "PACK"].includes(actual.task_type);
  const avance = Math.round(((paso - 1) / tareas.length) * 100);

  return (
    <main className="mx-auto flex min-h-dvh max-w-[36rem] flex-col bg-background">
      <header className="sticky top-0 z-40 flex items-center justify-between gap-sm bg-background px-container-margin py-md">
        <Link
          href="/prep"
          aria-label="Salir del modo cocina"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container"
        >
          <Icon name="close" />
        </Link>
        <p className="min-w-0 text-center font-label-md text-label-md uppercase text-on-surface-variant">
          Paso {paso} de {tareas.length}
        </p>
        <span className="h-10 w-10 shrink-0" aria-hidden />
      </header>

      <div className="h-1 w-full bg-surface-container-high">
        <div className="h-full bg-primary transition-all duration-300" style={{ width: `${avance}%` }} />
      </div>

      <section className="flex flex-1 flex-col gap-md px-container-margin py-lg">
        {actual.block_label && <Chip icon="label">{actual.block_label}</Chip>}

        <div>
          <h1 className="font-headline-xl text-headline-xl text-on-surface">{actual.label}</h1>
          {actual.planned_quantity != null && (
            <p className="mt-sm font-headline-md text-headline-md font-normal text-on-surface-variant">
              Preparar {actual.planned_quantity} {(actual.unit ?? "").toLowerCase()}
            </p>
          )}
          {params.cutLabel && (
            <p className="mt-xs font-headline-sm text-headline-sm font-normal text-on-surface-variant">
              Corte: {params.cutLabel}
            </p>
          )}
        </div>

        {(params.equipmentName || params.manualAlternative) && (
          <Card className="flex items-center gap-md p-md">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-surface-container-low text-primary">
              <Icon name={params.equipmentName ? "blender" : "pan_tool"} filled className="text-[28px]" />
            </span>
            <div className="min-w-0">
              <p className="font-headline-sm text-headline-sm text-on-surface">
                {params.equipmentName ?? "A mano"}
              </p>
              {params.equipmentName && params.batches && params.batches > 1 && (
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {params.batches} tandas
                </p>
              )}
              {params.manualAlternative && (
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Alternativa: {params.manualAlternative}
                </p>
              )}
            </div>
          </Card>
        )}

        {(params.reasons ?? []).length > 0 && (
          <ul className="space-y-1">
            {(params.reasons ?? []).map((r) => (
              <li
                key={r}
                className="flex items-start gap-sm font-body-sm text-body-sm text-on-surface-variant"
              >
                <Icon name="info" className="mt-0.5 shrink-0 text-[16px]" />
                <span className="min-w-0">{r}</span>
              </li>
            ))}
          </ul>
        )}

        {params.safety?.verdict === "REVIEW_REQUIRED" && (
          <Notice icon="warning">
            Sin regla de seguridad validada para este guardado: decide tú.
          </Notice>
        )}

        {esPortion && (params.packages ?? []).length > 0 && (
          <div className="space-y-sm">
            {(params.packages ?? []).map((p, i) => (
              <Card key={i} className="flex items-start gap-md p-md">
                <div className="min-w-0 flex-1">
                  <p className="font-body-md text-body-md font-semibold text-on-surface">
                    {p.intendedUseDate ? `Para el ${p.intendedUseDate}` : "Reserva"}
                    {p.mealType && ` · ${p.mealType.toLowerCase()}`}
                  </p>
                  <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
                    {p.storage === "FREEZE"
                      ? "Congelar"
                      : p.storage === "REFRIGERATE"
                        ? "Refrigerar"
                        : "Guardado: revisar"}
                  </p>
                  <label className="mt-sm flex items-center gap-sm font-body-sm text-body-sm text-on-surface-variant">
                    <input
                      type="checkbox"
                      className="size-5 accent-primary"
                      checked={paqueteVacio[i] ?? false}
                      onChange={(e) => setPaqueteVacio((prev) => ({ ...prev, [i]: e.target.checked }))}
                    />
                    Sellado al vacío
                  </label>
                  <select
                    aria-label="Dónde queda este paquete"
                    value={paqueteUbicacion[i] ?? ubicacionPara(p.storage) ?? ""}
                    onChange={(e) => setPaqueteUbicacion((prev) => ({ ...prev, [i]: e.target.value }))}
                    className={`${FIELD} mt-sm`}
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
                  aria-label="Cantidad real del paquete"
                  placeholder={String(p.quantity)}
                  value={paquetesReales[i] ?? ""}
                  onChange={(e) => setPaquetesReales((prev) => ({ ...prev, [i]: e.target.value }))}
                  className="w-24 shrink-0 rounded-xl border border-outline-variant bg-surface-container-lowest px-sm py-md text-right font-headline-sm text-headline-sm text-on-surface"
                />
              </Card>
            ))}
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Ajusta los gramos si la realidad fue distinta: lo que digites es lo que queda
              registrado.
            </p>
          </div>
        )}

        {!esPortion && actual.planned_quantity != null && (
          <label className="block font-body-sm text-body-sm text-on-surface-variant">
            ¿Preparaste otra cantidad? (opcional)
            <input
              type="number"
              inputMode="decimal"
              placeholder={String(actual.planned_quantity)}
              value={cantidadReal}
              onChange={(e) => setCantidadReal(e.target.value)}
              className={`${FIELD} mt-1 py-md font-headline-sm text-headline-sm`}
            />
          </label>
        )}
      </section>

      <footer className="sticky bottom-0 space-y-sm bg-background/95 px-container-margin pt-md pb-lg backdrop-blur-sm">
        {message && (
          <p className="font-body-sm text-body-sm text-on-surface-variant">{message}</p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        {!dependenciaLista && (
          <Notice icon="lock">Primero completa el paso del que depende esta tarea.</Notice>
        )}

        <button
          type="button"
          disabled={pending || !dependenciaLista}
          onClick={confirmar}
          className="elevated-shadow flex w-full items-center justify-center gap-sm rounded-xl bg-primary px-lg py-4 font-headline-md text-headline-md text-on-primary transition-transform active:scale-[0.98] disabled:opacity-40"
        >
          <Icon name="check_circle" filled className="text-[28px]" />
          LISTO
        </button>
        <ButtonOutline
          disabled={pending}
          onClick={() => run(() => skipTask(actual.id))}
          className="w-full"
        >
          Saltar este paso
        </ButtonOutline>
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
    <div className="space-y-sm">
      <ButtonOutline
        disabled={pending}
        onClick={() =>
          run(async () => {
            const r = await createLabelsForTask(task.id);
            if (r.ok && r.jobIds) setJobs(r.jobIds);
            return r;
          })
        }
        className="w-full"
      >
        <Icon name="label" className="text-[18px]" />
        Generar etiquetas de {task.label}
      </ButtonOutline>
      {jobs.length > 0 && (
        <a
          href={`/api/labels?jobs=${jobs.join(",")}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-full items-center justify-center gap-sm rounded-full bg-inverse-surface px-lg py-sm font-body-md text-body-sm font-semibold text-inverse-on-surface"
        >
          <Icon name="picture_as_pdf" className="text-[18px]" />
          Abrir PDF ({jobs.length} etiquetas)
        </a>
      )}
    </div>
  );
}
