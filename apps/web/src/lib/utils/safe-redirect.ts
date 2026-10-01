/**
 * Destino interno seguro a partir de un `?next=` que viene de la URL.
 *
 * El parámetro lo controla quien arma el enlace, no la aplicación. Sin esta
 * función había tres redirecciones abiertas: el callback de Supabase Auth
 * concatenaba `${origin}${next}` —con `next=.evil.com` el destino era
 * `https://hagotufila.cl.evil.com`— y el inicio de sesión y el onboarding
 * hacían `router.push(next)`, que con una URL absoluta navega fuera del sitio.
 * Justo después de iniciar sesión con un enlace legítimo, que es cuando más se
 * confía en lo que aparece.
 *
 * Solo se acepta una ruta relativa del propio sitio. Todo lo demás cae al
 * destino por omisión.
 */
const PLACEHOLDER_ORIGIN = "https://destino-interno.invalid";

export function safeNextPath(value: string | null | undefined, fallback = "/trabajos"): string {
  if (!value) return fallback;
  const candidate = value.trim();

  // Debe empezar por una sola barra. `//host` y `/\host` son direcciones de otro
  // sitio para el navegador.
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return fallback;
  }
  // Barras invertidas y caracteres de control: los navegadores los normalizan
  // de formas distintas, y no hay ruta legítima que los necesite.
  if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return fallback;

  let url: URL;
  try {
    url = new URL(candidate, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback;

  return `${url.pathname}${url.search}${url.hash}`;
}
