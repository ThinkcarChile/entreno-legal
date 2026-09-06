import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * /auth/callback CON DOBLES: qué canjea, a dónde manda, qué no dice.
 *
 * El canje de verdad lo hace Supabase; acá se afirma nuestro lado: que un
 * `code` se canjee, que un `token_hash` se verifique, que sin ninguno de los dos
 * no haya sesión, que `next` pase por `destinoInterno`, y que NI EL CÓDIGO NI
 * EL TOKEN aparezcan jamás en lo que se registra.
 */

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

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));

vi.mock("@/lib/observabilidad", () => ({
  registrarError: (evento: string, contexto: Record<string, unknown> = {}) => {
    puente.registrados.push({ evento, contexto });
  },
}));

import { GET } from "./route";

const ORIGEN = "https://familia.test";
const CODIGO = "codigo-secreto-de-un-solo-uso-9f8e7d";
const HASH = "hash-secreto-del-token-1a2b3c4d";

function pedir(consulta: string) {
  return GET(new NextRequest(`${ORIGEN}/auth/callback${consulta}`));
}

beforeEach(() => {
  puente.auth = {};
  puente.llamadas.length = 0;
  puente.registrados.length = 0;
  process.env.SITE_URL = ORIGEN;
});

describe("GET /auth/callback", () => {
  it("code válido → canjea y redirige (303) al destino interno", async () => {
    puente.auth.exchangeCodeForSession = async () => ({ data: { session: {} }, error: null });
    const res = await pedir(`?code=${CODIGO}&next=%2Feventos%3Fid%3D7`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGEN}/eventos?id=7`);
    expect(puente.llamadas).toEqual([{ metodo: "exchangeCodeForSession", args: [CODIGO] }]);
    expect(puente.registrados).toEqual([]);
  });

  it("code válido sin next → a la raíz", async () => {
    puente.auth.exchangeCodeForSession = async () => ({ data: {}, error: null });
    const res = await pedir(`?code=${CODIGO}`);
    expect(res.headers.get("location")).toBe(`${ORIGEN}/`);
  });

  it("sin code ni token → al login con «enlace inválido», sin tocar Supabase", async () => {
    const res = await pedir("");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGEN}/login?aviso=enlace-invalido`);
    expect(puente.llamadas).toEqual([]);
    expect(puente.registrados.map((r) => r.evento)).toEqual(["auth.callback.sin_codigo"]);
  });

  it("code inválido → al login con «enlace inválido»; el código NO se registra", async () => {
    puente.auth.exchangeCodeForSession = async () => ({
      data: {},
      error: { message: "invalid flow state", code: "flow_state_not_found" },
    });
    const res = await pedir(`?code=${CODIGO}&next=%2Ffamily`);
    expect(res.headers.get("location")).toBe(`${ORIGEN}/login?aviso=enlace-invalido`);
    const registrado = JSON.stringify(puente.registrados);
    expect(registrado).not.toContain(CODIGO);
    expect(registrado).toContain("flow_state_not_found");
  });

  it("next malicioso → canjea igual, pero manda a la raíz", async () => {
    puente.auth.exchangeCodeForSession = async () => ({ data: {}, error: null });
    for (const malo of ["https://evil.com", "//evil.com", "/\\evil.com", "%2F%2Fevil.com"]) {
      const res = await pedir(`?code=${CODIGO}&next=${encodeURIComponent(malo)}`);
      expect(res.headers.get("location"), malo).toBe(`${ORIGEN}/`);
    }
  });

  it("token_hash + type → verifyOtp, y el hash NO se registra ni con error", async () => {
    puente.auth.verifyOtp = async () => ({ data: {}, error: null });
    let res = await pedir(`?token_hash=${HASH}&type=recovery&next=%2Fnueva-contrasena`);
    expect(res.headers.get("location")).toBe(`${ORIGEN}/nueva-contrasena`);
    expect(puente.llamadas).toEqual([
      { metodo: "verifyOtp", args: [{ type: "recovery", token_hash: HASH }] },
    ]);

    puente.auth.verifyOtp = async () => ({
      data: {},
      error: { message: "Token has expired", code: "otp_expired" },
    });
    res = await pedir(`?token_hash=${HASH}&type=recovery`);
    expect(res.headers.get("location")).toBe(`${ORIGEN}/login?aviso=enlace-invalido`);
    expect(JSON.stringify(puente.registrados)).not.toContain(HASH);
  });

  it("token_hash con un type desconocido → no se verifica nada", async () => {
    const res = await pedir(`?token_hash=${HASH}&type=lo-que-sea`);
    expect(res.headers.get("location")).toBe(`${ORIGEN}/login?aviso=enlace-invalido`);
    expect(puente.llamadas).toEqual([]);
  });

  it("Supabase vuelve con ?error= → enlace inválido, sin canjear", async () => {
    const res = await pedir("?error=access_denied&error_code=otp_expired&error_description=x");
    expect(res.headers.get("location")).toBe(`${ORIGEN}/login?aviso=enlace-invalido`);
    expect(puente.llamadas).toEqual([]);
    expect(puente.registrados[0]?.contexto.codigo).toBe("otp_expired");
  });

  it("la redirección usa SITE_URL, no el host del pedido", async () => {
    // Detrás de un proxy el pedido llega con un host interno; la vuelta tiene
    // que ir al dominio público.
    puente.auth.exchangeCodeForSession = async () => ({ data: {}, error: null });
    const res = await GET(new NextRequest(`http://0.0.0.0:3000/auth/callback?code=${CODIGO}`));
    expect(res.headers.get("location")).toBe(`${ORIGEN}/`);
  });
});
