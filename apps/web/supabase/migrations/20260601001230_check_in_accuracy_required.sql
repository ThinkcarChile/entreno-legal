-- =============================================================================
-- HagoTuFila · Un check-in sin precisión no se da por verificado
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría: `register_check_in` solo marcaba
-- LOW_ACCURACY cuando la precisión llegaba Y superaba el máximo
-- (`p_accuracy_m is not null and p_accuracy_m > …`). Si no llegaba, la
-- comparación se saltaba y un punto dentro del radio quedaba VERIFIED. Con la
-- clave pública bastaba llamar a la RPC con coordenadas y `p_accuracy_m: null`
-- para comenzar el trabajo sin que nadie mirara nada.
--
-- El navegador siempre informa la precisión (`GeolocationCoordinates.accuracy`
-- es obligatoria), así que la aplicación no se ve afectada: una ubicación sin
-- precisión solo llega de una llamada hecha a mano. Ahora cuenta como
-- LOW_ACCURACY, queda en revisión como cualquier otro check-in dudoso, y se
-- puede reintentar o aprobar a mano igual que hasta ahora.
--
-- El resto de la función no cambia.
-- =============================================================================

create or replace function public.register_check_in(
  p_assignment_id uuid,
  p_consent       boolean,
  p_lat           numeric default null,
  p_lng           numeric default null,
  p_accuracy_m    integer default null,
  p_source        text default 'device'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_loc record;
  v_settings record;
  v_distance numeric;
  v_result public.check_in_result;
  v_review public.check_in_review;
  v_reason text;
  v_id uuid;
  v_first boolean;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'worker');
  select * into v_j from public.jobs where id = v_a.job_id;

  if not coalesce(p_consent, false) then
    raise exception 'Necesitamos tu permiso para registrar la llegada'
      using errcode = 'check_violation';
  end if;

  if p_source not in ('device', 'manual') then
    raise exception 'Origen de la ubicación no reconocido' using errcode = 'invalid_parameter_value';
  end if;

  if v_a.status not in ('CONFIRMED', 'ON_THE_WAY', 'CHECKED_IN') then
    raise exception 'El check-in no corresponde ahora (el trabajo está en %)', v_a.status
      using errcode = 'check_violation';
  end if;

  select check_in_radius_m, check_in_max_accuracy_m into v_settings
    from public.platform_settings where id;

  select lat, lng into v_loc from public.job_private_location where job_id = v_j.id;

  v_distance := app_private.distance_m(p_lat, p_lng, v_loc.lat, v_loc.lng);

  if p_lat is null or p_lng is null then
    v_result := 'NO_LOCATION';
    v_reason := 'La llegada se registró sin ubicación.';
  elsif p_accuracy_m is null then
    -- Sin precisión no se sabe cuánto vale el punto: no se da por bueno.
    v_result := 'LOW_ACCURACY';
    v_reason := 'El teléfono no informó la precisión de la ubicación.';
  elsif p_accuracy_m > v_settings.check_in_max_accuracy_m then
    v_result := 'LOW_ACCURACY';
    v_reason := 'El teléfono no pudo ubicarse con precisión suficiente.';
  elsif v_distance is null then
    -- El trabajo no tiene coordenadas guardadas: no se puede contrastar.
    v_result := 'NO_LOCATION';
    v_reason := 'El trabajo no tiene coordenadas con las que comparar.';
  elsif v_distance > v_settings.check_in_radius_m then
    v_result := 'OUT_OF_RANGE';
    v_reason := 'La ubicación quedó lejos del lugar del trabajo.';
  else
    v_result := 'VERIFIED';
    v_reason := null;
  end if;

  v_review := case when v_result = 'VERIFIED' then 'NOT_REQUIRED' else 'PENDING' end;

  insert into public.assignment_check_ins
    (assignment_id, job_id, worker_id, consent_given, lat, lng, accuracy_m, source,
     result, distance_m, review_status, review_reason)
  values
    (p_assignment_id, v_j.id, v_a.worker_id, true, p_lat, p_lng, p_accuracy_m, p_source,
     v_result, round(v_distance)::integer, v_review, v_reason)
  returning id into v_id;

  v_first := v_a.checked_in_at is null;

  if v_a.status <> 'CHECKED_IN' then
    update public.assignments
       set status = 'CHECKED_IN', checked_in_at = now(), updated_at = now()
     where id = p_assignment_id;
  end if;

  -- La línea de tiempo recibe el hecho, no el punto.
  if v_first then
    perform app_private.timeline_event(
      v_j.id, p_assignment_id, v_a.worker_id, 'CHECK_IN',
      'Llegada al lugar registrada',
      case
        when v_result = 'VERIFIED' then 'Verificada a ' || round(v_distance)::text || ' m del lugar.'
        else coalesce(v_reason, '') || ' Queda pendiente de revisión.'
      end,
      'check_in');

    perform app_private.notify_user(
      v_a.client_id, 'CHECK_IN', 'El trabajador llegó al lugar',
      case when v_result = 'VERIFIED'
           then 'La llegada quedó verificada.'
           else 'La llegada quedó registrada y en revisión.' end,
      '/mis-trabajos/' || p_assignment_id, v_j.id);
  end if;

  return jsonb_build_object(
    'check_in_id', v_id,
    'result', v_result,
    'review_status', v_review,
    'distance_m', round(v_distance)::integer,
    'can_start', v_result = 'VERIFIED'
  );
end;
$$;

grant execute on function public.register_check_in(uuid, boolean, numeric, numeric, integer, text) to authenticated;
revoke execute on function public.register_check_in(uuid, boolean, numeric, numeric, integer, text) from anon, public;
