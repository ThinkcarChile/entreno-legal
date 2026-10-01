import { describe, expect, it } from "vitest";

import {
  chunk,
  fetchAllPages,
  historyPageHref,
  pageCount,
  pageWindow,
  parsePageParam,
} from "./pagination";

describe("parsePageParam", () => {
  it("lee un entero positivo", () => {
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam(" 2 ")).toBe(2);
    expect(parsePageParam(["4", "9"])).toBe(4);
  });

  it.each([
    ["ausente", undefined],
    ["nulo", null],
    ["vacío", ""],
    ["cero", "0"],
    ["negativo", "-2"],
    ["decimal", "1.5"],
    ["texto", "dos"],
    ["notación científica", "1e3"],
    ["desmesurado", "99999999999"],
  ])("cae en la primera con un valor %s", (_label, value) => {
    expect(parsePageParam(value)).toBe(1);
  });
});

describe("pageWindow y pageCount", () => {
  it("la página 1 empieza en cero", () => {
    expect(pageWindow(1, 25)).toEqual({ limit: 25, offset: 0 });
    expect(pageWindow(3, 25)).toEqual({ limit: 25, offset: 50 });
    expect(pageWindow(0, 25)).toEqual({ limit: 25, offset: 0 });
  });

  it("cuenta páginas, con al menos una", () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(Number.NaN, 25)).toBe(1);
  });
});

describe("chunk", () => {
  it("parte sin perder ni repetir", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("rechaza un tamaño que no sirve", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("fetchAllPages", () => {
  // Una tabla de mentira con un orden total: lo que haría PostgREST con `.range()`.
  const tabla = (n: number) => Array.from({ length: n }, (_, i) => i);
  const fuente = (filas: number[], llamadas: [number, number][]) => async (from: number, to: number) => {
    llamadas.push([from, to]);
    return filas.slice(from, to + 1);
  };

  it("trae más de un tramo sin perder la fila 101 ni la 1001", async () => {
    const llamadas: [number, number][] = [];
    const filas = await fetchAllPages(fuente(tabla(1234), llamadas), { chunkSize: 500 });
    expect(filas).toHaveLength(1234);
    expect(filas[100]).toBe(100);
    expect(filas[1233]).toBe(1233);
    // Termina con un tramo vacío: uno corto no prueba que no haya más.
    expect(llamadas).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
      [1234, 1733],
    ]);
  });

  it("no se corta si PostgREST recorta cada respuesta por debajo del tramo (max_rows)", async () => {
    // `max_rows = 100`: pide 500, recibe 100. Antes se leía como «no hay más»
    // y la lista volvía a quedar en las cien primeras filas.
    const filas = tabla(1234);
    const llamadas: [number, number][] = [];
    const conTope = async (from: number, to: number) => {
      llamadas.push([from, to]);
      return filas.slice(from, Math.min(to + 1, from + 100));
    };
    const todas = await fetchAllPages(conTope, { chunkSize: 500 });
    expect(todas).toEqual(filas);
    expect(llamadas[1]).toEqual([100, 599]);
  });

  it("con un múltiplo exacto pide un tramo más y termina en vacío", async () => {
    const llamadas: [number, number][] = [];
    const filas = await fetchAllPages(fuente(tabla(10), llamadas), { chunkSize: 5 });
    expect(filas).toHaveLength(10);
    expect(llamadas).toHaveLength(3);
  });

  it("sin filas, una sola consulta", async () => {
    const llamadas: [number, number][] = [];
    expect(await fetchAllPages(fuente([], llamadas), { chunkSize: 5 })).toEqual([]);
    expect(llamadas).toHaveLength(1);
  });

  it("falla en voz alta si la consulta ignora el rango, en vez de dar vueltas", async () => {
    const siempreLlena = async () => tabla(5);
    await expect(fetchAllPages(siempreLlena, { chunkSize: 5, maxChunks: 3 })).rejects.toThrow(
      /tras 3 tramos \(15 filas\)/,
    );
    const desbordada = async () => tabla(6);
    await expect(fetchAllPages(desbordada, { chunkSize: 5 })).rejects.toThrow(/ignora el rango/);
  });

  it("propaga el error de la base", async () => {
    const rota = async () => {
      throw new Error("sin conexión");
    };
    await expect(fetchAllPages(rota)).rejects.toThrow("sin conexión");
  });
});

describe("historyPageHref", () => {
  it("la primera página es la dirección de siempre, con el ancla", () => {
    expect(historyPageHref("/admin/payouts", 1)).toBe("/admin/payouts#historial");
    expect(historyPageHref("/admin/payouts", 0)).toBe("/admin/payouts#historial");
  });

  it("las siguientes llevan `pagina`", () => {
    expect(historyPageHref("/admin/disputas", 3)).toBe("/admin/disputas?pagina=3#historial");
  });

  it("conserva el filtro al avanzar y al volver a la primera", () => {
    expect(historyPageHref("/admin/pagos", 2, { filtro: "refunded" })).toBe(
      "/admin/pagos?filtro=refunded&pagina=2#historial",
    );
    expect(historyPageHref("/admin/pagos", 1, { filtro: "refunded" })).toBe(
      "/admin/pagos?filtro=refunded#historial",
    );
  });

  it("un parámetro vacío no se escribe", () => {
    expect(historyPageHref("/admin/pagos", 2, { filtro: null })).toBe("/admin/pagos?pagina=2#historial");
    expect(historyPageHref("/admin/pagos", 2, { filtro: "" })).toBe("/admin/pagos?pagina=2#historial");
  });

  it("escapa lo que no viene limpio", () => {
    expect(historyPageHref("/admin/pagos", 1, { filtro: "a&pagina=9" })).toBe(
      "/admin/pagos?filtro=a%26pagina%3D9#historial",
    );
  });
});
