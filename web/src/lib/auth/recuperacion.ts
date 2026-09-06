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
 * autenticó esta sesión, con método y momento. Un canje de código de
 * recuperación produce `{ method: "recovery", timestamp: <segundos> }`. Acá se
 * exige eso, y que sea RECIENTE: un enlace de recuperación abierto hace tres
 * días no puede seguir sirviendo para cambiar la clave.
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
 * `true` sólo si el token dice "recovery" y ese momento cae dentro de la
 * ventana. `ahoraMs` se recibe para poder probar el vencimiento sin esperar.
 */
export function esRecuperacionVigente(
  reclamaciones: Record<string, unknown> | null,
  ahoraMs: number = Date.now(),
): boolean {
  const limite = VENTANA_RECUPERACION_MIN * 60;
  return entradasAmr(reclamaciones).some(
    (e) => e.method === "recovery" && ahoraMs / 1000 - e.timestamp <= limite && e.timestamp <= ahoraMs / 1000 + 60,
  );
}
