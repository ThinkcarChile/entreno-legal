import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "@/integration/harness";
import { clienteSobrePGlite } from "@/app/comi/cliente-pglite";
import { cargarServido } from "./servicio-queries";

/**
 * EL LECTOR DE LO SERVIDO, MEDIDO CONTRA POSTGRES DE VERDAD.
 *
 * Dos preguntas que desde lejos se ven iguales y significan cosas opuestas, y
 * que este archivo existe para separar:
 *
 *   · "¿CUÁNTO SOBRÓ del asado?" — un hecho del sábado, inmutable.
 *   · "¿cuánto QUEDA hoy de esa sobra?" — un saldo que cambia cada vez que
 *     alguien abre el refrigerador.
 *
 * El lector sumaba lo segundo y lo mostraba como lo primero: si el martes te
 * comías la sobra, el asado del sábado pasaba a declarar que no sobró nada —
 * historia cambiada por un hecho posterior y ajeno. Y el mismo número decide
 * cuánto MÁS te deja guardar la pantalla del día, así que el error no era sólo
 * de informe.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: mismo motivo que las suites de
 * integración del Sprint 13 — `harness.ts` lo comparten varios agentes y su
 * lista todavía no llega a la 0041.
 */

const RAIZ = path.resolve(__dirname, "../../../..");
const PENDIENTES = [
  "supabase/migrations/0039_permisos_plan_y_cocina.sql",
  "supabase/migrations/0040_adaptive_reviews.sql",
  "supabase/migrations/0041_eventos_avanzados.sql",
];

const USER = "00000000-0000-0000-0000-00000006f0a1";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let db: SupabaseClient;
let vacunoId: string;

async function asegurar(testigoSql: string, archivo: string): Promise<void> {
  const ya = await h.comoAdmin(() => h.fila(testigoSql));
  if (ya) return;
  await h.comoAdmin(() => h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8")));
}

async function eventoEnCurso(titulo: string): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.nutrition_events
         (household_id, event_date, event_type, meal_type, title, status)
       values ($1, current_date, 'BARBECUE', 'LUNCH', $2, 'CONFIRMED') returning id`,
      [hogar.householdId, titulo],
    ),
  );
  await h.comoAdmin(() =>
    h.db.query("update public.nutrition_events set status = 'IN_PROGRESS' where id = $1", [r!.id]),
  );
  return r!.id;
}

async function lote(gramos: number): Promise<string> {
  return h.comoAdmin(async () => {
    const l = await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, quantity, unit, weight_basis, status)
       values ($1, $2, 'vacuno', 0, 'G', 'RAW', 'AVAILABLE') returning id`,
      [hogar.householdId, vacunoId],
    );
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1, $2, 'PURCHASE', $3)`,
      [hogar.householdId, l!.id, gramos],
    );
    return l!.id;
  });
}

async function servir(eventoId: string, label: string, gramos: number): Promise<string> {
  const r = await h.como(USER, () =>
    h.fila<{ serve_event_item: { item_id: string } }>(
      `select public.serve_event_item($1, $2, $3, 'G', 'COOKED'::public.weight_basis,
                                      null, $4, null, null, null)`,
      [eventoId, label, gramos, vacunoId],
    ),
  );
  return r!.serve_event_item.item_id;
}

beforeAll(async () => {
  h = await levantarBase();

  await asegurar(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'can_edit_plan'`,
    PENDIENTES[0]!,
  );
  await asegurar(
    "select 1 where to_regclass('public.adaptive_nutrition_reviews') is not null",
    PENDIENTES[1]!,
  );
  await asegurar(
    "select 1 where to_regclass('public.event_serving_items') is not null",
    PENDIENTES[2]!,
  );

  hogar = await crearHogar(h, USER, "Hogar Lector", "Ana");
  db = clienteSobrePGlite(h);

  vacunoId = (await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.ingredients
         (household_id, canonical_name, display_name, category_id, is_active)
       values ($1, 'vacuno del lector', 'Vacuno del lector',
               (select id from public.ingredient_categories order by code limit 1), true)
       returning id`,
      [hogar.householdId],
    ),
  ))!.id;
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("cuánto sobró se lee del libro mayor, no del saldo de hoy", () => {
  it("la sobra consumida después sigue siendo la sobra que hubo", async () => {
    const evento = await eventoEnCurso("Asado del sábado");
    await lote(4000);
    const renglon = await servir(evento, "Lomo", 1000);

    const guardado = await h.como(USER, () =>
      h.fila<{ save_event_leftover: { lot_id: string } }>(
        "select public.save_event_leftover($1, 800, null, null, null, null)",
        [renglon],
      ),
    );
    const loteSobra = guardado!.save_event_leftover.lot_id;

    const antes = await h.como(USER, () => cargarServido(db, evento));
    expect(antes).toHaveLength(1);
    expect(antes[0]!.guardado).toBeCloseTo(800, 3);

    // EL MARTES ALGUIEN SE COMIÓ LA SOBRA: el lote queda en cero y CONSUMED.
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.inventory_movements (household_id, lot_id, reason, delta)
         values ($1, $2, 'ADJUSTMENT', -800)`,
        [hogar.householdId, loteSobra],
      ),
    );
    const saldo = await h.comoAdmin(() =>
      h.fila<{ quantity: string; status: string }>(
        "select quantity, status from public.inventory_lots where id = $1",
        [loteSobra],
      ),
    );
    expect(Number(saldo!.quantity)).toBe(0);
    expect(saldo!.status).toBe("CONSUMED");

    // El asado del sábado sobró lo mismo que sobró.
    const despues = await h.como(USER, () => cargarServido(db, evento));
    expect(despues[0]!.guardado).toBeCloseTo(800, 3);
  });

  it("sin ninguna sobra el cero es de verdad: el libro mayor se leyó y no tiene nada", async () => {
    const evento = await eventoEnCurso("Asado sin sobras");
    await lote(2000);
    await servir(evento, "Longaniza", 500);

    const filas = await h.como(USER, () => cargarServido(db, evento));
    expect(filas).toHaveLength(1);
    expect(filas[0]!.guardado).toBe(0);
  });
});

describe("lo anulado deja de estar vivo", () => {
  it("un renglón anulado desaparece de lo servido", async () => {
    const evento = await eventoEnCurso("Asado con un renglón anulado");
    await lote(3000);
    const bueno = await servir(evento, "Lomo bueno", 400);
    const malo = await servir(evento, "Lomo mal tecleado", 1800);

    await h.como(USER, () =>
      h.db.query("select public.void_event_serving_item($1, 'tecleé de más')", [malo]),
    );

    const filas = await h.como(USER, () => cargarServido(db, evento));
    expect(filas.map((f) => f.id)).toEqual([bueno]);
  });
});
