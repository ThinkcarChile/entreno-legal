import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * REGRESIONES DE LA TANDA 5 (migración 0022): la identidad por PRODUCTO
 * comercial llega al ledger de consumo.
 *
 * [I-1] Antes `consume_planned_meal` iteraba solo componentes con
 * ingredient_id: la porción de un producto se comía, su lote quedaba intacto
 * y no se registraba ni movimiento ni faltante. Física falsificada.
 */

const USER = "00000000-0000-0000-0000-0000000ad001";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let productoId: string;
let otroProductoId: string;
let asignacionId: string;
let asignacion2Id: string;
let loteProductoId: string;

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Tanda5", "Diego");

  await h.comoAdmin(async () => {
    productoId = (await h.fila<{ id: string }>(
      `insert into public.commercial_products (household_id, name, brand)
       values ($1, 'Atún lomitos 160 g', 'MarcaMar') returning id`,
      [hogar.householdId],
    ))!.id;
    otroProductoId = (await h.fila<{ id: string }>(
      `insert into public.commercial_products (household_id, name, brand)
       values ($1, 'Jurel 425 g', 'OtraMarca') returning id`,
      [hogar.householdId],
    ))!.id;
  });

  await h.como(USER, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);

    const perfil = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-tanda5', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tanda5')`,
      [hogar.memberId],
    ))!.publish_nutrition_profile;
    const versionPollo = (await h.fila<{ id: string }>(
      `select v.id from public.meal_template_versions v
       where v.status = 'PUBLISHED' limit 1`,
    ))!.id;

    // Lote del producto (como lo crea receive_purchase: ingredient_id NULL).
    loteProductoId = await h.comoAdmin(async () => {
      const lote = (await h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, product_id, label, quantity, unit, weight_basis, status)
         values ($1, $2, 'Atún lomitos', 0, 'G', 'AS_PACKAGED', 'AVAILABLE')
         returning id`,
        [hogar.householdId, productoId],
      ))!.id;
      await h.db.query(
        `insert into public.inventory_movements
           (household_id, lot_id, reason, delta, idempotency_key)
         values ($1, $2, 'PURCHASE', 320, 'SEED-T5:' || $3)`,
        [hogar.householdId, lote, lote],
      );
      return lote;
    });

    // Dos comidas por el camino REAL (confirm_meal_assignment), cada una con
    // un componente cuya identidad es el PRODUCTO.
    const plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
      [hogar.householdId],
    ))!.ensure_weekly_plan;
    const dias = await h.filas<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 2",
      [plan],
    );

    const confirmar = async (diaId: string, mealType: string, gramos: number) => {
      const asig = (await h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
         select $1, $2::public.meal_type, 'RECIPE', v.template_id, v.id
         from public.meal_template_versions v where v.id = $3
         returning id`,
        [diaId, mealType, versionPollo],
      ))!.id;
      await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        asig,
        JSON.stringify([
          {
            member_id: hogar.memberId,
            version_id: versionPollo,
            profile_id: perfil,
            optimizer_version: "portion-optimizer/1.0.0",
            meal_type: mealType,
            serving_date: new Date().toISOString().slice(0, 10),
            fit: "COMPATIBLE",
            adaptation_level: 0,
            score: 90,
            nutrition: {},
            completeness: {},
            reasons: [],
            unmet_constraints: [],
            components: [
              {
                label: "Atún lomitos",
                base_quantity: gramos,
                proposed_quantity: gramos,
                unit: "G",
                weight_basis: "AS_PACKAGED",
                cooking_method: null,
                added_fat_g: 0,
                sort_order: 1,
                product_id: productoId,
              },
            ],
            substitutions: [],
          },
        ]),
      ]);
      return asig;
    };

    asignacionId = await confirmar(dias[0]!.id, "LUNCH", 160);
    asignacion2Id = await confirmar(dias[1]!.id, "DINNER", 300);
  });
});

afterAll(async () => {
  await h?.cerrar();
});

describe("[I-1] consumir descuenta el lote del PRODUCTO", () => {
  it("el consumo genera el movimiento y la despensa baja 160 g", async () => {
    await h.como(USER, async () => {
      const r = await h.fila<{ consume_planned_meal: { servings: number; shortfalls: unknown[] } }>(
        "select public.consume_planned_meal($1)",
        [asignacionId],
      );
      expect(r!.consume_planned_meal.servings).toBe(1);
      // Sin faltante: había 320 g del producto para 160 g de porción.
      expect(r!.consume_planned_meal.shortfalls).toHaveLength(0);

      const lote = await h.fila<{ quantity: string }>(
        "select quantity::text from public.inventory_lots where id = $1",
        [loteProductoId],
      );
      expect(Number(lote!.quantity)).toBe(160);

      const mov = await h.fila<{ delta: string }>(
        `select delta::text from public.inventory_movements
         where lot_id = $1 and reason = 'CONSUMED'`,
        [loteProductoId],
      );
      expect(Number(mov!.delta)).toBe(-160);
    });
  });

  it("el lote de OTRO producto jamás paga la cuenta de este", async () => {
    await h.como(USER, async () => {
      // Lote del otro producto, intacto tras el consumo anterior.
      const otroLote = await h.comoAdmin(async () => {
        const lote = (await h.fila<{ id: string }>(
          `insert into public.inventory_lots
             (household_id, product_id, label, quantity, unit, weight_basis, status)
           values ($1, $2, 'Jurel', 0, 'G', 'AS_PACKAGED', 'AVAILABLE') returning id`,
          [hogar.householdId, otroProductoId],
        ))!.id;
        await h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, idempotency_key)
           values ($1, $2, 'PURCHASE', 425, 'SEED-T5B:' || $3)`,
          [hogar.householdId, lote, lote],
        );
        return lote;
      });

      // Segunda comida del MISMO producto: 320−160=160 disponibles, porción
      // de 300 → faltante de 140. El jurel no se toca.
      const r = await h.fila<{ consume_planned_meal: { shortfalls: { quantity: number }[] } }>(
        "select public.consume_planned_meal($1)",
        [asignacion2Id],
      );
      // Faltante DECLARADO de 140 g — no se inventa stock ni se toma del jurel.
      expect(r!.consume_planned_meal.shortfalls).toHaveLength(1);
      expect(r!.consume_planned_meal.shortfalls[0]!.quantity).toBe(140);

      const jurel = await h.fila<{ quantity: string }>(
        "select quantity::text from public.inventory_lots where id = $1",
        [otroLote],
      );
      expect(Number(jurel!.quantity)).toBe(425);

      // El faltante lleva el LINAJE del producto (columna nueva de 0022).
      const falta = await h.fila<{ product_id: string }>(
        `select product_id from public.consumption_shortfalls
         where assignment_id = $1`,
        [asignacion2Id],
      );
      expect(falta!.product_id).toBe(productoId);
    });
  });
});
