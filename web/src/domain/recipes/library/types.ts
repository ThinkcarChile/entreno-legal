/**
 * Biblioteca chilena de recetas (Sprint 11.5).
 *
 * Las recetas viven como DATOS TIPADOS, no como SQL suelto: así los guardianes
 * de calidad (§28-§31) son tests de verdad y el seed se genera de una sola
 * fuente, reproducible y versionada (§36).
 *
 * Regla que gobierna todo el archivo: nada se infiere en silencio. Una
 * cantidad sin base física, una identidad sin resolver o un rendimiento sin
 * dato se DECLARAN — jamás se rellenan con un valor cómodo.
 */

/** Estados físicos del alimento. Mismo enum que la base (§7). */
export type WeightBasis = "RAW" | "COOKED" | "DRAINED" | "EDIBLE_PORTION" | "AS_PACKAGED";

/** Slots existentes (§8). Nada cae en OTHER por comodidad. */
export type SlotType =
  | "PROTEIN"
  | "CARBOHYDRATE"
  | "VEGETABLE"
  | "SALAD"
  | "FAT"
  | "SAUCE"
  | "FRUIT"
  | "BASE"
  | "TOPPING"
  | "SWEETENER"
  | "DESSERT_COMPONENT"
  | "OPTIONAL"
  | "OTHER";

/** Rol culinario (§9). ADDED_FAT es lo único que el optimizador puede quitar. */
export type ComponentRole = "MAIN" | "ADDED_FAT" | "SEASONING";

export type Adjustability = "FIXED" | "ADJUSTABLE" | "OPTIONAL";

/**
 * Métodos de cocción. Los nombres chilenos del §12 mapean al enum que ya
 * existe en la base — no hace falta migración:
 *
 *   AL_JUGO / GUISADO → STEWED      HORNO   → BAKED
 *   PLANCHA           → GRILLED     SARTÉN  → PAN_SEARED
 *   FRITO             → FRIED       HERVIDO → BOILED
 *   AIR_FRYER         → AIR_FRYER   OTRO    → OTHER
 */
export type CookingMethod =
  | "RAW"
  | "BOILED"
  | "STEAMED"
  | "BAKED"
  | "GRILLED"
  | "PAN_SEARED"
  | "FRIED"
  | "AIR_FRYER"
  | "STEWED"
  | "POACHED"
  | "OTHER";

export type MealType = "BREAKFAST" | "LUNCH" | "TEA" | "DINNER" | "DESSERT" | "SNACK" | "OTHER";

export type CulinaryCompatibility = "EXCELLENT" | "GOOD" | "ACCEPTABLE";

/** Corte requerido (§24). El tamaño solo cuando aporta de verdad. */
export interface CutSpec {
  kind: "DICE" | "SLICE" | "SHRED" | "CHOP" | "WHOLE";
  /** Milímetros, solo si la receta realmente lo pide (12 mm en cazuela, etc.). */
  sizeMm?: number;
}

export interface LibraryComponent {
  /** `canonical_name` del catálogo. La identidad se resuelve por acá. */
  ingredient: string;
  quantity: number;
  unit: "G" | "ML" | "UNIT";
  /** §7: obligatorio y explícito. Nunca "100 g de arroz" a secas. */
  basis: WeightBasis;
  slot: SlotType;
  role: ComponentRole;
  adjustability: Adjustability;
  /** Solo cuando el componente admite rango real. */
  minQuantity?: number;
  maxQuantity?: number;
  cookingMethod?: CookingMethod;
  /**
   * §18: rendimiento crudo→cocido SOLO con dato explícito. Ausente = se
   * desconoce, y el sistema lo trata como desconocido. Jamás 1 por defecto.
   */
  yieldFactor?: number;
  cut?: CutSpec;
  optional?: boolean;
  notes?: string;
}

/** Alternativa culinaria (§19). Compatible en la olla ≠ equivalente nutricional. */
export interface LibraryAlternative {
  slot: SlotType;
  ingredient: string;
  compatibility: CulinaryCompatibility;
  /**
   * Equivalencia de CANTIDAD, si existe dato. Ausente = se cambia 1 por 1 en
   * la preparación pero el sistema recalcula la nutrición desde cero.
   */
  quantityEquivalence?: number;
  notes?: string;
}

export interface LibraryStep {
  instruction: string;
  minutes?: number;
  temperatureC?: number;
  /** Capacidad de equipo que MEJORA el paso; exige alternativa manual (§13). */
  optionalCapability?: string;
  manualAlternative?: string;
  /**
   * Paralelismo del paso. Tiene DOS lecturas legítimas y las dos se usan:
   *
   *   - Varios pasos con el MISMO número corren entre sí ("mientras el mote
   *     hierve, se hace la salsa verde").
   *   - Un número que aparece UNA sola vez marca el paso que corre junto a la
   *     línea principal: "cocer el arroz aparte mientras el guiso termina". No
   *     es un grupo a medias — es la otra relación, la del ramal contra el
   *     tronco, y ocho de las cien recetas publicadas la usan así.
   *
   * Queda escrito acá porque un guardián llegó a exigir dos miembros por grupo
   * y acusó a esas ocho de estar malas. El campo no estaba mal: la suposición
   * sí. Un test que le enseña a la gente a ignorarlo es peor que no tenerlo.
   *
   * Lo que NO cabe es un paso de SUSTITUCIÓN ("En vez de…") con grupo: ese paso
   * reemplaza a otro, no corre junto a nada, y declararlo paralelo hace que la
   * receta se cocine dos veces. Lo vigila `biblioteca.test.ts`.
   */
  parallelGroup?: number;
}

export type LibraryTag =
  | "ECONOMICA"
  | "RAPIDA"
  | "FAMILIAR"
  | "MEAL_PREP"
  | "FREEZER_FRIENDLY"
  | "LEFTOVER_FRIENDLY"
  | "TRADICIONAL"
  | "OLLA_UNICA";

export type LibraryCategory =
  | "POLLO"
  | "VACUNO"
  | "PESCADO"
  | "LEGUMBRES"
  | "TRADICIONAL"
  | "HUEVO"
  | "RAPIDA"
  | "DESAYUNO_ONCE"
  | "ENSALADA"
  | "SOPA"
  | "POSTRE";

export interface LibraryRecipe {
  /** Estable y único: es la identidad de la receta entre lotes y versiones. */
  slug: string;
  name: string;
  description: string;
  category: LibraryCategory;
  kind: "MEAL" | "SALAD" | "DESSERT";
  mealTypes: MealType[];
  /** §17: preparación familiar normal, no la porción de nadie en particular. */
  baseServings: number;
  prepMinutes: number;
  cookMinutes: number;
  difficulty: "FACIL" | "MEDIA" | "AVANZADA";
  components: LibraryComponent[];
  alternatives?: LibraryAlternative[];
  steps: LibraryStep[];
  tags: LibraryTag[];
  /**
   * Ensalada o postre reutilizable que la receta incluye por referencia
   * (§11): el slug de otra entrada de la biblioteca, no un texto suelto.
   */
  nested?: { slot: SlotType; slug: string; servingsFactor?: number }[];
  /** Notas de preparación por lotes (§23). Sin fechas de seguridad (§25). */
  batchPrepNotes?: string;
}

/** Alimento que la biblioteca necesita y el catálogo todavía no tiene (§15). */
export interface LibraryIngredient {
  canonicalName: string;
  displayName: string;
  category:
    | "MEAT"
    | "POULTRY"
    | "FISH"
    | "EGGS"
    | "GRAINS"
    | "LEGUMES"
    | "VEGETABLES"
    | "FRUITS"
    | "DAIRY"
    | "FATS_OILS"
    | "BREAD";
  /** Nombres con los que también se conoce: evita identidades duplicadas. */
  aliases?: string[];
  /** Porción comestible sobre lo comprado. Ausente = desconocida. */
  ediblePortionFactor?: number;
  /**
   * Espeja el enum `measurement_type` de la base: MASS | VOLUME | UNIT.
   * Decía "WEIGHT" y la base no conoce ese valor. El LOTE A no usaba el campo,
   * así que el error viajó latente hasta que el LOTE B cargó diez alimentos con
   * él y el seed rebotó. Un tipo que no espeja su enum no es un tipo, es una
   * opinión.
   */
  defaultMeasurementType?: "MASS" | "VOLUME" | "UNIT";
  /**
   * Fichas nutricionales. Cada una declara su base física y su fuente.
   * Un nutriente ausente es DESCONOCIDO — jamás cero (§14).
   */
  nutrition: {
    basis: WeightBasis;
    basisUnit: "G" | "ML";
    energyKcal?: number;
    proteinG?: number;
    carbohydratesG?: number;
    fatG?: number;
    fiberG?: number;
    sugarsG?: number;
    saturatedFatG?: number;
    sodiumMg?: number;
    potassiumMg?: number;
    phosphorusMg?: number;
    notes?: string;
  }[];
}
