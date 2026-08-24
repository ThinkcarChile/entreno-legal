import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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

  return (
    <main className="pt-2">
      <AppNav active="catalog" />
      <h1 className="text-2xl font-bold">Catálogo</h1>

      <form className="mt-3 flex flex-col gap-2" action="/catalog" method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder="Buscar por nombre, marca o código de barras"
          inputMode="search"
          className="rounded-xl border border-gray-300 bg-white px-4 py-3"
        />
        <div className="flex flex-wrap gap-2 text-sm">
          <select name="kind" defaultValue={kind} className="rounded-xl border border-gray-300 bg-white px-3 py-2">
            <option value="all">Todo</option>
            <option value="ingredient">Ingredientes</option>
            <option value="product">Productos</option>
          </select>
          <select
            name="category"
            defaultValue={params.category ?? ""}
            className="rounded-xl border border-gray-300 bg-white px-3 py-2"
          >
            <option value="">Toda categoría</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            name="source"
            defaultValue={sourceFilter}
            className="rounded-xl border border-gray-300 bg-white px-3 py-2"
          >
            <option value="">Toda fuente</option>
            {Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2">
            <input type="checkbox" name="verified" value="1" defaultChecked={verifiedOnly} />
            Solo verificados
          </label>
          <button className="rounded-xl bg-[var(--accent)] px-4 py-2 font-semibold text-white">
            Buscar
          </button>
        </div>
      </form>

      {barcodeQuery && products.length === 0 ? (
        <div className="mt-4 rounded-xl border border-[var(--accent)] bg-white p-4">
          <p className="text-sm">
            No hay ningún producto con el código <code>{barcodeQuery}</code> en tu catálogo.
          </p>
          <Link
            href={`/catalog/product/new?barcode=${barcodeQuery}`}
            className="mt-2 inline-block rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white"
          >
            Agregar producto
          </Link>
        </div>
      ) : null}

      {kind !== "product" && ingredients.length > 0 ? (
        <section className="mt-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide opacity-60">Ingredientes</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {ingredients.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/catalog/ingredient/${row.id}`}
                  className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3"
                >
                  <span className="font-medium">{row.display_name}</span>
                  <span className="text-xs opacity-60">{row.ingredient_categories?.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {kind !== "ingredient" && products.length > 0 ? (
        <section className="mt-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide opacity-60">
            Productos comerciales
          </h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {products.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/catalog/product/${row.id}`}
                  className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3"
                >
                  <span>
                    <span className="font-medium">{row.name}</span>
                    {row.brand ? <span className="ml-1 text-sm opacity-60">· {row.brand}</span> : null}
                  </span>
                  <span className="text-xs opacity-60">
                    {row.household_id ? "de tu hogar" : "catálogo"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-8">
        <Link
          href="/catalog/product/new"
          className="block rounded-xl border border-[var(--accent)] px-4 py-3 text-center font-semibold text-[var(--accent)]"
        >
          + Agregar producto personalizado
        </Link>
      </div>
    </main>
  );
}
