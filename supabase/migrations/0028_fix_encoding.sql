-- Sprint 11 — corrección de CODIFICACIÓN (0028).
--
-- Defecto real, encontrado en la demo viva §101: las migraciones 0026 y 0027
-- se entregaron por portapapeles con `clip` de Windows, que reescribe el UTF-8
-- en la página de códigos del sistema. Resultado en el remoto: cinco nombres
-- de biomarcador con acentos rotos ("Fósforo" → "Fósforo") y los mensajes de
-- las funciones igual de mutilados. Los datos clínicos NO se vieron afectados
-- — solo texto de presentación y de error — pero un mensaje ilegible en un
-- módulo de salud es un defecto: la persona tiene que ENTENDER por qué el
-- sistema se niega a algo.
--
-- Esta migración es idempotente y segura de re-aplicar:
--   1. corrige los nombres por código (no toca ninguna observación);
--   2. reemite TODAS las funciones de 0026/0027 con su texto correcto
--      (`create or replace`: mismo contrato, mismo cuerpo, acentos sanos).
--
-- Entregar SIEMPRE con `Set-Clipboard` en UTF-8, jamás con `clip`.

-- ---------------------------------------------------------------------------
-- 1. Nombres del catálogo global (por código: la identidad no cambia)
-- ---------------------------------------------------------------------------

update public.biomarker_definitions set display_name = 'Albúmina'
  where household_id is null and code = 'albumin';
update public.biomarker_definitions set display_name = 'Nitrógeno ureico (BUN)'
  where household_id is null and code = 'bun';
update public.biomarker_definitions set display_name = 'eGFR (filtración)'
  where household_id is null and code = 'egfr';
update public.biomarker_definitions set display_name = 'Fósforo'
  where household_id is null and code = 'phosphorus';
update public.biomarker_definitions set display_name = 'Triglicéridos'
  where household_id is null and code = 'triglycerides';

-- ---------------------------------------------------------------------------
-- 2. Funciones reemitidas con texto correcto (contrato idéntico)
-- ---------------------------------------------------------------------------

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

create or replace function app.deny_published_rule_delete()
returns trigger language plpgsql as $$
begin
  if old.status = 'PUBLISHED' then
    raise exception 'una versión publicada es historia: no se borra';
  end if;
  return old;
end;
$$;

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

  -- QA §100 lente M [M-1]: el `for update` sobre el conjunto serializa la
  -- numeración. Sin él, dos creaciones simultáneas calculaban el MISMO
  -- max+1 y la segunda moría con un error crudo de índice único.
  select id into v_set from public.clinical_rule_sets
  where household_id = v_hogar and code = p_code
  for update;
  if v_set is null then
    insert into public.clinical_rule_sets (household_id, code, name)
    values (v_hogar, p_code, p_name)
    on conflict (household_id, code) where household_id is not null do nothing
    returning id into v_set;
    if v_set is null then
      select id into v_set from public.clinical_rule_sets
      where household_id = v_hogar and code = p_code for update;
    end if;
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
