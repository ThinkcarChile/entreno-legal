import { uuidParam } from "@/lib/route-params";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, DataRow, EmptyState, Icon, LinkButton, Section } from "@/components/ui";
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

  // El envase solo aparece si hay algo que mostrar: una tarjeta vacía con tres
  // etiquetas y ningún dato ocupa el lugar de la información real.
  const hayDatosDeEnvase = Boolean(
    product.barcode || product.package_quantity || product.serving_quantity,
  );

  return (
    <AppShell
      active="catalog"
      title={product.name}
      subtitle={product.brand ?? "Sin marca"}
      action={
        <LinkButton href="/catalog" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Catálogo
        </LinkButton>
      }
    >
      <div className="mt-md flex flex-wrap gap-sm">
        <Chip tono={product.household_id ? "primario" : "neutro"} icon={product.household_id ? "home" : "inventory_2"}>
          {product.household_id ? "Producto de tu hogar" : "Del catálogo"}
        </Chip>
        {factData ? (
          <Chip
            tono={factData.verified ? "primario" : "neutro"}
            icon={factData.verified ? "verified" : "help"}
          >
            {factData.verified ? "Verificado" : "Sin verificar"}
          </Chip>
        ) : null}
      </div>

      {hayDatosDeEnvase ? (
        <Section title="Envase" className="mt-lg">
          <Card className="px-md py-xs">
            {product.barcode ? (
              <DataRow label="Código de barras">
                <span className="tabular-nums">{product.barcode}</span>
              </DataRow>
            ) : null}
            {product.package_quantity ? (
              <DataRow label="Contenido">
                {Number(product.package_quantity)} {unitLabel(product.package_unit)}
              </DataRow>
            ) : null}
            {product.serving_quantity ? (
              <DataRow
                label={`Porción${product.serving_name ? ` (${product.serving_name})` : ""}`}
              >
                {Number(product.serving_quantity)} {unitLabel(product.serving_unit)}
              </DataRow>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {factData ? (
        <div className="mt-lg">
          <QuantityCalculator
            per100={per100}
            basisUnit={basisUnit}
            servingQuantity={product.serving_quantity ? Number(product.serving_quantity) : null}
            servingName={product.serving_name}
            measures={measures}
          />
        </div>
      ) : (
        <div className="mt-lg">
          <EmptyState icon="nutrition">
            Este producto aún no tiene información nutricional.
          </EmptyState>
        </div>
      )}

      {factData ? (
        <Card className="mt-lg flex items-start gap-sm p-md">
          <Icon name="info" className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0 space-y-sm font-body-sm text-body-sm text-on-surface-variant">
            {factData.original_serving_quantity ? (
              <p>
                Etiqueta original: por porción de {Number(factData.original_serving_quantity)}{" "}
                {unitLabel(factData.original_serving_unit)} (valores normalizados a 100{" "}
                {basisUnit === "ML" ? "ml" : "g"}; el dato original se conserva).
              </p>
            ) : null}
            <p>
              Fuente: {SOURCE_TYPE_LABELS[factData.source_type as SourceType]} —{" "}
              {factData.source_name}.
            </p>
          </div>
        </Card>
      ) : null}
    </AppShell>
  );
}
