-- =============================================================================
-- HagoTuFila · Etapa 2.5 · 300 · Un estado para «cancelación en verificación»
-- =============================================================================
-- Va en su propia migración a propósito: PostgreSQL no permite USAR un valor de
-- enum en la misma transacción que lo añade. La migración …000400 es la que lo
-- usa; esta solo lo declara.
--
-- CANCELLATION_PENDING: el cliente pidió cancelar mientras había un pago en
-- vuelo (creado en el proveedor, sin confirmación ni rechazo todavía). El
-- trabajo no se da por cancelado hasta saber qué pasó con ese pago, porque una
-- confirmación tardía no puede ni revivir el trabajo ni quedar sin registrar.
-- Sale de ahí solo hacia CANCELLED.
--
-- JOB_CANCELLED: para avisar a las dos partes de la cancelación con su propio
-- tipo, en vez de disfrazarlo de JOB_UPDATED.
-- =============================================================================

alter type public.job_status add value if not exists 'CANCELLATION_PENDING' after 'PAYMENT_PENDING';

alter type public.notification_type add value if not exists 'JOB_CANCELLED';
