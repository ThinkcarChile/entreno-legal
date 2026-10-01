-- =============================================================================
-- HagoTuFila · Lo que se decide sobre el pago al trabajador, y lo que se le
-- debe al cliente por una disputa, cuadra con lo que de verdad se cobró
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTOS, encontrados por la revisión cruzada y reproducidos sobre la base:
--
-- 1. Una disputa ganada por el cliente no cubría el tiempo adicional.
--    `resolve_dispute` CLIENT_WINS cancela el payout entero —que incluye el
--    neto del tiempo adicional—, pero `default_client_wins_refund`
--    (20260601000300) anotaba solo el saldo del pago del TRABAJO, y un importe
--    explícito mayor que ese pago se rechazaba («supera lo cobrado»). La cola
--    ponía la disputa solo en el pago del trabajo. Trabajo de $21.000 más
--    $9.000 de tiempo adicional, el cliente gana: se le devolvían $21.000 y los
--    $9.000 se quedaban en la plataforma sin que ninguna pantalla lo mostrara.
--
-- 2. Cualquier devolución se podía ligar a cualquier disputa. El panel mandaba
--    el id de la disputa de la asignación en TODAS las tarjetas de sus pagos
--    (la vista lo toma con un `limit 1` por asignación), y
--    `request_payment_refund` solo miraba que la disputa estuviera RESUELTA: ni
--    que fuera de la misma asignación, ni que se le debiera algo, ni que el
--    pago fuera el que esa disputa devuelve, ni el importe. Devolver desde su
--    tarjeta el tiempo adicional gastaba el saldo de la disputa sobre el pago
--    del trabajo: el cliente que ganó recibía menos y la cola quedaba vacía.
--    Y con la disputa abierta, el panel no podía devolver NINGÚN pago de esa
--    asignación («La disputa está en OPEN y no permite devolver todavía»).
--
-- 3. Con una devolución en vuelo al resolver, el saldo por omisión de
--    CLIENT_WINS no la descontaba; cuando se confirmaba, el pago ya no podía
--    cubrir lo anotado y la cola mostraba para siempre «Devolución de una
--    disputa sin pedir» sobre un pago ya devuelto entero.
--
-- 4. Un bono que el cliente niega se pagaba igual si el payout no estaba en
--    PENDING al aprobar (retenido por administración o por un cobro en duda,
--    o aprobado antes de tiempo): `approve_completion_core` solo lo descontaba
--    en PENDING, devolvía `payout_status = 'APPROVED'` aunque quedara HELD, y
--    ni `approve_payout` ni la transferencia miraban `bonus_awarded`.
--
-- 5. Un payout retenido porque «las cifras no cuadran» no tenía salida: ninguna
--    función bajaba su neto (solo `resolve_dispute` PARCIAL, que no sirve fuera
--    de la ventana ni cuadra dentro), y `approve_payout` lo volvía a APPROVED
--    sin mirar las cifras, para que la transferencia lo frenara otra vez. Lo
--    mismo con un payout HELD tras una devolución total fuera de una disputa:
--    nada lo cancelaba. Hacía falta escribir SQL a mano.
--
-- Qué cambia:
--
--   · `app_private.dispute_refund_allocation`: lo que una disputa resuelta
--     todavía debe (su `refund_amount` menos las devoluciones ligadas a ella
--     pedidas, por confirmar o confirmadas) se reparte entre los cobros de su
--     asignación —primero el del trabajo, después el tiempo adicional, cada uno
--     hasta lo que le queda por devolver—. Es la única definición: la usan la
--     cola, `request_payment_refund` y el panel.
--   · CLIENT_WINS sin importe anota todo lo que queda por devolver de TODOS los
--     cobros de la asignación, descontando también lo pedido y sin respuesta.
--     Un importe explícito se mide contra lo cobrado en la asignación (trabajo
--     más tiempo adicional) y contra lo que todavía se puede devolver.
--   · La cola muestra cada cobro con su parte de la disputa, nunca más de lo
--     que ese cobro puede devolver: no quedan entradas fantasma.
--   · `request_payment_refund`, ligada a una disputa, exige que sea de la misma
--     asignación, que esté resuelta y deba algo, que el pago tenga parte de esa
--     deuda y que el importe no la pase. Sin ligar, no se come la parte
--     reservada para una disputa.
--   · El bono negado sale del payout en PENDING, APPROVED o HELD; la
--     aprobación devuelve el estado real; `approve_payout` lo descuenta si aún
--     estuviera, y la transferencia se niega si el payout todavía lo incluye.
--   · `public.adjust_payout`: administración BAJA el neto de un payout que no
--     se transfirió, o lo cancela con $0, con motivo escrito, auditoría, línea
--     de tiempo y aviso al trabajador. Con una disputa abierta también baja
--     (no cancela): es lo que deja resolverla cuando las cifras ya no
--     cuadraban. `approve_payout` ya no aprueba un payout con una devolución
--     sin respuesta o con cifras que no cuadran: primero se ajusta.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Lo comprometido de un cobro y el reparto de lo que debe una disputa
-- -----------------------------------------------------------------------------

-- Lo que ya salió o puede haber salido de un cobro: devoluciones pedidas, por
-- confirmar o confirmadas. Es lo que `request_payment_refund` mira para no
-- pasarse del cobro (20260601000910).
create or replace function app_private.payment_refund_committed(p_payment_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(r.amount), 0)::bigint
    from public.payment_refunds r
   where r.payment_id = p_payment_id
     and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')
$$;

comment on function app_private.payment_refund_committed is
  'Suma de las devoluciones pedidas, por confirmar o confirmadas de un cobro.';

-- Qué parte de lo que debe cada disputa resuelta va sobre cada cobro.
--
--   · Debe: su `refund_amount` menos las devoluciones LIGADAS a ella pedidas,
--     por confirmar o confirmadas. Una pedida deja de contar como deuda y pasa
--     a ser una devolución abierta, como en 20260601001510.
--   · Se reparte entre los cobros de la asignación que todavía admiten una
--     devolución (PAID, PARTIALLY_REFUNDED, UNDER_REVIEW): primero el del
--     trabajo, después los del tiempo adicional por orden de creación; cada uno
--     hasta lo que le queda (lo cobrado menos lo comprometido, ligado o no).
--   · Lo que no cabe en ningún cobro no se muestra: ya no queda nada que
--     devolver, y una entrada así no se podría despachar nunca.
--
-- Con `p_assignment_id` nulo recorre todas las asignaciones con una disputa
-- que todavía debe algo; es lo que lee la cola.
create or replace function app_private.dispute_refund_allocation(p_assignment_id uuid default null)
returns table (
  dispute_id    uuid,
  assignment_id uuid,
  payment_id    uuid,
  pending       bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_assignment uuid;
  v_dispute record;
  v_ids uuid[];
  v_room bigint[];
  v_left bigint;
  v_take bigint;
  v_i integer;
begin
  for v_assignment in
    select distinct d.assignment_id
      from public.disputes d
     where d.status = 'RESOLVED'
       and coalesce(d.refund_amount, 0) > 0
       and (p_assignment_id is null or d.assignment_id = p_assignment_id)
       and d.refund_amount > coalesce((
             select sum(r.amount) from public.payment_refunds r
              where r.dispute_id = d.id and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')), 0)
  loop
    select coalesce(array_agg(x.id order by x.is_job desc, x.created_at, x.id), '{}'),
           coalesce(array_agg(x.room order by x.is_job desc, x.created_at, x.id), '{}')
      into v_ids, v_room
      from (select p.id, p.created_at, (p.purpose = 'JOB') as is_job,
                   greatest(p.amount - app_private.payment_refund_committed(p.id), 0) as room
              from public.payments p
             where p.assignment_id = v_assignment
               and p.status in ('PAID', 'PARTIALLY_REFUNDED', 'UNDER_REVIEW')) x;

    for v_dispute in
      select d.id,
             d.refund_amount - coalesce((
               select sum(r.amount) from public.payment_refunds r
                where r.dispute_id = d.id and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')), 0) as owed
        from public.disputes d
       where d.assignment_id = v_assignment
         and d.status = 'RESOLVED'
         and coalesce(d.refund_amount, 0) > 0
       order by d.created_at, d.id
    loop
      v_left := v_dispute.owed;
      v_i := 1;
      while v_left > 0 and v_i <= coalesce(array_length(v_ids, 1), 0) loop
        v_take := least(v_room[v_i], v_left);
        if v_take > 0 then
          dispute_id := v_dispute.id;
          assignment_id := v_assignment;
          payment_id := v_ids[v_i];
          pending := v_take;
          return next;
          v_room[v_i] := v_room[v_i] - v_take;
          v_left := v_left - v_take;
        end if;
        v_i := v_i + 1;
      end loop;
    end loop;
  end loop;
end;
$$;

comment on function app_private.dispute_refund_allocation is
  'Reparto de lo que cada disputa resuelta todavía debe al cliente entre los cobros de su asignación (trabajo primero, después tiempo adicional), cada uno hasta lo que le queda por devolver. Una fila por disputa y cobro con parte.';


-- -----------------------------------------------------------------------------
-- 2. CLIENT_WINS sin importe: todo lo que queda por devolver
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000300 salvo qué se suma: antes, el saldo del último pago
-- del trabajo (lo cobrado menos lo CONFIRMADO). Ahora, cada cobro de la
-- asignación que todavía admite devolución —el trabajo y el tiempo adicional,
-- que el payout cancelado también incluía—, menos lo pedido, por confirmar o
-- confirmado. Lo que está en vuelo ya va camino del cliente: contarlo otra vez
-- dejaba una deuda que, al confirmarse, ningún cobro podía pagar.
create or replace function app_private.default_client_wins_refund()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refundable bigint;
begin
  if new.status = 'RESOLVED'
     and new.resolution = 'CLIENT_WINS'
     and new.refund_amount is null
     and (old.status is distinct from 'RESOLVED') then
    select coalesce(sum(greatest(p.amount - app_private.payment_refund_committed(p.id), 0)), 0)
      into v_refundable
      from public.payments p
     where p.assignment_id = new.assignment_id
       and p.status in ('PAID', 'PARTIALLY_REFUNDED', 'UNDER_REVIEW');

    new.refund_amount := v_refundable;
  end if;
  return new;
end;
$$;

comment on function app_private.default_client_wins_refund is
  'Con CLIENT_WINS sin importe, la devolución pendiente es lo que queda por devolver de todos los cobros de la asignación (trabajo y tiempo adicional), descontando lo pedido o por confirmar.';


-- -----------------------------------------------------------------------------
-- 3. Resolver una disputa con importes que caben en lo cobrado
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000800 salvo lo marcado [Nuevo]:
--
--   · el importe explícito se mide contra lo cobrado en la ASIGNACIÓN (trabajo
--     más tiempo adicional), no contra el último pago del trabajo; y contra lo
--     que todavía se puede devolver, para no anotar una deuda que ningún cobro
--     pueda pagar;
--   · el payout se bloquea antes que la disputa (orden canónico: pagos →
--     payouts → disputas);
--   · `refund_registered` devuelve lo que quedó anotado, también el importe
--     por omisión de CLIENT_WINS;
--   · si la resolución no cuadra, el motivo apunta también a «Ajustar» (solo
--     cambia el texto, después del prefijo de siempre).
create or replace function public.resolve_dispute(
  p_dispute_id      uuid,
  p_resolution      public.dispute_resolution,
  p_notes           text,
  p_refund_amount   bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d public.disputes;
  v_a public.assignments;
  v_j public.jobs;
  v_payout public.payouts;
  v_job_payment public.payments;
  v_payout_status public.payout_status;
  v_assignment_id uuid;
  v_net bigint;
  v_pays_worker boolean;
  v_held_reason text;
  v_overrun text;
  v_captured bigint;
  v_refundable bigint;
  v_registered bigint;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración resuelve una disputa'
      using errcode = 'insufficient_privilege';
  end if;

  if p_resolution is null then
    raise exception 'Hay que indicar el resultado' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(coalesce(trim(p_notes), '')) < 10 then
    raise exception 'La resolución necesita un motivo escrito' using errcode = 'check_violation';
  end if;

  select assignment_id into v_assignment_id from public.disputes where id = p_dispute_id;
  if v_assignment_id is null then
    raise exception 'La disputa no existe' using errcode = 'no_data_found';
  end if;

  -- Orden canónico de bloqueo: jobs → assignments → payments → payouts →
  -- disputes. Se bloquean todos los pagos de la asignación, no solo el del
  -- trabajo: las cifras de abajo los suman todos.
  select j.* into v_j
    from public.assignments a join public.jobs j on j.id = a.job_id
   where a.id = v_assignment_id
     for update of j;
  select * into v_a from public.assignments where id = v_assignment_id for update;
  perform 1 from public.payments where assignment_id = v_assignment_id order by id for update;
  -- [Nuevo] El payout antes que la disputa.
  select * into v_payout from public.payouts where assignment_id = v_assignment_id for update;
  select * into v_d from public.disputes where id = p_dispute_id for update;

  if v_d.status = 'RESOLVED' then
    raise exception 'Esta disputa ya está resuelta' using errcode = 'check_violation';
  end if;
  if v_d.status = 'WITHDRAWN' then
    raise exception 'Esta disputa fue retirada' using errcode = 'check_violation';
  end if;

  -- [Nuevo] Lo cobrado en la asignación y lo que todavía se puede devolver.
  select coalesce(sum(p.amount) filter (
           where p.status in ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'UNDER_REVIEW')), 0),
         coalesce(sum(greatest(p.amount - app_private.payment_refund_committed(p.id), 0)) filter (
           where p.status in ('PAID', 'PARTIALLY_REFUNDED', 'UNDER_REVIEW')), 0)
    into v_captured, v_refundable
    from public.payments p
   where p.assignment_id = v_assignment_id;

  if p_refund_amount is not null then
    if p_refund_amount < 0 then
      raise exception 'El monto a devolver no puede ser negativo' using errcode = 'check_violation';
    end if;
    if p_refund_amount > v_captured then
      raise exception 'El monto a devolver supera lo cobrado en este trabajo (%, contando el tiempo adicional)',
        app_private.format_clp(v_captured)
        using errcode = 'check_violation';
    end if;
  end if;

  -- Sobre un cobro devuelto entero no queda nada que pagarle al trabajador:
  -- ni todo ni una parte.
  v_pays_worker := p_resolution in ('WORKER_WINS', 'PARTIAL');
  v_job_payment := app_private.payout_job_payment(v_assignment_id);

  if v_pays_worker and v_job_payment.status = 'REFUNDED' then
    raise exception 'El cliente ya recibió la devolución total de este trabajo (%): no se puede resolver a favor del trabajador ni repartir. Resuélvela a favor del cliente',
      app_private.format_clp(v_job_payment.refunded_amount)
      using errcode = 'check_violation';
  end if;

  -- [Nuevo] Una deuda que ningún cobro pueda pagar quedaría pendiente para
  -- siempre. Se mira después de la regla anterior, que explica mejor el caso
  -- del cobro devuelto entero.
  if p_refund_amount > v_refundable then
    raise exception 'El monto a devolver supera lo que todavía se puede devolver: de los % cobrados en este trabajo ya se devolvieron o están en devolución %, y quedan %',
      app_private.format_clp(v_captured),
      app_private.format_clp(v_captured - v_refundable),
      app_private.format_clp(v_refundable)
      using errcode = 'check_violation';
  end if;

  update public.disputes
     set status = 'RESOLVED',
         resolution = p_resolution,
         resolution_notes = trim(p_notes),
         refund_amount = p_refund_amount,
         resolved_by = auth.uid(),
         resolved_at = now(),
         updated_at = now()
   where id = p_dispute_id
  returning refund_amount into v_registered;

  -- El payout retenido se libera, se recorta o se cancela según el resultado.
  if v_payout.id is not null then
    if p_resolution = 'WORKER_WINS' then
      v_payout_status := 'APPROVED';
      v_net := v_payout.net_amount;
    elsif p_resolution = 'CLIENT_WINS' then
      v_payout_status := 'CANCELLED';
      v_net := 0;
    else
      -- Parcial: lo que se devuelve al cliente sale de lo que iba al trabajador,
      -- nunca por debajo de cero.
      v_payout_status := 'APPROVED';
      v_net := greatest(v_payout.net_amount - coalesce(p_refund_amount, 0), 0);
    end if;

    -- La decisión se registra, pero un cobro en duda no libera nada: el payout
    -- sigue retenido hasta que `approve_payout` lo encuentre sano.
    if v_payout_status = 'APPROVED' then
      if app_private.job_payment_blocker(v_job_payment) is not null then
        v_held_reason := 'Disputa resuelta; el pago del cliente está '
          || case when v_job_payment.status = 'UNDER_REVIEW' then 'en revisión'
                  else 'en ' || coalesce(v_job_payment.status::text, 'un estado desconocido') end;
      elsif app_private.refund_in_flight_blocker(v_assignment_id) is not null then
        v_held_reason := 'Disputa resuelta; hay una devolución al cliente sin respuesta del banco';
      end if;
      if v_held_reason is not null then
        v_payout_status := 'HELD';
      end if;
    end if;

    update public.payouts
       set status = v_payout_status,
           net_amount = v_net,
           held_reason = case when v_payout_status = 'CANCELLED'
                                then 'Disputa resuelta a favor del cliente'
                              when v_payout_status = 'HELD'
                                then v_held_reason end,
           notes = trim(p_notes),
           approved_by = case when v_payout_status = 'APPROVED' then auth.uid() end,
           approved_at = case when v_payout_status = 'APPROVED' then now() end,
           updated_at = now()
     where id = v_payout.id;

    -- Con todo escrito, las cifras del payout que queda liberado. Lo devuelto,
    -- lo pedido, lo que se debe por esta y otras disputas y lo que irá al
    -- trabajador no pueden superar lo que el cliente pagó. Uno retenido no se
    -- mide aquí: no sale de la retención sin `approve_payout`, y la
    -- transferencia vuelve a medirlo todo.
    -- [Nuevo, solo el texto] Si las cifras ya no cuadraban antes de resolver
    -- (una devolución previa), ninguna resolución que le pague algo al
    -- trabajador cuadra: la parcial resta del neto lo mismo que anota como
    -- deuda. La salida es bajar antes el neto con «Ajustar», que se puede con
    -- la disputa abierta.
    if v_payout_status = 'APPROVED' then
      v_overrun := app_private.payout_overrun(v_assignment_id);
      if v_overrun is not null then
        raise exception 'Esta resolución no cuadra: %. Elige otra —a favor del cliente, o parcial descontando del trabajador lo que se devuelve—; si ya no cuadraba antes de resolver (por una devolución previa), baja primero el neto del trabajador con «Ajustar» en /admin/payouts, o revisa el caso con soporte',
          v_overrun
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- Lo que corresponde devolver queda anotado en la disputa (`refund_amount`),
  -- no en el estado del pago: el dinero SÍ se cobró. La devolución la ejecuta
  -- una persona desde /admin/pagos.

  -- El trabajo sale de DISPUTED hacia un estado definitivo.
  if v_j.status = 'DISPUTED' then
    update public.jobs set status = 'CLOSED', updated_at = now() where id = v_j.id;
  end if;

  perform app_private.timeline_event(
    v_j.id, v_a.id, auth.uid(), 'SYSTEM',
    'Disputa resuelta',
    trim(p_notes),
    'dispute_resolved_' || p_dispute_id::text);

  perform app_private.notify_user(
    v_a.client_id, 'DISPUTE_RESOLVED', 'La disputa se resolvió',
    trim(p_notes), '/mis-trabajos/' || v_a.id, v_j.id);
  perform app_private.notify_user(
    v_a.worker_id, 'DISPUTE_RESOLVED', 'La disputa se resolvió',
    trim(p_notes), '/mis-trabajos/' || v_a.id, v_j.id);

  return jsonb_build_object(
    'dispute_status', 'RESOLVED',
    'resolution', p_resolution,
    'payout_status', v_payout_status,
    -- [Nuevo] Lo anotado, también el importe por omisión de CLIENT_WINS.
    'refund_registered', coalesce(v_registered, 0)
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. La cola: cada cobro con su parte de la disputa
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001510 salvo de dónde sale la disputa: antes, la deuda
-- entera de la disputa en el pago del TRABAJO, midiera lo que midiera ese pago
-- (una disputa de $30.000 sobre un cobro de $21.000; o $5.000 sobre un cobro
-- ya devuelto entero, para siempre). Ahora, `dispute_refund_allocation`: cada
-- cobro con la parte que de verdad puede devolver. `dispute_id` es la disputa
-- a la que se liga la devolución de ESE cobro; el panel la manda solo ahí.
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
  with disputa_por_pago as (
    select x.payment_id,
           sum(x.pending)::bigint                                  as pending,
           (array_agg(x.dispute_id order by d.created_at, d.id))[1] as dispute_id
      from app_private.dispute_refund_allocation(null) x
      join public.disputes d on d.id = x.dispute_id
     group by x.payment_id
  )
  -- Los motivos del pago, de la vista del panel: los mismos campos que
  -- muestra cada tarjeta de /admin/pagos. La vista es `security_invoker`;
  -- aquí la lee el dueño de la función.
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

comment on function app_private.payment_review_queue is
  'Pagos que esperan a una persona, uno por fila: en revisión, con devolución abierta, con intentos en revisión o con su parte de la devolución de una disputa sin pedir (dispute_refund_allocation). Los motivos del pago salen de la vista admin_payments, la misma de /admin/pagos. La usan admin_pending_reviews y admin_payment_review_queue.';


-- -----------------------------------------------------------------------------
-- 5. Pedir una devolución: ligada a una disputa, solo lo que esa disputa debe
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001400 salvo lo marcado [Nuevo], en el mismo sitio en que
-- ya se miraba la disputa:
--
--   · ligada a una disputa: de la misma asignación que el pago, resuelta, con
--     algo por pedir, con parte de esa deuda sobre ESTE pago, y sin pasarla;
--   · sin ligar: no se come lo que este pago tiene reservado para una disputa.
--     Si no, el cliente recibiría el dinero por otro concepto y la disputa
--     seguiría pidiéndolo a un cobro que ya no lo tiene.
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
  v_owed_total bigint;
  v_owed_here bigint;
  v_reserved bigint;
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

  -- Orden canónico: trabajo → asignación → TODOS los pagos de la asignación.
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
    -- [Nuevo] La disputa es de este trabajo.
    if v_dispute.assignment_id is distinct from v_assignment_id then
      raise exception 'Esa disputa es de otro trabajo: esta devolución no se puede ligar a ella'
        using errcode = 'check_violation';
    end if;
    if v_dispute.status <> 'RESOLVED' then
      raise exception 'La disputa está en % y no permite devolver todavía', v_dispute.status
        using errcode = 'check_violation';
    end if;

    -- [Nuevo] Lo que la disputa todavía debe, y la parte que va sobre este pago.
    select coalesce(sum(x.pending), 0),
           coalesce(sum(x.pending) filter (where x.payment_id = p_payment_id), 0)
      into v_owed_total, v_owed_here
      from app_private.dispute_refund_allocation(v_assignment_id) x
     where x.dispute_id = p_dispute_id;

    if v_owed_total = 0 then
      raise exception 'La disputa no tiene ninguna devolución por pedir: lo que resolvió ya se devolvió o está en devolución. Si corresponde devolver algo más, pídelo sin ligarlo a la disputa'
        using errcode = 'check_violation';
    end if;
    if v_owed_here = 0 then
      raise exception 'La devolución de esta disputa (%) no va sobre este pago: pídela sobre el cobro que la muestra en /admin/pagos («Devolución de una disputa sin pedir»), o pide esta sin ligarla a la disputa',
        app_private.format_clp(v_owed_total)
        using errcode = 'check_violation';
    end if;
    if p_amount > v_owed_here then
      raise exception 'De este pago, la disputa debe % (pediste %). Pide ese importe ligado a la disputa; si además corresponde devolver más, pídelo después, sin ligarlo',
        app_private.format_clp(v_owed_here), app_private.format_clp(p_amount)
        using errcode = 'check_violation';
    end if;
  elsif v_assignment_id is not null then
    -- [Nuevo] Sin ligar, no se toca lo reservado para una disputa.
    select coalesce(sum(x.pending), 0)
      into v_reserved
      from app_private.dispute_refund_allocation(v_assignment_id) x
     where x.payment_id = p_payment_id;

    if v_reserved > 0 and v_committed + p_amount > v_payment.amount - v_reserved then
      raise exception 'De este pago, % son la devolución de una disputa resuelta y se piden ligados a ella (en /admin/pagos, «Devolver» en esta tarjeta ya la liga). Sin ligar se pueden devolver a lo sumo % (pediste %)',
        app_private.format_clp(v_reserved),
        app_private.format_clp(greatest(v_payment.amount - v_reserved - v_committed, 0)),
        app_private.format_clp(p_amount)
        using errcode = 'check_violation';
    end if;
  end if;

  -- Con el trabajador ya pagado, solo lo que queda de la plataforma.
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

comment on function public.request_payment_refund is
  'Deja pedida una devolución. Solo administración. Idempotente por petición; una sola abierta por pago; ligada a una disputa, solo la parte que esa disputa debe sobre este pago; sin ligar, sin tocar lo reservado para una disputa; con el payout transferido, no más de lo que queda de la plataforma. No devuelve dinero: eso lo hace el proveedor y lo cierra settle_payment_refund.';


-- -----------------------------------------------------------------------------
-- 6. Aprobar el trabajo: el bono negado sale del payout en cualquier estado
--    que todavía no se transfirió
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000200 salvo lo marcado [Nuevo]:
--
--   · el bono negado se descuenta con el payout en PENDING, APPROVED o HELD
--     (antes, solo en PENDING); el estado solo cambia de PENDING a APPROVED, y
--     uno retenido sigue retenido;
--   · el neto no baja de cero (un ajuste previo pudo dejarlo por debajo del
--     bono);
--   · devuelve el estado real del payout, y el aviso al trabajador no dice
--     «aprobado» de un pago retenido ni de uno cancelado (`adjust_payout` en
--     $0 con el trabajo en curso).
create or replace function app_private.approve_completion_core(
  p_assignment_id uuid,
  p_bonus_awarded boolean,
  p_automatic     boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_window integer;
  v_auto_hours integer;
  v_deadline timestamptz;
  v_payout public.payouts;
  v_bonus boolean;
  v_payout_status public.payout_status;
begin
  select * into v_a from public.assignments where id = p_assignment_id;
  select * into v_j from public.jobs where id = v_a.job_id;

  select dispute_window_hours, auto_approve_after_hours
    into v_window, v_auto_hours
    from public.platform_settings where id;
  v_deadline := now() + make_interval(hours => v_window);
  v_bonus := v_a.bonus_amount > 0 and coalesce(p_bonus_awarded, true);

  update public.assignments
     set status = 'COMPLETED',
         completed_at = now(),
         dispute_deadline_at = v_deadline,
         bonus_awarded = case when v_a.bonus_amount > 0 then v_bonus else null end,
         updated_at = now()
   where id = p_assignment_id;

  -- Un trabajo CLOSED, CANCELLED o EXPIRED es terminal: su estado manda.
  update public.jobs set status = 'COMPLETED', updated_at = now()
   where id = v_j.id and app_private.job_is_approvable(status);

  select * into v_payout from public.payouts where assignment_id = p_assignment_id for update;
  v_payout_status := v_payout.status;

  -- [Nuevo] El bono negado sale de todo payout que todavía no se transfirió.
  -- Solo PENDING pasa a APPROVED: uno retenido sigue retenido, y uno aprobado
  -- antes de tiempo, aprobado.
  if v_payout.id is not null and v_payout.status in ('PENDING', 'APPROVED', 'HELD') then
    v_payout_status := case when v_payout.status = 'PENDING' then 'APPROVED'::public.payout_status
                            else v_payout.status end;
    update public.payouts
       set status = v_payout_status,
           approved_at = case when v_payout.status = 'PENDING' then now() else approved_at end,
           bonus_amount = case when v_bonus then bonus_amount else 0 end,
           net_amount = case when v_bonus then net_amount
                             else greatest(net_amount - v_payout.bonus_amount, 0) end,
           updated_at = now()
     where id = v_payout.id;
  end if;

  if p_automatic then
    perform app_private.timeline_event(
      v_j.id, p_assignment_id, null, 'SYSTEM',
      'Trabajo aprobado automáticamente',
      'El cliente no aprobó ni reportó un problema en ' || v_auto_hours
        || ' horas. El plazo para reportar uno sigue abierto ' || v_window || ' horas más.',
      'completion_auto_approved');

    perform app_private.notify_user(
      v_a.worker_id, 'JOB_APPROVED', 'Tu trabajo quedó aprobado',
      -- [Nuevo] Un pago retenido o cancelado no se anuncia como camino de la
      -- transferencia.
      case v_payout_status
        when 'HELD' then 'Se aprobó automáticamente. Tu pago sigue retenido mientras administración revisa el caso: te avisaremos.'
        when 'CANCELLED' then 'Se aprobó automáticamente. Este trabajo no tiene pago: administración lo canceló y te avisó el motivo.'
        else 'Se aprobó automáticamente. El pago se transfiere cuando venza el plazo de reclamo.' end,
      '/mis-trabajos/' || p_assignment_id, v_j.id);

    perform app_private.notify_user(
      v_a.client_id, 'JOB_APPROVED', 'Aprobamos el trabajo por ti',
      'No recibimos tu respuesta en ' || v_auto_hours || ' horas. Si algo salió mal, tienes '
        || v_window || ' horas para reportarlo.',
      '/mis-trabajos/publicados/' || v_j.id, v_j.id);
  else
    perform app_private.timeline_event(
      v_j.id, p_assignment_id, v_a.client_id, 'SYSTEM',
      'Trabajo aprobado por el cliente',
      case v_payout_status
        when 'HELD' then 'El pago al trabajador sigue retenido: lo revisa la administración.'
        when 'CANCELLED' then 'El pago al trabajador está cancelado.'
        else 'El pago al trabajador quedó liberado para su transferencia.' end,
      'completion_approved');

    perform app_private.notify_user(
      v_a.worker_id, 'JOB_APPROVED', 'El cliente aprobó el trabajo',
      case v_payout_status
        when 'HELD' then 'Tu pago sigue retenido mientras administración revisa el caso: te avisaremos. Ya puedes dejar tu reseña.'
        when 'CANCELLED' then 'Este trabajo no tiene pago: administración lo canceló y te avisó el motivo. Ya puedes dejar tu reseña.'
        else 'Tu pago quedó aprobado. Ya puedes dejar tu reseña.' end,
      '/mis-trabajos/' || p_assignment_id, v_j.id);

    perform app_private.notify_user(
      v_a.client_id, 'NEW_REVIEW', 'Cuéntanos cómo te fue',
      'Tu reseña ayuda a quien contrate después.',
      '/mis-trabajos/' || p_assignment_id, v_j.id);
  end if;

  perform app_private.refresh_worker_stats(v_a.worker_id);

  return jsonb_build_object(
    'assignment_status', 'COMPLETED',
    'repeated', false,
    'dispute_deadline_at', v_deadline,
    -- [Nuevo] El estado real, no un «APPROVED» fijo.
    'payout_status', case when v_payout.id is null then null else v_payout_status::text end
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. La transferencia no lleva un bono que el cliente negó
-- -----------------------------------------------------------------------------
create or replace function app_private.payout_bonus_blocker(p_assignment_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 'El cliente no otorgó el bono de este trabajo, pero el pago al trabajador todavía lo incluye ('
         || app_private.format_clp(po.bonus_amount)
         || '). No se transfiere así: retenlo y vuelve a aprobarlo —al aprobar se descuenta el bono— '
         || 'o revisa el caso con soporte'
    from public.assignments a
    join public.payouts po on po.assignment_id = a.id
   where a.id = p_assignment_id
     and a.bonus_awarded is false
     and po.bonus_amount > 0
$$;

comment on function app_private.payout_bonus_blocker is
  'Motivo si el cliente negó el bono (assignments.bonus_awarded = false) y el payout todavía lo incluye, o NULL.';

-- Idéntica a 20260601000810 más el bono, antes de las cifras: si el bono negado
-- sigue en el payout, ese es el motivo que hay que leer.
create or replace function app_private.payout_money_blocker(p_assignment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_blocker text;
begin
  v_blocker := app_private.job_payment_blocker(app_private.payout_job_payment(p_assignment_id));
  if v_blocker is not null then
    return v_blocker;
  end if;

  v_blocker := app_private.refund_in_flight_blocker(p_assignment_id);
  if v_blocker is not null then
    return v_blocker;
  end if;

  -- [Nuevo]
  v_blocker := app_private.payout_bonus_blocker(p_assignment_id);
  if v_blocker is not null then
    return v_blocker;
  end if;

  v_blocker := app_private.payout_overrun(p_assignment_id);
  if v_blocker is not null then
    return 'Las cifras de este trabajo no cuadran: ' || v_blocker
      || '. No se transfiere: deja el pago retenido y ajústalo con «Ajustar» en /admin/payouts '
      || '(lo que de verdad le corresponde al trabajador) o revisa el caso con soporte';
  end if;

  return app_private.payout_environment_blocker(p_assignment_id);
end;
$$;


-- -----------------------------------------------------------------------------
-- 8. Aprobar el pago al trabajador: no a ciegas
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000800 salvo lo marcado [Nuevo]. Aprobar es lo que saca un
-- payout de la retención; antes solo miraba el estado del cobro del trabajo, y
-- un payout retenido porque las cifras no cuadraban volvía a APPROVED con el
-- motivo borrado, hasta que la transferencia lo frenaba otra vez.
create or replace function public.approve_payout(p_payout_id uuid, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p public.payouts;
  v_a public.assignments;
  v_assignment_id uuid;
  v_blocker text;
  v_bonus_removed bigint := 0;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración aprueba un pago al trabajador'
      using errcode = 'insufficient_privilege';
  end if;

  select assignment_id into v_assignment_id from public.payouts where id = p_payout_id;
  if v_assignment_id is null then
    raise exception 'El pago al trabajador no existe' using errcode = 'no_data_found';
  end if;

  perform 1 from public.jobs j
    join public.assignments a on a.job_id = j.id
   where a.id = v_assignment_id
     for update of j;
  select * into v_a from public.assignments where id = v_assignment_id for update;
  perform 1 from public.payments where assignment_id = v_assignment_id order by id for update;
  select * into v_p from public.payouts where id = p_payout_id for update;

  if exists (select 1 from public.disputes d
              where d.assignment_id = v_p.assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Hay una disputa abierta sobre este trabajo' using errcode = 'check_violation';
  end if;

  v_blocker := app_private.job_payment_blocker(app_private.payout_job_payment(v_assignment_id));
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'check_violation';
  end if;

  -- [Nuevo] Con una devolución sin respuesta del banco no se saben las cifras.
  v_blocker := app_private.refund_in_flight_blocker(v_assignment_id);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'check_violation';
  end if;

  -- [Nuevo] Un bono que el cliente negó y que el payout todavía incluye sale
  -- aquí, con la misma regla que al aprobar el trabajo. Queda en la auditoría.
  if v_a.bonus_awarded is false and v_p.bonus_amount > 0 then
    v_bonus_removed := v_p.bonus_amount;
    update public.payouts
       set bonus_amount = 0,
           net_amount = greatest(net_amount - v_p.bonus_amount, 0),
           updated_at = now()
     where id = p_payout_id;

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (auth.uid(), 'payout_bonus_removed', 'payouts', p_payout_id,
            jsonb_build_object('bonus_amount', v_p.bonus_amount, 'net_amount', v_p.net_amount),
            jsonb_build_object('bonus_amount', 0,
                               'net_amount', greatest(v_p.net_amount - v_p.bonus_amount, 0)));
  end if;

  -- [Nuevo] Las cifras tienen que cuadrar: lo devuelto, lo debido por una
  -- disputa y lo que irá al trabajador no pasan de lo cobrado. Si no, el payout
  -- sigue como estaba; primero se ajusta su neto.
  v_blocker := app_private.payout_overrun(v_assignment_id);
  if v_blocker is not null then
    raise exception 'Las cifras de este trabajo no cuadran: %. No se aprueba así: baja el neto a lo que de verdad le corresponde al trabajador con «Ajustar» —o cancélalo con $0— y apruébalo después',
      v_blocker
      using errcode = 'check_violation';
  end if;

  update public.payouts
     set status = 'APPROVED',
         approved_by = auth.uid(),
         approved_at = now(),
         held_reason = null,
         notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes),
         updated_at = now()
   where id = p_payout_id;

  perform app_private.notify_user(
    v_p.worker_id, 'PAYOUT_APPROVED', 'Tu pago quedó aprobado',
    'Te avisaremos cuando se registre la transferencia.',
    '/mis-trabajos/' || v_p.assignment_id, v_a.job_id);

  return jsonb_build_object('payout_status', 'APPROVED', 'bonus_removed', v_bonus_removed);
end;
$$;


-- -----------------------------------------------------------------------------
-- 9. Ajustar el pago al trabajador: solo hacia abajo, y a la vista
-- -----------------------------------------------------------------------------
-- Para el payout que quedó retenido porque una devolución dejó las cifras sin
-- cuadrar (o porque el cliente recibió la devolución total fuera de una
-- disputa): administración decide cuánto le corresponde de verdad al
-- trabajador y lo escribe, con un motivo que él lee.
--
--   · Solo administración; motivo de al menos 10 caracteres.
--   · Solo un payout que no se transfirió (PENDING, APPROVED, HELD).
--   · Con una disputa abierta, solo bajar, no cancelar. Si una devolución
--     previa ya descuadró las cifras, ninguna resolución que le pague algo al
--     trabajador cuadra (la parcial resta del neto lo mismo que anota como
--     deuda): sin bajar antes el neto, la única salida era darle la razón
--     entera al cliente. Cancelar, en cambio, es decidir la disputa: eso lo
--     hace su resolución a favor del cliente.
--   · Solo baja el neto. Subirlo sería pagar más de lo que entró sin que nada
--     lo midiera; para eso está soporte. El mismo neto otra vez no hace nada
--     (un doble clic no duplica el aviso).
--   · Con $0 lo cancela. Con más, el estado no cambia: uno retenido sigue
--     retenido y lo libera `approve_payout`, que vuelve a medir las cifras.
--   · Bloquea en el orden canónico (trabajo → asignación → pagos → payout), el
--     de la transferencia y el de pedir una devolución: un ajuste y una
--     transferencia a la vez se esperan.
--   · Queda en `audit_logs`, en la línea de tiempo (solo administración: el
--     neto del trabajador no es del cliente) y en un aviso al trabajador.
create or replace function public.adjust_payout(
  p_payout_id  uuid,
  p_net_amount bigint,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p public.payouts;
  v_a public.assignments;
  v_assignment_id uuid;
  v_status public.payout_status;
  v_overrun text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_open_dispute boolean;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración ajusta un pago al trabajador'
      using errcode = 'insufficient_privilege';
  end if;
  if char_length(v_reason) < 10 then
    raise exception 'El ajuste necesita un motivo escrito (al menos 10 caracteres): lo lee el trabajador'
      using errcode = 'check_violation';
  end if;
  if p_net_amount is null or p_net_amount < 0 then
    raise exception 'El nuevo neto tiene que ser un importe de cero o más'
      using errcode = 'invalid_parameter_value';
  end if;

  select assignment_id into v_assignment_id from public.payouts where id = p_payout_id;
  if v_assignment_id is null then
    raise exception 'El pago al trabajador no existe' using errcode = 'no_data_found';
  end if;

  -- Orden canónico: trabajo → asignación → pagos → payout.
  perform 1 from public.jobs j
    join public.assignments a on a.job_id = j.id
   where a.id = v_assignment_id
     for update of j;
  select * into v_a from public.assignments where id = v_assignment_id for update;
  perform 1 from public.payments where assignment_id = v_assignment_id order by id for update;
  select * into v_p from public.payouts where id = p_payout_id for update;

  if v_p.status not in ('PENDING', 'APPROVED', 'HELD') then
    raise exception 'Un pago al trabajador en estado % ya no se ajusta: %', v_p.status,
      case v_p.status
        when 'PAID' then 'se transfirió; lo que corresponda ahora es un caso para soporte'
        when 'PROCESSING' then 'se está registrando su transferencia'
        else 'está cancelado' end
      using errcode = 'check_violation';
  end if;

  if p_net_amount > v_p.net_amount then
    raise exception 'Un ajuste solo baja el neto: hoy es % y pediste %. Subirlo es un caso para soporte',
      app_private.format_clp(v_p.net_amount), app_private.format_clp(p_net_amount)
      using errcode = 'check_violation';
  end if;

  -- Con una disputa abierta se puede BAJAR el neto —es lo que permite
  -- resolverla cuando una devolución previa ya descuadró las cifras: ninguna
  -- resolución que le pague algo al trabajador cuadra sin eso—, pero no
  -- cancelarlo: que no reciba nada es una resolución a favor del cliente.
  v_open_dispute := exists (
    select 1 from public.disputes d
     where d.assignment_id = v_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW'));
  if p_net_amount = 0 and v_open_dispute then
    raise exception 'Hay una disputa abierta sobre este trabajo: para que el trabajador no reciba nada, resuélvela a favor del cliente. Mientras tanto, «Ajustar» solo baja el neto'
      using errcode = 'check_violation';
  end if;

  -- El mismo neto otra vez: nada que hacer.
  if p_net_amount = v_p.net_amount then
    return jsonb_build_object(
      'payout_status', v_p.status,
      'net_amount', v_p.net_amount,
      'previous_net_amount', v_p.net_amount,
      'repeated', true,
      'overrun', app_private.payout_overrun(v_assignment_id));
  end if;

  v_status := case when p_net_amount = 0 then 'CANCELLED'::public.payout_status else v_p.status end;

  update public.payouts
     set status = v_status,
         net_amount = p_net_amount,
         held_reason = case
           when v_status = 'CANCELLED' then 'Cancelado por administración: ' || v_reason
           when v_status = 'HELD' then 'Neto ajustado de ' || app_private.format_clp(v_p.net_amount)
                || ' a ' || app_private.format_clp(p_net_amount) || ': ' || v_reason
                || case when v_open_dispute then '. Sigue retenido hasta que se resuelva la disputa'
                        else '. Sigue retenido hasta que la administración lo apruebe' end
           else held_reason end,
         notes = v_reason,
         updated_at = now()
   where id = p_payout_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (auth.uid(), 'payout_adjusted', 'payouts', p_payout_id,
          jsonb_build_object('status', v_p.status, 'net_amount', v_p.net_amount,
                             'held_reason', v_p.held_reason),
          jsonb_build_object('status', v_status, 'net_amount', p_net_amount, 'reason', v_reason));

  perform app_private.timeline_event(
    v_a.job_id, v_assignment_id, auth.uid(), 'SYSTEM',
    case when v_status = 'CANCELLED' then 'Pago al trabajador cancelado'
         else 'Pago al trabajador ajustado' end,
    'De ' || app_private.format_clp(v_p.net_amount) || ' a ' || app_private.format_clp(p_net_amount)
      || ': ' || v_reason,
    'payout_adjusted_' || p_net_amount::text,
    null, null, null, null, 'ADMIN_ONLY');

  perform app_private.notify_user(
    v_p.worker_id, 'PAYOUT_ADJUSTED',
    case when v_status = 'CANCELLED' then 'Este trabajo no tendrá pago'
         else 'Cambió lo que recibirás por este trabajo' end,
    case when v_status = 'CANCELLED'
         then 'Administración canceló tu pago de ' || app_private.format_clp(v_p.net_amount) || '. Motivo: ' || v_reason
         else 'Administración ajustó tu pago de ' || app_private.format_clp(v_p.net_amount) || ' a '
              || app_private.format_clp(p_net_amount) || '. Motivo: ' || v_reason end,
    '/mis-trabajos/' || v_assignment_id, v_a.job_id);

  -- Lo que todavía no cuadre, si algo: un ajuste parcial es válido, pero la
  -- aprobación y la transferencia lo seguirán midiendo.
  v_overrun := case when v_status = 'CANCELLED' then null
                    else app_private.payout_overrun(v_assignment_id) end;

  return jsonb_build_object(
    'payout_status', v_status,
    'net_amount', p_net_amount,
    'previous_net_amount', v_p.net_amount,
    'repeated', false,
    'overrun', v_overrun);
end;
$$;

comment on function public.adjust_payout is
  'Solo administración: baja el neto de un payout no transferido (PENDING, APPROVED, HELD), o lo cancela con 0 (no con una disputa abierta: eso es resolverla a favor del cliente), con motivo escrito. Auditoría, línea de tiempo y aviso al trabajador. Nunca lo sube.';


-- -----------------------------------------------------------------------------
-- 10. El motivo de la retención dice qué hacer
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001400 salvo el texto de los motivos: antes decían
-- «revisa con soporte cuánto le corresponde al trabajador», y no había ninguna
-- herramienta para hacerlo. Ahora la hay.
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
      -- [Nuevo] Qué hacer, con la herramienta que ahora existe.
      else 'El cliente recibió la devolución total de este trabajo. Si al trabajador no le '
           || 'corresponde nada, cancela el pago con «Ajustar» en $0; si le corresponde una parte, '
           || 'ajústalo a esa cifra'
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

  -- Una devolución confirmada que deja las cifras sin cuadrar. La fila de la
  -- devolución ya está CONFIRMED cuando `settle_payment_refund` escribe el
  -- pago, así que `payout_overrun` la cuenta como devuelta y no como en vuelo.
  if new.refunded_amount > old.refunded_amount and new.assignment_id is not null then
    v_overrun := app_private.payout_overrun(new.assignment_id);
    if v_overrun is not null then
      v_reason := 'Se devolvieron ' || app_private.format_clp(new.refunded_amount - old.refunded_amount)
        || ' al cliente y las cifras de este trabajo ya no cuadran: ' || v_overrun
        -- [Nuevo]
        || '. No se transfiere así: baja el neto a lo que de verdad le corresponde al trabajador '
        || 'con «Ajustar» en /admin/payouts —o cancélalo con $0— y apruébalo después';

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


-- -----------------------------------------------------------------------------
-- 11. Privilegios
-- -----------------------------------------------------------------------------
-- `create or replace` conserva los de las funciones que ya existían; se
-- repiten para que esta migración diga por sí sola quién puede llamarlas.
grant execute on function public.resolve_dispute(uuid, public.dispute_resolution, text, bigint) to authenticated;
grant execute on function public.approve_payout(uuid, text) to authenticated;
grant execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.adjust_payout(uuid, bigint, text) to authenticated;
revoke execute on function public.resolve_dispute(uuid, public.dispute_resolution, text, bigint) from anon, public;
revoke execute on function public.approve_payout(uuid, text) from anon, public;
revoke execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) from anon, public;
revoke execute on function public.adjust_payout(uuid, bigint, text) from anon, public;

revoke all on function app_private.payment_refund_committed(uuid) from public, anon, authenticated;
revoke all on function app_private.dispute_refund_allocation(uuid) from public, anon, authenticated;
revoke all on function app_private.default_client_wins_refund() from public, anon, authenticated;
revoke all on function app_private.payment_review_queue() from public, anon, authenticated;
revoke all on function app_private.approve_completion_core(uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function app_private.payout_bonus_blocker(uuid) from public, anon, authenticated;
revoke all on function app_private.payout_money_blocker(uuid) from public, anon, authenticated;
revoke all on function app_private.hold_payout_on_unhealthy_payment() from public, anon, authenticated;
