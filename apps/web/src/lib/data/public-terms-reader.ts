import "server-only";

import { cache } from "react";

import { unstable_cache } from "next/cache";

import { createClient } from "@supabase/supabase-js";

import { env, resolveDataSource, supabasePublishableKey } from "@/lib/env";

import { defaultPublicTerms, parsePublicTerms, type PublicPlatformTerms } from "./public-terms";

/**
 * Lectura de la comisión y la ventana de disputa para las páginas públicas.
 *
 * Tres decisiones:
 *
 *  · **Cliente sin sesión.** `anon` puede leer `platform_settings` (política
 *    `platform_settings_read` y `grant select`), y estas dos columnas son
 *    públicas por definición: se publican en `/precios`. Leerlas con el cliente
 *    de cookies haría que el resultado dependiera de quién mira, y no podría
 *    guardarse en caché.
 *  · **Caché de cinco minutos** (`unstable_cache`, el modelo de caché de este
 *    proyecto: no usa Cache Components). Las páginas públicas se piden mucho y
 *    estos números cambian casi nunca; sin caché serían una consulta por visita.
 *    Un cambio en la base tarda hasta cinco minutos en verse aquí, o nada si
 *    quien lo cambia llama a `revalidateTag(PUBLIC_TERMS_TAG)`. El cobro y el
 *    payout no pasan por aquí: los calcula la base con el valor del momento.
 *  · **Un fallo no se guarda.** Si la base no responde, la función lanza dentro
 *    de la caché (así no queda guardado) y afuera se usa el respaldo, con una
 *    línea en el registro. Una página de precios caída por un parámetro es peor
 *    que el valor por defecto, que es la semilla de esa misma tabla.
 */
export const PUBLIC_TERMS_TAG = "platform-settings";

const REVALIDATE_SECONDS = 300;

const readFromDatabase = unstable_cache(
  async (): Promise<PublicPlatformTerms> => {
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !supabasePublishableKey) {
      throw new Error("Supabase no está configurado en este entorno.");
    }
    const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase
      .from("platform_settings")
      .select("commission_bps,dispute_window_hours")
      .maybeSingle();

    if (error) throw error;
    const terms = parsePublicTerms(data);
    if (!terms) throw new Error("platform_settings no tiene fila o trae valores fuera de rango.");
    return terms;
  },
  ["public-platform-terms"],
  { revalidate: REVALIDATE_SECONDS, tags: [PUBLIC_TERMS_TAG] },
);

/** Comisión y ventana de disputa vigentes. `cache` evita repetir la lectura en una misma petición. */
export const getPublicPlatformTerms = cache(async (): Promise<PublicPlatformTerms> => {
  if (resolveDataSource() !== "supabase") return defaultPublicTerms();

  try {
    return await readFromDatabase();
  } catch (error) {
    // Una consulta sin datos de nadie: el mensaje sirve y no expone nada.
    console.error("[platform_settings] no se pudo leer; se publican los valores por defecto", {
      code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
      message:
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error),
    });
    return defaultPublicTerms();
  }
});
