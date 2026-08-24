import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { QuantityCalculator } from "@/components/QuantityCalculator";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  basisUnit,
  nutrientColumns,
  parseRow,
  parseRows,
  sourceType as sourceTypeSchema,
  uuid,
  weightBasis,
} from "@/lib/supabase/rows";
import { z } from "zod";
import {
  NUTRIENT_KEYS,
  SOURCE_TYPE_LABELS,
  WEIGHT_BASIS_LABELS,
  type BasisUnit,
  type NutritionValues,
} from "@/domain/catalog/types";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ basis?: string }>;
}

const factRowSchema = nutrientColumns.extend({
  id: uuid,
  weight_basis: weightBasis,
  basis_unit: basisUnit,
  source_type: sourceTypeSchema,
  source_name: z.string(),
  verified: z.boolean(),
});
type FactRow = z.infer<typeof factRowSchema>;

const categoriaEmbebida = z.object({ name: z.string() });
const oneCategoria = z
  .union([categoriaEmbebida, z.array(categoriaEmbebida), z.null()])
  .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

function factValues(row: FactRow): NutritionValues {
  const values: NutritionValues = {};
  for (const key of NUTRIENT_KEYS) {
    const raw = row[key];
    values[key] = raw === null || raw === undefined ? null : Number(raw);
  }
  return values;
}

export default async function IngredientPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { basis } = await searchParams;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/catalog");

  const { data: ingredient, error: errorIngredient } = await supabase
    .from("ingredients")
    .select("id, display_name, ingredient_categories(name)")
    .eq("id", id)
    .maybeSingle();
  if (errorIngredient) throw new DataAccessError("ingrediente", errorIngredient);
  if (!ingredient) notFound();

  const { data: factsData, error: errorFactsData } = await supabase
    .from("nutrition_facts")
    .select("*")
    .eq("ingredient_id", id);
  if (errorFactsData) throw new DataAccessError("fichas nutricionales del ingrediente", errorFactsData);
  const facts = parseRows(factRowSchema, factsData, "fichas del ingrediente");
  if (facts.length === 0) notFound();

  const selected = facts.find((f) => f.weight_basis === basis) ?? facts[0]!;

  const { data: measuresData, error: errorMeasuresData } = await supabase
    .from("household_measures")
    .select("measure_name, quantity, unit")
    .eq("ingredient_id", id);
  if (errorMeasuresData) throw new DataAccessError("medidas domesticas del ingrediente", errorMeasuresData);
  const measures = (measuresData ?? []).map((m) => ({
    name: m.measure_name as string,
    quantity: Number(m.quantity),
    unit: m.unit as BasisUnit,
  }));

  const category = parseRow(
    z.object({ ingredient_categories: oneCategoria }),
    ingredient,
    "categoría del ingrediente",
  ).ingredient_categories?.name;

  return (
    <main className="pt-2">
      <AppNav active="catalog" />
      <h1 className="text-2xl font-bold">{ingredient.display_name}</h1>
      {category ? <p className="text-sm opacity-60">{category}</p> : null}

      {facts.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {facts.map((f) => (
            <a
              key={f.id}
              href={`?basis=${f.weight_basis}`}
              className={`rounded-full px-3 py-1 text-sm ${
                f.id === selected.id
                  ? "bg-[var(--accent)] text-white"
                  : "border border-gray-300 bg-white"
              }`}
            >
              {WEIGHT_BASIS_LABELS[f.weight_basis]}
            </a>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm">
          Estado: <strong>{WEIGHT_BASIS_LABELS[selected.weight_basis]}</strong>
        </p>
      )}

      <div className="mt-4">
        <QuantityCalculator
          per100={factValues(selected)}
          basisUnit={selected.basis_unit}
          measures={measures.filter((m) => m.unit === selected.basis_unit)}
        />
      </div>

      <p className="mt-4 text-xs opacity-70">
        Valores por 100 {selected.basis_unit === "ML" ? "ml" : "g"} (
        {WEIGHT_BASIS_LABELS[selected.weight_basis].toLowerCase()}). Fuente:{" "}
        {SOURCE_TYPE_LABELS[selected.source_type]} — {selected.source_name}.{" "}
        {selected.verified ? "✓ Verificado." : "No verificado."}
      </p>
    </main>
  );
}
