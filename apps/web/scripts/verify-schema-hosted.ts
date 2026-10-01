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
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvLocal } from "./env-local.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

loadEnvLocal(root);

/** Migraciones del repositorio: lo que el historial remoto tiene que tener. */
function repoMigrations(): number {
  return readdirSync(resolve(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).length;
}

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
 * Las catorce primeras se auditaron una por una en la Etapa 2.5, y las veinte
 * del Bloque 3 al escribirlas: quién debe llamarlas, qué escritura concreta les
 * negaría RLS al llamante, qué comprueban por dentro y qué prueba negativa lo
 * respalda. El detalle está en `docs/BASE-DE-DATOS.md`.
 * `mark_conversation_read` y `mark_notifications_read` salieron de esta lista en
 * aquella auditoría: no necesitaban SECURITY DEFINER y pasaron a INVOKER.
 *
 * Nota que vale para las veinte del Bloque 3: todas escriben tablas sobre las
 * que `authenticated` ya no tiene ningún privilegio de escritura —`assignments`,
 * `job_evidence`, `job_extensions`, `handoff_codes`, `disputes`, `payouts`,
 * `reviews`, `assignment_check_ins`— y todas empiezan por
 * `app_private.lock_assignment_for`, que exige sesión, comprueba el papel de
 * quien llama y bloquea jobs → assignments en el orden canónico. Las cinco de
 * administración comprueban `app_private.is_admin()` en su primera línea.
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
      "Resuelve solo una solicitud PENDING, con la fila bloqueada (…001140), y mueve el nivel " +
      "del trabajador.",
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
    "public.mark_on_the_way":
      "La llama el trabajador asignado. Escribe assignments.status y on_the_way_at, columnas " +
      "sobre las que el usuario perdió el UPDATE en la migración …000100 del Bloque 3. " +
      "Comprueba el papel y el estado de partida, y es idempotente.",
    "public.register_check_in":
      "La llama el trabajador asignado. Inserta en assignment_check_ins, tabla sin política de " +
      "INSERT para nadie, y calcula la distancia contra job_private_location, que el trabajador " +
      "puede leer pero no contrastar por sí solo. La hora es del servidor.",
    "public.start_job_work":
      "La llama el trabajador asignado. Escribe assignments y jobs, y exige un check-in " +
      "verificado o aprobado a mano: la condición vive aquí porque el usuario no puede leer el " +
      "estado de revisión de otro ni escribirlo.",
    "public.add_job_evidence":
      "La llaman las dos partes. Inserta en job_evidence, cuyo INSERT se revocó en el Bloque 3 " +
      "precisamente para que nadie pueda forjar un hito del sistema escribiendo evidence_type.",
    "public.request_job_extension":
      "La llama el trabajador asignado. Inserta en job_extensions, sin política de INSERT, y " +
      "calcula el importe desde la tarifa acordada: si viniera del navegador sería editable.",
    "public.answer_job_extension":
      "La llama el cliente. Escribe job_extensions y crea el pago adicional. El UPDATE de esa " +
      "tabla se revocó en el Bloque 3: antes un participante podía aceptar su propia extensión.",
    "public.start_extension_payment":
      "La llama el cliente. Devuelve el pago del tiempo adicional bajo bloqueo; payments no " +
      "tiene ninguna vía de escritura para el usuario.",
    "public.get_handoff_code":
      "La llama el cliente. Es la ÚNICA vía de lectura del PIN: handoff_codes dejó de tener " +
      "política de lectura para usuarios en el Bloque 3, así que el código no sale por una " +
      "consulta.",
    "public.request_handoff_code":
      "La llama el trabajador asignado. Solo emite un aviso al cliente; no devuelve el código " +
      "ni lo escribe en ninguna parte.",
    "public.request_job_completion":
      "La llama el trabajador asignado. Escribe assignments y jobs. No libera dinero: eso es de " +
      "approve_job_completion, y la separación es justamente lo que impide que una parte cobre " +
      "sola.",
    "public.approve_job_completion":
      "La llama el cliente. Escribe assignments, jobs y payouts —ninguna escribible por el " +
      "usuario— y es lo único que libera el pago al trabajador. Rechaza aprobar con una disputa " +
      "abierta.",
    "public.submit_review":
      "La llama cualquiera de las dos partes. El INSERT directo en reviews se revocó en el " +
      "Bloque 3: la función comprueba que el trabajo esté aprobado y calcula a quién se reseña.",
    "public.open_dispute":
      "La llaman las dos partes. El INSERT directo en disputes se revocó: con él se podía " +
      "insertar una disputa ya RESUELTA a favor de quien la abría.",
    "public.add_dispute_evidence":
      "La llaman las partes y la administración. dispute_evidence tenía política de INSERT y " +
      "ningún privilegio, así que nadie podía aportar una prueba; ahora entra por aquí, con " +
      "validación del archivo.",
    "public.resolve_dispute":
      "SOLO la administración: primera línea del cuerpo es app_private.is_admin(). Decide el " +
      "destino del payout y anota el importe a devolver. No ejecuta ninguna devolución " +
      "bancaria.",
    "public.review_check_in":
      "SOLO la administración: primera línea es app_private.is_admin(). Aprueba o rechaza una " +
      "llegada y con ello habilita o no el comienzo del trabajo.",
    "public.approve_payout":
      "SOLO la administración: primera línea es app_private.is_admin(). authenticated perdió el " +
      "UPDATE sobre payouts en la Etapa 2.5.",
    "public.mark_payout_paid":
      "SOLO la administración: primera línea es app_private.is_admin(). Registra una " +
      "transferencia hecha fuera de la plataforma, con su referencia; no mueve dinero.",
    "public.hold_payout":
      "SOLO la administración: primera línea es app_private.is_admin(). Retiene un pago con " +
      "motivo escrito.",
    "public.adjust_payout":
      "SOLO la administración: primera línea es app_private.is_admin(). authenticated no tiene " +
      "UPDATE sobre payouts. Baja el neto de un payout sin transferir —o lo cancela con 0—, " +
      "nunca lo sube, con motivo escrito; deja audit_logs, línea de tiempo y aviso al trabajador " +
      "(B27–B43, …001610).",
    "public.flag_payment_for_review":
      "SOLO la administración: primera línea es app_private.is_admin(). Pone en revisión manual " +
      "un pago PAID bajo el cerrojo trabajo → asignación → pago → extensión → payout y retiene " +
      "el payout; payments y payouts no tienen ninguna vía de escritura para el usuario. El " +
      "motivo va a audit_logs, no al pago (…001720, C21–C35, C52).",
    "public.release_payment_review":
      "SOLO la administración: primera línea es app_private.is_admin(). Devuelve a PAID solo un " +
      "pago en revisión MANUAL, con el cobro entero y sin devoluciones abiertas, y saca de la " +
      "retención el payout que esa revisión retuvo. Una revisión automática no se puede quitar " +
      "por aquí (…001720, C21–C35, C52).",
    "public.admin_pending_reviews":
      "SOLO la administración: primera línea es app_private.is_admin(). Devuelve recuentos de " +
      "las colas del panel; sin el rol, lanza excepción en vez de contestar cero.",
    "public.admin_payment_review_queue":
      "SOLO la administración: primera línea es app_private.is_admin(). Devuelve la cola «En " +
      "revisión» de /admin/pagos —un pago por fila y su motivo—, que es la misma que cuenta " +
      "admin_pending_reviews (…001510). Necesita leer payment_refunds y payment_attempts, que " +
      "solo administración lee. Solo lee (K01–K10, K29).",
    "public.admin_integrity_alerts":
      "SOLO la administración: primera línea es app_private.is_admin(). Lee " +
      "app_private.integrity_alerts, que nadie con sesión puede leer, para la alerta roja de " +
      "/admin (…001520). Solo lee (K18–K21, K26, K28).",
    "public.acknowledge_integrity_alerts":
      "SOLO la administración: primera línea es app_private.is_admin(). Marca como vistas las " +
      "reglas de invariante rotas en app_private.integrity_alerts —tabla sin ningún privilegio " +
      "para nadie con sesión— y deja una fila en audit_logs. No toca datos de negocio (K19–K20, K28).",
    "public.get_job_instructions":
      "La llama cualquiera con sesión, y solo devuelve algo al cliente del trabajo, al " +
      "trabajador asignado con la asignación viva o a la administración; a cualquier otro, " +
      "NULL. Necesita LEER jobs.instructions, columna sin privilegio de lectura para anon y " +
      "authenticated desde la migración …001100: es la única vía, igual que get_handoff_code.",
    "public.get_my_account":
      "La llama el propio usuario y solo devuelve su fila (where id = auth.uid()). Lee " +
      "profiles.role, roles e is_suspended, columnas sin privilegio de lectura para nadie con " +
      "sesión desde la migración …001110: así nadie averigua quién administra.",
    "public.withdraw_job_offer":
      "La llama el trabajador autor de la oferta. Escribe job_offers.status, columna que quedó " +
      "fuera de su concesión en la migración …000200 precisamente para que no pueda aceptarse " +
      "su propia oferta.",
    "public.request_payment_refund":
      "SOLO la administración: primera línea del cuerpo es app_private.is_admin(). Está " +
      "concedida a authenticated porque el panel la llama con la sesión de quien administra, " +
      "no con la clave de servicio; un usuario común que la invoque por su cuenta choca con " +
      "esa comprobación. Escribe payment_refunds, que no tiene ninguna vía de escritura para " +
      "el usuario, comprueba el saldo devolvible y, ligada a una disputa, que sea de la misma " +
      "asignación, esté resuelta y la devolución no pase de su parte sobre ese cobro (…001610). NO " +
      "devuelve dinero: solo deja la petición. La llamada al proveedor y el cierre son de " +
      "settle_payment_refund, que es exclusiva de service_role.",
    "public.resolve_unknown_refund":
      "SOLO la administración: primera línea del cuerpo es app_private.is_admin(). Cierra una " +
      "devolución con resultado desconocido (UNKNOWN) con lo que muestra el portal de " +
      "Transbank, por la misma vía que el banco (settle_payment_refund), y exige una nota que " +
      "queda en audit_logs. Rechaza las que siguen en curso y una reversa que no sea por el " +
      "total. payment_refunds no tiene ninguna vía de escritura para el usuario (D40–D49).",
    "public.request_attempt_refund":
      "SOLO la administración: primera línea del cuerpo es app_private.is_admin(). Concedida a " +
      "authenticated porque el panel la llama con la sesión de quien administra. Escribe " +
      "payment_attempt_refunds, sin ninguna vía de escritura para el usuario, y solo sobre un " +
      "intento DOUBLE_CHARGE o UNDER_REVIEW que no respalde el pago; el importe lo fija la base " +
      "(el cobro entero del intento). NO devuelve dinero: la llamada al proveedor y el cierre son " +
      "de settle_attempt_refund, exclusiva de service_role (J16–J34).",
    "public.resolve_unknown_attempt_refund":
      "SOLO la administración: primera línea del cuerpo es app_private.is_admin(). Cierra la " +
      "devolución UNKNOWN de un cobro duplicado con lo que muestra el portal de Transbank, por " +
      "settle_attempt_refund, con una nota obligatoria que queda en audit_logs (J29–J30).",
    "public.assignment_payment_states":
      "La llaman el cliente y el trabajador de la asignación, y la administración. Existe " +
      "porque el trabajador ya no lee filas de payments (la política payments_read es del " +
      "cliente y de administración): devuelve solo propósito, estado, importe y fechas de los " +
      "pagos de SUS asignaciones, sin dígitos de tarjeta, autorización, orden de compra ni " +
      "token. Solo lee (D52–D61).",
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

  check("tablas en public", inv.tablas, 36);
  check("vistas en public", inv.vistas, 7);
  check("funciones en public", inv.funciones, 65);
  check("enums", inv.enums, 24);
  check("políticas RLS en public", inv.politicas, 77);
  check("buckets de Storage", inv.buckets, 5);
  // 11 de …000900 y 20260401000100, más las tres de borrado de 20260601001210
  // (avatares propios, y evidencia y archivos de disputa propios sin registrar);
  // 20260601001840 quita las dos lecturas públicas (avatars, job-images), que
  // dejaban listar los buckets sin sesión, y añade la de la carpeta propia de
  // avatars.
  check("políticas de Storage", inv.politicas_storage, 13);
  check("comunas", inv.comunas, 346);
  check("regiones", inv.regiones, 16);
  check("categorías de trabajo", inv.categorias, 9);
  check("comisión (puntos base)", inv.comision_pb, 1400);
  // El esperado sale del propio repositorio: cada archivo de
  // supabase/migrations/ es una migración que tiene que estar aplicada.
  check("migraciones en el historial", inv.migraciones, repoMigrations());

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
    password_min_length?: number | null;
    mailer_templates_confirmation_content?: string | null;
    mailer_templates_recovery_content?: string | null;
    mailer_templates_email_change_content?: string | null;
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

  // §4.1.b. Los formularios piden 8 caracteres, pero la API de Auth es pública:
  // quien la llame directo con la clave publicable pasa con lo que diga el
  // proyecto, que trae 6. El mínimo real es este número.
  const minimo = auth.password_min_length;
  check(
    "largo mínimo de contraseña que exige Auth",
    typeof minimo === "number" && minimo >= 8 ? "8 o más" : `${minimo ?? "sin dato"}`,
    "8 o más",
  );

  // §4.1.c. Con la plantilla por omisión el enlace va por PKCE a
  // `/auth/callback` y solo funciona en el navegador donde se pidió el correo.
  for (const [nombre, contenido, tipo] of [
    ["Confirm signup", auth.mailer_templates_confirmation_content, "email"],
    ["Reset password", auth.mailer_templates_recovery_content, "recovery"],
    ["Change email address", auth.mailer_templates_email_change_content, "email_change"],
  ] as const) {
    // Tolera `{{.TokenHash}}` sin espacios y el `&amp;` que deja un editor HTML.
    const enlace = new RegExp(
      `/auth/confirm\\?token_hash=\\{\\{\\s*\\.TokenHash\\s*\\}\\}(?:&|&amp;)type=${tipo}(?![a-z_])`,
    );
    check(
      `plantilla «${nombre}» con enlace a /auth/confirm`,
      enlace.test(contenido ?? "") ? "sí" : "no: sigue con el enlace por omisión",
      "sí",
    );
  }

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
