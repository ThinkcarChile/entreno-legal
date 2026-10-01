-- =============================================================================
-- HagoTuFila · El token de Webpay no se lee con una sesión de usuario
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado sobre la base: `payments`
-- tenía SELECT de tabla completa para `authenticated`, y la política deja leer
-- la fila al cliente y al trabajador de la asignación. Cualquiera de los dos
-- podía pedir por REST `provider_token` —el token de la transacción en Webpay—
-- además de la URL y la sesión del intento. El propio código lo trata como
-- secreto operativo: la vista `admin_payments` lo excluye a propósito y el
-- servidor lo lee con la clave de servicio.
--
-- Se retira el SELECT de tabla y se concede columna por columna todo lo demás.
-- (Revocar solo esas columnas no tendría efecto: en PostgreSQL un privilegio de
-- tabla cubre todas las columnas aunque se revoque una.)
--
-- Nada se rompe: ninguna lectura con sesión de usuario pide esas columnas
-- (`PAYMENT_COLUMNS` en src/lib/data/supabase/shared.ts) y ninguna vista las
-- usa. Las lecturas que sí las necesitan van con la clave de servicio.
--
-- Riesgo que esto NO cierra: el trabajador de la asignación sigue pudiendo leer
-- los últimos 4 dígitos y el código de autorización del pago del cliente.
-- Retirarlos por columna rompería `admin_payments`, que corre con los
-- privilegios de quien consulta; cerrarlo bien exige separar la lectura del
-- trabajador (solo el estado) de la fila completa.
-- =============================================================================

do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'payments'
     and column_name not in ('provider_token', 'redirect_url', 'session_id', 'return_url');

  revoke select on public.payments from authenticated, anon;
  execute format('grant select (%s) on public.payments to authenticated', v_cols);
end $$;
