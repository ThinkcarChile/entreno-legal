/**
 * Genera supabase/seed/001_geo.sql a partir de la MISMA fuente que consume la
 * aplicación (src/lib/geo/chile.ts), importándola directamente.
 *
 * Una sola fuente evita el desfase clásico entre las comunas que ofrece la
 * interfaz y las que la base acepta como clave foránea.
 *
 *   npm run seed:geo
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { regions } from "../src/lib/geo/chile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../supabase/seed/001_geo.sql");

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const header = [
  "-- =============================================================================",
  "-- HagoTuFila · Semilla geográfica: regiones y comunas de Chile",
  "-- =============================================================================",
  "-- GENERADO AUTOMÁTICAMENTE. No editar a mano.",
  "-- Fuente: src/lib/geo/chile.ts · Regenerar con: npm run seed:geo",
  "-- =============================================================================",
  "",
  "insert into public.countries (code, name, currency, default_timezone)",
  "values ('CL', 'Chile', 'CLP', 'America/Santiago')",
  "on conflict (code) do nothing;",
  "",
];

const regionRows = regions.map(
  (r, index) =>
    `  (${quote(r.code)}, ${quote(r.countryCode)}, ${quote(r.name)}, ` +
    `${quote(r.shortName)}, ${quote(r.ordinal)}, ${quote(r.timezone)}, ${index + 1})`,
);

const communeRows = regions.flatMap((r) =>
  r.communes.map(
    (c) =>
      `  (${quote(c.code)}, ${quote(r.code)}, ${quote(c.name)}, ` +
      `${c.timezone ? quote(c.timezone) : "null"})`,
  ),
);

const sql = [
  ...header,
  "insert into public.regions (code, country_code, name, short_name, ordinal, timezone, sort_order)",
  "values",
  regionRows.join(",\n"),
  "on conflict (code) do nothing;",
  "",
  "insert into public.communes (code, region_code, name, timezone)",
  "values",
  communeRows.join(",\n"),
  "on conflict (code) do nothing;",
  "",
].join("\n");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, sql, "utf8");

console.log(`Generado ${target}`);
console.log(`  ${regions.length} regiones, ${communeRows.length} comunas`);
