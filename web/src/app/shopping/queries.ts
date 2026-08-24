import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { dateString, nullableNumeric, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import type {
  ConfirmedServing,
  IngredientMeta,
  ProductMeta,
  PurchaseBasis,
  ShoppingInput,
  ShoppingUnit,
  YieldEntry,
} from "@/domain/shopping/engine";
import type { MealType } from "@/domain/recipes/types";
import type { WeightBasis } from "@/domain/catalog/types";

type Db = SupabaseClient;

/**
 * Lectura para el ShoppingEngine. La fuente de verdad son las porciones
 * CONFIRMADAS (§1): acá no se mira la receta ni se multiplica por personas —
 * se leen los componentes congelados, con su identidad real ya resuelta.
 */

export interface ShoppingContext {
  planId: string;
  weekStart: string;
  input: ShoppingInput;
  /** Comidas con receta que todavía no se confirman (§30, §31). */
  unconfirmed: { date: string; mealType: MealType; recipeName: string | null }[];
}

const servingRowSchema = z.object({
  id: uuid,
  assignment_id: uuid,
  member_id: uuid,
  meal_type: z.string(),
  serving_date: dateString.nullable(),
  household_members: z
    .union([z.object({ display_name: z.string() }), z.array(z.object({ display_name: z.string() })), z.null()])
    .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
  member_serving_components: z
    .union([
      z.array(
        z.object({
          ingredient_id: uuid.nullable(),
          product_id: uuid.nullable(),
          label: z.string(),
          proposed_quantity: numeric,
          unit: z.enum(["G", "ML"]),
          weight_basis: z.string(),
          cooking_method: z.string().nullable(),
          added_fat_g: nullableNumeric,
        }),
      ),
      z.null(),
    ])
    .transform((v) => v ?? []),
});

export async function loadShoppingContext(
  db: Db,
  householdId: string,
  weekStart: string,
): Promise<ShoppingContext> {
  const { data: planId, error: planError } = await db.rpc("ensure_weekly_plan", {
    p_household_id: householdId,
    p_week_start: weekStart,
  });
  if (planError) throw new DataAccessError("semana para la compra", planError);

  const { data: dayRows, error: diasError } = await db
    .from("weekly_plan_days")
    .select("id, plan_date")
    .eq("plan_id", planId);
  if (diasError) throw new DataAccessError("días de la semana", diasError);
  const days = parseRows(z.object({ id: uuid, plan_date: dateString }), dayRows, "días de la semana");
  const fechaPorDia = new Map(days.map((d) => [d.id, d.plan_date]));

  const { data: asigRows, error: asigError } = await db
    .from("meal_assignments")
    .select(
      `id, day_id, meal_type, kind, status,
       meal_template_versions ( name )`,
    )
    .in("day_id", days.map((d) => d.id));
  if (asigError) throw new DataAccessError("comidas de la semana", asigError);

  const asignaciones = parseRows(
    z.object({
      id: uuid,
      day_id: uuid,
      meal_type: z.string(),
      kind: z.string(),
      status: z.string(),
      meal_template_versions: z
        .union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() })), z.null()])
        .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
    }),
    asigRows,
    "comidas de la semana",
  );

  // §31: la lista oficial sale solo de lo confirmado; lo pendiente se informa.
  const unconfirmed = asignaciones
    .filter((a) => a.kind === "RECIPE" && a.status === "PLANNED")
    .map((a) => ({
      date: fechaPorDia.get(a.day_id) ?? "",
      mealType: a.meal_type as MealType,
      recipeName: a.meal_template_versions?.name ?? null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const confirmadas = asignaciones
    .filter((a) => a.status === "CONFIRMED" || a.status === "SERVED")
    .map((a) => a.id);

  let servings: ConfirmedServing[] = [];
  if (confirmadas.length > 0) {
    const { data, error } = await db
      .from("member_serving_projections")
      .select(
        `id, assignment_id, member_id, meal_type, serving_date,
         household_members ( display_name ),
         member_serving_components (
           ingredient_id, product_id, label, proposed_quantity, unit,
           weight_basis, cooking_method, added_fat_g
         )`,
      )
      .in("assignment_id", confirmadas)
      .neq("status", "CANCELLED");
    if (error) throw new DataAccessError("porciones confirmadas", error);

    const asigPorId = new Map(asignaciones.map((a) => [a.id, a]));
    servings = parseRows(servingRowSchema, data, "porciones confirmadas").map((row) => {
      const asig = asigPorId.get(row.assignment_id);
      const fecha =
        row.serving_date ?? (asig ? (fechaPorDia.get(asig.day_id) ?? "") : "");
      return {
        assignmentId: row.assignment_id,
        date: fecha,
        mealType: row.meal_type as MealType,
        memberId: row.member_id,
        memberName: row.household_members?.display_name ?? "Integrante",
        components: row.member_serving_components.map((c) => ({
          ingredientId: c.ingredient_id,
          productId: c.product_id,
          label: c.label,
          quantity: c.proposed_quantity,
          unit: c.unit,
          weightBasis: c.weight_basis as WeightBasis,
          cookingMethod: c.cooking_method,
          addedFatG: c.added_fat_g ?? 0,
        })),
      };
    });
  }

  // Rendimientos, identidad y formatos: solo lo que estas porciones necesitan.
  const ingredientIds = [
    ...new Set(servings.flatMap((s) => s.components.map((c) => c.ingredientId)).filter(Boolean)),
  ] as string[];
  const productIds = [
    ...new Set(servings.flatMap((s) => s.components.map((c) => c.productId)).filter(Boolean)),
  ] as string[];

  let yields: YieldEntry[] = [];
  let ingredients: IngredientMeta[] = [];
  if (ingredientIds.length > 0) {
    const [yieldsRes, ingRes] = await Promise.all([
      db
        .from("ingredient_yields")
        .select("ingredient_id, cooking_method, yield_factor")
        .in("ingredient_id", ingredientIds),
      db
        .from("ingredients")
        .select("id, display_name, edible_portion_factor, ingredient_categories ( code )")
        .in("id", ingredientIds),
    ]);
    if (yieldsRes.error) throw new DataAccessError("rendimientos crudo-cocido", yieldsRes.error);
    if (ingRes.error) throw new DataAccessError("alimentos de la compra", ingRes.error);

    yields = parseRows(
      z.object({ ingredient_id: uuid, cooking_method: z.string().nullable(), yield_factor: numeric }),
      yieldsRes.data,
      "rendimientos crudo-cocido",
    ).map((y) => ({ ingredientId: y.ingredient_id, cookingMethod: y.cooking_method, factor: y.yield_factor }));

    ingredients = parseRows(
      z.object({
        id: uuid,
        display_name: z.string(),
        edible_portion_factor: nullableNumeric,
        ingredient_categories: z
          .union([z.object({ code: z.string() }), z.array(z.object({ code: z.string() })), z.null()])
          .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
      }),
      ingRes.data,
      "alimentos de la compra",
    ).map((i) => ({
      id: i.id,
      label: i.display_name,
      categoryCode: i.ingredient_categories?.code ?? null,
      ediblePortionFactor: i.edible_portion_factor,
    }));
  }

  let products: ProductMeta[] = [];
  if (productIds.length > 0) {
    const { data, error } = await db
      .from("commercial_products")
      .select("id, name, brand, package_quantity, package_unit")
      .in("id", productIds);
    if (error) throw new DataAccessError("productos de la compra", error);
    products = parseRows(
      z.object({
        id: uuid,
        name: z.string(),
        brand: z.string().nullable(),
        package_quantity: nullableNumeric,
        package_unit: z.enum(["G", "ML"]).nullable(),
      }),
      data,
      "productos de la compra",
    ).map((p) => ({
      id: p.id,
      label: p.brand ? `${p.brand} ${p.name}` : p.name,
      packageQuantity: p.package_quantity,
      packageUnit: p.package_unit,
    }));
  }

  return {
    planId: planId as string,
    weekStart,
    input: { servings, yields, ingredients, products },
    unconfirmed,
  };
}

// ---------------------------------------------------------------------------
// La lista guardada
// ---------------------------------------------------------------------------

export interface ShoppingItem {
  id: string;
  source: "FOOD_PLAN" | "MANUAL";
  lineKey: string | null;
  ingredientId: string | null;
  productId: string | null;
  label: string;
  unit: ShoppingUnit;
  requiredQuantity: number | null;
  plannedQuantity: number | null;
  purchaseBasis: PurchaseBasis;
  cookedQuantity: number | null;
  yieldFactor: number | null;
  unresolved: boolean;
  unresolvedReason: string | null;
  provenance: { assignmentId: string; date: string; mealType: MealType; quantity: number; members: string[] }[];
  status: "PENDING" | "PURCHASED" | "SKIPPED" | "HAVE_ENOUGH";
  statusReason: string | null;
  categoryCode: string | null;
}

export interface ShoppingListData {
  id: string;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  currentRevision: number;
  /** Firma de las entradas de la revisión vigente, para detectar cambios (§34). */
  currentSignature: string | null;
  items: ShoppingItem[];
}

const categoriaEmbebida = z
  .union([z.object({ code: z.string() }), z.array(z.object({ code: z.string() })), z.null()])
  .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

const itemRowSchema = z.object({
  id: uuid,
  source: z.enum(["FOOD_PLAN", "MANUAL"]),
  line_key: z.string().nullable(),
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  label: z.string(),
  unit: z.enum(["G", "ML", "UNIT"]),
  required_quantity: nullableNumeric,
  planned_quantity: nullableNumeric,
  purchase_basis: z.enum(["RAW", "COMMERCIAL_PACKAGE", "UNIT", "DRAINED", "OTHER"]),
  cooked_quantity: nullableNumeric,
  yield_factor: nullableNumeric,
  unresolved: z.boolean(),
  unresolved_reason: z.string().nullable(),
  provenance: z.array(
    z.object({
      assignmentId: z.string(),
      date: z.string(),
      mealType: z.string(),
      quantity: z.number(),
      members: z.array(z.string()),
    }),
  ),
  status: z.enum(["PENDING", "PURCHASED", "SKIPPED", "HAVE_ENOUGH"]),
  status_reason: z.string().nullable(),
  ingredients: z
    .union([
      z.object({ ingredient_categories: categoriaEmbebida }),
      z.array(z.object({ ingredient_categories: categoriaEmbebida })),
      z.null(),
    ])
    .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
});

export async function loadShoppingList(db: Db, planId: string): Promise<ShoppingListData | null> {
  const { data: lista, error } = await db
    .from("shopping_lists")
    .select("id, status, current_revision")
    .eq("plan_id", planId)
    .maybeSingle();
  if (error) throw new DataAccessError("lista de compras", error);
  if (!lista) return null;

  const cabecera = z
    .object({
      id: uuid,
      status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]),
      current_revision: z.number().int(),
    })
    .parse(lista);

  let currentSignature: string | null = null;
  if (cabecera.current_revision > 0) {
    const { data: rev, error: revError } = await db
      .from("shopping_list_revisions")
      .select("input_signature")
      .eq("list_id", cabecera.id)
      .eq("revision_number", cabecera.current_revision)
      .maybeSingle();
    if (revError) throw new DataAccessError("revisión de la lista", revError);
    currentSignature = rev?.input_signature ?? null;
  }

  const { data: itemRows, error: itemsError } = await db
    .from("shopping_list_items")
    .select(
      `id, source, line_key, ingredient_id, product_id, label, unit,
       required_quantity, planned_quantity, purchase_basis, cooked_quantity,
       yield_factor, unresolved, unresolved_reason, provenance, status, status_reason,
       ingredients ( ingredient_categories ( code ) )`,
    )
    .eq("list_id", cabecera.id)
    .order("label");
  if (itemsError) throw new DataAccessError("productos de la lista", itemsError);

  const items = parseRows(itemRowSchema, itemRows, "productos de la lista").map((row) => ({
    id: row.id,
    source: row.source,
    lineKey: row.line_key,
    ingredientId: row.ingredient_id,
    productId: row.product_id,
    label: row.label,
    unit: row.unit,
    requiredQuantity: row.required_quantity,
    plannedQuantity: row.planned_quantity,
    purchaseBasis: row.purchase_basis,
    cookedQuantity: row.cooked_quantity,
    yieldFactor: row.yield_factor,
    unresolved: row.unresolved,
    unresolvedReason: row.unresolved_reason,
    provenance: row.provenance.map((p) => ({ ...p, mealType: p.mealType as MealType })),
    status: row.status,
    statusReason: row.status_reason,
    categoryCode: row.ingredients?.ingredient_categories?.code ?? null,
  }));

  return {
    id: cabecera.id,
    status: cabecera.status,
    currentRevision: cabecera.current_revision,
    currentSignature,
    items,
  };
}
