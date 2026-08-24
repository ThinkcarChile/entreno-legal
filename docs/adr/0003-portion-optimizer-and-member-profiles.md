# 0003 — Perfiles nutricionales y PortionOptimizer

- Estado: APROBADO (implementado en Sprint 4)
- Fecha: 2026-08-24
- Decisión de baseline afectada: desarrolla K-3 (perfil versionado), K-25 (tracking OFF/BASIC/FULL) y §E-2 (PortionOptimizer). No modifica la baseline: precisa cómo se implementan.

## Contexto

Sprint 3 dejó una receta que se explica sola. Sprint 4 tiene que responder otra pregunta: si esta familia come este plato, ¿cuánto se sirve cada persona? Eso obliga a decidir cinco cosas que tocan invariantes de dominio.

---

## 1. Los objetivos por comida viven en `nutrition_goals`, no en una tabla aparte

**Decisión**: un objetivo de almuerzo es una fila de `nutrition_goals` con `scope = 'PER_MEAL'` y `meal_type = 'LUNCH'`. `meal_pattern_slots` guarda solo lo que no es un número: si la comida está habilitada, si es la primera del día, y la preferencia de ensalada.

**Por qué**: el prompt del sprint pedía un `MemberMealPreference` con `energy_min`, `protein_max`, etc., y a la vez advertía "no duplicar información". Duplicar los rangos en dos tablas obligaría a decidir cuál gana cada vez que difieren — y algún día van a diferir. Los objetivos ya tienen rango, vigencia, prioridad, origen e historial; un objetivo de comida es un objetivo con ámbito, no una entidad nueva.

**Consecuencia**: el historial de "cuánta proteína quería en el almuerzo en septiembre" sale gratis, porque la tabla de objetivos **es** el historial: nada se actualiza en destructivo, se marca `SUPERSEDED` y se inserta la fila nueva.

---

## 2. La grasa añadida es una preferencia propia, y detectarla exige tres condiciones

**Decisión**: `member_added_fat_preferences` (AVOID / ALLOWED / PREFERRED) es una tabla aparte de las preferencias de cocción. Y un componente cuenta como grasa añadida solo si cumple **las tres**: está en un slot `FAT`, es opcional, y **al menos el 70 % de su energía viene de la grasa**.

**Por qué la tercera condición**: se descubrió probando. El aliño de la ensalada chilena es un slot `FAT` que contiene aceite **y limón**. Con la regla de dos condiciones, a quien evita la grasa añadida se le quitaba también el limón. Quitar el aceite es respetar su configuración; quitar el limón es una arbitrariedad que nadie pidió.

**Consecuencia**: freír no cuesta lo mismo que air fryer sin aceite, y esa diferencia pertenece a la porción de esa persona (§35). No se estima absorción de fritura: no hay dato, y no se inventa.

---

## 3. El perfil es un snapshot con huella, y esa huella gobierna el recálculo

**Decisión**: `member_nutrition_profiles` guarda una versión inmutable con `input_signature`, un hash estable de todas sus entradas. `publish_nutrition_profile` compara la huella: si no cambió, devuelve el perfil vigente sin versionar nada.

**Por qué**: §17 pide recalcular a Sebastián sin tocar a Ricardo, Paula, Francisco ni Constanza. Con una huella determinista eso es trivial y demostrable: el hash se calcula sobre JSON con claves ordenadas, así que el orden en que la base devuelva las filas no puede cambiar el resultado.

**Refuerzo en la base**: un trigger rechaza reescribir los objetivos o la huella de un snapshot ya publicado, y el cambio emite `NUTRITION_PROFILE_CHANGED` al outbox con `dedupe_key` (K-22): reintentar no produce doble efecto.

---

## 4. El optimizador es determinista, escalonado y prefiere admitir que no puede

**Decisión**: `optimizePortion` no es un solver. Es una secuencia fija: porción estándar → restricciones HARD → preparación y grasa añadida → ensalada preferida → proteína hacia el rango → techo de calorías. Mismo input, mismo output, sin IA (§47).

**El orden de recorte importa** (§26): grasas opcionales, salsas, toppings, endulzantes, carbohidrato, base, otros, fruta, **proteína**, y al final verduras y ensalada. No se le quita la ensalada a alguien para cuadrar un número.

**Cuando no se puede, se dice**: si el mínimo de proteína no cabe bajo el máximo de calorías, el resultado es `TARGET_CONFLICT` con la explicación, no una porción inventada que parezca correcta (§27).

**Explicabilidad estructurada**: cada cambio produce un `reason_code` + parámetros + texto compuesto. Nunca texto libre: así se puede traducir, filtrar y auditar sin volver a parsear frases.

---

## 5. Un componente declara hasta dónde se lo puede mover

**Decisión**: `meal_slot_components` gana `adjustability` (FIXED / ADJUSTABLE / OPTIONAL), `min_quantity` y `max_quantity`. Un CHECK garantiza que **todo componente opcional es OPTIONAL**.

**Por qué el CHECK**: sin él, un aceite marcado opcional podía quedar como ADJUSTABLE, y entonces el optimizador no tenía permiso para sacarlo del plato de quien evita la grasa añadida. La regla vivía en el seed y en el RPC; ahora vive en la base, que es donde no se olvida.

**Sin límites declarados** se usa un margen conservador (0,5× a 2× la porción base) y se **anota la falta** en las razones (§29): el motor no se inventa autorización, avisa que no la tiene.

---

## Alternativas descartadas

- **Un optimizador matemático** (programación lineal sobre los slots): resuelve mejor casos difíciles y explica peor. §31 exige poder decir *por qué* subió el pollo; una función objetivo no lo dice en castellano.
- **Guardar la nutrición de cada porción como fuente**: se recalcula desde el snapshot del perfil y la versión de la receta, ambos inmutables, así que la porción es reproducible. Persistirla como verdad crearía una tercera copia que puede desincronizarse.
- **Tratar `tracking OFF` como "objetivos en cero"**: es la trampa que produce "te quedan 0 kcal" (§10). OFF significa *sin presupuesto*, no *presupuesto agotado*: `hasAnyTarget` distingue ambos y la interfaz nunca muestra macros a quien no los pidió.
