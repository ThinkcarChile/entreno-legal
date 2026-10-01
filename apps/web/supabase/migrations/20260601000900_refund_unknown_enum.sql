-- =============================================================================
-- HagoTuFila · Devolución con resultado desconocido (1/2): el valor de enum
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- Va sola porque PostgreSQL no deja usar un valor de enum recién añadido dentro
-- de la misma transacción que lo crea. Lo usa la migración siguiente
-- (`20260601000910_refund_outcome_unknown.sql`), que explica el defecto.
--
-- `UNKNOWN`: se le pidió la devolución a Transbank y no sabemos qué hizo —la
-- llamada se agotó, se cortó la red, el banco contestó 5xx o algo que no se
-- entiende—. No es final: bloquea cualquier devolución nueva sobre el mismo
-- pago hasta que la conciliación o una persona digan si el dinero salió.
-- =============================================================================

alter type public.refund_status add value if not exists 'UNKNOWN';
