import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCRUAL_CATEGORIES,
  CONSUMO_ECONOMICO,
  FINANCE_FORECAST_ENGINE_VERSION,
  SALIDAS_DE_DESPENSA,
  forecast,
  type AccrualBucket,
  type AccrualCategory,
  type CashSpendEntry,
  type FinanceForecastInput,
  type HouseholdBudget,
} from "./forecast-engine";
import { UMBRALES_POR_DEFECTO } from "./confidence";
import { known, money, unknown } from "./money";

const CLP = (n: bigint) => money("CLP", n);

function cubeta(
  category: AccrualCategory,
  conocido: bigint,
  desconocidos = 0,
  cantidadKg = 1,
): AccrualBucket {
  return {
    category,
    known: CLP(conocido),
    knownCount: 1,
    unknownCount: desconocidos,
    unknownReasons: desconocidos > 0 ? ["LOT_VALUE_UNKNOWN"] : [],
    coverage: {
      kind: "POR_CANTIDAD",
      unit: "G",
      knownQuantityMilli: BigInt(cantidadKg) * 1000000n,
      totalQuantityMilli: BigInt(cantidadKg + desconocidos) * 1000000n,
    },
  };
}

/**
 * La cubeta tal como la arma el panel: `cost_allocations` no guarda la unidad
 * de su cantidad ni la parte por estado, así que la cobertura se mide por
 * CONTEO. Es el camino que el cargador usa de verdad.
 */
function cubetaContada(
  category: AccrualCategory,
  conocido: bigint,
  conocidas: number,
  desconocidas: number,
): AccrualBucket {
  return {
    category,
    known: CLP(conocido),
    knownCount: conocidas,
    unknownCount: desconocidas,
    unknownReasons: desconocidas > 0 ? ["LOT_VALUE_UNKNOWN"] : [],
    coverage: { kind: "POR_CONTEO" },
  };
}

function compra(
  id: string,
  total: bigint,
  capitalizado: bigint,
  noCapitalizado: bigint,
): CashSpendEntry {
  return {
    purchaseId: id,
    label: `Compra ${id}`,
    purchasedOn: "2026-09-03",
    total: known(CLP(total)),
    capitalized: known(CLP(capitalizado)),
    expensedOnly: known(CLP(noCapitalizado)),
  };
}

function entrada(over: Partial<FinanceForecastInput> = {}): FinanceForecastInput {
  return {
    currency: "CLP",
    today: "2026-09-15",
    period: { type: "MONTH", startsOn: "2026-09-01", endsOn: "2026-09-30" },
    budgets: [],
    accruals: [],
    cashSpend: [],
    plannedLines: [],
    plannedConsumptionCost: known(CLP(0n)),
    openingPantryValue: known(CLP(0n)),
    closingPantryValue: known(CLP(0n)),
    lateRecognitions: { count: 0, amount: known(CLP(0n)), occurredPeriods: [] },
    thresholds: UMBRALES_POR_DEFECTO,
    atRiskBps: 8500n,
    uncostedOutflows: 0,
    staleAfterDays: 90,
    ...over,
  };
}

describe("[H9] las categorías del período son un espejo EXACTO del enum de la base", () => {
  it("la unión de TypeScript cubre public.cost_category, valor por valor", () => {
    const sql = readFileSync(
      path.resolve(__dirname, "../../../../supabase/migrations/0044_cost_allocations.sql"),
      "utf8",
    );
    const bloque = /create type public\.cost_category as enum\s*\(([^)]*)\)/i.exec(sql);
    expect(bloque, "el enum cost_category tiene que existir en la 0044").not.toBeNull();
    const enBase = [...bloque![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    // Si alguien agrega una categoría en SQL sin ubicarla en el período, este
    // test cae — que es exactamente lo que tiene que pasar: una categoría
    // huérfana desaparece del panel y sobreestima el valor almacenado.
    expect([...ACCRUAL_CATEGORIES].sort()).toEqual([...enBase].sort());
  });

  it("cada categoría está clasificada: o sale de la despensa, o traslada, o es gasto que no queda", () => {
    for (const c of ACCRUAL_CATEGORIES) {
      const ubicada =
        SALIDAS_DE_DESPENSA.includes(c) ||
        CONSUMO_ECONOMICO.includes(c) ||
        c === "TRANSFER_IN" ||
        c === "TRANSFER_OUT";
      expect(ubicada, `${c} quedó sin ubicar en el período`).toBe(true);
    }
  });

  it("los traspasos NO son consumo: cocinar no es comer", () => {
    expect(CONSUMO_ECONOMICO).not.toContain("TRANSFER_OUT");
    expect(CONSUMO_ECONOMICO).not.toContain("TRANSFER_IN");
  });
});

describe("[H12] el valor guardado se calcula contra lo CAPITALIZADO, no contra la caja", () => {
  it("una compra con despacho y consumo cero deja guardado el valor capitalizado, no la boleta entera", () => {
    // $142.300 de boleta, de los cuales $9.500 fueron despacho. La versión
    // vieja (caja − consumo) habría dicho que se guardaron $142.300.
    const r = forecast(
      entrada({
        cashSpend: [compra("p1", 142300n, 132800n, 9500n)],
        closingPantryValue: known(CLP(132800n)),
      }),
    );
    expect(r.cash.total).toEqual(known(CLP(142300n)));
    expect(r.storedValueDelta).toEqual(known(CLP(132800n)));
    expect(r.storedValueDelta).not.toEqual(r.cash.total);
    expect(r.storedValue.reconciles).toBe(true);
  });

  it("el consumo se resta de lo capitalizado y el cuadre se verifica", () => {
    const r = forecast(
      entrada({
        cashSpend: [compra("p1", 100000n, 90000n, 10000n)],
        accruals: [cubeta("CONSUMED", 30000n), cubeta("WASTED_AVOIDABLE", 5000n)],
        openingPantryValue: known(CLP(20000n)),
        closingPantryValue: known(CLP(75000n)), // 20.000 + 90.000 − 35.000
      }),
    );
    expect(r.storedValueDelta).toEqual(known(CLP(55000n)));
    expect(r.storedValue.reconciles).toBe(true);
    expect(r.warnings.map((w) => w.code)).not.toContain("STORED_VALUE_DOES_NOT_RECONCILE");
  });

  it("[H7] si el saldo de cierre no cuadra, lo dice en vez de mostrar un número tranquilizador", () => {
    const r = forecast(
      entrada({
        cashSpend: [compra("p1", 100000n, 90000n, 10000n)],
        accruals: [cubeta("CONSUMED", 30000n)],
        openingPantryValue: known(CLP(0n)),
        closingPantryValue: known(CLP(50000n)), // debería ser 60.000
      }),
    );
    expect(r.storedValue.reconciles).toBe(false);
    const aviso = r.warnings.find((w) => w.code === "STORED_VALUE_DOES_NOT_RECONCILE");
    expect(aviso).toBeDefined();
  });

  it("el gasto que no queda en la despensa tiene su propia fila", () => {
    const r = forecast(entrada({ cashSpend: [compra("p1", 100000n, 90000n, 10000n)] }));
    expect(r.cash.expensedOnly).toEqual(known(CLP(10000n)));
    expect(r.cash.capitalized).toEqual(known(CLP(90000n)));
  });

  it("[H22] un despacho ilegible NO vale cero: contamina el capitalizado como desconocido", () => {
    const r = forecast(
      entrada({
        cashSpend: [
          {
            purchaseId: "p1",
            label: "Súper",
            purchasedOn: "2026-09-03",
            total: known(CLP(100000n)),
            capitalized: unknown("NO_PRICE_RECORDED"),
            expensedOnly: unknown("NO_PRICE_RECORDED"),
          },
        ],
      }),
    );
    expect(r.cash.expensedOnly.known).toBe(false);
    expect(r.storedValueDelta.known).toBe(false);
  });
});

describe("[H4] el consumo económico cuadra con su propio desglose", () => {
  it("total == suma de byCategory, siempre", () => {
    const r = forecast(
      entrada({
        accruals: [
          cubeta("CONSUMED", 96480n),
          cubeta("WASTED_AVOIDABLE", 5900n),
          cubeta("WASTED_EXPECTED", 2240n),
          cubeta("ADJUSTMENT_LOSS", 1000n),
          cubeta("NON_CAPITALIZED_EXPENSE", 9500n),
          // Los traspasos existen y NO entran: cocinar mueve valor, no lo gasta.
          cubeta("TRANSFER_OUT", 30000n),
          cubeta("TRANSFER_IN", 30000n),
        ],
      }),
    );
    let suma = 0n;
    for (const b of r.economicConsumption.byCategory) suma += b.known.minor;
    expect(r.economicConsumption.knownSubtotal.minor).toBe(suma);
    expect(r.economicConsumption.total).toEqual(known(CLP(115120n)));
    // Las salidas de despensa excluyen el gasto no capitalizado: el despacho
    // nunca estuvo adentro y no puede descontarse del inventario.
    expect(r.storedValue.pantryOutflow).toEqual(known(CLP(105620n)));
  });

  it("con una sola cubeta desconocida el total del consumo es DESCONOCIDO, no el pedazo", () => {
    const r = forecast(
      entrada({ accruals: [cubeta("CONSUMED", 96480n, 3), cubeta("WASTED_AVOIDABLE", 5900n)] }),
    );
    expect(r.economicConsumption.total.known).toBe(false);
    // Pero el subtotal conocido sigue disponible, declarado como subtotal.
    expect(r.economicConsumption.knownSubtotal.minor).toBe(102380n);
  });
});

describe("[H2] el presupuesto declara sobre qué mide, y hay un semáforo por lado", () => {
  const caja: HouseholdBudget = { basis: "CASH", amount: CLP(100000n), validFrom: "2026-09-01" };
  const consumo: HouseholdBudget = {
    basis: "ECONOMIC_CONSUMPTION",
    amount: CLP(100000n),
    validFrom: "2026-09-01",
  };

  it("los mismos datos dan estados DISTINTOS según la base, y eso se afirma", () => {
    // La compra grande del mes: $150.000 de caja, casi nada consumido todavía.
    const r = forecast(
      entrada({
        budgets: [caja, consumo],
        cashSpend: [compra("p1", 150000n, 150000n, 0n)],
        accruals: [cubeta("CONSUMED", 20000n)],
        closingPantryValue: known(CLP(130000n)),
      }),
    );
    const porBase = new Map(r.budgets.map((b) => [b.basis, b.state]));
    expect(porBase.get("CASH")).toBe("OVER");
    expect(porBase.get("ECONOMIC_CONSUMPTION")).toBe("ON_TRACK");
    // Y jamás uno promediado: son dos veredictos separados.
    expect(r.budgets).toHaveLength(2);
  });

  it("el copy nombra el lado, nunca dice «tu presupuesto» a secas", () => {
    const r = forecast(entrada({ budgets: [caja] }));
    const v = r.budgets.find((b) => b.basis === "CASH")!;
    expect(v.leyenda).toContain("presupuesto de caja");
  });

  it("sin fila vigente el estado es NO_BUDGET, jamás ON_TRACK", () => {
    const r = forecast(entrada({}));
    for (const v of r.budgets) expect(v.state).toBe("NO_BUDGET");
  });
});

describe("ON_TRACK es inalcanzable con cobertura mala", () => {
  it("con 3 de 5 productos sin precio el estado es UNKNOWN_COVERAGE, ni verde ni rojo", () => {
    const r = forecast(
      entrada({
        budgets: [{ basis: "CASH", amount: CLP(500000n), validFrom: "2026-09-01" }],
        cashSpend: [compra("p1", 10000n, 10000n, 0n)],
        plannedLines: [
          { lineKey: "l1", label: "Pollo", quantity: 1000, unit: "G", estimate: known(CLP(4500n)), estimateAgeDays: 3 },
          { lineKey: "l2", label: "Cilantro", quantity: 100, unit: "G", estimate: unknown("NO_PRICE_RECORDED"), estimateAgeDays: null },
          { lineKey: "l3", label: "Pan amasado", quantity: 500, unit: "G", estimate: unknown("NO_PRICE_RECORDED"), estimateAgeDays: null },
          { lineKey: "l4", label: "Zapallo", quantity: 800, unit: "G", estimate: unknown("NO_PRICE_RECORDED"), estimateAgeDays: null },
        ],
      }),
    );
    expect(r.confidence).toBe("INSUFFICIENT_DATA");
    const caja = r.budgets.find((b) => b.basis === "CASH")!;
    expect(caja.state).toBe("UNKNOWN_COVERAGE");
    expect(caja.state).not.toBe("ON_TRACK");
    // La holgura no se calcula sobre un «al menos».
    expect(caja.headroom.known).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain("UNKNOWN_COVERAGE");
  });

  it("OVER sí se declara aunque falten datos: lo conocido ya pasó el presupuesto", () => {
    const r = forecast(
      entrada({
        budgets: [{ basis: "CASH", amount: CLP(50000n), validFrom: "2026-09-01" }],
        cashSpend: [compra("p1", 90000n, 90000n, 0n)],
        plannedLines: [
          { lineKey: "l1", label: "Cilantro", quantity: 100, unit: "G", estimate: unknown("NO_PRICE_RECORDED"), estimateAgeDays: null },
        ],
        closingPantryValue: known(CLP(90000n)),
      }),
    );
    expect(r.budgets.find((b) => b.basis === "CASH")!.state).toBe("OVER");
  });
});

describe("[§7.4] la proyección de la compra nombra lo que falta", () => {
  it("entrega «al menos» con los faltantes por nombre, jamás un total inventado", () => {
    const r = forecast(
      entrada({
        plannedLines: [
          { lineKey: "l1", label: "Arroz", quantity: 1000, unit: "G", estimate: known(CLP(121900n)), estimateAgeDays: 10 },
          { lineKey: "l2", label: "Pollo entero", quantity: 1500, unit: "G", estimate: unknown("NO_PRICE_RECORDED"), estimateAgeDays: null },
          { lineKey: "l3", label: "Cilantro", quantity: 50, unit: "G", estimate: unknown("NO_PRICE_RECORDED"), estimateAgeDays: null },
        ],
      }),
    );
    expect(r.projectedPurchase.subtotal.minorAtLeast).toBe(121900n);
    expect(r.projectedPurchase.total.known).toBe(false);
    expect(r.projectedPurchase.missingPrices.map((m) => m.label)).toEqual([
      "Pollo entero",
      "Cilantro",
    ]);
  });

  it("un precio rancio NO entra al «al menos» y se declara aparte", () => {
    const r = forecast(
      entrada({
        plannedLines: [
          { lineKey: "l1", label: "Arroz", quantity: 1000, unit: "G", estimate: known(CLP(2000n)), estimateAgeDays: 112 },
          { lineKey: "l2", label: "Aceite", quantity: 1000, unit: "ML", estimate: known(CLP(3000n)), estimateAgeDays: 10 },
        ],
      }),
    );
    expect(r.projectedPurchase.subtotal.minorAtLeast).toBe(3000n);
    expect(r.projectedPurchase.stalePrices).toEqual([{ lineKey: "l1", ageDays: 112 }]);
    const aviso = r.warnings.find((w) => w.code === "STALE_PRICES");
    expect(aviso).toEqual({ code: "STALE_PRICES", count: 1, maxAgeDays: 112 });
  });
});

describe("lo que no se pudo costear se declara", () => {
  it("las salidas sin costear salen como aviso, no se omiten", () => {
    const r = forecast(entrada({ uncostedOutflows: 3 }));
    expect(r.warnings).toContainEqual({ code: "SHORTFALLS_NOT_COSTED", count: 3 });
  });

  it("los reconocimientos tardíos se avisan y viajan con su período de ocurrencia", () => {
    const r = forecast(
      entrada({
        lateRecognitions: { count: 2, amount: known(CLP(3200n)), occurredPeriods: ["2026-08"] },
      }),
    );
    expect(r.warnings).toContainEqual({ code: "LATE_RECOGNITION", count: 2 });
    expect(r.lateRecognitions.occurredPeriods).toEqual(["2026-08"]);
  });
});

describe("la cobertura del período NO se puede fabricar", () => {
  // La mutación que el atacante nombró: el cargador ponía
  // `knownQuantityMilli === totalQuantityMilli`, con lo que `faltante` daba
  // siempre 0, no se registraba ni un ítem desconocido y `classify()` devolvía
  // KNOWN aunque no hubiera UNA sola asignación costeada. Con `POR_CONTEO` el
  // tipo ya no deja escribir esa igualdad, y estos casos lo verifican.

  it("todas las asignaciones sin costear NO dan cobertura KNOWN ni semáforo verde", () => {
    const r = forecast(
      entrada({
        budgets: [{ basis: "ECONOMIC_CONSUMPTION", amount: CLP(100000n), validFrom: "2026-09-01" }],
        // $0 conocido porque no hay NI UNA asignación con costo: 3 sin costear.
        accruals: [cubetaContada("WASTED_AVOIDABLE", 0n, 0, 3)],
      }),
    );
    expect(r.confidence).not.toBe("KNOWN");
    expect(r.confidence).toBe("INSUFFICIENT_DATA");
    expect(r.coverage.unknownItems).toBe(3);
    expect(r.economicConsumption.total.known).toBe(false);
    const v = r.budgets.find((b) => b.basis === "ECONOMIC_CONSUMPTION")!;
    expect(v.state).toBe("UNKNOWN_COVERAGE");
    expect(v.state).not.toBe("ON_TRACK");
    expect(r.warnings.map((w) => w.code)).toContain("UNKNOWN_COVERAGE");
  });

  it("una sola asignación sin costear entre muchas tampoco deja el período KNOWN", () => {
    const r = forecast(entrada({ accruals: [cubetaContada("CONSUMED", 96480n, 19, 1)] }));
    expect(r.coverage.knownItems).toBe(19);
    expect(r.coverage.unknownItems).toBe(1);
    expect(r.confidence).not.toBe("KNOWN");
    expect(r.confidence).not.toBe("MOSTLY_KNOWN");
  });

  it("con TODO costeado sí se puede decir KNOWN: la guarda no es un apagón", () => {
    const r = forecast(entrada({ accruals: [cubetaContada("CONSUMED", 96480n, 20, 0)] }));
    expect(r.coverage.knownItems).toBe(20);
    expect(r.coverage.unknownItems).toBe(0);
    expect(r.coverage.incomparableItems).toBe(0);
    expect(r.confidence).toBe("KNOWN");
    expect(r.economicConsumption.total).toEqual(known(CLP(96480n)));
  });
});

describe("[H24] el umbral de riesgo se aplica en enteros", () => {
  it("8500 bps de $100.000 son $85.000 exactos", () => {
    const base = entrada({
      budgets: [{ basis: "CASH", amount: CLP(100000n), validFrom: "2026-09-01" }],
      closingPantryValue: known(CLP(85000n)),
    });
    const justoEnElUmbral = forecast({ ...base, cashSpend: [compra("p", 85000n, 85000n, 0n)] });
    expect(justoEnElUmbral.budgets.find((b) => b.basis === "CASH")!.state).toBe("AT_RISK");
    const bajoElUmbral = forecast({
      ...base,
      cashSpend: [compra("p", 84999n, 84999n, 0n)],
      closingPantryValue: known(CLP(84999n)),
    });
    expect(bajoElUmbral.budgets.find((b) => b.basis === "CASH")!.state).toBe("ON_TRACK");
  });
});

describe("el motor es puro y versionado", () => {
  it("mismos insumos, misma salida", () => {
    const e = entrada({ accruals: [cubeta("CONSUMED", 1234n)] });
    expect(forecast(e)).toEqual(forecast(e));
    expect(forecast(e).engineVersion).toBe(FINANCE_FORECAST_ENGINE_VERSION);
  });
});

describe("el motivo que se muestra no depende del orden de las filas", () => {
  /** Dos salidas sin costear, con motivos de precedencia distinta. */
  const sinBoleta: AccrualBucket = {
    category: "CONSUMED",
    known: CLP(0n),
    knownCount: 0,
    unknownCount: 1,
    unknownReasons: ["LOT_VALUE_UNKNOWN"],
    coverage: { kind: "POR_CONTEO" },
  };
  const sinPolitica: AccrualBucket = {
    category: "WASTED_AVOIDABLE",
    known: CLP(0n),
    knownCount: 0,
    unknownCount: 1,
    unknownReasons: ["POLICY_NOT_APPLICABLE"],
    coverage: { kind: "POR_CONTEO" },
  };

  function motivo(accruals: readonly AccrualBucket[]) {
    const total = forecast(entrada({ accruals: [...accruals] })).economicConsumption.total;
    if (total.known) throw new Error("estas cubetas están todas sin costear");
    return total.reason;
  }

  it("gana la precedencia declarada, no el primero que vino", () => {
    // La mutación que el atacante nombró: `const primero = motivos[0]` hacía
    // que estos dos órdenes dieran textos distintos para el MISMO mes.
    expect(motivo([sinBoleta, sinPolitica])).toBe("LOT_VALUE_UNKNOWN");
    expect(motivo([sinPolitica, sinBoleta])).toBe("LOT_VALUE_UNKNOWN");
  });

  it("con desconocidos y sin motivo declarado no se inventa una causa", () => {
    // «NO_PRICE_RECORDED» mandaría a la persona a registrar un precio que quizá
    // ya existe. No saber POR QUÉ no se sabe es su propia respuesta.
    const mudo: AccrualBucket = { ...sinBoleta, unknownReasons: [] };
    expect(motivo([mudo])).toBe("POLICY_NOT_APPLICABLE");
  });
});
