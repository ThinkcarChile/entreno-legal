import { PaymentStatus } from "@/lib/domain/enums";

import {
  PaymentProviderNotConfiguredError,
  type ConfirmPaymentInput,
  type ConfirmPaymentResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type PaymentProvider,
  type PaymentStatusResult,
  type RefundPaymentInput,
  type RefundPaymentResult,
} from "./provider";

export interface TransbankConfig {
  /** "integration" o "production". Nunca se asume producción por defecto. */
  environment: "integration" | "production";
  commerceCode?: string;
  apiKey?: string;
}

/**
 * Webpay Plus (Transbank Chile).
 *
 * Estado actual: la clase define la forma del flujo y el manejo de estados internos,
 * pero **no** implementa llamadas a la red. La integración real debe hacerse con el
 * SDK oficial vigente de Transbank y su documentación, en ambiente de integración.
 *
 * Deliberadamente no se inventan endpoints, rutas ni formatos de payload: una firma
 * incorrecta escrita hoy sería deuda que habría que descubrir en producción.
 *
 * Cuando se integre:
 *  1. Instalar el SDK oficial de Transbank para Node.
 *  2. Configurar `TRANSBANK_COMMERCE_CODE` y `TRANSBANK_API_KEY` como variables de
 *     entorno del servidor. Nunca en el repositorio, nunca con prefijo NEXT_PUBLIC_.
 *  3. Implementar los cuatro métodos usando el SDK, mapeando sus respuestas a los
 *     tipos de `provider.ts`.
 *  4. Registrar cada respuesta en `payment_events` ya saneada.
 *
 * Reglas invariables: no almacenar datos de tarjeta, no registrar credenciales,
 * y mantener el ambiente de integración hasta certificar.
 */
export class TransbankPaymentProvider implements PaymentProvider {
  readonly id = "transbank_webpay_plus";
  readonly displayName = "Webpay Plus";

  constructor(private readonly config: TransbankConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.commerceCode && this.config.apiKey);
  }

  private guard(operation: string): never {
    throw new PaymentProviderNotConfiguredError(
      this.id,
      this.isConfigured()
        ? `La operación "${operation}" requiere integrar el SDK oficial de Transbank.`
        : "Faltan TRANSBANK_COMMERCE_CODE y TRANSBANK_API_KEY.",
    );
  }

  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    void _input;
    this.guard("createPayment");
  }

  async confirmPayment(_input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
    void _input;
    this.guard("confirmPayment");
  }

  async getStatus(_providerTransactionId: string, _token: string): Promise<PaymentStatusResult> {
    void _providerTransactionId;
    void _token;
    this.guard("getStatus");
  }

  async refund(_input: RefundPaymentInput): Promise<RefundPaymentResult> {
    void _input;
    this.guard("refund");
  }

  /**
   * Mapeo de estados del proveedor a estados internos.
   *
   * Se deja definido porque es lógica de dominio, no del SDK: cuando la integración
   * exista, solo hay que alimentar este mapeo con los códigos reales documentados.
   */
  static mapResponseCodeToStatus(responseCode: number | null | undefined): PaymentStatus {
    if (responseCode === 0) return PaymentStatus.AUTHORIZED;
    if (responseCode === null || responseCode === undefined) return PaymentStatus.UNDER_REVIEW;
    return PaymentStatus.FAILED;
  }
}
