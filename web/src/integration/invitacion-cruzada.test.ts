import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * LA VENTANA QUE LA 0033 DEJÓ ABIERTA.
 *
 * La 0033 cerró el salto entre hogares por la puerta: quitó el privilegio de
 * UPDATE sobre `user_id` y `household_id`, partió la política en dos y puso un
 * trigger que rechaza el cambio de identidad. Los tres ataques por PATCH
 * directo rebotan.
 *
 * Pero `accept_invitation` es SECURITY DEFINER —corre como dueña de la tabla—
 * y nunca verificó que la ficha invitada fuera del hogar que invita. La cadena:
 *
 *   1. El admin del hogar A crea una invitación con household_id = A
 *      (la política se lo permite) e invited_member_id = una ficha SIN CUENTA
 *      del hogar B.
 *   2. Quien acepta esa invitación queda vinculado a la ficha de B.
 *   3. `app.is_household_member(B)` da verdadero y B queda abierto entero.
 *
 * Las fichas sin cuenta no son un caso raro: son un requisito del producto, así
 * que el blanco siempre está disponible.
 *
 * Estos tests son la demostración de que la 0037 lo cierra.
 */

const USER_A = "00000000-0000-0000-0000-0000000a0037";
const USER_B = "00000000-0000-0000-0000-0000000b0037";
const USER_C = "00000000-0000-0000-0000-0000000c0037";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
/** Ficha del hogar B SIN cuenta vinculada: el blanco del ataque. */
let fichaSinCuentaEnB: string;

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar A", "Ana");
  hogarB = await crearHogar(h, USER_B, "Hogar B", "Beto");

  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_C,
      "carla@test.dev",
    ]);
  });

  // Beto agrega a alguien de su casa que todavía no tiene cuenta propia.
  fichaSinCuentaEnB = (await h.como(USER_B, () =>
    h.fila<{ id: string }>(
      `insert into public.household_members (household_id, display_name)
       values ($1, 'Hija de Beto') returning id`,
      [hogarB.householdId],
    ),
  ))!.id;
});

afterAll(async () => {
  await h?.cerrar();
});

/** Crea una invitación saltándose la app, como lo haría quien ataca por la API. */
async function invitar(
  actor: string,
  householdId: string,
  invitedMemberId: string | null,
  token: string,
) {
  return h.como(actor, () =>
    h.fila<{ id: string }>(
      `insert into public.invitations
         (household_id, invited_member_id, token_hash, role_code, expires_at)
       values ($1, $2, $3, 'MEMBER', now() + interval '7 days')
       returning id`,
      [householdId, invitedMemberId, token],
    ),
  );
}

describe("una invitación no puede cruzar de hogar", () => {
  it("el admin de A no puede siquiera CREAR una invitación que apunte a una ficha de B", async () => {
    // Primera capa: se ataja cuando todavía es una fila, no un vínculo.
    await expect(
      invitar(USER_A, hogarA.householdId, fichaSinCuentaEnB, "token-cruzado-1"),
    ).rejects.toThrow();
  });

  it("y si la invitación cruzada existiera igual, aceptarla no vincula nada", async () => {
    // Segunda capa, la que muerde: se fuerza la fila por fuera de la política
    // (como si alguien la hubiera creado antes de la 0037 o por otra vía) y se
    // comprueba que `accept_invitation` la rechaza igual.
    await h.comoAdmin(async () => {
      await h.db.query("alter table public.invitations disable trigger invitations_member_same_household");
      await h.db.query(
        `insert into public.invitations
           (household_id, invited_member_id, token_hash, role_code, expires_at)
         values ($1, $2, 'token-cruzado-2', 'MEMBER', now() + interval '7 days')`,
        [hogarA.householdId, fichaSinCuentaEnB],
      );
      await h.db.query("alter table public.invitations enable trigger invitations_member_same_household");
    });

    await expect(
      h.como(USER_C, () =>
        h.fila("select public.accept_invitation('token-cruzado-2', 'Carla')"),
      ),
    ).rejects.toThrow(/invitation invalid or expired/);

    // Y la ficha de B sigue sin cuenta: nadie se coló.
    const ficha = await h.comoAdmin(() =>
      h.fila<{ user_id: string | null }>(
        "select user_id from public.household_members where id = $1",
        [fichaSinCuentaEnB],
      ),
    );
    expect(ficha!.user_id).toBeNull();
  });

  it("el mensaje de error no delata que la ficha ajena existe", async () => {
    // Apuntar a un uuid inexistente ni siquiera es posible: la clave foránea
    // `invitations_invited_member_id_fkey` lo rechaza antes. Así que el oráculo
    // que hay que cerrar es el otro: "esta ficha es de otro hogar" contra "esta
    // ficha ya tiene cuenta". Si los mensajes difirieran, quien ataca sabría
    // que la ficha ajena existe y está libre.
    const yaVinculada = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.household_members where household_id = $1 and user_id is not null limit 1",
        [hogarA.householdId],
      ),
    ))!.id;

    await h.comoAdmin(async () => {
      await h.db.query("alter table public.invitations disable trigger invitations_member_same_household");
      await h.db.query(
        `insert into public.invitations
           (household_id, invited_member_id, token_hash, role_code, expires_at)
         values ($1, $2, 'token-ya-vinculada', 'MEMBER', now() + interval '7 days')`,
        [hogarA.householdId, yaVinculada],
      );
      await h.db.query("alter table public.invitations enable trigger invitations_member_same_household");
    });

    const mensajeFichaAjena = await h
      .como(USER_C, () => h.fila("select public.accept_invitation('token-cruzado-2', 'Carla')"))
      .catch((e: Error) => e.message);
    const mensajeYaVinculada = await h
      .como(USER_C, () => h.fila("select public.accept_invitation('token-ya-vinculada', 'Carla')"))
      .catch((e: Error) => e.message);

    expect(mensajeFichaAjena).toBe(mensajeYaVinculada);
  });

  it("la invitación legítima dentro del mismo hogar sigue funcionando", async () => {
    // El arreglo no puede romper el camino real: sin esto, nadie podría sumar
    // a su familia y la app quedaría inservible.
    await invitar(USER_B, hogarB.householdId, fichaSinCuentaEnB, "token-legitimo");

    const hogar = await h.como(USER_C, () =>
      h.fila<{ accept_invitation: string }>(
        "select public.accept_invitation('token-legitimo', 'Carla')",
      ),
    );
    expect(hogar!.accept_invitation).toBe(hogarB.householdId);

    const ficha = await h.comoAdmin(() =>
      h.fila<{ user_id: string | null }>(
        "select user_id from public.household_members where id = $1",
        [fichaSinCuentaEnB],
      ),
    );
    expect(ficha!.user_id).toBe(USER_C);
  });

  it("una invitación sin ficha previa sigue creando el integrante en SU hogar", async () => {
    const USER_D = "00000000-0000-0000-0000-0000000d0037";
    await h.comoAdmin(() =>
      h.db.query("insert into auth.users (id, email) values ($1, $2)", [USER_D, "d@test.dev"]),
    );
    await invitar(USER_A, hogarA.householdId, null, "token-nuevo");

    const hogar = await h.como(USER_D, () =>
      h.fila<{ accept_invitation: string }>(
        "select public.accept_invitation('token-nuevo', 'Diego')",
      ),
    );
    expect(hogar!.accept_invitation).toBe(hogarA.householdId);
  });
});
