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

  /** mock | transbank */
  PAYMENT_PROVIDER: z.enum(["mock", "transbank"]).default("mock"),
  TRANSBANK_ENVIRONMENT: z.enum(["integration", "production"]).default("integration"),
  TRANSBANK_COMMERCE_CODE: z.string().optional(),
  TRANSBANK_API_KEY: z.string().optional(),

  PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(5000).default(1400),
  DISPUTE_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(12),
});

export type ServerEnv = z.infer<typeof serverSchema>;

function read(): ServerEnv {
  const parsed = serverSchema.safeParse({
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
    TRANSBANK_COMMERCE_CODE: process.env.TRANSBANK_COMMERCE_CODE,
    TRANSBANK_API_KEY: process.env.TRANSBANK_API_KEY,
    PLATFORM_COMMISSION_BPS: process.env.PLATFORM_COMMISSION_BPS,
    DISPUTE_WINDOW_HOURS: process.env.DISPUTE_WINDOW_HOURS,
  });

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

export const env: ServerEnv = read();

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
