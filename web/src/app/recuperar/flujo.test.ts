import { beforeEach, describe, expect, it, vi } from "vitest";
import { VENTANA_RECUPERACION_MIN } from "@/lib/auth/recuperacion";

/**
 * RECUPERAR LA CLAVE, DE PUNTA A PUNTA CON DOBLES.
 *
 *   /recuperar  →  resetPasswordForEmail  →  (correo)  →  /auth/callback
 *               →  /nueva-contrasena  →  updateUser  →  signOut  →  /login
 *
 * Dos cosas mandan acá:
 *   - la respuesta de "olvidé mi contraseña" es LA MISMA exista o no el correo;
 *   - "nueva contraseña" sólo funciona con una sesión que venga del enlace de
 *     recuperación y sea reciente. Con sesión normal, sin sesión o con el
 *     enlace vencido, no cambia nada y manda al login.
 */

class Redirigio extends Error {
  constructor(readonly destino: string) {
    super(`redirect(${destino})`);
  }
}

const puente = vi.hoisted(() => ({
  auth: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
  llamadas: [] as { metodo: string; args: unknown[] }[],
  registrados: [] as { evento: string; contexto: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    auth: new Proxy(
      {},
      {
        get: (_o, metodo: string) => {
          return async (...args: unknown[]) => {
            puente.llamadas.push({ metodo, args });
            const fn = puente.auth[metodo];
            if (!fn) throw new Error(`el doble no sabe ${metodo}`);
            return fn(...args);
          };
        },
      },
    ),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redirigio(destino);
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));

vi.mock("@/lib/observabilidad", () => ({
  registrarError: (evento: string, contexto: Record<string, unknown> = {}) => {
    puente.registrados.push({ evento, contexto });
  },
}));

import { solicitarRecuperacion } from "./actions";
import { actualizarContrasena } from "../nueva-contrasena/actions";

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

/** Un JWT de mentira cuyo cuerpo dice cómo se autenticó la sesión. */
function tokenCon(amr: { method: string; timestamp: number }[]): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u1", amr })}.firma`;
}
const ahora = () => Math.floor(Date.now() / 1000);

function sesion(token: string | null, conUsuario = true) {
  puente.auth.getUser = async () => ({ data: { user: conUsuario ? { id: "u1" } : null } });
  puente.auth.getSession = async () => ({
    data: { session: token === null ? null : { access_token: token } },
  });
}

beforeEach(() => {
  puente.auth = {};
  puente.llamadas.length = 0;
  puente.registrados.length = 0;
  process.env.SITE_URL = "https://familia.test";
});

describe("solicitarRecuperacion (olvidé mi contraseña)", () => {
  it("correo válido → pide el enlace con redirectTo al callback → /nueva-contrasena", async () => {
    puente.auth.resetPasswordForEmail = async () => ({ data: {}, error: null });
    const destino = await destinoDe(solicitarRecuperacion(formulario({ email: "ana@familia.test" })));
    expect(destino).toBe("/recuperar?aviso=correo-enviado");
    expect(puente.llamadas).toEqual([
      {
        metodo: "resetPasswordForEmail",
        args: [
          "ana@familia.test",
          { redirectTo: "https://familia.test/auth/callback?next=%2Fnueva-contrasena" },
        ],
      },
    ]);
  });

  it("MENSAJE UNIFORME: un correo que no existe recibe exactamente lo mismo", async () => {
    puente.auth.resetPasswordForEmail = async () => ({
      data: {},
      error: { message: "User not found", code: "user_not_found" },
    });
    const destino = await destinoDe(
      solicitarRecuperacion(formulario({ email: "nadie@familia.test" })),
    );
    expect(destino).toBe("/recuperar?aviso=correo-enviado");
    // El motivo queda en el servidor, por código, sin el correo.
    expect(puente.registrados).toEqual([
      { evento: "auth.recuperacion.solicitud", contexto: { codigo: "user_not_found" } },
    ]);
  });

  it("correo mal formado → «datos», sin llamar a Supabase", async () => {
    expect(await destinoDe(solicitarRecuperacion(formulario({ email: "no-es-correo" })))).toBe(
      "/recuperar?aviso=datos",
    );
    expect(puente.llamadas).toEqual([]);
  });
});

describe("actualizarContrasena (nueva contraseña)", () => {
  const CLAVE = { password: "clave-nueva-123", confirmacion: "clave-nueva-123" };

  it("con sesión de recuperación reciente → actualiza, cierra sesión y manda al login", async () => {
    sesion(tokenCon([{ method: "otp", timestamp: ahora() - 60 }]));
    puente.auth.updateUser = async () => ({ data: {}, error: null });
    puente.auth.signOut = async () => ({ error: null });
    expect(await destinoDe(actualizarContrasena(formulario(CLAVE)))).toBe(
      "/login?aviso=clave-actualizada",
    );
    expect(puente.llamadas.map((l) => l.metodo)).toEqual([
      "getUser",
      "getSession",
      "updateUser",
      "signOut",
    ]);
    expect(puente.llamadas[2]?.args[0]).toEqual({ password: "clave-nueva-123" });
  });

  it("sin sesión (acceso directo) → «recuperación inválida», nada se actualiza", async () => {
    sesion(null, false);
    expect(await destinoDe(actualizarContrasena(formulario(CLAVE)))).toBe(
      "/login?aviso=recuperacion-invalida",
    );
    expect(puente.llamadas.map((l) => l.metodo)).not.toContain("updateUser");
  });

  it("con sesión NORMAL (password) → rechazada igual que sin sesión", async () => {
    // Una pestaña abierta en un computador ajeno no alcanza para cambiar la clave.
    sesion(tokenCon([{ method: "password", timestamp: ahora() }]));
    expect(await destinoDe(actualizarContrasena(formulario(CLAVE)))).toBe(
      "/login?aviso=recuperacion-invalida",
    );
    expect(puente.llamadas.map((l) => l.metodo)).not.toContain("updateUser");
  });

  it("recuperación VENCIDA → rechazada", async () => {
    sesion(
      tokenCon([{ method: "otp", timestamp: ahora() - VENTANA_RECUPERACION_MIN * 60 - 5 }]),
    );
    expect(await destinoDe(actualizarContrasena(formulario(CLAVE)))).toBe(
      "/login?aviso=recuperacion-invalida",
    );
    expect(puente.llamadas.map((l) => l.metodo)).not.toContain("updateUser");
  });

  it("token mal formado en la cookie → rechazada", async () => {
    sesion("esto-no-es-un-jwt");
    expect(await destinoDe(actualizarContrasena(formulario(CLAVE)))).toBe(
      "/login?aviso=recuperacion-invalida",
    );
  });

  it("claves que no coinciden o cortas → «clave rechazada», sin llamar a updateUser", async () => {
    sesion(tokenCon([{ method: "otp", timestamp: ahora() }]));
    expect(
      await destinoDe(
        actualizarContrasena(formulario({ password: "clave-nueva-123", confirmacion: "otra" })),
      ),
    ).toBe("/nueva-contrasena?aviso=clave-rechazada");
    expect(
      await destinoDe(actualizarContrasena(formulario({ password: "corta", confirmacion: "corta" }))),
    ).toBe("/nueva-contrasena?aviso=clave-rechazada");
    expect(puente.llamadas.map((l) => l.metodo)).not.toContain("updateUser");
  });

  it("Supabase rechaza la clave → «clave rechazada», y la sesión sigue (puede reintentar)", async () => {
    sesion(tokenCon([{ method: "otp", timestamp: ahora() }]));
    puente.auth.updateUser = async () => ({
      data: {},
      error: { message: "Password should be different", code: "same_password" },
    });
    expect(await destinoDe(actualizarContrasena(formulario(CLAVE)))).toBe(
      "/nueva-contrasena?aviso=clave-rechazada",
    );
    expect(puente.llamadas.map((l) => l.metodo)).not.toContain("signOut");
  });
});
