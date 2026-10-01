-- =============================================================================
-- HagoTuFila · Cada intento de pago queda en su propio historial
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado en el código: `payments`
-- guarda UN token. Si el `commit` de Webpay se cortaba en la red después de que
-- Transbank lo procesara, el pago seguía en CREATED y sin `committed_at`; el
-- cliente reintentaba, `register_payment_attempt` lo aceptaba y `checkout.ts`
-- sobrescribía `provider_token` y `buy_order`. El cobro anterior quedaba
-- huérfano: nadie volvía a confirmarlo, a consultarlo ni a devolverlo. La
-- migración 20260601000400 cerró el caso del commit que SÍ contestó; el del
-- commit que no contestó, y el de dos pestañas de Webpay abiertas a la vez,
-- quedaron documentados como riesgo abierto en docs/TRANSBANK.md.
--
-- Ahora:
--
--   1. `payment_attempts`: una fila por intento, con su orden de compra, su
--      sesión, su número, su token, sus fechas y su resultado. La escribe
--      `register_payment_attempt`, que conserva sus guardas, y el token lo ata
--      `record_payment_attempt_token` al intento al que pertenece, no al último
--      que se registró. Ningún token se pierde: el del pago es el del intento
--      vigente y los anteriores siguen en el historial.
--   2. La aplicación anota en el intento que pidió el `commit` ANTES de
--      llamar. Mientras ese intento no se resuelva no se abre otro: es el caso
--      del commit cortado, que antes dejaba reintentar.
--   3. `payment_attempts_pending_reconciliation`: los intentos anteriores sin
--      resolver, que la conciliación confirma y consulta como cualquier otro.
--   4. `admin_payments` cuenta los intentos que esperan a una persona (un cobro
--      duplicado, uno vencido con dinero posible) y dice cuáles son, para que
--      se vean en /admin/pagos.
--
-- Cómo se resuelve un intento —incluido el cobro duplicado— lo decide
-- `confirm_payment_result` en la migración siguiente, bajo los bloqueos de
-- siempre.
--
-- RLS: el historial solo lo escribe el rol de servicio. Administración lo lee
-- sin el token; clientes y trabajadores, nada.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. El historial
-- -----------------------------------------------------------------------------
-- `status` es texto con CHECK y no un enum: son cinco valores que solo decide
-- este esquema, y un enum obligaría a migraciones aparte para cada valor nuevo.
--
--   CREATED        registrado; todavía no se sabe qué pasó con él
--   FAILED         no hubo dinero: rechazado, abandonado, tiempo agotado
--   SETTLED        su dinero es el del pago (lo asentó `confirm_payment_result`)
--   DOUBLE_CHARGE  autorizado cuando el pago ya tenía el dinero de OTRO intento:
--                  hay que devolverlo
--   UNDER_REVIEW   salió de la ventana de conciliación sin resolverse y con
--                  indicios de cobro: lo mira una persona
create table if not exists public.payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid not null references public.payments (id) on delete restrict,
  attempt             integer not null check (attempt > 0),
  provider            text not null,
  environment         text not null,
  buy_order           text not null,
  session_id          text,
  return_url          text,
  provider_token      text,
  redirect_url        text,

  status              text not null default 'CREATED'
                      check (status in ('CREATED', 'FAILED', 'SETTLED', 'DOUBLE_CHARGE', 'UNDER_REVIEW')),
  failure_reason      text,
  review_reason       text,

  -- Lo que contestó el proveedor sobre ESTE intento.
  provider_status     text,
  response_code       integer,
  provider_amount     bigint,
  authorization_code  text,

  created_at          timestamptz not null default now(),
  token_at            timestamptz,
  commit_requested_at timestamptz,
  committed_at        timestamptz,
  resolved_at         timestamptz,
  updated_at          timestamptz not null default now(),

  constraint payment_attempts_number_unique unique (payment_id, attempt),
  -- Lo que espera a una persona dice por qué. Es lo que ve administración.
  constraint payment_attempts_review_has_reason
    check (status not in ('DOUBLE_CHARGE', 'UNDER_REVIEW') or review_reason is not null)
);

comment on table public.payment_attempts is
  'Historial de intentos de cada pago: orden de compra, sesión, token y resultado. Ningún token se sobrescribe. Solo lo escribe service_role.';
comment on column public.payment_attempts.provider_token is
  'Token de Webpay de este intento. Secreto operativo: ningún usuario lo lee, tampoco administración.';
comment on column public.payment_attempts.commit_requested_at is
  'Cuándo se pidió el commit de este intento, ANTES de llamar. Un intento con commit pedido y sin resolver impide abrir otro.';
comment on column public.payment_attempts.status is
  'CREATED, FAILED, SETTLED (su dinero es el del pago), DOUBLE_CHARGE (cobro duplicado por devolver) o UNDER_REVIEW (vencido con indicios de cobro).';

-- La orden de compra y el token identifican el intento en Transbank: no se
-- repiten nunca, tampoco entre pagos distintos.
create unique index if not exists payment_attempts_buy_order_idx
  on public.payment_attempts (buy_order);
create unique index if not exists payment_attempts_token_idx
  on public.payment_attempts (provider_token)
  where provider_token is not null;
create index if not exists payment_attempts_open_idx
  on public.payment_attempts (created_at)
  where status = 'CREATED';
create index if not exists payment_attempts_review_idx
  on public.payment_attempts (payment_id)
  where status in ('DOUBLE_CHARGE', 'UNDER_REVIEW');

drop trigger if exists payment_attempts_touch on public.payment_attempts;
create trigger payment_attempts_touch
  before update on public.payment_attempts
  for each row execute function app_private.touch_updated_at();


-- -----------------------------------------------------------------------------
-- 2. Los intentos que ya existían
-- -----------------------------------------------------------------------------
-- De cada pago se conoce el intento vigente; los anteriores se perdieron con
-- la sobrescritura, que es justo el defecto. El vigente entra con el resultado
-- que ya tiene el pago, para que la detección de cobros duplicados sepa qué
-- intento puso el dinero.
insert into public.payment_attempts (
  payment_id, attempt, provider, environment, buy_order, session_id, return_url,
  provider_token, redirect_url, status, failure_reason, review_reason,
  provider_status, response_code, authorization_code,
  created_at, token_at, committed_at, resolved_at
)
select p.id,
       greatest(p.attempt, 1),
       p.provider,
       coalesce(p.environment, 'mock'),
       p.buy_order,
       p.session_id,
       p.return_url,
       p.provider_token,
       p.redirect_url,
       case
         when p.status in ('PAID', 'UNDER_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED') then 'SETTLED'
         when p.status = 'FAILED' then 'FAILED'
         else 'CREATED'
       end,
       case when p.status = 'FAILED' then p.failure_reason end,
       case when p.status = 'UNDER_REVIEW' then p.review_reason end,
       p.provider_status,
       p.response_code,
       p.authorization_code,
       p.updated_at,
       case when p.provider_token is not null then p.updated_at end,
       p.committed_at,
       case when p.status in ('PENDING', 'CREATED', 'AUTHORIZED') then null else p.updated_at end
  from public.payments p
 where p.buy_order is not null
on conflict do nothing;


-- -----------------------------------------------------------------------------
-- 3. Privilegios: el historial no lo toca un usuario
-- -----------------------------------------------------------------------------
-- Los privilegios por omisión del esquema regalan SELECT a `anon` y escritura
-- a `authenticated` en cada tabla nueva: se retiran primero. Administración
-- lee todo menos lo que autoriza operaciones (token, URL, sesión), igual que
-- en `payments` desde 20260601000700.
alter table public.payment_attempts enable row level security;

drop policy if exists payment_attempts_admin_read on public.payment_attempts;
create policy payment_attempts_admin_read on public.payment_attempts
  for select using (app_private.is_admin());

revoke all on public.payment_attempts from anon, authenticated;
grant select (
  id, payment_id, attempt, provider, environment, buy_order, status,
  failure_reason, review_reason, provider_status, response_code, provider_amount,
  authorization_code, created_at, token_at, commit_requested_at, committed_at,
  resolved_at, updated_at
) on public.payment_attempts to authenticated;
grant select, insert, update on public.payment_attempts to service_role;


-- -----------------------------------------------------------------------------
-- 4. Registrar el intento: ahora también en el historial
-- -----------------------------------------------------------------------------
-- Las guardas de 20260601000400 se conservan, con una precisión: se miran sobre
-- el intento que puede tener un cobro pendiente de resolver, no sobre la fila
-- del pago en bloque.
--
--   · Un intento con commit pedido, hecho o con AUTHORIZED, que sigue sin
--     resolver, impide abrir otro. Es el commit cortado por la red: antes no
--     dejaba marca y el reintento pasaba.
--   · Si el último intento ya se resolvió sin dinero (FAILED), sus marcas de
--     commit no bloquean. Era lo que dejaba sin reintento, para siempre, el
--     cobro de una extensión rechazado: `start_extension_payment` lo devuelve a
--     PENDING y `committed_at` seguía puesto.
--
-- El intento nuevo empieza limpio en la fila del pago —token, URL, commit y
-- estado del proveedor eran del anterior y siguen en el historial—, para que
-- la conciliación del pago confirme el token nuevo y no lo dé por confirmado.
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
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  if v_payment.status not in ('PENDING', 'CREATED') then
    raise exception 'El pago está en % y no admite un intento nuevo', v_payment.status
      using errcode = 'check_violation';
  end if;

  select * into v_last
    from public.payment_attempts
   where payment_id = p_payment_id
   order by attempt desc
   limit 1;

  -- Un intento anterior pasó por commit, o el proveedor lo dio por autorizado,
  -- y todavía no se sabe en qué terminó. Abrir otro ahora es arriesgar un
  -- segundo cobro: lo cierra antes la conciliación.
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

  -- Un pago de integración y uno de producción no se mezclan nunca. Si el
  -- ambiente cambió a mitad de un intento vivo, eso es un error de
  -- configuración y no se resuelve en silencio.
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
  'Deja constancia del intento —en el pago y en payment_attempts— antes de redirigir a Webpay. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 5. El token, al intento al que pertenece
-- -----------------------------------------------------------------------------
-- Antes `checkout.ts` escribía el token directamente en `payments`. Con dos
-- inicios de pago casi simultáneos —doble clic, dos pestañas— el token del
-- primero podía caer encima del intento del segundo. Ahora el token se ata por
-- orden de compra: siempre queda en su intento, y solo pasa a la fila del pago
-- si ese intento sigue siendo el vigente. Devuelve si lo es.
create or replace function public.record_payment_attempt_token(
  p_payment_id              uuid,
  p_buy_order               text,
  p_token                   text,
  p_redirect_url            text,
  p_provider_transaction_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_attempt public.payment_attempts;
  v_current boolean;
begin
  if p_token is null or length(btrim(p_token)) = 0 then
    raise exception 'Falta el token del proveedor' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  select * into v_attempt
    from public.payment_attempts
   where payment_id = p_payment_id and buy_order = p_buy_order
   for update;
  if v_attempt.id is null then
    raise exception 'La orden de compra % no es un intento de este pago', p_buy_order
      using errcode = 'check_violation';
  end if;
  if v_attempt.provider_token is not null and v_attempt.provider_token <> p_token then
    raise exception 'Este intento ya tiene otro token' using errcode = 'check_violation';
  end if;

  update public.payment_attempts
     set provider_token = p_token,
         redirect_url   = p_redirect_url,
         token_at       = coalesce(token_at, now())
   where id = v_attempt.id;

  v_current := v_payment.buy_order = p_buy_order
               and v_payment.status in ('PENDING', 'CREATED');

  if v_current then
    update public.payments
       set provider_token          = p_token,
           provider_transaction_id = coalesce(p_provider_transaction_id, p_token),
           redirect_url            = p_redirect_url,
           updated_at              = now()
     where id = p_payment_id;
  end if;

  return v_current;
end;
$$;

revoke execute on function public.record_payment_attempt_token(uuid, text, text, text, text) from public;
revoke execute on function public.record_payment_attempt_token(uuid, text, text, text, text) from anon;
revoke execute on function public.record_payment_attempt_token(uuid, text, text, text, text) from authenticated;
grant execute on function public.record_payment_attempt_token(uuid, text, text, text, text) to service_role;

comment on function public.record_payment_attempt_token is
  'Ata el token de Webpay a su intento; solo lo copia al pago si ese intento sigue vigente. Devuelve si lo es. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 6. La cola de intentos anteriores
-- -----------------------------------------------------------------------------
-- Intentos sin resolver cuyo token ya no es el del pago: los que antes se
-- perdían. La conciliación los confirma y consulta igual que al vigente. El
-- token no sale de aquí, como en `payments_pending_reconciliation`: se lee
-- después con la clave de servicio.
create or replace function public.payment_attempts_pending_reconciliation(
  p_older_than_minutes integer default 15,
  p_limit              integer default 50,
  p_payment_id         uuid default null
)
returns table (
  attempt_id     uuid,
  payment_id     uuid,
  attempt        integer,
  payment_status public.payment_status,
  provider       text,
  environment    text,
  buy_order      text,
  session_id     text,
  amount         bigint,
  created_at     timestamptz,
  token_at       timestamptz,
  committed_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.payment_id, a.attempt, p.status, a.provider, a.environment,
         a.buy_order, a.session_id, p.amount, a.created_at, a.token_at, a.committed_at
    from public.payment_attempts a
    join public.payments p on p.id = a.payment_id
   where a.status = 'CREATED'
     and a.provider_token is not null
     and a.provider_token is distinct from p.provider_token
     and (p_payment_id is null or a.payment_id = p_payment_id)
     and coalesce(a.token_at, a.created_at)
         < now() - make_interval(mins => greatest(p_older_than_minutes, 0))
     -- Dentro de la ventana en que el proveedor responde. Lo que la cruza lo
     -- recoge `expire_stale_payments`.
     and a.created_at > now() - make_interval(days => app_private.reconciliation_window_days())
   order by a.created_at
   limit least(greatest(p_limit, 1), 200);
$$;

revoke execute on function public.payment_attempts_pending_reconciliation(integer, integer, uuid) from public;
revoke execute on function public.payment_attempts_pending_reconciliation(integer, integer, uuid) from anon;
revoke execute on function public.payment_attempts_pending_reconciliation(integer, integer, uuid) from authenticated;
grant execute on function public.payment_attempts_pending_reconciliation(integer, integer, uuid) to service_role;

comment on function public.payment_attempts_pending_reconciliation is
  'Intentos anteriores sin resolver y con token, dentro de la ventana de conciliación. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 7. Lo que ve administración
-- -----------------------------------------------------------------------------
-- La vista se recrea igual que en 20260501000100 y suma dos columnas al final:
-- cuántos intentos de ese pago esperan a una persona y cuáles son, con su
-- orden de compra, que es lo que se busca en el portal de Transbank. Con
-- `security_invoker`, un cliente que consulte la vista no ve esas filas: la
-- política del historial solo deja leer a administración.
create or replace view public.admin_payments
with (security_invoker = true)
as
  select p.id                       as payment_id,
         p.job_id,
         p.assignment_id,
         j.reference                as job_reference,
         j.title                    as job_title,
         p.client_id,
         p.purpose,
         p.status,
         p.provider,
         p.environment,
         p.buy_order,
         p.amount,
         p.currency,
         p.refunded_amount,
         p.amount - p.refunded_amount as refundable_amount,
         p.provider_status,
         p.response_code,
         p.authorization_code,
         p.card_last_digits,
         p.payment_type_code,
         p.installments,
         p.vci,
         p.attempt,
         p.failure_reason,
         p.review_reason,
         p.created_at,
         p.paid_at,
         p.captured_at,
         p.committed_at,
         p.reconciled_at,
         p.failed_at,
         (select count(*) from public.payment_events e where e.payment_id = p.id) as event_count,
         (select count(*) from public.payment_refunds r
           where r.payment_id = p.id and r.status = 'CONFIRMED')                  as refund_count,
         (select d.id from public.disputes d
           where d.assignment_id = p.assignment_id limit 1)                      as dispute_id,
         (select o.id from public.payouts o where o.payment_id = p.id limit 1)    as payout_id,
         (select count(*) from public.payment_attempts a
           where a.payment_id = p.id
             and a.status in ('DOUBLE_CHARGE', 'UNDER_REVIEW'))                   as attempts_in_review,
         (select string_agg('intento ' || a.attempt || ' · ' || a.buy_order || ' · ' || a.review_reason,
                            '; ' order by a.attempt)
            from public.payment_attempts a
           where a.payment_id = p.id
             and a.status in ('DOUBLE_CHARGE', 'UNDER_REVIEW'))                   as attempts_review_detail
    from public.payments p
    join public.jobs j on j.id = p.job_id;

comment on view public.admin_payments is
  'Pagos para el panel de administración. Sin token: el token autoriza operaciones y no sale de la base. Incluye los intentos que esperan a una persona.';

grant select on public.admin_payments to authenticated;
