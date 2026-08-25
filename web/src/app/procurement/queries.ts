import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  dateString,
  nullableNumeric,
  numeric,
  parseRows,
  uuid,
  weightBasis as weightBasisSchema,
} from "@/lib/supabase/rows";
import type {
  ExistingOrderItem,
  IsoWeekday,
  PendingListItem,
  ProcurementStatus,
  PurchasePolicy,
  Supplier,
  SupplierProduct,
} from "@/domain/procurement/types";
import type { WeightBasis } from "@/domain/stock/types";

type Db = SupabaseClient;

/**
 * Cargador de Procurement: consultas agregadas fijas, Zod en cada borde.
 * Un error de datos jamás se convierte en "no hay proveedores" en silencio.
 */

const unitSchema = z.enum(["G", "ML", "UNIT"]);
const weekdaySchema = z
  .array(z.number().int().min(1).max(7))
  .nullable()
  .transform((v) => (v && v.length > 0 ? (v as IsoWeekday[]) : null));

const supplierRow = z.object({
  id: uuid,
  name: z.string(),
  contact: z.string().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
});

const supplierProductRow = z.object({
  id: uuid,
  supplier_id: uuid,
  ingredient_id: uuid,
  presentation: z.string(),
  package_quantity: numeric,
  unit: unitSchema,
  weight_basis: weightBasisSchema,
  price: nullableNumeric,
  minimum_order_quantity: nullableNumeric,
  purchase_multiple: nullableNumeric,
  lead_time_days: z.number().int(),
  delivery_days: weekdaySchema,
  priority: z.number().int(),
  is_active: z.boolean(),
  suppliers: z
    .union([
      z.object({ name: z.string(), is_active: z.boolean() }),
      z.array(z.object({ name: z.string(), is_active: z.boolean() })),
      z.null(),
    ])
    .transform((v) => (Array.isArray(v) ? v[0] ?? null : v)),
});

const policyRow = z.object({
  ingredient_id: uuid,
  preferred_supplier_id: uuid.nullable(),
  order_days: weekdaySchema,
  receive_days: weekdaySchema,
});

const statusSchema = z.enum([
  "SUGGESTED",
  "PLANNED",
  "ORDERED",
  "READY",
  "DELIVERING",
  "RECEIVED",
  "STORED",
  "CANCELLED",
]);

/**
 * La provenance es el rastro auditable: un paso corrupto NO borra el resto en
 * silencio — se conservan los legibles y se deja constancia de los omitidos.
 */
const provenanceStep = z.object({ step: z.string(), detail: z.string() });
const provenanceSchema = z.unknown().transform((v): { step: string; detail: string }[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) return [{ step: "provenance", detail: "(registro ilegible)" }];
  const legibles: { step: string; detail: string }[] = [];
  let omitidos = 0;
  for (const e of v) {
    const r = provenanceStep.safeParse(e);
    if (r.success) legibles.push(r.data);
    else omitidos++;
  }
  if (omitidos > 0) legibles.push({ step: "provenance", detail: `(${omitidos} paso(s) ilegible(s) omitido(s))` });
  return legibles;
});

const orderRow = z.object({
  id: uuid,
  supplier_id: uuid.nullable(),
  supplier_name: z.string().nullable(),
  status: statusSchema,
  order_date: dateString.nullable(),
  expected_delivery_date: dateString.nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  received_at: z.string().nullable(),
  suppliers: z
    .union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() })), z.null()])
    .transform((v) => (Array.isArray(v) ? v[0] ?? null : v)),
  procurement_order_items: z
    .union([
      z.array(
        z.object({
          id: uuid,
          ingredient_id: uuid,
          supplier_product_id: uuid.nullable(),
          label: z.string(),
          presentation: z.string().nullable(),
          required_quantity: numeric,
          suggested_quantity: numeric,
          unit: unitSchema,
          weight_basis: weightBasisSchema,
          package_count: z.number().int().nullable(),
          provenance: z.unknown(),
        }),
      ),
      z.null(),
    ])
    .transform((v) => v ?? []),
});

export interface SupplierView extends Supplier {
  contact: string | null;
  notes: string | null;
}

export interface OrderItemView {
  id: string;
  ingredientId: string;
  supplierProductId: string | null;
  label: string;
  presentation: string | null;
  requiredQuantity: number;
  suggestedQuantity: number;
  unit: "G" | "ML" | "UNIT";
  weightBasis: WeightBasis;
  packageCount: number | null;
  provenance: { step: string; detail: string }[];
}

export interface OrderView {
  id: string;
  supplierId: string | null;
  /** Congelado al crear; si falta, cae al nombre vivo. */
  supplierName: string | null;
  status: ProcurementStatus;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  notes: string | null;
  createdAt: string;
  receivedAt: string | null;
  items: OrderItemView[];
}

export interface ProcurementConfig {
  suppliers: SupplierView[];
  supplierProducts: SupplierProduct[];
  policies: PurchasePolicy[];
}

export async function loadProcurementConfig(db: Db, householdId: string): Promise<ProcurementConfig> {
  const [proveedores, presentaciones, politicas] = await Promise.all([
    db
      .from("suppliers")
      .select("id, name, contact, notes, is_active")
      .eq("household_id", householdId)
      .order("name"),
    db
      .from("supplier_products")
      .select(
        "id, supplier_id, ingredient_id, presentation, package_quantity, unit, weight_basis, price, minimum_order_quantity, purchase_multiple, lead_time_days, delivery_days, priority, is_active, suppliers!inner ( name, is_active, household_id )",
      )
      .eq("suppliers.household_id", householdId),
    db
      .from("purchase_policies")
      .select("ingredient_id, preferred_supplier_id, order_days, receive_days")
      .eq("household_id", householdId),
  ]);
  if (proveedores.error) throw new DataAccessError("proveedores", proveedores.error);
  if (presentaciones.error) throw new DataAccessError("presentaciones", presentaciones.error);
  if (politicas.error) throw new DataAccessError("políticas de compra", politicas.error);

  return {
    suppliers: parseRows(supplierRow, proveedores.data, "proveedores").map((s) => ({
      id: s.id,
      name: s.name,
      contact: s.contact,
      notes: s.notes,
      isActive: s.is_active,
    })),
    supplierProducts: parseRows(supplierProductRow, presentaciones.data, "presentaciones").map(
      (p): SupplierProduct => ({
        id: p.id,
        supplierId: p.supplier_id,
        supplierName: p.suppliers?.name ?? "(proveedor)",
        supplierActive: p.suppliers?.is_active ?? false,
        ingredientId: p.ingredient_id,
        presentation: p.presentation,
        packageQuantity: p.package_quantity,
        unit: p.unit,
        weightBasis: p.weight_basis,
        price: p.price,
        minimumOrderQuantity: p.minimum_order_quantity,
        purchaseMultiple: p.purchase_multiple,
        leadTimeDays: p.lead_time_days,
        deliveryDays: p.delivery_days,
        priority: p.priority,
        isActive: p.is_active,
      }),
    ),
    policies: parseRows(policyRow, politicas.data, "políticas de compra").map((p) => ({
      ingredientId: p.ingredient_id,
      preferredSupplierId: p.preferred_supplier_id,
      orderDays: p.order_days,
      receiveDays: p.receive_days,
    })),
  };
}

export async function loadOrders(db: Db, householdId: string): Promise<OrderView[]> {
  const { data, error } = await db
    .from("procurement_orders")
    .select(
      "id, supplier_id, supplier_name, status, order_date, expected_delivery_date, notes, created_at, received_at, suppliers ( name ), procurement_order_items ( id, ingredient_id, supplier_product_id, label, presentation, required_quantity, suggested_quantity, unit, weight_basis, package_count, provenance )",
    )
    .eq("household_id", householdId)
    .order("created_at", { ascending: false });
  if (error) throw new DataAccessError("órdenes de abastecimiento", error);

  return parseRows(orderRow, data, "órdenes de abastecimiento").map((o) => ({
    id: o.id,
    supplierId: o.supplier_id,
    supplierName: o.supplier_name ?? o.suppliers?.name ?? null,
    status: o.status,
    orderDate: o.order_date,
    expectedDeliveryDate: o.expected_delivery_date,
    notes: o.notes,
    createdAt: o.created_at,
    receivedAt: o.received_at,
    items: o.procurement_order_items.map((i) => ({
      id: i.id,
      ingredientId: i.ingredient_id,
      supplierProductId: i.supplier_product_id,
      label: i.label,
      presentation: i.presentation,
      requiredQuantity: i.required_quantity,
      suggestedQuantity: i.suggested_quantity,
      unit: i.unit,
      weightBasis: i.weight_basis,
      packageCount: i.package_count,
      provenance: provenanceSchema.parse(i.provenance ?? []),
    })),
  }));
}

/** Items de órdenes, aplanados para netear la necesidad en el motor (§14). */
export function toExistingItems(orders: OrderView[]): ExistingOrderItem[] {
  return orders.flatMap((o) =>
    o.items.map((i) => ({
      orderId: o.id,
      orderStatus: o.status,
      ingredientId: i.ingredientId,
      quantity: i.suggestedQuantity,
      unit: i.unit,
      weightBasis: i.weightBasis,
      orderDate: o.orderDate,
      expectedDeliveryDate: o.expectedDeliveryDate,
    })),
  );
}

const pendingRow = z.object({
  ingredient_id: uuid.nullable(),
  unit: unitSchema,
  purchase_basis: z.enum(["RAW", "COMMERCIAL_PACKAGE", "UNIT", "DRAINED", "OTHER"]),
  required_quantity: nullableNumeric,
  planned_quantity: nullableNumeric,
});

/**
 * Líneas PENDIENTES de listas de compra vivas (DRAFT/ACTIVE): una línea
 * pendiente es una compra decidida — el proveedor no debe pedirla de nuevo.
 * La base de compra se mapea a base física: DRAINED al balde escurrido, el
 * resto (envase comercial, unidad, otro) a la masa comprable = RAW.
 */
export async function loadPendingListItems(db: Db, householdId: string): Promise<PendingListItem[]> {
  const { data, error } = await db
    .from("shopping_list_items")
    .select(
      "ingredient_id, unit, purchase_basis, required_quantity, planned_quantity, shopping_lists!inner ( household_id, status )",
    )
    .eq("status", "PENDING")
    .eq("shopping_lists.household_id", householdId)
    .in("shopping_lists.status", ["DRAFT", "ACTIVE"]);
  if (error) throw new DataAccessError("líneas pendientes de la lista", error);

  return parseRows(pendingRow.passthrough(), data, "líneas pendientes de la lista")
    .filter((r) => r.ingredient_id !== null)
    .map((r) => ({
      ingredientId: r.ingredient_id!,
      quantity: r.planned_quantity ?? r.required_quantity ?? 0,
      unit: r.unit,
      weightBasis: (r.purchase_basis === "DRAINED" ? "DRAINED" : "RAW") as WeightBasis,
    }))
    .filter((r) => r.quantity > 0);
}
