import { describe, expect, it } from "vitest";
import {
  CoverageBuilder,
  UMBRALES_POR_DEFECTO,
  classify,
  coverageVacia,
  dimensionOf,
  milliDe,
  mulDivHalfEven,
  peorCoberturaBps,
} from "./confidence";
import { money, mulDiv } from "./money";

/**
 * Cada test de acá está escrito para PONERSE ROJO si el arreglo se revierte.
 * Los dos defectos que persigue son [H18] (la confianza decidida por el último
 * bit de un `double`) y [H19] (mezclar gramos con mililitros en un mismo
 * denominador).
 */

describe("milliDe: de number a milésimas sin pasar por la coma flotante", () => {
  it("no multiplica: 1.005 * 1000 ya no es 1005 en IEEE-754", () => {
    // Ésta es la razón de que la conversión vaya por TEXTO. El producto pierde
    // exactitud solo, y quien lo escribe tiene que acordarse de envolverlo en un
    // `Math.round` — un redondeo que nadie declaró, en el camino de una
    // cantidad que después multiplica un monto.
    expect(1.005 * 1000).not.toBe(1005);
    expect(milliDe(1.005)).toBe(1005n);
    expect(milliDe(4.005)).toBe(4005n);
  });

  it("respeta los tres decimales del ledger y rechaza el cuarto", () => {
    expect(milliDe(1)).toBe(1000n);
    expect(milliDe(0.5)).toBe(500n);
    expect(milliDe(1234.567)).toBe(1234567n);
    expect(milliDe(-2.25)).toBe(-2250n);
    // Un cuarto decimal NO se trunca en silencio: no es comparable y se declara.
    expect(milliDe(0.0001)).toBeNull();
  });

  it("un número que no se puede leer no vale cero", () => {
    expect(milliDe(Number.NaN)).toBeNull();
    expect(milliDe(Number.POSITIVE_INFINITY)).toBeNull();
    // Notación exponencial: `1e-7` no tiene representación decimal legible acá.
    expect(milliDe(1e-7)).toBeNull();
  });
});

describe("mulDivHalfEven es el MISMO redondeo que el del dinero", () => {
  it("da exactamente lo mismo que mulDiv sobre los mismos números", () => {
    // Dos redondeos distintos en el mismo cálculo producirían un costo por kilo
    // que no cuadra con el costo total. Esta paridad es el contrato.
    const casos: Array<[bigint, bigint, bigint]> = [
      [1000n, 7n, 10n],
      [1n, 1n, 2n], // mitad exacta con cociente 0 (par) → 0
      [3n, 1n, 2n], // mitad exacta con cociente 1 (impar) → 2
      [12345n, 1n, 7n],
      [-800n, 7n, 10n],
      [999999n, 333n, 1000n],
    ];
    for (const [a, num, den] of casos) {
      expect(mulDivHalfEven(a, num, den)).toBe(mulDiv(money("CLP", a), num, den).minor);
    }
  });

  it("no divide por cero en silencio", () => {
    expect(() => mulDivHalfEven(10n, 1n, 0n)).toThrow();
  });
});

describe("classify: KNOWN es un CONTEO, no una fracción", () => {
  it("una lista sin nada que medir es INSUFFICIENT_DATA, no KNOWN", () => {
    expect(classify(coverageVacia(), UMBRALES_POR_DEFECTO)).toBe("INSUFFICIENT_DATA");
  });

  it("con todos los precios presentes es KNOWN aunque las fracciones no den 1 exacto", () => {
    // Tres tercios de una cantidad no representable en binario: en `double`
    // esto daba 0.9999999999999999 y el total se apagaba sin faltar un peso.
    const b = new CoverageBuilder();
    b.agregar("G", milliDe(0.1), true);
    b.agregar("G", milliDe(0.2), true);
    b.agregar("G", milliDe(0.3), true);
    const c = b.construir();
    expect(c.unknownItems).toBe(0);
    expect(classify(c, UMBRALES_POR_DEFECTO)).toBe("KNOWN");
  });

  it("con UN componente sin precio NO es KNOWN, por chico que sea", () => {
    // 1 g de sal sin precio contra 10 kg de carne con precio: la fracción da
    // 0,9999 y redondeaba a 1. El conteo no se deja engañar.
    const b = new CoverageBuilder();
    b.agregar("G", milliDe(10000), true);
    b.agregar("G", milliDe(1), false);
    const c = b.construir();
    expect(c.unknownItems).toBe(1);
    expect(classify(c, UMBRALES_POR_DEFECTO)).toBe("MOSTLY_KNOWN");
    expect(classify(c, UMBRALES_POR_DEFECTO)).not.toBe("KNOWN");
  });
});

describe("la cobertura se mide por dimensión y manda la PEOR", () => {
  it("los líquidos no tapan la falta de precio de la carne", () => {
    // 500 ml de aceite con precio + 500 g de carne SIN precio. Sumados en un
    // solo denominador daban 50 % de cobertura; por dimensión, la masa está en
    // 0 % y esa es la que manda.
    const b = new CoverageBuilder();
    b.agregar("ML", milliDe(500), true);
    b.agregar("G", milliDe(500), false);
    const c = b.construir();
    expect(peorCoberturaBps(c)).toBe(0n);
    expect(classify(c, UMBRALES_POR_DEFECTO)).toBe("INSUFFICIENT_DATA");
  });

  it("cada dimensión tiene su propio denominador y no se mezclan", () => {
    const b = new CoverageBuilder();
    b.agregar("ML", milliDe(1000), true);
    b.agregar("G", milliDe(900), true);
    b.agregar("G", milliDe(100), false);
    const c = b.construir();
    expect(c.byDimension.VOLUME.totalMilli).toBe(1000000n);
    expect(c.byDimension.MASS.totalMilli).toBe(1000000n);
    expect(peorCoberturaBps(c)).toBe(9000n);
    expect(classify(c, UMBRALES_POR_DEFECTO)).toBe("MOSTLY_KNOWN");
  });

  it("un ítem incomparable no entra a ningún denominador y tapa el verde", () => {
    // Una unidad sin peso declarado: si entrara al denominador se vería como
    // cobertura conocida. Acá se cuenta aparte y topa el veredicto en PARTIAL.
    const b = new CoverageBuilder();
    b.agregar("G", milliDe(1000), true);
    b.agregar("UNIT", null, false);
    const c = b.construir();
    expect(c.incomparableItems).toBe(1);
    expect(c.byDimension.COUNT.totalMilli).toBe(0n);
    expect(classify(c, UMBRALES_POR_DEFECTO)).toBe("PARTIAL");
  });

  it("si TODO es incomparable no se inventa un piso: INSUFFICIENT_DATA", () => {
    const b = new CoverageBuilder();
    b.agregar("UNIT", null, true);
    expect(classify(b.construir(), UMBRALES_POR_DEFECTO)).toBe("INSUFFICIENT_DATA");
  });
});

describe("los umbrales se comparan en enteros", () => {
  it("son puntos base bigint, jamás 0.90 en double", () => {
    expect(typeof UMBRALES_POR_DEFECTO.mostlyKnownBps).toBe("bigint");
    expect(UMBRALES_POR_DEFECTO.mostlyKnownBps).toBe(9000n);
    expect(UMBRALES_POR_DEFECTO.partialBps).toBe(5000n);
  });

  it("justo en el umbral cuenta como alcanzado", () => {
    const b = new CoverageBuilder();
    b.agregar("G", milliDe(900), true);
    b.agregar("G", milliDe(100), false);
    expect(peorCoberturaBps(b.construir())).toBe(9000n);
    expect(classify(b.construir(), UMBRALES_POR_DEFECTO)).toBe("MOSTLY_KNOWN");
  });
});

describe("las unidades no se convierten entre sí", () => {
  it("cada unidad tiene su dimensión y ninguna comparte", () => {
    expect(dimensionOf("G")).toBe("MASS");
    expect(dimensionOf("ML")).toBe("VOLUME");
    expect(dimensionOf("UNIT")).toBe("COUNT");
  });
});
