import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Integración del Sprint 6 — ShoppingEngine sobre PostgreSQL real.
 *
 * Lo central acá son las garantías que el motor NO puede dar solo desde el
 * dominio: que los participantes quedan congelados al confirmar (§0B), que un
 * integrante nuevo no se cuela en comidas históricas (§42), que las revisiones
 * son auditables (§49) y que un hogar no ve las listas del otro (§50) — todo
 * con rol authenticated de verdad, nunca superusuario.
 */

const USER_A = "00000000-0000-0000-0000-0000000000e1";
const USER_B = "00000000-0000-0000-0000-0000000000e2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
/** Cuatro integrantes más del hogar A (cinco en total). */
const familia: string[] = [];
let versionPollo: string;
let perfiles: Map<string, string>;
let planId: string;
let almuerzoLunes: string;
let listaA: string;

const SEMANA = weekStart("2026-09-14"); // lunes 2026-09-14
const LUNES = "2026-09-14";

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Compras A", "Fran");
  hogarB = await crearHogar(h, USER_B, "Hogar Compras B", "Vecino");
  perfiles = new Map();

  await h.como(USER_A, async () => {
    for (const nombre of ["Paula", "Sebastián", "Constanza", "Ricardo"]) {
      const fila = await h.fila<{ id: string }>(
        `insert into public.household_members (household_id, display_name)
         values ($1, $2) returning id`,
        [hogarA.householdId, nombre],
      );
      familia.push(fila!.id);
    }

    for (const miembro of [hogarA.memberId, ...familia]) {
      const perfil = await h.fila<{ publish_nutrition_profile: string }>(
        `select public.publish_nutrition_profile($1, 'BASIC', $2, '{}'::jsonb,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'compras')`,
        [miembro, `firma-compras-${miembro}`],
      );
      perfiles.set(miembro, perfil!.publish_nutrition_profile);
    }

    const plan = await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [hogarA.householdId, SEMANA],
    );
    planId = plan!.ensure_weekly_plan;
  });

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  await h.como(USER_A, async () => {
    const dia = await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planId, LUNES],
    );
    const asig = await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2
       returning id`,
      [dia!.id, versionPollo],
    );
    almuerzoLunes = asig!.id;
  });
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

function porcion(memberId: string, extra: Record<string, unknown> = {}) {
  return {
    member_id: memberId,
    version_id: versionPollo,
    profile_id: perfiles.get(memberId),
    optimizer_version: "portion-optimizer/1.0.0",
    meal_type: "LUNCH",
    serving_date: LUNES,
    fit: "COMPATIBLE",
    adaptation_level: 0,
    score: 90,
    nutrition: { energy_kcal: 500 },
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
        cooking_method: "BAKED",
        added_fat_g: 0,
        sort_order: 1,
        ingredient_id: null as string | null,
      },
    ],
    substitutions: [] as unknown[],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
describe("§0B los participantes se congelan al confirmar", () => {
  it("antes de confirmar no hay filas: 'todos' es dinámico", async () => {
    const filas = await h.como(USER_A, () =>
      h.filas("select 1 from public.meal_assignment_participants where assignment_id = $1", [
        almuerzoLunes,
      ]),
    );
    expect(filas).toHaveLength(0);
  });

  it("confirmar materializa el conjunto exacto de cinco", async () => {
    const pollo = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
    ))!.id;

    const todos = [hogarA.memberId, ...familia];
    await h.como(USER_A, async () => {
      const payload = todos.map((m) => {
        const p = porcion(m);
        (p.components[0] as { ingredient_id: string | null }).ingredient_id = pollo;
        return p;
      });
      await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        almuerzoLunes,
        JSON.stringify(payload),
      ]);
    });

    const congelados = await h.como(USER_A, () =>
      h.filas("select member_id from public.meal_assignment_participants where assignment_id = $1", [
        almuerzoLunes,
      ]),
    );
    expect(congelados).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
describe("§42 REGRESIÓN: el sexto integrante no entra a comidas históricas", () => {
  let sexto: string;

  it("se agrega un sexto integrante al hogar", async () => {
    sexto = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.household_members (household_id, display_name)
         values ($1, 'Bebé nuevo') returning id`,
        [hogarA.householdId],
      ),
    ))!.id;
    expect(sexto).toBeTruthy();
  });

  it("la comida confirmada sigue siendo de cinco: participantes y porciones", async () => {
    await h.como(USER_A, async () => {
      const participantes = await h.filas(
        "select 1 from public.meal_participants($1)",
        [almuerzoLunes],
      );
      expect(participantes).toHaveLength(5);

      // Lo que el ShoppingEngine lee de verdad: las porciones confirmadas.
      const porciones = await h.filas(
        "select 1 from public.member_serving_projections where assignment_id = $1",
        [almuerzoLunes],
      );
      expect(porciones).toHaveLength(5);
    });
  });

  it("la demanda total no incluye al sexto: 5 × 180 g, no 6 × 180 g", async () => {
    const total = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        `select sum(c.proposed_quantity) as total
         from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1`,
        [almuerzoLunes],
      ),
    );
    expect(Number(total!.total)).toBe(900);
  });
});

// ---------------------------------------------------------------------------
describe("§3 la identidad del alimento quedó congelada en la fila", () => {
  it("cada componente confirmado sabe qué ingrediente es, sin joins frágiles", async () => {
    const filas = await h.como(USER_A, () =>
      h.filas<{ ingredient_id: string | null }>(
        `select c.ingredient_id
         from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1`,
        [almuerzoLunes],
      ),
    );
    expect(filas).toHaveLength(5);
    for (const fila of filas) expect(fila.ingredient_id).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("§48 una versión nueva de la receta no cambia la demanda histórica", () => {
  it("la receta global publicada no se puede editar: RLS deja el update en 0 filas", async () => {
    const antes = await h.fila<{ suma: string }>(
      `select sum(quantity) as suma from public.meal_slot_components
       where slot_id in (select id from public.meal_slots where version_id = $1)`,
      [versionPollo],
    );
    await h.como(USER_A, async () => {
      await h.db.query(
        `update public.meal_slot_components set quantity = quantity * 2
         where slot_id in (select id from public.meal_slots where version_id = $1)`,
        [versionPollo],
      );
    });
    const despues = await h.fila<{ suma: string }>(
      `select sum(quantity) as suma from public.meal_slot_components
       where slot_id in (select id from public.meal_slots where version_id = $1)`,
      [versionPollo],
    );
    expect(despues!.suma).toBe(antes!.suma);
  });

  it("los componentes confirmados conservan sus cantidades tras publicar una versión nueva", async () => {
    const antes = await h.como(USER_A, () =>
      h.filas<{ proposed_quantity: string }>(
        `select c.proposed_quantity from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1 order by c.id`,
        [almuerzoLunes],
      ),
    );

    // Copia de la receta al hogar, borrador al doble, publicada.
    await h.como(USER_A, async () => {
      const template = (await h.fila<{ template_id: string }>(
        "select template_id from public.meal_template_versions where id = $1",
        [versionPollo],
      ))!.template_id;
      const copia = await h.fila<{ duplicate_meal_template: string }>(
        "select public.duplicate_meal_template($1, $2, 'Pollo doble')",
        [template, hogarA.householdId],
      );
      const borrador = (await h.fila<{ id: string }>(
        `select id from public.meal_template_versions
         where template_id = $1 and status = 'DRAFT'`,
        [copia!.duplicate_meal_template],
      ))!.id;
      await h.db.query(
        `update public.meal_slot_components set quantity = quantity * 2
         where slot_id in (select id from public.meal_slots where version_id = $1)`,
        [borrador],
      );
      await h.db.query("select public.publish_meal_template_version($1)", [borrador]);
    });

    const despues = await h.como(USER_A, () =>
      h.filas<{ proposed_quantity: string }>(
        `select c.proposed_quantity from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1 order by c.id`,
        [almuerzoLunes],
      ),
    );
    expect(despues).toEqual(antes);
  });

  it("y la copia del hogar, ya publicada, tampoco se puede editar", async () => {
    // La política de escritura solo alcanza borradores (v.status = 'DRAFT'):
    // para authenticated el update simplemente no encuentra filas. El trigger
    // de inmutabilidad queda como segundo cinturón para caminos con definer.
    const publicada = (await h.fila<{ id: string }>(
      `select v.id from public.meal_template_versions v
       join public.meal_templates t on t.id = v.template_id
       where t.name = 'Pollo doble' and v.status = 'PUBLISHED' and t.household_id = $1`,
      [hogarA.householdId],
    ))!.id;
    const antes = await h.fila<{ suma: string }>(
      `select sum(quantity) as suma from public.meal_slot_components
       where slot_id in (select id from public.meal_slots where version_id = $1)`,
      [publicada],
    );
    await h.como(USER_A, async () => {
      await h.db.query(
        `update public.meal_slot_components set quantity = quantity + 1
         where slot_id in (select id from public.meal_slots where version_id = $1)`,
        [publicada],
      );
    });
    const despues = await h.fila<{ suma: string }>(
      `select sum(quantity) as suma from public.meal_slot_components
       where slot_id in (select id from public.meal_slots where version_id = $1)`,
      [publicada],
    );
    expect(despues!.suma).toBe(antes!.suma);
  });
});

// ---------------------------------------------------------------------------
describe("§49/§51 revisiones de la lista", () => {
  it("la lista se crea una vez por semana, con revisiones numeradas", async () => {
    listaA = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, created_by)
         values ($1, $2, $3) returning id`,
        [hogarA.householdId, planId, hogarA.memberId],
      ),
    ))!.id;

    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.shopping_list_revisions
           (list_id, revision_number, input_signature, engine_version, payload)
         values ($1, 1, 'firma-v1', 'shopping-engine/1.0.0', '[{"label":"Pollo","requiredQuantity":900}]'::jsonb)`,
        [listaA],
      );
      await h.db.query(
        `insert into public.shopping_list_revisions
           (list_id, revision_number, input_signature, engine_version, payload, reasons)
         values ($1, 2, 'firma-v2', 'shopping-engine/1.0.0',
                 '[{"label":"Pollo","requiredQuantity":720}]'::jsonb,
                 '[{"label":"Pollo","kind":"QUANTITY_DECREASED","difference":-180}]'::jsonb)`,
        [listaA],
      );
    });

    await h.como(USER_A, async () => {
      await h.db.query("update public.shopping_lists set current_revision = 2 where id = $1", [
        listaA,
      ]);
    });

    // §49: la v1 sigue auditable después de la v2.
    const v1 = await h.como(USER_A, () =>
      h.fila<{ payload: unknown }>(
        "select payload from public.shopping_list_revisions where list_id = $1 and revision_number = 1",
        [listaA],
      ),
    );
    expect(v1).not.toBeNull();
    expect(JSON.stringify(v1!.payload)).toContain("900");
  });

  it("dos listas para el mismo plan chocan a propósito", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query(
          "insert into public.shopping_lists (household_id, plan_id) values ($1, $2)",
          [hogarA.householdId, planId],
        ),
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it("dos revisiones con el mismo número chocan a propósito", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query(
          `insert into public.shopping_list_revisions
             (list_id, revision_number, input_signature, engine_version, payload)
           values ($1, 2, 'otra', 'shopping-engine/1.0.0', '[]'::jsonb)`,
          [listaA],
        ),
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });
});

// ---------------------------------------------------------------------------
describe("§21/§22 la cantidad editada no pisa la calculada", () => {
  let itemId: string;

  it("el item guarda requerido y planificado por separado", async () => {
    itemId = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.shopping_list_items
           (list_id, source, line_key, label, unit, required_quantity, purchase_basis)
         values ($1, 'FOOD_PLAN', 'k1', 'Pechuga de pollo', 'G', 1850, 'RAW')
         returning id`,
        [listaA],
      ),
    ))!.id;

    await h.como(USER_A, async () => {
      await h.db.query(
        "update public.shopping_list_items set planned_quantity = 2000 where id = $1",
        [itemId],
      );
      await h.db.query(
        `insert into public.shopping_item_overrides (item_id, original_quantity, new_quantity, changed_by, reason)
         values ($1, 1850, 2000, $2, 'redondear al kilo')`,
        [itemId, hogarA.memberId],
      );
    });

    const item = await h.como(USER_A, () =>
      h.fila<{ required_quantity: string; planned_quantity: string }>(
        "select required_quantity, planned_quantity from public.shopping_list_items where id = $1",
        [itemId],
      ),
    );
    expect(Number(item!.required_quantity)).toBe(1850); // el cálculo no se perdió
    expect(Number(item!.planned_quantity)).toBe(2000);

    const auditoria = await h.como(USER_A, () =>
      h.fila<{ reason: string; changed_by: string }>(
        "select reason, changed_by from public.shopping_item_overrides where item_id = $1",
        [itemId],
      ),
    );
    expect(auditoria!.reason).toBe("redondear al kilo");
    expect(auditoria!.changed_by).toBe(hogarA.memberId);
  });
});

// ---------------------------------------------------------------------------
describe("§52 un producto manual no toca la demanda calculada", () => {
  it("el detergente convive con los alimentos sin mezclarse", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.shopping_list_items (list_id, source, label, unit, planned_quantity, purchase_basis)
         values ($1, 'MANUAL', 'Detergente', 'UNIT', 1, 'OTHER')`,
        [listaA],
      );
    });

    const porFuente = await h.como(USER_A, () =>
      h.filas<{ source: string; label: string }>(
        "select source, label from public.shopping_list_items where list_id = $1 order by label",
        [listaA],
      ),
    );
    expect(porFuente.find((i) => i.label === "Detergente")!.source).toBe("MANUAL");
    expect(porFuente.find((i) => i.label === "Pechuga de pollo")!.source).toBe("FOOD_PLAN");
  });
});

// ---------------------------------------------------------------------------
describe("§50 RLS: el hogar B no ve ni toca la lista del A", () => {
  it("no la lee", async () => {
    const filas = await h.como(USER_B, () =>
      h.filas("select 1 from public.shopping_lists where id = $1", [listaA]),
    );
    expect(filas).toHaveLength(0);
  });

  it("no lee sus items ni sus revisiones", async () => {
    const items = await h.como(USER_B, () =>
      h.filas("select 1 from public.shopping_list_items where list_id = $1", [listaA]),
    );
    expect(items).toHaveLength(0);
    const revisiones = await h.como(USER_B, () =>
      h.filas("select 1 from public.shopping_list_revisions where list_id = $1", [listaA]),
    );
    expect(revisiones).toHaveLength(0);
  });

  it("no puede marcar comprado un item ajeno", async () => {
    await h.como(USER_B, async () => {
      await h.db.query(
        "update public.shopping_list_items set status = 'PURCHASED' where list_id = $1",
        [listaA],
      );
    });
    // RLS silencia el update (0 filas): el estado no cambió.
    const estados = await h.como(USER_A, () =>
      h.filas<{ status: string }>(
        "select status from public.shopping_list_items where list_id = $1",
        [listaA],
      ),
    );
    expect(estados.every((e) => e.status === "PENDING")).toBe(true);
  });

  it("no puede crear una lista sobre el plan del hogar A", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "insert into public.shopping_lists (household_id, plan_id) values ($1, $2)",
          [hogarB.householdId, planId],
        ),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("§0A la configuración del evento queda congelada en la porción", () => {
  it("event_effect se guarda con versión y parámetros", async () => {
    // Reconfirmar la comida con un efecto de evento explícito.
    const pollo = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
    ))!.id;

    await h.como(USER_A, async () => {
      // Las cinco porciones de nuevo; el efecto de evento solo sobre Fran.
      const payload = [hogarA.memberId, ...familia].map((m) => {
        const p = porcion(m, m === hogarA.memberId ? {
          event_effect: {
            strategy_version: "event-strategy/1.0.0",
            kind: "RELAXED",
            event_id: null,
            event_title: "Asado de prueba",
            params: {
              energy_ceiling_multiplier: 1.25,
              around_target_multiplier: 0.9,
              minimum_floor_policy: "NEVER_BELOW_DECLARED_MINIMUM",
            },
          },
        } : {});
        (p.components[0] as { ingredient_id: string | null }).ingredient_id = pollo;
        return p;
      });
      await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        almuerzoLunes,
        JSON.stringify(payload),
      ]);
    });

    const fila = await h.como(USER_A, () =>
      h.fila<{ event_effect: { strategy_version: string; params: { energy_ceiling_multiplier: number } } }>(
        `select event_effect from public.member_serving_projections
         where assignment_id = $1 and member_id = $2`,
        [almuerzoLunes, hogarA.memberId],
      ),
    );
    expect(fila!.event_effect.strategy_version).toBe("event-strategy/1.0.0");
    expect(fila!.event_effect.params.energy_ceiling_multiplier).toBe(1.25);
  });

  it("sin evento, event_effect es NULL, no un objeto vacío", async () => {
    const fila = await h.como(USER_A, () =>
      h.fila<{ event_effect: unknown }>(
        `select event_effect from public.member_serving_projections
         where assignment_id = $1 and member_id <> $2 limit 1`,
        [almuerzoLunes, hogarA.memberId],
      ),
    );
    expect(fila).not.toBeNull();
    expect(fila!.event_effect).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("generate_shopping_revision: atómico, idempotente y respetuoso del checklist", () => {
  const item = (key: string, qty: number, label = "Pechuga de pollo") => ({
    line_key: key,
    ingredient_id: null,
    product_id: null,
    label,
    unit: "G",
    required_quantity: qty,
    purchase_basis: "RAW",
    cooked_quantity: null,
    yield_factor: null,
    unresolved: false,
    unresolved_reason: null,
    provenance: [],
  });

  it("genera la revisión siguiente y sincroniza los items", async () => {
    const numero = await h.como(USER_A, () =>
      h.fila<{ generate_shopping_revision: number }>(
        "select public.generate_shopping_revision($1, 'firma-v3', 'shopping-engine/1.0.0', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
        [listaA, JSON.stringify([item("k-pollo", 900)])],
      ),
    );
    expect(Number(numero!.generate_shopping_revision)).toBe(3);

    const cabecera = await h.como(USER_A, () =>
      h.fila<{ current_revision: number }>(
        "select current_revision from public.shopping_lists where id = $1",
        [listaA],
      ),
    );
    expect(Number(cabecera!.current_revision)).toBe(3);
  });

  it("§51: la misma firma NO crea otra revisión", async () => {
    const numero = await h.como(USER_A, () =>
      h.fila<{ generate_shopping_revision: number }>(
        "select public.generate_shopping_revision($1, 'firma-v3', 'shopping-engine/1.0.0', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
        [listaA, JSON.stringify([item("k-pollo", 900)])],
      ),
    );
    expect(Number(numero!.generate_shopping_revision)).toBe(3);
    const revisiones = await h.como(USER_A, () =>
      h.filas("select 1 from public.shopping_list_revisions where list_id = $1", [listaA]),
    );
    expect(revisiones).toHaveLength(3);
  });

  it("el checklist sobrevive a la regeneración: lo comprado sigue comprado", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "update public.shopping_list_items set status = 'PURCHASED' where list_id = $1 and line_key = 'k-pollo'",
        [listaA],
      );
      await h.db.query(
        "select public.generate_shopping_revision($1, 'firma-v4', 'shopping-engine/1.0.0', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
        [listaA, JSON.stringify([item("k-pollo", 720)])],
      );
    });
    const fila = await h.como(USER_A, () =>
      h.fila<{ status: string; required_quantity: string }>(
        "select status, required_quantity from public.shopping_list_items where list_id = $1 and line_key = 'k-pollo'",
        [listaA],
      ),
    );
    expect(fila!.status).toBe("PURCHASED"); // no se perdió al cambiar la cantidad
    expect(Number(fila!.required_quantity)).toBe(720);
  });

  it("un item comprado que se queda sin demanda NO se borra: queda en 0", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.generate_shopping_revision($1, 'firma-v5', 'shopping-engine/1.0.0', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
        [listaA, JSON.stringify([item("k-merluza", 360, "Merluza")])],
      );
    });
    const pollo = await h.como(USER_A, () =>
      h.fila<{ status: string; required_quantity: string }>(
        "select status, required_quantity from public.shopping_list_items where list_id = $1 and line_key = 'k-pollo'",
        [listaA],
      ),
    );
    // Comprado = historia: sobrevive con demanda 0 (§22/§35).
    expect(pollo).not.toBeNull();
    expect(pollo!.status).toBe("PURCHASED");
    expect(Number(pollo!.required_quantity)).toBe(0);
  });

  it("un item pendiente sin demanda sí se retira (§14)", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.generate_shopping_revision($1, 'firma-v6', 'shopping-engine/1.0.0', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
        [listaA, JSON.stringify([item("k-arroz", 500, "Arroz")])],
      );
    });
    const merluza = await h.como(USER_A, () =>
      h.fila("select 1 from public.shopping_list_items where list_id = $1 and line_key = 'k-merluza'", [
        listaA,
      ]),
    );
    expect(merluza).toBeNull();
  });

  it("el hogar B no puede generar revisiones en la lista del A", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "select public.generate_shopping_revision($1, 'intrusa', 'x', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)",
          [listaA],
        ),
      ),
    ).rejects.toThrow(/no autorizado|inexistente/i);
  });
});

// ---------------------------------------------------------------------------
describe("§49 el historial de revisiones es inmutable", () => {
  it("ni update ni delete tienen efecto, incluso para el dueño", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "update public.shopping_list_revisions set payload = '[]'::jsonb where list_id = $1 and revision_number = 1",
        [listaA],
      );
      await h.db.query(
        "delete from public.shopping_list_revisions where list_id = $1 and revision_number = 1",
        [listaA],
      );
    });
    const v1 = await h.como(USER_A, () =>
      h.fila<{ payload: unknown }>(
        "select payload from public.shopping_list_revisions where list_id = $1 and revision_number = 1",
        [listaA],
      ),
    );
    expect(v1).not.toBeNull();
    expect(JSON.stringify(v1!.payload)).toContain("900");
  });
});

// ---------------------------------------------------------------------------
describe("set_planned_quantity: cantidad y auditoría juntas, selladas por la base", () => {
  let itemArroz: string;

  it("guarda la cantidad y el override en una sola llamada", async () => {
    itemArroz = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.shopping_list_items where list_id = $1 and line_key = 'k-arroz'",
        [listaA],
      ),
    ))!.id;

    await h.como(USER_A, async () => {
      await h.db.query("select public.set_planned_quantity($1, 600, 'redondear')", [itemArroz]);
    });

    const fila = await h.como(USER_A, () =>
      h.fila<{ required_quantity: string; planned_quantity: string }>(
        "select required_quantity, planned_quantity from public.shopping_list_items where id = $1",
        [itemArroz],
      ),
    );
    expect(Number(fila!.required_quantity)).toBe(500); // intacta
    expect(Number(fila!.planned_quantity)).toBe(600);

    const audit = await h.como(USER_A, () =>
      h.fila<{ changed_by: string; original_quantity: string; new_quantity: string }>(
        "select changed_by, original_quantity, new_quantity from public.shopping_item_overrides where item_id = $1 order by changed_at desc limit 1",
        [itemArroz],
      ),
    );
    // El sello lo pone la base con quien está autenticado, no el cliente.
    expect(audit!.changed_by).toBe(hogarA.memberId);
    expect(Number(audit!.original_quantity)).toBe(500);
    expect(Number(audit!.new_quantity)).toBe(600);
  });

  it("la identidad del override no se puede falsificar por insert directo", async () => {
    await h.como(USER_A, async () => {
      // Intento de firmar como OTRO integrante: el trigger lo pisa.
      await h.db.query(
        "insert into public.shopping_item_overrides (item_id, original_quantity, new_quantity, changed_by) values ($1, 600, 700, $2)",
        [itemArroz, familia[0]],
      );
    });
    const audit = await h.como(USER_A, () =>
      h.fila<{ changed_by: string }>(
        "select changed_by from public.shopping_item_overrides where item_id = $1 order by changed_at desc limit 1",
        [itemArroz],
      ),
    );
    expect(audit!.changed_by).toBe(hogarA.memberId);
  });

  it("§36: con la compra finalizada, editar cantidades falla en el servidor", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("update public.shopping_lists set status = 'COMPLETED' where id = $1", [
        listaA,
      ]);
    });
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.set_planned_quantity($1, 999, null)", [itemArroz]),
      ),
    ).rejects.toThrow(/finalizó/i);
    await expect(
      h.como(USER_A, () =>
        h.db.query(
          "select public.generate_shopping_revision($1, 'firma-v7', 'x', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)",
          [listaA],
        ),
      ),
    ).rejects.toThrow(/finalizó/i);
  });
});

// ---------------------------------------------------------------------------
describe("coherencia hogar↔plan de la lista", () => {
  it("el hogar B no puede ocupar el plan del A ni con su propio household_id", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "insert into public.shopping_lists (household_id, plan_id) values ($1, $2)",
          [hogarB.householdId, planId],
        ),
      ),
    ).rejects.toThrow(/foreign key|viola|not present/i);
  });
});
