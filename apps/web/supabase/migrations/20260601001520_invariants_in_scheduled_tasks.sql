-- =============================================================================
-- HagoTuFila · Los invariantes se vigilan en producción, no solo en las pruebas
-- =============================================================================
-- Migración correctiva de 20260601000200. No la modifica.
--
-- DEFECTO: `app_private.payment_invariant_violations()` y
-- `app_private.refund_invariant_violations()` describen lo que nunca debe
-- pasar con el dinero —un payout pagable sobre un cobro devuelto, lo devuelto
-- por encima de lo cobrado, un pago fuera de la ventana sin resolver…— y solo
-- las llamaban las baterías de pruebas. En un proyecto real, si una de esas
-- reglas se rompía, nadie se enteraba hasta que un cliente o un trabajador
-- reclamara.
--
-- Qué cambia:
--
-- · `app_private.check_invariants()` corre TODAS las funciones
--   `app_private.*_invariant_violations()` —las que no reciben argumentos y
--   devuelven `(rule text, entity_id uuid)`—, cada una aislada: si una falla,
--   su error queda en el resultado y las demás corren igual. Las busca en el
--   catálogo, así que una función de invariantes nueva entra sola.
-- · Lo que encuentra queda en `app_private.integrity_alerts`, una fila por
--   regla rota (cuántos casos, hasta cinco ejemplos, desde cuándo). Una regla
--   que deja de aparecer se da por resuelta; si vuelve, es un caso nuevo.
-- · A cada administrador le llega un aviso `INTEGRITY_ALERT`
--   (20260601001500) por regla rota, como mucho uno cada 24 horas por regla
--   mientras siga rota: la fila guarda cuándo se avisó.
-- · `run_scheduled_tasks()` la llama al final, después de cerrar los pagos que
--   salieron de la ventana, y devuelve lo encontrado en la clave
--   `invariantes`. Conserva las tres tareas, su aislamiento y sus claves.
-- · `public.admin_integrity_alerts()` y `public.acknowledge_integrity_alerts()`:
--   el panel lee las reglas rotas y las marca como vistas. Solo
--   administración. Marcarlas no las arregla ni detiene el aviso diario:
--   quita la alerta roja de /admin hasta que aparezcan más casos de esa regla
--   o la regla se resuelva y vuelva.
--
-- Lo que NO hace: avisar por correo, Slack o un servicio de errores. Eso queda
-- como decisión del dueño del proyecto (docs/DESPLIEGUE-SUPABASE.md §4.4).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Qué está roto y a quién se le avisó
-- -----------------------------------------------------------------------------
-- Vive en `app_private`, que PostgREST no expone. Nadie con sesión la lee ni la
-- escribe directamente: el panel pasa por las dos funciones del final.
create table if not exists app_private.integrity_alerts (
  id                 uuid primary key default gen_random_uuid(),
  -- La función que la delata y la regla, tal como la devuelve.
  source             text not null,
  kind               text not null,
  violation_count    integer not null check (violation_count >= 0),
  sample_ids         uuid[] not null default '{}',
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  last_notified_at   timestamptz,
  acknowledged_at    timestamptz,
  acknowledged_by    uuid references public.profiles (id) on delete set null,
  -- Cuántos casos había cuando se marcó como vista: si hay más, vuelve a ser
  -- una alerta sin ver.
  acknowledged_count integer,
  resolved_at        timestamptz,
  constraint integrity_alerts_source_kind_key unique (source, kind)
);

alter table app_private.integrity_alerts enable row level security;
revoke all on app_private.integrity_alerts from public, anon, authenticated;

comment on table app_private.integrity_alerts is
  'Una fila por regla de invariante rota (función y regla). La escribe app_private.check_invariants; last_notified_at limita el aviso a uno cada 24 horas por regla.';


-- -----------------------------------------------------------------------------
-- 2. Correr los invariantes, registrar y avisar
-- -----------------------------------------------------------------------------
create or replace function app_private.check_invariants()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fn text;
  v_found jsonb;
  v_detail jsonb := '[]'::jsonb;
  v_ran text[] := '{}';
  v_errors jsonb := '[]'::jsonb;
  v_row jsonb;
  v_alert app_private.integrity_alerts;
  v_notified integer := 0;
begin
  -- Cada función, aislada: una que falla no se lleva a las demás.
  for v_fn in
    select p.proname::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
       and p.proname like '%\_invariant\_violations'
       and p.pronargs = 0
       and pg_get_function_result(p.oid) = 'TABLE(rule text, entity_id uuid)'
     order by p.proname
  loop
    begin
      execute format(
        'select coalesce(jsonb_agg(jsonb_build_object(
                  ''funcion'', %L, ''regla'', v.rule, ''casos'', v.casos, ''ejemplos'', v.ejemplos)
                  order by v.rule), ''[]''::jsonb)
           from (select x.rule,
                        count(*)::integer as casos,
                        to_jsonb((array_agg(x.entity_id order by x.entity_id))[1:5]) as ejemplos
                   from app_private.%I() x
                  group by x.rule) v',
        v_fn, v_fn)
        into v_found;
      v_detail := v_detail || v_found;
      v_ran := v_ran || v_fn;
    exception when others then
      v_errors := v_errors || jsonb_build_object('tarea', 'invariantes:' || v_fn, 'error', sqlerrm);
    end;
  end loop;

  -- Registrar y avisar, también aislado: si esto falla, lo encontrado sigue
  -- en el resultado.
  begin
    for v_row in select value from jsonb_array_elements(v_detail) loop
      insert into app_private.integrity_alerts as a (source, kind, violation_count, sample_ids)
      values (
        v_row ->> 'funcion',
        v_row ->> 'regla',
        (v_row ->> 'casos')::integer,
        array(select jsonb_array_elements_text(v_row -> 'ejemplos')::uuid)
      )
      on conflict (source, kind) do update
         set violation_count = excluded.violation_count,
             sample_ids = excluded.sample_ids,
             last_seen_at = now(),
             -- Resuelta y vuelta a romper: es un caso nuevo, nadie lo vio.
             first_seen_at = case when a.resolved_at is null then a.first_seen_at else now() end,
             acknowledged_at = case when a.resolved_at is null then a.acknowledged_at end,
             acknowledged_by = case when a.resolved_at is null then a.acknowledged_by end,
             acknowledged_count = case when a.resolved_at is null then a.acknowledged_count end,
             resolved_at = null;
    end loop;

    -- Lo que una función que SÍ corrió ya no devuelve, quedó resuelto. Lo de
    -- una función que falló no se toca: no se sabe.
    update app_private.integrity_alerts a
       set resolved_at = now()
     where a.resolved_at is null
       and a.source = any (v_ran)
       and not exists (
         select 1 from jsonb_array_elements(v_detail) d
          where d ->> 'funcion' = a.source and d ->> 'regla' = a.kind
       );

    -- Como mucho un aviso cada 24 horas por regla. El cerrojo serializa dos
    -- pasadas simultáneas: la segunda vuelve a mirar la fila y ya no avisa.
    for v_alert in
      select * from app_private.integrity_alerts
       where resolved_at is null
         and (last_notified_at is null or last_notified_at <= now() - interval '24 hours')
       order by source, kind
       for update
    loop
      perform app_private.notify_user(
        pr.id, 'INTEGRITY_ALERT',
        'Datos inconsistentes: ' || v_alert.kind,
        v_alert.violation_count
          || case when v_alert.violation_count = 1 then ' caso rompe' else ' casos rompen' end
          || ' la regla «' || v_alert.kind || '» (' || v_alert.source || '). '
          || 'Revísalo en el panel de administración antes de mover dinero sobre esos registros.',
        '/admin', null,
        jsonb_build_object('source', v_alert.source, 'kind', v_alert.kind,
                           'violation_count', v_alert.violation_count,
                           'sample_ids', to_jsonb(v_alert.sample_ids))
      )
        from public.profiles pr
       where pr.role = 'ADMIN';

      update app_private.integrity_alerts set last_notified_at = now() where id = v_alert.id;
      v_notified := v_notified + 1;
    end loop;
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'invariantes:avisos', 'error', sqlerrm);
  end;

  return jsonb_build_object(
    'violaciones', coalesce((select sum((d ->> 'casos')::integer) from jsonb_array_elements(v_detail) d), 0),
    'reglas', jsonb_array_length(v_detail),
    'detalle', v_detail,
    'funciones', to_jsonb(v_ran),
    'avisos', v_notified,
    'errores', v_errors
  );
end;
$$;

revoke all on function app_private.check_invariants() from public, anon, authenticated;

comment on function app_private.check_invariants is
  'Corre cada app_private.*_invariant_violations(), aislada; registra las reglas rotas en integrity_alerts y avisa a la administración (INTEGRITY_ALERT) como mucho una vez cada 24 horas por regla.';


-- -----------------------------------------------------------------------------
-- 3. Entrada única: las tres tareas de antes y, al final, los invariantes
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601000200 más el último bloque y la clave `invariantes`.
-- Los invariantes van después de `expire_stale_payments`: lo que esa pasada
-- cierra no es una violación, y lo que siga roto después, sí.
create or replace function app_private.run_scheduled_tasks()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_approved integer;
  v_expired integer;
  v_payments jsonb;
  v_invariants jsonb;
  v_errors jsonb := '[]'::jsonb;
begin
  begin
    v_approved := app_private.auto_approve_completions();
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'auto_approve_completions', 'error', sqlerrm);
  end;

  begin
    v_expired := app_private.expire_unassigned_jobs();
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'expire_unassigned_jobs', 'error', sqlerrm);
  end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      into v_payments
      from public.expire_stale_payments() x;
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'expire_stale_payments', 'error', sqlerrm);
  end;

  begin
    v_invariants := app_private.check_invariants();
    -- Los errores de una función de invariantes van con los demás.
    v_errors := v_errors || coalesce(v_invariants -> 'errores', '[]'::jsonb);
    v_invariants := v_invariants - 'errores';
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'invariantes', 'error', sqlerrm);
  end;

  if jsonb_array_length(v_errors) > 0 then
    raise warning 'run_scheduled_tasks: % tarea(s) con error: %', jsonb_array_length(v_errors), v_errors;
  end if;
  if coalesce((v_invariants ->> 'violaciones')::integer, 0) > 0 then
    raise warning 'run_scheduled_tasks: % violación(es) de invariantes: %',
      v_invariants ->> 'violaciones', v_invariants -> 'detalle';
  end if;

  return jsonb_build_object(
    'aprobados_automaticamente', v_approved,
    'trabajos_vencidos', v_expired,
    'pagos_fuera_de_ventana', v_payments,
    'invariantes', v_invariants,
    'errores', v_errors
  );
end;
$$;

revoke all on function app_private.run_scheduled_tasks() from public, anon, authenticated;
grant execute on function app_private.run_scheduled_tasks() to service_role;


-- -----------------------------------------------------------------------------
-- 4. Lo que ve el panel
-- -----------------------------------------------------------------------------
-- Las reglas rotas ahora mismo. Solo administración: sin el rol, lanza
-- excepción en vez de contestar «nada roto».
create or replace function public.admin_integrity_alerts()
returns table (
  alert_id         uuid,
  source           text,
  kind             text,
  violation_count  integer,
  sample_ids       uuid[],
  first_seen_at    timestamptz,
  last_seen_at     timestamptz,
  last_notified_at timestamptz,
  acknowledged_at  timestamptz,
  unacknowledged   boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración' using errcode = 'insufficient_privilege';
  end if;

  return query
    select a.id, a.source, a.kind, a.violation_count, a.sample_ids,
           a.first_seen_at, a.last_seen_at, a.last_notified_at, a.acknowledged_at,
           (a.acknowledged_at is null or a.violation_count > coalesce(a.acknowledged_count, 0))
      from app_private.integrity_alerts a
     where a.resolved_at is null
     order by a.first_seen_at, a.source, a.kind;
end;
$$;

revoke execute on function public.admin_integrity_alerts() from public, anon;
grant execute on function public.admin_integrity_alerts() to authenticated;

comment on function public.admin_integrity_alerts is
  'Reglas de invariante rotas según la última pasada de las tareas programadas. Solo administración.';

-- «Visto». No arregla nada ni detiene el aviso diario: quita la alerta roja
-- hasta que haya más casos de la regla, o hasta que se resuelva y vuelva.
create or replace function public.acknowledge_integrity_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración' using errcode = 'insufficient_privilege';
  end if;

  with vistas as (
    update app_private.integrity_alerts a
       set acknowledged_at = now(),
           acknowledged_by = auth.uid(),
           acknowledged_count = a.violation_count
     where a.resolved_at is null
       and (a.acknowledged_at is null or a.violation_count > coalesce(a.acknowledged_count, 0))
    returning a.id, a.source, a.kind, a.violation_count
  ),
  auditadas as (
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
    select auth.uid(), 'integrity_alert_acknowledged', 'integrity_alerts', v.id,
           jsonb_build_object('source', v.source, 'kind', v.kind, 'violation_count', v.violation_count)
      from vistas v
    returning 1
  )
  select count(*) into v_count from auditadas;

  return v_count;
end;
$$;

revoke execute on function public.acknowledge_integrity_alerts() from public, anon;
grant execute on function public.acknowledge_integrity_alerts() to authenticated;

comment on function public.acknowledge_integrity_alerts is
  'Marca como vistas las reglas rotas sin ver; queda en audit_logs. No las resuelve ni detiene el aviso diario. Solo administración.';
