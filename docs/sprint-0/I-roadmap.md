# I. Roadmap — 13 sprints

Cada sprint termina con una **funcionalidad utilizable** por la familia, build verde, tests, lint y typecheck (ciclo §83). El orden respeta las dependencias del modelo: identidad → catálogo → nutrición → planificación → compra → inventario → salud → IA avanzada.

| # | Sprint | Entregable utilizable | Contenido principal |
|---|---|---|---|
| 1 | **Fundaciones** | Familia puede crear su hogar e iniciar sesión | Scaffold Next.js+TS strict+Tailwind+Supabase; CI (lint/typecheck/test/build); esquema base Family (households, members, roles) con RLS desde el día 1; invitaciones; PWA shell mobile-first; pantalla FAMILIA mínima |
| 2 | **Catálogo de alimentos** | Buscar ingredientes con nutrición real | ingredients + nutrition (fuente verificada, seed inicial curado), unidades/equivalencias/estados (RAW/COOKED…), cooking_methods + efectos, categorías; commercial_products (manual); admin de catálogo |
| 3 | **Recetas modulares** | Ver y crear platos con slots y variantes | meal_templates/slots/options, sustituciones, salad_templates, dessert_templates, recipe_steps; recipe_nutrition calculada por NutritionEngine (primera versión del motor de cálculo por cantidad+método+grasa); pantalla RECETAS y RECETA. *(Las 28 recetas seed entran aquí o en el sprint 6, cuando el modelo esté probado.)* |
| 4 | **Perfiles y objetivos** | Cada integrante configura gustos, objetivos y patrón | preferences (LIKE→MEDICAL_RESTRICTION sin capa clínica aún), favoritos + FamilyFavoriteScore, cooking_preferences, nutrition_goals (min/pref/max, historial), meal_patterns + ayuno, MemberNutritionProfile versionado (NutritionEngine completo); pantalla MI NUTRICIÓN y outbox de eventos (H) básica |
| 5 | **Planificación semanal manual** | Paula arma la semana y ve porciones por persona | weekly_plans/days/assignments; PortionOptimizer (niveles 0–3) + MealCompatibilityEngine + explicaciones; member_servings/nutrition; pantallas SEMANA y PLANIFICAR; day_templates + daily overrides + eventos (targets efectivos por fecha) |
| 6 | **Modo Cocina + biblioteca 28 platos** | El cocinero cocina con instrucciones exactas | Totales por método, división por persona, pasos paralelos, kitchen_equipment y tandas; carga curada de los ~28 platos; CookingComplexityScore |
| 7 | **Compras** | Francisco compra con lista real y explicable | ShoppingEngine (RECETAS+HABITUALES+REPOSICIÓN−DESPENSA→COMPRAR), member_staples, formatos comerciales, lista compartida Realtime, "¿Por qué?" por producto; LOCK_WEEK + revisions + pantalla CAMBIOS (change_impacts) |
| 8 | **Despensa e inventario** | La casa sabe qué tiene | pantries/items/locations, inventory_movements, leftovers, vencimientos (FEFO + avisos), descuento en compra, ajustes auditables; consumo real básico ("comí lo planificado" + manual) actualizando macros restantes |
| 9 | **Stock inteligente** | Reposición automática aprendida | stock_targets, aprendizaje de consumo semanal/mensual desde historial, days_of_supply, sección REPOSICIÓN completa; price_history manual y estimación de gasto |
| 10 | **Salud (base)** | Subir exámenes y confirmarlos con privacidad real | health_profiles/conditions/medications, lab_documents (bucket privado+signed URLs), biomarker_definitions, LabExtractionService + confirmación humana, tendencias por biomarcador, health_data_grants, consent_records, auditoría; pantalla SALUD |
| 11 | **Motor clínico** | Exámenes confirmados influyen en comidas, con trazabilidad | clinical_rules (DSL validado, versionado, con fuentes) + ClinicalRulesEngine, member_clinical_constraints (ACTIVE/PROPOSED), cascada LAB→perfil→compatibilidad→porciones→compra, NutritionConflict + prioridades §56, LabMonitoringSchedule + recordatorios + NutritionDataConfidence |
| 12 | **Recomendación y "¿Qué puedo comer?"** | La app propone; la familia decide | FamilyMealOptimizer completo (variedad, por-vencer, complejidad, presupuesto semanal), modos ASISTIDO/AUTOMÁTICO, votación familiar, WHAT_CAN_I_EAT_NOW (despensa+sobras+macros restantes), RecommendationService + feedback |
| 13 | **Registro avanzado e importación** | Registrar por foto/voz/barcode; importar recetas | FoodLoggingService (confirmable), barcode → producto/despensa/compra, RecipeImportService (URL/texto/imagen → template confirmado); pulido PWA (offline de lista de compras), onboarding familiar |

## Notas

- **RLS y auditoría no son un sprint**: nacen en el sprint 1 y cada sprint agrega sus políticas junto con sus tablas.
- **Los motores se testean con casos dorados del Prompt Maestro** en el sprint donde nacen (E).
- Sprints 10–11 están deliberadamente tarde: requieren que perfiles, recálculo y explicabilidad ya funcionen para que lo clínico entre con seguridad. Si el director prefiere valor clínico antes, pueden adelantarse a costa de 7–9.
- Después del 13: historial de precios avanzado/comparación de supermercados, scraping (hoy excluido), multi-household por usuario, integración con dispositivos.
