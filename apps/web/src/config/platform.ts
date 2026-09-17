import { env } from "@/lib/env";

/**
 * Parámetros operacionales de la plataforma.
 * Nada de esto se escribe a mano dentro de componentes.
 */
export const platform = {
  currency: "CLP" as const,

  /**
   * Comisión de HagoTuFila en puntos base (1400 = 14%).
   *
   * Valor por defecto y respaldo del modo demostración. En modo Supabase manda
   * `platform_settings.commission_bps`, que es lo que usa también la base al
   * calcular el payout: dos fuentes distintas terminarían divergiendo.
   */
  commissionBps: env.PLATFORM_COMMISSION_BPS,

  /** Ventana para abrir una disputa tras finalizar el trabajo. */
  disputeWindowHours: env.DISPUTE_WINDOW_HOURS,

  /** Duración mínima publicable, en minutos. */
  minDurationMinutes: 30,

  /** Incrementos ofrecidos al solicitar una extensión, en minutos. */
  extensionPresetsMinutes: [60, 120, 240],

  /** Minutos antes del término estimado en que se habilita el PIN de entrega. */
  handoffPinLeadMinutes: 30,

  /** Largo del PIN de entrega. */
  handoffPinLength: 4,

  /** Radio máximo por defecto de una zona de trabajo, en kilómetros. */
  defaultServiceRadiusKm: 15,

  /** FilaPuntos otorgados por cada 1.000 CLP de servicio completado. */
  loyaltyPointsPer1000Clp: 10,

  /** Valor de 1 FilaPunto al descontar comisión, en CLP. */
  loyaltyPointValueClp: 1,

  /** Tope de descuento con FilaPuntos sobre la comisión, en puntos base. */
  loyaltyMaxCommissionDiscountBps: 5000,
} as const;

export type PlatformConfig = typeof platform;
