-- =============================================================================
-- HagoTuFila · Etapa 2.5 · 100 · Qué puede escribir un usuario con sesión
-- =============================================================================
-- Auditoría individual de las 16 RPC `SECURITY DEFINER`. Las funciones estaban
-- bien: comprueban `auth.uid()`, validan pertenencia y calculan los importes en
-- el servidor. El problema era otro, y más grave: no hacía falta llamarlas.
--
-- La Etapa 1 restringió con cuidado el UPDATE por columna —`profiles`,
-- `worker_profiles`, `job_offers`— pero el INSERT quedó abierto a TODAS las
-- columnas de TODAS las tablas, y casi todas tienen una política de tipo
-- "inserta tus propias filas". Donde el UPDATE decía que no, el INSERT decía
-- que sí. Cinco abusos comprobados contra el esquema real, no supuestos:
--
--   E01  Un usuario con sesión y sin perfil de trabajador se insertaba uno con
--        `verification_status = 'VERIFIED'`, `level = 'EXPERTO'`,
--        `trust_index = 100` y `completed_jobs = 999`. Se autoverificaba y se
--        inventaba su reputación, saltándose `request_worker_verification` y
--        `review_worker_verification` enteras. `is_verified_worker()` lee esa
--        misma columna, así que además quedaba habilitado para ofertar.
--   E02  Un trabajador verificado insertaba una oferta ya `ACCEPTED`, sin pasar
--        por `accept_job_offer`, que es quien comprueba la concurrencia y crea
--        la asignación.
--   E03  Cualquiera de las dos partes multiplicaba por diez el `agreed_total`
--        de su asignación y se ponía `bonus_awarded = true`. Los importes los
--        congela `accept_job_offer`; el UPDATE directo los descongelaba.
--   E04  El cliente dueño marcaba su propio trabajo como `PAID` sin pagar.
--        `guard_job_edits` congela el título, la fecha y el precio tras la
--        asignación, pero no `status`.
--   E05  Un usuario se insertaba una verificación ya `VERIFIED`, con
--        `reviewed_at` incluido.
--
-- El arreglo no toca ninguna de las 16 funciones: lo que faltaba era que sus
-- controles fueran los ÚNICOS caminos. Se aplica el mismo criterio que ya usaba
-- el UPDATE —conceder columna por columna lo que la aplicación escribe de
-- verdad— y se deja cerrado por defecto para lo que venga.
--
-- Las políticas RLS se quedan como están: siguen diciendo "solo tus propias
-- filas", que es cierto y útil. Lo que se corrige es la capa de privilegios,
-- que es la que había quedado sin cerrar.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. INSERT: nada, salvo lo que la aplicación escribe con sesión de usuario
-- -----------------------------------------------------------------------------
-- Son exactamente tres sitios en todo el código:
--   src/lib/actions/offers.ts      → job_offers
--   src/lib/actions/assignment.ts  → job_evidence
--   src/lib/actions/chat.ts        → messages
-- Todo lo demás entra por una RPC `SECURITY DEFINER`, que corre como `postgres`
-- y por tanto no depende de estos privilegios.
revoke insert on all tables in schema public from authenticated;

-- Una oferta la escribe el trabajador. `status` no está: nace PENDING y solo
-- `accept_job_offer` y `withdraw_job_offer` la mueven de ahí.
grant insert (job_id, worker_id, hourly_rate, estimated_total, message, estimated_arrival_at)
  on public.job_offers to authenticated;

-- La línea de tiempo del trabajo. Sin `storage_path`, `image_url` ni las
-- coordenadas: esas llegan en la Etapa 5 y entonces se amplía esta concesión a
-- conciencia, que es justo lo que no pasó con el INSERT la primera vez.
grant insert (job_id, assignment_id, author_id, evidence_type, title, body)
  on public.job_evidence to authenticated;

-- Un mensaje de chat. Sin `read_at`: lo marca `mark_conversation_read`.
grant insert (conversation_id, sender_id, message_type, body)
  on public.messages to authenticated;

-- Una reseña la escribe un participante del trabajo, y `reviews_insert_participant`
-- ya comprueba que lo sea. La interfaz llega en la Etapa 6, pero el esquema y las
-- pruebas ya la ejercitan. Sin `is_hidden`: ocultar una reseña es moderación, y
-- eso es de la administración.
grant insert (assignment_id, author_id, subject_id, overall, punctuality, communication, compliance, comment)
  on public.reviews to authenticated;

-- Abrir una disputa es un derecho del participante, y `disputes_insert` ya
-- comprueba que lo sea. La interfaz es de la Etapa 6. Sin `status`, sin
-- `resolution` y sin los importes de reembolso: eso lo resuelve la
-- administración, no quien reclama.
grant insert (assignment_id, opened_by, reason, description)
  on public.disputes to authenticated;

-- Y que una tabla nueva no reabra el agujero en silencio. Quien la cree tendrá
-- que conceder el INSERT a mano, columna por columna, como aquí arriba.
alter default privileges in schema public revoke insert on tables from authenticated;


-- -----------------------------------------------------------------------------
-- 2. UPDATE sobre `jobs`: ninguno
-- -----------------------------------------------------------------------------
-- Ningún punto del código actualiza `jobs` con la sesión del usuario. Las tres
-- vías son `publish_job`, `update_open_job` y `cancel_job`, todas RPC. El
-- privilegio sobraba, y con él se podía saltar `guard_job_edits` por el lado
-- que esa guarda no cubre: `status`, `commission_bps` y los importes.
revoke update on public.jobs from authenticated;


-- -----------------------------------------------------------------------------
-- 3. UPDATE sobre `assignments`: solo el avance de estado
-- -----------------------------------------------------------------------------
-- La aplicación escribe tres columnas, en `src/lib/actions/assignment.ts`.
-- `agreed_hourly_rate`, `agreed_total`, `bonus_amount` y `bonus_awarded` los
-- fija `accept_job_offer` al crear la asignación y nadie más vuelve a tocarlos.
revoke update on public.assignments from authenticated;
grant update (status, checked_in_at, started_at) on public.assignments to authenticated;


-- -----------------------------------------------------------------------------
-- 4. Las transiciones de la asignación, en la base y no solo en TypeScript
-- -----------------------------------------------------------------------------
-- `src/lib/domain/state-machines.ts` define `assignmentTransitions` y su propio
-- comentario dice que la intención es "replicarlas como constraints en la base
-- de datos". Estaban solo en el cliente: con el privilegio de escribir `status`
-- —que la aplicación necesita— un participante podía saltar de `IN_PROGRESS` a
-- `COMPLETED` sin pasar por el PIN de entrega, o volver atrás a un estado ya
-- superado.
--
-- El importe ya estaba protegido por `require_payment_before_work`, que impide
-- avanzar sin pago confirmado. Esto cierra el resto del recorrido.
--
-- La tabla es copia literal de `assignmentTransitions`. Si una cambia, cambia
-- la otra: son la misma regla escrita dos veces a propósito, y `db:test` las
-- compara.
create or replace function app_private.guard_assignment_transitions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permitidos text[];
begin
  -- Sin sesión (rol de servicio, disparadores del propio sistema) y la
  -- administración no pasan por aquí, igual que en `guard_job_edits`.
  if auth.uid() is null or app_private.is_admin() then
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  v_permitidos := case old.status::text
    when 'AWAITING_PAYMENT'    then array['CONFIRMED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'CONFIRMED'           then array['ON_THE_WAY', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'ON_THE_WAY'          then array['CHECKED_IN', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'CHECKED_IN'          then array['IN_PROGRESS', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'IN_PROGRESS'         then array['HANDOFF_COMPLETED', 'COMPLETED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER']
    when 'HANDOFF_COMPLETED'   then array['COMPLETED']
    else array[]::text[]
  end;

  if not (new.status::text = any (v_permitidos)) then
    raise exception 'Transición inválida en la asignación: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function app_private.guard_assignment_transitions is
  'Copia en la base de assignmentTransitions (src/lib/domain/state-machines.ts).';

drop trigger if exists assignments_guard_transitions on public.assignments;
create trigger assignments_guard_transitions
  before update on public.assignments
  for each row execute function app_private.guard_assignment_transitions();
