import { z } from "zod";
import { COOKING_METHODS, CULINARY_COMPATIBILITIES, MEAL_TYPES, SLOT_TYPES, TEMPLATE_KINDS } from "./types";

/**
 * Validación del borrador de una receta. Refleja las mismas invariantes que la
 * base (un componente apunta a exactamente un alimento; un paso con
 * equipamiento opcional obliga a un camino manual) para que el usuario reciba
 * un mensaje entendible en vez de un error de PostgreSQL.
 */

const uuid = z.string().uuid();

export const componentDraftSchema = z
  .object({
    ingredientId: uuid.optional().nullable(),
    productId: uuid.optional().nullable(),
    nestedVersionId: uuid.optional().nullable(),
    quantity: z.number().positive("La cantidad debe ser mayor que 0").max(100000),
    unit: z.enum(["G", "ML"]),
    weightBasis: z.enum(["RAW", "COOKED", "DRAINED", "EDIBLE_PORTION", "AS_PACKAGED"]),
    nutritionFactId: uuid.optional().nullable(),
    cookingMethod: z.enum(COOKING_METHODS).optional().nullable(),
    /** Rol culinario declarado (ADR 0004). Ver `component_role` en la base. */
    role: z.enum(["MAIN", "ADDED_FAT", "SEASONING"]).default("MAIN"),
    yieldFactor: z.number().positive().max(2).optional().nullable(),
    isOptional: z.boolean().default(false),
  })
  .refine(
    (c) => [c.ingredientId, c.productId, c.nestedVersionId].filter(Boolean).length === 1,
    { message: "Cada ingrediente debe apuntar a un alimento, un producto o una receta reutilizable" },
  );

export const alternativeDraftSchema = z.object({
  ingredientId: uuid,
  culinaryCompatibility: z.enum(CULINARY_COMPATIBILITIES).default("GOOD"),
  /** Ajuste de cantidad culinario. NO es equivalencia nutricional (ADR 0002 §4). */
  quantityEquivalence: z.number().positive().max(10).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const slotDraftSchema = z.object({
  slotType: z.enum(SLOT_TYPES),
  label: z.string().trim().max(120).optional().nullable(),
  isRequired: z.boolean().default(true),
  components: z.array(componentDraftSchema).min(1, "Un componente vacío no sirve: agrega o quita"),
  alternatives: z.array(alternativeDraftSchema).default([]),
});

export const stepDraftSchema = z
  .object({
    instruction: z.string().trim().min(1, "El paso necesita una instrucción").max(2000),
    durationMinutes: z.number().int().positive().max(600).optional().nullable(),
    temperatureC: z.number().int().min(-30).max(400).optional().nullable(),
    requiredCapability: z.string().trim().max(40).optional().nullable(),
    optionalCapability: z.string().trim().max(40).optional().nullable(),
    manualAlternative: z.string().trim().max(2000).optional().nullable(),
    parallelGroup: z.number().int().positive().max(20).optional().nullable(),
  })
  .refine((s) => !s.optionalCapability || Boolean(s.manualAlternative), {
    message: "Si el paso mejora con un equipo, describe también cómo hacerlo sin él",
    path: ["manualAlternative"],
  });

export const recipeDraftSchema = z.object({
  name: z.string().trim().min(1, "La receta necesita un nombre").max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  kind: z.enum(TEMPLATE_KINDS).default("MEAL"),
  mealTypes: z.array(z.enum(MEAL_TYPES)).min(1, "Elige al menos un momento del día"),
  baseServings: z
    .number()
    .int("Las porciones base son un número entero de personas")
    .positive()
    .max(50),
  baseTimeMinutes: z.number().int().positive().max(600).optional().nullable(),
  totalYieldFactor: z.number().positive().max(2).optional().nullable(),
  slots: z.array(slotDraftSchema).min(1, "Agrega al menos un ingrediente"),
  steps: z.array(stepDraftSchema).default([]),
});

export type ComponentDraftInput = z.input<typeof componentDraftSchema>;
export type SlotDraftInput = z.input<typeof slotDraftSchema>;
export type StepDraftInput = z.input<typeof stepDraftSchema>;
export type RecipeDraftInput = z.input<typeof recipeDraftSchema>;
export type RecipeDraft = z.output<typeof recipeDraftSchema>;
