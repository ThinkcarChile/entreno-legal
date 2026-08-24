# D. Data Flow — Los 7 casos

Notación: cada paso indica el dominio/motor responsable. Los recálculos siguen la arquitectura de eventos de [H](./H-event-recalculation.md) (recalcular solo lo afectado, todo trazable en `change_impacts`).

---

## Caso 1 — Sebastián cambia su objetivo de proteína

1. **UI → Nutrition**: Sebastián edita su objetivo. Se inserta una fila nueva en `nutrition_goals` (source=USER, status=ACTIVE); la anterior pasa a SUPERSEDED con `end_date`. Nada se sobreescribe: el historial queda completo.
2. **Evento**: `GOAL_CHANGED {member: sebastián, goal_type: PROTEIN}` → outbox.
3. **NutritionEngine**: recalcula el perfil efectivo → `member_nutrition_profiles` **versión N+1** (inmutable, con `computed_inputs` que registran exactamente qué goal cambió). Si el nuevo objetivo choca con una restricción clínica, se crea `nutrition_conflicts` y gana la prioridad §56 — visible, nunca oculto.
4. **Invalidación selectiva**: se marcan `is_stale` solo (a) `meal_compatibilities` de Sebastián, (b) `member_servings` de Sebastián en semanas **no archivadas**, (c) los `family_meal_fits` de templates donde su compatibilidad cambió de estado.
5. **PortionOptimizer**: recalcula las porciones de Sebastián en la semana activa (150 g → 220 g de pollo, etc.), guardando `nutrition_profile_version = N+1` y la explicación.
6. **ShoppingEngine**: recomputa los totales consolidados afectados (solo ingredientes donde participan porciones de Sebastián).
   - Semana **DRAFT/CONFIRMED**: la lista se actualiza directamente.
   - Semana **LOCKED**: se genera `shopping_list_revisions` con el delta (+180 g pollo, −100 g arroz) → ver Caso 7.
7. **Notifications**: `change_impacts`: "Sebastián aumentó proteína → +480 g pollo esta semana". El comprador ve la nueva cantidad; Sebastián ve sus nuevas porciones.

**Qué NO se recalcula**: perfiles de otros integrantes, semanas archivadas, inventario, recetas donde Sebastián no participa.

---

## Caso 2 — Francisco quiere el sábado un almuerzo de máximo 1.000 kcal

1. **UI → Nutrition**: Francisco crea un `member_daily_nutrition_plans` para esa fecha (o aplica la plantilla "Almuerzo grande"): `LUNCH.calorie_max = 1000`, y el motor redistribuye el resto del día según su plantilla (once/cena más livianas) respetando mínimos de proteína.
2. El **perfil base no cambia** (no hay nueva versión de `member_nutrition_profiles`): los overrides diarios se componen en el "perfil efectivo para la fecha" = perfil vigente + override + eventos + presupuesto semanal.
3. **Evento**: `DAILY_OVERRIDE_CHANGED {member, date}` → invalida solo las porciones de Francisco **de ese día** (y del resto de la semana solo si tiene presupuesto semanal activo, que obligaría a redistribuir).
4. **PortionOptimizer**: recalcula la porción de Francisco para el almuerzo del sábado (más carbohidrato/cantidad dentro de sus rangos, respetando sus preferencias de cocción sin aceite).
5. **ShoppingEngine**: delta de compra solo para los ingredientes del sábado; mismo tratamiento LOCKED/no-LOCKED del Caso 1.
6. **Cocina**: el Modo Cocina del sábado muestra la porción distinta de Francisco automáticamente.

---

## Caso 3 — Ricardo sube nuevos exámenes (del PDF a las recetas)

1. **Upload**: SALUD → subir examen → seleccionar persona (Ricardo). El archivo va a bucket **privado** (`lab_documents`, status=UPLOADED). Solo quien tenga grant sobre los datos de Ricardo puede hacerlo.
2. **Consentimiento**: si no existe `consent_records` vigente para envío a IA, se solicita y registra antes de procesar. Sin consentimiento no hay extracción automática (queda la carga manual de valores).
3. **LabExtractionService (IA)**: OCR + extracción estructurada → por cada resultado: `test_name`, `biomarker`, `value`, `unit`, `reference_min/max`, `date`, `laboratory`, `confidence`. Validación por schema; unidades se mapean contra `biomarker_definitions` (nunca se asumen unidades inexistentes). Baja confianza se muestra, no se oculta. Status → PENDING_CONFIRMATION.
4. **Confirmación humana**: "Confirma que interpretamos correctamente este examen." Ricardo (o quien tenga grant) revisa y edita → `lab_results` guarda `raw_value`, `confirmed_value`, `confidence`, `source_document`, `confirmed_by/at`; status → CONFIRMED. **Nada entra en cálculo antes de este paso.**
5. **Evento**: `LAB_RESULTS_CONFIRMED {member: ricardo, biomarkers[]}`.
6. **ClinicalRulesEngine (determinista)**: evalúa solo las reglas VALIDATED cuyo `condition` referencia esos biomarcadores:
   - Regla ya configurada/validada para Ricardo → actualiza/crea `member_clinical_constraints` (ACTIVE) y aplica automáticamente el recálculo.
   - Regla que implicaría un **objetivo clínico nuevo** no definido → crea constraint/goal con status **PROPOSED** + `change_impacts` pidiendo confirmación/revisión. Nunca inventa límites médicos.
7. **Cascada** (solo Ricardo): `ReassessNutritionProfile` (perfil versión N+1, con `data_confidence` clínica actualizada a "reciente") → `RecalculateMealCompatibility` (sus `meal_compatibilities`; algunas recetas pasan p. ej. a COMPATIBLE_WITH_COOKING_CHANGE o REVIEW_REQUIRED) → `RecalculateMemberPortions` (semanas activas) → `CalculateShoppingImpact`.
8. **Monitoreo**: `lab_monitoring_schedules` de esos biomarcadores se marcan CURRENT y se reprograma el próximo recordatorio.
9. **Transparencia con privacidad**: `change_impacts` para la familia dice "Ricardo agregó nuevos exámenes → 3 recetas recalculadas" — los **valores** clínicos solo los ve quien tenga `health_data_grants`. Un cambio derivado de decisión médica importante nunca se aplica silenciosamente (§53).

---

## Caso 4 — Paula planifica siete platos: ¿cómo se generan porciones individuales?

1. **Selección**: Paula (rol planificador) arma `weekly_plan` con 7 `meal_assignments` (modo MANUAL o ASISTIDO; la votación familiar es opcional y previa al cierre).
2. Por cada asignación y cada integrante activo en esa comida (según su `meal_pattern` — a Francisco no se le asigna desayuno):
   a. **MealCompatibilityEngine** entrega el `PersonalMealFit` vigente (precalculado; si `is_stale`, se recomputa on-demand).
   b. **PortionOptimizer** resuelve la porción en el orden de niveles:
      - **Nivel 0**: porción base cumple los rangos min/pref/max de la persona → listo.
      - **Nivel 1**: ajusta cantidades por slot (Francisco: 220 g pollo vs 150 g familiar) buscando `preferred` y respetando `maximum` de kcal.
      - **Nivel 2**: cambia método de cocción según `member_cooking_preferences` y restricciones (Francisco: airfryer sin aceite; Sebastián: frito) → recalcula con `ingredient_cooking_effects` + grasa añadida.
      - **Nivel 3**: sustituye **un** componente vía `meal_slot_options`/`ingredient_substitutions` (pollo → salmón para una persona).
      - **Nivel 4**: si nada basta para una necesidad médica → porción marcada REVIEW_REQUIRED: "Este plato requiere una adaptación especial." La seguridad prima.
   c. Se persisten `member_servings` + `member_serving_slots` + `member_serving_nutrition`, cada una con el `profile_version` usado y sus explicaciones.
3. **FamilyMealOptimizer** calcula `family_meal_fits` y `cooking_complexity_scores`; si un plato exige demasiados cambios, sugiere alternativas antes de confirmar.
4. **Salidas**: Modo Cocina (totales a preparar = suma de porciones, divididos por método, con tandas según `kitchen_equipment`) y Shopping (Caso 5). Confirmar la semana → status CONFIRMED.

---

## Caso 5 — Francisco abre la compra semanal: de recetas a cantidades reales

Pipeline del **ShoppingEngine** (cada paso queda registrado en `shopping_item_sources` → botón "¿Por qué?"):

1. **RECETAS**: para los 7 días, sumar `member_serving_slots` por ingrediente en cantidad canónica y estado (crudo/cocido → convertir a **comprable**, normalmente crudo, con `yield_factor`). Ej.: pollo lunes 950 g + pollo jueves 1.200 g = 2.150 g. Nunca receta × 5.
2. **HABITUALES**: agregar `member_staples`: ADD_ALWAYS entra directo; ASK genera el prompt "¿Agregar tus habituales?" (yogures, berries, avena, plátanos de Francisco); NEVER se omite.
3. **REPOSICIÓN**: `stock_targets` con `current < minimum` agregan `target − current`.
4. **YA DISPONIBLE**: **InventoryEngine** descuenta despensa (Caso 6). Ej.: pollo congelado 650 g → 2.150 − 650 = 1.500 g.
5. **FORMATOS COMERCIALES**: convertir cantidad → envases (`commercial_products.package_quantity`): 850 ml de leche → 1 envase de 1 L; redondeos siempre hacia arriba y explicados.
6. **COMPRAR REALMENTE**: lista final `shopping_list_items` con `to_buy_quantity`, envases sugeridos y estimación de precio si hay `price_history`.
7. **Compra en vivo**: lista compartida por Realtime — Paula agrega leche y aparece al instante; Francisco marca COMPRADO y se sincroniza; cada COMPRADO genera `inventory_movements(PURCHASE)` al confirmar la compra (entrada a despensa).

---

## Caso 6 — Hay alimentos en la despensa: ¿cómo se descuentan?

1. **Fuente de verdad**: `pantry_items` cuyo stock es la suma de `inventory_movements` (compras +, consumo/cocina −, mermas −, ajustes ±, sobras ±).
2. **En la compra (reserva lógica)**: al generar la lista, el ShoppingEngine descuenta stock disponible **no reservado**: descuenta primero lo más próximo a vencer (FEFO), respetando unidad canónica y equivalencias. El descuento es una *reserva* asociada al plan (no un movimiento físico todavía) para que dos semanas no descuenten el mismo arroz dos veces.
3. **Al cocinar**: Modo Cocina "preparar 450 g arroz crudo" → al confirmar la preparación se registra `inventory_movements(COOKING, −450 g)` contra la reserva; la diferencia entre cocinado y consumido vuelve como `leftovers` (+250 g pollo cocido, ubicación FRIDGE, `use_by`).
4. **Consumo directo** (yogur de la once, fruta): `consumption_logs` genera el movimiento de salida correspondiente.
5. **Ajustes**: conteo manual ("en realidad quedan 2,5 kg de arroz") = `ADJUSTMENT` auditable; nunca edición silenciosa.
6. **Aprendizaje**: el historial de movimientos alimenta `estimated_weekly_consumption` (promedio móvil por ingrediente) → `days_of_supply`, stock recomendado mensual (§37) y REPOSICIÓN. Al inicio no se inventan cantidades: sin historial suficiente, no hay recomendación de stock.
7. **Vencimientos**: job diario detecta `expiry_date` próximos → "Tienes 3 yogures que vencen pronto" + el recomendador prioriza recetas/postres que los usen.

---

## Caso 7 — Alguien cambia objetivos después de la compra: bloqueo/revisión de semana

1. **LOCK_WEEK**: al marcar la compra realizada, `weekly_plans.status = LOCKED` (se guarda quién y cuándo). La lista queda congelada como fue comprada.
2. Cambio posterior (Sebastián sube proteína): el flujo del Caso 1 corre **igual hasta el paso 5** — su perfil y sus porciones *futuras dentro de la semana* se recalculan como propuesta, pero **la compra no se modifica silenciosamente**.
3. **ShoppingEngine** genera `shopping_list_revisions` con el delta explicado:
   > "Sebastián cambió su objetivo." Impacto: **+180 g pollo, −100 g arroz.**
4. El planificador/comprador decide:
   - **APPLY_NOW**: se crea una mini-lista adicional de compra (o se reasigna desde despensa si alcanza) y las porciones nuevas quedan vigentes ya.
   - **APPLY_NEXT_WEEK**: la semana actual mantiene las porciones antiguas (el perfil nuevo queda registrado con `effective_from` = próxima semana para efectos de planificación); la próxima planificación nace con el objetivo nuevo.
   - **REVIEW**: queda pendiente en "¿Qué cambió?" hasta decidir.
5. **Excepción de seguridad**: si el cambio proviene de una **restricción clínica confirmada** (prioridad 1–2), las porciones se ajustan de inmediato aunque la semana esté bloqueada (la compra puede quedar con excedente, señalado en el impacto). La seguridad prima sobre el lock.
6. Todo queda en `change_impacts` con actor, causa, delta y decisión tomada.
