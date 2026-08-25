"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import type { ProcurementStatus } from "@/domain/procurement/types";
import type { PurchaseSuggestion } from "@/domain/procurement/types";

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
  if (!user) redirect("/login?next=/procurement");
  return supabase;
}

async function contexto(): Promise<
  { ok: true; supabase: Awaited<ReturnType<typeof client>>; householdId: string } | { ok: false; error: string }
> {
  const supabase = await client();
  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Primero crea o únete a un hogar." };
  return { ok: true, supabase, householdId };
}

function refrescar() {
  revalidatePath("/procurement");
  revalidatePath("/pantry");
  revalidatePath("/pantry/reorder");
}

/**
 * Aprobar una sugerencia (§13): SUGGESTED→PLANNED SOLO con decisión humana.
 * Idempotente por dedupe_key — el doble clic crea UNA orden (§22).
 */
export async function approveSuggestion(s: PurchaseSuggestion): Promise<ActionResult> {
  if (!Number.isFinite(s.suggestedOrderQuantity) || s.suggestedOrderQuantity <= 0) {
    return { ok: false, error: "La cantidad sugerida no es válida." };
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;

  // Clave determinista: misma sugerencia (alimento+base, día, cantidad,
  // proveedor) = misma orden, aunque se apriete dos veces o en dos pestañas.
  // El RPC además compara `known_incoming` contra lo VIVO: una pestaña vieja
  // con otra cantidad no crea una segunda orden — recibe "recarga la página".
  const dedupe = `PO:${ctx.householdId}:${s.ingredientId}:${s.weightBasis}:${s.orderDate ?? "sin-fecha"}:${s.suggestedOrderQuantity}:${s.supplierProductId ?? "sin-proveedor"}`;

  // El contexto de la decisión (confianza baja, riesgo de quiebre…) queda en
  // la orden: la advertencia que alguien aceptó es parte de la historia.
  const provenance = [
    ...s.provenance,
    ...s.warnings.map((w) => ({ step: "advertencia", detail: w })),
  ];

  const { error } = await ctx.supabase.rpc("create_procurement_order", {
    p_household_id: ctx.householdId,
    p_supplier_id: s.supplierId,
    p_order_date: s.orderDate,
    p_expected_delivery_date: s.expectedDeliveryDate,
    p_dedupe_key: dedupe,
    p_engine_version: s.engineVersion,
    p_items: [
      {
        ingredient_id: s.ingredientId,
        supplier_product_id: s.supplierProductId,
        label: s.label,
        required_quantity: s.requiredQuantity,
        suggested_quantity: s.suggestedOrderQuantity,
        unit: s.unit,
        weight_basis: s.weightBasis,
        package_count: s.packageCount,
        provenance,
        known_incoming: s.incoming,
      },
    ],
  });
  if (error) return { ok: false, error: `No se pudo crear la orden: ${error.message}` };

  refrescar();
  return {
    ok: true,
    message: `Orden planificada: ${s.suggestedOrderQuantity} ${s.unit === "G" ? "g" : s.unit === "ML" ? "ml" : "unidades"} de ${s.label}${s.supplierName ? ` a ${s.supplierName}` : ""}.`,
  };
}

/** Avanza el ciclo de vida (PLANNED→ORDERED→…); el RPC valida la transición. */
export async function advanceOrder(orderId: string, status: ProcurementStatus): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("advance_procurement_order", {
    p_order_id: orderId,
    p_new_status: status,
  });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: status === "CANCELLED" ? "Orden cancelada." : "Orden actualizada." };
}

/** Recibir: los items se vuelven lotes por el MISMO libro mayor del Sprint 7. */
export async function receiveOrder(orderId: string): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { data, error } = await ctx.supabase.rpc("receive_procurement_order", {
    p_order_id: orderId,
  });
  if (error) return { ok: false, error: error.message };
  refrescar();
  revalidatePath("/inventory");
  const n = typeof data === "number" ? data : 0;
  return {
    ok: true,
    message: n > 0 ? `Recibido: ${n} lote(s) nuevos en la despensa.` : "Orden marcada como recibida.",
  };
}

// ---------------------------------------------------------------------------
// Configuración: proveedores, presentaciones y políticas (RLS directa)
// ---------------------------------------------------------------------------

export async function saveSupplier(input: {
  id?: string;
  name: string;
  contact: string | null;
  isActive: boolean;
}): Promise<ActionResult> {
  const nombre = input.name.trim();
  if (nombre.length === 0 || nombre.length > 120) {
    return { ok: false, error: "El nombre del proveedor va de 1 a 120 caracteres." };
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;

  const fila = {
    household_id: ctx.householdId,
    name: nombre,
    contact: input.contact?.trim() || null,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = input.id
    ? await ctx.supabase.from("suppliers").update(fila).eq("id", input.id).eq("household_id", ctx.householdId).select("id")
    : await ctx.supabase.from("suppliers").insert(fila).select("id");
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Ya existe un proveedor con ese nombre." };
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "no autorizado" };
  }
  refrescar();
  return { ok: true, message: `Proveedor ${nombre} guardado.` };
}

export async function saveSupplierProduct(input: {
  id?: string;
  supplierId: string;
  ingredientId: string;
  presentation: string;
  packageQuantity: number;
  unit: "G" | "ML" | "UNIT";
  weightBasis: "RAW" | "DRAINED";
  price: number | null;
  minimumOrderQuantity: number | null;
  purchaseMultiple: number | null;
  leadTimeDays: number;
  deliveryDays: number[] | null;
  priority: number;
  isActive: boolean;
}): Promise<ActionResult> {
  if (!Number.isFinite(input.packageQuantity) || input.packageQuantity <= 0) {
    return { ok: false, error: "La cantidad por presentación tiene que ser mayor que cero." };
  }
  for (const [nombre, v] of [
    ["precio", input.price],
    ["pedido mínimo", input.minimumOrderQuantity],
    ["múltiplo", input.purchaseMultiple],
  ] as const) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) {
      return { ok: false, error: `El ${nombre} tiene que ser un número mayor que cero.` };
    }
  }
  if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0 || input.leadTimeDays > 60) {
    return { ok: false, error: "El tiempo de espera va de 0 a 60 días." };
  }
  const dias = input.deliveryDays?.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) ?? null;

  const ctx = await contexto();
  if (!ctx.ok) return ctx;

  const fila = {
    supplier_id: input.supplierId,
    ingredient_id: input.ingredientId,
    presentation: input.presentation.trim(),
    package_quantity: input.packageQuantity,
    unit: input.unit,
    weight_basis: input.weightBasis,
    price: input.price,
    minimum_order_quantity: input.minimumOrderQuantity,
    purchase_multiple: input.purchaseMultiple,
    lead_time_days: input.leadTimeDays,
    delivery_days: dias && dias.length > 0 ? dias : null,
    priority: Number.isInteger(input.priority) ? input.priority : 100,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };
  // El update devuelve lo tocado: 0 filas (RLS de otro hogar, id inexistente)
  // NO es un éxito silencioso.
  const { data, error } = input.id
    ? await ctx.supabase.from("supplier_products").update(fila).eq("id", input.id).select("id")
    : await ctx.supabase.from("supplier_products").insert(fila).select("id");
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Ese proveedor ya tiene una presentación para este alimento: edítala." };
    }
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "no autorizado" };
  }
  refrescar();
  return { ok: true, message: "Presentación guardada." };
}

export async function savePurchasePolicy(input: {
  ingredientId: string;
  preferredSupplierId: string | null;
  orderDays: number[] | null;
  receiveDays: number[] | null;
}): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;

  const limpiar = (v: number[] | null) => {
    const d = v?.filter((x) => Number.isInteger(x) && x >= 1 && x <= 7) ?? null;
    return d && d.length > 0 ? d : null;
  };
  const { error } = await ctx.supabase.from("purchase_policies").upsert(
    {
      household_id: ctx.householdId,
      ingredient_id: input.ingredientId,
      preferred_supplier_id: input.preferredSupplierId,
      order_days: limpiar(input.orderDays),
      receive_days: limpiar(input.receiveDays),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "household_id,ingredient_id" },
  );
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: "Política de compra guardada." };
}
