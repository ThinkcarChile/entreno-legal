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
 * Avisos del advisor de seguridad que se aceptan, y por qué CADA UNO.
 *
 * Silenciar un aviso "porque sí" es peor que no mirarlo: deja el mismo texto
 * verde con menos información. Y aceptar un grupo entero con un motivo común es
 * casi lo mismo, porque el motivo deja de decir nada del objeto concreto. Por
 * eso el motivo va por objeto, no por tipo de aviso.
 *
 * La lista se comprueba en los dos sentidos:
 *
 *   · un aviso que NO esté en la lista es un fallo, aunque sea del mismo tipo
 *     que otro ya aceptado —una función nueva se audita antes de aceptarse—;
 *   · un objeto de la lista que el advisor ya NO reporta también es un fallo,
 *     para que la lista no envejezca sola.
 *
 * Las catorce funciones se auditaron una por una en la Etapa 2.5: quién debe
 * llamarlas, qué escritura concreta les negaría RLS al llamante, qué comprueban
 * por dentro y qué prueba negativa lo respalda. El detalle está en
 * `docs/BASE-DE-DATOS.md`. `mark_conversation_read` y `mark_notifications_read`
 * salieron de esta lista en esa misma auditoría: no necesitaban SECURITY
 * DEFINER y pasaron a INVOKER.
 */
const AVISOS_ACEPTADOS: Record<string, Record<string, string>> = {
  auth_leaked_password_protection: {
    "Leaked Password Protection Disabled":
      "Supabase solo permite activarlo desde el plan Pro (la API responde 402 en Free) y el " +
      "proyecto de desarrollo es Free. El mínimo de 8 caracteres lo impone mientras tanto la " +
      "aplicación. EN PRODUCCIÓN, que será de pago, hay que activarlo y quitar esta entrada.",
  },
  authenticated_security_definer_function_executable: {
    "public.accept_job_offer":
      "La llama el cliente dueño del trabajo. Inserta en assignments y conversations, que no " +
      "tienen política de INSERT para nadie, y escribe audit_logs. Comprueba pertenencia, " +
      "estado del trabajo y de la oferta, y bloquea la fila del trabajo para serializar.",
    "public.cancel_job":
      "La llama el cliente dueño, o la administración. Escribe jobs.status, y desde la " +
      "migración …000100 el usuario no tiene UPDATE sobre jobs en absoluto.",
    "public.complete_onboarding":
      "La llama el propio usuario. Escribe profiles.roles y onboarding_completed_at, que están " +
      "fuera de su concesión de columna, y crea sus filas de user_private_data y loyalty.",
    "public.generate_handoff_code":
      "La llama el cliente de la asignación. Escribe handoff_codes, tabla que solo tiene " +
      "política de SELECT: el PIN no puede nacer de una escritura del usuario.",
    "public.open_job_conversation":
      "La llaman cliente y trabajador con una oferta de por medio. Inserta en conversations, " +
      "que no tiene política de INSERT, y comprueba que exista esa relación real.",
    "public.publish_job":
      "La llama cualquier cliente. Inserta en jobs y job_private_location —el usuario ya no " +
      "tiene INSERT en ninguna de las dos— y calcula precio y comisión en el servidor.",
    "public.request_worker_verification":
      "La llama el trabajador. Inserta en worker_verifications y pone " +
      "worker_profiles.verification_status en PENDING, columna fuera de su concesión: es " +
      "justo la que no puede escribirse a mano.",
    "public.review_worker_verification":
      "SOLO la administración: primera línea del cuerpo es app_private.is_admin(), que lee " +
      "profiles.role, columna que ningún usuario puede escribir (ni por UPDATE ni por INSERT). " +
      "Resuelve la verificación y mueve el nivel del trabajador.",
    "public.set_account_modes":
      "La llama el propio usuario. Escribe profiles.roles, fuera de su concesión de columna.",
    "public.set_worker_service_areas":
      "La llama el trabajador. Reemplaza sus filas de worker_service_areas, donde el usuario ya " +
      "no tiene INSERT desde la migración …000100.",
    "public.start_protected_payment":
      "La llama el cliente de la asignación. Inserta en payments, tabla sin ninguna vía de " +
      "escritura para el usuario, y calcula importe y comisión desde la base.",
    "public.update_open_job":
      "La llama el cliente dueño mientras el trabajo sigue abierto. Escribe jobs y " +
      "job_private_location, donde el usuario no tiene UPDATE ni INSERT.",
    "public.verify_handoff_code":
      "La llama el trabajador asignado. Necesita LEER handoff_codes, que él no puede leer —el " +
      "PIN es del cliente— para comparar sin revelarlo, y contar los intentos.",
    "public.withdraw_job_offer":
      "La llama el trabajador autor de la oferta. Escribe job_offers.status, columna que quedó " +
      "fuera de su concesión en la migración …000200 precisamente para que no pueda aceptarse " +
      "su propia oferta.",
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
  check("funciones en public", inv.funciones, 17);
  check("enums", inv.enums, 19);
  check("políticas RLS en public", inv.politicas, 73);
  check("buckets de Storage", inv.buckets, 5);
  check("políticas de Storage", inv.politicas_storage, 11);
  check("comunas", inv.comunas, 346);
  check("regiones", inv.regiones, 16);
  check("categorías de trabajo", inv.categorias, 9);
  check("comisión (puntos base)", inv.comision_pb, 1400);
  check("migraciones en el historial", inv.migraciones, 23);

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
      const aceptado = l.level === "WARN" && Boolean(AVISOS_ACEPTADOS[l.name]?.[objeto]);
      if (aceptado) {
        aceptadosVistos.add(`${l.name}\u0000${objeto}`);
        continue;
      }
      console.log(`     ✗ [${l.level}] ${l.name}: ${objeto} — ${l.title}`);
      failures += 1;
    }

    for (const [nombre, objetos] of Object.entries(AVISOS_ACEPTADOS)) {
      const entradas = Object.entries(objetos);
      const vistos = entradas.filter(([o]) => aceptadosVistos.has(`${nombre}\u0000${o}`));
      if (vistos.length > 0) {
        console.log(`     ~ ${nombre}: ${vistos.length} revisados uno a uno`);
        for (const [objeto, motivo] of vistos) {
          console.log(`        · ${objeto}: ${motivo}`);
        }
      }
      // Una lista de excepciones que ya no corresponde a nada es una mentira
      // que se va acumulando. Si el advisor dejó de reportarlo, sobra.
      for (const [objeto] of entradas) {
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
