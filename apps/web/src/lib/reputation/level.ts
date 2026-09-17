import { VerificationStatus, WorkerLevel } from "@/lib/domain/enums";

import type { ReputationSnapshot } from "@/lib/domain/types";

/**
 * Cálculo de nivel del trabajador.
 *
 * Función desacoplada y con criterios objetivos declarados como datos, para poder
 * ajustarlos sin reescribir lógica ni migrar la base.
 */

export interface LevelCriteria {
  level: WorkerLevel;
  minCompletedJobs: number;
  minWorkedHours: number;
  minAverageRating: number;
  minPunctualityRate: number;
  minCompletionRate: number;
  minTrustIndex: number;
  requiresVerification: boolean;
}

export const levelCriteria: readonly LevelCriteria[] = [
  {
    level: WorkerLevel.EXPERTO,
    minCompletedJobs: 60,
    minWorkedHours: 300,
    minAverageRating: 4.8,
    minPunctualityRate: 0.96,
    minCompletionRate: 0.97,
    minTrustIndex: 88,
    requiresVerification: true,
  },
  {
    level: WorkerLevel.PRO,
    minCompletedJobs: 20,
    minWorkedHours: 80,
    minAverageRating: 4.6,
    minPunctualityRate: 0.9,
    minCompletionRate: 0.93,
    minTrustIndex: 75,
    requiresVerification: true,
  },
  {
    level: WorkerLevel.VERIFICADO,
    minCompletedJobs: 1,
    minWorkedHours: 0,
    minAverageRating: 0,
    minPunctualityRate: 0,
    minCompletionRate: 0,
    minTrustIndex: 0,
    requiresVerification: true,
  },
];

export interface LevelInput {
  reputation: ReputationSnapshot;
  verificationStatus: VerificationStatus;
  trustIndex: number;
}

export function computeWorkerLevel(input: LevelInput): WorkerLevel {
  const { reputation, verificationStatus, trustIndex } = input;
  const verified = verificationStatus === VerificationStatus.VERIFIED;
  const workedHours = reputation.workedMinutes / 60;

  for (const criteria of levelCriteria) {
    if (criteria.requiresVerification && !verified) continue;
    if (reputation.completedJobs < criteria.minCompletedJobs) continue;
    if (workedHours < criteria.minWorkedHours) continue;
    if (reputation.averageRating < criteria.minAverageRating) continue;
    if (reputation.punctualityRate < criteria.minPunctualityRate) continue;
    if (reputation.completionRate < criteria.minCompletionRate) continue;
    if (trustIndex < criteria.minTrustIndex) continue;
    return criteria.level;
  }

  return WorkerLevel.NUEVO;
}

/** Qué falta para el siguiente nivel. Alimenta el panel del trabajador. */
export function nextLevelGap(
  input: LevelInput,
): { next: WorkerLevel; missing: readonly string[] } | null {
  const current = computeWorkerLevel(input);
  const order: WorkerLevel[] = [
    WorkerLevel.NUEVO,
    WorkerLevel.VERIFICADO,
    WorkerLevel.PRO,
    WorkerLevel.EXPERTO,
  ];
  const nextLevel = order[order.indexOf(current) + 1];
  if (!nextLevel) return null;

  const criteria = levelCriteria.find((c) => c.level === nextLevel);
  if (!criteria) return null;

  const { reputation, verificationStatus, trustIndex } = input;
  const workedHours = reputation.workedMinutes / 60;
  const missing: string[] = [];

  if (criteria.requiresVerification && verificationStatus !== VerificationStatus.VERIFIED) {
    missing.push("Completar la verificación de identidad");
  }
  if (reputation.completedJobs < criteria.minCompletedJobs) {
    missing.push(`${criteria.minCompletedJobs - reputation.completedJobs} trabajos completados más`);
  }
  if (workedHours < criteria.minWorkedHours) {
    missing.push(`${Math.ceil(criteria.minWorkedHours - workedHours)} horas trabajadas más`);
  }
  if (reputation.averageRating < criteria.minAverageRating) {
    missing.push(`Subir la calificación a ${criteria.minAverageRating.toFixed(1)}`);
  }
  if (trustIndex < criteria.minTrustIndex) {
    missing.push(`Alcanzar ${criteria.minTrustIndex} puntos de Índice de Confianza`);
  }

  return { next: nextLevel, missing };
}
