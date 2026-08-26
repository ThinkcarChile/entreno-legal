-- 0032 — Faltaba la olla a presión en el catálogo de equipos.
--
-- HALLAZGO (Sprint 11.5, al cargar porotos con riendas, garbanzos y carne
-- mechada): `equipment_capabilities` traía diez códigos desde la 0003 y ninguno
-- representa una olla a presión.
--
-- No es un detalle cosmético. En la cocina chilena de todos los días, la olla a
-- presión es la diferencia entre 60 y 25 minutos en cualquier legumbre seca, y
-- entre una carne mechada de domingo y una de día de semana. Sin el código, la
-- receta tenía dos salidas y las dos malas:
--
--   a) mapearla a 'POT' — decir que una olla común es una olla a presión;
--   b) borrar el paso — esconderle a quien SÍ la tiene que puede usarla.
--
-- Se agrega el código. Es aditivo: ninguna fila existente cambia, y las recetas
-- que ya estaban siguen sin referenciarlo.
--
-- Nota de diseño que se mantiene: la capacidad entra como OPCIONAL, nunca como
-- requerida. Toda receta de la biblioteca que la menciona trae su alternativa
-- manual, porque nadie se queda afuera de un plato de porotos por no tener una
-- olla a presión.

insert into public.equipment_capabilities (code, name)
values ('PRESSURE_COOKER', 'Olla a presión')
on conflict (code) do nothing;
