-- Tests SQL de Sprint 4: los datos nutricionales personales son privados del
-- hogar (§50, §51). Objetivos, preferencias, perfiles y porciones no cruzan.

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000020a', 'pa@test.dev'),
  ('00000000-0000-0000-0000-00000000020b', 'pb@test.dev');

set role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000020a', false);
select public.create_household('Hogar Perfil A', 'Ana');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000020b', false);
select public.create_household('Hogar Perfil B', 'Beto');

-- ---------------------------------------------------------------------------
-- A configura su nutrición
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000020a', false);

do $$
declare v_member uuid; v_pattern uuid; v_profile uuid;
begin
  select m.id into v_member from public.household_members m
  join public.households h on h.id = m.household_id
  where h.name = 'Hogar Perfil A';

  insert into public.member_tracking_settings (member_id, mode) values (v_member, 'FULL');

  insert into public.nutrition_goals
    (member_id, goal_type, scope, meal_type, minimum, preferred, maximum, unit)
  values
    (v_member, 'PROTEIN_G', 'DAILY', null, 120, 130, null, 'g'),
    (v_member, 'PROTEIN_G', 'PER_MEAL', 'LUNCH', 50, 65, 80, 'g'),
    (v_member, 'ENERGY_KCAL', 'PER_MEAL', 'LUNCH', null, null, 800, 'kcal');

  insert into public.meal_patterns (member_id, uses_fasting_pattern, first_meal_type)
  values (v_member, true, 'LUNCH') returning id into v_pattern;
  insert into public.meal_pattern_slots (pattern_id, meal_type, availability, is_first_meal)
  values (v_pattern, 'BREAKFAST', 'DISABLED', false), (v_pattern, 'LUNCH', 'ENABLED', true);

  insert into public.member_added_fat_preferences (member_id, stance) values (v_member, 'AVOID');

  v_profile := public.publish_nutrition_profile(
    v_member, 'FULL', 'firma-1',
    '{"goals":3}'::jsonb,
    '{"PROTEIN_G":{"minimum":120,"preferred":130,"maximum":null}}'::jsonb,
    '{"LUNCH":{"PROTEIN_G":{"minimum":50,"preferred":65,"maximum":80}}}'::jsonb,
    '{}'::jsonb, 'seed de prueba');

  if v_profile is null then raise exception 'FALLO P0: no se creó el perfil'; end if;
end $$;

-- Mismas entradas => no se versiona de nuevo (§17)
do $$
declare v_member uuid; v_a uuid; v_b uuid; n int;
begin
  select m.id into v_member from public.household_members m
  join public.households h on h.id = m.household_id where h.name = 'Hogar Perfil A';

  v_a := public.publish_nutrition_profile(v_member, 'FULL', 'firma-1', '{}'::jsonb,
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, null);
  v_b := public.publish_nutrition_profile(v_member, 'FULL', 'firma-2', '{}'::jsonb,
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'cambió un objetivo');

  if v_a = v_b then raise exception 'FALLO P1: una firma distinta debe crear versión nueva'; end if;

  select count(*) into n from public.member_nutrition_profiles where member_id = v_member;
  if n <> 2 then raise exception 'FALLO P2: se esperaban 2 versiones, hay %', n; end if;

  select count(*) into n from public.member_nutrition_profiles
  where member_id = v_member and is_current;
  if n <> 1 then raise exception 'FALLO P3: debe haber exactamente un perfil vigente'; end if;
end $$;

-- Un snapshot publicado no se reescribe
do $$
declare v_id uuid; ok boolean := false;
begin
  select p.id into v_id from public.member_nutrition_profiles p
  join public.household_members m on m.id = p.member_id
  join public.households h on h.id = m.household_id
  where h.name = 'Hogar Perfil A' and p.version = 1;

  begin
    update public.member_nutrition_profiles set daily_targets = '{"hackeado":true}'::jsonb where id = v_id;
  exception when others then ok := true;
  end;
  if not ok then raise exception 'FALLO P4: se pudo reescribir un snapshot de perfil'; end if;
end $$;

-- El cambio de perfil deja evento en el outbox (§45)
do $$
declare n int;
begin
  select count(*) into n from public.domain_events
  where event_type = 'NUTRITION_PROFILE_CHANGED';
  if n < 2 then raise exception 'FALLO P5: faltan eventos NUTRITION_PROFILE_CHANGED (n=%)', n; end if;
end $$;

-- ---------------------------------------------------------------------------
-- B no ve NADA de la nutrición de A (§50)
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000020b', false);

do $$
declare n int;
begin
  select count(*) into n from public.nutrition_goals;
  if n <> 0 then raise exception 'FALLO R1: B NO debería ver objetivos de A (n=%)', n; end if;

  select count(*) into n from public.member_tracking_settings;
  if n <> 0 then raise exception 'FALLO R2: B NO debería ver el tracking de A (n=%)', n; end if;

  select count(*) into n from public.meal_patterns;
  if n <> 0 then raise exception 'FALLO R3: B NO debería ver el patrón de comidas de A (n=%)', n; end if;

  select count(*) into n from public.meal_pattern_slots;
  if n <> 0 then raise exception 'FALLO R4: B NO debería ver las comidas de A (n=%)', n; end if;

  select count(*) into n from public.member_nutrition_profiles;
  if n <> 0 then raise exception 'FALLO R5: B NO debería ver los perfiles de A (n=%)', n; end if;

  select count(*) into n from public.member_added_fat_preferences;
  if n <> 0 then raise exception 'FALLO R6: B NO debería ver las preferencias de A (n=%)', n; end if;
end $$;

-- B tampoco puede escribir sobre un integrante de A
do $$
declare v_member uuid; ok boolean := false;
begin
  set role postgres;
  select m.id into v_member from public.household_members m
  join public.households h on h.id = m.household_id where h.name = 'Hogar Perfil A';
  set role authenticated;

  begin
    insert into public.nutrition_goals (member_id, goal_type, scope, preferred, unit)
    values (v_member, 'PROTEIN_G', 'DAILY', 999, 'g');
  exception when others then ok := true;
  end;
  if not ok then
    if exists (select 1 from public.nutrition_goals where preferred = 999) then
      raise exception 'FALLO R7: B pudo escribir un objetivo en el hogar de A';
    end if;
  end if;

  begin
    perform public.publish_nutrition_profile(v_member, 'FULL', 'intruso', '{}'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, null);
    raise exception 'FALLO R8: B pudo publicar un perfil en el hogar de A';
  exception when others then
    if sqlerrm like 'FALLO R8%' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Ajustabilidad de componentes (§28): el seed ya la trae resuelta
-- ---------------------------------------------------------------------------

set role postgres;

do $$
declare n int;
begin
  select count(*) into n from public.meal_slot_components where adjustability is null;
  if n <> 0 then raise exception 'FALLO S1: hay componentes sin ajustabilidad (n=%)', n; end if;

  select count(*) into n from public.meal_slot_components
  where is_optional and adjustability <> 'OPTIONAL';
  if n <> 0 then raise exception 'FALLO S2: un componente opcional debería ser OPTIONAL (n=%)', n; end if;
end $$;

-- Un objetivo sin ningún número no se guarda
do $$
declare v_member uuid; ok boolean := false;
begin
  select id into v_member from public.household_members limit 1;
  begin
    insert into public.nutrition_goals (member_id, goal_type, scope, unit)
    values (v_member, 'FAT_G', 'DAILY', 'g');
  exception when others then ok := true;
  end;
  if not ok then raise exception 'FALLO S3: un objetivo sin mínimo, ideal ni máximo no es un objetivo'; end if;
end $$;

-- Un rango invertido tampoco
do $$
declare v_member uuid; ok boolean := false;
begin
  select id into v_member from public.household_members limit 1;
  begin
    insert into public.nutrition_goals (member_id, goal_type, scope, minimum, maximum, unit)
    values (v_member, 'FIBER_G', 'DAILY', 90, 30, 'g');
  exception when others then ok := true;
  end;
  if not ok then raise exception 'FALLO S4: mínimo mayor que máximo no debería aceptarse'; end if;
end $$;

-- Una propuesta de IA no puede nacer activa
do $$
declare v_member uuid; ok boolean := false;
begin
  select id into v_member from public.household_members limit 1;
  begin
    insert into public.nutrition_goals (member_id, goal_type, scope, preferred, unit, source, status)
    values (v_member, 'CARBOHYDRATE_G', 'DAILY', 200, 'g', 'AI_ESTIMATE'::text::public.goal_source, 'ACTIVE');
  exception when others then ok := true;
  end;
  if not ok then raise exception 'FALLO S5: una propuesta de IA no entra en cálculo sin confirmar'; end if;
end $$;

reset role;
