/**
 * Inventario del esquema de un proyecto Supabase ALOJADO, más los avisos de
 * los advisors de seguridad y rendimiento.
 *
 *   npm run verify:schema:hosted
 *
 * Es el equivalente remoto de `supabase/tests/05_schema_inventory.sql`, que
 * corre contra el PostgreSQL local dentro de `npm run db:test`. Las cifras
 * esperadas son las mismas a propósito: si divergen, o falta una migración en
 * el proyecto alojado, o alguien cambió el esquema sin actualizar el inventario.
 *
 * Solo lee. No escribe nada. Necesita `SUPABASE_ACCESS_TOKEN`.
 *
 * Sale con código distinto de cero si alguna comprobación falla o si los
 * advisors reportan algún aviso de seguridad.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function loadEnvLocal(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(resolve(root, file), "utf8");
      for (const line of raw.split("\n")) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "").trim();
        if (value && !process.env[match[1]]) process.env[match[1]] = value;
      }
    } catch {
      // Puede no existir.
    }
  }
}

loadEnvLocal();

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
const API = process.env.SUPABASE_API_URL ?? "https://api.supabase.com";

function projectRef(): string {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
}

const REF = projectRef();

if (!TOKEN || !REF) {
  console.error("\n✗ Faltan variables para consultar el proyecto:\n");
  if (!TOKEN) console.error("   · SUPABASE_ACCESS_TOKEN");
  if (!REF) console.error("   · SUPABASE_PROJECT_REF (o NEXT_PUBLIC_SUPABASE_URL)");
  console.error("\nColócalas en apps/web/.env.local.\n");
  process.exit(1);
}

/* ----------------------------------------------------------------- llamadas */

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = parsed.message ?? parsed.error ?? text;
    } catch {
      // Texto crudo.
    }
    throw new Error(`HTTP ${response.status} en ${path} · ${detail}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

async function query<T>(sql: string): Promise<T[]> {
  return (await api(`/v1/projects/${REF}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: sql }),
  })) as T[];
}

/* -------------------------------------------------------------- resultados */

let failures = 0;
let n = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  n += 1;
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  const id = `V${String(n).padStart(2, "0")}`;
  console.log(
    `  ${ok ? "✓" : "✗"} ${id} ${label} = ${actual}` +
      (ok ? "" : `  FALLO (esperado ${expected})`),
  );
}

/* ------------------------------------------------------------------ proceso */

async function main(): Promise<void> {
  console.log(`\n══ Inventario del esquema · proyecto ${REF} ══\n`);

  const [inv] = await query<Record<string, number>>(`
    select
      (select count(*) from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE')     as tablas,
      (select count(*) from information_schema.views
        where table_schema = 'public')                                   as vistas,
      (select count(*) from information_schema.routines
        where routine_schema = 'public')                                 as funciones,
      (select count(*) from pg_type t join pg_namespace ns on ns.oid = t.typnamespace
        where ns.nspname = 'public' and t.typtype = 'e')                 as enums,
      (select count(*) from pg_policies where schemaname = 'public')     as politicas,
      (select count(*) from storage.buckets)                             as buckets,
      (select count(*) from pg_policies where schemaname = 'storage')    as politicas_storage,
      (select count(*) from public.communes)                             as comunas,
      (select count(*) from public.regions)                              as regiones,
      (select count(*) from public.job_categories)                       as categorias,
      (select commission_bps from public.platform_settings)              as comision_pb,
      (select count(*) from supabase_migrations.schema_migrations)       as migraciones;
  `);

  check("tablas en public", inv.tablas, 32);
  check("vistas en public", inv.vistas, 5);
  check("funciones en public", inv.funciones, 16);
  check("enums", inv.enums, 19);
  check("políticas RLS en public", inv.politicas, 73);
  check("buckets de Storage", inv.buckets, 5);
  check("políticas de Storage", inv.politicas_storage, 11);
  check("comunas", inv.comunas, 346);
  check("regiones", inv.regiones, 16);
  check("categorías de trabajo", inv.categorias, 9);
  check("comisión (puntos base)", inv.comision_pb, 1400);
  check("migraciones en el historial", inv.migraciones, 18);

  console.log("\n── Seguridad del esquema ──\n");

  const sinRls = await query<{ relname: string }>(`
    select c.relname from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     order by 1;
  `);
  check(
    "tablas sin RLS",
    sinRls.length === 0 ? "ninguna" : sinRls.map((r) => r.relname).join(", "),
    "ninguna",
  );

  const sinInvoker = await query<{ relname: string }>(`
    select c.relname from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'v'
       and not coalesce((
         select option_value::boolean from pg_options_to_table(c.reloptions)
          where option_name = 'security_invoker'), false)
     order by 1;
  `);
  check(
    "vistas sin security_invoker",
    sinInvoker.length === 0 ? "ninguna" : sinInvoker.map((r) => r.relname).join(", "),
    "ninguna",
  );

  // El rol anónimo no debe poder escribir en ninguna tabla de negocio.
  const escrituraAnon = await query<{ table_name: string }>(`
    select distinct table_name from information_schema.role_table_grants
     where grantee = 'anon' and table_schema = 'public'
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
     order by 1;
  `);
  check(
    "tablas con escritura para anon",
    escrituraAnon.length === 0 ? "ninguna" : escrituraAnon.map((r) => r.table_name).join(", "),
    "ninguna",
  );

  // Las funciones privilegiadas deben tener search_path fijado: si no, quien
  // pueda crear objetos en otro esquema puede secuestrar la resolución.
  const definerSinPath = await query<{ proname: string }>(`
    select p.proname from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname in ('public', 'app_private')
       and p.prosecdef
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
          where cfg like 'search_path=%')
     order by 1;
  `);
  check(
    "funciones SECURITY DEFINER sin search_path",
    definerSinPath.length === 0 ? "ninguna" : definerSinPath.map((r) => r.proname).join(", "),
    "ninguna",
  );

  console.log("\n── Realtime ──\n");

  const realtime = await query<{ tablename: string }>(`
    select tablename from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
     order by 1;
  `);
  const esperadasRt = ["conversations", "job_evidence", "messages", "notifications"];
  check(
    "tablas en la publicación supabase_realtime",
    realtime.map((r) => r.tablename).join(", ") || "ninguna",
    esperadasRt.join(", "),
  );

  console.log("\n── Advisors ──\n");

  let securityLeido = false;

  for (const kind of ["security", "performance"] as const) {
    let lints: Array<{ name: string; level: string; title: string }> = [];
    try {
      const body = (await api(`/v1/projects/${REF}/advisors/${kind}`)) as {
        lints?: Array<{ name: string; level: string; title: string }>;
      };
      lints = body.lints ?? [];
      if (kind === "security") securityLeido = true;
    } catch (error) {
      console.log(`  ✗ no se pudo leer el advisor de ${kind}: ${(error as Error).message}`);
      // No poder leerlo no es lo mismo que que esté limpio. En seguridad, la
      // diferencia importa: se cuenta como fallo.
      if (kind === "security") failures += 1;
      continue;
    }

    const errores = lints.filter((l) => l.level === "ERROR");
    const avisos = lints.filter((l) => l.level === "WARN");
    console.log(
      `  ${kind}: ${errores.length} errores, ${avisos.length} avisos, ` +
        `${lints.length - errores.length - avisos.length} informativos`,
    );
    for (const l of [...errores, ...avisos]) {
      console.log(`     [${l.level}] ${l.name}: ${l.title}`);
    }

    // Un aviso de seguridad no se ignora.
    if (kind === "security" && errores.length + avisos.length > 0) {
      failures += errores.length + avisos.length;
    }
  }

  if (failures === 0) {
    console.log(
      `\n✓ ${n} comprobaciones pasaron` +
        (securityLeido ? " y el advisor de seguridad no reporta nada" : "") +
        ".\n",
    );
  } else {
    const plural = failures === 1 ? "problema" : "problemas";
    console.log(`\n✗ ${failures} ${plural}. Revisa las líneas marcadas.\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}\n`);
  process.exit(1);
});
