import type { WeightBasis } from "../catalog/types";
import { signature } from "../nutrition/profile";
import type { MealType } from "../recipes/types";

/**
 * ShoppingEngine (Sprint 6) — determinista y sin opinión.
 *
 * Transforma porciones CONFIRMADAS en demanda de compra. Nunca calcula
 * `receta × personas`: la fuente de verdad son los `member_serving_components`
 * que quedaron congelados al confirmar (§1). Y nunca decide nada (§29): no
 * cambia porciones, no sustituye alimentos, no ajusta recetas. Solo suma,
 * convierte cuando SABE convertir, y explica de dónde salió cada gramo.
 *
 * Tres reglas que no se negocian:
 *
 *  - **Identidad real** (§3): se agrupa por el alimento que la persona come de
 *    verdad — merluza de Sebastián con merluza, no con el pollo del resto.
 *  - **Crudo ≠ cocido** (§4): 150 g de arroz cocido no son 150 g de arroz
 *    crudo. Con rendimiento conocido se convierte; sin rendimiento se marca
 *    `PURCHASE_QUANTITY_UNRESOLVED` — jamás se inventa un 1.0 (§47).
 *  - **Unidades incompatibles no se suman** (§7, §9): gramos con mililitros o
 *    con unidades jamás; cada dominio de unidad es su propia línea.
 */

export const SHOPPING_ENGINE_VERSION = "shopping-engine/1.0.0";

export type ShoppingUnit = "G" | "ML" | "UNIT";

export type PurchaseBasis = "RAW" | "COMMERCIAL_PACKAGE" | "UNIT" | "DRAINED" | "OTHER";

/** Un componente tal como quedó congelado al confirmar la porción. */
export interface ConfirmedComponent {
  ingredientId: string | null;
  productId: string | null;
  label: string;
  quantity: number;
  unit: "G" | "ML";
  weightBasis: WeightBasis;
  cookingMethod: string | null;
  addedFatG: number;
}

export interface ConfirmedServing {
  assignmentId: string;
  /** Fecha DATE-only `YYYY-MM-DD`. */
  date: string;
  mealType: MealType;
  memberId: string;
  memberName: string;
  components: ConfirmedComponent[];
}

/** Rendimiento crudo→cocido: peso cocido = peso crudo × factor. */
export interface YieldEntry {
  ingredientId: string;
  /** null = vale para cualquier método; la fila con método le gana. */
  cookingMethod: string | null;
  factor: number;
}

export interface IngredientMeta {
  id: string;
  label: string;
  categoryCode: string | null;
  /** Porción comestible (0-1]: crudo a comprar = comestible ÷ factor. */
  ediblePortionFactor: number | null;
}

export interface ProductMeta {
  id: string;
  label: string;
  packageQuantity: number | null;
  packageUnit: "G" | "ML" | null;
}

export interface ShoppingInput {
  servings: readonly ConfirmedServing[];
  yields: readonly YieldEntry[];
  ingredients: readonly IngredientMeta[];
  products: readonly ProductMeta[];
}

export interface ProvenanceEntry {
  assignmentId: string;
  date: string;
  mealType: MealType;
  /** Cantidad de COMPRA que aporta esta comida (o culinaria si unresolved). */
  quantity: number;
  members: string[];
}

export interface DemandLine {
  /** Identidad estable de la línea: alimento/producto + unidad + base. */
  key: string;
  ingredientId: string | null;
  productId: string | null;
  label: string;
  categoryCode: string | null;
  unit: ShoppingUnit;
  purchaseBasis: PurchaseBasis;
  /**
   * Cantidad a COMPRAR. Cuando hay demanda cocida sin rendimiento, contiene
   * solo la parte resuelta y `unresolved` lo dice — nunca un número inventado.
   */
  requiredQuantity: number;
  /** Necesidad culinaria en cocido, cuando difiere de la de compra (§5). */
  cookedQuantity: number | null;
  /** Factor usado, si fue uno solo (§6). Con varios, el detalle vive en provenance. */
  yieldFactor: number | null;
  unresolved: boolean;
  unresolvedReason: string | null;
  /** Envases enteros sugeridos cuando el producto declara formato (§11). */
  packages: { count: number; packageQuantity: number } | null;
  provenance: ProvenanceEntry[];
}

/** Grupos de la lista (§18), mapeados desde las categorías del catálogo. */
export const SHOPPING_GROUPS = [
  { code: "FRESH", name: "Frutas y verduras" },
  { code: "MEAT", name: "Carnes" },
  { code: "FISH", name: "Pescados y mariscos" },
  { code: "DAIRY", name: "Lácteos" },
  { code: "BAKERY", name: "Panadería" },
  { code: "PANTRY", name: "Despensa" },
  { code: "FROZEN", name: "Congelados" },
  { code: "CONDIMENTS", name: "Condimentos" },
  { code: "OTHER", name: "Otros" },
] as const;
export type ShoppingGroupCode = (typeof SHOPPING_GROUPS)[number]["code"];

const CATEGORY_TO_GROUP: Record<string, ShoppingGroupCode> = {
  FRUITS: "FRESH",
  VEGETABLES: "FRESH",
  MEAT: "MEAT",
  POULTRY: "MEAT",
  FISH: "FISH",
  DAIRY: "DAIRY",
  EGGS: "DAIRY",
  BREAD: "BAKERY",
  GRAINS: "PANTRY",
  LEGUMES: "PANTRY",
  FATS_OILS: "PANTRY",
  NUTS_SEEDS: "PANTRY",
  BEVERAGES: "PANTRY",
};

export function groupForCategory(categoryCode: string | null): ShoppingGroupCode {
  if (!categoryCode) return "OTHER";
  return CATEGORY_TO_GROUP[categoryCode] ?? "OTHER";
}

/**
 * La grasa añadida por la preparación (freír, saltear) es demanda real pero no
 * apunta a un aceite específico del catálogo: se junta en una línea propia y
 * honesta en vez de inventarle una identidad.
 */
export const ADDED_FAT_LINE = {
  key: "added-fat::G::OTHER",
  label: "Grasa para cocinar (según preparación)",
} as const;

interface Acc {
  line: DemandLine;
  /** factores usados en la línea, para saber si fue uno solo */
  factors: Set<number>;
  /** por comida: cantidad y quiénes */
  byAssignment: Map<string, { date: string; mealType: MealType; quantity: number; members: Set<string> }>;
}

function basisGroup(basis: PurchaseBasis): string {
  // RAW convertible (crudo, cocido convertido, porción comestible) es un solo
  // grupo; DRAINED y PACKAGE no se mezclan con él (§5).
  if (basis === "RAW") return "RAW";
  return basis;
}

function yieldFor(
  yields: readonly YieldEntry[],
  ingredientId: string,
  cookingMethod: string | null,
): number | null {
  const especifico = cookingMethod
    ? yields.find((y) => y.ingredientId === ingredientId && y.cookingMethod === cookingMethod)
    : undefined;
  if (especifico) return especifico.factor;
  const generico = yields.find((y) => y.ingredientId === ingredientId && y.cookingMethod === null);
  return generico ? generico.factor : null;
}

/**
 * Agrega la demanda de compra de un conjunto de porciones confirmadas.
 * Determinista: mismas entradas, misma salida, en el mismo orden.
 */
export function aggregateDemand(input: ShoppingInput): DemandLine[] {
  const ingredientById = new Map(input.ingredients.map((i) => [i.id, i]));
  const productById = new Map(input.products.map((p) => [p.id, p]));
  const lines = new Map<string, Acc>();

  const touch = (
    key: string,
    base: Omit<DemandLine, "key" | "requiredQuantity" | "cookedQuantity" | "yieldFactor" | "unresolved" | "unresolvedReason" | "packages" | "provenance">,
  ): Acc => {
    let acc = lines.get(key);
    if (!acc) {
      acc = {
        line: {
          key,
          ...base,
          requiredQuantity: 0,
          cookedQuantity: null,
          yieldFactor: null,
          unresolved: false,
          unresolvedReason: null,
          packages: null,
          provenance: [],
        },
        factors: new Set(),
        byAssignment: new Map(),
      };
      lines.set(key, acc);
    }
    return acc;
  };

  const aporta = (acc: Acc, serving: ConfirmedServing, purchaseQty: number) => {
    let entry = acc.byAssignment.get(serving.assignmentId);
    if (!entry) {
      entry = { date: serving.date, mealType: serving.mealType, quantity: 0, members: new Set() };
      acc.byAssignment.set(serving.assignmentId, entry);
    }
    entry.quantity += purchaseQty;
    entry.members.add(serving.memberName);
  };

  for (const serving of input.servings) {
    for (const component of serving.components) {
      if (component.quantity > 0) {
        const meta = component.ingredientId ? ingredientById.get(component.ingredientId) : undefined;
        const product = component.productId ? productById.get(component.productId) : undefined;

        // --- resolver base de compra y conversión ---
        let basis: PurchaseBasis = "RAW";
        let purchaseQty: number | null = component.quantity;
        let cookedQty: number | null = null;
        let factor: number | null = null;
        let reason: string | null = null;

        switch (component.weightBasis) {
          case "RAW":
            break;
          case "COOKED": {
            cookedQty = component.quantity;
            factor = component.ingredientId
              ? yieldFor(input.yields, component.ingredientId, component.cookingMethod)
              : null;
            if (factor === null) {
              purchaseQty = null;
              reason =
                `No hay rendimiento crudo→cocido para ${component.label}` +
                (component.cookingMethod ? ` (${component.cookingMethod.toLowerCase()})` : "") +
                ": no se puede calcular cuánto comprar sin inventar un factor.";
            } else {
              purchaseQty = component.quantity / factor;
            }
            break;
          }
          case "EDIBLE_PORTION": {
            const edible = meta?.ediblePortionFactor ?? null;
            if (edible === null) {
              purchaseQty = null;
              reason =
                `No se conoce la porción comestible de ${component.label}: ` +
                "no se puede convertir a cantidad con cáscara/hueso sin inventar.";
            } else {
              purchaseQty = component.quantity / edible;
            }
            break;
          }
          case "DRAINED":
            basis = "DRAINED";
            break;
          case "AS_PACKAGED":
            basis = "COMMERCIAL_PACKAGE";
            break;
        }

        const identidad =
          component.productId ?? component.ingredientId ?? `label:${component.label}`;
        const key = `${identidad}::${component.unit}::${basisGroup(basis)}`;

        const acc = touch(key, {
          ingredientId: component.ingredientId,
          productId: component.productId,
          label: product?.label ?? meta?.label ?? component.label,
          categoryCode: meta?.categoryCode ?? null,
          unit: component.unit,
          purchaseBasis: basis,
        });

        if (purchaseQty !== null) {
          acc.line.requiredQuantity += purchaseQty;
          if (factor !== null) acc.factors.add(factor);
          aporta(acc, serving, purchaseQty);
        } else {
          // Demanda cocida sin conversión: se declara, no se inventa (§4). En
          // la procedencia va la cantidad CULINARIA — un 0 diría "esta comida
          // no necesita nada", que es falso.
          acc.line.unresolved = true;
          acc.line.unresolvedReason = acc.line.unresolvedReason
            ? acc.line.unresolvedReason
            : reason;
          aporta(acc, serving, component.quantity);
        }
        if (cookedQty !== null) {
          acc.line.cookedQuantity = (acc.line.cookedQuantity ?? 0) + cookedQty;
        }
      }

      // Grasa añadida por la preparación de esta persona: demanda propia, en
      // gramos, sin mezclarla con el aceite de la receta (que puede ir en ml).
      if (component.addedFatG > 0) {
        const acc = touch(ADDED_FAT_LINE.key, {
          ingredientId: null,
          productId: null,
          label: ADDED_FAT_LINE.label,
          categoryCode: "FATS_OILS",
          unit: "G",
          purchaseBasis: "OTHER",
        });
        acc.line.requiredQuantity += component.addedFatG;
        aporta(acc, serving, component.addedFatG);
      }
    }
  }

  // --- cierre de cada línea ---
  const salida: DemandLine[] = [];
  for (const acc of lines.values()) {
    const line = acc.line;
    line.yieldFactor = acc.factors.size === 1 ? [...acc.factors][0]! : null;

    // Envases enteros cuando el producto declara formato en la misma unidad (§11).
    // Sin envases para DRAINED: el envase declara contenido ENVASADO y la
    // demanda está en gramos ESCURRIDOS — dividir dos bases distintas es la
    // misma mentira que crudo÷cocido sin rendimiento.
    if (line.productId && line.purchaseBasis !== "DRAINED") {
      const product = productById.get(line.productId);
      if (
        product?.packageQuantity &&
        product.packageUnit === line.unit &&
        line.requiredQuantity > 0
      ) {
        line.packages = {
          count: Math.ceil(line.requiredQuantity / product.packageQuantity),
          packageQuantity: product.packageQuantity,
        };
      }
    }

    line.provenance = [...acc.byAssignment.entries()]
      .map(([assignmentId, e]) => ({
        assignmentId,
        date: e.date,
        mealType: e.mealType,
        quantity: redondear(e.quantity),
        members: [...e.members].sort(),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    line.requiredQuantity = redondear(line.requiredQuantity);
    if (line.cookedQuantity !== null) line.cookedQuantity = redondear(line.cookedQuantity);
    salida.push(line);
  }

  // Orden estable: por grupo de compra, después por etiqueta.
  const groupOrder = new Map(SHOPPING_GROUPS.map((g, i) => [g.code, i]));
  return salida.sort((a, b) => {
    const ga = groupOrder.get(groupForCategory(a.categoryCode)) ?? 99;
    const gb = groupOrder.get(groupForCategory(b.categoryCode)) ?? 99;
    if (ga !== gb) return ga - gb;
    return a.label.localeCompare(b.label, "es") || a.key.localeCompare(b.key);
  });
}

/** Precisión interna: tres decimales, sin ruido de coma flotante. */
function redondear(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Firma de las ENTRADAS (§24, §51). Depende del contenido — qué se come, cuánto
 * y con qué rendimientos — y no de los ids de fila: deshacer y reconfirmar la
 * misma porción produce la misma firma y no genera una revisión duplicada.
 */
export function demandSignature(input: ShoppingInput): string {
  const contenido = {
    engine: SHOPPING_ENGINE_VERSION,
    // Regla: la firma cubre TODO lo que aggregateDemand lee. Si el catálogo
    // gana un edible_portion_factor o cambia el formato de un envase, la
    // demanda cambia y la lista tiene que enterarse.
    ingredients: [...input.ingredients]
      .map((i) => ({ i: i.id, e: i.ediblePortionFactor, c: i.categoryCode, l: i.label }))
      .sort((x, y) => x.i.localeCompare(y.i)),
    products: [...input.products]
      .map((p) => ({ i: p.id, q: p.packageQuantity, u: p.packageUnit, l: p.label }))
      .sort((x, y) => x.i.localeCompare(y.i)),
    servings: [...input.servings]
      .map((s) => ({
        a: s.assignmentId,
        m: s.memberId,
        c: [...s.components]
          .map((c) => ({
            i: c.ingredientId,
            p: c.productId,
            l: c.label,
            q: c.quantity,
            u: c.unit,
            w: c.weightBasis,
            k: c.cookingMethod,
            f: c.addedFatG,
          }))
          .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      }))
      .sort((x, y) => (x.a + x.m).localeCompare(y.a + y.m)),
    yields: [...input.yields]
      .map((y) => ({ i: y.ingredientId, m: y.cookingMethod, f: y.factor }))
      .sort((x, y) => (x.i + (x.m ?? "")).localeCompare(y.i + (y.m ?? ""))),
  };
  return signature(contenido);
}

// ---------------------------------------------------------------------------
// Deltas entre revisiones (§25)
// ---------------------------------------------------------------------------

export type DeltaKind =
  | "ADDED"
  | "REMOVED"
  | "QUANTITY_INCREASED"
  | "QUANTITY_DECREASED"
  | "UNCHANGED";

export interface DemandDelta {
  key: string;
  label: string;
  unit: ShoppingUnit;
  kind: DeltaKind;
  before: number | null;
  after: number | null;
  /** after - before (positivo = comprar más). */
  difference: number;
  /** La línea tiene cantidad sin resolver: el número mostrado no es un dato. */
  unresolved: boolean;
}

const TOLERANCIA = 0.001;

/** Lo mínimo que hace falta para comparar: una fila de la lista guardada sirve. */
export type DeltaSource = Pick<DemandLine, "key" | "label" | "unit" | "requiredQuantity"> &
  Partial<Pick<DemandLine, "unresolved">>;

export function computeDeltas(
  before: readonly DeltaSource[],
  after: readonly DeltaSource[],
): DemandDelta[] {
  const antes = new Map(before.map((l) => [l.key, l]));
  const despues = new Map(after.map((l) => [l.key, l]));
  const claves = [...new Set([...antes.keys(), ...despues.keys()])].sort();

  return claves.map((key) => {
    const a = antes.get(key) ?? null;
    const d = despues.get(key) ?? null;
    const qa = a?.requiredQuantity ?? null;
    const qd = d?.requiredQuantity ?? null;
    const diff = redondear((qd ?? 0) - (qa ?? 0));

    let kind: DeltaKind;
    if (a === null) kind = "ADDED";
    else if (d === null) kind = "REMOVED";
    else if (Math.abs(diff) <= TOLERANCIA) kind = "UNCHANGED";
    else kind = diff > 0 ? "QUANTITY_INCREASED" : "QUANTITY_DECREASED";

    return {
      key,
      label: (d ?? a)!.label,
      unit: (d ?? a)!.unit,
      kind,
      before: qa,
      after: qd,
      difference: diff,
      // §6 [U-6]: una línea sin rendimiento tiene cantidad DESCONOCIDA, no 0.
      unresolved: (d ?? a)!.unresolved === true,
    };
  });
}

// ---------------------------------------------------------------------------
// Presentación de cantidades (§8): precisión interna, unidad amigable afuera
// ---------------------------------------------------------------------------

export function formatQuantity(quantity: number, unit: ShoppingUnit): string {
  const numero = (n: number, decimales: number) =>
    n.toLocaleString("es-CL", {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimales,
    });

  if (unit === "UNIT") return `${numero(quantity, 0)} ${quantity === 1 ? "unidad" : "unidades"}`;
  if (unit === "G") {
    if (quantity >= 1000) return `${numero(quantity / 1000, 2)} kg`;
    return `${numero(quantity, 1)} g`;
  }
  if (quantity >= 1000) return `${numero(quantity / 1000, 2)} L`;
  return `${numero(quantity, 1)} ml`;
}
