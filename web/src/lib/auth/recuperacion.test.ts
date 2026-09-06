import { describe, expect, it } from "vitest";
import {
  esRecuperacionVigente,
  reclamacionesDe,
  VENTANA_RECUPERACION_MIN,
} from "./recuperacion";

/** Un JWT de mentira con estas reclamaciones. La firma no se verifica acá. */
function tokenCon(reclamaciones: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(reclamaciones)}.firma-falsa`;
}

const AHORA = 1_800_000_000_000; // ms
const seg = (ms: number) => Math.floor(ms / 1000);

describe("reclamacionesDe: leer el cuerpo de un JWT", () => {
  it("devuelve las reclamaciones de un token bien formado", () => {
    expect(reclamacionesDe(tokenCon({ sub: "abc", amr: [] }))).toEqual({ sub: "abc", amr: [] });
  });

  it("devuelve null ante cualquier cosa que no sea un JWT de tres partes", () => {
    expect(reclamacionesDe("")).toBeNull();
    expect(reclamacionesDe("a.b")).toBeNull();
    expect(reclamacionesDe("a.b.c.d")).toBeNull();
    expect(reclamacionesDe("x.!!!no-es-base64!!!.z")).toBeNull();
    expect(reclamacionesDe(`h.${Buffer.from("42").toString("base64url")}.f`)).toBeNull();
  });
});

describe("esRecuperacionVigente: sólo un canje de recuperación reciente habilita", () => {
  it("recovery hace un minuto → vigente", () => {
    const r = reclamacionesDe(
      tokenCon({ amr: [{ method: "recovery", timestamp: seg(AHORA) - 60 }] }),
    );
    expect(esRecuperacionVigente(r, AHORA)).toBe(true);
  });

  it("recovery justo dentro de la ventana → vigente; un segundo después → no", () => {
    const limite = VENTANA_RECUPERACION_MIN * 60;
    const dentro = reclamacionesDe(
      tokenCon({ amr: [{ method: "recovery", timestamp: seg(AHORA) - limite }] }),
    );
    const fuera = reclamacionesDe(
      tokenCon({ amr: [{ method: "recovery", timestamp: seg(AHORA) - limite - 1 }] }),
    );
    expect(esRecuperacionVigente(dentro, AHORA)).toBe(true);
    expect(esRecuperacionVigente(fuera, AHORA)).toBe(false);
  });

  it("una sesión normal (password) NO habilita, aunque sea reciente", () => {
    // El caso que este módulo existe para rechazar: acceso directo con una
    // sesión cualquiera a la pantalla de cambiar la clave.
    const r = reclamacionesDe(tokenCon({ amr: [{ method: "password", timestamp: seg(AHORA) }] }));
    expect(esRecuperacionVigente(r, AHORA)).toBe(false);
  });

  it("recovery viejo más password nuevo → no: manda el recovery y ya venció", () => {
    const r = reclamacionesDe(
      tokenCon({
        amr: [
          { method: "recovery", timestamp: seg(AHORA) - 10 * 24 * 3600 },
          { method: "password", timestamp: seg(AHORA) },
        ],
      }),
    );
    expect(esRecuperacionVigente(r, AHORA)).toBe(false);
  });

  it("sin amr, amr vacío, amr mal formado o token nulo → no", () => {
    expect(esRecuperacionVigente(reclamacionesDe(tokenCon({ sub: "x" })), AHORA)).toBe(false);
    expect(esRecuperacionVigente(reclamacionesDe(tokenCon({ amr: [] })), AHORA)).toBe(false);
    expect(esRecuperacionVigente(reclamacionesDe(tokenCon({ amr: "recovery" })), AHORA)).toBe(false);
    expect(
      esRecuperacionVigente(reclamacionesDe(tokenCon({ amr: [{ method: "recovery" }] })), AHORA),
    ).toBe(false);
    expect(esRecuperacionVigente(null, AHORA)).toBe(false);
  });

  it("un timestamp en el futuro lejano no cuenta", () => {
    // Un reloj torcido o un token armado a mano no puede "adelantar" la ventana.
    const r = reclamacionesDe(
      tokenCon({ amr: [{ method: "recovery", timestamp: seg(AHORA) + 3600 }] }),
    );
    expect(esRecuperacionVigente(r, AHORA)).toBe(false);
  });
});
