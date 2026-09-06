import { headers } from "next/headers";

/**
 * LA URL PÚBLICA DEL SITIO, para armar enlaces que salen por correo.
 *
 * Los correos de Supabase (confirmar cuenta, recuperar clave) vuelven a la app
 * por `/auth/callback`, y esa vuelta necesita una URL absoluta: el correo se
 * abre en otro dispositivo, en otro momento, sin ningún pedido nuestro al que
 * mirarle el `Host`. Lo mismo el enlace de invitación, que hoy se muestra como
 * ruta relativa y la persona tiene que adivinar el dominio.
 *
 * `SITE_URL` manda. Se lee en tiempo de ejecución a propósito —no lleva el
 * prefijo `NEXT_PUBLIC_`— para que cambiar de dominio no obligue a recompilar
 * el paquete: Next hornea las `NEXT_PUBLIC_*` en el build, y el dominio todavía
 * no está decidido.
 *
 * Sin `SITE_URL` se deduce de las cabeceras del pedido. Es lo que hay en
 * desarrollo, y es MENTIROSO detrás de un proxy que no reenvíe `X-Forwarded-*`:
 * por eso en producción la variable es obligatoria en la práctica, aunque el
 * código no reviente sin ella. `docs/deployment/auth-produccion.md` lo dice.
 */
export async function origenPublico(): Promise<string> {
  const fijo = process.env.SITE_URL?.trim();
  if (fijo) return fijo.replace(/\/+$/, "");

  const h = await headers();
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0]!.trim();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0]!.trim();
  if (host === "") {
    throw new Error(
      "No se pudo deducir la URL pública: no hay SITE_URL ni cabecera Host en el pedido.",
    );
  }
  return `${proto}://${host}`;
}
