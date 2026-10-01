-- =============================================================================
-- HagoTuFila · Una devolución no paga dos veces el mismo trabajo
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado al integrar las ramas de pagos y comprobado sobre la
-- base: 20260601000800 dejó dicho, del lado de la transferencia, que lo
-- devuelto al cliente, lo pedido y sin respuesta, lo que se le debe por una
-- disputa resuelta y lo que va al trabajador no pueden sumar más de lo que el
-- cliente pagó. Del lado de la devolución nadie lo miraba:
--
--   a. el trabajo termina, vence la ventana y administración registra la
--      transferencia: el payout queda PAID por $18.480 de un cobro de $21.000;
--   b. después, `request_payment_refund` acepta devolver los $21.000 enteros:
--      solo compara con el saldo del pago.
--
-- Resultado: el cliente con su dinero de vuelta y el trabajador ya pagado, las
-- dos cosas por el mismo trabajo y a cargo de la plataforma.
--
-- Y una variante silenciosa con el payout todavía sin transferir: una
-- devolución PARCIAL confirmada que deja las cifras sin cuadrar no movía el
-- payout. Seguía APPROVED, en la cola de transferencias, hasta que la barrera
-- de `mark_payout_paid` lo frenaba con un mensaje sobre cifras; nada antes le
-- decía a administración que ese payout ya no estaba listo.
--
-- Ahora:
--
--   · `request_payment_refund`, con el payout ya transferido (PAID, o
--     PROCESSING mientras se registra), solo acepta lo que queda de la
--     plataforma: lo cobrado menos lo devuelto, lo pedido sin respuesta, lo
--     debido por disputas y lo que se le pagó al trabajador. Más allá se niega
--     con las cifras y con cuánto se puede devolver todavía. Y bloquea en el
--     orden canónico (trabajo → asignación → pagos de la asignación), así que
--     una transferencia que se registra a la vez la espera o la ve.
--   · Con el payout sin transferir (PENDING, APPROVED, HELD) la devolución se
--     acepta como siempre: el dinero del trabajador todavía no salió y la
--     barrera de la transferencia lo frena. Pero si, CONFIRMADA, deja las
--     cifras sin cuadrar, el payout pasa a HELD con un motivo que lo explica,
--     en el mismo disparador que ya lo retenía cuando el pago se devolvía
--     entero o pasaba a revisión (20260501000400).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Cuánto se puede devolver con el trabajador ya pagado
-- -----------------------------------------------------------------------------
-- El mismo invariante de `payout_overrun`, medido ANTES de pedir: lo que
-- saldría con esta devolución no puede superar lo que entró.
--
--   · Entró: cada cobro de la asignación que llegó a cobrarse, también el que
--     está en revisión. Aquí no se trata de si se puede transferir —eso lo
--     decide la barrera—, sino de no devolver más de lo que hay; un cobro en
--     revisión es justamente dinero que entró y suele haber que devolver.
--   · Sale: lo devuelto, lo pedido y sin respuesta, lo debido por disputas
--     resueltas, esta devolución y lo que se le transfirió al trabajador (neto
--     más retención).
--   · Una devolución ligada a una disputa salda primero lo que esa disputa
--     debe: esa parte ya estaba contada como debida y no suma dos veces.
--
-- Devuelve el motivo para negarse, con las cifras, o NULL si cabe o si el
-- payout todavía no se transfirió.
create or replace function app_private.refund_after_payout_blocker(
  p_assignment_id uuid,
  p_amount        bigint,
  p_dispute_id    uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.payouts;
  v_paid bigint;
  v_refunded bigint;
  v_in_flight bigint;
  v_owed_others bigint;
  v_owed_this bigint;
  v_out bigint;
  v_room bigint;
  v_max bigint;
begin
  if p_assignment_id is null then
    return null;
  end if;

  select * into v_po from public.payouts where assignment_id = p_assignment_id;
  if v_po.id is null or v_po.status not in ('PAID', 'PROCESSING') then
    return null;
  end if;

  select coalesce(sum(p.amount) filter (
           where p.status in ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'UNDER_REVIEW')), 0),
         coalesce(sum(p.refunded_amount), 0)
    into v_paid, v_refunded
    from public.payments p
   where p.assignment_id = p_assignment_id;

  select coalesce(sum(r.amount), 0)
    into v_in_flight
    from public.payment_refunds r
    join public.payments p on p.id = r.payment_id
   where p.assignment_id = p_assignment_id
     and r.status not in ('CONFIRMED', 'FAILED', 'CANCELLED');

  select coalesce(sum(greatest(
           coalesce(d.refund_amount, 0) - coalesce((
             select sum(r.amount) from public.payment_refunds r
              where r.dispute_id = d.id and r.status not in ('FAILED', 'CANCELLED')), 0),
           0)) filter (where d.id is distinct from p_dispute_id), 0),
         coalesce(sum(greatest(
           coalesce(d.refund_amount, 0) - coalesce((
             select sum(r.amount) from public.payment_refunds r
              where r.dispute_id = d.id and r.status not in ('FAILED', 'CANCELLED')), 0),
           0)) filter (where d.id = p_dispute_id), 0)
    into v_owed_others, v_owed_this
    from public.disputes d
   where d.assignment_id = p_assignment_id and d.status = 'RESOLVED';

  v_out := v_po.net_amount + v_po.tax_withheld_amount;

  -- Con esta devolución: R + F + x + O + máx(T − x, 0) + W ≤ cobrado. Si x no
  -- pasa de lo que debe su disputa (T), no cambia nada y vale si ya cuadraba;
  -- si pasa, vale mientras x ≤ cobrado − (R + F + O + W).
  v_room := v_paid - (v_refunded + v_in_flight + v_owed_others + v_out);
  v_max := case when v_room >= v_owed_this then greatest(v_room, 0) else 0 end;

  if p_amount <= v_max then
    return null;
  end if;

  return 'Al trabajador ya se le pagaron ' || app_private.format_clp(v_out)
    || ' por este trabajo y el cliente pagó ' || app_private.format_clp(v_paid)
    || case when v_refunded + v_in_flight > 0
            then '; ya se le devolvió o está en devolución '
                 || app_private.format_clp(v_refunded + v_in_flight)
            else '' end
    || case when v_owed_others + v_owed_this > 0
            then '; se le deben ' || app_private.format_clp(v_owed_others + v_owed_this)
                 || ' por una disputa resuelta'
            else '' end
    || '. '
    || case when v_max > 0
            then 'Solo se pueden devolver ' || app_private.format_clp(v_max)
                 || ' más, lo que queda de la plataforma'
            else 'Ya no queda nada que se pueda devolver sin poner dinero de la plataforma' end
    || ' (pediste ' || app_private.format_clp(p_amount) || '). Devolver más sería pagar dos '
    || 'veces el mismo trabajo: al cliente y al trabajador. Si de verdad corresponde, es un caso '
    || 'para soporte';
end;
$$;

comment on function app_private.refund_after_payout_blocker is
  'Con el payout de la asignación transferido (PAID o PROCESSING): motivo, con cifras, si devolver p_amount haría que lo devuelto, lo pedido, lo debido por disputas y lo pagado al trabajador superen lo cobrado; NULL si cabe o si el payout no se transfirió.';

revoke all on function app_private.refund_after_payout_blocker(uuid, bigint, uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. Pedir la devolución
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000910 salvo dos cosas, marcadas abajo: los cerrojos en el
-- orden canónico y, con el payout transferido, lo que queda de la plataforma.
create or replace function public.request_payment_refund(
  p_payment_id       uuid,
  p_amount           bigint,
  p_reason           text,
  p_provider_event_id text,
  p_dispute_id       uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_dispute public.disputes;
  v_existing public.payment_refunds;
  v_open public.payment_refunds;
  v_committed bigint;
  v_refund_id uuid;
  v_job_id uuid;
  v_assignment_id uuid;
  v_blocker text;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración puede iniciar una devolución'
      using errcode = 'insufficient_privilege';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe a devolver debe ser positivo'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'Escribe el motivo de la devolución (al menos 10 caracteres)'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_provider_event_id is null or length(btrim(p_provider_event_id)) = 0 then
    raise exception 'Falta la clave de idempotencia de la devolución'
      using errcode = 'invalid_parameter_value';
  end if;

  -- [Nuevo] Orden canónico: trabajo → asignación → TODOS los pagos de la
  -- asignación. Es el de `mark_payout_paid`: una transferencia que se registra
  -- a la vez espera a esta petición (y verá la devolución en vuelo) o esta la
  -- espera a ella (y verá el payout transferido). Y dos devoluciones sobre
  -- pagos distintos de la misma asignación —el del trabajo y el del tiempo
  -- adicional— no miden a la vez lo que queda de la plataforma.
  select job_id, assignment_id into v_job_id, v_assignment_id
    from public.payments where id = p_payment_id;
  if v_job_id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  perform 1 from public.jobs where id = v_job_id for update;
  if v_assignment_id is not null then
    perform 1 from public.assignments where id = v_assignment_id for update;
    perform 1 from public.payments where assignment_id = v_assignment_id order by id for update;
  end if;
  select * into v_payment from public.payments where id = p_payment_id for update;

  -- Idempotencia, ANTES que cualquier otra regla: la misma petición repetida
  -- devuelve la misma fila, esté en curso, por confirmar, confirmada o
  -- fallida.
  select * into v_existing
    from public.payment_refunds
   where provider = v_payment.provider and provider_event_id = p_provider_event_id;
  if v_existing.id is not null then
    if v_existing.payment_id <> p_payment_id
       or (v_existing.status <> 'CONFIRMED' and v_existing.amount <> p_amount) then
      raise exception 'Esa clave de idempotencia ya se usó para otra devolución'
        using errcode = 'check_violation';
    end if;
    return v_existing.id;
  end if;

  -- Solo se devuelve dinero que se cobró. `UNDER_REVIEW` entra porque es
  -- justamente el estado de «se cobró y no debía».
  if v_payment.status not in ('PAID', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED') then
    raise exception 'El pago está en % y no admite devolución', v_payment.status
      using errcode = 'check_violation';
  end if;

  if v_payment.provider_token is null then
    raise exception 'El pago no tiene token del proveedor: no se puede devolver'
      using errcode = 'check_violation';
  end if;

  select * into v_open
    from public.payment_refunds
   where payment_id = p_payment_id and status in ('REQUESTED', 'UNKNOWN')
   order by requested_at desc
   limit 1;

  select coalesce(sum(amount), 0) into v_committed
    from public.payment_refunds
   where payment_id = p_payment_id and status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED');

  if v_committed + p_amount > v_payment.amount then
    raise exception 'La devolución excede el saldo: cobrado %, comprometido %, pedido %',
      v_payment.amount, v_committed,
      p_amount::text || case when v_open.id is null then ''
                             else ' (hay una devolución sin resultado final sobre este pago)' end
      using errcode = 'check_violation';
  end if;

  if v_open.id is not null then
    if v_open.status = 'UNKNOWN' then
      raise exception 'Hay una devolución de este pago con resultado por confirmar: hasta saber si el banco la hizo no se puede pedir otra'
        using errcode = 'check_violation';
    end if;
    raise exception 'Hay una devolución de este pago en curso: espera su resultado antes de pedir otra'
      using errcode = 'check_violation';
  end if;

  if p_dispute_id is not null then
    select * into v_dispute from public.disputes where id = p_dispute_id;
    if v_dispute.id is null then
      raise exception 'La disputa no existe' using errcode = 'no_data_found';
    end if;
    if v_dispute.status <> 'RESOLVED' then
      raise exception 'La disputa está en % y no permite devolver todavía', v_dispute.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- [Nuevo] Con el trabajador ya pagado, solo lo que queda de la plataforma.
  v_blocker := app_private.refund_after_payout_blocker(v_assignment_id, p_amount, p_dispute_id);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'check_violation';
  end if;

  insert into public.payment_refunds (
    payment_id, dispute_id, amount, currency, reason, status,
    provider, environment, provider_event_id, requested_by
  ) values (
    p_payment_id, p_dispute_id, p_amount, v_payment.currency, btrim(p_reason), 'REQUESTED',
    v_payment.provider, coalesce(v_payment.environment, 'mock'), p_provider_event_id, auth.uid()
  )
  returning id into v_refund_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (auth.uid(), 'payment_refund_requested', 'payments', p_payment_id,
          jsonb_build_object('refund_id', v_refund_id, 'amount', p_amount,
                             'dispute_id', p_dispute_id, 'reason', btrim(p_reason)));

  return v_refund_id;
end;
$$;

revoke execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) from public;
revoke execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) from anon;
grant execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) to authenticated;

comment on function public.request_payment_refund is
  'Deja pedida una devolución. Solo administración. Idempotente por petición; una sola abierta por pago; con el payout transferido, no más de lo que queda de la plataforma. No devuelve dinero: eso lo hace el proveedor y lo cierra settle_payment_refund.';


-- -----------------------------------------------------------------------------
-- 3. Retener el payout cuando una devolución deja las cifras sin cuadrar
-- -----------------------------------------------------------------------------
-- Idéntica a 20260501000400 en lo que ya hacía —retener cuando el pago del
-- trabajo pasa a revisión, falla o se devuelve entero— y una regla más, en el
-- mismo sitio para no tener dos disparadores que decidan sobre lo mismo:
--
--   · cuando sube lo devuelto de CUALQUIER cobro de la asignación (el del
--     trabajo o uno del tiempo adicional), es decir, cuando una devolución se
--     CONFIRMA, se vuelven a medir las cifras con `payout_overrun`. Si ya no
--     cuadran, el payout pagable (PENDING, APPROVED, PROCESSING) pasa a HELD
--     con el motivo y los números.
--
-- Una devolución pedida y sin respuesta no retiene: puede fallar, y mientras
-- tanto la transferencia ya se niega por ella (`refund_in_flight_blocker`). Un
-- payout transferido no se toca: el dinero salió, y para eso está la regla del
-- lado de la devolución.
create or replace function app_private.hold_payout_on_unhealthy_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
  v_overrun text;
begin
  if new.status is distinct from old.status
     and new.status in ('UNDER_REVIEW', 'FAILED', 'REFUNDED') then
    v_reason := case new.status
      when 'UNDER_REVIEW' then
        'El pago del cliente está en revisión' ||
        coalesce(': ' || nullif(new.review_reason, ''), '')
      when 'FAILED' then 'El pago del cliente no se completó'
      else 'El cliente recibió la devolución total de este trabajo'
    end;

    update public.payouts
       set status      = 'HELD',
           held_reason = v_reason,
           updated_at  = now()
     where payment_id = new.id
       and status in ('PENDING', 'APPROVED', 'PROCESSING');

    if found then
      insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
      select null, 'payout_held_unhealthy_payment', 'payouts', po.id,
             jsonb_build_object('payment_id', new.id, 'payment_status', new.status,
                                'reason', v_reason)
        from public.payouts po
       where po.payment_id = new.id and po.status = 'HELD';
    end if;
  end if;

  -- [Nuevo] Una devolución confirmada que deja las cifras sin cuadrar. La
  -- fila de la devolución ya está CONFIRMED cuando `settle_payment_refund`
  -- escribe el pago, así que `payout_overrun` la cuenta como devuelta y no
  -- como en vuelo.
  if new.refunded_amount > old.refunded_amount and new.assignment_id is not null then
    v_overrun := app_private.payout_overrun(new.assignment_id);
    if v_overrun is not null then
      v_reason := 'Se devolvieron ' || app_private.format_clp(new.refunded_amount - old.refunded_amount)
        || ' al cliente y las cifras de este trabajo ya no cuadran: ' || v_overrun
        || '. No se transfiere así: revisa con soporte cuánto le corresponde al trabajador';

      update public.payouts
         set status      = 'HELD',
             held_reason = v_reason,
             updated_at  = now()
       where assignment_id = new.assignment_id
         and status in ('PENDING', 'APPROVED', 'PROCESSING');

      if found then
        insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
        select null, 'payout_held_refund_overrun', 'payouts', po.id,
               jsonb_build_object('payment_id', new.id,
                                  'refunded_amount', new.refunded_amount,
                                  'reason', v_reason)
          from public.payouts po
         where po.assignment_id = new.assignment_id and po.status = 'HELD';
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function app_private.hold_payout_on_unhealthy_payment is
  'Retiene el pago al trabajador cuando el pago del cliente pasa a revisión, falla o se devuelve entero, y cuando una devolución confirmada deja las cifras de la asignación sin cuadrar. No lo cancela.';

revoke all on function app_private.hold_payout_on_unhealthy_payment() from public, anon, authenticated;
