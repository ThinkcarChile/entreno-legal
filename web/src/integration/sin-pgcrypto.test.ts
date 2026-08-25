import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

/**
 * PostgreSQL SIN pgcrypto — el entorno que de verdad tenemos.
 *
 * La demo viva del Sprint 10 falló con "function gen_random_bytes(integer)
 * does not exist": el código usaba pgcrypto, PGlite la tenía cargada en el
 * arnés, y en Supabase vive en el schema `extensions` — invisible para una
 * función SECURITY DEFINER con `search_path = public`. 518 tests verdes y la
 * app rota en producción.
 *
 * Este arnés levanta la MISMA cadena sin pgcrypto: si algún día vuelve a
 * colarse una dependencia de esa extensión, falla acá y no en la cocina.
 */

const ROOT = path.resolve(__dirname, "../../..");

const MIGRACIONES = [
  "0001_family.sql", "0002_catalog.sql", "0003_recipes.sql",
  "0004_publish_consistency_guard.sql", "0005_profiles_and_portions.sql",
  "0006_component_roles.sql", "0007_weekly_planning.sql",
  "0008_participants_and_serving_lifecycle.sql", "0009_shopping.sql",
  "0010_hardening_sprint6.sql", "0011_inventory.sql",
  "0012_consumption_shortfall.sql", "0013_stock_intelligence.sql",
  "0014_procurement.sql", "0015_batch_prep.sql", "0016_freezing_rules.sql",
  "0017_random_without_pgcrypto.sql",
];

// El mismo entorno que el arnés real (roles incluidos), sin pgcrypto.
const ENTORNO = `
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

let db: PGlite;

beforeAll(async () => {
  // A propósito: SIN pgcrypto. Solo pg_trgm (que el catálogo sí necesita).
  db = await PGlite.create({ extensions: { pg_trgm } });
  await db.exec("create extension if not exists pg_trgm;");
  await db.exec(ENTORNO);
  for (const m of MIGRACIONES) {
    await db.exec(readFileSync(path.join(ROOT, "supabase/migrations", m), "utf8"));
  }
}, 120000);

afterAll(async () => {
  await db?.close();
});

describe("la cadena completa levanta sin pgcrypto", () => {
  it("gen_random_bytes NO existe en este entorno (como en Supabase con search_path=public)", async () => {
    await expect(db.query("select gen_random_bytes(4)")).rejects.toThrow(/does not exist/);
  });

  it("gen_random_uuid SÍ existe: es nativa de PostgreSQL, sin extensión", async () => {
    const r = await db.query<{ u: string }>("select gen_random_uuid()::text as u");
    expect(r.rows[0]!.u).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ninguna función del proyecto depende de pgcrypto", async () => {
    const r = await db.query<{ nombre: string }>(
      `select p.proname as nombre
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app')
         and p.prosrc like '%gen_random_bytes%'`,
    );
    expect(r.rows.map((x) => x.nombre)).toEqual([]);
  });

  it("el token del QR y el código de paquete se generan igual (32 y 8 hex)", async () => {
    const token = await db.query<{ t: string }>(
      "select replace(gen_random_uuid()::text, '-', '') as t",
    );
    expect(token.rows[0]!.t).toMatch(/^[0-9a-f]{32}$/);
    const code = await db.query<{ c: string }>(
      "select 'PKG-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)) as c",
    );
    expect(code.rows[0]!.c).toMatch(/^PKG-[0-9A-F]{8}$/);
  });
});
