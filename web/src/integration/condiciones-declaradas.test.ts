import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * LA TABLA QUE EXISTIÓ MESES SIN UN SOLO ESCRITOR.
 *
 * `member_conditions` nació en la 0027 con RLS, comentario y todo — y una
 * auditoría la encontró completamente muerta: ningún camino de la aplicación la
 * tocaba. No había forma de anotar que alguien es diabético.
 *
 * Ahora la escribe /health (declareCondition/removeCondition por PostgREST
 * directo), así que la política ES el control y hay que probarla por los dos
 * lados: que el acceso médico legítimo funciona, y que el vecino —y el propio
 * integrante del hogar SIN acceso médico— rebotan. Los roles del hogar no dan
 * acceso a datos médicos; eso está escrito en la pantalla y acá se comprueba.
 */

const USER_A = "00000000-0000-0000-0000-0000000c0001";
const USER_B = "00000000-0000-0000-0000-0000000c0002";
const USER_HERMANA = "00000000-0000-0000-0000-0000000c0003";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
/** Ficha de una hija dependiente (sin cuenta) del hogar A: la tutela manda. */
let hijaDeA: string;
/** Integrante adulta del hogar A con cuenta propia: hermana de la dueña. */
let hermanaDeA: string;

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Cond A", "Ana");
  hogarB = await crearHogar(h, USER_B, "Hogar Cond B", "Beto");

  // Un dependiente es una ficha SIN cuenta (`user_id is null`): así lo define
  // app.medical_access — el admin del hogar es su tutor médico. No hay columna
  // is_dependent; la dependencia ES la ausencia de cuenta propia.
  hijaDeA = (await h.como(USER_A, () =>
    h.fila<{ id: string }>(
      `insert into public.household_members (household_id, display_name)
       values ($1, 'Hija') returning id`,
      [hogarA.householdId],
    ),
  ))!.id;

  await h.comoAdmin(() =>
    h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_HERMANA,
      "hermana@test.dev",
    ]),
  );
  hermanaDeA = (await h.como(USER_A, () =>
    h.fila<{ id: string }>(
      `insert into public.household_members (household_id, display_name, user_id)
       values ($1, 'Hermana', $2) returning id`,
      [hogarA.householdId, USER_HERMANA],
    ),
  ))!.id;
}, 300_000);

afterAll(async () => {
  await h?.cerrar();
});

function declarar(actor: string, memberId: string, label: string, declaredBy: string) {
  return h.como(actor, () =>
    h.fila<{ id: string }>(
      `insert into public.member_conditions (member_id, label, declared_by)
       values ($1, $2, $3) returning id`,
      [memberId, label, declaredBy],
    ),
  );
}

describe("condiciones declaradas: el acceso médico manda, no el hogar", () => {
  it("una persona declara su propia condición y la vuelve a leer", async () => {
    const fila = await declarar(USER_A, hogarA.memberId, "Hipertensión", hogarA.memberId);
    expect(fila?.id).toBeTruthy();

    const leidas = await h.como(USER_A, () =>
      h.filas<{ label: string }>(
        "select label from public.member_conditions where member_id = $1",
        [hogarA.memberId],
      ),
    );
    expect(leidas.map((c) => c.label)).toContain("Hipertensión");
  });

  it("el tutor declara por su dependiente", async () => {
    const fila = await declarar(USER_A, hijaDeA, "Celiaquía", hogarA.memberId);
    expect(fila?.id).toBeTruthy();
  });

  it("compartir hogar NO es ver la ficha médica: la hermana no lee ni escribe", async () => {
    // La hermana es integrante ACTIVA del mismo hogar. Sin un grant médico
    // explícito, la condición de Ana no existe para ella — y su intento de
    // escribir rebota. Si esto falla, los roles del hogar se convirtieron en
    // acceso médico, que es exactamente lo que el módulo promete que no pasa.
    const leidas = await h.como(USER_HERMANA, () =>
      h.filas("select id from public.member_conditions where member_id = $1", [hogarA.memberId]),
    );
    expect(leidas).toHaveLength(0);

    await expect(
      declarar(USER_HERMANA, hogarA.memberId, "Inventada por la hermana", hermanaDeA),
    ).rejects.toThrow();
  });

  it("el vecino de otro hogar no ve nada y no escribe nada", async () => {
    const leidas = await h.como(USER_B, () =>
      h.filas("select id from public.member_conditions where member_id = $1", [hogarA.memberId]),
    );
    expect(leidas).toHaveLength(0);

    await expect(
      declarar(USER_B, hogarA.memberId, "Inventada por el vecino", hogarB.memberId),
    ).rejects.toThrow();
  });

  it("borrar sin acceso borra CERO filas — y por eso el action cuenta", async () => {
    // La RLS filtra el DELETE en silencio: cero filas y "éxito". El action
    // removeCondition pide el count y convierte ese silencio en un error que
    // habla. Acá se fija el comportamiento de la capa de abajo del que ese
    // count depende: si esto cambiara, el action mentiría.
    const condicion = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.member_conditions where member_id = $1 limit 1",
        [hogarA.memberId],
      ),
    ))!.id;

    await h.como(USER_B, () =>
      h.db.query("delete from public.member_conditions where id = $1", [condicion]),
    );
    const sigue = await h.como(USER_A, () =>
      h.fila("select id from public.member_conditions where id = $1", [condicion]),
    );
    expect(sigue, "el vecino borró una condición ajena").not.toBeNull();

    // Y el dueño sí puede quitarla de verdad.
    await h.como(USER_A, () =>
      h.db.query("delete from public.member_conditions where id = $1", [condicion]),
    );
    const yaNo = await h.como(USER_A, () =>
      h.fila("select id from public.member_conditions where id = $1", [condicion]),
    );
    expect(yaNo).toBeNull();
  });
});
