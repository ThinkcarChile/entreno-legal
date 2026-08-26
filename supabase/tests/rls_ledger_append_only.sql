-- Tests SQL del Sprint 12 (bloqueante B1): el escape de `on delete set null`
-- en las guardas append-only tiene que ser QUIRÚRGICO.
--
-- Ejecutar tras aplicar migraciones + auth_stub en una base local
-- (scripts/db-test.sh). Falla con excepción si alguna aserción no se cumple.
--
-- Dos notas sobre cómo está escrito:
--
--  · El prefijo `rls_` es lo que globea scripts/db-test.sh. Lo que se prueba
--    acá no es RLS, son los triggers de historia inmutable.
--  · Corre como SUPERUSUARIO a propósito, sin `set role authenticated`. Si se
--    probara como `authenticated`, el UPDATE del atacante no tocaría ninguna
--    fila porque `inventory_movements` no tiene policy de UPDATE — el test
--    pasaría sin que el trigger hubiera abierto la boca. Un candado que hay que
--    probar con el usuario más poderoso que existe, o no se probó.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Escenario mínimo: un hogar, dos integrantes, un lote, un movimiento.
-- ---------------------------------------------------------------------------

insert into public.households (id, name)
values ('000000b1-0000-0000-0000-000000000001', 'Hogar B1');

insert into public.household_members (id, household_id, display_name) values
  ('000000b1-0000-0000-0000-000000000002', '000000b1-0000-0000-0000-000000000001', 'Quien anota'),
  ('000000b1-0000-0000-0000-000000000003', '000000b1-0000-0000-0000-000000000001', 'Quien queda');

insert into public.inventory_lots (id, household_id, label, unit)
values ('000000b1-0000-0000-0000-000000000004',
        '000000b1-0000-0000-0000-000000000001', 'Arroz de prueba', 'G');

insert into public.inventory_movements
  (id, household_id, lot_id, reason, delta, actor_member_id)
values ('000000b1-0000-0000-0000-000000000005',
        '000000b1-0000-0000-0000-000000000001',
        '000000b1-0000-0000-0000-000000000004',
        'PURCHASE', 1000, '000000b1-0000-0000-0000-000000000002');

-- ---------------------------------------------------------------------------
-- A. EL ATAQUE DIRECTO SIGUE REBOTANDO
--
-- Tres formas de intentarlo desde afuera; las tres tienen que morir con el
-- mensaje de siempre. Es la prueba de que el escape no abrió ninguna puerta:
-- el cliente dispara el trigger en profundidad 1 y nunca llega a la rama.
-- ---------------------------------------------------------------------------

do $$
declare v_reboto boolean;
begin
  -- A1. Anular a mano la MISMA columna que la acción referencial anularía.
  --     Es el intento más parecido a lo permitido, y aún así rebota.
  v_reboto := false;
  begin
    update public.inventory_movements set actor_member_id = null
    where id = '000000b1-0000-0000-0000-000000000005';
  exception when others then
    v_reboto := true;
    if sqlerrm not like 'el libro mayor de inventario es append-only%' then
      raise exception 'FALLO A1: rebotó con el mensaje equivocado: %', sqlerrm;
    end if;
  end;
  if not v_reboto then
    raise exception 'FALLO A1: un cliente pudo anular a mano una FK del libro mayor';
  end if;

  -- A2. Editar el número. Esto es la conservación de valor (K-19).
  v_reboto := false;
  begin
    update public.inventory_movements set delta = 0
    where id = '000000b1-0000-0000-0000-000000000005';
  exception when others then
    v_reboto := true;
    if sqlerrm not like 'el libro mayor de inventario es append-only%' then
      raise exception 'FALLO A2: rebotó con el mensaje equivocado: %', sqlerrm;
    end if;
  end;
  if not v_reboto then
    raise exception 'FALLO A2: se pudo editar el delta de un movimiento';
  end if;

  -- A3. Un UPDATE que no cambia nada tampoco pasa: el escape exige que haya
  --     UNA anulación real, no basta con "no cambié nada malo".
  v_reboto := false;
  begin
    update public.inventory_movements set serving_record_item_id = null
    where id = '000000b1-0000-0000-0000-000000000005';
  exception when others then
    v_reboto := true;
  end;
  if not v_reboto then
    raise exception 'FALLO A3: un UPDATE no-op del cliente pasó por el escape';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- B. ESTAR ADENTRO DE UN TRIGGER NO ALCANZA
--
-- La profundidad es una de tres condiciones, no la única. Acá el UPDATE sale
-- desde adentro de un trigger (profundidad > 1, igual que una acción
-- referencial) pero toca una columna que no está en la lista blanca. Tiene que
-- rebotar igual.
-- ---------------------------------------------------------------------------

create table public.b1_disparo (id int primary key);

create function public.b1_ataque_anidado() returns trigger language plpgsql as $$
begin
  update public.inventory_movements set delta = -999
  where id = '000000b1-0000-0000-0000-000000000005';
  return new;
end;
$$;

create trigger b1_ataque
  after insert on public.b1_disparo
  for each row execute function public.b1_ataque_anidado();

do $$
declare v_reboto boolean := false;
begin
  begin
    insert into public.b1_disparo (id) values (1);
  exception when others then
    v_reboto := true;
    if sqlerrm not like 'el libro mayor de inventario es append-only%' then
      raise exception 'FALLO B: rebotó con el mensaje equivocado: %', sqlerrm;
    end if;
  end;
  if not v_reboto then
    raise exception 'FALLO B: un trigger pudo editar el libro mayor colándose por la profundidad';
  end if;
end $$;

drop trigger b1_ataque on public.b1_disparo;
drop function public.b1_ataque_anidado();
drop table public.b1_disparo;

-- ---------------------------------------------------------------------------
-- C. LO QUE ANTES REVENTABA AHORA FUNCIONA — Y NO TOCA NADA MÁS
--
-- Borrar al integrante que anotó el movimiento dispara la acción referencial
-- `set null` sobre `inventory_movements.actor_member_id`. Antes de esta
-- corrección, el borrado moría con "el libro mayor es append-only", un mensaje
-- que además mentía sobre la causa.
-- ---------------------------------------------------------------------------

create temp table b1_antes as
  select * from public.inventory_movements
  where id = '000000b1-0000-0000-0000-000000000005';

delete from public.household_members
where id = '000000b1-0000-0000-0000-000000000002';

do $$
declare
  v_antes jsonb;
  v_ahora jsonb;
  v_actor uuid;
begin
  select actor_member_id into v_actor from public.inventory_movements
  where id = '000000b1-0000-0000-0000-000000000005';
  if v_actor is not null then
    raise exception 'FALLO C1: la acción referencial no anuló el puntero';
  end if;

  -- Y NADA más cambió: se compara la fila entera menos esa columna.
  select to_jsonb(a) - 'actor_member_id' into v_antes from b1_antes a;
  select to_jsonb(m) - 'actor_member_id' into v_ahora
  from public.inventory_movements m where id = '000000b1-0000-0000-0000-000000000005';
  if v_antes is distinct from v_ahora then
    raise exception 'FALLO C2: el borrado cambió algo más que el puntero: % vs %', v_antes, v_ahora;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- D. LA PIEZA SOLA: `app.is_fk_set_null_update`
--
-- Cada condición del escape, aislada. Es el contrato de la función escrito como
-- test: si mañana alguien la "simplifica", esto se cae.
-- ---------------------------------------------------------------------------

do $$
begin
  -- Valor → NULL en una columna de la lista: es un `set null`.
  if not app.is_fk_set_null_update(
       '{"a":"x","b":1}'::jsonb, '{"a":null,"b":1}'::jsonb, array['a']) then
    raise exception 'FALLO D1: no reconoció un set null legítimo';
  end if;

  -- NULL → valor: eso es escribir, no anular.
  if app.is_fk_set_null_update(
       '{"a":null,"b":1}'::jsonb, '{"a":"x","b":1}'::jsonb, array['a']) then
    raise exception 'FALLO D2: dejó pasar un NULL → valor';
  end if;

  -- Valor → otro valor: repuntar una fila a otra no es una acción referencial.
  if app.is_fk_set_null_update(
       '{"a":"x","b":1}'::jsonb, '{"a":"y","b":1}'::jsonb, array['a']) then
    raise exception 'FALLO D3: dejó pasar un valor → otro valor';
  end if;

  -- Anula bien PERO además cambia otra columna: el polizón viaja gratis. No.
  if app.is_fk_set_null_update(
       '{"a":"x","b":1}'::jsonb, '{"a":null,"b":2}'::jsonb, array['a']) then
    raise exception 'FALLO D4: dejó pasar un cambio colado junto a la anulación';
  end if;

  -- Anula una columna que NO está en la lista blanca.
  if app.is_fk_set_null_update(
       '{"a":"x","b":1}'::jsonb, '{"a":"x","b":null}'::jsonb, array['a']) then
    raise exception 'FALLO D5: anuló una columna fuera de la lista blanca';
  end if;

  -- No cambió nada: no es un `set null`, es un UPDATE sin motivo.
  if app.is_fk_set_null_update(
       '{"a":"x","b":1}'::jsonb, '{"a":"x","b":1}'::jsonb, array['a']) then
    raise exception 'FALLO D6: dejó pasar un UPDATE que no anula nada';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Limpieza: este test no deja hogar de prueba en la base.
-- ---------------------------------------------------------------------------
delete from public.households where id = '000000b1-0000-0000-0000-000000000001';

select 'B1 OK: el escape de set null funciona y el append-only sigue cerrado' as resultado;
