import { uuidParam } from "@/lib/route-params";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, Icon, LinkButton, Section } from "@/components/ui";
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

/**
 * Selector de estado (crudo, cocido, escurrido…): un carrusel de píldoras, no
 * un menú escondido. Cada estado tiene su PROPIA ficha nutricional, así que
 * cambiarlo cambia todos los números de abajo: tiene que verse.
 * 44 px de alto mínimo — esto se toca con el pulgar en 320 px.
 */
const PILDORA =
  "inline-flex min-h-[44px] shrink-0 snap-start items-center gap-1 rounded-full px-md py-2.5 font-body-sm text-body-sm font-semibold transition-colors";
const PILDORA_ACTIVA = "bg-primary text-on-primary";
const PILDORA_INACTIVA =
  "border border-outline-variant bg-surface-container-lowest text-on-surface-variant";

export default async function IngredientPage({ params, searchParams }: Props) {
  const { id: idCrudo } = await params;
  const id = uuidParam(idCrudo);
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

  const unidad = selected.basis_unit === "ML" ? "ml" : "g";

  return (
    <AppShell
      active="catalog"
      title={ingredient.display_name}
      subtitle={category ?? "Ingrediente del catálogo"}
      action={
        <LinkButton href="/catalog" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Catálogo
        </LinkButton>
      }
    >
      <Section
        className="mt-md"
        title="Estado del alimento"
        hint={`Los valores cambian según la preparación. Estás viendo por 100 ${unidad}.`}
      >
        {facts.length > 1 ? (
          <div className="hide-scrollbar -mx-container-margin flex snap-x gap-sm overflow-x-auto px-container-margin md:mx-0 md:px-0">
            {facts.map((f) => {
              const activa = f.id === selected.id;
              return (
                <a
                  key={f.id}
                  href={`?basis=${f.weight_basis}`}
                  aria-current={activa ? "true" : undefined}
                  className={`${PILDORA} ${activa ? PILDORA_ACTIVA : PILDORA_INACTIVA}`}
                >
                  {activa ? <Icon name="check" className="text-[16px]" /> : null}
                  {WEIGHT_BASIS_LABELS[f.weight_basis]}
                </a>
              );
            })}
          </div>
        ) : (
          <Chip tono="primario" icon="science">
            {WEIGHT_BASIS_LABELS[selected.weight_basis]}
          </Chip>
        )}
      </Section>

      <div className="mt-lg">
        <QuantityCalculator
          per100={factValues(selected)}
          basisUnit={selected.basis_unit}
          measures={measures.filter((m) => m.unit === selected.basis_unit)}
        />
      </div>

      <Card className="mt-lg flex items-start gap-sm p-md">
        <Icon name="info" className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Valores por 100 {unidad} ({WEIGHT_BASIS_LABELS[selected.weight_basis].toLowerCase()}).
            Fuente: {SOURCE_TYPE_LABELS[selected.source_type]} — {selected.source_name}.
          </p>
          <div className="mt-sm">
            {/* El sello acompaña al texto, nunca lo reemplaza: el color solo no
                puede ser lo que distingue un dato verificado de uno que no. */}
            <Chip
              tono={selected.verified ? "primario" : "neutro"}
              icon={selected.verified ? "verified" : "help"}
            >
              {selected.verified ? "Verificado" : "Sin verificar"}
            </Chip>
          </div>
        </div>
      </Card>
    </AppShell>
  );
}
