import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * UNA CUENTA SIN HOGAR VE UN ESTADO CONTROLADO, Y NO PUEDE CREARSE UNO.
 *
 * La política vive en `politica-hogar.ts` y la preguntan DOS lugares: la página
 * (para no mostrar el formulario) y la acción (para no procesarlo aunque
 * alguien mande el POST a mano). Acá se prueban las dos puntas y el
 * interruptor que las abre.
 */

class Redirigio extends Error {
  constructor(readonly destino: string) {
    super(`redirect(${destino})`);
  }
}

const puente = vi.hoisted(() => ({ rpc: [] as unknown[] }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    rpc: async (...args: unknown[]) => {
      puente.rpc.push(args);
      return { data: "hogar-nuevo", error: null };
    },
    auth: { signOut: async () => ({ error: null }) },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redirigio(destino);
  },
}));

import { createHousehold } from "./actions";
import { creacionDeHogarAbierta } from "./politica-hogar";
import { SinHogar } from "./SinHogar";

function formulario(campos: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

async function destinoDe(accion: Promise<void>): Promise<string> {
  try {
    await accion;
  } catch (e) {
    if (e instanceof Redirigio) return e.destino;
    throw e;
  }
  throw new Error("la acción terminó sin redirigir");
}

beforeEach(() => {
  puente.rpc.length = 0;
  delete process.env.HOGAR_CREACION_ABIERTA;
});

afterEach(() => {
  delete process.env.HOGAR_CREACION_ABIERTA;
});

describe("la política", () => {
  it("cerrada por omisión; sólo `1` la abre", () => {
    expect(creacionDeHogarAbierta()).toBe(false);
    process.env.HOGAR_CREACION_ABIERTA = "true";
    expect(creacionDeHogarAbierta()).toBe(false);
    process.env.HOGAR_CREACION_ABIERTA = " 1 ";
    expect(creacionDeHogarAbierta()).toBe(true);
  });
});

describe("createHousehold, la acción", () => {
  const DATOS = { householdName: "Casa Nueva", displayName: "Intruso" };

  it("con la política cerrada NO llama a create_household y vuelve con un aviso", async () => {
    const destino = await destinoDe(createHousehold(formulario(DATOS)));
    expect(destino.startsWith("/family?error=")).toBe(true);
    expect(decodeURIComponent(destino)).toContain("invitación");
    expect(puente.rpc, "la acción escribió con la política cerrada").toEqual([]);
  });

  it("con la política abierta crea el hogar como siempre", async () => {
    process.env.HOGAR_CREACION_ABIERTA = "1";
    expect(await destinoDe(createHousehold(formulario(DATOS)))).toBe("/family");
    expect(puente.rpc).toEqual([
      ["create_household", { p_name: "Casa Nueva", p_display_name: "Intruso" }],
    ]);
  });
});

describe("SinHogar, la pantalla", () => {
  it("dice qué falta y cómo conseguirlo, y deja cerrar sesión; no ofrece crear hogar", () => {
    const html = renderToStaticMarkup(createElement(SinHogar, {}));
    expect(html).toContain("Todavía no tienes hogar");
    expect(html).toContain("invitación");
    expect(html).toContain("Cerrar sesión");
    expect(html).not.toContain("Crear hogar");
    expect(html).not.toContain("householdName");
  });

  it("muestra el aviso que le llegue, si llega", () => {
    const html = renderToStaticMarkup(createElement(SinHogar, { error: "Los hogares nuevos están cerrados" }));
    expect(html).toContain("Los hogares nuevos están cerrados");
  });
});
