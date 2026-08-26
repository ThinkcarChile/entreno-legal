"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StockTarget } from "@/domain/stock/types";
import { deleteStockTarget, setStockTarget } from "@/app/stock/actions";
import { Button, ButtonOutline, Card, Flotante, Icon } from "@/components/ui";

/**
 * §32: "¿Cuánto quieres mantener en casa?" — el objetivo lo declara el hogar y
 * el sistema jamás lo cambia solo.
 */

/** Campo de formulario del kit: mismo alto de toque en todos lados. */
const FIELD =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";


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

  const sufijo = unit === "G" ? "g" : unit === "ML" ? "ml" : "unidades";

  return (
    <Card as="section" className="mb-lg p-md">
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      <div className="flex items-center justify-between gap-sm">
        <h2 className="flex items-center gap-sm font-headline-sm text-headline-sm text-on-surface">
          <Icon name="adjust" className="shrink-0 text-primary" />
          Objetivo de stock
        </h2>
        {!editando && (
          <ButtonOutline onClick={() => setEditando(true)}>
            {target ? "Cambiar objetivo" : "Definir objetivo"}
          </ButtonOutline>
        )}
      </div>

      {!editando ? (
        <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
          {!target && "Sin objetivo declarado: se usa un horizonte de 7 días por defecto."}
          {target &&
            !target.reorderEnabled &&
            "Pediste no recibir recomendaciones para este alimento."}
          {target && target.reorderEnabled && (
            <>
              {target.minimumQuantity != null && (
                <>
                  mínimo {target.minimumQuantity} {sufijo} ·{" "}
                </>
              )}
              {target.targetQuantity != null && (
                <>
                  objetivo {target.targetQuantity} {sufijo} ·{" "}
                </>
              )}
              {target.targetDaysOfSupply != null && (
                <>{target.targetDaysOfSupply} días de cobertura · </>
              )}
              {target.reviewCycle && <>revisión {cicloTexto(target.reviewCycle)} · </>}
              fuente {target.source === "USER_DEFINED" ? "tuya" : "sugerida"}
            </>
          )}
        </p>
      ) : (
        <div className="mt-md space-y-sm">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            ¿Cuánto quieres mantener de {label} en casa? Deja en blanco lo que no aplique.
          </p>
          <div className="grid grid-cols-1 gap-sm sm:grid-cols-2">
            <label className="font-body-sm text-body-sm text-on-surface-variant">
              Cantidad mínima ({sufijo})
              <input
                type="number"
                min="0"
                step="any"
                value={minimo}
                onChange={(e) => setMinimo(e.target.value)}
                className={`${FIELD} mt-1`}
              />
            </label>
            <label className="font-body-sm text-body-sm text-on-surface-variant">
              Cantidad objetivo ({sufijo})
              <input
                type="number"
                min="0"
                step="any"
                value={objetivo}
                onChange={(e) => setObjetivo(e.target.value)}
                className={`${FIELD} mt-1`}
              />
            </label>
            <label className="font-body-sm text-body-sm text-on-surface-variant">
              Días de cobertura
              <input
                type="number"
                min="1"
                max="90"
                value={dias}
                onChange={(e) => setDias(e.target.value)}
                className={`${FIELD} mt-1`}
              />
            </label>
            <label className="font-body-sm text-body-sm text-on-surface-variant">
              Revisión
              <select
                value={ciclo}
                onChange={(e) => setCiclo(e.target.value)}
                className={`${FIELD} mt-1`}
              >
                <option value="">Sin ciclo fijo</option>
                <option value="WEEKLY">Semanal</option>
                <option value="BIWEEKLY">Quincenal</option>
                <option value="MONTHLY">Mensual</option>
                <option value="MIN_STOCK">Por stock mínimo</option>
              </select>
            </label>
          </div>
          <label className="flex items-center gap-sm font-body-sm text-body-sm text-on-surface-variant">
            <input
              type="checkbox"
              className="size-5 shrink-0 accent-primary"
              checked={!reponer}
              onChange={(e) => setReponer(!e.target.checked)}
            />
            No recomendar reposición para este alimento
          </label>
          <div className="flex flex-wrap gap-sm">
            <ButtonOutline className="flex-1" onClick={() => setEditando(false)}>
              Cancelar
            </ButtonOutline>
            {target && (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => deleteStockTarget(ingredientId))}
                className="flex-1 inline-flex items-center justify-center gap-sm rounded-full border border-error-container px-lg py-sm font-body-md text-body-sm font-semibold text-error transition-transform active:scale-95 disabled:opacity-40"
              >
                Quitar objetivo
              </button>
            )}
            <Button
              className="flex-1"
              disabled={pending}
              onClick={() => {
                // Un texto inválido NO se convierte en "sin valor" a escondidas:
                // eso borraría un mínimo declarado sin que nadie lo pida.
                const campos = [minimo, objetivo, dias];
                if (campos.some((c) => c.trim() !== "" && !Number.isFinite(Number(c)))) {
                  setError("Revisa los números: hay un valor que no se entiende.");
                  return;
                }
                const num = (s: string) => (s.trim() === "" ? null : Number(s.trim()));
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
            >
              Guardar
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function cicloTexto(c: string): string {
  return (
    { WEEKLY: "semanal", BIWEEKLY: "quincenal", MONTHLY: "mensual", MIN_STOCK: "por mínimo", CUSTOM: "personalizada" }[
      c
    ] ?? c
  );
}
