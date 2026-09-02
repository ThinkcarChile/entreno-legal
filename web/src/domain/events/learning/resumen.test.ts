import { describe, expect, it } from "vitest";
import { resumirEvento, type LineaBalanceInput } from "./resumen";

function linea(over: Partial<LineaBalanceInput> = {}): LineaBalanceInput {
  return {
    ref: "l1",
    label: "Lomo vetado",
    unit: "G",
    servedG: 3550,
    deductedG: 3550,
    rawInputG: 5000,
    edibleLeftoverG: 350,
    plateWasteG: null,
    trimWasteG: null,
    boneDiscardG: null,
    spoiledG: null,
    ...over,
  };
}

const sinAsistencia = { confirmadosSinMarcar: 12, asistieron: 0, noLlegaron: 0, extras: 0 };

describe("el resumen no inventa lo que nadie anotó", () => {
  it("cero marcas de asistencia NO es cero asistentes", () => {
    const r = resumirEvento({
      asistencia: sinAsistencia,
      lineas: [linea()],
      compradoG: null,
      sobraEnLotesG: null,
    });
    expect(r.asistencia.cobertura).toBe("NINGUNA");
    if (r.asistencia.cobertura !== "NINGUNA") return;
    expect(r.asistencia.esperados).toBe(12);
    // No hay ningún campo que pueda leerse como "asistieron 0".
    expect(JSON.stringify(r.asistencia)).not.toContain("asistieron");
  });

  it("una sola marca de doce es una lista A MEDIAS, no una lista", () => {
    // Antes esto salía como registro cerrado: "0 asistieron, 1 no llegó, de 12
    // confirmadas". Las once personas que nadie miró quedaban contadas como
    // ausentes sin que nadie lo hubiera observado.
    const r = resumirEvento({
      asistencia: { confirmadosSinMarcar: 11, asistieron: 0, noLlegaron: 1, extras: 0 },
      lineas: [linea()],
      compradoG: null,
      sobraEnLotesG: null,
    });
    expect(r.asistencia.cobertura).toBe("PARCIAL");
    if (r.asistencia.cobertura !== "PARCIAL") return;
    expect(r.asistencia.asistieron).toBe(0);
    expect(r.asistencia.noLlegaron).toBe(1);
    expect(r.asistencia.sinMarcar).toBe(11);
    expect(r.asistencia.esperados).toBe(12);
  });

  it("con todos los esperados marcados el conteo sí cierra", () => {
    const r = resumirEvento({
      asistencia: { confirmadosSinMarcar: 0, asistieron: 9, noLlegaron: 3, extras: 2 },
      lineas: [linea()],
      compradoG: null,
      sobraEnLotesG: null,
    });
    expect(r.asistencia.cobertura).toBe("COMPLETA");
    if (r.asistencia.cobertura !== "COMPLETA") return;
    expect(r.asistencia.asistieron).toBe(9);
    expect(r.asistencia.esperados).toBe(12);
    // Los que llegaron sin estar en la lista NO se suman a los confirmados que
    // llegaron: son otro hecho y van en su propio campo.
    expect(r.asistencia.extras).toBe(2);
  });

  it("sin ningún destino declarado no se puede decir cuánto se comió", () => {
    const r = resumirEvento({
      asistencia: sinAsistencia,
      lineas: [linea({ edibleLeftoverG: null, plateWasteG: null, spoiledG: null })],
      compradoG: null,
      sobraEnLotesG: null,
    });
    expect(r.lineas[0]!.consumedG).toBeNull();
    expect(r.lineas[0]!.cierra).toBe(false);
    expect(r.lineasSinCerrar).toEqual(["Lomo vetado"]);
    expect(r.totales.consumidoG).toBeNull();
  });

  it("con la sobra declarada, lo consumido es la resta y el balance cierra", () => {
    const r = resumirEvento({
      asistencia: sinAsistencia,
      lineas: [linea({ servedG: 3550, edibleLeftoverG: 350 })],
      compradoG: null,
      sobraEnLotesG: 350,
    });
    expect(r.lineas[0]!.consumedG).toBe(3200);
    expect(r.lineas[0]!.cierra).toBe(true);
    expect(r.lineasSinCerrar).toHaveLength(0);
  });

  it("NO resta el peso crudo del servido: son bases distintas", () => {
    const r = resumirEvento({
      asistencia: sinAsistencia,
      lineas: [linea({ rawInputG: 5000, servedG: 3550, edibleLeftoverG: 350 })],
      compradoG: null,
      sobraEnLotesG: null,
    });
    // 5.000 − 3.550 = 1.450 sería "merma"; ese número no puede aparecer en
    // ninguna parte de la salida, porque la diferencia es sobre todo agua.
    expect(JSON.stringify(r)).not.toContain("1450");
    expect(r.lineas[0]!.rawInputG).toBe(5000);
  });

  it("lo servido sin lote detrás se declara, no se da por descontado", () => {
    const r = resumirEvento({
      asistencia: sinAsistencia,
      lineas: [linea({ servedG: 4200, deductedG: 3000 })],
      compradoG: null,
      sobraEnLotesG: null,
    });
    expect(r.lineas[0]!.sinRespaldoG).toBe(1200);
    expect(r.totales.sinRespaldoG).toBe(1200);
  });

  it("un corte sin servido registrado no aporta un cero a los totales", () => {
    const r = resumirEvento({
      asistencia: sinAsistencia,
      lineas: [linea({ ref: "a", servedG: 3000, deductedG: 3000, edibleLeftoverG: 0 }),
               linea({ ref: "b", label: "Pollo", servedG: null, deductedG: null })],
      compradoG: null,
      sobraEnLotesG: null,
    });
    expect(r.totales.servidoG).toBe(3000);
    expect(r.lineas[1]!.consumedG).toBeNull();
    expect(r.lineasSinCerrar).toEqual(["Pollo"]);
  });

  it("sin ninguna línea con datos, los totales son desconocidos y no cero", () => {
    const r = resumirEvento({
      asistencia: sinAsistencia,
      lineas: [linea({ servedG: null, deductedG: null, edibleLeftoverG: null })],
      compradoG: null,
      sobraEnLotesG: null,
    });
    expect(r.totales.servidoG).toBeNull();
    expect(r.totales.consumidoG).toBeNull();
    expect(r.totales.compradoG).toBeNull();
  });
});
