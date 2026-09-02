-- Sprint 14 — LA FRONTERA DE EXTRACCIÓN DE BOLETAS.
--
-- EL OCR NO TOCA NADA HASTA QUE UN HUMANO CONFIRMA: no crea stock, no crea
-- precios, no mueve plata. Extrae candidatos y espera. Esa frase ya está
-- implementada guarda por guarda en `0026_health_documents.sql` (documento →
-- candidatos → revisión → confirmados, bucket privado, estados calculados), y
-- acá se copia entera. Lo que cambia es el ancla (HOGAR, no persona), el destino
-- confirmado (muchísimo más pesado: una compra, sus lotes y su plata) y el
-- matching. Una boleta NO es dato clínico, así que NO usa los grants médicos —
-- pero sí bucket privado y RLS por hogar.
--
-- LO QUE ESTA MIGRACIÓN EXISTE PARA IMPEDIR, y que el diseño original permitía:
--
--   [H35/H60] SUBIR DOS VECES LA MISMA FOTO CREABA DOS COMPRAS. La única
--   idempotencia del diseño era llamar `confirm` dos veces sobre el MISMO
--   documento, que no es el caso real: el caso real es la persona que sube la
--   foto de nuevo «porque creo que no se subió». Acá hay dedup en tres capas:
--   hash del archivo (unique por hogar), identidad del papel (comercio + fecha +
--   folio) y capa blanda (mismo comercio, misma fecha, mismo total sin folio) que
--   deja la boleta en NEEDS_REVIEW nombrando a su hermana y BLOQUEA la
--   confirmación hasta que alguien declare «son dos compras distintas».
--
--   [H36] CONFIRMACIÓN PARCIAL. En el clínico decidir 5 de 8 observaciones y
--   volver después es inocuo. Acá no: la segunda llamada creaba una SEGUNDA
--   compra y el despacho se repartía dos veces, entre dos subconjuntos. La
--   confirmación de una boleta es TODO O NADA, y `purchase_receipts.purchase_id`
--   es único: una boleta genera UNA compra en toda su vida.
--
--   [H37] LA MISMA BOLETA POR LOS DOS CAMINOS. Recibiste el sábado por
--   `receive_shopping_list` y el domingo subes la foto: nada impedía que el
--   documento recorriera `confirm` (que crea lotes) Y `attach` (que solo
--   valoriza). Ahora la boleta DECLARA SU DESTINO al subir y el destino es
--   excluyente.
--
--   [H38] «1 kg» leído donde decía «10 kg». La identidad precio × cantidad =
--   subtotal es la única red que atrapa un dígito, y no estaba en ninguna parte.
--   Acá corre con `app.line_price_mismatch_minor` (0043) contra la tolerancia por
--   línea. Los tres números son datos LEÍDOS: el sistema NO sabe cuál está malo,
--   así que jamás recalcula ninguno — muestra los tres y decide la persona.
--
--   [H40/H45] «CONFIRMAR TODAS» CON 40 LÍNEAS DE SUPERMERCADO. Técnicamente hubo
--   un humano; no miró ninguna línea. Una línea dudosa exige `acknowledged` por
--   línea, que en la pantalla significa haberla abierto.
--
--   [H44] EL CÓDIGO DE BARRAS SIN DÍGITO VERIFICADOR. `match_method='BARCODE'` es
--   la vía de mayor confianza y la que menos escrutinio recibía; un EAN-13 con un
--   dígito mal leído matchea OTRO producto real. La aritmética que atrapa la
--   mayoría de esos errores es gratis: acá corre antes de usar el barcode.
--
--   [H41/H42] EL TOTAL CONTRA EL QUE SE VALIDA TODO LO ESCRIBÍA EL OCR. El total
--   declarado es el único campo de la boleta que exige toque humano explícito, y
--   si la persona se niega a teclearlo, TODAS las líneas quedan dudosas —
--   confirmables una por una, nunca en bloque.
--
--   [H52/H66] `archive` BORRABA EL ARCHIVO DE UNA COMPRA CONFIRMADA. Arreglar el
--   bug de huérfanos del Sprint 11 no es lo mismo que autorizar la destrucción de
--   la evidencia de un hecho contable en el mismo sprint que declara historia
--   inmutable.
--
--   [H68] MONTOS EN `audit_events`. Esa tabla está documentada como traza SIN
--   contenido sensible y su policy es de admin: meter plata ahí crea un canal
--   monetario que ninguna policy de finanzas gobierna y, al revés, esconde la
--   historia del dinero justo de quien tiene FINANCE_VIEW. Los montos viven en
--   `public.finance_audit_log`, con su propia RLS.

do $guarda$
begin
  if to_regclass('public.purchase_items') is null then
    raise exception
      'falta la migración 0043 (compras): la 0045 confirma boletas creando compras y no se aplica sola.'
      using errcode = 'check_violation';
  end if;
  if to_regclass('public.cost_allocations') is null then
    raise exception
      'falta la migración 0044 (asignación de costo): confirmar una boleta con cargos EXPENSE_ONLY necesita cost_allocations.'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'finance_access'
  ) then
    raise exception
      'falta app.finance_access y el enum public.finance_permission (permisos financieros): la 0045 declara su RLS con ellos.'
      using errcode = 'check_violation';
  end if;
end;
$guarda$;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------

-- Los MISMOS 7 estados de `public.lab_document_status`. Enum NUEVO y no reuso
-- del clínico para no acoplar finanzas con salud: `salud-privacidad.test.ts`
-- vigila esa separación y un enum compartido la volvería una dependencia real.
create type public.receipt_document_status as enum
  ('UPLOADED', 'PROCESSING', 'EXTRACTED', 'NEEDS_REVIEW', 'CONFIRMED', 'FAILED', 'ARCHIVED');

-- `public.ai_consent_status` y `public.extraction_candidate_status` SÍ se reusan
-- tal cual: son genéricos, no dicen nada clínico.

/**
 * [H37] El destino de la boleta, declarado al subir y EXCLUYENTE.
 *
 * Sin esto, un documento en EXTRACTED es candidato válido para
 * `confirm_receipt_extraction` (que crea lotes) y para
 * `attach_receipt_to_purchase` (que solo pone el valor que faltaba). La misma
 * mercadería entra dos veces a la despensa y el gasto se cuenta dos veces.
 */
create type public.receipt_intent as enum ('NEW_PURCHASE', 'ATTACH_TO_EXISTING');

/**
 * [H48] De dónde salió la fecha de la compra.
 *
 * Una boleta del 3 de agosto subida el 25 NO es una compra del 25. La fecha
 * correcta es la IMPRESA; si no se lee, se le pide a la persona; y solo si se
 * niega se usa hoy — dejando anotado cuál de las tres fue, para que la
 * antigüedad de un precio sea auditable en vez de creíble.
 */
create type public.purchase_date_source as enum ('PRINTED', 'HUMAN', 'UPLOAD_DATE');

/**
 * [H62] El propósito del consentimiento de IA, ACOTADO.
 *
 * Era texto libre. Un consentimiento cuyo alcance lo escribe quien lo pide no
 * es un consentimiento: es una casilla.
 */
create type public.receipt_ai_purpose as enum
  ('EXTRAER_LINEAS',        -- leer las líneas de la boleta para proponerlas
   'EXTRAER_TOTAL_Y_FOLIO', -- leer encabezado (comercio, fecha, folio, total)
   'AMBOS');

-- ---------------------------------------------------------------------------
-- public.finance_audit_log — la historia del dinero, visible con FINANCE_VIEW
-- ---------------------------------------------------------------------------
--
-- [H68] `public.audit_events` está documentada en 0001_family.sql:97 como
-- «Auditoría append-only (sin contenido sensible: referencias por id)» y su
-- policy es `app.is_household_admin`. Meter montos ahí rompe el contrato de la
-- tabla por un lado y, por el otro, deja la historia de las correcciones de
-- plata invisible justo para quien tiene FINANCE_VIEW y no es admin — el rol
-- que la necesita. Los montos viven acá; en `audit_events` quedan ids y conteos.

create table public.finance_audit_log (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  action         text not null check (char_length(action) between 1 and 80),
  subject_kind   text not null check (char_length(subject_kind) between 1 and 60),
  subject_id     uuid,
  currency       char(3) references public.currency_units (code),
  -- El monto puede ser DESCONOCIDO, y entonces lo dice su columna hermana.
  amount_minor   bigint check (amount_minor between -1000000000000000 and 1000000000000000),
  amount_status  public.money_status not null default 'UNKNOWN',
  amount_unknown_reason public.money_unknown_reason default 'NO_PRICE_RECORDED',
  detail         jsonb not null default '{}'::jsonb,
  actor_member_id uuid references public.household_members (id) on delete set null,
  actor_user_id  uuid,
  created_at     timestamptz not null default now(),
  constraint finance_audit_monto_coherente
    check (app.money_coherent(amount_status, amount_minor, amount_unknown_reason))
);

create index finance_audit_log_hogar_idx
  on public.finance_audit_log (household_id, created_at desc);

alter table public.finance_audit_log enable row level security;
create policy finance_audit_log_select on public.finance_audit_log
  for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
revoke insert, update, delete on public.finance_audit_log from anon, authenticated;

/** Traza append-only: se escribe, no se corrige. Corregir es escribir otra fila. */
create or replace function app.finance_audit_is_append_only()
returns trigger language plpgsql as $fn$
begin
  raise exception 'la traza del dinero es append-only: una corrección es una fila nueva'
    using errcode = 'check_violation';
end;
$fn$;

create trigger finance_audit_log_append_only
  before update or delete on public.finance_audit_log
  for each row execute function app.finance_audit_is_append_only();

/** Escribir en la traza del dinero. Un monto NULL entra como DESCONOCIDO con su motivo. */
create or replace function app.finance_audit(
  p_household     uuid,
  p_action        text,
  p_subject_kind  text,
  p_subject_id    uuid,
  p_currency      char(3),
  p_amount_minor  bigint,
  p_detail        jsonb default '{}'::jsonb,
  p_unknown_reason public.money_unknown_reason default 'NO_PRICE_RECORDED'
) returns void language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.finance_audit_log
    (household_id, action, subject_kind, subject_id, currency,
     amount_minor, amount_status, amount_unknown_reason, detail,
     actor_member_id, actor_user_id)
  values
    (p_household, p_action, p_subject_kind, p_subject_id, p_currency,
     p_amount_minor,
     case when p_amount_minor is null then 'UNKNOWN' else 'KNOWN' end::public.money_status,
     case when p_amount_minor is null then p_unknown_reason end::public.money_unknown_reason,
     coalesce(p_detail, '{}'::jsonb),
     app.current_member_id(p_household), auth.uid());
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Helpers puros: la clave del comercio y el dígito verificador del barcode
-- ---------------------------------------------------------------------------

/**
 * La clave normalizada del comercio.
 *
 * Es la MISMA expresión que `public.record_purchase` (0043) usa en línea para
 * `purchases.merchant_key`; acá vive con nombre para que la boleta y la compra
 * no puedan normalizar distinto y dejar de emparejarse.
 */
create or replace function app.merchant_key(p_name text)
returns text language sql immutable as $fn$
  select lower(trim(coalesce(nullif(trim(p_name), ''), 'sin comercio')));
$fn$;

/**
 * [H44] Dígito verificador de EAN-8 / UPC-A / EAN-13 / GTIN-14.
 *
 * Un barcode leído de una foto con un dígito cambiado puede matchear OTRO
 * producto real del catálogo, con `match_score` 1.0 y sin ninguna señal. Esta
 * aritmética es gratis y ataja la mayoría de esos errores. El gemelo exacto en
 * TypeScript vive en `web/src/domain/finance/receipt-extraction.ts` y hay un
 * test que corre los dos con la misma tabla de casos.
 *
 * Devuelve false —no NULL— ante basura: un código que no es un código no valida.
 */
create or replace function app.ean_check_digit_ok(p_code text)
returns boolean language plpgsql immutable as $fn$
declare
  v_code text;
  v_len int;
  v_suma int := 0;
  v_i int;
begin
  if p_code is null then return false; end if;
  v_code := trim(p_code);
  if v_code !~ '^[0-9]+$' then return false; end if;
  v_len := char_length(v_code);
  if v_len not in (8, 12, 13, 14) then return false; end if;

  -- Se recorre de derecha a izquierda SIN contar el verificador; el primero
  -- pesa 3 y desde ahí alternan 1 y 3. La regla vale igual para los cuatro largos.
  for v_i in 1 .. v_len - 1 loop
    v_suma := v_suma
      + substr(v_code, v_len - v_i, 1)::int * (case when v_i % 2 = 1 then 3 else 1 end);
  end loop;

  return ((10 - (v_suma % 10)) % 10) = substr(v_code, v_len, 1)::int;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Columnas que la boleta le agrega a la compra
-- ---------------------------------------------------------------------------

-- [H48] De dónde salió `purchased_on`, y [H42] quién puso la cara por el total.
alter table public.purchases
  add column purchased_on_source public.purchase_date_source not null default 'UPLOAD_DATE',
  add column total_confirmed_by  uuid references public.household_members (id) on delete set null,
  add column total_confirmed_at  timestamptz;

comment on column public.purchases.total_confirmed_by is
  'El total declarado es el único campo de la boleta que exige toque humano: es el ancla '
  'contra la que se concilia todo lo demás y un total mal leído puede TAPAR una línea mal '
  'leída si los errores se compensan.';

-- ---------------------------------------------------------------------------
-- public.purchase_receipts — calcado de lab_documents:242
-- ---------------------------------------------------------------------------

create table public.purchase_receipts (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references public.households (id) on delete cascade,

  -- Ruta en el bucket PRIVADO `purchase-receipts`. Jamás una URL pública.
  storage_path         text not null check (char_length(storage_path) between 1 and 500),
  -- [H51] El nombre del objeto ES el hash, así que volver a subir la misma foto
  -- es idempotente también a nivel de Storage: no deja cinco objetos distintos.
  content_sha256       text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  original_mime        text not null
    check (original_mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain')),
  byte_size            bigint not null check (byte_size > 0 and byte_size <= 8388608),

  -- Encabezado leído del papel. Todo NULL = no se leyó, jamás un valor inventado.
  receipt_date         date,
  merchant_name        text check (char_length(merchant_name) between 1 and 160),
  merchant_key         text check (char_length(merchant_key) between 1 and 160),
  receipt_number       text check (char_length(receipt_number) between 1 and 60),

  currency             char(3) not null default 'CLP' references public.currency_units (code),

  -- [H30] El total con su columna HERMANA de estado, igual que `purchases`. Sin
  -- ella quedaban representables dos mentiras: total_source='PRINTED' sin número,
  -- y $0 'impreso', que es exactamente como se ve un OCR que no leyó nada.
  declared_total_minor bigint check (declared_total_minor is null or declared_total_minor > 0),
  total_status         public.money_status not null default 'UNKNOWN',
  total_unknown_reason public.money_unknown_reason default 'NO_PRICE_RECORDED',
  total_source         public.receipt_total_source not null default 'UNKNOWN',

  -- [H37] El destino, elegido al subir y excluyente.
  intent               public.receipt_intent not null default 'NEW_PURCHASE',

  processing_status    public.receipt_document_status not null default 'UPLOADED',
  failure_reason       text,

  -- Consentimiento de IA (§2.5.2): una boleta manda RUT, dirección, medio de
  -- pago y el patrón de consumo del hogar a un modelo externo. Es decisión
  -- explícita, fechada, firmada y REVOCABLE.
  ai_consent_status    public.ai_consent_status not null default 'NOT_REQUESTED',
  ai_consented_at      timestamptz,
  ai_consented_by      uuid references public.household_members (id) on delete set null,
  ai_consent_purpose   public.receipt_ai_purpose,
  ai_consent_revoked_at timestamptz,
  ai_consent_revoked_by uuid references public.household_members (id) on delete set null,

  ai_processor_version text,
  extraction_version   text,
  -- [H43] La identidad de un candidato es su POSICIÓN. Un segundo pase del
  -- extractor con otro número de líneas desalineaba lo ya decidido; ahora cada
  -- pase es una PASADA con historia propia.
  extraction_pass      int not null default 0 check (extraction_pass >= 0),

  -- [H35] capa blanda de dedup: mismo comercio, misma fecha, mismo total, sin
  -- folio legible. No se auto-rechaza ni se auto-acepta: se nombra a la hermana
  -- y se espera a que un humano diga «son dos compras distintas» (que pasa: dos
  -- vueltas al mismo súper el mismo día).
  duplicate_of         uuid references public.purchase_receipts (id) on delete set null,
  duplicate_ack_at     timestamptz,
  duplicate_ack_by     uuid references public.household_members (id) on delete set null,
  duplicate_ack_reason text,

  confirmed_at         timestamptz,
  confirmed_by         uuid references public.household_members (id) on delete set null,

  -- [H36/H47/H60] EL ÚNICO dueño del vínculo boleta↔compra. `purchases` NO tiene
  -- `receipt_id`: dos punteros a la misma relación se desincronizan y dejan dos
  -- compras cuadrando contra el mismo total impreso.
  purchase_id          uuid references public.purchases (id) on delete set null,

  uploaded_at          timestamptz not null default now(),
  uploaded_by          uuid references public.household_members (id) on delete set null,

  constraint receipt_total_coherente check (
    (total_status = 'KNOWN'   and declared_total_minor is not null and total_unknown_reason is null) or
    (total_status = 'UNKNOWN' and declared_total_minor is null     and total_unknown_reason is not null)
  ),
  -- Decir «el total estaba impreso» sin traer el número es decir dos cosas que
  -- no pueden ser verdad a la vez.
  constraint receipt_total_impreso_tiene_numero
    check (total_source <> 'PRINTED' or declared_total_minor is not null),
  constraint receipt_no_es_su_propio_duplicado check (duplicate_of is null or duplicate_of <> id)
);

-- [H35 capa 1] Subir el mismo archivo NO crea una segunda fila.
--
-- EL PREDICADO NO ES «no archivada»: es «no archivada O ya generó compra».
-- Archivar es lo más fácil de hacer sin querer —se archiva para ordenar— y con
-- el predicado viejo eso apagaba la dedup entera: la misma foto volvía a entrar
-- como compra nueva, con su segundo juego de líneas y su segundo juego de lotes.
-- Una boleta que YA generó una compra retiene su hash y su folio PARA SIEMPRE.
-- Descartar un duplicado que nunca llegó a compra sí libera el hash, que es para
-- lo único que se escribió esta excepción.
create unique index purchase_receipts_hash_uniq
  on public.purchase_receipts (household_id, content_sha256)
  where processing_status <> 'ARCHIVED' or purchase_id is not null;

-- [H35 capa 2] Folio + comercio + fecha es la identidad de la boleta chilena.
-- Se aplica al TERMINAR la extracción, no al subir: antes de leer el papel no
-- hay folio que comparar.
create unique index purchase_receipts_folio_uniq
  on public.purchase_receipts (household_id, merchant_key, receipt_date, receipt_number)
  where receipt_number is not null
    and (processing_status <> 'ARCHIVED' or purchase_id is not null);

-- [H36] Una boleta genera UNA compra en toda su vida.
create unique index purchase_receipts_compra_uniq
  on public.purchase_receipts (purchase_id) where purchase_id is not null;

create index purchase_receipts_hogar_idx
  on public.purchase_receipts (household_id, uploaded_at desc);

alter table public.purchase_receipts enable row level security;
create policy purchase_receipts_select on public.purchase_receipts
  for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
revoke insert, update, delete on public.purchase_receipts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.receipt_extraction_candidates — calcado de lab_extraction_candidates:279
-- ---------------------------------------------------------------------------
--
-- La capa IA PROPONE; jamás decide. Nada de acá toca stock, precios ni plata.

create table public.receipt_extraction_candidates (
  id                    uuid primary key default gen_random_uuid(),
  receipt_id            uuid not null references public.purchase_receipts (id) on delete cascade,
  -- [H43] Pasada de extracción. La anterior se conserva como historia.
  extraction_pass       int not null default 1 check (extraction_pass >= 1),
  line_ordinal          int not null check (line_ordinal >= 1),

  raw_line_text         text not null check (char_length(raw_line_text) between 1 and 500),
  original_snippet      text check (char_length(original_snippet) <= 500),

  quantity              numeric(12, 3) check (quantity > 0),
  -- NULL = la boleta no traía unidad legible. JAMÁS se rellena con la unidad
  -- canónica del catálogo: eso sería inventar.
  unit                  text check (unit in ('G', 'ML', 'UNIT')),

  unit_price_minor      bigint check (unit_price_minor between -1000000000000000 and 1000000000000000),
  -- [H38] En qué base viene el precio impreso ($/kg de un pesable chileno vs la
  -- cantidad del lote en gramos). Sin esta columna el chequeo de línea NI SE
  -- PUEDE ESCRIBIR. NULL = no se leyó, y entonces el chequeo no corre.
  unit_price_basis      public.unit_price_basis,
  line_total_minor      bigint check (line_total_minor between -1000000000000000 and 1000000000000000),
  discount_minor        bigint check (discount_minor between -1000000000000000 and 1000000000000000),

  barcode               text check (barcode ~ '^[0-9]{8,14}$'),
  -- [H44] Resultado del dígito verificador, guardado para que la pantalla pueda
  -- explicar POR QUÉ un barcode no se usó como vía de match.
  barcode_check_ok      boolean,

  matched_product_id    uuid references public.commercial_products (id) on delete set null,
  matched_ingredient_id uuid references public.ingredients (id) on delete set null,
  match_method          public.line_match_method not null default 'NONE',
  match_score           numeric(4, 3) check (match_score between 0 and 1),

  extraction_confidence numeric(4, 3) check (extraction_confidence between 0 and 1),
  -- [H40] Una confianza GLOBAL por línea no alcanza: una boleta térmica se lee
  -- bien en la descripción y mal en el monto. `match_score` mide identidad del
  -- producto; esto mide legibilidad de CADA dígito. Claves esperadas:
  -- quantity / unit_price / line_total / barcode.
  field_confidences     jsonb not null default '{}'::jsonb,

  -- Por qué esta línea es dudosa, calculado por el servidor y guardado para que
  -- la pantalla resalte el campo exacto. Vacío = está limpia.
  doubt_reasons         text[] not null default '{}',

  status                public.extraction_candidate_status not null default 'PENDING',
  decided_at            timestamptz,
  decided_by            uuid references public.household_members (id) on delete set null,
  created_at            timestamptz not null default now(),

  unique (receipt_id, extraction_pass, line_ordinal)
);

create index receipt_candidates_por_boleta
  on public.receipt_extraction_candidates (receipt_id, extraction_pass, line_ordinal);

alter table public.receipt_extraction_candidates enable row level security;
create policy receipt_candidates_select on public.receipt_extraction_candidates
  for select to authenticated
  using (exists (
    select 1 from public.purchase_receipts d
    where d.id = receipt_id and app.finance_access(d.household_id, 'FINANCE_VIEW')
  ));
revoke insert, update, delete on public.receipt_extraction_candidates from anon, authenticated;

-- ---------------------------------------------------------------------------
-- LA DEFINICIÓN DE «DUDOSO», EN UN SOLO LUGAR
-- ---------------------------------------------------------------------------
--
-- Una línea dudosa no se confirma en bloque. Que la definición viva en UNA
-- función y no repartida entre `submit` y `confirm` es lo que impide que la
-- pantalla y el servidor tengan dos ideas distintas de qué se puede confirmar.

/**
 * [H41 red 2] Control de plausibilidad: ¿este precio se parece al de la última
 * vez en el mismo comercio?
 *
 * Devuelve el último precio unitario conocido para el mismo producto (o
 * alimento) en el mismo comercio y en la MISMA base de precio. NULL significa
 * DESCONOCIDO —nunca se compró ahí, o nunca se supo el precio— y quien llame
 * tiene que tratarlo como «no hay con qué comparar», jamás como cero.
 *
 * Un salto de 10x es un dígito, no inflación.
 */
create or replace function app.last_unit_price_minor(
  p_household     uuid,
  p_merchant_key  text,
  p_product_id    uuid,
  p_ingredient_id uuid,
  p_basis         public.unit_price_basis,
  p_before        date
) returns bigint language sql stable security definer set search_path = public as $fn$
  select i.unit_price_minor
  from public.purchase_items i
  join public.purchases c on c.id = i.purchase_id
  where c.household_id = p_household
    and c.merchant_key = p_merchant_key
    and c.purchased_on <= coalesce(p_before, c.purchased_on)
    and i.superseded_at is null
    and i.unit_price_minor is not null
    and i.unit_price_basis is not distinct from p_basis
    and ((p_product_id is not null and i.product_id = p_product_id)
      or (p_product_id is null and p_ingredient_id is not null and i.ingredient_id = p_ingredient_id))
  order by c.purchased_on desc, i.created_at desc
  limit 1;
$fn$;

/**
 * Por qué esta línea es dudosa. Array vacío = está limpia.
 *
 * Los motivos son etiquetas estables (la pantalla las traduce y resalta el campo
 * exacto), no frases: una frase cambia con el copy y rompe la comparación.
 *
 * [H40] La confianza por CAMPO entra acá. Una línea con código de barras
 * perfecto y total presente, pero con el monto leído con 0,4 de confianza porque
 * la boleta térmica estaba borrosa, pasaba como limpia. Ese es exactamente el
 * camino por el que $1.990 entra como $17.990.
 */
create or replace function app.receipt_candidate_doubts(p_candidate uuid)
returns text[] language plpgsql stable security definer set search_path = public as $fn$
declare
  v_c public.receipt_extraction_candidates;
  v_d public.purchase_receipts;
  v_out text[] := '{}';
  v_tol bigint;
  v_desc bigint;
  v_ultimo bigint;
  v_campo text;
  v_conf numeric;
begin
  select * into v_c from public.receipt_extraction_candidates where id = p_candidate;
  if v_c.id is null then
    raise exception 'candidato inexistente' using errcode = 'check_violation';
  end if;
  select * into v_d from public.purchase_receipts where id = v_c.receipt_id;

  -- 1. Sin producto ni alimento no hay qué recibir en la despensa.
  if v_c.matched_product_id is null and v_c.matched_ingredient_id is null then
    v_out := array_append(v_out, 'SIN_PRODUCTO');
  end if;

  -- 2. Sin total de línea no hay valor capitalizable: DESCONOCIDO, no cero.
  if v_c.line_total_minor is null then
    v_out := array_append(v_out, 'SIN_TOTAL_DE_LINEA');
  end if;

  -- 3. Match de baja confianza aceptado en silencio contamina precios y costos
  --    por meses. Un match_method que no es NONE sin score es igual de dudoso.
  if v_c.match_method <> 'NONE' and (v_c.match_score is null or v_c.match_score < 0.85) then
    v_out := array_append(v_out, 'MATCH_DUDOSO');
  end if;

  -- 4. [H44] Barcode que no valida: NO se usa como vía de match.
  if v_c.barcode is not null and coalesce(v_c.barcode_check_ok, false) is false then
    v_out := array_append(v_out, 'BARRAS_INVALIDO');
  end if;
  if v_c.match_method = 'BARCODE' and (v_c.barcode is null or coalesce(v_c.barcode_check_ok, false) is false) then
    v_out := array_append(v_out, 'BARRAS_SIN_RESPALDO');
  end if;

  -- 5. [H40] Confianza por campo. Se recorre lo que el extractor declaró; un
  --    campo sin confianza declarada NO se asume bueno.
  foreach v_campo in array array['quantity', 'unit_price', 'line_total', 'barcode'] loop
    if v_c.field_confidences ? v_campo then
      v_conf := (v_c.field_confidences ->> v_campo)::numeric;
      if v_conf is null or v_conf < 0.85 then
        v_out := array_append(v_out, 'LECTURA_DUDOSA:' || v_campo);
      end if;
    end if;
  end loop;
  if v_c.extraction_confidence is not null and v_c.extraction_confidence < 0.85 then
    v_out := array_append(v_out, 'LECTURA_DUDOSA:linea');
  end if;

  -- 6. [H38] La aritmética de la línea: precio × cantidad = subtotal. Es la
  --    única red que atrapa «1 kg» leído donde decía «10 kg». Los tres números
  --    son datos LEÍDOS: acá se MIDE, nunca se corrige ninguno.
  v_desc := app.line_price_mismatch_minor(
    v_c.unit_price_minor, v_c.unit_price_basis, v_c.quantity, v_c.unit, v_c.line_total_minor);
  if v_desc is not null then
    select u.reconciliation_tolerance_per_line_minor into v_tol
    from public.currency_units u where u.code = v_d.currency;
    if v_tol is null or abs(v_desc) > v_tol then
      v_out := array_append(v_out, 'ARITMETICA_NO_CUADRA');
    end if;
  elsif v_c.unit_price_minor is not null and v_c.unit_price_basis is null then
    -- El diseño ya sabe que el pesable es especial (VARIABLE_WEIGHT). Sin base
    -- declarada el chequeo no puede correr, así que la línea queda dudosa igual:
    -- no verificar no es lo mismo que verificar y pasar.
    v_out := array_append(v_out, 'PRECIO_SIN_BASE');
  end if;

  -- 7. [H41] Plausibilidad contra la última compra en el mismo comercio.
  if v_c.unit_price_minor is not null and v_c.unit_price_minor > 0 then
    v_ultimo := app.last_unit_price_minor(
      v_d.household_id, v_d.merchant_key, v_c.matched_product_id,
      v_c.matched_ingredient_id, v_c.unit_price_basis, v_d.receipt_date);
    -- v_ultimo NULL = nunca se compró acá: no hay con qué comparar y NO se
    -- inventa una comparación contra cero.
    if v_ultimo is not null and v_ultimo > 0 then
      if v_c.unit_price_minor >= v_ultimo * 3 or v_c.unit_price_minor * 3 <= v_ultimo then
        v_out := array_append(v_out, 'PRECIO_FUERA_DE_RANGO');
      end if;
    end if;
  end if;

  return v_out;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- upload / consentimiento / destino
-- ---------------------------------------------------------------------------

/**
 * [H51] Sonda de duplicado ANTES de subir nada.
 *
 * La server action calcula el sha256 sobre el buffer, pregunta acá y, si la
 * boleta ya existe, NO sube un segundo objeto al bucket. Sin esto el hash se
 * comprueba después de subir y la misma foto deja cinco objetos distintos.
 */
create or replace function public.find_purchase_receipt_by_hash(
  p_household uuid,
  p_sha256    text
) returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_d public.purchase_receipts;
begin
  if not app.finance_access(p_household, 'FINANCE_UPLOAD_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  -- Mismo predicado que el índice: archivar una boleta que ya generó compra NO
  -- la esconde de la sonda. Si lo hiciera, la foto volvería a entrar como compra
  -- nueva y la despensa quedaría con el doble de todo.
  select * into v_d from public.purchase_receipts
  where household_id = p_household and content_sha256 = lower(trim(p_sha256))
    and (processing_status <> 'ARCHIVED' or purchase_id is not null);
  if v_d.id is null then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'receiptId', v_d.id,
    'status', v_d.processing_status::text,
    'intent', v_d.intent::text,
    'archived', v_d.processing_status = 'ARCHIVED',
    'purchaseId', v_d.purchase_id,
    'uploadedAt', v_d.uploaded_at);
end;
$fn$;

/**
 * Subir una boleta. Calcado de `upload_lab_document` (0026:386) con dos cosas
 * más: el hash del archivo y el DESTINO declarado.
 *
 * [H35] Ante colisión de hash NO crea fila nueva: devuelve la que ya existe con
 * su estado, y la server action no sube un segundo objeto.
 *
 * Permiso: FINANCE_UPLOAD_RECEIPTS — el adolescente puede sacarle la foto a la
 * boleta sin poder confirmarla ni autorizar que se mande a un modelo externo.
 */
create or replace function public.upload_purchase_receipt(
  p_household    uuid,
  p_storage_path text,
  p_mime         text,
  p_bytes        bigint,
  p_sha256       text,
  p_intent       public.receipt_intent default 'NEW_PURCHASE'
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_hash text;
  v_d public.purchase_receipts;
  v_id uuid;
  v_currency char(3);
begin
  if not app.finance_access(p_household, 'FINANCE_UPLOAD_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  v_hash := lower(trim(coalesce(p_sha256, '')));
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'toda boleta entra con el sha256 de su archivo: sin él, subir la misma foto dos veces crea dos compras'
      using errcode = 'check_violation';
  end if;

  select * into v_d from public.purchase_receipts
  where household_id = p_household and content_sha256 = v_hash
    and (processing_status <> 'ARCHIVED' or purchase_id is not null)
  for update;
  if v_d.id is not null then
    -- Mismo archivo, misma boleta. Devolver la existente NO es un error: es la
    -- respuesta correcta a «creo que no se subió». Y si esa boleta está
    -- ARCHIVADA pero ya generó su compra, esta sigue siendo la respuesta
    -- correcta: la compra existe, ordenar la bandeja no la borró.
    return jsonb_build_object('receiptId', v_d.id, 'duplicated', true,
                              'archived', v_d.processing_status = 'ARCHIVED',
                              'purchaseId', v_d.purchase_id,
                              'status', v_d.processing_status::text);
  end if;

  select h.currency into v_currency from public.households h where h.id = p_household;
  if v_currency is null then
    raise exception 'el hogar no existe' using errcode = 'check_violation';
  end if;

  insert into public.purchase_receipts
    (household_id, storage_path, content_sha256, original_mime, byte_size,
     currency, intent, uploaded_by)
  values
    (p_household, p_storage_path, v_hash, p_mime, p_bytes,
     v_currency, coalesce(p_intent, 'NEW_PURCHASE'), app.current_member_id(p_household))
  returning id into v_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (p_household, auth.uid(), 'RECEIPT_UPLOADED', 'purchase_receipt', v_id);
  perform app.emit_event(p_household, 'RECEIPT_UPLOADED', 'purchase_receipt',
    jsonb_build_object('receipt_id', v_id), 'RECEIPT_UPLOADED:' || v_id::text);

  return jsonb_build_object('receiptId', v_id, 'duplicated', false, 'status', 'UPLOADED');
end;
$fn$;

/**
 * [H37] Cambiar el destino de la boleta. Solo mientras el documento siga abierto:
 * una vez que generó su compra, el destino es historia.
 */
create or replace function public.set_receipt_intent(
  p_receipt uuid,
  p_intent  public.receipt_intent
) returns void language plpgsql security definer set search_path = public as $fn$
declare v_d public.purchase_receipts;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_UPLOAD_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  if v_d.processing_status not in ('UPLOADED', 'EXTRACTED', 'NEEDS_REVIEW') then
    raise exception 'esta boleta ya está %: su destino no se cambia', lower(v_d.processing_status::text)
      using errcode = 'check_violation';
  end if;
  update public.purchase_receipts set intent = p_intent where id = p_receipt;
end;
$fn$;

/**
 * Consentimiento explícito para extracción por IA.
 *
 * [H49/H62] Exige FINANCE_CONFIRM_RECEIPTS, NO el permiso de subir. El diseño
 * usaba como ejemplo al adolescente que puede subir la foto pero no confirmarla,
 * y con la tabla original ese mismo adolescente autorizaba mandar RUT,
 * dirección, medio de pago y el patrón de consumo del HOGAR a un modelo externo:
 * datos de terceros que no consintieron, decididos por quien menos
 * responsabilidad tiene.
 */
create or replace function public.set_receipt_ai_consent(
  p_receipt uuid,
  p_granted boolean,
  p_purpose public.receipt_ai_purpose
) returns void language plpgsql security definer set search_path = public as $fn$
declare v_d public.purchase_receipts;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  if v_d.processing_status in ('CONFIRMED', 'ARCHIVED') then
    raise exception 'esta boleta ya está cerrada: su consentimiento es historia'
      using errcode = 'check_violation';
  end if;
  if p_granted and p_purpose is null then
    raise exception 'un consentimiento sin propósito declarado no es un consentimiento'
      using errcode = 'check_violation';
  end if;

  update public.purchase_receipts set
    ai_consent_status  = case when p_granted then 'GRANTED' else 'DECLINED' end::public.ai_consent_status,
    ai_consented_at    = now(),
    ai_consented_by    = app.current_member_id(v_d.household_id),
    ai_consent_purpose = case when p_granted then p_purpose end,
    ai_consent_revoked_at = null,
    ai_consent_revoked_by = null
  where id = p_receipt;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_d.household_id, auth.uid(), 'RECEIPT_AI_CONSENT_SET', 'purchase_receipt', p_receipt,
          jsonb_build_object('granted', p_granted, 'purpose', p_purpose::text));
end;
$fn$;

/**
 * [H62] Revocar el consentimiento. Sin esto, un permiso otorgado una vez valía
 * para siempre y no había forma de decir «este documento ya no se manda».
 */
create or replace function public.revoke_receipt_ai_consent(
  p_receipt uuid,
  p_reason  text
) returns void language plpgsql security definer set search_path = public as $fn$
declare v_d public.purchase_receipts;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'revocar un consentimiento necesita su porqué'
      using errcode = 'check_violation';
  end if;
  update public.purchase_receipts set
    ai_consent_status = 'DECLINED',
    ai_consent_revoked_at = now(),
    ai_consent_revoked_by = app.current_member_id(v_d.household_id)
  where id = p_receipt;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_d.household_id, auth.uid(), 'RECEIPT_AI_CONSENT_REVOKED', 'purchase_receipt', p_receipt,
          jsonb_build_object('reason', left(p_reason, 200)));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- submit_receipt_extraction — las cuatro guardas de submit_lab_extraction:446
-- ---------------------------------------------------------------------------

/**
 * La capa de extracción (sustituible) deposita ACÁ sus candidatos.
 *
 * Guardas literales del clínico:
 *   1. sin `ai_consent_status = 'GRANTED'` rechaza con errcode check_violation;
 *   2. CONFIRMED/ARCHIVED = historia, no se re-extrae;
 *   3. reintento respeta lo que un humano ya decidió;
 *   4. el estado se CALCULA, no se declara.
 *
 * [H43] Y una guarda que el clínico no necesitaba: la identidad de un candidato
 * de boleta es su POSICIÓN, no un analito con nombre. Si ya hay decisiones
 * humanas, el reintento NO borra ni renumera: abre una PASADA nueva y migra las
 * decisiones SOLO por coincidencia exacta de `raw_line_text`, jamás por posición.
 *
 * [H35 capa 3] Al terminar se busca la boleta hermana: mismo comercio, misma
 * fecha, mismo total, sin folio legible. Si aparece, queda apuntada en
 * `duplicate_of` y la confirmación se bloquea hasta que un humano declare que son
 * dos compras distintas.
 */
create or replace function public.submit_receipt_extraction(
  p_receipt           uuid,
  p_processor_version text,
  p_header            jsonb,
  p_candidates        jsonb
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_d public.purchase_receipts;
  v_c jsonb;
  v_pass int;
  v_decididos int;
  v_count int := 0;
  v_dudosos int := 0;
  v_ordinal int := 0;
  v_id uuid;
  v_barcode text;
  v_fecha date;
  v_comercio text;
  v_folio text;
  v_total bigint;
  v_total_source public.receipt_total_source;
  v_hermana uuid;
  v_r record;
  v_migradas int := 0;
  -- Los valores de cabecera EFECTIVOS (los que van a quedar en la fila): hacen
  -- falta para poder nombrar a la hermana si el folio choca.
  v_fecha_ef date;
  v_folio_ef text;
  v_key_ef text;
  v_folio_choco boolean := false;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_UPLOAD_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  if v_d.ai_consent_status <> 'GRANTED' then
    raise exception 'Sin consentimiento para extracción por IA: revisa la boleta a mano o consiente primero.'
      using errcode = 'check_violation';
  end if;
  if v_d.processing_status in ('CONFIRMED', 'ARCHIVED') then
    raise exception 'esta boleta ya fue confirmada: sus líneas son historia'
      using errcode = 'check_violation';
  end if;

  select count(*)::int into v_decididos
  from public.receipt_extraction_candidates
  where receipt_id = p_receipt and status <> 'PENDING';

  if v_decididos = 0 then
    -- Nadie decidió nada todavía: se borra la pasada entera y se re-inserta
    -- limpio, sin desalinear a nadie.
    delete from public.receipt_extraction_candidates where receipt_id = p_receipt;
    v_pass := 1;
  else
    -- [H43] Ya hay decisiones humanas: la pasada anterior se conserva como
    -- historia y esta nace al lado.
    v_pass := v_d.extraction_pass + 1;
  end if;

  -- Encabezado. Todo lo que no venga queda en NULL: el OCR que no logra leer el
  -- total escribe UNKNOWN, jamás cero.
  v_fecha := nullif(p_header ->> 'receipt_date', '')::date;
  v_comercio := nullif(trim(coalesce(p_header ->> 'merchant_name', '')), '');
  v_folio := nullif(trim(coalesce(p_header ->> 'receipt_number', '')), '');
  v_total := nullif(p_header ->> 'declared_total_minor', '')::bigint;
  v_total_source := case
    when v_total is null then 'UNKNOWN'
    else coalesce(nullif(p_header ->> 'total_source', ''), 'PRINTED')::public.receipt_total_source
  end;
  if v_total is not null and v_total <= 0 then
    -- Una boleta de cero pesos es como se ve un OCR que no leyó nada.
    v_total := null;
    v_total_source := 'UNKNOWN';
  end if;

  for v_c in select * from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) loop
    v_ordinal := v_ordinal + 1;
    v_barcode := nullif(trim(coalesce(v_c ->> 'barcode', '')), '');

    insert into public.receipt_extraction_candidates (
      receipt_id, extraction_pass, line_ordinal, raw_line_text, original_snippet,
      quantity, unit, unit_price_minor, unit_price_basis, line_total_minor, discount_minor,
      barcode, barcode_check_ok,
      matched_product_id, matched_ingredient_id, match_method, match_score,
      extraction_confidence, field_confidences
    ) values (
      p_receipt, v_pass, v_ordinal,
      left(coalesce(nullif(trim(coalesce(v_c ->> 'raw_line_text', '')), ''), '(línea ilegible)'), 500),
      left(v_c ->> 'original_snippet', 500),
      nullif(v_c ->> 'quantity', '')::numeric,
      nullif(trim(coalesce(v_c ->> 'unit', '')), ''),
      nullif(v_c ->> 'unit_price_minor', '')::bigint,
      nullif(v_c ->> 'unit_price_basis', '')::public.unit_price_basis,
      nullif(v_c ->> 'line_total_minor', '')::bigint,
      nullif(v_c ->> 'discount_minor', '')::bigint,
      v_barcode,
      case when v_barcode is not null then app.ean_check_digit_ok(v_barcode) end,
      nullif(v_c ->> 'matched_product_id', '')::uuid,
      nullif(v_c ->> 'matched_ingredient_id', '')::uuid,
      -- [H44] Un barcode que no valida NO es vía de match: se degrada.
      case
        when coalesce(nullif(v_c ->> 'match_method', ''), 'NONE') = 'BARCODE'
             and not coalesce(app.ean_check_digit_ok(v_barcode), false)
        then 'FUZZY_NAME'
        else coalesce(nullif(v_c ->> 'match_method', ''), 'NONE')
      end::public.line_match_method,
      nullif(v_c ->> 'match_score', '')::numeric,
      nullif(v_c ->> 'extraction_confidence', '')::numeric,
      coalesce(v_c -> 'field_confidences', '{}'::jsonb)
    ) returning id into v_id;

    update public.receipt_extraction_candidates
    set doubt_reasons = app.receipt_candidate_doubts(v_id)
    where id = v_id;
    v_count := v_count + 1;
  end loop;

  -- Cabecera y estado CALCULADO. `array_length` de un array vacío es NULL: por
  -- eso se compara con cardinality, que devuelve 0 y no NULL.
  select count(*)::int into v_dudosos
  from public.receipt_extraction_candidates
  where receipt_id = p_receipt and extraction_pass = v_pass and cardinality(doubt_reasons) > 0;

  -- [H43] Migración de decisiones por TEXTO, nunca por posición.
  if v_decididos > 0 then
    for v_r in
      select viejo.raw_line_text, viejo.status, viejo.decided_at, viejo.decided_by
      from public.receipt_extraction_candidates viejo
      where viejo.receipt_id = p_receipt and viejo.extraction_pass < v_pass
        and viejo.status <> 'PENDING'
    loop
      update public.receipt_extraction_candidates nuevo
      set status = v_r.status, decided_at = v_r.decided_at, decided_by = v_r.decided_by
      where nuevo.receipt_id = p_receipt and nuevo.extraction_pass = v_pass
        and nuevo.status = 'PENDING'
        and nuevo.raw_line_text = v_r.raw_line_text;
      if found then v_migradas := v_migradas + 1; end if;
    end loop;
  end if;

  v_fecha_ef := coalesce(v_fecha, v_d.receipt_date);
  v_folio_ef := coalesce(v_folio, v_d.receipt_number);
  v_key_ef := case when v_comercio is not null then app.merchant_key(v_comercio) else v_d.merchant_key end;

  -- [H35 capa 2] El folio choca cuando dos personas fotografían EL MISMO PAPEL:
  -- hashes distintos, mismo folio. Dejar que hable el índice tira la transacción
  -- entera y la persona ve un error crudo de Postgres sobre una boleta que quedó
  -- en UPLOADED, sin candidatos, sin hermana nombrada y sin ninguna acción
  -- posible. Acá la colisión se resuelve como la capa blanda: se nombra a la
  -- hermana, se deja NEEDS_REVIEW y se explica en español.
  begin
    update public.purchase_receipts set
      receipt_date = v_fecha_ef,
      merchant_name = coalesce(v_comercio, merchant_name),
      merchant_key = v_key_ef,
      receipt_number = v_folio_ef,
      declared_total_minor = v_total,
      total_status = case when v_total is null then 'UNKNOWN' else 'KNOWN' end::public.money_status,
      total_unknown_reason = case when v_total is null then 'NO_PRICE_RECORDED' end::public.money_unknown_reason,
      total_source = v_total_source,
      processing_status = case
        when v_count = 0 then 'FAILED'
        when v_dudosos > 0 then 'NEEDS_REVIEW'
        else 'EXTRACTED' end::public.receipt_document_status,
      failure_reason = case when v_count = 0
        then 'la extracción no encontró ninguna línea legible en este archivo' end,
      extraction_version = p_processor_version,
      ai_processor_version = p_processor_version,
      extraction_pass = v_pass
    where id = p_receipt;
  exception when unique_violation then
    v_folio_choco := true;
    select otra.id into v_hermana
    from public.purchase_receipts otra
    where otra.household_id = v_d.household_id
      and otra.id <> p_receipt
      and (otra.processing_status <> 'ARCHIVED' or otra.purchase_id is not null)
      and otra.merchant_key = v_key_ef
      and otra.receipt_date = v_fecha_ef
      and otra.receipt_number = v_folio_ef
    order by otra.uploaded_at asc
    limit 1;
    -- El folio NO se escribe en esta fila: el papel ya tiene dueño. Queda en la
    -- boleta hermana y acá queda dicho por qué, con nombre.
    update public.purchase_receipts set
      receipt_date = v_fecha_ef,
      merchant_name = coalesce(v_comercio, merchant_name),
      merchant_key = v_key_ef,
      declared_total_minor = v_total,
      total_status = case when v_total is null then 'UNKNOWN' else 'KNOWN' end::public.money_status,
      total_unknown_reason = case when v_total is null then 'NO_PRICE_RECORDED' end::public.money_unknown_reason,
      total_source = v_total_source,
      processing_status = case
        when v_count = 0 then 'FAILED' else 'NEEDS_REVIEW' end::public.receipt_document_status,
      failure_reason = case when v_count = 0
        then 'la extracción no encontró ninguna línea legible en este archivo'
        else 'otra boleta del hogar ya tiene este folio, este comercio y esta fecha: '
             || 'es el mismo papel fotografiado dos veces, o son dos compras distintas y hay que decirlo' end,
      duplicate_of = coalesce(v_hermana, duplicate_of),
      extraction_version = p_processor_version,
      ai_processor_version = p_processor_version,
      extraction_pass = v_pass
    where id = p_receipt;
    v_dudosos := v_dudosos + 1;
  end;

  -- [H35 capa 3] La hermana: mismo comercio, misma fecha, mismo total y sin
  -- folio con el cual distinguirlas. Ni auto-rechazo ni auto-aceptación.
  if not v_folio_choco
     and v_folio is null and v_fecha is not null and v_total is not null and v_comercio is not null then
    select otra.id into v_hermana
    from public.purchase_receipts otra
    where otra.household_id = v_d.household_id
      and otra.id <> p_receipt
      and (otra.processing_status <> 'ARCHIVED' or otra.purchase_id is not null)
      and otra.merchant_key = app.merchant_key(v_comercio)
      and otra.receipt_date = v_fecha
      and otra.declared_total_minor = v_total
    order by otra.uploaded_at asc
    limit 1;
    if v_hermana is not null then
      update public.purchase_receipts
      set duplicate_of = v_hermana,
          processing_status = 'NEEDS_REVIEW'
      where id = p_receipt;
      v_dudosos := v_dudosos + 1;
    end if;
  end if;

  -- [H68] Solo ids y conteos en la traza: ningún monto sale por acá.
  perform app.emit_event(v_d.household_id, 'RECEIPT_EXTRACTION_READY', 'purchase_receipt',
    jsonb_build_object('receipt_id', p_receipt, 'candidates', v_count,
                       'doubtful', v_dudosos, 'pass', v_pass),
    'RECEIPT_EXTRACTION_READY:' || p_receipt::text || ':' || v_pass::text);

  return jsonb_build_object('candidates', v_count, 'doubtful', v_dudosos,
                            'pass', v_pass, 'migrated', v_migradas,
                            'duplicateOf', v_hermana);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- app.receipt_confirm_blocks — UNA sola definición de «esto no se puede confirmar»
-- ---------------------------------------------------------------------------

/**
 * [H50] Los bloqueos, enumerados. La pantalla lee esta misma función antes de
 * habilitar el botón y `confirm_receipt_extraction` falla si devuelve filas: así
 * no hay dos ideas distintas de qué se puede confirmar, que era el defecto (el
 * único bloqueo explícito del diseño era OUT_OF_TOLERANCE y `NEEDS_REVIEW`
 * quedaba de decoración).
 *
 * Recibe el payload que se está por mandar —decisiones y total tecleado— para
 * poder juzgar también lo que no está en la base todavía. Con `p_decisions` NULL
 * informa solo los bloqueos de ESTADO, que es lo que la pantalla quiere al abrir.
 */
create or replace function app.receipt_confirm_blocks(
  p_receipt   uuid,
  p_decisions jsonb default null,
  p_confirmed_total_minor bigint default null,
  p_charges   jsonb default '[]'::jsonb,
  -- POR CUAL PUERTA se esta entrando. Las dos --crear una compra nueva y
  -- adjuntarse a una que ya existe-- tienen los MISMOS bloqueos: una linea
  -- dudosa sin abrir, el total sin teclear, el posible duplicado, la aritmetica
  -- que no cuadra. `attach_receipt_to_purchase` los tenia escritos aparte y a
  -- medias, que es exactamente el defecto [H50] con otro nombre.
  p_door      public.receipt_intent default 'NEW_PURCHASE'
) returns setof text language plpgsql stable security definer set search_path = public as $fn$
declare
  v_d public.purchase_receipts;
  v_c public.receipt_extraction_candidates;
  v_dec jsonb;
  v_cargo jsonb;
  v_pendientes int;
  v_cubiertos int := 0;
  -- [H36] Los ids YA VISTOS. El "todo o nada" compara CONJUNTOS: contar
  -- decisiones deja pasar el mismo candidate_id repetido llenando el cupo de
  -- las lineas que nadie decidio, y esas lineas se pierden para siempre porque
  -- el documento queda CONFIRMED con su compra.
  v_vistos uuid[] := '{}';
  v_confirmadas int := 0;
  v_suma bigint := 0;
  v_hay_desconocido boolean := false;
  v_tol bigint;
  v_u public.currency_units;
  v_total bigint;
  v_delta bigint;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt;
  if v_d.id is null then
    return next 'BOLETA_INEXISTENTE: esta boleta no existe o no la puedes ver';
    return;
  end if;

  if v_d.processing_status in ('CONFIRMED', 'ARCHIVED') then
    return next 'DOCUMENTO_CERRADO: esta boleta ya fue confirmada o archivada; sus líneas son historia';
  end if;
  if v_d.purchase_id is not null then
    return next format('YA_GENERO_COMPRA: esta boleta ya generó la compra %s', v_d.purchase_id);
  end if;
  if v_d.intent <> coalesce(p_door, 'NEW_PURCHASE') then
    return next case when coalesce(p_door, 'NEW_PURCHASE') = 'NEW_PURCHASE'
      then 'DESTINO_EQUIVOCADO: esta boleta está marcada para adjuntarse a una compra que ya existe, no para crear una nueva'
      else 'DESTINO_EQUIVOCADO: esta boleta está marcada para crear una compra nueva, no para ponerle precio a lo que ya está guardado'
    end;
  end if;
  if v_d.duplicate_of is not null and v_d.duplicate_ack_at is null then
    return next format(
      'POSIBLE_DUPLICADO: hay otra boleta del mismo comercio, la misma fecha y el mismo total (%s). Si son dos compras distintas, decláralo antes de confirmar',
      v_d.duplicate_of);
  end if;

  select count(*)::int into v_pendientes
  from public.receipt_extraction_candidates
  where receipt_id = p_receipt and extraction_pass = v_d.extraction_pass and status = 'PENDING';

  if v_d.extraction_pass = 0 then
    return next 'SIN_EXTRACCION: esta boleta todavía no tiene líneas leídas';
    return;
  end if;

  if p_decisions is null then
    if v_pendientes > 0 then
      return next format('LINEAS_PENDIENTES: quedan %s líneas por decidir', v_pendientes);
    end if;
    return;
  end if;

  select * into v_u from public.currency_units where code = v_d.currency;
  v_total := p_confirmed_total_minor;

  for v_dec in select * from jsonb_array_elements(coalesce(p_decisions, '[]'::jsonb)) loop
    -- [H43] La pasada VIGENTE y ninguna otra. Un candidato de una lectura vieja
    -- --que el propio codigo llama historia-- armaba la compra con la lectura
    -- superada y dejaba la linea vigente colgada para siempre, porque el
    -- documento ya habia quedado CONFIRMED con su purchase_id.
    select * into v_c from public.receipt_extraction_candidates
    where id = nullif(v_dec ->> 'candidate_id', '')::uuid
      and receipt_id = p_receipt
      and extraction_pass = v_d.extraction_pass;
    if v_c.id is null then
      if exists (
        select 1 from public.receipt_extraction_candidates vieja
        where vieja.id = nullif(v_dec ->> 'candidate_id', '')::uuid
          and vieja.receipt_id = p_receipt
      ) then
        return next format(
          'LINEA_DE_OTRA_LECTURA: la línea %s es de una lectura anterior de esta boleta; la vigente es la lectura %s',
          coalesce(v_dec ->> 'candidate_id', '(sin id)'), v_d.extraction_pass);
      else
        -- [H46] Un candidato de OTRA boleta —potencialmente de otro hogar— dentro
        -- de una transacción legítimamente autorizada es fuga de aislamiento.
        return next format('CANDIDATO_AJENO: la línea %s no pertenece a esta boleta',
                           coalesce(v_dec ->> 'candidate_id', '(sin id)'));
      end if;
      continue;
    end if;
    -- [H36] Ids únicos: la misma línea dos veces NO cubre dos pendientes.
    if v_c.id = any(v_vistos) then
      return next format(
        'LINEA_REPETIDA:%s: «%s» viene dos veces en la misma confirmación; una decisión por línea',
        v_c.line_ordinal, left(v_c.raw_line_text, 60));
      continue;
    end if;
    v_vistos := v_vistos || v_c.id;
    if v_c.status <> 'PENDING' then continue; end if;
    v_cubiertos := v_cubiertos + 1;

    if coalesce(v_dec ->> 'action', '') = 'DISCARD' then continue; end if;

    -- [H45] Una línea dudosa NO participa del confirmar-todo. Y [H41]: si nadie
    -- tecleó el total, TODAS las líneas quedan dudosas — una por una o nada.
    if (cardinality(app.receipt_candidate_doubts(v_c.id)) > 0 or v_total is null)
       and coalesce((v_dec ->> 'acknowledged')::boolean, false) is not true then
      return next format(
        'LINEA_SIN_MIRAR:%s: «%s» necesita que la abras y la revises antes de confirmarla',
        v_c.line_ordinal, left(v_c.raw_line_text, 60));
    end if;

    -- El valor con que va a entrar: el editado si viene, el del candidato si no.
    -- `?` distingue AUSENTE de null EXPLÍCITO, que es exactamente lo que hace
    -- falta para que «este precio es desconocido» no colapse a cero.
    if coalesce(v_dec ->> 'action', '') = 'EDIT' and v_dec ? 'line_total_minor' then
      if (v_dec ->> 'line_total_minor') is null then
        v_hay_desconocido := true;
      else
        v_suma := v_suma + (v_dec ->> 'line_total_minor')::bigint;
      end if;
    elsif v_c.line_total_minor is null then
      v_hay_desconocido := true;
    else
      v_suma := v_suma + v_c.line_total_minor;
    end if;

    -- El descuento de línea también entra al cuadre: `reconcile_purchase` (0043)
    -- cuadra contra `line_subtotal + line_discount`, así que si acá se omitiera,
    -- toda boleta con promo daría un DESCUADRE falso en la pantalla y un cuadre
    -- distinto en la base. Un descuento EDITADO a null explícito es DESCONOCIDO.
    if coalesce(v_dec ->> 'action', '') = 'EDIT' and v_dec ? 'discount_minor' then
      if (v_dec ->> 'discount_minor') is null then
        v_hay_desconocido := true;
      else
        v_suma := v_suma + (v_dec ->> 'discount_minor')::bigint;
      end if;
    elsif v_c.discount_minor is not null then
      v_suma := v_suma + v_c.discount_minor;
    end if;
    v_confirmadas := v_confirmadas + 1;
  end loop;

  -- Los cargos de la boleta (despacho, bolsa, cupón de orden) también son parte
  -- del total impreso. Un cargo sin monto es DESCONOCIDO y apaga el cuadre.
  for v_cargo in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    if nullif(v_cargo ->> 'amount_minor', '') is null then
      v_hay_desconocido := true;
    else
      v_suma := v_suma + (v_cargo ->> 'amount_minor')::bigint;
    end if;
  end loop;

  -- [H36] TODO O NADA: si el payload no cubre todos los pendientes, una segunda
  -- llamada crearía una SEGUNDA compra y repartiría el despacho dos veces.
  --
  -- `v_cubiertos` cuenta candidatos PENDING DISTINTOS de la pasada VIGENTE, así
  -- que esta comparación es de conjuntos: contenido en los pendientes y del
  -- mismo tamaño significa iguales. Con el conteo pelado, repetir un id o
  -- mandar uno de una lectura vieja llenaba el cupo sin cubrir a nadie.
  if v_cubiertos < v_pendientes then
    return next format(
      'FALTAN_DECISIONES: quedan %s líneas sin decidir. Confírmalas, edítalas o descártalas: una boleta se confirma entera',
      v_pendientes - v_cubiertos);
  end if;

  -- El descuadre contra el total que la persona tecleó. Un desconocido BLOQUEA
  -- el cuadre en vez de absorberse como redondeo: sum() ignorando NULL es
  -- exactamente cómo un valor desconocido se convierte en $0.
  if v_total is not null and v_confirmadas > 0 then
    if v_hay_desconocido then
      return next 'LINEA_SIN_VALOR: hay líneas sin total; no se puede cuadrar la boleta contra su total impreso mientras falte una';
    else
      v_delta := v_total - v_suma;
      v_tol := app.reconciliation_tolerance_minor(
        v_u.reconciliation_tolerance_minor, v_u.reconciliation_tolerance_per_line_minor,
        v_u.tolerance_pct, v_confirmadas, v_total);
      if abs(v_delta) > v_tol then
        return next format(
          'DESCUADRE: la suma de las líneas difiere del total en %s. Agrega la línea o el cargo que falta, o corrige el número mal leído. No se inventa una línea de ajuste',
          v_delta);
      end if;
    end if;
  end if;

  return;
end;
$fn$;

/**
 * La MISMA lista de bloqueos, expuesta para la pantalla.
 *
 * `app.receipt_confirm_blocks` vive en el esquema `app`, que PostgREST no
 * publica. Sin esta puerta la pantalla tendría que reimplementar la lista —y el
 * defecto que [H50] describe es precisamente que existan dos definiciones de
 * «esto no se puede confirmar». Devuelve un arreglo jsonb: vacío = se puede.
 */
create or replace function public.receipt_confirm_blocks(
  p_receipt   uuid,
  p_decisions jsonb default null,
  p_confirmed_total_minor bigint default null,
  p_charges   jsonb default '[]'::jsonb,
  p_door      public.receipt_intent default 'NEW_PURCHASE'
) returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_hogar uuid; v_out jsonb;
begin
  select household_id into v_hogar from public.purchase_receipts where id = p_receipt;
  if v_hogar is null or not app.finance_access(v_hogar, 'FINANCE_VIEW') then
    raise exception 'no autorizado';
  end if;
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_out
  from app.receipt_confirm_blocks(p_receipt, p_decisions, p_confirmed_total_minor,
                                  p_charges, p_door) b;
  return v_out;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- app.emit_purchase_price_observations — el llamador acá, el cuerpo en la 0046
-- ---------------------------------------------------------------------------

/**
 * Confirmar una boleta DEJA la historia de precios de esa compra.
 *
 * El contrato lo pide literal (una observación `source='RECEIPT'` por cada
 * línea confirmada con precio) y hasta acá no existía ni el productor ni el
 * llamador: el enum `price_source` declaraba 'RECEIPT', la dedup traía su
 * comentario «reprocesar la misma boleta no duplica», y nadie llamaba a nadie.
 * La historia de precios del hogar se alimentaba sólo a mano.
 *
 * `public.price_observations` vive en la 0046, que se aplica DESPUÉS de esta.
 * Así que acá queda el llamador con un cuerpo que se niega a seguir y la 0046 lo
 * reemplaza con el de verdad. Si alguien aplicara la 0045 sin la 0046, confirmar
 * una boleta FALLA diciendo por qué, en vez de crear la compra y dejar la
 * historia de precios vacía en silencio — un cuerpo vacío acá sería «el
 * productor no existe» otra vez, con mejor cara.
 *
 * `p_source` viaja como TEXTO porque `public.price_source` todavía no existe en
 * esta migración; la 0046 lo castea. La FIRMA no cambia: si cambiara, el
 * `create or replace` de la 0046 crearía una sobrecarga y este llamador seguiría
 * apuntando al cuerpo que no hace nada.
 */
create or replace function app.emit_purchase_price_observations(
  p_purchase uuid,
  p_source   text,
  p_actor    uuid
) returns int language plpgsql as $fn$
begin
  raise exception
    'falta la migración 0046 (precios): confirmar una boleta tiene que dejar su historia de precios y esta base todavía no puede'
    using errcode = 'check_violation';
end;
$fn$;

-- ---------------------------------------------------------------------------
-- confirm_receipt_extraction — el corazón, calcado de confirm_lab_extraction:525
-- ---------------------------------------------------------------------------

/**
 * La revisión humana, cerrada.
 *
 * Del clínico se copian: el `for update` del documento al entrar (serializa dos
 * confirmaciones simultáneas), la iteración por decisión con `for update` de
 * cada candidato, el `if status <> 'PENDING' then continue` que hace del
 * reintento un no-op, la distinción `?` entre campo AUSENTE y `null` EXPLÍCITO
 * —lo que permite que «este precio es desconocido» no colapse a cero— y los
 * mensajes humanos en vez de un NOT NULL crudo.
 *
 * Lo que NO se copia, porque en boletas es incorrecto:
 *
 *   [H36] la confirmación PARCIAL. Cada observación de laboratorio es
 *   independiente; una línea de boleta no lo es: el despacho se prorratea entre
 *   las líneas presentes, así que confirmar la mitad hoy y la mitad mañana
 *   reparte el mismo despacho dos veces y deja `final_value_minor` inflado para
 *   siempre. Acá es TODO O NADA y hay `unique` en `purchase_receipts.purchase_id`.
 *
 *   [H42] el total leído por máquina como ancla. `p_confirmed_total_minor` es lo
 *   que la persona TECLEÓ mirando el papel. Si se niega a teclearlo, la boleta
 *   queda con el total desconocido y ninguna línea se puede confirmar en bloque.
 *
 * NO reimplementa el ledger ni el reparto: arma el payload y llama a
 * `public.record_purchase` (0043), que es la misma puerta de la compra manual y
 * del pedido a proveedor, y que recibe con `app.receive_lot_from_purchase`.
 *
 * Permiso: FINANCE_CONFIRM_RECEIPTS.
 */
create or replace function public.confirm_receipt_extraction(
  p_receipt   uuid,
  p_decisions jsonb,
  p_confirmed_total_minor bigint default null,
  p_charges   jsonb default '[]'::jsonb,
  p_purchased_on date default null,
  p_location_id uuid default null,
  p_channel   public.purchase_channel default 'SUPERMARKET'
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_d public.purchase_receipts;
  v_c public.receipt_extraction_candidates;
  v_dec jsonb;
  v_cargo jsonb;
  v_bloqueos text[];
  v_actor uuid;
  v_lineas jsonb := '[]'::jsonb;
  v_cargos jsonb := '[]'::jsonb;
  v_linea jsonb;
  v_confirmadas int := 0;
  v_descartadas int := 0;
  v_editadas int := 0;
  v_purchase uuid;
  v_fecha date;
  v_fuente public.purchase_date_source;
  v_lotes int;
  v_gastos int;
  v_precios int;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  v_actor := app.current_member_id(v_d.household_id);

  -- [H50] UNA sola definición de «esto no se puede confirmar», la misma que lee
  -- la pantalla. Si el servidor y la pantalla tuvieran dos listas, la pantalla
  -- habilitaría el botón para algo que el servidor rechaza — o peor, al revés.
  select array_agg(b) into v_bloqueos
  from app.receipt_confirm_blocks(p_receipt, p_decisions, p_confirmed_total_minor, p_charges) b;
  if v_bloqueos is not null and cardinality(v_bloqueos) > 0 then
    raise exception 'esta boleta todavía no se puede confirmar: %', array_to_string(v_bloqueos, ' · ')
      using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------------------------
  -- Las decisiones, en el orden de la boleta: el orden es parte del reparto.
  -- ------------------------------------------------------------------
  for v_dec in
    select d from jsonb_array_elements(coalesce(p_decisions, '[]'::jsonb)) d
    order by (
      select c.line_ordinal from public.receipt_extraction_candidates c
      where c.id = nullif(d ->> 'candidate_id', '')::uuid
    ) asc
  loop
    -- [H46] El filtro por `receipt_id` va en el mismo `select ... for update`, y
    -- si no calza es un `raise`, no un `continue` silencioso: un candidato de
    -- otra boleta —potencialmente de otro hogar, porque este RPC es security
    -- definer y el permiso se validó sobre p_receipt— sería fuga de aislamiento
    -- y otra vía de duplicación.
    select * into v_c from public.receipt_extraction_candidates
    where id = nullif(v_dec ->> 'candidate_id', '')::uuid and receipt_id = p_receipt
      and extraction_pass = v_d.extraction_pass
    for update;
    if v_c.id is null then
      raise exception
        'esa línea no pertenece a esta boleta o es de una lectura anterior: la vigente es la lectura %',
        v_d.extraction_pass using errcode = 'check_violation';
    end if;
    if v_c.status <> 'PENDING' then continue; end if;   -- reintento = no-op

    if coalesce(v_dec ->> 'action', '') = 'DISCARD' then
      update public.receipt_extraction_candidates
      set status = 'DISCARDED', decided_at = now(), decided_by = v_actor
      where id = v_c.id;
      v_descartadas := v_descartadas + 1;
      continue;
    end if;

    -- CONFIRM usa los valores del candidato; EDIT los del payload, y `?`
    -- distingue campo AUSENTE de `null` EXPLÍCITO.
    v_linea := jsonb_build_object(
      'raw_label', v_c.raw_line_text,
      'raw_quantity_text', v_c.original_snippet,
      'ingredient_id', case when v_dec ? 'matched_ingredient_id'
                           then nullif(v_dec ->> 'matched_ingredient_id', '')
                           else v_c.matched_ingredient_id::text end,
      'product_id', case when v_dec ? 'matched_product_id'
                        then nullif(v_dec ->> 'matched_product_id', '')
                        else v_c.matched_product_id::text end,
      -- Una línea que el humano tocó ya no es un match de máquina: es MANUAL.
      'match_method', case when coalesce(v_dec ->> 'action', '') = 'EDIT'
                          then 'MANUAL' else v_c.match_method::text end,
      'match_score', case when coalesce(v_dec ->> 'action', '') = 'EDIT'
                         then null else v_c.match_score end,
      'quantity', case when v_dec ? 'quantity' then nullif(v_dec ->> 'quantity', '')
                      else v_c.quantity::text end,
      'unit', case when v_dec ? 'unit' then nullif(v_dec ->> 'unit', '') else v_c.unit end,
      'weight_basis', coalesce(nullif(v_dec ->> 'weight_basis', ''), 'RAW'),
      'unit_price_minor', case when v_dec ? 'unit_price_minor'
                              then nullif(v_dec ->> 'unit_price_minor', '')
                              else v_c.unit_price_minor::text end,
      'unit_price_basis', case when v_dec ? 'unit_price_basis'
                              then nullif(v_dec ->> 'unit_price_basis', '')
                              else v_c.unit_price_basis::text end,
      'line_subtotal_minor', case when v_dec ? 'line_total_minor'
                                 then nullif(v_dec ->> 'line_total_minor', '')
                                 else v_c.line_total_minor::text end);

    -- El descuento de línea solo viaja si EXISTE. Que la clave no venga significa
    -- «no hubo descuento» (0 conocido); que venga en `null` significa «había uno
    -- y no sé cuánto» y entra como DESCONOCIDO con su motivo. Esa distinción es
    -- justo la que el diseño pedía preservar.
    if v_dec ? 'discount_minor' then
      v_linea := v_linea || jsonb_build_object('line_discount_minor', v_dec -> 'discount_minor');
    elsif v_c.discount_minor is not null then
      v_linea := v_linea || jsonb_build_object('line_discount_minor', v_c.discount_minor);
    end if;

    -- Mensaje humano, no un NOT NULL crudo de Postgres.
    if (v_linea ->> 'line_subtotal_minor') is null then
      raise exception 'la línea «%» no tiene total: edítala o descártala', left(v_c.raw_line_text, 60)
        using errcode = 'check_violation';
    end if;
    if (v_linea ->> 'ingredient_id') is null and (v_linea ->> 'product_id') is null then
      raise exception 'la línea «%» no dice qué alimento es: elígelo o descártala', left(v_c.raw_line_text, 60)
        using errcode = 'check_violation';
    end if;

    v_lineas := v_lineas || jsonb_build_array(v_linea);
    update public.receipt_extraction_candidates
    set status = case when coalesce(v_dec ->> 'action', '') = 'EDIT' then 'EDITED' else 'CONFIRMED' end
                 ::public.extraction_candidate_status,
        decided_at = now(), decided_by = v_actor
    where id = v_c.id;
    v_confirmadas := v_confirmadas + 1;
    if coalesce(v_dec ->> 'action', '') = 'EDIT' then v_editadas := v_editadas + 1; end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Todo descartado: no hay compra que crear, y no puede haber ni un movimiento.
  -- ------------------------------------------------------------------
  if jsonb_array_length(v_lineas) = 0 then
    update public.purchase_receipts set
      processing_status = 'FAILED',
      failure_reason = 'todas las líneas fueron descartadas: esta boleta no generó ninguna compra'
    where id = p_receipt;
    insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (v_d.household_id, auth.uid(), 'RECEIPT_ALL_DISCARDED', 'purchase_receipt', p_receipt,
            jsonb_build_object('discarded', v_descartadas));
    return jsonb_build_object('confirmed', 0, 'discarded', v_descartadas,
                              'edited', 0, 'purchaseId', null, 'lots', 0);
  end if;

  -- ------------------------------------------------------------------
  -- Los cargos de la boleta: entidades visibles, jamás una resta escondida.
  -- ------------------------------------------------------------------
  for v_cargo in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    if coalesce(v_cargo ->> 'policy', '') = 'DIRECT_LINE' then
      raise exception
        'un cargo dirigido a una línea se registra como descuento de esa línea, no como cargo de la boleta'
        using errcode = 'check_violation';
    end if;
    v_cargos := v_cargos || jsonb_build_array(jsonb_build_object(
      'kind', v_cargo ->> 'kind',
      'label', v_cargo ->> 'label',
      'amount_minor', v_cargo ->> 'amount_minor',
      'policy', v_cargo ->> 'policy'));
  end loop;

  -- ------------------------------------------------------------------
  -- [H48] La fecha de la compra es la IMPRESA. La de subida es el último recurso
  -- y queda declarada como tal para que la antigüedad de un precio se pueda
  -- auditar en vez de creer.
  -- ------------------------------------------------------------------
  if v_d.receipt_date is not null then
    v_fecha := v_d.receipt_date;
    v_fuente := 'PRINTED';
  elsif p_purchased_on is not null then
    v_fecha := p_purchased_on;
    v_fuente := 'HUMAN';
  else
    v_fecha := app.household_today(v_d.household_id);
    v_fuente := 'UPLOAD_DATE';
  end if;

  -- El ledger, el reparto, la conciliación y la recepción: la MISMA puerta que
  -- usa la compra manual. Acá no se reimplementa nada de eso.
  v_purchase := public.record_purchase(
    v_d.household_id, coalesce(p_channel, 'SUPERMARKET'),
    coalesce(v_d.merchant_name, 'Comercio sin nombre'), null,
    v_fecha,
    p_confirmed_total_minor,
    case when p_confirmed_total_minor is null then 'UNKNOWN' else 'PRINTED' end::public.receipt_total_source,
    v_lineas, v_cargos, p_location_id,
    'RECEIPT:' || p_receipt::text, 'RECEIPT_IMPORT');

  -- Los cargos EXPENSE_ONLY (despacho, bolsa, propina) NO capitalizan: salieron
  -- del bolsillo y no entraron a la despensa. 0044 les da su propia asignación.
  v_gastos := app.allocate_purchase_expense(v_purchase);

  update public.purchases set
    purchased_on_source = v_fuente,
    total_confirmed_by = case when p_confirmed_total_minor is not null then v_actor end,
    total_confirmed_at = case when p_confirmed_total_minor is not null then now() end
  where id = v_purchase;

  -- La historia de precios del hogar. Va DESPUÉS del update de arriba porque la
  -- fecha de la observación y su procedencia salen de `purchased_on_source`: una
  -- boleta del 3 subida el 25 no es un precio del 25.
  v_precios := app.emit_purchase_price_observations(v_purchase, 'RECEIPT', v_actor);

  update public.purchase_receipts set
    purchase_id = v_purchase,
    processing_status = 'CONFIRMED',
    confirmed_at = now(),
    confirmed_by = v_actor
  where id = p_receipt;

  select count(*)::int into v_lotes
  from public.purchase_item_lots pil
  join public.purchase_items i on i.id = pil.purchase_item_id
  where i.purchase_id = v_purchase;

  -- [H68] En `audit_events` van ids y conteos, como manda el contrato de esa
  -- tabla (0001_family.sql:97). Los MONTOS van a finance_audit_log, que se ve
  -- con FINANCE_VIEW: quien puede ver la plata tiene que poder auditarla.
  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_d.household_id, auth.uid(), 'RECEIPT_EXTRACTION_CONFIRMED', 'purchase_receipt', p_receipt,
          jsonb_build_object('confirmed', v_confirmadas, 'edited', v_editadas,
                             'discarded', v_descartadas, 'lots_created', v_lotes,
                             'purchase_id', v_purchase));

  perform app.finance_audit(
    v_d.household_id, 'RECEIPT_CONFIRMED', 'purchase_receipt', p_receipt,
    v_d.currency, p_confirmed_total_minor,
    jsonb_build_object('purchase_id', v_purchase, 'lines', v_confirmadas,
                       'discarded', v_descartadas, 'lots', v_lotes,
                       'expense_allocations', v_gastos,
                       'price_observations', v_precios,
                       'extracted_total_minor', v_d.declared_total_minor,
                       'total_source', v_d.total_source::text,
                       'purchased_on_source', v_fuente::text));

  perform app.emit_event(v_d.household_id, 'RECEIPT_CONFIRMED', 'purchase_receipt',
    jsonb_build_object('receipt_id', p_receipt, 'purchase_id', v_purchase,
                       'lines', v_confirmadas, 'lots', v_lotes),
    'RECEIPT_CONFIRMED:' || p_receipt::text);

  return jsonb_build_object(
    'confirmed', v_confirmadas, 'edited', v_editadas, 'discarded', v_descartadas,
    'purchaseId', v_purchase, 'lots', v_lotes, 'expenseAllocations', v_gastos,
    'priceObservations', v_precios);
end;
$fn$;

comment on function public.confirm_receipt_extraction is
  'TODO O NADA: el payload cubre exactamente los candidatos PENDING o falla. '
  'Una boleta genera UNA compra en toda su vida (unique en purchase_receipts.purchase_id).';

-- ---------------------------------------------------------------------------
-- attach_receipt_to_purchase — la boleta que llega DESPUÉS de la mercadería
-- ---------------------------------------------------------------------------

/**
 * El caso más común de la vida real: recibiste el sábado por
 * `receive_shopping_list` (que deja los lotes con valor DESCONOCIDO a propósito,
 * porque una lista solo tiene estimaciones) y el domingo subes la foto.
 *
 * Acá NO se crea ningún lote, NO se inserta ningún movimiento y NO se toca
 * ninguna cantidad: solo se deposita el valor que faltaba, por la puerta de
 * `app.value_lot_from_purchase_item` (0043), que ya se niega a revalorizar un
 * lote que tenía valor y a valorizar un padre ya partido.
 *
 * [H37] Exige `intent = 'ATTACH_TO_EXISTING'`. Ese enum es lo que impide que la
 * misma boleta recorra los dos caminos y meta la mercadería dos veces.
 *
 * [H50] Y pasa por la MISMA `app.receipt_confirm_blocks` que la confirmación,
 * con la puerta declarada. Tenía su propia lista a medias —miraba el destino, el
 * duplicado y las asignaciones del lote, pero NO las líneas dudosas, NO exigía
 * `acknowledged` y NO pedía el total tecleado—, así que en «el caso más común de
 * la vida real» un dígito que el propio servidor había marcado como dudoso se
 * capitalizaba solo. Dos listas de «esto no se puede confirmar» es el defecto
 * [H50]; que la segunda sea más floja es el defecto y su consecuencia.
 *
 * Y NO da por confirmado lo que nadie enlazó: sólo pasan a CONFIRMED los
 * candidatos que vinieron en `p_links`, y a DISCARDED los que vinieron con
 * `action = 'DISCARD'`. El resto lo ataja el TODO O NADA de la lista.
 *
 * LÍMITE DECLARADO: si el lote YA tuvo salidas costeadas como desconocidas, esto
 * se niega. Traspasar hoy la plata de lo que ya se consumió a lo que queda es el
 * bug de reconocimiento tardío, y arreglarlo es generar asignaciones de
 * corrección con `late_recognition` — trabajo del motor de asignación (0044), no
 * de la frontera de extracción. Mejor un «no puedo» honesto que un número torcido.
 */
create or replace function public.attach_receipt_to_purchase(
  p_receipt uuid,
  p_links   jsonb,
  p_confirmed_total_minor bigint default null,
  p_channel public.purchase_channel default 'SUPERMARKET'
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_d public.purchase_receipts;
  v_link jsonb;
  v_c public.receipt_extraction_candidates;
  v_lot public.inventory_lots;
  v_actor uuid;
  v_purchase uuid;
  v_item uuid;
  v_ordinal int := 0;
  v_descartadas int := 0;
  v_i int;
  v_valor bigint;
  v_items uuid[] := '{}';
  v_lotes_ids uuid[] := '{}';
  v_cantidades numeric[] := '{}';
  -- Los candidatos que EFECTIVAMENTE se enlazaron. Sólo estos pasan a CONFIRMED.
  v_confirmados uuid[] := '{}';
  v_bloqueos text[];
  v_veredicto jsonb;
  v_fecha date;
  v_fuente public.purchase_date_source;
  v_currency char(3);
  v_gastos int;
  v_precios int;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  if jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) = 0 then
    raise exception 'adjuntar una boleta necesita decir qué línea corresponde a qué lote'
      using errcode = 'check_violation';
  end if;

  -- [H50] LA MISMA lista de bloqueos que la confirmación, con la puerta
  -- declarada: destino equivocado, documento cerrado, boleta que ya generó
  -- compra, posible duplicado sin declarar, línea dudosa sin abrir, total sin
  -- teclear, línea repetida, línea de una lectura vieja, líneas sin decidir y
  -- descuadre contra el total. Antes acá había una lista propia, más corta.
  select array_agg(b) into v_bloqueos
  from app.receipt_confirm_blocks(p_receipt, p_links, p_confirmed_total_minor,
                                  '[]'::jsonb, 'ATTACH_TO_EXISTING') b;
  if v_bloqueos is not null and cardinality(v_bloqueos) > 0 then
    raise exception 'esta boleta todavía no se puede adjuntar: %', array_to_string(v_bloqueos, ' · ')
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_d.household_id);
  select h.currency into v_currency from public.households h where h.id = v_d.household_id;

  if v_d.receipt_date is not null then
    v_fecha := v_d.receipt_date; v_fuente := 'PRINTED';
  else
    v_fecha := app.household_today(v_d.household_id); v_fuente := 'UPLOAD_DATE';
  end if;

  insert into public.purchases (
    household_id, channel, source, merchant_name, merchant_key, purchased_on, currency,
    declared_total_minor, total_status, total_unknown_reason, total_source,
    allocation_policy_version, allocation_policy_snapshot,
    purchased_on_source, total_confirmed_by, total_confirmed_at,
    idempotency_key, created_by
  ) values (
    v_d.household_id, coalesce(p_channel, 'SUPERMARKET'), 'LIST_RECEIPT',
    coalesce(v_d.merchant_name, 'Comercio sin nombre'),
    app.merchant_key(v_d.merchant_name), v_fecha, v_currency,
    p_confirmed_total_minor,
    case when p_confirmed_total_minor is null then 'UNKNOWN' else 'KNOWN' end::public.money_status,
    case when p_confirmed_total_minor is null then 'NO_PRICE_RECORDED' end::public.money_unknown_reason,
    case when p_confirmed_total_minor is null then 'UNKNOWN' else 'PRINTED' end::public.receipt_total_source,
    app.cost_allocation_engine_version(), app.allocation_policy_snapshot(v_currency),
    v_fuente,
    case when p_confirmed_total_minor is not null then v_actor end,
    case when p_confirmed_total_minor is not null then now() end,
    'RECEIPT-ATTACH:' || p_receipt::text, v_actor
  ) returning id into v_purchase;

  for v_link in
    select l from jsonb_array_elements(p_links) l
    order by (
      select c.line_ordinal from public.receipt_extraction_candidates c
      where c.id = nullif(l ->> 'candidate_id', '')::uuid
    ) asc
  loop
    select * into v_c from public.receipt_extraction_candidates
    where id = nullif(v_link ->> 'candidate_id', '')::uuid and receipt_id = p_receipt
      and extraction_pass = v_d.extraction_pass
    for update;
    if v_c.id is null then
      raise exception
        'esa línea no pertenece a esta boleta o es de una lectura anterior: la vigente es la lectura %',
        v_d.extraction_pass using errcode = 'check_violation';
    end if;
    if v_c.status <> 'PENDING' then continue; end if;   -- reintento = no-op

    -- Una línea de la boleta puede no corresponder a nada guardado (te llevaste
    -- algo que no estaba en la lista). Se DESCARTA explícitamente: es la única
    -- forma de que el todo-o-nada se pueda cumplir sin inventar un lote.
    if coalesce(v_link ->> 'action', '') = 'DISCARD' then
      update public.receipt_extraction_candidates
      set status = 'DISCARDED', decided_at = now(), decided_by = v_actor
      where id = v_c.id;
      v_descartadas := v_descartadas + 1;
      continue;
    end if;

    if v_c.line_total_minor is null then
      raise exception 'la línea «%» no tiene total: sin monto no hay valor que adjuntar',
        left(v_c.raw_line_text, 60) using errcode = 'check_violation';
    end if;

    select * into v_lot from public.inventory_lots
    where id = nullif(v_link ->> 'lot_id', '')::uuid for update;
    if v_lot.id is null or v_lot.household_id <> v_d.household_id then
      raise exception 'ese lote no es de este hogar' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.cost_allocations a where a.lot_id = v_lot.id) then
      raise exception
        'el lote «%» ya tuvo salidas costeadas sin precio: ponerle valor ahora traspasaría la plata de lo ya consumido a lo que queda. Primero hay que corregir esas salidas.',
        v_lot.label using errcode = 'check_violation';
    end if;

    v_ordinal := v_ordinal + 1;
    insert into public.purchase_items (
      purchase_id, household_id, line_ordinal, raw_label,
      ingredient_id, product_id, match_method, match_score,
      quantity_canonical, unit, weight_basis,
      unit_price_minor, unit_price_basis, line_subtotal_minor,
      line_discount_minor, line_discount_status, line_discount_unknown_reason
    ) values (
      v_purchase, v_d.household_id, v_ordinal, v_c.raw_line_text,
      coalesce(v_c.matched_ingredient_id, v_lot.ingredient_id),
      coalesce(v_c.matched_product_id, v_lot.product_id),
      v_c.match_method, v_c.match_score,
      -- La cantidad la manda EL LOTE: adjuntar una boleta jamás toca cantidades
      -- (para eso está adjust_lot). Acá solo llega el valor que faltaba.
      v_lot.quantity, v_lot.unit, v_lot.weight_basis,
      v_c.unit_price_minor, v_c.unit_price_basis, v_c.line_total_minor,
      -- `discount_minor` NULL en un candidato significa «la boleta no imprimió
      -- descuento en esta línea», no «no se sabe»: un descuento visible que el
      -- OCR no logró leer deja la línea dudosa por confianza de campo.
      case when v_c.discount_minor is null then 0 else v_c.discount_minor end, 'KNOWN', null
    ) returning id into v_item;

    -- El emparejamiento línea↔lote se lleva en arrays paralelos y NO se
    -- reconstruye después buscando por `raw_label`: dos líneas con el mismo
    -- texto (el mismo producto dos veces en la misma boleta) harían que la
    -- segunda valorizara el lote de la primera.
    v_items := v_items || v_item;
    v_lotes_ids := v_lotes_ids || v_lot.id;
    v_cantidades := v_cantidades || v_lot.quantity;
    v_confirmados := v_confirmados || v_c.id;
  end loop;

  if v_ordinal = 0 then
    raise exception
      'no quedó ninguna línea para adjuntar: si ninguna corresponde a lo guardado, archiva la boleta en vez de crear una compra vacía'
      using errcode = 'check_violation';
  end if;

  -- El reparto de cargos corre UNA vez sobre el conjunto completo, igual que en
  -- la compra manual: es lo que deja `final_value_minor` en cada línea.
  v_veredicto := app.allocate_purchase_charges(v_purchase);
  if (v_veredicto ->> 'ok')::boolean is not true then
    raise exception 'no se pudo repartir los cargos de esta boleta: %', v_veredicto ->> 'code'
      using errcode = 'check_violation';
  end if;
  perform public.reconcile_purchase(v_purchase);

  -- Los cargos EXPENSE_ONLY —incluido el ROUNDING que la conciliación de arriba
  -- fabrica ella misma— NO capitalizan: salieron del bolsillo y no entraron a la
  -- despensa. Sin esta llamada esa plata no está en el valor guardado NI en el
  -- consumo, y la fila «gasto que no queda en la despensa» del panel rinde un
  -- CERO CONOCIDO sobre una compra que sí tuvo despacho. Va después de
  -- `reconcile_purchase` a propósito: antes, el ROUNDING todavía no existe.
  v_gastos := app.allocate_purchase_expense(v_purchase);

  -- Recién ahora, con el valor final de cada línea, se deposita en el lote. Es
  -- la ÚNICA escritura sobre el inventario de todo este RPC, y solo mueve
  -- DESCONOCIDO → conocido.
  for v_i in 1 .. coalesce(array_length(v_items, 1), 0) loop
    select i.final_value_minor into v_valor
    from public.purchase_items i where i.id = v_items[v_i];
    perform app.value_lot_from_purchase_item(
      v_items[v_i], v_lotes_ids[v_i], v_cantidades[v_i], v_valor);
  end loop;

  -- SÓLO lo que vino en `p_links`. El `where status = 'PENDING'` a secas daba
  -- por confirmadas todas las líneas que nadie enlazó ni miró, de cualquier
  -- lectura, y las dejaba imposibles de confirmar después (YA_GENERO_COMPRA).
  update public.receipt_extraction_candidates
  set status = 'CONFIRMED', decided_at = now(), decided_by = v_actor
  where receipt_id = p_receipt and id = any(v_confirmados);

  update public.purchase_receipts set
    purchase_id = v_purchase, processing_status = 'CONFIRMED',
    confirmed_at = now(), confirmed_by = v_actor
  where id = p_receipt;

  -- La misma historia de precios que deja la confirmación: adjuntar una boleta
  -- también es leer un papel con precios impresos.
  v_precios := app.emit_purchase_price_observations(v_purchase, 'RECEIPT', v_actor);

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_d.household_id, auth.uid(), 'RECEIPT_ATTACHED', 'purchase_receipt', p_receipt,
          jsonb_build_object('purchase_id', v_purchase, 'lines', v_ordinal,
                             'discarded', v_descartadas));
  perform app.finance_audit(
    v_d.household_id, 'RECEIPT_ATTACHED', 'purchase_receipt', p_receipt,
    v_currency, p_confirmed_total_minor,
    jsonb_build_object('purchase_id', v_purchase, 'lines', v_ordinal,
                       'discarded', v_descartadas,
                       'expense_allocations', v_gastos,
                       'price_observations', v_precios));

  return jsonb_build_object('purchaseId', v_purchase, 'lines', v_ordinal,
                            'discarded', v_descartadas,
                            'expenseAllocations', v_gastos,
                            'priceObservations', v_precios);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Duplicado declarado, archivo y borrado
-- ---------------------------------------------------------------------------

/**
 * [H35 capa 3] «Son dos compras distintas»: pasa de verdad —dos vueltas al mismo
 * súper el mismo día— y por eso el sistema no auto-rechaza. Lo que sí exige es
 * que alguien lo DIGA, con su razón y con su nombre.
 */
create or replace function public.acknowledge_receipt_duplicate(
  p_receipt uuid,
  p_reason  text
) returns void language plpgsql security definer set search_path = public as $fn$
declare v_d public.purchase_receipts;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  if v_d.duplicate_of is null then
    raise exception 'esta boleta no está marcada como posible duplicado'
      using errcode = 'check_violation';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'declarar que son dos compras distintas necesita su porqué'
      using errcode = 'check_violation';
  end if;
  update public.purchase_receipts
  set duplicate_ack_at = now(),
      duplicate_ack_by = app.current_member_id(v_d.household_id),
      duplicate_ack_reason = p_reason
  where id = p_receipt;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_d.household_id, auth.uid(), 'RECEIPT_DUPLICATE_ACK', 'purchase_receipt', p_receipt,
          jsonb_build_object('duplicate_of', v_d.duplicate_of, 'reason', left(p_reason, 200)));
end;
$fn$;

/**
 * Archivar una boleta.
 *
 * [H52/H66] El archivo se borra SOLO si el documento nunca llegó a CONFIRMED —
 * subidas fallidas, duplicados descartados, extracciones FAILED. Ese es el bug
 * de huérfanos del Sprint 11 y ese sí se arregla acá.
 *
 * Una boleta CONFIRMADA es el respaldo de una compra viva, de sus lotes y de sus
 * asignaciones de costo: `raw_label` conserva el texto pero no permite reauditar
 * un dígito discutido tres meses después. Se archiva LÓGICAMENTE y el archivo se
 * conserva. Destruir la evidencia del hecho contable en el mismo sprint que
 * declara historia inmutable no es una opción; para el derecho de supresión está
 * `public.delete_receipt_file`, con permiso de admin y motivo obligatorio.
 *
 * Devuelve la ruta a borrar, o NULL: la server action no decide, obedece.
 */
create or replace function public.archive_purchase_receipt(p_receipt uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_d public.purchase_receipts;
  v_borrar boolean;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.finance_access(v_d.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;

  v_borrar := v_d.processing_status <> 'CONFIRMED' and v_d.purchase_id is null;

  update public.purchase_receipts set processing_status = 'ARCHIVED' where id = p_receipt;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_d.household_id, auth.uid(), 'RECEIPT_ARCHIVED', 'purchase_receipt', p_receipt,
          jsonb_build_object('file_deleted', v_borrar,
                             'previous_status', v_d.processing_status::text));

  return jsonb_build_object(
    'fileDeleted', v_borrar,
    'storagePath', case when v_borrar then v_d.storage_path end,
    'retained', not v_borrar,
    'retainedBecause', case when not v_borrar
      then 'esta boleta respalda una compra confirmada: el archivo se conserva' end);
end;
$fn$;

/**
 * [H66] El borrado REAL del archivo de una boleta confirmada. Derecho de
 * supresión, no limpieza: admin del hogar, motivo obligatorio, traza con nombre,
 * y la advertencia escrita de que las asignaciones quedan sin respaldo.
 */
create or replace function public.delete_receipt_file(
  p_receipt uuid,
  p_reason  text
) returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_d public.purchase_receipts;
begin
  select * into v_d from public.purchase_receipts where id = p_receipt for update;
  if v_d.id is null or not app.is_household_admin(v_d.household_id) then
    raise exception 'no autorizado';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'borrar el respaldo de una compra necesita su porqué'
      using errcode = 'check_violation';
  end if;

  update public.purchase_receipts
  set processing_status = 'ARCHIVED', failure_reason =
    'archivo borrado a petición: las asignaciones de esta compra quedan sin respaldo documental'
  where id = p_receipt;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_d.household_id, auth.uid(), 'RECEIPT_FILE_DELETED', 'purchase_receipt', p_receipt,
          jsonb_build_object('reason', left(p_reason, 200), 'purchase_id', v_d.purchase_id));
  perform app.finance_audit(
    v_d.household_id, 'RECEIPT_FILE_DELETED', 'purchase_receipt', p_receipt,
    v_d.currency, null,
    jsonb_build_object('reason', left(p_reason, 200), 'purchase_id', v_d.purchase_id),
    'NO_PRICE_RECORDED');

  return jsonb_build_object('storagePath', v_d.storage_path);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Storage: bucket PRIVADO con límites declarados EN LA BASE
-- ---------------------------------------------------------------------------

/**
 * El hogar dueño del objeto, leído de la ruta `household/{household_id}/...`.
 *
 * Devuelve NULL —y NO revienta— ante cualquier ruta que no calce: un cast
 * `::uuid` crudo dentro de una política haría fallar la consulta entera al
 * toparse con un solo nombre malformado. Mismo criterio que
 * `app.medical_path_member` (0034).
 */
create or replace function app.receipt_path_household(p_name text)
returns uuid language plpgsql immutable as $fn$
declare v_partes text[];
begin
  if p_name is null then return null; end if;
  v_partes := string_to_array(p_name, '/');
  if array_length(v_partes, 1) is null or array_length(v_partes, 1) < 3 then return null; end if;
  if v_partes[1] <> 'household' then return null; end if;
  if v_partes[2] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then return null; end if;
  return v_partes[2]::uuid;
end;
$fn$;

/** ¿Este objeto está registrado por una boleta que respalda una compra? */
create or replace function app.receipt_object_is_evidence(p_name text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.purchase_receipts d
    where d.storage_path = p_name and d.purchase_id is not null
  );
$fn$;

do $storage$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    -- Los límites viven EN `storage.buckets`, no solo en la server action: una
    -- validación que solo existe en el cliente es una sugerencia.
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('purchase-receipts', 'purchase-receipts', false, 8388608,
            array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'])
    on conflict (id) do update set
      public = false,
      file_size_limit = 8388608,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'];

    begin
      execute $pol$
        create policy receipts_upload on storage.objects
        for insert to authenticated
        with check (
          bucket_id = 'purchase-receipts'
          and app.finance_access(app.receipt_path_household(name), 'FINANCE_UPLOAD_RECEIPTS')
        )
      $pol$;
    exception when duplicate_object then null;
    end;

    -- Leer: FINANCE_VIEW sobre el hogar de la ruta. Sin política de SELECT,
    -- `createSignedUrl()` y `.download()` fallan contra el Supabase real —el
    -- bug que la 0034 tuvo que arreglar para el bucket médico— y la persona
    -- sube su boleta y no la puede volver a abrir nunca.
    begin
      execute $pol$
        create policy receipts_read on storage.objects
        for select to authenticated
        using (
          bucket_id = 'purchase-receipts'
          and app.finance_access(app.receipt_path_household(name), 'FINANCE_VIEW')
        )
      $pol$;
    exception when duplicate_object then null;
    end;

    -- [H66] Borrar: nunca el respaldo de una compra confirmada. Eso cubre el
    -- rollback del objeto huérfano (el bug del Sprint 11) y la limpieza de
    -- duplicados descartados, y deja fuera la evidencia contable.
    begin
      execute $pol$
        create policy receipts_delete_no_evidence on storage.objects
        for delete to authenticated
        using (
          bucket_id = 'purchase-receipts'
          and app.finance_access(app.receipt_path_household(name), 'FINANCE_UPLOAD_RECEIPTS')
          and not app.receipt_object_is_evidence(name)
        )
      $pol$;
    exception when duplicate_object then null;
    end;
  end if;
end;
$storage$;
