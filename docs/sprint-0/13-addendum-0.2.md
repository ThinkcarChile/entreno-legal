# Sprint 0.2 — Addendum final (diferencial sobre 0 / 0.1)

> Estado: **PARA REVISIÓN DEL DIRECTOR** — tras su aprobación se congela la arquitectura principal y comienza el Sprint 1.
> Exclusivamente arquitectónico y diferencial: solo lo que cambia o se agrega respecto de Sprint 0 y Addendum 0.1.

---

## 1. Correcciones al modelo 0.1

### 1.1 `inventory_lots`: estados ortogonales (corrige 0.1 §1)

El campo único `state` era incorrecto: un lote puede ser cocido **y** congelado a la vez. Se separa en dimensiones ortogonales:

- `processing_state`: `RAW | PREPPED | COOKED`
- `temperature_state`: `AMBIENT | CHILLED | FROZEN`
- `thawed_at timestamptz null` — historia térmica, no estado: un lote descongelado vuelve a `CHILLED` pero conserva `thawed_at`, que el `FoodStorageSafetyEngine` usa para recortar `use_by` y prohibir re-congelado según regla. `vacuum_sealed` sigue siendo dimensión aparte.

Movimientos afectados: `COOK` muta `processing_state`; `MOVE`/`FREEZE` mutan `temperature_state`; `THAW` es `FROZEN→CHILLED` + sella `thawed_at`. "COOKED + FROZEN" (porción cocinada y congelada) queda representable sin ambigüedad.

### 1.2 Conservación de costo en SPLIT/MERGE (precisa 0.1 §3)

El campo canónico de costo del lote pasa de `unit_cost` a **`acquisition_value`** (valor total del lote, `numeric(12,4)`); `unit_cost` es derivado (`value / quantity`). Así el valor —no el precio unitario— es lo que se conserva:

- **SPLIT**: cada hijo recibe `value = parent_value × (qty_hijo / qty_padre)`; el residuo de redondeo (fracciones de peso) se asigna al último hijo → Σ valores hijos = valor padre, exacto.
- **MERGE** con costos unitarios distintos: `value_merged = Σ values` (suma exacta, sin promediar precios); el unit_cost resultante es el promedio ponderado **implícito**, nunca almacenado como fuente.
- **Invariante de grupo ampliado**: además de Σ deltas de cantidad = 0, ahora Σ deltas de valor = 0 en SPLIT/MERGE/MOVE/TRANSFORM (la merma declarada mueve su valor a WASTED vía `cost_allocations`).

### 1.3 `households`: timezone y moneda

`timezone` ya existía (Sprint 0 §C-1); se precisa su semántica: **todo corte de día** (planes diarios, "hoy", vencimientos, períodos financieros) se calcula en la timezone del household. Se agrega **`currency char(3)` (default `CLP`)**: todos los montos (`purchases`, `price_observations`, `cost_allocations`, `household_food_budgets`) están en la moneda del household; una sola moneda por hogar, conversión fuera de alcance.

### 1.4 Outbox: idempotencia y deduplicación confirmadas (precisa H)

Entrega **at-least-once + efectos exactamente-una-vez** por construcción:

- `domain_events.dedupe_key` (clave natural generada por el productor, p. ej. `GOAL_CHANGED:{goal_id}`) con índice único + `ON CONFLICT DO NOTHING` → un mismo hecho no encola dos eventos.
- Todo efecto escribible de un handler lleva clave de idempotencia con constraint único: `inventory_movements.idempotency_key` (unique) — un retry no puede duplicar un movimiento; `cost_allocations.movement_id` ya era único; snapshots (perfil, compatibilidad, porciones) son únicos por `(sujeto, versión_de_insumos)` y reescribir la misma versión es no-op.
- Dispatcher: `FOR UPDATE SKIP LOCKED`, transición de estado atómica, reintentos con backoff, dead-letter. Un evento procesado dos veces produce exactamente el mismo estado.

---

## 2. Requisitos nuevos

### 2.1 Seguimiento nutricional opcional por integrante

**`member_tracking_settings`**: `member_id`, `food_logging` (`OFF | MEALS_ONLY | FULL`), `weight_tracking bool`, `activity_tracking bool`, `reminders`. **Opt-in, default OFF.**

Contrato con los motores: las porciones y la cocina funcionan para todos (el cocinero necesita cantidades aunque nadie trackee); lo que el tracking habilita son registros, dashboards y el TDEE observado. Con tracking OFF, `data_confidence` del perfil lo refleja ("sin registro de consumo") y los motores usan estimaciones por fórmula — degradación explícita, nunca datos inventados.

### 2.2 Productos personalizados y barcode por hogar

`commercial_products` gana `household_id null` (null = catálogo global; con valor = producto del hogar) y soporte de código propio: unicidad de barcode **por ámbito** — `unique(barcode) where household_id is null` y `unique(household_id, barcode)`. Escanear un código no reconocido → alta rápida de producto del hogar. `merged_into_id null` permite vincular después un producto custom al global sin romper referencias.

### 2.3 Registro real de consumo (amplía `consumption_logs`)

- Ítem ligado a porción planificada: `serving_id` + `fraction_consumed` o cantidad real (180 de 220 g).
- Ítems **OFF_PLAN** (comió algo no planificado): ingrediente/producto + cantidad, o texto libre pendiente de estructurar.
- `affects_inventory bool`: comer de la despensa genera movimiento (con idempotency_key del log); comer fuera no toca inventario.
- `source`: `PLANNED_CONFIRMED | MANUAL | NATURAL_LANGUAGE | VOICE | PHOTO | BARCODE`, + `raw_input` cuando aplica, + `confirmed` (toda estimación de IA/NL se confirma).

### 2.4 Peso y objetivos corporales

- `member_weight_history` (ya existía) + **`member_body_goals`**: `target_weight_kg`, `target_rate_kg_per_week`, `start_date`, `source` (USER/CLINICIAN), `status`. Con historial: mismo patrón de vigencia que `nutrition_goals`.
- **Tendencia de peso** = media móvil exponencial sobre el historial (derivada, no almacenada como fuente): es lo que consumen el TDEE observado y los dashboards, nunca el peso puntual del día.

### 2.5 Energía: TDEE estimado y observado

Sub-módulo **`EnergyModel`** dentro del NutritionEngine (no un motor nuevo):

- **Estimado**: fórmula estándar configurable (peso, estatura, edad, sexo cuando esté disponible, actividad declarada + pasos + entrenamientos) — baseline siempre disponible.
- **Observado**: balance energético sobre ventana móvil (ingesta registrada vs pendiente de la tendencia de peso). Requiere umbral mínimo de datos (tracking FULL y N días de registro consistente); bajo el umbral, se abstiene.
- Salida materializada **`member_energy_estimates`**: `member_id`, `period`, `estimated_tdee`, `observed_tdee null`, `confidence`, insumos versionados. Un TDEE observado divergente genera **propuesta** de ajuste de objetivo calórico (`nutrition_goals` con `source=SYSTEM`, `status=PROPOSED`) — jamás cambio automático.

### 2.6 Pasos y entrenamientos estructurados

- **`member_activity_days`**: `member_id`, `date`, `steps`, `source` (`MANUAL | NATURAL_LANGUAGE | DEVICE` futuro). Un registro por día (upsert idempotente).
- **`workouts`**: `member_id`, `date/time`, `workout_type` (STRENGTH/CARDIO/…, extensible), `duration_min`, `perceived_intensity`, `kcal_estimate null` (estimación marcada como tal), `source`, `raw_input null`, `confirmed`. Plantillas de entrenamiento fuera de alcance del producto (§80: no es una app de training); los workouts existen como insumo energético y como disparador de **sugerencia** "¿aplicar plantilla 'Día de entrenamiento'?" — sugerencia, nunca aplicación automática.

### 2.7 Entrada en lenguaje natural

Se generaliza el patrón de `FoodLoggingService` a un **`NaturalLanguageLogService`** (capa AI, mismo `AIProvider` + schema Zod): "comí 2 huevos y una tostada", "caminé 8.000 pasos", "40 min de pesas" → clasifica intención (comida / actividad / peso) → borrador estructurado con confianza → **confirmación** → `consumption_logs` / `member_activity_days` / `workouts` / `member_weight_history` con `source=NATURAL_LANGUAGE` y `raw_input` preservado. Sin tabla nueva: los logs destino ya portan origen y confirmación.

### 2.8 Hard constraints vs soft preferences (formaliza §56)

`member_preferences` gana **`enforcement`**: `HARD | SOFT`, con default derivado del tipo (`ALLERGY`, `INTOLERANCE`, `MEDICAL_RESTRICTION` → HARD, no rebajable por UI; `AVOID` → SOFT por defecto, elevable a HARD por el usuario; `LIKE/DISLIKE/FAVORITE` → SOFT). Contrato de motores, ahora explícito:

- **HARD = filtro**: se aplica antes de puntuar; ninguna optimización, score ni recomendación puede violarlo ni transarlo (sin opción de slot que lo evite → `NOT_COMPATIBLE`).
- **SOFT = penalización ponderada**: entra al scoring (PersonalMealFit, FamilyMealFit, ranking IA) y puede ceder ante otros criterios, siempre explicado.
- Los `member_clinical_constraints` son HARD por definición y siguen su propio ciclo (0.1 §12).

### 2.9 Versionado de recetas

**`meal_template_versions`**: snapshot inmutable de slots + opciones + pasos + nutrición al publicar (`template_id`, `version`, `published_at/by`). Editar un template publica versión nueva; la anterior no se toca.

- `meal_assignments` / `member_servings` referencian `(template_id, version)`: un plan cerrado o un histórico jamás cambia porque alguien editó la receta después.
- `meal_compatibilities` y `recipe_nutrition` se materializan por `(template_version, profile_version)`.
- El evento `MEAL_TEMPLATE_CHANGED` (H) se reemplaza por **`TEMPLATE_VERSION_PUBLISHED`**: invalida solo asignaciones **futuras no bloqueadas**, que migran a la versión nueva con recálculo; las semanas LOCKED y el historial conservan su versión.

### 2.10 Rendimiento crudo→cocido (endurece `ingredient_cooking_effects`)

- `yield_factor` con dirección explícita (`cooked_g = raw_g × yield_factor`), + `yield_source`, `verified` — mismo estándar de procedencia que la nutrición; cadena de fallback ingrediente → categoría → **"sin dato"** (bloquea el cálculo visible, nunca inventa).
- **Congelamiento del factor usado**: `member_serving_slots` y los movimientos `COOK` guardan las cantidades en ambas bases **y** el `yield_factor` aplicado. Corregir un factor después no reescribe historia (porciones servidas, costos, inventario); solo afecta cálculos futuros — coherente con el versionado de recetas y los snapshots.

---

## 3. Resumen: tablas, relaciones y eventos

### Tablas nuevas

| Tabla | Dominio | Relaciones clave |
|---|---|---|
| `member_tracking_settings` | Nutrition | 1—1 `household_members` |
| `member_body_goals` | Nutrition | N—1 member; mismo patrón de vigencia que `nutrition_goals` |
| `member_energy_estimates` | Nutrition (materializada) | N—1 member; insumos: weight_history, activity, consumption_logs |
| `member_activity_days` | Nutrition | unique (member, date) |
| `workouts` | Nutrition | N—1 member |
| `meal_template_versions` | Meals | N—1 `meal_templates`; referenciada por assignments/servings/compatibilities/nutrition |

### Tablas modificadas

| Tabla | Cambio |
|---|---|
| `inventory_lots` | `state` → `processing_state` + `temperature_state` + `thawed_at`; `unit_cost` → `acquisition_value` (unit_cost derivado) |
| `inventory_movements` | + `idempotency_key` unique; invariante de grupo ampliado a valor; `COOK` guarda `yield_factor` aplicado |
| `households` | + `currency` (default CLP); semántica de `timezone` fijada (corte de día) |
| `domain_events` | + `dedupe_key` unique |
| `commercial_products` | + `household_id null`, unicidad de barcode por ámbito, `merged_into_id` |
| `consumption_logs` | + `fraction_consumed`/cantidad real, ítems OFF_PLAN, `affects_inventory`, `raw_input`, fuentes NL |
| `member_preferences` | + `enforcement` (HARD/SOFT) con defaults por tipo |
| `meal_assignments` / `member_servings` | + referencia a `template_version`; slots congelan `yield_factor` |
| `ingredient_cooking_effects` | + dirección explícita, `yield_source`, `verified`, fallback a categoría |
| `nutrition_goals` | sin cambio de forma; nuevo emisor: propuestas del EnergyModel (`source=SYSTEM`) |

### Eventos afectados (H)

| Evento | Cambio |
|---|---|
| `MEAL_TEMPLATE_CHANGED` | **Reemplazado** por `TEMPLATE_VERSION_PUBLISHED`: migra solo asignaciones futuras no bloqueadas; historial y LOCKED conservan versión |
| `BODY_METRICS_LOGGED` (nuevo) | peso/pasos/workout → recompute batch de `member_energy_estimates` (nocturno); posible propuesta de objetivo |
| `CONSUMPTION_LOGGED` | + genera movimiento solo si `affects_inventory` (con idempotency_key del log) |
| `TRACKING_SETTINGS_CHANGED` (nuevo) | recalcula `data_confidence` del perfil; no toca porciones |
| Todos | dedupe_key en origen + efectos idempotentes (§1.4) |

### Decisiones estructurales agregadas

- **K-18** — Estados de lote ortogonales (`processing` × `temperature` + `thawed_at`).
- **K-19** — Costo canónico = valor total del lote (`acquisition_value`); Σ valor conservado en split/merge; precios unitarios siempre derivados.
- **K-20** — Tracking personal **opt-in por integrante**; los motores degradan explícitamente sin datos, nunca los exigen ni inventan.
- **K-21** — Recetas versionadas e inmutables + congelamiento de factores usados: el historial nunca se reescribe por ediciones posteriores.
- **K-22** — Exactamente-una-vez por construcción: dedupe_key en el outbox + claves de idempotencia únicas en todo efecto escribible.

---

Con la aprobación de este addendum se **congela la arquitectura principal** (Sprint 0 + 0.1 + 0.2) y comienza el Sprint 1 (Fundaciones). Cambios posteriores a la arquitectura congelada requerirán un ADR explícito.
