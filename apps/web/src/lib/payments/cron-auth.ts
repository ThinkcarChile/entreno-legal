import { timingSafeEqual } from "node:crypto";

/**
 * ¿Trae esta petición el secreto de las tareas programadas?
 *
 * Formato `Authorization: Bearer <secreto>`, el que usa Vercel Cron y el que
 * cualquier otro programador (GitHub Actions, pg_net, un cron del servidor)
 * puede enviar igual. La comparación es en tiempo constante: una ruta que mueve
 * el estado de pagos no debe filtrar el secreto carácter a carácter.
 *
 * Sin secreto configurado devuelve `false` siempre: no hay forma de que una
 * variable olvidada deje la ruta abierta.
 */
export function isAuthorizedCronRequest(
  authorization: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(authorization ?? "", "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
