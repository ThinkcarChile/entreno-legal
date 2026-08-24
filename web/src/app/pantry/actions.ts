"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { z } from "zod";
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
  revalidatePath("/shopping");
  revalidatePath("/plan");
}

/**
 * Recibir la compra finalizada: lo COMPRADO se vuelve lotes de despensa.
 * Idempotente en la base (K-22): apretar dos veces no duplica nada.
 */
export async function receiveShoppingList(listId: string): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("receive_shopping_list", {
    p_list_id: listId,
    p_location_id: null,
  });
  if (error) return { ok: false, error: `No se pudo recibir la compra: ${error.message}` };

  refrescar();
  const n = Number(data);
  return {
    ok: true,
    message:
      n === 0
        ? "Nada nuevo que recibir: esta compra ya estaba en la despensa."
        : `${n} ${n === 1 ? "lote recibido" : "lotes recibidos"} en la despensa.`,
  };
}

/**
 * "Comimos lo planificado": porciones a CONSUMED + descuento FEFO. Si la
 * despensa tenía menos de lo declarado, el desajuste queda persistido y se
 * dice de inmediato — el consumo declarado jamás se reduce.
 */
export async function consumePlannedMeal(assignmentId: string): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("consume_planned_meal", {
    p_assignment_id: assignmentId,
  });
  if (error) return { ok: false, error: `No se pudo registrar el consumo: ${error.message}` };

  const parsed = z
    .object({
      servings: z.number(),
      shortfalls: z.array(
        z.object({ label: z.string(), quantity: z.number(), unit: z.string() }),
      ),
    })
    .safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: "El registro de consumo devolvió una forma inesperada." };
  }
  const { servings, shortfalls } = parsed.data;

  refrescar();
  if (servings === 0) {
    return { ok: true, message: "No había porciones pendientes de registrar en esta comida." };
  }
  const base = `Registrado: ${servings} ${servings === 1 ? "porción comida" : "porciones comidas"}.`;
  if (shortfalls.length === 0) {
    return { ok: true, message: `${base} La despensa se descontó completa.` };
  }
  const detalle = shortfalls
    .map((s) => `${s.label} (${s.quantity} ${s.unit === "G" ? "g" : s.unit === "ML" ? "ml" : "u"})`)
    .join(", ");
  return {
    ok: true,
    message: `${base} Ojo: la despensa no tenía todo — faltó ${detalle}. El desajuste quedó anotado en Despensa.`,
  };
}

/** Cerrar un desajuste: ajusté el inventario, o lo acepto como no trazado. */
export async function resolveShortfall(
  shortfallId: string,
  resolution: "RESOLVED_ADJUSTMENT" | "ACCEPTED_UNTRACED",
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("resolve_shortfall", {
    p_shortfall_id: shortfallId,
    p_resolution: resolution,
  });
  if (error) return { ok: false, error: `No se pudo resolver: ${error.message}` };
  refrescar();
  return {
    ok: true,
    message:
      resolution === "ACCEPTED_UNTRACED"
        ? "Quedó como consumo no trazado."
        : "Desajuste resuelto con ajuste de inventario.",
  };
}

/** Ajuste auditable: "en realidad quedan X". */
export async function adjustLot(
  lotId: string,
  quantity: number,
  notes?: string,
): Promise<ActionResult> {
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { ok: false, error: "La cantidad tiene que ser un número positivo." };
  }
  const supabase = await client();
  const { error } = await supabase.rpc("adjust_lot", {
    p_lot_id: lotId,
    p_quantity: quantity,
    p_notes: notes ?? null,
  });
  if (error) return { ok: false, error: `No se pudo ajustar: ${error.message}` };
  refrescar();
  return { ok: true, message: "Cantidad ajustada." };
}

/** Merma con causa explícita. */
export async function discardLot(
  lotId: string,
  reason: "SPOILED" | "EXPIRED" | "DAMAGED" | "DISCARDED_LEFTOVER",
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("discard_lot", {
    p_lot_id: lotId,
    p_reason: reason,
    p_notes: null,
  });
  if (error) return { ok: false, error: `No se pudo descartar: ${error.message}` };
  refrescar();
  return { ok: true, message: "Lote descartado. Quedó registrado como merma." };
}

/** Mover de ubicación (congelar/descongelar actualiza el estado térmico). */
export async function moveLot(lotId: string, locationId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("move_lot", {
    p_lot_id: lotId,
    p_location_id: locationId,
  });
  if (error) return { ok: false, error: `No se pudo mover: ${error.message}` };
  refrescar();
  return { ok: true, message: "Lote movido." };
}

/** Alta manual: compra fuera de la app, sobra o regalo. */
export async function addManualLot(input: {
  label: string;
  quantity: number;
  unit: "G" | "ML" | "UNIT";
  ingredientId?: string | null;
  locationId?: string | null;
  expiryDate?: string | null;
}): Promise<ActionResult> {
  const limpio = input.label.trim();
  if (!limpio) return { ok: false, error: "Escribe qué es." };
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return { ok: false, error: "La cantidad tiene que ser mayor que cero." };
  }
  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Primero crea o únete a un hogar." };

  const { error } = await supabase.rpc("add_manual_lot", {
    p_household_id: householdId,
    p_label: limpio,
    p_quantity: input.quantity,
    p_unit: input.unit,
    p_ingredient_id: input.ingredientId ?? null,
    p_location_id: input.locationId ?? null,
    p_expiry_date: input.expiryDate || null,
    p_source_assignment_id: null,
  });
  if (error) return { ok: false, error: `No se pudo agregar: ${error.message}` };
  refrescar();
  return { ok: true, message: `${limpio} agregado a la despensa.` };
}

/** Asegura las ubicaciones por defecto al entrar por primera vez. */
export async function ensureLocations(): Promise<ActionResult> {
  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Sin hogar." };
  const { error } = await supabase.rpc("ensure_storage_locations", {
    p_household_id: householdId,
  });
  if (error) return { ok: false, error: "No se pudieron crear las ubicaciones." };
  refrescar();
  return { ok: true };
}
