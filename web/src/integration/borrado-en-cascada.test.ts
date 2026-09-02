import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * BORRAR UN PADRE NO PUEDE MORIR POR EL GUARDIÁN DE SUS HIJOS.
 *
 * La 0039 puso un trigger de permiso en los borrados de `weekly_plans`,
 * `weekly_plan_days` y `meal_assignments`, y la 0041 clonó el molde para lo que
 * cuelga de `nutrition_events`. Para saber de qué hogar es la fila, el guardián
 * mira HACIA ARRIBA: `app.plan_household(plan_id)`, `app.day_household(day_id)`,
 * `app.event_household(event_id)`.
 *
 * Y ahí está el problema. Esas FK son `on delete cascade`, y en una cascada
 * Postgres borra PRIMERO al padre y recién después dispara el DELETE de los
 * hijos. Cuando el guardián corre sobre el hijo, el padre ya no está: la función
 * devuelve NULL, el guardián dice "no se pudo determinar el hogar: no se borra a
 * ciegas" y aborta la transacción entera. Con eso, borrar un día, una semana, un
 * hogar o un evento en borrador con un solo invitado queda imposible — para
 * todo el mundo, incluido quien tiene todos los permisos.
 *
 * Sobre una base vacía no se ve: sin un solo día con comidas, el trigger nunca
 * llega a dispararse. Lo encontró el pre-vuelo de la 0059, DESPUÉS de que las
 * diecinueve se aplicaran a producción. Esta prueba existe para que no vuelva a
 * hacer falta un pre-vuelo para verlo.
 *
 * Lo que se afirma es la conducta CORRECTA: quien puede editar el plan puede
 * borrar una semana entera, con sus días y sus comidas adentro, y el guardián
 * sigue negándose a quien no puede. La corrección es la 0059.
 */

const ADMIN = "aaaaaaaa-0000-4000-8000-00000000c05a";
const MEMBER = "bbbbbbbb-0000-4000-8000-00000000c05a";

let h!: Harness;
let hogar!: { householdId: string; memberId: string };
let versionId!: string;

beforeAll(async () => {
  h = await levantarBase({ conSeeds: true });
  hogar = await crearHogar(h, ADMIN, "Cascada", "Ana");

  // Un integrante SIN permiso de planificar, para probar que el guardián sigue
  // guardando lo que tiene que guardar.
  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      MEMBER,
      "beto-cascada@test.dev",
    ]);
    await h.db.query(
      `insert into public.household_members (household_id, user_id, display_name)
       values ($1, $2, 'Beto')`,
      [hogar.householdId, MEMBER],
    );
  });

  const receta = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `select v.id from public.meal_template_versions v
        join public.meal_templates m on m.id = v.template_id
       where m.household_id is null and v.status = 'PUBLISHED' limit 1`,
    ),
  );
  versionId = receta!.id;
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

/** Una semana con un día y una comida adentro: la cadena completa de la cascada. */
async function semanaConComida(sufijo: number): Promise<{ plan: string; dia: string; comida: string }> {
  return h.comoAdmin(async () => {
    const plan = (await h.fila<{ id: string }>(
      `insert into public.weekly_plans (household_id, week_start, status)
       values ($1, (date_trunc('week', current_date) + ($2 || ' weeks')::interval)::date, 'DRAFT')
       returning id`,
      [hogar.householdId, String(sufijo)],
    ))!.id;
    const dia = (await h.fila<{ id: string }>(
      `insert into public.weekly_plan_days (plan_id, plan_date)
       values ($1, (date_trunc('week', current_date) + ($2 || ' weeks')::interval)::date)
       returning id`,
      [plan, String(sufijo)],
    ))!.id;
    const comida = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status)
       values ($1, 'LUNCH', 'RECIPE', $2, 'PLANNED') returning id`,
      [dia, versionId],
    ))!.id;
    return { plan, dia, comida };
  });
}

async function filas(sql: string, params: unknown[]): Promise<number> {
  const r = await h.db.query(sql, params);
  return r.affectedRows ?? 0;
}

describe("borrar en cascada con permiso", () => {
  it("quien puede editar el plan borra un DÍA con sus comidas adentro", async () => {
    const { dia } = await semanaConComida(1);
    const borradas = await h.como(ADMIN, () =>
      filas("delete from public.weekly_plan_days where id = $1", [dia]),
    );
    expect(borradas, "el día no se borró").toBe(1);
    const huerfanas = await h.comoAdmin(() =>
      h.fila<{ n: string }>("select count(*) as n from public.meal_assignments where day_id = $1", [dia]),
    );
    expect(Number(huerfanas!.n), "la cascada no se llevó las comidas").toBe(0);
  });

  it("quien puede editar el plan borra una SEMANA entera", async () => {
    const { plan, dia } = await semanaConComida(2);
    const borradas = await h.como(ADMIN, () =>
      filas("delete from public.weekly_plans where id = $1", [plan]),
    );
    expect(borradas, "la semana no se borró").toBe(1);
    const quedan = await h.comoAdmin(() =>
      h.fila<{ n: string }>("select count(*) as n from public.weekly_plan_days where id = $1", [dia]),
    );
    expect(Number(quedan!.n)).toBe(0);
  });

  it("un evento en BORRADOR con invitados se puede borrar", async () => {
    const evento = await h.comoAdmin(async () => {
      const e = (await h.fila<{ id: string }>(
        `insert into public.nutrition_events (household_id, event_date, event_type, title, status)
         values ($1, current_date + 7, 'BARBECUE', 'Asado en borrador', 'DRAFT') returning id`,
        [hogar.householdId],
      ))!.id;
      await h.db.query(
        `insert into public.event_participants (event_id, participant_type, member_id)
         values ($1, 'HOUSEHOLD_MEMBER', $2)`,
        [e, hogar.memberId],
      );
      return e;
    });
    // Es EXACTAMENTE lo que hace `deleteEvent` (web/src/app/plan/actions.ts).
    const borradas = await h.como(ADMIN, () =>
      filas("delete from public.nutrition_events where id = $1", [evento]),
    );
    expect(borradas, "el evento en borrador no se borró").toBe(1);
  });

  it("y el guardián SIGUE negándose a quien no puede editar el plan", async () => {
    // Sin esto, arreglar la cascada podría haber abierto la puerta de más. Un
    // borrado DIRECTO (no cascada) de quien no tiene permiso tiene que morir
    // igual que antes.
    const { comida } = await semanaConComida(3);
    await expect(
      h.como(MEMBER, () => filas("delete from public.meal_assignments where id = $1", [comida])),
    ).rejects.toThrow(/no puedes editar el plan|insufficient_privilege|no autorizado/i);
  });
});
