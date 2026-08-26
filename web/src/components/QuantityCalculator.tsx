"use client";

import { useState } from "react";
import {
  calculateNutritionForQuantity,
  quantityFromServings,
  roundForDisplay,
} from "@/domain/catalog/nutrition";
import {
  NUTRIENT_KEYS,
  NUTRIENT_LABELS,
  type BasisUnit,
  type NutritionValues,
} from "@/domain/catalog/types";
import { Card, ErrorNote, Icon } from "@/components/ui";

/** Campo de formulario del kit: mismo alto de toque en todas las pantallas. */
const FIELD =
  "mt-xs min-h-[48px] rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

interface Measure {
  name: string;
  quantity: number;
  unit: BasisUnit;
}

interface Props {
  per100: NutritionValues;
  basisUnit: BasisUnit;
  servingQuantity?: number | null;
  servingName?: string | null;
  measures?: Measure[];
  initialQuantity?: number;
}

/** Calculadora inmediata: cantidad en g/ml (o porciones) → macros al instante. */
export function QuantityCalculator({
  per100,
  basisUnit,
  servingQuantity,
  servingName,
  measures = [],
  initialQuantity = 100,
}: Props) {
  const [quantityText, setQuantityText] = useState(String(initialQuantity));
  const [servingsText, setServingsText] = useState("");

  const quantity = Number(quantityText);
  const validQuantity = Number.isFinite(quantity) && quantity >= 0;

  const applyServings = (text: string) => {
    setServingsText(text);
    const servings = Number(text);
    if (servingQuantity && Number.isFinite(servings) && servings > 0) {
      // El peso real (editable abajo) tiene prioridad si el usuario lo cambia después.
      setQuantityText(String(quantityFromServings(servings, servingQuantity)));
    }
  };

  const result = validQuantity
    ? calculateNutritionForQuantity(per100, quantity, basisUnit, basisUnit)
    : null;

  const unitLabel = basisUnit === "ML" ? "ml" : "g";

  return (
    <Card as="section" className="p-md">
      <div className="flex items-center gap-sm">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
          <Icon name="calculate" filled />
        </span>
        <h2 className="font-headline-sm text-headline-sm text-on-surface">Calcular por cantidad</h2>
      </div>

      <div className="mt-md flex flex-wrap items-end gap-md">
        <label className="flex flex-col font-body-sm text-body-sm font-semibold text-on-surface-variant">
          Cantidad ({unitLabel})
          <input
            inputMode="decimal"
            value={quantityText}
            onChange={(e) => setQuantityText(e.target.value)}
            className={`${FIELD} w-28 font-body-lg text-body-lg font-semibold tabular-nums`}
            aria-label={`Cantidad en ${unitLabel}`}
          />
        </label>
        {servingQuantity ? (
          <label className="flex flex-col font-body-sm text-body-sm font-semibold text-on-surface-variant">
            {servingName ? `Porciones (${servingName})` : "Porciones"}
            <input
              inputMode="decimal"
              value={servingsText}
              onChange={(e) => applyServings(e.target.value)}
              placeholder={`1 = ${servingQuantity} ${unitLabel}`}
              className={`${FIELD} w-32 tabular-nums`}
            />
          </label>
        ) : null}
      </div>

      {measures.length > 0 ? (
        <div className="mt-sm flex flex-wrap gap-sm">
          {measures.map((m) => (
            <button
              key={m.name}
              type="button"
              onClick={() => setQuantityText(String(m.quantity))}
              className="min-h-[44px] rounded-full border border-outline-variant px-md py-sm font-body-sm text-body-sm font-semibold text-on-surface-variant transition-transform active:scale-95"
            >
              {m.name} · {m.quantity} {m.unit === "ML" ? "ml" : "g"}
            </button>
          ))}
        </div>
      ) : null}

      {result ? (
        <div className="mt-md overflow-x-auto">
          <table className="w-full font-body-sm text-body-sm">
            <tbody>
              {NUTRIENT_KEYS.map((key) => {
                const value = result[key];
                const rounded = roundForDisplay(value ?? null, key === "energy_kcal" ? 0 : 1);
                return (
                  <tr key={key} className="border-t border-outline-variant/40">
                    <td className="py-sm pr-md text-on-surface-variant">
                      {NUTRIENT_LABELS[key].label}
                    </td>
                    <td className="py-sm text-right font-semibold tabular-nums text-on-surface">
                      {rounded === null ? (
                        <span
                          className="font-normal text-outline"
                          title="Dato no disponible en la fuente"
                        >
                          sin dato
                        </span>
                      ) : (
                        `${rounded} ${NUTRIENT_LABELS[key].unit}`
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-md">
          <ErrorNote>Ingresa una cantidad válida.</ErrorNote>
        </div>
      )}

      <p className="mt-sm font-label-md text-label-md text-outline">
        “Sin dato” significa que la fuente no informa ese nutriente (no es cero).
      </p>
    </Card>
  );
}
