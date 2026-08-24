# E. Calculation Engines

Siete motores. Todos son **módulos TypeScript puros y deterministas** (`src/engines/*`): reciben datos, devuelven resultados + explicaciones, no tocan la base de datos ni llaman IA. La capa de aplicación los alimenta (repositorios) y persiste sus salidas (snapshots materializados versionados). Esto los hace testeables con unit tests exhaustivos — requisito para un sistema que calcula comida y salud.

```
                    ┌──────────────────┐
 goals/pattern ───► │ NutritionEngine  │──► MemberNutritionProfile vN
 constraints ┐      └────────┬─────────┘
             │               │ (perfil efectivo por fecha)
┌────────────┴───┐  ┌────────▼─────────────┐     ┌─────────────────────┐
│ClinicalRules   │  │MealCompatibilityEng. │──►  │ FamilyMealOptimizer │
│Engine          │  └────────┬─────────────┘     └──────────┬──────────┘
└────────────────┘  ┌────────▼─────────┐                    │ semana propuesta
                    │ PortionOptimizer │◄───────────────────┘
                    └────────┬─────────┘
                             │ MemberServing[]
                    ┌────────▼─────────┐      ┌─────────────────┐
                    │  ShoppingEngine  │◄─────│ InventoryEngine │
                    └──────────────────┘      └─────────────────┘
```

---

## 1. NutritionEngine

**Responsabilidad**: producir el `MemberNutritionProfile` (versionado) y el **perfil efectivo por fecha**; calcular nutrición de cualquier combinación ingrediente+cantidad+estado+método+grasa.

- **Inputs**: `nutrition_goals` activos, datos corporales (peso vigente, estatura, actividad), `meal_patterns` (incl. ayuno), `member_clinical_constraints` ACTIVE, preferencias relevantes, `day_templates`/`member_daily_nutrition_plans`/`nutrition_events`/`weekly_energy_budgets` (para el efectivo por fecha), tablas `ingredient_nutrition`, `ingredient_cooking_effects`, `unit_equivalences`.
- **Outputs**: perfil versionado (targets diarios y por comida con min/pref/max, constraints activos, conflictos, `data_confidence`), y funciones de cálculo nutricional (`computeServingNutrition(slots, quantities, methods, fats) → macros`).
- **Reglas**: única fuente de objetivos para todo el sistema; los conflictos se resuelven por prioridad §56 y se emiten como `NutritionConflict`; jamás inventa valores nutricionales (si falta dato, el resultado se marca incompleto). La distribución de presupuesto semanal respeta mínimos nutricionales — sin compensaciones extremas por eventos.
- **Dependencias**: ClinicalRulesEngine (consume sus constraints ya materializados; no lo invoca).

## 2. PortionOptimizer

**Responsabilidad**: dada una comida (MealTemplate resuelto) y una persona con su perfil efectivo del día, encontrar la porción de **mínima adaptación** (Nivel 0→4).

- **Inputs**: template + slots + opciones, perfil efectivo (rangos por comida), preferencias de cocción/gustos, equivalencias/sustituciones, kcal/macros ya consumidos o planificados del día (para el encaje diario).
- **Outputs**: `MemberServing` propuesto: cantidades por slot (canónicas, con estado crudo/cocido explícito), método por componente, grasa añadida, sustitución (máx. 1), `adaptation_level`, nutrición resultante, y **explicación** por cada desviación de la base ("aumentamos tu pollo a 220 g porque tu objetivo de proteína de esta comida es 50–80 g y la porción base aportaba 38 g").
- **Algoritmo**: búsqueda escalonada, no solver genérico: (0) evaluar base → (1) escalar cantidades por slot dentro de rangos razonables de plato (no 600 g de arroz para cuadrar kcal) priorizando `preferred` de proteína y `maximum` de kcal → (2) iterar métodos permitidos por preferencia → (3) probar opciones de slot una a una → (4) `REVIEW_REQUIRED`. Determinista: mismo input, misma porción.
- **Dependencias**: NutritionEngine (cálculo de macros por candidato).

## 3. MealCompatibilityEngine

**Responsabilidad**: clasificar cada (template, persona) → `PersonalMealFit`.

- **Inputs**: template, perfil efectivo, preferencias (ALLERGY/AVOID/MEDICAL primero), resultado del PortionOptimizer en modo "¿existe solución de nivel ≤3?".
- **Outputs**: estado COMPATIBLE / COMPATIBLE_WITH_PORTION_CHANGE / COMPATIBLE_WITH_COOKING_CHANGE / COMPATIBLE_WITH_ONE_SUBSTITUTION / REVIEW_REQUIRED / NOT_COMPATIBLE + `required_changes` + razones.
- **Reglas**: ALLERGY sobre cualquier ingrediente sin opción de slot que lo evite ⇒ NOT_COMPATIBLE directo. Los resultados se cachean (`meal_compatibilities`) con `profile_version` y se invalidan selectivamente (H).
- **Dependencias**: PortionOptimizer, NutritionEngine.

## 4. FamilyMealOptimizer

**Responsabilidad**: puntuar y proponer comidas/semana para toda la familia.

- **Inputs**: `PersonalMealFit` de todos los integrantes activos en esa comida, favoritos (`family_favorite_score`), votos, historial reciente (variedad), `cooking_complexity`, tiempo de cocina disponible, eventos de la semana, despensa/por vencer (del InventoryEngine), presupuesto.
- **Outputs**: `FamilyMealFitScore` por template; para modo ASISTIDO/AUTOMÁTICO, una semana propuesta (7+ asignaciones) con explicaciones por día; siempre editable por el usuario.
- **Reglas**: una receta excelente = funciona para todos con muy pocas modificaciones ⇒ el score penaliza nº de cambios y complejidad, premia favoritos compartidos y uso de próximos-a-vencer; nunca propone algo NOT_COMPATIBLE para un integrante sin marcarlo; REVIEW_REQUIRED baja el score y se muestra.
- **CookingComplexityScore**: sub-cálculo: +por preparación adicional, +por sustitución, +por método adicional, +por sartén/tanda extra (según `kitchen_equipment.capacity`).
- **Dependencias**: MealCompatibilityEngine, InventoryEngine, (ranking fino puede delegarse a RecommendationService/IA, pero el filtro de elegibilidad es siempre determinista).

## 5. InventoryEngine

**Responsabilidad**: estado de despensa, reservas, sobras, vencimientos y aprendizaje de consumo.

- **Inputs**: `inventory_movements`, `pantry_items`, `leftovers`, reservas de planes activos, `stock_targets`, historial de consumo.
- **Outputs**: stock disponible (total y no-reservado) por ingrediente en unidad canónica; lista FEFO de próximos a vencer; `estimated_weekly/monthly_consumption` y `days_of_supply`; necesidades de REPOSICIÓN (`current < minimum`); disponibilidad de sobras para "¿Qué puedo comer?".
- **Reglas**: stock siempre derivado de movimientos; aprender del historial (promedio móvil con ventana configurable), nunca inventar consumos iniciales; conversión estricta de unidades.
- **Dependencias**: ninguna de otros motores (es base para Shopping y FamilyOptimizer).

## 6. ShoppingEngine

**Responsabilidad**: de porciones finales a lista real comprable, explicable y revisable.

- **Inputs**: `member_servings` de la semana (cantidades canónicas + estado), `member_staples` (con política), salidas del InventoryEngine (stock no reservado, reposición), `commercial_products` (envases), `price_history`.
- **Outputs**: `shopping_list` con items = RECETAS + HABITUALES + REPOSICIÓN − YA DISPONIBLE → COMPRAR REALMENTE, cada item con desglose de origen ("¿Por qué?"), conversión a envases y estimación de precio; para semanas LOCKED, `shopping_list_revisions` (deltas APPLY_NOW/APPLY_NEXT_WEEK/REVIEW).
- **Reglas**: `SUM(member_final_serving)` consolidado por ingrediente — nunca receta × personas; convertir cocido→crudo/comprable con yield factors; redondeo de envases hacia arriba y explicado; determinista y re-ejecutable (misma semana, mismos insumos ⇒ misma lista).
- **Dependencias**: InventoryEngine, NutritionEngine (conversiones de unidades/estados vía sus tablas).

## 7. ClinicalRulesEngine

**Responsabilidad**: transformar resultados de laboratorio **confirmados** y condiciones en `member_clinical_constraints`, de forma 100 % determinista.

- **Inputs**: `lab_results` CONFIRMED (valores canónicos), `health_conditions`, `medications` (solo como contexto de reglas, jamás modificables), `clinical_rules` VALIDATED (DSL condición→acción, versionadas, con fuente).
- **Outputs**: constraints ACTIVE (cuando la regla estaba validada/configurada → recálculo automático) o PROPOSED (cuando implicaría un objetivo clínico nuevo → requiere confirmación §55); expiración de constraints cuya evidencia venció (`NutritionDataConfidence` → "datos clínicos: incompletos/desactualizados"); eventos para la cascada de recálculo.
- **Reglas duras**: sin LLM en este motor; sin valores inventados; toda constraint referencia la regla (código+versión) y los resultados que la originaron; los conflictos con otros objetivos pasan por la prioridad §56 con visibilidad total; nunca diagnostica ni toca medicación.
- **Dependencias**: ninguna (es el más aislado; publica hacia NutritionEngine vía datos).

---

## Contratos comunes

- **Determinismo**: mismo input ⇒ mismo output; nada de `Date.now()`/aleatoriedad dentro del motor (la fecha entra como parámetro).
- **Explicación como dato**: cada output relevante lleva `reasons[]` estructuradas (código de razón + parámetros), que la UI/IA convierten en texto. La explicabilidad no es un string suelto: es parte del contrato.
- **Versionado de insumos**: toda salida materializada registra las versiones de perfil/regla/nutrición usadas → trazabilidad y invalidación selectiva.
- **Tests**: cada motor con suite de unit tests basada en los ejemplos del Prompt Maestro (pescado 4 métodos, +180 g pollo/−100 g arroz, 850 ml → 1 L, etc.) como casos dorados.
