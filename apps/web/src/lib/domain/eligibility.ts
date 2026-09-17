import { VerificationStatus } from "./enums";

import type { WorkerProfile } from "./types";

/**
 * Elegibilidad del trabajador. Regla única, una sola vez.
 *
 * DECISIÓN DE PRODUCTO (Etapa 2): un trabajador necesita estar VERIFICADO para
 * enviar ofertas, no solo para ser asignado.
 *
 * Por qué, y no lo contrario:
 *  - Un cliente que recibe ofertas de personas que quizá nunca se verifiquen
 *    pierde tiempo eligiendo a alguien que después no puede ser asignado.
 *  - La verificación es el activo del producto. Pedirla antes de la primera
 *    oferta la convierte en un paso natural del onboarding y no en un obstáculo
 *    que aparece en el peor momento.
 *  - La regla ya estaba en RLS desde la Etapa 1 (`job_offers_insert_verified`),
 *    probada y en producción del esquema. Relajarla habría sido rehacer una
 *    decisión sin un defecto que lo justifique.
 *
 * Quien está PENDING puede explorar todos los trabajos, abrir su detalle y
 * preparar su perfil. Lo único que no puede es ofertar.
 *
 * La misma regla vive en la base (`app_private.worker_can_be_assigned` y la
 * política de INSERT de `job_offers`). Aquí sirve para que la interfaz no
 * ofrezca botones imposibles.
 */

export type EligibilityReason =
  | "OK"
  | "NO_WORKER_PROFILE"
  | "NOT_VERIFIED"
  | "VERIFICATION_PENDING"
  | "VERIFICATION_REJECTED"
  | "SUSPENDED"
  | "PROFILE_INCOMPLETE";

export interface Eligibility {
  allowed: boolean;
  reason: EligibilityReason;
  /** Mensaje listo para mostrar. */
  message: string;
  /** A dónde mandar al usuario para resolverlo. */
  href?: string;
}

const OK: Eligibility = { allowed: true, reason: "OK", message: "" };

/** ¿Puede este trabajador enviar ofertas? */
export function canSendOffers(worker: WorkerProfile | null): Eligibility {
  if (!worker) {
    return {
      allowed: false,
      reason: "NO_WORKER_PROFILE",
      message: "Activa el modo trabajador para poder ofertar.",
      href: "/cuenta/trabajador",
    };
  }

  switch (worker.verificationStatus) {
    case VerificationStatus.VERIFIED:
      return OK;
    case VerificationStatus.PENDING:
      return {
        allowed: false,
        reason: "VERIFICATION_PENDING",
        message:
          "Tu verificación está en revisión. Puedes explorar trabajos y te avisamos apenas quede lista.",
        href: "/cuenta/trabajador",
      };
    case VerificationStatus.REJECTED:
      return {
        allowed: false,
        reason: "VERIFICATION_REJECTED",
        message: "Tu verificación fue rechazada. Revisa los datos y vuelve a enviarla.",
        href: "/cuenta/trabajador",
      };
    case VerificationStatus.SUSPENDED:
      return {
        allowed: false,
        reason: "SUSPENDED",
        message: "Tu cuenta está suspendida. Escríbenos para revisarla.",
        href: "/contacto",
      };
    default:
      return {
        allowed: false,
        reason: "NOT_VERIFIED",
        message: "Verifica tu identidad para empezar a enviar ofertas.",
        href: "/cuenta/trabajador",
      };
  }
}

/** ¿Puede este trabajador ser asignado a un trabajo? */
export function canBeAssigned(worker: WorkerProfile | null): Eligibility {
  return canSendOffers(worker);
}

/**
 * ¿Está el perfil de trabajador lo bastante completo para ofertar bien?
 * No bloquea: avisa. Un perfil vacío recibe menos aceptaciones.
 */
export function workerProfileCompleteness(worker: WorkerProfile | null): {
  complete: boolean;
  missing: readonly string[];
} {
  if (!worker) return { complete: false, missing: ["Activar el modo trabajador"] };

  const missing: string[] = [];
  if (!worker.headline) missing.push("Una descripción breve de lo que haces");
  if (!worker.profile.avatarUrl) missing.push("Una fotografía de perfil");
  if (worker.baseHourlyRate.amount <= 0) missing.push("Tu tarifa base por hora");
  if (worker.serviceAreas.length === 0) missing.push("Al menos una zona de trabajo");
  if (!worker.availabilityNote) missing.push("Tu disponibilidad general");

  return { complete: missing.length === 0, missing };
}
