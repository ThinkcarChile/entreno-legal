import { describe, expect, it } from "vitest";
import {
  POLITICA_POR_DEFECTO,
  RECIPE_COST_ENGINE_VERSION,
  costRecipe,
  type MarketEstimate,
  type RecipeCostComponentInput,
  type RecipeCostInput,
} from "./recipe-cost-engine";
import { known, money, unknown } from "./money";

/**
 * El motor de costo de receta, con los defectos que el diseño traía adentro.
 * Cada test cae si el arreglo se revierte.
 */

function receta(componentes: readonly RecipeCostComponentInput[], servings = 4): RecipeCostInput {
  return {
    currency: "CLP",
    recipeId: "rec-1",
    recipeVersionId: "ver-1",
    servings,
    components: componentes,
    policy: POLITICA_POR_DEFECTO,
  };
}

/** Pollo en la despensa: 1 kg que costó $2.000 (marzo). */
function loteDePollo(valorMinor: bigint | null): RecipeCostComponentInput["pantry"] {
  return {
    lotId: "lote-pollo",
    remaining: valorMinor === null ? unknown("LOT_VALUE_UNKNOWN") : known(money("CLP", valorMinor)),
    remainingQuantity: 1000,
    unit: "G",
    weightBasis: "RAW",
  };
}

/** El mismo pollo en la vitrina del súper HOY: $4.500 el kilo. */
const VITRINA_AGOSTO: MarketEstimate = {
  source: "PRICE_OBSERVATION",
  referenceId: "obs-1",
  observedOn: "2026-08-20",
  normalizedValueMinor: 4500n, // $4.500 el kilo
  unit: "G",
  weightBasis: "RAW",
  staleDays: 5,
};

describe("[H8] la despensa NO se revaloriza a precio de mercado", () => {
  it("un lote con valor conocido se costea al costo del lote, aunque haya precio de vitrina", () => {
    const r = costRecipe(
      receta([
        {
          componentId: "c1",
          label: "Pollo",
          quantity: 500,
          unit: "G",
          weightBasis: "RAW",
          optional: false,
          pantry: loteDePollo(2000n),
          market: [VITRINA_AGOSTO],
        },
      ]),
    );
    // Medio kilo de un lote de 1 kg que costó $2.000 vale $1.000. Con el precio
    // de vitrina habría dado $2.250: un 125 % más, puro IPC disfrazado de ahorro.
    expect(r.lines[0]!.cost).toEqual(known(money("CLP", 1000n)));
    expect(r.lines[0]!.valuationKind).toBe("HISTORICAL_COST");
    expect(r.fromPantry).toEqual(known(money("CLP", 1000n)));
    expect(r.requiresPurchase).toEqual(known(money("CLP", 0n)));
  });

  it("un lote SIN valor queda DESCONOCIDO y no cae al precio de mercado", () => {
    // Éste es el caso exacto que el `valuationOrder` del diseño dejaba pasar:
    // «no hay lote» y «hay lote sin valor» se trataban igual, y el segundo caía
    // a una observación de vitrina que después sumaba dentro de `fromPantry`.
    const r = costRecipe(
      receta([
        {
          componentId: "c1",
          label: "Pollo",
          quantity: 500,
          unit: "G",
          weightBasis: "RAW",
          optional: false,
          pantry: loteDePollo(null),
          market: [VITRINA_AGOSTO],
        },
      ]),
    );
    expect(r.lines[0]!.cost).toEqual(unknown("LOT_VALUE_UNKNOWN"));
    expect(r.fromPantry.known).toBe(false);
    expect(r.total.known).toBe(false);
    expect(r.missing.map((m) => m.label)).toEqual(["Pollo"]);
  });

  it("la política de despensa es LOT_ACTUAL y nada más", () => {
    expect(POLITICA_POR_DEFECTO.pantryValuationOrder).toEqual(["LOT_ACTUAL"]);
  });
});

describe("[H11] «ya lo tengo» no significa «es gratis»", () => {
  const pollo = (enDespensa: boolean): RecipeCostComponentInput => ({
    componentId: "c1",
    label: "Pollo",
    quantity: 500,
    unit: "G",
    weightBasis: "RAW",
    optional: false,
    pantry: enDespensa ? loteDePollo(2000n) : null,
    market: [
      {
        source: "LAST_PURCHASE",
        referenceId: "pi-1",
        observedOn: "2026-08-01",
        normalizedValueMinor: 2000n, // $2.000 el kilo
        unit: "G",
        weightBasis: "RAW",
        staleDays: 20,
      },
    ],
  });

  it("cuesta lo mismo prepararlo, esté o no en la despensa; sólo cambia lo que hay que comprar", () => {
    const conDespensa = costRecipe(receta([pollo(true)]));
    const sinDespensa = costRecipe(receta([pollo(false)]));

    // La cifra de «cuesta preparar» es IDÉNTICA. Es la que impide que el mismo
    // plan parezca barato una semana y caro la siguiente.
    expect(conDespensa.total).toEqual(sinDespensa.total);
    expect(conDespensa.total).toEqual(known(money("CLP", 1000n)));

    // Lo que cambia es la caja de hoy.
    expect(conDespensa.requiresPurchase).toEqual(known(money("CLP", 0n)));
    expect(sinDespensa.requiresPurchase).toEqual(known(money("CLP", 1000n)));
    expect(conDespensa.lines[0]!.requiresCashToday).toBe(false);
    expect(sinDespensa.lines[0]!.requiresCashToday).toBe(true);
  });
});

describe("un precio viejo no es un precio", () => {
  it("sobre staleAfterDays la línea queda desconocida en vez de estimarse", () => {
    const r = costRecipe(
      receta([
        {
          componentId: "c1",
          label: "Aceite",
          quantity: 200,
          unit: "ML",
          weightBasis: "AS_PACKAGED",
          optional: false,
          pantry: null,
          market: [
            {
              source: "PRICE_OBSERVATION",
              referenceId: "obs-viejo",
              observedOn: "2025-12-01",
              normalizedValueMinor: 3000n,
              unit: "ML",
              weightBasis: "AS_PACKAGED",
              staleDays: 240,
            },
          ],
        },
      ]),
    );
    expect(r.lines[0]!.cost).toEqual(unknown("NO_PRICE_RECORDED"));
    expect(r.confidence).toBe("INSUFFICIENT_DATA");
  });
});

describe("la base física no se convierte sin factor anotado", () => {
  const atun = (conversion?: { num: bigint; den: bigint }): RecipeCostComponentInput => ({
    componentId: "c1",
    label: "Atún",
    quantity: 100,
    unit: "G",
    weightBasis: "DRAINED",
    optional: false,
    pantry: {
      lotId: "l",
      remaining: known(money("CLP", 2000n)),
      remainingQuantity: 1000,
      unit: "G",
      weightBasis: "AS_PACKAGED",
    },
    market: [],
    ...(conversion === undefined ? {} : { basisConversion: conversion }),
  });

  it("sin factor, el peso drenado contra el peso del envase queda DESCONOCIDO", () => {
    // Comparar peso drenado con peso neto produce una diferencia del 30 % que
    // no existe. Acá no se inventa un 1:1.
    const r = costRecipe(receta([atun()]));
    expect(r.lines[0]!.cost).toEqual(unknown("UNIT_NOT_NORMALIZABLE"));
  });

  it("con el factor anotado sí se convierte, y en fracción exacta", () => {
    // 100 g drenados equivalen a 143 g de envase con factor 10/7.
    const r = costRecipe(receta([atun({ num: 10n, den: 7n })]));
    // 142857 milésimas de gramo → $2.000 * 142857 / 1000000 = $286 (half-even).
    expect(r.lines[0]!.cost).toEqual(known(money("CLP", 286n)));
  });
});

describe("la regla transversal del total", () => {
  it("total es conocido SI Y SÓLO SI la confianza es KNOWN", () => {
    const r = costRecipe(
      receta([
        {
          componentId: "c1",
          label: "Arroz",
          quantity: 500,
          unit: "G",
          weightBasis: "RAW",
          optional: false,
          pantry: loteDePollo(2000n),
          market: [],
        },
        {
          componentId: "c2",
          label: "Cilantro",
          quantity: 20,
          unit: "G",
          weightBasis: "RAW",
          optional: false,
          pantry: null,
          market: [],
        },
      ]),
    );
    expect(r.confidence).not.toBe("KNOWN");
    expect(r.total.known).toBe(false);
    // Pero el subtotal SÍ está, y viene con la lista de lo que falta, en el
    // mismo objeto: no se puede mostrar uno sin el otro.
    expect(r.knownSubtotal.minorAtLeast).toBe(1000n);
    expect(r.knownSubtotal.missingCount).toBe(1);
    expect(r.missing.map((m) => m.label)).toEqual(["Cilantro"]);
  });

  it("un opcional sin precio no degrada la confianza del plato", () => {
    const r = costRecipe(
      receta([
        {
          componentId: "c1",
          label: "Pollo",
          quantity: 500,
          unit: "G",
          weightBasis: "RAW",
          optional: false,
          pantry: loteDePollo(2000n),
          market: [],
        },
        {
          componentId: "c2",
          label: "Perejil (opcional)",
          quantity: 5,
          unit: "G",
          weightBasis: "RAW",
          optional: true,
          pantry: null,
          market: [],
        },
      ]),
    );
    expect(r.confidence).toBe("KNOWN");
    expect(r.total).toEqual(known(money("CLP", 1000n)));
    // Igual aparece en las líneas: no se esconde, sólo no manda.
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]!.cost.known).toBe(false);
  });

  it("el costo por porción sale del total, y con porciones inválidas es DESCONOCIDO", () => {
    const componente: RecipeCostComponentInput = {
      componentId: "c1",
      label: "Pollo",
      quantity: 500,
      unit: "G",
      weightBasis: "RAW",
      optional: false,
      pantry: loteDePollo(2000n),
      market: [],
    };
    expect(costRecipe(receta([componente], 4)).perServing).toEqual(known(money("CLP", 250n)));
    expect(costRecipe(receta([componente], 0)).perServing).toEqual(
      unknown("POLICY_NOT_APPLICABLE"),
    );
  });
});

describe("el motor es puro y versionado", () => {
  it("declara su versión y no depende del reloj", () => {
    const entrada = receta([
      {
        componentId: "c1",
        label: "Pollo",
        quantity: 500,
        unit: "G",
        weightBasis: "RAW",
        optional: false,
        pantry: loteDePollo(2000n),
        market: [],
      },
    ]);
    const a = costRecipe(entrada);
    const b = costRecipe(entrada);
    expect(a.engineVersion).toBe(RECIPE_COST_ENGINE_VERSION);
    expect(a).toEqual(b);
  });
});
