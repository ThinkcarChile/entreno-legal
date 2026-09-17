import type { NotificationType } from "@/lib/domain/enums";

export interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  href?: string | null;
  jobId?: string | null;
  /** Datos adicionales para push o plantillas de email. */
  data?: Record<string, string | number | boolean | null>;
}

export type ChannelId = "in_app" | "push" | "email" | "sms" | "whatsapp";

export interface DeliveryResult {
  channel: ChannelId;
  delivered: boolean;
  reason?: string;
}

/**
 * Canal de entrega.
 *
 * La Etapa 1 solo implementa `in_app`. Push, email y SMS/WhatsApp se agregan
 * registrando nuevas implementaciones en el despachador, sin tocar los emisores.
 */
export interface NotificationChannel {
  readonly id: ChannelId;
  isEnabled(): boolean;
  send(payload: NotificationPayload): Promise<DeliveryResult>;
}
