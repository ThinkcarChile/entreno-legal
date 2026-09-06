import { readFileSync } from "node:fs";
import path from "node:path";
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
import { avisoFamiliaDe } from "./avisos";

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

  it("con la política cerrada NO llama a create_household y vuelve con un aviso por código", async () => {
    const destino = await destinoDe(createHousehold(formulario(DATOS)));
    // Por CÓDIGO, no por texto libre: el mismo vector que se cerró en /login.
    expect(destino).toBe("/family?aviso=hogares-cerrados");
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
    const html = renderToStaticMarkup(createElement(SinHogar, { mensaje: null }));
    expect(html).toContain("Todavía no tienes hogar");
    expect(html).toContain("invitación");
    expect(html).toContain("Cerrar sesión");
    expect(html).not.toContain("Crear hogar");
    expect(html).not.toContain("householdName");
  });

  it("sólo muestra un mensaje de NUESTRA lista, nunca texto libre de la URL", () => {
    // Antes recibía `?error=` crudo: una caja roja para cualquier frase. Ahora
    // la página resuelve un código a texto nuestro y le pasa ESO. El texto de
    // estafa de un atacante nunca llega hasta acá porque nunca es un código.
    const html = renderToStaticMarkup(
      createElement(SinHogar, { mensaje: avisoFamiliaDe("hogares-cerrados") }),
    );
    expect(html).toContain("Los hogares nuevos están cerrados");
    // Un código inventado se resuelve a null y no pinta nada.
    const vacio = renderToStaticMarkup(
      createElement(SinHogar, { mensaje: avisoFamiliaDe("Tu cuenta fue bloqueada, llama al 600") }),
    );
    expect(vacio).not.toContain("bloqueada");
  });
});

describe("ninguna acción de familia ni de invitación pinta texto libre en la URL", () => {
  it("los avisos van por código, no por `?error=`", () => {
    // El vector que cerró avisos.ts en /login, cerrado también acá: si alguien
    // vuelve a escribir `?error=<texto>` en una redirección, este test lo dice.
    for (const a of [
      path.resolve(__dirname, "actions.ts"),
      path.resolve(__dirname, "../invite/[token]/actions.ts"),
    ]) {
      const fuente = readFileSync(a, "utf8");
      expect(fuente, `${a} redirige con texto libre en ?error=`).not.toMatch(/\?error=/);
    }
  });
});
