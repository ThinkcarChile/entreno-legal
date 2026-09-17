-- =============================================================================
-- HagoTuFila · Etapa 2 · 600 · El cliente no escribe sobre las ofertas
-- =============================================================================
-- Defecto encontrado al escribir las pruebas de esta etapa.
--
-- La Etapa 1 dejó una política `job_offers_update_client` que permitía al dueño
-- del trabajo actualizar cualquier fila de `job_offers` de ese trabajo. La
-- intención era que pudiera aceptarlas o rechazarlas, pero el permiso es de
-- fila completa: también podía reescribir el precio propuesto por el trabajador.
--
-- Ya no hace falta: aceptar y rechazar pasan por `accept_job_offer`, que es
-- SECURITY DEFINER y valida quién llama. El cliente se queda solo con lectura.
-- =============================================================================

drop policy if exists job_offers_update_client on public.job_offers;

-- Refuerzo por privilegio de columna: ni siquiera el trabajador puede tocar el
-- importe de una oferta ya enviada. Para cambiar de precio, la retira y envía
-- otra, que es además lo honesto de cara al cliente.
revoke update on public.job_offers from authenticated;
grant update (message, estimated_arrival_at, status, responded_at, updated_at)
  on public.job_offers to authenticated;

comment on policy job_offers_update_worker on public.job_offers is
  'El trabajador ajusta el mensaje y la hora de llegada de su propia oferta. El precio es inmutable.';
