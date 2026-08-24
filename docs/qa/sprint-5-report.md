# QA adversarial — Sprint 5

**Fecha:** 2026-08-24
**Objetivo:** encontrar errores reales en la planificación semanal, los eventos y la persistencia de porciones confirmadas, con foco en **las costuras que después va a leer el ShoppingEngine**.
**Resultado:** 10 fallas encontradas, 10 corregidas. 205 pruebas verdes (183 antes + 22 nuevas de integración), `lint`, `typecheck` y `build` limpios, y las 23 secciones ejecutadas — incluidas §21 (móvil 320/375/430) y §22 (semana realista) contra la aplicación viva con las migraciones aplicadas.

El criterio para dar por probada una costura fue ejecutar contra PostgreSQL de verdad (PGlite, migraciones 0001–0008 + seeds), con `set role authenticated` y el claim del usuario puesto. Como `postgres` las políticas RLS ni se evalúan: una prueba de seguridad corrida como superusuario pasa siempre y no prueba nada.

---

## Las fallas

### F-1 · Una comida familiar suponía que comen todos — §2

**Gravedad: alta.** Es la falla que más plata cuesta.

`meal_assignments` no tenía forma de decir quién come. El sábado que Francisco tiene un cumpleaños afuera, la aplicación le calculaba porción igual y la sumaba al total a preparar. Ese total es el número que el ShoppingEngine va a convertir en lista de compras: 360 g de pollo cuando se van a cocinar 180, todas las semanas.

**Corrección** (ADR 0006, migración 0008): tabla `meal_assignment_participants` y función `public.meal_participants(assignment_id)`, donde **sin filas = comen todos los integrantes activos**. `confirm_meal_assignment` rechaza porciones de quien no participa en vez de guardarlas calladamente. En el tablero, cada comida muestra "Comen: todos" y se puede abrir para desmarcar a alguien.

**Prueba:** `qa-sprint5.test.ts` → "confirma bien con solo el participante, y el que come afuera no suma al total" verifica que el total quede en 180 g.

---

### F-2 · Reconfirmar pisaba en silencio una porción ya comida — §13

**Gravedad: alta.**

`serving_status` era `PLANNED | SERVED | SKIPPED`, y `confirm_meal_assignment` borraba e insertaba sin mirar el estado. Confirmar de nuevo el domingo por la noche reescribía lo que la familia había comido el sábado. El registro histórico pasaba a ser una ficción, y una ficción plausible es peor que un vacío.

**Corrección:** `serving_status` gana `CONSUMED` y `CANCELLED`. `confirm_meal_assignment` y `unconfirm_meal_assignment` fallan con mensaje explícito si alguna porción de esa comida está `SERVED` o `CONSUMED`. Las comparaciones van por `::text` a propósito: un valor de enum recién creado no puede usarse como literal en la misma transacción que lo creó.

**Prueba:** "una vez servida, reconfirmar falla en vez de pisar el registro" y "deshacer tampoco borra lo que ya se comió".

---

### F-3 · La estrategia de un evento era decorativa — §5

**Gravedad: alta.** No rompía nada; simplemente no hacía nada, que en un producto de alimentación es su propia forma de estar roto.

`event_strategy` se guardaba, se mostraba una etiqueta linda en el calendario, y el motor de porciones no la miraba nunca. Un asado marcado "con margen" producía exactamente la misma porción recortada que un martes cualquiera. La persona veía "porción reducida para cuadrar tus calorías" el día de su cumpleaños.

**Corrección:** `domain/nutrition/events.ts` la convierte en objetivos concretos, con dos límites duros:

- `RELAXED` ensancha el techo un 25% en la comida del evento; `LIGHTER_AROUND` aprieta un 10% las **otras** comidas del mismo día; `SKIP_TRACKING` deja la comida sin objetivos. Nunca por debajo del mínimo declarado: **un asado no se paga con un día de ayuno**.
- No se inventan bordes. Quien no declaró un máximo no recibe uno por relajar. Relajar un objetivo que no existe no significa nada.

Los eventos con `nutrition_event_members` afectan **solo a esas personas** (§3). Cuando hay varios el mismo día gana el más permisivo: nadie debería comer menos por tener dos motivos para celebrar.

**Prueba:** 16 pruebas en `domain/nutrition/events.test.ts`.

---

### F-4 · "Sin conteo ese día" no se podía expresar — §5

Descubierta al implementar F-3. `optimizePortion` recibía un `override` que se **mezclaba** con los objetivos del patrón. Un `override` vacío no borra nada: `{...patrón, ...{}}` devuelve el patrón intacto. Así, "hoy no hay objetivos" y "no cambio nada" se escribían exactamente igual, y `SKIP_TRACKING` no habría tenido efecto por más que se implementara.

**Corrección:** `optimizePortion` gana `resolvedTargets`, que **reemplaza** en vez de mezclar. Documentado en el propio tipo, porque la diferencia es sutil y se va a olvidar.

---

### F-5 · Cambiar un evento dejaba comidas confirmadas plausibles y equivocadas — §18

Agregar, mover o cancelar un evento no tocaba las comidas ya confirmadas de ese día ni avisaba que habían quedado desactualizadas.

**Corrección:** `meal_assignments` gana `needs_review` y `review_reason`; un trigger sobre `nutrition_events` marca las comidas confirmadas de esa fecha **sin tocar una sola porción**. Recalcular solo significaría cambiar en silencio números que alguien ya revisó y aprobó. La aplicación avisa, la persona decide.

También gana `confirm_count` y `last_confirmed_at` (§12): se puede ver que una comida se recalculó tres veces antes de servirse, y el outbox emite un evento por confirmación con `dedupe_key` distinto en vez de colapsarlas.

**Prueba:** "agregar un evento ese día deja la comida marcada y las porciones intactas" compara componente por componente antes y después. Además, un evento de OTRO hogar no marca nada acá.

---

### F-6 · El tablero solo dejaba planificar cuatro comidas — §1

La base soporta los ocho tipos desde el Sprint 3. El tablero mostraba cuatro. Una once con postre terminaba escrita como "otra cosa", o simplemente no se planificaba — y lo que no se planifica no se compra.

**Corrección:** postre, snack, fruta y otro aparecen bajo "+ Postre, snack, fruta u otra comida", y quedan visibles solos los días que ya los tienen.

**Prueba:** "acepta postre, snack, fruta y otro en el mismo día, uno de cada tipo", y que dos del mismo tipo choquen a propósito.

---

### F-7 · `FRUIT` existía en la base y no en el dominio — §1

La migración 0005 agregó `FRUIT` al enum `meal_type`. La unión `MealType` de TypeScript se quedó con siete valores. La base aceptaba una comida que el dominio no sabía nombrar: habría llegado a la pantalla como texto crudo, sin etiqueta.

**Corrección:** `FRUIT` agregado a `MEAL_TYPES` y a `MEAL_TYPE_LABELS`.

---

### F-8 · Cuatro lecturas del Sprint 5 se casteaban en vez de validarse — §6, §20

El *preflight* del Sprint 5 sacó los `as unknown as` de la capa de datos, pero quedaron cuatro puntos fuera de ella:

| Dónde | Qué pasaba |
|---|---|
| `confirmMeal` | `weekly_plan_days as unknown` para sacar `plan_date`. Es una columna **DATE-only**: si llegara como `Date`, la porción quedaba guardada con la fecha corrida un día. |
| `confirmMeal` y `/recipes/[id]/family` | La ficha nutricional de cada alternativa se leía con `as never` — el dato que decide la nutrición de un reemplazo aceptado. Una fila con otra forma se convertía en una porción con números inventados. **La misma lógica estaba copiada en las dos pantallas.** |
| `/plan/comida/[id]` | Dos embeds casteados: sin fecha ni nombre de receta la pantalla se habría mostrado vacía en vez de fallar. |
| `loadUpcomingOverrides` | `plan_date` sin normalizar y el embed casteado. |

**Corrección:** todo pasa por Zod con `dateString` para las fechas. La lectura de alternativas duplicada se extrajo a `loadAlternativesWithFacts()` en `app/recipes/queries.ts`: una sola lectura validada que comparten las dos pantallas. Dos copias de la misma lectura sin validar es el lugar exacto donde el Sprint 4 perdió las preferencias.

Además, dos `await supabase…` en `setMealParticipants` ignoraban su error. Si esa limpieza falla quedan guardadas porciones de gente que ya no come — justo lo que F-1 vino a arreglar. Ahora lanzan.

---

## Lo que se probó y estaba bien

| Área | Veredicto |
|---|---|
| §1 · Un día admite uno de cada tipo de comida, sin columnas por tipo | Correcto en la base desde el Sprint 3 (`unique (day_id, meal_type)`). El límite era de pantalla → F-6 |
| §3 · Un evento puede afectar a una sola persona | `nutrition_event_members` ya existía; le faltaba efecto → F-3 |
| §6 · Los valores DATE-only viven como `YYYY-MM-DD` | El schema `dateString` y toda la aritmética de `calendar.ts` evitan `Date`. La comparación de rangos de evento es lexicográfica sobre strings, a propósito. Cuatro fugas encontradas → F-8 |
| §7 · Bordes de semana | La semana va de lunes a domingo, `ensure_weekly_plan` es idempotente y dos semanas seguidas no comparten días. Verificado leyendo las fechas con el mismo schema que usa la aplicación |
| §12 · Reconfirmar es rastreable | Faltaba → resuelto en F-5 (`confirm_count`, un evento de outbox por confirmación) |
| §19 · RLS con rol `authenticated` | Verificado sobre las tablas nuevas: desde el hogar B no se leen los participantes, las porciones ni los eventos del hogar A, y tampoco se pueden insertar comensales en una comida ajena |

---

## §21 y §22 — ejecutados en vivo

Con las migraciones **0007 + 0008 ya aplicadas** en el Supabase del proyecto (verificado por API: las siete tablas nuevas responden 200), se armó la semana del 31 de agosto al 6 de septiembre en la aplicación real, con la familia de demostración (Casa, Paula, Sebastián, Constanza, Ricardo):

- **7 almuerzos planificados** con recetas publicadas distintas (pollo, lentejas, merluza ×2, pasta, carne).
- **Ricardo excluido del sábado** desde la fila "Comen:". La comida confirmó con **4 porciones, no 5**, y en "SE PREPARÓ" la merluza suma 1.146 g repartidos por método — 400 g frito (Sebastián), 400 g al horno (Paula y Constanza), 346 g guisado (Casa) — sin un gramo para quien no está. Es el número exacto que va a leer el ShoppingEngine.
- **Asado agregado el sábado** con estrategia "con margen": el almuerzo ya confirmado quedó marcado **revisar** con el aviso "Se agregó un evento ese día. Las porciones guardadas quedaron como estaban" — y las cantidades guardadas no se movieron.
- **"Ver lo guardado"** muestra quiénes comieron, el aviso de revisión, las versiones exactas (optimizador, perfil y receta) de cada porción y los totales por método.
- **Sin desborde horizontal en 320, 375 ni 430 px** (`scrollWidth == clientWidth` en las tres). En 320 px la barra de navegación desbordaba la página: se corrigió con scroll interno de la propia barra.

Dos hallazgos más salieron de esta pasada en vivo:

### F-9 · Una familia recién creada no podía confirmar ninguna comida

`confirmMeal` exigía que las cinco personas tuvieran un snapshot de perfil publicado, y el snapshot solo se publicaba al guardar algo en la ficha. Una familia nueva — exactamente el estado de la demo — no podía confirmar **nada** hasta abrir las cinco fichas una por una.

**Corrección:** al confirmar, se publica el snapshot de quien no lo tenga (`publishProfileSnapshot`, compartido con las acciones de la ficha). Un perfil sin objetivos es un perfil válido: dice "esta persona no lleva conteo". El RPC deduplica por firma, así que confirmar de nuevo no crea versiones de más.

### F-10 · "Falta publicar el perfil de algún integrante" no decía cuál

Con cinco personas, ese mensaje obliga a abrir las cinco fichas para adivinar. Ahora el error nombra a las personas. Quedó como mensaje de error real solo para el caso en que la publicación automática de F-9 falle.

---

## Archivos

**Nuevos**

- `supabase/migrations/0008_participants_and_serving_lifecycle.sql`
- `web/src/domain/nutrition/events.ts` + `events.test.ts` (16 pruebas)
- `web/src/integration/qa-sprint5.test.ts` (22 pruebas)
- `docs/adr/0006-participantes-y-ciclo-de-vida-de-la-porcion.md`

**Nuevos (segunda pasada)**

- `web/src/app/family/profile-publish.ts` — `publishProfileSnapshot` compartido

**Modificados**

- `web/src/domain/portions/optimizer.ts` · `family.ts` — `resolvedTargets`
- `web/src/domain/recipes/types.ts` — `FRUIT`
- `web/src/app/plan/{queries,actions,WeekBoard,page}.tsx` y `comida/[assignmentId]/page.tsx`
- `web/src/app/recipes/queries.ts` — `loadAlternativesWithFacts()`
- `web/src/app/recipes/[id]/family/page.tsx` · `web/src/app/family/nutrition-queries.ts`
- `web/src/integration/harness.ts` — migración 0008
- `web/src/components/AppNav.tsx` — scroll interno en 320 px
- `web/src/app/family/nutrition-actions.ts` — delega en `publishProfileSnapshot`
