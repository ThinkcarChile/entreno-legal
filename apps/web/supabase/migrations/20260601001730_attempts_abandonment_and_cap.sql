-- =============================================================================
-- HagoTuFila · Un abandono no tumba un cobro en curso, los intentos tienen
-- tope y el trabajador deja de recibir el identificador del pago
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO 1, encontrado por la auditoría cruzada y reproducido sobre la base:
-- el cliente abre Webpay en dos pestañas (intentos 1 y 2), paga en la primera
-- —el retorno marca su commit y llama a Transbank— y anula la segunda, que es
-- la vigente. `register_payment_attempt` ya se negaba a abrir un intento nuevo
-- mientras otro tuviera el commit pedido; `record_payment_abandonment` no
-- miraba lo mismo y pasaba el PAGO a FAILED. La autorización del primero caía
-- entonces sobre un pago fallido: UNDER_REVIEW («approved_after_failed»), el
-- trabajo sin habilitar y `start_protected_payment` negándose a otro pago
-- («Hay un pago en revisión»). Solo una devolución y un segundo pago lo
-- destrababan.
--
-- Ahora, con otro intento del mismo pago confirmándose (commit pedido o hecho,
-- o autorizado según el proveedor), el abandono del vigente cierra SOLO ese
-- intento y el pago sigue CREATED: es la misma condición, al revés, que la de
-- `register_payment_attempt`. Cuando el otro intento se resuelva, el pago
-- queda PAID por él o, si también falla, el siguiente abandono o la
-- conciliación lo cierran.
--
-- DEFECTO 2: los intentos no tenían tope. Cada «Pagar» abría una transacción
-- nueva en Transbank con las credenciales del comercio, y la conciliación
-- preguntaba después por cada una. Un cliente con un trabajo esperando pago
-- podía abrir miles. Ahora `register_payment_attempt` admite como mucho cinco
-- intentos por pago en treinta minutos; el sexto se niega con un mensaje para
-- el cliente, ANTES de llamar a Transbank (`startCheckout` registra el intento
-- antes de crear la transacción).
--
-- DEFECTO 3 (defensa en profundidad del retorno sin token, ver TRANSBANK.md
-- §4): `assignment_payment_states` le entregaba al trabajador el `id` de los
-- pagos de su asignación. Con él y la ruta /pagos/retorno se podía fabricar un
-- retorno «tiempo agotado» del pago del cliente. El retorno ya no decide nada
-- con lo que trae la URL (pregunta a Transbank por el token guardado del
-- intento), pero el trabajador tampoco necesita el identificador: ninguna de
-- sus pantallas lo usa. Lo recibe en nulo; el cliente y administración, igual
-- que antes.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. El abandono del vigente, con otro intento confirmándose
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001020 salvo lo marcado [Nuevo].
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

  -- [Nuevo] Otro intento de este mismo pago se está confirmando: su commit se
  -- pidió o se hizo, o el proveedor lo dio por autorizado. Es la condición con
  -- que `register_payment_attempt` se niega a abrir otro. Cerrar el pago aquí
  -- haría caer esa autorización sobre un pago FAILED —revisión, trabajo sin
  -- habilitar—, así que se cierra solo el intento vigente y el pago sigue en
  -- curso, a la espera del otro.
  if exists (
       select 1 from public.payment_attempts a
        where a.payment_id = p_payment_id
          and a.id is distinct from v_attempt.id
          and a.status = 'CREATED'
          and (a.commit_requested_at is not null
               or a.committed_at is not null
               or upper(coalesce(a.provider_status, '')) in ('AUTHORIZED', 'CAPTURED'))
     ) then
    if v_attempt.id is null or v_attempt.status <> 'CREATED' then
      return jsonb_build_object(
        'outcome', 'ignored',
        'payment_status', v_payment.status,
        'attempt', v_attempt.attempt,
        'attempt_status', v_attempt.status,
        'reason', 'otro intento de este pago se está confirmando'
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
        'failure_reason', p_failure_reason,
        'payment_kept', 'another_attempt_committing'
      )
    );

    return jsonb_build_object(
      'outcome', 'attempt_only',
      'payment_status', v_payment.status,
      'attempt', v_attempt.attempt,
      'attempt_status', 'FAILED',
      'failure_reason', p_failure_reason,
      'reason', 'otro intento de este pago se está confirmando'
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
  'Registra un retorno sin cobro (abandono, timeout, conflicto) sobre el intento que lo trae: el pago solo cambia si es el intento vigente y ningún otro intento suyo se está confirmando. Nunca toca un pago que ya tiene resultado financiero.';


-- -----------------------------------------------------------------------------
-- 2. Registrar un intento, con tope
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001410 salvo el tope, marcado [Nuevo].
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

  -- [Nuevo] Tope: cinco intentos por pago en treinta minutos. Cada intento es
  -- una transacción nueva en Transbank con las credenciales del comercio, y
  -- la conciliación pregunta después por cada una. Nadie que de verdad quiere
  -- pagar necesita más; el que los encadena por guion, sí. Bajo el cerrojo del
  -- pago, dos llamadas simultáneas no se cuelan las dos por el mismo hueco.
  if (select count(*) from public.payment_attempts a
       where a.payment_id = p_payment_id
         and a.created_at > now() - interval '30 minutes') >= 5 then
    raise exception 'Hiciste varios intentos de pago en poco tiempo. Espera unos minutos antes de volver a intentarlo'
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
  'Deja constancia del intento —en el pago y en payment_attempts— antes de redirigir a Webpay. Bloquea trabajo → asignación → pago, como confirm_payment_result. Como mucho cinco intentos por pago en treinta minutos. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 3. Lo que las dos partes saben del pago de su trabajo
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000920 salvo el `id`, marcado [Nuevo]: lo reciben el
-- cliente que pagó y administración; el trabajador, nulo.
create or replace function public.assignment_payment_states(p_assignment_ids uuid[])
returns table (
  id            uuid,
  job_id        uuid,
  assignment_id uuid,
  extension_id  uuid,
  client_id     uuid,
  purpose       public.payment_purpose,
  status        public.payment_status,
  amount        bigint,
  provider      text,
  authorized_at timestamptz,
  paid_at       timestamptz,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when a.client_id = auth.uid() or app_private.is_admin() then p.id end,
         p.job_id, p.assignment_id, p.extension_id, p.client_id, p.purpose,
         p.status, p.amount, p.provider, p.authorized_at, p.paid_at, p.created_at
    from public.payments p
    join public.assignments a on a.id = p.assignment_id
   where p.assignment_id = any (p_assignment_ids)
     and (a.client_id = auth.uid() or a.worker_id = auth.uid() or app_private.is_admin())
   order by p.created_at desc;
$$;

revoke execute on function public.assignment_payment_states(uuid[]) from public;
revoke execute on function public.assignment_payment_states(uuid[]) from anon;
grant execute on function public.assignment_payment_states(uuid[]) to authenticated;

comment on function public.assignment_payment_states is
  'Pagos de las asignaciones de quien llama (cliente o trabajador) o de cualquiera para administración: estado, propósito, importe y fechas. Nada del proveedor ni de la tarjeta; el identificador del pago, solo para el cliente y administración.';
