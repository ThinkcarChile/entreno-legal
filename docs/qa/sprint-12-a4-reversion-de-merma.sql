-- ---------------------------------------------------------------------------
-- ALTO A4 — "un ADJUSTMENT no puede revertir una merma"
-- Demostración del ataque, ANTES y DESPUÉS del bloque (6b) de
-- `app.movement_owner_guard` (0036).
-- ---------------------------------------------------------------------------
--
-- CÓMO SE CORRE. Contra una base con TODAS las migraciones aplicadas (el PGlite
-- del harness de integración, o un Postgres local de QA):
--
--     psql "$DATABASE_URL" -f docs/qa/sprint-12-a4-reversion-de-merma.sql
--
-- El script arma su propio andamiaje, ataca, IMPRIME el veredicto y hace
-- ROLLBACK: no deja ni una fila. No sirve para producción y no pretende
-- servir — ahí el veredicto lo da la regresión de vitest
-- (`web/src/integration/sprint12-regresiones.test.ts`, describe "ALTO 5").
--
-- QUÉ DEMUESTRA.
--   Un renglón sirve 200 g y el libro mayor le saca 200 g al lote (1000 -> 800).
--   De esos 200, 100 se botan: `discard_serving` los anota con delta 0 —el lote
--   ya pagó al servir— y con `covers_quantity` = -100.
--   El ataque apunta un ADJUSTMENT con `reverses_movement_id` a ESA merma.
--
--   ANTES del arreglo pasaba entero, y los topes que ya existían no lo veían:
--   el (7) mide contra la cobertura del movimiento original, que tiene 100
--   disponibles; y el (8) hace 0 devueltos + 100 botados + 100 = 200, que NO
--   supera los 200 que el renglón le sacó a la despensa. El lote subía de 800 a
--   900 mientras el espejo `discarded_quantity` seguía diciendo que esos mismos
--   cien gramos estaban botados: el mismo alimento en la basura y en la
--   despensa al mismo tiempo.
--
--   DESPUÉS, el bloque (6b) pregunta QUÉ se está revirtiendo. Solo un CONSUMED
--   se revierte; una merma se deshace por su propio camino
--   (`undo_discard_serving`), que devuelve el saldo del renglón SIN mover un
--   gramo de inventario.
--
-- Al final el script comprueba las dos mitades de la regla: que el camino
-- legítimo para deshacer un descarte mal marcado sigue abierto, y que revertir
-- un CONSUMED de verdad sigue funcionando.

begin;

-- Un usuario con sesión: los RPC son SECURITY DEFINER y preguntan por
-- `auth.uid()`, no por el rol de la conexión.
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000a4001', 'a4@qa.local')
on conflict (id) do nothing;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a4001', true);

insert into public.households (id, name)
values ('00000000-0000-0000-0000-0000000a4010', 'Hogar A4');

insert into public.household_members (id, household_id, user_id, display_name)
values ('00000000-0000-0000-0000-0000000a4011',
        '00000000-0000-0000-0000-0000000a4010',
        '00000000-0000-0000-0000-0000000a4001', 'QA A4');

-- Lote con 1000 g, por el libro mayor (jamás un UPDATE a mano al lote).
insert into public.inventory_lots (id, household_id, label, unit, quantity, weight_basis, status)
values ('00000000-0000-0000-0000-0000000a4020',
        '00000000-0000-0000-0000-0000000a4010',
        'Pechuga de pollo (sin piel)', 'G', 0, 'RAW', 'AVAILABLE');

insert into public.inventory_movements (household_id, lot_id, reason, delta)
values ('00000000-0000-0000-0000-0000000a4010',
        '00000000-0000-0000-0000-0000000a4020', 'PURCHASE', 1000);

-- Se sirve fuera de plan: 200 g.
insert into public.meal_serving_records (id, household_id, member_id, kind, served_on)
values ('00000000-0000-0000-0000-0000000a4030',
        '00000000-0000-0000-0000-0000000a4010',
        '00000000-0000-0000-0000-0000000a4011', 'OFF_PLAN', current_date);

insert into public.meal_serving_record_items
  (id, record_id, label, served_quantity, served_unit, served_weight_basis,
   served_quantity_is_declared)
values ('00000000-0000-0000-0000-0000000a4031',
        '00000000-0000-0000-0000-0000000a4030',
        'Pechuga de pollo (sin piel)', 200, 'G', 'RAW', true);

-- El descuento físico: 200 g menos en el lote, colgados del renglón.
insert into public.inventory_movements
  (id, household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
values ('00000000-0000-0000-0000-0000000a4040',
        '00000000-0000-0000-0000-0000000a4010',
        '00000000-0000-0000-0000-0000000a4020', 'CONSUMED', -200,
        '00000000-0000-0000-0000-0000000a4031', -200);

update public.meal_serving_record_items
set deducted_quantity = 200
where id = '00000000-0000-0000-0000-0000000a4031';

-- La merma: de los 200 servidos, 100 se botaron. Por el RPC de verdad.
select public.discard_serving('00000000-0000-0000-0000-0000000a4031'::uuid, 100,
                              'se enfrió y nadie se lo comió',
                              '00000000-0000-0000-0000-0000000a4050'::uuid);

-- ---------------------------------------------------------------------------
-- EL ATAQUE
-- ---------------------------------------------------------------------------
do $$
declare
  v_merma   uuid;
  v_antes   numeric;
  v_despues numeric;
  v_botado  numeric;
begin
  select m.id into v_merma
  from public.inventory_movements m
  where m.serving_record_item_id = '00000000-0000-0000-0000-0000000a4031'
    and m.reason = 'DISCARDED_LEFTOVER'
    and m.covers_quantity < 0
  order by m.created_at desc, m.id desc
  limit 1;

  select quantity into v_antes from public.inventory_lots
  where id = '00000000-0000-0000-0000-0000000a4020';

  raise notice '--- ATAQUE A4: revertir la merma % ---', v_merma;
  raise notice 'lote ANTES: % g', v_antes;

  begin
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, serving_record_item_id,
       covers_quantity, reverses_movement_id, notes)
    values ('00000000-0000-0000-0000-0000000a4010',
            '00000000-0000-0000-0000-0000000a4020', 'ADJUSTMENT', 100,
            '00000000-0000-0000-0000-0000000a4031', 100, v_merma,
            'ataque A4: sacar comida de la basura y ponerla en la despensa');

    select quantity into v_despues from public.inventory_lots
    where id = '00000000-0000-0000-0000-0000000a4020';
    select discarded_quantity into v_botado from public.meal_serving_record_items
    where id = '00000000-0000-0000-0000-0000000a4031';

    raise warning
      'AGUJERO ABIERTO — la reversión de la merma pasó: el lote subió de % a % g y el renglón sigue declarando % g en la basura. Los mismos gramos en dos lugares.',
      v_antes, v_despues, v_botado;
  exception when others then
    raise notice 'AGUJERO CERRADO — la base rechazó la reversión: %', sqlerrm;
    select quantity into v_despues from public.inventory_lots
    where id = '00000000-0000-0000-0000-0000000a4020';
    raise notice 'lote DESPUÉS: % g (intacto)', v_despues;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- LO QUE NO SE PUEDE ROMPER AL TAPAR EL AGUJERO
-- ---------------------------------------------------------------------------
do $$
declare v_botado numeric; v_lote numeric;
begin
  -- (a) Deshacer un descarte mal marcado sigue siendo un camino legítimo:
  --     `undo_discard_serving` NO escribe `reverses_movement_id` y NO mueve
  --     inventario. Solo le devuelve al renglón el derecho a decidir.
  perform public.undo_discard_serving('00000000-0000-0000-0000-0000000a4031'::uuid, 100,
                                      'estaba mal marcado',
                                      '00000000-0000-0000-0000-0000000a4060'::uuid);

  select discarded_quantity into v_botado from public.meal_serving_record_items
  where id = '00000000-0000-0000-0000-0000000a4031';
  select quantity into v_lote from public.inventory_lots
  where id = '00000000-0000-0000-0000-0000000a4020';

  raise notice 'undo_discard_serving OK — basura declarada: % g, lote: % g (sin mover un gramo)',
    v_botado, v_lote;

  -- (b) Y revertir un CONSUMED de verdad —el único caso legítimo— sigue
  --     devolviendo los gramos al lote del que salieron.
  perform public.return_serving_to_inventory('00000000-0000-0000-0000-0000000a4031'::uuid, 100,
                                             'se sirvió de más');
  select quantity into v_lote from public.inventory_lots
  where id = '00000000-0000-0000-0000-0000000a4020';
  raise notice 'return_serving_to_inventory OK — lote: % g (800 + 100 devueltos)', v_lote;
end $$;

rollback;
