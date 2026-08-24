"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StockTarget } from "@/domain/stock/types";
import { deleteStockTarget, setStockTarget } from "@/app/stock/actions";

/**
 * §32: "¿Cuánto quieres mantener en casa?" — el objetivo lo declara el hogar y
 * el sistema jamás lo cambia solo.
 */
export function ItemDetailActions({
  ingredientId,
  label,
  unit,
  target,
}: {
  ingredientId: string;
  label: string;
  unit: "G" | "ML" | "UNIT";
  target: StockTarget | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);

  const [minimo, setMinimo] = useState(target?.minimumQuantity?.toString() ?? "");
  const [objetivo, setObjetivo] = useState(target?.targetQuantity?.toString() ?? "");
  const [dias, setDias] = useState(target?.targetDaysOfSupply?.toString() ?? "");
  const [ciclo, setCiclo] = useState(target?.reviewCycle ?? "");
  const [reponer, setReponer] = useState(target?.reorderEnabled ?? true);

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo completar.");
        return;
      }
      if (result.message) setMessage(result.message);
      setEditando(false);
      router.refresh();
    });
  }

  const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";
  const sufijo = unit === "G" ? "g" : unit === "ML" ? "ml" : "unidades";

  return (
    <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
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

      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Objetivo de stock</h2>
        {!editando && (
          <button
            type="button"
            onClick={() => setEditando(true)}
            className="rounded-full border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]"
          >
            {target ? "Cambiar objetivo" : "Definir objetivo"}
          </button>
        )}
      </div>

      {!editando ? (
        <p className="mt-1 text-xs text-[var(--ink)]/60">
          {!target && "Sin objetivo declarado: se usa un horizonte de 7 días por defecto."}
          {target && !target.reorderEnabled && "Pediste no recibir recomendaciones para este alimento."}
          {target && target.reorderEnabled && (
            <>
              {target.minimumQuantity != null && <>mínimo {target.minimumQuantity} {sufijo} · </>}
              {target.targetQuantity != null && <>objetivo {target.targetQuantity} {sufijo} · </>}
              {target.targetDaysOfSupply != null && <>{target.targetDaysOfSupply} días de cobertura · </>}
              {target.reviewCycle && <>revisión {cicloTexto(target.reviewCycle)} · </>}
              fuente {target.source === "USER_DEFINED" ? "tuya" : "sugerida"}
            </>
          )}
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-[var(--ink)]/60">
            ¿Cuánto quieres mantener de {label} en casa? Deja en blanco lo que no aplique.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-[var(--ink)]/60">
              Cantidad mínima ({sufijo})
              <input
                type="number"
                min="0"
                step="any"
                value={minimo}
                onChange={(e) => setMinimo(e.target.value)}
                className={`${field} mt-1`}
              />
            </label>
            <label className="text-xs text-[var(--ink)]/60">
              Cantidad objetivo ({sufijo})
              <input
                type="number"
                min="0"
                step="any"
                value={objetivo}
                onChange={(e) => setObjetivo(e.target.value)}
                className={`${field} mt-1`}
              />
            </label>
            <label className="text-xs text-[var(--ink)]/60">
              Días de cobertura
              <input
                type="number"
                min="1"
                max="90"
                value={dias}
                onChange={(e) => setDias(e.target.value)}
                className={`${field} mt-1`}
              />
            </label>
            <label className="text-xs text-[var(--ink)]/60">
              Revisión
              <select value={ciclo} onChange={(e) => setCiclo(e.target.value)} className={`${field} mt-1`}>
                <option value="">Sin ciclo fijo</option>
                <option value="WEEKLY">Semanal</option>
                <option value="BIWEEKLY">Quincenal</option>
                <option value="MONTHLY">Mensual</option>
                <option value="MIN_STOCK">Por stock mínimo</option>
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="size-4"
              checked={!reponer}
              onChange={(e) => setReponer(!e.target.checked)}
            />
            No recomendar reposición para este alimento
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEditando(false)}
              className="flex-1 rounded-full border border-[var(--ink)]/20 px-4 py-2 text-sm"
            >
              Cancelar
            </button>
            {target && (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => deleteStockTarget(ingredientId))}
                className="flex-1 rounded-full border border-red-200 px-4 py-2 text-sm text-red-700 disabled:opacity-50"
              >
                Quitar objetivo
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                const num = (s: string) => {
                  const t = s.trim();
                  if (t === "") return null;
                  const n = Number(t);
                  return Number.isFinite(n) ? n : null;
                };
                run(() =>
                  setStockTarget({
                    ingredientId,
                    unit,
                    minimumQuantity: num(minimo),
                    targetQuantity: num(objetivo),
                    targetDaysOfSupply: dias.trim() === "" ? null : Number(dias),
                    reviewCycle: (ciclo || null) as "WEEKLY" | null,
                    reorderEnabled: reponer,
                  }),
                );
              }}
              className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Guardar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function cicloTexto(c: string): string {
  return (
    { WEEKLY: "semanal", BIWEEKLY: "quincenal", MONTHLY: "mensual", MIN_STOCK: "por mínimo", CUSTOM: "personalizada" }[
      c
    ] ?? c
  );
}
