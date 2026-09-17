import type { DeliveryResult, NotificationChannel, NotificationPayload } from "./types";

/**
 * Despachador de notificaciones.
 *
 * Los emisores llaman a `dispatch` y no saben qué canales existen. Agregar push,
 * email o WhatsApp consiste en registrar un canal más.
 */
export class NotificationDispatcher {
  private readonly channels: NotificationChannel[] = [];

  register(channel: NotificationChannel): this {
    this.channels.push(channel);
    return this;
  }

  async dispatch(payload: NotificationPayload): Promise<readonly DeliveryResult[]> {
    const active = this.channels.filter((c) => c.isEnabled());
    return Promise.all(active.map((c) => c.send(payload)));
  }
}
