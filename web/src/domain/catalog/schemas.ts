import { z } from "zod";
import { isValidBarcode, normalizeBarcode } from "./barcode";

/** "" → null; texto numérico (coma o punto decimal) → number. */
const optionalNumber = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v === null || v === undefined) return null;
    const text = String(v).trim().replace(",", ".");
    if (text === "") return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  })
  .refine((v) => v === null || (!Number.isNaN(v) && v >= 0), "Debe ser un número ≥ 0");

export const nutritionInputSchema = z.object({
  energy_kcal: optionalNumber,
  protein_g: optionalNumber,
  carbohydrates_g: optionalNumber,
  fat_g: optionalNumber,
  fiber_g: optionalNumber,
  sugars_g: optionalNumber,
  saturated_fat_g: optionalNumber,
  sodium_mg: optionalNumber,
  potassium_mg: optionalNumber,
  phosphorus_mg: optionalNumber,
});

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1, "Nombre requerido").max(200),
    brand: z
      .string()
      .trim()
      .max(120)
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .default(null),
    barcode: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : normalizeBarcode(v)))
      .nullable()
      .default(null)
      .refine((v) => v === null || isValidBarcode(v), "Código de barras inválido (checksum GS1)"),
    packageQuantity: optionalNumber,
    packageUnit: z.enum(["G", "ML"]).default("G"),
    servingQuantity: optionalNumber,
    servingUnit: z.enum(["G", "ML"]).default("G"),
    servingName: z
      .string()
      .trim()
      .max(60)
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .default(null),
    nutritionMode: z.enum(["PER_100", "PER_SERVING"]),
    nutrition: nutritionInputSchema,
  })
  .refine(
    (data) =>
      data.nutritionMode === "PER_100" ||
      (data.servingQuantity !== null && data.servingQuantity > 0),
    { message: "Para nutrición por porción debes indicar el peso de la porción", path: ["servingQuantity"] },
  )
  .refine(
    (data) => Object.values(data.nutrition).some((v) => v !== null),
    { message: "Ingresa al menos un valor nutricional", path: ["nutrition"] },
  );

export type CreateProductInput = z.infer<typeof createProductSchema>;
