import { z } from "zod";

/**
 * Límite de Data Access: toda fila que entra al dominio se VALIDA, no se castea.
 *
 * El bug crítico del Sprint 4 nació de un `as unknown as`: la base devolvía
 * `preference_type` y el dominio leía `preferenceType`. El casteo compilaba, no
 * fallaba en ningún momento, y el optimizador terminó ignorando todas las
 * preferencias — una alergia dejó de bloquear un plato sin que nada avisara.
 *
 * Un cast le miente al compilador. Un schema hace ruido cuando la forma cambia,
 * que es exactamente lo que queremos que pase.
 */

export class DataShapeError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(context: string, issues: z.ZodIssue[]) {
    const detalle = issues
      .slice(0, 4)
      .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join(" · ");
    super(`Los datos de "${context}" no tienen la forma esperada — ${detalle}`);
    this.name = "DataShapeError";
    this.issues = issues;
  }
}

/**
 * Los helpers son genéricos sobre el SCHEMA, no sobre el tipo: así el resultado
 * es el tipo de salida (`z.output`), ya con los `transform` aplicados. Genéricos
 * sobre `T` hacían que TypeScript infiriera el tipo de ENTRADA y el resultado no
 * calzaba con nada.
 */

/** Valida una lista de filas. `null`/`undefined` se tratan como lista vacía. */
export function parseRows<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  context: string,
): z.output<S>[] {
  const result = z.array(schema).safeParse(data ?? []);
  if (!result.success) throw new DataShapeError(context, result.error.issues);
  return result.data;
}

/** Valida una fila obligatoria. */
export function parseRow<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  context: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new DataShapeError(context, result.error.issues);
  return result.data;
}

/** Valida una fila que legítimamente puede no existir (`maybeSingle`). */
export function parseMaybeRow<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  context: string,
): z.output<S> | null {
  if (data === null || data === undefined) return null;
  return parseRow(schema, data, context);
}

// ---------------------------------------------------------------------------
// Piezas reutilizables
// ---------------------------------------------------------------------------

export const uuid = z.string().uuid();

/**
 * PostgREST entrega `numeric` como string para no perder precisión. Se convierte
 * acá, en el borde, y no con un `Number(...)` suelto en cada punto de uso.
 */
export const numeric = z.coerce.number();
export const nullableNumeric = z.coerce.number().nullable();

/**
 * Embed de PostgREST: según la cardinalidad devuelve un objeto o un arreglo.
 *
 * Se escribe CONCRETO en cada consulta, con `union` + `transform` sobre el
 * schema real. Un helper genérico sobre `ZodTypeAny` compila pero degrada el
 * tipo inferido a `unknown`, que es justo lo que queremos evitar acá:
 *
 * ```ts
 * const ingredientEmbed = z
 *   .union([ingrediente, z.array(ingrediente), z.null()])
 *   .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));
 * ```
 */

/** Los diez nutrientes con columna propia, tal como los devuelve la base. */
export const nutrientColumns = z.object({
  energy_kcal: nullableNumeric,
  protein_g: nullableNumeric,
  carbohydrates_g: nullableNumeric,
  fat_g: nullableNumeric,
  fiber_g: nullableNumeric,
  sugars_g: nullableNumeric,
  saturated_fat_g: nullableNumeric,
  sodium_mg: nullableNumeric,
  potassium_mg: nullableNumeric,
  phosphorus_mg: nullableNumeric,
});

export const weightBasis = z.enum([
  "RAW",
  "COOKED",
  "DRAINED",
  "EDIBLE_PORTION",
  "AS_PACKAGED",
]);

export const basisUnit = z.enum(["G", "ML"]);

export const sourceType = z.enum([
  "PACKAGE_LABEL_VERIFIED",
  "NATIONAL_FOOD_DATABASE",
  "USDA_FOODDATA_CENTRAL",
  "OTHER_VERIFIED_DATABASE",
  "USER_ENTERED_LABEL",
  "USER_ENTERED_GENERIC",
  "AI_ESTIMATE",
  "DEV_SEED",
]);
