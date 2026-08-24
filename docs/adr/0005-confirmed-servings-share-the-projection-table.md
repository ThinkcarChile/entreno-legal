# 0005 — La porción confirmada es la misma proyección, con asignación

- Estado: APROBADO (implementado en Sprint 5)
- Fecha: 2026-08-24
- Decisión de baseline afectada: precisa Sprint 0 §C-6 (`member_servings` + `member_serving_slots`). No cambia el modelo conceptual: cambia dónde vive.

## Contexto

§C-6 define `member_servings` como tabla propia: la porción final por persona, con su nivel de adaptación, cantidades por slot, estado, versión de perfil y explicaciones.

El Sprint 4 ya creó `member_serving_projections` + `member_serving_components` con exactamente esa forma — cantidades base y propuesta, método, grasa añadida, nutrición, completitud, razones, `fit`, nivel de adaptación, y las versiones de receta, perfil y optimizador. Nació sin vínculo a una comida porque en ese sprint no existía la semana.

Quedaban dos caminos: crear `member_servings` como tabla nueva casi idéntica, o darle a la que ya existe lo único que le faltaba.

## Decisión

`member_serving_projections` gana `assignment_id` (nullable) y `status` (`PLANNED` / `SERVED` / `SKIPPED`). El vínculo define qué es la fila:

- **`assignment_id` NULL** — proyección efímera de "ver porciones para mi familia". No se guarda: la pantalla calcula y muestra.
- **`assignment_id` con valor** — **porción confirmada** dentro de una semana, persistida con todas sus versiones de entrada.

Un índice único parcial sobre `(assignment_id, member_id)` garantiza una sola porción por persona y comida: confirmar dos veces reemplaza, no duplica.

Los reemplazos aceptados salen de la URL y pasan a `member_serving_substitutions`, con quién los aceptó y cuándo.

## Por qué

Dos tablas con las mismas dieciséis columnas se desincronizan. En cuanto el motor gane un campo — y va a ganarlo, el clínico llega en el Sprint 11 — habría que acordarse de agregarlo en las dos. La diferencia real entre una proyección y una porción confirmada no es su forma: es si alguien dijo "esto es lo que vamos a comer". Eso es un vínculo, no un esquema aparte.

Además evita una copia: al confirmar no se traduce de una tabla a otra, se escribe una vez. Menos traducción es menos lugar donde perder un dato — que es exactamente cómo se perdieron las preferencias en el Sprint 4.

## Consecuencias

- `confirm_meal_assignment(assignment_id, servings)` persiste porciones, componentes y sustituciones en una sola transacción, marca la comida como `CONFIRMED` y deja evento en el outbox con `dedupe_key`.
- `unconfirm_meal_assignment` borra las porciones y devuelve la comida a `PLANNED`. Una comida tiene una sola verdad.
- La pantalla "ver porciones" sigue **sin persistir nada**: recalcula al vuelo. Guardar cada exploración llenaría la tabla de cálculos que nadie pidió.
- `member_serving_slots` de §C-6 no se implementa por separado: `member_serving_components` cumple ese rol.

## Alternativas descartadas

- **Tabla `member_servings` aparte, copiando desde la proyección al confirmar**: fiel al documento, con el costo de mantener dos esquemas iguales y un traductor entre ellos.
- **Persistir toda proyección y marcar cuál fue confirmada**: convierte cada apertura de "ver porciones" en escritura. La pantalla es exploratoria; escribir en una lectura es una sorpresa desagradable y ensucia la auditoría con ruido.
