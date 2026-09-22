-- =============================================================================
-- HagoTuFila · Bloque 5.1 · 500 · Ventana de conciliación y pagos rezagados
-- =============================================================================
-- Dos cosas que quedaron a medias en el Bloque 5.
--
-- 1. LA VENTANA ESTABA CLAVADA EN EL CÓDIGO
--
--    `payments_pending_reconciliation` llevaba `interval '7 days'` escrito
--    dentro. Siete días es lo que responde Webpay hoy, pero es una cifra del
--    proveedor, no una ley: si mañana la cambian, o si otro proveedor tiene
--    otra, hay que editar una función de base para algo que es configuración.
--    Pasa a `platform_settings`, junto al resto de tolerancias del producto.
--
-- 2. LOS PAGOS QUE CRUZABAN ESA VENTANA DESAPARECÍAN
--
--    Y este es el de verdad. La consulta excluía los pagos más viejos que la
--    ventana. Eso significa que un pago sin estado final simplemente dejaba de
--    aparecer en la cola el octavo día: nadie lo volvía a mirar, nadie lo
--    cerraba, y no quedaba constancia de que se hubiera abandonado. Un pago
--    puede quedarse así para siempre, invisible.
--
--    Ahora cruzar la ventana es un hecho con nombre, registrado y auditado, y
--    el destino depende de si hubo dinero de por medio:
--
--      PENDING / CREATED   → FAILED con `reconciliation_window_expired`.
--                            El token de Webpay muere a los 5 minutos; a los
--                            siete días es seguro que no hubo cobro. Se cierra
--                            y el cliente queda libre para volver a pagar.
--
--      AUTHORIZED          → UNDER_REVIEW con `reconciliation_window_expired`.
--      UNDER_REVIEW              Aquí sí puede haber dinero recibido, así que
--                            no se cierra solo: pasa a revisión y se queda en
--                            la cola de administración hasta que una persona
--                            decida.
--
--    En los dos casos se escribe un `payment_event` y una entrada de auditoría.
--    Ningún pago se cierra en silencio.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La ventana, como configuración
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column if not exists reconciliation_window_days integer not null default 7;

comment on column public.platform_settings.reconciliation_window_days is
  'Días durante los que el proveedor responde por una transacción. Webpay Plus: 7. Pasado el plazo, un pago sin estado final se cierra o pasa a revisión.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_reconciliation_window_ck') then
    alter table public.platform_settings
      add constraint platform_settings_reconciliation_window_ck
      check (reconciliation_window_days between 1 and 90);
  end if;
end $$;

create or replace function app_private.reconciliation_window_days()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select reconciliation_window_days from public.platform_settings limit 1), 7);
$$;

revoke execute on function app_private.reconciliation_window_days() from public;
revoke execute on function app_private.reconciliation_window_days() from anon;


-- -----------------------------------------------------------------------------
-- 2. La cola, con la ventana leída de la configuración
-- -----------------------------------------------------------------------------
create or replace function public.payments_pending_reconciliation(
  p_older_than_minutes integer default 5,
  p_limit integer default 50
)
returns table (
  payment_id     uuid,
  job_id         uuid,
  assignment_id  uuid,
  reference      text,
  status         public.payment_status,
  provider       text,
  environment    text,
  buy_order      text,
  session_id     text,
  amount         bigint,
  attempt        integer,
  created_at     timestamptz,
  reconciled_at  timestamptz,
  review_reason  text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.job_id, p.assignment_id, j.reference, p.status, p.provider,
         p.environment, p.buy_order, p.session_id, p.amount, p.attempt,
         p.created_at, p.reconciled_at, p.review_reason
    from public.payments p
    join public.jobs j on j.id = p.job_id
   where p.status in ('PENDING', 'CREATED', 'AUTHORIZED', 'UNDER_REVIEW')
     and p.provider_token is not null
     and p.created_at < now() - make_interval(mins => greatest(p_older_than_minutes, 0))
     -- Dentro de la ventana en que el proveedor todavía responde. Lo que la
     -- cruza NO se pierde: lo recoge `expire_stale_payments`.
     and p.created_at > now() - make_interval(days => app_private.reconciliation_window_days())
   order by p.created_at
   limit least(greatest(p_limit, 1), 200);
$$;

revoke execute on function public.payments_pending_reconciliation(integer, integer) from public;
revoke execute on function public.payments_pending_reconciliation(integer, integer) from anon;
revoke execute on function public.payments_pending_reconciliation(integer, integer) from authenticated;
grant execute on function public.payments_pending_reconciliation(integer, integer) to service_role;


-- -----------------------------------------------------------------------------
-- 3. Los rezagados: ninguno desaparece
-- -----------------------------------------------------------------------------
create or replace function public.expire_stale_payments(p_limit integer default 100)
returns table (
  payment_id  uuid,
  was_status  public.payment_status,
  now_status  public.payment_status,
  reason      text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_cutoff timestamptz;
  v_next public.payment_status;
begin
  v_cutoff := now() - make_interval(days => app_private.reconciliation_window_days());

  for v_row in
    select p.id, p.status, p.job_id, p.assignment_id, p.provider
      from public.payments p
     where p.status in ('PENDING', 'CREATED', 'AUTHORIZED')
       and p.created_at <= v_cutoff
     order by p.created_at
     limit least(greatest(p_limit, 1), 500)
  loop
    -- Orden canónico de bloqueo: jobs → assignments → payments.
    perform 1 from public.jobs where id = v_row.job_id for update;
    if v_row.assignment_id is not null then
      perform 1 from public.assignments where id = v_row.assignment_id for update;
    end if;
    perform 1 from public.payments where id = v_row.id for update;

    -- Se relee bajo el bloqueo: entre la selección y aquí, una conciliación
    -- simultánea pudo resolverlo.
    if not exists (
      select 1 from public.payments
       where id = v_row.id and status in ('PENDING', 'CREATED', 'AUTHORIZED')
    ) then
      continue;
    end if;

    -- AUTHORIZED puede tener dinero detrás: no se cierra solo.
    v_next := case
      when v_row.status = 'AUTHORIZED' then 'UNDER_REVIEW'::public.payment_status
      else 'FAILED'::public.payment_status
    end;

    if v_next = 'UNDER_REVIEW' then
      update public.payments
         set status        = 'UNDER_REVIEW',
             review_reason = 'reconciliation_window_expired',
             captured_at   = coalesce(captured_at, now()),
             updated_at    = now()
       where id = v_row.id;
    else
      update public.payments
         set status         = 'FAILED',
             failure_reason = 'reconciliation_window_expired',
             failed_at      = coalesce(failed_at, now()),
             updated_at     = now()
       where id = v_row.id;
    end if;

    insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
    values (v_row.id, v_row.status, v_next, v_row.provider,
            jsonb_build_object(
              'operation', 'expire',
              'reason', 'reconciliation_window_expired',
              'window_days', app_private.reconciliation_window_days()
            ));

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (null, 'payment_expired_out_of_window', 'payments', v_row.id,
            jsonb_build_object('status', v_row.status),
            jsonb_build_object('status', v_next,
                               'window_days', app_private.reconciliation_window_days()));

    payment_id := v_row.id;
    was_status := v_row.status;
    now_status := v_next;
    reason := 'reconciliation_window_expired';
    return next;
  end loop;
end;
$$;

revoke execute on function public.expire_stale_payments(integer) from public;
revoke execute on function public.expire_stale_payments(integer) from anon;
revoke execute on function public.expire_stale_payments(integer) from authenticated;
grant execute on function public.expire_stale_payments(integer) to service_role;

comment on function public.expire_stale_payments is
  'Cierra o manda a revisión los pagos que cruzaron la ventana de conciliación. Ninguno desaparece sin evento y auditoría. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 4. Un pago sin resolver y fuera de ventana es una violación de invariante
-- -----------------------------------------------------------------------------
-- Si `expire_stale_payments` deja de ejecutarse, esto lo dice. Antes no lo
-- decía nadie: simplemente se acumulaban en silencio.
create or replace function app_private.refund_invariant_violations()
returns table (rule text, entity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 'refunded_over_amount', p.id
    from public.payments p
   where p.refunded_amount > p.amount

  union all
  select 'refunded_without_confirmation', p.id
    from public.payments p
   where p.status in ('REFUNDED', 'PARTIALLY_REFUNDED')
     and not exists (
       select 1 from public.payment_refunds r
        where r.payment_id = p.id and r.status = 'CONFIRMED'
     )

  union all
  select 'refunded_amount_mismatch', p.id
    from public.payments p
   where p.refunded_amount <> coalesce((
           select sum(r.amount) from public.payment_refunds r
            where r.payment_id = p.id and r.status = 'CONFIRMED'
         ), 0)

  union all
  select 'confirmed_refund_without_kind', r.id
    from public.payment_refunds r
   where r.status = 'CONFIRMED' and r.kind is null

  union all
  select 'environment_mixed', p.id
    from public.payments p
    join public.payment_refunds r on r.payment_id = p.id
   where p.environment is not null and r.environment <> p.environment

  union all
  -- Pago sin estado final, fuera de la ventana y sin haber pasado por
  -- `expire_stale_payments`: se quedó colgado y nadie lo sabe.
  select 'stale_payment_out_of_window', p.id
    from public.payments p
   where p.status in ('PENDING', 'CREATED', 'AUTHORIZED')
     and p.created_at <= now() - make_interval(
           days => app_private.reconciliation_window_days() + 1
         );
$$;

revoke execute on function app_private.refund_invariant_violations() from public;
revoke execute on function app_private.refund_invariant_violations() from anon;
grant execute on function app_private.refund_invariant_violations() to authenticated;
