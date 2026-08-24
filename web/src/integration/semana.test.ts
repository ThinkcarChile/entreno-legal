import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { dateString } from "@/lib/supabase/rows";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Integración del Sprint 5: la semana, los eventos y — sobre todo — que
 * confirmar una comida deje las porciones GUARDADAS con todas sus versiones.
 *
 * Una proyección que solo vive en pantalla no sirve para responder, meses
 * después, por qué se sirvió lo que se sirvió.
 */

const USER_A = "00000000-0000-0000-0000-0000000000c1";
const USER_B = "00000000-0000-0000-0000-0000000000c2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
let versionPollo: string;
let planId: string;
let asignacion: string;
let perfilId: string;

const SEMANA = weekStart("2026-09-02"); // miércoles -> lunes 2026-08-31

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Semana A", "Ana");
  hogarB = await crearHogar(h, USER_B, "Hogar Semana B", "Beto");

  await h.como(USER_A, async () => {
    await h.db.query("select public.seed_demo_family_profiles($1)", [hogarA.householdId]);

    const perfil = await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'FULL', 'firma-semana', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'prueba')`,
      [hogarA.memberId],
    );
    perfilId = perfil!.publish_nutrition_profile;
  });

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("la semana se crea con sus siete días", () => {
  it("ensure_weekly_plan es idempotente", async () => {
    await h.como(USER_A, async () => {
      const primera = await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, $2)",
        [hogarA.householdId, SEMANA],
      );
      const segunda = await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, $2)",
        [hogarA.householdId, SEMANA],
      );
      expect(primera!.ensure_weekly_plan).toBe(segunda!.ensure_weekly_plan);
      planId = primera!.ensure_weekly_plan;

      const dias = await h.filas("select 1 from public.weekly_plan_days where plan_id = $1", [
        planId,
      ]);
      expect(dias).toHaveLength(7);
    });
  });

  it("la semana empieza un lunes", async () => {
    const dias = await h.como(USER_A, () =>
      h.filas<{ plan_date: string }>(
        "select plan_date from public.weekly_plan_days where plan_id = $1 order by plan_date",
        [planId],
      ),
    );
    // Se normaliza con el MISMO schema que usa la aplicación: una columna date
    // puede llegar como texto o como Date, y convertirla mal corre el día.
    expect(dateString.parse(dias[0]!.plan_date)).toBe("2026-08-31");
    expect(dias).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
describe("asignar una comida", () => {
  it("una receta necesita versión; una salida a comer, no", async () => {
    await h.como(USER_A, async () => {
      const dia = await h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
        [planId],
      );

      const creada = await h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, version_id)
         values ($1, 'LUNCH', 'RECIPE', $2) returning id`,
        [dia!.id, versionPollo],
      );
      asignacion = creada!.id;

      // Comer afuera no lleva receta y se acepta igual.
      await h.db.query(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'DINNER', 'EAT_OUT')`,
        [dia!.id],
      );

      // Pero una receta SIN versión no puede guardarse.
      let falló = false;
      try {
        await h.db.query(
          `insert into public.meal_assignments (day_id, meal_type, kind)
           values ($1, 'TEA', 'RECIPE')`,
          [dia!.id],
        );
      } catch {
        falló = true;
      }
      expect(falló).toBe(true);
    });
  });

  it("una sola comida por día y tipo", async () => {
    await h.como(USER_A, async () => {
      const dia = await h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
        [planId],
      );
      let falló = false;
      try {
        await h.db.query(
          `insert into public.meal_assignments (day_id, meal_type, kind, version_id)
           values ($1, 'LUNCH', 'RECIPE', $2)`,
          [dia!.id, versionPollo],
        );
      } catch {
        falló = true;
      }
      expect(falló).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
describe("confirmar una comida deja todo guardado", () => {
  const porciones = () => [
    {
      member_id: hogarA.memberId,
      version_id: versionPollo,
      profile_id: perfilId,
      optimizer_version: "portion-optimizer/1.0.0",
      meal_type: "LUNCH",
      serving_date: "2026-08-31",
      fit: "COMPATIBLE_WITH_PORTION_CHANGE",
      adaptation_level: 1,
      score: 92.5,
      nutrition: { energy_kcal: 584, protein_g: 65 },
      completeness: { energy_kcal: "COMPLETE", phosphorus_mg: "PARTIAL" },
      reasons: [{ code: "PROTEIN_TARGET", text: "Subimos el pollo." }],
      unmet_constraints: [],
      components: [
        {
          label: "Pechuga de pollo (sin piel)",
          base_quantity: 180,
          proposed_quantity: 255,
          unit: "G",
          weight_basis: "RAW",
          cooking_method: "AIR_FRYER",
          added_fat_g: 0,
          sort_order: 1,
        },
        {
          label: "Arroz blanco",
          base_quantity: 75,
          proposed_quantity: 75,
          unit: "G",
          weight_basis: "RAW",
          cooking_method: "BOILED",
          added_fat_g: 0,
          sort_order: 2,
        },
      ],
      substitutions: [] as unknown[],
    },
  ];

  it("guarda porciones, componentes y actualiza el estado", async () => {
    const guardadas = await h.como(USER_A, () =>
      h.fila<{ confirm_meal_assignment: number }>(
        "select public.confirm_meal_assignment($1, $2::jsonb)",
        [asignacion, JSON.stringify(porciones())],
      ),
    );
    expect(Number(guardadas!.confirm_meal_assignment)).toBe(1);

    const estado = await h.como(USER_A, () =>
      h.fila<{ status: string; confirmed_at: string | null }>(
        "select status, confirmed_at from public.meal_assignments where id = $1",
        [asignacion],
      ),
    );
    expect(estado!.status).toBe("CONFIRMED");
    expect(estado!.confirmed_at).not.toBeNull();

    const componentes = await h.como(USER_A, () =>
      h.filas<{ label: string; proposed_quantity: string }>(
        `select c.label, c.proposed_quantity
         from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1 order by c.sort_order`,
        [asignacion],
      ),
    );
    expect(componentes).toHaveLength(2);
    expect(Number(componentes[0]!.proposed_quantity)).toBeCloseTo(255, 3);
  });

  it("guarda las versiones que produjeron el cálculo", async () => {
    const fila = await h.como(USER_A, () =>
      h.fila<{ optimizer_version: string; version_id: string; profile_id: string }>(
        `select optimizer_version, version_id, profile_id
         from public.member_serving_projections where assignment_id = $1`,
        [asignacion],
      ),
    );
    expect(fila!.optimizer_version).toBe("portion-optimizer/1.0.0");
    expect(fila!.version_id).toBe(versionPollo);
    expect(fila!.profile_id).toBe(perfilId);
  });

  it("confirmar dos veces reemplaza, no duplica", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        asignacion,
        JSON.stringify(porciones()),
      ]);
      const filas = await h.filas(
        "select 1 from public.member_serving_projections where assignment_id = $1",
        [asignacion],
      );
      expect(filas).toHaveLength(1);
    });
  });

  it("un reemplazo aceptado queda en la base, no en la URL", async () => {
    const merluza = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'merluza'",
    ))!.id;
    const pollo = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
    ))!.id;

    const conReemplazo = porciones();
    conReemplazo[0]!.substitutions = [
      { from_ingredient_id: pollo, to_ingredient_id: merluza, reason_code: "SOFT_PREFERENCE" },
    ];

    await h.como(USER_A, async () => {
      await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        asignacion,
        JSON.stringify(conReemplazo),
      ]);
    });

    const subs = await h.como(USER_A, () =>
      h.filas<{ to_ingredient_id: string; accepted_by: string | null }>(
        `select s.to_ingredient_id, s.accepted_by
         from public.member_serving_substitutions s
         join public.member_serving_projections p on p.id = s.projection_id
         where p.assignment_id = $1`,
        [asignacion],
      ),
    );
    expect(subs).toHaveLength(1);
    expect(subs[0]!.to_ingredient_id).toBe(merluza);
    // Queda registrado QUIÉN lo aceptó.
    expect(subs[0]!.accepted_by).toBe(hogarA.memberId);
  });

  it("deshacer la confirmación borra las porciones y vuelve a PLANNED", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.unconfirm_meal_assignment($1)", [asignacion]);
    });

    const estado = await h.como(USER_A, () =>
      h.fila<{ status: string; confirmed_at: string | null }>(
        "select status, confirmed_at from public.meal_assignments where id = $1",
        [asignacion],
      ),
    );
    expect(estado!.status).toBe("PLANNED");
    expect(estado!.confirmed_at).toBeNull();

    const quedan = await h.como(USER_A, () =>
      h.filas("select 1 from public.member_serving_projections where assignment_id = $1", [
        asignacion,
      ]),
    );
    expect(quedan).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("eventos de la semana", () => {
  it("se guardan con su estrategia y se leen por rango", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.nutrition_events
           (household_id, event_date, event_type, meal_type, strategy, title)
         values ($1, '2026-09-05', 'BARBECUE', 'LUNCH', 'RELAXED', 'Asado en casa')`,
        [hogarA.householdId],
      );
    });

    const eventos = await h.como(USER_A, () =>
      h.filas<{ title: string; strategy: string }>(
        `select title, strategy from public.nutrition_events
         where household_id = $1 and event_date between '2026-08-31' and '2026-09-06'`,
        [hogarA.householdId],
      ),
    );
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.title).toBe("Asado en casa");
    expect(eventos[0]!.strategy).toBe("RELAXED");
  });

  it("un rango invertido no se guarda", async () => {
    const falló = await h.como(USER_A, async () => {
      try {
        await h.db.query(
          `insert into public.nutrition_events
             (household_id, event_date, end_date, event_type, strategy, title)
           values ($1, '2026-09-05', '2026-09-01', 'TRAVEL', 'RELAXED', 'Viaje')`,
          [hogarA.householdId],
        );
        return false;
      } catch {
        return true;
      }
    });
    expect(falló).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("la semana de un hogar es privada", () => {
  it("B no ve la semana, las comidas, las porciones ni los eventos de A", async () => {
    const conteos = await h.como(USER_B, async () => ({
      semanas: (
        await h.filas("select 1 from public.weekly_plans where household_id = $1", [
          hogarA.householdId,
        ])
      ).length,
      dias: (await h.filas("select 1 from public.weekly_plan_days where plan_id = $1", [planId]))
        .length,
      comidas: (await h.filas("select 1 from public.meal_assignments")).length,
      eventos: (await h.filas("select 1 from public.nutrition_events")).length,
      porciones: (await h.filas("select 1 from public.member_serving_projections")).length,
    }));

    expect(conteos).toEqual({ semanas: 0, dias: 0, comidas: 0, eventos: 0, porciones: 0 });
  });

  it("B sí ve su propia semana: la prueba no pasa por estar todo vacío", async () => {
    const propias = await h.como(USER_B, async () => {
      await h.db.query("select public.ensure_weekly_plan($1, $2)", [hogarB.householdId, SEMANA]);
      return h.filas("select 1 from public.weekly_plans where household_id = $1", [
        hogarB.householdId,
      ]);
    });
    expect(propias.length).toBe(1);
  });

  it("B tampoco puede confirmar una comida de A", async () => {
    const falló = await h.como(USER_B, async () => {
      try {
        await h.db.query("select public.confirm_meal_assignment($1, '[]'::jsonb)", [asignacion]);
        return false;
      } catch {
        return true;
      }
    });
    expect(falló).toBe(true);
  });
});
