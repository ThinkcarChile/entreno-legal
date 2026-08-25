/**
 * Explicabilidad estructurada (§31). Nunca texto libre: cada razón es un código
 * + parámetros, y el texto se compone a partir de eso. Así mañana se puede
 * traducir, filtrar o auditar sin volver a parsear frases.
 */

export const REASON_CODES = [
  "STANDARD_PORTION",
  "NO_TARGETS",
  "MEAL_DISABLED",
  "PROTEIN_TARGET",
  "CALORIE_LIMIT",
  "COOKING_PREFERENCE",
  "ADDED_FAT_AVOIDED",
  "ADDED_FAT_INCLUDED",
  "SALAD_PREFERENCE",
  "SOFT_PREFERENCE",
  "HARD_CONSTRAINT",
  "SUBSTITUTION_SUGGESTED",
  "TARGET_CONFLICT",
  "MISSING_ADJUSTMENT_LIMITS",
  "LIMIT_UNVERIFIABLE",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export type ReasonParams = Record<string, string | number>;

export interface Reason {
  code: ReasonCode;
  params: ReasonParams;
  /** Texto ya compuesto, listo para mostrar. La fuente de verdad es code+params. */
  text: string;
}

function n(value: unknown): string {
  return typeof value === "number"
    ? Number(value.toFixed(value % 1 === 0 ? 0 : 1)).toLocaleString("es-CL")
    : String(value ?? "");
}

const TEMPLATES: Record<ReasonCode, (p: ReasonParams) => string> = {
  STANDARD_PORTION: () => "Porción estándar de la receta: no hay nada que ajustar.",
  NO_TARGETS: () =>
    "Esta persona no tiene objetivos configurados para esta comida, así que recibe la porción estándar.",
  MEAL_DISABLED: (p) => `${p.meal} no forma parte de su patrón de comidas.`,
  PROTEIN_TARGET: (p) =>
    `Ajustamos ${p.component} de ${n(p.from)} a ${n(p.to)} g para acercarnos a tu objetivo de proteína de esta comida (${n(p.min)}–${n(p.max)} g, ideal ${n(p.preferred)} g).`,
  CALORIE_LIMIT: (p) =>
    `Bajamos ${p.component} de ${n(p.from)} a ${n(p.to)} g para mantener la comida bajo ${n(p.limit)} kcal.`,
  COOKING_PREFERENCE: (p) =>
    `Tu preparación preferida para ${p.component} es ${p.method}.`,
  ADDED_FAT_AVOIDED: (p) =>
    `Sacamos ${p.component} porque prefieres evitar la grasa añadida.`,
  ADDED_FAT_INCLUDED: (p) =>
    `${p.component} queda incluido: ${n(p.grams)} g de grasa añadida que cuentan en tu porción.`,
  SALAD_PREFERENCE: (p) => `Subimos la ensalada a ${n(p.to)} g porque la prefieres.`,
  SOFT_PREFERENCE: (p) =>
    `${p.component} no es de tu gusto. No lo quitamos, pero queda anotado.`,
  HARD_CONSTRAINT: (p) =>
    `${p.component} no es compatible contigo (${p.reason}). Esta receta necesita un reemplazo.`,
  SUBSTITUTION_SUGGESTED: (p) =>
    `Podrías reemplazar ${p.component} por ${p.alternative}.`,
  // Gate 0→10 [J-1]: el techo existe, el plato no tiene ficha completa. No se
  // dice "cumplido" ni "excedido": se dice que no se sabe.
  LIMIT_UNVERIFIABLE: (p) =>
    `No se puede verificar el ${p.limit === "ENERGY_MAX" ? "tope de calorías" : "mínimo de proteína"}: falta la ficha de ${n(p.faltan)} ingrediente(s) del plato.`,
  TARGET_CONFLICT: (p) =>
    `No es posible alcanzar ${n(p.protein)} g de proteína manteniendo esta comida bajo ${n(p.calories)} kcal con esta receta.`,
  MISSING_ADJUSTMENT_LIMITS: (p) =>
    `${p.component} no tiene límites de ajuste definidos: se usó un margen conservador.`,
};

export function reason(code: ReasonCode, params: ReasonParams = {}): Reason {
  return { code, params, text: TEMPLATES[code](params) };
}
