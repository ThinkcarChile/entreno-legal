/** Identidad de producto. Un solo lugar para textos y enlaces de marca. */
export const site = {
  name: "Hago Tu Fila",
  shortName: "HagoTuFila",
  domain: "hagotufila.cl",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://hagotufila.cl",
  claim: "Tu tiempo vale más que una fila.",
  description:
    "Delega filas, trámites y gestiones a personas verificadas en todo Chile.",
  locale: "es-CL",
  defaultCountry: "CL",
  defaultTimezone: "America/Santiago",
  contactEmail: "hola@hagotufila.cl",
  /** Nombre de cara al usuario del mecanismo de protección de pago. */
  protectedPaymentLabel: "Pago Protegido HagoTuFila",
  loyaltyLabel: "FilaPuntos",
  trustIndexLabel: "Índice de Confianza HagoTuFila",
} as const;

export const seoKeywords = [
  "hacer fila por mí",
  "persona para hacer fila",
  "pagar para hacer fila",
  "hacer trámites por mí",
  "mandados Chile",
  "hacer fila Santiago",
  "hacer fila concierto",
  "hacer fila entradas",
  "trámites presenciales Chile",
] as const;
