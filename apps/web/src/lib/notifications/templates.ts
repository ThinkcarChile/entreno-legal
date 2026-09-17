import { NotificationType } from "@/lib/domain/enums";

/**
 * Plantillas por tipo de notificación.
 *
 * Centralizadas para que push, email y SMS reutilicen exactamente el mismo texto
 * base cuando esos canales se habiliten.
 */
export interface TemplateContext {
  jobTitle?: string;
  actorName?: string;
  amount?: string;
  hours?: string;
  rating?: string;
}

type Template = (ctx: TemplateContext) => { title: string; body: string };

export const notificationTemplates: Record<NotificationType, Template> = {
  NEW_OFFER: (c) => ({
    title: "Nueva oferta recibida",
    body: `${c.actorName ?? "Un trabajador"} envió una oferta para "${c.jobTitle ?? "tu trabajo"}".`,
  }),
  OFFER_ACCEPTED: (c) => ({
    title: "Tu oferta fue aceptada",
    body: `Te seleccionaron para "${c.jobTitle ?? "un trabajo"}". Falta confirmar el pago para comenzar.`,
  }),
  JOB_PAID: (c) => ({
    title: "Pago confirmado",
    body: `El pago de "${c.jobTitle ?? "el trabajo"}" está confirmado y protegido. Ya puedes comenzar.`,
  }),
  WORKER_ON_THE_WAY: (c) => ({
    title: "El trabajador va en camino",
    body: `${c.actorName ?? "El trabajador"} se dirige al lugar acordado.`,
  }),
  CHECK_IN: (c) => ({
    title: "Check-in realizado",
    body: `${c.actorName ?? "El trabajador"} llegó al lugar y registró su check-in.`,
  }),
  NEW_MESSAGE: (c) => ({
    title: "Nuevo mensaje",
    body: `${c.actorName ?? "Tienes un mensaje nuevo"} te escribió sobre "${c.jobTitle ?? "el trabajo"}".`,
  }),
  EXTENSION_REQUESTED: (c) => ({
    title: "Solicitud de extensión",
    body: `Se solicitó extender "${c.jobTitle ?? "el trabajo"}" por ${c.hours ?? "más tiempo"}.`,
  }),
  EXTENSION_ANSWERED: (c) => ({
    title: "Respuesta a la extensión",
    body: `${c.actorName ?? "El trabajador"} respondió a la solicitud de extensión.`,
  }),
  JOB_FINISHED: (c) => ({
    title: "Trabajo terminado",
    body: `"${c.jobTitle ?? "El trabajo"}" finalizó. Revisa y confirma para liberar el pago.`,
  }),
  DISPUTE_OPENED: (c) => ({
    title: "Se abrió una disputa",
    body: `Hay una disputa sobre "${c.jobTitle ?? "un trabajo"}". El pago queda retenido mientras se revisa.`,
  }),
  PAYOUT_APPROVED: (c) => ({
    title: "Pago aprobado",
    body: `Tu pago de ${c.amount ?? "el trabajo"} fue aprobado y se transferirá a tu cuenta.`,
  }),
  NEW_REVIEW: (c) => ({
    title: "Nueva reseña",
    body: `${c.actorName ?? "Alguien"} te calificó con ${c.rating ?? "una nueva reseña"}.`,
  }),
  VERIFICATION_UPDATED: () => ({
    title: "Estado de verificación actualizado",
    body: "Revisa el estado de tu verificación de identidad en tu perfil.",
  }),
};

export function renderNotification(
  type: NotificationType,
  ctx: TemplateContext = {},
): { title: string; body: string } {
  return notificationTemplates[type](ctx);
}

export { NotificationType };
