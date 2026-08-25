import { describe, expect, it } from "vitest";
import {
  PURCHASE_SCHEDULE_VERSION,
  addDays,
  chooseSupplierProduct,
  isoWeekday,
  planPurchases,
  scheduleDates,
  suggestQuantity,
} from "./engine";
import type {
  ExistingOrderItem,
  ProcurementNeed,
  PurchasePolicy,
  PurchaseScheduleInput,
  SupplierProduct,
} from "./types";
import type { ReorderRecommendation } from "@/domain/stock/types";

// Lunes. Todos los cálculos de fechas del sprint se anclan acá.
const HOY = "2026-08-24";

function rec(quantity: number | null, extra: Partial<ReorderRecommendation> = {}): ReorderRecommendation {
  return {
    status: quantity != null && quantity > 0 ? "REORDER_NOW" : "NO_ACTION",
    recommendedQuantity: quantity,
    unit: "G",
    horizonDays: 14,
    reasons: [],
    confidence: "MEDIUM",
    engineVersion: "reorder-engine/1.0.0",
    forecastVersion: "demand-forecast/1.0.0",
    ...extra,
  };
}

function need(partial: Partial<ProcurementNeed> = {}): ProcurementNeed {
  return {
    ingredientId: "ing-pollo",
    label: "Pollo",
    unit: "G",
    weightBasis: "RAW",
    onHand: 4000,
    available: 4000,
    coverageDays: 4,
    dailyRate: 1000,
    reorder: rec(4000),
    ...partial,
  };
}

function producto(partial: Partial<SupplierProduct> = {}): SupplierProduct {
  return {
    id: "sp-a",
    supplierId: "sup-a",
    supplierName: "Proveedor A",
    supplierActive: true,
    ingredientId: "ing-pollo",
    presentation: "bolsa 1 kg",
    packageQuantity: 1000,
    unit: "G",
    weightBasis: "RAW",
    price: null,
    minimumOrderQuantity: null,
    purchaseMultiple: null,
    leadTimeDays: 0,
    deliveryDays: null,
    priority: 100,
    isActive: true,
    ...partial,
  };
}

function entrada(partial: Partial<PurchaseScheduleInput> = {}): PurchaseScheduleInput {
  return {
    today: HOY,
    needs: [need()],
    supplierProducts: [producto()],
    policies: [],
    existingItems: [],
    pendingListItems: [],
    capacity: {},
    ...partial,
  };
}

describe("fechas (isoWeekday/addDays sin zona local)", () => {
  it("día ISO correcto y cruce de mes", () => {
    expect(isoWeekday("2026-08-24")).toBe(1); // lunes
    expect(isoWeekday("2026-08-28")).toBe(5); // viernes
    expect(isoWeekday("2026-08-30")).toBe(7); // domingo
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
  });
});

describe("§12 — el ejemplo del director, número por número", () => {
  it("pollo: MOQ 5 kg, lead 2 días, entrega viernes → pedir miércoles para recepción viernes, 5 kg", () => {
    const r = planPurchases(
      entrada({
        needs: [need({ onHand: 8000, available: 8000, reorder: rec(4000) })],
        supplierProducts: [
          producto({
            presentation: "caja 1 kg",
            minimumOrderQuantity: 5000,
            leadTimeDays: 2,
            deliveryDays: [5], // solo viernes
          }),
        ],
      }),
    );
    expect(r.suggestions).toHaveLength(1);
    const s = r.suggestions[0]!;
    expect(s.requiredQuantity).toBe(4000); // la necesidad se conserva (§17)
    expect(s.suggestedOrderQuantity).toBe(5000); // el MOQ solo mueve lo sugerido
    expect(s.supplierName).toBe("Proveedor A");
    expect(s.orderDate).toBe("2026-08-26"); // miércoles
    expect(s.expectedDeliveryDate).toBe("2026-08-28"); // viernes
    expect(s.provenance.map((p) => p.step)).toContain("pedido mínimo");
    expect(s.needsAction).toBe(false);
    expect(s.engineVersion).toBe(PURCHASE_SCHEDULE_VERSION);
  });
});

describe("proveedores (§18, §25)", () => {
  it("sin proveedor: la necesidad se informa igual, sin fechas, en 'necesita acción'", () => {
    const r = planPurchases(entrada({ supplierProducts: [] }));
    const s = r.suggestions[0]!;
    expect(s.supplierId).toBeNull();
    expect(s.orderDate).toBeNull();
    expect(s.requiredQuantity).toBe(4000);
    expect(s.suggestedOrderQuantity).toBe(4000);
    expect(s.needsAction).toBe(true);
    expect(s.warnings.join(" ")).toContain("sin proveedor");
  });

  it("dos proveedores: gana la mejor prioridad; la política de preferido la vence", () => {
    const productos = [
      producto({ id: "sp-a", supplierId: "sup-a", supplierName: "A", priority: 50 }),
      producto({ id: "sp-b", supplierId: "sup-b", supplierName: "B", priority: 10 }),
    ];
    const sinPolitica = chooseSupplierProduct(productos, need(), null);
    expect(sinPolitica.chosen?.supplierName).toBe("B");
    expect(sinPolitica.alternatives.map((a) => a.supplierName)).toEqual(["A"]);

    const politica: PurchasePolicy = {
      ingredientId: "ing-pollo",
      preferredSupplierId: "sup-a",
      orderDays: null,
      receiveDays: null,
    };
    expect(chooseSupplierProduct(productos, need(), politica).chosen?.supplierName).toBe("A");
  });

  it("proveedor inactivo o presentación inactiva no participan", () => {
    const r = chooseSupplierProduct(
      [producto({ supplierActive: false }), producto({ id: "sp-x", isActive: false })],
      need(),
      null,
    );
    expect(r.chosen).toBeNull();
  });

  it("presentación en OTRA unidad no se convierte a ciegas: avisa", () => {
    const r = planPurchases(
      entrada({ supplierProducts: [producto({ unit: "UNIT", packageQuantity: 1 })] }),
    );
    const s = r.suggestions[0]!;
    expect(s.supplierId).toBeNull();
    expect(s.warnings.join(" ")).toContain("otra unidad");
  });

  it("preferido sin presentación disponible → alternativa con aviso", () => {
    const politica: PurchasePolicy = {
      ingredientId: "ing-pollo",
      preferredSupplierId: "sup-z",
      orderDays: null,
      receiveDays: null,
    };
    const r = planPurchases(entrada({ policies: [politica] }));
    const s = r.suggestions[0]!;
    expect(s.supplierId).toBe("sup-a");
    expect(s.warnings.join(" ")).toContain("preferido");
  });
});

function esMultiploTest(q: number, m: number): boolean {
  const resto = q % m;
  return resto < 1e-6 || m - resto < 1e-6;
}

describe("cantidades (§17): required nunca se pierde, suggested se explica", () => {
  it("envase: 4.300 g en bolsas de 1 kg → 5 bolsas = 5.000 g", () => {
    const r = suggestQuantity(4300, producto(), null);
    expect(r.quantity).toBe(5000);
    expect(r.packageCount).toBe(5);
    expect(r.steps.map((s) => s.step)).toContain("envase");
  });

  it("múltiplo de compra: 5.000 con múltiplo 4.000 → 8.000 = 8 envases exactos", () => {
    const r = suggestQuantity(5000, producto({ purchaseMultiple: 4000 }), null);
    expect(r.quantity).toBe(8000);
    expect(r.packageCount).toBe(8); // invariante: sugerido = envases × tamaño
    expect(r.steps.map((s) => s.step)).toContain("múltiplo");
  });

  it("múltiplo raro pero conmensurable: se busca el punto donde AMBOS calzan", () => {
    // envases de 1.000 y múltiplos de 350 se encuentran en 7.000 (7 envases = 20×350)
    const r = suggestQuantity(500, producto({ purchaseMultiple: 350 }), null);
    expect(r.quantity).toBe(7000);
    expect(r.packageCount).toBe(7);
  });

  it("múltiplo que NO calza con envases enteros: se declara, jamás un par contradictorio", () => {
    // lcm(1.000, 9.999) queda fuera de todo rango razonable
    const r = suggestQuantity(500, producto({ purchaseMultiple: 9999 }), null);
    expect(r.packageCount).toBeNull();
    expect(esMultiploTest(r.quantity, 9999)).toBe(true); // lo que el proveedor acepta
    expect(r.warnings.join(" ")).toContain("no calza");
  });

  it("el recorte por capacidad respeta el múltiplo del proveedor", () => {
    // pide 5.000, caben 4.500: 4×1.000 = 4.000 SÍ es múltiplo de 2.000
    const r = suggestQuantity(5000, producto({ purchaseMultiple: 2000 }), 4500);
    expect(r.quantity).toBe(4000);
    expect(r.packageCount).toBe(4);
  });

  it("cantidad exacta no agrega pasos fantasma", () => {
    const r = suggestQuantity(3000, producto(), null);
    expect(r.quantity).toBe(3000);
    expect(r.steps).toHaveLength(0);
  });

  it("capacidad conocida recorta hacia abajo en envases enteros y avisa", () => {
    const r = suggestQuantity(5000, producto(), 3500);
    expect(r.quantity).toBe(3000);
    expect(r.packageCount).toBe(3);
    expect(r.warnings.join(" ")).toContain("capacidad");
  });

  it("capacidad desconocida = sin tope (jamás se inventa, §16)", () => {
    const r = suggestQuantity(50000, producto(), null);
    expect(r.quantity).toBe(50000);
    expect(r.warnings).toHaveLength(0);
  });

  it("si ni el mínimo cabe, avisa y NO recorta bajo el mínimo", () => {
    const r = suggestQuantity(2000, producto({ minimumOrderQuantity: 5000 }), 3000);
    expect(r.quantity).toBe(5000); // se mantiene el mínimo, con la advertencia
    expect(r.warnings.join(" ")).toContain("no cabe");
  });
});

describe("fechas de pedido y entrega (§12, §25)", () => {
  it("sin restricciones: entrega = hoy + lead time, pedido hoy", () => {
    const r = scheduleDates(HOY, producto({ leadTimeDays: 3 }), null);
    expect(r).toEqual({ orderDate: HOY, deliveryDate: addDays(HOY, 3) });
  });

  it("día de pedido restringido: el pedido se adelanta al último día permitido", () => {
    // Entrega solo viernes, lead 1 día → límite jueves; pero solo se pide lunes/martes.
    const politica: PurchasePolicy = {
      ingredientId: "ing-pollo",
      preferredSupplierId: null,
      orderDays: [1, 2],
      receiveDays: null,
    };
    const r = scheduleDates(HOY, producto({ leadTimeDays: 1, deliveryDays: [5] }), politica);
    expect(r).toEqual({ orderDate: "2026-08-25", deliveryDate: "2026-08-28" }); // martes → viernes
  });

  it("día de recepción del hogar también manda", () => {
    const politica: PurchasePolicy = {
      ingredientId: "ing-pollo",
      preferredSupplierId: null,
      orderDays: null,
      receiveDays: [6], // solo sábado
    };
    const r = scheduleDates(HOY, producto({ leadTimeDays: 0, deliveryDays: [5, 6] }), politica);
    expect(r).toEqual({ orderDate: "2026-08-29", deliveryDate: "2026-08-29" }); // sábado
  });

  it("pedir ANTES nunca atrasa: entrega lunes con pedido solo-miércoles se resuelve adelantando", () => {
    const politica: PurchasePolicy = {
      ingredientId: "ing-pollo",
      preferredSupplierId: null,
      orderDays: [3],
      receiveDays: null,
    };
    // Entrega solo lunes, lead 0: el lunes mismo no se puede pedir, pero el
    // miércoles ANTERIOR sí — el lead time es mínimo, no exacto.
    const r = scheduleDates(HOY, producto({ leadTimeDays: 0, deliveryDays: [1] }), politica);
    expect(r).toEqual({ orderDate: "2026-08-26", deliveryDate: "2026-08-31" });
  });

  it("lead time más largo que la ventana base no cae al error falso", () => {
    const r = scheduleDates(HOY, producto({ leadTimeDays: 40 }), null);
    expect(r).toEqual({ orderDate: HOY, deliveryDate: addDays(HOY, 40) });
  });

  it("la entrega que llega después del quiebre avisa", () => {
    const r = planPurchases(
      entrada({
        needs: [need({ coverageDays: 1, dailyRate: 2000 })],
        supplierProducts: [producto({ leadTimeDays: 6 })],
      }),
    );
    expect(r.suggestions[0]!.warnings.join(" ")).toContain("quiebre");
  });
});

describe("en camino (§14, §15): netea la necesidad, JAMÁS se suma al stock", () => {
  const enCamino = (qty: number, status: ExistingOrderItem["orderStatus"]): ExistingOrderItem => ({
    orderId: "po-1",
    orderStatus: status,
    ingredientId: "ing-pollo",
    quantity: qty,
    unit: "G",
    weightBasis: "RAW",
    orderDate: HOY,
    expectedDeliveryDate: addDays(HOY, 2),
  });

  it("orden viva parcial: la necesidad neta baja y queda explicada", () => {
    const r = planPurchases(entrada({ existingItems: [enCamino(1500, "ORDERED")] }));
    const s = r.suggestions[0]!;
    expect(s.requiredQuantity).toBe(2500); // 4000 − 1500
    expect(s.incoming).toBe(1500);
    expect(s.onHand).toBe(4000); // separados SIEMPRE: nunca un "5.500 en casa"
    expect(s.provenance.map((p) => p.step)).toContain("en camino");
  });

  it("orden viva que cubre todo: no se sugiere de nuevo, se informa", () => {
    const r = planPurchases(entrada({ existingItems: [enCamino(4000, "DELIVERING")] }));
    expect(r.suggestions).toHaveLength(0);
    expect(r.coveredByIncoming).toEqual([
      {
        ingredientId: "ing-pollo",
        label: "Pollo",
        unit: "G",
        weightBasis: "RAW",
        incoming: 4000,
        pendingInList: 0,
        warnings: [],
      },
    ]);
  });

  it("SUGGESTED no cuenta (nadie la aceptó) ni RECEIVED (ya es lote en casa)", () => {
    const r = planPurchases(
      entrada({ existingItems: [enCamino(4000, "SUGGESTED"), enCamino(4000, "RECEIVED")] }),
    );
    expect(r.suggestions[0]!.requiredQuantity).toBe(4000);
    expect(r.suggestions[0]!.incoming).toBe(0);
  });
});

describe("base física (RAW ≠ DRAINED): el balde equivocado no se llena ni se netea", () => {
  it("una orden RAW en camino NO netea la necesidad DRAINED del mismo alimento", () => {
    const r = planPurchases(
      entrada({
        needs: [
          need({ weightBasis: "DRAINED", reorder: rec(400) }),
          need({ reorder: rec(1000) }), // RAW
        ],
        supplierProducts: [producto(), producto({ id: "sp-d", weightBasis: "DRAINED" })],
        existingItems: [
          {
            orderId: "po-raw",
            orderStatus: "ORDERED",
            ingredientId: "ing-pollo",
            quantity: 1000,
            unit: "G",
            weightBasis: "RAW",
            orderDate: HOY,
            expectedDeliveryDate: addDays(HOY, 1),
          },
        ],
      }),
    );
    const drained = r.suggestions.find((s) => s.weightBasis === "DRAINED")!;
    expect(drained.requiredQuantity).toBe(400); // intacta: lo que viene es RAW
    expect(drained.incoming).toBe(0);
    expect(r.coveredByIncoming.find((c) => c.weightBasis === "RAW")).toBeTruthy(); // el RAW sí queda cubierto
  });

  it("presentación en otra BASE física no se elige ni se convierte: avisa", () => {
    const r = planPurchases(
      entrada({
        needs: [need({ weightBasis: "DRAINED", reorder: rec(400) })],
        supplierProducts: [producto()], // solo RAW
      }),
    );
    const s = r.suggestions[0]!;
    expect(s.supplierId).toBeNull();
    expect(s.warnings.join(" ")).toContain("otra base física");
  });
});

describe("la lista de compras semanal también netea (sin doble compra)", () => {
  it("línea pendiente parcial: la necesidad neta baja y queda explicada", () => {
    const r = planPurchases(
      entrada({
        pendingListItems: [{ ingredientId: "ing-pollo", quantity: 1500, unit: "G", weightBasis: "RAW" }],
      }),
    );
    const s = r.suggestions[0]!;
    expect(s.requiredQuantity).toBe(2500); // 4000 − 1500
    expect(s.pendingInList).toBe(1500);
    expect(s.provenance.map((p) => p.step)).toContain("lista de compras");
  });

  it("línea pendiente que cubre todo → informativo, no una segunda compra", () => {
    const r = planPurchases(
      entrada({
        pendingListItems: [{ ingredientId: "ing-pollo", quantity: 4000, unit: "G", weightBasis: "RAW" }],
      }),
    );
    expect(r.suggestions).toHaveLength(0);
    expect(r.coveredByIncoming[0]!.pendingInList).toBe(4000);
  });

  it("una línea DRAINED no netea la necesidad RAW", () => {
    const r = planPurchases(
      entrada({
        pendingListItems: [{ ingredientId: "ing-pollo", quantity: 4000, unit: "G", weightBasis: "DRAINED" }],
      }),
    );
    expect(r.suggestions[0]!.requiredQuantity).toBe(4000);
  });
});

describe("órdenes atrasadas: netean pero AVISAN (jamás cubrir con fantasmas en silencio)", () => {
  const item = (extra: Partial<ExistingOrderItem>): ExistingOrderItem => ({
    orderId: "po-x",
    orderStatus: "ORDERED",
    ingredientId: "ing-pollo",
    quantity: 1000,
    unit: "G",
    weightBasis: "RAW",
    orderDate: addDays(HOY, -3),
    expectedDeliveryDate: addDays(HOY, 1),
    ...extra,
  });

  it("entrega vencida → advertencia fuerte en la sugerencia", () => {
    const r = planPurchases(entrada({ existingItems: [item({ expectedDeliveryDate: addDays(HOY, -1) })] }));
    expect(r.suggestions[0]!.warnings.join(" ")).toContain("ATRASADA");
  });

  it("PLANNED con fecha de pedido pasada → advertencia de pedirla o cancelarla", () => {
    const r = planPurchases(
      entrada({ existingItems: [item({ orderStatus: "PLANNED", expectedDeliveryDate: null })] }),
    );
    expect(r.suggestions[0]!.warnings.join(" ")).toContain("PLANIFICADA");
  });

  it("la advertencia sobrevive aunque lo en camino cubra TODO (coveredByIncoming)", () => {
    const r = planPurchases(
      entrada({
        existingItems: [item({ quantity: 4000, expectedDeliveryDate: addDays(HOY, -1) })],
      }),
    );
    expect(r.suggestions).toHaveLength(0);
    expect(r.coveredByIncoming[0]!.warnings.join(" ")).toContain("ATRASADA");
  });
});

describe("bordes restantes de la matriz §25", () => {
  it("stock suficiente (NO_ACTION) → nada que sugerir", () => {
    const r = planPurchases(entrada({ needs: [need({ reorder: rec(null) })] }));
    expect(r.suggestions).toHaveLength(0);
  });

  it("confianza LOW → advertencia visible antes de aprobar", () => {
    const r = planPurchases(
      entrada({ needs: [need({ reorder: rec(4000, { confidence: "LOW" }) })] }),
    );
    expect(r.suggestions[0]!.warnings.join(" ")).toContain("BAJA");
  });

  it("cobertura después de recibir: (libre + en camino + sugerido) / tasa (entrega hoy)", () => {
    const r = planPurchases(entrada()); // libre 4000, sugerido 4000, tasa 1000, entrega hoy
    expect(r.suggestions[0]!.coverageAfterDays).toBe(8);
  });

  it("cobertura tras recibir descuenta el consumo entre hoy y la entrega", () => {
    const r = planPurchases(entrada({ supplierProducts: [producto({ leadTimeDays: 2 })] }));
    // 4000 libre + 4000 sugerido − 2 días × 1000 = 6000 → 6 días
    expect(r.suggestions[0]!.coverageAfterDays).toBe(6);
  });

  it("el faltante confirmado (libre negativo) RESTA de la cobertura, no se esconde", () => {
    const r = planPurchases(entrada({ needs: [need({ available: -500, onHand: 0 })] }));
    // −500 + 4000 = 3500 → 3.5 días
    expect(r.suggestions[0]!.coverageAfterDays).toBe(3.5);
  });

  it("sin tasa no se inventa cobertura", () => {
    const r = planPurchases(entrada({ needs: [need({ dailyRate: null, coverageDays: null })] }));
    expect(r.suggestions[0]!.coverageAfterDays).toBeNull();
  });

  it("determinismo: mismos insumos → mismo resultado byte a byte", () => {
    const a = planPurchases(entrada());
    const b = planPurchases(entrada());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
