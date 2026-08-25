-- Sprint 11 — Final Live Closure §1: `nutrition_source` como columna propia.
--
-- El defecto que cierra: una restricción cuantitativa individual evaluada
-- contra el PROMEDIO de la olla (total de la receta ÷ porciones base) no sabe
-- cuánto le van a servir a esta persona. Declarar COMPATIBLE ahí es una
-- afirmación de seguridad sin fundamento.
--
-- Las tres fuentes NO se colapsan: la fuerza del veredicto depende de cuál se
-- usó, así que la fuente viaja como columna consultable (no enterrada en un
-- jsonb) y la pantalla la explica con palabras.
--
-- No modifica migraciones congeladas.

create type public.clinical_nutrition_source as enum
  ('CONFIRMED_MEMBER_SERVING', 'PROJECTED_MEMBER_SERVING', 'RECIPE_BASE_ESTIMATE', 'NONE');

alter table public.meal_clinical_assessments
  add column if not exists nutrition_source public.clinical_nutrition_source
    not null default 'NONE';

comment on column public.meal_clinical_assessments.nutrition_source is
  'De dónde salió la nutrición evaluada. RECIPE_BASE_ESTIMATE es SCREENING: '
  'por sí solo jamás produce un COMPATIBLE fuerte para una restricción '
  'cuantitativa HARD/CRITICAL — el motor devuelve REVIEW_REQUIRED hasta que '
  'exista la porción individual.';

create index clinical_assessments_by_source
  on public.meal_clinical_assessments (member_id, nutrition_source);

-- ---------------------------------------------------------------------------
-- save_meal_clinical_assessment v2: recibe y guarda la fuente
-- ---------------------------------------------------------------------------

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
  v_source public.clinical_nutrition_source;
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

  -- La fuente es obligatoria en la práctica: sin ella no se puede saber si un
  -- veredicto habla de la persona. Si el payload no la trae, NONE — que el
  -- motor nunca convierte en un COMPATIBLE cuantitativo.
  v_source := coalesce(
    nullif(p_payload->>'nutrition_source', '')::public.clinical_nutrition_source,
    'NONE');

  insert into public.meal_clinical_assessments
    (member_id, version_id, assignment_id, assessed_on, engine_version, status,
     nutrition_source, reasons, missing_data, rule_refs, restriction_snapshot,
     observation_refs, proposed_adjustments)
  values
    (p_member_id, p_version_id, p_assignment_id, p_assessed_on, p_engine_version, p_status,
     v_source,
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
