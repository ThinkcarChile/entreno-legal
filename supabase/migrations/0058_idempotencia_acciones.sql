-- 0058 — Idempotencia de las acciones que el asistente va a proponer.
--
-- El diseño declara que ninguna herramienta de tipo ACT puede ser
-- `NOT_IDEMPOTENT`. Es una promesa de TIPO, y hasta esta migración no tenía
-- respaldo en la base: `add_manual_lot` inserta siempre, `use_lot` es un delta
-- relativo puro, `addManualItem` inserta siempre, `recordObservedYield` es un
-- insert directo, `saveSchedule` es un insert directo. Calcular la clave en
-- TypeScript no evita nada bajo concurrencia — evita el segundo clic del mismo
-- navegador y nada más.
--
-- Lo que cada una hace mal si se ejecuta dos veces, para que se entienda por
-- qué la lista es esta y no otra:
--
--   · `add_manual_lot`  → dos lotes: comida que no existe, contada dos veces.
--   · `use_lot`         → descuenta de nuevo, y el QR invita justamente a
--                         repetir el gesto.
--   · `createRestriction` → dos restricciones clínicas activas sobre la misma
--                         persona. La más grave de todas.
--   · `addManualItem`   → la línea manual queda explícitamente FUERA del
--                         unique parcial de la 0009.
--   · `saveEvent`       → un evento duplicado MUEVE porciones.
--   · `assessMeal`      → inunda la trazabilidad clínica de la persona.
--   · `recordObservedYield` → SESGA el rendimiento que después usan compras y
--                         preparación: no se ve, y contamina todo aguas abajo.
--
-- REGLA que sale de acá y vale para el registry: una herramienta ACT sólo
-- puede declararse `KEYED` si existen (a) el índice único parcial en la tabla
-- destino y (b) el parámetro `p_dedupe_key` en el RPC. Sin las dos cosas entra
-- como NOT_BUILT.

-- ---------------------------------------------------------------------------
-- 1. La clave común, para lo que no tiene libro mayor propio
-- ---------------------------------------------------------------------------

create table public.action_idempotency (
  household_id uuid not null references public.households (id) on delete cascade,
  dedupe_key   text not null,
  accion       text not null,
  result_id    uuid,
  created_at   timestamptz not null default now(),
  primary key (household_id, dedupe_key)
);

alter table public.action_idempotency enable row level security;
create policy action_idem_select on public.action_idempotency
  for select to authenticated using (app.is_household_member(household_id));
revoke insert, update, delete on public.action_idempotency from anon, authenticated;

/**
 * Toma la clave. Devuelve `(tomada, result_id)`:
 *   tomada = true  → es la primera vez, sigue adelante.
 *   tomada = false → ya se hizo; `result_id` es lo que devolvió aquella vez.
 *
 * Devuelve DOS valores y no sólo el uuid a propósito. La versión de un valor
 * —"si es null, es la primera vez"— confunde "nunca se hizo" con "se hizo y
 * todavía no se anotó el resultado", que son la carrera exacta que este
 * mecanismo existe para cerrar: dos clics simultáneos, el primero adentro sin
 * haber liquidado. NULL era un agujero, no una opción.
 */
create or replace function app.claim_dedupe(
  p_household uuid,
  p_key       text,
  p_accion    text,
  out tomada  boolean,
  out result_id uuid
) language plpgsql security definer set search_path = public as $$
declare v_insertadas int;
begin
  if p_key is null or char_length(btrim(p_key)) = 0 then
    raise exception 'esta acción exige clave de idempotencia: sin ella, el doble clic es indetectable';
  end if;

  -- El INSERT es el candado. Si dos transacciones llegan juntas, la segunda se
  -- bloquea en la clave primaria y despierta viendo la fila de la primera.
  insert into public.action_idempotency (household_id, dedupe_key, accion)
  values (p_household, p_key, p_accion)
  on conflict (household_id, dedupe_key) do nothing;

  get diagnostics v_insertadas = row_count;
  if v_insertadas = 1 then
    tomada := true;
    result_id := null;
    return;
  end if;

  tomada := false;
  select a.result_id into result_id from public.action_idempotency a
   where a.household_id = p_household and a.dedupe_key = p_key;
end;
$$;

create or replace function app.settle_dedupe(p_household uuid, p_key text, p_result uuid)
returns void language sql security definer set search_path = public as $$
  update public.action_idempotency set result_id = p_result
   where household_id = p_household and dedupe_key = p_key;
$$;

-- ---------------------------------------------------------------------------
-- 2. Claves de dedupe en las tablas que las necesitan
-- ---------------------------------------------------------------------------
--
-- Índices PARCIALES `where dedupe_key is not null`: todo lo que ya existe
-- —cientos de lotes, líneas de compra, restricciones— nació sin clave y no
-- puede empezar a chocar entre sí. La clave es de las escrituras nuevas que
-- pasan por el asistente.

alter table public.inventory_lots add column if not exists dedupe_key text;
create unique index if not exists inventory_lots_dedupe
  on public.inventory_lots (household_id, dedupe_key) where dedupe_key is not null;

alter table public.member_clinical_restrictions add column if not exists dedupe_key text;
create unique index if not exists clinical_restrictions_dedupe
  on public.member_clinical_restrictions (member_id, dedupe_key) where dedupe_key is not null;

alter table public.shopping_list_items add column if not exists dedupe_key text;
create unique index if not exists shopping_items_dedupe
  on public.shopping_list_items (list_id, dedupe_key) where dedupe_key is not null;

alter table public.nutrition_events add column if not exists dedupe_key text;
create unique index if not exists nutrition_events_dedupe
  on public.nutrition_events (household_id, dedupe_key) where dedupe_key is not null;

alter table public.meal_clinical_assessments add column if not exists dedupe_key text;
create unique index if not exists meal_assessments_dedupe
  on public.meal_clinical_assessments (member_id, dedupe_key) where dedupe_key is not null;

alter table public.household_observed_yields add column if not exists dedupe_key text;
create unique index if not exists observed_yields_dedupe
  on public.household_observed_yields (household_id, dedupe_key) where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- 3. Los dos INSERT planos que no tenían NINGÚN unique
-- ---------------------------------------------------------------------------
--
-- Acá no hace falta clave de dedupe: la identidad natural de la fila alcanza y
-- es más honesta, porque impide el duplicado venga de donde venga (del
-- asistente, de la pantalla o de un reintento de red).
--
-- `member_lab_schedules` acepta dos formas de objetivo —un biomarcador o una
-- etiqueta de panel (`lab_schedule_target`)— así que son DOS índices parciales
-- y no uno sobre `(member_id, biomarker_id)`: en un único índice los NULL no
-- chocan entre sí, y las agendas por panel quedarían sin protección ninguna,
-- que es exactamente el caso que hoy se duplica.
create unique index if not exists lab_schedules_por_biomarcador
  on public.member_lab_schedules (member_id, biomarker_id) where biomarker_id is not null;
create unique index if not exists lab_schedules_por_panel
  on public.member_lab_schedules (member_id, panel_label) where panel_label is not null;

-- `household_equipment_configs` NO tiene `household_id`: cuelga del equipo. El
-- hogar llega por ahí, y la identidad real de una capacidad es (equipo,
-- capacidad).
create unique index if not exists equipment_configs_uniq
  on public.household_equipment_configs (equipment_id, capability);

-- ---------------------------------------------------------------------------
-- 4. `use_lot` con clave, SIN tocarle el cuerpo
-- ---------------------------------------------------------------------------
--
-- El diseño proponía reescribir `use_lot` entero: descontar `quantity` a mano y
-- escribir el movimiento. Eso ROMPE el libro mayor. Desde la 0011 la cantidad
-- del lote la mantiene el trigger sobre `inventory_movements`, así que hacer
-- las dos cosas descuenta dos veces; y la versión de la 0036 delega en
-- `serve_off_plan`, que es quien sabe de FEFO, de faltantes y de merma. Copiar
-- ese cuerpo para agregarle una línea es la forma más segura de reintroducir a
-- mano un bug que ya se arregló.
--
-- Se usa el molde de la 0039: la función viva se muda al esquema `app` (que
-- PostgREST no expone) y en `public` queda un envoltorio con el mismo nombre y
-- un parámetro más, con default, para que quien ya la llama con tres no se
-- entere de nada.

do $mudar_use_lot$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'use_lot'
  ) then
    alter function public.use_lot(uuid, numeric, text) set schema app;
  end if;
end;
$mudar_use_lot$;

revoke all on function app.use_lot(uuid, numeric, text) from public, anon, authenticated;

create or replace function public.use_lot(
  p_lot_id     uuid,
  p_quantity   numeric default null,
  p_notes      text    default null,
  p_dedupe_key text    default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid; v_claim record;
begin
  select household_id into v_household from public.inventory_lots where id = p_lot_id;
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  -- Sin clave se comporta EXACTAMENTE como antes. La clave es una mejora que
  -- se pide, no un requisito nuevo que rompa a los que ya llaman.
  if p_dedupe_key is not null then
    select * into v_claim from app.claim_dedupe(v_household, p_dedupe_key, 'use_lot');
    if not v_claim.tomada then return; end if;   -- ya se hizo: no se descuenta otra vez
  end if;

  perform app.use_lot(p_lot_id, p_quantity, p_notes);

  if p_dedupe_key is not null then
    perform app.settle_dedupe(v_household, p_dedupe_key, p_lot_id);
  end if;
end;
$$;

comment on function public.use_lot(uuid, numeric, text, text) is
  'Envoltorio de idempotencia (0058). El cuerpo real vive en app.use_lot y '
  'sigue siendo el de la 0036: FEFO, faltantes y libro mayor. Acá sólo se '
  'agrega la clave, porque el QR invita a tocar dos veces.';

-- ---------------------------------------------------------------------------
-- 5. `apply_clinical_shopping_delta`: clave Y guarda de estado
-- ---------------------------------------------------------------------------
--
-- Hasta acá el asistente tenía PROHIBIDO proponerla, por dos motivos: aplicar
-- el delta dos veces lo suma dos veces, y no había ninguna guarda sobre el
-- estado de la revisión — se podía aplicar el ajuste de una revisión ya
-- resuelta, o resuelta como DESCARTADA.
--
-- Mismo molde que arriba: el cuerpo de la 0030 no se toca. Ese cuerpo es el que
-- sabe que quien compra ve `CLINICAL_ADJUSTMENT` y jamás el biomarcador.

do $mudar_delta$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'apply_clinical_shopping_delta'
  ) then
    alter function public.apply_clinical_shopping_delta(uuid, jsonb) set schema app;
  end if;
end;
$mudar_delta$;

revoke all on function app.apply_clinical_shopping_delta(uuid, jsonb)
  from public, anon, authenticated;

create or replace function public.apply_clinical_shopping_delta(
  p_review_id  uuid,
  p_deltas     jsonb,
  p_dedupe_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_r public.clinical_impact_reviews; v_household uuid; v_claim record;
begin
  select * into v_r from public.clinical_impact_reviews where id = p_review_id for update;
  -- El mensaje de "no existe" lo sigue dando la función de adentro: el contrato
  -- de errores no se cambia de contrabando en una migración de idempotencia.
  if not found then return app.apply_clinical_shopping_delta(p_review_id, p_deltas); end if;

  -- Una revisión ya resuelta no se vuelve a aplicar. Antes de esta línea, el
  -- ajuste de una revisión DISMISSED se aplicaba igual.
  if v_r.status <> 'PENDING' then
    return jsonb_build_object(
      'applied', '[]'::jsonb, 'no_line_found', '[]'::jsonb,
      'reason_code', 'CLINICAL_ADJUSTMENT',
      'skipped', 'REVISION_YA_RESUELTA', 'status', v_r.status);
  end if;

  v_household := app.member_household(v_r.member_id);

  if p_dedupe_key is not null then
    select * into v_claim from app.claim_dedupe(v_household, p_dedupe_key, 'apply_clinical_shopping_delta');
    if not v_claim.tomada then
      return jsonb_build_object(
        'applied', '[]'::jsonb, 'no_line_found', '[]'::jsonb,
        'reason_code', 'CLINICAL_ADJUSTMENT', 'skipped', 'YA_APLICADO');
    end if;
  end if;

  declare v_out jsonb;
  begin
    v_out := app.apply_clinical_shopping_delta(p_review_id, p_deltas);
    if p_dedupe_key is not null then
      perform app.settle_dedupe(v_household, p_dedupe_key, p_review_id);
    end if;
    return v_out;
  end;
end;
$$;

comment on function public.apply_clinical_shopping_delta(uuid, jsonb, text) is
  'Envoltorio (0058): guarda de estado —sólo revisiones PENDING— y clave de '
  'idempotencia. El cuerpo de la 0030 no se toca: es el que garantiza que quien '
  'compra vea CLINICAL_ADJUSTMENT y nunca el biomarcador.';
