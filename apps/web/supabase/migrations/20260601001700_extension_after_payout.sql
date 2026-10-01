-- =============================================================================
-- HagoTuFila · El tiempo adicional pagado tarde no reescribe un pago ya hecho
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría cruzada y reproducido sobre la base: el
-- cobro del tiempo adicional se podía pagar DESPUÉS de que se transfiriera el
-- pago al trabajador, y `on_extension_paid` lo sumaba igual al payout:
--
--   a. el trabajador pide 60 minutos más, el cliente los acepta y no paga;
--   b. el trabajo se aprueba, vence la ventana y administración registra la
--      transferencia: payout PAID por $18.480, con su referencia bancaria;
--   c. el cliente paga el tiempo adicional. `confirm_payment_result` lo da por
--      bueno y el payout PAID pasa a $26.220 con la MISMA referencia y la misma
--      fecha. Al trabajador se le avisa «Se sumó a lo que recibirás».
--
-- Resultado: un registro de transferencia que no coincide con lo que movió el
-- banco, $7.740 que el trabajador no recibe y que ninguna pantalla puede
-- pagarle (PAID es terminal), y el cliente que tampoco puede recuperarlos
-- porque `refund_after_payout_blocker` cree que ya salieron. Ningún invariante
-- ni cola lo veía. Con un payout CANCELLED (disputa a favor del cliente) pasaba
-- lo mismo: el importe se sumaba a un payout cancelado. Y no hacía falta pagar
-- tarde a propósito: un cobro adicional en curso mientras se registraba la
-- transferencia terminaba igual.
--
-- Ahora, en cuatro capas que van juntas:
--
--   · `guard_payment_settlement`: el cobro de una extensión solo se asienta
--     como PAID si el payout de la asignación todavía admite sumas (PENDING,
--     APPROVED o HELD) y el trabajo no está cerrado. Si no, el dinero ya se
--     cobró y queda en UNDER_REVIEW con `review_reason = payout_already_settled`:
--     sale en la cola de revisión de /admin/pagos y se devuelve desde ahí. El
--     payout se bloquea en el orden canónico (trabajo → asignación → pago →
--     extensión → payout) antes de decidir, así que una transferencia que se
--     registra a la vez espera o es esperada, nunca se cruza.
--   · `on_extension_paid`: solo suma a un payout PENDING, APPROVED o HELD, y
--     solo avisa al trabajador si de verdad sumó. Y solo la primera vez que el
--     cobro llega a PAID desde un estado en vuelo (ver más abajo la revisión
--     manual: volver a PAID al quitarla no es un cobro nuevo).
--   · `start_extension_payment`: no abre el cobro cuando el payout ya no admite
--     sumas o el trabajo está cerrado, con un mensaje que se entiende. Y bloquea
--     pago → extensión → payout, el orden de todos (antes tomaba la extensión
--     antes que el pago).
--   · `guard_payout`: los importes de un payout PAID o CANCELLED no cambian,
--     venga de donde venga el UPDATE. Es la red por debajo de todo lo anterior.
--     Ningún camino legítimo los toca: la transferencia (`mark_payout_paid`)
--     solo cambia estado, referencia y fecha; `resolve_dispute` recorta el neto
--     o cancela en el mismo UPDATE que cambia el estado, sobre un payout que no
--     está ni PAID ni CANCELLED; la aprobación solo toca payouts PENDING.
--
-- La guarda de liquidación, que se reescribe entera aquí, trae además la puerta
-- que usa `release_payment_review` (20260601001720) para devolver a PAID un pago
-- puesto en revisión A MANO: solo ese motivo (`manual_review`) y solo dentro de
-- esa función, que lo anuncia en una variable local a la transacción.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La guarda de liquidación
-- -----------------------------------------------------------------------------
-- Idéntica a 20260401000100 salvo lo marcado [Nuevo].
create or replace function app_private.guard_payment_settlement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_assignment public.assignments;
  v_extension public.job_extensions;
  v_payout_status public.payout_status;
  v_extension_live boolean;
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
  if new.extension_id is not null then
    select * into v_extension from public.job_extensions where id = new.extension_id for update;
  end if;

  -- [Nuevo] El payout, después de la extensión: es lo que decide si el cobro
  -- adicional todavía tiene dónde sumarse. Bloqueado, una transferencia que se
  -- registra a la vez no puede cambiarlo entre esta decisión y la suma.
  if new.purpose = 'EXTENSION' and new.status = 'PAID' and new.assignment_id is not null then
    select status into v_payout_status
      from public.payouts where assignment_id = new.assignment_id
       for update;
  end if;

  if new.status = 'PAID' then
    v_extension_live := new.purpose = 'EXTENSION'
      and v_extension.id is not null
      and v_extension.status = 'ACCEPTED'
      and v_extension.assignment_id = new.assignment_id
      and v_assignment.status not in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')
      and v_job.status not in ('CANCELLED', 'CANCELLATION_PENDING', 'EXPIRED');

    -- [Nuevo] Quitar una revisión puesta a mano. La revisión no fue una duda
    -- sobre el dinero —ese pago ya estaba cobrado y asentado—, sino una pausa
    -- que decidió una persona; la misma persona la levanta desde
    -- `release_payment_review`, que comprueba todo lo demás bajo los mismos
    -- cerrojos. Cualquier otro UNDER_REVIEW sigue sin volver nunca a PAID.
    if old.status = 'UNDER_REVIEW'
       and old.review_reason = 'manual_review'
       and current_setting('app.release_manual_review', true) = new.id::text then
      new.review_reason := null;
      new.paid_at := coalesce(new.paid_at, now());
      new.captured_at := coalesce(new.captured_at, now());
    -- Solo se llega a PAID desde un estado en vuelo. Una aprobación sobre un
    -- pago que ya estaba FAILED o UNDER_REVIEW es contradictoria: puede haber
    -- dinero cobrado y hay que mirarlo, pero jamás habilita nada.
    elsif old.status not in ('PENDING', 'CREATED', 'AUTHORIZED') then
      new.status := 'UNDER_REVIEW';
      new.review_reason := 'approved_after_' || lower(old.status::text);
      new.captured_at := coalesce(new.captured_at, now());
      new.paid_at := null;
    elsif new.purpose = 'JOB'
          and v_job.status in ('OFFER_ACCEPTED', 'PAYMENT_PENDING')
          and v_assignment.status = 'AWAITING_PAYMENT' then
      -- Camino feliz del trabajo: sigue vivo. `on_payment_paid` lo habilita.
      new.paid_at := coalesce(new.paid_at, now());
      new.captured_at := coalesce(new.captured_at, now());
      new.authorized_at := coalesce(new.authorized_at, now());
    elsif v_extension_live
          -- [Nuevo] y con un payout que todavía admite sumas, en un trabajo
          -- que no está cerrado. Transferido, en proceso o cancelado, sumarle
          -- algo reescribiría un pago que ya se hizo (o que ya no se hará).
          and v_job.status <> 'CLOSED'
          and v_payout_status in ('PENDING', 'APPROVED', 'HELD') then
      -- Tiempo adicional de un trabajo vivo: el cobro es válido. No habilita
      -- nada por sí mismo; `on_extension_paid` lo suma al payout existente.
      new.paid_at := coalesce(new.paid_at, now());
      new.captured_at := coalesce(new.captured_at, now());
      new.authorized_at := coalesce(new.authorized_at, now());
    else
      -- Confirmación tardía: el trabajo ya no espera este pago. El dinero se
      -- recibió y queda registrado para devolución. No habilita ni paga.
      new.status := 'UNDER_REVIEW';
      new.review_reason := case
        when v_job.status in ('CANCELLED', 'CANCELLATION_PENDING') then 'late_confirmation_after_cancellation'
        -- [Nuevo] La extensión estaba bien; lo que ya no está es dónde sumarla.
        when v_extension_live then 'payout_already_settled'
        when new.purpose = 'EXTENSION' then 'extension_not_accepted'
        else 'job_not_awaiting_payment'
      end;
      new.captured_at := coalesce(new.captured_at, now());
      new.paid_at := null;
    end if;
  end if;

  -- Un pago del trabajo que deja de estar en vuelo resuelve la cancelación que
  -- lo esperaba. Un pago de extensión nunca decide sobre la cancelación.
  if new.purpose = 'JOB'
     and new.status in ('FAILED', 'UNDER_REVIEW')
     and v_job.status = 'CANCELLATION_PENDING' then
    perform app_private.finalize_job_cancellation(
      v_job.id,
      case when new.status = 'FAILED' then 'payment_failed' else 'late_payment_under_review' end
    );
  end if;

  return new;
end;
$$;

comment on function app_private.guard_payment_settlement is
  'BEFORE UPDATE de payments: decide bajo cerrojo (trabajo → asignación → pago → extensión → payout) si un PAID habilita, suma al payout o va a revisión. Un cobro adicional con el payout ya transferido o cancelado va a UNDER_REVIEW (payout_already_settled). Solo release_payment_review devuelve a PAID un pago en revisión manual.';

revoke all on function app_private.guard_payment_settlement() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. El cobro adicional solo suma donde todavía se puede sumar
-- -----------------------------------------------------------------------------
-- Idéntica a 20260401000100 salvo lo marcado [Nuevo].
create or replace function app_private.on_extension_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_e public.job_extensions;
  v_a public.assignments;
  v_bps integer;
  v_commission bigint;
begin
  if new.purpose <> 'EXTENSION' or new.status <> 'PAID' or old.status = 'PAID' then
    return new;
  end if;

  -- [Nuevo] Solo el cobro que llega a PAID desde un estado en vuelo suma. Un
  -- pago que vuelve a PAID al quitarle una revisión manual ya se sumó la
  -- primera vez: sumarlo de nuevo pagaría dos veces el mismo tiempo.
  if old.status not in ('PENDING', 'CREATED', 'AUTHORIZED') then
    return new;
  end if;

  select * into v_e from public.job_extensions where id = new.extension_id;
  if v_e.id is null or v_e.status <> 'ACCEPTED' then
    return new;
  end if;

  select * into v_a from public.assignments where id = new.assignment_id;
  if v_a.id is null or v_a.status in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER') then
    return new;
  end if;

  v_bps := app_private.commission_bps();
  v_commission := round(new.amount::numeric * v_bps / 10000.0);

  -- [Nuevo] Solo a un payout que todavía no se transfirió ni se canceló. La
  -- guarda de liquidación ya manda a revisión el cobro que llega tarde; esto
  -- es la segunda línea, por si algún día otro camino escribe PAID.
  update public.payouts
     set gross_amount = gross_amount + new.amount,
         commission_amount = commission_amount + v_commission,
         net_amount = net_amount + new.amount - v_commission,
         updated_at = now()
   where assignment_id = new.assignment_id
     and status in ('PENDING', 'APPROVED', 'HELD');

  -- [Nuevo] Sin suma no hay «se sumó»: se deja constancia para administración
  -- y no se le promete nada al trabajador.
  if not found then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
    values (null, 'extension_paid_without_open_payout', 'payments', new.id,
            jsonb_build_object('assignment_id', new.assignment_id,
                               'extension_id', new.extension_id,
                               'amount', new.amount,
                               'payout_status', (select status from public.payouts
                                                  where assignment_id = new.assignment_id)));
    return new;
  end if;

  perform app_private.timeline_event(
    new.job_id, new.assignment_id, v_a.client_id, 'SYSTEM',
    'Pago del tiempo adicional confirmado',
    v_e.additional_minutes::text || ' minutos adicionales pagados.',
    'extension_paid_' || v_e.id::text);

  perform app_private.notify_user(
    v_a.worker_id, 'JOB_PAID', 'El tiempo adicional quedó pagado',
    'Se sumó a lo que recibirás por este trabajo.',
    '/mis-trabajos/' || new.assignment_id, new.job_id);

  return new;
end;
$$;

comment on function app_private.on_extension_paid is
  'AFTER UPDATE de payments: suma el cobro adicional, la primera vez que llega a PAID desde un estado en vuelo, al payout de la asignación si sigue PENDING, APPROVED o HELD. Solo entonces avisa al trabajador.';

revoke all on function app_private.on_extension_paid() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. Arrancar el cobro adicional: no sobre un pago ya cerrado
-- -----------------------------------------------------------------------------
-- Idéntica a 20260401000100 salvo lo marcado [Nuevo].
create or replace function public.start_extension_payment(p_extension_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_e public.job_extensions;
  v_assignment_id uuid;
  v_payment public.payments;
  v_payout_status public.payout_status;
begin
  select assignment_id into v_assignment_id from public.job_extensions where id = p_extension_id;
  if v_assignment_id is null then
    raise exception 'La solicitud de tiempo adicional no existe' using errcode = 'no_data_found';
  end if;

  v_a := app_private.lock_assignment_for(v_assignment_id, 'client');
  select * into v_j from public.jobs where id = v_a.job_id;

  -- [Nuevo] Orden canónico: el pago antes que la extensión. Su identificador
  -- se lee sin bloqueo; con la asignación ya bloqueada, nadie puede cambiarlo
  -- (`answer_job_extension` pasa por el mismo cerrojo).
  select * into v_e from public.job_extensions where id = p_extension_id;
  if v_e.payment_id is not null then
    select * into v_payment from public.payments where id = v_e.payment_id for update;
  end if;
  select * into v_e from public.job_extensions where id = p_extension_id for update;

  if v_e.status <> 'ACCEPTED' then
    raise exception 'Esta solicitud no está aceptada' using errcode = 'check_violation';
  end if;
  if v_e.payment_id is null then
    raise exception 'La solicitud aceptada no tiene un cobro asociado' using errcode = 'check_violation';
  end if;

  -- [Nuevo] Y el payout, al final: es lo que dice si todavía hay dónde sumar.
  select status into v_payout_status
    from public.payouts where assignment_id = v_assignment_id
     for update;

  if v_payment.status = 'PAID' then
    return v_payment.id;
  end if;
  if v_payment.status = 'UNDER_REVIEW' then
    raise exception 'Este cobro adicional está en revisión' using errcode = 'check_violation';
  end if;

  -- [Nuevo] Con el pago al trabajador transferido, cancelado o decidido en una
  -- disputa, cobrar el tiempo adicional ya no llega a nadie: la guarda lo
  -- dejaría en revisión para devolverlo. Mejor no cobrarlo.
  if v_j.status = 'CLOSED'
     or v_payout_status is null
     or v_payout_status not in ('PENDING', 'APPROVED', 'HELD') then
    raise exception 'El pago de este trabajo ya se cerró: el tiempo adicional ya no se puede pagar desde aquí. Si crees que corresponde, escríbenos a soporte'
      using errcode = 'check_violation';
  end if;

  if v_payment.status = 'FAILED' then
    update public.payments set status = 'PENDING', updated_at = now() where id = v_payment.id;
  end if;

  return v_payment.id;
end;
$$;

grant execute on function public.start_extension_payment(uuid) to authenticated;
revoke execute on function public.start_extension_payment(uuid) from anon, public;

comment on function public.start_extension_payment is
  'La llama el cliente: devuelve el cobro del tiempo adicional aceptado, bajo el cerrojo trabajo → asignación → pago → extensión → payout. Se niega con el payout transferido o cancelado o el trabajo cerrado.';


-- -----------------------------------------------------------------------------
-- 4. Un payout transferido o cancelado no cambia de importes
-- -----------------------------------------------------------------------------
-- Idéntica a 20260301000400 salvo lo marcado [Nuevo], en la rama de UPDATE. Va
-- aquí y no en `guard_payout_transitions` porque esa sale en cuanto el estado
-- no cambia, y el defecto era justamente un UPDATE de importes sin cambio de
-- estado. Sin exención para el rol de servicio: es la red de un guion mal
-- escrito tanto como de una función.
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

    -- [Nuevo] Lo transferido es lo que movió el banco y lo cancelado ya no se
    -- paga: ninguno de los dos cambia de cifras. Si falta o sobra algo, es
    -- otra operación, con su propio rastro.
    if old.status in ('PAID', 'CANCELLED')
       and (new.gross_amount, new.commission_amount, new.discount_amount, new.bonus_amount,
            new.tax_withheld_amount, new.net_amount)
           is distinct from
           (old.gross_amount, old.commission_amount, old.discount_amount, old.bonus_amount,
            old.tax_withheld_amount, old.net_amount) then
      raise exception 'El pago al trabajador ya está % y sus importes no cambian. Lo que falte o sobre se resuelve aparte, con soporte',
        case old.status when 'PAID' then 'transferido' else 'cancelado' end
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

comment on function app_private.guard_payout is
  'BEFORE INSERT OR UPDATE de payouts: nace sobre un pago PAID de una asignación viva; no cambia de asignación, pago ni trabajador; transferido o cancelado, no cambia de importes. Sin exención para el rol de servicio.';

revoke all on function app_private.guard_payout() from public, anon, authenticated;
