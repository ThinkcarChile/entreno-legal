-- =============================================================================
-- HagoTuFila · Etapa 2.5 · 400 · Cancelar con un pago en vuelo, sin carreras
-- =============================================================================
-- El hallazgo que cerraba la auditoría de las RPC: `cancel_job` cancelaba un
-- trabajo en PAYMENT_PENDING sin mirar el pago. Si el proveedor confirmaba
-- después, `create_payout_for_assignment` —que no comprobaba nada— creaba un
-- payout a favor del trabajador por un trabajo cancelado, y las dos partes
-- recibían «ya puedes comenzar». El dinero del cliente quedaba cobrado sin
-- ruta de devolución.
--
-- No es un defecto del proveedor: es una carrera del dominio, y se resuelve en
-- el dominio. Garantía que deja esta migración, para cualquier orden de llegada
-- de una confirmación, un rechazo, un duplicado y una cancelación:
--
--   NUNCA coexisten trabajo cancelado, pago PAID, asignación habilitada y payout.
--
-- Política de cancelación
-- -----------------------
--   · Sin pago en vuelo → la cancelación se completa en el acto.
--   · Con un pago PENDING que nunca llegó al proveedor (sin transacción) →
--     no hay dinero en juego: el pago pasa a FAILED y se cancela en el acto.
--   · Con un pago creado en el proveedor (CREATED / AUTHORIZED, o PENDING con
--     transacción) → el trabajo pasa a CANCELLATION_PENDING. No se da por
--     cancelado hasta saber qué pasó con ese pago. El cliente ve «Estamos
--     verificando el estado del pago antes de completar la cancelación».
--   · Confirmación tardía APROBADA sobre CANCELLATION_PENDING o CANCELLED →
--     el pago queda UNDER_REVIEW con `review_reason`, con `captured_at` y con
--     los datos de autorización: el dinero se recibió y hay que devolverlo.
--     Ni habilita el trabajo ni crea payout. El trabajo termina CANCELLED.
--   · Confirmación tardía FALLIDA → no hay dinero: el pago pasa a FAILED y la
--     cancelación se completa.
--   · Pago ya confirmado (trabajo PAID) → cancelar no es una cancelación
--     simple: es reembolso o disputa. `cancel_job` lo rechaza.
--
-- «Devolución pendiente» se representa con el enum existente:
-- `payments.status = 'UNDER_REVIEW'` + `captured_at` + `review_reason`. No se
-- afirma que exista un reembolso bancario real: hasta integrar Transbank, esto
-- es el registro contable de que hay dinero que devolver.
--
-- Atomicidad
-- ----------
-- Todo lo que decide sobre dinero corre en UNA transacción con los tres
-- bloqueos tomados en el MISMO orden en todas partes:
--
--     jobs  →  assignments  →  payments
--
-- `cancel_job` ya bloqueaba el trabajo primero; `start_protected_payment`
-- bloqueaba la asignación primero y se corrige aquí. Un orden único es lo que
-- evita interbloqueos entre una cancelación y una confirmación simultáneas.
--
-- La decisión «habilitar o devolver» la toma un disparador BEFORE UPDATE sobre
-- `payments`, bajo esos bloqueos, ANTES de que el estado PAID llegue a
-- escribirse. Así vale para cualquier vía: la RPC de confirmación, un script,
-- o un UPDATE directo con la clave de servicio. El payout se crea DESPUÉS de
-- esa decisión, en el mismo disparador AFTER, y nunca al revés.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Columnas e índices
-- -----------------------------------------------------------------------------
alter table public.jobs
  add column if not exists cancellation_requested_at timestamptz;

comment on column public.jobs.cancellation_requested_at is
  'Cuándo pidió el cliente cancelar. Distinto de cancelled_at: entre ambos, el trabajo está en CANCELLATION_PENDING.';

alter table public.payments
  add column if not exists captured_at   timestamptz,
  add column if not exists review_reason text;

comment on column public.payments.captured_at is
  'Cuándo dijo el proveedor que el dinero se cobró, decidiera lo que decidiera después la plataforma.';
comment on column public.payments.review_reason is
  'Por qué un pago está UNDER_REVIEW: late_confirmation_after_cancellation, amount_mismatch, approved_after_failed…';

-- Idempotencia de los eventos del proveedor: una misma confirmación repetida
-- trae el mismo identificador, y solo se registra una vez.
alter table public.payment_events
  add column if not exists provider_event_id text;

create unique index if not exists payment_events_provider_event_idx
  on public.payment_events (provider, provider_event_id)
  where provider_event_id is not null;

-- El payout referencia al pago que lo origina: dos payouts por el mismo pago
-- no caben, ni aunque alguien borrara el índice único de assignment_id.
alter table public.payouts
  add column if not exists payment_id uuid references public.payments (id) on delete restrict;

create unique index if not exists payouts_payment_idx
  on public.payouts (payment_id)
  where payment_id is not null;


-- -----------------------------------------------------------------------------
-- 2. Privilegios: las tres tablas de dinero no las toca un usuario
-- -----------------------------------------------------------------------------
-- `payment_events` se declara append-only desde la Etapa 1, pero eso descansaba
-- solo en RLS: `authenticated` conservaba UPDATE, DELETE y TRUNCATE en las tres
-- tablas. La aplicación las escribe exclusivamente con la clave de servicio.
revoke update, delete, truncate on public.payments, public.payment_events, public.payouts
  from authenticated;


-- -----------------------------------------------------------------------------
-- 3. Los estados terminales son terminales para TODOS, también para el sistema
-- -----------------------------------------------------------------------------
-- `guard_assignment_transitions` dejaba pasar al rol de servicio y a la
-- administración. Para el orden de los pasos eso es correcto; para revivir una
-- asignación cancelada, no. Esa comprobación va ANTES de la exención.
create or replace function app_private.guard_assignment_transitions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permitidos text[];
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Sin excepción para nadie: de un estado final no se sale.
  if old.status in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER', 'COMPLETED') then
    raise exception 'La asignación ya terminó en % y no se puede reabrir', old.status
      using errcode = 'check_violation';
  end if;

  -- Sin sesión (rol de servicio, disparadores del propio sistema) y la
  -- administración no pasan por el resto, igual que en `guard_job_edits`.
  if auth.uid() is null or app_private.is_admin() then
    return new;
  end if;

  v_permitidos := case old.status::text
    when 'AWAITING_PAYMENT'    then array['CONFIRMED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'CONFIRMED'           then array['ON_THE_WAY', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'ON_THE_WAY'          then array['CHECKED_IN', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'CHECKED_IN'          then array['IN_PROGRESS', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'IN_PROGRESS'         then array['HANDOFF_COMPLETED', 'COMPLETED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'HANDOFF_COMPLETED'   then array['COMPLETED']
    else array[]::text[]
  end;

  if not (new.status::text = any (v_permitidos)) then
    raise exception 'Transición inválida en la asignación: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Lo mismo para el trabajo. De CANCELLED, EXPIRED y CLOSED no se vuelve, y de
-- CANCELLATION_PENDING solo se sale hacia CANCELLED.
create or replace function app_private.guard_job_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if old.status = 'CLOSED' then
    raise exception 'Un trabajo cerrado no cambia de estado' using errcode = 'check_violation';
  end if;

  if old.status in ('CANCELLED', 'EXPIRED') and new.status <> 'CLOSED' then
    raise exception 'Un trabajo % no se puede reabrir (→ %)', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'CANCELLATION_PENDING' and new.status <> 'CANCELLED' then
    raise exception 'Un trabajo con cancelación en verificación solo puede terminar cancelado (→ %)', new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists jobs_guard_terminal on public.jobs;
create trigger jobs_guard_terminal
  before update on public.jobs
  for each row execute function app_private.guard_job_terminal();


-- -----------------------------------------------------------------------------
-- 4. Un payout solo existe sobre un pago PAID y una asignación viva
-- -----------------------------------------------------------------------------
-- Es una restricción de la tabla, no una cortesía del código que la inserta:
-- da igual quién intente crearlo o cómo.
create or replace function app_private.guard_payout()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment public.assignments;
  v_job_status public.job_status;
  v_payment public.payments;
begin
  if tg_op = 'UPDATE' then
    if new.assignment_id is distinct from old.assignment_id
       or new.payment_id is distinct from old.payment_id
       or new.worker_id is distinct from old.worker_id then
      raise exception 'Un payout no cambia de asignación, de pago ni de trabajador'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select * into v_assignment from public.assignments where id = new.assignment_id;
  if v_assignment is null then
    raise exception 'El payout apunta a una asignación inexistente' using errcode = 'foreign_key_violation';
  end if;
  if v_assignment.status in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER') then
    raise exception 'No se crea un payout sobre una asignación cancelada' using errcode = 'check_violation';
  end if;
  if new.worker_id <> v_assignment.worker_id then
    raise exception 'El payout no es para el trabajador de la asignación' using errcode = 'check_violation';
  end if;

  select status into v_job_status from public.jobs where id = v_assignment.job_id;
  if v_job_status in ('CANCELLED', 'CANCELLATION_PENDING', 'EXPIRED') then
    raise exception 'No se crea un payout sobre un trabajo %', v_job_status using errcode = 'check_violation';
  end if;

  -- Sin pago confirmado no hay de dónde pagar.
  if new.payment_id is null then
    select id into new.payment_id
      from public.payments
     where assignment_id = new.assignment_id and purpose = 'JOB' and status = 'PAID'
     order by created_at desc
     limit 1;
  end if;
  if new.payment_id is null then
    raise exception 'No se crea un payout sin un pago confirmado' using errcode = 'check_violation';
  end if;

  select * into v_payment from public.payments where id = new.payment_id;
  if v_payment.status <> 'PAID' then
    raise exception 'No se crea un payout sobre un pago en estado %', v_payment.status
      using errcode = 'check_violation';
  end if;
  if v_payment.assignment_id is distinct from new.assignment_id then
    raise exception 'El pago del payout es de otra asignación' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists payouts_guard on public.payouts;
create trigger payouts_guard
  before insert or update on public.payouts
  for each row execute function app_private.guard_payout();


-- -----------------------------------------------------------------------------
-- 5. Crear el payout: idempotente, y ligado al pago que lo origina
-- -----------------------------------------------------------------------------
-- Cambia de firma, así que se deja de usar la anterior. El disparador que la
-- llamaba desaparece: la creación del payout pasa a `on_payment_paid`, en el
-- mismo disparador que habilita el trabajo, y no en uno aparte que podía
-- correr sin haber comprobado nada.
drop trigger if exists payments_create_payout on public.payments;
drop function if exists app_private.on_payment_paid_create_payout();
drop function if exists app_private.create_payout_for_assignment(uuid);

create or replace function app_private.create_payout_for_assignment(
  p_assignment_id uuid,
  p_payment_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment public.assignments;
  v_bps integer := app_private.commission_bps();
  v_commission bigint;
  v_net bigint;
  v_payout_id uuid;
begin
  select * into v_assignment from public.assignments where id = p_assignment_id;
  if v_assignment is null then
    raise exception 'La asignación no existe' using errcode = 'no_data_found';
  end if;

  -- Ya existe: se devuelve el mismo. Nunca dos.
  select id into v_payout_id from public.payouts where assignment_id = p_assignment_id;
  if v_payout_id is not null then
    return v_payout_id;
  end if;

  -- La comisión se aplica sobre el servicio, nunca sobre el bono: el bono llega
  -- completo a quien cumplió el objetivo.
  v_commission := round(v_assignment.agreed_total::numeric * v_bps / 10000);
  v_net := v_assignment.agreed_total - v_commission + coalesce(v_assignment.bonus_amount, 0);

  -- `guard_payout` comprueba el resto: pago PAID, asignación viva, trabajo vivo.
  insert into public.payouts (
    assignment_id, payment_id, worker_id, status, gross_amount, commission_amount,
    bonus_amount, net_amount, currency
  ) values (
    p_assignment_id, p_payment_id, v_assignment.worker_id, 'PENDING', v_assignment.agreed_total,
    v_commission, coalesce(v_assignment.bonus_amount, 0), v_net, v_assignment.currency
  )
  returning id into v_payout_id;

  return v_payout_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. Completar una cancelación
-- -----------------------------------------------------------------------------
-- Lo llama `cancel_job` cuando no hay dinero en juego, y el disparador de
-- pagos cuando el pago en vuelo se resuelve. Quien lo llama ya tiene el
-- bloqueo del trabajo.
create or replace function app_private.finalize_job_cancellation(p_job_id uuid, p_how text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_assignment public.assignments;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if v_job is null or v_job.status = 'CANCELLED' then
    return;
  end if;

  update public.jobs
     set status = 'CANCELLED',
         cancelled_at = coalesce(cancelled_at, now()),
         updated_at = now()
   where id = p_job_id
     and status in ('DRAFT', 'PUBLISHED', 'OFFER_ACCEPTED', 'PAYMENT_PENDING', 'CANCELLATION_PENDING');

  update public.job_offers
     set status = 'REJECTED', responded_at = now()
   where job_id = p_job_id and status = 'PENDING';

  update public.assignments
     set status = 'CANCELLED_BY_CLIENT', cancelled_at = now(),
         cancellation_reason = v_job.cancellation_reason, updated_at = now()
   where job_id = p_job_id and status = 'AWAITING_PAYMENT'
  returning * into v_assignment;

  if v_assignment.id is not null then
    perform app_private.notify_user(
      v_assignment.worker_id, 'JOB_CANCELLED',
      'Trabajo cancelado',
      'El cliente canceló "' || v_job.title || '".'
        || case when v_job.cancellation_reason is not null
                then ' Motivo: ' || v_job.cancellation_reason else '' end,
      '/mis-trabajos', v_job.id
    );
  end if;

  perform app_private.notify_user(
    v_job.client_id, 'JOB_CANCELLED',
    'Cancelación completada',
    case p_how
      when 'late_payment_under_review'
        then 'Cancelamos "' || v_job.title || '". Recibimos un pago después de tu solicitud: queda registrado para devolución.'
      when 'payment_failed'
        then 'Cancelamos "' || v_job.title || '". El pago no se completó, así que no hay nada que devolver.'
      else 'Cancelamos "' || v_job.title || '".'
    end,
    '/mis-trabajos/publicados/' || v_job.id, v_job.id
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. La decisión, bajo bloqueo y ANTES de escribir: ¿habilita, o devuelve?
-- -----------------------------------------------------------------------------
create or replace function app_private.guard_payment_settlement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_assignment public.assignments;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- El dinero devuelto no vuelve a estar cobrado. Aquí no hay decisión que
  -- tomar: es un error del llamante.
  if old.status in ('REFUNDED', 'PARTIALLY_REFUNDED') and new.status in ('PAID', 'FAILED', 'PENDING', 'CREATED', 'AUTHORIZED') then
    raise exception 'Un pago devuelto no cambia a %', new.status using errcode = 'check_violation';
  end if;

  -- Un pago capturado no «falla» después. Si el proveedor lo dice, es revisión.
  if new.status = 'FAILED' and old.status in ('PAID', 'UNDER_REVIEW') then
    raise exception 'Un pago ya cobrado no pasa a FAILED: pasa por revisión o reembolso'
      using errcode = 'check_violation';
  end if;

  -- Orden canónico de bloqueo: la fila de payments ya la tiene el UPDATE.
  select * into v_job from public.jobs where id = new.job_id for update;
  if new.assignment_id is not null then
    select * into v_assignment from public.assignments where id = new.assignment_id for update;
  end if;

  if new.status = 'PAID' then
    -- Solo se llega a PAID desde un estado en vuelo. Una aprobación sobre un
    -- pago que ya estaba FAILED o UNDER_REVIEW es contradictoria: puede haber
    -- dinero cobrado y hay que mirarlo, pero jamás habilita nada.
    if old.status not in ('PENDING', 'CREATED', 'AUTHORIZED') then
      new.status := 'UNDER_REVIEW';
      new.review_reason := 'approved_after_' || lower(old.status::text);
      new.captured_at := coalesce(new.captured_at, now());
      new.paid_at := null;
    elsif new.purpose = 'JOB'
          and v_job.status in ('OFFER_ACCEPTED', 'PAYMENT_PENDING')
          and v_assignment.status = 'AWAITING_PAYMENT' then
      -- Camino feliz: el trabajo sigue vivo. `on_payment_paid` lo habilita.
      new.paid_at := coalesce(new.paid_at, now());
      new.captured_at := coalesce(new.captured_at, now());
      new.authorized_at := coalesce(new.authorized_at, now());
    else
      -- Confirmación tardía: el trabajo ya no espera este pago. El dinero se
      -- recibió y queda registrado para devolución. No habilita ni paga.
      new.status := 'UNDER_REVIEW';
      new.review_reason := case
        when v_job.status in ('CANCELLED', 'CANCELLATION_PENDING') then 'late_confirmation_after_cancellation'
        else 'job_not_awaiting_payment'
      end;
      new.captured_at := coalesce(new.captured_at, now());
      new.paid_at := null;
    end if;
  end if;

  -- Un pago que deja de estar en vuelo resuelve la cancelación que lo esperaba.
  if new.status in ('FAILED', 'UNDER_REVIEW') and v_job.status = 'CANCELLATION_PENDING' then
    perform app_private.finalize_job_cancellation(
      v_job.id,
      case when new.status = 'FAILED' then 'payment_failed' else 'late_payment_under_review' end
    );
  end if;

  return new;
end;
$$;

-- Nombre con «a_» para que corra antes que `payments_touch` entre los BEFORE.
drop trigger if exists payments_a_guard_settlement on public.payments;
create trigger payments_a_guard_settlement
  before update on public.payments
  for each row execute function app_private.guard_payment_settlement();


-- -----------------------------------------------------------------------------
-- 8. Habilitar y pagar, en ese orden, después de decidir
-- -----------------------------------------------------------------------------
-- Solo se llega aquí con status = PAID, es decir, después de que la guarda
-- comprobó bajo bloqueo que el trabajo y la asignación siguen esperando este
-- pago. El payout se crea al final, con el pago ya PAID y ligado a él.
create or replace function app_private.on_payment_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_assignment public.assignments;
  v_conversation_id uuid;
begin
  if new.status <> 'PAID' or old.status = 'PAID' or new.purpose <> 'JOB' then
    return new;
  end if;

  select * into v_job from public.jobs where id = new.job_id;
  select * into v_assignment from public.assignments where id = new.assignment_id;

  if v_assignment is null then
    return new;
  end if;

  update public.assignments
     set status = 'CONFIRMED', updated_at = now()
   where id = v_assignment.id and status = 'AWAITING_PAYMENT';

  update public.jobs
     set status = 'PAID', updated_at = now()
   where id = v_job.id and status in ('OFFER_ACCEPTED', 'PAYMENT_PENDING');

  perform app_private.create_payout_for_assignment(v_assignment.id, new.id);

  select id into v_conversation_id
    from public.conversations
   where job_id = v_job.id and is_primary;

  if v_conversation_id is not null then
    insert into public.messages (conversation_id, sender_id, message_type, body)
    values (v_conversation_id, null, 'SYSTEM',
            'El trabajo fue pagado. El pago queda protegido hasta que el servicio se complete.');
  end if;

  perform app_private.notify_user(
    v_assignment.worker_id, 'JOB_PAID',
    'Pago confirmado',
    'El pago de "' || v_job.title || '" está confirmado. Ya puedes comenzar.',
    '/mis-trabajos/' || v_assignment.id, v_job.id
  );

  perform app_private.notify_user(
    v_assignment.client_id, 'JOB_PAID',
    'Pago confirmado',
    'Tu pago de "' || v_job.title || '" quedó protegido.',
    '/mis-trabajos/publicados/' || v_job.id, v_job.id
  );

  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 9. Cancelar, mirando el pago
-- -----------------------------------------------------------------------------
create or replace function public.cancel_job(p_job_id uuid, p_reason text default null::text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_assignment public.assignments;
  v_payment public.payments;
begin
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  -- Orden canónico: trabajo → asignación → pago.
  select * into v_job from public.jobs where id = p_job_id for update;

  if v_job is null then
    raise exception 'El trabajo no existe' using errcode = 'no_data_found';
  end if;

  if v_job.client_id <> auth.uid() and not app_private.is_admin() then
    raise exception 'Solo el cliente puede cancelar su trabajo'
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status = 'CANCELLATION_PENDING' then
    raise exception 'La cancelación ya está en curso: estamos verificando el estado del pago'
      using errcode = 'check_violation';
  end if;

  if v_job.status not in ('DRAFT', 'PUBLISHED', 'OFFER_ACCEPTED', 'PAYMENT_PENDING') then
    raise exception 'Este trabajo ya no se puede cancelar: con el pago confirmado, corresponde un reembolso o una disputa'
      using errcode = 'check_violation';
  end if;

  select * into v_assignment
    from public.assignments
   where job_id = p_job_id and status = 'AWAITING_PAYMENT'
   for update;

  -- Ojo: `registro is not null` en PL/pgSQL exige que TODAS las columnas sean
  -- no nulas, y estas filas siempre traen alguna nula. Se comprueba la clave.
  if v_assignment.id is not null then
    select * into v_payment
      from public.payments
     where assignment_id = v_assignment.id and purpose = 'JOB'
       and status in ('PENDING', 'CREATED', 'AUTHORIZED', 'PAID', 'UNDER_REVIEW')
     order by created_at desc
     limit 1
     for update;
  end if;

  update public.jobs
     set cancellation_reason = p_reason,
         cancellation_requested_at = coalesce(cancellation_requested_at, now())
   where id = p_job_id;

  -- Dinero ya cobrado: nunca una cancelación simple.
  if v_payment.id is not null and v_payment.status in ('PAID', 'UNDER_REVIEW') then
    raise exception 'Hay un pago cobrado sobre este trabajo: corresponde un reembolso o una disputa, no una cancelación'
      using errcode = 'check_violation';
  end if;

  -- Pago que nunca llegó al proveedor: no hay nada en vuelo.
  if v_payment.id is not null and v_payment.provider_transaction_id is null then
    update public.payments
       set status = 'FAILED', failed_at = now()
     where id = v_payment.id;
    v_payment := null;
  end if;

  -- Pago en vuelo: la cancelación queda pendiente hasta saber qué pasó.
  if v_payment.id is not null then
    update public.jobs
       set status = 'CANCELLATION_PENDING', updated_at = now()
     where id = p_job_id;

    update public.job_offers
       set status = 'REJECTED', responded_at = now()
     where job_id = p_job_id and status = 'PENDING';

    perform app_private.notify_user(
      v_job.client_id, 'JOB_CANCELLED',
      'Cancelación en verificación',
      'Estamos verificando el estado del pago de "' || v_job.title || '" antes de completar la cancelación.',
      '/mis-trabajos/publicados/' || v_job.id, v_job.id
    );
    perform app_private.notify_user(
      v_assignment.worker_id, 'JOB_CANCELLED',
      'El cliente pidió cancelar',
      'El cliente pidió cancelar "' || v_job.title || '". Se completará en cuanto se verifique el pago. No inicies el trabajo.',
      '/mis-trabajos/' || v_assignment.id, v_job.id
    );
    return;
  end if;

  perform app_private.finalize_job_cancellation(p_job_id, 'client');
end;
$$;


-- -----------------------------------------------------------------------------
-- 10. Iniciar el pago: mismo orden de bloqueo, y nunca sobre una cancelación
-- -----------------------------------------------------------------------------
create or replace function public.start_protected_payment(p_assignment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment public.assignments;
  v_job public.jobs;
  v_existing public.payments;
  v_total bigint;
  v_payment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  -- Sin bloqueo, solo para saber qué trabajo bloquear primero.
  select job_id into v_job.id from public.assignments where id = p_assignment_id;
  if v_job.id is null then
    raise exception 'La asignación no existe' using errcode = 'no_data_found';
  end if;

  select * into v_job from public.jobs where id = v_job.id for update;
  select * into v_assignment from public.assignments where id = p_assignment_id for update;

  if v_assignment.client_id <> auth.uid() then
    raise exception 'Solo el cliente puede pagar este trabajo'
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status not in ('OFFER_ACCEPTED', 'PAYMENT_PENDING') then
    raise exception 'Este trabajo ya no admite pago (está %)', v_job.status
      using errcode = 'check_violation';
  end if;

  if v_assignment.status <> 'AWAITING_PAYMENT' then
    raise exception 'Este trabajo ya no está esperando pago' using errcode = 'check_violation';
  end if;

  select * into v_existing
    from public.payments
   where assignment_id = p_assignment_id and purpose = 'JOB'
     and status in ('PENDING', 'CREATED', 'AUTHORIZED', 'PAID', 'UNDER_REVIEW')
   order by created_at desc
   limit 1;

  -- `v_existing is not null` —lo que había— nunca era cierto: la fila siempre
  -- trae columnas nulas, y cada intento creaba un pago nuevo en vez de reusar
  -- el que estaba en curso.
  if v_existing.id is not null then
    if v_existing.status = 'UNDER_REVIEW' then
      raise exception 'Hay un pago en revisión sobre este trabajo. No se inicia otro.'
        using errcode = 'check_violation';
    end if;
    -- Un pago ya confirmado no se vuelve a cobrar; uno en curso se reutiliza.
    return v_existing.id;
  end if;

  v_total := v_assignment.agreed_total + coalesce(v_assignment.bonus_amount, 0);

  insert into public.payments (
    job_id, assignment_id, client_id, purpose, status, amount, currency, provider
  ) values (
    v_assignment.job_id, p_assignment_id, v_assignment.client_id, 'JOB', 'PENDING',
    v_total, v_assignment.currency,
    coalesce(current_setting('app.payment_provider', true), 'mock')
  )
  returning id into v_payment_id;

  update public.jobs
     set status = 'PAYMENT_PENDING', updated_at = now()
   where id = v_assignment.job_id and status = 'OFFER_ACCEPTED';

  return v_payment_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 11. La confirmación del proveedor, una sola vez y bajo los tres bloqueos
-- -----------------------------------------------------------------------------
-- Es la ÚNICA vía de producción para registrar lo que dijo el proveedor. La
-- llama el servidor con la clave de servicio (la ruta /pagos/retorno hoy; el
-- webhook de Webpay mañana). Ningún usuario puede ejecutarla.
--
--   p_provider_event_id  identifica ESTA confirmación en el proveedor. La
--                        misma confirmación repetida trae el mismo id y se
--                        registra una sola vez: la segunda devuelve
--                        outcome = 'duplicate' y no toca nada.
--   p_result             lo que dijo el proveedor: 'PAID' o 'FAILED'.
--   p_amount             lo que dice el proveedor que cobró. Si no coincide con
--                        el importe del pago, no se habilita nada: revisión.
create or replace function public.confirm_payment_result(
  p_payment_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_result text,
  p_amount bigint default null,
  p_details jsonb default '{}'::jsonb
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
  v_decision text;
  v_reason text;
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
      'job_status', v_job_status,
      'assignment_status', v_assignment_status,
      'payout_id', v_payout_id
    );
  end if;

  v_decision := p_result;
  if p_result = 'PAID' and p_amount is not null and p_amount <> v_payment.amount then
    v_decision := 'UNDER_REVIEW';
    v_reason := 'amount_mismatch';
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
      'review_reason', v_reason
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
  select status into v_job_status from public.jobs where id = v_job_id;
  select status into v_assignment_status from public.assignments where id = v_assignment_id;
  select id into v_payout_id from public.payouts where assignment_id = v_assignment_id;

  return jsonb_build_object(
    'outcome', 'applied',
    'payment_status', v_payment.status,
    'review_reason', v_payment.review_reason,
    'job_status', v_job_status,
    'assignment_status', v_assignment_status,
    'payout_id', v_payout_id
  );
end;
$$;

revoke execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb) from public;
revoke execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb) from anon;
revoke execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb) from authenticated;
grant execute on function public.confirm_payment_result(uuid, text, text, text, bigint, jsonb) to service_role;

comment on function public.confirm_payment_result is
  'Única vía para registrar la respuesta del proveedor. Idempotente por (provider, provider_event_id). Solo service_role.';


-- -----------------------------------------------------------------------------
-- 12. Los invariantes, consultables
-- -----------------------------------------------------------------------------
-- Cero filas es el estado sano. Las pruebas locales y alojadas lo consultan
-- después de cada escenario y de cada carrera.
create or replace function app_private.payment_invariant_violations()
returns table (rule text, entity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Payout sobre trabajo cancelado o en cancelación.
  select 'payout_on_cancelled_job', po.id
    from public.payouts po
    join public.assignments a on a.id = po.assignment_id
    join public.jobs j on j.id = a.job_id
   where j.status in ('CANCELLED', 'CANCELLATION_PENDING', 'EXPIRED')
  union all
  -- Payout sobre asignación cancelada.
  select 'payout_on_cancelled_assignment', po.id
    from public.payouts po
    join public.assignments a on a.id = po.assignment_id
   where a.status in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')
  union all
  -- Payout sin pago PAID detrás.
  select 'payout_without_paid_payment', po.id
    from public.payouts po
   where not exists (
     select 1 from public.payments p
      where p.assignment_id = po.assignment_id and p.purpose = 'JOB' and p.status = 'PAID'
   )
  union all
  -- Pago PAID sobre trabajo cancelado.
  select 'paid_payment_on_cancelled_job', p.id
    from public.payments p
    join public.jobs j on j.id = p.job_id
   where p.status = 'PAID' and j.status in ('CANCELLED', 'CANCELLATION_PENDING')
  union all
  -- Asignación habilitada sobre trabajo cancelado.
  select 'enabled_assignment_on_cancelled_job', a.id
    from public.assignments a
    join public.jobs j on j.id = a.job_id
   where j.status in ('CANCELLED', 'CANCELLATION_PENDING')
     and a.status not in ('AWAITING_PAYMENT', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')
  union all
  -- Trabajo cancelado con asignación aún esperando pago (cancelación a medias).
  select 'cancelled_job_with_live_assignment', a.id
    from public.assignments a
    join public.jobs j on j.id = a.job_id
   where j.status = 'CANCELLED' and a.status = 'AWAITING_PAYMENT'
  union all
  -- Un mismo evento del proveedor registrado dos veces.
  select 'duplicate_provider_event', (array_agg(id order by created_at))[1]
    from public.payment_events
   where provider_event_id is not null
   group by provider, provider_event_id
  having count(*) > 1
  union all
  -- Dos payouts para el mismo pago.
  select 'duplicate_payout_for_payment', (array_agg(id order by created_at))[1]
    from public.payouts
   where payment_id is not null
   group by payment_id
  having count(*) > 1;
$$;
