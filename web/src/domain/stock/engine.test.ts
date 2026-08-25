import { describe, expect, it } from "vitest";
import { consumptionRate, toRawQuantity } from "./forecast";
import { analyzeStock, lotUsable, REORDER_ENGINE_VERSION } from "./engine";
import type { StockInput, StockLot } from "./types";

const HOY = "2026-10-19"; // lunes

function lot(parcial: Partial<StockLot>): StockLot {
  return {
    id: `l-${Math.abs(JSON.stringify(parcial).length)}-${parcial.id ?? ""}`,
    ingredientId: "ing-pollo",
    label: "Pechuga de pollo",
    quantity: 1000,
    unit: "G",
    weightBasis: "RAW",
    isApproximate: false,
    expiryDate: null,
    useBy: null,
    createdAt: "2026-10-01T10:00:00Z",
    status: "AVAILABLE",
    acquisitionValue: null,
    ...parcial,
  };
}

function base(parcial: Partial<StockInput> = {}): StockInput {
  return {
    today: HOY,
    lots: [],
    futureDemand: [],
    consumption: [],
    shortfalls: [],
    waste: [],
    purchases: [],
    yields: [],
    targets: [],
    planningCoveredDates: [],
    ingredients: [{ id: "ing-pollo", label: "Pechuga de pollo", categoryCode: "POULTRY" }],
    ...parcial,
  };
}

/** Consumo diario constante de `qty` por `dias` días hacia atrás desde ayer. */
function consumoDiario(qty: number, dias: number, ingredientId = "ing-pollo") {
  // Días 0..dias-1 hacia atrás desde HOY inclusive: "últimos 7 días" = 7 días.
  const out = [];
  for (let i = 0; i < dias; i += 1) {
    const d = new Date(Date.UTC(2026, 9, 19));
    d.setUTCDate(d.getUTCDate() - i);
    out.push({
      ingredientId,
      quantity: qty,
      unit: "G" as const,
      weightBasis: "RAW" as const,
      cookingMethod: null,
      date: d.toISOString().slice(0, 10),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
describe("§3/§4 disponible = en casa − reservado por demanda confirmada", () => {
  it("el ejemplo del director: 4,5 kg en casa, 3,2 kg reservados, 1,3 kg libres", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ id: "a", quantity: 4500 })],
        futureDemand: [
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 1100, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-20", projectionId: "p1" },
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 2100, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-23", projectionId: "p2" },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.onHand).toBe(4500);
    expect(items[0]!.reserved).toBe(3200);
    expect(items[0]!.available).toBe(1300);
    expect(items[0]!.confirmedShortage).toBe(0);
  });

  it("§40 familia nueva: plan 3 kg, stock 1 kg → faltante confirmado 2 kg, SIN tasa inventada", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 1000 })],
        futureDemand: [
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 3000, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-21", projectionId: "p1" },
        ],
      }),
    );
    const item = items[0]!;
    expect(item.available).toBe(-2000);
    expect(item.confirmedShortage).toBe(2000);
    expect(item.rate.dailyRate).toBeNull(); // jamás "consumes 2,1 kg/semana"
    expect(item.coverage.kind).toBe("INSUFFICIENT_DATA");
    expect(item.reorder.status).toBe("REORDER_NOW");
    expect(item.reorder.recommendedQuantity).toBe(2000);
    expect(item.reorder.reasons.join(" ")).toMatch(/plan confirmado/i);
  });

  it("§44/§46 sin porción no hay reserva: la demanda viene de servings reales", () => {
    // Ricardo excluido / comiendo afuera = su porción NO existe en futureDemand.
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 1000 })],
        futureDemand: [
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 200, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-24", projectionId: "solo-4" },
        ],
      }),
    );
    expect(items[0]!.reserved).toBe(200); // solo lo que las porciones dicen
  });

  it("§45 sustitución: la merluza reserva merluza, no pollo", () => {
    const items = analyzeStock(
      base({
        ingredients: [
          { id: "ing-pollo", label: "Pollo", categoryCode: "POULTRY" },
          { id: "ing-merluza", label: "Merluza", categoryCode: "FISH" },
        ],
        lots: [lot({ quantity: 1000 }), lot({ id: "m", ingredientId: "ing-merluza", label: "Merluza", quantity: 800 })],
        futureDemand: [
          { ingredientId: "ing-merluza", label: "Merluza", quantity: 340, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-21", projectionId: "p1" },
        ],
      }),
    );
    const porId = new Map(items.map((i) => [i.ingredientId, i]));
    expect(porId.get("ing-pollo")!.reserved).toBe(0);
    expect(porId.get("ing-merluza")!.reserved).toBe(340);
  });
});

// ---------------------------------------------------------------------------
describe("§6/§50 bases físicas: convertible explícito o UNRESOLVED", () => {
  it("demanda COCIDA con rendimiento: se reserva el crudo equivalente", () => {
    const items = analyzeStock(
      base({
        ingredients: [{ id: "ing-arroz", label: "Arroz", categoryCode: "GRAINS" }],
        lots: [lot({ ingredientId: "ing-arroz", label: "Arroz", quantity: 500 })],
        yields: [{ ingredientId: "ing-arroz", cookingMethod: "BOILED", factor: 2.8, isHousehold: false }],
        futureDemand: [
          { ingredientId: "ing-arroz", label: "Arroz", quantity: 280, unit: "G", weightBasis: "COOKED", cookingMethod: "BOILED", servingDate: "2026-10-21", projectionId: "p1" },
        ],
      }),
    );
    expect(items[0]!.reserved).toBe(100); // 280 / 2,8
    expect(items[0]!.unresolvedDemand).toHaveLength(0);
  });

  it("demanda COCIDA sin rendimiento: UNRESOLVED con razón, jamás 1:1", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 500 })],
        futureDemand: [
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 300, unit: "G", weightBasis: "COOKED", cookingMethod: "BAKED", servingDate: "2026-10-21", projectionId: "p1" },
        ],
      }),
    );
    const item = items[0]!;
    expect(item.reserved).toBe(0); // NO se inventó una conversión
    expect(item.unresolvedDemand).toHaveLength(1);
    expect(item.coverage.kind).toBe("UNRESOLVED");
    expect(item.reorder.status).toBe("UNRESOLVED");
  });

  it("demanda y consumo DRAINED se emparejan con lotes DRAINED sin conversión (atún en lata)", () => {
    const items = analyzeStock(
      base({
        ingredients: [{ id: "ing-atun", label: "Atún en lata", categoryCode: "FISH" }],
        lots: [
          lot({ id: "atun", ingredientId: "ing-atun", label: "Atún escurrido", quantity: 400, weightBasis: "DRAINED" }),
        ],
        futureDemand: [
          { ingredientId: "ing-atun", label: "Atún", quantity: 120, unit: "G", weightBasis: "DRAINED", cookingMethod: null, servingDate: "2026-10-21", projectionId: "p1" },
        ],
        consumption: consumoDiario(80, 10, "ing-atun").map((c) => ({ ...c, weightBasis: "DRAINED" as const })),
      }),
    );
    // Misma base física = emparejamiento directo, igual que consume_planned_meal.
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.weightBasis).toBe("DRAINED");
    expect(item.onHand).toBe(400);
    expect(item.reserved).toBe(120);
    expect(item.unresolvedDemand).toHaveLength(0);
    expect(item.rate.dailyRate).toBe(80); // el consumo escurrido SÍ fabrica tasa
    expect(item.coverage.kind).toBe("DAYS");
    expect(item.reorder.status).not.toBe("UNRESOLVED");
  });

  it("un lote DRAINED no paga demanda cruda ni infla el bucket crudo", () => {
    const items = analyzeStock(
      base({
        ingredients: [{ id: "ing-atun", label: "Atún", categoryCode: "FISH" }],
        lots: [lot({ id: "d", ingredientId: "ing-atun", label: "Atún escurrido", quantity: 400, weightBasis: "DRAINED" })],
        futureDemand: [
          { ingredientId: "ing-atun", label: "Atún", quantity: 100, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-21", projectionId: "p1" },
        ],
      }),
    );
    const crudo = items.find((i) => i.weightBasis === "RAW")!;
    const escurrido = items.find((i) => i.weightBasis === "DRAINED")!;
    expect(crudo.onHand).toBe(0); // los 400 g escurridos no son crudo
    expect(crudo.confirmedShortage).toBe(100);
    expect(escurrido.onHand).toBe(400);
    expect(escurrido.reserved).toBe(0);
  });

  it("stock en UNIT con demanda en gramos: identidades separadas, sin peso inventado", () => {
    const items = analyzeStock(
      base({
        ingredients: [{ id: "ing-tomate", label: "Tomate", categoryCode: "VEGETABLES" }],
        lots: [lot({ ingredientId: "ing-tomate", label: "Tomates", quantity: 2, unit: "UNIT" })],
        futureDemand: [
          { ingredientId: "ing-tomate", label: "Tomate", quantity: 350, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-21", projectionId: "p1" },
        ],
      }),
    );
    // Dos identidades: las 2 unidades NO pagan los 350 g.
    const gramos = items.find((i) => i.unit === "G")!;
    const unidades = items.find((i) => i.unit === "UNIT")!;
    expect(gramos.onHand).toBe(0);
    expect(gramos.confirmedShortage).toBe(350);
    expect(unidades.onHand).toBe(2);
    expect(unidades.reserved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("§12-§14 consumo observado y ventanas", () => {
  it("30 días de historia: tasa del período completo y ventanas 7/14/30", () => {
    const rate = consumptionRate({
      today: HOY,
      ingredientId: "ing-pollo",
      unit: "G",
      bucketBasis: "RAW",
      consumption: consumoDiario(230, 30),
      shortfalls: [],
      yields: [],
    });
    expect(rate.historyDays).toBe(30);
    expect(rate.last7).toBe(230 * 7);
    expect(rate.last30).toBe(230 * 30);
    expect(rate.dailyRate).toBe(230);
    expect(rate.rateWindow).toBe(30);
    expect(rate.variability).toBe("LOW");
  });

  it("una sola observación: INSUFFICIENT_DATA, sin tasa", () => {
    const rate = consumptionRate({
      today: HOY,
      ingredientId: "ing-pollo",
      unit: "G",
      bucketBasis: "RAW",
      consumption: consumoDiario(500, 1),
      shortfalls: [],
      yields: [],
    });
    expect(rate.dailyRate).toBeNull();
    expect(rate.observations).toBe(1);
  });

  it("historia corta NO se diluye en la ventana larga (§13)", () => {
    // 6 días comiendo 200 g/día: la tasa sale de esos 6 días, no de 30.
    const rate = consumptionRate({
      today: HOY,
      ingredientId: "ing-pollo",
      unit: "G",
      bucketBasis: "RAW",
      consumption: consumoDiario(200, 6),
      shortfalls: [],
      yields: [],
    });
    expect(rate.rateWindow).toBe(7);
    expect(rate.dailyRate).toBe(200); // 1.200 / 6, no 1.200 / 30
  });

  it("§16 alta variabilidad se reconoce (1,1 / 3,4 / 0,8 / 3,0 kg semanales)", () => {
    const consumo = [];
    const semanas = [1100, 3400, 800, 3000];
    for (let s = 0; s < 4; s += 1) {
      const d = new Date(Date.UTC(2026, 9, 19));
      d.setUTCDate(d.getUTCDate() - (s * 7 + 3));
      consumo.push({
        ingredientId: "ing-pollo",
        quantity: semanas[s]!,
        unit: "G" as const,
        weightBasis: "RAW" as const,
        cookingMethod: null,
        date: d.toISOString().slice(0, 10),
      });
    }
    const rate = consumptionRate({
      today: HOY, ingredientId: "ing-pollo", unit: "G", bucketBasis: "RAW",
      consumption: consumo, shortfalls: [], yields: [],
    });
    expect(rate.variability).toBe("HIGH");
  });

  it("§42 el shortfall ES consumo: la tasa usa el declarado 1.155, no el trazado 1.120", () => {
    const consumo = consumoDiario(0, 0);
    // 5 días de historia, uno de ellos con 1.155 declarados (35 sin trazar).
    for (let i = 1; i <= 5; i += 1) {
      const d = new Date(Date.UTC(2026, 9, 19));
      d.setUTCDate(d.getUTCDate() - i);
      consumo.push({
        ingredientId: "ing-pollo",
        quantity: i === 1 ? 1155 : 200,
        unit: "G" as const,
        weightBasis: "RAW" as const,
        cookingMethod: null,
        date: d.toISOString().slice(0, 10),
      });
    }
    const rate = consumptionRate({
      today: HOY, ingredientId: "ing-pollo", unit: "G", bucketBasis: "RAW",
      consumption: consumo,
      shortfalls: [{ ingredientId: "ing-pollo", quantity: 35, unit: "G", weightBasis: "RAW", date: "2026-10-18" }],
      yields: [],
    });
    expect(rate.last7).toBe(1155 + 200 * 4); // el declarado completo
    expect(rate.untrackedTotal30).toBe(35);
    expect(rate.tracedTotal30).toBe(1155 + 800 - 35);
  });
});

// ---------------------------------------------------------------------------
describe("§2/§17 no doble conteo: confirmado GANA sobre forecast", () => {
  const conHistoria = () =>
    base({
      lots: [lot({ quantity: 10000 })],
      consumption: consumoDiario(271.4, 30), // ~1,9 kg/semana
      futureDemand: [
        { ingredientId: "ing-pollo", label: "Pollo", quantity: 3200, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-23", projectionId: "p1" },
      ],
      // Semana planificada de verdad: cada día con comida, uno a uno (S-1).
      planningCoveredDates: ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"],
    });

  it("el ejemplo del director: 3,2 confirmado + forecast SOLO días 8-14", () => {
    const items = analyzeStock(conHistoria());
    const h14 = items[0]!.horizons.find((h) => h.days === 14)!;
    expect(h14.confirmed).toBe(3200);
    // días 8-14 = 7 días sin cubrir × 271,4 ≈ 1.900
    expect(h14.forecastUncovered).toBeCloseTo(271.4 * 7, 0);
    expect(h14.total).toBeCloseTo(3200 + 271.4 * 7, 0);
  });

  it("dentro de la semana confirmada el forecast es CERO", () => {
    const items = analyzeStock(conHistoria());
    const h7 = items[0]!.horizons.find((h) => h.days === 7)!;
    expect(h7.forecastUncovered).toBe(0); // días 1-7 cubiertos por el plan
    expect(h7.confirmed).toBe(3200);
  });

  it("sin planificación que cubra, el forecast toma el horizonte completo", () => {
    const input = conHistoria();
    const items = analyzeStock({ ...input, planningCoveredDates: [], futureDemand: [] });
    const h7 = items[0]!.horizons.find((h) => h.days === 7)!;
    // El forecast parte MAÑANA (hoy ya se comió o está confirmado): 6 días.
    expect(h7.forecastUncovered).toBeCloseTo(271.4 * 6, 0);
  });
});

// ---------------------------------------------------------------------------
describe("§11 cobertura", () => {
  it("con historia y stock: días de cobertura", () => {
    const items = analyzeStock(
      base({ lots: [lot({ quantity: 1400 })], consumption: consumoDiario(200, 30) }),
    );
    expect(items[0]!.coverage).toEqual({ kind: "DAYS", days: 7 });
  });

  it("consumo esperado cero con historia: NO_EXPECTED_DEMAND, no ∞", () => {
    const items = analyzeStock(
      base({ lots: [lot({ quantity: 500 })], consumption: consumoDiario(0, 30) }),
    );
    // 30 días de ceros = sin observaciones (los días en 0 no son consumos):
    // eso es INSUFFICIENT_DATA, no infinito.
    expect(["INSUFFICIENT_DATA", "NO_EXPECTED_DEMAND"]).toContain(items[0]!.coverage.kind);
    expect(JSON.stringify(items[0]!.coverage)).not.toContain("Infinity");
  });
});

// ---------------------------------------------------------------------------
describe("§8/§19 políticas de objetivo", () => {
  it("mínimo declarado: bajo el mínimo → REORDER_NOW apuntando al objetivo", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 1500 })],
        targets: [{ ingredientId: "ing-pollo", unit: "G", minimumQuantity: 2000, targetQuantity: 5000, targetDaysOfSupply: null, safetyStock: null, reviewCycle: null, reorderEnabled: true, source: "USER_DEFINED" }],
      }),
    );
    const item = items[0]!;
    expect(item.reorder.status).toBe("REORDER_NOW");
    expect(item.reorder.recommendedQuantity).toBe(3500); // hasta el objetivo
    expect(item.reorder.reasons.join(" ")).toMatch(/mínimo/i);
  });

  it("días de cobertura: 14 días de pollo con consumo conocido", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 1400 })],
        consumption: consumoDiario(200, 30),
        targets: [{ ingredientId: "ing-pollo", unit: "G", minimumQuantity: null, targetQuantity: null, targetDaysOfSupply: 14, safetyStock: null, reviewCycle: null, reorderEnabled: true, source: "USER_DEFINED" }],
      }),
    );
    const item = items[0]!;
    // forecast desde mañana: 13 días × 200 = 2.600; libre 1.400 → 1.200
    expect(item.reorder.recommendedQuantity).toBe(1200);
    expect(item.reorder.horizonDays).toBe(14);
    // libre cubre 7 días = la mitad del horizonte → límite SOON/WATCH
    expect(["REORDER_SOON", "WATCH"]).toContain(item.reorder.status);
  });

  it("reorder_enabled = false: sin recomendación, con la razón dicha", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 100 })],
        consumption: consumoDiario(300, 30),
        targets: [{ ingredientId: "ing-pollo", unit: "G", minimumQuantity: null, targetQuantity: null, targetDaysOfSupply: null, safetyStock: null, reviewCycle: null, reorderEnabled: false, source: "USER_DEFINED" }],
      }),
    );
    expect(items[0]!.reorder.status).toBe("NO_ACTION");
    expect(items[0]!.reorder.recommendedQuantity).toBeNull();
    expect(items[0]!.reorder.reasons.join(" ")).toMatch(/pediste no recibir/i);
  });

  it("jamás cantidad negativa: stock de sobra → NO_ACTION", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 50000 })],
        consumption: consumoDiario(200, 30),
        targets: [{ ingredientId: "ing-pollo", unit: "G", minimumQuantity: null, targetQuantity: null, targetDaysOfSupply: 7, safetyStock: null, reviewCycle: null, reorderEnabled: true, source: "USER_DEFINED" }],
      }),
    );
    expect(items[0]!.reorder.status).toBe("NO_ACTION");
    expect(items[0]!.reorder.recommendedQuantity).toBeNull();
  });

  it("ciclo de revisión como horizonte: MONTHLY = 30 días", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 3000 })],
        consumption: consumoDiario(200, 30),
        targets: [{ ingredientId: "ing-pollo", unit: "G", minimumQuantity: null, targetQuantity: null, targetDaysOfSupply: null, safetyStock: null, reviewCycle: "MONTHLY", reorderEnabled: true, source: "USER_DEFINED" }],
      }),
    );
    expect(items[0]!.reorder.horizonDays).toBe(30);
    expect(items[0]!.reorder.recommendedQuantity).toBe(2800); // 29 días × 200 − 3.000
  });
});

// ---------------------------------------------------------------------------
describe("§21/§48/§49 lotes no usables y aproximados", () => {
  it("un lote vencido con fecha declarada NO cuenta, pero no se borra", () => {
    expect(lotUsable(lot({ expiryDate: "2026-10-15" }), HOY)).toBe(false);
    expect(lotUsable(lot({ expiryDate: "2026-10-25" }), HOY)).toBe(true);
    expect(lotUsable(lot({}), HOY)).toBe(true); // sin fecha no se inventa expiración
    const items = analyzeStock(
      base({
        lots: [lot({ id: "v", quantity: 800, expiryDate: "2026-10-10" }), lot({ id: "ok", quantity: 300 })],
      }),
    );
    expect(items[0]!.onHand).toBe(300);
  });

  it("stock aproximado baja la confianza y queda marcado", () => {
    const exacto = analyzeStock(
      base({ lots: [lot({ quantity: 1200 })], consumption: consumoDiario(200, 30) }),
    )[0]!;
    const aprox = analyzeStock(
      base({ lots: [lot({ quantity: 1200, isApproximate: true })], consumption: consumoDiario(200, 30) }),
    )[0]!;
    expect(aprox.hasApproximate).toBe(true);
    const niveles = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
    expect(niveles[aprox.confidence!]).toBeLessThan(niveles[exacto.confidence!]);
    expect(aprox.confidenceReasons.join(" ")).toMatch(/aproximado/i);
  });
});

// ---------------------------------------------------------------------------
describe("§22/§47 usar primero (FEFO), sin tocar el ledger", () => {
  it("el lote que vence antes es el use-first", () => {
    const items = analyzeStock(
      base({
        lots: [
          lot({ id: "b", quantity: 500, expiryDate: "2026-10-30" }),
          lot({ id: "a", quantity: 500, expiryDate: "2026-10-22" }),
        ],
      }),
    );
    expect(items[0]!.useFirstLotId).toBe("a");
    expect(items[0]!.onHand).toBe(1000); // el total no cambia
  });
});

// ---------------------------------------------------------------------------
describe("§25/§43 desperdicio como señal, jamás corrección automática", () => {
  it("compra > consumo con merma repetida → señal de sobrecompra", () => {
    const items = analyzeStock(
      base({
        ingredients: [{ id: "ing-manzana", label: "Manzana", categoryCode: "FRUITS" }],
        lots: [lot({ ingredientId: "ing-manzana", label: "Manzanas", quantity: 20, unit: "UNIT" })],
        consumption: [
          { ingredientId: "ing-manzana", quantity: 12, unit: "UNIT", weightBasis: "RAW", cookingMethod: null, date: "2026-10-10" },
        ],
        waste: [
          { ingredientId: "ing-manzana", quantity: 5, unit: "UNIT", weightBasis: "RAW", estimatedCost: null, date: "2026-10-12" },
        ],
        purchases: [
          { ingredientId: "ing-manzana", quantity: 20, unit: "UNIT", weightBasis: "RAW", date: "2026-10-05" },
        ],
        targets: [{ ingredientId: "ing-manzana", unit: "UNIT", minimumQuantity: null, targetQuantity: 20, targetDaysOfSupply: null, safetyStock: null, reviewCycle: "WEEKLY", reorderEnabled: true, source: "USER_DEFINED" }],
      }),
    );
    const item = items.find((i) => i.ingredientId === "ing-manzana")!;
    expect(item.overbuySignal).toBe(true);
    // El target manual NO se tocó.
    expect(item.target!.targetQuantity).toBe(20);
  });

  it("§26 costo de merma proporcional al valor del lote, solo si existe", () => {
    const items = analyzeStock(
      base({
        waste: [
          { ingredientId: "ing-pollo", quantity: 300, unit: "G", weightBasis: "RAW", estimatedCost: 1350, date: "2026-10-15" },
        ],
        lots: [lot({ quantity: 100 })],
      }),
    );
    expect(items[0]!.wasteCost30).toBe(1350);
    const sinValor = analyzeStock(
      base({
        waste: [{ ingredientId: "ing-pollo", quantity: 300, unit: "G", weightBasis: "RAW", estimatedCost: null, date: "2026-10-15" }],
        lots: [lot({ quantity: 100 })],
      }),
    );
    expect(sinValor[0]!.wasteCost30).toBeNull(); // no se inventa
  });
});

// ---------------------------------------------------------------------------
describe("§35 determinismo e idempotencia", () => {
  it("mismos inputs, misma salida, byte a byte", () => {
    const input = base({
      lots: [lot({ quantity: 4500 })],
      consumption: consumoDiario(230, 30),
      futureDemand: [
        { ingredientId: "ing-pollo", label: "Pollo", quantity: 1100, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-21", projectionId: "p1" },
      ],
      planningCoveredDates: ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"],
      targets: [{ ingredientId: "ing-pollo", unit: "G", minimumQuantity: null, targetQuantity: null, targetDaysOfSupply: 14, safetyStock: null, reviewCycle: null, reorderEnabled: true, source: "USER_DEFINED" }],
    });
    const a = analyzeStock(input);
    const b = analyzeStock(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("§36 toda recomendación declara sus versiones", () => {
    const items = analyzeStock(base({ lots: [lot({})] }));
    expect(items[0]!.reorder.engineVersion).toBe(REORDER_ENGINE_VERSION);
    expect(items[0]!.reorder.forecastVersion).toBe("demand-forecast/1.0.0");
  });
});

// ---------------------------------------------------------------------------
describe("conversión explícita a crudo", () => {
  it("RAW pasa directo; COOKED necesita factor; DRAINED no tiene conversión", () => {
    const yields = [{ ingredientId: "i", cookingMethod: "BOILED", factor: 2.5, isHousehold: false }];
    expect(toRawQuantity(100, "RAW", null, "i", yields)).toBe(100);
    expect(toRawQuantity(250, "COOKED", "BOILED", "i", yields)).toBe(100);
    expect(toRawQuantity(250, "COOKED", "FRIED", "i", yields)).toBeNull(); // sin genérico
    expect(toRawQuantity(100, "DRAINED", null, "i", yields)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("correcciones de la revisión adversarial (lote 2)", () => {
  it("un alimento comido UNA vez no fabrica una tasa diaria", () => {
    const rate = consumptionRate({
      today: HOY, ingredientId: "ing-pollo", unit: "G", bucketBasis: "RAW",
      consumption: consumoDiario(500, 2), // dos observaciones aisladas
      shortfalls: [], yields: [],
    });
    expect(rate.dailyRate).toBeNull(); // no "consumes 250 g/día"
    expect(rate.observations).toBe(2);
  });

  it("el atún ESCURRIDO no se suma al crudo: buckets separados por base física", () => {
    const items = analyzeStock(
      base({
        ingredients: [{ id: "ing-atun", label: "Atún", categoryCode: "FISH" }],
        lots: [
          lot({ id: "raw", ingredientId: "ing-atun", label: "Atún fresco", quantity: 300 }),
          lot({ id: "dr", ingredientId: "ing-atun", label: "Atún en lata", quantity: 120, weightBasis: "DRAINED" }),
        ],
      }),
    );
    const atun = items.filter((i) => i.ingredientId === "ing-atun");
    expect(atun).toHaveLength(2);
    const crudo = atun.find((i) => i.weightBasis === "RAW")!;
    const escurrido = atun.find((i) => i.weightBasis === "DRAINED")!;
    expect(crudo.onHand).toBe(300); // NO 420
    expect(escurrido.onHand).toBe(120);
  });

  it("demanda DRAINED contra stock DRAINED funciona de punta a punta (misma base)", () => {
    const items = analyzeStock(
      base({
        ingredients: [{ id: "ing-atun", label: "Atún", categoryCode: "FISH" }],
        lots: [lot({ ingredientId: "ing-atun", label: "Atún en lata", quantity: 240, weightBasis: "DRAINED" })],
        futureDemand: [
          { ingredientId: "ing-atun", label: "Atún", quantity: 120, unit: "G", weightBasis: "DRAINED", cookingMethod: null, servingDate: "2026-10-21", projectionId: "p1" },
        ],
      }),
    );
    const escurrido = items.find((i) => i.weightBasis === "DRAINED")!;
    expect(escurrido.reserved).toBe(120);
    expect(escurrido.available).toBe(120);
    expect(escurrido.unresolvedDemand).toHaveLength(0);
  });

  it("un objetivo declarado en UNIT no se aplica al bucket en gramos", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 100 })],
        targets: [{ ingredientId: "ing-pollo", unit: "UNIT", minimumQuantity: 5, targetQuantity: 10, targetDaysOfSupply: null, safetyStock: null, reviewCycle: null, reorderEnabled: true, source: "USER_DEFINED" }],
      }),
    );
    const item = items[0]!;
    expect(item.target).toBeNull(); // 5 unidades no se comparan con 100 g
    expect(item.reorder.status).not.toBe("REORDER_NOW");
  });

  it("el rendimiento del HOGAR le gana al global", () => {
    const yields = [
      { ingredientId: "i", cookingMethod: "BOILED", factor: 2.8, isHousehold: false },
      { ingredientId: "i", cookingMethod: "BOILED", factor: 2.5, isHousehold: true },
    ];
    expect(toRawQuantity(250, "COOKED", "BOILED", "i", yields)).toBe(100); // 250/2,5
  });

  it("una merma con fecha FUTURA no cuenta como historia", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 100 })],
        waste: [{ ingredientId: "ing-pollo", quantity: 500, unit: "G", weightBasis: "RAW", estimatedCost: null, date: "2026-10-25" }],
      }),
    );
    expect(items[0]!.waste30).toBe(0);
  });

  it("§26 costo de merma: o se calcula ENTERO o es null — nunca una suma parcial", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 100 })],
        waste: [
          { ingredientId: "ing-pollo", quantity: 300, unit: "G", weightBasis: "RAW", estimatedCost: 1350, date: "2026-10-15" },
          { ingredientId: "ing-pollo", quantity: 200, unit: "G", weightBasis: "RAW", estimatedCost: null, date: "2026-10-16" },
        ],
      }),
    );
    expect(items[0]!.waste30).toBe(500);
    expect(items[0]!.wasteCost30).toBeNull(); // la mitad costeada NO se presenta como el total
  });

  it("un shortfall COCIDO no se resta 1:1 de un total crudo", () => {
    const rate = consumptionRate({
      today: HOY, ingredientId: "ing-pollo", unit: "G", bucketBasis: "RAW",
      consumption: consumoDiario(200, 10),
      shortfalls: [{ ingredientId: "ing-pollo", quantity: 150, unit: "G", weightBasis: "COOKED", date: "2026-10-18" }],
      yields: [], // sin rendimiento: inconvertible
    });
    expect(rate.untrackedTotal30).toBe(0); // no se mezclaron bases
    expect(rate.unresolvedDeclared).toBe(150); // pero tampoco desapareció
  });
});

describe("Gate 0→9 [S-1] — la cobertura del plan cuenta dÍas, no un máximo", () => {
  it("una comida suelta el sábado NO apaga el forecast de lunes a viernes", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 10000 })],
        consumption: consumoDiario(271.4, 30),
        futureDemand: [
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 900, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-24", projectionId: "p1" },
        ],
        // SOLO el sábado está planificado. Antes (máximo global) esto
        // marcaba cubiertos los offsets 1..5 y el forecast quedaba en cero.
        planningCoveredDates: ["2026-10-24"],
      }),
    );
    const h7 = items[0]!.horizons.find((h) => h.days === 7)!;
    expect(h7.confirmed).toBe(900);
    // 6 días de forecast − 1 día planificado (el sábado) = 5 días.
    expect(h7.forecastUncovered).toBeCloseTo(271.4 * 5, 0);
  });

  it("la semana completa planificada sí apaga el forecast, como siempre", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 10000 })],
        consumption: consumoDiario(271.4, 30),
        futureDemand: [
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 3200, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-10-23", projectionId: "p1" },
        ],
        planningCoveredDates: ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"],
      }),
    );
    const h7 = items[0]!.horizons.find((h) => h.days === 7)!;
    expect(h7.forecastUncovered).toBe(0);
  });

  it("un día planificado FUERA del horizonte no cuenta dentro de él", () => {
    const items = analyzeStock(
      base({
        lots: [lot({ quantity: 10000 })],
        consumption: consumoDiario(100, 30),
        futureDemand: [
          { ingredientId: "ing-pollo", label: "Pollo", quantity: 500, unit: "G", weightBasis: "RAW", cookingMethod: null, servingDate: "2026-11-10", projectionId: "p1" },
        ],
        planningCoveredDates: ["2026-11-10"],
      }),
    );
    const h7 = items[0]!.horizons.find((h) => h.days === 7)!;
    // El 10-nov cae fuera de los 7 días: forecast completo (6 días).
    expect(h7.forecastUncovered).toBeCloseTo(100 * 6, 0);
    expect(h7.confirmed).toBe(0);
  });
});
