import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
const R = "..";
const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
await db.exec("create extension if not exists pg_trgm; create extension if not exists pgcrypto;");
await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;`);
const h = readFileSync("src/integration/harness.ts","utf8");
for (const m of h.match(/supabase\/migrations\/[^"]+\.sql/g)) await db.exec(readFileSync(`${R}/${m}`,"utf8"));
for (const s of h.match(/supabase\/seed\/[^"]+\.sql/g)) await db.exec(readFileSync(`${R}/${s}`,"utf8"));
const ing = await db.query(`
  select i.canonical_name, c.code as categoria,
         string_agg(distinct f.weight_basis::text||' ('||f.basis_unit||')', ', ' order by f.weight_basis::text||' ('||f.basis_unit||')') as bases,
         i.edible_portion_factor as epf,
         coalesce((select string_agg(m.measure_name||' = '||trim(trailing '.' from trim(trailing '0' from m.quantity::text))||' '||m.unit,'; ')
                   from public.household_measures m where m.ingredient_id=i.id),'') as medidas
  from public.ingredients i join public.ingredient_categories c on c.id = i.category_id
  left join public.nutrition_facts f on f.ingredient_id=i.id
  where i.household_id is null group by i.id, i.canonical_name, c.code, i.edible_portion_factor order by c.code, i.canonical_name`);
const rec = await db.query(`select v.name, v.base_servings from public.meal_template_versions v join public.meal_templates t on t.id=v.template_id where t.household_id is null and v.status='PUBLISHED' order by v.name`);
const cap = await db.query(`select code, name from public.equipment_capabilities order by code`);
let out = `# Vocabulario del catálogo — generado, no editar a mano\n\n`;
out += `Generado desde la base real. Es la ÚNICA lista de identidades contra la que la\nbiblioteca puede escribir. Un nombre que no esté acá no existe: o se usa el que sí\nestá, o se declara en \`alimentosNuevos\`.\n\n`;
out += `## Alimentos disponibles (${ing.rows.length})\n\nLa columna **bases** manda: si una receta pide una base que el alimento no tiene, el\ngenerador de seed revienta.\n\n`;
out += `| canonical_name | categoría | bases disponibles | porción comestible | medidas |\n|---|---|---|---|---|\n`;
for (const r of ing.rows) out += `| \`${r.canonical_name}\` | ${r.categoria} | ${r.bases ?? '**SIN FICHA**'} | ${r.epf ?? '—'} | ${r.medidas || '—'} |\n`;
out += `\n## Recetas ya publicadas (${rec.rows.length}) — NINGUNA se puede repetir\n\n`;
for (const r of rec.rows) out += `- ${r.name}\n`;
out += `\n## Capacidades de equipamiento (${cap.rows.length})\n\nSolo estos códigos existen. Toda capacidad se usa como OPCIONAL y exige \`manualAlternative\`.\n\n`;
for (const r of cap.rows) out += `- \`${r.code}\` — ${r.name}\n`;
mkdirSync(`${R}/docs/recetas`, { recursive: true });
writeFileSync(`${R}/docs/recetas/vocabulario-catalogo.md`, out, "utf8");
console.log(`alimentos=${ing.rows.length} recetas=${rec.rows.length}`);
await db.close();
