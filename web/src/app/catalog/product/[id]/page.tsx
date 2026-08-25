import { uuidParam } from "@/lib/route-params";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { QuantityCalculator } from "@/components/QuantityCalculator";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  NUTRIENT_KEYS,
  SOURCE_TYPE_LABELS,
  type BasisUnit,
  type NutritionValues,
  type SourceType,
} from "@/domain/catalog/types";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProductPage({ params }: Props) {
  const { id: idCrudo } = await params;
  const id = uuidParam(idCrudo);
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/catalog");

  const { data: product, error: errorProduct } = await supabase
    .from("commercial_products")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (errorProduct) throw new DataAccessError("producto comercial", errorProduct);
  if (!product) notFound();

  const { data: factData, error: errorFactData } = await supabase
    .from("nutrition_facts")
    .select("*")
    .eq("product_id", id)
    .limit(1)
    .maybeSingle();
  if (errorFactData) throw new DataAccessError("ficha nutricional del producto", errorFactData);

  const per100: NutritionValues = {};
  if (factData) {
    for (const key of NUTRIENT_KEYS) {
      const raw = (factData as Record<string, unknown>)[key];
      per100[key] = raw === null || raw === undefined ? null : Number(raw);
    }
  }
  const basisUnit = ((factData?.basis_unit as BasisUnit | undefined) ?? "G") satisfies BasisUnit;

  const { data: measuresData, error: errorMeasuresData } = await supabase
    .from("household_measures")
    .select("measure_name, quantity, unit")
    .eq("product_id", id);
  if (errorMeasuresData) throw new DataAccessError("medidas domesticas del producto", errorMeasuresData);
  const measures = (measuresData ?? []).map((m) => ({
    name: m.measure_name as string,
    quantity: Number(m.quantity),
    unit: m.unit as BasisUnit,
  }));

  const unitLabel = (u: string | null) => (u === "ML" ? "ml" : "g");

  return (
    <main className="pt-2">
      <AppNav active="catalog" />
      <h1 className="text-2xl font-bold">{product.name}</h1>
      <p className="text-sm opacity-70">
        {product.brand ?? "Sin marca"}
        {product.household_id ? " · producto de tu hogar" : " · catálogo"}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        {product.barcode ? (
          <>
            <dt className="opacity-60">Código</dt>
            <dd className="text-right font-mono">{product.barcode}</dd>
          </>
        ) : null}
        {product.package_quantity ? (
          <>
            <dt className="opacity-60">Envase</dt>
            <dd className="text-right">
              {Number(product.package_quantity)} {unitLabel(product.package_unit)}
            </dd>
          </>
        ) : null}
        {product.serving_quantity ? (
          <>
            <dt className="opacity-60">Porción{product.serving_name ? ` (${product.serving_name})` : ""}</dt>
            <dd className="text-right">
              {Number(product.serving_quantity)} {unitLabel(product.serving_unit)}
            </dd>
          </>
        ) : null}
      </dl>

      {factData ? (
        <div className="mt-4">
          <QuantityCalculator
            per100={per100}
            basisUnit={basisUnit}
            servingQuantity={product.serving_quantity ? Number(product.serving_quantity) : null}
            servingName={product.serving_name}
            measures={measures}
          />
        </div>
      ) : (
        <p className="mt-4 text-sm opacity-70">Este producto aún no tiene información nutricional.</p>
      )}

      {factData?.original_serving_quantity ? (
        <p className="mt-3 text-xs opacity-60">
          Etiqueta original: por porción de {Number(factData.original_serving_quantity)}{" "}
          {unitLabel(factData.original_serving_unit)} (valores normalizados a 100{" "}
          {basisUnit === "ML" ? "ml" : "g"}; el dato original se conserva).
        </p>
      ) : null}

      {factData ? (
        <p className="mt-2 text-xs opacity-70">
          Fuente: {SOURCE_TYPE_LABELS[factData.source_type as SourceType]} — {factData.source_name}.{" "}
          {factData.verified ? "✓ Verificado." : "No verificado."}
        </p>
      ) : null}
    </main>
  );
}
