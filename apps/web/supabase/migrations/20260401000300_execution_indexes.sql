-- =============================================================================
-- HagoTuFila · Bloque 3 · 300 · Índices de las claves foráneas nuevas
-- =============================================================================
-- El advisor de rendimiento de Supabase señaló tres claves foráneas sin índice
-- que cubre, todas de la tabla nueva `assignment_check_ins`. Dos de ellas se
-- usan de verdad en consultas: `worker_id` es la columna de su política de RLS
-- («el trabajador ve las suyas»), y `job_id` es por donde el panel interno cruza
-- una llegada con su trabajo. La tercera, `reviewed_by`, la necesita PostgreSQL
-- al borrar un perfil para comprobar la referencia.
--
-- Va en su propia migración porque la …000100 ya está aplicada en el proyecto
-- alojado: una migración aplicada no se reescribe, se corrige con la siguiente.
--
-- Los demás avisos de este tipo son de la Etapa 1 y siguen agrupados en la hoja
-- de ruta: tocan tablas con datos y van en su propia tanda.
-- =============================================================================

create index if not exists assignment_check_ins_worker_idx
  on public.assignment_check_ins (worker_id, occurred_at desc);

create index if not exists assignment_check_ins_job_idx
  on public.assignment_check_ins (job_id);

create index if not exists assignment_check_ins_reviewer_idx
  on public.assignment_check_ins (reviewed_by)
  where reviewed_by is not null;
