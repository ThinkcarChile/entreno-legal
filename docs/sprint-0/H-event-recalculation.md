# H. Event / Recalculation Architecture

## Objetivo

Cuando cambia un objetivo, examen, preferencia, receta, evento, inventario o consumo real, el sistema debe reaccionar **recalculando solo lo afectado**, de forma trazable y sin sorpresas (respetando LOCK_WEEK y la confirmación humana en lo clínico).

## Patrón: Outbox + procesamiento en el mismo Postgres

Sin infraestructura de colas externa en esta etapa (decisión K-5):

1. Toda mutación de dominio relevante escribe, **en la misma transacción**, una fila en `domain_events` (outbox): `event_type`, `aggregate`, `payload` (ids, no datos clínicos), `scope` (member_ids, semanas), `status=PENDING`.
2. Un **dispatcher** en el servidor (route handler invocado por Supabase Cron/pg_cron cada minuto + disparo inmediato "best effort" tras la mutación) toma eventos PENDING con `FOR UPDATE SKIP LOCKED`, ejecuta los handlers y marca PROCESSED/FAILED (con reintentos y dead-letter).
3. Los handlers son **idempotentes**: recalcular dos veces produce el mismo estado (los snapshots llevan versiones de insumos; si los insumos no cambiaron, no se escribe nueva versión).
4. La UI recibe frescura vía Supabase Realtime (subscripción a las tablas materializadas y a `change_impacts`).

Esto permite migrar después a una cola dedicada sin cambiar los contratos (el outbox ya separa "qué pasó" de "qué se recalcula").

## Catálogo de eventos y su alcance de invalidación

| Evento | Origen | Se recalcula (solo) | No se toca |
|---|---|---|---|
| `GOAL_CHANGED` | Nutrition | Perfil del miembro (vN+1) → sus compatibilidades → sus porciones en semanas no archivadas → deltas de compra | Otros miembros; semanas archivadas |
| `DAILY_OVERRIDE_CHANGED` | Nutrition | Porciones del miembro **de esa fecha** (+semana si hay presupuesto semanal) | Perfil base; otros días |
| `LAB_RESULTS_CONFIRMED` | Health | ClinicalRules del miembro → constraints → perfil → compatibilidades → porciones → compra; schedules/recordatorios | Nada clínico sin confirmación; nada de otros miembros |
| `CLINICAL_CONSTRAINT_ACTIVATED` | Health | *(precisado en 0.1)* Como GOAL_CHANGED, y además **invalida de inmediato** porciones/recomendaciones afectadas (`CLINICALLY_INVALIDATED`) aun con LOCK_WEEK + genera `clinical_impact_review` | Compras realizadas, inventario y cantidades cocinadas: solo cambian al resolver la revisión (humano) |
| `PREFERENCE_CHANGED` (gustos/cocción/favoritos) | Family | Compatibilidades del miembro; family_meal_fits de templates afectados; porciones solo si la preferencia afecta método/grasa en semana activa | Perfil nutricional (no cambia) |
| `MEAL_TEMPLATE_CHANGED` / nutrición de ingrediente corregida | Meals | recipe_nutrition del template; compatibilidades y porciones **solo de asignaciones activas que lo usan**, para todos los miembros involucrados | Templates no relacionados |
| `EVENT_ADDED/REMOVED` (NutritionEvent) | Nutrition | Estrategia de la semana afectada (targets efectivos de esos días) → porciones de esos días | Perfil base |
| `PLAN_ASSIGNED/CHANGED` | Planning | Porciones de esa asignación; totales de cocina; delta de compra | Otras asignaciones |
| `WEEK_LOCKED` | Planning | Congela lista; a partir de aquí los deltas van a `shopping_list_revisions` | — |
| `INVENTORY_MOVED` (incluye split/merge/transform/cook/thaw, sobras y mermas con causa — 0.1) | Inventory | Stock/reservas del lote; `cost_allocations` (CONSUMED/WASTED); REPOSICIÓN; sugerencias por-vencer; forecast (job batch) | Porciones (no dependen del stock) |
| `PURCHASE_RECEIVED` (0.1) | Procurement | Crea `purchase`+lotes con costo; `price_observations`; concilia lista (planificado vs real); dispara sesión PREPARAR COMPRA opcional | Nada nutricional |
| `PREP_TASK_EXECUTED` (0.1) | Prep & Storage | Movimientos del ledger de la tarea; `use_by` recalculado (SafetyEngine); etiquetas/print jobs | Stock total (invariante Σ=0 en splits) |
| `CONSUMPTION_LOGGED` | Planning | Macros restantes del día del miembro → "¿Qué puedo comer?"; movimiento de inventario; sobras | Plan de otros días |
| `STAPLE_CHANGED` | Shopping | Sección HABITUALES de listas DRAFT | Listas cerradas |

## Grafo de dependencias (qué invalida qué)

```
nutrition_goals ─┐
meal_patterns ───┤
clinical_constraints ─┤→ member_nutrition_profiles (vN)
weight/actividad ─────┘        │
                               ▼
        meal_compatibilities (member × template)
                               ▼
        member_servings (member × assignment)  ←── meal_assignments
                               ▼
        member_serving_nutrition / cooking totals
                               ▼
        shopping_list_items  ←── pantry (reservas) ←── inventory_movements
                               ▼
        shopping_list_revisions (si LOCKED)
```

Regla de implementación: cada tabla materializada guarda las **versiones de sus insumos** (`profile_version`, `template_version`, `nutrition_source_version`). Invalidar = marcar `is_stale` por comparación de versiones dentro del `scope` del evento; recomputar = job idempotente que solo escribe si el resultado difiere. Nunca "recalcular todo el household".

## Interacción con LOCK_WEEK y confirmación humana

- Semana DRAFT/CONFIRMED: la cascada llega hasta la lista de compras directamente.
- Semana LOCKED: la cascada se detiene en `shopping_list_revisions` (PENDING_REVIEW) — decisión humana APPLY_NOW / APPLY_NEXT_WEEK / REVIEW. Excepción *(precisada en 0.1)*: `CLINICAL_CONSTRAINT_ACTIVATED` **invalida** de inmediato lo afectado (nunca lo modifica) y abre un `clinical_impact_review`; compras, inventario y cocinado solo cambian al resolverla ([Addendum §12](./12-addendum.md#12-precisión-sobre-lock_week-clinicalimpactreview)).
- Cambios clínicos que crean objetivos nuevos: la cascada se detiene **antes** del perfil, en una PROPUESTA (§55); al confirmarse, continúa.

## Trazabilidad

Cada corrida de handler escribe/actualiza `change_impacts` (causa → efectos legibles) y enlaza: evento origen → versiones creadas → deltas. La pantalla "¿Qué cambió?" es una vista directa de esta tabla; `NutritionReasoningService` solo redacta, no decide.

## Frescura vs. costo

- **Síncrono** (en la request): lo que el usuario está mirando (su porción al editar su objetivo, la lista al abrir COMPRAS si hay `is_stale`).
- **Asíncrono** (dispatcher): el resto de la cascada.
- **Batch nocturno**: aprendizaje de consumo (`estimated_weekly_consumption`), estados de recordatorios de exámenes (CURRENT→EXPIRING_SOON→OUTDATED), vencimientos de despensa, expiración de constraints.
