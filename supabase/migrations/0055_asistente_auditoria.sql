-- 0055 — La auditoría del asistente: qué hizo, cuándo, quién lo confirmó y con
-- qué datos. Si no puede contestar eso, no sirve.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ HAY DOS LIBROS Y NO UNO
-- ---------------------------------------------------------------------------
--
-- `audit_events` (0001) lo lee todo admin del hogar. Eso está bien para "se
-- ajustó la lista de compras" y está MAL para el asistente, porque el asistente
-- también contesta preguntas de salud.
--
-- Guardar en `audit_events` el ámbito de una consulta clínica —aunque sea sólo
-- el id del integrante— le cuenta a un admin SIN grant sobre Ana que existe
-- consulta de salud sobre Ana, con qué frecuencia y quién la hace. La
-- existencia y la frecuencia de una consulta médica también son dato sensible,
-- y es justo lo que un grant revocado debería dejar de revelar.
--
-- Entonces:
--   · Lo clínico va a `assistant_medical_audit`, con RLS anclada en
--     `app.medical_access(owner, 'READ_LABS')`: lo ve el dueño y sus grantees,
--     no el admin por ser admin.
--   · En `audit_events` queda una fila con herramienta genérica ('SALUD') y sin
--     ámbito. Que hubo actividad se sabe; sobre quién, no.
--
-- Lo que NUNCA se guarda en ninguno de los dos: la pregunta, la respuesta, el
-- payload de la herramienta, ni un solo valor. Ids, nombre de herramienta y
-- traceId. Con eso se reconstruye qué pasó sin volver a exponer el dato.

create table public.assistant_medical_audit (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  owner_member uuid not null references public.household_members (id) on delete cascade,
  actor_member uuid references public.household_members (id) on delete set null,
  tool         text not null,
  kind         text not null,
  trace_id     text not null,
  status       text not null,
  scope_ids    jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index assistant_medical_audit_dueno
  on public.assistant_medical_audit (owner_member, created_at desc);

alter table public.assistant_medical_audit enable row level security;

create policy assistant_medical_audit_select on public.assistant_medical_audit
  for select to authenticated using (app.medical_access(owner_member, 'READ_LABS'));

revoke insert, update, delete on public.assistant_medical_audit from anon, authenticated;

/**
 * El recibo de toda llamada a herramienta del asistente.
 *
 * `p_owner` no nulo = la llamada tocó datos de esa persona, y entonces el
 * recibo detallado va al libro clínico.
 *
 * OJO con el `return` silencioso de quien no es del hogar: NO es un catch
 * vacío. Auditar es un efecto lateral de una llamada que ya se hizo, y hacer
 * reventar la operación entera porque el recibo no cupo cambiaría el contrato
 * de errores de veinte acciones. Lo que sí está prohibido es lo contrario:
 * que una acción del asistente no deje recibo. El guardián de eso es el test
 * de integración, que cuenta un ASSISTANT_TOOL_CALL por cada runTool.
 */
create or replace function public.log_assistant_call(
  p_household uuid,
  p_tool      text,
  p_kind      text,
  p_trace     text,
  p_scope_ids jsonb default '{}'::jsonb,
  p_status    text  default 'OK',
  p_owner     uuid  default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_scope jsonb;
begin
  if not app.is_household_member(p_household) then return; end if;
  v_actor := app.current_member_id(p_household);

  -- Sólo uuids. Cualquier otra cosa que venga en `scope_ids` —una etiqueta, un
  -- texto, el nombre de un alimento— se cae acá y no llega al libro.
  -- Las columnas de `jsonb_each_text` se llaman `key` y `value`. Van citadas
  -- porque `value` es palabra reservada, y sin comillas esto compila igual y
  -- revienta recién en tiempo de ejecución, con la auditoría ya en producción.
  select coalesce(jsonb_object_agg(e."key", e."value"), '{}'::jsonb) into v_scope
    from jsonb_each_text(coalesce(p_scope_ids, '{}'::jsonb)) e
   where e."value" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  if p_owner is not null then
    insert into public.assistant_medical_audit
      (household_id, owner_member, actor_member, tool, kind, trace_id, status, scope_ids)
    values (p_household, p_owner, v_actor, p_tool, p_kind, p_trace, p_status, v_scope);

    -- En el libro que lee el admin queda que hubo actividad, sin decir sobre
    -- quién ni con qué. Un admin sin grant no necesita saber más, y saber más
    -- sería justo lo que el grant revocado tenía que dejar de contar.
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (p_household, auth.uid(), 'ASSISTANT_TOOL_CALL', 'assistant_tool', null,
            jsonb_build_object('tool', 'SALUD', 'kind', p_kind,
                               'trace_id', p_trace, 'status', p_status));
    return;
  end if;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (p_household, auth.uid(), 'ASSISTANT_TOOL_CALL', 'assistant_tool', null,
          jsonb_build_object('tool', p_tool, 'kind', p_kind, 'trace_id', p_trace,
                             'status', p_status, 'scope', v_scope));
end;
$$;

comment on function public.log_assistant_call(uuid, text, text, text, jsonb, text, uuid) is
  'Metadata SÓLO con ids, nombre de herramienta y traceId. Lo clínico va a otro '
  'libro con RLS por grant: audit_events lo lee todo admin del hogar, y la '
  'FRECUENCIA de una consulta médica también es dato sensible.';

/**
 * El recibo del acto de EJECUTAR una propuesta.
 *
 * Contesta las cuatro preguntas que le dan sentido a auditar un asistente:
 * qué hizo (`accion`), cuándo (`created_at`), quién lo confirmó (`decided_by`,
 * que la 0053 exige distinto de nulo para cerrar) y con qué datos (`basis`,
 * la foto congelada, referenciada por id).
 *
 * El `basis` se referencia y no se copia: ya está guardado en la propuesta, y
 * duplicarlo acá sería un segundo dueño del mismo dato.
 */
create or replace function public.log_assistant_execution(
  p_proposal uuid,
  p_status   text,
  p_result   jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare v_row public.assistant_proposals;
begin
  select * into v_row from public.assistant_proposals where id = p_proposal;
  if not found then raise exception 'no autorizado'; end if;
  if not app.is_household_member(v_row.household_id) then raise exception 'no autorizado'; end if;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_row.household_id, auth.uid(), 'ASSISTANT_PROPOSAL_EXECUTED',
          'assistant_proposal', p_proposal,
          jsonb_build_object(
            'accion',       v_row.accion,
            'risk',         v_row.risk,
            'origen',       v_row.origen,
            'trace_id',     v_row.trace_id,
            'dedupe_key',   v_row.dedupe_key,
            'confirmado_por', v_row.decided_by,
            'confirmado_el',  v_row.decided_at,
            'status',       p_status,
            'result',       coalesce(p_result, '{}'::jsonb)));
end;
$$;

/**
 * La URL firmada de un examen deja rastro.
 *
 * `getExamSignedUrl` emite hoy una URL de `medical-documents` que da acceso al
 * PDF durante su TTL y NO deja ni una línea en ningún libro. O sea: el momento
 * exacto en que el dato clínico sale del sistema es el único que no se audita.
 */
create or replace function public.log_medical_url_emission(
  p_document    uuid,
  p_ttl_seconds int
) returns void language plpgsql security definer set search_path = public as $$
declare v_member uuid; v_household uuid;
begin
  select member_id into v_member from public.lab_documents where id = p_document;
  if v_member is null then raise exception 'no autorizado'; end if;
  if not app.medical_access(v_member, 'READ_LABS') then raise exception 'no autorizado'; end if;

  v_household := app.member_household(v_member);

  insert into public.assistant_medical_audit
    (household_id, owner_member, actor_member, tool, kind, trace_id, status, scope_ids)
  values (v_household, v_member, app.current_member_id(v_household),
          'medical.signed_url', 'READ', 'url:' || p_document::text, 'OK',
          jsonb_build_object('document_id', p_document::text));

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_household, auth.uid(), 'MEDICAL_URL_EMITTED', 'lab_document', p_document,
          jsonb_build_object('ttl_seconds', p_ttl_seconds));
end;
$$;

comment on function public.log_medical_url_emission(uuid, int) is
  'El momento en que el PDF del examen sale del sistema es el único que hoy no '
  'se audita. Acá deja rastro, y el detalle va al libro clínico.';
