-- =============================================================================
-- HagoTuFila · Bloque 3 · 200 · Disputas, payouts y administración
-- =============================================================================
-- La Etapa 1 dejó las tablas `disputes`, `dispute_evidence` y `payouts` con
-- todas sus columnas, y un disparador que retenía el payout al abrir una
-- disputa. Lo que faltaba era todo lo que convierte eso en un procedimiento:
-- abrir con reglas, aportar pruebas, resolver, y registrar una transferencia
-- que en esta etapa es manual y se dice que es manual.
--
-- Defectos reales que se cierran aquí:
--
--   1. `dispute_evidence` tenía política de INSERT pero ningún privilegio: la
--      RLS dejaba pasar a los participantes y PostgreSQL los frenaba antes.
--      Nadie podía aportar una prueba, ni el que abría la disputa.
--   2. `hold_payout_on_dispute` ponía `jobs.status = 'DISPUTED'` sin mirar el
--      estado previo. Sobre un trabajo ya cancelado chocaba con
--      `guard_job_terminal` y reventaba la apertura de la disputa entera.
--   3. La resolución era un `UPDATE` directo bajo la política de administración
--      y no hacía nada más: no liberaba ni cancelaba el payout, no cerraba el
--      trabajo, no avisaba a nadie y no quedaba registrada como decisión.
--   4. `payouts` no tenía ninguna vía de aprobación ni de pago. El enum
--      `payout_status` existía completo y la máquina de estados vivía solo en
--      TypeScript.
--
-- Lo que esta migración NO hace, y se dice sin rodeos: no mueve dinero. No hay
-- reembolso al medio de pago ni transferencia bancaria. Una resolución decide
-- QUÉ corresponde y lo deja registrado; `mark_payout_paid` anota una
-- transferencia que una persona hizo por fuera, con su referencia. El
-- reembolso real es de la Etapa 4, con el proveedor integrado.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Abrir una disputa deja de ser una escritura directa
-- -----------------------------------------------------------------------------
revoke insert (assignment_id, opened_by, reason, description)
  on public.disputes from authenticated;
revoke insert on public.disputes from authenticated;
revoke update on public.disputes from authenticated;

comment on table public.disputes is
  'Se abre con open_dispute y se resuelve con resolve_dispute (solo administración). Sin escritura directa para nadie con sesión.';

-- La prueba de una disputa sí la escribe la persona, pero por función: así se
-- valida el archivo y se registra el rol con el que se aportó.
revoke insert on public.dispute_evidence from authenticated;

-- El disparador que retenía el payout se reescribe: ya no fuerza el estado del
-- trabajo a ciegas.
create or replace function app_private.hold_payout_on_dispute()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_job_status public.job_status;
begin
  update public.payouts
     set status = 'HELD',
         held_reason = 'Disputa abierta',
         updated_at = now()
   where assignment_id = new.assignment_id
     and status in ('PENDING', 'APPROVED');

  select j.id, j.status into v_job_id, v_job_status
    from public.assignments a
    join public.jobs j on j.id = a.job_id
   where a.id = new.assignment_id;

  -- Un trabajo cancelado, vencido o cerrado no «pasa a disputa»: la disputa
  -- existe igual, pero el estado terminal manda. Antes esto lanzaba la
  -- excepción de `guard_job_terminal` y tumbaba la apertura completa.
  if v_job_status in ('PAID', 'IN_PROGRESS', 'HANDOFF_COMPLETED', 'COMPLETED') then
    update public.jobs set status = 'DISPUTED', updated_at = now() where id = v_job_id;
  end if;

  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. Abrir una disputa
-- -----------------------------------------------------------------------------
create or replace function public.open_dispute(
  p_assignment_id uuid,
  p_reason        text,
  p_description   text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_uid uuid := auth.uid();
  v_window integer;
  v_id uuid;
  v_other uuid;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'any');
  select * into v_j from public.jobs where id = v_a.job_id;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Hay que indicar un motivo' using errcode = 'check_violation';
  end if;
  if char_length(coalesce(trim(p_description), '')) < 20 then
    raise exception 'Cuéntanos qué pasó con al menos 20 caracteres' using errcode = 'check_violation';
  end if;

  -- Antes del pago no hay nada que disputar: se cancela y punto.
  if v_a.status in ('AWAITING_PAYMENT') then
    raise exception 'Todavía no hay un trabajo en marcha que disputar'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Ya hay una disputa abierta para este trabajo' using errcode = 'check_violation';
  end if;

  -- La ventana de disputa solo corre una vez aprobado el trabajo. Antes de eso
  -- se puede reclamar en cualquier momento.
  if v_a.status = 'COMPLETED' and v_a.dispute_deadline_at is not null
     and v_a.dispute_deadline_at < now() then
    select dispute_window_hours into v_window from public.platform_settings where id;
    raise exception 'El plazo para reportar un problema venció (% horas desde la aprobación)', v_window
      using errcode = 'check_violation';
  end if;

  insert into public.disputes (assignment_id, opened_by, reason, description)
  values (p_assignment_id, v_uid, trim(p_reason), trim(p_description))
  returning id into v_id;

  perform app_private.timeline_event(
    v_j.id, p_assignment_id, v_uid, 'SYSTEM',
    'Disputa abierta',
    trim(p_reason),
    'dispute_opened_' || v_id::text);

  v_other := case when v_uid = v_a.worker_id then v_a.client_id else v_a.worker_id end;

  perform app_private.notify_user(
    v_other, 'DISPUTE_OPENED', 'Se abrió una disputa',
    'La administración revisará el caso. El pago queda retenido mientras tanto.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  perform app_private.notify_user(
    v_uid, 'DISPUTE_OPENED', 'Recibimos tu reporte',
    'La administración lo revisará. El pago queda retenido mientras tanto.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Aportar pruebas a una disputa
-- -----------------------------------------------------------------------------
create or replace function public.add_dispute_evidence(
  p_dispute_id   uuid,
  p_body         text default null,
  p_storage_path text default null,
  p_mime_type    text default null,
  p_size_bytes   integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.disputes;
  v_a public.assignments;
  v_role public.app_role;
  v_max bigint;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select * into v_d from public.disputes where id = p_dispute_id;
  if v_d.id is null then
    raise exception 'La disputa no existe' using errcode = 'no_data_found';
  end if;

  select * into v_a from public.assignments where id = v_d.assignment_id;

  if v_uid not in (v_a.client_id, v_a.worker_id) and not app_private.is_admin() then
    raise exception 'No participas en esta disputa' using errcode = 'insufficient_privilege';
  end if;

  if v_d.status = 'RESOLVED' then
    raise exception 'Esta disputa ya está resuelta' using errcode = 'check_violation';
  end if;

  if coalesce(trim(coalesce(p_body, '')), '') = '' and p_storage_path is null then
    raise exception 'Escribe algo o adjunta un archivo' using errcode = 'check_violation';
  end if;

  select evidence_max_bytes into v_max from public.platform_settings where id;

  if p_storage_path is not null then
    if split_part(p_storage_path, '/', 1) <> v_uid::text then
      raise exception 'La ruta del archivo no corresponde a tu carpeta'
        using errcode = 'insufficient_privilege';
    end if;
    if p_storage_path like '%..%' then
      raise exception 'Ruta de archivo no válida' using errcode = 'invalid_parameter_value';
    end if;
    if p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then
      raise exception 'Formato de archivo no admitido' using errcode = 'invalid_parameter_value';
    end if;
    if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > v_max then
      raise exception 'El archivo supera el tamaño permitido' using errcode = 'check_violation';
    end if;
  end if;

  v_role := case
    when app_private.is_admin() then 'ADMIN'::public.app_role
    when v_uid = v_a.client_id then 'CLIENT'::public.app_role
    else 'WORKER'::public.app_role
  end;

  insert into public.dispute_evidence (dispute_id, author_id, author_role, body, storage_path)
  values (p_dispute_id, v_uid, v_role, nullif(trim(coalesce(p_body, '')), ''), p_storage_path)
  returning id into v_id;

  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Resolver una disputa: solo la administración, y con consecuencias
-- -----------------------------------------------------------------------------
-- La resolución decide qué corresponde y lo deja escrito. No ejecuta ningún
-- reembolso: no hay integración con el medio de pago, y decirlo es parte de la
-- decisión. Lo que sí hace es dejar el payout en un estado definitivo, para
-- que nadie cobre por un trabajo que se resolvió a favor del cliente.
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
  v_payout_status public.payout_status;
  v_assignment_id uuid;
  v_net bigint;
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
  -- filas propias de la disputa.
  select j.* into v_j
    from public.assignments a join public.jobs j on j.id = a.job_id
   where a.id = v_assignment_id
     for update of j;
  select * into v_a from public.assignments where id = v_assignment_id for update;
  select * into v_payment from public.payments
   where assignment_id = v_assignment_id and purpose = 'JOB'
   order by created_at desc limit 1
     for update;
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

    update public.payouts
       set status = v_payout_status,
           net_amount = v_net,
           held_reason = case when v_payout_status = 'CANCELLED'
                              then 'Disputa resuelta a favor del cliente' end,
           notes = trim(p_notes),
           approved_by = case when v_payout_status = 'APPROVED' then auth.uid() end,
           approved_at = case when v_payout_status = 'APPROVED' then now() end,
           updated_at = now()
     where id = v_payout.id;
  end if;

  -- Lo que corresponde devolver queda anotado en la disputa (`refund_amount`),
  -- no en el estado del pago. El dinero SÍ se cobró: mover el pago a
  -- UNDER_REVIEW borraría ese hecho y rompería el invariante «un payout se
  -- apoya en un pago confirmado», que es justo el que protege al trabajador en
  -- una resolución parcial. La cola de devoluciones de la administración son
  -- las disputas resueltas con importe a devolver; ejecutarlas necesita el
  -- proveedor integrado, y eso es de la Etapa 4.

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
-- 5. Revisión de un check-in que no se verificó solo
-- -----------------------------------------------------------------------------
create or replace function public.review_check_in(
  p_check_in_id uuid,
  p_approved    boolean,
  p_reason      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.assignment_check_ins;
  v_a public.assignments;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración revisa un check-in'
      using errcode = 'insufficient_privilege';
  end if;
  if p_approved is null then
    raise exception 'Hay que aprobar o rechazar' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(coalesce(trim(p_reason), '')) < 5 then
    raise exception 'La revisión necesita un motivo escrito' using errcode = 'check_violation';
  end if;

  select * into v_c from public.assignment_check_ins where id = p_check_in_id for update;
  if v_c.id is null then
    raise exception 'El check-in no existe' using errcode = 'no_data_found';
  end if;
  if v_c.review_status not in ('PENDING') then
    raise exception 'Este check-in ya fue revisado (%)', v_c.review_status
      using errcode = 'check_violation';
  end if;

  update public.assignment_check_ins
     set review_status = (case when p_approved then 'APPROVED' else 'REJECTED' end)::public.check_in_review,
         review_reason = trim(p_reason),
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_check_in_id;

  select * into v_a from public.assignments where id = v_c.assignment_id;

  perform app_private.timeline_event(
    v_c.job_id, v_c.assignment_id, auth.uid(), 'SYSTEM',
    case when p_approved then 'Llegada aprobada tras revisión'
         else 'Llegada rechazada tras revisión' end,
    trim(p_reason),
    'check_in_review_' || p_check_in_id::text);

  perform app_private.notify_user(
    v_a.worker_id, 'CHECK_IN',
    case when p_approved then 'Tu llegada quedó aprobada' else 'Tu llegada fue rechazada' end,
    trim(p_reason), '/mis-trabajos/' || v_c.assignment_id, v_c.job_id);

  return jsonb_build_object('review_status', case when p_approved then 'APPROVED' else 'REJECTED' end);
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. Payouts: la máquina de estados, también en la base
-- -----------------------------------------------------------------------------
-- `payoutTransitions` vivía solo en TypeScript. Aquí va su copia, por la misma
-- razón que la de la asignación: la interfaz no es una frontera de seguridad.
create or replace function app_private.guard_payout_transitions()
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

  v_permitidos := case old.status::text
    when 'PENDING'    then array['APPROVED', 'HELD', 'CANCELLED']
    when 'APPROVED'   then array['PROCESSING', 'HELD', 'CANCELLED']
    when 'PROCESSING' then array['PAID', 'HELD']
    when 'HELD'       then array['APPROVED', 'CANCELLED']
    else array[]::text[]      -- PAID y CANCELLED son terminales
  end;

  if not (new.status::text = any (v_permitidos)) then
    raise exception 'Transición inválida en el payout: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function app_private.guard_payout_transitions is
  'Copia en la base de payoutTransitions (src/lib/domain/state-machines.ts). PAID y CANCELLED son terminales para todos, también para el rol de servicio.';

drop trigger if exists payouts_guard_transitions on public.payouts;
create trigger payouts_guard_transitions
  before update on public.payouts
  for each row execute function app_private.guard_payout_transitions();

-- Aprobar: pasa de PENDING/HELD a APPROVED.
create or replace function public.approve_payout(p_payout_id uuid, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p public.payouts;
  v_a public.assignments;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración aprueba un pago al trabajador'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_p from public.payouts where id = p_payout_id for update;
  if v_p.id is null then
    raise exception 'El pago al trabajador no existe' using errcode = 'no_data_found';
  end if;

  select * into v_a from public.assignments where id = v_p.assignment_id;

  if exists (select 1 from public.disputes d
              where d.assignment_id = v_p.assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Hay una disputa abierta sobre este trabajo' using errcode = 'check_violation';
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

-- Registrar la transferencia. Es un asiento contable de algo que una persona
-- hizo por fuera: la plataforma no mueve dinero en esta etapa.
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
  v_when timestamptz;
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

  select * into v_p from public.payouts where id = p_payout_id for update;
  if v_p.id is null then
    raise exception 'El pago al trabajador no existe' using errcode = 'no_data_found';
  end if;
  if v_p.status = 'PAID' then
    -- Idempotente: registrar dos veces la misma transferencia no la duplica.
    return jsonb_build_object('payout_status', 'PAID', 'repeated', true);
  end if;
  if v_p.status <> 'APPROVED' then
    raise exception 'Un pago en estado % no se puede transferir todavía', v_p.status
      using errcode = 'check_violation';
  end if;

  select * into v_a from public.assignments where id = v_p.assignment_id;

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

-- Retener a mano, cuando la administración ve algo antes que nadie.
create or replace function public.hold_payout(p_payout_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p public.payouts;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración retiene un pago'
      using errcode = 'insufficient_privilege';
  end if;
  if char_length(coalesce(trim(p_reason), '')) < 5 then
    raise exception 'La retención necesita un motivo escrito' using errcode = 'check_violation';
  end if;

  select * into v_p from public.payouts where id = p_payout_id for update;
  if v_p.id is null then
    raise exception 'El pago al trabajador no existe' using errcode = 'no_data_found';
  end if;

  update public.payouts
     set status = 'HELD', held_reason = trim(p_reason), updated_at = now()
   where id = p_payout_id;

  return jsonb_build_object('payout_status', 'HELD');
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. Ganancias del trabajador
-- -----------------------------------------------------------------------------
-- Una vista con lo que el trabajador necesita ver de su dinero, con el trabajo
-- al que corresponde. `security_invoker`, así que manda la RLS de `payouts`:
-- cada quien ve lo suyo y la administración lo ve todo.
drop view if exists public.worker_earnings;
create view public.worker_earnings
with (security_invoker = true) as
  select p.id,
         p.worker_id,
         p.assignment_id,
         a.job_id,
         j.reference        as job_reference,
         j.title            as job_title,
         j.starts_at        as job_starts_at,
         a.status           as assignment_status,
         p.status,
         p.gross_amount,
         p.commission_amount,
         p.bonus_amount,
         p.net_amount,
         p.currency,
         p.bank_reference,
         p.held_reason,
         p.approved_at,
         p.paid_at,
         p.created_at
    from public.payouts p
    join public.assignments a on a.id = p.assignment_id
    join public.jobs j on j.id = a.job_id;

comment on view public.worker_earnings is
  'Lo que el trabajador ha ganado, por trabajo y estado. No afirma ninguna transferencia que no esté registrada con su referencia.';

grant select on public.worker_earnings to authenticated;


-- -----------------------------------------------------------------------------
-- 8. Trabajos que necesitan una mirada: cola de la administración
-- -----------------------------------------------------------------------------
create or replace function public.admin_pending_reviews()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check_ins integer;
  v_disputes integer;
  v_payouts integer;
  v_refunds integer;
  v_extensions integer;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_check_ins from public.assignment_check_ins where review_status = 'PENDING';
  select count(*) into v_disputes from public.disputes where status in ('OPEN', 'UNDER_REVIEW');
  select count(*) into v_payouts from public.payouts where status in ('PENDING', 'APPROVED', 'HELD');
  -- Dos colas distintas de dinero por devolver: un cobro que llegó cuando el
  -- trabajo ya no lo esperaba, y una disputa resuelta con importe a favor del
  -- cliente. Ninguna de las dos ejecuta una devolución todavía.
  select (select count(*) from public.payments where status = 'UNDER_REVIEW')
       + (select count(*) from public.disputes
           where status = 'RESOLVED' and coalesce(refund_amount, 0) > 0)
    into v_refunds;
  select count(*) into v_extensions from public.job_extensions where status = 'PENDING' and expires_at > now();

  return jsonb_build_object(
    'check_ins', v_check_ins,
    'disputes', v_disputes,
    'payouts', v_payouts,
    'refunds', v_refunds,
    'extensions', v_extensions
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 8 bis. Nadie con sesión borra filas
-- -----------------------------------------------------------------------------
-- Ningún punto de la aplicación llama a `.delete()`: las bajas son cambios de
-- estado (oferta retirada, trabajo cancelado, zona de servicio reemplazada en
-- bloque por su RPC). El privilegio seguía concedido en 28 relaciones desde el
-- `grant select on all tables` de la Etapa 1, y la única barrera era que no
-- hubiera política de DELETE. Una barrera sola no basta para una baja.
do $$
declare r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v')
  loop
    execute format('revoke delete on public.%I from authenticated, anon', r.relname);
  end loop;
end $$;


-- -----------------------------------------------------------------------------
-- 9. Privilegios
-- -----------------------------------------------------------------------------
grant execute on function public.open_dispute(uuid, text, text) to authenticated;
grant execute on function public.add_dispute_evidence(uuid, text, text, text, integer) to authenticated;
grant execute on function public.resolve_dispute(uuid, public.dispute_resolution, text, bigint) to authenticated;
grant execute on function public.review_check_in(uuid, boolean, text) to authenticated;
grant execute on function public.approve_payout(uuid, text) to authenticated;
grant execute on function public.mark_payout_paid(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.hold_payout(uuid, text) to authenticated;
grant execute on function public.admin_pending_reviews() to authenticated;

revoke execute on function public.open_dispute(uuid, text, text) from anon, public;
revoke execute on function public.add_dispute_evidence(uuid, text, text, text, integer) from anon, public;
revoke execute on function public.resolve_dispute(uuid, public.dispute_resolution, text, bigint) from anon, public;
revoke execute on function public.review_check_in(uuid, boolean, text) from anon, public;
revoke execute on function public.approve_payout(uuid, text) from anon, public;
revoke execute on function public.mark_payout_paid(uuid, text, timestamptz, text) from anon, public;
revoke execute on function public.hold_payout(uuid, text) from anon, public;
revoke execute on function public.admin_pending_reviews() from anon, public;

-- Las cuatro que solo son de administración comprueban `is_admin()` en su
-- primera línea. Se conceden a `authenticated` porque no hay un rol de base
-- para la administración: el rol vive en `profiles.role`, que ningún usuario
-- puede escribir.
