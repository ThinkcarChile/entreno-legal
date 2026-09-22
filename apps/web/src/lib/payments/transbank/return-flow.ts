/**
 * Clasificación del retorno de Webpay Plus.
 *
 * La documentación oficial define CUATRO flujos, y cada uno llega con un juego
 * de parámetros distinto. Elegir «el token que venga» es el error que convierte
 * un pago abortado en un cobro:
 *
 * 1. **Normal** — llega solo `token_ws`. Vale tanto para aprobado como para
 *    rechazado; lo decide el `commit`.
 * 2. **Timeout del formulario** — llegan `TBK_ID_SESION` y `TBK_ORDEN_COMPRA`,
 *    y NO llega token. Sin token no hay `commit` posible. (Transbank escribe
 *    esta variable como `TBK_ID_SESION` en el resumen de flujos y como
 *    `TBK_ID_SESSION` en el detalle; se aceptan las dos.)
 * 3. **Abortado** — llegan `TBK_TOKEN`, `TBK_ID_SESION` y `TBK_ORDEN_COMPRA`.
 *    El token existe pero NO se confirma: se consulta con `status`.
 * 4. **Error y «volver al sitio»** — llegan los cuatro a la vez. Aquí está la
 *    trampa: hay un `token_ws` que invita a confirmar, junto a un `TBK_TOKEN`
 *    que dice que la transacción no terminó bien. No se elige uno por gusto;
 *    se trata como abortado —no se confirma— y se resuelve consultando el
 *    estado, que es la única fuente que no depende de lo que traiga la URL.
 *
 * El plazo del formulario es de 4 minutos en producción y 10 en integración;
 * el token creado caduca a los 5 minutos si nadie lo usa.
 */
export type ReturnFlow =
  | { kind: "NORMAL"; token: string }
  | { kind: "TIMEOUT"; sessionId: string | null; buyOrder: string | null }
  | { kind: "ABORTED"; token: string; sessionId: string | null; buyOrder: string | null }
  | {
      kind: "CONFLICTED";
      token: string;
      abortedToken: string;
      sessionId: string | null;
      buyOrder: string | null;
    }
  | { kind: "UNKNOWN" };

/** Lee un parámetro y descarta el vacío: Webpay manda `TBK_TOKEN=` a veces. */
function param(values: Record<string, string | null | undefined>, name: string): string | null {
  const raw = values[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Decide el flujo a partir de los parámetros recibidos, vengan por GET o por
 * POST. No toca la red ni la base: es una función pura, y por eso se puede
 * probar exhaustivamente.
 */
export function classifyReturn(
  values: Record<string, string | null | undefined>,
): ReturnFlow {
  const token = param(values, "token_ws");
  const abortedToken = param(values, "TBK_TOKEN");
  const sessionId = param(values, "TBK_ID_SESION") ?? param(values, "TBK_ID_SESSION");
  const buyOrder = param(values, "TBK_ORDEN_COMPRA");

  if (token && abortedToken) {
    return { kind: "CONFLICTED", token, abortedToken, sessionId, buyOrder };
  }
  if (abortedToken) {
    return { kind: "ABORTED", token: abortedToken, sessionId, buyOrder };
  }
  if (token) {
    return { kind: "NORMAL", token };
  }
  if (sessionId || buyOrder) {
    return { kind: "TIMEOUT", sessionId, buyOrder };
  }
  return { kind: "UNKNOWN" };
}

/** ¿Este flujo autoriza a llamar a `commit`? Solo uno de los cuatro. */
export function mayCommit(flow: ReturnFlow): boolean {
  return flow.kind === "NORMAL";
}

/** El token utilizable para consultar el estado, si lo hay. */
export function tokenForStatus(flow: ReturnFlow): string | null {
  switch (flow.kind) {
    case "NORMAL":
      return flow.token;
    case "ABORTED":
      return flow.token;
    case "CONFLICTED":
      // Los dos apuntan a la misma transacción; se usa el del flujo abortado
      // porque es el que indica que algo no terminó como debía.
      return flow.abortedToken;
    default:
      return null;
  }
}

/** Motivo de fallo que corresponde a cada flujo, para `payments.failure_reason`. */
export function failureReasonFor(flow: ReturnFlow): string | null {
  switch (flow.kind) {
    case "TIMEOUT":
      return "form_timeout";
    case "ABORTED":
      return "aborted_by_user";
    case "CONFLICTED":
      return "return_conflict";
    case "UNKNOWN":
      return "return_without_parameters";
    default:
      return null;
  }
}
