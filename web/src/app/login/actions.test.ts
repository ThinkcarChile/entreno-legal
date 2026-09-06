import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LA PUERTA, PROBADA CON DOBLES: entrar, crear cuenta, salir.
 *
 * Lo que se afirma acá no es que Supabase funcione —eso no es nuestro— sino
 * lo que hacemos ANTES y DESPUÉS de hablarle: qué le mandamos, a dónde
 * redirigimos, y qué NO decimos. En particular:
 *
 *   - el `next` pasa por `destinoInterno`: uno malicioso termina en `/`;
 *   - los errores viajan como códigos, y el de registro es UNIFORME (no revela
 *     si el correo ya tenía cuenta);
 *   - el registro manda `emailRedirectTo` a `/auth/callback` con el destino
 *     adentro, y distingue "hay sesión" de "revisa tu correo".
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
  headers: async () => ({
    get: (k: string) => (k.toLowerCase() === "host" ? "familia.test" : null),
  }),
}));

vi.mock("@/lib/observabilidad", () => ({
  registrarError: (evento: string, contexto: Record<string, unknown> = {}) => {
    puente.registrados.push({ evento, contexto });
  },
}));

import { signIn, signOut, signUp } from "./actions";

function formulario(campos: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

/** Corre la acción y devuelve a dónde redirigió. */
async function destinoDe(accion: Promise<void>): Promise<string> {
  try {
    await accion;
  } catch (e) {
    if (e instanceof Redirigio) return e.destino;
    throw e;
  }
  throw new Error("la acción terminó sin redirigir");
}

const CREDENCIALES = { email: "ana@familia.test", password: "clave-larga-1" };

beforeEach(() => {
  puente.auth = {};
  puente.llamadas.length = 0;
  puente.registrados.length = 0;
  delete process.env.SITE_URL;
});

describe("signIn", () => {
  it("login válido → al destino pedido", async () => {
    puente.auth.signInWithPassword = async () => ({ data: {}, error: null });
    expect(await destinoDe(signIn(formulario({ ...CREDENCIALES, next: "/eventos?id=7" })))).toBe(
      "/eventos?id=7",
    );
    expect(puente.llamadas[0]?.args[0]).toEqual(CREDENCIALES);
  });

  it("login válido sin next → a la raíz, que decide sola", async () => {
    puente.auth.signInWithPassword = async () => ({ data: {}, error: null });
    expect(await destinoDe(signIn(formulario(CREDENCIALES)))).toBe("/");
  });

  it("login inválido → un solo código, sin el mensaje de Supabase", async () => {
    puente.auth.signInWithPassword = async () => ({
      data: {},
      error: { message: "Invalid login credentials", code: "invalid_credentials" },
    });
    expect(await destinoDe(signIn(formulario(CREDENCIALES)))).toBe("/login?aviso=credenciales");
  });

  it("correo sin confirmar → EL MISMO código que la clave mala", async () => {
    // Distinguirlos le diría a quien tantea que ese correo tiene cuenta.
    puente.auth.signInWithPassword = async () => ({
      data: {},
      error: { message: "Email not confirmed", code: "email_not_confirmed" },
    });
    expect(await destinoDe(signIn(formulario(CREDENCIALES)))).toBe("/login?aviso=credenciales");
  });

  it("next malicioso → a la raíz, aunque el login sea válido", async () => {
    puente.auth.signInWithPassword = async () => ({ data: {}, error: null });
    for (const malo of ["https://evil.com", "//evil.com", "/\\evil.com", "%2F%2Fevil.com"]) {
      expect(await destinoDe(signIn(formulario({ ...CREDENCIALES, next: malo })))).toBe("/");
    }
  });

  it("datos inválidos → no le habla a Supabase", async () => {
    expect(await destinoDe(signIn(formulario({ email: "no-es-correo", password: "x" })))).toBe(
      "/login?aviso=datos",
    );
    expect(puente.llamadas).toEqual([]);
  });
});

describe("signUp", () => {
  it("con sesión (Confirm Email apagado) → al destino, y manda emailRedirectTo con el destino adentro", async () => {
    puente.auth.signUp = async () => ({ data: { session: { access_token: "t" } }, error: null });
    const destino = await destinoDe(
      signUp(formulario({ ...CREDENCIALES, next: "/invite/abcdefghijklmnopqrstu" })),
    );
    expect(destino).toBe("/invite/abcdefghijklmnopqrstu");
    const args = puente.llamadas[0]?.args[0] as { options: { emailRedirectTo: string } };
    expect(args.options.emailRedirectTo).toBe(
      "http://familia.test/auth/callback?next=%2Finvite%2Fabcdefghijklmnopqrstu",
    );
  });

  it("SITE_URL manda sobre la cabecera Host", async () => {
    process.env.SITE_URL = "https://mesa.ejemplo.cl/";
    puente.auth.signUp = async () => ({ data: { session: {} }, error: null });
    await destinoDe(signUp(formulario(CREDENCIALES)));
    const args = puente.llamadas[0]?.args[0] as { options: { emailRedirectTo: string } };
    expect(args.options.emailRedirectTo).toBe("https://mesa.ejemplo.cl/auth/callback?next=%2F");
  });

  it("sin sesión (Confirm Email activo) → «revisa tu correo», no al destino", async () => {
    puente.auth.signUp = async () => ({ data: { session: null, user: { id: "u" } }, error: null });
    expect(await destinoDe(signUp(formulario({ ...CREDENCIALES, next: "/family" })))).toBe(
      "/login?aviso=revisa-correo",
    );
  });

  it("error de registro → código UNIFORME, sea cual sea el motivo", async () => {
    // "User already registered" es un oráculo de correos: no puede llegar a la
    // pantalla. Se compara la salida de dos errores distintos: idéntica.
    puente.auth.signUp = async () => ({
      data: {},
      error: { message: "User already registered", code: "user_already_exists" },
    });
    const a = await destinoDe(signUp(formulario(CREDENCIALES)));
    puente.auth.signUp = async () => ({
      data: {},
      error: { message: "Signup is disabled", code: "signup_disabled" },
    });
    const b = await destinoDe(signUp(formulario(CREDENCIALES)));
    expect(a).toBe("/login?aviso=cuenta");
    expect(b).toBe(a);
    // El motivo real queda en el log del servidor, por código.
    expect(puente.registrados.map((r) => r.contexto.codigo)).toEqual([
      "user_already_exists",
      "signup_disabled",
    ]);
  });

  it("next malicioso → emailRedirectTo lleva la raíz, no el destino externo", async () => {
    puente.auth.signUp = async () => ({ data: { session: {} }, error: null });
    await destinoDe(signUp(formulario({ ...CREDENCIALES, next: "//evil.com" })));
    const args = puente.llamadas[0]?.args[0] as { options: { emailRedirectTo: string } };
    expect(args.options.emailRedirectTo).toBe("http://familia.test/auth/callback?next=%2F");
  });
});

describe("signOut", () => {
  it("cierra la sesión en Supabase y manda al login", async () => {
    puente.auth.signOut = async () => ({ error: null });
    expect(await destinoDe(signOut())).toBe("/login");
    expect(puente.llamadas.map((l) => l.metodo)).toEqual(["signOut"]);
  });
});
