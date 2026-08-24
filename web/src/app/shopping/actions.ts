"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  aggregateDemand,
  computeDeltas,
  demandSignature,
  SHOPPING_ENGINE_VERSION,
  type DemandDelta,
  type DemandLine,
} from "@/domain/shopping/engine";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadShoppingContext, loadShoppingList } from "./queries";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  deltas?: DemandDelta[];
}

async function client() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/shopping");
  return supabase;
}

/**
 * Genera (o actualiza) la lista de la semana desde las porciones CONFIRMADAS.
 *
 * Nunca sobreescribe en silencio (§24): cada generación es una revisión con su
 * firma de entradas y sus deltas. Si las entradas no cambiaron, no pasa nada —
 * misma firma, misma lista (§51). La escritura completa ocurre en UNA
 * transacción en la base (`generate_shopping_revision`): o pasa todo o no pasa
 * nada, y el checklist sobrevive identificado por la clave estable de cada
 * línea.
 */
export async function regenerateList(weekStart: string): Promise<ActionResult> {
  const supabase = await client();
  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Primero crea o únete a un hogar." };
  const yo = members.find((m) => m.isMe)?.id ?? null;

  const contexto = await loadShoppingContext(supabase, householdId, weekStart);
  const lines = aggregateDemand(contexto.input);
  const firma = demandSignature(contexto.input);

  // La lista de la semana, creada si no existe. Si dos personas la crean a la
  // vez, el unique (plan_id) hace ganar a una y la otra simplemente la relee.
  let lista = await loadShoppingList(supabase, contexto.planId);
  if (!lista) {
    const { error } = await supabase.from("shopping_lists").insert({
      household_id: householdId,
      plan_id: contexto.planId,
      status: "ACTIVE",
      created_by: yo,
    });
    lista = await loadShoppingList(supabase, contexto.planId);
    if (!lista) {
      if (error) throw new DataAccessError("creación de la lista de compras", error);
      return { ok: false, error: "No se pudo crear la lista de compras. Intenta de nuevo." };
    }
  }

  if (lista.status === "COMPLETED") {
    return { ok: false, error: "Esta compra ya se finalizó: la lista quedó cerrada." };
  }

  // §51: mismas entradas = misma revisión. No se duplica nada.
  if (lista.currentSignature === firma) {
    return { ok: true, message: "La lista ya está al día.", deltas: [] };
  }

  // Deltas contra lo que la lista dice HOY (§25): es lo que la persona ve.
  const antes = lista.items
    .filter((i) => i.source === "FOOD_PLAN" && i.lineKey)
    .map((i) => ({
      key: i.lineKey!,
      label: i.label,
      unit: i.unit,
      requiredQuantity: i.requiredQuantity ?? 0,
    }));
  const deltas = computeDeltas(antes, lines).filter((d) => d.kind !== "UNCHANGED");

  const { data: numero, error: revError } = await supabase.rpc("generate_shopping_revision", {
    p_list_id: lista.id,
    p_signature: firma,
    p_engine: SHOPPING_ENGINE_VERSION,
    p_reasons: deltas,
    p_payload: lines,
    p_items: lines.map((l) => ({
      line_key: l.key,
      ingredient_id: l.ingredientId,
      product_id: l.productId,
      label: l.label,
      unit: l.unit,
      required_quantity: l.requiredQuantity,
      purchase_basis: l.purchaseBasis,
      cooked_quantity: l.cookedQuantity,
      yield_factor: l.yieldFactor,
      unresolved: l.unresolved,
      unresolved_reason: l.unresolvedReason,
      provenance: l.provenance,
    })),
  });
  if (revError) {
    return { ok: false, error: `No se pudo actualizar la lista: ${revError.message}` };
  }

  revalidatePath("/shopping");
  return {
    ok: true,
    message:
      Number(numero) === 1
        ? `Lista generada con ${lines.length} productos.`
        : `Lista actualizada (revisión ${numero}).`,
    deltas,
  };
}

/**
 * Marca un producto: comprado, ya lo tengo, no lo llevo, o vuelve a pendiente.
 * `purchased_by`/`purchased_at` los estampa la base con quien está autenticado.
 */
export async function setItemStatus(
  itemId: string,
  status: "PENDING" | "PURCHASED" | "SKIPPED" | "HAVE_ENOUGH",
): Promise<ActionResult> {
  const supabase = await client();

  const bloqueada = await listaCerrada(supabase, itemId);
  if (bloqueada) return bloqueada;

  const { data, error } = await supabase
    .from("shopping_list_items")
    .update({
      status,
      status_reason: status === "HAVE_ENOUGH" ? "IN_STOCK" : null,
      purchased_at: status === "PURCHASED" ? new Date().toISOString() : null,
      purchased_by: null, // lo estampa el trigger con quien es de verdad
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .select("id");
  if (error) return { ok: false, error: "No se pudo actualizar el producto." };
  // RLS con cero filas NO es éxito: es "no tienes permiso o ya no existe".
  if (!data || data.length === 0) {
    return { ok: false, error: "No se pudo actualizar: no tienes permiso o el producto ya no está." };
  }

  revalidatePath("/shopping");
  return { ok: true };
}

/**
 * §21/§22: el comprador decide comprar otra cantidad. La necesidad calculada
 * NUNCA se pierde y el cambio queda auditado — cantidad y auditoría se
 * escriben juntas en una transacción (`set_planned_quantity`).
 * `quantity = null` vuelve a la cantidad calculada.
 */
export async function editPlannedQuantity(
  itemId: string,
  quantity: number | null,
  reason?: string,
): Promise<ActionResult> {
  if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) {
    return { ok: false, error: "La cantidad tiene que ser un número positivo." };
  }
  const supabase = await client();

  const { error } = await supabase.rpc("set_planned_quantity", {
    p_item_id: itemId,
    p_quantity: quantity,
    p_reason: reason ?? null,
  });
  if (error) return { ok: false, error: `No se pudo guardar la cantidad: ${error.message}` };

  revalidatePath("/shopping");
  return {
    ok: true,
    message: quantity === null ? "Vuelve a la cantidad calculada." : "Cantidad de compra actualizada.",
  };
}

/** §38: un producto manual — detergente — que no viene de ninguna receta. */
export async function addManualItem(
  listId: string,
  label: string,
  quantity: number | null,
  unit: "G" | "ML" | "UNIT",
): Promise<ActionResult> {
  const limpio = label.trim();
  if (!limpio) return { ok: false, error: "Escribe qué hay que comprar." };
  if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) {
    return { ok: false, error: "La cantidad tiene que ser un número positivo." };
  }
  const supabase = await client();

  const { data: cabecera, error: cabError } = await supabase
    .from("shopping_lists")
    .select("status")
    .eq("id", listId)
    .maybeSingle();
  if (cabError) throw new DataAccessError("lista para agregar producto", cabError);
  if (cabecera?.status === "COMPLETED") {
    return { ok: false, error: "Esta compra ya se finalizó: reábrela para agregar productos." };
  }

  const { data, error } = await supabase
    .from("shopping_list_items")
    .insert({
      list_id: listId,
      source: "MANUAL",
      label: limpio,
      unit,
      planned_quantity: quantity,
      purchase_basis: "OTHER",
    })
    .select("id");
  if (error || !data || data.length === 0) {
    return { ok: false, error: "No se pudo agregar el producto." };
  }

  revalidatePath("/shopping");
  return { ok: true, message: `${limpio} agregado a la lista.` };
}

/** Quitar un producto manual. Los calculados no se borran a mano: se replanifica. */
export async function removeManualItem(itemId: string): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase
    .from("shopping_list_items")
    .delete()
    .eq("id", itemId)
    .eq("source", "MANUAL")
    .select("id");
  if (error) return { ok: false, error: "No se pudo quitar el producto." };
  if (!data || data.length === 0) {
    return { ok: false, error: "No se pudo quitar: no tienes permiso o ya no está." };
  }
  revalidatePath("/shopping");
  return { ok: true };
}

/** §36: fin de la compra. La recepción real llega con el InventoryEngine. */
export async function completeList(listId: string): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase
    .from("shopping_lists")
    .update({ status: "COMPLETED", completed_at: new Date().toISOString() })
    .eq("id", listId)
    .select("id");
  if (error) return { ok: false, error: "No se pudo finalizar la compra." };
  if (!data || data.length === 0) {
    return { ok: false, error: "No se pudo finalizar: no tienes permiso." };
  }
  revalidatePath("/shopping");
  return { ok: true, message: "Compra finalizada." };
}

/** Reabrir una compra finalizada por error. */
export async function reopenList(listId: string): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase
    .from("shopping_lists")
    .update({ status: "ACTIVE", completed_at: null })
    .eq("id", listId)
    .select("id");
  if (error) return { ok: false, error: "No se pudo reabrir la compra." };
  if (!data || data.length === 0) {
    return { ok: false, error: "No se pudo reabrir: no tienes permiso." };
  }
  revalidatePath("/shopping");
  return { ok: true, message: "Compra reabierta." };
}

/** Deltas SIN aplicar (§34): qué cambiaría si se actualiza la lista ahora. */
export async function previewDeltas(weekStart: string): Promise<ActionResult> {
  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Sin hogar." };

  const contexto = await loadShoppingContext(supabase, householdId, weekStart);
  const lista = await loadShoppingList(supabase, contexto.planId);
  if (!lista) return { ok: true, deltas: [] };

  const lines: DemandLine[] = aggregateDemand(contexto.input);
  const antes = lista.items
    .filter((i) => i.source === "FOOD_PLAN" && i.lineKey)
    .map((i) => ({
      key: i.lineKey!,
      label: i.label,
      unit: i.unit,
      requiredQuantity: i.requiredQuantity ?? 0,
    }));
  return {
    ok: true,
    deltas: computeDeltas(antes, lines).filter((d) => d.kind !== "UNCHANGED"),
  };
}

/** §36 en el servidor, no solo en la UI: nada se edita en una compra cerrada. */
async function listaCerrada(
  supabase: Awaited<ReturnType<typeof client>>,
  itemId: string,
): Promise<ActionResult | null> {
  const { data, error } = await supabase
    .from("shopping_list_items")
    .select("shopping_lists ( status )")
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw new DataAccessError("estado de la lista", error);
  const lista = data?.shopping_lists as { status?: string } | { status?: string }[] | null;
  const status = Array.isArray(lista) ? lista[0]?.status : lista?.status;
  if (status === "COMPLETED") {
    return { ok: false, error: "Esta compra ya se finalizó: reábrela para seguir editando." };
  }
  return null;
}
