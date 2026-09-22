/**
 * Captura de evidencia de una prueba contra Webpay **Integration**.
 *
 *   npm run evidence:webpay -- --lista
 *   npm run evidence:webpay -- --caso "3. Crédito aprobado"
 *   npm run evidence:webpay -- --caso "5. Débito rechazado" --orden HTF-...
 *
 * Después de cada prueba a mano hay que mirar doce cosas: la fila de
 * `payments`, la orden de compra, el importe, el estado del proveedor, el
 * estado interno, los eventos, la auditoría, el trabajo, la asignación, el
 * payout, las notificaciones y los invariantes. Hacerlo a mano doce veces por
 * diecisiete pruebas es como no hacerlo: a la tercera se mira solo el estado.
 *
 * Esto lo lee todo de la base real y lo escribe en
 * `evidencia/webpay-integration.md`, en un formato que sirve para adjuntar a la
 * validación de Transbank.
 *
 * Lo que NUNCA imprime, ni en pantalla ni en el archivo:
 *   · el token completo —solo los seis primeros y los cuatro últimos—;
 *   · claves de Supabase, de Transbank o de cualquier otra cosa;
 *   · números de tarjeta —de la base solo salen los cuatro últimos dígitos,
 *     que es lo único que se guarda—;
 *   · cookies ni JWT;
 *   · correos, RUT ni teléfonos: las personas aparecen por su papel.
 *
 * Se niega a ejecutarse si el pago es de producción.
 *
 * Sale con código distinto de cero si algún invariante está roto.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocal } from "./env-local.ts";
import { maskToken } from "../src/lib/payments/transbank/sanitize.ts";
import { isValidBuyOrder } from "../src/lib/payments/transbank/identifiers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
loadEnvLocal(root);

/* --------------------------------------------------------------- seguridad */

if (process.env.TRANSBANK_ENVIRONMENT === "production") {
  console.error(
    "\n✗ evidence:webpay no se ejecuta con TRANSBANK_ENVIRONMENT=production.\n" +
      "  Es una herramienta de integración: no se asoma a donde el dinero es real.\n",
  );
  process.exit(1);
}

/* ---------------------------------------------------------------- opciones */

interface Opciones {
  caso: string | null;
  orden: string | null;
  ambiente: string;
  lista: boolean;
  sinArchivo: boolean;
}

function opciones(argv: string[]): Opciones {
  const o: Opciones = { caso: null, orden: null, ambiente: "integration", lista: false, sinArchivo: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lista" || arg === "--list") o.lista = true;
    else if (arg === "--sin-archivo") o.sinArchivo = true;
    else if (arg === "--caso" || arg === "--case") o.caso = argv[++i] ?? null;
    else if (arg === "--orden" || arg === "--buy-order") o.orden = argv[++i] ?? null;
    else if (arg === "--ambiente" || arg === "--environment") o.ambiente = argv[++i] ?? "integration";
  }
  // Se puede ensayar el recorrido con el proveedor simulado antes de tocar
  // Transbank —para eso está `--ambiente mock`—, pero producción no se mira
  // desde aquí ni pidiéndolo.
  if (o.ambiente === "production") {
    console.error("\n✗ Esta herramienta no mira pagos de producción.\n");
    process.exit(1);
  }
  return o;
}

/* ------------------------------------------------------------------- tipos */

interface Pago {
  id: string;
  job_id: string;
  assignment_id: string | null;
  extension_id: string | null;
  purpose: string;
  status: string;
  amount: number;
  currency: string;
  provider: string;
  environment: string | null;
  buy_order: string | null;
  session_id: string | null;
  provider_token: string | null;
  provider_transaction_id: string | null;
  provider_status: string | null;
  response_code: number | null;
  vci: string | null;
  authorization_code: string | null;
  card_last_digits: string | null;
  payment_type_code: string | null;
  installments: number | null;
  refunded_amount: number;
  attempt: number;
  failure_reason: string | null;
  transaction_date: string | null;
  accounting_date: string | null;
  authorized_at: string | null;
  paid_at: string | null;
  failed_at: string | null;
  committed_at: string | null;
  reconciled_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNAS =
  "id,job_id,assignment_id,extension_id,purpose,status,amount,currency,provider,environment," +
  "buy_order,session_id,provider_token,provider_transaction_id,provider_status,response_code,vci," +
  "authorization_code,card_last_digits,payment_type_code,installments,refunded_amount,attempt," +
  "failure_reason,transaction_date,accounting_date,authorized_at,paid_at,failed_at,committed_at," +
  "reconciled_at,created_at,updated_at";

/* --------------------------------------------------------------- utilidades */

const CLP = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

function money(valor: number | null | undefined): string {
  return valor == null ? "—" : CLP.format(valor);
}

function fecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", hour12: false });
}

function si(valor: unknown): string {
  return valor == null || valor === "" ? "—" : String(valor);
}

function orThrow<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as T;
}

/* ------------------------------------------------------------- invariantes */

interface Violacion {
  regla: string;
  detalle: string;
}

/**
 * Los invariantes del dinero, acotados a este pago y a su trabajo.
 *
 * `app_private.payment_invariant_violations()` no es invocable por API —vive
 * fuera del esquema expuesto, y así debe seguir—, así que aquí se comprueban
 * las mismas reglas sobre lo que toca esta prueba. No sustituye a `db:test`:
 * lo que hace es que una prueba a mano no pueda darse por buena con el dinero
 * descuadrado.
 */
async function invariantes(
  db: SupabaseClient,
  pago: Pago,
  ventanaDias: number,
): Promise<Violacion[]> {
  const rotos: Violacion[] = [];

  const eventos = orThrow(
    await db.from("payment_events").select("id,from_status,to_status,created_at").eq("payment_id", pago.id),
  ) as { to_status: string }[];
  const asientos = eventos.filter((e) => e.to_status === "PAID" || e.to_status === "AUTHORIZED");
  if (asientos.length > 1) {
    rotos.push({ regla: "un pago, un solo efecto financiero", detalle: `${asientos.length} asientos` });
  }

  const payouts = orThrow(
    await db.from("payouts").select("id,status,net_amount,assignment_id,payment_id").eq("payment_id", pago.id),
  ) as { id: string; status: string; net_amount: number }[];
  if (payouts.length > 1) {
    rotos.push({ regla: "un pago, a lo sumo un payout", detalle: `${payouts.length} payouts` });
  }

  const pagable = payouts.filter((p) => p.status !== "CANCELLED" && p.status !== "HELD");
  if (pagable.length > 0 && !["PAID", "PARTIALLY_REFUNDED"].includes(pago.status)) {
    rotos.push({
      regla: "no se paga al trabajador sin cobro del cliente",
      detalle: `payout ${pagable[0].status} con pago ${pago.status}`,
    });
  }
  if (pagable.length > 0 && pago.status === "REFUNDED") {
    rotos.push({ regla: "un pago devuelto no deja payout pagable", detalle: `payout ${pagable[0].status}` });
  }

  const trabajos = orThrow(await db.from("jobs").select("id,status").eq("id", pago.job_id)) as {
    id: string;
    status: string;
  }[];
  const trabajo = trabajos[0];
  if (trabajo?.status === "CANCELLED" && pagable.length > 0) {
    rotos.push({ regla: "un trabajo cancelado no tiene payout", detalle: `payout ${pagable[0].status}` });
  }

  if (pago.refunded_amount > pago.amount) {
    rotos.push({
      regla: "no se devuelve más de lo cobrado",
      detalle: `${money(pago.refunded_amount)} de ${money(pago.amount)}`,
    });
  }

  const devoluciones = orThrow(
    await db.from("payment_refunds").select("id,amount,status,kind").eq("payment_id", pago.id),
  ) as { amount: number; status: string; kind: string | null }[];
  const confirmadas = devoluciones.filter((d) => d.status === "CONFIRMED");
  const sumaConfirmada = confirmadas.reduce((acc, d) => acc + d.amount, 0);
  if (sumaConfirmada !== pago.refunded_amount) {
    rotos.push({
      regla: "lo devuelto cuadra con las devoluciones confirmadas",
      detalle: `${money(pago.refunded_amount)} en el pago contra ${money(sumaConfirmada)} confirmados`,
    });
  }
  for (const d of confirmadas) {
    if (!d.kind) rotos.push({ regla: "una devolución confirmada dice si fue reversa o anulación", detalle: "kind nulo" });
  }

  const TERMINALES = ["AUTHORIZED", "FAILED", "REVERSED", "NULLIFIED", "PARTIALLY_NULLIFIED", "CAPTURED"];
  const enVuelo = ["PENDING", "CREATED", "AUTHORIZED", "UNDER_REVIEW"].includes(pago.status);
  const antiguedadDias = (Date.now() - new Date(pago.created_at).getTime()) / 86_400_000;
  if (enVuelo && antiguedadDias > ventanaDias) {
    rotos.push({
      regla: "ningún pago sin resolver fuera de la ventana",
      detalle: `${antiguedadDias.toFixed(1)} días con estado ${pago.status}; lo delata stale_payment_out_of_window`,
    });
  }
  if (pago.provider_status && !TERMINALES.includes(pago.provider_status) && ["PAID", "REFUNDED"].includes(pago.status)) {
    rotos.push({
      regla: "no se asienta con una respuesta no final",
      detalle: `${pago.status} con provider_status ${pago.provider_status}`,
    });
  }

  return rotos;
}

/* --------------------------------------------------------------- el informe */

async function informe(db: SupabaseClient, pago: Pago, caso: string, ventanaDias: number): Promise<string> {
  const lineas: string[] = [];
  const w = (linea = ""): void => void lineas.push(linea);

  w(`## ${caso}`);
  w();
  w(`_Capturado el ${fecha(new Date().toISOString())} (hora de Chile)._`);
  w();

  /* 1-5 · el pago */
  w("### 1. El pago");
  w();
  w("| Campo | Valor |");
  w("|---|---|");
  w(`| Orden de compra | \`${si(pago.buy_order)}\` |`);
  w(`| Importe | ${money(pago.amount)} ${pago.currency} |`);
  w(`| Ambiente | ${si(pago.environment)} |`);
  w(`| Proveedor | ${si(pago.provider)} |`);
  w(`| Estado del proveedor | ${si(pago.provider_status)} |`);
  w(`| \`response_code\` | ${si(pago.response_code)} |`);
  w(`| Estado interno | **${pago.status}** |`);
  w(`| Motivo del fallo | ${si(pago.failure_reason)} |`);
  w(`| Propósito | ${pago.purpose}${pago.extension_id ? " (extensión)" : ""} |`);
  w(`| Intento | ${pago.attempt} |`);
  w(`| Código de autorización | ${si(pago.authorization_code)} |`);
  w(`| Tipo de pago | ${si(pago.payment_type_code)} |`);
  w(`| Cuotas | ${si(pago.installments)} |`);
  w(`| Últimos dígitos | ${pago.card_last_digits ? `••••${pago.card_last_digits}` : "—"} |`);
  w(`| \`vci\` (informativo) | ${si(pago.vci)} |`);
  w(`| Token | ${si(maskToken(pago.provider_token))} |`);
  w(`| Devuelto | ${money(pago.refunded_amount)} |`);
  w(`| Creado | ${fecha(pago.created_at)} |`);
  w(`| Fecha de la transacción | ${fecha(pago.transaction_date)} |`);
  w(`| Asentado | ${fecha(pago.committed_at)} |`);
  w(`| Conciliado | ${fecha(pago.reconciled_at)} |`);
  w(`| Autorizado / cobrado / fallido | ${fecha(pago.authorized_at)} / ${fecha(pago.paid_at)} / ${fecha(pago.failed_at)} |`);
  w();

  /* 2 · la orden de compra, comprobada */
  const ordenOk = pago.buy_order != null && isValidBuyOrder(pago.buy_order);
  w("### 2. La orden de compra");
  w();
  w(
    `\`${si(pago.buy_order)}\` — ${pago.buy_order?.length ?? 0} caracteres, ` +
      `${ordenOk ? "válida" : "**FUERA DE FORMATO**"} (máximo 26, sin acentos ni datos personales).`,
  );
  const sesion = pago.session_id ?? "";
  w();
  w(`\`session_id\`: ${sesion.length} caracteres (máximo 61), enlaza con el intento interno.`);
  w();

  /* 6 · eventos */
  const eventos = orThrow(
    await db
      .from("payment_events")
      .select("id,from_status,to_status,provider,provider_event_id,payload,created_at")
      .eq("payment_id", pago.id)
      .order("created_at", { ascending: true }),
  ) as {
    from_status: string | null;
    to_status: string;
    provider: string | null;
    provider_event_id: string | null;
    payload: Record<string, unknown> | null;
    created_at: string;
  }[];
  w("### 3. Eventos del pago");
  w();
  if (eventos.length === 0) w("_Ninguno._");
  else {
    w("| Cuándo | De | A | Motivo | Clave de idempotencia |");
    w("|---|---|---|---|---|");
    for (const e of eventos) {
      const clave = e.provider_event_id?.startsWith("commit:")
        ? `commit:${maskToken(e.provider_event_id.slice(7))}`
        : si(e.provider_event_id);
      const motivo = si(e.payload?.reason ?? e.payload?.operation);
      w(`| ${fecha(e.created_at)} | ${si(e.from_status)} | ${e.to_status} | ${motivo} | \`${clave}\` |`);
    }
  }
  w();

  /* 7 · auditoría */
  const auditoria = orThrow(
    await db
      .from("audit_logs")
      .select("action,entity_type,entity_id,actor_role,created_at")
      .eq("entity_id", pago.id)
      .order("created_at", { ascending: true }),
  ) as { action: string; entity_type: string; actor_role: string | null; created_at: string }[];
  w("### 4. Auditoría");
  w();
  if (auditoria.length === 0) w("_Sin entradas: este recorrido no pasó por una decisión de administración._");
  else {
    w("| Cuándo | Acción | Entidad | Papel |");
    w("|---|---|---|---|");
    for (const a of auditoria) w(`| ${fecha(a.created_at)} | ${a.action} | ${a.entity_type} | ${si(a.actor_role)} |`);
  }
  w();

  /* 8-9 · trabajo y asignación */
  const trabajo = (
    orThrow(await db.from("jobs").select("id,reference,status,starts_at,created_at").eq("id", pago.job_id)) as {
      id: string;
      reference: string;
      status: string;
      starts_at: string | null;
    }[]
  )[0];
  const asignaciones = orThrow(
    await db
      .from("assignments")
      .select("id,status,started_at,completed_at,cancelled_at,extension_minutes,created_at")
      .eq("job_id", pago.job_id)
      .order("created_at", { ascending: true }),
  ) as {
    id: string;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    extension_minutes: number | null;
  }[];

  w("### 5. Trabajo y asignación");
  w();
  w(`Trabajo ${si(trabajo?.reference)}: **${si(trabajo?.status)}**, programado para ${fecha(trabajo?.starts_at)}.`);
  w();
  if (asignaciones.length === 0) w("_Sin asignación._");
  else {
    w("| Asignación | Estado | Iniciada | Completada | Cancelada | Extensión |");
    w("|---|---|---|---|---|---|");
    for (const a of asignaciones) {
      w(
        `| \`${a.id.slice(0, 8)}…\` | ${a.status} | ${fecha(a.started_at)} | ${fecha(a.completed_at)} | ` +
          `${fecha(a.cancelled_at)} | ${a.extension_minutes ?? 0} min |`,
      );
    }
  }
  w();

  /* 10 · payout */
  const payouts = orThrow(
    await db
      .from("payouts")
      .select("id,status,gross_amount,net_amount,commission_amount,held_reason,approved_at,paid_at,created_at")
      .eq("payment_id", pago.id)
      .order("created_at", { ascending: true }),
  ) as {
    id: string;
    status: string;
    gross_amount: number;
    net_amount: number;
    commission_amount: number | null;
    held_reason: string | null;
    approved_at: string | null;
    paid_at: string | null;
  }[];
  w("### 6. Pago al trabajador");
  w();
  if (payouts.length === 0) w("_Ninguno, que es lo correcto si el cobro no llegó a asentarse._");
  else {
    w("| Estado | Bruto | Comisión | Neto | Retención | Aprobado | Pagado |");
    w("|---|---|---|---|---|---|---|");
    for (const p of payouts) {
      w(
        `| ${p.status} | ${money(p.gross_amount)} | ${money(p.commission_amount)} | ${money(p.net_amount)} | ` +
          `${si(p.held_reason)} | ${fecha(p.approved_at)} | ${fecha(p.paid_at)} |`,
      );
    }
  }
  w();

  /* 11 · notificaciones */
  const notificaciones = orThrow(
    await db
      .from("notifications")
      .select("notification_type,created_at,user_id")
      .eq("job_id", pago.job_id)
      .order("created_at", { ascending: true }),
  ) as { notification_type: string; created_at: string; user_id: string }[];
  const destinatarios = new Map<string, number>();
  for (const n of notificaciones) destinatarios.set(n.user_id, (destinatarios.get(n.user_id) ?? 0) + 1);
  w("### 7. Notificaciones");
  w();
  if (notificaciones.length === 0) w("_Ninguna._");
  else {
    w(`${notificaciones.length} para ${destinatarios.size} persona(s). Sin datos personales:`);
    w();
    w("| Cuándo | Tipo |");
    w("|---|---|");
    for (const n of notificaciones) w(`| ${fecha(n.created_at)} | ${n.notification_type} |`);
  }
  w();

  /* 12 · invariantes */
  const rotos = await invariantes(db, pago, ventanaDias);
  w("### 8. Invariantes");
  w();
  if (rotos.length === 0) {
    w(`**Cero violaciones.** Ventana de conciliación configurada: ${ventanaDias} días.`);
  } else {
    w("**VIOLACIONES:**");
    w();
    for (const v of rotos) w(`- ${v.regla} → ${v.detalle}`);
  }
  w();
  w("---");
  w();

  return lineas.join("\n");
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const o = opciones(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "\n✗ Faltan NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SECRET_KEY en .env.local.\n" +
        "  Son del servidor: no se pasan por la línea de órdenes ni se pegan en un chat.\n",
    );
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  /* Listado de órdenes de integración: lo que se adjunta a la validación. */
  if (o.lista) {
    const filas = orThrow(
      await db
        .from("payments")
        .select("buy_order,amount,status,provider_status,response_code,purpose,created_at")
        .eq("environment", o.ambiente)
        .not("buy_order", "is", null)
        .order("created_at", { ascending: false })
        .limit(40),
    ) as {
      buy_order: string;
      amount: number;
      status: string;
      provider_status: string | null;
      response_code: number | null;
      purpose: string;
      created_at: string;
    }[];
    console.log(`\nÓrdenes en ambiente «${o.ambiente}» (${filas.length}):\n`);
    console.log("| Orden de compra | Importe | Fecha y hora | Proveedor | rc | Interno |");
    console.log("|---|---|---|---|---|---|");
    for (const f of filas) {
      console.log(
        `| \`${f.buy_order}\` | ${money(f.amount)} | ${fecha(f.created_at)} | ` +
          `${si(f.provider_status)} | ${si(f.response_code)} | ${f.status} |`,
      );
    }
    console.log();
    return;
  }

  const ajustes = orThrow(
    await db.from("platform_settings").select("reconciliation_window_days").limit(1),
  ) as { reconciliation_window_days: number | null }[];
  const ventanaDias = ajustes[0]?.reconciliation_window_days ?? 7;

  let consulta = db.from("payments").select(COLUMNAS).eq("environment", o.ambiente);
  if (o.orden) consulta = consulta.eq("buy_order", o.orden);
  const pagos = orThrow(
    await consulta.order("created_at", { ascending: false }).limit(1),
  ) as unknown as Pago[];

  const pago = pagos[0];
  if (!pago) {
    console.error(
      o.orden
        ? `\n✗ No hay ningún pago en «${o.ambiente}» con la orden ${o.orden}.\n`
        : `\n✗ No hay ningún pago en «${o.ambiente}» todavía. Haz primero el recorrido.\n`,
    );
    process.exit(1);
  }
  if (pago.environment === "production") {
    console.error("\n✗ El pago es de producción. Esta herramienta no se asoma ahí.\n");
    process.exit(1);
  }

  const caso = o.caso ?? `Pago ${pago.buy_order ?? pago.id.slice(0, 8)}`;
  const texto = await informe(db, pago, caso, ventanaDias);
  console.log(`\n${texto}`);

  if (!o.sinArchivo) {
    const carpeta = resolve(root, "evidencia");
    if (!existsSync(carpeta)) mkdirSync(carpeta, { recursive: true });
    const archivo = resolve(carpeta, "webpay-integration.md");
    if (!existsSync(archivo)) {
      writeFileSync(
        archivo,
        "# Evidencia · Webpay Plus, ambiente de integración\n\n" +
          "Generado por `npm run evidence:webpay`. Sin tokens completos, sin claves,\n" +
          "sin tarjetas y sin datos personales.\n\n---\n\n",
        "utf8",
      );
    }
    appendFileSync(archivo, `${texto}\n`, "utf8");
    console.log(`→ añadido a evidencia/webpay-integration.md`);
  }

  const rotos = await invariantes(db, pago, ventanaDias);
  if (rotos.length > 0) {
    console.error(`\n✗ ${rotos.length} invariante(s) roto(s). La prueba no se da por buena.\n`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error("\n✗ La captura de evidencia se interrumpió:", error instanceof Error ? error.message : error);
  process.exit(1);
});
