# C. Database Architecture

Esquema relacional inicial para PostgreSQL (Supabase). **Este documento es para revisión del modelo; las migraciones SQL se escribirán en el sprint correspondiente, tras aprobación.**

> **Actualización 0.1**: el [Addendum](./12-addendum.md) agrega las tablas de Finance, Procurement y Prep & Storage, promueve el inventario a lotes (`inventory_lots`) y **reemplaza** `pantries`/`pantry_items`, `leftovers`, `price_history` y `stock_targets` (ver [Addendum §13](./12-addendum.md#13-revisión-del-modelo)). Las secciones afectadas abajo quedan marcadas; el resto sigue vigente tal cual.

## Convenciones globales

- PK: `id uuid default gen_random_uuid()`.
- Todas las tablas de datos de hogar llevan `household_id uuid not null` (directo o vía FK inmediata) — es la base de RLS.
- `created_at`/`updated_at timestamptz`; borrado lógico solo donde se exige historial (`deleted_at`).
- Cantidades físicas: `numeric(10,2)` + `unit` (enum: `G, KG, ML, L, UNIT`) normalizadas a **g/ml/unit** en columnas canónicas (`quantity_canonical`, `unit_canonical`). Nunca se suman unidades incompatibles sin `unit_equivalence`.
- Nutrición: valores por **100 g de porción comestible en el estado indicado** (`weight_basis`: RAW/COOKED/DRAINED/EDIBLE_PORTION/COMMERCIAL_PACKAGE).
- Enumeraciones como tipos Postgres (`meal_type`, `cooking_method`, `preference_type`, `goal_source`…), no strings libres.
- JSONB solo para: payloads de eventos, condiciones/acciones de reglas clínicas (DSL validado), micronutrientes extensibles y metadatos de IA. **Nunca** como reemplazo de relaciones normales.
- Datos sensibles marcados 🔒 (salud) — viven en tablas separadas con RLS reforzada (ver [G](./G-security-model.md)).

---

## 1. Family / Identidad

### `households`
- **Propósito**: la familia; raíz de aislamiento.
- **Campos**: `id`, `name`, `locale` (default `es-CL`), `timezone`, `created_at`.
- **Relaciones**: 1—N con casi todo.

### `household_members`
- **Propósito**: persona del hogar; puede existir sin cuenta.
- **Campos**: `id`, `household_id`, `user_id uuid null → auth.users`, `display_name`, `photo_url null`, `birth_date null`, `sex null` (solo si se necesita para cálculos), `height_cm null`, `activity_level`, `is_active`, `created_at`.
- **Relaciones**: N—1 `households`; 0..1 `auth.users` (unique parcial sobre `user_id`).
- **Índices**: `(household_id)`, unique `(household_id, user_id)` where user_id is not null.
- **Sensibles**: birth_date/sex/height son personales; el peso va aparte (historial).

### `member_weight_history`
- **Propósito**: historial de peso.
- **Campos**: `id`, `member_id`, `weight_kg`, `measured_at`, `source` (USER/DEVICE).
- **Índices**: `(member_id, measured_at desc)`.

### `household_roles` + `member_role_assignments`
- **Propósito**: roles configurables (INTEGRANTE, PLANIFICADOR, COMPRADOR, COCINERO, ADMIN) con flags de permiso (`can_edit_plan`, `can_manage_shopping`, `can_manage_members`, …). Una persona, varios roles.
- **Campos assignment**: `member_id`, `role_id`, `granted_by`, `granted_at`.
- **Nota**: los permisos **médicos no** derivan de roles; ver `health_data_grants`.

---

## 2. Nutrition

### `nutrition_goals`
- **Propósito**: objetivos con rango, vigencia e historial (la tabla ES el historial: filas con vigencia, nunca update destructivo → cubre `GoalHistory`).
- **Campos**: `id`, `member_id`, `goal_type` (CALORIES/PROTEIN/CARBS/FAT/FIBER/micronutriente…), `scope` (DAILY/PER_MEAL + `meal_type null`), `minimum null`, `preferred null`, `maximum null`, `unit`, `start_date`, `end_date null`, `source` (USER/CLINICIAN/SYSTEM/AI_PROPOSAL), `priority`, `status` (ACTIVE/SUPERSEDED/PROPOSED/REJECTED), `created_by`, `created_at`.
- **Índices**: `(member_id, goal_type, scope, meal_type) where status='ACTIVE'`; `(member_id, start_date)`.
- **Nota**: `AI_PROPOSAL` nace con `status='PROPOSED'` y no entra en cálculo hasta confirmarse.

### `member_nutrition_profiles` 🔒(parcial)
- **Propósito**: **snapshot versionado e inmutable** del estado nutricional vigente — la única fuente que consultan recetas y cálculos.
- **Campos**: `id`, `member_id`, `version int`, `effective_from`, `computed_inputs jsonb` (ids+versiones de goals, constraints, pattern, peso usado), `daily_targets jsonb` (resuelto: kcal/protein/carbs/fat/fiber min-pref-max), `meal_targets jsonb`, `active_constraints jsonb` (referencias a `member_clinical_constraints` confirmados — sin detalle clínico), `conflicts jsonb`, `data_confidence jsonb` (recencia/completitud por categoría), `created_at`.
- **Índices**: unique `(member_id, version)`; `(member_id) where is_current`.
- **Nota**: los `jsonb` aquí son *salidas materializadas* del motor (cacheo versionado), no la fuente; la fuente son las tablas relacionales.

### `meal_patterns` + `meal_pattern_slots`
- **Propósito**: patrón habitual por persona: qué comidas hace (BREAKFAST/LUNCH/DESSERT/TEA/DINNER/SNACK/FRUIT/OTHER), ventana de alimentación (ayuno intermitente como preferencia): `feeding_window_start/end`, `first_meal_type`.
- **Campos slot**: `pattern_id`, `meal_type`, `enabled`, orden, preferencias (`prefers_salad`, `is_first_meal`).

### `day_templates` + `day_template_meals`
- **Propósito**: plantillas ("Día normal", "Día entrenamiento", "Almuerzo grande"…): por comida `calorie_min/preferred/max`, `protein_min/preferred/max`, `enabled`.
- **Campos**: `member_id null` (personal) o `household_id` (compartida), `name`.

### `member_daily_nutrition_plans`
- **Propósito**: **override por fecha** (DAILY OVERRIDE): `date`, `member_id`, `template_id null`, `daily_calorie_target null`, `daily_protein_target null` + filas hijas por comida (`meal_type`, `enabled`, rangos kcal/protein).
- **Índices**: unique `(member_id, date)`.

### `nutrition_events`
- **Propósito**: eventos (cumpleaños, asado, viaje, comida libre…): `household_id`, `member_ids uuid[]` o tabla puente, `date`/rango, `event_type`, `meal_type null`, `strategy` (margen razonable; nunca compensación extrema), `notes`.
- **Índices**: `(household_id, date)`.

### `weekly_energy_budgets`
- **Propósito**: presupuesto semanal opcional: `member_id`, `week_start`, `total_kcal`, `distribution_policy`.

### `nutrition_conflicts`
- **Propósito**: conflictos visibles entre objetivos/restricciones: `member_id`, `goal_ids`, `constraint_id null`, `winner`, `priority_rule_applied`, `explanation`, `resolved_action`, `profile_version`.

---

## 3. Meals / Catálogo

### `ingredients`
- **Propósito**: alimento genérico.
- **Campos**: `id`, `name`, `category_id`, `default_unit`, `edible_portion_factor`, `density_g_per_ml null`, `is_verified`.
- **Relaciones**: 1—N `ingredient_nutrition`, `ingredient_units`.

### `ingredient_nutrition`
- **Propósito**: nutrición por 100 g y por estado.
- **Campos**: `ingredient_id`, `weight_basis` (RAW/COOKED/…), `kcal`, `protein`, `carbohydrates`, `fat`, `saturated_fat`, `fiber`, `sugar`, `sodium`, `potassium`, `phosphorus`, `micronutrients jsonb` (extensible), `nutrition_source`, `source_version`, `verified boolean`, `verified_by null`.
- **Regla**: la IA nunca inserta aquí silenciosamente; `verified=false` hasta revisión.

### `ingredient_units` / `unit_equivalences`
- **Propósito**: conversiones (`1 unit huevo = 55 g`, `1 taza arroz crudo = 195 g`). Prohibido sumar `g + unit` sin fila aquí.

### `cooking_methods` + `ingredient_cooking_effects`
- **Propósito**: métodos (AIR_FRYER, FRIED, BAKED, GRILLED, PAN_SEARED, STEAMED, BOILED, STEWED, POACHED, RAW, OTHER) y su efecto por ingrediente/categoría: `yield_factor` (crudo→cocido), `default_added_fat_g` (0 para airfryer, >0 para frito), `absorbed_fat_factor`.
- **Regla**: 200 g pescado airfryer ≠ 200 g pescado frito; la diferencia sale de aquí + grasa añadida explícita.

### `commercial_products`
- **Propósito**: producto real de tienda: `ingredient_id null`, `brand`, `name`, `barcode` (unique, nullable), `package_quantity`, `package_unit`, `nutrition jsonb` estructurada o FK a fila propia de nutrición, `price null`, `store null`, `last_price_date`.
- **Índices**: `(barcode)`, trigram sobre `name`.

### `meal_templates`
- **Propósito**: plato modular: `id`, `household_id null` (null = biblioteca global), `name`, `meal_types meal_type[]`, `photo_url`, `base_time_minutes`, `complexity_base`, `is_active`.

### `meal_slots`
- **Propósito**: componentes: `template_id`, `slot_type` (PROTEIN/CARBOHYDRATE/VEGETABLE/SALAD/FAT/SAUCE/OPTIONAL/DESSERT), `is_required`, `default_option_id`.

### `meal_slot_options`
- **Propósito**: alternativas por slot: `slot_id`, `ingredient_id` | `salad_template_id` | `dessert_template_id`, `base_quantity_per_serving`, `unit`, `allowed_cooking_methods cooking_method[]`, `is_default`.

### `ingredient_substitutions` / `nutritional_equivalents`
- **Propósito**: sustituciones válidas entre ingredientes (`from_id`, `to_id`, `ratio`, `context`), y equivalencias nutricionales (p. ej. proteína ~ proteína) para el cambio de **un** componente.

### `salad_templates` + `salad_components`
- **Propósito**: ensaladas de primera clase: componentes tipados (BASE/VEGETABLE/FAT_DRESSING/EXTRA) con ingrediente, cantidad por porción y opciones. La nutrición se calcula; una ensalada nunca es "0 kcal" por defecto.

### `dessert_templates`
- **Propósito**: postres con atributos (`is_quick`, `no_cook`, `is_cold`, `uses_oven`, `is_fruit_based`, `high_protein`, `low_kcal`) y variantes por slot (base + toppings) para adaptaciones mínimas.

### `recipe_steps`
- **Propósito**: pasos, con soporte de **preparación paralela**: `template_id`, `step_number`, `instruction`, `applies_to_cooking_method null`, `equipment_id null`, `duration_minutes`, `can_run_in_parallel_with int[]`.

### `recipe_nutrition` (materializada)
- **Propósito**: nutrición por porción base del template con opciones default; cache recalculable, con `computed_at` y versión de insumos.

### `kitchen_equipment` *(ampliada en 0.1 → `household_equipment` + `equipment_capabilities` + `preparation_alternatives`; ver [Addendum §9](./12-addendum.md#9-equipamiento-opcional-y-capacidades))*
- **Propósito**: equipamiento del hogar: `household_id`, `equipment_type` (AIRFRYER/OVEN/…), `capacity_g null` → cálculo de tandas. En 0.1: capacidades concretas como datos (p. ej. discos de procesador) y regla de método base manual obligatorio.

---

## 4. Preferencias y favoritos

### `member_preferences`
- **Propósito**: gustos separados por tipo: `member_id`, `preference_type` (LIKE/DISLIKE/AVOID/ALLERGY/INTOLERANCE/MEDICAL_RESTRICTION/FAVORITE), `target_kind` (INGREDIENT/CATEGORY/MEAL_TEMPLATE/PRODUCT), `target_id`, `severity null`, `notes`.
- **Regla**: DISLIKE ≠ prohibición; ALLERGY/MEDICAL_RESTRICTION son de seguridad (prioridad 1–2). `MEDICAL_RESTRICTION` referencia `member_clinical_constraints` 🔒.
- **Índices**: `(member_id, preference_type)`, `(target_kind, target_id)`.

### `member_favorites`
- **Propósito**: favoritos por entidad (plato/postre/ensalada/producto/fruta/snack) → `family_favorite_score` se calcula (vista), no se almacena a mano.

### `member_cooking_preferences`
- **Propósito**: preferencias de preparación generales y por ingrediente: `member_id`, `ingredient_id null` (null = general), `cooking_method`, `stance` (PREFERRED/ACCEPTED/AVOID), y grasas añadidas (`avoid_added_oil`, `avoid_butter`).

### `member_staples` (productos habituales)
- **Propósito**: `member_id`, `product_id|ingredient_id`, `typical_weekly_quantity`, `policy` (ADD_ALWAYS/ASK/NEVER).

### `member_fruit_plans`
- **Propósito**: fruta como categoría de primera clase: favoritas, `weekly_target` (p. ej. 7 plátanos/semana), contextos de uso (postre/desayuno/once/snack).

---

## 5. Health 🔒 (todas las tablas de esta sección son sensibles)

### `health_profiles`, `health_conditions`, `medications`
- **Propósito**: condiciones y medicamentos declarados: `member_id`, `condition_code null`, `name`, `diagnosed_at null`, `source`, `status`. La app **no** modifica medicamentos; solo registra.

### `lab_documents`
- **Propósito**: archivo subido (PDF/JPG/PNG/HEIC): `member_id`, `storage_path` (bucket privado), `uploaded_by`, `laboratory null`, `taken_at null`, `processing_status` (UPLOADED/EXTRACTING/PENDING_CONFIRMATION/CONFIRMED/REJECTED), `ai_consent_record_id`.

### `biomarker_definitions` (global, no sensible)
- **Propósito**: catálogo canónico: `code`, `name`, `canonical_unit`, unidades aceptadas + conversión, `value_type`.

### `lab_tests` + `lab_results`
- **Propósito**: resultados extraídos y confirmados.
- **Campos results**: `document_id`, `member_id`, `biomarker_id`, `raw_value`, `raw_unit`, `confirmed_value null`, `confirmed_unit`, `reference_min/max` (del laboratorio, distinto del objetivo clínico), `taken_at`, `extraction_confidence`, `status` (EXTRACTED/CONFIRMED/EDITED/DISCARDED), `confirmed_by`, `confirmed_at`.
- **Regla**: solo `status='CONFIRMED'|'EDITED'` alimenta reglas clínicas.
- **Índices**: `(member_id, biomarker_id, taken_at desc)` → tendencias.

### `clinical_rules` + `clinical_rule_sources` (global, versionadas)
- **Propósito**: reglas deterministas: `code`, `version`, `condition jsonb` (DSL validado: biomarcador/umbral/condición), `action jsonb` (tipo de constraint, nutriente, límite, ingredientes/categorías afectadas), `requires_confirmation boolean`, `source_id` (referencia bibliográfica/protocolo), `status` (DRAFT/VALIDATED/RETIRED).
- **Regla**: solo reglas VALIDATED se aplican automáticamente; una regla que crearía un objetivo clínico nuevo genera PROPUESTA (§55).

### `member_clinical_constraints`
- **Propósito**: restricción vigente por persona: `member_id`, `rule_id null` (null = ingresada por clínico/usuario), `constraint_type`, `nutrient|ingredient|category`, `limit_min/max`, `unit`, `status` (PROPOSED/ACTIVE/EXPIRED/REJECTED), `derived_from_result_ids uuid[]`, `valid_until null`, `confirmed_by/at`.

### `lab_monitoring_schedules` + `health_reminders`
- **Propósito**: frecuencia configurable por persona y biomarcador/panel (`interval` 1/3/6/12 meses | fecha específica | según profesional; `source` USER/DOCTOR/NUTRITIONIST/CLINICAL_PROTOCOL) y recordatorios con estado CURRENT/EXPIRING_SOON/OUTDATED/MISSING. Nunca se inventa frecuencia.

### `health_data_grants`
- **Propósito**: permisos médicos explícitos entre integrantes: `subject_member_id`, `grantee_member_id`, `scope` (SUMMARY/FULL/CONSTRAINTS_ONLY), `granted_by`, `revoked_at null`.
- **Regla**: por defecto nadie ve exámenes de otro; el plan familiar solo expone *efectos* (compatibilidad/porciones), no diagnósticos.

### `consent_records`
- **Propósito**: consentimiento para enviar documentos médicos a proveedor de IA: `member_id`, `scope`, `provider`, `granted_at`, `revoked_at null`, `granted_by`.

---

## 6. Planning

### `weekly_plans` + `weekly_plan_days` + `meal_assignments`
- **Propósito**: la semana: `household_id`, `week_start`, `status` (DRAFT/VOTING/CONFIRMED/LOCKED/ARCHIVED), `locked_at/by`; días; asignaciones (`day_id`, `meal_type`, `kind` RECIPE/EAT_OUT/LEFTOVER/EVENT/FREE, `template_id null`, `leftover_id null`, orden).
- **Índices**: unique `(household_id, week_start)`.

### `meal_assignment_votes`
- **Propósito**: votación LOVE/LIKE/NEUTRAL/DISLIKE por integrante y propuesta.

### `member_servings`
- **Propósito**: **la porción final por persona** — pieza central del sistema.
- **Campos**: `assignment_id`, `member_id`, `adaptation_level` (0–4), `slot_resolutions` (tabla hija `member_serving_slots`: slot, opción elegida, `quantity_canonical`, `cooking_method`, `added_fat_id/quantity`, `substituted boolean`), `status` (PLANNED/SERVED/SKIPPED), `nutrition_profile_version` usado, `explanations` (por qué esta cantidad/método/sustitución).
- **Índices**: `(assignment_id)`, `(member_id, status)`.

### `member_serving_nutrition` (materializada)
- **Propósito**: nutrición resultante tras cantidad + preparación + grasa + salsa + sustituciones; cache con insumos versionados.

### `meal_compatibilities` (materializada)
- **Propósito**: `PersonalMealFit`: `template_id`, `member_id`, `status` (COMPATIBLE / COMPATIBLE_WITH_PORTION_CHANGE / COMPATIBLE_WITH_COOKING_CHANGE / COMPATIBLE_WITH_ONE_SUBSTITUTION / REVIEW_REQUIRED / NOT_COMPATIBLE), `required_changes jsonb`, `profile_version`, `computed_at`, `is_stale boolean`.

### `family_meal_fits` / `cooking_complexity_scores` (materializadas)
- **Propósito**: agregado familiar (compatibilidad, gustos, favoritos, nº de cambios, complejidad, variedad) y score de complejidad de cocina (preparaciones/sustituciones/métodos/sartenes adicionales).

### `consumption_logs`
- **Propósito**: PLANNED vs ACTUAL: `member_id`, `serving_id null`, `date`, `meal_type`, `source` (PLANNED_CONFIRMED/"comí lo planificado", MANUAL, VOICE, PHOTO, BARCODE), `items` (hija: ingrediente/producto, cantidad, estado crudo/cocido), `ai_estimated boolean`, `confirmed boolean`.
- **Índices**: `(member_id, date)`.

---

## 7. Shopping

### `shopping_lists` + `shopping_list_items`
- **Propósito**: lista consolidada: `weekly_plan_id`, `status` (DRAFT/READY/SHOPPING/DONE), items con `ingredient_id|product_id`, `needed_quantity_canonical`, `pantry_deducted_quantity`, `to_buy_quantity`, `package_suggestion` (envases: cantidad→unidades), `origin_breakdown` (hija `shopping_item_sources`: RECIPE(day, assignment)/STAPLE(member)/RESTOCK/ADJUSTMENT con cantidades) → alimenta el "¿Por qué?", `checked_by/at`, `price_estimate null`.
- **Realtime**: canal Supabase por `shopping_list_id` (agregar/marcar comprado sincronizado).

### `shopping_list_revisions`
- **Propósito**: cambios post-LOCK: `list_id`, `caused_by_event_id`, `delta` (hija por item: +180 g pollo, −100 g arroz), `status` (PENDING_REVIEW/APPLIED_NOW/DEFERRED_NEXT_WEEK/REJECTED), `decided_by/at`.

### `price_history` *(superseded en 0.1 → `price_observations`, alimentada automáticamente por `purchase_items` + registro manual; ver [Addendum §3](./12-addendum.md#3-finanzas-de-alimentación))*
- **Propósito original**: `product_id`, `store`, `price`, `date`, `source` (MANUAL/RECEIPT). Sin scraping por ahora.

---

## 8. Inventory

> **⚠️ Sección reescrita por el Addendum 0.1**: el stock ahora se modela como **lotes** (`inventory_lots`) sobre `storage_locations` (evolución de `pantry_locations`, con capacidad opcional); `pantries`, `pantry_items` y `leftovers` quedan absorbidas; `stock_targets` es reemplazada por `reorder_rules` + `demand_forecasts` (Procurement); `inventory_movements` gana `lot_id`, `reason` explícita (incl. causas de merma) y `group_id` con invariantes. Modelo completo en [Addendum §1, §6–8](./12-addendum.md#1-la-decisión-central-inventario-por-lotes). Lo siguiente se conserva como referencia del diseño original:

### `pantries` + `pantry_locations` + `pantry_items` *(superseded en 0.1)*
- **Propósito**: despensa por ubicación (PANTRY/FRIDGE/FREEZER/OTHER): `ingredient_id|product_id`, `quantity_canonical`, `expiry_date null`, `opened boolean`.
- **Índices**: `(household_id, ingredient_id)`, `(household_id, expiry_date) where expiry_date is not null`.

### `inventory_movements`
- **Propósito**: libro mayor del inventario: `pantry_item_id|ingredient_id`, `movement_type` (PURCHASE/CONSUMPTION/COOKING/WASTE/ADJUSTMENT/LEFTOVER_IN/LEFTOVER_OUT), `quantity_delta`, `reference` (shopping_item/serving/leftover), `created_by`.
- **Regla**: el stock actual es derivable; los ajustes manuales también son movimientos (auditables).

### `stock_targets` *(superseded en 0.1 → `reorder_rules` + `demand_forecasts`)*
- **Propósito**: `household_id`, `ingredient_id|product_id`, `minimum_stock`, `target_stock`, `estimated_weekly_consumption` (aprendida del historial de movimientos; editable), `learned_at`, `days_of_supply` (derivado).

### `leftovers` *(superseded en 0.1 → `inventory_lots` con `origin=assignment`, `state=COOKED`)*
- **Propósito**: comida preparada: `source_assignment_id`, `ingredient/dish`, `quantity_canonical`, `stored_location`, `cooked_at`, `use_by`, `status` (AVAILABLE/PLANNED/CONSUMED/DISCARDED). Participa en inventario y en "¿Qué puedo comer?".

---

## 9. AI, cambios y auditoría

### `ai_recommendations` + `recommendation_reasons` + `recommendation_feedback`
- **Propósito**: toda recomendación persistida con sus razones estructuradas ("aumentamos tu porción de pollo porque tu objetivo de proteína de esta comida es 50–80 g…") y feedback del usuario (aceptada/editada/rechazada) para aprendizaje.

### `domain_events` (outbox — ver [H](./H-event-recalculation.md))
- **Propósito**: `event_type`, `aggregate` (member/plan/list…), `payload jsonb`, `scope` (member_ids, week), `status` (PENDING/PROCESSED/FAILED), `processed_at`.

### `change_impacts`
- **Propósito**: la pantalla "¿Qué cambió?": `household_id`, `caused_by` (evento + actor), `summary` ("Sebastián aumentó proteína"), `effects` (hija: "+480 g pollo esta semana", "3 recetas recalculadas"), `requires_action boolean`, `seen_by`.

### `audit_events` 🔒(acceso)
- **Propósito**: auditoría append-only: quién accedió/modificó qué (obligatoria para datos de salud, consentimientos, confirmaciones, cambios de permisos). Sin contenido clínico en el detalle: referencias por id.

---

## Diagrama de relaciones principales (simplificado)

```
households ─┬─ household_members ─┬─ nutrition_goals ──────────┐
            │                     ├─ meal_patterns             │
            │                     ├─ member_preferences        ▼
            │                     ├─ member_cooking_prefs   member_nutrition_profiles (v1..vN)
            │                     ├─ member_staples             ▲
            │                     └─ health_* 🔒 ── clinical_rules
            ├─ weekly_plans ── days ── meal_assignments ── member_servings ── member_serving_nutrition
            │                                    ▲                  │
            │        meal_templates ── slots ── options             ▼
            │              │                            shopping_lists ── items ── item_sources
            │        ingredients ── nutrition/units/cooking_effects      ▲
            └─ pantries ── pantry_items ── inventory_movements ──────────┘
                                └─ leftovers / stock_targets
```

## Qué NO se modela con JSON

Relaciones entre personas, recetas, ingredientes, porciones, compras e inventario: todo relacional. JSONB queda restringido a snapshots materializados versionados, DSL de reglas clínicas validado por schema, micronutrientes extensibles y payloads de eventos.
