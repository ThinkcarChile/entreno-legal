-- =============================================================================
-- HagoTuFila · La ventana del proveedor corre desde el intento vigente, y el
-- registro de un intento bloquea en el orden de todos
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO 1, encontrado al integrar las ramas de pagos: `expire_stale_payments`
-- medía la ventana de conciliación desde `payments.created_at`. Un pago se crea
-- una vez y se intenta muchas: un cobro del tiempo adicional que se rechazó y se
-- reintenta días después, o un cliente que vuelve a pagar una semana más tarde.
-- Con el pago creado hace siete días o más, el intento recién abierto —con el
-- cliente todavía escribiendo su tarjeta en el formulario de Webpay— se cerraba
-- como FAILED en la siguiente pasada del cron. Si el cliente pagaba, el retorno
-- encontraba el pago FAILED y la guarda lo mandaba a revisión: cliente cobrado y
-- trabajo sin habilitar.
--
-- La misma cuenta tenía otras dos caras, que se corrigen a la vez porque sin
-- ellas la corrección abría un hueco:
--
--   · `payments_pending_reconciliation` excluía el pago por la misma fecha: un
--     intento nuevo sobre un pago viejo no se conciliaba nunca —ni se cerraba,
--     ya con la corrección— hasta siete días después del intento.
--   · el invariante `stale_payment_out_of_window` lo señalaba como roto.
--
-- Ahora las tres miden desde el intento vigente —el que lleva la orden de
-- compra del pago—: desde que se registró, segundos antes de crear la
-- transacción en Webpay. Solo un pago sin intento (nunca salió hacia el
-- proveedor) se mide desde su creación. Es la misma fecha con que la cola de
-- intentos anteriores y el segundo bucle de `expire_stale_payments` ya medían
-- los suyos (`payment_attempts.created_at`): un intento se mide igual sea el
-- vigente o no.
--
-- DEFECTO 2: `register_payment_attempt` bloqueaba el pago y después, a través
-- de la guarda de liquidación (que corre al pasar el pago a CREATED), el
-- trabajo y la asignación. Es el orden inverso al de `confirm_payment_result`,
-- `record_payment_abandonment` y `expire_stale_payments` (trabajo → asignación
-- → pago). Un cliente que reintenta mientras la conciliación confirma el
-- intento anterior del mismo pago podía dejar a las dos sesiones esperándose
-- una a otra hasta que PostgreSQL abortara una por interbloqueo. Ahora bloquea
-- trabajo → asignación → pago antes de tocar nada, como las demás.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Desde cuándo corre la ventana del proveedor
-- -----------------------------------------------------------------------------
create or replace function app_private.payment_window_start(
  p_payment_id uuid,
  p_buy_order  text,
  p_created_at timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select a.created_at
       from public.payment_attempts a
      where a.payment_id = p_payment_id and a.buy_order = p_buy_order),
    p_created_at)
$$;

comment on function app_private.payment_window_start is
  'Desde cuándo corre la ventana del proveedor para el intento vigente de un pago (el de su orden de compra): su registro. Sin intento, la creación del pago.';

revoke all on function app_private.payment_window_start(uuid, text, timestamptz) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. La cola de conciliación de pagos
-- -----------------------------------------------------------------------------
-- Idéntica a 20260501000500 salvo la fecha: el margen mínimo y la ventana se
-- miden desde el intento vigente.
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
    cross join lateral (
      select app_private.payment_window_start(p.id, p.buy_order, p.created_at) as desde
    ) w
   where p.status in ('PENDING', 'CREATED', 'AUTHORIZED', 'UNDER_REVIEW')
     and p.provider_token is not null
     and w.desde < now() - make_interval(mins => greatest(p_older_than_minutes, 0))
     -- Dentro de la ventana en que el proveedor todavía responde. Lo que la
     -- cruza NO se pierde: lo recoge `expire_stale_payments`.
     and w.desde > now() - make_interval(days => app_private.reconciliation_window_days())
   order by w.desde
   limit least(greatest(p_limit, 1), 200);
$$;

revoke execute on function public.payments_pending_reconciliation(integer, integer) from public;
revoke execute on function public.payments_pending_reconciliation(integer, integer) from anon;
revoke execute on function public.payments_pending_reconciliation(integer, integer) from authenticated;
grant execute on function public.payments_pending_reconciliation(integer, integer) to service_role;


-- -----------------------------------------------------------------------------
-- 3. Los rezagados, medidos desde el intento vigente
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001020 salvo la selección del primer bucle y su
-- relectura bajo bloqueo: un intento registrado entre la selección y el
-- bloqueo cambia la orden de compra del pago y reinicia la ventana, así que se
-- vuelve a medir con la fila ya bloqueada y se usa la orden de compra que tiene
-- AHORA, no la de la selección.
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
  v_attempt public.payment_attempts;
  v_payment public.payments;
  v_attempt_next text;
begin
  v_cutoff := now() - make_interval(days => app_private.reconciliation_window_days());

  for v_row in
    select p.id, p.job_id, p.assignment_id
      from public.payments p
      cross join lateral (
        select app_private.payment_window_start(p.id, p.buy_order, p.created_at) as desde
      ) w
     where p.status in ('PENDING', 'CREATED', 'AUTHORIZED')
       and w.desde <= v_cutoff
     order by w.desde
     limit least(greatest(p_limit, 1), 500)
  loop
    -- Orden canónico de bloqueo: jobs → assignments → payments.
    perform 1 from public.jobs where id = v_row.job_id for update;
    if v_row.assignment_id is not null then
      perform 1 from public.assignments where id = v_row.assignment_id for update;
    end if;
    select * into v_payment from public.payments where id = v_row.id for update;

    -- Se relee bajo el bloqueo: entre la selección y aquí, una conciliación
    -- simultánea pudo resolverlo, o el cliente pudo abrir un intento nuevo.
    if v_payment.status not in ('PENDING', 'CREATED', 'AUTHORIZED')
       or app_private.payment_window_start(v_payment.id, v_payment.buy_order, v_payment.created_at)
            > v_cutoff then
      continue;
    end if;

    -- AUTHORIZED puede tener dinero detrás: no se cierra solo.
    v_next := case
      when v_payment.status = 'AUTHORIZED' then 'UNDER_REVIEW'::public.payment_status
      else 'FAILED'::public.payment_status
    end;

    if v_next = 'UNDER_REVIEW' then
      update public.payments
         set status        = 'UNDER_REVIEW',
             review_reason = 'reconciliation_window_expired',
             captured_at   = coalesce(captured_at, now()),
             updated_at    = now()
       where id = v_payment.id;
    else
      update public.payments
         set status         = 'FAILED',
             failure_reason = 'reconciliation_window_expired',
             failed_at      = coalesce(failed_at, now()),
             updated_at     = now()
       where id = v_payment.id;
    end if;

    -- El intento vigente sigue la suerte del pago, salvo que tenga indicios de
    -- cobro propios: entonces va a revisión (ver 20260601001020).
    update public.payment_attempts a
       set status         = case
                              when v_next = 'UNDER_REVIEW'
                                or a.commit_requested_at is not null
                                or a.committed_at is not null
                                or upper(coalesce(a.provider_status, '')) in ('AUTHORIZED', 'CAPTURED')
                              then 'UNDER_REVIEW' else 'FAILED' end,
           review_reason  = case
                              when v_next = 'UNDER_REVIEW'
                                or a.commit_requested_at is not null
                                or a.committed_at is not null
                                or upper(coalesce(a.provider_status, '')) in ('AUTHORIZED', 'CAPTURED')
                              then 'reconciliation_window_expired' end,
           failure_reason = case
                              when v_next = 'UNDER_REVIEW'
                                or a.commit_requested_at is not null
                                or a.committed_at is not null
                                or upper(coalesce(a.provider_status, '')) in ('AUTHORIZED', 'CAPTURED')
                              then null else 'reconciliation_window_expired' end,
           resolved_at    = now()
     where a.payment_id = v_payment.id
       and a.buy_order = v_payment.buy_order
       and a.status = 'CREATED';

    insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
    values (v_payment.id, v_payment.status, v_next, v_payment.provider,
            jsonb_build_object(
              'operation', 'expire',
              'reason', 'reconciliation_window_expired',
              'window_days', app_private.reconciliation_window_days()
            ));

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (null, 'payment_expired_out_of_window', 'payments', v_payment.id,
            jsonb_build_object('status', v_payment.status),
            jsonb_build_object('status', v_next,
                               'window_days', app_private.reconciliation_window_days()));

    payment_id := v_payment.id;
    was_status := v_payment.status;
    now_status := v_next;
    reason := 'reconciliation_window_expired';
    return next;
  end loop;

  -- Los intentos anteriores que salieron de la ventana sin resolverse. Igual
  -- que en 20260601001020: cada uno se mide desde su propio registro.
  for v_row in
    select a.id, a.payment_id, p.job_id, p.assignment_id
      from public.payment_attempts a
      join public.payments p on p.id = a.payment_id
     where a.status = 'CREATED'
       and a.created_at <= v_cutoff
     order by a.created_at
     limit least(greatest(p_limit, 1), 500)
  loop
    perform 1 from public.jobs where id = v_row.job_id for update;
    if v_row.assignment_id is not null then
      perform 1 from public.assignments where id = v_row.assignment_id for update;
    end if;
    select * into v_payment from public.payments where id = v_row.payment_id for update;
    select * into v_attempt from public.payment_attempts where id = v_row.id for update;

    if v_attempt.status <> 'CREATED' then
      continue;
    end if;

    v_attempt_next := case
      when v_attempt.commit_requested_at is not null
        or v_attempt.committed_at is not null
        or upper(coalesce(v_attempt.provider_status, '')) in ('AUTHORIZED', 'CAPTURED')
      then 'UNDER_REVIEW'
      else 'FAILED'
    end;

    update public.payment_attempts
       set status         = v_attempt_next,
           review_reason  = case when v_attempt_next = 'UNDER_REVIEW' then 'reconciliation_window_expired' end,
           failure_reason = case when v_attempt_next = 'FAILED' then 'reconciliation_window_expired' end,
           resolved_at    = now()
     where id = v_attempt.id;

    insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
    values (v_payment.id, v_payment.status, v_payment.status, v_attempt.provider,
            jsonb_build_object(
              'operation', 'expire_attempt',
              'reason', 'reconciliation_window_expired',
              'attempt', v_attempt.attempt,
              'buy_order', v_attempt.buy_order,
              'attempt_status', v_attempt_next
            ));

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (null, 'payment_attempt_expired_out_of_window', 'payments', v_payment.id,
            jsonb_build_object('attempt', v_attempt.attempt, 'status', 'CREATED'),
            jsonb_build_object('attempt', v_attempt.attempt, 'status', v_attempt_next,
                               'buy_order', v_attempt.buy_order));
  end loop;
end;
$$;

revoke execute on function public.expire_stale_payments(integer) from public;
revoke execute on function public.expire_stale_payments(integer) from anon;
revoke execute on function public.expire_stale_payments(integer) from authenticated;
grant execute on function public.expire_stale_payments(integer) to service_role;

comment on function public.expire_stale_payments is
  'Cierra o manda a revisión los pagos cuyo intento vigente cruzó la ventana de conciliación, y los intentos anteriores que la cruzaron. Ninguno desaparece sin evento y auditoría. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 4. El invariante, con la misma fecha
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000910 salvo `stale_payment_out_of_window`, que mide desde
-- el intento vigente como las dos funciones de arriba.
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
  select 'stale_payment_out_of_window', p.id
    from public.payments p
   where p.status in ('PENDING', 'CREATED', 'AUTHORIZED')
     and app_private.payment_window_start(p.id, p.buy_order, p.created_at)
           <= now() - make_interval(days => app_private.reconciliation_window_days() + 1)

  union all
  select 'refund_committed_over_amount', p.id
    from public.payments p
   where (select coalesce(sum(r.amount), 0) from public.payment_refunds r
           where r.payment_id = p.id and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED'))
         > p.amount;
$$;

revoke execute on function app_private.refund_invariant_violations() from public;
revoke execute on function app_private.refund_invariant_violations() from anon;
grant execute on function app_private.refund_invariant_violations() to authenticated;


-- -----------------------------------------------------------------------------
-- 5. Registrar un intento, en el orden de todos
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001000 salvo los cerrojos del principio. La guarda de
-- liquidación (`guard_payment_settlement`) corre al pasar el pago a CREATED y
-- bloquea el trabajo, la asignación y, en un cobro del tiempo adicional, la
-- extensión. Con el trabajo y la asignación ya bloqueados aquí, antes que el
-- pago, la guarda los encuentra tomados por esta misma transacción y el orden
-- queda trabajo → asignación → pago → extensión, el de `confirm_payment_result`.
create or replace function public.register_payment_attempt(
  p_payment_id  uuid,
  p_provider    text,
  p_environment text,
  p_buy_order   text,
  p_session_id  text,
  p_return_url  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_last public.payment_attempts;
  v_job_id uuid;
  v_assignment_id uuid;
begin
  -- [Nuevo] Sin bloqueo: solo para saber qué bloquear, y en qué orden.
  select job_id, assignment_id into v_job_id, v_assignment_id
    from public.payments where id = p_payment_id;
  if v_job_id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  perform 1 from public.jobs where id = v_job_id for update;
  if v_assignment_id is not null then
    perform 1 from public.assignments where id = v_assignment_id for update;
  end if;
  select * into v_payment from public.payments where id = p_payment_id for update;

  if v_payment.status not in ('PENDING', 'CREATED') then
    raise exception 'El pago está en % y no admite un intento nuevo', v_payment.status
      using errcode = 'check_violation';
  end if;

  select * into v_last
    from public.payment_attempts
   where payment_id = p_payment_id
   order by attempt desc
   limit 1;

  if exists (
       select 1 from public.payment_attempts a
        where a.payment_id = p_payment_id
          and a.status = 'CREATED'
          and (a.commit_requested_at is not null
               or a.committed_at is not null
               or upper(coalesce(a.provider_status, '')) in ('AUTHORIZED', 'CAPTURED'))
     )
     or (coalesce(v_last.status, 'CREATED') = 'CREATED'
         and (v_payment.committed_at is not null
              or upper(coalesce(v_payment.provider_status, '')) in ('AUTHORIZED', 'CAPTURED'))) then
    raise exception 'Tu pago anterior se está confirmando. Espera unos minutos antes de volver a pagar'
      using errcode = 'check_violation';
  end if;

  if p_environment not in ('integration', 'production', 'mock') then
    raise exception 'Ambiente de proveedor no reconocido: %', p_environment
      using errcode = 'invalid_parameter_value';
  end if;

  if v_payment.environment is not null and v_payment.environment <> p_environment then
    raise exception 'El pago se creó en el ambiente % y ahora se intenta en %',
      v_payment.environment, p_environment
      using errcode = 'check_violation';
  end if;

  insert into public.payment_attempts (
    payment_id, attempt, provider, environment, buy_order, session_id, return_url
  ) values (
    p_payment_id, v_payment.attempt + 1, p_provider, p_environment, p_buy_order,
    p_session_id, p_return_url
  );

  update public.payments
     set provider                = p_provider,
         environment             = p_environment,
         buy_order               = p_buy_order,
         session_id              = coalesce(session_id, p_session_id),
         return_url              = p_return_url,
         attempt                 = attempt + 1,
         status                  = 'CREATED',
         provider_token          = null,
         provider_transaction_id = null,
         redirect_url            = null,
         committed_at            = null,
         provider_status         = null,
         response_code           = null,
         vci                     = null,
         failure_reason          = null,
         updated_at              = now()
   where id = p_payment_id;

  insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
  values (
    p_payment_id, v_payment.status, 'CREATED', p_provider,
    jsonb_build_object(
      'operation', 'create',
      'environment', p_environment,
      'buy_order', p_buy_order,
      'attempt', v_payment.attempt + 1
    )
  );
end;
$$;

revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from public;
revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from anon;
revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from authenticated;
grant execute on function public.register_payment_attempt(uuid, text, text, text, text, text) to service_role;

comment on function public.register_payment_attempt is
  'Deja constancia del intento —en el pago y en payment_attempts— antes de redirigir a Webpay. Bloquea trabajo → asignación → pago, como confirm_payment_result. Solo service_role.';
