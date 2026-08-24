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
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="font-semibold">Calcular por cantidad</h2>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          Cantidad ({unitLabel})
          <input
            inputMode="decimal"
            value={quantityText}
            onChange={(e) => setQuantityText(e.target.value)}
            className="mt-1 w-28 rounded-xl border border-gray-300 px-3 py-2 text-lg font-semibold"
            aria-label={`Cantidad en ${unitLabel}`}
          />
        </label>
        {servingQuantity ? (
          <label className="flex flex-col text-sm">
            {servingName ? `Porciones (${servingName})` : "Porciones"}
            <input
              inputMode="decimal"
              value={servingsText}
              onChange={(e) => applyServings(e.target.value)}
              placeholder={`1 = ${servingQuantity} ${unitLabel}`}
              className="mt-1 w-32 rounded-xl border border-gray-300 px-3 py-2"
            />
          </label>
        ) : null}
      </div>
      {measures.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {measures.map((m) => (
            <button
              key={m.name}
              type="button"
              onClick={() => setQuantityText(String(m.quantity))}
              className="rounded-full border border-gray-300 px-2.5 py-1 text-xs"
            >
              {m.name} · {m.quantity} {m.unit === "ML" ? "ml" : "g"}
            </button>
          ))}
        </div>
      ) : null}

      {result ? (
        <table className="mt-4 w-full text-sm">
          <tbody>
            {NUTRIENT_KEYS.map((key) => {
              const value = result[key];
              const rounded = roundForDisplay(value ?? null, key === "energy_kcal" ? 0 : 1);
              return (
                <tr key={key} className="border-t border-gray-100">
                  <td className="py-1.5">{NUTRIENT_LABELS[key].label}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">
                    {rounded === null ? (
                      <span className="font-normal opacity-50" title="Dato no disponible en la fuente">
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
      ) : (
        <p className="mt-3 text-sm text-red-700">Ingresa una cantidad válida.</p>
      )}
      <p className="mt-2 text-xs opacity-60">
        “Sin dato” significa que la fuente no informa ese nutriente (no es cero).
      </p>
    </section>
  );
}
