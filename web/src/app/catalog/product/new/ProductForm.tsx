"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProduct } from "../../actions";
import { createProductSchema, type CreateProductInput } from "@/domain/catalog/schemas";
import { normalizeLabelToPer100, roundForDisplay } from "@/domain/catalog/nutrition";
import { NUTRIENT_KEYS, NUTRIENT_LABELS, type NutritionValues } from "@/domain/catalog/types";
import { Button, ButtonOutline, Card, ErrorNote, Icon } from "@/components/ui";

/** Campo de formulario del kit: mismo alto de toque en todas las pantallas. */
const FIELD =
  "mt-xs min-h-[48px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

/** Etiqueta sobre el campo. */
const LABEL = "block font-body-sm text-body-sm font-semibold text-on-surface-variant";

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
      <Card as="section" className="p-md">
        <div className="flex items-center gap-sm">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <Icon name="fact_check" filled />
          </span>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Interpretamos</h2>
        </div>

        <p className="mt-sm font-body-md text-body-md text-on-surface">
          <strong className="font-semibold">{review.name}</strong>
          {review.brand ? ` · ${review.brand}` : ""}
          {review.barcode ? ` · ${review.barcode}` : ""}
        </p>
        {isPerServing ? (
          <p className="mt-xs font-body-sm text-body-sm text-on-surface-variant">
            Porción de {review.servingQuantity} {unit}
            {review.nutrition.energy_kcal != null ? ` = ${review.nutrition.energy_kcal} kcal` : ""}.
            Normalizado a 100 {unit} (el dato original se conserva):
          </p>
        ) : (
          <p className="mt-xs font-body-sm text-body-sm text-on-surface-variant">
            Valores por 100 {unit}:
          </p>
        )}

        <div className="mt-sm overflow-x-auto">
          <table className="w-full font-body-sm text-body-sm">
            <tbody>
              {NUTRIENT_KEYS.map((key) => {
                const value = per100[key];
                if (value === null || value === undefined) return null;
                return (
                  <tr key={key} className="border-t border-outline-variant/40">
                    <td className="py-sm pr-md text-on-surface-variant">
                      {NUTRIENT_LABELS[key].label}
                    </td>
                    <td className="py-sm text-right font-semibold tabular-nums text-on-surface">
                      {roundForDisplay(value, 1)} {NUTRIENT_LABELS[key].unit} / 100 {unit}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-sm font-label-md text-label-md text-outline">
          Los nutrientes no ingresados quedarán como “sin dato” (no como cero).
        </p>

        <div className="mt-md flex flex-wrap gap-sm">
          <Button onClick={confirm} disabled={pending} className="flex-1 py-3">
            <Icon name="save" className="text-[18px]" />
            {pending ? "Guardando…" : "Confirmar y guardar"}
          </Button>
          <ButtonOutline onClick={() => setReview(null)} disabled={pending} className="py-3">
            Corregir
          </ButtonOutline>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-md">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card className="flex flex-col gap-md p-md">
        <label className={LABEL}>
          Nombre *
          <input
            className={FIELD}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label className={LABEL}>
          Marca
          <input
            className={FIELD}
            value={form.brand}
            onChange={(e) => set("brand", e.target.value)}
          />
        </label>
        <label className={LABEL}>
          Código de barras
          <input
            className={FIELD}
            inputMode="numeric"
            value={form.barcode}
            onChange={(e) => set("barcode", e.target.value)}
            placeholder="EAN-8 / UPC-A / EAN-13 / GTIN-14"
          />
        </label>

        <div className="grid grid-cols-2 gap-sm">
          <label className={LABEL}>
            Peso del envase
            <input
              className={FIELD}
              inputMode="decimal"
              value={form.packageQuantity}
              onChange={(e) => set("packageQuantity", e.target.value)}
            />
          </label>
          <label className={LABEL}>
            Unidad
            <select
              className={FIELD}
              value={form.packageUnit}
              onChange={(e) => set("packageUnit", e.target.value)}
            >
              <option value="G">g</option>
              <option value="ML">ml</option>
            </select>
          </label>
        </div>
      </Card>

      <Card as="section" className="p-md">
        <fieldset className="min-w-0">
          <legend className="mb-sm font-headline-sm text-headline-sm text-on-surface">
            Información nutricional
          </legend>

          <div className="flex flex-wrap gap-md">
            <label className="flex items-center gap-xs font-body-sm text-body-sm text-on-surface">
              <input
                type="radio"
                className="h-5 w-5 accent-primary"
                checked={form.nutritionMode === "PER_SERVING"}
                onChange={() => set("nutritionMode", "PER_SERVING")}
              />
              Por porción
            </label>
            <label className="flex items-center gap-xs font-body-sm text-body-sm text-on-surface">
              <input
                type="radio"
                className="h-5 w-5 accent-primary"
                checked={form.nutritionMode === "PER_100"}
                onChange={() => set("nutritionMode", "PER_100")}
              />
              Por 100 g/ml
            </label>
          </div>

          {form.nutritionMode === "PER_SERVING" ? (
            <div className="mt-md grid grid-cols-2 gap-sm sm:grid-cols-3">
              <label className={LABEL}>
                Porción *
                <input
                  className={FIELD}
                  inputMode="decimal"
                  value={form.servingQuantity}
                  onChange={(e) => set("servingQuantity", e.target.value)}
                  placeholder="48"
                />
              </label>
              <label className={LABEL}>
                Unidad
                <select
                  className={FIELD}
                  value={form.servingUnit}
                  onChange={(e) => set("servingUnit", e.target.value)}
                >
                  <option value="G">g</option>
                  <option value="ML">ml</option>
                </select>
              </label>
              <label className={`${LABEL} col-span-2 sm:col-span-1`}>
                Nombre
                <input
                  className={FIELD}
                  value={form.servingName}
                  onChange={(e) => set("servingName", e.target.value)}
                  placeholder="rebanada"
                />
              </label>
            </div>
          ) : null}

          <div className="mt-md grid grid-cols-1 gap-sm sm:grid-cols-2">
            {NUTRIENT_KEYS.map((key) => (
              <label key={key} className={LABEL}>
                {NUTRIENT_LABELS[key].label} ({NUTRIENT_LABELS[key].unit})
                <input
                  className={FIELD}
                  inputMode="decimal"
                  value={form.nutrition[key] ?? ""}
                  onChange={(e) => setNutrient(key, e.target.value)}
                  placeholder="sin dato"
                />
              </label>
            ))}
          </div>

          <p className="mt-sm font-label-md text-label-md text-outline">
            Deja vacío lo que la etiqueta no informa: se guardará como “sin dato”, nunca como 0.
          </p>
        </fieldset>
      </Card>

      <Button full onClick={toReview}>
        <Icon name="checklist" className="text-[18px]" />
        Revisar antes de guardar
      </Button>
    </div>
  );
}
