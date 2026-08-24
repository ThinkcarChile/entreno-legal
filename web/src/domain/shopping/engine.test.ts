import { describe, expect, it } from "vitest";
import {
  ADDED_FAT_LINE,
  aggregateDemand,
  computeDeltas,
  demandSignature,
  formatQuantity,
  groupForCategory,
  type ConfirmedServing,
  type ShoppingInput,
} from "./engine";

/** Un serving mínimo con lo que el motor necesita. */
function serving(parcial: Partial<ConfirmedServing>): ConfirmedServing {
  return {
    assignmentId: "a-lunes",
    date: "2026-08-31",
    mealType: "LUNCH",
    memberId: "m1",
    memberName: "Casa",
    components: [],
    ...parcial,
  };
}

function pollo(quantity: number, extra: Partial<ConfirmedServing["components"][number]> = {}) {
  return {
    ingredientId: "ing-pollo",
    productId: null,
    label: "Pechuga de pollo",
    quantity,
    unit: "G" as const,
    weightBasis: "RAW" as const,
    cookingMethod: "AIR_FRYER",
    addedFatG: 0,
    ...extra,
  };
}

const SIN_EXTRAS = { yields: [], ingredients: [], products: [] };

// ---------------------------------------------------------------------------
describe("§40 caso base: la demanda es la suma exacta de los servings", () => {
  it("suma los componentes de todas las porciones confirmadas", () => {
    const lines = aggregateDemand({
      servings: [
        serving({ memberId: "m1", memberName: "Casa", components: [pollo(255)] }),
        serving({ memberId: "m2", memberName: "Paula", components: [pollo(180)] }),
        serving({ memberId: "m3", memberName: "Constanza", components: [pollo(180)] }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.requiredQuantity).toBe(615);
    expect(lines[0]!.unresolved).toBe(false);
  });

  it("NUNCA es receta × personas: cada porción aporta su cantidad real", () => {
    // Tres personas, receta base de 180: si el motor multiplicara, diría 540.
    const lines = aggregateDemand({
      servings: [
        serving({ memberId: "m1", components: [pollo(255)] }),
        serving({ memberId: "m2", memberName: "Paula", components: [pollo(120)] }),
        serving({ memberId: "m3", memberName: "Sebastián", components: [pollo(310)] }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines[0]!.requiredQuantity).toBe(685);
  });
});

// ---------------------------------------------------------------------------
describe("§3 identidad real del alimento (regresión B-2 del Sprint 4)", () => {
  it("la merluza de Sebastián no se suma al pollo de los demás", () => {
    const lines = aggregateDemand({
      servings: [
        serving({ memberId: "m1", components: [pollo(400)] }),
        serving({ memberId: "m2", memberName: "Paula", components: [pollo(395)] }),
        serving({
          memberId: "m3",
          memberName: "Sebastián",
          components: [
            pollo(360, { ingredientId: "ing-merluza", label: "Merluza" }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });

    const porId = new Map(lines.map((l) => [l.ingredientId, l]));
    expect(porId.get("ing-pollo")!.requiredQuantity).toBe(795);
    expect(porId.get("ing-merluza")!.requiredQuantity).toBe(360);
    expect(lines).toHaveLength(2);
  });

  it("dos slots distintos con el mismo ingrediente SÍ se consolidan", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(100, { label: "Tomate en ensalada", ingredientId: "ing-tomate" }),
            pollo(50, { label: "Tomate en salsa", ingredientId: "ing-tomate" }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.requiredQuantity).toBe(150);
  });
});

// ---------------------------------------------------------------------------
describe("§41 exclusión: quien no come no genera demanda", () => {
  it("cuatro porciones confirmadas = demanda de cuatro", () => {
    // Ricardo no está en los servings confirmados: el motor ni sabe que existe.
    const nombres = ["Casa", "Paula", "Constanza", "Sebastián"];
    const lines = aggregateDemand({
      servings: nombres.map((n, i) =>
        serving({ memberId: `m${i}`, memberName: n, components: [pollo(200)] }),
      ),
      ...SIN_EXTRAS,
    });
    expect(lines[0]!.requiredQuantity).toBe(800);
    expect(lines[0]!.provenance[0]!.members).toEqual(nombres.sort());
  });
});

// ---------------------------------------------------------------------------
describe("§43 sustitución: el pollo baja y la merluza aparece", () => {
  it("delta exacto al cambiar el alimento de una persona", () => {
    const antes = aggregateDemand({
      servings: [
        serving({ memberId: "m1", components: [pollo(400)] }),
        serving({ memberId: "m2", memberName: "Sebastián", components: [pollo(360)] }),
      ],
      ...SIN_EXTRAS,
    });
    const despues = aggregateDemand({
      servings: [
        serving({ memberId: "m1", components: [pollo(400)] }),
        serving({
          memberId: "m2",
          memberName: "Sebastián",
          components: [pollo(340, { ingredientId: "ing-merluza", label: "Merluza" })],
        }),
      ],
      ...SIN_EXTRAS,
    });

    const deltas = computeDeltas(antes, despues);
    const porLabel = new Map(deltas.map((d) => [d.label, d]));
    expect(porLabel.get("Pechuga de pollo")!.kind).toBe("QUANTITY_DECREASED");
    expect(porLabel.get("Pechuga de pollo")!.difference).toBe(-360);
    expect(porLabel.get("Merluza")!.kind).toBe("ADDED");
    // §27: conserva la masa de la serving final (340), no asume la misma (360).
    expect(porLabel.get("Merluza")!.after).toBe(340);
  });
});

// ---------------------------------------------------------------------------
describe("§44 unidades compatibles se consolidan con precisión interna", () => {
  it("500 g + 1.200 g = 1.700 g", () => {
    const lines = aggregateDemand({
      servings: [
        serving({ memberId: "m1", components: [pollo(500)] }),
        serving({ memberId: "m2", components: [pollo(1200)] }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines[0]!.requiredQuantity).toBe(1700);
    expect(formatQuantity(1700, "G")).toBe("1,7 kg");
  });

  it("750 ml + 1.000 ml se presentan como 1,75 L", () => {
    expect(formatQuantity(1750, "ML")).toBe("1,75 L");
  });
});

// ---------------------------------------------------------------------------
describe("§45/§9 unidades incompatibles JAMÁS se suman", () => {
  it("gramos y mililitros del mismo alimento son líneas separadas", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(300, { ingredientId: "ing-aceite", label: "Aceite de oliva", unit: "G" }),
            pollo(200, { ingredientId: "ing-aceite", label: "Aceite de oliva", unit: "ML" }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines).toHaveLength(2);
    const unidades = lines.map((l) => l.unit).sort();
    expect(unidades).toEqual(["G", "ML"]);
    expect(lines.find((l) => l.unit === "G")!.requiredQuantity).toBe(300);
    expect(lines.find((l) => l.unit === "ML")!.requiredQuantity).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("§4/§46 crudo vs cocido", () => {
  const arrozCocido = (qty: number) =>
    pollo(qty, {
      ingredientId: "ing-arroz",
      label: "Arroz blanco",
      weightBasis: "COOKED" as const,
      cookingMethod: "BOILED",
    });

  it("con rendimiento conocido convierte a cantidad de compra", () => {
    const lines = aggregateDemand({
      servings: [serving({ components: [arrozCocido(750)] })],
      yields: [{ ingredientId: "ing-arroz", cookingMethod: "BOILED", factor: 2.5 }],
      ingredients: [],
      products: [],
    });
    expect(lines[0]!.requiredQuantity).toBe(300); // 750 / 2,5
    expect(lines[0]!.cookedQuantity).toBe(750);
    expect(lines[0]!.yieldFactor).toBe(2.5);
    expect(lines[0]!.unresolved).toBe(false);
  });

  it("no mezcla la necesidad culinaria con la de compra (§5)", () => {
    const lines = aggregateDemand({
      servings: [serving({ components: [arrozCocido(750)] })],
      yields: [{ ingredientId: "ing-arroz", cookingMethod: "BOILED", factor: 2.5 }],
      ingredients: [],
      products: [],
    });
    // Dos números distintos, cada uno con su significado.
    expect(lines[0]!.cookedQuantity).not.toBe(lines[0]!.requiredQuantity);
  });

  it("usa el factor genérico si no hay uno del método exacto", () => {
    const lines = aggregateDemand({
      servings: [serving({ components: [arrozCocido(500)] })],
      yields: [{ ingredientId: "ing-arroz", cookingMethod: null, factor: 2.0 }],
      ingredients: [],
      products: [],
    });
    expect(lines[0]!.requiredQuantity).toBe(250);
  });

  it("sin rendimiento: UNRESOLVED con explicación, nunca inventa (§47)", () => {
    const lines = aggregateDemand({
      servings: [serving({ components: [arrozCocido(750)] })],
      ...SIN_EXTRAS,
    });
    expect(lines[0]!.unresolved).toBe(true);
    expect(lines[0]!.requiredQuantity).toBe(0); // no aportó nada resuelto
    expect(lines[0]!.cookedQuantity).toBe(750); // la necesidad culinaria sí se dice
    expect(lines[0]!.unresolvedReason).toMatch(/rendimiento/i);
    // La procedencia dice la cantidad CULINARIA, no un cero mentiroso.
    expect(lines[0]!.provenance[0]!.quantity).toBe(750);
  });

  it("mezcla de crudo resuelto y cocido sin factor: dice la parte resuelta Y que falta", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(200, { ingredientId: "ing-arroz", label: "Arroz blanco" }),
            arrozCocido(300),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.requiredQuantity).toBe(200);
    expect(lines[0]!.unresolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("porción comestible y escurrido", () => {
  it("EDIBLE_PORTION se convierte con el factor del catálogo", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(160, {
              ingredientId: "ing-palta",
              label: "Palta",
              weightBasis: "EDIBLE_PORTION" as const,
            }),
          ],
        }),
      ],
      yields: [],
      ingredients: [
        { id: "ing-palta", label: "Palta", categoryCode: "FRUITS", ediblePortionFactor: 0.8 },
      ],
      products: [],
    });
    expect(lines[0]!.requiredQuantity).toBe(200); // 160 / 0,8: se compra con cáscara
  });

  it("EDIBLE_PORTION sin factor conocido queda sin resolver", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(160, {
              ingredientId: "ing-palta",
              label: "Palta",
              weightBasis: "EDIBLE_PORTION" as const,
            }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines[0]!.unresolved).toBe(true);
  });

  it("DRAINED con producto NO sugiere envases: el envase declara contenido envasado, no escurrido", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(260, {
              ingredientId: null,
              productId: "prod-atun",
              label: "Atún en lata",
              weightBasis: "DRAINED" as const,
            }),
          ],
        }),
      ],
      yields: [],
      ingredients: [],
      products: [{ id: "prod-atun", label: "Atún en lata 160 g", packageQuantity: 160, packageUnit: "G" }],
    });
    expect(lines[0]!.purchaseBasis).toBe("DRAINED");
    expect(lines[0]!.packages).toBeNull(); // 260÷160 diría 2 latas y son más
    expect(lines[0]!.requiredQuantity).toBe(260);
  });

  it("DRAINED es su propia base y no se mezcla con crudo (§5)", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(100, { ingredientId: "ing-atun", label: "Atún" }),
            pollo(120, {
              ingredientId: "ing-atun",
              label: "Atún",
              weightBasis: "DRAINED" as const,
            }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });
    expect(lines).toHaveLength(2);
    const bases = lines.map((l) => l.purchaseBasis).sort();
    expect(bases).toEqual(["DRAINED", "RAW"]);
  });
});

// ---------------------------------------------------------------------------
describe("§11 productos comerciales", () => {
  it("propone envases enteros cuando el formato es conocido, sin perder los gramos", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(700, {
              ingredientId: null,
              productId: "prod-yogur",
              label: "Yogur natural",
              weightBasis: "AS_PACKAGED" as const,
            }),
          ],
        }),
      ],
      yields: [],
      ingredients: [],
      products: [
        { id: "prod-yogur", label: "Yogur natural 140 g", packageQuantity: 140, packageUnit: "G" },
      ],
    });
    expect(lines[0]!.purchaseBasis).toBe("COMMERCIAL_PACKAGE");
    expect(lines[0]!.packages).toEqual({ count: 5, packageQuantity: 140 });
    expect(lines[0]!.requiredQuantity).toBe(700); // los gramos no se pierden
  });
});

// ---------------------------------------------------------------------------
describe("§35 grasa añadida por preparación", () => {
  it("va en su propia línea en gramos, sin mezclarse con el aceite en ml de la receta", () => {
    const lines = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(4, { ingredientId: "ing-aceite", label: "Aceite de oliva", unit: "ML" }),
            pollo(400, { ingredientId: "ing-merluza", label: "Merluza", addedFatG: 8 }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });
    const grasa = lines.find((l) => l.key === ADDED_FAT_LINE.key);
    expect(grasa).toBeDefined();
    expect(grasa!.requiredQuantity).toBe(8);
    expect(grasa!.unit).toBe("G");
    const aceite = lines.find((l) => l.ingredientId === "ing-aceite");
    expect(aceite!.requiredQuantity).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe("§16/§17 procedencia: cada gramo sabe de dónde vino", () => {
  it("desglosa por comida con fecha, tipo y personas", () => {
    const lines = aggregateDemand({
      servings: [
        serving({ assignmentId: "a-lun", date: "2026-08-31", components: [pollo(940)] }),
        serving({
          assignmentId: "a-mie",
          date: "2026-09-02",
          mealType: "DINNER",
          memberId: "m2",
          memberName: "Paula",
          components: [pollo(795)],
        }),
        serving({ assignmentId: "a-vie", date: "2026-09-04", memberId: "m3", components: [pollo(1115)] }),
      ],
      ...SIN_EXTRAS,
    });
    const linea = lines[0]!;
    expect(linea.requiredQuantity).toBe(2850);
    expect(linea.provenance).toHaveLength(3);
    expect(linea.provenance.map((p) => p.quantity)).toEqual([940, 795, 1115]);
    // la suma de la procedencia ES el total: nada se duplica ni se pierde
    const suma = linea.provenance.reduce((acc, p) => acc + p.quantity, 0);
    expect(suma).toBe(linea.requiredQuantity);
  });
});

// ---------------------------------------------------------------------------
describe("§51 idempotencia por firma de entradas", () => {
  const base = (): ShoppingInput => ({
    servings: [
      serving({ memberId: "m1", components: [pollo(400)] }),
      serving({ memberId: "m2", memberName: "Paula", components: [pollo(300)] }),
    ],
    yields: [{ ingredientId: "ing-arroz", cookingMethod: "BOILED", factor: 2.5 }],
    ingredients: [],
    products: [],
  });

  it("mismas entradas producen la misma firma, sin importar el orden", () => {
    const a = base();
    const b = base();
    (b.servings as ConfirmedServing[]).reverse();
    expect(demandSignature(a)).toBe(demandSignature(b));
  });

  it("cambiar una cantidad cambia la firma", () => {
    const a = base();
    const b = base();
    (b.servings as ConfirmedServing[])[0]!.components[0]!.quantity = 401;
    expect(demandSignature(a)).not.toBe(demandSignature(b));
  });

  it("cambiar un rendimiento cambia la firma (la conversión es parte del cálculo)", () => {
    const a = base();
    const b = { ...base(), yields: [{ ingredientId: "ing-arroz", cookingMethod: "BOILED", factor: 2.8 }] };
    expect(demandSignature(a)).not.toBe(demandSignature(b));
  });

  it("curar la porción comestible en el catálogo cambia la firma", () => {
    const a = { ...base(), ingredients: [{ id: "ing-palta", label: "Palta", categoryCode: "FRUITS", ediblePortionFactor: null }] };
    const b = { ...base(), ingredients: [{ id: "ing-palta", label: "Palta", categoryCode: "FRUITS", ediblePortionFactor: 0.8 }] };
    // Sin esto, una línea UNRESOLVED por falta de factor jamás se resolvería:
    // la firma no cambiaría y "Actualizar lista" nunca aparecería.
    expect(demandSignature(a)).not.toBe(demandSignature(b));
  });

  it("cambiar el formato de un envase cambia la firma", () => {
    const a = { ...base(), products: [{ id: "prod-yogur", label: "Yogur", packageQuantity: 140, packageUnit: "G" as const }] };
    const b = { ...base(), products: [{ id: "prod-yogur", label: "Yogur", packageQuantity: 170, packageUnit: "G" as const }] };
    expect(demandSignature(a)).not.toBe(demandSignature(b));
  });
});

// ---------------------------------------------------------------------------
describe("§25/§26 deltas", () => {
  it("clasifica agregado, quitado, subió, bajó y sin cambio", () => {
    const antes = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(2800),
            pollo(500, { ingredientId: "ing-arroz", label: "Arroz blanco" }),
            pollo(300, { ingredientId: "ing-cerdo", label: "Cerdo" }),
            pollo(120, { ingredientId: "ing-tomate", label: "Tomate" }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });
    const despues = aggregateDemand({
      servings: [
        serving({
          components: [
            pollo(2886),
            pollo(380, { ingredientId: "ing-arroz", label: "Arroz blanco" }),
            pollo(360, { ingredientId: "ing-merluza", label: "Merluza" }),
            pollo(120, { ingredientId: "ing-tomate", label: "Tomate" }),
          ],
        }),
      ],
      ...SIN_EXTRAS,
    });

    const deltas = computeDeltas(antes, despues);
    const por = new Map(deltas.map((d) => [d.label, d]));
    expect(por.get("Pechuga de pollo")!.kind).toBe("QUANTITY_INCREASED");
    expect(por.get("Pechuga de pollo")!.difference).toBe(86);
    expect(por.get("Arroz blanco")!.kind).toBe("QUANTITY_DECREASED");
    expect(por.get("Arroz blanco")!.difference).toBe(-120);
    expect(por.get("Merluza")!.kind).toBe("ADDED");
    expect(por.get("Cerdo")!.kind).toBe("REMOVED");
    expect(por.get("Cerdo")!.difference).toBe(-300);
    expect(por.get("Tomate")!.kind).toBe("UNCHANGED");
  });

  it("§26: excluir a una persona hace desaparecer su cantidad, con delta visible", () => {
    const conRicardo = aggregateDemand({
      servings: [
        serving({ memberId: "m1", components: [pollo(400)] }),
        serving({ memberId: "m-ricardo", memberName: "Ricardo", components: [pollo(350)] }),
      ],
      ...SIN_EXTRAS,
    });
    const sinRicardo = aggregateDemand({
      servings: [serving({ memberId: "m1", components: [pollo(400)] })],
      ...SIN_EXTRAS,
    });
    const deltas = computeDeltas(conRicardo, sinRicardo);
    expect(deltas[0]!.kind).toBe("QUANTITY_DECREASED");
    expect(deltas[0]!.difference).toBe(-350);
  });
});

// ---------------------------------------------------------------------------
describe("§18 grupos de la lista desde el catálogo", () => {
  it("mapea las categorías del catálogo a los grupos de compra", () => {
    expect(groupForCategory("FRUITS")).toBe("FRESH");
    expect(groupForCategory("VEGETABLES")).toBe("FRESH");
    expect(groupForCategory("POULTRY")).toBe("MEAT");
    expect(groupForCategory("FISH")).toBe("FISH");
    expect(groupForCategory("EGGS")).toBe("DAIRY");
    expect(groupForCategory("GRAINS")).toBe("PANTRY");
    expect(groupForCategory(null)).toBe("OTHER");
    expect(groupForCategory("ALGO_NUEVO")).toBe("OTHER");
  });
});

// ---------------------------------------------------------------------------
describe("presentación de cantidades (§8, §10)", () => {
  it("gramos chicos quedan exactos, no absurdos redondeados a cero", () => {
    expect(formatQuantity(3.4, "G")).toBe("3,4 g");
  });
  it("unidades en singular y plural", () => {
    expect(formatQuantity(1, "UNIT")).toBe("1 unidad");
    expect(formatQuantity(5, "UNIT")).toBe("5 unidades");
  });
});
