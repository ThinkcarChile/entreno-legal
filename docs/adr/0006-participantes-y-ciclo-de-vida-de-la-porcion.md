# 0006 — Participantes por comida y ciclo de vida de una porción

- Estado: APROBADO (implementado en el QA adversarial del Sprint 5)
- Fecha: 2026-08-24
- Decisión de baseline afectada: precisa §C-5 (`MealAssignment`) y §C-6 (porción por persona). No cambia el modelo conceptual.
- Migración: `supabase/migrations/0008_participants_and_serving_lifecycle.sql`

## Contexto

El QA adversarial del Sprint 5 buscaba errores en las costuras que después va a leer el ShoppingEngine. Encontró tres, y los tres son del mismo tipo: el modelo suponía un caso ideal que la vida familiar no cumple.

**Una comida familiar no siempre la comen todos.** `meal_assignments` no tenía forma de decir quién come. El sábado que Francisco tiene un cumpleaños afuera, la aplicación le calculaba porción igual y la sumaba al total a preparar. Ese total es exactamente lo que el ShoppingEngine va a convertir en lista de compras: comprar 360 g de pollo cuando se van a cocinar 180 no es un número mal redondeado, es comida a la basura todas las semanas.

**Una porción ya comida no puede reescribirse.** `serving_status` tenía `PLANNED`, `SERVED` y `SKIPPED`, pero `confirm_meal_assignment` borraba e insertaba sin mirar el estado. Confirmar de nuevo el domingo por la noche pisaba en silencio lo que la familia había comido el sábado, y el registro histórico pasaba a ser una ficción.

**Cambiar un evento no dejaba rastro.** Agregar un asado el sábado no tocaba las comidas ya confirmadas de ese día ni avisaba que habían quedado desactualizadas. Quedaban plausibles y equivocadas, que es peor que quedar vacías.

## Decisión

### Participantes: la ausencia de filas significa "todos"

Tabla nueva `meal_assignment_participants (assignment_id, member_id)` y función `public.meal_participants(assignment_id)` que resuelve el caso normal.

**Sin filas = comen todos los integrantes activos.** Con filas = comen exactamente esas personas.

Es la diferencia entre escribir cinco filas por cada almuerzo de cada día de cada semana — treinta y cinco filas semanales que dicen lo obvio — y escribir una sola el sábado que alguien no está. El caso normal no paga nada, y el caso raro se expresa sin ambigüedad.

`confirm_meal_assignment` valida contra esa función: mandar la porción de alguien que no participa es un error, no un dato que se guarda callado.

### Ciclo de vida: `PLANNED → SERVED/CONSUMED` es de una sola vía

`serving_status` gana `CONSUMED` y `CANCELLED`. `confirm_meal_assignment` y `unconfirm_meal_assignment` fallan con mensaje explícito si alguna porción de esa comida ya está `SERVED` o `CONSUMED`.

`meal_assignments` gana `confirm_count` y `last_confirmed_at`: se puede ver que una comida se recalculó tres veces antes de servirse, y el outbox emite un evento por confirmación con `dedupe_key` distinto en vez de colapsarlas en una.

### Eventos: marcan para revisión, no recalculan solos

`meal_assignments` gana `needs_review` y `review_reason`. Un trigger sobre `nutrition_events` marca las comidas confirmadas de esa fecha cuando un evento se crea, cambia o se borra — **sin tocar una sola porción**.

Recalcular solo significaría cambiar en silencio lo que alguien ya revisó y aprobó. La aplicación avisa; la persona decide si deshace la confirmación y vuelve a calcular.

### La estrategia de un evento tiene efecto real

`event_strategy` se guardaba y se mostraba como etiqueta, y el motor de porciones no la miraba nunca. Un asado marcado "con margen" producía la misma porción recortada que un martes cualquiera.

`domain/nutrition/events.ts` la convierte en objetivos concretos, con dos límites:

- `RELAXED` ensancha el techo un 25% en la comida del evento. `LIGHTER_AROUND` aprieta un 10% las **otras** comidas del mismo día. `SKIP_TRACKING` deja la comida sin objetivos. Nunca por debajo del mínimo declarado: **un asado no se paga con un día de ayuno**.
- No se inventan bordes. Quien no declaró un máximo no recibe uno por relajar.

Los eventos con `nutrition_event_members` afectan solo a esas personas. Cuando hay varios el mismo día gana el más permisivo: nadie debería comer menos por tener dos motivos para celebrar.

Para que "sin objetivos" fuera expresable, `optimizePortion` gana `resolvedTargets`, que **reemplaza** los objetivos del patrón en vez de mezclarse con ellos. Un `override` vacío no servía: `{...patrón, ...{}}` devuelve el patrón intacto, así que "hoy no hay objetivos" y "no cambio nada" se escribían igual.

## Consecuencias

- El total a preparar deja de contar a quien no está. Es el número que va a leer el ShoppingEngine.
- Cambiar quiénes comen devuelve la comida a `PLANNED` y borra las porciones planificadas: dejarlas sería guardar porciones de gente que ya no come.
- `MEAL_CONFIRMED` sale al outbox una vez por confirmación. Un consumidor que lea el outbox verá el historial completo de recálculos.
- `CANCELLED` queda definido y todavía sin uso en la aplicación: lo va a necesitar el registro de consumo real, no la planificación.

## Alternativas descartadas

- **Una columna `excluded_members uuid[]` en `meal_assignments`.** Más barata de escribir y peor de consultar: sin llave foránea, sin `on delete cascade`, y con la pregunta "¿quién come?" resuelta por diferencia en cada lectura. Además invierte el sentido — la lista natural es de quienes comen, no de quienes faltan.
- **Filas de participantes siempre, sin caso implícito.** Explícito y honesto, pero convierte cada semana planificada en más de cien filas que repiten lo que ya se sabe, y obliga a mantenerlas al día cada vez que entra o sale alguien del hogar.
- **Recalcular las porciones cuando cambia un evento.** Suena servicial y es traicionero: cambia números que alguien ya miró y aprobó, sin decirlo.
