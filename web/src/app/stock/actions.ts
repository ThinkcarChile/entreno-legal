"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

async function client() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pantry");
  return supabase;
}

function refrescar() {
  revalidatePath("/pantry");
  revalidatePath("/pantry/reorder");
  revalidatePath("/shopping");
}

/** §32: "¿Cuánto quieres mantener en casa?" — el objetivo lo decide el hogar. */
export async function setStockTarget(input: {
  ingredientId: string;
  unit: "G" | "ML" | "UNIT";
  minimumQuantity: number | null;
  targetQuantity: number | null;
  targetDaysOfSupply: number | null;
  reviewCycle: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "MIN_STOCK" | "CUSTOM" | null;
  reorderEnabled: boolean;
}): Promise<ActionResult> {
  for (const [nombre, valor] of [
    ["mínima", input.minimumQuantity],
    ["objetivo", input.targetQuantity],
  ] as const) {
    if (valor !== null && (!Number.isFinite(valor) || valor < 0)) {
      return { ok: false, error: `La cantidad ${nombre} tiene que ser un número positivo.` };
    }
  }
  if (
    input.targetDaysOfSupply !== null &&
    (!Number.isInteger(input.targetDaysOfSupply) ||
      input.targetDaysOfSupply < 1 ||
      input.targetDaysOfSupply > 90)
  ) {
    return { ok: false, error: "Los días de cobertura van de 1 a 90." };
  }

  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Primero crea o únete a un hogar." };

  const { error } = await supabase.rpc("set_stock_target", {
    p_household_id: householdId,
    p_ingredient_id: input.ingredientId,
    p_unit: input.unit,
    p_minimum_quantity: input.minimumQuantity,
    p_target_quantity: input.targetQuantity,
    p_target_days_of_supply: input.targetDaysOfSupply,
    p_safety_stock: null,
    p_review_cycle: input.reviewCycle,
    p_reorder_enabled: input.reorderEnabled,
  });
  if (error) return { ok: false, error: `No se pudo guardar el objetivo: ${error.message}` };

  refrescar();
  return { ok: true, message: "Objetivo de stock guardado." };
}

/** Quitar el objetivo: vuelve al comportamiento por defecto. */
export async function deleteStockTarget(ingredientId: string): Promise<ActionResult> {
  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Sin hogar." };

  const { error } = await supabase.rpc("delete_stock_target", {
    p_household_id: householdId,
    p_ingredient_id: ingredientId,
  });
  if (error) return { ok: false, error: "No se pudo quitar el objetivo." };
  refrescar();
  return { ok: true, message: "Objetivo quitado." };
}

/**
 * §33/§34: la recomendación llega a la lista como SUGERENCIA con procedencia
 * STOCK_INTELLIGENCE. Shopping sigue siendo el dueño de la lista: acá no se
 * crean compras recibidas ni lotes, y jamás se compra solo.
 */
export async function addReorderToShoppingList(input: {
  weekStart: string;
  ingredientId: string;
  label: string;
  quantity: number;
  unit: "G" | "ML" | "UNIT";
}): Promise<ActionResult> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return { ok: false, error: "La cantidad tiene que ser mayor que cero." };
  }
  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Sin hogar." };

  // La lista de la semana (se crea si no existe, igual que en /shopping).
  const { data: planId, error: planError } = await supabase.rpc("ensure_weekly_plan", {
    p_household_id: householdId,
    p_week_start: input.weekStart,
  });
  if (planError) return { ok: false, error: "No se pudo preparar la semana de compras." };

  const cabecera = await supabase
    .from("shopping_lists")
    .select("id, status")
    .eq("plan_id", planId)
    .maybeSingle();
  if (cabecera.error) return { ok: false, error: "No se pudo leer la lista de compras." };
  let lista = cabecera.data;

  if (!lista) {
    const { error } = await supabase
      .from("shopping_lists")
      .insert({ household_id: householdId, plan_id: planId, status: "ACTIVE" });
    if (error && error.code !== "23505") {
      return { ok: false, error: "No se pudo preparar la lista de compras." };
    }
    const relectura = await supabase
      .from("shopping_lists")
      .select("id, status")
      .eq("plan_id", planId)
      .maybeSingle();
    if (relectura.error) return { ok: false, error: "No se pudo leer la lista de compras." };
    lista = relectura.data;
  }
  if (!lista) return { ok: false, error: "No se pudo preparar la lista de compras." };
  if (lista.status === "COMPLETED") {
    return { ok: false, error: "La compra de esa semana ya se finalizó: reábrela primero." };
  }

  // Si ya existe la sugerencia para este alimento, se actualiza la cantidad
  // en vez de duplicar la línea.
  // §8-C de la revisión: la línea del PLAN de esta lista ya cubre la demanda
  // confirmada. La recomendación incluye ese faltante — sumar ambas sería
  // doble conteo. Se descuenta lo que la lista ya pide pendiente.
  const { data: delPlan, error: planItemError } = await supabase
    .from("shopping_list_items")
    .select("required_quantity, planned_quantity, status")
    .eq("list_id", lista.id)
    .eq("source", "FOOD_PLAN")
    .eq("ingredient_id", input.ingredientId)
    .eq("unit", input.unit);
  if (planItemError) return { ok: false, error: "No se pudo revisar la lista." };
  const yaPedido = (delPlan ?? [])
    .filter((i) => i.status === "PENDING")
    .reduce((acc, i) => acc + Number(i.planned_quantity ?? i.required_quantity ?? 0), 0);
  const cantidad = Math.round(Math.max(0, input.quantity - yaPedido) * 1000) / 1000;
  if (cantidad <= 0) {
    return {
      ok: true,
      message: `La línea del plan en la lista ya cubre lo recomendado de ${input.label}.`,
    };
  }

  const { data: existentes, error: exError } = await supabase
    .from("shopping_list_items")
    .select("id, planned_quantity")
    .eq("list_id", lista.id)
    .eq("source", "STOCK_INTELLIGENCE")
    .eq("ingredient_id", input.ingredientId)
    .limit(1);
  if (exError) return { ok: false, error: "No se pudo revisar la lista." };
  const existente = existentes?.[0] ?? null;

  const actualizar = async (id: string, original: number | null) => {
    // Solo una sugerencia PENDIENTE se re-cuantifica: si ya se compró o se
    // decidió sobre ella, tocarla en silencio reescribiría una decisión.
    const { data, error } = await supabase
      .from("shopping_list_items")
      .update({ planned_quantity: cantidad, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "PENDING")
      .select("id");
    if (error) return { ok: false as const, error: "No se pudo actualizar la sugerencia." };
    if (!data || data.length === 0) {
      return {
        ok: false as const,
        error: "Esa sugerencia ya no está pendiente en la lista: revísala en Compras.",
      };
    }
    // El cambio de cantidad queda auditado, como toda edición de compra (§22).
    await supabase.from("shopping_item_overrides").insert({
      item_id: id,
      original_quantity: original,
      new_quantity: cantidad,
      reason: "recalculado por Stock Intelligence",
    });
    return { ok: true as const };
  };

  if (existente) {
    const r = await actualizar(existente.id, Number(existente.planned_quantity ?? 0) || null);
    if (!r.ok) return r;
  } else {
    const { data, error } = await supabase
      .from("shopping_list_items")
      .insert({
        list_id: lista.id,
        source: "STOCK_INTELLIGENCE",
        ingredient_id: input.ingredientId,
        label: input.label,
        unit: input.unit,
        planned_quantity: cantidad,
        purchase_basis: "RAW",
      })
      .select("id");
    if (error?.code === "23505") {
      // Carrera de dos clics: el unique ganó por nosotros — se actualiza la
      // fila que llegó primero.
      const { data: fila, error: relecturaError } = await supabase
        .from("shopping_list_items")
        .select("id, planned_quantity")
        .eq("list_id", lista.id)
        .eq("source", "STOCK_INTELLIGENCE")
        .eq("ingredient_id", input.ingredientId)
        .maybeSingle();
      if (relecturaError || !fila) {
        return { ok: false, error: "No se pudo agregar la sugerencia a la lista." };
      }
      const r = await actualizar(fila.id, Number(fila.planned_quantity ?? 0) || null);
      if (!r.ok) return r;
    } else if (error || !data || data.length === 0) {
      return { ok: false, error: "No se pudo agregar la sugerencia a la lista." };
    }
  }

  refrescar();
  const nota =
    cantidad < input.quantity
      ? ` (descontando lo que la lista del plan ya pide: ${Math.round((input.quantity - cantidad) * 10) / 10})`
      : "";
  return { ok: true, message: `${input.label} agregado a la próxima compra como sugerencia${nota}.` };
}
