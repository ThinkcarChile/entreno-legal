-- =============================================================================
-- HagoTuFila · Un retorno sin cobro solo cierra el intento que lo trae
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado en el código: el cliente
-- abre Webpay en una pestaña, reintenta en otra (intento nuevo, token nuevo) y
-- después anula la primera. Ese retorno trae el `TBK_TOKEN` del intento
-- anterior; como el token ya no estaba en el pago, el retorno lo encontraba por
-- `session_id` —que es el mismo en todos los intentos— y
-- `record_payment_abandonment` marcaba FAILED el pago entero, es decir, el
-- intento VIGENTE. Si ese intento se aprobaba luego, la guarda lo veía como
-- «aprobado tras fallar» y el pago caía en revisión: cliente cobrado, trabajo
-- sin habilitar.
--
-- Ahora la función recibe la identidad del intento que trae el retorno —token
-- u orden de compra— y decide bajo los bloqueos de siempre:
--
--   · es el intento vigente → como antes: el pago pasa a FAILED, salvo que ya
--     tenga un resultado con dinero;
--   · es un intento anterior → solo ese intento pasa a FAILED, con su motivo y
--     un `payment_event`. El pago no se toca;
--   · sin identidad → el intento vigente, que es lo que hacían las llamadas
--     anteriores a esta migración.
--
-- Y `expire_stale_payments` cierra también los intentos anteriores que salen
-- de la ventana sin resolverse: FAILED si no hubo indicio de cobro, y
-- UNDER_REVIEW —a la vista de administración— si se pidió su commit o el
-- proveedor lo llegó a dar por autorizado. Ninguno se queda colgado en
-- silencio. El intento vigente de un pago que vence sigue la suerte del pago.
--
-- La firma de `record_payment_abandonment` cambia (dos parámetros nuevos con
-- valor por omisión): se borra la anterior para no dejar dos versiones.
-- =============================================================================

drop function if exists public.record_payment_abandonment(uuid, text, text, jsonb);

create or replace function public.record_payment_abandonment(
  p_payment_id     uuid,
  p_provider       text,
  p_failure_reason text,
  p_details        jsonb default '{}'::jsonb,
  p_token          text default null,
  p_buy_order      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_assignment_id uuid;
  v_payment public.payments;
  v_attempt public.payment_attempts;
  v_current boolean;
begin
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

  -- El intento que trae el retorno.
  if p_token is not null then
    select * into v_attempt from public.payment_attempts
     where payment_id = p_payment_id and provider_token = p_token
     for update;
  end if;
  if v_attempt.id is null and p_buy_order is not null then
    select * into v_attempt from public.payment_attempts
     where payment_id = p_payment_id and buy_order = p_buy_order
     for update;
  end if;

  if p_token is null and p_buy_order is null then
    -- Sin identidad: el intento vigente, como antes de esta migración.
    select * into v_attempt from public.payment_attempts
     where payment_id = p_payment_id and buy_order = v_payment.buy_order
     for update;
    v_current := true;
  else
    v_current := (p_token is not null and p_token = v_payment.provider_token)
              or (v_attempt.id is not null and v_attempt.buy_order = v_payment.buy_order)
              or (v_attempt.id is null and p_buy_order is not null and p_buy_order = v_payment.buy_order);
  end if;

  /* ------------------------------------------------- un intento anterior --- */

  if not v_current then
    -- Ni es el vigente ni está en el historial de este pago: no hay nada que
    -- cerrar, y el pago no se toca.
    if v_attempt.id is null then
      return jsonb_build_object(
        'outcome', 'ignored',
        'payment_status', v_payment.status,
        'reason', 'el retorno no corresponde a ningún intento de este pago'
      );
    end if;

    if v_attempt.status <> 'CREATED' then
      return jsonb_build_object(
        'outcome', 'ignored',
        'payment_status', v_payment.status,
        'attempt', v_attempt.attempt,
        'attempt_status', v_attempt.status,
        'reason', 'ese intento ya estaba resuelto'
      );
    end if;

    update public.payment_attempts
       set status          = 'FAILED',
           failure_reason  = p_failure_reason,
           provider_status = coalesce(p_details ->> 'provider_status', provider_status),
           response_code   = coalesce((p_details ->> 'response_code')::integer, response_code),
           resolved_at     = now()
     where id = v_attempt.id;

    insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
    values (
      p_payment_id, v_payment.status, v_payment.status, p_provider,
      coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
        'operation', 'return',
        'scope', 'attempt',
        'attempt', v_attempt.attempt,
        'buy_order', v_attempt.buy_order,
        'failure_reason', p_failure_reason
      )
    );

    return jsonb_build_object(
      'outcome', 'attempt_only',
      'payment_status', v_payment.status,
      'attempt', v_attempt.attempt,
      'attempt_status', 'FAILED',
      'failure_reason', p_failure_reason
    );
  end if;

  /* ---------------------------------------------------- el intento vigente --- */

  -- Un pago que ya se resolvió con dinero de por medio no se «abandona».
  if v_payment.status in ('PAID', 'AUTHORIZED', 'UNDER_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED') then
    return jsonb_build_object(
      'outcome', 'ignored',
      'payment_status', v_payment.status,
      'reason', 'el pago ya tiene un resultado financiero'
    );
  end if;

  update public.payments
     set status         = 'FAILED',
         failure_reason = p_failure_reason,
         failed_at      = coalesce(failed_at, now()),
         updated_at     = now()
   where id = p_payment_id;

  insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
  values (
    p_payment_id, v_payment.status, 'FAILED', p_provider,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
      'operation', 'return',
      'failure_reason', p_failure_reason,
      'attempt', v_attempt.attempt
    )
  );

  if v_attempt.id is not null then
    update public.payment_attempts
       set status          = 'FAILED',
           failure_reason  = p_failure_reason,
           provider_status = coalesce(p_details ->> 'provider_status', provider_status),
           response_code   = coalesce((p_details ->> 'response_code')::integer, response_code),
           resolved_at     = now()
     where id = v_attempt.id and status = 'CREATED';
  end if;

  return jsonb_build_object(
    'outcome', 'applied',
    'payment_status', 'FAILED',
    'failure_reason', p_failure_reason,
    'attempt', v_attempt.attempt,
    'attempt_status', case when v_attempt.id is null then null else 'FAILED' end
  );
end;
$$;

revoke execute on function public.record_payment_abandonment(uuid, text, text, jsonb, text, text) from public;
revoke execute on function public.record_payment_abandonment(uuid, text, text, jsonb, text, text) from anon;
revoke execute on function public.record_payment_abandonment(uuid, text, text, jsonb, text, text) from authenticated;
grant execute on function public.record_payment_abandonment(uuid, text, text, jsonb, text, text) to service_role;

comment on function public.record_payment_abandonment is
  'Registra un retorno sin cobro (abandono, timeout, conflicto) sobre el intento que lo trae: el pago solo cambia si es el intento vigente. Nunca toca un pago que ya tiene resultado financiero.';


-- -----------------------------------------------------------------------------
-- Los rezagados, también por intento
-- -----------------------------------------------------------------------------
-- Igual que en 20260501000500 para los pagos, y además:
--
--   · el intento vigente de un pago que vence acompaña al pago (FAILED, o
--     UNDER_REVIEW si el pago estaba AUTHORIZED);
--   · un intento anterior que sale de la ventana sin resolverse se cierra con
--     su propio evento y su propia auditoría.
--
-- La salida de la función no cambia: una fila por PAGO que cambió de estado.
-- Los intentos anteriores no cambian el estado de ningún pago.
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
    select p.id, p.status, p.job_id, p.assignment_id, p.provider, p.buy_order
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

    -- El intento vigente sigue la suerte del pago.
    update public.payment_attempts a
       set status         = case when v_next = 'UNDER_REVIEW' then 'UNDER_REVIEW' else 'FAILED' end,
           review_reason  = case when v_next = 'UNDER_REVIEW' then 'reconciliation_window_expired' end,
           failure_reason = case when v_next = 'FAILED' then 'reconciliation_window_expired' end,
           resolved_at    = now()
     where a.payment_id = v_row.id
       and a.buy_order = v_row.buy_order
       and a.status = 'CREATED';

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

  -- Los intentos anteriores que salieron de la ventana sin resolverse.
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

    -- Con commit pedido, hecho, o un AUTHORIZED del proveedor puede haber
    -- dinero: a una persona. Sin nada de eso, no hubo cobro.
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
  'Cierra o manda a revisión los pagos —y los intentos anteriores— que cruzaron la ventana de conciliación. Ninguno desaparece sin evento y auditoría. Solo service_role.';
