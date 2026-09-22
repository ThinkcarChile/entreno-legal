-- =============================================================================
-- HagoTuFila · Bloque 3 · 100 · Ejecución del trabajo, de punta a punta
-- =============================================================================
-- Hasta aquí el recorrido terminaba en «pago confirmado». Lo que venía después
-- —ir en camino, llegar, comenzar, informar, adjuntar evidencia, pedir más
-- tiempo, entregar con código y finalizar— existía a medias: las tablas estaban
-- creadas desde la Etapa 1, pero nadie las escribía, y lo poco que se escribía
-- se hacía con `UPDATE` directos desde la sesión del usuario.
--
-- Esta migración convierte ese recorrido en operaciones del servidor, con las
-- mismas reglas que el resto del sistema:
--
--   · una función por paso, atómica, que comprueba QUIÉN llama y en qué estado
--     está el trabajo antes de tocar nada;
--   · bloqueo canónico jobs → assignments → payments, el mismo de la Etapa 2.5;
--   · cada paso deja una entrada en la línea de tiempo, y esa entrada es
--     idempotente: repetir la acción no duplica eventos ni avisos;
--   · el usuario pierde la escritura directa sobre las tablas del recorrido.
--
-- Defectos reales que se cierran aquí (todos comprobados en el esquema vigente):
--
--   1. `job_extensions` tenía UPDATE concedido sobre TODAS sus columnas y una
--      política que dejaba pasar a cualquier participante. El trabajador podía
--      aceptar su propia extensión, o cambiarle el importe a una ya aceptada.
--   2. `generate_handoff_code` hacía `on conflict do update set code = code`:
--      nunca renovaba `expires_at`, así que un código vencido no se podía
--      regenerar jamás y la entrega quedaba bloqueada para siempre.
--   3. `verify_handoff_code` sumaba un intento también cuando acertaba, y una
--      segunda validación del mismo código volvía a insertar evidencia.
--   4. Las políticas de Storage `evidence_read` y `dispute_files_read` solo
--      dejaban leer al autor del archivo o a la administración: la contraparte
--      del trabajo veía la fila de evidencia pero no podía abrir la foto.
--   5. `assignments.completed_at` y `dispute_deadline_at` no los escribía nadie:
--      la ventana de disputa no se aplicaba en ninguna parte.
--   6. Quedaba UPDATE sin acotar para `authenticated` sobre `job_evidence`,
--      `handoff_codes`, `conversations`, `job_images`, `job_private_location`,
--      `dispute_evidence` y `loyalty_*`. La única barrera era que no hubiera
--      política de RLS, y eso es una barrera de una sola capa.
--
-- Privacidad de la ubicación: las coordenadas del check-in NO van a la línea de
-- tiempo. Viven en `assignment_check_ins`, que solo lee el propio trabajador y
-- la administración. El cliente ve el resultado —verificado, fuera de rango, en
-- revisión— y la distancia, nunca el punto. Ver §4.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Ajustes centrales: las tolerancias no se escriben en un componente
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column if not exists check_in_radius_m integer not null default 300,
  add column if not exists check_in_max_accuracy_m integer not null default 250,
  add column if not exists extension_max_minutes integer not null default 480,
  add column if not exists extension_window_minutes integer not null default 120,
  add column if not exists evidence_max_bytes bigint not null default 8388608,
  add column if not exists evidence_max_per_assignment integer not null default 40;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_check_in_radius_ck') then
    alter table public.platform_settings
      add constraint platform_settings_check_in_radius_ck
      check (check_in_radius_m between 50 and 5000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_check_in_accuracy_ck') then
    alter table public.platform_settings
      add constraint platform_settings_check_in_accuracy_ck
      check (check_in_max_accuracy_m between 10 and 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_extension_ck') then
    alter table public.platform_settings
      add constraint platform_settings_extension_ck
      check (extension_max_minutes between 15 and 1440 and extension_window_minutes between 15 and 1440);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_evidence_ck') then
    alter table public.platform_settings
      add constraint platform_settings_evidence_ck
      check (evidence_max_bytes between 102400 and 26214400 and evidence_max_per_assignment between 1 and 500);
  end if;
end $$;

comment on column public.platform_settings.check_in_radius_m is
  'Distancia máxima al lugar del trabajo para dar un check-in por verificado. Una sola fuente: ningún componente la lleva escrita.';
comment on column public.platform_settings.check_in_max_accuracy_m is
  'Precisión mínima aceptable del GPS. Por encima de esto, el check-in queda en revisión en vez de darse por bueno.';


-- -----------------------------------------------------------------------------
-- 2. Enumeraciones nuevas
-- -----------------------------------------------------------------------------
-- Son tipos nuevos, no valores añadidos a un enum existente, así que pueden
-- crearse y usarse en la misma transacción.
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'check_in_result') then
    create type public.check_in_result as enum (
      'VERIFIED',      -- dentro del radio y con precisión suficiente
      'OUT_OF_RANGE',  -- la posición está lejos del lugar del trabajo
      'LOW_ACCURACY',  -- el teléfono no supo ubicarse con precisión bastante
      'NO_LOCATION'    -- no hubo ubicación: rechazada, no disponible o sin permiso
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'check_in_review') then
    create type public.check_in_review as enum (
      'NOT_REQUIRED',  -- se verificó solo
      'PENDING',       -- espera una mirada de la administración
      'APPROVED',
      'REJECTED'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'evidence_visibility') then
    create type public.evidence_visibility as enum ('PARTICIPANTS', 'ADMIN_ONLY');
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 3. Columnas nuevas del recorrido
-- -----------------------------------------------------------------------------
alter table public.assignments
  add column if not exists on_the_way_at          timestamptz,
  add column if not exists expected_end_at        timestamptz,
  add column if not exists extension_minutes      integer not null default 0,
  add column if not exists completion_requested_at timestamptz,
  add column if not exists completion_note        text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assignments_extension_minutes_ck') then
    alter table public.assignments
      add constraint assignments_extension_minutes_ck check (extension_minutes >= 0);
  end if;
end $$;

comment on column public.assignments.expected_end_at is
  'Hora prevista de término = inicio real + duración acordada + extensiones aceptadas. La calcula el servidor; el contador de la interfaz se reconstruye desde aquí.';
comment on column public.assignments.extension_minutes is
  'Minutos concedidos por extensiones ACEPTADAS. El acuerdo original (agreed_duration_minutes) no se toca nunca.';

-- La línea de tiempo: un identificador de hecho para que cada hito se registre
-- una sola vez, y metadatos del archivo adjunto.
alter table public.job_evidence
  add column if not exists event_key    text,
  add column if not exists visibility   public.evidence_visibility not null default 'PARTICIPANTS',
  add column if not exists mime_type    text,
  add column if not exists size_bytes   integer;

create unique index if not exists job_evidence_event_idx
  on public.job_evidence (assignment_id, event_key)
  where event_key is not null;

comment on column public.job_evidence.event_key is
  'Identificador del hito (on_the_way, check_in, work_started…). Único por asignación: repetir la acción no duplica la línea de tiempo.';
comment on column public.job_evidence.visibility is
  'PARTICIPANTS: lo ven cliente y trabajador. ADMIN_ONLY: solo administración (revisión de un check-in, por ejemplo).';

comment on column public.job_evidence.lat is
  'Heredada de la Etapa 1 y ya sin uso: las coordenadas del check-in viven en assignment_check_ins, fuera del alcance de la contraparte.';


-- -----------------------------------------------------------------------------
-- 4. Check-in: las coordenadas no son parte de la línea de tiempo
-- -----------------------------------------------------------------------------
-- La prueba de llegada le importa a las dos partes, pero la posición exacta del
-- teléfono de una persona es dato suyo. Se separa:
--
--   · `assignment_check_ins` guarda latitud, longitud, precisión, origen,
--     resultado y distancia. Lo lee el propio trabajador y la administración.
--   · La línea de tiempo recibe «llegada registrada», con el resultado y la
--     distancia redondeada. Nunca el punto.
--
-- Esto NO impide del todo un GPS falseado: un teléfono puede mentir su
-- posición. Lo que da es un registro con hora del servidor, una distancia
-- calculada contra la dirección real y una vía de revisión manual cuando algo
-- no cuadra. Se dice así en la interfaz y en la documentación.
create table if not exists public.assignment_check_ins (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  job_id        uuid not null references public.jobs (id) on delete cascade,
  worker_id     uuid not null references public.profiles (id) on delete restrict,

  -- Consentimiento explícito, guardado con el hecho.
  consent_given boolean not null default false,
  lat           numeric(10,7),
  lng           numeric(10,7),
  accuracy_m    integer check (accuracy_m is null or accuracy_m >= 0),
  -- 'device' (el navegador), 'manual' (sin ubicación, declarada por la persona).
  source        text not null default 'device' check (source in ('device', 'manual')),

  result        public.check_in_result not null,
  distance_m    integer check (distance_m is null or distance_m >= 0),
  review_status public.check_in_review not null default 'NOT_REQUIRED',
  review_reason text,
  reviewed_by   uuid references public.profiles (id) on delete set null,
  reviewed_at   timestamptz,

  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists assignment_check_ins_assignment_idx
  on public.assignment_check_ins (assignment_id, occurred_at desc);
create index if not exists assignment_check_ins_review_idx
  on public.assignment_check_ins (review_status, created_at)
  where review_status = 'PENDING';

alter table public.assignment_check_ins enable row level security;

drop policy if exists check_ins_own_read on public.assignment_check_ins;
create policy check_ins_own_read on public.assignment_check_ins
  for select using (worker_id = auth.uid() or app_private.is_admin());

comment on table public.assignment_check_ins is
  'Ubicación de llegada del trabajador. La lee él y la administración; el cliente ve el resultado por la línea de tiempo, no el punto. Sin políticas de escritura: entra por register_check_in.';


-- -----------------------------------------------------------------------------
-- 5. La vista de check-ins deja de exponer coordenadas
-- -----------------------------------------------------------------------------
-- `public.checkins` leía `job_evidence.lat/lng`. Ahora lee la tabla nueva y
-- muestra lo que la contraparte sí puede ver: cuándo llegó y si se verificó.
drop view if exists public.checkins;
create view public.checkins
with (security_invoker = true) as
  select c.id,
         c.job_id,
         c.assignment_id,
         c.worker_id,
         c.result,
         c.distance_m,
         c.review_status,
         c.source,
         c.occurred_at,
         c.created_at
    from public.assignment_check_ins c;

comment on view public.checkins is
  'Llegadas registradas, sin coordenadas. RLS de assignment_check_ins manda: el trabajador ve las suyas y la administración todas.';


-- -----------------------------------------------------------------------------
-- 6. Se cierran las escrituras directas del recorrido
-- -----------------------------------------------------------------------------
-- A partir de aquí, avanzar un trabajo es llamar a una función. Ninguna de
-- estas tablas admite escritura con la sesión del usuario.
--
-- `assignments` conservaba UPDATE sobre (status, checked_in_at, started_at)
-- para `src/lib/actions/assignment.ts`, que escribía la hora con el reloj del
-- navegador y no comprobaba el rol más que en TypeScript. Con las funciones de
-- abajo ese privilegio sobra, y mientras existiera el CLIENTE podía marcar
-- «voy en camino» en nombre del trabajador.
revoke update (status, checked_in_at, started_at) on public.assignments from authenticated;
revoke update on public.assignments   from authenticated;
revoke update on public.job_extensions from authenticated;
revoke update on public.job_evidence   from authenticated;
revoke update on public.handoff_codes  from authenticated;
revoke update on public.conversations  from authenticated;
revoke update on public.job_images     from authenticated;
revoke update on public.job_private_location from authenticated;
revoke update on public.dispute_evidence from authenticated;
revoke update on public.loyalty_accounts from authenticated;
revoke update on public.loyalty_transactions from authenticated;
revoke update on public.audit_logs from authenticated;
revoke update on public.assignment_check_ins from authenticated;

revoke delete on public.job_extensions, public.job_evidence, public.handoff_codes,
                 public.dispute_evidence, public.loyalty_accounts, public.loyalty_transactions,
                 public.audit_logs, public.assignment_check_ins
  from authenticated;

-- La evidencia entra por `add_job_evidence`, que valida tipo, tamaño y autor.
-- El privilegio de INSERT por columnas dejaba forjar un hito del sistema
-- (`evidence_type = 'SYSTEM'`) o una entrega (`HANDOFF`) escribiendo la tabla.
revoke insert (job_id, assignment_id, author_id, evidence_type, title, body)
  on public.job_evidence from authenticated;
revoke insert on public.job_evidence from authenticated;

-- Las coordenadas heredadas de la Etapa 1 dejan de ser legibles: ya no se
-- escriben, y lo que queda de la semilla de demostración no tiene por qué
-- llegar al navegador.
revoke select on public.job_evidence from authenticated, anon;
grant select (id, job_id, assignment_id, author_id, author_name, evidence_type,
              title, body, storage_path, image_url, queue_ahead, occurred_at,
              created_at, event_key, visibility, mime_type, size_bytes)
  on public.job_evidence to authenticated;

grant select on public.assignment_check_ins to authenticated;


-- -----------------------------------------------------------------------------
-- 7. Distancia sin PostGIS
-- -----------------------------------------------------------------------------
-- Haversine sobre una esfera de 6.371 km. Para decidir si alguien está «en el
-- lugar» dentro de unos cientos de metros sobra, y evita depender de una
-- extensión que en un proyecto alojado puede no estar disponible.
create or replace function app_private.distance_m(
  p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric
)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then null
    else 6371000 * 2 * asin(sqrt(
      power(sin(radians(p_lat2 - p_lat1) / 2), 2)
      + cos(radians(p_lat1)) * cos(radians(p_lat2))
        * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
    ))
  end;
$$;

comment on function app_private.distance_m is
  'Distancia en metros entre dos coordenadas (haversine). Sin PostGIS a propósito: la precisión sobra para un radio de check-in.';


-- -----------------------------------------------------------------------------
-- 8. Línea de tiempo: un hecho, una entrada, aunque se repita la acción
-- -----------------------------------------------------------------------------
create or replace function app_private.timeline_event(
  p_job_id        uuid,
  p_assignment_id uuid,
  p_author_id     uuid,
  p_type          public.evidence_type,
  p_title         text,
  p_body          text default null,
  p_event_key     text default null,
  p_storage_path  text default null,
  p_mime_type     text default null,
  p_size_bytes    integer default null,
  p_queue_ahead   integer default null,
  p_visibility    public.evidence_visibility default 'PARTICIPANTS'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_id   uuid;
begin
  -- El nombre se congela en el momento del hecho: la evidencia no cambia si
  -- después cambia el perfil.
  select trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name_initial, ''))
    into v_name
    from public.profiles p
   where p.id = p_author_id;

  insert into public.job_evidence
    (job_id, assignment_id, author_id, author_name, evidence_type, title, body,
     event_key, storage_path, mime_type, size_bytes, queue_ahead, visibility)
  values
    (p_job_id, p_assignment_id, p_author_id, nullif(v_name, ''), p_type, p_title, p_body,
     p_event_key, p_storage_path, p_mime_type, p_size_bytes, p_queue_ahead, p_visibility)
  on conflict (assignment_id, event_key) where event_key is not null
  do nothing
  returning id into v_id;

  return v_id;
end;
$$;

comment on function app_private.timeline_event is
  'Escribe la línea de tiempo del trabajo. Con event_key el hito es único por asignación: repetir la acción no duplica la entrada.';


-- -----------------------------------------------------------------------------
-- 9. Punto de partida común de todas las funciones del recorrido
-- -----------------------------------------------------------------------------
-- Bloquea en el orden canónico jobs → assignments, comprueba que haya sesión y
-- devuelve la asignación con el papel de quien llama. Todas las funciones de
-- abajo empiezan por aquí, y por eso todas bloquean igual.
-- Devuelve la asignación ya bloqueada. El trabajo también queda bloqueado, y
-- antes que ella: quien lo necesite lo lee después sin coste, porque el bloqueo
-- ya está tomado. Se devuelve una sola fila porque PL/pgSQL no admite dos
-- variables compuestas en un mismo INTO.
create or replace function app_private.lock_assignment_for(
  p_assignment_id uuid,
  p_role text                       -- 'worker' | 'client' | 'any'
)
returns public.assignments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_job_id uuid;
  v_assignment public.assignments;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select a.job_id into v_job_id from public.assignments a where a.id = p_assignment_id;
  if v_job_id is null then
    raise exception 'No encontramos el trabajo asignado' using errcode = 'no_data_found';
  end if;

  -- Orden canónico: jobs antes que assignments, igual que en toda la Etapa 2.5.
  perform 1 from public.jobs where id = v_job_id for update;
  select * into v_assignment from public.assignments where id = p_assignment_id for update;

  if p_role = 'worker' and v_assignment.worker_id <> v_uid then
    raise exception 'Solo el trabajador asignado puede hacer esto'
      using errcode = 'insufficient_privilege';
  end if;

  if p_role = 'client' and v_assignment.client_id <> v_uid then
    raise exception 'Solo el cliente de este trabajo puede hacer esto'
      using errcode = 'insufficient_privilege';
  end if;

  if p_role = 'any' and v_uid not in (v_assignment.client_id, v_assignment.worker_id) then
    raise exception 'No participas en este trabajo'
      using errcode = 'insufficient_privilege';
  end if;

  if v_assignment.status in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER') then
    raise exception 'Este trabajo está cancelado' using errcode = 'check_violation';
  end if;

  return v_assignment;
end;
$$;


-- -----------------------------------------------------------------------------
-- 10. Voy en camino
-- -----------------------------------------------------------------------------
create or replace function public.mark_on_the_way(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_repeat boolean := false;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'worker');
  select * into v_j from public.jobs where id = v_a.job_id;

  -- Idempotente: si ya avisó, no se duplica ni el estado ni el aviso.
  if v_a.status = 'ON_THE_WAY' then
    v_repeat := true;
  elsif v_a.status <> 'CONFIRMED' then
    raise exception 'Este paso no corresponde ahora (el trabajo está en %)', v_a.status
      using errcode = 'check_violation';
  else
    update public.assignments
       set status = 'ON_THE_WAY', on_the_way_at = now(), updated_at = now()
     where id = p_assignment_id;

    perform app_private.timeline_event(
      v_j.id, p_assignment_id, v_a.worker_id, 'SYSTEM',
      'El trabajador va en camino',
      'Salió hacia el lugar del trabajo.',
      'on_the_way');

    perform app_private.notify_user(
      v_a.client_id, 'WORKER_ON_THE_WAY', 'El trabajador va en camino',
      'Te avisamos cuando llegue al lugar.',
      '/mis-trabajos/' || p_assignment_id, v_j.id);

    -- Mensaje automático en el hilo: nunca lleva ubicación ni PIN.
    insert into public.messages (conversation_id, sender_id, message_type, body)
    select c.id, v_a.worker_id, 'SYSTEM', 'Voy en camino al lugar del trabajo.'
      from public.conversations c
     where c.job_id = v_j.id and c.worker_id = v_a.worker_id and c.is_primary;
  end if;

  return jsonb_build_object(
    'assignment_status', 'ON_THE_WAY',
    'repeated', v_repeat,
    'on_the_way_at', coalesce(v_a.on_the_way_at, now())
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 11. Check-in
-- -----------------------------------------------------------------------------
-- Consentimiento explícito, hora del servidor, distancia calculada contra la
-- dirección real del trabajo. Se puede repetir: un primer intento con mala
-- señal no deja a nadie atrapado.
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
  elsif p_accuracy_m is not null and p_accuracy_m > v_settings.check_in_max_accuracy_m then
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


-- -----------------------------------------------------------------------------
-- 12. Comenzar el trabajo
-- -----------------------------------------------------------------------------
create or replace function public.start_job_work(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_ok boolean;
  v_end timestamptz;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'worker');
  select * into v_j from public.jobs where id = v_a.job_id;

  if v_a.status = 'IN_PROGRESS' then
    return jsonb_build_object('assignment_status', 'IN_PROGRESS', 'repeated', true,
                              'expected_end_at', v_a.expected_end_at);
  end if;

  if v_a.status <> 'CHECKED_IN' then
    raise exception 'Primero hay que registrar la llegada' using errcode = 'check_violation';
  end if;

  -- Un check-in verificado, o uno aprobado a mano por la administración.
  select exists (
    select 1 from public.assignment_check_ins c
     where c.assignment_id = p_assignment_id
       and (c.result = 'VERIFIED' or c.review_status = 'APPROVED')
  ) into v_ok;

  if not v_ok then
    raise exception 'La llegada todavía no está verificada. Puedes reintentar el check-in o pedir una revisión.'
      using errcode = 'check_violation';
  end if;

  v_end := now() + make_interval(mins => v_a.agreed_duration_minutes + v_a.extension_minutes);

  update public.assignments
     set status = 'IN_PROGRESS', started_at = now(), expected_end_at = v_end, updated_at = now()
   where id = p_assignment_id;

  update public.jobs set status = 'IN_PROGRESS', updated_at = now()
   where id = v_j.id and status = 'PAID';

  perform app_private.timeline_event(
    v_j.id, p_assignment_id, v_a.worker_id, 'SYSTEM',
    'Trabajo iniciado',
    'A partir de aquí corre el tiempo acordado.',
    'work_started');

  perform app_private.notify_user(
    v_a.client_id, 'JOB_STARTED', 'El trabajo comenzó',
    'Te avisaremos de cada actualización.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return jsonb_build_object('assignment_status', 'IN_PROGRESS', 'repeated', false,
                            'expected_end_at', v_end);
end;
$$;


-- -----------------------------------------------------------------------------
-- 13. Actualizaciones y evidencia
-- -----------------------------------------------------------------------------
-- Una sola puerta para lo que las dos partes suben al trabajo. Los tipos
-- reservados al sistema (CHECK_IN, HANDOFF, SYSTEM) no se aceptan aquí: si se
-- admitieran, cualquiera podría escribir un hito falso en la línea de tiempo.
create or replace function public.add_job_evidence(
  p_assignment_id uuid,
  p_evidence_type public.evidence_type,
  p_title         text,
  p_body          text default null,
  p_storage_path  text default null,
  p_mime_type     text default null,
  p_size_bytes    integer default null,
  p_queue_ahead   integer default null
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
  v_settings record;
  v_count integer;
  v_id uuid;
  v_other uuid;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'any');
  select * into v_j from public.jobs where id = v_a.job_id;

  if p_evidence_type not in ('NOTE', 'PHOTO', 'QUEUE_STATUS', 'LOCATION') then
    raise exception 'Ese tipo de evidencia lo escribe el sistema, no las personas'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'La actualización necesita un título' using errcode = 'check_violation';
  end if;

  if char_length(p_title) > 120 or char_length(coalesce(p_body, '')) > 2000 then
    raise exception 'La actualización es demasiado larga' using errcode = 'check_violation';
  end if;

  select evidence_max_bytes, evidence_max_per_assignment into v_settings
    from public.platform_settings where id;

  if p_storage_path is not null then
    -- La ruta la construye el servidor con el identificador de quien sube. Si
    -- no empieza por ahí, no es suya: se rechaza antes de guardar nada.
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
    if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > v_settings.evidence_max_bytes then
      raise exception 'El archivo supera el tamaño permitido' using errcode = 'check_violation';
    end if;
  end if;

  select count(*) into v_count from public.job_evidence
   where assignment_id = p_assignment_id and author_id = v_uid and event_key is null;
  if v_count >= v_settings.evidence_max_per_assignment then
    raise exception 'Alcanzaste el máximo de actualizaciones para este trabajo'
      using errcode = 'check_violation';
  end if;

  v_id := app_private.timeline_event(
    v_j.id, p_assignment_id, v_uid, p_evidence_type, trim(p_title), p_body,
    null, p_storage_path, p_mime_type, p_size_bytes, p_queue_ahead);

  v_other := case when v_uid = v_a.worker_id then v_a.client_id else v_a.worker_id end;

  perform app_private.notify_user(
    v_other,
    case when p_storage_path is null then 'JOB_UPDATE'::public.notification_type
         else 'NEW_EVIDENCE'::public.notification_type end,
    case when p_storage_path is null then 'Nueva actualización del trabajo'
         else 'Nueva evidencia del trabajo' end,
    trim(p_title),
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 14. Extensiones de tiempo
-- -----------------------------------------------------------------------------
-- El trabajador propone, el cliente decide. El importe lo calcula la base desde
-- la tarifa acordada: no llega del navegador ni se puede editar después.
create or replace function public.request_job_extension(
  p_assignment_id uuid,
  p_minutes       integer,
  p_reason        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_settings record;
  v_amount bigint;
  v_id uuid;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'worker');
  select * into v_j from public.jobs where id = v_a.job_id;

  if v_a.status <> 'IN_PROGRESS' then
    raise exception 'Solo se puede pedir más tiempo con el trabajo en curso'
      using errcode = 'check_violation';
  end if;

  select extension_max_minutes, extension_window_minutes into v_settings
    from public.platform_settings where id;

  if p_minutes is null or p_minutes < 15 or p_minutes > v_settings.extension_max_minutes then
    raise exception 'El tiempo adicional debe estar entre 15 y % minutos', v_settings.extension_max_minutes
      using errcode = 'check_violation';
  end if;

  if p_minutes % 15 <> 0 then
    raise exception 'El tiempo adicional se pide en bloques de 15 minutos'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.job_extensions
     where assignment_id = p_assignment_id and status = 'PENDING' and expires_at > now()
  ) then
    raise exception 'Ya hay una solicitud de tiempo adicional esperando respuesta'
      using errcode = 'check_violation';
  end if;

  -- Prorrateo por minuto sobre la tarifa acordada, redondeado al peso.
  v_amount := round(v_a.agreed_hourly_rate::numeric * p_minutes / 60.0);
  if v_amount <= 0 then
    raise exception 'El importe adicional calculado no es válido' using errcode = 'check_violation';
  end if;

  -- Las solicitudes vencidas se cierran solas al pedir una nueva.
  update public.job_extensions
     set status = 'EXPIRED', responded_at = now(), updated_at = now()
   where assignment_id = p_assignment_id and status = 'PENDING' and expires_at <= now();

  insert into public.job_extensions
    (assignment_id, requested_by, additional_minutes, hourly_rate, additional_amount,
     reason, expires_at)
  values
    (p_assignment_id, v_a.worker_id, p_minutes, v_a.agreed_hourly_rate, v_amount,
     nullif(trim(coalesce(p_reason, '')), ''),
     now() + make_interval(mins => v_settings.extension_window_minutes))
  returning id into v_id;

  perform app_private.timeline_event(
    v_j.id, p_assignment_id, v_a.worker_id, 'NOTE',
    'Tiempo adicional solicitado',
    p_minutes::text || ' minutos más' ||
      case when p_reason is null then '' else ': ' || trim(p_reason) end);

  perform app_private.notify_user(
    v_a.client_id, 'EXTENSION_REQUESTED', 'Te piden más tiempo',
    p_minutes::text || ' minutos adicionales por este trabajo.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return v_id;
end;
$$;

create or replace function public.answer_job_extension(
  p_extension_id uuid,
  p_accept       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_e public.job_extensions;
  v_assignment_id uuid;
  v_payment_id uuid;
  v_end timestamptz;
begin
  if p_accept is null then
    raise exception 'Hay que aceptar o rechazar' using errcode = 'invalid_parameter_value';
  end if;

  select assignment_id into v_assignment_id from public.job_extensions where id = p_extension_id;
  if v_assignment_id is null then
    raise exception 'La solicitud no existe' using errcode = 'no_data_found';
  end if;

  -- Orden canónico: primero trabajo y asignación, después la extensión.
  v_a := app_private.lock_assignment_for(v_assignment_id, 'client');
  select * into v_j from public.jobs where id = v_a.job_id;
  select * into v_e from public.job_extensions where id = p_extension_id for update;

  -- La respuesta es definitiva: una segunda no cambia nada, y dos simultáneas
  -- se serializan en este bloqueo.
  if v_e.status <> 'PENDING' then
    raise exception 'Esta solicitud ya fue respondida (%)' , v_e.status
      using errcode = 'check_violation';
  end if;

  if v_e.expires_at <= now() then
    update public.job_extensions
       set status = 'EXPIRED', responded_at = now(), updated_at = now()
     where id = p_extension_id;
    raise exception 'La solicitud de tiempo adicional venció' using errcode = 'check_violation';
  end if;

  if not p_accept then
    update public.job_extensions
       set status = 'REJECTED', responded_at = now(), updated_at = now()
     where id = p_extension_id;

    perform app_private.notify_user(
      v_a.worker_id, 'EXTENSION_ANSWERED', 'El cliente no aceptó más tiempo',
      'Continúa con el tiempo acordado.',
      '/mis-trabajos/' || v_assignment_id, v_j.id);

    return jsonb_build_object('status', 'REJECTED', 'payment_id', null);
  end if;

  if v_a.status <> 'IN_PROGRESS' then
    raise exception 'El trabajo ya no está en curso' using errcode = 'check_violation';
  end if;

  -- El cobro adicional es un pago APARTE, con su propio propósito. No toca el
  -- pago original ni el acuerdo inicial, y no libera nada por sí mismo: el
  -- payout solo sube cuando ese pago queda confirmado (ver §15).
  insert into public.payments
    (job_id, assignment_id, extension_id, client_id, purpose, status, amount, currency, provider)
  values
    (v_j.id, v_assignment_id, p_extension_id, v_a.client_id, 'EXTENSION', 'PENDING',
     v_e.additional_amount, v_e.currency, 'pending')
  returning id into v_payment_id;

  update public.job_extensions
     set status = 'ACCEPTED', responded_at = now(), payment_id = v_payment_id, updated_at = now()
   where id = p_extension_id;

  v_end := coalesce(v_a.expected_end_at, now()) + make_interval(mins => v_e.additional_minutes);

  update public.assignments
     set extension_minutes = extension_minutes + v_e.additional_minutes,
         expected_end_at = v_end,
         updated_at = now()
   where id = v_assignment_id;

  perform app_private.timeline_event(
    v_j.id, v_assignment_id, v_a.client_id, 'NOTE',
    'Tiempo adicional aceptado',
    v_e.additional_minutes::text || ' minutos más. Queda pendiente el pago adicional.');

  perform app_private.notify_user(
    v_a.worker_id, 'EXTENSION_ANSWERED', 'El cliente aceptó más tiempo',
    v_e.additional_minutes::text || ' minutos adicionales.',
    '/mis-trabajos/' || v_assignment_id, v_j.id);

  return jsonb_build_object('status', 'ACCEPTED', 'payment_id', v_payment_id,
                            'expected_end_at', v_end);
end;
$$;


-- -----------------------------------------------------------------------------
-- 15. El pago adicional tiene su propio camino en la guarda de liquidación
-- -----------------------------------------------------------------------------
-- `guard_payment_settlement` (Etapa 2.5) decide sobre los pagos del trabajo:
-- un PAID solo habilita si el trabajo está esperando ese pago. Un cobro de
-- EXTENSION llega con el trabajo YA en curso, así que caía en la rama de
-- «confirmación tardía» y terminaba en UNDER_REVIEW por
-- `job_not_awaiting_payment`: el cliente pagaba el tiempo adicional y el dinero
-- quedaba marcado como devolución pendiente.
--
-- Se le da su propia rama, con las mismas exigencias: la extensión tiene que
-- estar ACEPTADA y el trabajo vivo. Todo lo demás de la función queda igual,
-- incluida la decisión sobre cancelaciones. Se reescribe entera porque una
-- guarda de dinero no se parchea a trozos.
create or replace function app_private.guard_payment_settlement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_assignment public.assignments;
  v_extension public.job_extensions;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- El dinero devuelto no vuelve a estar cobrado. Aquí no hay decisión que
  -- tomar: es un error del llamante.
  if old.status in ('REFUNDED', 'PARTIALLY_REFUNDED') and new.status in ('PAID', 'FAILED', 'PENDING', 'CREATED', 'AUTHORIZED') then
    raise exception 'Un pago devuelto no cambia a %', new.status using errcode = 'check_violation';
  end if;

  -- Un pago capturado no «falla» después. Si el proveedor lo dice, es revisión.
  if new.status = 'FAILED' and old.status in ('PAID', 'UNDER_REVIEW') then
    raise exception 'Un pago ya cobrado no pasa a FAILED: pasa por revisión o reembolso'
      using errcode = 'check_violation';
  end if;

  -- Orden canónico de bloqueo: la fila de payments ya la tiene el UPDATE.
  select * into v_job from public.jobs where id = new.job_id for update;
  if new.assignment_id is not null then
    select * into v_assignment from public.assignments where id = new.assignment_id for update;
  end if;
  if new.extension_id is not null then
    select * into v_extension from public.job_extensions where id = new.extension_id for update;
  end if;

  if new.status = 'PAID' then
    -- Solo se llega a PAID desde un estado en vuelo. Una aprobación sobre un
    -- pago que ya estaba FAILED o UNDER_REVIEW es contradictoria: puede haber
    -- dinero cobrado y hay que mirarlo, pero jamás habilita nada.
    if old.status not in ('PENDING', 'CREATED', 'AUTHORIZED') then
      new.status := 'UNDER_REVIEW';
      new.review_reason := 'approved_after_' || lower(old.status::text);
      new.captured_at := coalesce(new.captured_at, now());
      new.paid_at := null;
    elsif new.purpose = 'JOB'
          and v_job.status in ('OFFER_ACCEPTED', 'PAYMENT_PENDING')
          and v_assignment.status = 'AWAITING_PAYMENT' then
      -- Camino feliz del trabajo: sigue vivo. `on_payment_paid` lo habilita.
      new.paid_at := coalesce(new.paid_at, now());
      new.captured_at := coalesce(new.captured_at, now());
      new.authorized_at := coalesce(new.authorized_at, now());
    elsif new.purpose = 'EXTENSION'
          and v_extension.id is not null
          and v_extension.status = 'ACCEPTED'
          and v_extension.assignment_id = new.assignment_id
          and v_assignment.status not in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')
          and v_job.status not in ('CANCELLED', 'CANCELLATION_PENDING', 'EXPIRED') then
      -- Tiempo adicional de un trabajo vivo: el cobro es válido. No habilita
      -- nada por sí mismo; `on_extension_paid` lo suma al payout existente.
      new.paid_at := coalesce(new.paid_at, now());
      new.captured_at := coalesce(new.captured_at, now());
      new.authorized_at := coalesce(new.authorized_at, now());
    else
      -- Confirmación tardía: el trabajo ya no espera este pago. El dinero se
      -- recibió y queda registrado para devolución. No habilita ni paga.
      new.status := 'UNDER_REVIEW';
      new.review_reason := case
        when v_job.status in ('CANCELLED', 'CANCELLATION_PENDING') then 'late_confirmation_after_cancellation'
        when new.purpose = 'EXTENSION' then 'extension_not_accepted'
        else 'job_not_awaiting_payment'
      end;
      new.captured_at := coalesce(new.captured_at, now());
      new.paid_at := null;
    end if;
  end if;

  -- Un pago del trabajo que deja de estar en vuelo resuelve la cancelación que
  -- lo esperaba. Un pago de extensión nunca decide sobre la cancelación.
  if new.purpose = 'JOB'
     and new.status in ('FAILED', 'UNDER_REVIEW')
     and v_job.status = 'CANCELLATION_PENDING' then
    perform app_private.finalize_job_cancellation(
      v_job.id,
      case when new.status = 'FAILED' then 'payment_failed' else 'late_payment_under_review' end
    );
  end if;

  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 15 bis. El pago adicional no habilita el trabajo: solo suma al payout
-- -----------------------------------------------------------------------------
-- `guard_payment_settlement` decide sobre los pagos de tipo JOB. Un pago de
-- EXTENSION no puede seguir ese camino —el trabajo ya está en curso, no
-- esperando pago— y sin esta regla terminaría en UNDER_REVIEW por
-- «job_not_awaiting_payment». Aquí se le da su propia vía: se admite si la
-- extensión está aceptada y el trabajo sigue vivo, y lo único que produce es
-- más dinero para el trabajador en el payout que ya existe.
create or replace function app_private.on_extension_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_e public.job_extensions;
  v_a public.assignments;
  v_bps integer;
  v_commission bigint;
begin
  if new.purpose <> 'EXTENSION' or new.status <> 'PAID' or old.status = 'PAID' then
    return new;
  end if;

  select * into v_e from public.job_extensions where id = new.extension_id;
  if v_e.id is null or v_e.status <> 'ACCEPTED' then
    return new;
  end if;

  select * into v_a from public.assignments where id = new.assignment_id;
  if v_a.id is null or v_a.status in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER') then
    return new;
  end if;

  v_bps := app_private.commission_bps();
  v_commission := round(new.amount::numeric * v_bps / 10000.0);

  update public.payouts
     set gross_amount = gross_amount + new.amount,
         commission_amount = commission_amount + v_commission,
         net_amount = net_amount + new.amount - v_commission,
         updated_at = now()
   where assignment_id = new.assignment_id;

  perform app_private.timeline_event(
    new.job_id, new.assignment_id, v_a.client_id, 'SYSTEM',
    'Pago del tiempo adicional confirmado',
    v_e.additional_minutes::text || ' minutos adicionales pagados.',
    'extension_paid_' || v_e.id::text);

  perform app_private.notify_user(
    v_a.worker_id, 'JOB_PAID', 'El tiempo adicional quedó pagado',
    'Se sumó a lo que recibirás por este trabajo.',
    '/mis-trabajos/' || new.assignment_id, new.job_id);

  return new;
end;
$$;

drop trigger if exists payments_on_extension_paid on public.payments;
create trigger payments_on_extension_paid
  after update on public.payments
  for each row execute function app_private.on_extension_paid();


-- -----------------------------------------------------------------------------
-- 15 ter. Arrancar el cobro del tiempo adicional
-- -----------------------------------------------------------------------------
-- Espejo de `start_protected_payment` para el pago de una extensión: devuelve
-- el pago que hay que llevar al proveedor. El importe NO llega del navegador,
-- lo fijó `answer_job_extension` desde la tarifa acordada.
create or replace function public.start_extension_payment(p_extension_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_e public.job_extensions;
  v_assignment_id uuid;
  v_payment public.payments;
begin
  select assignment_id into v_assignment_id from public.job_extensions where id = p_extension_id;
  if v_assignment_id is null then
    raise exception 'La solicitud de tiempo adicional no existe' using errcode = 'no_data_found';
  end if;

  v_a := app_private.lock_assignment_for(v_assignment_id, 'client');
  select * into v_j from public.jobs where id = v_a.job_id;
  select * into v_e from public.job_extensions where id = p_extension_id for update;

  if v_e.status <> 'ACCEPTED' then
    raise exception 'Esta solicitud no está aceptada' using errcode = 'check_violation';
  end if;
  if v_e.payment_id is null then
    raise exception 'La solicitud aceptada no tiene un cobro asociado' using errcode = 'check_violation';
  end if;

  select * into v_payment from public.payments where id = v_e.payment_id for update;

  if v_payment.status = 'PAID' then
    return v_payment.id;
  end if;
  if v_payment.status = 'UNDER_REVIEW' then
    raise exception 'Este cobro adicional está en revisión' using errcode = 'check_violation';
  end if;
  if v_payment.status = 'FAILED' then
    update public.payments set status = 'PENDING', updated_at = now() where id = v_payment.id;
  end if;

  return v_payment.id;
end;
$$;

grant execute on function public.start_extension_payment(uuid) to authenticated;
revoke execute on function public.start_extension_payment(uuid) from anon, public;


-- -----------------------------------------------------------------------------
-- 16. Código de entrega
-- -----------------------------------------------------------------------------
-- El PIN no se lee de la tabla: se pide por función. Así queda una sola vía
-- auditable, y `handoff_codes` deja de tener lectura directa para nadie.
drop policy if exists handoff_codes_client_read on public.handoff_codes;

drop policy if exists handoff_codes_admin_read on public.handoff_codes;
create policy handoff_codes_admin_read on public.handoff_codes
  for select using (app_private.is_admin());

comment on table public.handoff_codes is
  'El PIN se entrega solo por get_handoff_code (cliente) y se valida por verify_handoff_code (trabajador). Sin lectura directa: nadie lo obtiene con una consulta a la tabla.';

-- Regenerar cuando venció era imposible: la versión anterior conservaba el
-- código con `on conflict do update set code = code` y no tocaba `expires_at`.
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

  if v_a.status not in ('CHECKED_IN', 'IN_PROGRESS') then
    raise exception 'El código de entrega se genera con el trabajo en curso'
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

-- Leerlo es una operación distinta de crearlo, y también es del cliente.
create or replace function public.get_handoff_code(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_client uuid;
  v_row public.handoff_codes;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select client_id into v_client from public.assignments where id = p_assignment_id;
  if v_client is null then
    raise exception 'No encontramos el trabajo asignado' using errcode = 'no_data_found';
  end if;
  if v_client <> v_uid then
    raise exception 'Solo el cliente puede ver el código de entrega'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.handoff_codes where assignment_id = p_assignment_id;

  if v_row.assignment_id is null then
    return jsonb_build_object('exists', false);
  end if;

  return jsonb_build_object(
    'exists', true,
    'code', case when v_row.verified_at is null and v_row.expires_at > now() then v_row.code end,
    'verified', v_row.verified_at is not null,
    'expired', v_row.expires_at <= now(),
    'attempts', v_row.attempts,
    'expires_at', v_row.expires_at
  );
end;
$$;

-- El trabajador pide el código; el aviso va al cliente. El PIN nunca viaja por
-- el chat ni por la notificación.
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

  if v_a.status not in ('CHECKED_IN', 'IN_PROGRESS') then
    raise exception 'Todavía no corresponde pedir el código de entrega'
      using errcode = 'check_violation';
  end if;

  perform app_private.notify_user(
    v_a.client_id, 'HANDOFF_REQUESTED', 'Te piden el código de entrega',
    'El trabajador está listo para entregarte lo acordado.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);
end;
$$;

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

  if c.assignment_id is null then
    raise exception 'Todavía no existe un código de entrega para este trabajo'
      using errcode = 'no_data_found';
  end if;

  -- Un código usado no vuelve a servir.
  if c.verified_at is not null then
    raise exception 'Este código de entrega ya se usó' using errcode = 'check_violation';
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
-- 17. Finalización: pedirla y aprobarla son dos cosas distintas
-- -----------------------------------------------------------------------------
-- El botón del trabajador NO libera el dinero. Deja el trabajo a la espera de
-- que el cliente revise. Sin esa separación, «terminé» y «me pagan» serían la
-- misma acción decidida por una sola parte.
create or replace function public.request_job_completion(
  p_assignment_id uuid,
  p_note text default null
)
returns jsonb
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

  if v_a.status = 'HANDOFF_COMPLETED' then
    return jsonb_build_object('assignment_status', 'HANDOFF_COMPLETED', 'repeated', true);
  end if;

  if v_a.status <> 'IN_PROGRESS' then
    raise exception 'Solo se puede pedir el cierre con el trabajo en curso'
      using errcode = 'check_violation';
  end if;

  update public.assignments
     set status = 'HANDOFF_COMPLETED',
         handoff_completed_at = now(),
         completion_requested_at = now(),
         completion_note = nullif(trim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = p_assignment_id;

  update public.jobs set status = 'HANDOFF_COMPLETED', updated_at = now()
   where id = v_j.id and status in ('PAID', 'IN_PROGRESS');

  perform app_private.timeline_event(
    v_j.id, p_assignment_id, v_a.worker_id, 'SYSTEM',
    'Finalización solicitada',
    coalesce(nullif(trim(coalesce(p_note, '')), ''), 'El trabajador dio por terminado el trabajo.'),
    'completion_requested');

  perform app_private.notify_user(
    v_a.client_id, 'JOB_FINISHED', 'El trabajador terminó',
    'Revisa el trabajo y apruébalo para liberar el pago.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return jsonb_build_object('assignment_status', 'HANDOFF_COMPLETED', 'repeated', false);
end;
$$;

-- Aprobar es del cliente, y es lo que libera el payout.
create or replace function public.approve_job_completion(
  p_assignment_id uuid,
  p_bonus_awarded boolean default true
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
  v_deadline timestamptz;
  v_payout public.payouts;
  v_bonus boolean;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'client');
  select * into v_j from public.jobs where id = v_a.job_id;

  if v_a.status = 'COMPLETED' then
    return jsonb_build_object('assignment_status', 'COMPLETED', 'repeated', true);
  end if;

  if v_a.status not in ('HANDOFF_COMPLETED', 'IN_PROGRESS') then
    raise exception 'Todavía no corresponde aprobar este trabajo (está en %)', v_a.status
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Hay una disputa abierta: la resuelve la administración'
      using errcode = 'check_violation';
  end if;

  select dispute_window_hours into v_window from public.platform_settings where id;
  v_deadline := now() + make_interval(hours => v_window);
  v_bonus := v_a.bonus_amount > 0 and coalesce(p_bonus_awarded, true);

  update public.assignments
     set status = 'COMPLETED',
         completed_at = now(),
         dispute_deadline_at = v_deadline,
         bonus_awarded = case when v_a.bonus_amount > 0 then v_bonus else null end,
         updated_at = now()
   where id = p_assignment_id;

  update public.jobs set status = 'COMPLETED', updated_at = now() where id = v_j.id;

  -- El payout pasa a APROBADO: es lo máximo que puede hacer el cliente. La
  -- transferencia la registra la administración, y es manual.
  select * into v_payout from public.payouts where assignment_id = p_assignment_id for update;

  if v_payout.id is not null and v_payout.status = 'PENDING' then
    update public.payouts
       set status = 'APPROVED',
           approved_at = now(),
           bonus_amount = case when v_bonus then bonus_amount else 0 end,
           net_amount = case when v_bonus then net_amount else net_amount - v_payout.bonus_amount end,
           updated_at = now()
     where id = v_payout.id;
  end if;

  perform app_private.timeline_event(
    v_j.id, p_assignment_id, v_a.client_id, 'SYSTEM',
    'Trabajo aprobado por el cliente',
    'El pago al trabajador quedó liberado para su transferencia.',
    'completion_approved');

  perform app_private.notify_user(
    v_a.worker_id, 'JOB_APPROVED', 'El cliente aprobó el trabajo',
    'Tu pago quedó aprobado. Ya puedes dejar tu reseña.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  perform app_private.notify_user(
    v_a.client_id, 'NEW_REVIEW', 'Cuéntanos cómo te fue',
    'Tu reseña ayuda a quien contrate después.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  perform app_private.refresh_worker_stats(v_a.worker_id);

  return jsonb_build_object(
    'assignment_status', 'COMPLETED',
    'repeated', false,
    'dispute_deadline_at', v_deadline,
    'payout_status', case when v_payout.id is null then null else 'APPROVED' end
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 18. Métricas del trabajador: se calculan, no se escriben
-- -----------------------------------------------------------------------------
-- `refresh_worker_reputation` ya recalculaba la nota media desde las reseñas.
-- Faltaba todo lo demás: trabajos completados, minutos trabajados, puntualidad
-- y cumplimiento seguían en cero para siempre. Ninguna de estas columnas es
-- escribible por el usuario (la concesión de columna de `worker_profiles` solo
-- incluye titular, tarifa, disponibilidad y aceptación de trabajos).
create or replace function app_private.refresh_worker_stats(p_worker_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_completed integer;
  v_minutes integer;
  v_cancelled integer;
  v_puntuales integer;
  v_con_hora integer;
begin
  select count(*) filter (where a.status = 'COMPLETED'),
         coalesce(sum(a.agreed_duration_minutes + a.extension_minutes)
                    filter (where a.status = 'COMPLETED'), 0),
         count(*) filter (where a.status = 'CANCELLED_BY_WORKER')
    into v_completed, v_minutes, v_cancelled
    from public.assignments a
   where a.worker_id = p_worker_id;

  -- Puntualidad: de los trabajos completados con llegada registrada, en
  -- cuántos llegó antes de la hora de inicio del trabajo.
  select count(*), count(*) filter (where c.occurred_at <= j.starts_at)
    into v_con_hora, v_puntuales
    from public.assignments a
    join public.jobs j on j.id = a.job_id
    join lateral (
      select min(ci.occurred_at) as occurred_at
        from public.assignment_check_ins ci
       where ci.assignment_id = a.id
    ) c on c.occurred_at is not null
   where a.worker_id = p_worker_id and a.status = 'COMPLETED';

  update public.worker_profiles
     set completed_jobs = v_completed,
         worked_minutes = v_minutes,
         cancellation_count = v_cancelled,
         completion_rate = case when v_completed + v_cancelled = 0 then 0
                                else round(v_completed::numeric / (v_completed + v_cancelled), 3) end,
         punctuality_rate = case when v_con_hora = 0 then 0
                                 else round(v_puntuales::numeric / v_con_hora, 3) end,
         updated_at = now()
   where user_id = p_worker_id;
end;
$$;

comment on function app_private.refresh_worker_stats is
  'Recalcula trabajos completados, minutos, cancelaciones, cumplimiento y puntualidad desde los hechos. El Índice de Confianza se deriva de estas cifras en la aplicación.';


-- -----------------------------------------------------------------------------
-- 19. Reseñas por función, no por escritura directa
-- -----------------------------------------------------------------------------
revoke insert (assignment_id, author_id, subject_id, overall, punctuality,
                communication, compliance, comment)
  on public.reviews from authenticated;
revoke insert on public.reviews from authenticated;

-- Los parámetros son `integer` y no `smallint` a propósito: una llamada por
-- RPC manda números JSON, que llegan como `integer`, y con `smallint` PostgreSQL
-- no encuentra la función.
create or replace function public.submit_review(
  p_assignment_id uuid,
  p_overall       integer,
  p_punctuality   integer,
  p_communication integer,
  p_compliance    integer,
  p_comment       text default null
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
  v_subject uuid;
  v_id uuid;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'any');
  select * into v_j from public.jobs where id = v_a.job_id;

  if v_a.status <> 'COMPLETED' then
    raise exception 'Solo se puede reseñar un trabajo aprobado' using errcode = 'check_violation';
  end if;

  if p_overall is null or p_punctuality is null or p_communication is null or p_compliance is null
     or p_overall not between 1 and 5 or p_punctuality not between 1 and 5
     or p_communication not between 1 and 5 or p_compliance not between 1 and 5 then
    raise exception 'Las puntuaciones van de 1 a 5' using errcode = 'invalid_parameter_value';
  end if;

  v_subject := case when v_uid = v_a.client_id then v_a.worker_id else v_a.client_id end;

  insert into public.reviews
    (assignment_id, author_id, subject_id, overall, punctuality, communication, compliance, comment)
  values
    (p_assignment_id, v_uid, v_subject, p_overall::smallint, p_punctuality::smallint,
     p_communication::smallint, p_compliance::smallint,
     nullif(trim(coalesce(p_comment, '')), ''))
  on conflict (assignment_id, author_id) do nothing
  returning id into v_id;

  if v_id is null then
    raise exception 'Ya dejaste tu reseña de este trabajo' using errcode = 'unique_violation';
  end if;

  perform app_private.notify_user(
    v_subject, 'NEW_REVIEW', 'Recibiste una reseña',
    'Alguien con quien trabajaste dejó su evaluación.',
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 20. Storage: la contraparte tiene que poder abrir la evidencia
-- -----------------------------------------------------------------------------
-- `evidence_read` solo dejaba leer al autor del archivo. Con eso, el cliente
-- veía en la línea de tiempo que había una fotografía y no podía abrirla, que
-- es justo lo contrario de lo que la evidencia sirve.
drop policy if exists "evidence_read" on storage.objects;
create policy "evidence_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'evidence'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or app_private.is_admin()
      or exists (
        select 1 from public.job_evidence e
         where e.storage_path = storage.objects.name
           and app_private.is_job_participant(e.job_id)
      )
    )
  );

drop policy if exists "dispute_files_read" on storage.objects;
create policy "dispute_files_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'dispute-files'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or app_private.is_admin()
      or exists (
        select 1 from public.dispute_evidence de
          join public.disputes d on d.id = de.dispute_id
         where de.storage_path = storage.objects.name
           and app_private.is_assignment_participant(d.assignment_id)
      )
    )
  );


-- -----------------------------------------------------------------------------
-- 21. Privilegios de ejecución
-- -----------------------------------------------------------------------------
grant execute on function public.mark_on_the_way(uuid) to authenticated;
grant execute on function public.register_check_in(uuid, boolean, numeric, numeric, integer, text) to authenticated;
grant execute on function public.start_job_work(uuid) to authenticated;
grant execute on function public.add_job_evidence(uuid, public.evidence_type, text, text, text, text, integer, integer) to authenticated;
grant execute on function public.request_job_extension(uuid, integer, text) to authenticated;
grant execute on function public.answer_job_extension(uuid, boolean) to authenticated;
grant execute on function public.get_handoff_code(uuid) to authenticated;
grant execute on function public.request_handoff_code(uuid) to authenticated;
grant execute on function public.request_job_completion(uuid, text) to authenticated;
grant execute on function public.approve_job_completion(uuid, boolean) to authenticated;
grant execute on function public.submit_review(uuid, integer, integer, integer, integer, text) to authenticated;

-- Ninguna función nueva es ejecutable por el rol anónimo.
revoke execute on function public.mark_on_the_way(uuid) from anon, public;
revoke execute on function public.register_check_in(uuid, boolean, numeric, numeric, integer, text) from anon, public;
revoke execute on function public.start_job_work(uuid) from anon, public;
revoke execute on function public.add_job_evidence(uuid, public.evidence_type, text, text, text, text, integer, integer) from anon, public;
revoke execute on function public.request_job_extension(uuid, integer, text) from anon, public;
revoke execute on function public.answer_job_extension(uuid, boolean) from anon, public;
revoke execute on function public.get_handoff_code(uuid) from anon, public;
revoke execute on function public.request_handoff_code(uuid) from anon, public;
revoke execute on function public.request_job_completion(uuid, text) from anon, public;
revoke execute on function public.approve_job_completion(uuid, boolean) from anon, public;
revoke execute on function public.submit_review(uuid, integer, integer, integer, integer, text) from anon, public;
