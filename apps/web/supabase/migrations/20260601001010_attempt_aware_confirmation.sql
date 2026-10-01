-- =============================================================================
-- HagoTuFila · La confirmación sabe de qué intento es, y un descuadre no habilita
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- Dos DEFECTOS, encontrados por la auditoría y comprobados en el código, que se
-- corrigen en la misma función porque los dos viven en el mismo asiento:
--
-- 1. UN DESCUADRE PASABA POR PAID. Cuando el proveedor autorizaba pero la orden
--    de compra, la sesión o el código de autorización no cuadraban, el retorno
--    llamaba a `confirm_payment_result` con 'PAID' y DESPUÉS movía el pago a
--    UNDER_REVIEW. El paso por PAID disparaba `on_payment_paid`: el trabajo
--    quedaba habilitado, la asignación confirmada y al trabajador le llegaba
--    «Ya puedes comenzar», aunque el payout se retuviera después. Solo el
--    descuadre de importe iba directo a revisión, porque lo decidía la propia
--    función.
--
--    Ahora el motivo del descuadre entra en la función (`p_review_reason`) y la
--    decisión es revisión desde el principio, igual que con el importe: nunca
--    pasa por PAID, no habilita el trabajo y no avisa al trabajador.
--
-- 2. UN SEGUNDO COBRO SE PERDÍA. Con el historial de intentos (migración
--    anterior) un retorno o una conciliación pueden traer el token de un
--    intento que ya no es el vigente. Si ese intento resultaba autorizado
--    cuando el pago ya estaba cobrado por otro, la función lo registraba como
--    un PAID más sobre un pago PAID: «applied», sin cambio, y el segundo cobro
--    no quedaba en ninguna parte.
--
--    Ahora la función recibe el token (`p_token`), identifica el intento bajo
--    los mismos bloqueos —jobs → assignments → payments → payment_attempts— y
--    decide:
--
--      · otro intento ya puso el dinero del pago → COBRO DUPLICADO: el intento
--        pasa a DOUBLE_CHARGE con su motivo, queda un `payment_event`, una
--        entrada de auditoría y un aviso a administración. El pago, el trabajo
--        y el payout no se tocan: el trabajo se pagó una vez y bien; lo que hay
--        que devolver es el segundo cobro, no el primero.
--      · el pago todavía no tiene dinero → este intento lo asienta, por el
--        camino de siempre, y el pago pasa a apuntar a él (token y orden de
--        compra), para que una devolución vaya a la transacción que cobró.
--      · rechazado y no es el intento vigente → solo ese intento queda FAILED.
--        El pago sigue con el intento que de verdad está en curso.
--
-- Sin `p_token` la función asienta sobre el intento vigente, como antes: así
-- siguen funcionando las llamadas que ya existían. Lo único nuevo para ellas es
-- que un intento ya resuelto con su dinero contesta `duplicate` aunque la clave
-- del evento sea otra (el mismo cobro leído por `commit` y por `status`).
--
-- La firma cambia (dos parámetros nuevos con valor por omisión), así que se
-- borra la anterior en vez de sobrecargarla: dos versiones harían ambigua
-- cualquier llamada de seis argumentos.
-- =============================================================================

drop function if exists public.confirm_payment_result(uuid, text, text, text, bigint, jsonb);

create or replace function public.confirm_payment_result(
  p_payment_id        uuid,
  p_provider          text,
  p_provider_event_id text,
  p_result            text,
  p_amount            bigint default null,
  p_details           jsonb default '{}'::jsonb,
  p_token             text default null,
  p_review_reason     text default null
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
  v_settled_by public.payment_attempts;
  v_current boolean;
  v_decision text;
  v_reason text;
  v_job_title text;
  v_job_status public.job_status;
  v_assignment_status public.assignment_status;
  v_payout_id uuid;
begin
  if p_result not in ('PAID', 'FAILED') then
    raise exception 'Resultado de proveedor no reconocido: %', p_result
      using errcode = 'invalid_parameter_value';
  end if;
  if p_provider_event_id is null or length(trim(p_provider_event_id)) = 0 then
    raise exception 'Falta el identificador del evento del proveedor'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Sin bloqueo: solo para saber qué bloquear, y en qué orden.
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

  if v_payment.provider <> p_provider then
    raise exception 'El evento es del proveedor % y el pago es de %', p_provider, v_payment.provider
      using errcode = 'check_violation';
  end if;

  -- El intento al que pertenece esta respuesta. Con token, el suyo; sin token
  -- —o con un token escrito directamente en el pago—, el vigente.
  if p_token is not null then
    select * into v_attempt from public.payment_attempts
     where provider_token = p_token
     for update;
    if v_attempt.id is not null and v_attempt.payment_id <> p_payment_id then
      raise exception 'El token pertenece a otro pago' using errcode = 'check_violation';
    end if;
    if v_attempt.id is null and v_payment.provider_token is distinct from p_token then
      raise exception 'El token no corresponde a ningún intento de este pago'
        using errcode = 'check_violation';
    end if;
  end if;
  if v_attempt.id is null then
    select * into v_attempt from public.payment_attempts
     where payment_id = p_payment_id and buy_order = v_payment.buy_order
     for update;
  end if;

  -- Vigente: el intento cuya orden de compra lleva el pago. Un pago sin
  -- historial (anterior a él) solo tiene el vigente.
  v_current := v_attempt.id is null or v_attempt.buy_order is not distinct from v_payment.buy_order;

  -- Idempotencia: bajo el bloqueo del pago, esta comprobación es segura frente
  -- a dos llamadas simultáneas. El índice único es la red por debajo.
  if exists (
    select 1 from public.payment_events
     where provider = p_provider and provider_event_id = p_provider_event_id
  ) then
    select status into v_job_status from public.jobs where id = v_job_id;
    select status into v_assignment_status from public.assignments where id = v_assignment_id;
    select id into v_payout_id from public.payouts where assignment_id = v_assignment_id;
    return jsonb_build_object(
      'outcome', 'duplicate',
      'payment_status', v_payment.status,
      'review_reason', v_payment.review_reason,
      'job_status', v_job_status,
      'assignment_status', v_assignment_status,
      'payout_id', v_payout_id,
      'attempt', v_attempt.attempt,
      'attempt_status', v_attempt.status
    );
  end if;

  -- El mismo cobro que llega por otro camino (el `commit` y la consulta de
  -- estado del mismo token, con claves distintas) no es un segundo cobro: el
  -- intento ya está resuelto con su dinero. Y un intento anterior ya resuelto
  -- no se vuelve a cerrar. Un FAILED sobre el intento vigente ya cobrado sí
  -- sigue adelante: la guarda lo rechaza en voz alta, como siempre.
  --
  -- Un intento en UNDER_REVIEW NO es «ya resuelto con su dinero»: es uno que
  -- venció con un commit pedido y sin respuesta, es decir, la duda. Si después
  -- llega su autorización, es justo la respuesta que faltaba y se registra
  -- (como cobro duplicado o sobre el pago, que la guarda manda a revisión).
  -- Tratarla como duplicada la descartaría sin evento.
  if (p_result = 'PAID' and v_attempt.status in ('SETTLED', 'DOUBLE_CHARGE'))
     or (p_result = 'FAILED' and not v_current and v_attempt.status <> 'CREATED') then
    select status into v_job_status from public.jobs where id = v_job_id;
    select status into v_assignment_status from public.assignments where id = v_assignment_id;
    select id into v_payout_id from public.payouts where assignment_id = v_assignment_id;
    return jsonb_build_object(
      'outcome', 'duplicate',
      'payment_status', v_payment.status,
      'review_reason', v_payment.review_reason,
      'job_status', v_job_status,
      'assignment_status', v_assignment_status,
      'payout_id', v_payout_id,
      'decision', case when v_attempt.status = 'DOUBLE_CHARGE' then 'DOUBLE_CHARGE' end,
      'attempt', v_attempt.attempt,
      'attempt_status', v_attempt.status
    );
  end if;

  if v_attempt.id is not null and v_attempt.provider_token is null and p_token is not null then
    update public.payment_attempts
       set provider_token = p_token, token_at = coalesce(token_at, now())
     where id = v_attempt.id;
  end if;

  /* ----------------------------------------------------- cobro duplicado --- */

  -- Otro intento ya puso el dinero de este pago. Este segundo cobro no se
  -- asienta sobre el pago —el trabajo se pagó una vez— ni se descarta: queda en
  -- el intento, a la vista de administración, para devolverlo.
  if p_result = 'PAID' and v_attempt.id is not null then
    select * into v_settled_by from public.payment_attempts
     where payment_id = p_payment_id and id <> v_attempt.id and status = 'SETTLED'
     order by attempt
     limit 1;

    if v_settled_by.id is not null then
      v_reason := 'double_charge'
        || coalesce(':' || nullif(btrim(coalesce(p_review_reason, '')), ''), '');

      update public.payment_attempts
         set status             = 'DOUBLE_CHARGE',
             review_reason      = v_reason,
             provider_status    = coalesce(p_details ->> 'provider_status', 'AUTHORIZED'),
             provider_amount    = coalesce(p_amount, provider_amount),
             authorization_code = coalesce(p_details ->> 'authorization_code', authorization_code),
             resolved_at        = now()
       where id = v_attempt.id;

      insert into public.payment_events (payment_id, from_status, to_status, provider, provider_event_id, payload)
      values (
        p_payment_id, v_payment.status, v_payment.status, p_provider, p_provider_event_id,
        coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
          'operation', 'double_charge',
          'provider_result', p_result,
          'provider_amount', p_amount,
          'expected_amount', v_payment.amount,
          'decision', 'DOUBLE_CHARGE',
          'review_reason', v_reason,
          'attempt', v_attempt.attempt,
          'buy_order', v_attempt.buy_order,
          'settled_attempt', v_settled_by.attempt
        )
      );

      insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
      values (null, 'payment_double_charge', 'payments', p_payment_id,
              jsonb_build_object('attempt', v_attempt.attempt,
                                 'buy_order', v_attempt.buy_order,
                                 'amount', coalesce(p_amount, v_payment.amount),
                                 'settled_attempt', v_settled_by.attempt,
                                 'settled_buy_order', v_settled_by.buy_order,
                                 'review_reason', v_reason));

      -- Que no dependa de que alguien abra la pantalla: aviso a administración.
      select title into v_job_title from public.jobs where id = v_job_id;
      perform app_private.notify_user(
        pr.id, 'PAYMENT_UNDER_REVIEW',
        'Cobro duplicado por devolver',
        'El cliente de "' || v_job_title || '" tiene un segundo cobro autorizado (orden '
          || v_attempt.buy_order || '). El trabajo ya estaba pagado: hay que devolverlo.',
        '/admin/pagos?filtro=review', v_job_id,
        jsonb_build_object('payment_id', p_payment_id, 'attempt', v_attempt.attempt)
      )
        from public.profiles pr
       where pr.role = 'ADMIN';

      select status into v_job_status from public.jobs where id = v_job_id;
      select status into v_assignment_status from public.assignments where id = v_assignment_id;
      select id into v_payout_id from public.payouts where assignment_id = v_assignment_id;
      return jsonb_build_object(
        'outcome', 'applied',
        'decision', 'DOUBLE_CHARGE',
        'payment_status', v_payment.status,
        'review_reason', v_reason,
        'job_status', v_job_status,
        'assignment_status', v_assignment_status,
        'payout_id', v_payout_id,
        'attempt', v_attempt.attempt,
        'attempt_status', 'DOUBLE_CHARGE'
      );
    end if;
  end if;

  /* ------------------------------------- un intento anterior, sin dinero --- */

  -- Rechazado, y no es el intento en curso: queda en su fila. Tocar el pago
  -- cerraría el intento vigente, que puede estar a punto de cobrarse.
  if p_result = 'FAILED' and not v_current then
    update public.payment_attempts
       set status          = 'FAILED',
           failure_reason  = coalesce(failure_reason, p_details ->> 'failure_reason', 'rejected_by_issuer'),
           provider_status = coalesce(p_details ->> 'provider_status', provider_status),
           provider_amount = coalesce(p_amount, provider_amount),
           resolved_at     = now()
     where id = v_attempt.id;

    insert into public.payment_events (payment_id, from_status, to_status, provider, provider_event_id, payload)
    values (
      p_payment_id, v_payment.status, v_payment.status, p_provider, p_provider_event_id,
      coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
        'operation', 'attempt_failed',
        'provider_result', p_result,
        'decision', 'ATTEMPT_FAILED',
        'attempt', v_attempt.attempt,
        'buy_order', v_attempt.buy_order
      )
    );

    select status into v_job_status from public.jobs where id = v_job_id;
    select status into v_assignment_status from public.assignments where id = v_assignment_id;
    select id into v_payout_id from public.payouts where assignment_id = v_assignment_id;
    return jsonb_build_object(
      'outcome', 'applied',
      'decision', 'ATTEMPT_FAILED',
      'payment_status', v_payment.status,
      'review_reason', v_payment.review_reason,
      'job_status', v_job_status,
      'assignment_status', v_assignment_status,
      'payout_id', v_payout_id,
      'attempt', v_attempt.attempt,
      'attempt_status', 'FAILED'
    );
  end if;

  /* ------------------------------------- el pago pasa a apuntar al cobro --- */

  -- Un intento anterior autorizado sobre un pago que todavía no tiene dinero:
  -- es el que lo paga. El pago pasa a llevar su token y su orden de compra,
  -- para que la conciliación y una devolución vayan a la transacción que cobró.
  -- El intento que estaba en curso queda en el historial como uno más.
  if p_result = 'PAID' and not v_current then
    update public.payments
       set buy_order               = v_attempt.buy_order,
           provider_token          = coalesce(v_attempt.provider_token, p_token),
           provider_transaction_id = coalesce(v_attempt.provider_token, p_token),
           redirect_url            = v_attempt.redirect_url,
           committed_at            = coalesce(v_attempt.committed_at, committed_at)
     where id = p_payment_id;
    v_current := true;
  end if;

  /* ---------------------------------------------- el camino de siempre --- */

  v_decision := p_result;
  if p_result = 'PAID' and p_amount is not null and p_amount <> v_payment.amount then
    v_decision := 'UNDER_REVIEW';
    v_reason := 'amount_mismatch';
  end if;
  -- Lo que comprobó la aplicación contra lo que se pidió (orden de compra,
  -- sesión, código de autorización). Revisión desde el principio: si pasara
  -- por PAID, `on_payment_paid` habilitaría el trabajo y avisaría al
  -- trabajador antes de que nadie pudiera retenerlo.
  if p_result = 'PAID' and nullif(btrim(coalesce(p_review_reason, '')), '') is not null then
    v_decision := 'UNDER_REVIEW';
    v_reason := btrim(p_review_reason);
  end if;

  -- El evento del proveedor se registra tal cual llegó, con la decisión al lado.
  insert into public.payment_events (payment_id, from_status, to_status, provider, provider_event_id, payload)
  values (
    p_payment_id, v_payment.status, p_result::public.payment_status, p_provider, p_provider_event_id,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
      'provider_result', p_result,
      'provider_amount', p_amount,
      'expected_amount', v_payment.amount,
      'decision', v_decision,
      'review_reason', v_reason,
      'attempt', v_attempt.attempt
    )
  );

  if v_decision = 'UNDER_REVIEW' then
    update public.payments
       set status = 'UNDER_REVIEW',
           review_reason = v_reason,
           captured_at = coalesce(captured_at, now()),
           authorization_code = coalesce(p_details ->> 'authorization_code', authorization_code),
           card_last_digits = coalesce(p_details ->> 'card_last_digits', card_last_digits),
           payment_type_code = coalesce(p_details ->> 'payment_type_code', payment_type_code)
     where id = p_payment_id;
  elsif v_decision = 'PAID' then
    -- La guarda BEFORE decide bajo bloqueo si esto se queda en PAID o pasa a
    -- UNDER_REVIEW porque el trabajo ya no lo espera.
    update public.payments
       set status = 'PAID',
           authorization_code = coalesce(p_details ->> 'authorization_code', authorization_code),
           card_last_digits = coalesce(p_details ->> 'card_last_digits', card_last_digits),
           payment_type_code = coalesce(p_details ->> 'payment_type_code', payment_type_code),
           installments = coalesce((p_details ->> 'installments')::smallint, installments)
     where id = p_payment_id;
  else
    update public.payments
       set status = 'FAILED', failed_at = coalesce(failed_at, now())
     where id = p_payment_id;
  end if;

  select * into v_payment from public.payments where id = p_payment_id;

  -- El intento queda con su resultado. SETTLED es «su dinero es el del pago»,
  -- acabe el pago como acabe: así se reconoce un segundo cobro después.
  if v_attempt.id is not null then
    update public.payment_attempts
       set status             = case when p_result = 'PAID' then 'SETTLED' else 'FAILED' end,
           failure_reason     = case when p_result = 'FAILED'
                                     then coalesce(failure_reason, p_details ->> 'failure_reason', 'rejected_by_issuer')
                                     else failure_reason end,
           review_reason      = case when p_result = 'PAID' and v_payment.status = 'UNDER_REVIEW'
                                     then v_payment.review_reason
                                     else review_reason end,
           provider_status    = coalesce(p_details ->> 'provider_status',
                                         case when p_result = 'PAID' then 'AUTHORIZED' end,
                                         provider_status),
           provider_amount    = coalesce(p_amount, provider_amount),
           authorization_code = coalesce(p_details ->> 'authorization_code', authorization_code),
           resolved_at        = now()
     where id = v_attempt.id;
  end if;

  select status into v_job_status from public.jobs where id = v_job_id;
  select status into v_assignment_status from public.assignments where id = v_assignment_id;
  select id into v_payout_id from public.payouts where assignment_id = v_assignment_id;

  return jsonb_build_object(
    'outcome', 'applied',
    'decision', v_decision,
    'payment_status', v_payment.status,
    'review_reason', v_payment.review_reason,
    'job_status', v_job_status,
    'assignment_status', v_assignment_status,
    'payout_id', v_payout_id,
    'attempt', v_attempt.attempt,
    'attempt_status', case when v_attempt.id is null then null
                           when p_result = 'PAID' then 'SETTLED' else 'FAILED' end
  );
end;
$$;

revoke execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb, text, text) from public;
revoke execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb, text, text) from anon;
revoke execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb, text, text) from authenticated;
grant execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb, text, text) to service_role;

comment on function public.confirm_payment_result is
  'Única vía para registrar la respuesta del proveedor. Idempotente por (provider, provider_event_id). Con p_token resuelve el intento: un segundo cobro queda como DOUBLE_CHARGE, nunca en silencio. Con p_review_reason, revisión sin pasar por PAID. Solo service_role.';
