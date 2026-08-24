-- Tests SQL de Sprint 2: RLS de catálogo y unicidad de barcode por ámbito.
-- Ejecutar tras aplicar migraciones + auth_stub en una base local (scripts/db-test.sh).
-- Falla con excepción si alguna aserción no se cumple.

\set ON_ERROR_STOP on

-- Usuarios de prueba
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.dev'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.dev');

-- Hogar A (como usuario A)
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.create_household('Hogar A', 'Ana') as household_a \gset

-- Hogar B (como usuario B)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select public.create_household('Hogar B', 'Beto') as household_b \gset

-- ---------------------------------------------------------------------------
-- G. Permisos de producto privado
-- ---------------------------------------------------------------------------

-- A crea un producto privado de su hogar
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.commercial_products (household_id, barcode, brand, name, source)
values (:'household_a', '2000000000015', 'Privada', 'Pan privado de A', 'USER_ENTERED_LABEL');

do $$
declare n int;
begin
  -- A ve su producto
  select count(*) into n from public.commercial_products where name = 'Pan privado de A';
  if n <> 1 then raise exception 'FALLO G1: A debería ver su producto (n=%)', n; end if;
end $$;

-- B no ve el producto privado de A
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$
declare n int;
begin
  select count(*) into n from public.commercial_products where name = 'Pan privado de A';
  if n <> 0 then raise exception 'FALLO G2: B NO debería ver el producto privado de A (n=%)', n; end if;
end $$;

-- B no puede insertar en el hogar de A
do $$
begin
  begin
    insert into public.commercial_products (household_id, name, source)
    values ((select household_id from public.household_members limit 0), 'x', 'USER_ENTERED_LABEL');
  exception when others then null;
  end;
  begin
    insert into public.commercial_products (household_id, name, source)
    select h.id, 'Intruso', 'USER_ENTERED_LABEL' from public.households h where h.name = 'Hogar A';
    -- Si la RLS funciona, el select no devuelve filas de A para B → 0 inserts. Verificamos:
  end;
  if exists (select 1 from public.commercial_products where name = 'Intruso') then
    raise exception 'FALLO G3: B pudo insertar en el hogar de A';
  end if;
end $$;

-- Un hogar no puede modificar datos globales verificados (ingredientes globales)
do $$
declare n int;
begin
  update public.ingredients set display_name = 'HACKED' where household_id is null;
  select count(*) into n from public.ingredients where display_name = 'HACKED';
  if n <> 0 then raise exception 'FALLO G4: un hogar modificó ingredientes globales'; end if;
end $$;

-- Ambos hogares SÍ ven el catálogo global
do $$
declare n int;
begin
  select count(*) into n from public.ingredients where household_id is null;
  if n < 15 then raise exception 'FALLO G5: catálogo global no visible (n=%)', n; end if;
end $$;

-- ---------------------------------------------------------------------------
-- F. Barcode duplicado en el ámbito correspondiente
-- ---------------------------------------------------------------------------

-- Mismo barcode que el producto de A, pero en hogar B: PERMITIDO (ámbitos distintos)
insert into public.commercial_products (household_id, barcode, name, source)
select h.id, '2000000000015', 'Pan privado de B', 'USER_ENTERED_LABEL'
from public.households h where h.name = 'Hogar B';

-- Duplicado dentro del MISMO hogar B: RECHAZADO
do $$
begin
  begin
    insert into public.commercial_products (household_id, barcode, name, source)
    select h.id, '2000000000015', 'Duplicado B', 'USER_ENTERED_LABEL'
    from public.households h where h.name = 'Hogar B';
    raise exception 'FALLO F1: barcode duplicado aceptado dentro del mismo hogar';
  exception
    when unique_violation then null; -- esperado
  end;
end $$;

-- ---------------------------------------------------------------------------
-- UNKNOWN != ZERO: el seed debe contener nutrientes NULL (no 0)
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.nutrition_facts
  where potassium_mg is null and source_type = 'DEV_SEED';
  if n = 0 then raise exception 'FALLO D1: no hay nutrientes desconocidos como NULL en el seed'; end if;
end $$;

-- Un hogar tampoco puede "verificar" datos globales (RLS: 0 filas afectadas)
do $$
declare n int;
begin
  update public.nutrition_facts set verified = true where source_type = 'DEV_SEED';
  select count(*) into n from public.nutrition_facts where source_type = 'DEV_SEED' and verified;
  if n <> 0 then raise exception 'FALLO G6: un hogar verificó datos globales'; end if;
end $$;

reset role;

-- DEV_SEED/AI_ESTIMATE jamás verificados: el constraint rechaza incluso al dueño de la tabla
do $$
declare v_ing uuid;
begin
  select id into v_ing from public.ingredients where household_id is null limit 1;
  begin
    insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
      energy_kcal, source_type, source_name, verified)
    values (v_ing, 'RAW', 'G', 100, 'DEV_SEED', 'x', true);
    raise exception 'FALLO D2: DEV_SEED aceptó verified=true';
  exception
    when check_violation then null;  -- esperado
  end;
end $$;
select 'RLS/catalog SQL tests: OK' as result;
