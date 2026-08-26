import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell, ShellAction } from "@/components/AppShell";
import {
  Button,
  Card,
  CardLink,
  Chip,
  EmptyState,
  Icon,
  LinkButton,
  Notice,
  Section,
} from "@/components/ui";
import { isValidBarcode, normalizeBarcode } from "@/domain/catalog/barcode";
import { SOURCE_TYPE_LABELS, type SourceType } from "@/domain/catalog/types";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { parseRows, uuid } from "@/lib/supabase/rows";
import { z } from "zod";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    q?: string;
    kind?: string; // all | ingredient | product
    category?: string;
    source?: string;
    verified?: string;
  }>;
}

const categoriaEmbebida = z.object({ name: z.string() });
const oneCategoria = z
  .union([categoriaEmbebida, z.array(categoriaEmbebida), z.null()])
  .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

const ingredientRowSchema = z.object({
  id: uuid,
  display_name: z.string(),
  household_id: uuid.nullable(),
  ingredient_categories: oneCategoria,
});
type IngredientRow = z.infer<typeof ingredientRowSchema>;

const productRowSchema = z.object({
  id: uuid,
  name: z.string(),
  brand: z.string().nullable(),
  barcode: z.string().nullable(),
  household_id: uuid.nullable(),
  verified: z.boolean(),
});
type ProductRow = z.infer<typeof productRowSchema>;

/**
 * Campo de formulario del kit: 48 px de alto mínimo — en 320 px el pulgar
 * necesita blanco, no elegancia (mismo criterio que /health/exams/upload).
 */
const CAMPO =
  "min-h-[48px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md text-on-surface";

/** El buscador es una píldora con el icono adentro: mismo campo, otra forma. */
const BUSCADOR =
  "min-h-[48px] w-full rounded-full border border-outline-variant bg-surface-container-lowest py-3 pl-13 pr-md font-body-md text-body-md text-on-surface";

export default async function CatalogPage({ searchParams }: Props) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const kind = params.kind ?? "all";
  const verifiedOnly = params.verified === "1";

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/catalog");

  const { data: categories, error: errorCategories } = await supabase
    .from("ingredient_categories")
    .select("id, name")
    .order("sort_order");
  if (errorCategories) throw new DataAccessError("categorias del catalogo", errorCategories);

  const barcodeQuery = q !== "" && isValidBarcode(q) ? normalizeBarcode(q) : null;

  let ingredients: IngredientRow[] = [];
  let products: ProductRow[] = [];

  if (kind !== "product" && !barcodeQuery) {
    let query = supabase
      .from("ingredients")
      .select("id, display_name, household_id, ingredient_categories(name)")
      .eq("is_active", true)
      .order("display_name")
      .limit(50);
    if (q !== "") query = query.ilike("display_name", `%${q}%`);
    if (params.category) query = query.eq("category_id", params.category);
    const { data, error } = await query;
    if (error) throw new DataAccessError("ingredientes del catalogo", error);
    ingredients = parseRows(ingredientRowSchema, data, "ingredientes del catálogo");
  }

  if (kind !== "ingredient") {
    let query = supabase
      .from("commercial_products")
      .select("id, name, brand, barcode, household_id, verified")
      .eq("is_active", true)
      .order("name")
      .limit(50);
    if (barcodeQuery) {
      query = query.eq("barcode", barcodeQuery);
    } else if (q !== "") {
      query = query.or(`name.ilike.%${q}%,brand.ilike.%${q}%`);
    }
    if (verifiedOnly) query = query.eq("verified", true);
    const { data, error } = await query;
    if (error) throw new DataAccessError("productos del catalogo", error);
    products = parseRows(productRowSchema, data, "productos del catálogo");
  }

  // Filtro por fuente: aplica sobre nutrition_facts del sujeto (consulta simple)
  const sourceFilter = (params.source ?? "") as SourceType | "";

  const sinResultados = ingredients.length === 0 && products.length === 0 && !barcodeQuery;

  return (
    <AppShell
      active="catalog"
      title="Catálogo"
      subtitle="Ingredientes y productos comerciales con su ficha de origen."
      action={
        <ShellAction href="/catalog/product/new">
          <Icon name="add" className="text-[18px]" />
          Agregar producto
        </ShellAction>
      }
    >
      <form className="mt-md" action="/catalog" method="get">
        <Card className="space-y-md p-md">
          <label className="relative block">
            <span className="sr-only">Buscar por nombre, marca o código de barras</span>
            <Icon
              name="search"
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-outline"
            />
            <input
              name="q"
              defaultValue={q}
              placeholder="Buscar por nombre, marca o código de barras"
              inputMode="search"
              className={BUSCADOR}
            />
          </label>

          <div className="grid grid-cols-1 gap-sm sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
                Qué mostrar
              </span>
              <select name="kind" defaultValue={kind} className={CAMPO}>
                <option value="all">Todo</option>
                <option value="ingredient">Ingredientes</option>
                <option value="product">Productos</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
                Categoría
              </span>
              <select name="category" defaultValue={params.category ?? ""} className={CAMPO}>
                <option value="">Toda categoría</option>
                {(categories ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
                Fuente del dato
              </span>
              <select name="source" defaultValue={sourceFilter} className={CAMPO}>
                <option value="">Toda fuente</option>
                {Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-md">
            <label className="flex items-center gap-sm font-body-sm text-body-sm text-on-surface-variant">
              <input
                type="checkbox"
                name="verified"
                value="1"
                defaultChecked={verifiedOnly}
                className="h-6 w-6 shrink-0 accent-[var(--color-primary)]"
              />
              Solo verificados
            </label>
            <Button type="submit">
              <Icon name="search" className="text-[18px]" />
              Buscar
            </Button>
          </div>
        </Card>
      </form>

      {barcodeQuery && products.length === 0 ? (
        <div className="mt-md space-y-sm">
          <Notice icon="barcode_scanner" tono="info">
            No hay ningún producto con el código <strong>{barcodeQuery}</strong> en tu catálogo.
          </Notice>
          <LinkButton href={`/catalog/product/new?barcode=${barcodeQuery}`}>
            <Icon name="add" className="text-[18px]" />
            Agregar producto
          </LinkButton>
        </div>
      ) : null}

      {sinResultados ? (
        <div className="mt-md">
          <EmptyState icon="nutrition">
            No hay nada que coincida con esa búsqueda. Prueba con otro nombre o cambia los filtros.
          </EmptyState>
        </div>
      ) : null}

      {kind !== "product" && ingredients.length > 0 ? (
        <Section title="Ingredientes" className="mt-lg">
          <ul className="space-y-sm">
            {ingredients.map((row) => (
              <li key={row.id}>
                <CardLink
                  href={`/catalog/ingredient/${row.id}`}
                  className="flex items-center gap-md p-md"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-fixed text-on-primary-fixed">
                    <Icon name="nutrition" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-body-md text-body-md font-semibold text-on-surface">
                    {row.display_name}
                  </span>
                  {row.ingredient_categories?.name ? (
                    <Chip tono="neutro">{row.ingredient_categories.name}</Chip>
                  ) : null}
                </CardLink>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {kind !== "ingredient" && products.length > 0 ? (
        <Section title="Productos comerciales" className="mt-lg">
          <ul className="space-y-sm">
            {products.map((row) => (
              <li key={row.id}>
                <CardLink
                  href={`/catalog/product/${row.id}`}
                  className="flex items-center gap-md p-md"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-secondary-fixed text-on-secondary-fixed-variant">
                    <Icon name="inventory_2" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-body-md text-body-md font-semibold text-on-surface">
                      {row.name}
                    </span>
                    {row.brand ? (
                      <span className="block truncate font-body-sm text-body-sm text-on-surface-variant">
                        {row.brand}
                      </span>
                    ) : null}
                  </span>
                  <Chip tono={row.household_id ? "primario" : "neutro"}>
                    {row.household_id ? "de tu hogar" : "catálogo"}
                  </Chip>
                </CardLink>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <LinkButton href="/catalog/product/new" variant="outline" className="mt-lg w-full py-3">
        <Icon name="add" className="text-[18px]" />
        Agregar producto personalizado
      </LinkButton>
    </AppShell>
  );
}
