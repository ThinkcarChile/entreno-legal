-- Sprint 11 — Salud (parte 1): documentos médicos, biomarcadores,
-- observaciones de laboratorio y GRANTS médicos independientes de roles.
--
-- Principios (ADR 0012):
--  · AI NEVER OVERRIDES CLINICAL RULES: lo extraído por IA vive en
--    `lab_extraction_candidates`; el motor clínico solo lee observaciones
--    CONFIRMED, que únicamente produce un humano vía RPC.
--  · UNKNOWN NEVER MEANS NORMAL: unidad faltante = NULL explícito, jamás se
--    asume mmol/L; el rango de referencia impreso pertenece a la observación
--    y no se reemplaza por uno "general".
--  · Privacidad INTRA-hogar: ser ADMIN/PLANNER/COOK no da acceso a exámenes.
--    Acceso = self, grant activo, o tutor de dependiente sin cuenta (regla
--    explícita del ADR, no un default silencioso).
--  · Una observación confirmada NO se edita: corregir crea una fila nueva
--    encadenada (`corrected_from`) y la vieja queda CORRECTED.

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------

create type public.lab_document_status as enum
  ('UPLOADED', 'PROCESSING', 'EXTRACTED', 'NEEDS_REVIEW', 'CONFIRMED', 'FAILED', 'ARCHIVED');

create type public.ai_consent_status as enum
  ('NOT_REQUESTED', 'GRANTED', 'DECLINED');

create type public.lab_observation_status as enum
  ('EXTRACTED_UNVERIFIED', 'CONFIRMED', 'REJECTED', 'CORRECTED');

create type public.extraction_candidate_status as enum
  ('PENDING', 'CONFIRMED', 'EDITED', 'DISCARDED');

create type public.medical_permission as enum
  ('READ_LABS', 'UPLOAD_LABS', 'EDIT_UNVERIFIED', 'CONFIRM_LABS',
   'VIEW_CLINICAL_RESTRICTIONS', 'MANAGE_CLINICAL_RESTRICTIONS');

create type public.lab_schedule_source as enum
  ('USER', 'DOCTOR', 'NUTRITIONIST', 'CLINICAL_PROTOCOL');

-- ---------------------------------------------------------------------------
-- 1. Catálogo de biomarcadores (estructura global extensible; NO límites)
-- ---------------------------------------------------------------------------

create table public.biomarker_definitions (
  id             uuid primary key default gen_random_uuid(),
  -- NULL = catálogo global; con valor = definición privada del hogar.
  household_id   uuid references public.households (id) on delete cascade,
  code           text not null,
  display_name   text not null,
  category       text,
  -- Unidad canónica SUGERIDA para mostrar. Jamás se usa para "completar" una
  -- observación sin unidad: eso sería inventar un dato clínico.
  canonical_unit text,
  description    text,
  created_at     timestamptz not null default now()
);

create unique index biomarker_defs_global_code_uniq
  on public.biomarker_definitions (code) where household_id is null;
create unique index biomarker_defs_hh_code_uniq
  on public.biomarker_definitions (household_id, code) where household_id is not null;

alter table public.biomarker_definitions enable row level security;
create policy biomarker_defs_select on public.biomarker_definitions
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));

-- Definiciones globales: ESTRUCTURA, no verdades médicas. Cero límites.
insert into public.biomarker_definitions (code, display_name, category, canonical_unit) values
  ('creatinine',        'Creatinina',            'RENAL',   'mg/dL'),
  ('egfr',              'eGFR (filtración)',     'RENAL',   'mL/min/1.73m2'),
  ('uacr',              'UACR / albuminuria',    'RENAL',   'mg/g'),
  ('potassium',         'Potasio',               'ELECTROLYTE', 'mmol/L'),
  ('phosphorus',        'Fósforo',               'ELECTROLYTE', 'mg/dL'),
  ('sodium',            'Sodio',                 'ELECTROLYTE', 'mmol/L'),
  ('bicarbonate',       'Bicarbonato',           'ELECTROLYTE', 'mmol/L'),
  ('bun',               'Nitrógeno ureico (BUN)','RENAL',   'mg/dL'),
  ('calcium',           'Calcio',                'ELECTROLYTE', 'mg/dL'),
  ('albumin',           'Albúmina',              'PROTEIN', 'g/dL'),
  ('hemoglobin',        'Hemoglobina',           'HEMATOLOGY', 'g/dL'),
  ('glucose',           'Glucosa',               'METABOLIC', 'mg/dL'),
  ('hba1c',             'Hemoglobina glicada (HbA1c)', 'METABOLIC', '%'),
  ('total_cholesterol', 'Colesterol total',      'LIPID',   'mg/dL'),
  ('ldl',               'Colesterol LDL',        'LIPID',   'mg/dL'),
  ('hdl',               'Colesterol HDL',        'LIPID',   'mg/dL'),
  ('triglycerides',     'Triglicéridos',         'LIPID',   'mg/dL')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Acceso médico: self, grant activo, o tutor de dependiente
-- ---------------------------------------------------------------------------

create table public.medical_data_grants (
  id                uuid primary key default gen_random_uuid(),
  owner_member_id   uuid not null references public.household_members (id) on delete cascade,
  grantee_member_id uuid not null references public.household_members (id) on delete cascade,
  permission        public.medical_permission not null,
  granted_by        uuid references public.household_members (id) on delete set null,
  granted_at        timestamptz not null default now(),
  revoked_at        timestamptz,
  revoked_by        uuid references public.household_members (id) on delete set null,
  constraint medical_grant_not_self check (owner_member_id <> grantee_member_id)
);

-- Un permiso VIVO por par (revocar y re-otorgar crea fila nueva: historia).
create unique index medical_grants_active_uniq
  on public.medical_data_grants (owner_member_id, grantee_member_id, permission)
  where revoked_at is null;
create index medical_grants_by_grantee on public.medical_data_grants (grantee_member_id)
  where revoked_at is null;

/** Hogar de un integrante (para validaciones de ámbito). */
create or replace function app.member_household(p_member uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.household_members where id = p_member;
$$;

/** ¿El usuario actual ES este integrante? */
create or replace function app.is_self_member(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members m
    where m.id = p_member and m.user_id = auth.uid()
  );
$$;

/**
 * Acceso médico efectivo (ADR 0012 §2). Los roles del hogar NO cuentan:
 *  1. self — mis propios datos;
 *  2. grant activo del dueño hacia un integrante vinculado a mi usuario;
 *  3. tutor: el dueño NO tiene cuenta vinculada y yo soy ADMIN de su hogar
 *     (dependientes: alguien tiene que poder subir/confirmar sus exámenes).
 */
create or replace function app.medical_access(p_owner uuid, p_permission public.medical_permission)
returns boolean language sql stable security definer set search_path = public as $$
  select app.is_self_member(p_owner)
    or exists (
      select 1
      from public.medical_data_grants g
      join public.household_members me on me.id = g.grantee_member_id
      where g.owner_member_id = p_owner
        and g.permission = p_permission
        and g.revoked_at is null
        and me.user_id = auth.uid()
    )
    or exists (
      select 1 from public.household_members owner_m
      where owner_m.id = p_owner
        and owner_m.user_id is null
        and app.is_household_admin(owner_m.household_id)
    );
$$;

alter table public.medical_data_grants enable row level security;
-- Ver grants: el dueño, el receptor, o el tutor del dueño.
create policy medical_grants_select on public.medical_data_grants
  for select to authenticated
  using (
    app.is_self_member(owner_member_id)
    or app.is_self_member(grantee_member_id)
    or exists (
      select 1 from public.household_members owner_m
      where owner_m.id = owner_member_id and owner_m.user_id is null
        and app.is_household_admin(owner_m.household_id)
    )
  );
-- Escritura SOLO por RPC.

/** ¿Puedo ADMINISTRAR los grants de este dueño? (self o tutor). */
create or replace function app.can_manage_medical_grants(p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select app.is_self_member(p_owner)
    or exists (
      select 1 from public.household_members owner_m
      where owner_m.id = p_owner
        and owner_m.user_id is null
        and app.is_household_admin(owner_m.household_id)
    );
$$;

create or replace function public.grant_medical_access(
  p_owner_member   uuid,
  p_grantee_member uuid,
  p_permission     public.medical_permission
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_actor uuid;
  v_hogar uuid;
begin
  if not app.can_manage_medical_grants(p_owner_member) then
    raise exception 'no autorizado';
  end if;
  v_hogar := app.member_household(p_owner_member);
  if app.member_household(p_grantee_member) is distinct from v_hogar then
    raise exception 'no autorizado';
  end if;
  v_actor := app.current_member_id(v_hogar);

  -- Idempotente: si el permiso vivo ya existe, se devuelve.
  select id into v_id from public.medical_data_grants
  where owner_member_id = p_owner_member and grantee_member_id = p_grantee_member
    and permission = p_permission and revoked_at is null;
  if v_id is not null then return v_id; end if;

  insert into public.medical_data_grants (owner_member_id, grantee_member_id, permission, granted_by)
  values (p_owner_member, p_grantee_member, p_permission, v_actor)
  returning id into v_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_hogar, auth.uid(), 'MEDICAL_GRANT_CREATED', 'medical_data_grant', v_id,
          jsonb_build_object('permission', p_permission::text));
  return v_id;
end;
$$;

create or replace function public.revoke_medical_access(p_grant uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_grant public.medical_data_grants;
  v_hogar uuid;
begin
  select * into v_grant from public.medical_data_grants where id = p_grant for update;
  if v_grant.id is null or not app.can_manage_medical_grants(v_grant.owner_member_id) then
    raise exception 'no autorizado';
  end if;
  if v_grant.revoked_at is not null then return; end if; -- idempotente
  v_hogar := app.member_household(v_grant.owner_member_id);
  update public.medical_data_grants
  set revoked_at = now(), revoked_by = app.current_member_id(v_hogar)
  where id = p_grant;
  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_hogar, auth.uid(), 'MEDICAL_GRANT_REVOKED', 'medical_data_grant', p_grant,
          jsonb_build_object('permission', v_grant.permission::text));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Documentos de laboratorio
-- ---------------------------------------------------------------------------

create table public.lab_documents (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references public.households (id) on delete cascade,
  member_id            uuid not null references public.household_members (id) on delete cascade,
  document_date        date,
  uploaded_at          timestamptz not null default now(),
  uploaded_by          uuid references public.household_members (id) on delete set null,
  source_lab_name      text,
  document_type        text not null default 'LAB_RESULTS'
                       check (document_type in ('LAB_RESULTS', 'MEDICAL_REPORT', 'OTHER')),
  -- Ruta en el bucket PRIVADO `medical-documents`. Jamás una URL pública.
  storage_path         text,
  processing_status    public.lab_document_status not null default 'UPLOADED',
  -- Consentimiento para extracción por IA (§4). Sin GRANTED no se envía nada
  -- al modelo; el documento igual puede revisarse a mano.
  ai_consent_status    public.ai_consent_status not null default 'NOT_REQUESTED',
  ai_consented_at      timestamptz,
  ai_consented_by      uuid references public.household_members (id) on delete set null,
  ai_consent_purpose   text,
  ai_processor_version text,
  extraction_version   text,
  confirmed_at         timestamptz,
  confirmed_by         uuid references public.household_members (id) on delete set null
);

create index lab_documents_by_member on public.lab_documents (member_id, document_date desc);

alter table public.lab_documents enable row level security;
create policy lab_documents_select on public.lab_documents
  for select to authenticated
  using (app.medical_access(member_id, 'READ_LABS'));
-- Escritura SOLO por RPC.

-- ---------------------------------------------------------------------------
-- 4. Candidatos de extracción (capa IA: propone, JAMÁS decide)
-- ---------------------------------------------------------------------------

create table public.lab_extraction_candidates (
  id                    uuid primary key default gen_random_uuid(),
  document_id           uuid not null references public.lab_documents (id) on delete cascade,
  biomarker_id          uuid references public.biomarker_definitions (id) on delete set null,
  raw_label             text,
  value                 numeric(12, 4),
  -- NULL = el examen no traía unidad legible. NUNCA se rellena con la
  -- canónica del catálogo: eso sería inventar un dato clínico (§7).
  unit                  text,
  reference_low         numeric(12, 4),
  reference_high        numeric(12, 4),
  reference_text        text,
  collected_date        date,
  extraction_confidence numeric(4, 3) check (extraction_confidence between 0 and 1),
  original_snippet      text check (char_length(original_snippet) <= 500),
  status                public.extraction_candidate_status not null default 'PENDING',
  created_at            timestamptz not null default now()
);

create index extraction_candidates_by_doc on public.lab_extraction_candidates (document_id);

alter table public.lab_extraction_candidates enable row level security;
create policy extraction_candidates_select on public.lab_extraction_candidates
  for select to authenticated
  using (exists (
    select 1 from public.lab_documents d
    where d.id = document_id and app.medical_access(d.member_id, 'READ_LABS')
  ));

-- ---------------------------------------------------------------------------
-- 5. Observaciones (lo ÚNICO que el motor clínico puede leer, y solo CONFIRMED)
-- ---------------------------------------------------------------------------

create table public.lab_observations (
  id                    uuid primary key default gen_random_uuid(),
  member_id             uuid not null references public.household_members (id) on delete cascade,
  document_id           uuid references public.lab_documents (id) on delete set null,
  biomarker_id          uuid not null references public.biomarker_definitions (id) on delete restrict,
  value                 numeric(12, 4) not null,
  -- NULL = unidad DESCONOCIDA. El motor clínico se niega a usarla en reglas
  -- que exijan unidad; jamás se asume una.
  unit                  text,
  -- El rango IMPRESO por el laboratorio pertenece a ESTA observación (§8).
  reference_low         numeric(12, 4),
  reference_high        numeric(12, 4),
  reference_text        text,
  collected_date        date,
  reported_date         date,
  source_lab            text,
  extraction_confidence numeric(4, 3),
  verification_status   public.lab_observation_status not null default 'EXTRACTED_UNVERIFIED',
  verified_by           uuid references public.household_members (id) on delete set null,
  verified_at           timestamptz,
  original_snippet      text check (char_length(original_snippet) <= 500),
  notes                 text,
  -- Corrección auditable (§11): la fila nueva apunta a la corregida.
  corrected_from        uuid references public.lab_observations (id) on delete set null,
  correction_reason     text,
  created_at            timestamptz not null default now()
);

create index lab_observations_by_member_bio
  on public.lab_observations (member_id, biomarker_id, collected_date desc);
create index lab_observations_confirmed
  on public.lab_observations (member_id, verification_status)
  where verification_status = 'CONFIRMED';

alter table public.lab_observations enable row level security;
create policy lab_observations_select on public.lab_observations
  for select to authenticated
  using (app.medical_access(member_id, 'READ_LABS'));

-- ---------------------------------------------------------------------------
-- 6. Frecuencias de examen (configuradas, jamás inventadas)
-- ---------------------------------------------------------------------------

create table public.member_lab_schedules (
  id                     uuid primary key default gen_random_uuid(),
  member_id              uuid not null references public.household_members (id) on delete cascade,
  biomarker_id           uuid references public.biomarker_definitions (id) on delete cascade,
  panel_label            text,
  expected_interval_days int check (expected_interval_days > 0),
  next_due_date          date,
  -- Quién definió la frecuencia (§14): la app NO inventa "cada 3 meses".
  source                 public.lab_schedule_source not null,
  notes                  text,
  enabled                boolean not null default true,
  created_by             uuid references public.household_members (id) on delete set null,
  created_at             timestamptz not null default now(),
  constraint lab_schedule_target check (num_nonnulls(biomarker_id, panel_label) >= 1)
);

create index lab_schedules_by_member on public.member_lab_schedules (member_id) where enabled;

alter table public.member_lab_schedules enable row level security;
create policy lab_schedules_select on public.member_lab_schedules
  for select to authenticated
  using (app.medical_access(member_id, 'READ_LABS'));
create policy lab_schedules_write on public.member_lab_schedules
  for all to authenticated
  using (app.medical_access(member_id, 'CONFIRM_LABS'))
  with check (app.medical_access(member_id, 'CONFIRM_LABS'));

-- ---------------------------------------------------------------------------
-- 7. RPCs del pipeline: Documento → Candidatos → Revisión → Observaciones
-- ---------------------------------------------------------------------------

create or replace function public.upload_lab_document(
  p_member_id     uuid,
  p_document_date date,
  p_source_lab    text,
  p_document_type text,
  p_storage_path  text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_hogar uuid;
  v_id uuid;
begin
  if not app.medical_access(p_member_id, 'UPLOAD_LABS') then
    raise exception 'no autorizado';
  end if;
  v_hogar := app.member_household(p_member_id);

  insert into public.lab_documents
    (household_id, member_id, document_date, source_lab_name, document_type,
     storage_path, uploaded_by)
  values
    (v_hogar, p_member_id, p_document_date, nullif(trim(p_source_lab), ''),
     coalesce(nullif(p_document_type, ''), 'LAB_RESULTS'), p_storage_path,
     app.current_member_id(v_hogar))
  returning id into v_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (v_hogar, auth.uid(), 'LAB_DOCUMENT_UPLOADED', 'lab_document', v_id);
  perform app.emit_event(v_hogar, 'LAB_UPLOADED', 'lab_document',
    jsonb_build_object('document_id', v_id), 'LAB_UPLOADED:' || v_id::text);
  return v_id;
end;
$$;

/** Consentimiento explícito para extracción por IA (§4). */
create or replace function public.set_lab_ai_consent(
  p_document_id uuid,
  p_granted     boolean,
  p_purpose     text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_doc public.lab_documents;
begin
  select * into v_doc from public.lab_documents where id = p_document_id for update;
  if v_doc.id is null or not app.medical_access(v_doc.member_id, 'UPLOAD_LABS') then
    raise exception 'no autorizado';
  end if;
  update public.lab_documents set
    ai_consent_status  = case when p_granted then 'GRANTED' else 'DECLINED' end::public.ai_consent_status,
    ai_consented_at    = now(),
    ai_consented_by    = app.current_member_id(v_doc.household_id),
    ai_consent_purpose = p_purpose
  where id = p_document_id;
end;
$$;

/**
 * La capa de extracción (sustituible) deposita ACÁ sus candidatos. Exige
 * consentimiento GRANTED: sin él este RPC rechaza — la frontera no es
 * disciplina del cliente, es una guarda del servidor.
 */
create or replace function public.submit_lab_extraction(
  p_document_id       uuid,
  p_processor_version text,
  p_candidates        jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_doc public.lab_documents;
  v_c jsonb;
  v_count int := 0;
  v_dudosos int := 0;
  v_bio uuid;
begin
  select * into v_doc from public.lab_documents where id = p_document_id for update;
  if v_doc.id is null or not app.medical_access(v_doc.member_id, 'EDIT_UNVERIFIED') then
    raise exception 'no autorizado';
  end if;
  if v_doc.ai_consent_status <> 'GRANTED' then
    raise exception 'Sin consentimiento para extracción por IA: revisa el documento a mano o consiente primero.'
      using errcode = 'check_violation';
  end if;
  if v_doc.processing_status in ('CONFIRMED', 'ARCHIVED') then
    raise exception 'este documento ya fue confirmado: sus observaciones son historia';
  end if;

  -- Reintento de extracción = reemplazo completo de candidatos PENDIENTES.
  delete from public.lab_extraction_candidates
  where document_id = p_document_id and status = 'PENDING';

  for v_c in select * from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) loop
    v_bio := null;
    if nullif(v_c->>'biomarker_code', '') is not null then
      select id into v_bio from public.biomarker_definitions
      where code = v_c->>'biomarker_code'
        and (household_id is null or household_id = v_doc.household_id)
      order by (household_id is not null) desc limit 1;
    end if;
    insert into public.lab_extraction_candidates
      (document_id, biomarker_id, raw_label, value, unit,
       reference_low, reference_high, reference_text, collected_date,
       extraction_confidence, original_snippet)
    values
      (p_document_id, v_bio, v_c->>'raw_label',
       (v_c->>'value')::numeric,
       nullif(trim(coalesce(v_c->>'unit', '')), ''),   -- '' o ausente = NULL, jamás inventada
       (v_c->>'reference_low')::numeric,
       (v_c->>'reference_high')::numeric,
       nullif(v_c->>'reference_text', ''),
       (v_c->>'collected_date')::date,
       (v_c->>'confidence')::numeric,
       left(v_c->>'original_snippet', 500));
    v_count := v_count + 1;
    if v_bio is null or nullif(trim(coalesce(v_c->>'unit', '')), '') is null
       or (v_c->>'value') is null then
      v_dudosos := v_dudosos + 1;
    end if;
  end loop;

  update public.lab_documents set
    processing_status  = case when v_count = 0 then 'FAILED'
                              when v_dudosos > 0 then 'NEEDS_REVIEW'
                              else 'EXTRACTED' end::public.lab_document_status,
    extraction_version = p_processor_version,
    ai_processor_version = p_processor_version
  where id = p_document_id;

  perform app.emit_event(v_doc.household_id, 'LAB_EXTRACTION_READY', 'lab_document',
    jsonb_build_object('document_id', p_document_id, 'candidates', v_count),
    'LAB_EXTRACTION_READY:' || p_document_id::text || ':' || coalesce(p_processor_version, ''));
  return v_count;
end;
$$;

/**
 * Revisión humana (§9/§10): por candidato CONFIRM / EDIT / DISCARD. Solo lo
 * confirmado se vuelve observación. El candidato editado guarda la edición
 * (status EDITED) y la observación nace de los valores editados.
 * Concurrencia (§86): lock del documento — dos confirmaciones simultáneas se
 * serializan y la segunda ve el estado real.
 */
create or replace function public.confirm_lab_extraction(
  p_document_id uuid,
  p_decisions   jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_doc public.lab_documents;
  v_d jsonb;
  v_cand public.lab_extraction_candidates;
  v_actor uuid;
  v_obs uuid;
  v_confirmadas int := 0;
  v_descartadas int := 0;
  v_bio uuid;
begin
  select * into v_doc from public.lab_documents where id = p_document_id for update;
  if v_doc.id is null or not app.medical_access(v_doc.member_id, 'CONFIRM_LABS') then
    raise exception 'no autorizado';
  end if;
  if v_doc.processing_status in ('CONFIRMED', 'ARCHIVED') then
    raise exception 'este documento ya fue confirmado: sus observaciones son historia';
  end if;
  v_actor := app.current_member_id(v_doc.household_id);

  for v_d in select * from jsonb_array_elements(coalesce(p_decisions, '[]'::jsonb)) loop
    select * into v_cand from public.lab_extraction_candidates
    where id = (v_d->>'candidate_id')::uuid and document_id = p_document_id
    for update;
    if v_cand.id is null then
      raise exception 'candidato inexistente en este documento';
    end if;
    if v_cand.status <> 'PENDING' then continue; end if; -- reintento = no-op

    if v_d->>'action' = 'DISCARD' then
      update public.lab_extraction_candidates set status = 'DISCARDED' where id = v_cand.id;
      v_descartadas := v_descartadas + 1;
      continue;
    end if;

    -- CONFIRM usa los valores del candidato; EDIT los del payload.
    if v_d->>'action' = 'EDIT' then
      v_bio := coalesce(nullif(v_d->>'biomarker_id', '')::uuid, v_cand.biomarker_id);
    else
      v_bio := v_cand.biomarker_id;
    end if;
    if v_bio is null then
      raise exception 'una observación necesita su biomarcador: edita la fila "%" y elígelo', coalesce(v_cand.raw_label, '?');
    end if;
    -- QA §100 lente O [O-1]: sin valor no hay observación. Antes reventaba
    -- con un NOT NULL crudo de Postgres; ahora dice qué falta y dónde.
    if (case when v_d->>'action' = 'EDIT' and v_d ? 'value'
             then (v_d->>'value')::numeric else v_cand.value end) is null then
      raise exception 'la fila "%" no tiene valor: edítala o descártala', coalesce(v_cand.raw_label, '?');
    end if;
    if not exists (
      select 1 from public.biomarker_definitions b
      where b.id = v_bio and (b.household_id is null or b.household_id = v_doc.household_id)
    ) then
      raise exception 'no autorizado';
    end if;

    insert into public.lab_observations
      (member_id, document_id, biomarker_id, value, unit,
       reference_low, reference_high, reference_text,
       collected_date, reported_date, source_lab, extraction_confidence,
       verification_status, verified_by, verified_at, original_snippet)
    values
      (v_doc.member_id, p_document_id, v_bio,
       case when v_d->>'action' = 'EDIT' and v_d ? 'value'
            then (v_d->>'value')::numeric else v_cand.value end,
       case when v_d->>'action' = 'EDIT' and v_d ? 'unit'
            then nullif(trim(v_d->>'unit'), '') else v_cand.unit end,
       case when v_d->>'action' = 'EDIT' and v_d ? 'reference_low'
            then (v_d->>'reference_low')::numeric else v_cand.reference_low end,
       case when v_d->>'action' = 'EDIT' and v_d ? 'reference_high'
            then (v_d->>'reference_high')::numeric else v_cand.reference_high end,
       coalesce(nullif(v_d->>'reference_text', ''), v_cand.reference_text),
       coalesce((v_d->>'collected_date')::date, v_cand.collected_date, v_doc.document_date),
       v_doc.document_date,
       v_doc.source_lab_name,
       v_cand.extraction_confidence,
       'CONFIRMED', v_actor, now(), v_cand.original_snippet)
    returning id into v_obs;

    update public.lab_extraction_candidates
    set status = case when v_d->>'action' = 'EDIT' then 'EDITED' else 'CONFIRMED' end::public.extraction_candidate_status
    where id = v_cand.id;
    v_confirmadas := v_confirmadas + 1;
  end loop;

  -- El documento queda CONFIRMED solo cuando no restan pendientes.
  if not exists (
    select 1 from public.lab_extraction_candidates
    where document_id = p_document_id and status = 'PENDING'
  ) then
    update public.lab_documents
    set processing_status = 'CONFIRMED', confirmed_at = now(), confirmed_by = v_actor
    where id = p_document_id;
    perform app.emit_event(v_doc.household_id, 'LAB_CONFIRMED', 'lab_document',
      jsonb_build_object('document_id', p_document_id, 'observations', v_confirmadas),
      'LAB_CONFIRMED:' || p_document_id::text);
  end if;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_doc.household_id, auth.uid(), 'LAB_EXTRACTION_CONFIRMED', 'lab_document', p_document_id,
          jsonb_build_object('confirmed', v_confirmadas, 'discarded', v_descartadas));

  return jsonb_build_object('confirmed', v_confirmadas, 'discarded', v_descartadas);
end;
$$;

/**
 * Corrección auditable (§11): jamás UPDATE del valor. Nace una observación
 * nueva encadenada y la vieja pasa a CORRECTED. La historia conserva ambas.
 */
create or replace function public.correct_lab_observation(
  p_observation_id uuid,
  p_new_value      numeric,
  p_new_unit       text,
  p_reason         text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_obs public.lab_observations;
  v_hogar uuid;
  v_nueva uuid;
begin
  select * into v_obs from public.lab_observations where id = p_observation_id for update;
  if v_obs.id is null or not app.medical_access(v_obs.member_id, 'CONFIRM_LABS') then
    raise exception 'no autorizado';
  end if;
  if v_obs.verification_status <> 'CONFIRMED' then
    raise exception 'solo se corrige una observación confirmada';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'una corrección necesita su porqué';
  end if;
  v_hogar := app.member_household(v_obs.member_id);

  insert into public.lab_observations
    (member_id, document_id, biomarker_id, value, unit,
     reference_low, reference_high, reference_text,
     collected_date, reported_date, source_lab, extraction_confidence,
     verification_status, verified_by, verified_at,
     original_snippet, corrected_from, correction_reason)
  values
    (v_obs.member_id, v_obs.document_id, v_obs.biomarker_id,
     p_new_value, nullif(trim(coalesce(p_new_unit, '')), ''),
     v_obs.reference_low, v_obs.reference_high, v_obs.reference_text,
     v_obs.collected_date, v_obs.reported_date, v_obs.source_lab, v_obs.extraction_confidence,
     'CONFIRMED', app.current_member_id(v_hogar), now(),
     v_obs.original_snippet, v_obs.id, p_reason)
  returning id into v_nueva;

  update public.lab_observations set verification_status = 'CORRECTED' where id = v_obs.id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_hogar, auth.uid(), 'LAB_OBSERVATION_CORRECTED', 'lab_observation', v_nueva,
          jsonb_build_object('corrected_from', v_obs.id));
  return v_nueva;
end;
$$;

create or replace function public.archive_lab_document(p_document_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_doc public.lab_documents;
begin
  select * into v_doc from public.lab_documents where id = p_document_id for update;
  if v_doc.id is null or not app.medical_access(v_doc.member_id, 'CONFIRM_LABS') then
    raise exception 'no autorizado';
  end if;
  update public.lab_documents set processing_status = 'ARCHIVED' where id = p_document_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Bucket privado (solo cuando el schema storage existe: Supabase sí,
--    PGlite no — misma técnica condicional que el resto del arnés)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('medical-documents', 'medical-documents', false)
    on conflict (id) do update set public = false;

    -- Subir: solo con permiso UPLOAD_LABS sobre el integrante de la ruta
    -- `member/{member_id}/...`. Leer: NADIE directo — solo URLs firmadas
    -- emitidas por el servidor tras validar el acceso.
    begin
      execute $pol$
        create policy medical_docs_upload on storage.objects
        for insert to authenticated
        with check (
          bucket_id = 'medical-documents'
          and app.medical_access(((string_to_array(name, '/'))[2])::uuid, 'UPLOAD_LABS')
        )
      $pol$;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
