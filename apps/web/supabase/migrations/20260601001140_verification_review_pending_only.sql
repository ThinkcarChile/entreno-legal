-- =============================================================================
-- HagoTuFila · Solo se revisa una verificación pendiente
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado en el código:
-- `review_worker_verification` buscaba la solicitud y la resolvía sin mirar en
-- qué estado estaba. Una solicitud ya rechazada podía aprobarse después —y con
-- ella el perfil de trabajador pasaba a VERIFIED con los documentos que se
-- habían rechazado—; una ya aprobada podía «aprobarse» de nuevo y volver a
-- avisar a la persona; y dos personas de administración resolviendo a la vez la
-- misma solicitud dejaban ganar a la última, sin que ninguna se enterara.
--
-- Ahora solo se resuelve una solicitud PENDING. La fila se bloquea antes de
-- mirar el estado, así que de dos resoluciones simultáneas una espera a la otra
-- y luego falla con el motivo. Revisar dos veces falla con un mensaje que dice
-- en qué quedó la solicitud. Para volver a evaluar a alguien rechazado, la
-- persona envía una solicitud nueva (`request_worker_verification`), que nace
-- PENDING.
--
-- Cuerpo idéntico al de …000300_accounts_and_verification.sql salvo el bloqueo
-- y la comprobación del estado.
-- =============================================================================

create or replace function public.review_worker_verification(
  p_verification_id uuid,
  p_status public.verification_status,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.worker_verifications;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración puede resolver una verificación'
      using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('VERIFIED', 'REJECTED', 'SUSPENDED') then
    raise exception 'Resolución no válida' using errcode = 'check_violation';
  end if;

  select * into v_row from public.worker_verifications
   where id = p_verification_id
     for update;
  if v_row is null then
    raise exception 'La solicitud no existe' using errcode = 'no_data_found';
  end if;

  if v_row.status <> 'PENDING' then
    raise exception 'Esta solicitud ya no está pendiente: quedó %. Solo se revisa una solicitud pendiente.',
      case v_row.status
        when 'VERIFIED' then 'aprobada'
        when 'REJECTED' then 'rechazada'
        when 'SUSPENDED' then 'suspendida'
        else lower(v_row.status::text)
      end
      using errcode = 'check_violation';
  end if;

  update public.worker_verifications
     set status = p_status,
         rejection_reason = case when p_status = 'VERIFIED' then null else p_reason end,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_verification_id;

  update public.worker_profiles
     set verification_status = p_status,
         identity_verified = (p_status = 'VERIFIED'),
         phone_verified = case when p_status = 'VERIFIED' then true else phone_verified end,
         level = case when p_status = 'VERIFIED' and level = 'NUEVO'
                      then 'VERIFICADO'::public.worker_level else level end,
         is_accepting_jobs = case when p_status = 'VERIFIED' then is_accepting_jobs else false end,
         updated_at = now()
   where user_id = v_row.user_id;

  perform app_private.notify_user(
    v_row.user_id, 'VERIFICATION_UPDATED',
    case p_status
      when 'VERIFIED' then 'Tu identidad fue verificada'
      when 'REJECTED' then 'Tu verificación fue rechazada'
      else 'Tu cuenta fue suspendida'
    end,
    case p_status
      when 'VERIFIED' then 'Ya puedes enviar ofertas y aceptar trabajos.'
      else coalesce(p_reason, 'Revisa los datos enviados y vuelve a intentarlo.')
    end,
    '/cuenta/trabajador'
  );
end;
$$;
