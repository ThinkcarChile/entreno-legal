import { describe, expect, it } from "vitest";

import {
  jobSearchOrFilter,
  normalizeSearchQuery,
  postgrestIlikePattern,
  SEARCH_QUERY_MAX,
} from "./search";

/**
 * El texto de búsqueda llega de la URL (?q=) y va a un filtro `or()` de
 * PostgREST. Con el texto pegado tal cual, una coma rompía el análisis del
 * filtro y el listado público cambiaba por la página de error.
 */
describe("postgrestIlikePattern", () => {
  const casos: [string, string][] = [
    ["Notaría, Providencia", String.raw`"%Notaría, Providencia%"`],
    ["a)", String.raw`"%a)%"`],
    ["(x", String.raw`"%(x%"`],
    ["x,id.eq.1", String.raw`"%x,id.eq.1%"`],
    // Los comodines de LIKE pasan a ser literales…
    ["100%", String.raw`"%100\\%%"`],
    ["a_b", String.raw`"%a\\_b%"`],
    // …y la barra y la comilla se escapan dos veces: para LIKE y para PostgREST.
    ['"rápido"', String.raw`"%\"rápido\"%"`],
    [String.raw`a\b`, String.raw`"%a\\\\b%"`],
  ];

  for (const [entrada, esperado] of casos) {
    it(`${JSON.stringify(entrada)} → ${esperado}`, () => {
      expect(postgrestIlikePattern(entrada)).toBe(esperado);
    });
  }
});

describe("normalizeSearchQuery", () => {
  it("recorta, colapsa espacios y quita el comodín de PostgREST", () => {
    expect(normalizeSearchQuery("  fila   en\tnotaría* ")).toBe("fila en notaría");
  });

  it("sin texto útil no hay búsqueda", () => {
    expect(normalizeSearchQuery(undefined)).toBeNull();
    expect(normalizeSearchQuery("")).toBeNull();
    expect(normalizeSearchQuery("   ")).toBeNull();
    expect(normalizeSearchQuery("***")).toBeNull();
  });

  it(`corta en ${SEARCH_QUERY_MAX} caracteres, sin partir uno compuesto`, () => {
    const largo = "ñ".repeat(SEARCH_QUERY_MAX + 50);
    expect([...normalizeSearchQuery(largo)!]).toHaveLength(SEARCH_QUERY_MAX);
    expect([...normalizeSearchQuery("😀".repeat(SEARCH_QUERY_MAX + 1))!]).toHaveLength(
      SEARCH_QUERY_MAX,
    );
  });
});

describe("jobSearchOrFilter", () => {
  it("busca en título y descripción con el mismo patrón entre comillas", () => {
    expect(jobSearchOrFilter("Registro Civil, Providencia")).toBe(
      'title.ilike."%Registro Civil, Providencia%",description.ilike."%Registro Civil, Providencia%"',
    );
  });

  it("una coma, un paréntesis o un punto no quedan fuera de las comillas", () => {
    const filtro = jobSearchOrFilter("x),id.eq.(1")!;
    // Lo que no está entre comillas es solo la estructura del filtro.
    const fueraDeComillas = filtro.replace(/"(?:[^"\\]|\\.)*"/g, "");
    expect(fueraDeComillas).toBe("title.ilike.,description.ilike.");
  });

  it("sin texto no hay filtro", () => {
    expect(jobSearchOrFilter("  ")).toBeNull();
  });
});
