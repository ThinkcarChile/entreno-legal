import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

/**
 * PostgreSQL de verdad (compilado a WASM) para las pruebas de integración.
 *
 * Los tres bugs más graves del Sprint 4 vivían en la costura entre la base y la
 * capa de datos: filas con una forma, código esperando otra. Esa costura no se
 * prueba con objetos escritos a mano — hay que traer las filas de un Postgres
 * real, con sus tipos, sus `numeric` que llegan como texto y sus embeds.
 */

const ROOT = path.resolve(__dirname, "../../..");

const MIGRACIONES = [
  "supabase/migrations/0001_family.sql",
  "supabase/migrations/0002_catalog.sql",
  "supabase/migrations/0003_recipes.sql",
  "supabase/migrations/0004_publish_consistency_guard.sql",
  "supabase/migrations/0005_profiles_and_portions.sql",
  "supabase/migrations/0006_component_roles.sql",
  "supabase/migrations/0007_weekly_planning.sql",
  "supabase/migrations/0008_participants_and_serving_lifecycle.sql",
  "supabase/migrations/0009_shopping.sql",
  "supabase/migrations/0010_hardening_sprint6.sql",
  "supabase/migrations/0011_inventory.sql",
  "supabase/migrations/0012_consumption_shortfall.sql",
  "supabase/migrations/0013_stock_intelligence.sql",
  "supabase/migrations/0014_procurement.sql",
];

const SEEDS = [
  "supabase/seed/dev_catalog_seed.sql",
  "supabase/seed/dev_recipes_seed.sql",
  "supabase/seed/dev_family_profiles.sql",
];

/** Lo que Supabase ya trae de fábrica y las migraciones dan por hecho. */
const ENTORNO_SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
`;

export interface Harness {
  db: PGlite;
  /** Ejecuta como el usuario autenticado indicado, con RLS activa. */
  como<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  /** Ejecuta como postgres (sin RLS), para preparar datos. */
  comoAdmin<T>(fn: () => Promise<T>): Promise<T>;
  filas<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  fila<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  cerrar(): Promise<void>;
}

export async function levantarBase(): Promise<Harness> {
  const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  await db.exec("create extension if not exists pg_trgm; create extension if not exists pgcrypto;");
  await db.exec(ENTORNO_SUPABASE);

  for (const archivo of [...MIGRACIONES, ...SEEDS]) {
    await db.exec(readFileSync(path.join(ROOT, archivo), "utf8"));
  }

  const filas = async <T,>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows;

  return {
    db,
    filas,
    fila: async <T,>(sql: string, params: unknown[] = []) => (await filas<T>(sql, params))[0] ?? null,
    async como(userId, fn) {
      await db.exec("set role authenticated;");
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
      try {
        return await fn();
      } finally {
        await db.exec("reset role;");
      }
    },
    async comoAdmin(fn) {
      await db.exec("reset role;");
      return fn();
    },
    cerrar: () => db.close(),
  };
}

/** Crea un usuario de auth y su hogar, y devuelve los ids. */
export async function crearHogar(
  h: Harness,
  userId: string,
  hogar: string,
  nombre: string,
): Promise<{ householdId: string; memberId: string }> {
  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `${nombre.toLowerCase()}@test.dev`,
    ]);
  });

  return h.como(userId, async () => {
    const creado = await h.fila<{ create_household: string }>(
      "select public.create_household($1, $2)",
      [hogar, nombre],
    );
    const householdId = creado!.create_household;
    const miembro = await h.fila<{ id: string }>(
      "select id from public.household_members where household_id = $1 and user_id = $2",
      [householdId, userId],
    );
    return { householdId, memberId: miembro!.id };
  });
}

/** Las columnas que la aplicación pide para armar un perfil. */
export const SELECT_PERFIL = {
  tracking: "select mode from public.member_tracking_settings where member_id = $1",
  goals: `select goal_type, scope, meal_type, minimum, preferred, maximum, priority
          from public.nutrition_goals where member_id = $1 and status = 'ACTIVE'`,
  preferences: `select preference_type, target_kind, target_id
                from public.member_preferences where member_id = $1`,
  cooking: `select ingredient_id, category_id, cooking_method, stance
            from public.member_cooking_preferences where member_id = $1`,
  fat: "select stance from public.member_added_fat_preferences where member_id = $1",
  snapshot: `select id, version from public.member_nutrition_profiles
             where member_id = $1 and is_current`,
};

/** Patrón de comidas con sus slots embebidos, como lo devolvería PostgREST. */
export async function patronDe(h: Harness, memberId: string): Promise<unknown> {
  const patron = await h.fila<Record<string, unknown>>(
    `select uses_fasting_pattern, first_meal_type, feeding_window_start, feeding_window_end, id
     from public.meal_patterns where member_id = $1`,
    [memberId],
  );
  if (!patron) return null;
  const slots = await h.filas(
    `select meal_type, availability, is_first_meal, salad_preference, priority, sort_order
     from public.meal_pattern_slots where pattern_id = $1`,
    [patron.id],
  );
  delete patron.id;
  return { ...patron, meal_pattern_slots: slots };
}

/** Componentes de una versión con sus embeds, como los pide la aplicación. */
export async function componentesDe(h: Harness, versionId: string) {
  const filas = await h.filas<Record<string, unknown>>(
    `select c.id, c.slot_id, c.ingredient_id, c.product_id, c.nested_version_id,
            c.quantity, c.unit, c.weight_basis, c.cooking_method, c.yield_factor,
            c.is_optional, c.sort_order, c.adjustability, c.role,
            c.min_quantity, c.max_quantity, c.frozen_nutrition, c.frozen_source,
            s.slot_type,
            case when i.id is null then null
                 else jsonb_build_object('display_name', i.display_name, 'category_id', i.category_id)
            end as ingredients,
            case when p.id is null then null
                 else jsonb_build_object('name', p.name, 'brand', p.brand)
            end as commercial_products,
            case when f.id is null then null
                 else jsonb_build_object(
                   'id', f.id, 'weight_basis', f.weight_basis, 'basis_unit', f.basis_unit,
                   'source_type', f.source_type, 'source_name', f.source_name, 'verified', f.verified,
                   'energy_kcal', f.energy_kcal, 'protein_g', f.protein_g,
                   'carbohydrates_g', f.carbohydrates_g, 'fat_g', f.fat_g, 'fiber_g', f.fiber_g,
                   'sugars_g', f.sugars_g, 'saturated_fat_g', f.saturated_fat_g,
                   'sodium_mg', f.sodium_mg, 'potassium_mg', f.potassium_mg,
                   'phosphorus_mg', f.phosphorus_mg)
            end as nutrition_facts
     from public.meal_slot_components c
     join public.meal_slots s on s.id = c.slot_id
     left join public.ingredients i on i.id = c.ingredient_id
     left join public.commercial_products p on p.id = c.product_id
     left join public.nutrition_facts f on f.id = c.nutrition_fact_id
     where s.version_id = $1
     order by s.sort_order, c.sort_order`,
    [versionId],
  );
  return filas;
}
