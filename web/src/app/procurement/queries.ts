import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { dateString, nullableNumeric, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import type {
  ExistingOrderItem,
  IsoWeekday,
  ProcurementStatus,
  PurchasePolicy,
  Supplier,
  SupplierProduct,
} from "@/domain/procurement/types";

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

const orderRow = z.object({
  id: uuid,
  supplier_id: uuid.nullable(),
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
          required_quantity: numeric,
          suggested_quantity: numeric,
          unit: unitSchema,
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
  requiredQuantity: number;
  suggestedQuantity: number;
  unit: "G" | "ML" | "UNIT";
  packageCount: number | null;
  provenance: { step: string; detail: string }[];
}

export interface OrderView {
  id: string;
  supplierId: string | null;
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
        "id, supplier_id, ingredient_id, presentation, package_quantity, unit, price, minimum_order_quantity, purchase_multiple, lead_time_days, delivery_days, priority, is_active, suppliers!inner ( name, is_active, household_id )",
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

const provenanceSchema = z
  .array(z.object({ step: z.string(), detail: z.string() }))
  .catch([]);

export async function loadOrders(db: Db, householdId: string): Promise<OrderView[]> {
  const { data, error } = await db
    .from("procurement_orders")
    .select(
      "id, supplier_id, status, order_date, expected_delivery_date, notes, created_at, received_at, suppliers ( name ), procurement_order_items ( id, ingredient_id, supplier_product_id, label, required_quantity, suggested_quantity, unit, package_count, provenance )",
    )
    .eq("household_id", householdId)
    .order("created_at", { ascending: false });
  if (error) throw new DataAccessError("órdenes de abastecimiento", error);

  return parseRows(orderRow, data, "órdenes de abastecimiento").map((o) => ({
    id: o.id,
    supplierId: o.supplier_id,
    supplierName: o.suppliers?.name ?? null,
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
      requiredQuantity: i.required_quantity,
      suggestedQuantity: i.suggested_quantity,
      unit: i.unit,
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
      expectedDeliveryDate: o.expectedDeliveryDate,
    })),
  );
}
