import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { MEAL_TYPES, type MealType } from "@/domain/recipes/types";
import { columnsOf, dateString, nullableNumeric, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  EXTENTS,
  ORIGENES_DECLARACION,
  type Extent,
  type OrigenDeclaracion,
  type RenglonServido,
} from "./extent";

/**
 * Lecturas de la pantalla "Lo que comimos".
 *
 * Los dos hechos que se muestran son distintos y NO se derivan el uno del otro:
 *
 *   · lo SERVIDO — `meal_serving_records` (0036): lo que salió a la mesa y ya
 *     descontó la despensa;
 *   · lo DECLARADO — `consumption_logs` + `intake_log_items` (0038): lo que una
 *     persona dice que se comió.
 *
 * Una porción servida SIN declaración no es "no comió": es "todavía nadie lo
 * dijo", y por eso viaja en su propia lista con su propio nombre.
 *
 * Acá no se lee NADA clínico. La pantalla no lo muestra y por lo tanto tampoco
 * lo pide: `meal_serving_clinical_context` exige `app.medical_access` y esta
 * superficie no tiene por qué tocar esa puerta.
 */

type Db = SupabaseClient;

const mealType = z.enum(MEAL_TYPES);
const unidad = z.enum(["G", "ML", "UNIT"]);
const baseFisica = z.enum(["RAW", "COOKED", "DRAINED", "EDIBLE_PORTION", "AS_PACKAGED"]);

// --- lo servido -------------------------------------------------------------

const renglonServidoColumnas = z.object({
  id: uuid,
  label: z.string(),
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  served_quantity: numeric,
  served_unit: unidad,
  served_weight_basis: baseFisica,
  deducted_quantity: numeric,
  discarded_quantity: numeric,
  sort_order: z.number().int(),
});

const servidoColumnas = z.object({
  id: uuid,
  member_id: uuid,
  meal_type: mealType.nullable(),
  kind: z.enum(["FROM_PLAN", "OFF_PLAN"]),
  served_on: dateString,
});

/**
 * PostgREST devuelve el embed como arreglo cuando la relación es a muchos, pero
 * como objeto cuando el planificador cree que es a uno. Se normaliza acá y no
 * con un cast: el cast del Sprint 4 es exactamente lo que este proyecto no
 * vuelve a hacer.
 */
const renglonesServidos = z
  .union([z.array(renglonServidoColumnas), renglonServidoColumnas, z.null()])
  .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v]));

const servidoSchema = servidoColumnas.extend({
  meal_serving_record_items: renglonesServidos,
});

const SELECT_SERVIDO = columnsOf(
  servidoColumnas,
  `meal_serving_record_items(${columnsOf(renglonServidoColumnas)})`,
);

export interface PorcionServida {
  id: string;
  memberId: string;
  mealType: MealType | null;
  /** `true` cuando salió del plan de la semana; `false` cuando se sirvió suelta. */
  desdeElPlan: boolean;
  renglones: RenglonServido[];
}

// --- lo declarado -----------------------------------------------------------

const renglonLogColumnas = z.object({
  id: uuid,
  label: z.string(),
  extent: z.enum(EXTENTS),
  quantity: nullableNumeric,
  unit: unidad.nullable(),
  quantity_is_declared: z.boolean(),
  serving_record_item_id: uuid.nullable(),
  sort_order: z.number().int(),
});

const logColumnas = z.object({
  id: uuid,
  member_id: uuid,
  meal_type: mealType.nullable(),
  kind: z.enum(["PLANNED", "OFF_PLAN", "AWAY"]),
  source: z.enum(ORIGENES_DECLARACION),
  serving_record_id: uuid.nullable(),
  consumed_on: dateString,
  notes: z.string().nullable(),
  correction_reason: z.string().nullable(),
});

const renglonesLog = z
  .union([z.array(renglonLogColumnas), renglonLogColumnas, z.null()])
  .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v]));

const logSchema = logColumnas.extend({ intake_log_items: renglonesLog });

const SELECT_LOG = columnsOf(logColumnas, `intake_log_items(${columnsOf(renglonLogColumnas)})`);

export interface RenglonDeclarado {
  id: string;
  label: string;
  extent: Extent;
  quantity: number | null;
  unit: "G" | "ML" | "UNIT" | null;
  quantityIsDeclared: boolean;
  servingRecordItemId: string | null;
}

export interface Declaracion {
  id: string;
  memberId: string;
  mealType: MealType | null;
  kind: "PLANNED" | "OFF_PLAN" | "AWAY";
  source: OrigenDeclaracion;
  servingRecordId: string | null;
  notes: string | null;
  correctionReason: string | null;
  renglones: RenglonDeclarado[];
}

export interface DiaDeComidas {
  dia: string;
  /** Salió a la mesa y todavía nadie dijo qué pasó con eso. */
  porDeclarar: PorcionServida[];
  /** Ya está dicho. Se puede corregir o anular, nunca editar en silencio. */
  declarado: Declaracion[];
}

/**
 * Todo lo del día en una sola pasada. El cruce entre servido y declarado se
 * hace acá con los ids: una porción está pendiente cuando NO existe ninguna
 * declaración viva colgada de ella, que es la misma regla que hace cumplir el
 * índice `intake_logs_serving_record_active_uniq`.
 */
export async function loadDia(db: Db, householdId: string, dia: string): Promise<DiaDeComidas> {
  const { data: servidos, error: errorServidos } = await db
    .from("meal_serving_records")
    .select(SELECT_SERVIDO)
    .eq("household_id", householdId)
    .eq("served_on", dia)
    .eq("status", "ACTIVE")
    .order("served_at", { ascending: true });
  if (errorServidos) throw new DataAccessError("lo que salió a la mesa", errorServidos);

  const { data: logs, error: errorLogs } = await db
    .from("consumption_logs")
    .select(SELECT_LOG)
    .eq("household_id", householdId)
    .eq("consumed_on", dia)
    .eq("status", "ACTIVE")
    .order("logged_at", { ascending: true });
  if (errorLogs) throw new DataAccessError("lo que se declaró comido", errorLogs);

  const declarado: Declaracion[] = parseRows(logSchema, logs, "lo que se declaró comido").map((l) => ({
    id: l.id,
    memberId: l.member_id,
    mealType: l.meal_type,
    kind: l.kind,
    source: l.source,
    servingRecordId: l.serving_record_id,
    notes: l.notes,
    correctionReason: l.correction_reason,
    renglones: l.intake_log_items
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({
        id: i.id,
        label: i.label,
        extent: i.extent,
        quantity: i.quantity,
        unit: i.unit,
        quantityIsDeclared: i.quantity_is_declared,
        servingRecordItemId: i.serving_record_item_id,
      })),
  }));

  const yaDeclarados = new Set(
    declarado.map((d) => d.servingRecordId).filter((id): id is string => id !== null),
  );

  const porDeclarar: PorcionServida[] = parseRows(servidoSchema, servidos, "lo que salió a la mesa")
    .filter((r) => !yaDeclarados.has(r.id))
    .map((r) => ({
      id: r.id,
      memberId: r.member_id,
      mealType: r.meal_type,
      desdeElPlan: r.kind === "FROM_PLAN",
      renglones: r.meal_serving_record_items
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((i) => ({
          servingRecordItemId: i.id,
          label: i.label,
          ingredientId: i.ingredient_id,
          productId: i.product_id,
          servido: i.served_quantity,
          entregado: i.deducted_quantity,
          botado: i.discarded_quantity,
          unidad: i.served_unit,
          baseFisica: i.served_weight_basis,
          sortOrder: i.sort_order,
        })),
    }));

  return { dia, porDeclarar, declarado };
}
