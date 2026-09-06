/**
 * ¿ESTA SESIÓN VIENE DE UN ENLACE DE RECUPERACIÓN?
 *
 * La pantalla de "nueva contraseña" no puede abrirse con cualquier sesión. Si
 * bastara con estar dentro, una sesión robada —una pestaña abierta en un
 * computador ajeno— alcanzaría para cambiarle la clave al dueño y dejarlo
 * afuera de su propia casa. Lo que la habilita es haber abierto el enlace que
 * Supabase mandó al correo, y eso Supabase lo deja escrito en el token.
 *
 * El token de acceso (un JWT) lleva la reclamación `amr`: la lista de cómo se
 * autenticó esta sesión, con método y momento. Acá se exige que el método sea
 * de un solo uso por enlace (`otp`) y RECIENTE: un enlace de recuperación
 * abierto hace tres días no puede seguir sirviendo para cambiar la clave.
 *
 * POR QUÉ `otp` Y NO `recovery`. Lo natural sería buscar `method: "recovery"`,
 * y así estuvo escrito hasta que el despliegue real lo desmintió: al canjear un
 * enlace de recuperación con `verifyOtp({ type: "recovery", token_hash })`,
 * Supabase emite la sesión con `amr: [{ method: "otp", timestamp }]`, no
 * "recovery". Con el método equivocado, esta guarda rechazaba TODA recuperación
 * legítima (probado contra la app en Vercel: caía en "recuperación inválida").
 *
 * ¿Es seguro aceptar `otp`? Un inicio de sesión con clave produce
 * `method: "password"`; sólo un enlace de un solo uso produce `otp`. Esta app
 * NO usa magic link para entrar (login es siempre correo + clave), así que la
 * ÚNICA fuente de una sesión `otp` es el enlace de recuperación. Si algún día se
 * agrega magic link, hay que volver a distinguir acá (ver el test). El `amr` va
 * DENTRO del JWT firmado por Supabase: no se puede falsificar como una cookie.
 *
 * No se inventa ningún token propio: se lee lo que Supabase firmó. Y no se
 * verifica la firma acá porque no hace falta: quien llama pasa antes por
 * `auth.getUser()`, que le muestra el token a Supabase y sólo contesta con un
 * usuario si la firma es válida. La reclamación se lee del MISMO token que
 * acaba de ser validado.
 */

/** Cuánto vale un enlace de recuperación una vez abierto. */
export const VENTANA_RECUPERACION_MIN = 30;

interface EntradaAmr {
  method: string;
  timestamp: number;
}

/** Las reclamaciones de un JWT, sin verificar la firma (ver la cabecera). */
export function reclamacionesDe(accessToken: string): Record<string, unknown> | null {
  const partes = accessToken.split(".");
  if (partes.length !== 3) return null;
  try {
    const cuerpo = Buffer.from(partes[1]!, "base64url").toString("utf8");
    const json: unknown = JSON.parse(cuerpo);
    return json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function entradasAmr(reclamaciones: Record<string, unknown> | null): EntradaAmr[] {
  const amr = reclamaciones?.amr;
  if (!Array.isArray(amr)) return [];
  return amr.filter(
    (e): e is EntradaAmr =>
      e !== null &&
      typeof e === "object" &&
      typeof (e as EntradaAmr).method === "string" &&
      typeof (e as EntradaAmr).timestamp === "number",
  );
}

/**
 * `true` sólo si la sesión se estableció por un enlace de un solo uso (`otp`,
 * que en esta app significa recuperación) y ese momento cae dentro de la
 * ventana. Un login con clave (`password`) nunca califica. `ahoraMs` se recibe
 * para poder probar el vencimiento sin esperar.
 */
export function esRecuperacionVigente(
  reclamaciones: Record<string, unknown> | null,
  ahoraMs: number = Date.now(),
): boolean {
  const limite = VENTANA_RECUPERACION_MIN * 60;
  return entradasAmr(reclamaciones).some(
    (e) => e.method === "otp" && ahoraMs / 1000 - e.timestamp <= limite && e.timestamp <= ahoraMs / 1000 + 60,
  );
}
