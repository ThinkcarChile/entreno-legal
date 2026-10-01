-- =============================================================================
-- HagoTuFila · «Devoluciones por procesar» cuenta pagos, cada uno una vez
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTOS, comprobados sobre la base y en el panel:
--
-- 1. `admin_pending_reviews()` (20260601000910) sumaba tres recuentos
--    independientes: pagos `UNDER_REVIEW`, disputas resueltas con devolución
--    sin pedir y devoluciones abiertas. Un pago en revisión al que ya se le
--    pidió la devolución contaba DOS veces: la tarjeta del panel decía 2 y la
--    lista a la que lleva mostraba 1.
-- 2. La cifra y la lista no medían lo mismo. `/admin/pagos?filtro=review`
--    muestra además los pagos con un intento en revisión (un cobro duplicado,
--    20260601001000), que la cifra no contaba; y la cifra contaba las disputas
--    resueltas a favor del cliente sin devolución pedida, que la lista no
--    mostraba. La tarjeta podía decir 0 con un cobro duplicado esperando, o 1
--    sin que la lista enseñara nada que hacer.
-- 3. (En la aplicación) la lista tenía tope de 100 filas.
--
-- Qué cambia:
--
-- · `app_private.payment_review_queue()`: una fila por PAGO que espera a una
--   persona, con el porqué —en revisión, devolución abierta, intentos en
--   revisión, disputa resuelta con devolución sin pedir—. Es la única
--   definición de la cola: la cifra y la lista salen de aquí.
--   Los tres primeros motivos se leen de la vista `admin_payments`
--   (`status`, `open_refund_id`, `attempts_in_review`), que es justo lo que
--   filtraba antes `/admin/pagos?filtro=review` y lo que muestra cada
--   tarjeta. No se vuelven a derivar de las tablas: si la vista cambia qué
--   cuenta como intento en revisión (p. ej. deja fuera un cobro duplicado ya
--   devuelto), la cola y la cifra cambian con ella y no se quedan con un pago
--   que la pantalla ya no muestra como pendiente.
-- · `public.admin_payment_review_queue()`: la misma cola para el panel. Solo
--   administración; sin el rol, lanza excepción. `/admin/pagos?filtro=review`
--   la recorre entera, por tramos, del pago más antiguo al más reciente.
-- · `admin_pending_reviews()`: misma firma y mismas claves; `refunds` pasa a
--   ser el número de filas de esa cola.
--
-- La disputa se cuenta en el pago que la devuelve: el pago del TRABAJO de su
-- asignación —el que ya cobró, si hay más de uno; el último, si ninguno—, que
-- es también el que toma `default_client_wins_refund` (20260601000300) y al
-- que lleva el enlace «Devolución pendiente» de `/admin/disputas`. Pendiente
-- es lo resuelto menos lo comprometido con esa disputa (en curso, por
-- confirmar o confirmado), igual que antes: una devolución pedida deja de
-- contar como disputa y pasa a contar como devolución abierta, del mismo pago.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La cola, definida una sola vez
-- -----------------------------------------------------------------------------
create or replace function app_private.payment_review_queue()
returns table (
  payment_id             uuid,
  created_at             timestamptz,
  under_review           boolean,
  open_refund            boolean,
  attempts_in_review     integer,
  dispute_id             uuid,
  dispute_refund_pending bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with disputa as (
    -- Resueltas con importe a favor del cliente, con lo que falta pedir.
    select d.id,
           d.created_at,
           (select p.id
              from public.payments p
             where p.assignment_id = d.assignment_id
               and p.purpose = 'JOB'
             order by (p.status in ('PAID', 'PARTIALLY_REFUNDED', 'UNDER_REVIEW', 'REFUNDED')) desc,
                      p.created_at desc,
                      p.id desc
             limit 1)                                             as payment_id,
           d.refund_amount - coalesce((
             select sum(r.amount)
               from public.payment_refunds r
              where r.dispute_id = d.id
                and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')
           ), 0)                                                  as pending
      from public.disputes d
     where d.status = 'RESOLVED'
       and coalesce(d.refund_amount, 0) > 0
  ),
  disputa_por_pago as (
    select x.payment_id,
           sum(x.pending)::bigint                                  as pending,
           (array_agg(x.id order by x.created_at, x.id))[1]        as dispute_id
      from disputa x
     where x.pending > 0
       and x.payment_id is not null
     group by x.payment_id
  )
  -- Los motivos del pago, de la vista del panel: los mismos campos que
  -- muestra cada tarjeta de /admin/pagos (ver la cabecera). La vista es
  -- `security_invoker`; aquí la lee el dueño de la función.
  select v.payment_id,
         v.created_at,
         v.status = 'UNDER_REVIEW',
         v.open_refund_id is not null,
         coalesce(v.attempts_in_review, 0)::integer,
         dp.dispute_id,
         coalesce(dp.pending, 0)
    from public.admin_payments v
    left join disputa_por_pago dp on dp.payment_id = v.payment_id
   where v.status = 'UNDER_REVIEW'
      or v.open_refund_id is not null
      or v.attempts_in_review > 0
      or dp.payment_id is not null;
$$;

revoke all on function app_private.payment_review_queue() from public, anon, authenticated;

comment on function app_private.payment_review_queue is
  'Pagos que esperan a una persona, uno por fila: en revisión, con devolución abierta, con intentos en revisión o con la devolución de una disputa sin pedir. Los motivos del pago salen de la vista admin_payments, la misma de /admin/pagos. La usan admin_pending_reviews y admin_payment_review_queue.';


-- -----------------------------------------------------------------------------
-- 2. La misma cola, para el panel
-- -----------------------------------------------------------------------------
-- Con la sesión de quien administra, como el resto del panel. Admite `order`,
-- `limit` y filtros de PostgREST: la aplicación la recorre por tramos.
create or replace function public.admin_payment_review_queue()
returns table (
  payment_id             uuid,
  created_at             timestamptz,
  under_review           boolean,
  open_refund            boolean,
  attempts_in_review     integer,
  dispute_id             uuid,
  dispute_refund_pending bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración' using errcode = 'insufficient_privilege';
  end if;

  return query select q.* from app_private.payment_review_queue() q;
end;
$$;

revoke execute on function public.admin_payment_review_queue() from public, anon;
grant execute on function public.admin_payment_review_queue() to authenticated;

comment on function public.admin_payment_review_queue is
  'Cola «En revisión» de /admin/pagos. Solo administración: sin el rol lanza excepción. La cifra de admin_pending_reviews.refunds es su número de filas.';


-- -----------------------------------------------------------------------------
-- 3. Los recuentos del panel: `refunds` es la cola, sin contar dos veces
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000910 salvo `v_refunds`.
create or replace function public.admin_pending_reviews()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check_ins integer;
  v_disputes integer;
  v_payouts integer;
  v_refunds integer;
  v_extensions integer;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_check_ins from public.assignment_check_ins where review_status = 'PENDING';
  select count(*) into v_disputes from public.disputes where status in ('OPEN', 'UNDER_REVIEW');
  select count(*) into v_payouts from public.payouts where status in ('PENDING', 'APPROVED', 'HELD');
  -- Un pago por fila, aunque tenga varios motivos: es lo que lista
  -- /admin/pagos?filtro=review, adonde lleva la tarjeta.
  select count(*) into v_refunds from app_private.payment_review_queue();
  select count(*) into v_extensions from public.job_extensions where status = 'PENDING' and expires_at > now();

  return jsonb_build_object(
    'check_ins', v_check_ins,
    'disputes', v_disputes,
    'payouts', v_payouts,
    'refunds', v_refunds,
    'extensions', v_extensions
  );
end;
$$;

revoke execute on function public.admin_pending_reviews() from public, anon;
grant execute on function public.admin_pending_reviews() to authenticated;
