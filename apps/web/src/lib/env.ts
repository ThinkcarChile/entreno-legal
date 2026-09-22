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
   * Ambiente de Webpay Plus. Por defecto integración, siempre.
   *
   * No hay forma de llegar a producción por omisión: hace falta poner
   * `production` aquí Y `TRANSBANK_PRODUCTION_ENABLED=true`, y aun así pasar
   * todas las guardas de `payments/transbank/config.ts`.
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

function read(): ServerEnv {
  const parsed = serverSchema.safeParse({
    NODE_ENV: orUndefined(process.env.NODE_ENV),
    NEXT_PUBLIC_SITE_URL: orUndefined(process.env.NEXT_PUBLIC_SITE_URL),
    NEXT_PUBLIC_SUPABASE_URL: orUndefined(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: orUndefined(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: orUndefined(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SECRET_KEY: orUndefined(process.env.SUPABASE_SECRET_KEY),
    SUPABASE_SERVICE_ROLE_KEY: orUndefined(process.env.SUPABASE_SERVICE_ROLE_KEY),
    NEXT_PUBLIC_DATA_SOURCE: orUndefined(process.env.NEXT_PUBLIC_DATA_SOURCE),
    PAYMENT_PROVIDER: orUndefined(process.env.PAYMENT_PROVIDER),
    TRANSBANK_ENVIRONMENT: orUndefined(process.env.TRANSBANK_ENVIRONMENT),
    TRANSBANK_PRODUCTION_ENABLED: orUndefined(process.env.TRANSBANK_PRODUCTION_ENABLED),
    TRANSBANK_PRODUCTION_COMMERCE_CODE: orUndefined(
      process.env.TRANSBANK_PRODUCTION_COMMERCE_CODE,
    ),
    TRANSBANK_PRODUCTION_API_KEY_SECRET: orUndefined(
      process.env.TRANSBANK_PRODUCTION_API_KEY_SECRET,
    ),
    PLATFORM_COMMISSION_BPS: orUndefined(process.env.PLATFORM_COMMISSION_BPS),
    DISPUTE_WINDOW_HOURS: orUndefined(process.env.DISPUTE_WINDOW_HOURS),
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
