import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * CIERRE v2 §2/§3 — el impacto clínico llega a la PORCIÓN y a las COMPRAS
 * sin reescribir nada solo y sin filtrar una letra clínica.
 *
 * Datos 100% sintéticos.
 */

const USER = "00000000-0000-0000-0000-0000000c1001";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;
let listaId: string;
let reviewId: string;

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Impacto Demo", "Ana");
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  await h.como(USER, async () => {
    const plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
      [hogar.householdId],
    ))!.ensure_weekly_plan;
    listaId = (await h.fila<{ id: string }>(
      `insert into public.shopping_lists (household_id, plan_id, status)
       values ($1, $2, 'ACTIVE') returning id`,
      [hogar.householdId, plan],
    ))!.id;
    // Dos líneas pendientes: una bajará, la otra subirá.
    await h.db.query(
      `insert into public.shopping_list_items
         (list_id, ingredient_id, label, required_quantity, planned_quantity, unit, purchase_basis, status, source)
       values ($1, $2, 'Ingrediente A', 500, 500, 'G', 'RAW', 'PENDING', 'FOOD_PLAN')`,
      [listaId, polloId],
    );
    const merluza = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'merluza'",
    ))!.id;
    await h.db.query(
      `insert into public.shopping_list_items
         (list_id, ingredient_id, label, required_quantity, planned_quantity, unit, purchase_basis, status, source)
       values ($1, $2, 'Ingrediente B', 300, 300, 'G', 'RAW', 'PENDING', 'FOOD_PLAN')`,
      [listaId, merluza],
    );

    reviewId = (await h.fila<{ create_clinical_impact_review: string }>(
      "select public.create_clinical_impact_review($1, 'CLINICAL_RESTRICTION_CHANGED', gen_random_uuid(), '{}'::jsonb)",
      [hogar.memberId],
    ))!.create_clinical_impact_review;
  });
});

afterAll(async () => {
  await h?.cerrar();
});

describe("§3 — el delta clínico ajusta compras con motivo NEUTRO", () => {
  it("aplica −120 g y +150 g, y la bitácora dice CLINICAL_ADJUSTMENT", async () => {
    await h.como(USER, async () => {
      const merluza = (await h.fila<{ id: string }>(
        "select id from public.ingredients where canonical_name = 'merluza'",
      ))!.id;

      const r = (await h.fila<{ apply_clinical_shopping_delta: {
        applied: { label: string; antes: number; ahora: number; delta: number; reason_code: string }[];
        reason_code: string;
      } }>(
        "select public.apply_clinical_shopping_delta($1, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            { ingredient_id: polloId, unit: "G", delta_quantity: -120 },
            { ingredient_id: merluza, unit: "G", delta_quantity: 150 },
          ]),
        ],
      ))!.apply_clinical_shopping_delta;

      expect(r.applied).toHaveLength(2);
      const a = r.applied.find((x) => x.label === "Ingrediente A")!;
      const b = r.applied.find((x) => x.label === "Ingrediente B")!;
      expect(a.antes).toBe(500);
      expect(a.ahora).toBe(380); // −120
      expect(b.ahora).toBe(450); // +150
      expect(r.reason_code).toBe("CLINICAL_ADJUSTMENT");

      const overrides = await h.filas<{ reason: string }>(
        `select o.reason from public.shopping_item_overrides o
         join public.shopping_list_items i on i.id = o.item_id
         where i.list_id = $1`,
        [listaId],
      );
      expect(overrides).toHaveLength(2);
      expect(overrides.every((o) => o.reason === "CLINICAL_ADJUSTMENT")).toBe(true);
    });
  });

  it("§83: NADA de lo que ve quien compra contiene datos clínicos", async () => {
    await h.como(USER, async () => {
      const filas = await h.filas<Record<string, unknown>>(
        `select i.*, o.reason as override_reason
         from public.shopping_list_items i
         left join public.shopping_item_overrides o on o.item_id = i.id
         where i.list_id = $1`,
        [listaId],
      );
      const texto = JSON.stringify(filas).toLowerCase();
      for (const prohibido of [
        "biomarker", "fosforo", "fósforo", "phosphorus", "potasio", "potassium",
        "diagn", "restricc", "clinical_restriction", "lab_", "mg/dl", "mmol",
      ]) {
        expect(texto.includes(prohibido), `la lista de compras filtró "${prohibido}"`).toBe(false);
      }
      // El único rastro permitido es el código neutro.
      expect(texto).toContain("clinical_adjustment");
    });
  });

  it("§38/§39: el ajuste NO movió lotes ni movimientos de inventario", async () => {
    await h.como(USER, async () => {
      const lotes = (await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_lots"))!.n;
      const movs = (await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_movements"))!.n;
      const merluza = (await h.fila<{ id: string }>(
        "select id from public.ingredients where canonical_name = 'merluza'",
      ))!.id;
      await h.db.query("select public.apply_clinical_shopping_delta($1, $2::jsonb)", [
        reviewId,
        JSON.stringify([{ ingredient_id: merluza, unit: "G", delta_quantity: -50 }]),
      ]);
      expect((await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_lots"))!.n).toBe(lotes);
      expect((await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_movements"))!.n).toBe(movs);
    });
  });

  it("sin línea que ajustar lo DICE, no inventa una compra", async () => {
    await h.como(USER, async () => {
      const arroz = (await h.fila<{ id: string }>(
        "select id from public.ingredients where canonical_name = 'arroz blanco'",
      ))!.id;
      const r = (await h.fila<{ apply_clinical_shopping_delta: { applied: unknown[]; no_line_found: unknown[] } }>(
        "select public.apply_clinical_shopping_delta($1, $2::jsonb)",
        [reviewId, JSON.stringify([{ ingredient_id: arroz, unit: "G", delta_quantity: 200 }])],
      ))!.apply_clinical_shopping_delta;
      expect(r.applied).toHaveLength(0);
      expect(r.no_line_found).toHaveLength(1);
      const items = await h.filas("select id from public.shopping_list_items where list_id = $1", [listaId]);
      expect(items).toHaveLength(2); // no nació ninguna línea nueva
    });
  });

  it("la cantidad nunca queda negativa", async () => {
    await h.como(USER, async () => {
      await h.db.query("select public.apply_clinical_shopping_delta($1, $2::jsonb)", [
        reviewId,
        JSON.stringify([{ ingredient_id: polloId, unit: "G", delta_quantity: -99999 }]),
      ]);
      const fila = await h.fila<{ planned_quantity: string }>(
        `select planned_quantity::text from public.shopping_list_items
         where list_id = $1 and ingredient_id = $2`,
        [listaId, polloId],
      );
      expect(Number(fila!.planned_quantity)).toBe(0);
    });
  });

  it("otro hogar no puede aplicar deltas sobre esta revisión", async () => {
    const OTRO = "00000000-0000-0000-0000-0000000c1002";
    await crearHogar(h, OTRO, "Ajeno", "Vecino");
    await h.como(OTRO, async () => {
      await expect(
        h.db.query("select public.apply_clinical_shopping_delta($1, '[]'::jsonb)", [reviewId]),
      ).rejects.toThrow(/no autorizado/);
    });
  });
});
