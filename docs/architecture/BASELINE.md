# ARCHITECTURE BASELINE 1.0 — FROZEN

> Congelada el **2026-08-24** por aprobación del director del proyecto.
> Composición: **Prompt Maestro + Sprint 0 (A–K) + Addendum 0.1 + Addendum 0.2 (con revisión final incorporada)** — todo en [`docs/sprint-0/`](../sprint-0/README.md).

## Régimen de cambios desde ahora

- Cualquier **cambio estructural importante** (entidades, invariantes, boundaries de dominio, decisiones K-1…K-25) requiere un **ADR** en [`docs/adr/`](../adr/) + migración normal versionada. No más Sprint 0.x, salvo problema crítico descubierto durante implementación.
- Cambios no estructurales (campos menores, índices, UI, contenido) siguen el flujo normal de sprint sin ADR.
- El ciclo de trabajo por sprint es el del Prompt Maestro §83; ningún sprint se declara terminado con el build roto.

## Confirmación final de cobertura

Revisión de Prompt Maestro + Sprint 0 + 0.1 + 0.2 contra la lista de requisitos. **Todos tienen ubicación arquitectónica definida:**

| Requisito | Ubicación |
|---|---|
| Familia multiusuario | Family: households/members/roles, miembros sin cuenta (K-2) |
| Tracking opcional | `member_tracking_settings` OFF/BASIC/FULL (K-25) |
| Recetas modulares/versionadas | MealTemplate+slots (Sprint 0 §C-3) + `meal_template_versions` (K-21) |
| Macros personales | `nutrition_goals` min/pref/max + `member_nutrition_profiles` versionado (K-3) |
| Días y comidas diferentes | day_templates + daily overrides + eventos + presupuesto semanal |
| Ayuno | `meal_patterns` (ventana de alimentación, primera comida) |
| Postres / frutas / ensaladas | DessertTemplate / member_fruit_plans / SaladTemplate (primera clase) |
| Preferencias de cocción | `member_cooking_preferences` + efectos por método |
| Equipamiento opcional | `household_equipment` + capacidades + método base manual obligatorio (K-15) |
| Salud/exámenes + vigencia | Health 🔒: lab pipeline con confirmación + `lab_monitoring_schedules` + `NutritionDataConfidence` |
| Actividad/pasos | `member_activity_days` |
| Entrenamiento y progresión | modelo normalizado sesión→ejercicio→serie + aliases (K-23) |
| Productos personalizados/barcode | `commercial_products` por ámbito hogar/global (0.2 §2.2) |
| Consumo real pesado | `consumption_logs` (fracción/cantidad real, off-plan, affects_inventory) |
| Peso y objetivos | `body_measurements` append-only + `member_body_goals` + tendencia + TDEE observado (K-24) |
| Inventario por lotes | `inventory_lots` + ledger con causas e invariantes (K-11, K-18, K-19) |
| Desperdicio | movimiento con causa + cost_allocation WASTED + tasa en forecast |
| Costos | Finance: purchases/cost_allocations/presupuestos, caja ≠ consumo (K-12) |
| Compra por integrante | porciones finales + staples + costo por member vía cantidades reales |
| Ciclos de abastecimiento | `reorder_rules` por producto (0.1 §6) |
| Proveedores | suppliers/orders/deliveries (0.1 §6) |
| Batch prep | prep_batches → movimientos del ledger + BatchPrepOptimizer |
| Conservación | `FoodStorageSafetyEngine` + reglas versionadas + SAFETY_REVIEW_REQUIRED (K-14, K-18) |
| Etiquetas/QR | label_templates/print_jobs, PDF primero, QR = id opaco (K-16) |
| Forecasting | `DemandForecastEngine` + demand_forecasts/reorder_suggestions |

**Diferidos con ubicación definida** (no son huecos; su arquitectura existe y su implementación está calendarizada o pospuesta explícitamente): impresión térmica directa (driver adicional de `print_jobs`), base externa de códigos de barra, integración con dispositivos (pasos/peso, `source=DEVICE`), scraping de precios.

**Único punto sin diseño de detalle** (no estructural, no costoso de diferir): el **canal de entrega de notificaciones** (push/email). El dominio Notifications y su contenido (`change_impacts`, `health_reminders`) están definidos; el transporte se decidirá cuando un sprint lo necesite (probablemente con la lista compartida o los recordatorios de exámenes) — no requiere ADR salvo que introduzca infraestructura nueva.

## Documentos de la baseline

- [Sprint 0 A–K](../sprint-0/README.md)
- [Addendum 0.1](../sprint-0/12-addendum.md)
- [Addendum 0.2 + revisión final](../sprint-0/13-addendum-0.2.md)
- Decisiones estructurales: K-1…K-10 (Sprint 0), K-11…K-17 (0.1), K-18…K-25 (0.2/rev. final)
