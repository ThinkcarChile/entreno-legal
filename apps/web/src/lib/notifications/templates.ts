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

/**
 * El nombre de una persona va entre comillas angulares —«Camila F.»— y nunca
 * suelto en la frase. Lo escribe quien lo elige, y suelto se puede leer como
 * parte del aviso: «HagoTuFila: tu pago fue rechazado envió una oferta…». La
 * base cita igual en los avisos que genera ella (migración …001120). Sin
 * nombre, el genérico va sin comillas: ese texto es nuestro.
 */
export function quotedName(name: string | undefined, fallback: string): string {
  // La base ya no admite comillas en un nombre (…001120); se quitan igual aquí
  // para que ningún nombre pueda cerrar la cita que lo encierra.
  const clean = name?.replace(/["«»‹›“”„‟〝〞＂]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? `«${clean}»` : fallback;
}

export const notificationTemplates: Record<NotificationType, Template> = {
  NEW_OFFER: (c) => ({
    title: "Nueva oferta recibida",
    body: `Recibiste una oferta de ${quotedName(c.actorName, "un trabajador")} para "${c.jobTitle ?? "tu trabajo"}".`,
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
    body: `${quotedName(c.actorName, "El trabajador")} se dirige al lugar acordado.`,
  }),
  CHECK_IN: (c) => ({
    title: "Check-in realizado",
    body: `${quotedName(c.actorName, "El trabajador")} llegó al lugar y registró su check-in.`,
  }),
  NEW_MESSAGE: (c) => ({
    title: "Nuevo mensaje",
    body: `Tienes un mensaje de ${quotedName(c.actorName, "alguien")} sobre "${c.jobTitle ?? "el trabajo"}".`,
  }),
  EXTENSION_REQUESTED: (c) => ({
    title: "Solicitud de extensión",
    body: `Se solicitó extender "${c.jobTitle ?? "el trabajo"}" por ${c.hours ?? "más tiempo"}.`,
  }),
  EXTENSION_ANSWERED: (c) => ({
    title: "Respuesta a la extensión",
    body: `${quotedName(c.actorName, "El trabajador")} respondió a la solicitud de extensión.`,
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
    body: `${quotedName(c.actorName, "Alguien")} te calificó con ${c.rating ?? "una nueva reseña"}.`,
  }),
  JOB_STARTED: (c) => ({
    title: "El trabajo comenzó",
    body: `${quotedName(c.actorName, "El trabajador")} empezó "${c.jobTitle ?? "el trabajo"}". Te avisamos de cada avance.`,
  }),
  JOB_UPDATE: (c) => ({
    title: "Nueva actualización del trabajo",
    body: `${quotedName(c.actorName, "El trabajador")} envió novedades de "${c.jobTitle ?? "el trabajo"}".`,
  }),
  NEW_EVIDENCE: (c) => ({
    title: "Nueva evidencia del trabajo",
    body: `Se adjuntó una foto o comprobante a "${c.jobTitle ?? "el trabajo"}".`,
  }),
  HANDOFF_REQUESTED: (c) => ({
    title: "Te piden el código de entrega",
    body: `${quotedName(c.actorName, "El trabajador")} está listo para entregarte lo acordado.`,
  }),
  JOB_APPROVED: (c) => ({
    title: "El cliente aprobó el trabajo",
    body: `Tu pago por "${c.jobTitle ?? "el trabajo"}" quedó aprobado.`,
  }),
  DISPUTE_RESOLVED: (c) => ({
    title: "La disputa se resolvió",
    body: `Ya hay una decisión sobre "${c.jobTitle ?? "el trabajo"}".`,
  }),
  PAYOUT_PAID: (c) => ({
    title: "Registramos tu transferencia",
    body: `El pago de "${c.jobTitle ?? "el trabajo"}" quedó registrado como transferido.`,
  }),
  // Lo escribe la base con las cifras y el motivo; esto es el genérico.
  PAYOUT_ADJUSTED: (c) => ({
    title: "Cambió lo que recibirás",
    body: `Administración ajustó tu pago por "${c.jobTitle ?? "el trabajo"}". Revisa el motivo en el trabajo.`,
  }),
  JOB_CANCELLED: (c) => ({
    title: "El trabajo se canceló",
    body: `"${c.jobTitle ?? "El trabajo"}" quedó cancelado.`,
  }),
  JOB_EXPIRED: (c) => ({
    title: "Tu trabajo venció sin trabajador",
    body: `"${c.jobTitle ?? "El trabajo"}" pasó su hora de inicio sin una oferta aceptada. Puedes publicarlo otra vez.`,
  }),
  // Lo escribe la base con la regla y el número de casos; esto es el genérico.
  INTEGRITY_ALERT: () => ({
    title: "Datos inconsistentes",
    body: "Una regla del dinero está rota. Revísalo en el panel de administración.",
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
