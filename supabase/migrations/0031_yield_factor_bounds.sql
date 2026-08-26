-- 0031 — El rendimiento crudo→cocido podía llegar hasta 2, y eso es falso.
--
-- HALLAZGO (Sprint 11.5, al cargar la biblioteca chilena):
--
-- `meal_slot_components.yield_factor` y `meal_template_versions.total_yield_factor`
-- traían `check (... <= 2)` desde la migración 0003. La misma cota estaba
-- espejada en Zod (`web/src/domain/recipes/schemas.ts`).
--
-- La cota es incorrecta para toda una familia de alimentos: los que absorben
-- agua al cocerse.
--
--   arroz blanco      100 g crudo → ~250 g cocido   (2,5)
--   fideos            100 g crudo → ~240 g cocidos  (2,4)
--   porotos secos     100 g secos → ~240 g cocidos  (2,4)
--   garbanzos secos   100 g secos → ~240 g cocidos  (2,4)
--
-- O sea: el `<= 2` no era una barrera contra datos absurdos, era una
-- afirmación falsa sobre la cocina. Con esa cota, la única forma de cargar
-- arroz era mentir (poner 2) o declarar el rendimiento como desconocido — y
-- ninguna de las dos es aceptable cuando el dato SÍ se conoce.
--
-- CORRECCIÓN: se sube la cota a 5. Sigue siendo una barrera real contra el
-- error de tipeo (un 25 o un 250 se rechazan igual), pero deja de negar un
-- hecho físico. No se toca ningún dato existente: es solo ensanchar el rango
-- permitido, así que ninguna fila cargada hasta hoy cambia de validez.
--
-- Lo que NO cambia: `> 0` sigue firme, y NULL sigue significando DESCONOCIDO.
-- Un rendimiento ausente jamás se rellena con 1.

alter table public.meal_slot_components
  drop constraint if exists meal_slot_components_yield_factor_check;

alter table public.meal_slot_components
  add constraint meal_slot_components_yield_factor_check
  check (yield_factor > 0 and yield_factor <= 5);

alter table public.meal_template_versions
  drop constraint if exists meal_template_versions_total_yield_factor_check;

alter table public.meal_template_versions
  add constraint meal_template_versions_total_yield_factor_check
  check (total_yield_factor > 0 and total_yield_factor <= 5);

comment on column public.meal_slot_components.yield_factor is
  'Rendimiento crudo->cocido de ESTE componente. NULL = DESCONOCIDO, nunca 1 por '
  'defecto. Rango 0 < f <= 5: los granos y legumbres secas superan el 2 (arroz 2,5).';
