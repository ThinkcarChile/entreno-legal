import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * REGRESIONES DE LA TANDA 3 del Integration Gate 0→10.
 *
 * Cada `it` de este archivo falla contra el código anterior a la migración
 * 0020 y a los arreglos de esta tanda. Son defectos que la auditoría de 13
 * lentes confirmó y que §55 marca como bloqueantes para el Sprint 11.
 */

const USER_A = "00000000-0000-0000-0000-0000000ab001";
const USER_B = "00000000-0000-0000-0000-0000000ab002";

let h: Harness;
let A: { householdId: string; memberId: string };
let B: { householdId: string; memberId: string };
let polloId: string;
let versionA: string;

beforeAll(async () => {
  h = await levantarBase();
  A = await crearHogar(h, USER_A, "Tanda3 A", "Ana");
  B = await crearHogar(h, USER_B, "Tanda3 B", "Bruno");

  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  await h.como(USER_A, async () => {
    const plantilla = (await h.fila<{ id: string }>(
      `insert into public.meal_templates (household_id, name, kind)
       values ($1, 'Receta de A', 'MEAL') returning id`,
      [A.householdId],
    ))!.id;
    versionA = (await h.fila<{ id: string }>(
      `insert into public.meal_template_versions (template_id, name, base_servings, status, version_number)
       values ($1, 'Receta de A', 4, 'DRAFT', 1) returning id`,
      [plantilla],
    ))!.id;
    await h.db.query(
      `insert into public.meal_slots (version_id, slot_type, label, sort_order)
       values ($1, 'PROTEIN', 'Proteína', 1)`,
      [versionA],
    );
  });
});

/** Una lista de compras de la semana indicada (no hay RPC para crearla). */
async function crearLista(offsetDias: number): Promise<string> {
  const plan = (await h.fila<{ ensure_weekly_plan: string }>(
    "select public.ensure_weekly_plan($1, (date_trunc('week', current_date + $2::int))::date)",
    [A.householdId, offsetDias],
  ))!.ensure_weekly_plan;
  return (await h.fila<{ id: string }>(
    `insert into public.shopping_lists (household_id, plan_id, status)
     values ($1, $2, 'ACTIVE') returning id`,
    [A.householdId, plan],
  ))!.id;
}

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
// [G-1] replace_draft_content validaba CERO de los cinco UUID del cliente
// ---------------------------------------------------------------------------

describe("[G-1] los UUID que manda el navegador se validan", () => {
  it("no deja meter un alimento privado de OTRO hogar en mi receta", async () => {
    const alimentoDeB = await h.como(USER_B, async () =>
      (await h.fila<{ id: string }>(
        `insert into public.ingredients (household_id, canonical_name, display_name, category_id)
         values ($1, 'secreto de bruno', 'Secreto de Bruno',
                 (select id from public.ingredient_categories limit 1)) returning id`,
        [B.householdId],
      ))!.id,
    );

    await h.como(USER_A, async () => {
      const payload = {
        slots: [
          {
            slot_type: "PROTEIN",
            label: "Proteína",
            components: [{ ingredient_id: alimentoDeB, quantity: 100, unit: "G" }],
          },
        ],
      };
      await expect(
        h.db.query("select public.replace_draft_content($1, $2::jsonb)", [
          versionA,
          JSON.stringify(payload),
        ]),
      ).rejects.toThrow(/no pertenece a este hogar/);
    });
  });

  it("no deja apuntar a una ficha nutricional privada de otro hogar", async () => {
    const fichaDeB = await h.como(USER_B, async () =>
      (await h.fila<{ id: string }>(
        `insert into public.nutrition_facts
           (ingredient_id, household_id, weight_basis, basis_unit, energy_kcal, protein_g,
            source_type, source_name)
         values ($1, $2, 'RAW', 'G', 999, 99, 'USER_ENTERED_LABEL', 'La libreta de Bruno')
         returning id`,
        [polloId, B.householdId],
      ))!.id,
    );

    await h.como(USER_A, async () => {
      const payload = {
        slots: [
          {
            slot_type: "PROTEIN",
            components: [
              { ingredient_id: polloId, quantity: 100, unit: "G", nutrition_fact_id: fichaDeB },
            ],
          },
        ],
      };
      await expect(
        h.db.query("select public.replace_draft_content($1, $2::jsonb)", [
          versionA,
          JSON.stringify(payload),
        ]),
      ).rejects.toThrow(/no pertenece a este hogar/);
    });
  });

  it("sigue aceptando lo que SÍ es mío o global (no rompe el camino bueno)", async () => {
    await h.como(USER_A, async () => {
      const payload = {
        name: "Receta de A",
        base_servings: 4,
        slots: [
          {
            slot_type: "PROTEIN",
            label: "Proteína",
            components: [{ ingredient_id: polloId, quantity: 120, unit: "G" }],
          },
        ],
      };
      await h.db.query("select public.replace_draft_content($1, $2::jsonb)", [
        versionA,
        JSON.stringify(payload),
      ]);
      const n = await h.fila<{ n: string }>(
        `select count(*)::text as n from public.meal_slot_components c
         join public.meal_slots s on s.id = c.slot_id where s.version_id = $1`,
        [versionA],
      );
      expect(n!.n).toBe("1");
    });
  });
});

// ---------------------------------------------------------------------------
// [G-2] publicar copiaba la ficha privada de otro hogar dentro de mi receta
// ---------------------------------------------------------------------------

describe("[G-2] publicar no exfiltra fichas de otro hogar", () => {
  it("rechaza publicar si un componente apunta a una ficha ajena", async () => {
    const fichaDeB = await h.como(USER_B, async () =>
      (await h.fila<{ id: string }>(
        `insert into public.nutrition_facts
           (ingredient_id, household_id, weight_basis, basis_unit, energy_kcal, protein_g,
            source_type, source_name)
         values ($1, $2, 'RAW', 'G', 777, 77, 'USER_ENTERED_LABEL', 'Etiqueta privada de Bruno')
         returning id`,
        [polloId, B.householdId],
      ))!.id,
    );

    // Se mete a mano (saltándose el RPC ya corregido) para probar el segundo
    // cerrojo: aunque la fila existiera, publicar no la copia.
    const version2 = await h.comoAdmin(async () => {
      const t = (await h.fila<{ id: string }>(
        `insert into public.meal_templates (household_id, name, kind)
         values ($1, 'Colada', 'MEAL') returning id`,
        [A.householdId],
      ))!.id;
      const v = (await h.fila<{ id: string }>(
        `insert into public.meal_template_versions (template_id, name, base_servings, status, version_number)
         values ($1, 'Colada', 2, 'DRAFT', 1) returning id`,
        [t],
      ))!.id;
      const s = (await h.fila<{ id: string }>(
        `insert into public.meal_slots (version_id, slot_type, sort_order)
         values ($1, 'PROTEIN', 1) returning id`,
        [v],
      ))!.id;
      await h.db.query(
        `insert into public.meal_slot_components
           (slot_id, ingredient_id, quantity, unit, weight_basis, nutrition_fact_id)
         values ($1, $2, 100, 'G', 'RAW', $3)`,
        [s, polloId, fichaDeB],
      );
      return v;
    });

    await h.como(USER_A, async () => {
      await expect(
        h.db.query("select public.publish_meal_template_version($1)", [version2]),
      ).rejects.toThrow(/no pertenece a este hogar/);

      const c = await h.fila<{ frozen_nutrition: unknown }>(
        `select c.frozen_nutrition from public.meal_slot_components c
         join public.meal_slots s on s.id = c.slot_id where s.version_id = $1`,
        [version2],
      );
      expect(c!.frozen_nutrition).toBeNull();
    });
  });

  it("sigue publicando una receta sana, con su congelado y su auditoría", async () => {
    await h.como(USER_A, async () => {
      const v = await h.fila<{ publish_meal_template_version: string }>(
        "select public.publish_meal_template_version($1)",
        [versionA],
      );
      expect(v!.publish_meal_template_version).toBe(versionA);
      const estado = await h.fila<{ status: string }>(
        "select status from public.meal_template_versions where id = $1",
        [versionA],
      );
      expect(estado!.status).toBe("PUBLISHED");
      const auditoria = await h.fila<{ n: string }>(
        `select count(*)::text as n from public.audit_events
         where subject_id = $1 and action = 'RECIPE_VERSION_PUBLISHED'`,
        [versionA],
      );
      expect(auditoria!.n).toBe("1");
    });
  });
});

// ---------------------------------------------------------------------------
// [B-1] la base física de la compra sobrevive hasta el lote
// ---------------------------------------------------------------------------

describe("[B-1] comprar AS_PACKAGED no se convierte en RAW por el camino", () => {
  it("el lote recibido conserva la base declarada en la compra", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.ensure_storage_locations($1)", [A.householdId]);
      const lista = await crearLista(0);

      await h.db.query(
        `insert into public.shopping_list_items
           (list_id, ingredient_id, label, required_quantity, planned_quantity, unit,
            purchase_basis, status, source)
         values ($1, $2, 'Atún en lata', 400, 400, 'G', 'COMMERCIAL_PACKAGE', 'PURCHASED', 'MANUAL')`,
        [lista, polloId],
      );
      await h.db.query(
        "update public.shopping_lists set status = 'COMPLETED' where id = $1",
        [lista],
      );
      await h.db.query("select public.receive_shopping_list($1)", [lista]);

      const lote = await h.fila<{ weight_basis: string; quantity: string }>(
        `select weight_basis, quantity::text from public.inventory_lots
         where household_id = $1 and label = 'Atún en lata'`,
        [A.householdId],
      );
      expect(lote!.weight_basis).toBe("AS_PACKAGED");
      expect(Number(lote!.quantity)).toBe(400);
    });
  });

  it("DRAINED sigue funcionando igual que antes", async () => {
    await h.como(USER_A, async () => {
      const lista = await crearLista(7);
      await h.db.query(
        `insert into public.shopping_list_items
           (list_id, ingredient_id, label, required_quantity, planned_quantity, unit,
            purchase_basis, status, source)
         values ($1, $2, 'Porotos escurridos', 240, 240, 'G', 'DRAINED', 'PURCHASED', 'MANUAL')`,
        [lista, polloId],
      );
      await h.db.query("update public.shopping_lists set status = 'COMPLETED' where id = $1", [
        lista,
      ]);
      await h.db.query("select public.receive_shopping_list($1)", [lista]);
      const lote = await h.fila<{ weight_basis: string }>(
        `select weight_basis from public.inventory_lots
         where household_id = $1 and label = 'Porotos escurridos'`,
        [A.householdId],
      );
      expect(lote!.weight_basis).toBe("DRAINED");
    });
  });
});

// ---------------------------------------------------------------------------
// [B-1b] las conversiones entre bases son explícitas o NO existen
// ---------------------------------------------------------------------------

describe("[B-1b] no hay conversión 1:1 inventada entre bases", () => {
  it("sin fila anotada, no hay factor: devuelve NULL, no 1", async () => {
    const r = await h.como(USER_A, async () =>
      h.fila<{ basis_factor: string | null }>(
        "select app.basis_factor($1, 'EDIBLE_PORTION', 'RAW', $2) as basis_factor",
        [polloId, A.householdId],
      ),
    );
    expect(r!.basis_factor).toBeNull();
  });

  it("el factor del hogar le gana al global", async () => {
    await h.comoAdmin(async () => {
      await h.db.query(
        `insert into public.ingredient_basis_conversions
           (household_id, ingredient_id, from_basis, to_basis, factor, source_name)
         values (null, $1, 'EDIBLE_PORTION', 'RAW', 1.4, 'USDA')`,
        [polloId],
      );
    });
    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.ingredient_basis_conversions
           (household_id, ingredient_id, from_basis, to_basis, factor, source_name)
         values ($1, $2, 'EDIBLE_PORTION', 'RAW', 1.6, 'Lo pesamos en casa')`,
        [A.householdId, polloId],
      );
      const r = await h.fila<{ basis_factor: string }>(
        "select app.basis_factor($1, 'EDIBLE_PORTION', 'RAW', $2) as basis_factor",
        [polloId, A.householdId],
      );
      expect(Number(r!.basis_factor)).toBe(1.6);
    });
  });

  it("el hogar B no ve el factor casero del hogar A", async () => {
    const r = await h.como(USER_B, async () =>
      h.filas(
        "select id from public.ingredient_basis_conversions where household_id = $1",
        [A.householdId],
      ),
    );
    expect(r).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [M-2] cambiar de opinión sobre la cocción ACTUALIZA, no acumula
// ---------------------------------------------------------------------------

describe("[M-2] la preferencia de cocción se actualiza de verdad", () => {
  it("dos opiniones seguidas dejan UNA fila, con la última", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.set_cooking_preference($1, $2, null, 'FRIED', 'AVOID')", [
        A.memberId,
        polloId,
      ]);
      await h.db.query("select public.set_cooking_preference($1, $2, null, 'FRIED', 'PREFERRED')", [
        A.memberId,
        polloId,
      ]);
      const filas = await h.filas<{ stance: string }>(
        `select stance from public.member_cooking_preferences
         where member_id = $1 and ingredient_id = $2 and cooking_method = 'FRIED'`,
        [A.memberId, polloId],
      );
      expect(filas).toHaveLength(1);
      expect(filas[0]!.stance).toBe("PREFERRED");
    });
  });

  it("la preferencia global y la del alimento conviven sin pisarse", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.set_cooking_preference($1, null, null, 'FRIED', 'AVOID')", [
        A.memberId,
      ]);
      const filas = await h.filas<{ ingredient_id: string | null; stance: string }>(
        `select ingredient_id, stance from public.member_cooking_preferences
         where member_id = $1 and cooking_method = 'FRIED' order by ingredient_id nulls first`,
        [A.memberId],
      );
      expect(filas).toHaveLength(2);
      expect(filas[0]!.ingredient_id).toBeNull();
      expect(filas[0]!.stance).toBe("AVOID");
      expect(filas[1]!.stance).toBe("PREFERRED");
    });
  });

  it("nadie guarda preferencias en el integrante de otra casa", async () => {
    await h.como(USER_B, async () => {
      await expect(
        h.db.query("select public.set_cooking_preference($1, null, null, 'BOILED', 'AVOID')", [
          A.memberId,
        ]),
      ).rejects.toThrow(/no autorizado/);
    });
  });

  it("el índice único impide duplicados aunque alguien escriba directo", async () => {
    await h.comoAdmin(async () => {
      await expect(
        h.db.query(
          `insert into public.member_cooking_preferences
             (member_id, ingredient_id, category_id, cooking_method, stance)
           values ($1, $2, null, 'FRIED', 'AVOID')`,
          [A.memberId, polloId],
        ),
      ).rejects.toThrow();
    });
  });
});
