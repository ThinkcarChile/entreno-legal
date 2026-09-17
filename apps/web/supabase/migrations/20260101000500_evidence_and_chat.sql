-- =============================================================================
-- HagoTuFila · 500 · Evidencia, línea de tiempo y chat
-- =============================================================================
-- Decisión: una sola tabla append-only (job_evidence) es la fuente de verdad de
-- todo lo ocurrido durante un trabajo. `checkins` y `job_updates` existen como
-- VISTAS sobre ella.
--
-- Por qué: tres tablas con el mismo ciclo de vida obligarían a escribir en
-- varias al mismo tiempo y a mantenerlas sincronizadas. Una sola bitácora
-- inmutable es más simple de auditar y no puede quedar inconsistente, que es
-- justo lo que importa al resolver una disputa.
-- =============================================================================

create table public.job_evidence (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs (id) on delete cascade,
  assignment_id uuid references public.assignments (id) on delete cascade,
  author_id     uuid references public.profiles (id) on delete set null,
  -- Nombre en el momento del registro: la evidencia no cambia si el perfil cambia.
  author_name   text,
  evidence_type public.evidence_type not null,
  title         text not null,
  body          text,
  storage_path  text,
  image_url     text,
  lat           numeric(10,7),
  lng           numeric(10,7),
  accuracy_m    integer,
  -- Personas por delante en la fila, cuando aplica.
  queue_ahead   integer check (queue_ahead is null or queue_ahead >= 0),
  -- Marca de tiempo del hecho; created_at es cuándo se registró.
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index job_evidence_job_idx on public.job_evidence (job_id, occurred_at);
create index job_evidence_assignment_idx on public.job_evidence (assignment_id, occurred_at);
create index job_evidence_type_idx on public.job_evidence (evidence_type);

comment on table public.job_evidence is
  'Append-only. Corregir significa insertar una entrada nueva, nunca reescribir la anterior.';

-- Vistas compatibles con el modelo conceptual del producto.
create view public.checkins
with (security_invoker = true)
as
  select id, job_id, assignment_id, author_id as worker_id, lat, lng, accuracy_m,
         body as note, occurred_at, created_at
    from public.job_evidence
   where evidence_type = 'CHECK_IN';

create view public.job_updates
with (security_invoker = true)
as
  select id, job_id, assignment_id, author_id, author_name, title, body,
         image_url, queue_ahead, occurred_at, created_at
    from public.job_evidence
   where evidence_type in ('NOTE', 'PHOTO', 'QUEUE_STATUS', 'LOCATION', 'SYSTEM');

comment on view public.checkins is
  'Vista sobre job_evidence. security_invoker garantiza que se apliquen las RLS del usuario.';

-- -----------------------------------------------------------------------------
-- Chat por trabajo. Solo cliente y trabajador asignado.
-- -----------------------------------------------------------------------------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null unique references public.jobs (id) on delete cascade,
  assignment_id   uuid references public.assignments (id) on delete set null,
  client_id       uuid not null references public.profiles (id) on delete cascade,
  worker_id       uuid not null references public.profiles (id) on delete cascade,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index conversations_client_idx on public.conversations (client_id, last_message_at desc);
create index conversations_worker_idx on public.conversations (worker_id, last_message_at desc);

create trigger conversations_touch
  before update on public.conversations
  for each row execute function app_private.touch_updated_at();

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- NULL en mensajes automáticos del sistema.
  sender_id       uuid references public.profiles (id) on delete set null,
  message_type    public.message_type not null default 'TEXT',
  body            text check (char_length(body) <= 4000),
  storage_path    text,
  image_url       text,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),

  constraint messages_has_content check (
    body is not null or image_url is not null or storage_path is not null
  )
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- Mantiene el orden de la bandeja sin consultas caras.
create or replace function app_private.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.conversations
     set last_message_at = new.created_at, updated_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function app_private.touch_conversation();

-- Realtime: el chat se suscribe a esta tabla.
select app_private.publish_realtime('public.messages');
select app_private.publish_realtime('public.job_evidence');
