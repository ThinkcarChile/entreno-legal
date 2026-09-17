import { VerificationStatus } from "@/lib/domain/enums";

import type {
  IdentityVerificationProvider,
  StartVerificationInput,
  StartVerificationResult,
  VerificationOutcome,
} from "./provider";

/**
 * Revisión manual por el equipo de HagoTuFila.
 *
 * El usuario sube documento y selfie a Supabase Storage (bucket privado) y un
 * administrador aprueba o rechaza. Es la implementación vigente de la Etapa 1.
 */
export class ManualVerificationProvider implements IdentityVerificationProvider {
  readonly id = "manual";
  readonly displayName = "Revisión manual HagoTuFila";

  isConfigured(): boolean {
    return true;
  }

  async start(input: StartVerificationInput): Promise<StartVerificationResult> {
    return {
      providerSessionId: `manual:${input.userId}`,
      redirectUrl: null,
      status: VerificationStatus.PENDING,
    };
  }

  async getOutcome(providerSessionId: string): Promise<VerificationOutcome> {
    return {
      providerSessionId,
      status: VerificationStatus.PENDING,
      reason: null,
      signals: { reviewedBy: "human" },
      decidedAt: null,
    };
  }
}
