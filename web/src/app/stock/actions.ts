"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  /** true SOLO si la acción escribió una línea (Gate 0→10 [M-3]). */
  added?: boolean;
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
  /** Base física del bucket que recomendó (Gate 0→10 [S-2]). Los buckets de
   * Stock Intelligence son RAW/COOKED/DRAINED; cualquier otra base se compra
   * como RAW (misma regla que el bucketDeLote del motor). */
  weightBasis: string;
}): Promise<ActionResult> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return { ok: false, error: "La cantidad tiene que ser mayor que cero." };
  }
  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Sin hogar." };

  // Gate 0→10 [S-2]: la base física de la recomendación viaja hasta la línea.
  // Antes se escribía purchase_basis 'RAW' fijo: la sugerencia de un bucket
  // DRAINED quedaba como RAW, la clave de neteo de Procurement nunca calzaba
  // y el hogar pedía la MISMA necesidad al súper Y al proveedor.
  // Un bucket COCIDO no se compra en gramos cocidos: se convierte a crudo con
  // el rendimiento ANOTADO, o se rechaza con la razón — nunca 1:1.
  let cantidadPedida = input.quantity;
  let basisCompra: "RAW" | "DRAINED" = input.weightBasis === "DRAINED" ? "DRAINED" : "RAW";
  if (input.weightBasis === "COOKED") {
    const { data: yieldData, error: yieldError } = await supabase
      .from("ingredient_yields")
      .select("yield_factor, cooking_method")
      .eq("ingredient_id", input.ingredientId);
    if (yieldError) return { ok: false, error: "No se pudo leer el rendimiento del alimento." };
    const generico = (yieldData ?? []).find((y) => y.cooking_method === null);
    const factor = generico ? Number(generico.yield_factor) : null;
    if (factor === null || !Number.isFinite(factor) || factor <= 0) {
      return {
        ok: false,
        error: `${input.label} está medido en gramos cocidos y no hay rendimiento anotado: no se puede convertir a compra en crudo.`,
      };
    }
    cantidadPedida = Math.round((input.quantity / factor) * 1000) / 1000;
    basisCompra = "RAW";
  }

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
    .eq("unit", input.unit)
    // [S-2]: una línea DRAINED pendiente NO descuenta la necesidad RAW.
    .eq("purchase_basis", basisCompra);
  if (planItemError) return { ok: false, error: "No se pudo revisar la lista." };
  const yaPedido = (delPlan ?? [])
    .filter((i) => i.status === "PENDING")
    .reduce((acc, i) => acc + Number(i.planned_quantity ?? i.required_quantity ?? 0), 0);

  // Sprint 9: lo que ya viene EN CAMINO en órdenes de abastecimiento vivas
  // también cubre esta recomendación — la lista y el proveedor no deben
  // comprar la misma necesidad dos veces (neteo en AMBAS direcciones).
  const { data: enCaminoData, error: enCaminoError } = await supabase
    .from("procurement_order_items")
    .select("suggested_quantity, unit, procurement_orders!inner ( household_id, status )")
    .eq("ingredient_id", input.ingredientId)
    .eq("unit", input.unit)
    .eq("weight_basis", basisCompra)
    .eq("procurement_orders.household_id", householdId)
    .in("procurement_orders.status", ["PLANNED", "ORDERED", "READY", "DELIVERING"]);
  if (enCaminoError) return { ok: false, error: "No se pudo revisar las órdenes en camino." };
  const enCamino = (enCaminoData ?? []).reduce((acc, i) => acc + Number(i.suggested_quantity ?? 0), 0);

  const cantidad = Math.round(Math.max(0, cantidadPedida - yaPedido - enCamino) * 1000) / 1000;
  if (cantidad <= 0) {
    return {
      ok: true,
      // [M-3]: no se escribió nada — el botón no debe decir "Agregado".
      added: false,
      message:
        enCamino > 0
          ? `Lo recomendado de ${input.label} ya viene cubierto (lista pendiente + órdenes en camino).`
          : `La línea del plan en la lista ya cubre lo recomendado de ${input.label}.`,
    };
  }

  const { data: existentes, error: exError } = await supabase
    .from("shopping_list_items")
    .select("id, planned_quantity")
    .eq("list_id", lista.id)
    .eq("source", "STOCK_INTELLIGENCE")
    .eq("ingredient_id", input.ingredientId)
    .eq("unit", input.unit)
    .eq("purchase_basis", basisCompra)
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
        purchase_basis: basisCompra,
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
        .eq("unit", input.unit)
        .eq("purchase_basis", basisCompra)
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
    cantidad < cantidadPedida
      ? ` (descontando lo que la lista del plan ya pide: ${Math.round((cantidadPedida - cantidad) * 10) / 10})`
      : "";
  return {
    ok: true,
    added: true,
    message: `${input.label} agregado a la próxima compra como sugerencia${nota}.`,
  };
}
