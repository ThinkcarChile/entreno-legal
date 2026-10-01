-- =============================================================================
-- HagoTuFila · El título del trabajo y el motivo de cancelación, validados
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría cruzada y reproducido sobre la base:
-- 20260601001120 cerró la suplantación por el nombre —«HagoTuFila: tu pago fue
-- rechazado, entra a pagos-htf.cl» leído como aviso de la plataforma— y dejó
-- abiertos los otros dos textos que escribe una persona y que la base mete en
-- los avisos de la contraparte:
--
--   · el título del trabajo, entre comillas dobles en una docena de avisos:
--     «Te seleccionaron para "<título>"», «El cliente actualizó "<título>"»
--     —que va a cada trabajador con oferta pendiente—, «Recibiste una oferta
--     … para "<título>"». Solo tenía un largo de 10 a 120. Con una comilla
--     dentro, el título cerraba la cita:
--
--       Fila". HagoTuFila: verifica tu cuenta para cobrar en htf-pagos.cl o se bloquea. "OK
--
--     y el aviso se leía como dos frases, la segunda de la plataforma;
--   · el motivo de cancelación, sin ninguna regla: `finalize_job_cancellation`
--     le añade « Motivo: <motivo>» al aviso del trabajador. Se aceptaron 5.000
--     caracteres con saltos de línea y una dirección web.
--
-- Ahora los dos siguen la regla de los nombres, sin la parte de los espacios:
-- sin caracteres de control ni invisibles (saltos de línea incluidos), sin
-- comillas dobles, angulares ni tipográficas —el apóstrofo sí—, sin direcciones
-- web ni correos, y sin «HagoTuFila». El título, hasta 120 caracteres, como ya
-- era; el motivo, hasta 300, lo que ya admitía el formulario.
--
-- Va en restricciones CHECK y no dentro de `publish_job`, `update_open_job` y
-- `cancel_job`: así vale para cualquier camino de escritura —las RPC, la clave
-- de servicio, una función futura— sin reescribir funciones que no son de este
-- cambio. El precio es el mensaje: quien llama a la RPC directamente recibe
-- una violación de restricción, no el motivo en palabras. La aplicación
-- valida lo mismo antes de enviar (src/lib/validation/free-text.ts) y muestra
-- el motivo.
--
-- Datos existentes: las restricciones se crean NOT VALID —desde ya valen para
-- toda fila nueva o modificada—, se limpian las filas que no cumplen y después
-- se validan. Limpiar es cambiar los caracteres prohibidos por espacios; si
-- aun así no cumple (una dirección web, «HagoTuFila»), el título pasa a
-- «Trabajo <referencia>» y el motivo se borra. El disparador de auditoría de
-- `jobs` y `assignments` guarda el valor anterior en `audit_logs`.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La regla, en un solo lugar
-- -----------------------------------------------------------------------------
-- Los mismos rangos que `person_name_problem`. NULL es válido: el motivo es
-- opcional, y el título ya tiene su `not null`.
create or replace function app_private.free_text_problem(p_text text, p_label text, p_max integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_text is null
      then null
    when char_length(p_text) > p_max
      then p_label || ' admite hasta ' || p_max || ' caracteres.'
    when p_text ~ '[\x01-\x1f\x7f-\x9f\u00a0\u00ad\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]'
      then p_label || ' no puede tener saltos de línea, tabulaciones ni caracteres invisibles.'
    -- Las comillas que delimitan el texto en los avisos: dobles para el
    -- título, angulares para los nombres. El apóstrofo sí se admite.
    when p_text ~ '["«»‹›“”„‟〝〞＂]'
      then p_label || ' no puede incluir comillas.'
    when p_text ~* '(://|www\.|@|[a-z0-9-]\.[a-z]{2,})'
      then p_label || ' no puede incluir direcciones web ni correos.'
    when lower(p_text) like '%hagotufila%'
      then p_label || ' no puede incluir «HagoTuFila».'
  end;
$$;

comment on function app_private.free_text_problem(text, text, integer) is
  'NULL si el texto libre (título del trabajo, motivo de cancelación) es válido; si no, el motivo en palabras. Misma regla que src/lib/validation/free-text.ts.';

-- Lo que hace esta migración con un texto existente que no cumple: cambia los
-- caracteres prohibidos por espacios y recorta. Puede seguir sin cumplir (una
-- dirección web): eso lo decide quien la llama.
create or replace function app_private.clean_free_text(p_text text, p_max integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(btrim(left(btrim(regexp_replace(
           regexp_replace(regexp_replace(coalesce(p_text, ''),
             '[\x01-\x1f\x7f-\x9f\u00a0\u00ad\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]',
             ' ', 'g'),
             '["«»‹›“”„‟〝〞＂]', ' ', 'g'),
           ' {2,}', ' ', 'g')), p_max)), '');
$$;

-- La primera la evalúan las restricciones CHECK, con los privilegios de quien
-- escribe la fila (como `person_name_problem`). La segunda solo la usa esta
-- migración.
revoke all on function app_private.free_text_problem(text, text, integer) from public, anon;
grant execute on function app_private.free_text_problem(text, text, integer) to authenticated, service_role;
revoke all on function app_private.clean_free_text(text, integer) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. Las restricciones, sin validar todavía
-- -----------------------------------------------------------------------------
alter table public.jobs
  add constraint jobs_title_free_text
    check (app_private.free_text_problem(title, 'El título', 120) is null) not valid,
  add constraint jobs_cancellation_reason_free_text
    check (app_private.free_text_problem(cancellation_reason, 'El motivo', 300) is null) not valid;

alter table public.assignments
  add constraint assignments_cancellation_reason_free_text
    check (app_private.free_text_problem(cancellation_reason, 'El motivo', 300) is null) not valid;


-- -----------------------------------------------------------------------------
-- 3. Datos existentes
-- -----------------------------------------------------------------------------
-- El título no puede quedar vacío ni por debajo de 10 caracteres: si limpiarlo
-- no basta, se usa la referencia del trabajo, que la genera la base.
--
-- Título y motivo del trabajo en UNA sola actualización: las dos restricciones
-- ya valen para toda fila que se escribe, aunque estén sin validar. Limpiar
-- primero el título de un trabajo cuyo motivo también está sucio escribía una
-- fila que violaba la restricción del motivo, y la migración entera fallaba.
-- Cada columna se reescribe solo si no cumple; si cumple, queda igual.
update public.jobs j
   set title = case
         when app_private.free_text_problem(j.title, 'El título', 120) is null
           then j.title
         when char_length(coalesce(c.titulo, '')) >= 10
              and app_private.free_text_problem(c.titulo, 'El título', 120) is null
           then c.titulo
         else 'Trabajo ' || j.reference
       end,
       cancellation_reason = case
         when app_private.free_text_problem(j.cancellation_reason, 'El motivo', 300) is null
           then j.cancellation_reason
         when app_private.free_text_problem(c.motivo, 'El motivo', 300) is null
           then c.motivo
       end
  from (select id,
               app_private.clean_free_text(title, 120) as titulo,
               app_private.clean_free_text(cancellation_reason, 300) as motivo
          from public.jobs) c
 where c.id = j.id
   and (app_private.free_text_problem(j.title, 'El título', 120) is not null
        or app_private.free_text_problem(j.cancellation_reason, 'El motivo', 300) is not null);

update public.assignments a
   set cancellation_reason = case
         when app_private.free_text_problem(c.limpio, 'El motivo', 300) is null then c.limpio
       end
  from (select id, app_private.clean_free_text(cancellation_reason, 300) as limpio
          from public.assignments where cancellation_reason is not null) c
 where c.id = a.id
   and app_private.free_text_problem(a.cancellation_reason, 'El motivo', 300) is not null;


-- -----------------------------------------------------------------------------
-- 4. Ahora sí, validadas
-- -----------------------------------------------------------------------------
alter table public.jobs validate constraint jobs_title_free_text;
alter table public.jobs validate constraint jobs_cancellation_reason_free_text;
alter table public.assignments validate constraint assignments_cancellation_reason_free_text;

comment on constraint jobs_title_free_text on public.jobs is
  'El título entra entre comillas en los avisos: sin comillas, saltos de línea, direcciones web ni «HagoTuFila» (app_private.free_text_problem).';
comment on constraint jobs_cancellation_reason_free_text on public.jobs is
  'El motivo entra en el aviso de cancelación al trabajador: hasta 300 caracteres, misma regla que el título.';
