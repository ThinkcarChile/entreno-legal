-- Sprint 11 — Salud (parte 2): condiciones, restricciones clínicas, reglas
-- versionadas, evaluaciones de comida e impact reviews.
--
-- Principios (ADR 0012):
--  · DIAGNOSIS != NUTRITION RULE: una condición registrada jamás genera
--    límites sola; los límites nacen de restricciones CONFIRMADAS con fuente.
--  · Reglas versionadas e inmutables tras publicar: la historia cita su
--    versión; publicar v2 no reescribe lo evaluado con v1.
--  · Nueva información clínica genera IMPACTO (revisable), nunca reescritura
--    silenciosa de semanas confirmadas, inventario, paquetes ni historia.
--  · El estado clínico del serving es el ÚNICO dato visible sin grant
--    (divulgación mínima para cocina/planner): categórico, sin valores.

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------

create type public.clinical_severity as enum
  ('INFO', 'CAUTION', 'HARD', 'CRITICAL_REVIEW');

create type public.clinical_restriction_type as enum
  ('NUTRIENT_MAX', 'NUTRIENT_MIN', 'INGREDIENT_EXCLUDE', 'CATEGORY_EXCLUDE',
   'PORTION_MAX', 'PORTION_MIN', 'MEAL_REQUIREMENT', 'REVIEW_REQUIRED', 'OTHER');

create type public.clinical_source as enum
  ('CLINICIAN_ENTERED', 'DIETITIAN_ENTERED', 'VALIDATED_PROTOCOL', 'USER_CONFIRMED_LIMIT');

create type public.clinical_verification as enum
  ('UNVERIFIED', 'CONFIRMED', 'RETIRED');

create type public.clinical_assessment_status as enum
  ('COMPATIBLE', 'COMPATIBLE_WITH_CAUTION', 'REVIEW_REQUIRED', 'CLINICALLY_INVALIDATED');

create type public.clinical_rule_status as enum
  ('DRAFT', 'PUBLISHED', 'RETIRED');

create type public.impact_review_status as enum
  ('PENDING', 'REVIEWED', 'APPLIED', 'DISMISSED');

-- ---------------------------------------------------------------------------
-- 1. Condiciones declaradas (registro, JAMÁS generador de reglas)
-- ---------------------------------------------------------------------------

create table public.member_conditions (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.household_members (id) on delete cascade,
  label        text not null,
  code         text,
  declared_by  uuid references public.household_members (id) on delete set null,
  confirmed_by text,   -- profesional que la confirmó, si aplica (texto libre)
  notes        text,
  declared_at  timestamptz not null default now()
);

alter table public.member_conditions enable row level security;
create policy member_conditions_select on public.member_conditions
  for select to authenticated
  using (app.medical_access(member_id, 'VIEW_CLINICAL_RESTRICTIONS'));
create policy member_conditions_write on public.member_conditions
  for all to authenticated
  using (app.medical_access(member_id, 'MANAGE_CLINICAL_RESTRICTIONS'))
  with check (app.medical_access(member_id, 'MANAGE_CLINICAL_RESTRICTIONS'));

comment on table public.member_conditions is
  'Condición declarada/confirmada. NO autoriza a inventar límites: esos nacen '
  'solo de member_clinical_restrictions confirmadas con fuente.';

-- ---------------------------------------------------------------------------
-- 2. Reglas clínicas versionadas (inmutables tras publicar)
-- ---------------------------------------------------------------------------

create table public.clinical_rule_sets (
  id           uuid primary key default gen_random_uuid(),
  -- NULL = regla global del sistema (curada); con valor = del hogar.
  household_id uuid references public.households (id) on delete cascade,
  code         text not null,
  name         text not null,
  created_at   timestamptz not null default now()
);
create unique index clinical_rule_sets_global_uniq
  on public.clinical_rule_sets (code) where household_id is null;
create unique index clinical_rule_sets_hh_uniq
  on public.clinical_rule_sets (household_id, code) where household_id is not null;

create table public.clinical_rule_versions (
  id               uuid primary key default gen_random_uuid(),
  rule_set_id      uuid not null references public.clinical_rule_sets (id) on delete cascade,
  version          int not null check (version > 0),
  status           public.clinical_rule_status not null default 'DRAFT',
  source           public.clinical_source not null,
  source_reference text,
  effective_from   date,
  effective_until  date,
  -- Lógica DECLARATIVA que el motor determinista interpreta. Jamás código.
  logic            jsonb not null default '{}'::jsonb,
  required_inputs  jsonb not null default '[]'::jsonb,
  outputs          jsonb not null default '{}'::jsonb,
  reviewed_by      text,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (rule_set_id, version)
);

/** Inmutabilidad (§23/§60): publicada = solo puede pasar a RETIRED. */
create or replace function app.protect_published_rule()
returns trigger language plpgsql as $$
begin
  if old.status = 'PUBLISHED' then
    if new.status = 'RETIRED'
       and new.logic = old.logic and new.required_inputs = old.required_inputs
       and new.outputs = old.outputs and new.source = old.source
       and new.version = old.version and new.rule_set_id = old.rule_set_id
       and new.published_at = old.published_at then
      return new;  -- retirar está permitido; editar la lógica no.
    end if;
    raise exception 'una versión publicada es inmutable: crea una versión nueva';
  end if;
  return new;
end;
$$;
create trigger clinical_rule_versions_immutable
  before update on public.clinical_rule_versions
  for each row execute function app.protect_published_rule();

create or replace function app.deny_published_rule_delete()
returns trigger language plpgsql as $$
begin
  if old.status = 'PUBLISHED' then
    raise exception 'una versión publicada es historia: no se borra';
  end if;
  return old;
end;
$$;
create trigger clinical_rule_versions_no_delete
  before delete on public.clinical_rule_versions
  for each row execute function app.deny_published_rule_delete();

alter table public.clinical_rule_sets enable row level security;
alter table public.clinical_rule_versions enable row level security;
create policy rule_sets_select on public.clinical_rule_sets
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy rule_versions_select on public.clinical_rule_versions
  for select to authenticated
  using (exists (
    select 1 from public.clinical_rule_sets s
    where s.id = rule_set_id
      and (s.household_id is null or app.is_household_member(s.household_id))
  ));
-- Escritura de reglas SOLO por RPC.

create or replace function public.create_clinical_rule_version(
  p_code             text,
  p_name             text,
  p_source           public.clinical_source,
  p_source_reference text,
  p_logic            jsonb,
  p_required_inputs  jsonb,
  p_reviewed_by      text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_hogar uuid;
  v_set uuid;
  v_next int;
  v_id uuid;
begin
  select household_id into v_hogar from public.household_members
  where user_id = auth.uid() and is_active order by created_at limit 1;
  if v_hogar is null then raise exception 'no autorizado'; end if;

  select id into v_set from public.clinical_rule_sets
  where household_id = v_hogar and code = p_code;
  if v_set is null then
    insert into public.clinical_rule_sets (household_id, code, name)
    values (v_hogar, p_code, p_name) returning id into v_set;
  end if;

  select coalesce(max(version), 0) + 1 into v_next
  from public.clinical_rule_versions where rule_set_id = v_set;

  insert into public.clinical_rule_versions
    (rule_set_id, version, source, source_reference, logic, required_inputs, reviewed_by)
  values
    (v_set, v_next, p_source, p_source_reference,
     coalesce(p_logic, '{}'::jsonb), coalesce(p_required_inputs, '[]'::jsonb), p_reviewed_by)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.publish_clinical_rule_version(p_version_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_v public.clinical_rule_versions;
  v_hogar uuid;
begin
  select v.* into v_v from public.clinical_rule_versions v where v.id = p_version_id for update;
  if v_v.id is null then raise exception 'no autorizado'; end if;
  select household_id into v_hogar from public.clinical_rule_sets where id = v_v.rule_set_id;
  if v_hogar is null or not app.is_household_member(v_hogar) then
    raise exception 'no autorizado';
  end if;
  if v_v.status = 'PUBLISHED' then return; end if; -- idempotente
  if v_v.status = 'RETIRED' then
    raise exception 'una versión retirada no se republica: crea una nueva';
  end if;

  -- Publicar v_N retira la vigencia de la anterior SIN tocar su contenido.
  update public.clinical_rule_versions
  set status = 'RETIRED', effective_until = current_date
  where rule_set_id = v_v.rule_set_id and status = 'PUBLISHED' and id <> p_version_id;

  update public.clinical_rule_versions
  set status = 'PUBLISHED', published_at = now(),
      effective_from = coalesce(effective_from, current_date)
  where id = p_version_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_hogar, auth.uid(), 'CLINICAL_RULE_PUBLISHED', 'clinical_rule_version', p_version_id,
          jsonb_build_object('version', v_v.version));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Restricciones clínicas por integrante
-- ---------------------------------------------------------------------------

create table public.member_clinical_restrictions (
  id                  uuid primary key default gen_random_uuid(),
  member_id           uuid not null references public.household_members (id) on delete cascade,
  type                public.clinical_restriction_type not null,
  -- Objetivo de la restricción: clave de nutriente ('sodium_mg'…), uuid de
  -- alimento/categoría, o texto libre según el tipo.
  target              text not null,
  value               numeric(12, 4),
  unit                text,
  severity            public.clinical_severity not null,
  source              public.clinical_source not null,
  source_reference    text,
  rule_version_id     uuid references public.clinical_rule_versions (id) on delete set null,
  valid_from          date not null default current_date,
  valid_until         date,
  verification_status public.clinical_verification not null default 'UNVERIFIED',
  created_by          uuid references public.household_members (id) on delete set null,
  confirmed_by        uuid references public.household_members (id) on delete set null,
  confirmed_at        timestamptz,
  reason              text,
  created_at          timestamptz not null default now()
);

create index clinical_restrictions_active
  on public.member_clinical_restrictions (member_id, verification_status)
  where verification_status = 'CONFIRMED';

alter table public.member_clinical_restrictions enable row level security;
create policy clinical_restrictions_select on public.member_clinical_restrictions
  for select to authenticated
  using (app.medical_access(member_id, 'VIEW_CLINICAL_RESTRICTIONS'));
-- Escritura SOLO por RPC (flujo clínico; la UI de preferencias no llega acá).

create or replace function public.create_clinical_restriction(
  p_member_id        uuid,
  p_type             public.clinical_restriction_type,
  p_target           text,
  p_value            numeric,
  p_unit             text,
  p_severity         public.clinical_severity,
  p_source           public.clinical_source,
  p_source_reference text,
  p_rule_version_id  uuid,
  p_reason           text,
  p_confirm          boolean default false
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_hogar uuid;
  v_actor uuid;
  v_id uuid;
begin
  if not app.medical_access(p_member_id, 'MANAGE_CLINICAL_RESTRICTIONS') then
    raise exception 'no autorizado';
  end if;
  if nullif(trim(coalesce(p_target, '')), '') is null then
    raise exception 'una restricción necesita su objetivo';
  end if;
  if p_type in ('NUTRIENT_MAX', 'NUTRIENT_MIN') and (p_value is null or p_unit is null) then
    raise exception 'un límite de nutriente necesita valor Y unidad: sin unidad no hay límite';
  end if;
  if p_rule_version_id is not null and not exists (
    select 1 from public.clinical_rule_versions v
    join public.clinical_rule_sets s on s.id = v.rule_set_id
    where v.id = p_rule_version_id
      and (s.household_id is null or s.household_id = app.member_household(p_member_id))
  ) then
    raise exception 'no autorizado';
  end if;

  v_hogar := app.member_household(p_member_id);
  v_actor := app.current_member_id(v_hogar);

  insert into public.member_clinical_restrictions
    (member_id, type, target, value, unit, severity, source, source_reference,
     rule_version_id, verification_status, created_by, confirmed_by, confirmed_at, reason)
  values
    (p_member_id, p_type, trim(p_target), p_value, nullif(trim(coalesce(p_unit, '')), ''),
     p_severity, p_source, p_source_reference, p_rule_version_id,
     case when p_confirm then 'CONFIRMED' else 'UNVERIFIED' end::public.clinical_verification,
     v_actor,
     case when p_confirm then v_actor end,
     case when p_confirm then now() end,
     p_reason)
  returning id into v_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_hogar, auth.uid(), 'CLINICAL_RESTRICTION_CREATED', 'clinical_restriction', v_id,
          jsonb_build_object('type', p_type::text, 'severity', p_severity::text));
  perform app.emit_event(v_hogar, 'CLINICAL_RESTRICTION_CHANGED', 'clinical_restriction',
    jsonb_build_object('restriction_id', v_id, 'member_id', p_member_id),
    'CLINICAL_RESTRICTION_CHANGED:' || v_id::text || ':created');
  return v_id;
end;
$$;

/** Confirmar / retirar por el flujo clínico. Jamás desde preferencias. */
create or replace function public.set_clinical_restriction_status(
  p_restriction_id uuid,
  p_status         public.clinical_verification,
  p_reason         text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_r public.member_clinical_restrictions;
  v_hogar uuid;
  v_actor uuid;
begin
  select * into v_r from public.member_clinical_restrictions
  where id = p_restriction_id for update;
  if v_r.id is null or not app.medical_access(v_r.member_id, 'MANAGE_CLINICAL_RESTRICTIONS') then
    raise exception 'no autorizado';
  end if;
  if v_r.verification_status = p_status then return; end if;
  if v_r.verification_status = 'RETIRED' then
    raise exception 'una restricción retirada es historia: crea una nueva';
  end if;
  v_hogar := app.member_household(v_r.member_id);
  v_actor := app.current_member_id(v_hogar);

  update public.member_clinical_restrictions set
    verification_status = p_status,
    confirmed_by = case when p_status = 'CONFIRMED' then v_actor else confirmed_by end,
    confirmed_at = case when p_status = 'CONFIRMED' then now() else confirmed_at end,
    valid_until  = case when p_status = 'RETIRED' then current_date else valid_until end,
    reason       = coalesce(nullif(p_reason, ''), reason)
  where id = p_restriction_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_hogar, auth.uid(), 'CLINICAL_RESTRICTION_STATUS', 'clinical_restriction', p_restriction_id,
          jsonb_build_object('status', p_status::text));
  perform app.emit_event(v_hogar, 'CLINICAL_RESTRICTION_CHANGED', 'clinical_restriction',
    jsonb_build_object('restriction_id', p_restriction_id, 'member_id', v_r.member_id),
    'CLINICAL_RESTRICTION_CHANGED:' || p_restriction_id::text || ':' || p_status::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Evaluaciones clínicas de comida (snapshot explicable, §30/§60/§61)
-- ---------------------------------------------------------------------------

create table public.meal_clinical_assessments (
  id                   uuid primary key default gen_random_uuid(),
  member_id            uuid not null references public.household_members (id) on delete cascade,
  version_id           uuid not null references public.meal_template_versions (id) on delete cascade,
  assignment_id        uuid references public.meal_assignments (id) on delete set null,
  assessed_on          date not null,
  engine_version       text not null,
  status               public.clinical_assessment_status not null,
  -- Explicabilidad (§96): razones estructuradas, datos faltantes, reglas y
  -- versiones aplicadas, REFERENCIAS a observaciones usadas (ids, no copias).
  reasons              jsonb not null default '[]'::jsonb,
  missing_data         jsonb not null default '[]'::jsonb,
  rule_refs            jsonb not null default '[]'::jsonb,
  restriction_snapshot jsonb not null default '[]'::jsonb,
  observation_refs     jsonb not null default '[]'::jsonb,
  proposed_adjustments jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now()
);

create index clinical_assessments_by_member
  on public.meal_clinical_assessments (member_id, assessed_on desc);
create index clinical_assessments_by_assignment
  on public.meal_clinical_assessments (assignment_id) where assignment_id is not null;

alter table public.meal_clinical_assessments enable row level security;
create policy clinical_assessments_select on public.meal_clinical_assessments
  for select to authenticated
  using (app.medical_access(member_id, 'VIEW_CLINICAL_RESTRICTIONS'));

create or replace function public.save_meal_clinical_assessment(
  p_member_id      uuid,
  p_version_id     uuid,
  p_assignment_id  uuid,
  p_assessed_on    date,
  p_engine_version text,
  p_status         public.clinical_assessment_status,
  p_payload        jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_hogar uuid;
  v_id uuid;
begin
  if not app.medical_access(p_member_id, 'VIEW_CLINICAL_RESTRICTIONS') then
    raise exception 'no autorizado';
  end if;
  v_hogar := app.member_household(p_member_id);
  if not app.version_in_scope(p_version_id, v_hogar) then
    raise exception 'no autorizado';
  end if;
  if p_assignment_id is not null
     and app.assignment_household(p_assignment_id) is distinct from v_hogar then
    raise exception 'no autorizado';
  end if;

  insert into public.meal_clinical_assessments
    (member_id, version_id, assignment_id, assessed_on, engine_version, status,
     reasons, missing_data, rule_refs, restriction_snapshot, observation_refs,
     proposed_adjustments)
  values
    (p_member_id, p_version_id, p_assignment_id, p_assessed_on, p_engine_version, p_status,
     coalesce(p_payload->'reasons', '[]'::jsonb),
     coalesce(p_payload->'missing_data', '[]'::jsonb),
     coalesce(p_payload->'rule_refs', '[]'::jsonb),
     coalesce(p_payload->'restriction_snapshot', '[]'::jsonb),
     coalesce(p_payload->'observation_refs', '[]'::jsonb),
     coalesce(p_payload->'proposed_adjustments', '[]'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Estado clínico del serving (divulgación MÍNIMA; §37/§43)
-- ---------------------------------------------------------------------------

alter table public.member_serving_projections
  add column if not exists clinical_status public.clinical_assessment_status,
  add column if not exists clinical_assessment_id uuid
    references public.meal_clinical_assessments (id) on delete set null;

comment on column public.member_serving_projections.clinical_status is
  'ÚNICO dato clínico visible sin grant: categórico, sin valores ni causas. '
  'CLINICALLY_INVALIDATED = NO SERVIR SIN REVISIÓN.';

/**
 * Marca el estado clínico de un serving FUTURO (§37). Historia intocable:
 * SERVED/CONSUMED jamás cambian. No borra ni recalcula nada más.
 */
create or replace function public.set_serving_clinical_status(
  p_projection_id uuid,
  p_status        public.clinical_assessment_status,
  p_assessment_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_p public.member_serving_projections;
  v_hogar uuid;
begin
  select * into v_p from public.member_serving_projections where id = p_projection_id for update;
  if v_p.id is null then raise exception 'no autorizado'; end if;
  v_hogar := app.member_household(v_p.member_id);
  if not app.medical_access(v_p.member_id, 'VIEW_CLINICAL_RESTRICTIONS') then
    raise exception 'no autorizado';
  end if;
  if v_p.status in ('SERVED', 'CONSUMED') then
    raise exception 'esa porción ya es historia: una regla nueva no la reescribe'
      using errcode = 'check_violation';
  end if;
  if p_assessment_id is not null and not exists (
    select 1 from public.meal_clinical_assessments a
    where a.id = p_assessment_id and a.member_id = v_p.member_id
  ) then
    raise exception 'no autorizado';
  end if;

  update public.member_serving_projections
  set clinical_status = p_status, clinical_assessment_id = p_assessment_id
  where id = p_projection_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Impact reviews (§34-§40): la nueva información PROPONE, no reescribe
-- ---------------------------------------------------------------------------

create table public.clinical_impact_reviews (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  member_id     uuid not null references public.household_members (id) on delete cascade,
  trigger_kind  text not null,   -- LAB_RESULTS_CONFIRMED | CLINICAL_RESTRICTION_CHANGED | RULE_PUBLISHED
  trigger_ref   uuid,
  status        public.impact_review_status not null default 'PENDING',
  -- Qué cambió y qué toca: comidas, porciones, compras, lo ya comprado,
  -- preparado y consumido. Payload NO sensible (ids y conteos, no valores).
  summary       jsonb not null default '{}'::jsonb,
  dedupe_key    text unique,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references public.household_members (id) on delete set null
);

create index impact_reviews_pending
  on public.clinical_impact_reviews (member_id, status) where status = 'PENDING';

alter table public.clinical_impact_reviews enable row level security;
create policy impact_reviews_select on public.clinical_impact_reviews
  for select to authenticated
  using (app.medical_access(member_id, 'VIEW_CLINICAL_RESTRICTIONS'));

/** Creación idempotente (§34): mismo disparador = una sola revisión viva. */
create or replace function public.create_clinical_impact_review(
  p_member_id    uuid,
  p_trigger_kind text,
  p_trigger_ref  uuid,
  p_summary      jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_hogar uuid;
  v_id uuid;
  v_key text;
begin
  if not app.medical_access(p_member_id, 'VIEW_CLINICAL_RESTRICTIONS') then
    raise exception 'no autorizado';
  end if;
  v_hogar := app.member_household(p_member_id);
  v_key := 'IMPACT:' || p_member_id::text || ':' || p_trigger_kind || ':' || coalesce(p_trigger_ref::text, '-');

  select id into v_id from public.clinical_impact_reviews where dedupe_key = v_key;
  if v_id is not null then return v_id; end if;

  insert into public.clinical_impact_reviews
    (household_id, member_id, trigger_kind, trigger_ref, summary, dedupe_key)
  values (v_hogar, p_member_id, p_trigger_kind, p_trigger_ref, coalesce(p_summary, '{}'::jsonb), v_key)
  returning id into v_id;

  perform app.emit_event(v_hogar, 'CLINICAL_IMPACT_CREATED', 'clinical_impact_review',
    jsonb_build_object('review_id', v_id, 'member_id', p_member_id, 'trigger', p_trigger_kind),
    'CLINICAL_IMPACT_CREATED:' || v_key);
  return v_id;
end;
$$;

/**
 * Resolver una revisión (§35-§40). `p_apply` marca los servings FUTUROS
 * listados con su estado clínico; JAMÁS toca inventario, compras, paquetes
 * ni historia (eso lo protege set_serving_clinical_status).
 */
create or replace function public.resolve_clinical_impact_review(
  p_review_id      uuid,
  p_resolution     public.impact_review_status,
  p_serving_status jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_r public.clinical_impact_reviews;
  v_s jsonb;
begin
  select * into v_r from public.clinical_impact_reviews where id = p_review_id for update;
  if v_r.id is null or not app.medical_access(v_r.member_id, 'VIEW_CLINICAL_RESTRICTIONS') then
    raise exception 'no autorizado';
  end if;
  if p_resolution not in ('REVIEWED', 'APPLIED', 'DISMISSED') then
    raise exception 'resolución inválida';
  end if;
  if v_r.status <> 'PENDING' then return; end if; -- idempotente

  if p_resolution = 'APPLIED' then
    for v_s in select * from jsonb_array_elements(coalesce(p_serving_status, '[]'::jsonb)) loop
      perform public.set_serving_clinical_status(
        (v_s->>'projection_id')::uuid,
        (v_s->>'status')::public.clinical_assessment_status,
        nullif(v_s->>'assessment_id', '')::uuid);
    end loop;
  end if;

  update public.clinical_impact_reviews
  set status = p_resolution, resolved_at = now(),
      resolved_by = app.current_member_id(v_r.household_id)
  where id = p_review_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_r.household_id, auth.uid(), 'CLINICAL_IMPACT_RESOLVED', 'clinical_impact_review', p_review_id,
          jsonb_build_object('resolution', p_resolution::text));
  perform app.emit_event(v_r.household_id, 'CLINICAL_IMPACT_APPLIED', 'clinical_impact_review',
    jsonb_build_object('review_id', p_review_id, 'resolution', p_resolution::text),
    'CLINICAL_IMPACT_APPLIED:' || p_review_id::text);
end;
$$;
