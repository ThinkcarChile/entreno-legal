-- =============================================================================
-- HagoTuFila · El código de entrega se usa con el trabajo en curso, y solo ahí
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y reproducido sobre la base: el código
-- de entrega se ofrecía desde el check-in (`CHECKED_IN`), pero en ese estado no
-- se podía validar nunca.
--
--   · `generate_handoff_code` y `request_handoff_code` aceptaban CHECKED_IN, y la
--     interfaz mostraba el panel del código en cuanto el trabajador llegaba.
--   · `verify_handoff_code` no miraba el estado. Con el código correcto
--     intentaba pasar la asignación a HANDOFF_COMPLETED, y
--     `guard_assignment_transitions` —con razón— no admite CHECKED_IN →
--     HANDOFF_COMPLETED: la validación entera se deshacía con un error.
--   · Con un código equivocado, en cambio, sí sumaba el intento. Tras cinco
--     fallos el código quedaba bloqueado hasta caducar, 12 horas después.
--
-- Es decir: en CHECKED_IN acertar era imposible y equivocarse costaba caro.
--
-- La corrección elige el estado que ya dicen la máquina de estados y
-- docs/EJECUCION.md §8 («solo con el trabajo en curso»): el código se genera,
-- se pide y se valida con la asignación en IN_PROGRESS. No se añade la
-- transición CHECKED_IN → HANDOFF_COMPLETED: entregar sin haber comenzado
-- saltaría el inicio, que es lo que exige un check-in verificado o aprobado, y
-- el tiempo acordado no habría empezado a correr.
--
-- Y el estado se comprueba ANTES de comparar el código: en cualquier estado en
-- que validar sea imposible —antes de comenzar, con la entrega ya registrada,
-- con una disputa abierta, que congela el trabajo, o con el pago del trabajo
-- fuera de PAID, que el disparador `require_payment_before_work` no deja
-- avanzar— la función rechaza sin gastar intento. Un intento solo se consume cuando acertar habría cerrado la
-- entrega.
--
-- Reparación de datos: los intentos gastados en una asignación que sigue en
-- CHECKED_IN se gastaron, por fuerza, en el estado imposible —de IN_PROGRESS no
-- se vuelve—, así que se devuelven. Los de una asignación que ya avanzó no se
-- pueden separar de los legítimos y se dejan como están.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Generar: el cliente, con el trabajo en curso y sin disputa abierta
-- -----------------------------------------------------------------------------
create or replace function public.generate_handoff_code(p_assignment_id uuid)
returns char(4)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_code char(4);
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'client');
  select * into v_j from public.jobs where id = v_a.job_id;

  if v_a.status <> 'IN_PROGRESS' then
    raise exception 'El código de entrega se genera con el trabajo en curso'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Hay una disputa abierta: la entrega queda en pausa hasta que la administración la resuelva'
      using errcode = 'check_violation';
  end if;

  select code into v_code from public.handoff_codes
   where assignment_id = p_assignment_id and expires_at > now() and verified_at is null
   for update;

  if v_code is null then
    insert into public.handoff_codes (assignment_id, code, attempts, verified_at, expires_at)
    values (p_assignment_id, lpad((floor(random() * 10000))::int::text, 4, '0'),
            0, null, now() + interval '12 hours')
    on conflict (assignment_id) do update
      set code = lpad((floor(random() * 10000))::int::text, 4, '0'),
          attempts = 0,
          verified_at = null,
          expires_at = now() + interval '12 hours'
    returning code into v_code;

    perform app_private.timeline_event(
      v_j.id, p_assignment_id, v_a.client_id, 'SYSTEM',
      'Código de entrega generado',
      'El cliente lo comparte con el trabajador al momento de la entrega.',
      'handoff_code_generated');
  end if;

  return v_code;
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. Pedirlo: el trabajador, en el mismo estado en que se puede validar
-- -----------------------------------------------------------------------------
create or replace function public.request_handoff_code(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'worker');
  select * into v_j from public.jobs where id = v_a.job_id;

  if v_a.status <> 'IN_PROGRESS' then
    raise exception 'El código de entrega se pide con el trabajo en curso'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Hay una disputa abierta: la entrega queda en pausa hasta que la administración la resuelva'
      using errcode = 'check_violation';
  end if;

  perform app_private.notify_user(
    v_a.client_id, 'HANDOFF_REQUESTED', 'Te piden el código de entrega',
    'El trabajador está listo para entregarte lo acordado.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Validarlo: el estado primero, el código después
-- -----------------------------------------------------------------------------
create or replace function public.verify_handoff_code(p_assignment_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  c public.handoff_codes;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'worker');
  select * into v_j from public.jobs where id = v_a.job_id;

  select * into c from public.handoff_codes where assignment_id = p_assignment_id for update;

  -- Un código usado no vuelve a servir. Va primero porque es la respuesta que
  -- recibe la segunda de dos validaciones simultáneas (carrera X11).
  if c.verified_at is not null then
    raise exception 'Este código de entrega ya se usó' using errcode = 'check_violation';
  end if;

  -- Nada de lo que sigue gasta un intento si acertar no podría cerrar la entrega.
  if v_a.status in ('HANDOFF_COMPLETED', 'COMPLETED') then
    raise exception 'La entrega de este trabajo ya quedó registrada' using errcode = 'check_violation';
  end if;

  if v_a.status <> 'IN_PROGRESS' then
    raise exception 'El código de entrega se valida con el trabajo en curso. Primero comienza el trabajo.'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Hay una disputa abierta: la entrega queda en pausa hasta que la administración la resuelva'
      using errcode = 'check_violation';
  end if;

  -- Sin el pago del trabajo en PAID, `require_payment_before_work` no deja pasar
  -- a HANDOFF_COMPLETED: acertar fallaría igual que en CHECKED_IN. Un pago puede
  -- volver de PAID a UNDER_REVIEW con el trabajo en curso (lo admite
  -- `guard_payment_no_rollback`, y `hold_payout_on_unhealthy_payment` lo
  -- espera), así que es un estado alcanzable: se rechaza sin gastar intento.
  -- Es la misma condición que el disparador, comprobada antes de comparar.
  if not exists (
    select 1 from public.payments p
     where p.assignment_id = p_assignment_id and p.purpose = 'JOB' and p.status = 'PAID'
  ) then
    raise exception 'El pago de este trabajo no está confirmado: la entrega queda en pausa hasta que se resuelva'
      using errcode = 'check_violation';
  end if;

  if c.assignment_id is null then
    raise exception 'Todavía no existe un código de entrega para este trabajo'
      using errcode = 'no_data_found';
  end if;

  if c.attempts >= 5 then
    raise exception 'Demasiados intentos. Contacta a soporte.' using errcode = 'check_violation';
  end if;

  if c.expires_at < now() then
    raise exception 'El código de entrega expiró' using errcode = 'check_violation';
  end if;

  if c.code <> p_code then
    -- Solo los fallos consumen intentos.
    update public.handoff_codes set attempts = attempts + 1 where assignment_id = p_assignment_id;
    return false;
  end if;

  update public.handoff_codes
     set verified_at = now()
   where assignment_id = p_assignment_id;

  update public.assignments
     set status = 'HANDOFF_COMPLETED',
         handoff_completed_at = now(),
         completion_requested_at = coalesce(completion_requested_at, now()),
         updated_at = now()
   where id = p_assignment_id;

  update public.jobs set status = 'HANDOFF_COMPLETED', updated_at = now()
   where id = v_j.id and status in ('PAID', 'IN_PROGRESS');

  perform app_private.timeline_event(
    v_j.id, p_assignment_id, v_a.worker_id, 'HANDOFF',
    'Entrega completada',
    'Código de entrega validado por ambas partes.',
    'handoff_verified');

  perform app_private.notify_user(
    v_a.client_id, 'JOB_FINISHED', 'La entrega quedó registrada',
    'Revisa el trabajo y apruébalo para liberar el pago.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return true;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Los intentos gastados donde validar era imposible se devuelven
-- -----------------------------------------------------------------------------
update public.handoff_codes h
   set attempts = 0
  from public.assignments a
 where a.id = h.assignment_id
   and a.status = 'CHECKED_IN'
   and h.verified_at is null
   and h.attempts > 0;


-- -----------------------------------------------------------------------------
-- 5. Privilegios: los mismos de siempre, repetidos por claridad
-- -----------------------------------------------------------------------------
grant execute on function public.generate_handoff_code(uuid) to authenticated;
grant execute on function public.request_handoff_code(uuid) to authenticated;
grant execute on function public.verify_handoff_code(uuid, text) to authenticated;
revoke execute on function public.generate_handoff_code(uuid) from anon, public;
revoke execute on function public.request_handoff_code(uuid) from anon, public;
revoke execute on function public.verify_handoff_code(uuid, text) from anon, public;
