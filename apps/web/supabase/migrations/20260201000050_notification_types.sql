-- =============================================================================
-- HagoTuFila · Etapa 2 · 050 · Nuevos tipos de notificación
-- =============================================================================
-- En archivo propio: añadir valores a un enum y usarlos en la misma transacción
-- no está permitido en PostgreSQL. Separarlo evita una migración frágil.
-- =============================================================================

alter type public.notification_type add value if not exists 'OFFER_WITHDRAWN';
alter type public.notification_type add value if not exists 'JOB_UPDATED';
alter type public.notification_type add value if not exists 'JOB_ASSIGNED';
alter type public.notification_type add value if not exists 'JOB_STARTING_SOON';
