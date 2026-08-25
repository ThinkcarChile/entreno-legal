import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";
import { analyzeStock } from "@/domain/stock/engine";
import { planPrep } from "@/domain/prep/engine";
import type { StockInput } from "@/domain/stock/types";
import type { PrepEngineInput } from "@/domain/prep/types";

/**
 * GATE FINAL §14 — RENDIMIENTO con un dataset razonable.
 *
 * ~500 lotes, 6 semanas de plan, 90 días de movimientos, demanda confirmada y
 * tareas de prep. No es optimización prematura: es la prueba de que los
 * motores son lineales y las consultas críticas usan índice. Umbrales
 * holgados a propósito (CI en frío): si un motor se vuelve cuadrático o una
 * consulta pierde su índice, esto revienta MUCHO antes de acercarse al límite.
 */

const USER = "00000000-0000-0000-0000-0000000ae001";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let ingredientes: string[] = [];

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Perf", "Ana");

  ingredientes = (
    await h.filas<{ id: string }>("select id from public.ingredients limit 20")
  ).map((f) => f.id);

  // 500 lotes + un movimiento de compra cada uno + 400 consumos históricos.
  await h.comoAdmin(async () => {
    await h.db.query(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, quantity, unit, weight_basis, status, created_at)
       select $1, i.id, 'perf-' || g, 100 + (g % 900), 'G', 'RAW', 'AVAILABLE',
              now() - ((g % 90) || ' days')::interval
       from generate_series(1, 500) g
       join lateral (
         select id from public.ingredients offset (g % 20) limit 1
       ) i on true`,
      [hogar.householdId],
    );
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta, idempotency_key)
       select household_id, id, 'PURCHASE', quantity, 'PERF:' || id::text
       from public.inventory_lots where household_id = $1 and label like 'perf-%'`,
      [hogar.householdId],
    );
  });
}, 120000);

afterAll(async () => {
  await h?.cerrar();
});

describe("§14 — motores lineales y consultas con índice", () => {
  it("analyzeStock con 500 lotes y 90 días de historia corre en < 2 s", async () => {
    const lots = (
      await h.filas<Record<string, string>>(
        `select id, ingredient_id, label, quantity::text, unit, weight_basis,
                expiry_date::text, use_by::text, created_at::text, status
         from public.inventory_lots where household_id = $1 and status = 'AVAILABLE'`,
        [hogar.householdId],
      )
    ).map((l) => ({
      id: l.id!,
      ingredientId: l.ingredient_id!,
      label: l.label!,
      quantity: Number(l.quantity),
      unit: "G" as const,
      weightBasis: "RAW" as const,
      isApproximate: false,
      expiryDate: l.expiry_date ?? null,
      useBy: l.use_by ?? null,
      createdAt: l.created_at!,
      status: "AVAILABLE" as const,
      acquisitionValue: null,
    }));
    expect(lots.length).toBeGreaterThanOrEqual(500);

    // 400 consumos repartidos en 30 días, 20 alimentos.
    const consumption = Array.from({ length: 400 }, (_, i) => ({
      ingredientId: ingredientes[i % 20]!,
      quantity: 50 + (i % 200),
      unit: "G" as const,
      weightBasis: "RAW" as const,
      cookingMethod: null,
      date: `2026-08-${String(1 + (i % 24)).padStart(2, "0")}`,
    }));
    const futureDemand = Array.from({ length: 60 }, (_, i) => ({
      ingredientId: ingredientes[i % 20]!,
      label: `demanda ${i}`,
      quantity: 100 + i,
      unit: "G" as const,
      weightBasis: "RAW" as const,
      cookingMethod: null,
      servingDate: `2026-08-${String(25 + (i % 5)).padStart(2, "0")}`,
      projectionId: `00000000-0000-0000-0000-${String(100000 + i).padStart(12, "0")}`,
    }));

    const input: StockInput = {
      today: "2026-08-25",
      lots,
      futureDemand,
      consumption,
      shortfalls: [],
      waste: [],
      purchases: [],
      yields: [],
      targets: [],
      planningCoveredDates: ["2026-08-25", "2026-08-26"],
      ingredients: ingredientes.map((id, i) => ({ id, label: `ing ${i}`, categoryCode: null })),
      excludedProductLots: 0,
    } as StockInput & { excludedProductLots: number };

    const t0 = performance.now();
    const items = analyzeStock(input);
    const ms = performance.now() - t0;
    expect(items.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2000);
  });

  it("planPrep con 500 lotes y 60 demandas corre en < 2 s", () => {
    const lots = Array.from({ length: 500 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(200000 + i).padStart(12, "0")}`,
      ingredientId: ingredientes[i % 20]!,
      categoryId: null,
      label: `lote ${i}`,
      quantity: 100 + (i % 900),
      unit: "G" as const,
      weightBasis: "RAW",
      processingState: "RAW" as const,
      temperatureState: "CHILLED" as const,
      vacuumSealed: false,
      locationKind: "FRIDGE" as const,
      useBy: null,
      expiryDate: null,
      createdOn: "2026-08-20",
      intendedUseDate: null,
    }));
    const demand = Array.from({ length: 60 }, (_, i) => ({
      assignmentId: `00000000-0000-0000-0000-${String(300000 + i).padStart(12, "0")}`,
      date: `2026-08-${String(25 + (i % 6)).padStart(2, "0")}`,
      mealType: "LUNCH",
      ingredientId: ingredientes[i % 20]!,
      quantity: 150 + i,
      unit: "G" as const,
      weightBasis: "RAW",
      cookingMethod: null,
    }));
    const input: PrepEngineInput = {
      today: "2026-08-25",
      horizonDays: 7,
      lots,
      demand,
      preferences: [],
      capabilities: [],
      safetyRules: [],
      yields: [],
      freezerCapacityKnown: null,
    };
    const t0 = performance.now();
    const plan = planPrep(input);
    const ms = performance.now() - t0;
    expect(plan.tasks.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2000);
  });

  it("las consultas críticas del ledger usan índice (no seq scan del hogar)", async () => {
    // La consulta de lotes disponibles del hogar — la más frecuente del app.
    const plan = await h.filas<{ "QUERY PLAN": string }>(
      `explain select * from public.inventory_lots
       where household_id = $1 and status = 'AVAILABLE' and quantity > 0`,
      [hogar.householdId],
    );
    const texto = plan.map((f) => f["QUERY PLAN"]).join("\n");
    expect(texto).toMatch(/Index Scan|Bitmap/);

    // Movimientos por lote (reconstrucción del ledger).
    const plan2 = await h.filas<{ "QUERY PLAN": string }>(
      `explain select * from public.inventory_movements where lot_id = $1`,
      [(await h.fila<{ id: string }>("select id from public.inventory_lots limit 1"))!.id],
    );
    const texto2 = plan2.map((f) => f["QUERY PLAN"]).join("\n");
    expect(texto2).toMatch(/Index Scan|Bitmap/);
  });
});
