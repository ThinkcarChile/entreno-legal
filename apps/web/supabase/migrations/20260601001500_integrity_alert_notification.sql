-- =============================================================================
-- HagoTuFila · Tipo de aviso para una inconsistencia en los datos
-- =============================================================================
-- Va en su propio archivo: un valor nuevo de enum no puede usarse en la misma
-- transacción en que se agrega, y la migración 20260601001520 lo usa para
-- avisar a la administración cuando un invariante se rompe.
--
-- Ninguno de los que existen sirve: `PAYMENT_UNDER_REVIEW` habla de un pago, y
-- un invariante roto puede ser un payout, una asignación o una devolución.
-- =============================================================================

alter type public.notification_type add value if not exists 'INTEGRITY_ALERT';
