import { describe, expect, it } from "vitest";
import { expiryInfo, fefoOrder, stockByIngredient, stockKey, type PantryLot } from "./fefo";

function lot(parcial: Partial<PantryLot>): PantryLot {
  return {
    id: "l1",
    ingredientId: "ing-pollo",
    productId: null,
    label: "Pollo",
    quantity: 500,
    unit: "G",
    weightBasis: "RAW",
    processingState: "RAW",
    temperatureState: "CHILLED",
    locationId: null,
    expiryDate: null,
    useBy: null,
    status: "AVAILABLE",
    createdAt: "2026-09-01T10:00:00Z",
    ...parcial,
  };
}

describe("orden FEFO del baseline: use_by → expiry → antigüedad", () => {
  it("use_by manda sobre expiry", () => {
    const orden = fefoOrder([
      lot({ id: "a", expiryDate: "2026-09-10" }),
      lot({ id: "b", useBy: "2026-09-05", expiryDate: "2026-09-20" }),
    ]);
    expect(orden.map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("sin fechas, gana el más antiguo", () => {
    const orden = fefoOrder([
      lot({ id: "nuevo", createdAt: "2026-09-03T10:00:00Z" }),
      lot({ id: "viejo", createdAt: "2026-09-01T10:00:00Z" }),
    ]);
    expect(orden.map((l) => l.id)).toEqual(["viejo", "nuevo"]);
  });

  it("las fechas se comparan como texto, sin pasar por Date", () => {
    const orden = fefoOrder([
      lot({ id: "b", expiryDate: "2026-10-02" }),
      lot({ id: "a", expiryDate: "2026-09-30" }),
    ]);
    expect(orden.map((l) => l.id)).toEqual(["a", "b"]);
  });
});

describe("estado de vencimiento", () => {
  const HOY = "2026-09-05";

  it("vencido, para hoy, pronto y ok", () => {
    expect(expiryInfo(lot({ expiryDate: "2026-09-04" }), HOY).state).toBe("EXPIRED");
    expect(expiryInfo(lot({ expiryDate: "2026-09-05" }), HOY).state).toBe("USE_TODAY");
    expect(expiryInfo(lot({ expiryDate: "2026-09-07" }), HOY).state).toBe("SOON");
    expect(expiryInfo(lot({ expiryDate: "2026-09-20" }), HOY).state).toBe("OK");
  });

  it("sin fecha NO se inventa un estado: NO_DATE", () => {
    const info = expiryInfo(lot({}), HOY);
    expect(info.state).toBe("NO_DATE");
    expect(info.days).toBeNull();
  });

  it("use_by le gana a expiry y lo dice", () => {
    const info = expiryInfo(lot({ useBy: "2026-09-05", expiryDate: "2026-09-20" }), HOY);
    expect(info.state).toBe("USE_TODAY");
    expect(info.basis).toBe("USE_BY");
  });
});

describe("stock por alimento para el descuento en compra", () => {
  it("suma solo lotes disponibles de la MISMA representación", () => {
    const stock = stockByIngredient([
      lot({ id: "a", quantity: 300 }),
      lot({ id: "b", quantity: 200 }),
      lot({ id: "c", quantity: 400, weightBasis: "COOKED" }), // cocido: aparte
      lot({ id: "d", quantity: 100, status: "CONSUMED" }), // ya no está
      lot({ id: "e", quantity: 50, ingredientId: null }), // sin identidad
    ]);
    expect(stock.get(stockKey("ing-pollo", "G", "RAW"))).toEqual({ quantity: 500, lots: 2 });
    expect(stock.get(stockKey("ing-pollo", "G", "COOKED"))).toEqual({ quantity: 400, lots: 1 });
  });
});
