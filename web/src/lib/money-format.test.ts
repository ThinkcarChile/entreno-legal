import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  describeMonto,
  describeUnknown,
  formatAtLeast,
  formatDelta,
  formatMoney,
} from "./money-format";
import { Monto, MontoAlMenos } from "@/components/Monto";
import { known, money, sumPartial, unknown } from "@/domain/finance/money";

/**
 * LA PRUEBA DE PANTALLA DEL DINERO.
 *
 * No comprueba estilos: comprueba que las cuatro situaciones de un monto se ven
 * DISTINTAS y que ninguna de las tres malas termina mostrando un número. Es el
 * test que el §7.3 pide explícitamente («si `loadBudgetPeriod` levanta
 * `DataAccessError`, la pantalla renderiza ERROR, no `$0` ni `NO_BUDGET`»).
 */

describe("el formato del monto", () => {
  it("CLP no lleva decimales: el peso es el átomo", () => {
    expect(formatMoney(money("CLP", 25000n))).toBe("$25.000");
    expect(formatMoney(money("CLP", 0n))).toBe("$0");
    expect(formatMoney(money("CLP", 1n))).toBe("$1");
    expect(formatMoney(money("CLP", 142300n))).toBe("$142.300");
    expect(formatMoney(money("CLP", 1234567n))).toBe("$1.234.567");
  });

  it("las monedas con centavos se escriben con la coma decimal chilena", () => {
    expect(formatMoney(money("USD", 1050n))).toBe("US$ 10,50");
    // Menos de un dólar: el relleno de ceros es exacto, sin dividir por 100.
    expect(formatMoney(money("USD", 7n))).toBe("US$ 0,07");
    expect(formatMoney(money("EUR", 100000n))).toBe("€ 1.000,00");
  });

  it("el negativo lleva el signo menos tipográfico, no un guion suelto", () => {
    expect(formatMoney(money("CLP", -4500n))).toBe("−$4.500");
  });

  it("una variación positiva lleva el + adelante: es un delta, no un saldo", () => {
    expect(formatDelta(money("CLP", 45820n))).toBe("+$45.820");
    expect(formatDelta(money("CLP", -820n))).toBe("−$820");
    expect(formatDelta(money("CLP", 0n))).toBe("$0");
  });
});

describe("las cuatro ramas de un monto", () => {
  it("conocido muestra el número y no necesita explicación", () => {
    const v = describeMonto({ estado: "DATO", valor: known(money("CLP", 8140n)) });
    expect(v).toEqual({ rama: "CONOCIDO", texto: "$8.140", detalle: null });
  });

  it("desconocido NO es $0 y dice por qué", () => {
    const v = describeMonto({ estado: "DATO", valor: unknown("LOT_VALUE_UNKNOWN") });
    expect(v.rama).toBe("DESCONOCIDO");
    expect(v.texto).toBe("Valor desconocido");
    expect(v.texto).not.toContain("0");
    expect(v.detalle).toBe("este lote entró a la despensa sin boleta");
  });

  it("error NO es $0 ni vacío", () => {
    const v = describeMonto({ estado: "ERROR", que: "el gasto del mes" });
    expect(v.rama).toBe("ERROR");
    expect(v.texto).toBe("No pudimos cargarlo");
    expect(v.detalle).toContain("el gasto del mes");
  });

  it("[H17] sin permiso NO es $0: la RLS devuelve cero filas y eso no es «no gastaste nada»", () => {
    const v = describeMonto({ estado: "SIN_PERMISO" });
    expect(v.rama).toBe("SIN_PERMISO");
    expect(v.texto).toBe("Sin permiso");
    expect(v.detalle).toContain("permiso");
  });

  it("cada motivo de desconocido tiene texto propio: ninguno cae en un genérico", () => {
    const textos = new Set(
      (
        [
          "NO_PRICE_RECORDED",
          "LOT_VALUE_UNKNOWN",
          "MIXED_UNKNOWN_MERGE",
          "CONSUMPTION_WITHOUT_LOT",
          "NOT_YET_RECOGNIZED",
          "UNIT_NOT_NORMALIZABLE",
          "POLICY_NOT_APPLICABLE",
        ] as const
      ).map(describeUnknown),
    );
    expect(textos.size).toBe(7);
  });
});

describe("<Monto>: la pantalla no puede mostrar $0 por error ni por falta de permiso", () => {
  const pintar = (estado: Parameters<typeof describeMonto>[0]) =>
    renderToStaticMarkup(createElement(Monto, { valor: estado }));

  it("un DataAccessError renderiza ERROR y no un cero", () => {
    const html = pintar({ estado: "ERROR", que: "el consumo del mes" });
    expect(html).toContain("No pudimos cargarlo");
    expect(html).not.toContain("$0");
    expect(html).not.toMatch(/>\$\d/);
  });

  it("un integrante sin FINANCE_VIEW ve «Sin permiso», jamás $0", () => {
    const html = pintar({ estado: "SIN_PERMISO" });
    expect(html).toContain("Sin permiso");
    expect(html).not.toContain("$0");
  });

  it("un valor desconocido se ve DISTINTO de un cero conocido", () => {
    const desconocido = pintar({ estado: "DATO", valor: unknown("NO_PRICE_RECORDED") });
    const gratis = pintar({ estado: "DATO", valor: known(money("CLP", 0n)) });
    expect(desconocido).not.toBe(gratis);
    expect(desconocido).toContain("Valor desconocido");
    // «Me lo regalaron» sí es un cero de verdad, y se ve como cero.
    expect(gratis).toContain("$0");
  });
});

describe("«al menos» viene pegado a sus faltantes", () => {
  const suma = sumPartial(
    [
      { id: "l1", label: "Arroz", value: known(money("CLP", 121900n)) },
      { id: "l2", label: "Pollo entero", value: unknown("NO_PRICE_RECORDED") },
      { id: "l3", label: "Cilantro", value: unknown("NO_PRICE_RECORDED") },
      { id: "l4", label: "Pan amasado", value: unknown("NO_PRICE_RECORDED") },
    ],
    "CLP",
  );

  it("nombra los productos que faltan: «3 sin precio» sin decir cuáles es inarreglable", () => {
    const v = formatAtLeast(suma.subtotal, suma.missing);
    expect(v.prefijo).toBe("al menos");
    expect(v.texto).toBe("$121.900");
    expect(v.detalle).toBe("3 productos sin precio: Pollo entero, Cilantro, Pan amasado");
  });

  it("el componente pinta «al menos» en la tipografía del número, no en una nota al pie", () => {
    const html = renderToStaticMarkup(
      createElement(MontoAlMenos, { subtotal: suma.subtotal, missing: suma.missing }),
    );
    expect(html).toContain("al menos $121.900");
    expect(html).toContain("Pollo entero");
  });

  it("mostrar el subtotal con una lista de faltantes de OTRA consulta revienta", () => {
    // Se vería perfecto y sería falso: «al menos $121.900, falta 1 producto»
    // cuando faltan tres. `atLeastAmount` cobra el peaje.
    expect(() => formatAtLeast(suma.subtotal, suma.missing.slice(0, 1))).toThrow();
  });
});
