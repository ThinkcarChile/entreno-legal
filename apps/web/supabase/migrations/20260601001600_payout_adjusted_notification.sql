-- =============================================================================
-- HagoTuFila · Tipo de aviso para un pago al trabajador ajustado
-- =============================================================================
-- Va en su propio archivo: un valor nuevo de enum no puede usarse en la misma
-- transacción en que se agrega, y la migración 20260601001610 lo usa para
-- avisarle al trabajador cuando administración baja o cancela su pago
-- (`adjust_payout`).
--
-- Ninguno de los que existen sirve: `PAYOUT_APPROVED` y `PAYOUT_PAID` dicen que
-- el pago avanza, y un ajuste dice que cambió lo que va a recibir.
-- =============================================================================

alter type public.notification_type add value if not exists 'PAYOUT_ADJUSTED';
