-- Tests SQL de Sprint 3: aislamiento de recetas por hogar, intocabilidad de la
-- biblioteca global e inmutabilidad de las versiones publicadas.
-- Ejecutar tras migraciones + auth_stub + seeds (scripts/db-test.sh).
-- Falla con excepción si alguna aserción no se cumple.

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000010a', 'ra@test.dev'),
  ('00000000-0000-0000-0000-00000000010b', 'rb@test.dev');

set role authenticated;

-- Sin metacomandos de psql: los hogares se referencian por nombre, para que
-- estos tests corran también fuera de psql.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000010a', false);
select public.create_household('Hogar Receta A', 'Ana');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000010b', false);
select public.create_household('Hogar Receta B', 'Beto');

-- ---------------------------------------------------------------------------
-- H. Una receta global no es modificable por un hogar
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000010a', false);

do $$
declare n int; v_global uuid;
begin
  -- Las recetas globales del seed SÍ se ven.
  select count(*) into n from public.meal_templates where household_id is null;
  if n < 8 then raise exception 'FALLO H0: A debería ver la biblioteca global (n=%)', n; end if;

  select id into v_global from public.meal_templates
  where household_id is null and name = 'Pollo con arroz y ensalada chilena';

  -- ...pero no se pueden modificar.
  update public.meal_templates set name = 'Secuestrada' where id = v_global;
  if exists (select 1 from public.meal_templates where name = 'Secuestrada') then
    raise exception 'FALLO H1: un hogar NO puede renombrar una receta global';
  end if;

  delete from public.meal_templates where id = v_global;
  if not exists (select 1 from public.meal_templates where id = v_global) then
    raise exception 'FALLO H2: un hogar NO puede borrar una receta global';
  end if;

  -- Tampoco su contenido.
  update public.meal_template_versions set base_servings = 99
  where template_id = v_global;
  if exists (select 1 from public.meal_template_versions
             where template_id = v_global and base_servings = 99) then
    raise exception 'FALLO H3: un hogar NO puede editar una versión global';
  end if;
end $$;

-- Pero SÍ puede copiarla a sus recetas ("Copiar a mis recetas").
do $$
declare v_global uuid; v_copy uuid; n int;
begin
  select id into v_global from public.meal_templates
  where household_id is null and name = 'Pollo con arroz y ensalada chilena';

  v_copy := public.duplicate_meal_template(v_global,
    (select id from public.households where name = 'Hogar Receta A'), 'Mi pollo con arroz');

  select count(*) into n from public.meal_templates
  where id = v_copy and household_id is not null and copied_from_id = v_global;
  if n <> 1 then raise exception 'FALLO H4: la copia debería quedar en el hogar de A'; end if;

  -- La copia trae el contenido, en borrador.
  select count(*) into n from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  join public.meal_template_versions v on v.id = s.version_id
  where v.template_id = v_copy;
  if n = 0 then raise exception 'FALLO H5: la copia llegó sin ingredientes'; end if;

  select count(*) into n from public.meal_template_versions
  where template_id = v_copy and status = 'DRAFT' and version_number = 1;
  if n <> 1 then raise exception 'FALLO H6: la copia debería nacer como borrador v1'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- I. Una receta del hogar es invisible para otros hogares
-- ---------------------------------------------------------------------------

do $$
declare v_version uuid; v_household uuid;
begin
  select id into v_household from public.households where name = 'Hogar Receta A';
  v_version := public.create_meal_template(v_household, 'Cazuela secreta de Ana', 'MEAL', '{LUNCH}', 4);

  perform public.replace_draft_content(v_version, jsonb_build_object(
    'name', 'Cazuela secreta de Ana',
    'base_servings', 4,
    'meal_types', jsonb_build_array('LUNCH'),
    'slots', jsonb_build_array(jsonb_build_object(
      'slot_type', 'PROTEIN', 'sort_order', 1,
      'components', jsonb_build_array(jsonb_build_object(
        'ingredient_id', (select id from public.ingredients
                          where canonical_name = 'pechuga de pollo sin piel' and household_id is null),
        'nutrition_fact_id', (select f.id from public.nutrition_facts f
                              join public.ingredients i on i.id = f.ingredient_id
                              where i.canonical_name = 'pechuga de pollo sin piel'
                                and i.household_id is null and f.weight_basis = 'RAW'),
        'quantity', 800, 'unit', 'G', 'weight_basis', 'RAW', 'sort_order', 1))))
  ));

  perform public.publish_meal_template_version(v_version);
end $$;

do $$
declare n int;
begin
  select count(*) into n from public.meal_templates where name = 'Cazuela secreta de Ana';
  if n <> 1 then raise exception 'FALLO I1: A debería ver su propia receta (n=%)', n; end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000010b', false);
do $$
declare n int;
begin
  select count(*) into n from public.meal_templates where name = 'Cazuela secreta de Ana';
  if n <> 0 then raise exception 'FALLO I2: B NO debería ver la receta de A (n=%)', n; end if;

  select count(*) into n from public.meal_template_versions v
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana';
  if n <> 0 then raise exception 'FALLO I3: B NO debería ver versiones de la receta de A (n=%)', n; end if;

  select count(*) into n from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  join public.meal_template_versions v on v.id = s.version_id
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana';
  if n <> 0 then raise exception 'FALLO I4: B NO debería ver los ingredientes de la receta de A (n=%)', n; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Publicar congela la ficha nutricional usada (ADR 0002 §3)
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000010a', false);

do $$
declare v_frozen jsonb;
begin
  select c.frozen_nutrition into v_frozen
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  join public.meal_template_versions v on v.id = s.version_id
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana';

  if v_frozen is null then
    raise exception 'FALLO F1: publicar debe congelar la ficha nutricional del componente';
  end if;
  if (v_frozen->'values'->>'energy_kcal') is null then
    raise exception 'FALLO F2: el snapshot congelado llegó sin valores';
  end if;
  if (v_frozen->>'weight_basis') <> 'RAW' then
    raise exception 'FALLO F3: el snapshot perdió la base (esperaba RAW, vino %)', v_frozen->>'weight_basis';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Inmutabilidad: una versión publicada no se edita, se versiona (K-21)
-- ---------------------------------------------------------------------------

do $$
declare v_version uuid; v_slot uuid; ok boolean;
begin
  select v.id into v_version
  from public.meal_template_versions v
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana' and v.status = 'PUBLISHED';

  -- Editar la versión publicada
  ok := false;
  begin
    update public.meal_template_versions set base_servings = 8 where id = v_version;
  exception when others then ok := true;
  end;
  if not ok and exists (select 1 from public.meal_template_versions
                        where id = v_version and base_servings = 8) then
    raise exception 'FALLO M1: se pudo editar una versión publicada';
  end if;

  -- Agregar contenido a la versión publicada
  select id into v_slot from public.meal_slots where version_id = v_version limit 1;
  ok := false;
  begin
    insert into public.meal_slot_components (slot_id, ingredient_id, quantity, unit, weight_basis)
    values (v_slot, (select id from public.ingredients where canonical_name = 'tomate' and household_id is null),
            100, 'G', 'RAW');
  exception when others then ok := true;
  end;
  if not ok then
    raise exception 'FALLO M2: se pudo agregar un ingrediente a una versión publicada';
  end if;

  -- El camino correcto: crear la versión siguiente
  perform public.create_draft_from_version(v_version);
end $$;

do $$
declare n int; v_v1 numeric;
begin
  select count(*) into n from public.meal_template_versions v
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana';
  if n <> 2 then raise exception 'FALLO M3: debería haber v1 + v2 (n=%)', n; end if;

  select count(*) into n from public.meal_template_versions v
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana' and v.version_number = 2 and v.status = 'DRAFT';
  if n <> 1 then raise exception 'FALLO M4: v2 debería existir en borrador'; end if;

  -- v1 sigue intacta
  select c.quantity into v_v1
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  join public.meal_template_versions v on v.id = s.version_id
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana' and v.version_number = 1;
  if v_v1 <> 800 then raise exception 'FALLO M5: v1 cambió (cantidad=%)', v_v1; end if;

  -- v2 SÍ se puede editar: es borrador
  update public.meal_slot_components c set quantity = 1000
  from public.meal_slots s, public.meal_template_versions v, public.meal_templates t
  where c.slot_id = s.id and s.version_id = v.id and v.template_id = t.id
    and t.name = 'Cazuela secreta de Ana' and v.version_number = 2;

  select c.quantity into v_v1
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  join public.meal_template_versions v on v.id = s.version_id
  join public.meal_templates t on t.id = v.template_id
  where t.name = 'Cazuela secreta de Ana' and v.version_number = 1;
  if v_v1 <> 800 then raise exception 'FALLO M6: editar v2 alteró v1 (cantidad=%)', v_v1; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Estructura: alternativas culinarias sin equivalencia nutricional
-- ---------------------------------------------------------------------------

set role postgres;

do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
  where table_name = 'meal_slot_alternatives'
    and column_name in ('nutritional_equivalence', 'nutrition_ratio', 'kcal_equivalence');
  if n <> 0 then
    raise exception 'FALLO G1: meal_slot_alternatives no debe expresar equivalencia nutricional';
  end if;

  select count(*) into n from public.meal_slot_alternatives;
  if n = 0 then raise exception 'FALLO G2: el seed debería traer alternativas culinarias'; end if;
end $$;

-- Un componente apunta a exactamente un objetivo
do $$
declare ok boolean := false;
begin
  begin
    insert into public.meal_slot_components (slot_id, quantity, unit, weight_basis)
    values ((select id from public.meal_slots limit 1), 100, 'G', 'RAW');
  exception when others then ok := true;
  end;
  if not ok then raise exception 'FALLO C1: un componente sin objetivo no debería insertarse'; end if;
end $$;

-- Un paso con equipamiento opcional obliga a tener alternativa manual (K-15)
do $$
declare ok boolean := false;
begin
  begin
    insert into public.recipe_steps (version_id, step_number, instruction, optional_capability)
    values ((select id from public.meal_template_versions where status = 'DRAFT' limit 1),
            99, 'Usar air fryer', 'AIR_FRYER');
  exception when others then ok := true;
  end;
  if not ok then
    raise exception 'FALLO K15: un paso con equipamiento opcional exige camino manual';
  end if;
end $$;

reset role;
