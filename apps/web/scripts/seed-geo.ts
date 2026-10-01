/**
 * Genera supabase/seed/001_geo.sql a partir de la MISMA fuente que consume la
 * aplicación (src/lib/geo/chile.ts), importándola directamente.
 *
 * Una sola fuente evita el desfase clásico entre las comunas que ofrece la
 * interfaz y las que la base acepta como clave foránea.
 *
 *   npm run seed:geo
 *
 * Con `--migracion <ruta>` escribe las MISMAS filas como una migración nueva
 * (así nació 20260601001900_geo_reference_data.sql: los datos geográficos
 * hacen falta en todos los entornos, producción incluida, y una migración no
 * se puede saltar). Se niega a sobrescribir un archivo que ya exista: una
 * migración aplicada no se reescribe. Si cambia la lista de comunas, se
 * regenera la semilla y se escribe OTRA migración con las filas nuevas.
 *
 *   node scripts/seed-geo.ts --migracion supabase/migrations/<marca>_<nombre>.sql
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { regions } from "../src/lib/geo/chile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const seedHeader = [
  "-- =============================================================================",
  "-- HagoTuFila · Semilla geográfica: regiones y comunas de Chile",
  "-- =============================================================================",
  "-- GENERADO AUTOMÁTICAMENTE. No editar a mano.",
  "-- Fuente: src/lib/geo/chile.ts · Regenerar con: npm run seed:geo",
  "-- =============================================================================",
  "",
];

const migrationHeader = [
  "-- =============================================================================",
  "-- HagoTuFila · Regiones y comunas de Chile en todos los entornos",
  "-- =============================================================================",
  "-- Migración correctiva. No modifica migraciones anteriores.",
  "--",
  "-- DEFECTO, encontrado por la auditoría y comprobado contra una base sin la",
  "-- semilla: las migraciones solo cargaban el país y las categorías. Las 16",
  "-- regiones y las 346 comunas venían de `supabase/seed/001_geo.sql`, que la",
  "-- documentación prohibía aplicar en producción. Sin ellas nadie termina el",
  "-- registro (`profiles.region_code` y `commune_code` son claves foráneas) ni",
  "-- publica un trabajo (`publish_job` exige la comuna).",
  "--",
  "-- Son datos de referencia, no de demostración: no crean cuentas. Viajan con",
  "-- el esquema para que `supabase db push`, `npm run db:push:hosted` y la",
  "-- integración continua los dejen en cualquier proyecto sin un paso aparte.",
  "-- Las filas son las mismas que las de la semilla, y `on conflict do nothing`",
  "-- deja intacto un proyecto donde la semilla ya se aplicó.",
  "--",
  "-- GENERADA con `node scripts/seed-geo.ts --migracion <ruta>` desde",
  "-- src/lib/geo/chile.ts, la misma fuente que la semilla. No editar a mano.",
  "-- =============================================================================",
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

/** Las sentencias, idénticas en la semilla y en la migración. */
const body = [
  "insert into public.countries (code, name, currency, default_timezone)",
  "values ('CL', 'Chile', 'CLP', 'America/Santiago')",
  "on conflict (code) do nothing;",
  "",
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
];

const flag = process.argv.indexOf("--migracion");

if (flag >= 0) {
  const path = process.argv[flag + 1];
  if (!path || !/^\d+_[a-z0-9_]+\.sql$/.test(path.split("/").pop() ?? "")) {
    console.error("Uso: node scripts/seed-geo.ts --migracion supabase/migrations/<marca>_<nombre>.sql");
    process.exit(1);
  }
  const target = resolve(root, path);
  if (existsSync(target)) {
    console.error(`✗ ${target} ya existe. Una migración aplicada no se reescribe: usa otra marca.`);
    process.exit(1);
  }
  writeFileSync(target, [...migrationHeader, ...body].join("\n"), "utf8");
  console.log(`Generada ${target}`);
} else {
  const target = resolve(root, "supabase/seed/001_geo.sql");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, [...seedHeader, ...body].join("\n"), "utf8");
  console.log(`Generado ${target}`);
}

console.log(`  ${regions.length} regiones, ${communeRows.length} comunas`);
