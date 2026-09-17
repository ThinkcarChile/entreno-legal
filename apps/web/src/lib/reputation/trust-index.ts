import { VerificationStatus, WorkerLevel } from "@/lib/domain/enums";

import type { ReputationSnapshot, TrustSignals } from "@/lib/domain/types";

/**
 * Índice de Confianza HagoTuFila.
 *
 * Función pura y desacoplada: no consulta la base, no depende del framework.
 * Se puede recalcular en batch, en un trigger o en el cliente sin duplicar lógica.
 *
 * No es un promedio de estrellas. Combina resultado (calificación), consistencia
 * (cumplimiento, puntualidad), relación (comunicación), trayectoria (volumen y
 * antigüedad) y verificación.
 */

export interface TrustIndexInput {
  reputation: ReputationSnapshot;
  trust: TrustSignals;
  verificationStatus: VerificationStatus;
}

export interface TrustIndexComponent {
  code: string;
  label: string;
  /** 0..1 */
  score: number;
  weight: number;
}

export interface TrustIndexResult {
  /** 0..100 */
  value: number;
  components: readonly TrustIndexComponent[];
}

const WEIGHTS = {
  rating: 0.3,
  completion: 0.2,
  punctuality: 0.18,
  communication: 0.12,
  experience: 0.12,
  verification: 0.08,
} as const;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Volumen con rendimiento decreciente: 40 trabajos ya aportan casi el máximo. */
function experienceScore(completedJobs: number, accountAgeDays: number): number {
  const volume = clamp01(Math.log10(completedJobs + 1) / Math.log10(41));
  const tenure = clamp01(accountAgeDays / 365);
  return clamp01(volume * 0.75 + tenure * 0.25);
}

/** Penaliza cancelaciones respecto del total de trabajos tomados. */
function reliabilityScore(snapshot: ReputationSnapshot): number {
  const taken = snapshot.completedJobs + snapshot.cancellationCount;
  if (taken === 0) return 0.5;
  const observed = snapshot.completedJobs / taken;
  return clamp01(Math.min(observed, snapshot.completionRate || observed));
}

export function computeTrustIndex(input: TrustIndexInput): TrustIndexResult {
  const { reputation, trust, verificationStatus } = input;

  const ratingScore =
    reputation.reviewCount === 0
      ? 0.5
      : clamp01((reputation.averageRating - 1) / 4);

  const verificationScore = clamp01(
    (verificationStatus === VerificationStatus.VERIFIED ? 0.55 : 0) +
      (trust.identityVerified ? 0.15 : 0) +
      (trust.phoneVerified ? 0.15 : 0) +
      (trust.bankAccountVerified ? 0.15 : 0),
  );

  const components: TrustIndexComponent[] = [
    { code: "rating", label: "Calificación", score: ratingScore, weight: WEIGHTS.rating },
    {
      code: "completion",
      label: "Cumplimiento",
      score: reliabilityScore(reputation),
      weight: WEIGHTS.completion,
    },
    {
      code: "punctuality",
      label: "Puntualidad",
      score: clamp01(reputation.punctualityRate),
      weight: WEIGHTS.punctuality,
    },
    {
      code: "communication",
      label: "Comunicación",
      score: clamp01(reputation.communicationRate),
      weight: WEIGHTS.communication,
    },
    {
      code: "experience",
      label: "Trayectoria",
      score: experienceScore(reputation.completedJobs, reputation.accountAgeDays),
      weight: WEIGHTS.experience,
    },
    {
      code: "verification",
      label: "Verificación",
      score: verificationScore,
      weight: WEIGHTS.verification,
    },
  ];

  const weighted = components.reduce((acc, c) => acc + c.score * c.weight, 0);

  return { value: Math.round(weighted * 100), components };
}

/** Bandas cualitativas del índice, para etiquetar sin exponer el número crudo. */
export function trustIndexBand(value: number): { label: string; tone: "neutral" | "info" | "success" } {
  if (value >= 85) return { label: "Confianza muy alta", tone: "success" };
  if (value >= 70) return { label: "Confianza alta", tone: "success" };
  if (value >= 50) return { label: "Confianza media", tone: "info" };
  return { label: "Perfil en construcción", tone: "neutral" };
}

export { WorkerLevel };
