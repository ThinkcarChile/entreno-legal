-- =============================================================================
-- HagoTuFila · Pedir el código de entrega avisa una vez cada pocos minutos
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría cruzada y reproducido sobre la base: los
-- límites de 20260601001200 cubren publicar, ofertar y escribir en el chat, y
-- no las RPC que avisan a la contraparte en cada llamada.
-- `request_handoff_code` (última versión en 20260601001220) crea un aviso
-- HANDOFF_REQUESTED para el cliente cada vez que el trabajador la llama con el
-- trabajo en curso: 200 llamadas en un bucle dejaron 200 avisos en la bandeja
-- del cliente en una sola transacción, y lo mismo harían por push o correo
-- cuando esos canales se habiliten.
--
-- Ahora el aviso sale una vez por asignación cada 5 minutos. Una llamada antes
-- de tiempo se rechaza con SQLSTATE PT429 —HTTP 429 en PostgREST, como los
-- demás límites— y un mensaje que dice cuándo se puede volver a avisar. El
-- último aviso se busca en `notifications` (el índice por usuario y fecha lo
-- cubre), bajo el bloqueo de la asignación que ya toma la función: dos
-- llamadas simultáneas no pasan juntas.
--
-- Cuerpo idéntico al de 20260601001220 salvo el bloque del límite.
-- =============================================================================

create or replace function public.request_handoff_code(p_assignment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_last timestamptz;
  v_cooldown constant interval := interval '5 minutes';
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

  -- Un aviso por asignación cada `v_cooldown`. Bajo el bloqueo de la asignación.
  select max(n.created_at) into v_last
    from public.notifications n
   where n.user_id = v_a.client_id
     and n.notification_type = 'HANDOFF_REQUESTED'
     and n.href = '/mis-trabajos/' || p_assignment_id;

  if v_last is not null and v_last > now() - v_cooldown then
    raise exception 'Ya le avisamos al cliente hace un momento. Podrás volver a avisarle en %.',
      app_private.rate_limit_wait_text(v_last + v_cooldown - now())
      using errcode = 'PT429';
  end if;

  perform app_private.notify_user(
    v_a.client_id, 'HANDOFF_REQUESTED', 'Te piden el código de entrega',
    'El trabajador está listo para entregarte lo acordado.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);
end;
$$;

grant execute on function public.request_handoff_code(uuid) to authenticated;
revoke execute on function public.request_handoff_code(uuid) from anon, public;
