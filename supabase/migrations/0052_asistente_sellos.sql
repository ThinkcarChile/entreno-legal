-- 0052 — Sellos de fila y firmas de entrada: cómo se sabe que la foto envejeció.
--
-- El problema real, con nombre: son las 20:00 y el asistente propone "usa 2,0
-- kg de pollo del lote L-77 para la cena del viernes". A las 20:20 otro
-- integrante escanea el QR de ese mismo lote y ocupa 1,0 kg. A las 20:22
-- alguien toca Aceptar. Si la propuesta se ejecuta con lo que vio a las 20:00,
-- descuenta 2,0 kg de un lote que tiene 1,0.
--
-- La única defensa contra eso que ya existe en el repo es la `demandSignature`
-- de compras. Stock, procurement y prep no tienen NADA. Acá se generaliza en
-- dos niveles:
--
--   Nivel 1 — SELLO DE FILA: barato, un RPC, cero motores. Contesta "¿esta fila
--             es la misma que vi?".
--   Nivel 2 — FIRMA DE ENTRADA: contesta "¿el motor vería lo mismo si lo corro
--             de nuevo?". Más caro, y necesario cuando lo propuesto no depende
--             de una fila sino de una escena entera.
--
-- Lo que NINGUNO de los dos hace es autorizar. Una firma igual no ejecuta
-- nada: sólo deja de ser una razón para NO ejecutar. La foto sirve para
-- comparar; la ejecución exige la escena.

-- ---------------------------------------------------------------------------
-- 1. Sello de fila
-- ---------------------------------------------------------------------------
--
-- El sello es el md5 de la fila ENTERA (`md5(t::text)`) y no de `updated_at`,
-- por dos motivos que se descubrieron mirando el esquema real:
--
--   · La mitad de las tablas de la lista blanca no tiene `updated_at`
--     (`meal_assignments`, `nutrition_events`, `consumption_shortfalls`…): un
--     sello basado en esa columna reventaría en unas y funcionaría en otras,
--     que es la peor de las mezclas.
--   · Un `updated_at` sólo delata los cambios que alguien se acordó de
--     estampar. La fila entera delata todos.
--
-- Y el caso importante: la fila que YA NO ESTÁ. Devolver NULL diría "no pude
-- calcularlo"; devolver el sello de la nada diría "no cambió". Ninguna de las
-- dos es cierta, así que se dice 'AUSENTE' con todas sus letras y quien
-- compara sabe exactamente qué pasó.

-- El sello se resuelve con `app.row_reachable` (0050) y NO con
-- `is_household_member`, que es lo que decía antes. La diferencia no es de
-- estilo:
--
--   · `is_household_member` contesta "¿esta fila es de tu casa?", y un id
--     clínico de otro integrante SÍ es de tu casa. Con esa pregunta, cualquier
--     integrante obtenía el md5 de la fila entera de una restricción, un examen
--     o una evaluación de otro: no revela el contenido, pero confirma que ese
--     id clínico existe en la casa y delata CADA cambio con su hora. Justo lo
--     que la 0050 dice cerrar cuando exige ámbito y permiso en el mismo paso.
--   · `row_reachable` contesta la pregunta completa —hogar, grant de quien lee
--     y consentimiento de quien es dueño— y es la MISMA que decide si ese id
--     podía nombrarse. Dos puertas para el mismo id con dos preguntas distintas
--     es tener dos dueños de la misma regla.
--
-- Y la fila inalcanzable devuelve 'AUSENTE', no una excepción. Un `raise` acá
-- era un oráculo de existencia: la fila de otra casa contestaba "no autorizado"
-- y un uuid inventado contestaba 'AUSENTE', o sea que la diferencia sola
-- confirmaba que la fila ajena existe, y se podía probar id por id. Las tres
-- respuestas que tienen que verse iguales desde afuera —no existe, es de otra
-- casa, es clínica y no la puedes ver— ahora se ven iguales.
--
-- Que sea la respuesta segura además de la indistinguible no es casualidad:
-- 'AUSENTE' significa "la foto ya no calza", así que una propuesta apoyada en
-- una fila que dejó de ser alcanzable —porque le revocaron el grant o porque
-- el dueño revocó el consentimiento— muere y nace otra. Nunca se ejecuta.

create or replace function app.row_stamp(p_table text, p_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_scope uuid; v_stamp text;
begin
  -- Revienta solo si la tabla no está en la lista blanca (0050). Un nombre de
  -- tabla no es un id: negarlo en silencio no protege a nadie y esconde el bug.
  v_scope := app.row_scope(p_table, p_id);

  if v_scope is null then return 'AUSENTE'; end if;
  if not app.row_reachable(p_table, p_id, v_scope) then return 'AUSENTE'; end if;

  -- El `format(%I)` es seguro porque `row_scope` ya rechazó todo nombre que no
  -- esté en la lista cerrada: acá el identificador ya no viene del atacante.
  execute format('select md5(t::text) from public.%I t where t.id = $1', p_table)
    into v_stamp using p_id;

  return coalesce(v_stamp, 'AUSENTE');
end;
$$;

comment on function app.row_stamp(text, uuid) is
  'Sello de la fila entera, y sólo de la fila que ESTE actor alcanza. AUSENTE '
  'cubre las tres: no existe, es de otra casa, es clínica sin permiso. La fila '
  'que ya no está devuelve AUSENTE y no NULL: "no pude calcularlo" y "no '
  'cambió" son respuestas distintas.';

create or replace function public.assistant_row_stamps(p_rows jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    jsonb_object_agg(r->>'id', app.row_stamp(r->>'table', (r->>'id')::uuid)),
    '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
$$;

comment on function public.assistant_row_stamps(jsonb) is
  'Todos los sellos del basis en UN viaje. Entra [{"table":…,"id":…}], sale '
  '{id: sello}. Un sello por consulta convertía revalidar en veinte viajes. '
  'Ninguna combinación de ids corta la llamada entera: lo que no se alcanza '
  'sale AUSENTE, igual que lo que no existe.';

-- ---------------------------------------------------------------------------
-- 2. Firmas de entrada de los tres motores que no la tenían
-- ---------------------------------------------------------------------------
--
-- Cada firma resume EXACTAMENTE lo que ese motor lee, y nada más. Meter de
-- todo haría que la firma cambiara por cosas que al motor le dan lo mismo, y
-- una firma que cambia sola termina ignorada.
--
-- El `p_today` va adentro a propósito: los tres motores razonan sobre fechas
-- (vencimientos, ventanas de compra, días de preparación), así que la misma
-- despensa el jueves y el viernes NO es la misma entrada.

create or replace function app.stock_input_stamp(p_household uuid, p_today date)
returns text language sql stable security definer set search_path = public as $$
  select md5(coalesce(string_agg(x, '|' order by x), 'vacio'))
  from (
    select 'l:' || l.id::text || ':' || l.quantity::text || ':' || l.status::text ||
           ':' || coalesce(l.expiry_date::text, '-') ||
           ':' || coalesce(l.use_by::text, '-') as x
      from public.inventory_lots l
     where l.household_id = p_household
       and l.status not in ('CONSUMED', 'DISCARDED', 'SPLIT')
    union all
    select 'st:' || t.id::text || ':' || coalesce(t.target_quantity::text, '-') ||
           ':' || coalesce(t.minimum_quantity::text, '-')
      from public.stock_targets t where t.household_id = p_household
    union all
    select 'sf:' || s.id::text || ':' || s.quantity::text
      from public.consumption_shortfalls s
     where s.household_id = p_household and s.status = 'OPEN'
    union all
    select 'd:' || p_today::text
  ) q;
$$;

create or replace function app.procurement_input_stamp(p_household uuid, p_today date)
returns text language sql stable security definer set search_path = public as $$
  select md5(
    app.stock_input_stamp(p_household, p_today) || '#' ||
    coalesce((select string_agg(o.id::text || ':' || o.status::text, '|' order by o.id)
                from public.procurement_orders o
               where o.household_id = p_household
                 and o.status in ('SUGGESTED', 'PLANNED', 'ORDERED', 'READY', 'DELIVERING')), '-')
    || '#' ||
    coalesce((select string_agg(i.id::text || ':' || coalesce(i.planned_quantity::text, '-'),
                                '|' order by i.id)
                from public.shopping_list_items i
                join public.shopping_lists sl on sl.id = i.list_id
               where sl.household_id = p_household
                 and sl.status in ('DRAFT', 'ACTIVE')
                 and i.status = 'PENDING'), '-'));
$$;

create or replace function app.prep_input_stamp(p_household uuid, p_today date)
returns text language sql stable security definer set search_path = public as $$
  select md5(
    app.stock_input_stamp(p_household, p_today) || '#' ||
    coalesce((select string_agg(a.id::text || ':' || a.status::text, '|' order by a.id)
                from public.meal_assignments a
                join public.weekly_plan_days d on d.id = a.day_id
                join public.weekly_plans p on p.id = d.plan_id
               where p.household_id = p_household and d.plan_date >= p_today), '-'));
$$;

-- Un solo viaje para las tres, con la guarda de pertenencia en un solo lugar.
create or replace function public.assistant_engine_stamps(p_household uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_today date;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;
  v_today := app.household_today(p_household);
  return jsonb_build_object(
    'today',       v_today,
    'stock',       app.stock_input_stamp(p_household, v_today),
    'procurement', app.procurement_input_stamp(p_household, v_today),
    'prep',        app.prep_input_stamp(p_household, v_today));
end;
$$;

comment on function public.assistant_engine_stamps(uuid) is
  'Las firmas de entrada de stock, procurement y prep, con el today del hogar '
  'adentro: la misma despensa el jueves y el viernes NO es la misma entrada.';
