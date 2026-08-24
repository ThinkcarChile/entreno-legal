import type { BasisUnit, NutritionFact, WeightBasis } from "../catalog/types";

/** Tipos de comida (§2). Una receta puede servir para más de uno. */
export const MEAL_TYPES = [
  "BREAKFAST",
  "LUNCH",
  "TEA",
  "DINNER",
  "DESSERT",
  "SNACK",
  "OTHER",
] as const;
export type MealType = (typeof MEAL_TYPES)[number];

/**
 * Ensaladas y postres NO son subsistemas aparte (§11, §13): son plantillas con
 * la misma arquitectura modular, distinguidas por su clase para poder
 * referenciarlas desde un slot de otra receta.
 */
export const TEMPLATE_KINDS = ["MEAL", "SALAD", "DESSERT"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/**
 * Tipos de slot (§3, §13). La lista crece sin lógica hardcodeada: la UI se
 * apoya en SLOT_LABELS y las reglas de negocio nunca hacen switch por slot.
 */
export const SLOT_TYPES = [
  "PROTEIN",
  "CARBOHYDRATE",
  "VEGETABLE",
  "SALAD",
  "FAT",
  "SAUCE",
  "FRUIT",
  "BASE",
  "TOPPING",
  "SWEETENER",
  "DESSERT_COMPONENT",
  "OPTIONAL",
  "OTHER",
] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export const COOKING_METHODS = [
  "RAW",
  "BOILED",
  "STEAMED",
  "BAKED",
  "GRILLED",
  "PAN_SEARED",
  "FRIED",
  "AIR_FRYER",
  "STEWED",
  "POACHED",
  "OTHER",
] as const;
export type CookingMethod = (typeof COOKING_METHODS)[number];

/**
 * Compatibilidad CULINARIA de una alternativa (§24). Deliberadamente separada
 * de cualquier equivalencia nutricional: que el pescado reemplace al pollo en
 * el plato no significa que 200 g de uno equivalgan a 200 g del otro.
 */
export const CULINARY_COMPATIBILITIES = ["EXCELLENT", "GOOD", "ACCEPTABLE"] as const;
export type CulinaryCompatibility = (typeof CULINARY_COMPATIBILITIES)[number];

/** A qué apunta un componente o una alternativa. */
export type ComponentTarget =
  | { kind: "INGREDIENT"; ingredientId: string }
  | { kind: "PRODUCT"; productId: string }
  | { kind: "SALAD"; saladVersionId: string };

/**
 * Componente de un slot, ya resuelto para calcular. Un slot puede tener varios
 * (§10): la ensalada chilena son tomate + cebolla + cilantro + limón.
 */
export interface RecipeComponent {
  id: string;
  slotId: string;
  slotType: SlotType;
  /** Nombre visible del alimento (para UI y mensajes de error). */
  label: string;
  target: ComponentTarget;
  /** Cantidad TOTAL de la receta base, no por persona (§7). */
  quantity: number;
  unit: BasisUnit;
  weightBasis: WeightBasis;
  /**
   * Ficha nutricional CONGELADA en la versión (§5). `null` = el componente no
   * tiene nutrición conocida: aporta desconocido a todos los nutrientes, jamás 0.
   */
  nutrition: NutritionFact | null;
  cookingMethod: CookingMethod | null;
  /** Crudo → cocido (§19). `null` = DESCONOCIDO. Nunca se asume 1 (100 %). */
  yieldFactor: number | null;
  isOptional: boolean;
  sortOrder: number;
  /**
   * Hasta dónde se puede mover este componente al personalizar la porción
   * (Sprint 4 §28, §29). FIXED = no se toca ni para cuadrar calorías.
   */
  adjustability: "FIXED" | "ADJUSTABLE" | "OPTIONAL";
  minQuantity: number | null;
  maxQuantity: number | null;
  /** Categoría del alimento, para resolver preferencias por categoría. */
  categoryId: string | null;
}

/**
 * Alternativa culinaria de un slot (§23, §24): "en vez de pollo, pavo o pescado".
 *
 * Representa SOLO que el reemplazo es válido en la cocina. NO afirma equivalencia
 * nutricional: 200 g de pollo no son 200 g de pescado, y este tipo no permite
 * expresar que lo sean. Las cantidades finales las calculará el PortionOptimizer
 * en un sprint posterior.
 */
export interface SlotAlternative {
  id: string;
  slotId: string;
  label: string;
  target: ComponentTarget;
  culinaryCompatibility: CulinaryCompatibility;
  /**
   * Equivalencia de CANTIDAD sugerida por la cocina (p. ej. "usar 1,2x"), no de
   * nutrientes. Opcional y por defecto desconocida.
   */
  quantityEquivalence: number | null;
  notes: string | null;
}

export interface RecipeSlot {
  id: string;
  slotType: SlotType;
  label: string | null;
  isRequired: boolean;
  sortOrder: number;
}

export interface RecipeStep {
  id: string;
  stepNumber: number;
  instruction: string;
  durationMinutes: number | null;
  temperatureC: number | null;
  /** Capacidad de equipamiento requerida (§17). */
  requiredCapability: string | null;
  /** Capacidad que mejora el resultado pero no es obligatoria. */
  optionalCapability: string | null;
  /** Cómo hacerlo sin ese equipamiento: obligatorio si hay capacidad opcional. */
  manualAlternative: string | null;
  /** Pasos con el mismo grupo pueden correr en paralelo. */
  parallelGroup: number | null;
  notes: string | null;
}

export interface MealTemplateVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  status: TemplateStatus;
  name: string;
  mealTypes: MealType[];
  /** Las cantidades pertenecen a la receta total para estas porciones (§7). */
  baseServings: number;
  baseTimeMinutes: number | null;
  /** Rendimiento global crudo → servible. `null` = DESCONOCIDO (§19). */
  totalYieldFactor: number | null;
  slots: RecipeSlot[];
  components: RecipeComponent[];
  steps: RecipeStep[];
}

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  BREAKFAST: "Desayuno",
  LUNCH: "Almuerzo",
  TEA: "Once",
  DINNER: "Cena",
  DESSERT: "Postre",
  SNACK: "Snack",
  OTHER: "Otro",
};

/** Lenguaje de cocina, no de base de datos (§33). */
export const SLOT_LABELS: Record<SlotType, string> = {
  PROTEIN: "Proteína",
  CARBOHYDRATE: "Carbohidrato",
  VEGETABLE: "Verdura",
  SALAD: "Ensalada",
  FAT: "Grasa o aderezo",
  SAUCE: "Salsa",
  FRUIT: "Fruta",
  BASE: "Base",
  TOPPING: "Topping",
  SWEETENER: "Endulzante",
  DESSERT_COMPONENT: "Componente de postre",
  OPTIONAL: "Opcional",
  OTHER: "Otro",
};

export const SLOT_ADD_LABELS: Record<SlotType, string> = {
  PROTEIN: "Agregar proteína",
  CARBOHYDRATE: "Agregar carbohidrato",
  VEGETABLE: "Agregar verdura",
  SALAD: "Agregar ensalada",
  FAT: "Agregar grasa o aderezo",
  SAUCE: "Agregar salsa",
  FRUIT: "Agregar fruta",
  BASE: "Agregar base",
  TOPPING: "Agregar topping",
  SWEETENER: "Agregar endulzante",
  DESSERT_COMPONENT: "Agregar componente",
  OPTIONAL: "Agregar opcional",
  OTHER: "Agregar otro",
};

export const COOKING_METHOD_LABELS: Record<CookingMethod, string> = {
  RAW: "Crudo",
  BOILED: "Hervido",
  STEAMED: "Al vapor",
  BAKED: "Al horno",
  GRILLED: "A la parrilla",
  PAN_SEARED: "A la plancha",
  FRIED: "Frito",
  AIR_FRYER: "Air fryer",
  STEWED: "Guisado",
  POACHED: "Pochado",
  OTHER: "Otro",
};

export const STATUS_LABELS: Record<TemplateStatus, string> = {
  DRAFT: "Borrador",
  PUBLISHED: "Publicada",
  ARCHIVED: "Archivada",
};

export const CULINARY_COMPATIBILITY_LABELS: Record<CulinaryCompatibility, string> = {
  EXCELLENT: "Reemplazo directo",
  GOOD: "Buen reemplazo",
  ACCEPTABLE: "Reemplazo aceptable",
};
