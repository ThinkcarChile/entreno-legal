"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { createProductSchema, type CreateProductInput } from "@/domain/catalog/schemas";
import { normalizeLabelToPer100 } from "@/domain/catalog/nutrition";
import { NUTRIENT_KEYS, type NutritionValues } from "@/domain/catalog/types";
import { DataAccessError } from "@/lib/supabase/unwrap";

export interface CreateProductResult {
  ok: boolean;
  productId?: string;
  error?: string;
}

/** Redondeo solo en el borde de persistencia (3 decimales — ADR 0001 §7). */
function toDb(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.round(value * 1000) / 1000;
}

export async function createProduct(input: CreateProductInput): Promise<CreateProductResult> {
  const parsed = createProductSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }
  const data = parsed.data;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/catalog/product/new");

  const { data: membership, error: errorMembership } = await supabase
    .from("household_members")
    .select("id, household_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (errorMembership) throw new DataAccessError("hogar del usuario", errorMembership);
  if (!membership) {
    return { ok: false, error: "Primero crea o únete a un hogar (pestaña Familia)." };
  }

  // Nutrición: normalizar a por-100 si vino por porción; conservar el original.
  let per100: NutritionValues = data.nutrition;
  let original: { quantity: number; unit: "G" | "ML"; values: NutritionValues } | null = null;
  if (data.nutritionMode === "PER_SERVING") {
    const normalized = normalizeLabelToPer100({
      servingQuantity: data.servingQuantity as number,
      servingUnit: data.servingUnit,
      values: data.nutrition,
    });
    per100 = normalized.per100;
    original = {
      quantity: data.servingQuantity as number,
      unit: data.servingUnit,
      values: data.nutrition,
    };
  }

  const { data: product, error: productError } = await supabase
    .from("commercial_products")
    .insert({
      household_id: membership.household_id,
      barcode: data.barcode,
      brand: data.brand,
      name: data.name,
      package_quantity: data.packageQuantity,
      package_unit: data.packageUnit,
      serving_quantity: data.servingQuantity,
      serving_unit: data.servingUnit,
      serving_name: data.servingName,
      source: "USER_ENTERED_LABEL",
      created_by: membership.id,
    })
    .select("id")
    .single();

  if (productError || !product) {
    if (productError?.code === "23505") {
      return { ok: false, error: "Ese código de barras ya existe en tu hogar." };
    }
    return { ok: false, error: "No se pudo guardar el producto." };
  }

  const nutritionRow: Record<string, unknown> = {
    product_id: product.id,
    household_id: membership.household_id,
    weight_basis: "AS_PACKAGED",
    basis_unit: data.nutritionMode === "PER_SERVING" ? data.servingUnit : data.packageUnit,
    source_type: "USER_ENTERED_LABEL",
    source_name: "Etiqueta del envase (ingreso manual)",
    original_serving_quantity: original?.quantity ?? null,
    original_serving_unit: original?.unit ?? null,
    original_values: original ? original.values : null,
  };
  for (const key of NUTRIENT_KEYS) {
    nutritionRow[key] = toDb(per100[key]);
  }

  const { error: nutritionError } = await supabase.from("nutrition_facts").insert(nutritionRow);
  if (nutritionError) {
    return { ok: false, error: "Producto creado, pero la nutrición no se pudo guardar." };
  }

  return { ok: true, productId: product.id };
}
