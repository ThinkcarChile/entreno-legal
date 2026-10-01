-- =============================================================================
-- HagoTuFila · «Poner en revisión» pasa por la base, y se puede deshacer
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTOS, encontrados por la auditoría cruzada y reproducidos sobre la base:
--
-- 1. El botón «Poner en revisión» de /admin/pagos hacía un UPDATE directo de
--    `payments` con la clave de servicio. El UPDATE bloquea el pago y después
--    la guarda de liquidación bloquea el trabajo: pago → trabajo, el orden
--    inverso al de todas las funciones de dinero. Con una transferencia o una
--    confirmación a la vez, PostgreSQL abortaba una de las dos por
--    interbloqueo.
-- 2. Sobre un pago PAID no había vuelta atrás: la guarda convierte cualquier
--    UNDER_REVIEW → PAID en «approved_after_under_review». El trabajo quedaba
--    congelado para las dos partes y el payout retenido; la única salida era
--    devolverle el dinero al cliente.
-- 3. Sobre un pago CREATED (sin dinero detrás) lo dejaba en UNDER_REVIEW: el
--    retorno de Webpay lo daba por resuelto y no confirmaba nunca, y en un
--    trabajo con la cancelación pedida la cerraba con «Recibimos un pago…»
--    sin que hubiera entrado nada.
-- 4. `refund_after_payout_blocker` contaba como cobrado cualquier pago en
--    UNDER_REVIEW, también uno que nunca capturó dinero. Poner en revisión el
--    cobro adicional nunca pagado inflaba lo que se podía devolver con el
--    trabajador ya pagado: se devolvían $9.000 más de lo que se cobró.
--
-- Ahora:
--
--   · `flag_payment_for_review(pago, motivo)`: solo administración, solo un
--     pago PAID (dinero cobrado y sin devoluciones), nunca con la cancelación
--     del trabajo en curso ni con el payout ya transferido (ahí una revisión
--     no retiene nada: lo que queda es una devolución). Bloquea trabajo → asignación → pago → extensión →
--     payout antes de tocar nada. El motivo de la revisión queda como
--     `review_reason = manual_review` —la marca que la distingue de todas las
--     automáticas—, el texto que escribió la persona va a `audit_logs` (que
--     solo lee administración) y no al pago, que el cliente sí lee. El payout
--     que ese pago respalda queda retenido con un motivo propio («en revisión
--     por administración»). Contesta `unchanged` si el pago ya estaba en
--     revisión.
--   · `release_payment_review(pago, nota)`: la vuelta atrás, solo para la marca
--     manual, bajo los mismos cerrojos. El pago vuelve a PAID —la guarda lo
--     admite solo dentro de esta función— y el payout que esa revisión retuvo
--     sale de HELD al estado que tenía: PENDING si el trabajo seguía en curso,
--     APPROVED si ya estaba aprobado. Si mientras tanto se abrió una disputa,
--     sigue retenido, ahora por la disputa.
--   · `guard_payout_transitions` admite HELD → PENDING solo en esa vuelta
--     atrás. Sin ella, un payout pendiente volvería APROBADO antes de que el
--     cliente aprobara, y la aprobación —que solo toca payouts PENDING— ya no
--     descontaría un bono no otorgado.
--   · `refund_after_payout_blocker` cuenta un pago en UNDER_REVIEW como dinero
--     recibido solo si tiene `captured_at`.
--
-- Las dos funciones nuevas se conceden a `authenticated` porque el panel las
-- llama con la sesión de quien administra; la primera línea de cada una es
-- `app_private.is_admin()`.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La máquina de estados del payout, con la vuelta atrás de la revisión
-- -----------------------------------------------------------------------------
-- Idéntica a 20260401000200 salvo lo marcado [Nuevo].
create or replace function app_private.guard_payout_transitions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_permitidos text[];
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- [Nuevo] Quitar una revisión manual devuelve el payout que esa revisión
  -- retuvo al estado que tenía, también PENDING. Es una transición de sistema,
  -- no de la interfaz (no está en `payoutTransitions`): solo la hace
  -- `release_payment_review`, que la anuncia para ESTE pago en una variable
  -- local a su transacción.
  if old.status = 'HELD' and new.status = 'PENDING'
     and new.payment_id is not null
     and current_setting('app.release_manual_review', true) = new.payment_id::text then
    return new;
  end if;

  v_permitidos := case old.status::text
    when 'PENDING'    then array['APPROVED', 'HELD', 'CANCELLED']
    when 'APPROVED'   then array['PROCESSING', 'HELD', 'CANCELLED']
    when 'PROCESSING' then array['PAID', 'HELD']
    when 'HELD'       then array['APPROVED', 'CANCELLED']
    else array[]::text[]      -- PAID y CANCELLED son terminales
  end;

  if not (new.status::text = any (v_permitidos)) then
    raise exception 'Transición inválida en el payout: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function app_private.guard_payout_transitions is
  'Copia en la base de payoutTransitions (src/lib/domain/state-machines.ts). PAID y CANCELLED son terminales para todos, también para el rol de servicio. Única excepción de sistema: HELD → PENDING dentro de release_payment_review.';

revoke all on function app_private.guard_payout_transitions() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. Lo cobrado, para devolver con el trabajador pagado: solo lo capturado
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001400 salvo el filtro de lo cobrado, marcado [Nuevo].
-- Un pago en revisión sigue contando —un cobro tardío o duplicado capturado es
-- justamente dinero que entró y suele haber que devolver—, pero solo si se
-- capturó. Todos los caminos automáticos a UNDER_REVIEW fijan `captured_at`;
-- uno sin él es un pago que nunca cobró nada.
create or replace function app_private.refund_after_payout_blocker(
  p_assignment_id uuid,
  p_amount        bigint,
  p_dispute_id    uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.payouts;
  v_paid bigint;
  v_refunded bigint;
  v_in_flight bigint;
  v_owed_others bigint;
  v_owed_this bigint;
  v_out bigint;
  v_room bigint;
  v_max bigint;
begin
  if p_assignment_id is null then
    return null;
  end if;

  select * into v_po from public.payouts where assignment_id = p_assignment_id;
  if v_po.id is null or v_po.status not in ('PAID', 'PROCESSING') then
    return null;
  end if;

  select coalesce(sum(p.amount) filter (
           where p.status in ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
              -- [Nuevo] en revisión, solo si de verdad se cobró.
              or (p.status = 'UNDER_REVIEW' and p.captured_at is not null)), 0),
         coalesce(sum(p.refunded_amount), 0)
    into v_paid, v_refunded
    from public.payments p
   where p.assignment_id = p_assignment_id;

  select coalesce(sum(r.amount), 0)
    into v_in_flight
    from public.payment_refunds r
    join public.payments p on p.id = r.payment_id
   where p.assignment_id = p_assignment_id
     and r.status not in ('CONFIRMED', 'FAILED', 'CANCELLED');

  select coalesce(sum(greatest(
           coalesce(d.refund_amount, 0) - coalesce((
             select sum(r.amount) from public.payment_refunds r
              where r.dispute_id = d.id and r.status not in ('FAILED', 'CANCELLED')), 0),
           0)) filter (where d.id is distinct from p_dispute_id), 0),
         coalesce(sum(greatest(
           coalesce(d.refund_amount, 0) - coalesce((
             select sum(r.amount) from public.payment_refunds r
              where r.dispute_id = d.id and r.status not in ('FAILED', 'CANCELLED')), 0),
           0)) filter (where d.id = p_dispute_id), 0)
    into v_owed_others, v_owed_this
    from public.disputes d
   where d.assignment_id = p_assignment_id and d.status = 'RESOLVED';

  v_out := v_po.net_amount + v_po.tax_withheld_amount;

  -- Con esta devolución: R + F + x + O + máx(T − x, 0) + W ≤ cobrado. Si x no
  -- pasa de lo que debe su disputa (T), no cambia nada y vale si ya cuadraba;
  -- si pasa, vale mientras x ≤ cobrado − (R + F + O + W).
  v_room := v_paid - (v_refunded + v_in_flight + v_owed_others + v_out);
  v_max := case when v_room >= v_owed_this then greatest(v_room, 0) else 0 end;

  if p_amount <= v_max then
    return null;
  end if;

  return 'Al trabajador ya se le pagaron ' || app_private.format_clp(v_out)
    || ' por este trabajo y el cliente pagó ' || app_private.format_clp(v_paid)
    || case when v_refunded + v_in_flight > 0
            then '; ya se le devolvió o está en devolución '
                 || app_private.format_clp(v_refunded + v_in_flight)
            else '' end
    || case when v_owed_others + v_owed_this > 0
            then '; se le deben ' || app_private.format_clp(v_owed_others + v_owed_this)
                 || ' por una disputa resuelta'
            else '' end
    || '. '
    || case when v_max > 0
            then 'Solo se pueden devolver ' || app_private.format_clp(v_max)
                 || ' más, lo que queda de la plataforma'
            else 'Ya no queda nada que se pueda devolver sin poner dinero de la plataforma' end
    || ' (pediste ' || app_private.format_clp(p_amount) || '). Devolver más sería pagar dos '
    || 'veces el mismo trabajo: al cliente y al trabajador. Si de verdad corresponde, es un caso '
    || 'para soporte';
end;
$$;

comment on function app_private.refund_after_payout_blocker is
  'Con el payout de la asignación transferido (PAID o PROCESSING): motivo, con cifras, si devolver p_amount haría que lo devuelto, lo pedido, lo debido por disputas y lo pagado al trabajador superen lo cobrado (un pago en revisión cuenta solo si se capturó); NULL si cabe o si el payout no se transfirió.';

revoke all on function app_private.refund_after_payout_blocker(uuid, bigint, uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. Poner un pago en revisión
-- -----------------------------------------------------------------------------
create or replace function public.flag_payment_for_review(
  p_payment_id uuid,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_assignment_id uuid;
  v_extension_id uuid;
  v_job public.jobs;
  v_payment public.payments;
  v_payout public.payouts;
  v_payout_after public.payout_status;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración pone un pago en revisión'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'Escribe el motivo de la revisión (al menos 10 caracteres)'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Sin bloqueo: solo para saber qué bloquear, y en qué orden.
  select job_id, assignment_id, extension_id
    into v_job_id, v_assignment_id, v_extension_id
    from public.payments where id = p_payment_id;
  if v_job_id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  -- Orden canónico: trabajo → asignación → pago → extensión → payout. La
  -- guarda de liquidación, que corre con el UPDATE de abajo, los encuentra ya
  -- tomados por esta misma transacción.
  select * into v_job from public.jobs where id = v_job_id for update;
  if v_assignment_id is not null then
    perform 1 from public.assignments where id = v_assignment_id for update;
  end if;
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_extension_id is not null then
    perform 1 from public.job_extensions where id = v_extension_id for update;
  end if;
  if v_assignment_id is not null then
    select * into v_payout from public.payouts where assignment_id = v_assignment_id for update;
  end if;

  -- Un doble clic no es un error, pero tampoco hace nada: se dice.
  if v_payment.status = 'UNDER_REVIEW' then
    return jsonb_build_object(
      'outcome', 'unchanged',
      'payment_status', v_payment.status,
      'review_reason', v_payment.review_reason
    );
  end if;

  -- Solo dinero cobrado y entero. Lo demás no tiene dinero que revisar, o ya
  -- tiene su propio camino.
  if v_payment.status <> 'PAID' then
    raise exception '%', case
      when v_payment.status in ('PENDING', 'CREATED', 'AUTHORIZED') then
        'Este pago todavía está en curso (' || v_payment.status::text || '): no hay dinero que revisar. '
        || 'Si el cliente dice que pagó, usa «Consultar al proveedor»'
      when v_payment.status = 'FAILED' then
        'Este pago no se completó: no hay dinero que revisar'
      else
        'Este pago ya tiene devoluciones (' || v_payment.status::text || '): se gestiona desde «Devolver», '
        || 'no con una revisión'
    end
      using errcode = 'check_violation';
  end if;

  -- Con la cancelación en curso, lo que decide es el resultado del pago: una
  -- revisión manual la cerraría como si hubiera llegado un pago tardío.
  if v_job.status in ('CANCELLATION_PENDING', 'CANCELLED') then
    raise exception 'El trabajo tiene una cancelación en curso o cerrada: el pago no se pone en revisión a mano'
      using errcode = 'check_violation';
  end if;

  -- Con el trabajador ya pagado, una revisión no retiene nada: solo dejaría un
  -- payout transferido sobre un cobro «en duda». Lo que quede por hacer es una
  -- devolución, que mide lo que queda de la plataforma.
  if v_payout.id is not null and v_payout.status in ('PAID', 'PROCESSING') then
    raise exception 'El pago al trabajador de este trabajo ya se transfirió: una revisión ya no retiene nada. Si hay que devolverle algo al cliente, usa «Devolver»'
      using errcode = 'check_violation';
  end if;

  update public.payments
     set status        = 'UNDER_REVIEW',
         review_reason = 'manual_review',
         captured_at   = coalesce(captured_at, paid_at, now()),
         updated_at    = now()
   where id = p_payment_id;

  -- El payout que este pago respalda y que todavía se podía pagar queda
  -- retenido, con un motivo propio: es lo que reconoce `release_payment_review`
  -- para devolverlo a donde estaba. (`hold_payout_on_unhealthy_payment` ya lo
  -- retuvo con el UPDATE de arriba; aquí se deja dicho que fue esta revisión,
  -- y se retiene igual si algún día ese disparador cambia.)
  if v_payout.id is not null
     and v_payout.payment_id = p_payment_id
     and v_payout.status in ('PENDING', 'APPROVED', 'PROCESSING') then
    update public.payouts
       set status      = 'HELD',
           held_reason = 'El pago del cliente está en revisión por administración',
           updated_at  = now()
     where id = v_payout.id;
  end if;

  select status into v_payout_after from public.payouts where id = v_payout.id;

  -- Para la historia del pago, que el cliente lee: qué pasó, sin quién ni por
  -- qué. Eso va a la auditoría.
  insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
  values (p_payment_id, v_payment.status, 'UNDER_REVIEW', v_payment.provider,
          jsonb_build_object('operation', 'manual_review', 'review_reason', 'manual_review'));

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (auth.uid(), 'payment_review_flagged', 'payments', p_payment_id,
          jsonb_build_object('status', v_payment.status,
                             'review_reason', v_payment.review_reason,
                             'payout_status', v_payout.status),
          jsonb_build_object('status', 'UNDER_REVIEW',
                             'review_reason', 'manual_review',
                             'reason', btrim(p_reason),
                             'payout_status', v_payout_after));

  return jsonb_build_object(
    'outcome', 'applied',
    'payment_status', 'UNDER_REVIEW',
    'review_reason', 'manual_review',
    'payout_status', v_payout_after
  );
end;
$$;

revoke execute on function public.flag_payment_for_review(uuid, text) from public;
revoke execute on function public.flag_payment_for_review(uuid, text) from anon;
grant execute on function public.flag_payment_for_review(uuid, text) to authenticated;

comment on function public.flag_payment_for_review is
  'Solo administración: pone en revisión manual (review_reason = manual_review) un pago PAID, bajo el cerrojo trabajo → asignación → pago → extensión → payout. El payout del trabajo queda retenido. El motivo va a audit_logs. Contesta unchanged si ya estaba en revisión.';


-- -----------------------------------------------------------------------------
-- 4. Quitarla
-- -----------------------------------------------------------------------------
create or replace function public.release_payment_review(
  p_payment_id uuid,
  p_note       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_assignment_id uuid;
  v_extension_id uuid;
  v_job public.jobs;
  v_assignment public.assignments;
  v_payment public.payments;
  v_payout public.payouts;
  v_before text;
  v_target public.payout_status;
  v_payout_after public.payout_status;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración quita un pago de revisión'
      using errcode = 'insufficient_privilege';
  end if;
  if p_note is null or length(btrim(p_note)) < 10 then
    raise exception 'Escribe por qué se quita la revisión (al menos 10 caracteres)'
      using errcode = 'invalid_parameter_value';
  end if;

  select job_id, assignment_id, extension_id
    into v_job_id, v_assignment_id, v_extension_id
    from public.payments where id = p_payment_id;
  if v_job_id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  -- Los mismos cerrojos, en el mismo orden, que al ponerla.
  select * into v_job from public.jobs where id = v_job_id for update;
  if v_assignment_id is not null then
    select * into v_assignment from public.assignments where id = v_assignment_id for update;
  end if;
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_extension_id is not null then
    perform 1 from public.job_extensions where id = v_extension_id for update;
  end if;
  if v_assignment_id is not null then
    select * into v_payout from public.payouts where assignment_id = v_assignment_id for update;
  end if;

  if v_payment.status = 'PAID' then
    return jsonb_build_object('outcome', 'unchanged', 'payment_status', 'PAID');
  end if;

  -- Solo la marca manual. Una revisión automática es una duda sobre el dinero
  -- —un importe que no cuadra, un cobro tardío— y se resuelve consultando al
  -- proveedor o devolviendo, nunca dándola por buena con un clic.
  if v_payment.status <> 'UNDER_REVIEW' or v_payment.review_reason is distinct from 'manual_review' then
    raise exception 'Solo se quita de revisión un pago que se puso en revisión a mano. Este está en % (motivo: %): se resuelve consultando al proveedor o devolviendo',
      v_payment.status, coalesce(v_payment.review_reason, 'sin motivo')
      using errcode = 'check_violation';
  end if;

  if v_payment.captured_at is null or v_payment.refunded_amount <> 0 then
    raise exception 'Este pago no tiene el cobro entero detrás: no vuelve a confirmado'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.payment_refunds r
              where r.payment_id = p_payment_id and r.status in ('REQUESTED', 'UNKNOWN')) then
    raise exception 'Hay una devolución de este pago sin resultado final: espera a que se resuelva antes de quitar la revisión'
      using errcode = 'check_violation';
  end if;

  if v_job.status in ('CANCELLED', 'CANCELLATION_PENDING', 'EXPIRED') then
    raise exception 'El trabajo está %: el pago no vuelve a confirmado. Devuélvelo desde «Devolver»',
      v_job.status
      using errcode = 'check_violation';
  end if;

  -- Cómo estaba el payout antes de la revisión: lo anotó `flag_payment_for_review`.
  select l.before ->> 'payout_status' into v_before
    from public.audit_logs l
   where l.entity_type = 'payments' and l.entity_id = p_payment_id
     and l.action = 'payment_review_flagged'
   order by l.created_at desc
   limit 1;

  -- La puerta de la guarda de liquidación y de la máquina de estados del
  -- payout, para este pago y solo dentro de esta transacción.
  perform set_config('app.release_manual_review', p_payment_id::text, true);

  update public.payments
     set status     = 'PAID',
         updated_at = now()
   where id = p_payment_id;

  -- El payout que retuvo ESTA revisión (y no otra cosa después) vuelve a donde
  -- estaba. Con una disputa abierta mientras tanto, sigue retenido por ella.
  if v_payout.id is not null
     and v_payout.payment_id = p_payment_id
     and v_payout.status = 'HELD'
     and v_payout.held_reason = 'El pago del cliente está en revisión por administración' then
    if exists (select 1 from public.disputes d
                where d.assignment_id = v_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
      update public.payouts
         set held_reason = 'Disputa abierta', updated_at = now()
       where id = v_payout.id;
    else
      v_target := case
        when v_assignment.status = 'COMPLETED' then 'APPROVED'
        when v_before = 'PENDING' then 'PENDING'
        when v_before in ('APPROVED', 'PROCESSING') then 'APPROVED'
        else 'PENDING'
      end;
      update public.payouts
         set status = v_target, held_reason = null, updated_at = now()
       where id = v_payout.id;
    end if;
  end if;

  perform set_config('app.release_manual_review', '', true);

  select status into v_payout_after from public.payouts where id = v_payout.id;

  insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
  values (p_payment_id, 'UNDER_REVIEW', 'PAID', v_payment.provider,
          jsonb_build_object('operation', 'manual_review_released'));

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (auth.uid(), 'payment_review_released', 'payments', p_payment_id,
          jsonb_build_object('status', 'UNDER_REVIEW', 'review_reason', 'manual_review',
                             'payout_status', v_payout.status),
          jsonb_build_object('status', 'PAID', 'note', btrim(p_note),
                             'payout_status', v_payout_after));

  return jsonb_build_object(
    'outcome', 'applied',
    'payment_status', 'PAID',
    'payout_status', v_payout_after
  );
end;
$$;

revoke execute on function public.release_payment_review(uuid, text) from public;
revoke execute on function public.release_payment_review(uuid, text) from anon;
grant execute on function public.release_payment_review(uuid, text) to authenticated;

comment on function public.release_payment_review is
  'Solo administración: devuelve a PAID un pago en revisión MANUAL (review_reason = manual_review), con el cobro entero y sin devoluciones abiertas, bajo los mismos cerrojos que flag_payment_for_review. El payout que esa revisión retuvo vuelve a PENDING o APPROVED; con una disputa abierta sigue retenido. La nota va a audit_logs.';


-- -----------------------------------------------------------------------------
-- 5. Las revisiones manuales anteriores a esta migración
-- -----------------------------------------------------------------------------
-- El panel escribía siempre el mismo texto. Las que se pusieron sobre un pago
-- cobrado (con `paid_at` y `captured_at`) reciben la marca nueva y se pueden
-- quitar. Las que cayeron sobre un pago sin dinero no se tocan: no hay a qué
-- PAID volver, y decidir qué hacer con ellas es de una persona.
update public.payouts po
   set held_reason = 'El pago del cliente está en revisión por administración'
  from public.payments p
 where p.id = po.payment_id
   and po.status = 'HELD'
   and po.held_reason = 'El pago del cliente está en revisión: Marcado manualmente desde administración'
   and p.status = 'UNDER_REVIEW'
   and p.review_reason = 'Marcado manualmente desde administración'
   and p.paid_at is not null
   and p.captured_at is not null
   and p.refunded_amount = 0;

update public.payments
   set review_reason = 'manual_review'
 where status = 'UNDER_REVIEW'
   and review_reason = 'Marcado manualmente desde administración'
   and paid_at is not null
   and captured_at is not null
   and refunded_amount = 0;
