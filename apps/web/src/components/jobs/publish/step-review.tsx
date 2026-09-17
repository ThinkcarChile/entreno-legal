"use client";

import { AlertTriangle, ShieldCheck } from "lucide-react";

import { site } from "@/config/site";
import { CategoryGroup, JobObjectiveType } from "@/lib/domain/enums";
import { urgencyLabels } from "@/lib/domain/labels";
import { communeName, regionName, timezoneFor } from "@/lib/geo/chile";
import { formatDate, formatDuration, formatTime, zonedInputToUtc } from "@/lib/utils/datetime";
import { formatMoney, money, proratePerHour } from "@/lib/utils/money";

import type { StepProps } from "./types";
import type { JobCategory } from "@/lib/domain/types";

export function StepReview({
  draft,
  errors,
  update,
  categories,
}: StepProps & { categories: readonly JobCategory[] }) {
  const category = categories.find((c) => c.id === draft.categoryId);
  const timezone = timezoneFor(draft.regionCode ?? "13", draft.communeCode);

  const startsAt =
    draft.date && draft.time ? zonedInputToUtc(draft.date, draft.time, timezone) : null;
  const duration = draft.durationMinutes ?? 0;
  const hourly = draft.hourlyRate ?? 0;
  const total = hourly > 0 && duration > 0 ? proratePerHour(money(hourly), duration) : null;

  return (
    <div className="space-y-6">
      <dl className="divide-y divide-ink-100 rounded-[var(--radius-card)] border border-ink-200 bg-white">
        <Row label="Categoría" value={category?.name ?? "—"} />
        <Row
          label="Tipo"
          value={category?.group === CategoryGroup.TRAMITE ? "Trámite o gestión" : "Hacer una fila"}
        />
        <Row
          label="Dónde"
          value={
            <>
              {draft.placeName && <span className="block">{draft.placeName}</span>}
              {draft.addressLine ?? "—"}
              <span className="block text-ink-500">
                {draft.communeCode ? communeName(draft.communeCode) : "—"},{" "}
                {draft.regionCode ? regionName(draft.regionCode) : "—"}
              </span>
            </>
          }
        />
        <Row
          label="Cuándo"
          value={
            startsAt ? (
              <>
                <span className="block first-letter:uppercase">{formatDate(startsAt, timezone)}</span>
                <span className="text-ink-500">
                  Desde las {formatTime(startsAt, timezone)} · {formatDuration(duration)} estimadas
                </span>
              </>
            ) : (
              "—"
            )
          }
        />
        <Row label="Título" value={draft.title ?? "—"} />
        <Row
          label="Descripción"
          value={<span className="whitespace-pre-line">{draft.description ?? "—"}</span>}
        />
        {draft.instructions && (
          <Row
            label="Instrucciones"
            value={<span className="whitespace-pre-line">{draft.instructions}</span>}
          />
        )}
        <Row label="Objetivo" value={objectiveText(draft)} />
        {draft.bonusAmount ? (
          <Row
            label="Bono por objetivo"
            value={
              <>
                {formatMoney(money(draft.bonusAmount))}
                {draft.bonusConditions && (
                  <span className="block text-ink-500">{draft.bonusConditions}</span>
                )}
              </>
            }
          />
        ) : null}
        <Row
          label="Precio"
          value={
            <>
              <span className="text-lg font-semibold text-ink-900">
                {total ? formatMoney(total) : "—"}
              </span>
              <span className="block text-ink-500">
                {hourly > 0 ? `${formatMoney(money(hourly))}/h` : "—"} ·{" "}
                {urgencyLabels[draft.urgency ?? "NORMAL"].label}
              </span>
            </>
          }
        />
      </dl>

      <div className="flex gap-3 rounded-[var(--radius-card)] border border-warning-100 bg-warning-50 p-5 text-sm text-warning-800">
        <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">Antes de publicar, confirma que tu encargo es permitido</p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Nadie se hará pasar por ti ni usará tu identidad.</li>
            <li>No es un trámite que exija legalmente la presencia del titular.</li>
            <li>No implica comprar productos ilegales ni realizar acciones ilegales.</li>
            <li>El establecimiento no prohíbe expresamente que un tercero haga la fila.</li>
          </ul>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border border-ink-200 bg-white p-5">
        <input
          type="checkbox"
          checked={draft.acceptsRules ?? false}
          onChange={(event) => update({ acceptsRules: event.target.checked })}
          className="mt-0.5 h-4.5 w-4.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
        />
        <span className="text-sm text-ink-700">
          Confirmo que este encargo cumple las reglas de uso de {site.name} y que la información
          entregada es correcta.
        </span>
      </label>
      {errors.acceptsRules && (
        <p className="text-sm text-danger-600" role="alert">
          {errors.acceptsRules}
        </p>
      )}

      <p className="flex gap-2.5 text-sm text-ink-600">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success-600" aria-hidden="true" />
        Publicar es gratis. Solo pagas cuando aceptas una oferta, y el dinero queda protegido
        hasta que el servicio se complete.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-500">{label}</dt>
      <dd className="text-[0.9375rem] text-ink-800">{value}</dd>
    </div>
  );
}

function objectiveText(draft: StepProps["draft"]): string {
  switch (draft.objectiveType) {
    case JobObjectiveType.HOLD_PLACE:
      return "Mantener el lugar en la fila.";
    case JobObjectiveType.AS_FRONT_AS_POSSIBLE:
      return "Quedar lo más adelante posible.";
    case JobObjectiveType.WITHIN_FIRST_N:
      return `Quedar dentro de los primeros ${draft.targetPosition ?? "—"}.`;
    case JobObjectiveType.COMPLETE_ERRAND:
      return draft.objectiveDescription || "Completar la gestión encargada.";
    default:
      return draft.objectiveDescription || "—";
  }
}
