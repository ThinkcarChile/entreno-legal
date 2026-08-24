-- Sprint 1 — Dominio Family: households, integrantes, roles, invitaciones,
-- outbox y auditoría. RLS activada en el 100% de las tablas (K-8).
-- Baseline: docs/architecture/BASELINE.md

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  locale      text not null default 'es-CL',
  timezone    text not null default 'America/Santiago',
  currency    char(3) not null default 'CLP',
  created_at  timestamptz not null default now()
);

create table public.household_members (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  user_id        uuid references auth.users (id) on delete set null,
  display_name   text not null check (char_length(display_name) between 1 and 80),
  photo_url      text,
  birth_date     date,
  sex            text check (sex in ('F', 'M', 'OTHER')),
  height_cm      numeric(5, 1) check (height_cm between 30 and 260),
  activity_level text not null default 'UNSPECIFIED'
                 check (activity_level in ('UNSPECIFIED','SEDENTARY','LIGHT','MODERATE','ACTIVE','VERY_ACTIVE')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index household_members_household_idx on public.household_members (household_id);
create unique index household_members_user_uniq
  on public.household_members (household_id, user_id) where user_id is not null;

create table public.household_roles (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references public.households (id) on delete cascade,
  code                text not null,
  name                text not null,
  is_admin            boolean not null default false,
  can_manage_members  boolean not null default false,
  can_edit_plan       boolean not null default false,
  can_manage_shopping boolean not null default false,
  can_cook            boolean not null default false,
  created_at          timestamptz not null default now(),
  unique (household_id, code)
);

create table public.member_role_assignments (
  member_id  uuid not null references public.household_members (id) on delete cascade,
  role_id    uuid not null references public.household_roles (id) on delete cascade,
  granted_by uuid references public.household_members (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (member_id, role_id)
);

create table public.invitations (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references public.households (id) on delete cascade,
  invited_member_id uuid references public.household_members (id) on delete cascade,
  email             text,
  token_hash        text not null unique,
  role_code         text not null default 'MEMBER',
  expires_at        timestamptz not null,
  created_by        uuid references public.household_members (id) on delete set null,
  created_at        timestamptz not null default now(),
  accepted_at       timestamptz,
  accepted_by       uuid references auth.users (id),
  revoked_at        timestamptz
);

create index invitations_household_idx on public.invitations (household_id);

-- Outbox (H, K-22: at-least-once delivery + idempotent effects)
create table public.domain_events (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  event_type   text not null,
  aggregate    text not null,
  payload      jsonb not null default '{}'::jsonb,
  scope        jsonb not null default '{}'::jsonb,
  dedupe_key   text not null unique,
  status       text not null default 'PENDING'
               check (status in ('PENDING','PROCESSING','PROCESSED','FAILED','DEAD')),
  attempts     int not null default 0,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);

create index domain_events_pending_idx on public.domain_events (created_at) where status = 'PENDING';

-- Auditoría append-only (sin contenido sensible: referencias por id)
create table public.audit_events (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  actor_user_id uuid,
  action        text not null,
  subject_kind  text not null,
  subject_id    uuid,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index audit_events_household_idx on public.audit_events (household_id, created_at desc);

revoke update, delete on public.audit_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Funciones de pertenencia (base de RLS)
-- ---------------------------------------------------------------------------

create or replace function app.is_household_member(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hid and m.user_id = auth.uid() and m.is_active
  );
$$;

create or replace function app.is_household_admin(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.household_members m
    join public.member_role_assignments a on a.member_id = m.id
    join public.household_roles r on r.id = a.role_id
    where m.household_id = hid and m.user_id = auth.uid() and m.is_active and r.is_admin
  );
$$;

create or replace function app.current_member_id(hid uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select m.id from public.household_members m
  where m.household_id = hid and m.user_id = auth.uid() and m.is_active
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Bootstrap: crear hogar (resuelve el huevo-gallina de RLS en INSERT)
-- Crea household + miembro del creador + roles semilla + asignación ADMIN.
-- ---------------------------------------------------------------------------

-- En schema public: las funciones RPC deben estar en el esquema expuesto por la API.
create or replace function public.create_household(p_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_member uuid;
  v_admin_role uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.households (name) values (p_name) returning id into v_household;

  insert into public.household_members (household_id, user_id, display_name)
  values (v_household, auth.uid(), p_display_name)
  returning id into v_member;

  insert into public.household_roles (household_id, code, name, is_admin, can_manage_members, can_edit_plan, can_manage_shopping, can_cook)
  values
    (v_household, 'ADMIN',   'Administrador familiar', true,  true,  true,  true,  true),
    (v_household, 'MEMBER',  'Integrante',             false, false, false, false, false),
    (v_household, 'PLANNER', 'Planificador',           false, false, true,  false, false),
    (v_household, 'SHOPPER', 'Comprador',              false, false, false, true,  false),
    (v_household, 'COOK',    'Cocinero',               false, false, false, false, true);

  select id into v_admin_role from public.household_roles
  where household_id = v_household and code = 'ADMIN';

  insert into public.member_role_assignments (member_id, role_id, granted_by)
  values (v_member, v_admin_role, v_member);

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (v_household, auth.uid(), 'HOUSEHOLD_CREATED', 'household', v_household);

  return v_household;
end;
$$;

-- ---------------------------------------------------------------------------
-- Aceptar invitación por token (el hash llega calculado desde el servidor)
-- ---------------------------------------------------------------------------

create or replace function public.accept_invitation(p_token_hash text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_inv public.invitations;
  v_member uuid;
  v_role uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_inv from public.invitations
  where token_hash = p_token_hash
    and accepted_at is null and revoked_at is null and expires_at > now()
  for update;

  if not found then
    raise exception 'invitation invalid or expired';
  end if;

  if v_inv.invited_member_id is not null then
    -- Vincular cuenta a un miembro existente sin cuenta
    update public.household_members
    set user_id = auth.uid(), updated_at = now()
    where id = v_inv.invited_member_id and user_id is null
    returning id into v_member;
    if v_member is null then
      raise exception 'member already linked';
    end if;
  else
    insert into public.household_members (household_id, user_id, display_name)
    values (v_inv.household_id, auth.uid(), coalesce(nullif(p_display_name, ''), 'Integrante'))
    returning id into v_member;
  end if;

  select id into v_role from public.household_roles
  where household_id = v_inv.household_id and code = v_inv.role_code;
  if v_role is not null then
    insert into public.member_role_assignments (member_id, role_id, granted_by)
    values (v_member, v_role, v_inv.created_by)
    on conflict do nothing;
  end if;

  update public.invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_inv.id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (v_inv.household_id, auth.uid(), 'INVITATION_ACCEPTED', 'invitation', v_inv.id);

  return v_inv.household_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: activada en todas las tablas, políticas por operación
-- ---------------------------------------------------------------------------

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_roles enable row level security;
alter table public.member_role_assignments enable row level security;
alter table public.invitations enable row level security;
alter table public.domain_events enable row level security;
alter table public.audit_events enable row level security;

-- households: leer si miembro; editar si admin; crear solo vía app.create_household
create policy households_select on public.households
  for select using (app.is_household_member(id));
create policy households_update on public.households
  for update using (app.is_household_admin(id)) with check (app.is_household_admin(id));

-- household_members: leer si miembro; insertar/borrar admin; actualizar self o admin
create policy members_select on public.household_members
  for select using (app.is_household_member(household_id));
create policy members_insert on public.household_members
  for insert with check (app.is_household_admin(household_id));
create policy members_update on public.household_members
  for update using (user_id = auth.uid() or app.is_household_admin(household_id))
  with check (user_id = auth.uid() or app.is_household_admin(household_id));
create policy members_delete on public.household_members
  for delete using (app.is_household_admin(household_id));

-- roles y asignaciones: leer miembro; escribir admin
create policy roles_select on public.household_roles
  for select using (app.is_household_member(household_id));
create policy roles_write on public.household_roles
  for all using (app.is_household_admin(household_id))
  with check (app.is_household_admin(household_id));

create policy assignments_select on public.member_role_assignments
  for select using (exists (
    select 1 from public.household_members m
    where m.id = member_id and app.is_household_member(m.household_id)));
create policy assignments_write on public.member_role_assignments
  for all using (exists (
    select 1 from public.household_members m
    where m.id = member_id and app.is_household_admin(m.household_id)))
  with check (exists (
    select 1 from public.household_members m
    where m.id = member_id and app.is_household_admin(m.household_id)));

-- invitations: solo admin (aceptación vía función definer)
create policy invitations_admin on public.invitations
  for all using (app.is_household_admin(household_id))
  with check (app.is_household_admin(household_id));

-- outbox y auditoría: lectura admin; escritura solo vía funciones definer / service role
create policy domain_events_select on public.domain_events
  for select using (app.is_household_admin(household_id));
create policy audit_events_select on public.audit_events
  for select using (app.is_household_admin(household_id));
