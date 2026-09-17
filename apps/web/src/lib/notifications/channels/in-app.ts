import type {
  DeliveryResult,
  NotificationChannel,
  NotificationPayload,
} from "../types";

/**
 * Canal in-app: persiste la notificación para que el usuario la vea dentro del producto.
 *
 * Recibe la función de escritura por inyección para no acoplar el canal a Supabase
 * ni a la implementación de datos activa.
 */
export type NotificationWriter = (payload: NotificationPayload) => Promise<void>;

export class InAppNotificationChannel implements NotificationChannel {
  readonly id = "in_app" as const;

  constructor(private readonly write: NotificationWriter) {}

  isEnabled(): boolean {
    return true;
  }

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    try {
      await this.write(payload);
      return { channel: this.id, delivered: true };
    } catch (error) {
      return {
        channel: this.id,
        delivered: false,
        reason: error instanceof Error ? error.message : "error desconocido",
      };
    }
  }
}
