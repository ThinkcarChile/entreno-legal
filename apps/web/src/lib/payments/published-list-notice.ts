import type { ReturnNotice } from "./return-target";

/**
 * Los avisos de vuelta de Webpay que llegan a la LISTA de trabajos publicados
 * (`/mis-trabajos/publicados?pago=…`).
 *
 * `/pagos/retorno` manda aquí justo los casos inciertos: cuando no pudo
 * resolver el retorno (`verificando`), cuando el pago es de otra cuenta o el
 * resultado no se reconoce (`desconocido`) y cuando no se pudo procesar
 * (`error`). La página no leía `?pago=` y mostraba la lista sin más: en el caso
 * en que más importa, el cliente no veía «No vuelvas a pagar».
 *
 * Función pura, para probar cada caso (published-list-notice.test.ts).
 */
export function publishedListNotice(pago: string | undefined): ReturnNotice | null {
  switch (pago) {
    case "verificando":
      return {
        tone: "info",
        title: "Estamos verificando tu pago",
        body:
          "Todavía no sabemos qué pasó con tu pago. No vuelvas a pagar mientras verificamos: si " +
          "el cobro se hizo, lo verás reflejado en tu trabajo en unos minutos.",
      };
    case "desconocido":
      return {
        tone: "warning",
        title: "No pudimos mostrarte el resultado del pago",
        body:
          "El pago no corresponde a la cuenta con la que entraste, o volvió con un resultado que " +
          "no reconocimos. Si pagaste con otra cuenta, entra con ella para verlo. No vuelvas a " +
          "pagar sin revisar antes el estado de tu trabajo.",
      };
    case "error":
      return {
        tone: "danger",
        title: "No pudimos procesar la vuelta del pago",
        body:
          "Algo falló al volver de Webpay. No vuelvas a pagar sin revisar antes el estado de tu " +
          "trabajo: si el cobro se hizo, lo verás reflejado en unos minutos. Si sigue sin " +
          "aparecer, escríbenos.",
      };
    case "ok":
      return {
        tone: "success",
        title: "Pago confirmado",
        body: "El dinero quedó asociado a tu trabajo.",
      };
    default:
      return null;
  }
}
