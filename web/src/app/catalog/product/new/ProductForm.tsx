"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProduct } from "../../actions";
import { createProductSchema, type CreateProductInput } from "@/domain/catalog/schemas";
import { normalizeLabelToPer100, roundForDisplay } from "@/domain/catalog/nutrition";
import { NUTRIENT_KEYS, NUTRIENT_LABELS, type NutritionValues } from "@/domain/catalog/types";

const inputCls = "rounded-xl border border-gray-300 bg-white px-3 py-2.5 w-full";

export function ProductForm({ initialBarcode }: { initialBarcode: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<CreateProductInput | null>(null);

  const [form, setForm] = useState({
    name: "",
    brand: "",
    barcode: initialBarcode,
    packageQuantity: "",
    packageUnit: "G",
    servingQuantity: "",
    servingUnit: "G",
    servingName: "",
    nutritionMode: "PER_SERVING",
    nutrition: Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, ""])) as Record<string, string>,
  });

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const setNutrient = (key: string, value: string) =>
    setForm((f) => ({ ...f, nutrition: { ...f.nutrition, [key]: value } }));

  const toReview = () => {
    setError(null);
    const parsed = createProductSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Revisa los datos");
      return;
    }
    setReview(parsed.data);
  };

  const confirm = () => {
    if (!review) return;
    startTransition(async () => {
      const result = await createProduct(review);
      if (result.ok && result.productId) {
        router.push(`/catalog/product/${result.productId}`);
      } else {
        setReview(null);
        setError(result.error ?? "No se pudo guardar");
      }
    });
  };

  if (review) {
    const isPerServing = review.nutritionMode === "PER_SERVING";
    const per100: NutritionValues = isPerServing
      ? normalizeLabelToPer100({
          servingQuantity: review.servingQuantity as number,
          servingUnit: review.servingUnit,
          values: review.nutrition,
        }).per100
      : review.nutrition;
    const unit = isPerServing
      ? review.servingUnit === "ML" ? "ml" : "g"
      : review.packageUnit === "ML" ? "ml" : "g";

    return (
      <section className="rounded-xl border border-[var(--accent)] bg-white p-4">
        <h2 className="font-semibold">Interpretamos:</h2>
        <p className="mt-1 text-sm">
          <strong>{review.name}</strong>
          {review.brand ? ` · ${review.brand}` : ""}
          {review.barcode ? ` · ${review.barcode}` : ""}
        </p>
        {isPerServing ? (
          <p className="mt-1 text-sm opacity-70">
            Porción de {review.servingQuantity} {unit}
            {review.nutrition.energy_kcal != null ? ` = ${review.nutrition.energy_kcal} kcal` : ""}.
            Normalizado a 100 {unit} (el dato original se conserva):
          </p>
        ) : (
          <p className="mt-1 text-sm opacity-70">Valores por 100 {unit}:</p>
        )}
        <table className="mt-2 w-full text-sm">
          <tbody>
            {NUTRIENT_KEYS.map((key) => {
              const value = per100[key];
              if (value === null || value === undefined) return null;
              return (
                <tr key={key} className="border-t border-gray-100">
                  <td className="py-1">{NUTRIENT_LABELS[key].label}</td>
                  <td className="py-1 text-right tabular-nums">
                    {roundForDisplay(value, 1)} {NUTRIENT_LABELS[key].unit} / 100 {unit}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs opacity-60">
          Los nutrientes no ingresados quedarán como “sin dato” (no como cero).
        </p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={confirm}
            disabled={pending}
            className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Guardando…" : "Confirmar y guardar"}
          </button>
          <button
            onClick={() => setReview(null)}
            disabled={pending}
            className="rounded-xl border border-gray-300 px-4 py-3"
          >
            Corregir
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      <label className="text-sm font-medium">
        Nombre *
        <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Marca
        <input className={inputCls} value={form.brand} onChange={(e) => set("brand", e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Código de barras
        <input
          className={inputCls}
          inputMode="numeric"
          value={form.barcode}
          onChange={(e) => set("barcode", e.target.value)}
          placeholder="EAN-8 / UPC-A / EAN-13 / GTIN-14"
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm font-medium">
          Peso del envase
          <input
            className={inputCls}
            inputMode="decimal"
            value={form.packageQuantity}
            onChange={(e) => set("packageQuantity", e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          Unidad
          <select
            className={inputCls}
            value={form.packageUnit}
            onChange={(e) => set("packageUnit", e.target.value)}
          >
            <option value="G">g</option>
            <option value="ML">ml</option>
          </select>
        </label>
      </div>

      <fieldset className="rounded-xl border border-gray-200 p-3">
        <legend className="px-1 text-sm font-semibold">Información nutricional</legend>
        <div className="flex gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={form.nutritionMode === "PER_SERVING"}
              onChange={() => set("nutritionMode", "PER_SERVING")}
            />
            Por porción
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={form.nutritionMode === "PER_100"}
              onChange={() => set("nutritionMode", "PER_100")}
            />
            Por 100 g/ml
          </label>
        </div>

        {form.nutritionMode === "PER_SERVING" ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <label className="text-sm">
              Porción *
              <input
                className={inputCls}
                inputMode="decimal"
                value={form.servingQuantity}
                onChange={(e) => set("servingQuantity", e.target.value)}
                placeholder="48"
              />
            </label>
            <label className="text-sm">
              Unidad
              <select
                className={inputCls}
                value={form.servingUnit}
                onChange={(e) => set("servingUnit", e.target.value)}
              >
                <option value="G">g</option>
                <option value="ML">ml</option>
              </select>
            </label>
            <label className="text-sm">
              Nombre
              <input
                className={inputCls}
                value={form.servingName}
                onChange={(e) => set("servingName", e.target.value)}
                placeholder="rebanada"
              />
            </label>
          </div>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2">
          {NUTRIENT_KEYS.map((key) => (
            <label key={key} className="text-sm">
              {NUTRIENT_LABELS[key].label} ({NUTRIENT_LABELS[key].unit})
              <input
                className={inputCls}
                inputMode="decimal"
                value={form.nutrition[key] ?? ""}
                onChange={(e) => setNutrient(key, e.target.value)}
                placeholder="sin dato"
              />
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs opacity-60">
          Deja vacío lo que la etiqueta no informa: se guardará como “sin dato”, nunca como 0.
        </p>
      </fieldset>

      <button
        onClick={toReview}
        className="rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white"
      >
        Revisar antes de guardar
      </button>
    </div>
  );
}
