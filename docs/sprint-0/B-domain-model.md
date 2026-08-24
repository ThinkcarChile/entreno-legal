# B. Domain Model

Nueve dominios (bounded contexts). Cada uno tiene entidades propias, un contrato público (servicios/consultas) y no accede a las tablas internas de otro dominio directamente: se comunica vía servicios de aplicación y eventos de dominio (ver [H](./H-event-recalculation.md)).

```
┌─────────────────────────────────────────────────────────────────┐
│                            UI (Next.js)                         │
├─────────────────────────────────────────────────────────────────┤
│                        Application Layer                        │
├──────────┬──────────┬─────────┬──────────┬──────────┬───────────┤
│  Family  │Nutrition │  Meals  │  Health  │ Planning │ Shopping  │
│          │          │         │          │          │ Inventory │
├──────────┴──────────┴─────────┴──────────┴──────────┴───────────┤
│   Engines (puros, deterministas): Nutrition · Portion · Compat  │
│   FamilyOptimizer · Inventory · Shopping · ClinicalRules        │
├─────────────────────────────────────────────────────────────────┤
│   AI Services (AIProvider + servicios con schema validation)    │
├─────────────────────────────────────────────────────────────────┤
│   Data Access (Supabase/Postgres, RLS) · Domain Event Bus       │
└─────────────────────────────────────────────────────────────────┘
```

## 1. Family (Hogar e identidad)

**Responsabilidad**: households, integrantes, cuentas, roles y permisos.

- Entidades: `User`, `Household`, `HouseholdMember`, `HouseholdRole`, asignación de roles.
- Reglas clave: un `User` puede pertenecer a un Household; un `HouseholdMember` puede existir **sin cuenta** (p. ej. un niño) y vincularse a un `User` después; una persona puede tener varios roles (integrante, planificador, comprador, cocinero, administrador familiar).
- Es la base del aislamiento de seguridad: todo dato del sistema cuelga (directa o transitivamente) de un `household_id`.
- Los permisos médicos son adicionales y viven en Health (grants explícitos), no se derivan del rol.

## 2. Nutrition (Objetivos y perfil efectivo)

**Responsabilidad**: la verdad nutricional vigente de cada persona.

- Entidades: `NutritionGoal` (min/preferred/max, con `source` USER/CLINICIAN/SYSTEM/AI_PROPOSAL y vigencia), `GoalHistory`, `MemberNutritionProfile` (snapshot **versionado** e inmutable), `MealPattern` (qué comidas hace cada persona, ayuno intermitente como patrón), `DailyNutritionPlan` (overrides por fecha), `DayTemplate` ("día normal", "día entrenamiento"…), `NutritionEvent` (cumpleaños, asado…), presupuesto semanal opcional, `NutritionConflict`.
- Regla clave: **ningún otro módulo calcula objetivos**; todos consultan el `MemberNutritionProfile` vigente (o el efectivo para una fecha, que combina perfil + override diario + eventos).
- Resuelve conflictos con la prioridad del Prompt Maestro §56 y los deja visibles, nunca ocultos.

## 3. Meals (Catálogo de comidas)

**Responsabilidad**: recetas modulares y datos de alimentos.

- Entidades: `Ingredient` (+ nutrición estructurada por 100 g, fuente y verificación), `IngredientCategory`, `CommercialProduct` (marca, código de barras, envase, nutrición real del producto, precio), `MealTemplate` con `MealSlot`s (Protein/Carbohydrate/Vegetable/Salad/Fat/Sauce/Optional/Dessert), `MealSlotOption`, `IngredientSubstitution`, `NutritionalEquivalent`, `SaladTemplate`, `DessertTemplate`, `RecipeStep`, métodos de cocción (`CookingMethod`) con efectos nutricionales (grasa añadida, factores de rendimiento crudo/cocido).
- Regla clave: variaciones de un mismo plato se modelan como opciones de slot, no como recetas duplicadas. Las ensaladas y postres son estructuras de primera clase con nutrición calculada.

## 4. Health (Salud clínica)

**Responsabilidad**: datos médicos y su transformación segura en restricciones.

- Entidades: `HealthProfile`, `HealthCondition`, `Medication`, `LabDocument` (archivo privado), `LabTest`, `LabResult` (raw/confirmed/confidence), `BiomarkerDefinition`, `LabMonitoringSchedule`, `HealthReminder`, `ClinicalRule` (determinista, versionada, con fuente), `MemberClinicalConstraint`, `NutritionDataConfidence` (vigencia/completitud, nunca un "score de salud"), `ConsentRecord`.
- Reglas clave: separación física y de permisos respecto del resto de dominios; nada clínico entra en cálculo sin **confirmación humana**; los recálculos que crean objetivos clínicos nuevos generan **propuestas**, no cambios silenciosos.

## 5. Planning (Semana familiar)

**Responsabilidad**: convertir catálogo + perfiles en una semana concreta.

- Entidades: `WeeklyPlan` (con estado DRAFT/VOTING/CONFIRMED/LOCKED), `WeeklyPlanDay`, `MealAssignment` (receta, comer fuera, sobras, evento, comida libre), `MemberServing` y `MemberServingNutrition` (porción final por persona: cantidad + método + grasa añadida + sustituciones), `MealCompatibility`/`PersonalMealFit`, `FamilyMealFit`, `CookingComplexity`, votación familiar (LOVE/LIKE/NEUTRAL/DISLIKE), modos MANUAL/ASISTIDO/AUTOMÁTICO, bloqueo de semana y revisiones de impacto.
- Regla clave: la personalización sigue estrictamente los niveles 0–4; `REVIEW_REQUIRED` cuando una necesidad médica no se resuelve con cantidad/método/una sustitución.

## 6. Shopping (Compra)

**Responsabilidad**: de porciones finales a lista real comprable.

- Entidades: `ShoppingList`, `ShoppingListItem` (con desglose explicable: recetas por día, habituales, reposición, descuento de despensa), `ShoppingListRevision` (cambios post-lock), `StapleProduct` (habituales por persona con ADD_ALWAYS/ASK/NEVER), conversión a formatos comerciales, `PriceHistory` (store/product/price/date), lista compartida en tiempo real con estado COMPRADO.
- Regla clave: la cantidad nace de `SUM(member_final_serving)` consolidada por ingrediente, nunca de receta × personas.

## 7. Inventory (Despensa)

**Responsabilidad**: qué hay en la casa y cuánto conviene tener.

- Entidades: `Pantry`, `PantryLocation` (PANTRY/FRIDGE/FREEZER/OTHER), `PantryItem` (cantidad, unidad, vencimiento opcional), `StockTarget` (current/minimum/target, consumo semanal/mensual estimado, days_of_supply), `InventoryMovement` (toda variación es un movimiento auditable: compra, consumo, cocción, merma, ajuste), `Leftover`/`PreparedFoodInventory`.
- Reglas clave: el stock se deriva de movimientos (no se edita "a mano" sin dejar movimiento); los consumos estimados se **aprenden del historial**, no se inventan; alimentos por vencer alimentan al recomendador.

## 8. AI (Servicios de inteligencia)

**Responsabilidad**: extracción, razonamiento explicativo, ranking, importación y registro de consumo asistido — detrás de abstracciones.

- Servicios: `AIProvider`, `LabExtractionService`, `NutritionReasoningService`, `RecommendationService`, `RecipeImportService`, `FoodLoggingService` (texto/voz/foto/código de barras).
- Entidades: `AIRecommendation`, `RecommendationReason`, `RecommendationFeedback`.
- Reglas clave: toda salida es estructurada y validada por schema; toda estimación de IA requiere confirmación humana antes de convertirse en dato; mínimo envío de información (ver [F](./F-ai-architecture.md) y [G](./G-security-model.md)).

## 9. Notifications & Audit (Transversal)

**Responsabilidad**: comunicar cambios y dejar rastro.

- Entidades: `DomainEvent` (outbox), `ChangeImpact` (la pantalla "¿Qué cambió?"), `HealthReminder`, recordatorios de exámenes (CURRENT/EXPIRING_SOON/OUTDATED/MISSING), `AuditEvent` (accesos a datos médicos, confirmaciones, consentimientos).
- Regla clave: todo cambio automático relevante es explicable y atribuible (quién/qué lo causó, qué recalculó, con qué versión de perfil).

## Dependencias entre dominios (dirección permitida)

```
Family  ←─ todos (identidad y aislamiento)
Nutrition ←─ Planning, Shopping, AI          (consultan perfil efectivo)
Nutrition ─→ consume: Health (constraints confirmados), Family
Meals   ←─ Planning, Shopping, Inventory, AI (catálogo)
Health  ─→ publica constraints hacia Nutrition; no conoce Planning
Planning ─→ produce MemberServing → Shopping
Inventory ─→ descuenta en Shopping; recibe movimientos de Shopping/Cocina
AI      ─→ solo a través de servicios; nunca escribe datos finales sin confirmación
```
