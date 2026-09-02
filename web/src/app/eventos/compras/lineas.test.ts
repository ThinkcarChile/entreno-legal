import { describe, expect, it } from "vitest";
import type {
  BbqAttendanceStatus,
  BbqCutPlan,
  BbqQuantityResult,
  Range,
} from "@/domain/events/bbq/types";
import { planDeCompraDelEvento, sobranteDespuesDelRedondeo } from "./lineas";

/**
 * Lo que estos tests defienden, en orden de gravedad:
 *
 *  1. Dos renglones del menú con el MISMO alimento no pueden pisarse. La clave
 *     de línea es única por lista: si cada uno escribiera la suya, la segunda
 *     borraría a la primera y el hogar compraría la mitad de la carne.
 *  2. Un corte que el motor no pudo estimar NO se convierte en cero gramos.
 *  3. El sobrante que se muestra en compras incluye el redondeo comercial, y
 *     jamás suma gramos de compra con gramos servibles.
 */

const RANGO = (min: number, base: number, max: number): Range => ({ min, base, max });

function corte(over: Partial<BbqCutPlan> & { itemId: string }): BbqCutPlan {
  return {
    cutRef: "ing-1",
    displayName: "Sobrecostilla",
    category: "VACUNO",
    servable: RANGO(1000, 1200, 1400),
    cooked: { known: true, value: RANGO(1050, 1260, 1470) },
    rawEdible: { known: true, value: RANGO(1500, 1800, 2100) },
    rawPurchase: { known: true, value: RANGO(1875, 2250, 2625) },
    inventoryToUse: { known: true, grams: 0, frozenGrams: 0, lotIds: [] },
    purchaseRequired: { known: true, value: RANGO(1875, 2250, 2625) },
    batches: { known: false, reason: "EQUIPMENT_CAPACITY_UNKNOWN" },
    chain: [
      { stage: "RAW_PURCHASE_TO_EDIBLE_RAW", factor: 0.8, source: "CUT_DEFINITION", observations: 0, conflict: false },
      { stage: "EDIBLE_RAW_TO_COOKED", factor: 0.7, source: "INGREDIENT_YIELD", observations: 0, conflict: false },
      { stage: "COOKED_TO_SERVABLE", factor: 0.95, source: "CUT_DEFINITION", observations: 0, conflict: false },
    ],
    flags: [],
    ...over,
  };
}

function resultado(byCut: BbqCutPlan[], sobrante: Range = RANGO(0, 0, 0)): BbqQuantityResult {
  const cero = RANGO(0, 0, 0);
  const asistencia = {
    INVITED: 0,
    CONFIRMED: 0,
    MAYBE: 0,
    DECLINED: 0,
    ATTENDED: 0,
    NO_SHOW: 0,
  } as Record<BbqAttendanceStatus, number>;
  return {
    engineVersion: "bbq-quantity/1.0.0",
    policyVersion: "test",
    policySource: "test",
    inputSignature: "firma",
    headcount: {
      participants: 8,
      counted: 8,
      adults: 8,
      children: 0,
      unknownAge: 0,
      householdMembers: 0,
      guests: 8,
      byAttendance: asistencia,
      effective: RANGO(8, 8, 8),
    },
    demand: {
      participants: RANGO(1000, 1200, 1400),
      desiredLeftoverGrams: 0,
      safetyBuffer: cero,
      total: RANGO(1000, 1200, 1400),
    },
    totalServableDemand: RANGO(1000, 1200, 1400),
    byCut,
    uncoveredServableDemand: null,
    expectedLeftovers: { range: sobrante, basis: "BEFORE_COMMERCIAL_ROUNDING" },
    knownPurchaseSubtotal: RANGO(0, 0, 0),
    totalPurchaseRequired: { known: true, value: RANGO(1875, 2250, 2625) },
    coverage: {
      appetiteKnown: 1,
      ageKnown: 1,
      dietaryInfoKnown: 1,
      attendanceConfirmed: 1,
      cutsWithFullChain: 1,
    },
    confidence: "MEDIUM",
    reasons: [],
    reviewRequired: [],
  };
}

const EVENTO = { eventoId: "ev-1", titulo: "Asado del sábado", fecha: "2026-09-12" };

describe("dos renglones del mismo alimento comparten una línea de compra", () => {
  it("suma las cantidades en vez de pisar la línea", () => {
    const plan = planDeCompraDelEvento({
      ...EVENTO,
      salida: resultado([
        corte({ itemId: "a", displayName: "Sobrecostilla a la parrilla" }),
        corte({ itemId: "b", displayName: "Sobrecostilla al vacío" }),
      ]),
      identidades: [
        { itemId: "a", ingredientId: "ing-1", productId: null },
        { itemId: "b", ingredientId: "ing-1", productId: null },
      ],
    });

    // UNA línea, no dos con la misma clave.
    expect(plan.lineas).toHaveLength(1);
    // Y la cantidad es la SUMA. Si la agrupación se rompiera y cada renglón
    // escribiera su línea, la base seguiría siendo 2250 y se compraría la mitad.
    expect(plan.lineas[0]!.cantidad).toBe(4500);
    expect(plan.lineas[0]!.procedencia.map((p) => p.itemId)).toEqual(["a", "b"]);
  });

  it("dos alimentos distintos son dos líneas con claves distintas", () => {
    const plan = planDeCompraDelEvento({
      ...EVENTO,
      salida: resultado([
        corte({ itemId: "a", cutRef: "ing-1" }),
        corte({ itemId: "b", cutRef: "ing-2", displayName: "Pollo" }),
      ]),
      identidades: [
        { itemId: "a", ingredientId: "ing-1", productId: null },
        { itemId: "b", ingredientId: "ing-2", productId: null },
      ],
    });
    expect(plan.lineas).toHaveLength(2);
    expect(new Set(plan.lineas.map((l) => l.lineKey)).size).toBe(2);
  });

  it("la clave lleva el evento, la identidad, la unidad y la base", () => {
    const plan = planDeCompraDelEvento({
      ...EVENTO,
      salida: resultado([corte({ itemId: "a" })]),
      identidades: [{ itemId: "a", ingredientId: "ing-1", productId: null }],
    });
    expect(plan.lineas[0]!.lineKey).toBe("event:ev-1::ing:ing-1::G::RAW");
    expect(plan.lineas[0]!.purchaseBasis).toBe("RAW");
  });
});

describe("un corte sin rendimiento no vale cero", () => {
  it("línea entera sin estimar: cantidad null y motivo escrito", () => {
    const plan = planDeCompraDelEvento({
      ...EVENTO,
      salida: resultado([
        corte({ itemId: "a", purchaseRequired: { known: false, reason: "YIELD_UNKNOWN" } }),
      ]),
      identidades: [{ itemId: "a", ingredientId: "ing-1", productId: null }],
    });
    expect(plan.lineas[0]!.cantidad).toBeNull();
    expect(plan.lineas[0]!.sinCantidad).toBe(true);
    expect(plan.lineas[0]!.motivo).toContain("Sobrecostilla");
    // La procedencia conserva el corte con cantidad desconocida: la línea
    // existe, y quien la mire tiene que ver POR QUÉ no tiene número.
    expect(plan.lineas[0]!.procedencia[0]!.quantity).toBeNull();
  });

  it("línea a medias: la cantidad es la parte conocida y se marca sin resolver", () => {
    const plan = planDeCompraDelEvento({
      ...EVENTO,
      salida: resultado([
        corte({ itemId: "a" }),
        corte({
          itemId: "b",
          displayName: "Entraña",
          purchaseRequired: { known: false, reason: "YIELD_UNKNOWN" },
        }),
      ]),
      identidades: [
        { itemId: "a", ingredientId: "ing-1", productId: null },
        { itemId: "b", ingredientId: "ing-1", productId: null },
      ],
    });
    expect(plan.lineas[0]!.cantidad).toBe(2250);
    expect(plan.lineas[0]!.sinCantidad).toBe(true);
    expect(plan.lineas[0]!.motivo).toContain("Entraña");
  });
});

describe("el inventario que no se pudo netear se declara aparte", () => {
  it("los gramos de base desconocida NO entran en lo neteado", () => {
    const plan = planDeCompraDelEvento({
      ...EVENTO,
      salida: resultado([
        corte({
          itemId: "a",
          inventoryToUse: { known: true, grams: 800, frozenGrams: 800, lotIds: ["l1"] },
        }),
        corte({
          itemId: "b",
          cutRef: "ing-2",
          displayName: "Pollo",
          inventoryToUse: {
            known: false,
            reason: "INVENTORY_YIELD_UNKNOWN",
            faceValueGrams: 1500,
            lotIds: ["l2"],
          },
        }),
      ]),
      identidades: [
        { itemId: "a", ingredientId: "ing-1", productId: null },
        { itemId: "b", ingredientId: "ing-2", productId: null },
      ],
    });
    expect(plan.resumen.inventarioNeteado).toBe(800);
    expect(plan.resumen.inventarioSinBase).toBe(1500);
  });
});

describe("un corte que ya no está en el menú no se compra a ciegas", () => {
  it("se avisa y la línea no se escribe", () => {
    const plan = planDeCompraDelEvento({
      ...EVENTO,
      salida: resultado([corte({ itemId: "borrado" })]),
      identidades: [],
    });
    expect(plan.lineas).toHaveLength(0);
    expect(plan.avisos.join(" ")).toContain("ya no está en el menú");
  });
});

describe("el sobrante que ve la persona incluye el redondeo comercial", () => {
  const salida = resultado([corte({ itemId: "a" })], RANGO(400, 500, 600));

  it("comprar de más por el envase aumenta el sobrante, convertido a peso servible", () => {
    // Recomendado 2.250 g de compra; se compran 4.250 (dos paquetes de kilo y
    // pico). Los 2.000 g de más rinden 2000 × 0,8 × 0,7 × 0,95 = 1.064 g en el
    // plato. El sobrante pasa de ~500 g a ~1.564 g.
    const s = sobranteDespuesDelRedondeo(salida, { a: 4250 });
    expect(s.conocido).toBe(true);
    if (!s.conocido) return;
    expect(s.extraDeCompra).toBe(2000);
    expect(s.rango.base).toBeCloseTo(1564, 0);
    // El extra JAMÁS se suma en peso de compra: 500 + 2000 = 2500 sería la
    // resta ilegal entre dos bases distintas.
    expect(s.rango.base).not.toBeCloseTo(2500, 0);
  });

  it("comprar exactamente lo recomendado deja el sobrante del motor", () => {
    const s = sobranteDespuesDelRedondeo(salida, { a: 2250 });
    expect(s.conocido).toBe(true);
    if (!s.conocido) return;
    expect(s.rango).toEqual(RANGO(400, 500, 600));
    expect(s.extraDeCompra).toBe(0);
  });

  it("sin cadena completa el sobrante es un PISO, no un total", () => {
    const sinCadena = resultado(
      [
        corte({
          itemId: "a",
          chain: [
            { stage: "RAW_PURCHASE_TO_EDIBLE_RAW", factor: 0.8, source: "CUT_DEFINITION", observations: 0, conflict: false },
            { stage: "EDIBLE_RAW_TO_COOKED", factor: null, source: null, observations: 0, conflict: false },
            { stage: "COOKED_TO_SERVABLE", factor: null, source: null, observations: 0, conflict: false },
          ],
        }),
      ],
      RANGO(400, 500, 600),
    );
    const s = sobranteDespuesDelRedondeo(sinCadena, { a: 4250 });
    expect(s.conocido).toBe(false);
    if (s.conocido) return;
    expect(s.cortesSinCadena).toEqual(["Sobrecostilla"]);
    expect(s.alMenos).toEqual(RANGO(400, 500, 600));
    expect(s.motivo).toContain("piso");
  });

  it("un corte del que no se compró nada no aporta sobrante", () => {
    const s = sobranteDespuesDelRedondeo(salida, {});
    expect(s.conocido).toBe(true);
    if (!s.conocido) return;
    expect(s.rango).toEqual(RANGO(400, 500, 600));
  });
});
