-- =============================================================================
-- HagoTuFila · Al trabajador no se le paga sobre un cobro devuelto o en duda
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado sobre la base:
-- `resolve_dispute`, `approve_payout` y `mark_payout_paid` liberaban el pago al
-- trabajador sin mirar el pago del cliente. Los disparadores de 20260501000200
-- y 20260501000400 retienen el payout (HELD) cuando el pago del trabajo se
-- devuelve entero o pasa a revisión, pero retener no bastaba: cualquiera de
-- las tres funciones lo sacaba de ahí.
--
--   a. el cliente recibe la devolución total; el payout queda HELD;
--   b. administración lo aprueba (`approve_payout`: HELD → APPROVED), o una
--      disputa abierta antes se resuelve a favor del trabajador
--      (`resolve_dispute`: HELD → APPROVED);
--   c. vencida la ventana, o con la disputa ya resuelta, `mark_payout_paid` lo
--      registra transferido.
--
-- Resultado: el cliente con su dinero de vuelta y el trabajador cobrado por el
-- mismo trabajo, las dos cosas a cargo de la plataforma. Lo mismo con un pago
-- en revisión: se dudaba del dinero que entró y se liberaba el que sale.
--
-- Ahora:
--
--   · `mark_payout_paid` es la barrera definitiva. `payout_transfer_blocker`
--     exige, ANTES de que una disputa resuelta exima de esperar la ventana, que
--     el pago del trabajo esté sano: PAID o PARTIALLY_REFUNDED, sin devoluciones
--     sin respuesta del banco, y con las cifras cuadradas —lo devuelto al
--     cliente, lo que se le debe por una disputa y lo que se transferiría al
--     trabajador no pueden sumar más de lo que el cliente pagó—. Y toma los
--     cerrojos en el orden canónico (trabajo → asignación → pagos → payout):
--     una devolución que se pide a la vez espera a la transferencia, o la
--     transferencia la ve.
--   · `approve_payout` se niega si el pago del trabajo está devuelto entero, en
--     revisión o en cualquier estado que no sea un cobro confirmado.
--   · `resolve_dispute` no resuelve a favor del trabajador, ni reparte, sobre un
--     pago devuelto entero; y no deja un payout cuyas cifras contradigan una
--     devolución. Si el pago está en revisión o con una devolución sin
--     respuesta, la decisión se registra igual pero el payout queda retenido:
--     lo libera `approve_payout` cuando el cobro vuelva a estar sano.
--
-- Lo demás de 20260601000100/0200/0300 —la ventana de disputa, la devolución
-- por omisión de CLIENT_WINS y la aprobación automática— no cambia.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Piezas: el pago del trabajo y lo que lo deja en duda
-- -----------------------------------------------------------------------------

-- Pesos chilenos para un mensaje: $21.000.
create or replace function app_private.format_clp(p_amount bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select '$' || replace(to_char(coalesce(p_amount, 0), 'FM999,999,999,999,990'), ',', '.')
$$;

-- El pago del cliente que respalda el payout de una asignación: el que el
-- payout guarda en `payment_id` (lo fija `guard_payout` al crearlo) o, en un
-- payout anterior a esa columna, el último pago del trabajo.
create or replace function app_private.payout_job_payment(p_assignment_id uuid)
returns public.payments
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.*
    from public.payments p
   where p.id = coalesce(
           (select po.payment_id from public.payouts po where po.assignment_id = p_assignment_id),
           (select x.id from public.payments x
             where x.assignment_id = p_assignment_id and x.purpose = 'JOB'
             order by x.created_at desc limit 1))
$$;

comment on function app_private.payout_job_payment is
  'Pago del cliente (purpose JOB) que respalda el payout de la asignación.';

-- ¿El cobro del trabajo sigue en pie? Solo PAID o PARTIALLY_REFUNDED: lo
-- demás es dinero que no entró, que volvió o del que se duda.
create or replace function app_private.job_payment_blocker(p_payment public.payments)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_payment.id is null then
      'No encontramos el pago del cliente de este trabajo: sin un cobro confirmado no hay de dónde pagarle al trabajador'
    when p_payment.status = 'REFUNDED' then
      'El cliente recibió la devolución total de este trabajo ('
        || app_private.format_clp(p_payment.refunded_amount)
        || '): no se le paga al trabajador sobre un cobro devuelto. El pago queda retenido; '
        || 'si aun así corresponde pagarle, es un caso para soporte'
    when p_payment.status = 'UNDER_REVIEW' then
      'El pago del cliente está en revisión'
        || coalesce(' (' || nullif(btrim(p_payment.review_reason), '') || ')', '')
        || ': se duda del dinero que entró. Resuélvelo primero en /admin/pagos '
        || '—consulta al proveedor o devuelve— y después vuelve aquí'
    when p_payment.status not in ('PAID', 'PARTIALLY_REFUNDED') then
      'El pago del cliente está en ' || p_payment.status::text
        || ': solo se le paga al trabajador sobre un cobro confirmado'
  end
$$;

comment on function app_private.job_payment_blocker is
  'Motivo por el que el pago del trabajo no respalda un pago al trabajador (devuelto, en revisión, sin cobrar), o NULL si está sano.';

-- Una devolución pedida al banco y sin respuesta. Mientras no se sepa si el
-- dinero volvió, lo que queda del cobro es una incógnita.
--
-- Se mira por exclusión —todo lo que no es un resultado final— y no por
-- inclusión de REQUESTED: un estado intermedio que se añada mañana a
-- `refund_status` cuenta como «sin respuesta» sin tocar esta función.
create or replace function app_private.refund_in_flight_blocker(p_assignment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_total bigint;
  v_since timestamptz;
begin
  select count(*), coalesce(sum(r.amount), 0), min(r.requested_at)
    into v_count, v_total, v_since
    from public.payment_refunds r
    join public.payments p on p.id = r.payment_id
   where p.assignment_id = p_assignment_id
     and r.status not in ('CONFIRMED', 'FAILED', 'CANCELLED');

  if v_count = 0 then
    return null;
  end if;

  return case when v_count = 1 then 'Hay una devolución al cliente'
              else 'Hay ' || v_count || ' devoluciones al cliente' end
    || ' sin respuesta del banco (' || app_private.format_clp(v_total) || ', pedida el '
    || to_char(v_since at time zone 'America/Santiago', 'DD-MM-YYYY "a las" HH24:MI')
    || ', hora de Chile). Hasta saber si el dinero volvió no se pueden cuadrar las cifras: '
    || 'concíliala en /admin/pagos y vuelve a intentarlo';
end;
$$;

comment on function app_private.refund_in_flight_blocker is
  'Motivo si alguna devolución sobre los pagos de la asignación no tiene resultado final del banco, o NULL.';

-- ¿Cuadran las cifras? Lo que sale —lo devuelto al cliente, lo pedido y sin
-- respuesta, lo que se le debe por una disputa resuelta, y el payout— no puede
-- superar lo que entró. Devuelve la explicación con los números, o NULL.
--
--   · Entró: todos los cobros de la asignación que llegaron a cobrarse —el del
--     trabajo y los del tiempo adicional, que también suben el payout—.
--   · Al trabajador: el neto, más lo retenido por impuestos si alguna vez se
--     retiene, que también sale de la plataforma. El bruto no: en una
--     resolución PARCIAL lo devuelto se descuenta del neto, no del bruto.
--   · Debido por disputa: el `refund_amount` de cada disputa resuelta, menos
--     las devoluciones ligadas a ella que ya se confirmaron o están pedidas.
--
-- Lo pedido y sin respuesta cuenta como si se fuera a devolver: es el caso
-- peor, y el único que no puede salir caro.
create or replace function app_private.payout_overrun(p_assignment_id uuid)
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
  v_owed bigint;
  v_out bigint;
  v_total bigint;
begin
  select * into v_po from public.payouts where assignment_id = p_assignment_id;
  if v_po.id is null or v_po.status = 'CANCELLED' then
    return null;
  end if;

  select coalesce(sum(p.amount) filter (where p.status in ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')), 0),
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
           0)), 0)
    into v_owed
    from public.disputes d
   where d.assignment_id = p_assignment_id and d.status = 'RESOLVED';

  v_out := v_po.net_amount + v_po.tax_withheld_amount;
  v_total := v_refunded + v_in_flight + v_owed + v_out;

  if v_total <= v_paid then
    return null;
  end if;

  return 'el cliente pagó ' || app_private.format_clp(v_paid)
    || ', se le devolvió ' || app_private.format_clp(v_refunded)
    || case when v_in_flight > 0
            then ', hay ' || app_private.format_clp(v_in_flight) || ' en devolución sin respuesta'
            else '' end
    || case when v_owed > 0
            then ', se le deben ' || app_private.format_clp(v_owed) || ' por una disputa'
            else '' end
    || ' y al trabajador irían ' || app_private.format_clp(v_out)
    || ': suman ' || app_private.format_clp(v_total)
    || ', ' || app_private.format_clp(v_total - v_paid) || ' más de lo que entró';
end;
$$;

comment on function app_private.payout_overrun is
  'Explicación con cifras si lo devuelto o debido al cliente más el payout supera lo cobrado en la asignación, o NULL si cuadra.';

-- Todo lo anterior junto, con las palabras de la transferencia. Es una pieza
-- aparte para que la próxima condición sobre el dinero se añada aquí y no en
-- la función de la ventana.
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

  v_blocker := app_private.payout_overrun(p_assignment_id);
  if v_blocker is not null then
    return 'Las cifras de este trabajo no cuadran: ' || v_blocker
      || '. No se transfiere: deja el pago retenido y revisa el caso con soporte';
  end if;

  return null;
end;
$$;

comment on function app_private.payout_money_blocker is
  'Motivo por el que el dinero del cliente no respalda transferir el payout de la asignación, o NULL.';


-- -----------------------------------------------------------------------------
-- 2. Transferencia: el dinero, antes que el calendario
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000100 salvo el paso del dinero, que va antes de la
-- excepción de la disputa resuelta: una resolución exime de esperar la
-- ventana, no de que el cobro siga en pie.

create or replace function app_private.payout_transfer_blocker(p_assignment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_blocker text;
begin
  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    return 'Hay una disputa abierta sobre este trabajo: el pago queda retenido hasta resolverla';
  end if;

  v_blocker := app_private.payout_money_blocker(p_assignment_id);
  if v_blocker is not null then
    return v_blocker;
  end if;

  -- Una disputa resuelta es la decisión final de la administración.
  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status = 'RESOLVED') then
    return null;
  end if;

  select * into v_a from public.assignments where id = p_assignment_id;

  if v_a.status <> 'COMPLETED' or v_a.dispute_deadline_at is null then
    return 'El trabajo todavía no está aprobado: no corre la ventana para reportar problemas';
  end if;

  if v_a.dispute_deadline_at > now() then
    return 'El plazo para reportar problemas vence el '
           || to_char(v_a.dispute_deadline_at at time zone 'America/Santiago', 'DD-MM-YYYY "a las" HH24:MI')
           || ' (hora de Chile). La transferencia se registra después';
  end if;

  return null;
end;
$$;

-- Idéntica a 20260601000100 salvo el orden de los cerrojos. Antes bloqueaba el
-- payout y después la asignación, al revés que `open_dispute` y que los
-- disparadores que retienen el payout cuando cambia un pago; y no bloqueaba
-- los pagos, así que una devolución podía pedirse entre la comprobación y la
-- transferencia.
create or replace function public.mark_payout_paid(
  p_payout_id      uuid,
  p_bank_reference text,
  p_paid_at        timestamptz default null,
  p_notes          text default null
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
  v_when timestamptz;
  v_blocker text;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración registra una transferencia'
      using errcode = 'insufficient_privilege';
  end if;
  if char_length(coalesce(trim(p_bank_reference), '')) < 4 then
    raise exception 'Hace falta la referencia de la transferencia' using errcode = 'check_violation';
  end if;

  v_when := coalesce(p_paid_at, now());
  if v_when > now() + interval '1 day' then
    raise exception 'La fecha de la transferencia no puede estar en el futuro'
      using errcode = 'check_violation';
  end if;

  select assignment_id into v_assignment_id from public.payouts where id = p_payout_id;
  if v_assignment_id is null then
    raise exception 'El pago al trabajador no existe' using errcode = 'no_data_found';
  end if;

  -- Orden canónico: trabajo → asignación → pagos → payout. Es el de
  -- `resolve_dispute` y `confirm_payment_result`. Con los pagos bloqueados, una
  -- devolución que se pide ahora mismo espera a que esto termine, y una
  -- disputa que se abre ahora mismo espera igual que antes.
  perform 1 from public.jobs j
    join public.assignments a on a.job_id = j.id
   where a.id = v_assignment_id
     for update of j;
  select * into v_a from public.assignments where id = v_assignment_id for update;
  perform 1 from public.payments where assignment_id = v_assignment_id order by id for update;
  select * into v_p from public.payouts where id = p_payout_id for update;

  if v_p.status = 'PAID' then
    -- Idempotente: registrar dos veces la misma transferencia no la duplica.
    return jsonb_build_object('payout_status', 'PAID', 'repeated', true);
  end if;
  if v_p.status <> 'APPROVED' then
    raise exception 'Un pago en estado % no se puede transferir todavía', v_p.status
      using errcode = 'check_violation';
  end if;

  v_blocker := app_private.payout_transfer_blocker(v_p.assignment_id);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'check_violation';
  end if;

  -- APPROVED → PROCESSING → PAID: la máquina de estados no se salta ni aquí.
  update public.payouts set status = 'PROCESSING', updated_at = now() where id = p_payout_id;
  update public.payouts
     set status = 'PAID',
         bank_reference = trim(p_bank_reference),
         paid_at = v_when,
         notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes),
         updated_at = now()
   where id = p_payout_id;

  perform app_private.notify_user(
    v_p.worker_id, 'PAYOUT_PAID', 'Registramos tu transferencia',
    'Referencia: ' || trim(p_bank_reference),
    '/mis-trabajos/' || v_p.assignment_id, v_a.job_id);

  return jsonb_build_object('payout_status', 'PAID', 'repeated', false);
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Aprobar: no sobre un cobro devuelto ni en revisión
-- -----------------------------------------------------------------------------
-- Idéntica a 20260401000200 salvo los cerrojos —el mismo orden que la
-- transferencia— y la comprobación del pago del trabajo. Aprobar es lo que
-- saca un payout de la retención; si el cobro sigue devuelto o en duda, la
-- retención tiene que seguir.

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

  return jsonb_build_object('payout_status', 'APPROVED');
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Resolver una disputa sin contradecir una devolución
-- -----------------------------------------------------------------------------
-- Idéntica a 20260401000200 salvo tres cosas, marcadas abajo:
--
--   · a favor del trabajador o repartida, no sobre un cobro devuelto entero;
--   · si el cobro está en revisión o con una devolución sin respuesta, el
--     payout queda retenido en vez de aprobado;
--   · al final, si el payout queda aprobado, las cifras tienen que cuadrar.
--     Si no, se lanza y la transacción entera —disputa incluida— se deshace:
--     no queda una decisión a medias.

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
  v_payment public.payments;
  v_job_payment public.payments;
  v_payout_status public.payout_status;
  v_assignment_id uuid;
  v_net bigint;
  v_pays_worker boolean;
  v_held_reason text;
  v_overrun text;
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

  -- Orden canónico de bloqueo: jobs → assignments → payments, y después las
  -- filas propias de la disputa. Se bloquean todos los pagos de la asignación,
  -- no solo el del trabajo: las cifras de abajo los suman todos.
  select j.* into v_j
    from public.assignments a join public.jobs j on j.id = a.job_id
   where a.id = v_assignment_id
     for update of j;
  select * into v_a from public.assignments where id = v_assignment_id for update;
  perform 1 from public.payments where assignment_id = v_assignment_id order by id for update;
  select * into v_payment from public.payments
   where assignment_id = v_assignment_id and purpose = 'JOB'
   order by created_at desc limit 1;
  select * into v_d from public.disputes where id = p_dispute_id for update;

  if v_d.status = 'RESOLVED' then
    raise exception 'Esta disputa ya está resuelta' using errcode = 'check_violation';
  end if;
  if v_d.status = 'WITHDRAWN' then
    raise exception 'Esta disputa fue retirada' using errcode = 'check_violation';
  end if;

  if p_refund_amount is not null then
    if p_refund_amount < 0 then
      raise exception 'El monto a devolver no puede ser negativo' using errcode = 'check_violation';
    end if;
    if v_payment.id is not null and p_refund_amount > v_payment.amount then
      raise exception 'El monto a devolver supera lo cobrado' using errcode = 'check_violation';
    end if;
  end if;

  -- [Nuevo] Sobre un cobro devuelto entero no queda nada que pagarle al
  -- trabajador: ni todo ni una parte.
  v_pays_worker := p_resolution in ('WORKER_WINS', 'PARTIAL');
  v_job_payment := app_private.payout_job_payment(v_assignment_id);

  if v_pays_worker and v_job_payment.status = 'REFUNDED' then
    raise exception 'El cliente ya recibió la devolución total de este trabajo (%): no se puede resolver a favor del trabajador ni repartir. Resuélvela a favor del cliente',
      app_private.format_clp(v_job_payment.refunded_amount)
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
   where id = p_dispute_id;

  -- El payout retenido se libera, se recorta o se cancela según el resultado.
  select * into v_payout from public.payouts where assignment_id = v_assignment_id for update;

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

    -- [Nuevo] La decisión se registra, pero un cobro en duda no libera nada:
    -- el payout sigue retenido hasta que `approve_payout` lo encuentre sano.
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

    -- [Nuevo] Con todo escrito, las cifras del payout que queda liberado. Lo
    -- devuelto, lo pedido, lo que se debe por esta y otras disputas y lo que
    -- irá al trabajador no pueden superar lo que el cliente pagó. Uno retenido
    -- no se mide aquí: no sale de la retención sin `approve_payout`, y la
    -- transferencia vuelve a medirlo todo.
    if v_payout_status = 'APPROVED' then
      v_overrun := app_private.payout_overrun(v_assignment_id);
      if v_overrun is not null then
        raise exception 'Esta resolución no cuadra: %. Elige otra —a favor del cliente, o parcial descontando del trabajador lo que se devuelve— o revisa el caso con soporte',
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
    'refund_registered', coalesce(p_refund_amount, 0)
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. Privilegios
-- -----------------------------------------------------------------------------
-- Las tres públicas conservan los suyos: `create or replace` no los toca. Se
-- repiten para que esta migración diga por sí sola quién puede llamarlas.
grant execute on function public.resolve_dispute(uuid, public.dispute_resolution, text, bigint) to authenticated;
grant execute on function public.approve_payout(uuid, text) to authenticated;
grant execute on function public.mark_payout_paid(uuid, text, timestamptz, text) to authenticated;
revoke execute on function public.resolve_dispute(uuid, public.dispute_resolution, text, bigint) from anon, public;
revoke execute on function public.approve_payout(uuid, text) from anon, public;
revoke execute on function public.mark_payout_paid(uuid, text, timestamptz, text) from anon, public;

revoke all on function app_private.format_clp(bigint) from public, anon, authenticated;
revoke all on function app_private.payout_job_payment(uuid) from public, anon, authenticated;
revoke all on function app_private.job_payment_blocker(public.payments) from public, anon, authenticated;
revoke all on function app_private.refund_in_flight_blocker(uuid) from public, anon, authenticated;
revoke all on function app_private.payout_overrun(uuid) from public, anon, authenticated;
revoke all on function app_private.payout_money_blocker(uuid) from public, anon, authenticated;
revoke all on function app_private.payout_transfer_blocker(uuid) from public, anon, authenticated;
grant execute on function app_private.payout_transfer_blocker(uuid) to service_role;
