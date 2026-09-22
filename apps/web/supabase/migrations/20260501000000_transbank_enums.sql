-- =============================================================================
-- HagoTuFila · Bloque 5 · 000 · Valores de enumeración para Webpay Plus
-- =============================================================================
-- Va en su propia migración porque PostgreSQL no permite usar un valor de enum
-- recién añadido dentro de la misma transacción que lo crea.
--
-- Qué se añade y qué NO.
--
-- NO se añaden estados a `payment_status`. El encargo pide distinguir
-- conceptualmente iniciado, pendiente, autorizado, pagado, fallido, abandonado,
-- timeout, en revisión, reversado, parcialmente anulado, anulado, devolución
-- solicitada y devolución confirmada. Doce de esos trece ya caben en lo que
-- hay:
--
--   iniciado / pendiente     → PENDING
--   creado en el proveedor   → CREATED
--   autorizado               → AUTHORIZED
--   pagado                   → PAID
--   fallido                  → FAILED
--   abandonado               → FAILED + failure_reason = 'aborted_by_user'
--   timeout                  → FAILED + failure_reason = 'form_timeout'
--   en revisión              → UNDER_REVIEW + review_reason
--   reversado / anulado      → REFUNDED
--   parcialmente anulado     → PARTIALLY_REFUNDED
--
-- «Abandonado» y «timeout» no son estados contables distintos de «fallido»:
-- en los tres casos no hay dinero. Lo que cambia es el motivo, y el motivo es
-- un dato, no un estado. Inventar `ABORTED` y `TIMEOUT` obligaría a tocar cada
-- `in (...)` del esquema —y son decenas— a cambio de nada que la máquina de
-- estados necesite decidir.
--
-- Lo único que sí necesita vocabulario propio es la devolución, porque
-- «solicitada» y «confirmada» sí son dos hechos distintos con consecuencias
-- distintas: una devolución pedida y no confirmada NO reduce lo devuelto.
-- =============================================================================

create type public.refund_status as enum (
  'REQUESTED',   -- se pidió al proveedor; todavía no se sabe
  'CONFIRMED',   -- el proveedor la confirmó: hay dinero devuelto
  'FAILED',      -- el proveedor la rechazó; no hay dinero devuelto
  'CANCELLED'    -- se descartó antes de llegar al proveedor
);

comment on type public.refund_status is
  'Estado de una devolución. CONFIRMED solo tras respuesta exitosa del proveedor, nunca por haberla solicitado.';

/**
 * Cómo lo resolvió el banco. Son dos operaciones distintas con respuestas de
 * forma distinta, no dos nombres para lo mismo.
 */
create type public.refund_kind as enum ('REVERSED', 'NULLIFIED');

comment on type public.refund_kind is
  'REVERSED: reversa del mismo día, antes de la captura. NULLIFIED: anulación, total o parcial, con su propia autorización.';

-- Nuevos avisos del ciclo de vida del dinero.
alter type public.notification_type add value if not exists 'PAYMENT_UNDER_REVIEW';
alter type public.notification_type add value if not exists 'REFUND_CONFIRMED';
