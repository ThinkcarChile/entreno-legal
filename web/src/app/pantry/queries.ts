import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  dateString,
  numeric,
  parseRows,
  uuid,
  weightBasis as weightBasisSchema,
} from "@/lib/supabase/rows";
import type { PantryLot } from "@/domain/inventory/fefo";

type Db = SupabaseClient;

/**
 * Lectura de la despensa. El stock viene SIEMPRE del cacheo que mantiene el
 * libro mayor: nadie lo edita a mano, y una fila con forma rara explota acá.
 */

export interface StorageLocation {
  id: string;
  name: string;
  kind: "PANTRY" | "FRIDGE" | "FREEZER" | "OTHER";
  sortOrder: number;
}

const locationRowSchema = z.object({
  id: uuid,
  name: z.string(),
  kind: z.enum(["PANTRY", "FRIDGE", "FREEZER", "OTHER"]),
  sort_order: z.number().int(),
});

const lotRowSchema = z.object({
  id: uuid,
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  label: z.string(),
  quantity: numeric,
  unit: z.enum(["G", "ML", "UNIT"]),
  weight_basis: weightBasisSchema,
  processing_state: z.enum(["RAW", "PREPPED", "COOKED"]),
  temperature_state: z.enum(["AMBIENT", "CHILLED", "FROZEN"]),
  location_id: uuid.nullable(),
  expiry_date: dateString.nullable(),
  use_by: dateString.nullable(),
  status: z.enum(["AVAILABLE", "RESERVED", "CONSUMED", "DISCARDED", "SPLIT"]),
  created_at: z.string(),
});

export interface PantryData {
  locations: StorageLocation[];
  lots: PantryLot[];
}

export async function loadPantry(db: Db, householdId: string): Promise<PantryData> {
  const [locRes, lotRes] = await Promise.all([
    db
      .from("storage_locations")
      .select("id, name, kind, sort_order")
      .eq("household_id", householdId)
      .order("sort_order"),
    db
      .from("inventory_lots")
      .select(
        `id, ingredient_id, product_id, label, quantity, unit, weight_basis,
         processing_state, temperature_state, location_id, expiry_date, use_by,
         status, created_at`,
      )
      .eq("household_id", householdId)
      .in("status", ["AVAILABLE", "RESERVED"])
      .order("created_at"),
  ]);
  if (locRes.error) throw new DataAccessError("ubicaciones de la despensa", locRes.error);
  if (lotRes.error) throw new DataAccessError("lotes de la despensa", lotRes.error);

  const locations = parseRows(locationRowSchema, locRes.data, "ubicaciones de la despensa").map(
    (l) => ({ id: l.id, name: l.name, kind: l.kind, sortOrder: l.sort_order }),
  );

  const lots: PantryLot[] = parseRows(lotRowSchema, lotRes.data, "lotes de la despensa").map(
    (l) => ({
      id: l.id,
      ingredientId: l.ingredient_id,
      productId: l.product_id,
      label: l.label,
      quantity: l.quantity,
      unit: l.unit,
      weightBasis: l.weight_basis,
      processingState: l.processing_state,
      temperatureState: l.temperature_state,
      locationId: l.location_id,
      expiryDate: l.expiry_date,
      useBy: l.use_by,
      status: l.status,
      createdAt: l.created_at,
    }),
  );

  return { locations, lots };
}

/**
 * Stock disponible de un conjunto de alimentos, para el hint "tienes X en
 * despensa" de la lista de compras. Solo lotes AVAILABLE.
 */
export async function loadAvailableLots(
  db: Db,
  householdId: string,
  ingredientIds: readonly string[],
): Promise<PantryLot[]> {
  if (ingredientIds.length === 0) return [];
  const { data, error } = await db
    .from("inventory_lots")
    .select(
      `id, ingredient_id, product_id, label, quantity, unit, weight_basis,
       processing_state, temperature_state, location_id, expiry_date, use_by,
       status, created_at`,
    )
    .eq("household_id", householdId)
    .eq("status", "AVAILABLE")
    .in("ingredient_id", [...ingredientIds]);
  if (error) throw new DataAccessError("stock para la compra", error);

  return parseRows(lotRowSchema, data, "stock para la compra").map((l) => ({
    id: l.id,
    ingredientId: l.ingredient_id,
    productId: l.product_id,
    label: l.label,
    quantity: l.quantity,
    unit: l.unit,
    weightBasis: l.weight_basis,
    processingState: l.processing_state,
    temperatureState: l.temperature_state,
    locationId: l.location_id,
    expiryDate: l.expiry_date,
    useBy: l.use_by,
    status: l.status,
    createdAt: l.created_at,
  }));
}

/** Alimentos vinculables desde el alta manual (globales + del hogar). */
export async function loadIngredientOptions(
  db: Db,
  householdId: string,
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await db
    .from("ingredients")
    .select("id, display_name, household_id")
    .eq("is_active", true)
    .or(`household_id.is.null,household_id.eq.${householdId}`)
    .order("display_name");
  if (error) throw new DataAccessError("alimentos del catálogo", error);
  return parseRows(
    z.object({ id: uuid, display_name: z.string(), household_id: uuid.nullable() }),
    data,
    "alimentos del catálogo",
  ).map((i) => ({ id: i.id, name: i.display_name }));
}

export interface Shortfall {
  id: string;
  label: string;
  quantity: number;
  unit: "G" | "ML" | "UNIT";
  weightBasis: string;
  servingDate: string | null;
  createdAt: string;
}

/** Desajustes ABIERTOS: la comida declaró más de lo que la despensa tenía. */
export async function loadOpenShortfalls(db: Db, householdId: string): Promise<Shortfall[]> {
  const { data, error } = await db
    .from("consumption_shortfalls")
    .select("id, label, quantity, unit, weight_basis, serving_date, created_at")
    .eq("household_id", householdId)
    .eq("status", "OPEN")
    .order("created_at", { ascending: false });
  if (error) throw new DataAccessError("desajustes de inventario", error);
  return parseRows(
    z.object({
      id: uuid,
      label: z.string(),
      quantity: numeric,
      unit: z.enum(["G", "ML", "UNIT"]),
      weight_basis: weightBasisSchema,
      serving_date: dateString.nullable(),
      created_at: z.string(),
    }),
    data,
    "desajustes de inventario",
  ).map((f) => ({
    id: f.id,
    label: f.label,
    quantity: f.quantity,
    unit: f.unit,
    weightBasis: f.weight_basis,
    servingDate: f.serving_date,
    createdAt: f.created_at,
  }));
}
