-- ---------------------------------------------------------------------------
-- Sprint 12 / B2: el saldo físico de un renglón servido se gasta UNA sola vez.
-- ---------------------------------------------------------------------------
--
-- Los gramos que salieron de la despensa por un renglón servido pueden volver
-- por tres caminos —corregir lo servido, devolver al refrigerador, declararlos
-- basura— y los tres comen del MISMO saldo. Antes de este parche, botar no
-- gastaba nada: se podía botar 200 y después devolver los mismos 200, y el
-- inventario terminaba creyendo que tenía comida que estaba en el basurero.
--
-- Este archivo ES la demostración: contra la versión anterior de
-- `0036_foodlog_plan_vs_reality.sql` falla en "FALLO 4 (ATAQUE B2 VIVO)";
-- contra la versión parchada pasa entero.
--
-- Cómo correrlo (necesita PostgreSQL local; ver scripts/db-test.sh):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/auth_stub.sql
--   for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/foodlog_discard_budget.sql
--
-- Corre como superusuario A PROPÓSITO: así el ataque final —escribir la
-- devolución directo en el libro mayor, sin pasar por ningún RPC— llega hasta
-- el trigger. Si el candado dependiera de la RLS o de la buena fe del cliente,
-- este archivo lo delataría.

\set ON_ERROR_STOP on

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000d1', 'merma-b2@test.dev')
on conflict (id) do nothing;

do $$
declare
  v_hogar    uuid;
  v_miembro  uuid;
  v_lote     uuid;
  v_registro uuid;
  v_renglon  uuid;
  v_mov      uuid;
  v_qty      numeric;
  v_ok       boolean;
  v_msg      text;
begin
  perform set_config('request.jwt.claim.sub',
                     '00000000-0000-0000-0000-0000000000d1', true);

  v_hogar := public.create_household('Hogar merma B2', 'Dani');
  select id into v_miembro from public.household_members
  where household_id = v_hogar order by created_at limit 1;

  -- Un lote de 1000 g sin identidad de catálogo: alcanza para el efecto físico
  -- y no arrastra el catálogo entero al test.
  v_lote := public.add_manual_lot(v_hogar, 'Arroz cocido de prueba B2', 1000, 'G');

  -- Servir 200 g fuera de plan: el único camino que descuenta inventario.
  v_registro := public.serve_off_plan(v_miembro, v_lote, 200);
  select id into v_renglon from public.meal_serving_record_items
  where record_id = v_registro;

  select quantity into v_qty from public.inventory_lots where id = v_lote;
  if v_qty <> 800 then
    raise exception 'FALLO 1: servir 200 debería dejar el lote en 800, quedó en %', v_qty;
  end if;

  -- -------------------------------------------------------------------------
  -- Se botó todo lo servido. El lote NO se mueve: ya pagó al servir.
  -- -------------------------------------------------------------------------
  perform public.discard_serving(v_renglon, 200, 'se cayó al suelo');

  select quantity into v_qty from public.inventory_lots where id = v_lote;
  if v_qty <> 800 then
    raise exception 'FALLO 2: botar no puede volver a descontar (lote en %)', v_qty;
  end if;

  select discarded_quantity into v_qty from public.meal_serving_record_items
  where id = v_renglon;
  if v_qty <> 200 then
    raise exception 'FALLO 3: la merma tiene que quedar registrada en el renglón (fue %)', v_qty;
  end if;

  -- -------------------------------------------------------------------------
  -- EL ATAQUE B2: devolver al inventario comida que ya está en la basura.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.return_serving_to_inventory(v_renglon, 200, 'volvió al refrigerador');
  exception when sqlstate '23514' then
    get stacked diagnostics v_msg = message_text;
    v_ok := true;
  end;
  if not v_ok then
    raise exception
      'FALLO 4 (ATAQUE B2 VIVO): se devolvieron al inventario 200 g que ya se habían declarado basura';
  end if;
  raise notice 'ataque bloqueado al devolver: %', v_msg;

  select quantity into v_qty from public.inventory_lots where id = v_lote;
  if v_qty <> 800 then
    raise exception 'FALLO 5: el ataque alcanzó a mover el lote a %', v_qty;
  end if;

  -- Mismo saldo, otro camino: corregir lo servido a la baja.
  v_ok := false;
  begin
    perform public.correct_serving_item(v_renglon, 0, 'en realidad no serví nada');
  exception when sqlstate '23514' then
    get stacked diagnostics v_msg = message_text;
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FALLO 6: corregir a la baja devolvió comida ya botada';
  end if;
  raise notice 'ataque bloqueado al corregir: %', v_msg;

  -- Mismo saldo, tercer camino: anular el servido completo.
  v_ok := false;
  begin
    perform public.void_serving_record(v_registro, 'me equivoqué de persona');
  exception when sqlstate '23514' then
    get stacked diagnostics v_msg = message_text;
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FALLO 7: anular el servido devolvió comida ya botada';
  end if;
  raise notice 'ataque bloqueado al anular: %', v_msg;

  -- Y botar de nuevo lo ya botado: 200 + 200 sobre un renglón que sirvió 200.
  v_ok := false;
  begin
    perform public.discard_serving(v_renglon, 200, 'la boté dos veces');
  exception when sqlstate '23514' then
    get stacked diagnostics v_msg = message_text;
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FALLO 8: se declararon 400 g de basura sobre un renglón que sirvió 200';
  end if;
  raise notice 'ataque bloqueado al botar de nuevo: %', v_msg;

  -- -------------------------------------------------------------------------
  -- EL CANDADO NO ES EL RPC. Sin pasar por ninguna función: la devolución
  -- escrita a mano en el libro mayor, con el movimiento original al lado.
  -- -------------------------------------------------------------------------
  select id into v_mov from public.inventory_movements
  where serving_record_item_id = v_renglon and reason = 'CONSUMED'
  order by created_at desc limit 1;

  v_ok := false;
  begin
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, serving_record_item_id,
       covers_quantity, reverses_movement_id)
    values (v_hogar, v_lote, 'ADJUSTMENT', 200, v_renglon, 200, v_mov);
  exception when sqlstate '23514' then
    get stacked diagnostics v_msg = message_text;
    v_ok := true;
  end;
  if not v_ok then
    raise exception
      'FALLO 9: el libro mayor aceptó reponer comida botada escrita a mano';
  end if;
  raise notice 'ataque bloqueado en el trigger: %', v_msg;

  select quantity into v_qty from public.inventory_lots where id = v_lote;
  if v_qty <> 800 then
    raise exception 'FALLO 10: después de cinco intentos el lote quedó en %', v_qty;
  end if;

  -- -------------------------------------------------------------------------
  -- Lo que SÍ tiene que poder pasar: la merma estaba mal declarada.
  -- Anulada la merma, el saldo vuelve y devolver funciona de verdad.
  -- -------------------------------------------------------------------------
  perform public.undo_discard_serving(v_renglon, 200, 'no se botó, estaba en el plato');

  select discarded_quantity into v_qty from public.meal_serving_record_items
  where id = v_renglon;
  if v_qty <> 0 then
    raise exception 'FALLO 11: anular la merma debería dejar el renglón en 0 botados (quedó %)', v_qty;
  end if;

  perform public.return_serving_to_inventory(v_renglon, 200, 'volvió al refrigerador');

  select quantity into v_qty from public.inventory_lots where id = v_lote;
  if v_qty <> 1000 then
    raise exception 'FALLO 12: la devolución legítima debería dejar el lote en 1000 (quedó %)', v_qty;
  end if;

  select served_quantity + deducted_quantity + shortfall_quantity + discarded_quantity
  into v_qty from public.meal_serving_record_items where id = v_renglon;
  if v_qty <> 0 then
    raise exception 'FALLO 13: el renglón devuelto entero debería quedar en cero (quedó %)', v_qty;
  end if;

  raise notice 'B2 OK: lo botado no vuelve, y lo que nunca se botó sí.';
end $$;
