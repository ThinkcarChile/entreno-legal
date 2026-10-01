-- =============================================================================
-- HagoTuFila · Un reintento no borra el rastro de un cobro posible
-- =============================================================================
-- Migración correctiva de 20260501000100. No la modifica.
--
-- DEFECTO, encontrado por la auditoría y comprobado en el código: si el commit
-- de Webpay contestaba AUTHORIZED (queda `committed_at` y `provider_status`)
-- pero el asiento en la base fallaba después, el pago seguía en CREATED. Si el
-- cliente volvía a pagar, `register_payment_attempt` aceptaba el CREATED y
-- `checkout.ts` sobrescribía `buy_order` y `provider_token`: el cobro anterior
-- quedaba sin rastro, la conciliación ya no podía consultarlo, y el cliente
-- pagaba dos veces.
--
-- Ahora no se abre un intento nuevo sobre un pago cuyo intento anterior pasó
-- por commit o figura autorizado. Reintentar tras abandonar el formulario —sin
-- commit— sigue permitido, como antes.
--
-- Riesgo que NO cierra, documentado en docs/TRANSBANK.md: si el cliente deja
-- abierta una pestaña de Webpay, reintenta en otra y después completa la
-- primera, el retorno de la primera trae un token que ya no está en la fila.
-- Cerrarlo exige guardar el historial de tokens por intento.
-- =============================================================================

create or replace function public.register_payment_attempt(
  p_payment_id  uuid,
  p_provider    text,
  p_environment text,
  p_buy_order   text,
  p_session_id  text,
  p_return_url  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  if v_payment.status not in ('PENDING', 'CREATED') then
    raise exception 'El pago está en % y no admite un intento nuevo', v_payment.status
      using errcode = 'check_violation';
  end if;

  -- El intento anterior ya pasó por commit, o el proveedor lo dio por
  -- autorizado, y aun así el pago no quedó asentado (el asiento falló después
  -- del commit). Abrir otro intento sobrescribiría el token de un cobro que
  -- pudo haberse hecho: quedaría sin rastro y el cliente pagaría dos veces. Ese
  -- pago lo cierra la conciliación, que consulta el token actual.
  if v_payment.committed_at is not null
     or upper(coalesce(v_payment.provider_status, '')) in ('AUTHORIZED', 'CAPTURED') then
    raise exception 'Tu pago anterior se está confirmando. Espera unos minutos antes de volver a pagar'
      using errcode = 'check_violation';
  end if;

  if p_environment not in ('integration', 'production', 'mock') then
    raise exception 'Ambiente de proveedor no reconocido: %', p_environment
      using errcode = 'invalid_parameter_value';
  end if;

  -- Un pago de integración y uno de producción no se mezclan nunca. Si el
  -- ambiente cambió a mitad de un intento vivo, eso es un error de
  -- configuración y no se resuelve en silencio.
  if v_payment.environment is not null and v_payment.environment <> p_environment then
    raise exception 'El pago se creó en el ambiente % y ahora se intenta en %',
      v_payment.environment, p_environment
      using errcode = 'check_violation';
  end if;

  update public.payments
     set provider      = p_provider,
         environment   = p_environment,
         buy_order     = p_buy_order,
         session_id    = coalesce(session_id, p_session_id),
         return_url    = p_return_url,
         attempt       = attempt + 1,
         status        = 'CREATED',
         updated_at    = now()
   where id = p_payment_id;

  insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
  values (
    p_payment_id, v_payment.status, 'CREATED', p_provider,
    jsonb_build_object(
      'operation', 'create',
      'environment', p_environment,
      'buy_order', p_buy_order,
      'attempt', v_payment.attempt + 1
    )
  );
end;
$$;


revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from public;
revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from anon;
revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from authenticated;
grant execute on function public.register_payment_attempt(uuid, text, text, text, text, text) to service_role;
