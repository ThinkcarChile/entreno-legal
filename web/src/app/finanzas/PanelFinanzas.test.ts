import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelFinanzas } from "./PanelFinanzas";
import type { PanelFinanzas as DatosPanel } from "./queries";
import {
  forecast,
  type AccrualBucket,
  type AccrualCategory,
  type FinanceForecastInput,
} from "@/domain/finance/forecast-engine";
import { UMBRALES_POR_DEFECTO } from "@/domain/finance/confidence";
import { known, money, unknown } from "@/domain/finance/money";

/**
 * LA PANTALLA DE PLATA, RENDERIZADA DE VERDAD.
 *
 * El ataque encontró esto: la fila de una categoría se pintaba con
 * `−{formatMoney(b.known)}`, saltándose `<Monto>`. Cuando la categoría entera
 * estaba sin costear, `known` valía $0 y la pantalla mostraba «−$0» con un chip
 * «3 sin costear» al lado — un cero CONOCIDO donde la verdad era «no lo
 * sabemos», que es palabra por palabra la mentira que este sprint existe para
 * impedir.
 *
 * Estos casos miran el HTML, no el objeto: la única forma de demostrar que un
 * desconocido no termina como «$0» es leer lo que la persona lee.
 */

const CLP = (n: bigint) => money("CLP", n);

function cubeta(
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

function panelCon(over: Partial<FinanceForecastInput> = {}): DatosPanel {
  const entrada: FinanceForecastInput = {
    currency: "CLP",
    today: "2026-09-15",
    period: { type: "MONTH", startsOn: "2026-09-01", endsOn: "2026-09-30" },
    budgets: [],
    accruals: [],
    cashSpend: [],
    plannedLines: [],
    plannedConsumptionCost: unknown("NO_PRICE_RECORDED"),
    openingPantryValue: unknown("NOT_YET_RECOGNIZED"),
    closingPantryValue: known(CLP(45820n)),
    lateRecognitions: { count: 0, amount: known(CLP(0n)), occurredPeriods: [] },
    thresholds: UMBRALES_POR_DEFECTO,
    atRiskBps: 8500n,
    uncostedOutflows: 0,
    staleAfterDays: 90,
    ...over,
  };
  return {
    currency: "CLP",
    periodo: { startsOn: "2026-09-01", endsOn: "2026-09-30" },
    pronostico: forecast(entrada),
    faltantes: [],
    permisos: {
      FINANCE_VIEW: true,
      FINANCE_VIEW_MEMBER: false,
      FINANCE_UPLOAD_RECEIPTS: false,
      FINANCE_CONFIRM_RECEIPTS: false,
      FINANCE_MANAGE_PRICES: false,
      FINANCE_MANAGE_BUDGET: false,
    },
  };
}

const pintar = (panel: DatosPanel) =>
  renderToStaticMarkup(createElement(PanelFinanzas, { panel }));

describe("una categoría 100 % sin costear NO se pinta como −$0", () => {
  const html = pintar(panelCon({ accruals: [cubeta("WASTED_AVOIDABLE", 0n, 0, 3)] }));

  it("dice «Valor desconocido» y nombra la causa", () => {
    expect(html).toContain("Se botó (evitable)");
    expect(html).toContain("Valor desconocido");
    expect(html).toContain("este lote entró a la despensa sin boleta");
  });

  it("no aparece «−$0» en ninguna parte, ni «al menos $0» como consuelo", () => {
    expect(html).not.toContain("−$0");
    expect(html).not.toContain("al menos $0");
    // Sí puede haber «$0» en la caja: un mes SIN compras gastó cero de verdad,
    // y ese cero está MEDIDO. Lo que no puede es aparecer donde nadie midió.
    const consumo = html.slice(html.indexOf("Se consumió de verdad"));
    const hastaValorGuardado = consumo.slice(0, consumo.indexOf("El valor guardado"));
    expect(hastaValorGuardado).not.toContain("$0");
  });

  it("el conteo de lo que falta sigue al lado del monto", () => {
    expect(html).toContain("3 sin costear");
  });
});

describe("una categoría a medio costear se muestra como «al menos»", () => {
  const html = pintar(panelCon({ accruals: [cubeta("CONSUMED", 96480n, 19, 1)] }));

  it("usa la maquinaria del subtotal, no un total disfrazado", () => {
    expect(html).toContain("al menos −$96.480");
    expect(html).toContain("1 movimiento sin costear");
  });

  it("el titular del consumo también es un «al menos», no un total", () => {
    expect(html).toContain("Total consumido");
    // El total NO puede aparecer como si estuviera completo.
    expect(html).not.toMatch(/Total consumido<\/[^>]+><[^>]*>−\$96\.480/);
  });
});

describe("con todo costeado la pantalla sí muestra el número", () => {
  const html = pintar(panelCon({ accruals: [cubeta("CONSUMED", 96480n, 20, 0)] }));

  it("muestra el total con su signo y sin «al menos»", () => {
    expect(html).toContain("−$96.480");
    expect(html).not.toContain("al menos");
    expect(html).not.toContain("Valor desconocido: este lote");
  });
});

describe("los avisos del motor llegan a la persona", () => {
  it("las salidas sin costear se muestran, no se quedan dentro del objeto", () => {
    const html = pintar(panelCon({ uncostedOutflows: 3 }));
    expect(html).toContain("3 salidas de la despensa sin costear");
    expect(html).toContain("es un piso, no el total");
  });

  it("el reconocimiento tardío se explica con su mes de ocurrencia", () => {
    const html = pintar(
      panelCon({
        lateRecognitions: {
          count: 2,
          amount: known(CLP(3200n)),
          occurredPeriods: ["2026-08-01"],
        },
      }),
    );
    expect(html).toContain("2 movimientos de meses anteriores");
    expect(html).toContain("2026-08-01");
  });

  it("sin avisos no se pinta la sección: no se inventa alarma donde no hay", () => {
    const html = pintar(panelCon({ accruals: [cubeta("CONSUMED", 96480n, 20, 0)] }));
    expect(html).not.toContain("Antes de leer las cifras");
  });
});
