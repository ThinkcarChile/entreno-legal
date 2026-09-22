-- =============================================================================
-- HagoTuFila · Bloque 3 · 000 · Valores de enumeración para la ejecución
-- =============================================================================
-- PostgreSQL no deja usar un valor de enumeración recién añadido dentro de la
-- misma transacción que lo añade. Por eso los valores nuevos viven en su propia
-- migración, antes de la que los usa. Es la misma razón por la que
-- `CANCELLATION_PENDING` llegó en la migración …000300 y no en la …000400.
--
-- Qué se añade y por qué el recorrido lo necesita:
--
--   JOB_STARTED        el trabajador comenzó de verdad (no solo llegó)
--   JOB_UPDATE         una actualización de avance escrita por el trabajador
--   NEW_EVIDENCE       una fotografía o comprobante nuevo
--   HANDOFF_REQUESTED  el trabajador pide el código de entrega
--   JOB_APPROVED       el cliente aprobó el trabajo y liberó el payout
--   DISPUTE_RESOLVED   la administración resolvió una disputa
--   PAYOUT_PAID        se registró la transferencia al trabajador
--
-- Los avisos que YA existían y se reutilizan tal cual, sin duplicar vocabulario:
-- WORKER_ON_THE_WAY, CHECK_IN, EXTENSION_REQUESTED, EXTENSION_ANSWERED,
-- JOB_FINISHED (el trabajador pidió finalizar), DISPUTE_OPENED,
-- PAYOUT_APPROVED, NEW_REVIEW.
-- =============================================================================

alter type public.notification_type add value if not exists 'JOB_STARTED'       after 'CHECK_IN';
alter type public.notification_type add value if not exists 'JOB_UPDATE'        after 'JOB_STARTED';
alter type public.notification_type add value if not exists 'NEW_EVIDENCE'      after 'JOB_UPDATE';
alter type public.notification_type add value if not exists 'HANDOFF_REQUESTED' after 'EXTENSION_ANSWERED';
alter type public.notification_type add value if not exists 'JOB_APPROVED'      after 'JOB_FINISHED';
alter type public.notification_type add value if not exists 'DISPUTE_RESOLVED'  after 'DISPUTE_OPENED';
alter type public.notification_type add value if not exists 'PAYOUT_PAID'       after 'PAYOUT_APPROVED';
