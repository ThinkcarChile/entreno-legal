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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvLocal } from "./env-local.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

loadEnvLocal(root);

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

/* --------------------------------------------------- avisos ya revisados */

/**
 * Avisos del advisor de seguridad que se aceptan, y por qué.
 *
 * Silenciar un aviso "porque sí" es peor que no mirarlo: deja el mismo texto
 * verde con menos información. Aquí cada aviso aceptado va con su objeto y su
 * motivo, y la lista se comprueba en los dos sentidos:
 *
 *   · un aviso que NO esté en la lista es un fallo, aunque sea del mismo tipo
 *     que otro ya aceptado —una función nueva se revisa antes de aceptarse—;
 *   · un objeto de la lista que el advisor ya NO reporta también es un fallo,
 *     para que la lista no envejezca sola.
 */
const AVISOS_ACEPTADOS: Record<string, { motivo: string; objetos: readonly string[] }> = {
  auth_leaked_password_protection: {
    motivo:
      "Supabase solo permite activarlo desde el plan Pro (la API responde 402 en " +
      "Free) y el proyecto de desarrollo es Free. Mientras tanto, el mínimo de 8 " +
      "caracteres lo impone la propia aplicación al registrarse y al cambiar la " +
      "clave. EN PRODUCCIÓN, que será de pago, hay que activarlo y quitar esta " +
      "entrada: en cuanto esté activo el advisor deja de reportarlo y esta lista " +
      "falla por sobrar, que es justo lo que se quiere",
    objetos: ["Leaked Password Protection Disabled"],
  },
  authenticated_security_definer_function_executable: {
    motivo:
      "son las 16 RPC del marketplace: existen justamente para que las llame " +
      "quien tiene sesión, y cada una comprueba auth.uid() antes de actuar",
    objetos: [
      "public.accept_job_offer",
      "public.cancel_job",
      "public.complete_onboarding",
      "public.generate_handoff_code",
      "public.mark_conversation_read",
      "public.mark_notifications_read",
      "public.open_job_conversation",
      "public.publish_job",
      "public.request_worker_verification",
      "public.review_worker_verification",
      "public.set_account_modes",
      "public.set_worker_service_areas",
      "public.start_protected_payment",
      "public.update_open_job",
      "public.verify_handoff_code",
      "public.withdraw_job_offer",
    ],
  },
};

interface Lint {
  name: string;
  level: string;
  title: string;
  metadata?: { schema?: string; name?: string } | null;
}

function objetoDe(lint: Lint): string {
  const esquema = lint.metadata?.schema;
  const nombre = lint.metadata?.name;
  if (esquema && nombre) return `${esquema}.${nombre}`;
  return nombre ?? lint.title;
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
  check("migraciones en el historial", inv.migraciones, 19);

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

  console.log("\n── Configuración del proyecto ──\n");

  // Lo que no cabe en una migración. `docs/DESPLIEGUE-SUPABASE.md` §4.1 lo pide
  // como obligatorio, y hasta ahora solo lo pedía: nada lo comprobaba, así que
  // un proyecto sin las URLs de retorno pasaba el inventario entero en verde y
  // el fallo aparecía recién al pinchar el enlace de un correo.
  const auth = (await api(`/v1/projects/${REF}/config/auth`)) as {
    uri_allow_list?: string;
  };
  const permitidas = (auth.uri_allow_list ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const callback = `${siteUrl}/auth/callback`;
  check(
    "URL de retorno de autenticación autorizada",
    permitidas.includes(callback) ? callback : `falta ${callback} (hay: ${permitidas.join(", ") || "ninguna"})`,
    callback,
  );

  console.log("\n── Advisors ──\n");

  let securityLeido = false;
  const aceptadosVistos = new Set<string>();

  for (const kind of ["security", "performance"] as const) {
    let lints: Lint[] = [];
    try {
      const body = (await api(`/v1/projects/${REF}/advisors/${kind}`)) as { lints?: Lint[] };
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

    if (kind !== "security") {
      // El advisor de rendimiento informa, no bloquea: sus avisos son consejos
      // de optimización, no agujeros. Se resumen por tipo y no se listan uno a
      // uno, que es lo que antes llenaba la pantalla y escondía lo importante.
      const porTipo = new Map<string, number>();
      for (const l of [...errores, ...avisos]) {
        porTipo.set(l.name, (porTipo.get(l.name) ?? 0) + 1);
      }
      for (const [nombre, cuantos] of [...porTipo].sort((a, b) => b[1] - a[1])) {
        console.log(`     · ${nombre}: ${cuantos}`);
      }
      continue;
    }

    // Seguridad: un aviso no se ignora. O está revisado y en la lista, o falla.
    for (const l of [...errores, ...avisos]) {
      const objeto = objetoDe(l);
      const aceptado = l.level === "WARN" && AVISOS_ACEPTADOS[l.name]?.objetos.includes(objeto);
      if (aceptado) {
        aceptadosVistos.add(`${l.name}\u0000${objeto}`);
        continue;
      }
      console.log(`     ✗ [${l.level}] ${l.name}: ${objeto} — ${l.title}`);
      failures += 1;
    }

    for (const [nombre, entrada] of Object.entries(AVISOS_ACEPTADOS)) {
      const vistos = entrada.objetos.filter((o) => aceptadosVistos.has(`${nombre}\u0000${o}`));
      if (vistos.length > 0) {
        console.log(`     ~ ${nombre}: ${vistos.length} aceptados — ${entrada.motivo}`);
      }
      // Una lista de excepciones que ya no corresponde a nada es una mentira
      // que se va acumulando. Si el advisor dejó de reportarlo, sobra.
      for (const objeto of entrada.objetos) {
        if (!aceptadosVistos.has(`${nombre}\u0000${objeto}`)) {
          console.log(
            `     ✗ ${nombre}: ${objeto} está en la lista de aceptados pero el ` +
              `advisor ya no lo reporta. Quítalo de AVISOS_ACEPTADOS.`,
          );
          failures += 1;
        }
      }
    }
  }

  if (failures === 0) {
    console.log(
      `\n✓ ${n} comprobaciones pasaron` +
        (securityLeido ? " y el advisor de seguridad no reporta nada sin revisar" : "") +
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
