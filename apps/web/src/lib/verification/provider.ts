import type { VerificationStatus } from "@/lib/domain/enums";

/**
 * Verificación de identidad.
 *
 * En la Etapa 1 la revisión es manual desde el panel de administración. La interfaz
 * existe desde ahora para que incorporar un proveedor externo (documento + prueba de
 * vida) sea un cambio de implementación, no un rediseño del modelo de datos.
 *
 * No se implementa biometría real todavía. Los estados y la superficie ya están.
 */

export interface StartVerificationInput {
  userId: string;
  /** URL de retorno tras completar el flujo del proveedor. */
  returnUrl: string;
  locale?: string;
}

export interface StartVerificationResult {
  /** Identificador de la sesión de verificación en el proveedor. */
  providerSessionId: string;
  /** URL a la que enviar al usuario, si el proveedor usa flujo alojado. */
  redirectUrl: string | null;
  status: VerificationStatus;
}

export interface VerificationOutcome {
  providerSessionId: string;
  status: VerificationStatus;
  /** Motivo de rechazo, si aplica. Se muestra al usuario. */
  reason: string | null;
  /** Señales devueltas por el proveedor, ya saneadas. Nunca la imagen cruda. */
  signals: Record<string, unknown>;
  decidedAt: string | null;
}

export interface IdentityVerificationProvider {
  readonly id: string;
  readonly displayName: string;
  isConfigured(): boolean;
  start(input: StartVerificationInput): Promise<StartVerificationResult>;
  getOutcome(providerSessionId: string): Promise<VerificationOutcome>;
}
