-- =============================================================================
-- HagoTuFila · Nadie publica avisos del sistema desde su sesión
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y reproducido sobre la base: la política
-- `messages_insert` exigía que el remitente fuera quien llama y que participara
-- en la conversación, pero nada sobre el TIPO de mensaje, y `message_type`
-- estaba entre las columnas concedidas. Un participante podía, con su sesión y
-- la clave pública:
--
--   POST /rest/v1/messages
--   { conversation_id, sender_id: <yo>, message_type: 'SYSTEM',
--     body: 'HagoTuFila: el pago quedó retenido. Para liberarlo transfiere
--            $15.000 a la cuenta 123.' }
--
-- y el otro lo veía con el aspecto de un aviso oficial. Un vector de fraude
-- directo, también a ojos de la administración al revisar una disputa.
--
-- Ahora, desde una sesión de usuario, solo se escriben mensajes de texto. Los
-- avisos del sistema los siguen escribiendo las funciones de la base
-- (`mark_on_the_way`, `on_payment_paid`, …), que no pasan por esta política.
-- No se restringe el remitente de los avisos: algunos legítimos lo llevan
-- (`mark_on_the_way` firma con el trabajador).
--
-- Las imágenes en el chat todavía no están conectadas; cuando lo estén, entran
-- por una función que valide el archivo, no por un INSERT directo.
-- =============================================================================

drop policy if exists messages_insert on public.messages;

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and message_type = 'TEXT'
    and exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and (c.client_id = auth.uid() or c.worker_id = auth.uid())
    )
  );
