import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "@/domain/family/invitations";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * LA INVITACIÓN FAMILIAR, CONTRA POSTGRESQL DE VERDAD.
 *
 * Lo que está en juego es quién entra a qué hogar. Se prueba en la base y no
 * con dobles porque las guardas viven en la RPC `accept_invitation` (0037) y en
 * la RLS de `invitations` (0001): un doble que las imite las imitaría bien o
 * mal, y no sabríamos cuál.
 *
 * HECHOS que estos tests fijan (ver docs/deployment/auth-produccion.md):
 *   - el token se genera en la app (32 bytes, base64url) y en la base sólo
 *     vive su sha256; se busca por hash, sin filtro de hogar, y el hogar lo
 *     dicta la fila;
 *   - vale 7 días y UN solo uso: `accepted_at` la consume;
 *   - no está ligada al correo: `invitations.email` es informativo; quien tiene
 *     el enlace, entra. Eso es una decisión, y queda escrita acá;
 *   - sin sesión no se acepta (la RPC lo exige por dentro);
 *   - una invitación con ficha previa (`invited_member_id`) sólo puede
 *     vincular una ficha DEL MISMO hogar: el cruce está cerrado por la RPC y
 *     por el trigger de 0037;
 *   - una cuenta sin hogar no ve ni una fila de nadie.
 */

const USER_ADMIN = "00000000-0000-4000-8000-00000000ad01";
const USER_INVITADO = "00000000-0000-4000-8000-00000000fa01";
const USER_OTRO = "00000000-0000-4000-8000-00000000fb01";
const USER_ADMIN_B = "00000000-0000-4000-8000-00000000ad02";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };

/** Como usuario, con sesión y RLS. */
const como = <T>(userId: string, fn: () => Promise<T>) => h.como(userId, fn);

/** Crea una invitación en el hogar dado tal como lo hace `createInvitation`. */
async function invitar(
  householdId: string,
  extra: Partial<{ expires_at: string; invited_member_id: string; email: string }> = {},
): Promise<string> {
  const token = generateInvitationToken();
  await h.comoAdmin(() =>
    h.db.query(
      `insert into public.invitations (household_id, token_hash, role_code, expires_at, invited_member_id, email)
       values ($1, $2, 'MEMBER', $3, $4, $5)`,
      [
        householdId,
        hashInvitationToken(token),
        extra.expires_at ?? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        extra.invited_member_id ?? null,
        extra.email ?? null,
      ],
    ),
  );
  return token;
}

/** Acepta como el usuario dado; devuelve el hogar o el mensaje de error. */
async function aceptar(userId: string, token: string): Promise<string> {
  return como(userId, async () => {
    const r = await h.fila<{ accept_invitation: string }>(
      "select public.accept_invitation($1, $2)",
      [hashInvitationToken(token), "Invitado"],
    );
    return r?.accept_invitation ?? "SIN RESULTADO";
  }).catch((e: Error) => `ERROR: ${e.message}`);
}

async function hogaresDe(userId: string): Promise<string[]> {
  const f = await h.comoAdmin(() =>
    h.filas<{ household_id: string }>(
      "select household_id from public.household_members where user_id = $1 and is_active order by created_at",
      [userId],
    ),
  );
  return f.map((x) => x.household_id);
}

beforeAll(async () => {
  h = await levantarBase({ conSeeds: false });
  hogarA = await crearHogar(h, USER_ADMIN, "Hogar A", "Ana");
  hogarB = await crearHogar(h, USER_ADMIN_B, "Hogar B", "Bruno");
  // Los invitados tienen CUENTA pero no hogar: es la situación de quien recién
  // se registró desde el enlace.
  await h.comoAdmin(() =>
    h.db.query(
      "insert into auth.users (id, email) values ($1, 'inv@x.test'), ($2, 'otro@x.test') on conflict do nothing",
      [USER_INVITADO, USER_OTRO],
    ),
  );
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("invitación válida", () => {
  it("quien la acepta con sesión queda como integrante del hogar correcto", async () => {
    const token = await invitar(hogarA.householdId);
    expect(await aceptar(USER_INVITADO, token)).toBe(hogarA.householdId);
    expect(await hogaresDe(USER_INVITADO)).toEqual([hogarA.householdId]);
  });

  it("es de UN solo uso: la segunda vez falla, aunque sea otra persona", async () => {
    const token = await invitar(hogarA.householdId);
    expect(await aceptar(USER_OTRO, token)).toBe(hogarA.householdId);
    const otraVez = await aceptar(USER_INVITADO, token);
    expect(otraVez).toContain("ERROR");
    expect(otraVez).toContain("invalid or expired");
  });

  it("NO está ligada al correo: el email de la fila es informativo", async () => {
    // Decisión, no descuido: el enlace ES la credencial. Se deja fijado para que
    // nadie crea que hay una comprobación que no existe.
    const token = await invitar(hogarB.householdId, { email: "alguien-mas@x.test" });
    expect(await aceptar(USER_INVITADO, token)).toBe(hogarB.householdId);
  });
});

describe("invitación que no sirve", () => {
  it("token inventado → error, y nadie entra a ningún hogar", async () => {
    const antes = await hogaresDe(USER_OTRO);
    const r = await aceptar(USER_OTRO, generateInvitationToken());
    expect(r).toContain("invalid or expired");
    expect(await hogaresDe(USER_OTRO)).toEqual(antes);
  });

  it("vencida → el MISMO error que una inventada", async () => {
    const token = await invitar(hogarA.householdId, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const vencida = await aceptar(USER_OTRO, token);
    const inventada = await aceptar(USER_OTRO, generateInvitationToken());
    expect(vencida).toBe(inventada);
  });

  it("sin sesión → la RPC se niega por dentro (además del privilegio)", async () => {
    const token = await invitar(hogarA.householdId);
    let mensaje = "";
    await h.db.exec("set role authenticated;");
    try {
      await h.db.query("select set_config('request.jwt.claim.sub', '', false)");
      await h.db.query("select public.accept_invitation($1, 'X')", [hashInvitationToken(token)]);
    } catch (e) {
      mensaje = String((e as Error).message);
    } finally {
      await h.db.exec("reset role;");
    }
    expect(mensaje).toContain("authentication required");
  });
});

describe("cruce de hogares: cerrado", () => {
  it("una invitación del hogar A no puede vincular una ficha del hogar B", async () => {
    /**
     * El caso de 0037. Una ficha "sin cuenta" del hogar B (Bruno tiene cuenta;
     * se crea otra sin `user_id`). Un admin de A que apuntara su invitación a
     * esa ficha abriría B entero. El trigger de `invitations` lo rechaza al
     * insertar, y si la fila existiera igual, la RPC vuelve a exigir el hogar.
     */
    const fichaSinCuentaB = (await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "insert into public.household_members (household_id, display_name) values ($1, 'Abuela B') returning id",
        [hogarB.householdId],
      ),
    ))!.id;

    let errorAlInsertar = "";
    try {
      await invitar(hogarA.householdId, { invited_member_id: fichaSinCuentaB });
    } catch (e) {
      errorAlInsertar = String((e as Error).message);
    }
    expect(errorAlInsertar).toContain("invalid or expired");

    // Y la ficha de B sigue sin cuenta: nadie la tocó.
    const ficha = await h.comoAdmin(() =>
      h.fila<{ user_id: string | null }>(
        "select user_id from public.household_members where id = $1",
        [fichaSinCuentaB],
      ),
    );
    expect(ficha?.user_id).toBeNull();
  });

  it("sólo un admin del hogar puede crear su invitación (RLS)", async () => {
    // Bruno (admin de B) intenta invitar al hogar A: la RLS `invitations_admin`
    // deja la inserción sin efecto. Se comprueba contando.
    const antes = (await h.comoAdmin(() =>
      h.fila<{ n: number }>("select count(*)::int as n from public.invitations where household_id = $1", [
        hogarA.householdId,
      ]),
    ))!.n;
    await como(USER_ADMIN_B, async () => {
      try {
        await h.db.query(
          `insert into public.invitations (household_id, token_hash, role_code, expires_at)
           values ($1, $2, 'MEMBER', now() + interval '7 days')`,
          [hogarA.householdId, hashInvitationToken(generateInvitationToken())],
        );
      } catch {
        /* rechazada por RLS: también vale */
      }
    });
    const despues = (await h.comoAdmin(() =>
      h.fila<{ n: number }>("select count(*)::int as n from public.invitations where household_id = $1", [
        hogarA.householdId,
      ]),
    ))!.n;
    expect(despues).toBe(antes);
  });
});

describe("cuenta sin hogar", () => {
  const USER_SIN_HOGAR = "00000000-0000-4000-8000-00000000c0c0";

  it("no ve ni una fila de hogares, integrantes ni invitaciones", async () => {
    await h.comoAdmin(() =>
      h.db.query("insert into auth.users (id, email) values ($1, 'solo@x.test') on conflict do nothing", [
        USER_SIN_HOGAR,
      ]),
    );
    const vistos = await como(USER_SIN_HOGAR, async () => ({
      hogares: (await h.filas("select id from public.households")).length,
      integrantes: (await h.filas("select id from public.household_members")).length,
      invitaciones: (await h.filas("select id from public.invitations")).length,
    }));
    expect(vistos).toEqual({ hogares: 0, integrantes: 0, invitaciones: 0 });
  });

  it("y el control de vacuidad: con hogar, la misma consulta SÍ ve filas", async () => {
    // Sin esto, un `select` roto que devolviera vacío para todos daría verde.
    const vistos = await como(USER_ADMIN, async () => (await h.filas("select id from public.households")).length);
    expect(vistos).toBeGreaterThan(0);
  });
});
