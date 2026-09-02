-- 0056 — El centro de acciones: la cola DURABLE de lo que la casa tiene
-- pendiente.
--
-- Regla estructural, y de ella sale todo lo demás: EL MODELO NO CREA ITEMS.
-- Los crean los motores. El modelo, a lo más, ordena y redacta lo que ya
-- existe. Si el modelo pudiera crear items, inventaría urgencias — y una
-- urgencia inventada en una casa donde hay alguien con una restricción clínica
-- no es ruido, es daño.
--
-- Por eso no hay ningún RPC acá que acepte texto libre del asistente: el
-- `titulo` se compone desde `Reason`, y la severidad NO se pasa: se deriva del
-- tipo y la base la exige.

create type public.inbox_kind as enum (
  'SEGURIDAD_ALIMENTARIA',  -- 1
  'CLINICO_BLOQUEANTE',     -- 2
  'FALTANTE_CONFIRMADO',    -- 3
  'VENCE_HOY',              -- 4
  'ACCION_PENDIENTE',       -- 5
  'PROPUESTA_VENCIDA',      -- 6
  'REPOSICION',             -- 7
  'DATO_FALTANTE',          -- 8
  'SUGERENCIA'              -- 9
);

create type public.inbox_estado as enum ('ABIERTO', 'ATENDIDO', 'DESCARTADO', 'CADUCO');

-- La severidad es del TIPO, no del item. Congelada acá y no en TypeScript
-- porque es lo que ordena la bandeja, y una tabla que se puede reordenar desde
-- arriba es una bandeja donde la sugerencia de receta puede ponerse encima del
-- aviso de seguridad.
create or replace function app.inbox_severidad(p_kind public.inbox_kind)
returns smallint language sql immutable as $$
  select (case p_kind
    when 'SEGURIDAD_ALIMENTARIA' then 1
    when 'CLINICO_BLOQUEANTE'    then 2
    when 'FALTANTE_CONFIRMADO'   then 3
    when 'VENCE_HOY'             then 4
    when 'ACCION_PENDIENTE'      then 5
    when 'PROPUESTA_VENCIDA'     then 6
    when 'REPOSICION'            then 7
    when 'DATO_FALTANTE'         then 8
    when 'SUGERENCIA'            then 9
  end)::smallint;
$$;

create table public.assistant_inbox_items (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  kind           public.inbox_kind not null,
  severidad      smallint not null,
  titulo         text not null check (char_length(titulo) between 1 and 200),
  detalle        jsonb not null default '[]'::jsonb,   -- Reason[]
  provenance     jsonb not null default '[]'::jsonb,
  -- "No sé" es accionable en este proyecto, no ruido: por eso los unknowns
  -- viajan con el aviso y no se descartan al escribirlo.
  unknowns       jsonb not null default '[]'::jsonb,
  -- Hasta cuándo el aviso es ACCIONABLE (el vencimiento del lote, la fecha de
  -- la comida). No la fecha de creación: ordenar por recencia pone la
  -- sugerencia de hace cinco minutos sobre el aviso de seguridad de ayer.
  ventana        date,
  dedupe_key     text not null,
  ref_table      text,
  ref_id         uuid,
  proposal_id    uuid references public.assistant_proposals (id) on delete set null,
  -- Sobre quién es el aviso, cuando es de una persona. Obligatorio si exige
  -- capacidad clínica: sin dueño no hay a quién preguntarle el permiso.
  owner_member   uuid references public.household_members (id) on delete cascade,
  -- La audiencia va en la POLÍTICA, no en TypeScript.
  requires       jsonb not null default '[]'::jsonb,
  estado         public.inbox_estado not null default 'ABIERTO',
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,
  resolved_by    uuid references public.household_members (id),
  resolved_at    timestamptz,

  constraint severidad_congelada check (severidad = app.inbox_severidad(kind)),
  constraint dedupe_no_vacia check (char_length(btrim(dedupe_key)) > 0),
  constraint requires_es_lista check (jsonb_typeof(requires) = 'array'),
  constraint ref_completa check ((ref_table is null) = (ref_id is null))
);

-- Dos avisos del mismo lote, uno. El aviso "vence hoy" del jueves no se suma
-- al del miércoles: lo actualiza.
create unique index inbox_dedupe_vivo
  on public.assistant_inbox_items (household_id, dedupe_key) where estado = 'ABIERTO';

-- El orden real: severidad, después ventana, después recencia. Nunca recencia
-- sola.
create index inbox_orden on public.assistant_inbox_items
  (household_id, severidad, ventana nulls last, created_at desc) where estado = 'ABIERTO';

alter table public.assistant_inbox_items enable row level security;

-- La audiencia ES la política. Un item clínico no lo ve quien no tiene el
-- grant, aunque administre la casa.
create policy inbox_select on public.assistant_inbox_items
  for select to authenticated
  using (app.capabilities_ok(household_id, requires));

revoke insert, update, delete on public.assistant_inbox_items from anon, authenticated;

/**
 * El único escritor. Lo llaman los motores; el modelo no lo alcanza.
 *
 * La severidad no es parámetro: se deriva del tipo. Si lo fuera, un productor
 * distraído —o un modelo que redacta el argumento— podría marcar una
 * sugerencia como severidad 1 y ponerla arriba del aviso de seguridad.
 */
create or replace function public.upsert_inbox_item(
  p_household  uuid,
  p_kind       public.inbox_kind,
  p_titulo     text,
  p_detalle    jsonb,
  p_provenance jsonb,
  p_unknowns   jsonb,
  p_ventana    date,
  p_dedupe     text,
  p_ref_table  text,
  p_ref_id     uuid,
  p_proposal   uuid,
  p_owner      uuid,
  p_requires   jsonb,
  p_expires    timestamptz
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_requires jsonb := coalesce(p_requires, '[]'::jsonb);
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;
  if p_dedupe is null or char_length(btrim(p_dedupe)) = 0 then
    raise exception 'un aviso sin clave de dedupe se repite todos los días';
  end if;

  -- Si el aviso apunta a una fila, esa fila tiene que ser de este hogar. El
  -- `ref_id` es un uuid que puede haber pasado por el modelo, así que va por la
  -- lista blanca del ámbito (0050) y no por confianza.
  if p_ref_id is not null then
    if app.row_scope(p_ref_table, p_ref_id) is distinct from p_household then
      raise exception 'no autorizado';
    end if;
  end if;

  if p_owner is not null and app.member_household(p_owner) is distinct from p_household then
    raise exception 'no autorizado';
  end if;

  -- Un aviso que exige permiso clínico y no dice sobre quién es un aviso que
  -- nadie puede evaluar: `capabilities_ok` necesita el dueño.
  if exists (select 1 from jsonb_array_elements(v_requires) c where c->>'k' = 'MEDICAL')
     and p_owner is null then
    raise exception 'un aviso clínico sin integrante dueño no se puede mostrar a nadie';
  end if;

  insert into public.assistant_inbox_items
    (household_id, kind, severidad, titulo, detalle, provenance, unknowns, ventana,
     dedupe_key, ref_table, ref_id, proposal_id, owner_member, requires, expires_at)
  values
    (p_household, p_kind, app.inbox_severidad(p_kind), p_titulo,
     coalesce(p_detalle, '[]'::jsonb), coalesce(p_provenance, '[]'::jsonb),
     coalesce(p_unknowns, '[]'::jsonb), p_ventana, p_dedupe, p_ref_table, p_ref_id,
     p_proposal, p_owner, v_requires, p_expires)
  on conflict (household_id, dedupe_key) where estado = 'ABIERTO'
  do update set
    titulo      = excluded.titulo,
    detalle     = excluded.detalle,
    provenance  = excluded.provenance,
    unknowns    = excluded.unknowns,
    ventana     = excluded.ventana,
    proposal_id = excluded.proposal_id,
    requires    = excluded.requires,
    expires_at  = excluded.expires_at
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.resolve_inbox_item(
  p_id     uuid,
  p_estado public.inbox_estado
) returns void language plpgsql security definer set search_path = public as $$
declare v_row public.assistant_inbox_items; v_me uuid;
begin
  if p_estado = 'ABIERTO' then
    raise exception 'resolver un aviso es cerrarlo: ABIERTO no es un cierre';
  end if;

  select * into v_row from public.assistant_inbox_items where id = p_id for update;
  if not found then raise exception 'no autorizado'; end if;
  -- Quien no puede VER el aviso tampoco puede cerrarlo: si no, cerrar sería un
  -- oráculo sobre la existencia de avisos clínicos ajenos.
  if not app.capabilities_ok(v_row.household_id, v_row.requires) then raise exception 'no autorizado'; end if;
  if v_row.estado <> 'ABIERTO' then return; end if;   -- idempotente

  v_me := app.current_member_id(v_row.household_id);
  update public.assistant_inbox_items
     set estado = p_estado, resolved_by = v_me, resolved_at = now()
   where id = p_id;
end;
$$;

/**
 * Caducar lo vencido, FUERA del camino de lectura.
 *
 * La lectura filtra por predicado y no escribe nada (ver `inbox_abiertos`).
 * Esto se llama desde el cron o desde mantención, acotado y saltando lo que
 * otro esté tocando, para que la bandeja se lea aunque la escritura esté
 * bloqueada.
 */
create or replace function public.expire_inbox_items(p_household uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not app.is_household_member(p_household) then raise exception 'no autorizado'; end if;

  with vencidos as (
    select id from public.assistant_inbox_items
     where household_id = p_household and estado = 'ABIERTO'
       and expires_at is not null and expires_at <= now()
     order by expires_at
     limit 200
     for update skip locked
  )
  update public.assistant_inbox_items i
     set estado = 'CADUCO', resolved_at = now()
    from vencidos v where i.id = v.id;

  get diagnostics n = row_count;
  return n;
end;
$$;

/**
 * LEER la bandeja. Sin escribir una sola fila.
 *
 * El filtro por `expires_at` va en el predicado: un aviso vencido no aparece
 * aunque nadie lo haya marcado CADUCO todavía. Así "no pude verificar tu
 * bandeja" queda reservado para cuando de verdad falló la lectura, y no para
 * cuando falló una escritura que la lectura no necesitaba.
 */
create or replace function public.inbox_abiertos(p_household uuid)
returns setof public.assistant_inbox_items
language sql stable security definer set search_path = public as $$
  select i.* from public.assistant_inbox_items i
   where i.household_id = p_household
     and i.estado = 'ABIERTO'
     and (i.expires_at is null or i.expires_at > now())
     and app.capabilities_ok(i.household_id, i.requires)
     and app.is_household_member(i.household_id)
   order by i.severidad, i.ventana nulls last, i.created_at desc;
$$;

-- El badge cuenta SÓLO severidad 1..5: lo que le exige algo a una persona. Un
-- número que incluye sugerencias es un número que se aprende a ignorar.
create or replace function public.inbox_badge(p_household uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.inbox_abiertos(p_household) i where i.severidad <= 5;
$$;

comment on table public.assistant_inbox_items is
  'La cola durable de la casa. Los items los producen los MOTORES: no hay RPC '
  'que permita crear uno con texto libre del modelo, y la severidad la impone '
  'el tipo.';
