-- =============================================================================
-- HagoTuFila · Límites por usuario para publicar, ofertar y escribir
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría: no había ningún límite por usuario. Con
-- una sola cuenta y la clave pública se podía:
--
--   · publicar cientos de trabajos en minutos (`publish_job`), que además entran
--     al listado público y al sitemap, es decir, se indexan;
--   · mandar una oferta a cada trabajo abierto del país, y cada oferta le
--     llega como aviso a su cliente;
--   · inundar una conversación con mensajes, cada uno con su notificación.
--
-- La aplicación no puede poner el límite: quien tiene una sesión llama a
-- PostgREST directo, sin pasar por ella. Por eso va en la base, en un
-- disparador BEFORE INSERT sobre `jobs`, `job_offers` y `messages`, que vale
-- para cualquier cliente.
--
-- Qué se cuenta: solo lo que hace el propio usuario con su sesión. Cada alta
-- deja una marca en `app_private.rate_limit_events`; lo que crea el sistema
-- —rol de servicio, tareas programadas, semillas— no lleva sesión y no gasta
-- cupo de nadie. Tampoco cuentan los avisos automáticos del chat (`SYSTEM`),
-- que firman las funciones de la base, ni lo que hace la administración.
--
-- Los límites viven en `platform_settings` y se cambian con un `update`, sin
-- migración. Los valores por omisión son holgados a propósito: ningún uso
-- normal se acerca, y cortan el abuso en serie.
--
--   rate_limit_jobs_per_day         30  trabajos creados en 24 horas
--   rate_limit_offers_per_hour      30  ofertas enviadas en una hora
--   rate_limit_messages_per_minute  20  mensajes escritos en un minuto
--
-- El error dice cuándo se puede volver a intentar, y sale con SQLSTATE PT429:
-- PostgREST lo devuelve como HTTP 429, que es lo que significa.
--
-- Lo que esto NO cubre, y está en docs/DESPLIEGUE-SUPABASE.md §4.5: el registro
-- y el ingreso. Esos los atiende Supabase Auth, con sus propios límites y su
-- CAPTCHA, que se configuran en el panel. Tampoco los pagos: el intento de pago
-- tiene su propia función y su propio control.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Los límites, en el mismo sitio que el resto de la configuración
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column if not exists rate_limit_jobs_per_day integer not null default 30,
  add column if not exists rate_limit_offers_per_hour integer not null default 30,
  add column if not exists rate_limit_messages_per_minute integer not null default 20;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_rate_limit_jobs_range') then
    alter table public.platform_settings
      add constraint platform_settings_rate_limit_jobs_range
      check (rate_limit_jobs_per_day between 1 and 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_rate_limit_offers_range') then
    alter table public.platform_settings
      add constraint platform_settings_rate_limit_offers_range
      check (rate_limit_offers_per_hour between 1 and 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_rate_limit_messages_range') then
    alter table public.platform_settings
      add constraint platform_settings_rate_limit_messages_range
      check (rate_limit_messages_per_minute between 1 and 600);
  end if;
end $$;

comment on column public.platform_settings.rate_limit_jobs_per_day is
  'Trabajos que una persona puede crear en 24 horas móviles. Lo impone un disparador sobre jobs; no cuenta lo que crea el sistema ni la administración.';
comment on column public.platform_settings.rate_limit_offers_per_hour is
  'Ofertas que un trabajador puede enviar en una hora móvil, retiradas incluidas. Lo impone un disparador sobre job_offers.';
comment on column public.platform_settings.rate_limit_messages_per_minute is
  'Mensajes de chat que una persona puede escribir en un minuto móvil. Los avisos automáticos (SYSTEM) no cuentan.';


-- -----------------------------------------------------------------------------
-- 2. La marca de cada alta hecha por un usuario
-- -----------------------------------------------------------------------------
-- No se cuenta sobre las tablas de negocio porque ahí no se distingue quién
-- creó la fila: un trabajo que monta el rol de servicio para una prueba, o una
-- oferta de la semilla de demostración, gastarían el cupo de esa persona.
--
-- Vive en `app_private`, que PostgREST no expone. Nadie con sesión la lee ni la
-- escribe: solo el disparador, que corre como su dueño.
create table if not exists app_private.rate_limit_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null,
  action      text not null check (action in ('job', 'offer', 'message')),
  occurred_at timestamptz not null default now()
);

create index if not exists rate_limit_events_lookup_idx
  on app_private.rate_limit_events (user_id, action, occurred_at desc);

alter table app_private.rate_limit_events enable row level security;
revoke all on app_private.rate_limit_events from public, anon, authenticated;

comment on table app_private.rate_limit_events is
  'Una fila por alta hecha por un usuario con su sesión (trabajo, oferta, mensaje). Se poda sola: cada alta borra las marcas de esa persona que ya salieron de la ventana.';


-- -----------------------------------------------------------------------------
-- 3. «Podrás volver a intentarlo en …»
-- -----------------------------------------------------------------------------
create or replace function app_private.rate_limit_wait_text(p_wait interval)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_secs bigint := greatest(ceil(extract(epoch from p_wait)), 1)::bigint;
  v_hours bigint;
  v_mins bigint;
begin
  if v_secs < 60 then
    return v_secs || case when v_secs = 1 then ' segundo' else ' segundos' end;
  end if;
  if v_secs < 3600 then
    v_mins := ceil(v_secs / 60.0)::bigint;
    return v_mins || case when v_mins = 1 then ' minuto' else ' minutos' end;
  end if;
  v_hours := v_secs / 3600;
  v_mins := ceil((v_secs - v_hours * 3600) / 60.0)::bigint;
  if v_mins = 60 then
    v_hours := v_hours + 1;
    v_mins := 0;
  end if;
  return v_hours || ' h' || case when v_mins > 0 then ' ' || v_mins || ' min' else '' end;
end;
$$;

comment on function app_private.rate_limit_wait_text is
  'Espera en palabras para el mensaje de límite: «40 segundos», «12 minutos», «3 h 20 min». Siempre redondea hacia arriba: nunca promete antes de tiempo.';


-- -----------------------------------------------------------------------------
-- 4. El disparador
-- -----------------------------------------------------------------------------
-- Un candado consultivo por persona y acción serializa dos altas simultáneas de
-- la misma persona: sin él, las dos verían el mismo recuento y pasarían juntas
-- el último cupo. No bloquea a nadie más.
create or replace function app_private.enforce_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text := tg_argv[0];
  v_uid    uuid := auth.uid();
  v_owner  uuid;
  v_limit  integer;
  v_window interval;
  v_count  integer;
  v_next   timestamptz;
  v_wait   text;
begin
  -- Sin sesión no hay a quién limitar: es el rol de servicio, una tarea
  -- programada o una migración.
  if v_uid is null then
    return new;
  end if;

  -- El dueño de la fila, según la tabla. Cada asignación se evalúa por separado,
  -- así que referirse a una columna que la otra tabla no tiene no falla.
  if v_action = 'job' then
    v_owner := new.client_id;
  elsif v_action = 'offer' then
    v_owner := new.worker_id;
  elsif v_action = 'message' then
    -- Los avisos automáticos los escriben las funciones de la base, a veces
    -- firmados por el trabajador (`mark_on_the_way`). No son escritura suya.
    if new.message_type = 'SYSTEM' then
      return new;
    end if;
    v_owner := new.sender_id;
  else
    raise exception 'Acción de límite desconocida: %', v_action;
  end if;

  -- Una fila a nombre de otra persona no es algo que esta persona hizo por sí
  -- misma; RLS ya impide que un usuario la escriba directamente.
  if v_owner is distinct from v_uid then
    return new;
  end if;

  if app_private.is_admin(v_uid) then
    return new;
  end if;

  select case v_action
           when 'job' then s.rate_limit_jobs_per_day
           when 'offer' then s.rate_limit_offers_per_hour
           else s.rate_limit_messages_per_minute
         end
    into v_limit
    from public.platform_settings s
   where s.id;

  if v_limit is null then
    return new;
  end if;

  v_window := case v_action
                when 'job' then interval '24 hours'
                when 'offer' then interval '1 hour'
                else interval '1 minute'
              end;

  perform pg_advisory_xact_lock(hashtextextended('rate_limit:' || v_action || ':' || v_uid::text, 0));

  select count(*) into v_count
    from app_private.rate_limit_events e
   where e.user_id = v_uid and e.action = v_action and e.occurred_at > now() - v_window;

  if v_count >= v_limit then
    -- El cupo se libera cuando la marca número `v_limit`, contando desde la más
    -- reciente, sale de la ventana.
    select e.occurred_at + v_window into v_next
      from app_private.rate_limit_events e
     where e.user_id = v_uid and e.action = v_action and e.occurred_at > now() - v_window
     order by e.occurred_at desc
    offset v_limit - 1
     limit 1;

    v_wait := app_private.rate_limit_wait_text(coalesce(v_next, now() + v_window) - now());

    if v_action = 'job' then
      raise exception 'Alcanzaste el máximo de % trabajos publicados en 24 horas. Podrás publicar otro en %.',
        v_limit, v_wait
        using errcode = 'PT429', detail = 'retry_at=' || coalesce(v_next, now() + v_window)::text;
    elsif v_action = 'offer' then
      raise exception 'Alcanzaste el máximo de % ofertas en una hora. Podrás enviar otra en %.',
        v_limit, v_wait
        using errcode = 'PT429', detail = 'retry_at=' || coalesce(v_next, now() + v_window)::text;
    else
      raise exception 'Estás enviando mensajes muy seguido. Podrás escribir de nuevo en %.',
        v_wait
        using errcode = 'PT429', detail = 'retry_at=' || coalesce(v_next, now() + v_window)::text;
    end if;
  end if;

  insert into app_private.rate_limit_events (user_id, action) values (v_uid, v_action);

  -- Poda: lo que ya salió de la ventana no vuelve a contar.
  delete from app_private.rate_limit_events e
   where e.user_id = v_uid and e.action = v_action and e.occurred_at <= now() - v_window;

  return new;
end;
$$;

comment on function app_private.enforce_rate_limit is
  'BEFORE INSERT en jobs, job_offers y messages. Limita lo que una persona crea con su sesión según platform_settings.rate_limit_*. Sin sesión, la administración y los avisos SYSTEM quedan fuera. Error con SQLSTATE PT429 (HTTP 429 en PostgREST).';

drop trigger if exists jobs_rate_limit on public.jobs;
create trigger jobs_rate_limit
  before insert on public.jobs
  for each row execute function app_private.enforce_rate_limit('job');

drop trigger if exists job_offers_rate_limit on public.job_offers;
create trigger job_offers_rate_limit
  before insert on public.job_offers
  for each row execute function app_private.enforce_rate_limit('offer');

drop trigger if exists messages_rate_limit on public.messages;
create trigger messages_rate_limit
  before insert on public.messages
  for each row execute function app_private.enforce_rate_limit('message');

-- Ninguna de las dos se llama a mano. El disparador no necesita el privilegio
-- de ejecución de quien inserta.
revoke all on function app_private.enforce_rate_limit() from public, anon, authenticated;
revoke all on function app_private.rate_limit_wait_text(interval) from public, anon, authenticated;
