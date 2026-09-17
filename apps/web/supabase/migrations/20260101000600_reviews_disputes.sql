-- =============================================================================
-- HagoTuFila · 600 · Reseñas y disputas
-- =============================================================================

-- Solo quien participó en un trabajo completado puede reseñar. La restricción es
-- estructural: la reseña cuelga de la asignación, no del perfil.
create table public.reviews (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  author_id     uuid not null references public.profiles (id) on delete cascade,
  subject_id    uuid not null references public.profiles (id) on delete cascade,
  punctuality   smallint not null check (punctuality between 1 and 5),
  communication smallint not null check (communication between 1 and 5),
  compliance    smallint not null check (compliance between 1 and 5),
  overall       smallint not null check (overall between 1 and 5),
  comment       text check (char_length(comment) <= 1000),
  is_hidden     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Una reseña por persona y trabajo.
  unique (assignment_id, author_id),
  constraint reviews_no_self_review check (author_id <> subject_id)
);

create index reviews_subject_idx on public.reviews (subject_id, created_at desc);

create trigger reviews_touch
  before update on public.reviews
  for each row execute function app_private.touch_updated_at();

-- Impide reseñas de quien no participó o de trabajos no completados.
create or replace function app_private.validate_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  select * into a from public.assignments where id = new.assignment_id;

  if a is null then
    raise exception 'La asignación no existe';
  end if;

  if a.status <> 'COMPLETED' then
    raise exception 'Solo se puede reseñar un trabajo completado';
  end if;

  if new.author_id not in (a.client_id, a.worker_id) then
    raise exception 'Solo los participantes del trabajo pueden reseñar';
  end if;

  if new.subject_id not in (a.client_id, a.worker_id) then
    raise exception 'Solo se puede reseñar a la contraparte del trabajo';
  end if;

  return new;
end;
$$;

create trigger reviews_validate
  before insert on public.reviews
  for each row execute function app_private.validate_review();

-- Recalcula la instantánea de reputación del trabajador.
create or replace function app_private.refresh_worker_reputation(p_worker_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.worker_profiles w
     set average_rating = coalesce(agg.avg_overall, 0),
         review_count   = coalesce(agg.n, 0),
         communication_rate = coalesce(agg.avg_communication / 5.0, 0),
         updated_at = now()
    from (
      select avg(overall)::numeric(3,2) as avg_overall,
             avg(communication)::numeric(4,3) as avg_communication,
             count(*) as n
        from public.reviews
       where subject_id = p_worker_id and not is_hidden
    ) agg
   where w.user_id = p_worker_id;
end;
$$;

create or replace function app_private.on_review_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app_private.refresh_worker_reputation(coalesce(new.subject_id, old.subject_id));
  return coalesce(new, old);
end;
$$;

create trigger reviews_refresh_reputation
  after insert or update or delete on public.reviews
  for each row execute function app_private.on_review_change();

-- -----------------------------------------------------------------------------
-- Disputas
-- -----------------------------------------------------------------------------
create table public.disputes (
  id               uuid primary key default gen_random_uuid(),
  assignment_id    uuid not null references public.assignments (id) on delete restrict,
  opened_by        uuid not null references public.profiles (id) on delete restrict,
  status           public.dispute_status not null default 'OPEN',
  reason           text not null,
  description      text not null check (char_length(description) >= 20),
  resolution       public.dispute_resolution,
  resolution_notes text,
  -- Monto devuelto al cliente en una resolución parcial.
  refund_amount    bigint check (refund_amount is null or refund_amount >= 0),
  currency         char(3) not null default 'CLP',
  resolved_by      uuid references public.profiles (id) on delete set null,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint disputes_resolution_required check (
    status <> 'RESOLVED' or resolution is not null
  )
);

create index disputes_assignment_idx on public.disputes (assignment_id);
create index disputes_status_idx on public.disputes (status, created_at);

create trigger disputes_touch
  before update on public.disputes
  for each row execute function app_private.touch_updated_at();

-- Evidencia de la disputa. Append-only y nunca se elimina.
create table public.dispute_evidence (
  id           uuid primary key default gen_random_uuid(),
  dispute_id   uuid not null references public.disputes (id) on delete restrict,
  author_id    uuid references public.profiles (id) on delete set null,
  author_role  public.app_role,
  body         text,
  storage_path text,
  file_url     text,
  created_at   timestamptz not null default now()
);

create index dispute_evidence_dispute_idx on public.dispute_evidence (dispute_id, created_at);

comment on table public.dispute_evidence is
  'Nunca se borra evidencia relacionada con disputas. ON DELETE RESTRICT es deliberado.';

-- Al abrir una disputa el payout queda retenido.
create or replace function app_private.hold_payout_on_dispute()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payouts
     set status = 'HELD',
         held_reason = 'Disputa abierta',
         updated_at = now()
   where assignment_id = new.assignment_id
     and status in ('PENDING', 'APPROVED');

  update public.jobs j
     set status = 'DISPUTED', updated_at = now()
    from public.assignments a
   where a.id = new.assignment_id and j.id = a.job_id;

  return new;
end;
$$;

create trigger disputes_hold_payout
  after insert on public.disputes
  for each row execute function app_private.hold_payout_on_dispute();
