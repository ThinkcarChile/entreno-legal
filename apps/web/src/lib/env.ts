import { z } from "zod";

/**
 * Validación de variables de entorno.
 *
 * Importante: la aplicación debe poder compilar y ejecutarse en modo demo sin
 * credenciales. Por eso las variables de Supabase, Transbank y similares son
 * opcionales y su ausencia degrada funcionalidad, no rompe el build.
 */

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("https://hagotufila.cl"),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),

  /**
   * Clave pública del proyecto.
   *
   * Supabase reemplazó las claves `anon` y `service_role` por `publishable` y
   * `secret`, y retira las antiguas a fines de 2026. Se aceptan las dos formas y
   * manda la nueva cuando está presente, para no obligar a migrar de golpe.
   */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),

  /** Clave privada. Solo servidor: omite RLS. Nunca con prefijo NEXT_PUBLIC_. */
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  /**
   * demo | supabase | auto
   *
   * "auto" elige Supabase si hay credenciales. Los dos modos nunca se mezclan:
   * o toda la aplicación lee datos reales, o toda lee datos de demostración.
   */
  NEXT_PUBLIC_DATA_SOURCE: z.enum(["demo", "supabase", "auto"]).default("auto"),

  /** mock | mock-delayed | transbank */
  PAYMENT_PROVIDER: z.enum(["mock", "mock-delayed", "transbank"]).default("mock"),

  /**
   * Ambiente de Webpay Plus.
   *
   * No hay forma de llegar a producción por omisión: hace falta poner
   * `production` aquí Y `TRANSBANK_PRODUCTION_ENABLED=true`, y aun así pasar
   * todas las guardas de `payments/transbank/config.ts`.
   *
   * Tampoco a integración, cuando el despliegue es de producción. Si falta, el
   * valor se resuelve a integración —el resto del código lee siempre un
   * ambiente concreto—, pero queda marcado como no elegido
   * (`transbankEnvironmentExplicit`), y con `NODE_ENV=production` y
   * `PAYMENT_PROVIDER=transbank` las guardas se niegan a operar así. Antes se
   * tomaba integración en silencio: tarjetas de prueba habilitaban trabajos en
   * un despliegue productivo. Fuera de producción, integración por omisión
   * sigue siendo lo correcto.
   */
  TRANSBANK_ENVIRONMENT: z.enum(["integration", "production"]).default("integration"),

  /**
   * Interruptor adicional para operar de verdad.
   *
   * Existe para que tener las credenciales productivas en el hosting no baste
   * para cobrar: hace falta un acto explícito y auditable. Mientras esté en
   * falso, el proveedor productivo se niega a operar aunque todo lo demás esté
   * puesto.
   */
  TRANSBANK_PRODUCTION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * Credenciales PRODUCTIVAS. Solo servidor, nunca con prefijo NEXT_PUBLIC_,
   * nunca en el repositorio y nunca en un registro.
   *
   * Las de integración no se configuran: las publica Transbank, las trae el
   * SDK y se usan desde `payments/transbank/config.ts`. Ponerlas aquí sería
   * invitar a confundirlas con las de verdad.
   */
  TRANSBANK_PRODUCTION_COMMERCE_CODE: z.string().optional(),
  TRANSBANK_PRODUCTION_API_KEY_SECRET: z.string().optional(),

  /**
   * Secreto de las tareas programadas. Quien llama a `/api/cron/*` lo envía como
   * `Authorization: Bearer <secreto>` (el formato de Vercel Cron). Sin él, esas
   * rutas responden 503 en vez de quedar abiertas. Mínimo 32 caracteres.
   */
  CRON_SECRET: z.string().min(32).optional(),

  PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(5000).default(1400),
  DISPUTE_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(12),
});

export type ServerEnv = z.infer<typeof serverSchema>;

/**
 * Una variable presente pero vacía equivale a no haberla definido.
 *
 * `.env.example` y la documentación piden dejar en blanco lo que todavía no se
 * tiene (`SUPABASE_SECRET_KEY=`, las cuentas de prueba, las credenciales de
 * Transbank). Sin esta normalización, Next carga esos valores como `""`, zod los
 * rechaza contra `min(1)` o los coerce a 0, y la aplicación devuelve 500 en vez
 * de arrancar en modo demostración. La plantilla es la fuente de verdad: si dice
 * "déjalo vacío", vacío tiene que significar ausente.
 */
function orUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Las variables tal como llegan del entorno, antes de validarlas. */
export type RawServerEnv = { [K in keyof ServerEnv]?: string };

/**
 * Valida un conjunto de variables. La aplicación la llama una sola vez, desde
 * `read()`; se exporta para poder probarla con otros conjuntos.
 */
export function parseServerEnv(raw: RawServerEnv): ServerEnv {
  const normalized = Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, orUndefined(value)]),
  );
  const parsed = serverSchema.safeParse(normalized);

  if (!parsed.success) {
    // Falla ruidosa solo cuando el valor presente es inválido, no cuando falta.
    throw new Error(
      `Variables de entorno inválidas:\n${parsed.error.issues
        .map((i) => ` - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }

  return parsed.data;
}

function read(): ServerEnv {
  // Cada variable por su nombre literal: Next sustituye `process.env.X` al
  // compilar, y este módulo también llega al navegador (vía config/platform).
  return parseServerEnv({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_DATA_SOURCE: process.env.NEXT_PUBLIC_DATA_SOURCE,
    PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
    TRANSBANK_ENVIRONMENT: process.env.TRANSBANK_ENVIRONMENT,
    TRANSBANK_PRODUCTION_ENABLED: process.env.TRANSBANK_PRODUCTION_ENABLED,
    TRANSBANK_PRODUCTION_COMMERCE_CODE: process.env.TRANSBANK_PRODUCTION_COMMERCE_CODE,
    TRANSBANK_PRODUCTION_API_KEY_SECRET: process.env.TRANSBANK_PRODUCTION_API_KEY_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    PLATFORM_COMMISSION_BPS: process.env.PLATFORM_COMMISSION_BPS,
    DISPUTE_WINDOW_HOURS: process.env.DISPUTE_WINDOW_HOURS,
  });
}

export const env: ServerEnv = read();

/**
 * ¿`TRANSBANK_ENVIRONMENT` venía escrita, o `env.TRANSBANK_ENVIRONMENT` es el
 * valor por omisión? Vacía cuenta como ausente, igual que en el resto.
 *
 * Lo leen las guardas de Webpay (`GuardContext.environmentExplicit`): con
 * `NODE_ENV=production` un ambiente que nadie eligió no opera.
 */
export function isExplicitTransbankEnvironment(raw: string | undefined): boolean {
  return orUndefined(raw) !== undefined;
}

export const transbankEnvironmentExplicit = isExplicitTransbankEnvironment(
  process.env.TRANSBANK_ENVIRONMENT,
);

/** Clave pública efectiva: la nueva si existe, la heredada si no. */
export const supabasePublishableKey =
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Clave privada efectiva. Solo debe leerse desde código de servidor. */
export const supabaseSecretKey =
  env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

export const hasSupabaseCredentials =
  Boolean(env.NEXT_PUBLIC_SUPABASE_URL) && Boolean(supabasePublishableKey);

export function resolveDataSource(): "demo" | "supabase" {
  if (env.NEXT_PUBLIC_DATA_SOURCE === "demo") return "demo";
  if (env.NEXT_PUBLIC_DATA_SOURCE === "supabase") return "supabase";
  return hasSupabaseCredentials ? "supabase" : "demo";
}
