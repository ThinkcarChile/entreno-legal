-- =============================================================================
-- HagoTuFila · Una devolución parcial no deja el trabajo sin poder terminar
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría cruzada y reproducido sobre la base: las
-- devoluciones parciales con el payout todavía sin transferir se aceptan
-- (PAGOS.md §4 bis, `request_payment_refund`) y dejan el pago del trabajo en
-- PARTIALLY_REFUNDED, que el resto del sistema trata como cobro sano: la
-- barrera de la transferencia (`job_payment_blocker`), el invariante
-- `payout_without_paid_payment` y la propia cola de devoluciones. Pero dos
-- comprobaciones del recorrido exigían el pago EXACTAMENTE en PAID:
--
--   · `require_payment_before_work`, el disparador que no deja a la asignación
--     pasar a ON_THE_WAY, CHECKED_IN, IN_PROGRESS, HANDOFF_COMPLETED ni
--     COMPLETED sin el pago confirmado;
--   · `verify_handoff_code`, que repite esa condición antes de gastar un
--     intento.
--
-- Con un bono devuelto, o una devolución de buena voluntad durante el trabajo,
-- el trabajador ya no podía ponerse en camino ni validar la entrega, el
-- cliente no podía aprobar, `auto_approve_completions` saltaba la asignación en
-- cada pasada con un aviso y la ventana de disputa no empezaba nunca: solo una
-- disputa abierta por una de las partes, o SQL, lo destrababan.
--
-- Ahora las dos preguntan lo mismo, en un solo sitio:
-- `app_private.job_payment_backs_work(asignación)` — ¿hay un pago del trabajo
-- en PAID o PARTIALLY_REFUNDED? Es la misma regla de `job_payment_blocker`. Un
-- pago devuelto entero (REFUNDED), en revisión (UNDER_REVIEW), fallido o en
-- curso sigue sin dejar avanzar nada.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Una sola regla: qué pago del trabajo respalda que se trabaje
-- -----------------------------------------------------------------------------
create or replace function app_private.job_payment_backs_work(p_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.payments p
     where p.assignment_id = p_assignment_id
       and p.purpose = 'JOB'
       and p.status in ('PAID', 'PARTIALLY_REFUNDED')
  )
$$;

comment on function app_private.job_payment_backs_work is
  '¿El pago del trabajo de la asignación respalda que se trabaje? PAID o PARTIALLY_REFUNDED: la misma regla de job_payment_blocker. Devuelto entero, en revisión, fallido o en curso, no.';

revoke all on function app_private.job_payment_backs_work(uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. El disparador del recorrido
-- -----------------------------------------------------------------------------
-- Idéntico a 20260201000200 salvo la condición, que ahora es la de arriba. El
-- mensaje no cambia: es el que ya conocen la aplicación y las pruebas.
create or replace function app_private.require_payment_before_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('ON_THE_WAY', 'CHECKED_IN', 'IN_PROGRESS', 'HANDOFF_COMPLETED', 'COMPLETED')
     and old.status is distinct from new.status then
    if not app_private.job_payment_backs_work(new.id) then
      raise exception 'El trabajo no puede avanzar sin un pago confirmado'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.require_payment_before_work() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. Validar el código de entrega
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001220 salvo la comprobación del pago, marcada [Nuevo]:
-- la misma función que el disparador, comprobada antes de comparar el código
-- para no gastar un intento donde acertar fallaría igual.
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

  -- [Nuevo] La misma regla que `require_payment_before_work`, que no deja pasar
  -- a HANDOFF_COMPLETED sin ella: un pago en PAID o devuelto en parte. Un pago
  -- puede pasar a UNDER_REVIEW o devolverse entero con el trabajo en curso, así
  -- que es un estado alcanzable: se rechaza sin gastar intento.
  if not app_private.job_payment_backs_work(p_assignment_id) then
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

grant execute on function public.verify_handoff_code(uuid, text) to authenticated;
revoke execute on function public.verify_handoff_code(uuid, text) from anon, public;
