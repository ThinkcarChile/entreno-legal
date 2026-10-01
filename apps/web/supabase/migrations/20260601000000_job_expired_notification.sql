-- =============================================================================
-- HagoTuFila · Tipo de aviso para un trabajo que vence sin trabajador
-- =============================================================================
-- Va en su propio archivo: un valor nuevo de enum no puede usarse en la misma
-- transacción en que se agrega, y la migración siguiente lo usa.
-- =============================================================================

alter type public.notification_type add value if not exists 'JOB_EXPIRED';
