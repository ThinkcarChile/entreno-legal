import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * LO QUE EL PRE-VUELO ENCONTRÓ VIVO EN PRODUCCIÓN, AFIRMADO COMO CONDUCTA.
 *
 * Cada bloque corresponde a un ítem de la cabecera de la 0060. Lo que se
 * afirma es la conducta CORRECTA —no la ortografía del arreglo—, y cada una se
 * verificó primero contra la base real: `has_function_privilege` decía TRUE,
 * `pg_policies` mostraba `can_access_member` en las tres políticas de escritura,
 * `confdeltype` de la FK de la bandeja era 'a'.
 *
 * Donde se puede, se prueba el borde por los dos lados: que lo cerrado quede
 * cerrado Y que lo que debe seguir abierto siga abierto. Un arreglo de permisos
 * que sólo se prueba por el lado que cierra es cómo se rompe algo que nadie
 * pidió romper.
 */

const ADMIN = "aaaaaaaa-0000-4000-8000-000000000060";
const BETO = "bbbbbbbb-0000-4000-8000-000000000060";

let h!: Harness;
let hogar!: { householdId: string; memberId: string };
let beto!: string;

async function afectadas(sql: string, params: unknown[]): Promise<number> {
  const r = await h.db.query(sql, params);
  return r.affectedRows ?? 0;
}

beforeAll(async () => {
  h = await levantarBase({ conSeeds: true });
  hogar = await crearHogar(h, ADMIN, "Prevuelo", "Ana");

  beto = await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [BETO, "beto-prevuelo@test.dev"]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name)
       values ($1, $2, 'Beto') returning id`,
      [hogar.householdId, BETO],
    );
    return m!.id;
  });
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("[16] purgar conversaciones no es de cualquiera", () => {
  it("ni authenticated ni anon pueden ejecutarla", async () => {
    for (const rol of ["authenticated", "anon"]) {
      const r = await h.fila<{ ok: boolean }>(
        `select has_function_privilege($1, 'public.purge_assistant_conversations()', 'execute') as ok`,
        [rol],
      );
      expect(r!.ok, `${rol} todavía puede ejecutar purge_assistant_conversations`).toBe(false);
    }
  });
});

describe("[15] escribir un perfil exige poder editarlo, no sólo verlo", () => {
  it("Beto NO edita el perfil de Ana; SÍ edita el suyo", async () => {
    // Los dos perfiles los publica un admin por el RPC (security definer).
    await h.comoAdmin(async () => {
      for (const [m, firma] of [[hogar.memberId, "ana"], [beto, "beto"]] as const) {
        await h.db.query(
          `select public.publish_nutrition_profile($1, 'BASIC', $2, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'prevuelo')`,
          [m, `firma-prevuelo-${firma}`],
        );
      }
    });

    // El UPDATE ajeno no revienta: la RLS lo esconde y afecta 0 filas. Eso es lo
    // que hay que afirmar — que sea cero, no que lance.
    const ajeno = await h.como(BETO, () =>
      afectadas("update public.member_nutrition_profiles set version = version where member_id = $1", [
        hogar.memberId,
      ]),
    );
    expect(ajeno, "Beto pudo tocar el perfil de Ana").toBe(0);

    const propio = await h.como(BETO, () =>
      afectadas("update public.member_nutrition_profiles set version = version where member_id = $1", [beto]),
    );
    expect(propio, "Beto ya no puede tocar su PROPIO perfil: el arreglo cerró de más").toBeGreaterThan(0);
  });

  it("las políticas de escritura de los slots del patrón piden puede_editar_perfil", async () => {
    // Acá sí se mira la política y no la conducta, a propósito: sembrar un slot
    // exige conocer columnas que esta prueba no tiene por qué saber, y lo que
    // importa es el predicado. Lo que NO puede quedar es la política vieja.
    const filas = await h.filas<{ policyname: string; cmd: string; with_check: string | null }>(
      `select policyname, cmd, with_check from pg_policies
        where schemaname = 'public' and tablename = 'meal_pattern_slots' order by policyname`,
    );
    const nombres = filas.map((f) => f.policyname);
    expect(nombres).not.toContain("pattern_slots_all");
    const escritura = filas.find((f) => f.policyname === "pattern_slots_write");
    expect(escritura, "falta la política de escritura").toBeDefined();
    expect(escritura!.with_check ?? "").toContain("puede_editar_perfil");
  });
});

describe("[9] [18] [20] borrar a una persona no muere por lo que dejó atrás", () => {
  it("con un costo asignado, consumo del asistente y un item resuelto en la bandeja", async () => {
    // El SET NULL en cascada se ejercita por `assignment_id`, no por `member_id`:
    // una asignación con comensal exige un movimiento real del ledger (lo dice
    // su guardián), y armar ese movimiento es andamiaje que no prueba nada más.
    // La propiedad es la misma: la FK `on delete set null` dispara un UPDATE a
    // profundidad 2 y el append-only tiene que dejarlo pasar.
    const { alloc, comida } = await h.comoAdmin(async () => {
      const plan = (await h.fila<{ id: string }>(
        `insert into public.weekly_plans (household_id, week_start, status)
         values ($1, (date_trunc('week', current_date) + interval '9 weeks')::date, 'DRAFT') returning id`,
        [hogar.householdId],
      ))!.id;
      const dia = (await h.fila<{ id: string }>(
        `insert into public.weekly_plan_days (plan_id, plan_date)
         values ($1, (date_trunc('week', current_date) + interval '9 weeks')::date) returning id`,
        [plan],
      ))!.id;
      const receta = (await h.fila<{ id: string }>(
        `select v.id from public.meal_template_versions v join public.meal_templates m on m.id = v.template_id
          where m.household_id is null and v.status = 'PUBLISHED' limit 1`,
      ))!.id;
      const comida = (await h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status)
         values ($1, 'LUNCH', 'RECIPE', $2, 'PLANNED') returning id`,
        [dia, receta],
      ))!.id;
      // ANCLA REAL. `cost_allocations_ancla` exige lote Y movimiento; el libro
      // mayor los da juntos: add_manual_lot deja un lote y su movimiento PURCHASE
      // (delta > 0, asi que el costeo automatico de la 0044 no lo reclama y el
      // indice unico por movimiento queda libre para esta fila).
      const ingrediente = (await h.fila<{ id: string }>(
        "select id from public.ingredients where household_id is null order by canonical_name limit 1",
      ))!.id;
      const lote = (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Lote prevuelo', 100, 'G', $2)",
        [hogar.householdId, ingrediente],
      ))!.add_manual_lot;
      const movimiento = (await h.fila<{ id: string }>(
        "select id from public.inventory_movements where lot_id = $1 order by created_at limit 1",
        [lote],
      ))!.id;
      const a = await h.fila<{ id: string }>(
        `insert into public.cost_allocations
           (household_id, movement_id, lot_id, category, currency, quantity, cost_basis_snapshot,
            engine_version, occurred_on, recognized_on, assignment_id)
         values ($1, $2, $3, 'CONSUMED', 'CLP', 1, '{}'::jsonb, 'prevuelo/1.0.0',
                 current_date, current_date, $4)
         returning id`,
        [hogar.householdId, movimiento, lote, comida],
      );
      await h.db.query(
        `insert into public.assistant_usage (household_id, member_id, trace_id, capa)
         values ($1, $2, 'traza-prevuelo', 1)`,
        [hogar.householdId, beto],
      );
      await h.db.query(
        `insert into public.assistant_inbox_items
           (household_id, kind, severidad, titulo, dedupe_key, resolved_by)
         values ($1, 'FALTANTE_CONFIRMADO', 3, 'Resuelto por Beto', 'dedupe-prevuelo', $2)`,
        [hogar.householdId, beto],
      );
      return { alloc: a!.id, comida };
    });

    // [9] Se borra la COMIDA (directo, con permiso): su FK deja el costo con
    // assignment_id en NULL por cascada, y eso no puede morir.
    const comidasBorradas = await h.como(ADMIN, () =>
      afectadas("delete from public.meal_assignments where id = $1", [comida]),
    );
    expect(comidasBorradas).toBe(1);
    const asignacion = await h.comoAdmin(() =>
      h.fila<{ a: string | null }>("select assignment_id as a from public.cost_allocations where id = $1", [alloc]),
    );
    expect(asignacion!.a, "el costo sigue apuntando a una comida que no existe").toBeNull();

    // [18] [20] El borrado como dueña: lo que se prueba son los TRIGGERS en la cascada,
    // no la RLS de household_members. Los triggers disparan igual para postgres.
    const borradas = await h.comoAdmin(() =>
      afectadas("delete from public.household_members where id = $1", [beto]),
    );
    expect(borradas, "no se pudo borrar a Beto").toBe(1);

    const despues = await h.comoAdmin(() =>
      h.fila<{ usos: string; resolved: string | null }>(
        `select (select count(*) from public.assistant_usage where member_id = $1) as usos,
                (select resolved_by from public.assistant_inbox_items where dedupe_key = 'dedupe-prevuelo') as resolved`,
        [beto],
      ),
    );
    expect(Number(despues!.usos)).toBe(0);
    expect(despues!.resolved, "la bandeja sigue apuntando a un integrante que no existe").toBeNull();

    // Y el append-only sigue cerrado para un cliente: un UPDATE directo muere.
    await expect(
      h.comoAdmin(() =>
        h.db.query("update public.cost_allocations set quantity = 2 where id = $1", [alloc]),
      ),
    ).rejects.toThrow(/append-only/i);
  });
});

describe("[3] reactivar a alguien le devuelve su rol", () => {
  it("un integrante desactivado y reactivado tiene MEMBER", async () => {
    const carla = await h.comoAdmin(async () => {
      const m = (await h.fila<{ id: string }>(
        `insert into public.household_members (household_id, display_name) values ($1, 'Carla') returning id`,
        [hogar.householdId],
      ))!.id;
      // Se le quita el rol a mano y se la desactiva: el estado en que la 0039
      // dejaba a quien volvía de un viaje.
      await h.db.query("delete from public.member_role_assignments where member_id = $1", [m]);
      await h.db.query("update public.household_members set is_active = false where id = $1", [m]);
      await h.db.query("update public.household_members set is_active = true where id = $1", [m]);
      return m;
    });
    const rol = await h.comoAdmin(() =>
      h.fila<{ n: string }>(
        `select count(*) as n from public.member_role_assignments a
           join public.household_roles r on r.id = a.role_id
          where a.member_id = $1 and r.code = 'MEMBER'`,
        [carla],
      ),
    );
    expect(Number(rol!.n), "Carla volvió sin ningún rol").toBe(1);
  });
});
