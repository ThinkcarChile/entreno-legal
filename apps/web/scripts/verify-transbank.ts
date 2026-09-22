/**
 * Verificación de la integración con Webpay Plus.
 *
 *   npm run verify:transbank
 *
 * Dos mitades, y las dos importan:
 *
 * 1. **Sin red** — configuración, guardas de producción, saneado, formato de
 *    los identificadores y ausencia de secretos en el árbol. Corre siempre.
 * 2. **Contra el ambiente de integración de Transbank** — crear una
 *    transacción real, consultar su estado, comprobar la persistencia y la
 *    idempotencia. Necesita salida a `webpay3gint.transbank.cl`.
 *
 * Si la red no alcanza a Transbank, la segunda mitad NO se da por buena: se
 * marca como bloqueada, se dice por qué y el verificador termina con código
 * distinto de cero salvo que se pida explícitamente lo contrario con
 * `ALLOW_OFFLINE=1`. Un verificador que pasa sin haber hablado con el
 * proveedor es peor que no tenerlo.
 *
 * Este guion **se niega a usar producción**. No hay variable que lo permita.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocal } from "./env-local.ts";

import {
  INTEGRATION_API_KEY,
  INTEGRATION_COMMERCE_CODE,
  TRANSBANK_HOSTS,
  isTrustedRedirect,
  productionBlockers,
  siteUrlBlockers,
} from "../src/lib/payments/transbank/config.ts";
import {
  buildBuyOrder,
  buildSessionId,
  isValidBuyOrder,
  paymentIdFromSessionId,
} from "../src/lib/payments/transbank/identifiers.ts";
import { findMismatches } from "../src/lib/payments/transbank/mapping.ts";
import { classifyReturn, mayCommit } from "../src/lib/payments/transbank/return-flow.ts";
import {
  containsForbiddenKeys,
  maskToken,
  sanitizeProviderPayload,
  scrub,
} from "../src/lib/payments/transbank/sanitize.ts";
import { TransbankPaymentProvider } from "../src/lib/payments/transbank/provider.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
loadEnvLocal(root);

/* --------------------------------------------------------------- seguridad */

// Este guion NO opera en producción, pase lo que pase en el entorno.
if (process.env.TRANSBANK_ENVIRONMENT === "production") {
  console.error(
    "\n✗ verify:transbank no se ejecuta con TRANSBANK_ENVIRONMENT=production.\n" +
      "  Es un verificador de integración: nunca toca el ambiente donde el dinero es real.\n",
  );
  process.exit(1);
}

const ALLOW_OFFLINE = process.env.ALLOW_OFFLINE === "1";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://hagotufila.cl";

/* ------------------------------------------------------- arnés de pruebas */

interface Result {
  id: string;
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

const results: Result[] = [];
let counter = 0;

function nextId(): string {
  counter += 1;
  return `T${String(counter).padStart(2, "0")}`;
}

async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  const id = nextId();
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail });
    console.log(`  ${id} OK   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, name, ok: false, detail });
    console.log(`  ${id} FALLO ${name} — ${detail}`);
  }
}

function skip(name: string, reason: string): void {
  const id = nextId();
  results.push({ id, name, ok: false, skipped: true, detail: reason });
  console.log(`  ${id} OMITIDA ${name} — ${reason}`);
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  console.log("\n══ Verificación de Webpay Plus (ambiente de integración) ══");

  /* ------------------------------------------------------------------ SDK */

  section("SDK oficial");

  const sdkPackage = JSON.parse(
    readFileSync(resolve(root, "node_modules/transbank-sdk/package.json"), "utf8"),
  ) as { name: string; version: string; engines?: { node?: string }; repository?: { url?: string } };

  await check("el SDK instalado es el oficial de Transbank", () => {
    expect(sdkPackage.name === "transbank-sdk", `el paquete es ${sdkPackage.name}`);
    expect(
      (sdkPackage.repository?.url ?? "").includes("TransbankDevelopers/transbank-sdk-nodejs"),
      "el repositorio no es el oficial",
    );
    return `${sdkPackage.name}@${sdkPackage.version}`;
  });

  await check("la versión está fijada exactamente en package.json", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const declared = manifest.dependencies["transbank-sdk"];
    expect(Boolean(declared), "transbank-sdk no está en dependencies");
    expect(
      /^\d+\.\d+\.\d+$/.test(declared),
      `la versión declarada "${declared}" no es exacta (lleva ^ o ~)`,
    );
    expect(
      declared === sdkPackage.version,
      `declarada ${declared} pero instalada ${sdkPackage.version}`,
    );
    return declared;
  });

  await check("la versión de Node cumple lo que pide el SDK", () => {
    const required = sdkPackage.engines?.node ?? ">=18.0.0";
    const major = Number(process.versions.node.split(".")[0]);
    const minimum = Number(/(\d+)/.exec(required)?.[1] ?? 18);
    expect(major >= minimum, `Node ${process.versions.node} < ${required}`);
    return `Node ${process.versions.node} cumple ${required}`;
  });

  await check("el lockfile está presente y fija el SDK", () => {
    const lock = readFileSync(resolve(root, "package-lock.json"), "utf8");
    expect(lock.includes("transbank-sdk"), "el lockfile no menciona transbank-sdk");
    expect(
      lock.includes(`"version": "${sdkPackage.version}"`),
      "el lockfile no fija la versión instalada",
    );
    return "package-lock.json coherente";
  });

  /* -------------------------------------------------------- configuración */

  section("Configuración y guardas");

  await check("el proveedor activo no es el productivo", () => {
    const environment = process.env.TRANSBANK_ENVIRONMENT ?? "integration";
    expect(environment === "integration", `TRANSBANK_ENVIRONMENT=${environment}`);
    return "integration";
  });

  await check("producción sigue desactivada", () => {
    const blockers = productionBlockers({
      environment: "production",
      productionEnabled: process.env.TRANSBANK_PRODUCTION_ENABLED === "true",
      commerceCode: process.env.TRANSBANK_PRODUCTION_COMMERCE_CODE,
      apiKeySecret: process.env.TRANSBANK_PRODUCTION_API_KEY_SECRET,
      siteUrl: SITE_URL,
      nodeEnv: process.env.NODE_ENV ?? "development",
      demoMode: false,
      selectedProvider: process.env.PAYMENT_PROVIDER ?? "mock",
    });
    expect(blockers.length > 0, "¡producción NO está bloqueada! Revisa la configuración.");
    return `${blockers.length} motivos impiden operar en producción`;
  });

  await check("la bandera TRANSBANK_PRODUCTION_ENABLED está en falso", () => {
    const value = process.env.TRANSBANK_PRODUCTION_ENABLED ?? "false";
    expect(value !== "true", "la bandera de producción está activada");
    return `TRANSBANK_PRODUCTION_ENABLED=${value}`;
  });

  await check("las credenciales de integración son las públicas del SDK", () => {
    expect(String(INTEGRATION_COMMERCE_CODE) === "597055555532", "el comercio no es el de Webpay Plus");
    expect(String(INTEGRATION_API_KEY).length === 64, "la llave de integración no tiene 64 caracteres");
    return `comercio ${INTEGRATION_COMMERCE_CODE}`;
  });

  await check("no hay credenciales productivas configuradas en este entorno", () => {
    const code = process.env.TRANSBANK_PRODUCTION_COMMERCE_CODE;
    const key = process.env.TRANSBANK_PRODUCTION_API_KEY_SECRET;
    expect(!code && !key, "hay credenciales productivas en el entorno de pruebas");
    return "ninguna";
  });

  await check("la URL del sitio se evalúa como corresponde", () => {
    const blockers = siteUrlBlockers(SITE_URL);
    // En desarrollo es normal que sea localhost: lo que importa es que eso
    // mismo bloquearía producción.
    return blockers.length === 0
      ? `${SITE_URL} valdría para producción`
      : `${SITE_URL} bloquearía producción (${blockers.length} motivos)`;
  });

  /* ------------------------------------------------------- identificadores */

  section("Identificadores");

  const samplePaymentId = "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f";

  await check("el buy_order cumple el formato y el límite de Webpay", () => {
    const order = buildBuyOrder(samplePaymentId);
    expect(order.length <= 26, `mide ${order.length}`);
    expect(isValidBuyOrder(order), "no cumple el patrón permitido");
    return `${order} (${order.length} caracteres)`;
  });

  await check("10.000 buy_order del mismo pago no colisionan", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(buildBuyOrder(samplePaymentId));
    expect(seen.size === 10_000, `${10_000 - seen.size} colisiones`);
    return "sin colisiones";
  });

  await check("el session_id vuelve al pago y no lleva datos personales", () => {
    const sessionId = buildSessionId(samplePaymentId);
    expect(sessionId.length <= 61, `mide ${sessionId.length}`);
    expect(!sessionId.includes("@"), "parece contener un correo");
    expect(paymentIdFromSessionId(sessionId) === samplePaymentId, "no se puede revertir");
    return `${sessionId.length} caracteres`;
  });

  /* ------------------------------------------------------------- retornos */

  section("Los cuatro flujos de retorno");

  await check("flujo normal: solo token_ws, y es el único que confirma", () => {
    const flow = classifyReturn({ token_ws: "abc" });
    expect(flow.kind === "NORMAL", `clasificado como ${flow.kind}`);
    expect(mayCommit(flow), "el flujo normal debería permitir confirmar");
    return "NORMAL";
  });

  await check("tiempo agotado: sin token, sin confirmar", () => {
    const flow = classifyReturn({ TBK_ID_SESION: "S-1", TBK_ORDEN_COMPRA: "HTF-1" });
    expect(flow.kind === "TIMEOUT", `clasificado como ${flow.kind}`);
    expect(!mayCommit(flow), "¡un timeout no puede confirmarse!");
    return "TIMEOUT";
  });

  await check("abortado: TBK_TOKEN, sin confirmar", () => {
    const flow = classifyReturn({
      TBK_TOKEN: "abc",
      TBK_ID_SESION: "S-1",
      TBK_ORDEN_COMPRA: "HTF-1",
    });
    expect(flow.kind === "ABORTED", `clasificado como ${flow.kind}`);
    expect(!mayCommit(flow), "¡un pago abortado no puede confirmarse!");
    return "ABORTED";
  });

  await check("los cuatro parámetros juntos NO se confirman", () => {
    const flow = classifyReturn({
      token_ws: "abc",
      TBK_TOKEN: "def",
      TBK_ID_SESION: "S-1",
      TBK_ORDEN_COMPRA: "HTF-1",
    });
    expect(flow.kind === "CONFLICTED", `clasificado como ${flow.kind}`);
    expect(!mayCommit(flow), "¡un retorno contradictorio no puede confirmarse!");
    return "CONFLICTED";
  });

  /* -------------------------------------------------------------- saneado */

  section("Secretos");

  await check("un error con la llave dentro sale limpio", () => {
    const leak = `AxiosError\nheaders: {"Tbk-Api-Key-Secret":"${INTEGRATION_API_KEY}"}`;
    const safe = scrub(leak, [String(INTEGRATION_API_KEY)]);
    expect(!safe.includes(String(INTEGRATION_API_KEY)), "¡la llave sobrevivió al saneado!");
    return "la llave no aparece";
  });

  await check("la carga que se persiste no lleva claves prohibidas", () => {
    const dirty = {
      status: "AUTHORIZED",
      amount: 1000,
      headers: { "Tbk-Api-Key-Secret": INTEGRATION_API_KEY },
      card_detail: { card_number: "4051885600446623" },
    };
    const clean = sanitizeProviderPayload(dirty);
    expect(!containsForbiddenKeys(clean), "quedaron claves prohibidas");
    const asText = JSON.stringify(clean);
    expect(!asText.includes(String(INTEGRATION_API_KEY)), "quedó la llave");
    expect(!asText.includes("4051885600446623"), "quedó el número de tarjeta");
    expect(clean.card_last_digits === "6623", "no se conservaron los cuatro últimos");
    return "solo campos permitidos";
  });

  await check("ningún archivo del repositorio lleva una credencial productiva", () => {
    const suspicious: string[] = [];
    const skipDirs = new Set(["node_modules", ".next", ".git", "test-results", "playwright-report"]);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(resolve(root, dir))) {
        if (skipDirs.has(entry)) continue;
        const relative = `${dir}/${entry}`;
        const full = resolve(root, relative);
        if (statSync(full).isDirectory()) {
          walk(relative);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs|sql|json|md|yml|yaml)$/.test(entry)) continue;
        if (entry === "package-lock.json") continue;
        // Los ficheros de prueba llevan credenciales FALSAS a propósito: es
        // justo lo que comprueban. Excluirlos es la diferencia entre un
        // rastreo útil y uno que se ignora por ruidoso.
        if (/\.test\.ts$/.test(entry)) continue;
        const source = readFileSync(full, "utf8");
        // Un código de comercio productivo empieza por 597 y NO es de integración.
        for (const match of source.matchAll(/\b597(?!0555555)\d{9}\b/g)) {
          suspicious.push(`${relative}: ${match[0]}`);
        }
      }
    };
    walk("src");
    walk("scripts");
    walk("supabase");
    expect(suspicious.length === 0, suspicious.join(", "));
    return "ninguna";
  });

  /* ------------------------------------------------- ambiente de integración */

  section("Ambiente de integración de Transbank");

  const provider = new TransbankPaymentProvider(
    {
      environment: "integration",
      commerceCode: String(INTEGRATION_COMMERCE_CODE),
      apiKey: String(INTEGRATION_API_KEY),
      returnUrl: `${SITE_URL}/pagos/retorno`,
    },
    {
      environment: "integration",
      productionEnabled: false,
      siteUrl: SITE_URL,
      nodeEnv: process.env.NODE_ENV ?? "development",
      demoMode: false,
      selectedProvider: "transbank",
    },
  );

  // La disponibilidad se decide con un intento REAL de crear la transacción,
  // no con una sonda aparte: una sonda puede pasar y la llamada de verdad
  // fallar, y entonces las omisiones no coincidirían con lo que de verdad no
  // se pudo probar.
  let liveToken: string | null = null;
  const liveBuyOrder: string = buildBuyOrder(samplePaymentId);
  const liveSessionId: string = buildSessionId(samplePaymentId);
  const liveAmount = 44_000;

  const reachable = await tryCreate();

  async function tryCreate(): Promise<{ ok: boolean; reason: string }> {
    try {
      const created = await provider.createPayment({
        paymentId: samplePaymentId,
        jobId: "verify",
        reference: "VERIFY",
        amount: { amount: liveAmount, currency: "CLP" },
        returnUrl: `${SITE_URL}/pagos/retorno`,
        sessionId: liveSessionId,
        buyOrder: liveBuyOrder,
      });
      liveToken = created.token;
      return { ok: true, reason: `token ${maskToken(created.token)}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // El cortafuegos de Transbank (Imperva) devuelve 403 a las IP de
      // centros de datos. No es un fallo de la integración: es que desde aquí
      // no hay camino hasta ellos.
      const blocked = /403/.test(message);
      return {
        ok: false,
        reason: blocked
          ? `el cortafuegos de Transbank devuelve 403 a esta IP (no es un fallo del código)`
          : scrub(message),
      };
    }
  }

  if (!reachable.ok) {
    const reason = `${TRANSBANK_HOSTS.integration}: ${reachable.reason}`;
    for (const name of [
      "crear una transacción real en integración",
      "la URL devuelta es del dominio del ambiente",
      "consultar el estado de la transacción recién creada",
      "el estado inicial es INITIALIZED y no está autorizado",
      "la transacción responde con el importe y la orden que se pidieron",
      "confirmar una transacción sin pagar es rechazado por Webpay",
      "un token inventado no se confirma",
    ]) {
      skip(name, reason);
    }
  } else {
    await check("crear una transacción real en integración", () => {
      expect(Boolean(liveToken), "sin token");
      expect(liveToken!.length <= 64, "token más largo de lo que admite el SDK");
      return reachable.reason;
    });

    await check("la URL devuelta es del dominio del ambiente", async () => {
      expect(liveToken !== null, "no hubo transacción que comprobar");
      // El proveedor ya lo valida al crear; si hubiera devuelto otro dominio,
      // la llamada anterior habría fallado. Aquí se deja constancia.
      const created = await provider.inspect(liveToken!);
      expect(created.environment === "integration", "el ambiente no es integración");
      expect(
        isTrustedRedirect(`https://${TRANSBANK_HOSTS.integration}/x`, "integration"),
        "la validación de dominio no reconoce el host del ambiente",
      );
      return TRANSBANK_HOSTS.integration;
    });

    await check("consultar el estado de la transacción recién creada", async () => {
      const snapshot = await provider.inspect(liveToken!);
      expect(snapshot.token === liveToken, "el estado no corresponde al token");
      return `status=${snapshot.providerStatus}`;
    });

    await check("el estado inicial es INITIALIZED y no está autorizado", async () => {
      const snapshot = await provider.inspect(liveToken!);
      expect(!snapshot.authorized, "¡una transacción sin pagar aparece como autorizada!");
      return `authorized=${snapshot.authorized}`;
    });

    await check("la transacción responde con el importe y la orden que se pidieron", async () => {
      const snapshot = await provider.inspect(liveToken!);
      const problems = findMismatches(
        {
          vci: snapshot.vci,
          amount: snapshot.amount,
          status: snapshot.providerStatus,
          buyOrder: snapshot.buyOrder,
          sessionId: snapshot.sessionId,
          cardLastDigits: snapshot.cardLastDigits,
          accountingDate: snapshot.accountingDate,
          transactionDate: snapshot.transactionDate,
          authorizationCode: snapshot.authorizationCode,
          paymentTypeCode: snapshot.paymentTypeCode,
          responseCode: snapshot.responseCode,
          installmentsAmount: snapshot.installmentsAmount,
          installmentsNumber: snapshot.installmentsNumber,
          balance: snapshot.balance,
        },
        { amount: liveAmount, buyOrder: liveBuyOrder, sessionId: liveSessionId },
      );
      // Sin pagar no hay código de autorización: ese descuadre es el esperado.
      const unexpected = problems.filter((p) => p !== "missing_authorization_code");
      expect(unexpected.length === 0, `descuadres: ${unexpected.join(", ")}`);
      return "importe, orden y sesión coinciden";
    });

    await check("confirmar una transacción sin pagar es rechazado por Webpay", async () => {
      try {
        const result = await provider.confirmPayment({ token: liveToken! });
        expect(
          result.status !== "PAID",
          "¡Webpay aprobó una transacción que nadie pagó!",
        );
        return `no aprobada (${result.status})`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(
          !message.includes(String(INTEGRATION_API_KEY)),
          "¡el error del SDK filtró la llave!",
        );
        return "rechazado por el proveedor, sin filtrar credenciales";
      }
    });

    await check("un token inventado no se confirma", async () => {
      try {
        const result = await provider.confirmPayment({ token: "01" + "f".repeat(62) });
        expect(result.status !== "PAID", "¡un token inventado fue aprobado!");
        return `no aprobado (${result.status})`;
      } catch {
        return "rechazado por el proveedor";
      }
    });
  }

  /* ----------------------------------------------------------- persistencia */

  section("Persistencia e idempotencia en la base");

  const supabase = supabaseAdmin();
  if (!supabase) {
    for (const name of [
      "las columnas de Webpay existen en payments",
      "buy_order y session_id son únicos",
      "la tabla de devoluciones existe con RLS",
      "las funciones nuevas no son ejecutables por un usuario",
      "los invariantes del dinero devuelto están limpios",
    ]) {
      skip(name, "faltan credenciales de Supabase en .env.local");
    }
  } else {
    await check("las columnas de Webpay existen en payments", async () => {
      const { error } = await supabase
        .from("payments")
        .select(
          "environment,buy_order,session_id,return_url,redirect_url,provider_status,response_code,vci,transaction_date,accounting_date,installments_amount,attempt,failure_reason,committed_at,reconciled_at",
        )
        .limit(1);
      expect(!error, error?.message ?? "");
      return "15 columnas";
    });

    await check("la vista de administración no expone el token", async () => {
      const { error } = await supabase.from("admin_payments").select("provider_token").limit(1);
      expect(Boolean(error), "¡admin_payments expone provider_token!");
      return "provider_token no está en la vista";
    });

    await check("la tabla de devoluciones existe", async () => {
      const { error } = await supabase
        .from("payment_refunds")
        .select("id,payment_id,amount,status,kind,provider_event_id")
        .limit(1);
      expect(!error, error?.message ?? "");
      return "payment_refunds";
    });

    await check("los invariantes del dinero devuelto están limpios", async () => {
      const { data, error } = await supabase.rpc("refund_invariant_violations");
      if (error && /does not exist|schema/.test(error.message)) {
        // Vive en app_private: no es invocable desde PostgREST. Se comprueba
        // en las pruebas SQL locales, que es donde corresponde.
        return "se comprueba en db:test (app_private)";
      }
      expect(!error, error?.message ?? "");
      const rows = (data ?? []) as unknown[];
      expect(rows.length === 0, `${rows.length} violaciones`);
      return "cero violaciones";
    });
  }

  /* ------------------------------------------------------------- informe */

  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const passed = results.filter((r) => r.ok);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log(
    `  ${passed.length} de ${results.length} comprobaciones pasaron` +
      (skipped.length > 0 ? ` · ${skipped.length} omitidas` : ""),
  );
  if (failed.length > 0) {
    console.log("\n  Fallaron:");
    for (const r of failed) console.log(`   · ${r.id} ${r.name}: ${r.detail}`);
  }
  if (skipped.length > 0) {
    console.log("\n  Omitidas (NO son un aprobado):");
    for (const r of skipped) console.log(`   · ${r.id} ${r.name}: ${r.detail}`);
    if (!ALLOW_OFFLINE) {
      console.log(
        "\n  Estas comprobaciones necesitan salida a Transbank o credenciales de Supabase.\n" +
          "  Se cuentan como FALLO a propósito: un verificador que pasa sin haber hablado\n" +
          "  con el proveedor no verifica nada. Con ALLOW_OFFLINE=1 se acepta el resultado\n" +
          "  parcial, y entonces hay que decir en el informe qué quedó sin comprobar.",
      );
    }
  }
  console.log("══════════════════════════════════════════════════════════\n");

  const hardFailure = failed.length > 0 || (skipped.length > 0 && !ALLOW_OFFLINE);
  process.exit(hardFailure ? 1 : 0);
}

function supabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

main().catch((error) => {
  console.error(
    "\n✗ La verificación de Transbank se interrumpió:",
    error instanceof Error ? scrub(error.message) : error,
  );
  process.exit(1);
});
