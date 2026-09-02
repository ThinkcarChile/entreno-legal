-- 0054 — Conversaciones y turnos POR ACTOR, no por hogar.
--
-- La fuga que esto cierra no la vería ninguna RLS de las tablas de dominio: si
-- el papá pregunta por sus exámenes a las 10 y a las 18 conversa la hija en el
-- mismo teléfono, un contexto "del hogar" le entregaría a ella el hilo de él.
-- Las tablas clínicas siguen bien protegidas y el dato igual se filtró, porque
-- ya había salido de ellas y estaba escrito en un turno.
--
-- Por eso la conversación es de UNA persona. Ni el admin del hogar la lee: que
-- alguien administre la casa no lo hace dueño de lo que otro le preguntó al
-- asistente.
--
-- Y el chat es EFÍMERO. Lo durable es el inbox (0056). Guardar conversaciones
-- para siempre convierte un asistente en un archivo de todo lo que la familia
-- se preguntó alguna vez, que es un activo que nadie pidió y que alguien va a
-- tener que custodiar.

create table public.assistant_conversations (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.household_members (id) on delete cascade,
  titulo       text check (titulo is null or char_length(titulo) between 1 and 120),
  created_at   timestamptz not null default now(),
  last_turn_at timestamptz not null default now(),
  purge_after  timestamptz not null default now() + interval '30 days'
);

create index assistant_conv_actor
  on public.assistant_conversations (member_id, last_turn_at desc);
create index assistant_conv_purga
  on public.assistant_conversations (purge_after);

create type public.assistant_turn_role as enum ('USUARIO', 'ASISTENTE', 'HERRAMIENTA');

create table public.assistant_turns (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  rol             public.assistant_turn_role not null,
  -- Por qué capa del router pasó. 0 y 1 son código propio; 2 y 3 hablan con el
  -- proveedor. Sirve para saber cuánto del asistente es determinista de verdad.
  ruta_capa       smallint check (ruta_capa between 0 and 3),
  texto           text,
  tool_name       text,
  tool_status     text,
  -- SÓLO ids y etiquetas. Nunca valores. Un turno de herramienta que guardara
  -- lo que devolvió sería una copia sin RLS de la tabla de la que salió.
  payload_refs    jsonb not null default '{}'::jsonb,
  proposal_id     uuid references public.assistant_proposals (id) on delete set null,
  trace_id        text not null check (char_length(trace_id) between 1 and 80),
  created_at      timestamptz not null default now()
);

create index assistant_turns_conv on public.assistant_turns (conversation_id, created_at);

alter table public.assistant_conversations enable row level security;
alter table public.assistant_turns enable row level security;

-- SÓLO el autor, y sólo mientras siga siendo integrante activo del hogar. La
-- segunda mitad importa: `is_self_member` mira `user_id`, y una ficha dada de
-- baja sigue teniéndolo.
create policy assistant_conv_own on public.assistant_conversations
  for all to authenticated
  using (app.is_self_member(member_id) and app.is_household_member(household_id))
  with check (app.is_self_member(member_id) and app.is_household_member(household_id));

create policy assistant_turns_own on public.assistant_turns
  for all to authenticated
  using (exists (select 1 from public.assistant_conversations c
                  where c.id = conversation_id
                    and app.is_self_member(c.member_id)
                    and app.is_household_member(c.household_id)))
  with check (exists (select 1 from public.assistant_conversations c
                  where c.id = conversation_id
                    and app.is_self_member(c.member_id)
                    and app.is_household_member(c.household_id)));

-- Un turno escrito no se edita ni se borra: si se pudiera, la traza del
-- asistente contaría la conversación que convenga.
create or replace function app.turno_inmutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.assistant_conversations where id = old.conversation_id) then
    return case tg_op when 'DELETE' then old else new end;   -- la purga, cascada abajo
  end if;
  raise exception 'un turno no se edita ni se borra: la conversación se purga entera'
    using errcode = 'check_violation';
end;
$$;

create trigger assistant_turns_inmutables
  before update or delete on public.assistant_turns
  for each row execute function app.turno_inmutable();

/**
 * La purga. Corre por cron o mantención, JAMÁS al leer.
 *
 * Sin argumento de hogar a propósito: es una tarea del sistema, no una acción
 * de una persona, y por eso no pregunta por `auth.uid()` — pregunta por el
 * reloj. Es SECURITY DEFINER y no está expuesta a `authenticated`.
 */
create or replace function public.purge_assistant_conversations()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.assistant_conversations where purge_after <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.purge_assistant_conversations() from anon, authenticated;

comment on table public.assistant_conversations is
  'El hilo del asistente es de UNA persona, no del hogar. Ni el admin lo lee. '
  'Y es efímero: lo durable es el inbox.';
