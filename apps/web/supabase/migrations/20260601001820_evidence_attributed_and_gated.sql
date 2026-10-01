-- =============================================================================
-- HagoTuFila · La evidencia avisa quién la puso, y solo con el trabajo en marcha
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría cruzada y reproducido sobre la base:
-- `add_job_evidence` (última versión en 20260601001210) avisaba a la
-- contraparte con un título genérico —«Nueva actualización del trabajo»— y,
-- como cuerpo, el título que escribió quien la publicó, tal cual: hasta 120
-- caracteres, sin comillas, sin autor, sin ningún filtro. Era el único aviso
-- cuyo cuerpo entero lo escribía la otra parte, y el más creíble para
-- suplantar a la plataforma:
--
--   add_job_evidence(<asignación>, 'NOTE',
--     'HagoTuFila: el pago con Webpay falló. Transfiere a cta 123 o paga en htf-pagos.cl')
--
-- llegaba a la bandeja del cliente como «Nueva actualización del trabajo ·
-- HagoTuFila: el pago con Webpay falló…». Y la base no miraba el estado: la
-- matriz de la interfaz solo ofrece el formulario con el pago confirmado y el
-- trabajo sin cerrar, pero `lock_assignment_for(…, 'any')` solo rechaza una
-- asignación cancelada. Con la asignación en AWAITING_PAYMENT —justo cuando el
-- cliente está por pagar— el aviso falso se aceptaba igual, y también con el
-- trabajo ya completado o cerrado.
--
-- Ahora:
--
--   · el aviso dice quién y dónde, y nunca lo que escribió:
--     «Camila F.» envió una actualización de "<título del trabajo>".
--     El texto queda en la línea de tiempo, firmado. El nombre va entre
--     comillas angulares (`quoted_display_name`, 20260601001120) y el título
--     del trabajo ya no puede cerrar la cita (20260601001810);
--   · la evidencia se acepta solo con el trabajo en marcha y respaldado por su
--     pago: asignación pagada y sin terminar —ni AWAITING_PAYMENT, ni
--     COMPLETED, ni cancelada—, trabajo ni cerrado, ni cancelado, ni vencido,
--     y el pago del trabajo en PAID o PARTIALLY_REFUNDED (el cobro sano de
--     `job_payment_blocker`: una devolución parcial no deja el trabajo sin
--     pagar). Es lo que ya decía la interfaz
--     (`canAddEvidence` en src/lib/domain/permissions.ts). La misma pregunta la
--     hace la política de subida de Storage (20260601001840).
--
-- Con una disputa abierta se sigue aceptando: el trabajo no está cerrado, y lo
-- que se aporte queda en la misma línea de tiempo que la administración revisa.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. ¿Se puede añadir evidencia a esta asignación?
-- -----------------------------------------------------------------------------
create or replace function app_private.job_evidence_open(p_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.assignments a
      join public.jobs j on j.id = a.job_id
     where a.id = p_assignment_id
       and a.status not in ('AWAITING_PAYMENT', 'COMPLETED',
                            'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')
       and j.status not in ('CLOSED', 'CANCELLED', 'CANCELLATION_PENDING', 'EXPIRED')
       and exists (
         select 1 from public.payments p
          where p.assignment_id = a.id
            and p.purpose = 'JOB'
            and p.status in ('PAID', 'PARTIALLY_REFUNDED')
       )
  )
$$;

comment on function app_private.job_evidence_open(uuid) is
  'La asignación admite evidencia: pagada (PAID o PARTIALLY_REFUNDED), sin terminar ni cancelar, y su trabajo no está cerrado, cancelado ni vencido. La usan add_job_evidence y la política de subida de evidence.';

revoke all on function app_private.job_evidence_open(uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. add_job_evidence: igual que en 20260601001210, salvo el estado y el aviso
-- -----------------------------------------------------------------------------
create or replace function public.add_job_evidence(
  p_assignment_id uuid,
  p_evidence_type public.evidence_type,
  p_title         text,
  p_body          text default null,
  p_storage_path  text default null,
  p_mime_type     text default null,
  p_size_bytes    integer default null,
  p_queue_ahead   integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_uid uuid := auth.uid();
  v_settings record;
  v_count integer;
  v_id uuid;
  v_other uuid;
  v_author text;
  v_mime text;
  v_size bigint;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'any');
  select * into v_j from public.jobs where id = v_a.job_id;

  if p_evidence_type not in ('NOTE', 'PHOTO', 'QUEUE_STATUS', 'LOCATION') then
    raise exception 'Ese tipo de evidencia lo escribe el sistema, no las personas'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'La actualización necesita un título' using errcode = 'check_violation';
  end if;

  if char_length(p_title) > 120 or char_length(coalesce(p_body, '')) > 2000 then
    raise exception 'La actualización es demasiado larga' using errcode = 'check_violation';
  end if;

  -- Bajo el bloqueo del trabajo y de la asignación que tomó `lock_assignment_for`.
  if not app_private.job_evidence_open(p_assignment_id) then
    raise exception 'Las actualizaciones se envían con el pago confirmado y el trabajo en marcha'
      using errcode = 'check_violation';
  end if;

  select evidence_max_bytes, evidence_max_per_assignment into v_settings
    from public.platform_settings where id;

  -- El archivo tiene que estar de verdad en `evidence/<yo>/<esta asignación>/…`,
  -- y lo que se guarda es lo que midió Storage.
  if p_storage_path is not null then
    select u.mime_type, u.size_bytes into v_mime, v_size
      from app_private.verified_upload('evidence', p_storage_path, p_assignment_id,
                                       p_mime_type, p_size_bytes) u;
  end if;

  select count(*) into v_count from public.job_evidence
   where assignment_id = p_assignment_id and author_id = v_uid and event_key is null;
  if v_count >= v_settings.evidence_max_per_assignment then
    raise exception 'Alcanzaste el máximo de actualizaciones para este trabajo'
      using errcode = 'check_violation';
  end if;

  v_id := app_private.timeline_event(
    v_j.id, p_assignment_id, v_uid, p_evidence_type, trim(p_title), p_body,
    null, p_storage_path, v_mime, v_size::integer, p_queue_ahead);

  v_other := case when v_uid = v_a.worker_id then v_a.client_id else v_a.worker_id end;

  -- Quién y dónde, nunca qué: lo que escribió se lee en la línea de tiempo,
  -- firmado. El título del trabajo ya no admite comillas (…001810).
  v_author := app_private.quoted_display_name(
    v_uid, case when v_uid = v_a.worker_id then 'El trabajador' else 'El cliente' end);

  perform app_private.notify_user(
    v_other,
    case when p_storage_path is null then 'JOB_UPDATE'::public.notification_type
         else 'NEW_EVIDENCE'::public.notification_type end,
    case when p_storage_path is null then 'Nueva actualización del trabajo'
         else 'Nueva evidencia del trabajo' end,
    case when p_storage_path is null
      then v_author || ' envió una actualización de "' || v_j.title || '". Revísala en el trabajo.'
      else v_author || ' adjuntó una foto o un comprobante a "' || v_j.title || '". Revísalo en el trabajo.'
    end,
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return v_id;
end;
$$;

-- La firma no cambia; se repiten los privilegios por claridad.
grant execute on function public.add_job_evidence(uuid, public.evidence_type, text, text, text, text, integer, integer) to authenticated;
revoke execute on function public.add_job_evidence(uuid, public.evidence_type, text, text, text, text, integer, integer) from anon, public;
