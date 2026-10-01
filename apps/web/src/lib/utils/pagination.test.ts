import { describe, expect, it } from "vitest";

import { chunk, fetchAllPages, pageCount, pageWindow, parsePageParam } from "./pagination";

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
    expect(llamadas).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
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
      /superó 15 filas/,
    );
  });

  it("propaga el error de la base", async () => {
    const rota = async () => {
      throw new Error("sin conexión");
    };
    await expect(fetchAllPages(rota)).rejects.toThrow("sin conexión");
  });
});
