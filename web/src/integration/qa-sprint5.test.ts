import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { dateString } from "@/lib/supabase/rows";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * QA adversarial del Sprint 5 — las costuras que va a usar el ShoppingEngine.
 *
 * Todo corre con `set role authenticated` y el claim del usuario puesto (§19):
 * como `postgres` las políticas RLS ni se evalúan, así que una prueba de
 * seguridad ejecutada como superusuario pasa siempre y no prueba nada.
 */

const USER_A = "00000000-0000-0000-0000-0000000000d1";
const USER_B = "00000000-0000-0000-0000-0000000000d2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
/** Segundo integrante del hogar A, el que a veces come afuera. */
let hijo: string;
let versionPollo: string;
let perfilMama: string;
let perfilHijo: string;
let planId: string;
let almuerzoSabado: string;
let diaSabado: string;

const SEMANA = weekStart("2026-09-02"); // lunes 2026-08-31
const SABADO = "2026-09-05";

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar QA5 A", "Ana");
  hogarB = await crearHogar(h, USER_B, "Hogar QA5 B", "Beto");

  await h.como(USER_A, async () => {
    const creado = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, display_name)
       values ($1, 'Tomás') returning id`,
      [hogarA.householdId],
    );
    hijo = creado!.id;

    for (const miembro of [hogarA.memberId, hijo]) {
      const perfil = await h.fila<{ publish_nutrition_profile: string }>(
        `select public.publish_nutrition_profile($1, 'FULL', $2, '{}'::jsonb,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'qa5')`,
        [miembro, `firma-${miembro}`],
      );
      if (miembro === hogarA.memberId) perfilMama = perfil!.publish_nutrition_profile;
      else perfilHijo = perfil!.publish_nutrition_profile;
    }

    const plan = await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [hogarA.householdId, SEMANA],
    );
    planId = plan!.ensure_weekly_plan;

    const dia = await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planId, SABADO],
    );
    diaSabado = dia!.id;
  });

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  await h.como(USER_A, async () => {
    const asig = await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2
       returning id`,
      [diaSabado, versionPollo],
    );
    almuerzoSabado = asig!.id;
  });
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

function porcion(memberId: string, profileId: string, extra: Record<string, unknown> = {}) {
  return {
    member_id: memberId,
    version_id: versionPollo,
    profile_id: profileId,
    optimizer_version: "portion-optimizer/1.0.0",
    meal_type: "LUNCH",
    serving_date: SABADO,
    fit: "COMPATIBLE",
    adaptation_level: 0,
    score: 90,
    nutrition: { energy_kcal: 520 },
    completeness: { energy_kcal: "COMPLETE" },
    reasons: [],
    unmet_constraints: [],
    components: [
      {
        label: "Pechuga de pollo (sin piel)",
        base_quantity: 180,
        proposed_quantity: 180,
        unit: "G",
        weight_basis: "RAW",
        cooking_method: "AIR_FRYER",
        added_fat_g: 0,
        sort_order: 1,
      },
    ],
    substitutions: [] as unknown[],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// §1 Los ocho tipos de comida
// ---------------------------------------------------------------------------
describe("§1 un día puede tener más que desayuno, almuerzo, once y cena", () => {
  it("acepta postre, snack, fruta y otro en el mismo día, uno de cada tipo", async () => {
    await h.como(USER_A, async () => {
      for (const tipo of ["DESSERT", "SNACK", "FRUIT", "OTHER"]) {
        await h.db.query(
          `insert into public.meal_assignments (day_id, meal_type, kind) values ($1, $2, 'FREE')`,
          [diaSabado, tipo],
        );
      }
      const tipos = await h.filas<{ meal_type: string }>(
        "select meal_type from public.meal_assignments where day_id = $1",
        [diaSabado],
      );
      expect(tipos.map((t) => t.meal_type).sort()).toEqual(
        ["DESSERT", "FRUIT", "LUNCH", "OTHER", "SNACK"].sort(),
      );
    });
  });

  it("dos comidas del mismo tipo el mismo día chocan a propósito", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query(
          `insert into public.meal_assignments (day_id, meal_type, kind) values ($1, 'SNACK', 'FREE')`,
          [diaSabado],
        ),
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });
});

// ---------------------------------------------------------------------------
// §2 Participantes por comida
// ---------------------------------------------------------------------------
describe("§2 no siempre comen todos", () => {
  it("sin filas de participantes, participa toda la familia activa", async () => {
    const quienes = await h.como(USER_A, () =>
      h.filas<{ member_id: string }>("select member_id from public.meal_participants($1)", [
        almuerzoSabado,
      ]),
    );
    expect(quienes.map((q) => q.member_id).sort()).toEqual([hogarA.memberId, hijo].sort());
  });

  it("marcando a una persona, el resto queda fuera", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "insert into public.meal_assignment_participants (assignment_id, member_id) values ($1, $2)",
        [almuerzoSabado, hogarA.memberId],
      );
      const quienes = await h.filas<{ member_id: string }>(
        "select member_id from public.meal_participants($1)",
        [almuerzoSabado],
      );
      expect(quienes).toHaveLength(1);
      expect(quienes[0]!.member_id).toBe(hogarA.memberId);
    });
  });

  it("confirmar rechaza la porción de alguien que no participa", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          almuerzoSabado,
          JSON.stringify([porcion(hogarA.memberId, perfilMama), porcion(hijo, perfilHijo)]),
        ]),
      ),
    ).rejects.toThrow(/no participan/i);
  });

  it("confirma bien con solo el participante, y el que come afuera no suma al total", async () => {
    const guardadas = await h.como(USER_A, () =>
      h.fila<{ confirm_meal_assignment: number }>(
        "select public.confirm_meal_assignment($1, $2::jsonb)",
        [almuerzoSabado, JSON.stringify([porcion(hogarA.memberId, perfilMama)])],
      ),
    );
    expect(Number(guardadas!.confirm_meal_assignment)).toBe(1);

    // Esto es exactamente lo que va a leer el ShoppingEngine: 180 g de pollo,
    // no 360 g. Comprar para alguien que no está es plata y comida a la basura.
    const total = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        `select coalesce(sum(c.proposed_quantity), 0) as total
         from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1`,
        [almuerzoSabado],
      ),
    );
    expect(Number(total!.total)).toBe(180);
  });

  it("volver a incluir a todos borra las filas y vuelve al caso normal", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "delete from public.meal_assignment_participants where assignment_id = $1",
        [almuerzoSabado],
      );
      const quienes = await h.filas("select 1 from public.meal_participants($1)", [almuerzoSabado]);
      expect(quienes).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// §12 y §13 Ciclo de vida de una porción
// ---------------------------------------------------------------------------
describe("§13 una porción servida es historia", () => {
  it("reconfirmar cuenta las veces, mientras nadie haya comido", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        almuerzoSabado,
        JSON.stringify([porcion(hogarA.memberId, perfilMama), porcion(hijo, perfilHijo)]),
      ]);
      const fila = await h.fila<{ confirm_count: number; last_confirmed_at: string | null }>(
        "select confirm_count, last_confirmed_at from public.meal_assignments where id = $1",
        [almuerzoSabado],
      );
      expect(Number(fila!.confirm_count)).toBeGreaterThanOrEqual(2);
      expect(fila!.last_confirmed_at).not.toBeNull();
    });
  });

  it("cada confirmación deja su propio evento en el outbox, sin pisarse", async () => {
    const eventos = await h.como(USER_A, () =>
      h.filas<{ dedupe_key: string }>(
        `select dedupe_key from public.domain_events
         where event_type = 'MEAL_CONFIRMED' and payload->>'assignment_id' = $1`,
        [almuerzoSabado],
      ),
    );
    expect(eventos.length).toBeGreaterThanOrEqual(2);
    expect(new Set(eventos.map((e) => e.dedupe_key)).size).toBe(eventos.length);
  });

  it("una vez servida, reconfirmar falla en vez de pisar el registro", async () => {
    // Gate 0→10 [D-2]: el cliente ya NO puede tocar el estado de una porción
    // (la policy es solo-lectura). Se prepara el escenario como lo hace el
    // sistema — desde la base, igual que consume_planned_meal.
    await h.comoAdmin(async () => {
      await h.db.query(
        "update public.member_serving_projections set status = 'SERVED' where assignment_id = $1",
        [almuerzoSabado],
      );
    });

    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          almuerzoSabado,
          JSON.stringify([porcion(hogarA.memberId, perfilMama)]),
        ]),
      ),
    ).rejects.toThrow(/ya se sirvió/i);
  });

  it("deshacer tampoco borra lo que ya se comió", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.unconfirm_meal_assignment($1)", [almuerzoSabado]),
      ),
    ).rejects.toThrow(/ya se sirvió/i);

    const quedan = await h.como(USER_A, () =>
      h.filas("select 1 from public.member_serving_projections where assignment_id = $1", [
        almuerzoSabado,
      ]),
    );
    expect(quedan).toHaveLength(2);
  });

  it("CONSUMED y CANCELLED existen como estados", async () => {
    const valores = await h.filas<{ enumlabel: string }>(
      `select enumlabel from pg_enum e
       join pg_type t on t.oid = e.enumtypid where t.typname = 'serving_status'`,
    );
    expect(valores.map((v) => v.enumlabel).sort()).toEqual(
      ["CANCELLED", "CONSUMED", "PLANNED", "SERVED", "SKIPPED"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// §18 Cambiar un evento no reescribe porciones confirmadas
// ---------------------------------------------------------------------------
describe("§18 un evento nuevo marca para revisión, no recalcula solo", () => {
  it("agregar un evento ese día deja la comida marcada y las porciones intactas", async () => {
    const antes = await h.como(USER_A, () =>
      h.filas<{ id: string; proposed_quantity: string }>(
        `select c.id, c.proposed_quantity from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1 order by c.id`,
        [almuerzoSabado],
      ),
    );

    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.nutrition_events
           (household_id, event_date, event_type, meal_type, strategy, title)
         values ($1, $2, 'BIRTHDAY', 'LUNCH', 'RELAXED', 'Cumpleaños del Tomás')`,
        [hogarA.householdId, SABADO],
      );
    });

    const marca = await h.como(USER_A, () =>
      h.fila<{ needs_review: boolean; review_reason: string | null }>(
        "select needs_review, review_reason from public.meal_assignments where id = $1",
        [almuerzoSabado],
      ),
    );
    expect(marca!.needs_review).toBe(true);
    expect(marca!.review_reason).toMatch(/evento/i);

    const despues = await h.como(USER_A, () =>
      h.filas<{ id: string; proposed_quantity: string }>(
        `select c.id, c.proposed_quantity from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1 order by c.id`,
        [almuerzoSabado],
      ),
    );
    expect(despues).toEqual(antes);
  });

  it("cancelar el evento también marca: la comida vuelve a no cuadrar", async () => {
    // SE CANCELA, NO SE BORRA. La 0041 le puso un candado a esta tabla: un
    // evento que ya salio del borrador no se puede borrar, porque su historia
    // queda ("este evento ya salio del borrador: se cancela, no se borra").
    // Antes esta prueba hacia un DELETE y desde esa migracion muere ahi.
    //
    // La garantia del §18 no se perdio, cambio de verbo: `flag_meals_on_event_change`
    // dispara en INSERT, UPDATE y DELETE, asi que pasar a CANCELLED marca igual
    // —y la version de la 0041 ademas arreglo que solo marcaba el primer dia,
    // que dejaba un viaje de tres dias con los dias 2 y 3 desalineados en
    // silencio—. Lo que se comprueba sigue siendo lo mismo: cuando el evento
    // deja de aplicar, la comida vuelve a no cuadrar.
    await h.como(USER_A, async () => {
      await h.db.query(
        "update public.meal_assignments set needs_review = false, review_reason = null where id = $1",
        [almuerzoSabado],
      );
      await h.db.query(
        "update public.nutrition_events set status = 'CANCELLED' where household_id = $1",
        [hogarA.householdId],
      );
    });

    const marca = await h.como(USER_A, () =>
      h.fila<{ needs_review: boolean }>(
        "select needs_review from public.meal_assignments where id = $1",
        [almuerzoSabado],
      ),
    );
    expect(marca!.needs_review).toBe(true);
  });

  it("un evento de OTRO hogar no marca nada acá", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "update public.meal_assignments set needs_review = false where id = $1",
        [almuerzoSabado],
      );
    });

    await h.como(USER_B, async () => {
      await h.db.query(
        `insert into public.nutrition_events (household_id, event_date, event_type, strategy, title)
         values ($1, $2, 'BARBECUE', 'RELAXED', 'Asado del Beto')`,
        [hogarB.householdId, SABADO],
      );
    });

    const marca = await h.como(USER_A, () =>
      h.fila<{ needs_review: boolean }>(
        "select needs_review from public.meal_assignments where id = $1",
        [almuerzoSabado],
      ),
    );
    expect(marca!.needs_review).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §19 RLS de las tablas nuevas, con rol authenticated
// ---------------------------------------------------------------------------
describe("§19 lo del hogar A no se ve desde el hogar B", () => {
  it("los participantes de una comida ajena no se leen", async () => {
    // Desde el Sprint 6 (§0B) confirmar ya materializa las filas de
    // participantes, así que esta puede existir: se asegura, no se re-inserta.
    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.meal_assignment_participants (assignment_id, member_id)
         values ($1, $2) on conflict do nothing`,
        [almuerzoSabado, hogarA.memberId],
      );
    });

    const desdeB = await h.como(USER_B, () =>
      h.filas("select 1 from public.meal_assignment_participants where assignment_id = $1", [
        almuerzoSabado,
      ]),
    );
    expect(desdeB).toHaveLength(0);
  });

  it("tampoco se pueden agregar comensales a una comida ajena", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "insert into public.meal_assignment_participants (assignment_id, member_id) values ($1, $2)",
          [almuerzoSabado, hogarB.memberId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("las porciones guardadas del hogar A no se leen desde B", async () => {
    const desdeB = await h.como(USER_B, () =>
      h.filas("select 1 from public.member_serving_projections where assignment_id = $1", [
        almuerzoSabado,
      ]),
    );
    expect(desdeB).toHaveLength(0);
  });

  it("los eventos de un hogar no se ven desde el otro", async () => {
    const desdeA = await h.como(USER_A, () =>
      h.filas("select 1 from public.nutrition_events where household_id = $1", [
        hogarB.householdId,
      ]),
    );
    expect(desdeA).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6 y §7 Fechas y bordes de semana
// ---------------------------------------------------------------------------
describe("§7 los bordes de la semana", () => {
  it("el domingo pertenece a su semana y el lunes siguiente a la otra", async () => {
    const dias = await h.como(USER_A, () =>
      h.filas<{ plan_date: string }>(
        "select plan_date from public.weekly_plan_days where plan_id = $1 order by plan_date",
        [planId],
      ),
    );
    const fechas = dias.map((d) => dateString.parse(d.plan_date));
    expect(fechas[0]).toBe("2026-08-31");
    expect(fechas[6]).toBe("2026-09-06");
    expect(fechas).toHaveLength(7);
  });

  it("dos semanas seguidas no comparten días", async () => {
    const siguiente = await h.como(USER_A, () =>
      h.fila<{ ensure_weekly_plan: string }>("select public.ensure_weekly_plan($1, $2)", [
        hogarA.householdId,
        "2026-09-07",
      ]),
    );
    const dias = await h.como(USER_A, () =>
      h.filas<{ plan_date: string }>(
        "select plan_date from public.weekly_plan_days where plan_id = $1 order by plan_date",
        [siguiente!.ensure_weekly_plan],
      ),
    );
    const fechas = dias.map((d) => dateString.parse(d.plan_date));
    expect(fechas[0]).toBe("2026-09-07");
    expect(fechas).toHaveLength(7);
  });

  it("una fecha DATE-only no se corre un día al leerla", async () => {
    const fila = await h.como(USER_A, () =>
      h.fila<{ serving_date: string }>(
        "select serving_date from public.member_serving_projections where assignment_id = $1 limit 1",
        [almuerzoSabado],
      ),
    );
    expect(dateString.parse(fila!.serving_date)).toBe(SABADO);
  });
});
