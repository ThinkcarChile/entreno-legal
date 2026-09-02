-- 0057 — Presupuesto, cuotas y cortafuegos, ATÓMICOS y en la base.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ ESTO NO PUEDE VIVIR EN TYPESCRIPT
-- ---------------------------------------------------------------------------
--
-- Dos pestañas del mismo usuario compiten. Dos instancias de Next.js no
-- comparten memoria y son efímeras. Un contador en proceso o no llega nunca al
-- tope —cada instancia cuenta lo suyo— o abre el cortafuegos para una sola
-- mientras las demás siguen golpeando al proveedor caído. La única cuenta que
-- vale es la que se toma y se paga en la misma transacción.
--
-- ---------------------------------------------------------------------------
-- DOS MONEDAS, NO UNA
-- ---------------------------------------------------------------------------
--
--   TOKENS: sólo las capas 2 y 3, que hablan con el proveedor.
--   LLAMADAS A HERRAMIENTA: TODAS las capas, la 0 incluida.
--
-- "Los caminos rápidos no consumen presupuesto" es verdad en tokens y mentira
-- en base de datos: un camino de capa 0 como `stock.de_alimento` corre el
-- cargador de stock, que son diez consultas con ventanas de 30 días. Un chip
-- que alguien toca rápido cinco veces son cincuenta consultas contra Supabase,
-- sin techo y sin costo declarado. El recurso que de verdad se agota queda
-- descubierto justo en las capas que el router premia.
--
-- ---------------------------------------------------------------------------
-- RESERVA Y LIQUIDACIÓN, NO SÓLO RESERVA
-- ---------------------------------------------------------------------------
--
-- Los tokens reales sólo se conocen DESPUÉS de la llamada. Si el request muere
-- en el medio —timeout, el usuario cierra la pestaña, salta el AbortController—
-- el proveedor ya facturó la generación y el contador quedaría en cero. Alguien
-- que corta a los 19 segundos, una y otra vez, gasta plata real sin mover el
-- contador ni un token.
--
-- Por eso se descuenta el ESTIMADO al reservar y se ajusta al liquidar. Y las
-- reservas huérfanas NO se devuelven al saldo: se asumen gastadas, porque
-- devolverlas es exactamente el agujero que se quiere cerrar.

create table public.assistant_budget_policies (
  household_id        uuid primary key references public.households (id) on delete cascade,
  tokens_dia_hogar    int not null default 200000 check (tokens_dia_hogar > 0),
  llamadas_dia_hogar  int not null default 300    check (llamadas_dia_hogar > 0),
  tokens_hora_actor   int not null default 40000  check (tokens_hora_actor > 0),
  llamadas_hora_actor int not null default 60     check (llamadas_hora_actor > 0),
  -- Herramientas por minuto y por actor: la moneda de las capas 0 y 1.
  tools_minuto_actor  int not null default 30     check (tools_minuto_actor > 0),
  -- Piso por actor dentro de la cuota del hogar. Sin esto, alguien juega con
  -- el chat en la mañana y a la hora de cocinar el asistente está muerto para
  -- el resto de la casa, que es justo cuando se necesita.
  tope_actor_pct      smallint not null default 60 check (tope_actor_pct between 10 and 100),

  -- El cortafuegos del proveedor vive acá y no en memoria, por lo mismo de
  -- arriba: un contador por instancia no es un contador.
  fallas_seguidas     smallint not null default 0 check (fallas_seguidas >= 0),
  abierto_hasta       timestamptz,
  ultima_sonda        timestamptz,
  updated_at          timestamptz not null default now()
);

-- Cada reserva es una fila. `estimado` se descuenta de inmediato; `tokens_in`
-- y `tokens_out` llegan al liquidar. `liquidada_at` nulo con la fila vieja =
-- reserva huérfana, y se queda gastada.
create table public.assistant_usage (
  id           bigserial primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.household_members (id) on delete cascade,
  trace_id     text not null,
  capa         smallint not null check (capa between 0 and 3),
  estimado     int not null default 0 check (estimado >= 0),
  tokens_in    int not null default 0 check (tokens_in >= 0),
  tokens_out   int not null default 0 check (tokens_out >= 0),
  tool_calls   int not null default 0 check (tool_calls >= 0),
  liquidada_at timestamptz,
  created_at   timestamptz not null default now()
);

create index assistant_usage_ventana on public.assistant_usage (household_id, created_at desc);
create index assistant_usage_actor   on public.assistant_usage (member_id, created_at desc);
create unique index assistant_usage_traza on public.assistant_usage (trace_id);

alter table public.assistant_budget_policies enable row level security;
alter table public.assistant_usage enable row level security;

create policy budget_policies_select on public.assistant_budget_policies
  for select to authenticated using (app.is_household_member(household_id));
create policy budget_policies_write on public.assistant_budget_policies
  for all to authenticated
  using (app.is_household_admin(household_id))
  with check (app.is_household_admin(household_id));

-- Cuánto gasté YO lo puedo ver siempre; cuánto gastó la casa, quien administra.
create policy usage_select on public.assistant_usage
  for select to authenticated
  using (app.is_household_admin(household_id) or app.is_self_member(member_id));
revoke insert, update, delete on public.assistant_usage from anon, authenticated;

-- El consumo ya cobrado no se edita a mano: liquidar es del RPC.
create or replace function app.uso_no_se_edita()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.households where id = old.household_id) then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'el consumo del asistente no se borra: borrarlo es devolver plata que ya se gastó'
      using errcode = 'check_violation';
  end if;
  if old.liquidada_at is not null then
    raise exception 'esta reserva ya está liquidada' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger assistant_usage_inmutable
  before update or delete on public.assistant_usage
  for each row execute function app.uso_no_se_edita();

/**
 * LA RESERVA ATÓMICA. Consulta y consume en la misma transacción.
 *
 * Devuelve `{permitido, motivo, reserva_id, se_repone}`. El motivo importa
 * tanto como el permiso: "ya usaste tu parte de hoy" no es lo mismo que "la
 * casa usó su cuota de hoy", y la diferencia decide a quién se le dice qué —
 * culpar al que no fue es la forma más rápida de que una familia deje de
 * confiar en una pantalla.
 *
 * Vive en `app` (que PostgREST no expone) con un envoltorio en `public`: el
 * router llama por RPC, y nadie puede saltarse la reserva llamando derecho.
 */
create or replace function app.assistant_budget_check(
  p_household        uuid,
  p_trace            text,
  p_capa             smallint,
  p_tokens_estimados int,
  p_tool_calls       int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me uuid; v_p public.assistant_budget_policies;
  v_th int; v_lh int; v_ta int; v_la int; v_tm int;
  v_actores int; v_tope_actor int; v_id bigint;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;
  v_me := app.current_member_id(p_household);
  if v_me is null then raise exception 'no autorizado'; end if;
  if p_trace is null or char_length(btrim(p_trace)) = 0 then
    raise exception 'una reserva sin traza no se puede liquidar después';
  end if;

  insert into public.assistant_budget_policies (household_id) values (p_household)
    on conflict (household_id) do nothing;
  select * into v_p from public.assistant_budget_policies
   where household_id = p_household for update;

  -- 1. Cortafuegos del proveedor. Sólo afecta a las capas que lo usan: que el
  --    proveedor esté caído no tiene por qué apagar el camino determinista.
  if p_capa >= 2 and v_p.abierto_hasta is not null and v_p.abierto_hasta > now() then
    return jsonb_build_object('permitido', false, 'motivo', 'PROVEEDOR_CAIDO',
                              'se_repone', v_p.abierto_hasta);
  end if;

  -- 2. Una traza, una reserva. Reintentar el mismo turno no cobra dos veces, y
  --    tampoco se finge que se reservó de nuevo: se devuelve la que ya hay.
  select id into v_id from public.assistant_usage where trace_id = p_trace;
  if v_id is not null then
    return jsonb_build_object('permitido', true, 'motivo', 'RESERVA_YA_TOMADA',
                              'reserva_id', v_id);
  end if;

  -- 3. Herramientas por minuto: la moneda que SÍ pagan las capas 0 y 1. Cada
  --    reserva cuenta al menos una llamada, así que sumar `tool_calls` alcanza.
  select coalesce(sum(tool_calls), 0) into v_tm from public.assistant_usage
   where member_id = v_me and created_at >= now() - interval '1 minute';
  if v_tm + greatest(coalesce(p_tool_calls, 0), 1) > v_p.tools_minuto_actor then
    return jsonb_build_object('permitido', false, 'motivo', 'DEMASIADO_SEGUIDO',
                              'se_repone', now() + interval '1 minute');
  end if;

  -- 4. Las capas 0 y 1 son código propio: no gastan tokens, y por eso su
  --    reserva se anota con estimado 0. Anotarla igual es lo que hace que el
  --    tope de arriba exista.
  if p_capa <= 1 then
    insert into public.assistant_usage
      (household_id, member_id, trace_id, capa, estimado, tool_calls)
    values (p_household, v_me, p_trace, p_capa, 0, greatest(coalesce(p_tool_calls, 0), 1))
    returning id into v_id;
    return jsonb_build_object('permitido', true, 'motivo', null, 'reserva_id', v_id);
  end if;

  -- 5. Consentimiento vivo. Sin él no se habla con nadie de afuera.
  if not app.assistant_consent_ok(p_household, 'ASSISTANT_HOUSEHOLD') then
    return jsonb_build_object('permitido', false, 'motivo', 'SIN_CONSENTIMIENTO');
  end if;

  select coalesce(sum(greatest(estimado, tokens_in + tokens_out)), 0),
         coalesce(sum(tool_calls), 0)
    into v_th, v_lh
    from public.assistant_usage
   where household_id = p_household and created_at >= date_trunc('day', now());

  select coalesce(sum(greatest(estimado, tokens_in + tokens_out)), 0),
         coalesce(sum(tool_calls), 0)
    into v_ta, v_la
    from public.assistant_usage
   where member_id = v_me and created_at >= now() - interval '1 hour';

  if v_th + p_tokens_estimados > v_p.tokens_dia_hogar
     or v_lh + p_tool_calls > v_p.llamadas_dia_hogar then
    return jsonb_build_object('permitido', false, 'motivo', 'CUOTA_HOGAR',
                              'se_repone', date_trunc('day', now()) + interval '1 day');
  end if;

  if v_ta + p_tokens_estimados > v_p.tokens_hora_actor
     or v_la + p_tool_calls > v_p.llamadas_hora_actor then
    return jsonb_build_object('permitido', false, 'motivo', 'CUOTA_ACTOR',
                              'se_repone', now() + interval '1 hour');
  end if;

  -- 6. Piso para el resto de la casa. Un actor puede consumir todo el saldo
  --    diario del hogar respetando cada tope horario: seis horas seguidas de
  --    chat caben perfectamente dentro de "40.000 tokens por hora". El tope por
  --    porcentaje sólo aplica cuando hay más de un integrante activo — en una
  --    casa de una persona sería una cuota inventada contra nadie.
  select count(*) into v_actores from public.household_members
   where household_id = p_household and is_active;
  if v_actores > 1 then
    select coalesce(sum(greatest(estimado, tokens_in + tokens_out)), 0) into v_ta
      from public.assistant_usage
     where member_id = v_me and created_at >= date_trunc('day', now());
    v_tope_actor := (v_p.tokens_dia_hogar * v_p.tope_actor_pct) / 100;
    if v_ta + p_tokens_estimados > v_tope_actor then
      return jsonb_build_object('permitido', false, 'motivo', 'CUOTA_ACTOR_DEL_HOGAR',
                                'se_repone', date_trunc('day', now()) + interval '1 day');
    end if;
  end if;

  insert into public.assistant_usage
    (household_id, member_id, trace_id, capa, estimado, tool_calls)
  values (p_household, v_me, p_trace, p_capa, greatest(coalesce(p_tokens_estimados, 0), 0),
          greatest(coalesce(p_tool_calls, 0), 0))
  returning id into v_id;

  return jsonb_build_object('permitido', true, 'motivo', null, 'reserva_id', v_id);
end;
$$;

create or replace function public.assistant_budget_check(
  p_household        uuid,
  p_trace            text,
  p_capa             smallint,
  p_tokens_estimados int,
  p_tool_calls       int
) returns jsonb language sql security definer set search_path = public as $$
  select app.assistant_budget_check(p_household, p_trace, p_capa, p_tokens_estimados, p_tool_calls);
$$;

comment on function app.assistant_budget_check(uuid, text, smallint, int, int) is
  'Reserva atómica: consulta y consume en la misma transacción. Las capas 0 y 1 '
  'no gastan tokens pero SÍ gastan llamadas, que es el recurso que de verdad se '
  'agota en el camino barato.';

/**
 * La liquidación. Corre SIEMPRE, incluso cuando el turno terminó abortado o
 * con excepción — de ahí que el llamador la ponga en un `finally`.
 *
 * `greatest(estimado, real)` en las sumas de arriba es la mitad del contrato:
 * mientras la reserva no se liquida, cuenta por el estimado; una vez liquidada,
 * por lo real si fue más. Nunca por menos que lo ya comprometido dentro del
 * mismo turno vivo.
 */
create or replace function public.assistant_usage_settle(
  p_trace      text,
  p_tokens_in  int,
  p_tokens_out int,
  p_tool_calls int
) returns void language plpgsql security definer set search_path = public as $$
declare v_row public.assistant_usage;
begin
  select * into v_row from public.assistant_usage where trace_id = p_trace for update;
  if not found then
    raise exception 'no hay reserva viva con esa traza: no existe camino que llame al proveedor sin reservar antes';
  end if;
  if not app.is_self_member(v_row.member_id) then raise exception 'no autorizado'; end if;
  if v_row.liquidada_at is not null then return; end if;   -- idempotente

  update public.assistant_usage
     set tokens_in = greatest(coalesce(p_tokens_in, 0), 0),
         tokens_out = greatest(coalesce(p_tokens_out, 0), 0),
         tool_calls = greatest(coalesce(p_tool_calls, tool_calls), 0),
         liquidada_at = now()
   where trace_id = p_trace;
end;
$$;

/**
 * Barrido de reservas huérfanas: se dan por gastadas, no se devuelven.
 *
 * Devolverlas al saldo sería premiar exactamente el patrón que se quiere
 * cortar (abrir, gastar, cortar antes de que responda). Lo único que hace el
 * barrido es CERRARLAS, para que dejen de contar como "en vuelo" y el tope por
 * minuto no quede trabado para siempre.
 */
create or replace function public.assistant_usage_sweep(p_household uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;
  update public.assistant_usage
     set tokens_in = greatest(tokens_in, estimado), liquidada_at = now()
   where household_id = p_household and liquidada_at is null
     and created_at <= now() - interval '5 minutes';
  get diagnostics n = row_count;
  return n;
end;
$$;

/**
 * El cortafuegos.
 *
 * Un timeout pesa DOBLE: es la falla que más le cuesta a la persona (veinte
 * segundos mirando una pantalla que no dice nada), así que baja el umbral
 * efectivo de cinco a tres.
 *
 * Al vencer los diez minutos NO se abre la compuerta entera: pasa UNA sonda
 * por minuto. Volver de golpe con toda la casa encima es cómo un proveedor que
 * se estaba recuperando se vuelve a caer.
 */
create or replace function public.assistant_breaker_report(
  p_household uuid,
  p_resultado text          -- 'OK' | 'FALLA' | 'TIMEOUT'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_p public.assistant_budget_policies; v_peso smallint; v_fallas smallint;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;
  if p_resultado not in ('OK', 'FALLA', 'TIMEOUT') then
    raise exception 'resultado desconocido: %', p_resultado;
  end if;

  insert into public.assistant_budget_policies (household_id) values (p_household)
    on conflict (household_id) do nothing;
  select * into v_p from public.assistant_budget_policies
   where household_id = p_household for update;

  if p_resultado = 'OK' then
    update public.assistant_budget_policies
       set fallas_seguidas = 0, abierto_hasta = null, updated_at = now()
     where household_id = p_household;
    return jsonb_build_object('abierto', false, 'fallas', 0);
  end if;

  v_peso := case p_resultado when 'TIMEOUT' then 2 else 1 end;
  v_fallas := v_p.fallas_seguidas + v_peso;

  if v_fallas >= 5 then
    update public.assistant_budget_policies
       set fallas_seguidas = v_fallas, abierto_hasta = now() + interval '10 minutes',
           updated_at = now()
     where household_id = p_household;
    return jsonb_build_object('abierto', true, 'fallas', v_fallas,
                              'vuelve', now() + interval '10 minutes');
  end if;

  update public.assistant_budget_policies
     set fallas_seguidas = v_fallas, updated_at = now()
   where household_id = p_household;
  return jsonb_build_object('abierto', false, 'fallas', v_fallas);
end;
$$;

/**
 * Half-open explícito: una sonda por minuto cuando el plazo ya venció.
 * Devuelve true si a ESTE turno le toca ser la sonda.
 */
create or replace function public.assistant_breaker_probe(p_household uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_p public.assistant_budget_policies;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;
  select * into v_p from public.assistant_budget_policies
   where household_id = p_household for update;
  if not found or v_p.abierto_hasta is null then return true; end if;
  if v_p.abierto_hasta > now() then return false; end if;
  if v_p.ultima_sonda is not null and v_p.ultima_sonda > now() - interval '1 minute' then
    return false;
  end if;
  update public.assistant_budget_policies set ultima_sonda = now()
   where household_id = p_household;
  return true;
end;
$$;

comment on table public.assistant_usage is
  'Reserva y liquidación. La reserva se descuenta al pedirla; lo real se ajusta '
  'al liquidar. Una reserva huérfana se da por GASTADA: devolverla premiaría al '
  'que corta el request a los 19 segundos.';
