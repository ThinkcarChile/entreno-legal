import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { dateString, nullableNumeric, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import { moneyMinorNullable, moneyStatus, unknownReason } from "@/domain/finance/rows";

type Db = SupabaseClient;

/**
 * Cargadores de la frontera de boletas.
 *
 * Regla de la casa: fila de Supabase → Zod → dominio; cero `as` sobre filas. Y
 * la regla propia de este sprint: los montos entran por `moneyMinorNullable`
 * (bigint o nada) y NUNCA por `nullableNumeric`, que es `z.coerce.number()` y
 * está bien para cantidades y mal para plata.
 *
 * Un fallo de consulta LANZA. Una pantalla de dinero que muestra «$0» porque la
 * consulta se cayó es de los errores más peligrosos que existen: ERROR != VACÍO.
 */

const receiptRow = z.object({
  id: uuid,
  household_id: uuid,
  storage_path: z.string(),
  original_mime: z.string(),
  receipt_date: dateString.nullable(),
  merchant_name: z.string().nullable(),
  receipt_number: z.string().nullable(),
  currency: z.enum(["CLP", "USD", "EUR"]),
  declared_total_minor: moneyMinorNullable,
  total_status: moneyStatus,
  total_unknown_reason: unknownReason.nullable(),
  total_source: z.enum(["PRINTED", "SUMMED", "UNKNOWN"]),
  intent: z.enum(["NEW_PURCHASE", "ATTACH_TO_EXISTING"]),
  processing_status: z.string(),
  failure_reason: z.string().nullable(),
  ai_consent_status: z.string(),
  extraction_version: z.string().nullable(),
  extraction_pass: z.number().int(),
  duplicate_of: uuid.nullable(),
  duplicate_ack_at: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  purchase_id: uuid.nullable(),
  uploaded_at: z.string(),
});

export type ReceiptRow = z.infer<typeof receiptRow>;

const candidateRow = z.object({
  id: uuid,
  receipt_id: uuid,
  extraction_pass: z.number().int(),
  line_ordinal: z.number().int(),
  raw_line_text: z.string(),
  original_snippet: z.string().nullable(),
  quantity: nullableNumeric,
  unit: z.string().nullable(),
  unit_price_minor: moneyMinorNullable,
  unit_price_basis: z.enum(["PER_KG", "PER_L", "PER_UNIT", "PER_100G"]).nullable(),
  line_total_minor: moneyMinorNullable,
  discount_minor: moneyMinorNullable,
  barcode: z.string().nullable(),
  barcode_check_ok: z.boolean().nullable(),
  matched_product_id: uuid.nullable(),
  matched_ingredient_id: uuid.nullable(),
  match_method: z.string(),
  match_score: nullableNumeric,
  extraction_confidence: nullableNumeric,
  field_confidences: z.record(z.string(), z.number()).catch({}),
  doubt_reasons: z.array(z.string()),
  status: z.string(),
});

export type CandidateRow = z.infer<typeof candidateRow>;

/*
 * Las columnas van ESCRITAS EN EL `.select()`, literal, y no en una constante
 * compartida. Es más largo a propósito: `contract-loaders.test.ts` (§35) sólo
 * puede verificar contra la base real los selects cuyas columnas están en el
 * texto; uno armado desde una constante se salta el chequeo en silencio, que es
 * justo lo que ese gate existe para impedir.
 */

/** Las boletas del hogar que la RLS me deja ver (exige FINANCE_VIEW). */
export async function loadReceipts(db: Db, householdId: string): Promise<ReceiptRow[]> {
  const { data, error } = await db
    .from("purchase_receipts")
    .select(
      "id, household_id, storage_path, original_mime, receipt_date, merchant_name, receipt_number, currency, declared_total_minor, total_status, total_unknown_reason, total_source, intent, processing_status, failure_reason, ai_consent_status, extraction_version, extraction_pass, duplicate_of, duplicate_ack_at, confirmed_at, purchase_id, uploaded_at",
    )
    .eq("household_id", householdId)
    .neq("processing_status", "ARCHIVED")
    .order("uploaded_at", { ascending: false })
    .limit(60);
  if (error) throw new DataAccessError("boletas del hogar", error);
  return parseRows(receiptRow, data, "boletas del hogar");
}

export async function loadReceipt(db: Db, id: string): Promise<ReceiptRow | null> {
  const { data, error } = await db
    .from("purchase_receipts")
    .select(
      "id, household_id, storage_path, original_mime, receipt_date, merchant_name, receipt_number, currency, declared_total_minor, total_status, total_unknown_reason, total_source, intent, processing_status, failure_reason, ai_consent_status, extraction_version, extraction_pass, duplicate_of, duplicate_ack_at, confirmed_at, purchase_id, uploaded_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new DataAccessError("la boleta", error);
  if (data === null) return null;
  return parseRows(receiptRow, [data], "la boleta")[0]!;
}

/**
 * Los candidatos de la PASADA vigente. Las pasadas anteriores quedan en la base
 * como historia y no se pintan: mezclarlas mostraría la misma línea dos veces
 * con decisiones distintas.
 */
export async function loadCandidates(
  db: Db,
  receiptId: string,
  pass: number,
): Promise<CandidateRow[]> {
  const { data, error } = await db
    .from("receipt_extraction_candidates")
    .select(
      "id, receipt_id, extraction_pass, line_ordinal, raw_line_text, original_snippet, quantity, unit, unit_price_minor, unit_price_basis, line_total_minor, discount_minor, barcode, barcode_check_ok, matched_product_id, matched_ingredient_id, match_method, match_score, extraction_confidence, field_confidences, doubt_reasons, status",
    )
    .eq("receipt_id", receiptId)
    .eq("extraction_pass", pass)
    .order("line_ordinal");
  if (error) throw new DataAccessError("las líneas de la boleta", error);
  return parseRows(candidateRow, data, "las líneas de la boleta");
}

/** Nombre legible de los alimentos y productos que las líneas ya matchearon. */
export async function loadEtiquetas(
  db: Db,
  ingredientIds: readonly string[],
  productIds: readonly string[],
): Promise<Record<string, string>> {
  const salida: Record<string, string> = {};
  if (ingredientIds.length > 0) {
    const { data, error } = await db
      .from("ingredients")
      .select("id, display_name")
      .in("id", [...ingredientIds]);
    if (error) throw new DataAccessError("los alimentos de la boleta", error);
    for (const fila of parseRows(
      z.object({ id: uuid, display_name: z.string() }),
      data,
      "los alimentos de la boleta",
    )) {
      salida[fila.id] = fila.display_name;
    }
  }
  if (productIds.length > 0) {
    const { data, error } = await db
      .from("commercial_products")
      .select("id, name")
      .in("id", [...productIds]);
    if (error) throw new DataAccessError("los productos de la boleta", error);
    for (const fila of parseRows(
      z.object({ id: uuid, name: z.string() }),
      data,
      "los productos de la boleta",
    )) {
      salida[fila.id] = fila.name;
    }
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Adjuntar: los lotes que están guardados y todavía no saben lo que costaron
// ---------------------------------------------------------------------------

const lotSinValorRow = z.object({
  id: uuid,
  label: z.string(),
  quantity: numeric,
  unit: z.string(),
  value_status: moneyStatus,
  value_unknown_reason: unknownReason.nullable(),
  created_at: z.string(),
});

export type LotSinValorRow = z.infer<typeof lotSinValorRow>;

/**
 * Los candidatos a recibir el precio de una boleta que llegó DESPUÉS.
 *
 * Sólo lotes con valor DESCONOCIDO: adjuntar una boleta mueve desconocido →
 * conocido y nada más. Un lote que ya sabe lo que costó no se revaloriza —
 * `app.value_lot_from_purchase_item` se niega, y ofrecerlo en la pantalla sería
 * ofrecer un botón que el servidor rechaza.
 *
 * Se piden `value_status` y su motivo aunque el filtro ya los fije: si algún día
 * el filtro cambia, la pantalla sigue sabiendo qué está mirando en vez de
 * suponerlo.
 */
export async function loadLotesSinValor(
  db: Db,
  householdId: string,
): Promise<LotSinValorRow[]> {
  // EL DINERO SE PIDE POR LA VISTA, LO FÍSICO POR LA TABLA. Antes esto era una
  // sola consulta a `inventory_lots` que nombraba `value_status` y
  // `value_unknown_reason`, y desde la 0048 eso NO SE PUEDE: esa migración le
  // quita a `authenticated` el select sobre la tabla y se lo devuelve columna
  // por columna, dejando afuera las cuatro del dinero. La despensa la ve toda
  // la casa; el precio, sólo quien tiene FINANCE_VIEW, y lo lee por
  // `lot_valuations`. La consulta vieja moría con "permission denied for table
  // inventory_lots" para TODO EL MUNDO —también para quien sí tiene el
  // permiso—, porque lo que faltaba era el permiso sobre la tabla.
  //
  // Y el arreglo mejora el significado, no sólo el permiso: el filtro por
  // `value_status` ahora pasa por el `where` de la vista, así que a alguien sin
  // FINANCE_VIEW esta pantalla le muestra una lista vacía —no hay lotes que
  // pueda valorizar— en vez de reventar.
  const { data: valores, error: errorValores } = await db
    .from("lot_valuations")
    .select("lot_id, value_status, value_unknown_reason")
    .eq("household_id", householdId)
    .eq("value_status", "UNKNOWN")
    .limit(200);
  if (errorValores) throw new DataAccessError("los lotes sin precio", errorValores);

  const porLote = new Map(
    parseRows(
      z.object({
        lot_id: uuid,
        value_status: moneyStatus,
        value_unknown_reason: unknownReason.nullable(),
      }),
      valores,
      "los lotes sin precio",
    ).map((v) => [v.lot_id, v]),
  );
  // ERROR != VACÍO, pero VACÍO SÍ ES VACÍO: sin lotes de valor desconocido no
  // hay nada que preguntarle a la tabla, y un `.in()` con lista vacía es una
  // consulta que no hace falta hacer.
  if (porLote.size === 0) return [];

  const { data, error } = await db
    .from("inventory_lots")
    .select("id, label, quantity, unit, created_at")
    .eq("household_id", householdId)
    .eq("status", "AVAILABLE")
    .gt("quantity", 0)
    .in("id", [...porLote.keys()])
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new DataAccessError("los lotes sin precio", error);

  const fisico = parseRows(
    z.object({
      id: uuid,
      label: z.string(),
      quantity: numeric,
      unit: z.string(),
      created_at: z.string(),
    }),
    data,
    "los lotes sin precio",
  );

  // Se arman sólo los lotes que están en LAS DOS respuestas. Un lote que la
  // vista dio y la tabla no (porque ya se consumió entre una consulta y otra)
  // se cae acá en vez de aparecer a medio llenar.
  return fisico.flatMap((l) => {
    const valor = porLote.get(l.id);
    return valor === undefined
      ? []
      : [
          lotSinValorRow.parse({
            ...l,
            value_status: valor.value_status,
            value_unknown_reason: valor.value_unknown_reason,
          }),
        ];
  });
}
