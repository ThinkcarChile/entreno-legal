import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  columnsOf,
  dateString,
  nullableNumeric,
  numeric,
  parseRows,
  uuid,
  weightBasis as weightBasisSchema,
} from "@/lib/supabase/rows";
import { addDays, effectiveDate } from "@/domain/nutrition/calendar";
import type {
  StockInput,
  StockLot,
  StockTarget,
} from "@/domain/stock/types";

type Db = SupabaseClient;

/**
 * Cargador de Stock Intelligence: TODO lo que los motores necesitan, en un
 * número fijo de consultas agregadas (§55) — jamás una por lote. Zod en cada
 * borde; un error jamás se convierte en despensa vacía.
 */

const unitSchema = z.enum(["G", "ML", "UNIT"]);

const lotRow = z.object({
  id: uuid,
  ingredient_id: uuid.nullable(),
  label: z.string(),
  quantity: numeric,
  unit: unitSchema,
  weight_basis: weightBasisSchema,
  is_approximate: z.boolean(),
  expiry_date: dateString.nullable(),
  use_by: dateString.nullable(),
  created_at: z.string(),
  status: z.enum(["AVAILABLE", "RESERVED", "CONSUMED", "DISCARDED", "SPLIT"]),
  // `acquisition_value` YA NO SE PIDE ACÁ. Sprint 14 (migración 0048) cerró por
  // COLUMNA la lectura del dinero de `inventory_lots`: el valor sólo se lee por
  // `public.lot_valuations`, que exige el permiso FINANCE_VIEW. Este loader lo
  // pedía y NADIE lo usaba —`analyzeStock` costea la merma con
  // `waste_movements.estimated_cost`, no con esto—, así que seguir pidiéndolo
  // habría roto la despensa entera de todo integrante sin permiso financiero
  // para alimentar un campo muerto. Se mata al lector viejo en el mismo cambio.
});

const demandRow = z.object({
  id: uuid,
  serving_date: dateString.nullable(),
  member_serving_components: z
    .union([
      z.array(
        z.object({
          ingredient_id: uuid.nullable(),
          label: z.string(),
          proposed_quantity: numeric,
          unit: z.enum(["G", "ML"]),
          weight_basis: weightBasisSchema,
          cooking_method: z.string().nullable(),
        }),
      ),
      z.null(),
    ])
    .transform((v) => v ?? []),
});

/**
 * Consumo observado, DESPUÉS del Sprint 12.
 *
 * Hasta la 0036, el consumo observado se leía de las proyecciones en estado
 * CONSUMED tomando `proposed_quantity` — o sea, lo PLANIFICADO haciéndose pasar
 * por lo consumido. Ese estado ya no lo escribe nadie: `consume_planned_meal`
 * dejó de fabricar realidad y ahora sólo SIRVE. Si este lector se hubiera
 * quedado donde estaba, el día que la migración entra a producción el histórico
 * de 30 días queda vacío, el motor lee el vacío como cero, la tasa de consumo
 * se apaga y la lista de compras dice que no hace falta nada. Un pronóstico
 * apagado por falta de datos no se puede distinguir de un pronóstico que dice
 * "no consumes esto" si no se cambia de fuente.
 *
 * La fuente correcta es lo SERVIDO (`meal_serving_record_items`): es el hecho
 * físico, el único que descuenta despensa, y `served_quantity` es el análogo
 * exacto del consumo DECLARADO del §7 — incluye la parte que la despensa no
 * tenía, porque `served = deducted + shortfall`.
 *
 * NO se lee el eje ACTUAL_CONSUMED (`intake_log_items`, 0038) a propósito: ese
 * eje es NUTRICIONAL y no mueve un gramo. Para reponer la despensa importa lo
 * que salió de ella, no lo que la persona alcanzó a comerse.
 */
const servedRow = z.object({
  ingredient_id: uuid.nullable(),
  label: z.string(),
  served_quantity: numeric,
  served_unit: unitSchema,
  served_weight_basis: weightBasisSchema,
  planned_cooking_method: z.string().nullable(),
  meal_serving_records: z
    .union([
      z.object({ served_on: dateString }),
      z.array(z.object({ served_on: dateString })),
      z.null(),
    ])
    .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
});

const targetRow = z.object({
  ingredient_id: uuid,
  unit: unitSchema,
  minimum_quantity: nullableNumeric,
  target_quantity: nullableNumeric,
  target_days_of_supply: z.number().int().nullable(),
  safety_stock: nullableNumeric,
  review_cycle: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "MIN_STOCK", "CUSTOM"]).nullable(),
  reorder_enabled: z.boolean(),
  source: z.enum(["USER_DEFINED", "SYSTEM_SUGGESTED"]),
});

/**
 * Vistas de merma y compra (0013). Los schemas viven ACÁ, una sola vez, y el
 * `.select()` se deriva de ellos con `columnsOf`: el desajuste que rompió
 * /pantry contra el Supabase real no puede repetirse por construcción.
 */
const wasteRow = z.object({
  ingredient_id: uuid.nullable(),
  unit: unitSchema,
  weight_basis: weightBasisSchema,
  quantity: numeric,
  estimated_cost: nullableNumeric,
  created_at: z.string(),
});

const purchaseRow = z.object({
  ingredient_id: uuid,
  unit: unitSchema,
  weight_basis: weightBasisSchema,
  quantity: numeric,
  created_at: z.string(),
});

export async function loadStockInput(
  db: Db,
  householdId: string,
  today: string,
  timeZone = "America/Santiago",
): Promise<StockInput & { excludedProductLots: number }> {
  const hace30 = addDays(today, -30);

  // Las proyecciones no llevan household_id: se anclan por integrante. Sin
  // este filtro, una persona que pertenece a DOS hogares mezclaría los
  // consumos de ambos en el forecast.
  const { data: miembrosData, error: miembrosError } = await db
    .from("household_members")
    .select("id")
    .eq("household_id", householdId);
  if (miembrosError) throw new DataAccessError("stock: integrantes", miembrosError);
  const memberIds = parseRows(z.object({ id: uuid }), miembrosData, "stock: integrantes").map(
    (m) => m.id,
  );

  const [
    lotsRes,
    productLotsRes,
    futureRes,
    servedRes,
    consumedRes,
    shortRes,
    wasteRes,
    purchRes,
    yieldsRes,
    targetsRes,
  ] = await Promise.all([
      db
        .from("inventory_lots")
        .select(
          `id, ingredient_id, label, quantity, unit, weight_basis, is_approximate,
           expiry_date, use_by, created_at, status`,
        )
        .eq("household_id", householdId)
        .eq("status", "AVAILABLE")
        .not("ingredient_id", "is", null),
      // Gate 0→10 [I-1]: los lotes con identidad de PRODUCTO quedan fuera del
      // análisis (el motor trabaja por alimento), pero se CUENTAN y se dicen.
      // Silenciarlos hacía pasar por "análisis completo" uno que no lo era.
      db
        .from("inventory_lots")
        .select("id", { count: "exact", head: true })
        .eq("household_id", householdId)
        .eq("status", "AVAILABLE")
        .gt("quantity", 0)
        .is("ingredient_id", null)
        .not("product_id", "is", null),
      // LA DEMANDA QUE TODAVÍA HAY QUE COMPRAR.
      db
        .from("member_serving_projections")
        .select(
          `id, serving_date,
           member_serving_components (
             ingredient_id, label, proposed_quantity, unit, weight_basis, cooking_method
           )`,
        )
        .eq("status", "PLANNED")
        .not("assignment_id", "is", null)
        .in("member_id", memberIds)
        .gte("serving_date", today)
        // EL RELEVO DEL EVENTO (H20). Una porción con `covered_by_event_id` la
        // cubre un asado y NO demanda ingredientes. Sin esta línea, el sábado
        // del asado esta consulta proyectaba el almuerzo confirmado mientras la
        // lista del evento pedía los kilos de carne: se compraban las dos cosas.
        // La marca existía en la base desde la 0041 y ningún lector la miraba.
        .is("covered_by_event_id", null),
      // LO SERVIDO (0036): la fuente viva del consumo observado. `!inner` no es
      // decorativo — sin él, un renglón cuyo registro no pasa el filtro llegaría
      // con el embed en null y se perdería en silencio.
      db
        .from("meal_serving_record_items")
        .select(
          `ingredient_id, label, served_quantity, served_unit, served_weight_basis,
           planned_cooking_method,
           meal_serving_records!inner ( served_on )`,
        )
        .eq("meal_serving_records.household_id", householdId)
        .eq("meal_serving_records.status", "ACTIVE")
        .gte("meal_serving_records.served_on", hace30)
        .not("ingredient_id", "is", null),
      // HISTORIA del mundo anterior a la 0036: porciones que quedaron en
      // CONSUMED cuando `consume_planned_meal` servía y consumía en un solo
      // acto. Nadie escribe más ese estado, pero lo que ya está escrito ocurrió
      // de verdad y sigue siendo el único registro de esos días. Sin esta
      // consulta, el histórico se vaciaría de golpe el día del despliegue.
      // No hay doble conteo posible: una porción servida por el mundo nuevo
      // queda en SERVED y nunca en CONSUMED.
      db
        .from("member_serving_projections")
        .select(
          `id, serving_date,
           member_serving_components (
             ingredient_id, label, proposed_quantity, unit, weight_basis, cooking_method
           )`,
        )
        .eq("status", "CONSUMED")
        .in("member_id", memberIds)
        .gte("serving_date", hace30),
      db
        .from("consumption_shortfalls")
        .select("ingredient_id, quantity, unit, weight_basis, serving_date")
        .eq("household_id", householdId)
        .gte("serving_date", hace30),
      db
        .from("waste_movements")
        // Columnas DERIVADAS del schema (columnsOf): no se pueden desincronizar.
        // La cota de 30 días evita traer toda la historia para una ventana de 30.
        .select(columnsOf(wasteRow))
        .eq("household_id", householdId)
        .gte("created_at", hace30),
      db
        .from("purchase_movements")
        .select(columnsOf(purchaseRow))
        .eq("household_id", householdId)
        .gte("created_at", hace30),
      db
        .from("ingredient_yields")
        .select("ingredient_id, cooking_method, yield_factor, household_id")
        // La RLS devuelve los globales + TODOS los hogares del usuario: sin este
        // filtro, un factor curado por el hogar A ganaría (isHousehold) en los
        // cálculos del hogar B para una persona multi-hogar. Mismo patrón que
        // pantry/queries.ts y el RPC de consumo (0012).
        .or(`household_id.is.null,household_id.eq.${householdId}`),
      db
        .from("stock_targets")
        .select(
          `ingredient_id, unit, minimum_quantity, target_quantity, target_days_of_supply,
           safety_stock, review_cycle, reorder_enabled, source`,
        )
        .eq("household_id", householdId),
    ]);

  for (const [contexto, res] of [
    ["lotes", lotsRes],
    ["lotes por producto", productLotsRes],
    ["demanda futura", futureRes],
    ["consumo servido", servedRes],
    ["consumo declarado (historia)", consumedRes],
    ["desajustes", shortRes],
    ["mermas", wasteRes],
    ["compras", purchRes],
    ["rendimientos", yieldsRes],
    ["objetivos de stock", targetsRes],
  ] as const) {
    if (res.error) throw new DataAccessError(`stock: ${contexto}`, res.error);
  }

  const lots: StockLot[] = parseRows(lotRow, lotsRes.data, "stock: lotes")
    .filter((l): l is typeof l & { ingredient_id: string } => l.ingredient_id !== null)
    .map((l) => ({
      id: l.id,
      ingredientId: l.ingredient_id,
      label: l.label,
      quantity: l.quantity,
      unit: l.unit,
      weightBasis: l.weight_basis,
      isApproximate: l.is_approximate,
      expiryDate: l.expiry_date,
      useBy: l.use_by,
      createdAt: l.created_at,
      status: l.status,
      // DESCONOCIDO, no cero: el valor del lote vive detrás de FINANCE_VIEW y
      // este loader no lo pide. `StockLot.acquisitionValue` queda declarado
      // como lo que es —un dato que este camino no trae— y ningún motor lo lee.
      acquisitionValue: null,
    }));

  const futuras = parseRows(demandRow, futureRes.data, "stock: demanda futura");
  const futureDemand = futuras.flatMap((p) =>
    p.serving_date === null
      ? []
      : p.member_serving_components
          .filter((c) => c.ingredient_id !== null && c.proposed_quantity > 0)
          .map((c) => ({
            ingredientId: c.ingredient_id!,
            label: c.label,
            quantity: c.proposed_quantity,
            unit: c.unit,
            weightBasis: c.weight_basis,
            cookingMethod: c.cooking_method,
            servingDate: p.serving_date!,
            projectionId: p.id,
          })),
  );

  // §2/§17 + Gate 0→10 [S-1]: los DÍAS con comidas planificadas, uno a uno.
  // El máximo global apagaba el forecast de todos los días intermedios.
  const planningCoveredDates = [
    ...new Set(futuras.map((p) => p.serving_date).filter((d): d is string => d !== null)),
  ].sort();

  // Lo servido: el consumo observado de acá en adelante.
  const servidos = parseRows(servedRow, servedRes.data, "stock: consumo servido");
  const consumoServido = servidos.flatMap((s) =>
    s.ingredient_id === null || s.meal_serving_records === null || s.served_quantity <= 0
      ? []
      : [
          {
            ingredientId: s.ingredient_id,
            quantity: s.served_quantity,
            unit: s.served_unit,
            weightBasis: s.served_weight_basis,
            // Fuera de plan no hay método congelado, y no se inventa uno: sin
            // método, la conversión cocido→crudo usa el rendimiento genérico o
            // se declara inconvertible. UNKNOWN nunca es 1:1.
            cookingMethod: s.planned_cooking_method,
            date: s.meal_serving_records.served_on,
          },
        ],
  );

  // Historia anterior a la 0036, tal como quedó escrita.
  const consumidas = parseRows(demandRow, consumedRes.data, "stock: consumo declarado");
  const consumoHistorico = consumidas.flatMap((p) =>
    p.serving_date === null
      ? []
      : p.member_serving_components
          .filter((c) => c.ingredient_id !== null && c.proposed_quantity > 0)
          .map((c) => ({
            ingredientId: c.ingredient_id!,
            quantity: c.proposed_quantity,
            unit: c.unit,
            weightBasis: c.weight_basis,
            cookingMethod: c.cooking_method,
            date: p.serving_date!,
          })),
  );

  const consumption = [...consumoServido, ...consumoHistorico];

  const shortfalls = parseRows(
    z.object({
      ingredient_id: uuid.nullable(),
      quantity: numeric,
      unit: unitSchema,
      weight_basis: weightBasisSchema,
      serving_date: dateString.nullable(),
    }),
    shortRes.data,
    "stock: desajustes",
  )
    .filter((s): s is typeof s & { ingredient_id: string } => s.ingredient_id !== null)
    .map((s) => ({
      ingredientId: s.ingredient_id,
      quantity: s.quantity,
      unit: s.unit,
      weightBasis: s.weight_basis,
      date: s.serving_date,
    }));

  const waste = parseRows(
    wasteRow,
    wasteRes.data,
    "stock: mermas",
  )
    .filter((w): w is typeof w & { ingredient_id: string } => w.ingredient_id !== null)
    .map((w) => ({
      ingredientId: w.ingredient_id,
      quantity: w.quantity,
      unit: w.unit,
      weightBasis: w.weight_basis,
      estimatedCost: w.estimated_cost,
      date: fechaEnHogar(w.created_at, timeZone),
    }));

  const purchases = parseRows(
    purchaseRow,
    purchRes.data,
    "stock: compras",
  ).map((p) => ({
    ingredientId: p.ingredient_id,
    unit: p.unit,
    weightBasis: p.weight_basis,
    quantity: p.quantity,
    date: fechaEnHogar(p.created_at, timeZone),
  }));

  const yields = parseRows(
    z.object({
      ingredient_id: uuid,
      cooking_method: z.string().nullable(),
      yield_factor: numeric,
      household_id: uuid.nullable(),
    }),
    yieldsRes.data,
    "stock: rendimientos",
  ).map((y) => ({
    ingredientId: y.ingredient_id,
    cookingMethod: y.cooking_method,
    factor: y.yield_factor,
    isHousehold: y.household_id !== null,
  }));

  const targets: StockTarget[] = parseRows(targetRow, targetsRes.data, "stock: objetivos").map(
    (t) => ({
      ingredientId: t.ingredient_id,
      unit: t.unit,
      minimumQuantity: t.minimum_quantity,
      targetQuantity: t.target_quantity,
      targetDaysOfSupply: t.target_days_of_supply,
      safetyStock: t.safety_stock,
      reviewCycle: t.review_cycle,
      reorderEnabled: t.reorder_enabled,
      source: t.source,
    }),
  );

  // Identidades presentes → una sola consulta de metadatos.
  const ids = [
    ...new Set([
      ...lots.map((l) => l.ingredientId),
      ...futureDemand.map((d) => d.ingredientId),
      ...consumption.map((c) => c.ingredientId),
    ]),
  ];
  let ingredients: StockInput["ingredients"] = [];
  if (ids.length > 0) {
    const { data, error } = await db
      .from("ingredients")
      .select("id, display_name, ingredient_categories ( code )")
      .in("id", ids);
    if (error) throw new DataAccessError("stock: alimentos", error);
    ingredients = parseRows(
      z.object({
        id: uuid,
        display_name: z.string(),
        ingredient_categories: z
          .union([z.object({ code: z.string() }), z.array(z.object({ code: z.string() })), z.null()])
          .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
      }),
      data,
      "stock: alimentos",
    ).map((i) => ({
      id: i.id,
      label: i.display_name,
      categoryCode: i.ingredient_categories?.code ?? null,
    }));
  }

  // [I-1]: cuántos lotes con identidad de producto quedaron FUERA del análisis.
  // La pantalla lo dice, y CERO significa «análisis completo de verdad».
  //
  // Por eso un `count` nulo NO se aplana a 0: PostgREST devuelve `null` cuando
  // el conteo no vino en la respuesta, y convertirlo en cero le diría a la
  // persona que no quedó nada afuera justo cuando no sabemos si quedó. Es la
  // misma regla del dinero —desconocido no es cero— aplicada a un conteo que la
  // pantalla presenta como completo.
  const excludedProductLots = productLotsRes.count;
  if (excludedProductLots === null) {
    throw new Error(
      "stock: la consulta de lotes de producto no trajo su conteo; sin él no se puede " +
        "declarar el análisis como completo",
    );
  }

  return {
    excludedProductLots,
    today,
    lots,
    futureDemand,
    consumption,
    shortfalls,
    waste,
    purchases,
    yields,
    targets,
    planningCoveredDates,
    ingredients,
  };
}

/** El día del HOGAR para un timestamp del ledger: a las 22:30 de Santiago
 * todavía es hoy, aunque en UTC ya sea mañana. */
function fechaEnHogar(isoTimestamp: string, timeZone: string): string {
  return effectiveDate(new Date(isoTimestamp), timeZone);
}
