import { describe, expect, it } from "vitest";
import { estimateBbqQuantity, DEFAULT_BBQ_QUANTITY_POLICY } from "@/domain/events/bbq/quantity";
import type {
  BbqInventoryLotInput,
  BbqQuantityInput,
  WeightStage,
} from "@/domain/events/bbq/types";
import type { WeightBasis } from "@/domain/catalog/types";
import type { StockLot } from "@/domain/stock/types";
import { ETAPA_DE_BASE_FISICA, tramoDeObservacion } from "./bases";
import { repartirDisponible, tipoDeEquipo } from "./inventario";

/**
 * El defecto que estos tests impiden que vuelva: netear la despensa contra la
 * demanda del asado SIN mirar en qué base física está guardado cada lote.
 *
 * Un costillar congelado pesa CON hueso, la sobra de otro asado pesa cocida y
 * una lata escurrida no pesa ninguna de las dos cosas. Restarlos todos de
 * frentón contra el crudo comestible sobreestima la cobertura y hace comprar de
 * menos — que es el error caro, porque faltar carne el sábado a las dos de la
 * tarde no se arregla.
 *
 * NINGUNO DE ESTOS TESTS PASA SI SE REVIERTE EL ARREGLO: el de más abajo compra
 * cantidades DISTINTAS según la base del lote, y con la traducción rota (todo a
 * la misma etapa, o todo a UNKNOWN) las tres corridas darían el mismo número.
 */

describe("la traducción de base física a etapa del §12", () => {
  it("RAW es peso de compra y EDIBLE_PORTION es crudo comestible", () => {
    // No es una convención inventada acá: es lo que estas dos bases YA
    // significan en el ShoppingEngine, que divide EDIBLE_PORTION por el factor
    // de porción comestible para llegar al peso de compra y deja RAW tal cual.
    expect(ETAPA_DE_BASE_FISICA.RAW).toBe("RAW_PURCHASE");
    expect(ETAPA_DE_BASE_FISICA.EDIBLE_PORTION).toBe("EDIBLE_RAW");
    expect(ETAPA_DE_BASE_FISICA.COOKED).toBe("COOKED");
  });

  it("escurrido y como-se-vende NO se mapean: son UNKNOWN, no crudo", () => {
    expect(ETAPA_DE_BASE_FISICA.DRAINED).toBeNull();
    expect(ETAPA_DE_BASE_FISICA.AS_PACKAGED).toBeNull();
  });

  it("cubre todas las bases del catálogo, sin agujeros", () => {
    const todas: WeightBasis[] = ["RAW", "COOKED", "DRAINED", "EDIBLE_PORTION", "AS_PACKAGED"];
    for (const base of todas) {
      expect(Object.prototype.hasOwnProperty.call(ETAPA_DE_BASE_FISICA, base)).toBe(true);
    }
    // Y ninguna base se traduce a SERVABLE: ningún lote se guarda en peso de
    // plato servido, y permitirlo abriría la puerta a netear el sobrante
    // planificado contra la despensa.
    expect(Object.values(ETAPA_DE_BASE_FISICA)).not.toContain("SERVABLE");
  });
});

describe("el tramo de una observación del hogar", () => {
  it("acepta los tres tramos contiguos", () => {
    expect(tramoDeObservacion("RAW_PURCHASE", "EDIBLE_RAW")).toBe("RAW_PURCHASE_TO_EDIBLE_RAW");
    expect(tramoDeObservacion("EDIBLE_RAW", "COOKED")).toBe("EDIBLE_RAW_TO_COOKED");
    expect(tramoDeObservacion("COOKED", "SERVABLE")).toBe("COOKED_TO_SERVABLE");
  });

  it("rechaza el salto que mezcla hueso con cocción", () => {
    // "5.000 g de compra → 3.550 g cocidos" mezcla hueso, desgrase y cocción en
    // un solo número. Si entrara como factor de cocción, el motor le aplicaría
    // ADEMÁS el factor de hueso de la ficha y descontaría la merma dos veces.
    expect(tramoDeObservacion("RAW_PURCHASE", "COOKED")).toBeNull();
    expect(tramoDeObservacion("EDIBLE_RAW", "SERVABLE")).toBeNull();
  });

  it("sin etapa declarada no hay tramo (las filas anteriores a la 0041)", () => {
    expect(tramoDeObservacion(null, "COOKED")).toBeNull();
    expect(tramoDeObservacion("EDIBLE_RAW", null)).toBeNull();
    expect(tramoDeObservacion(null, null)).toBeNull();
  });

  it("no acepta el tramo al revés", () => {
    expect(tramoDeObservacion("COOKED", "EDIBLE_RAW")).toBeNull();
  });
});

describe("el reparto de lo disponible entre lotes", () => {
  const lote = (id: string, cantidad: number, vence: string | null): StockLot => ({
    id,
    ingredientId: "ing-1",
    label: "Sobrecostilla",
    quantity: cantidad,
    unit: "G",
    weightBasis: "RAW",
    isApproximate: false,
    expiryDate: vence,
    useBy: null,
    createdAt: "2026-09-01T00:00:00Z",
    status: "AVAILABLE",
    acquisitionValue: null,
  });

  it("le da al evento la COLA de la fila FEFO, no la cabeza", () => {
    // Hay 3 kg en mano pero sólo 1 kg disponible: los otros 2 están
    // comprometidos con las comidas de la semana, y el descuento físico es
    // FEFO. Lo que queda libre es el lote que vence más tarde.
    const reparto = repartirDisponible(
      [lote("viejo", 2000, "2026-09-10"), lote("nuevo", 1000, "2026-12-01")],
      1000,
    );
    expect(reparto).toHaveLength(1);
    expect(reparto[0]!.lote.id).toBe("nuevo");
    expect(reparto[0]!.gramos).toBe(1000);
  });

  it("cuando todo está disponible reparte todo, en orden FEFO", () => {
    const reparto = repartirDisponible(
      [lote("viejo", 2000, "2026-09-10"), lote("nuevo", 1000, "2026-12-01")],
      3000,
    );
    expect(reparto.map((r) => r.lote.id)).toEqual(["viejo", "nuevo"]);
    expect(reparto.reduce((a, r) => a + r.gramos, 0)).toBe(3000);
  });

  it("los lotes sin fecha de vencimiento van al final y desempatan estable", () => {
    const a = repartirDisponible([lote("b", 500, null), lote("a", 500, null)], 500);
    const b = repartirDisponible([lote("a", 500, null), lote("b", 500, null)], 500);
    expect(a.map((r) => r.lote.id)).toEqual(b.map((r) => r.lote.id));
  });

  it("no reparte nada cuando no hay disponible", () => {
    expect(repartirDisponible([lote("x", 900, null)], 0)).toEqual([]);
  });
});

describe("el tipo de equipo se reconoce o no se inventa", () => {
  it("reconoce los nombres en castellano y en inglés", () => {
    expect(tipoDeEquipo("PARRILLA")).toBe("GRILL");
    expect(tipoDeEquipo("grill de carbón")).toBe("GRILL");
    expect(tipoDeEquipo("plancha")).toBe("GRIDDLE");
    expect(tipoDeEquipo("air fryer")).toBe("AIR_FRYER");
    expect(tipoDeEquipo("horno")).toBe("OVEN");
  });

  it("lo que no reconoce NO se convierte en parrilla", () => {
    // Contar las tandas del asado en la capacidad de una máquina cualquiera da
    // un número que suena preciso y es inventado.
    expect(tipoDeEquipo("SHRED")).toBeNull();
    expect(tipoDeEquipo("licuadora")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* La prueba que importa: la misma despensa, tres bases, tres compras          */
/* -------------------------------------------------------------------------- */

function entradaBase(inventario: BbqInventoryLotInput[]): BbqQuantityInput {
  return {
    eventDate: "2026-09-12",
    participants: Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      kind: "GUEST" as const,
      ageGroup: "ADULT" as const,
      appetite: "NORMAL" as const,
      attendance: "CONFIRMED" as const,
      dietaryFlags: [],
      // Invitados: sin ficha en la casa que consultar.
      recordedBlocks: null,
      approxWeightKg: null,
    })),
    menu: [
      {
        id: "item-1",
        kind: "MEAT" as const,
        category: "VACUNO" as const,
        cutRef: "ing-sobrecostilla",
        displayName: "Sobrecostilla",
        distributionPct: null,
        cookingMethod: "GRILL",
        equipmentId: null,
      },
    ],
    sidesLevel: "MEDIUM",
    mealContext: "FIRST_MAJOR_MEAL",
    durationHours: 4,
    desiredLeftover: { kind: "NONE" },
    safetyBufferPct: 0,
    // Cadena completa: sin ella el motor no puede convertir ningún lote y el
    // test no probaría nada.
    cutDefinitions: [
      {
        cutRef: "ing-sobrecostilla",
        boneIn: true,
        rawPurchaseToEdibleRaw: 0.8,
        cookedToServable: 0.95,
        edibleRawToCooked: null,
        source: "test",
        confidence: "MEDIUM",
      },
    ],
    ingredientYields: [
      { cutRef: "ing-sobrecostilla", cookingMethod: "GRILL", factor: 0.7, source: "test" },
    ],
    observedYields: [],
    inventory: inventario,
    equipment: [],
    acceptedPlanRawEdibleG: null,
    policy: DEFAULT_BBQ_QUANTITY_POLICY,
  };
}

/** Un lote de 2 kg guardado en la base física que diga la base de datos. */
function loteEn(base: WeightBasis): BbqInventoryLotInput {
  const stage: WeightStage | null = ETAPA_DE_BASE_FISICA[base];
  return { lotId: "lote-1", cutRef: "ing-sobrecostilla", availableG: 2000, stage, frozen: false };
}

describe("dos kilos en la despensa NO cubren lo mismo según su base", () => {
  const compraDe = (base: WeightBasis) => {
    const r = estimateBbqQuantity(entradaBase([loteEn(base)]));
    const linea = r.byCut[0]!;
    return { linea, r };
  };

  it("2 kg cocidos cubren MUCHO más peso de compra que 2 kg con hueso", () => {
    const conHueso = compraDe("RAW");
    const cocido = compraDe("COOKED");
    expect(conHueso.linea.inventoryToUse.known).toBe(true);
    expect(cocido.linea.inventoryToUse.known).toBe(true);
    if (!conHueso.linea.inventoryToUse.known || !cocido.linea.inventoryToUse.known) return;

    // 2 kg cocidos equivalen a 2000 / 0,7 / 0,8 = 3.571 g de compra; 2 kg de
    // compra son 2 kg de compra. Si la traducción de bases se rompiera y los
    // dos se netearan 1:1, estas dos cifras serían idénticas.
    expect(conHueso.linea.inventoryToUse.grams).toBeCloseTo(2000, 3);
    expect(cocido.linea.inventoryToUse.grams).toBeGreaterThan(3500);

    if (!conHueso.linea.purchaseRequired.known || !cocido.linea.purchaseRequired.known) {
      throw new Error("las dos líneas tenían cadena completa: deberían saber cuánto comprar");
    }
    expect(cocido.linea.purchaseRequired.value.base).toBeLessThan(
      conHueso.linea.purchaseRequired.value.base,
    );
  });

  it("un lote escurrido no se netea 1:1: queda UNKNOWN y lo dice", () => {
    const escurrido = compraDe("DRAINED");
    expect(escurrido.linea.inventoryToUse.known).toBe(false);
    if (escurrido.linea.inventoryToUse.known) return;
    // Los 2 kg EXISTEN —se muestran a valor nominal— pero no se restaron.
    expect(escurrido.linea.inventoryToUse.faceValueGrams).toBe(2000);
    expect(escurrido.linea.flags).toContain("INVENTORY_YIELD_UNKNOWN");

    // Y la referencia queda en el extremo caro: comprar como si no cubriera
    // nada. Con el neteo 1:1 la compra sería 2 kg menor.
    const conHueso = compraDe("RAW");
    if (!escurrido.linea.purchaseRequired.known || !conHueso.linea.purchaseRequired.known) {
      throw new Error("ambas líneas deberían traer un rango de compra");
    }
    expect(escurrido.linea.purchaseRequired.value.base).toBeGreaterThan(
      conHueso.linea.purchaseRequired.value.base,
    );
  });
});
