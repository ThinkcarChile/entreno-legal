import type { PaymentRow } from "./checkout";
import type { ReturnOutcome } from "./return-handler";

/**
 * A dónde va el navegador del dueño del pago después del retorno, y con qué
 * aviso (`?pago=`).
 *
 * Depende del resultado y también de QUÉ se pagó. El cobro del tiempo
 * adicional (`EXTENSION`) llega con el trabajo ya pagado: si se mandaba, como
 * el del trabajo, a `/pagar/{asignación}`, esa pantalla veía el pago del
 * trabajo en PAID y redirigía a `?pago=ok`. Un cobro adicional rechazado o
 * abandonado terminaba mostrando «Pago confirmado». Ahora vuelve siempre a la
 * página de la asignación, con avisos propios (`extension-…`).
 *
 * Es una función pura —sin red, sin base— para poder probar cada combinación.
 */
export function returnTargetFor(outcome: ReturnOutcome): string {
  switch (outcome.kind) {
    case "SETTLED": {
      const { payment, settlement } = outcome;
      const status = settlement.paymentStatus;
      if (isExtension(payment)) {
        if (status === "PAID") return extensionPage(payment, "ok");
        if (status === "UNDER_REVIEW") return extensionPage(payment, "revision");
        if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return assignmentPage(payment);
        return extensionPage(payment, "rechazado");
      }
      if (status === "PAID") return assignmentPage(payment, "ok");
      if (status === "UNDER_REVIEW") return jobPage(payment, "revision");
      if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return jobPage(payment);
      if (settlement.jobStatus === "CANCELLED") return jobPage(payment, "cancelado");
      return checkoutPage(payment, "rechazado");
    }

    case "REVIEW":
      return isExtension(outcome.payment)
        ? extensionPage(outcome.payment, "revision")
        : jobPage(outcome.payment, "revision");

    case "DOUBLE_CHARGE":
      return isExtension(outcome.payment)
        ? extensionPage(outcome.payment, "duplicado")
        : jobPage(outcome.payment, "duplicado");

    case "ABANDONED": {
      const notice =
        outcome.reason === "form_timeout"
          ? "tiempo"
          : outcome.reason === "aborted_by_user"
            ? "cancelado"
            : "incompleto";
      if (!isExtension(outcome.payment)) {
        // La pantalla de pago del trabajo ya redirige sola si el pago está pagado.
        return checkoutPage(outcome.payment, notice);
      }
      // El abandono de una pestaña antigua cuando el cobro adicional ya se pagó
      // con otro intento: lo que importa es que está pagado.
      if (outcome.payment.status === "PAID") return extensionPage(outcome.payment, "ok");
      if (outcome.payment.status === "UNDER_REVIEW") return extensionPage(outcome.payment, "revision");
      return extensionPage(outcome.payment, notice);
    }

    case "PENDING":
      return isExtension(outcome.payment)
        ? extensionPage(outcome.payment, "verificando")
        : jobPage(outcome.payment, "verificando");

    case "ALREADY": {
      const { payment } = outcome;
      if (isExtension(payment)) {
        if (payment.status === "PAID") return extensionPage(payment, "ok");
        if (payment.status === "UNDER_REVIEW") return extensionPage(payment, "revision");
        if (payment.status === "REFUNDED" || payment.status === "PARTIALLY_REFUNDED") {
          return assignmentPage(payment);
        }
        return extensionPage(payment, "incompleto");
      }
      if (payment.status === "PAID") {
        return payment.assignment_id
          ? assignmentPage(payment, "ok")
          : "/mis-trabajos/publicados?pago=ok";
      }
      if (payment.status === "UNDER_REVIEW") return jobPage(payment, "revision");
      if (payment.status === "REFUNDED" || payment.status === "PARTIALLY_REFUNDED") {
        return jobPage(payment);
      }
      return checkoutPage(payment, "incompleto");
    }

    case "FORBIDDEN":
      return "/mis-trabajos/publicados?pago=error";

    default:
      return "/mis-trabajos/publicados?pago=desconocido";
  }
}

function isExtension(payment: PaymentRow): boolean {
  return payment.purpose === "EXTENSION";
}

function withNotice(path: string, notice?: string): string {
  return notice ? `${path}?pago=${notice}` : path;
}

/** El trabajo visto por el cliente: ofertas, estado y cancelación. */
function jobPage(payment: PaymentRow, notice?: string): string {
  return withNotice(`/mis-trabajos/publicados/${payment.job_id}`, notice);
}

/** La asignación: donde el trabajo avanza. */
function assignmentPage(payment: PaymentRow, notice?: string): string {
  return payment.assignment_id
    ? withNotice(`/mis-trabajos/${payment.assignment_id}`, notice)
    : jobPage(payment, notice);
}

/** La pantalla de pago del TRABAJO. Nunca para una extensión. */
function checkoutPage(payment: PaymentRow, notice: string): string {
  return payment.assignment_id
    ? withNotice(`/pagar/${payment.assignment_id}`, notice)
    : jobPage(payment, notice);
}

/** El cobro del tiempo adicional vuelve a su asignación, con su propio aviso. */
function extensionPage(payment: PaymentRow, notice: string): string {
  return assignmentPage(payment, `extension-${notice}`);
}

/** Un aviso de vuelta del proveedor, listo para pintar. */
export interface ReturnNotice {
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  body: string;
}

/**
 * Los avisos del cobro del tiempo adicional, para la página de la asignación.
 *
 * Cada uno dice lo que de verdad pasó con ESE cobro. Ninguno dice «Pago
 * confirmado» salvo el que lo está.
 */
export function extensionReturnNotice(pago: string | undefined): ReturnNotice | null {
  switch (pago) {
    case "extension-ok":
      return {
        tone: "success",
        title: "Tiempo adicional pagado",
        body: "El cobro del tiempo adicional quedó confirmado y se suma a lo que recibe el trabajador.",
      };
    case "extension-rechazado":
      return {
        tone: "danger",
        title: "El pago del tiempo adicional fue rechazado",
        body:
          "Tu banco no autorizó la transacción y no se realizó ningún cobro. Puedes intentarlo " +
          "otra vez, con la misma tarjeta o con otra.",
      };
    case "extension-cancelado":
      return {
        tone: "warning",
        title: "Cancelaste el pago del tiempo adicional",
        body:
          "Saliste del formulario de Webpay antes de terminar. No se cobró nada y el tiempo " +
          "adicional sigue esperando el pago.",
      };
    case "extension-tiempo":
      return {
        tone: "warning",
        title: "El tiempo para pagar terminó",
        body:
          "El formulario de Webpay tiene un plazo limitado. No se cobró nada: vuelve a intentarlo " +
          "cuando quieras.",
      };
    case "extension-incompleto":
      return {
        tone: "warning",
        title: "El pago del tiempo adicional no se completó",
        body:
          "Volviste sin un resultado claro. No se cobró nada; si tienes dudas, espera unos minutos " +
          "antes de reintentar y comprueba tu cartola.",
      };
    case "extension-verificando":
      return {
        tone: "info",
        title: "Estamos verificando el pago del tiempo adicional",
        body:
          "Todavía no sabemos qué pasó. No vuelvas a pagar mientras verificamos: si el cobro se " +
          "hizo, lo verás reflejado en unos minutos.",
      };
    case "extension-revision":
      return {
        tone: "warning",
        title: "El pago del tiempo adicional quedó en revisión",
        body:
          "Recibimos el cobro, pero algo no cuadró y no lo dimos por bueno. No vuelvas a pagar: " +
          "lo estamos revisando y te avisaremos.",
      };
    case "extension-duplicado":
      return {
        tone: "warning",
        title: "Recibimos un segundo cobro",
        body:
          "El tiempo adicional ya estaba pagado y tu banco autorizó otro pago. Ese cobro de más " +
          "quedó registrado para devolución; no tienes que volver a pagar.",
      };
    default:
      return null;
  }
}
