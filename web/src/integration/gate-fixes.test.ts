import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * REGRESIONES DEL INTEGRATION GATE 0→10.
 *
 * Un test por defecto confirmado en la auditoría de 13 lentes. Cada uno
 * reproduce el escenario que fallaba antes de la corrección.
 */

const USER_A = "00000000-0000-0000-0000-00000000bb01";
const USER_B = "00000000-0000-0000-0000-00000000bb02";

let h: Harness;
let A: { householdId: string; memberId: string };
let B: { householdId: string; memberId: string };
let polloId: string;
let pantry: string;
let fridge: string;
let freezer: string;

async function lote(id: string) {
  return (await h.comoAdmin(() =>
    h.fila<{
      quantity: string; processing_state: string; temperature_state: string;
      thawed_at: string | null; frozen_at: string | null; acquisition_value: string | null;
      status: string;
    }>(
      `select quantity::text, processing_state::text, temperature_state::text,
              thawed_at::text, frozen_at::text, acquisition_value::text, status
       from public.inventory_lots where id = $1`,
      [id],
    ),
  ))!;
}

async function crear(label: string, cantidad: number, ubicacion?: string, estado?: string) {
  return h.como(USER_A, async () =>
    (await h.fila<{ add_manual_lot: string }>(
      "select public.add_manual_lot($1, $2, $3, 'G', $4, $5, null, null, $6)",
      [A.householdId, label, cantidad, polloId, ubicacion ?? null, estado ?? null],
    ))!.add_manual_lot,
  );
}

beforeAll(async () => {
  h = await levantarBase();
  A = await crearHogar(h, USER_A, "Hogar Fixes A", "Ana");
  B = await crearHogar(h, USER_B, "Hogar Fixes B", "Bruno");
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  await h.como(USER_A, () => h.db.query("select public.ensure_storage_locations($1)", [A.householdId]));
  const ubic = await h.como(USER_A, () =>
    h.filas<{ id: string; kind: string }>(
      "select id, kind::text from public.storage_locations where household_id = $1",
      [A.householdId],
    ),
  );
  pantry = ubic.find((u) => u.kind === "PANTRY")!.id;
  fridge = ubic.find((u) => u.kind === "FRIDGE")!.id;
  freezer = ubic.find((u) => u.kind === "FREEZER")!.id;
}, 120000);

afterAll(async () => {
  await h?.cerrar();
});

describe("[C-1] la temperatura la manda la ubicación DESTINO", () => {
  it("del congelador a la DESPENSA queda AMBIENT (antes quedaba CHILLED)", async () => {
    const id = await crear("Pollo térmico", 500, freezer);
    expect((await lote(id)).temperature_state).toBe("FROZEN");
    await h.como(USER_A, () => h.db.query("select public.move_lot($1, $2)", [id, pantry]));
    const l = await lote(id);
    expect(l.temperature_state).toBe("AMBIENT");
    expect(l.thawed_at).not.toBeNull(); // salir del congelador sella la evidencia
  });

  it("del congelador al refrigerador queda CHILLED, y volver congela de nuevo", async () => {
    const id = await crear("Pollo vaivén", 500, freezer);
    await h.como(USER_A, () => h.db.query("select public.move_lot($1, $2)", [id, fridge]));
    expect((await lote(id)).temperature_state).toBe("CHILLED");
    await h.como(USER_A, () => h.db.query("select public.move_lot($1, $2)", [id, freezer]));
    expect((await lote(id)).temperature_state).toBe("FROZEN");
  });
});

describe("[C-2] el estado de preparación se DECLARA", () => {
  it("una sobra se puede registrar como COOKED desde la app", async () => {
    const id = await crear("Cazuela de ayer", 800, fridge, "COOKED");
    const l = await lote(id);
    expect(l.processing_state).toBe("COOKED");
    expect(l.temperature_state).toBe("CHILLED"); // por la ubicación
  });

  it("sin declarar sigue siendo RAW, y un estado inventado se rechaza", async () => {
    expect((await lote(await crear("Pollo normal", 100))).processing_state).toBe("RAW");
    await expect(crear("Pollo raro", 100, undefined, "SEMICRUDO")).rejects.toThrow(/desconocido/);
  });
});

describe("[C-3] los lotes nacen con la temperatura de donde se guardan", () => {
  it("alta manual en el congelador nace FROZEN con frozen_at", async () => {
    const l = await lote(await crear("Pollo congelado", 300, freezer));
    expect(l.temperature_state).toBe("FROZEN");
    expect(l.frozen_at).not.toBeNull();
  });
});

describe("[K-1] merge no duplica el dinero", () => {
  it("unir 1.000 + 700 deja el valor en el hijo y DEBITA a los padres", async () => {
    const a = await crear("Merge A", 300, pantry);
    const b = await crear("Merge B", 200, pantry);
    await h.comoAdmin(() =>
      h.db.query("update public.inventory_lots set acquisition_value = 1000 where id = $1", [a]),
    );
    await h.comoAdmin(() =>
      h.db.query("update public.inventory_lots set acquisition_value = 700 where id = $1", [b]),
    );
    const nuevo = await h.como(USER_A, async () =>
      (await h.fila<{ merge_lots: string }>("select public.merge_lots(array[$1, $2]::uuid[])", [a, b]))!
        .merge_lots,
    );
    expect(Number((await lote(nuevo)).acquisition_value)).toBe(1700);
    // El dinero viaja: los orígenes ya no valen lo que entregaron.
    expect((await lote(a)).acquisition_value).toBeNull();
    expect((await lote(b)).acquisition_value).toBeNull();
    // Total de la despensa: 1.700, no 3.400.
    const total = await h.comoAdmin(() =>
      h.fila<{ s: string }>(
        "select coalesce(sum(acquisition_value), 0)::text as s from public.inventory_lots where household_id = $1",
        [A.householdId],
      ),
    );
    expect(Number(total!.s)).toBe(1700);
  });
});

describe("[D-1] una comida servida no se borra", () => {
  it("borrar la asignación con porciones CONSUMED se rechaza", async () => {
    const plan = await h.como(USER_A, async () =>
      (await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
        [A.householdId],
      ))!.ensure_weekly_plan,
    );
    const dia = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
        [plan],
      ),
    ))!.id;
    const asignacion = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
         select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
         from public.meal_template_versions v
         join public.meal_templates t on t.id = v.template_id
         where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED' limit 1
         returning id`,
        [dia],
      ),
    ))!.id;
    const perfil = await h.como(USER_A, async () =>
      (await h.fila<{ publish_nutrition_profile: string }>(
        `select public.publish_nutrition_profile($1, 'BASIC', 'firma-fix', '{}'::jsonb,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'fix')`,
        [A.memberId],
      ))!.publish_nutrition_profile,
    );
    const version = (await h.fila<{ id: string }>(
      `select v.id from public.meal_template_versions v
       join public.meal_templates t on t.id = v.template_id
       where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
    ))!.id;
    const fecha = (await h.como(USER_A, () =>
      h.fila<{ d: string }>("select plan_date::text as d from public.weekly_plan_days where id = $1", [dia]),
    ))!.d;

    await h.como(USER_A, () =>
      h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        asignacion,
        JSON.stringify([
          {
            member_id: A.memberId, version_id: version, profile_id: perfil,
            optimizer_version: "portion-optimizer/1.0.0", meal_type: "LUNCH", serving_date: fecha,
            fit: "COMPATIBLE", adaptation_level: 0, score: 90,
            nutrition: {}, completeness: {}, reasons: [], unmet_constraints: [],
            components: [], substitutions: [],
          },
        ]),
      ]),
    );
    await h.comoAdmin(() =>
      h.db.query(
        "update public.member_serving_projections set status = 'CONSUMED' where assignment_id = $1",
        [asignacion],
      ),
    );

    await expect(
      h.como(USER_A, () => h.db.query("delete from public.meal_assignments where id = $1", [asignacion])),
    ).rejects.toThrow(/ya se sirvió/i);
  });
});

describe("[D-2 / I-2] las porciones no se escriben desde el cliente", () => {
  it("un UPDATE directo de status no cambia nada (RLS solo-lectura)", async () => {
    const antes = await h.comoAdmin(() =>
      h.filas<{ status: string }>("select status from public.member_serving_projections"),
    );
    await h.como(USER_A, () =>
      h.db.query("update public.member_serving_projections set status = 'PLANNED'"),
    );
    const despues = await h.comoAdmin(() =>
      h.filas<{ status: string }>("select status from public.member_serving_projections"),
    );
    expect(despues).toEqual(antes);
  });

  it("un DELETE directo de la porción CONSUMED tampoco pasa", async () => {
    const antes = (await h.comoAdmin(() =>
      h.filas("select id from public.member_serving_projections where status = 'CONSUMED'"),
    )).length;
    await h.como(USER_A, () =>
      h.db.query("delete from public.member_serving_projections where status = 'CONSUMED'"),
    );
    const despues = (await h.comoAdmin(() =>
      h.filas("select id from public.member_serving_projections where status = 'CONSUMED'"),
    )).length;
    expect(despues).toBe(antes);
  });
});

describe("[G-3] meal_participants exige pertenecer al hogar", () => {
  it("el hogar B no puede enumerar quién come en una comida de A", async () => {
    const asignacion = (await h.comoAdmin(() =>
      h.fila<{ id: string }>("select id from public.meal_assignments limit 1"),
    ))!.id;
    await expect(
      h.como(USER_B, () => h.db.query("select * from public.meal_participants($1)", [asignacion])),
    ).rejects.toThrow(/no autorizado/);
    // El dueño sí.
    const suyos = await h.como(USER_A, () =>
      h.filas("select * from public.meal_participants($1)", [asignacion]),
    );
    expect(suyos.length).toBeGreaterThan(0);
  });
});

describe("[A-1] la sustitución aceptada se PERSISTE y sobrevive", () => {
  it("se guarda por comida+integrante+componente y es idempotente", async () => {
    // Comida NUEVA: la del test anterior quedó CONSUMED y su historia está
    // protegida (esa guarda se prueba aparte).
    const plan = await h.como(USER_A, async () =>
      (await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, (date_trunc('week', current_date + 7))::date)",
        [A.householdId],
      ))!.ensure_weekly_plan,
    );
    const dia = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
        [plan],
      ),
    ))!.id;
    const asignacion = (await h.como(USER_A, () =>
      h.fila<{ id: string; version_id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
         select $1, 'DINNER', 'RECIPE', v.template_id, v.id
         from public.meal_template_versions v
         join public.meal_templates t on t.id = v.template_id
         where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED' limit 1
         returning id, version_id`,
        [dia],
      ),
    ))!;
    const componente = (await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `select c.id from public.meal_slot_components c
         join public.meal_slots s on s.id = c.slot_id
         where s.version_id = $1 and c.ingredient_id = $2 limit 1`,
        [asignacion.version_id, polloId],
      ),
    ))!.id;
    const merluza = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'merluza'",
    ))!.id;

    const primera = await h.como(USER_A, async () =>
      (await h.fila<{ set_substitution_choice: string }>(
        "select public.set_substitution_choice($1, $2, $3, $4)",
        [asignacion.id, A.memberId, componente, merluza],
      ))!.set_substitution_choice,
    );
    const segunda = await h.como(USER_A, async () =>
      (await h.fila<{ set_substitution_choice: string }>(
        "select public.set_substitution_choice($1, $2, $3, $4)",
        [asignacion.id, A.memberId, componente, merluza],
      ))!.set_substitution_choice,
    );
    expect(segunda).toBe(primera); // idempotente

    const guardadas = await h.como(USER_A, () =>
      h.filas("select id from public.meal_substitution_choices where assignment_id = $1", [asignacion.id]),
    );
    expect(guardadas).toHaveLength(1);
  });

  it("el hogar B no puede elegir reemplazos en comidas de A", async () => {
    const asignacion = (await h.comoAdmin(() =>
      h.fila<{ id: string }>("select id from public.meal_assignments limit 1"),
    ))!.id;
    const merluza = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'merluza'",
    ))!.id;
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.set_substitution_choice($1, $2, $3, $4)", [
          asignacion,
          B.memberId,
          "00000000-0000-0000-0000-0000000000ff",
          merluza,
        ]),
      ),
    ).rejects.toThrow(/no autorizado/);
  });
});
