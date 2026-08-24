# Sprint 0.1 — Addendum arquitectónico

> Estado: **PARA REVISIÓN DEL DIRECTOR DEL PROYECTO** — el Sprint 1 no comienza hasta su aprobación.
> Este addendum incorpora los requisitos de finanzas, procurement, preparación/almacenamiento, desperdicio, pronóstico y etiquetado al diseño del Sprint 0. Los documentos A–K se modificaron **solo** donde cambia una relación o decisión estructural; todo lo demás del Sprint 0 sigue vigente.

## Índice

1. [La decisión central: inventario por lotes](#1-la-decisión-central-inventario-por-lotes)
2. [Nuevos dominios y boundaries](#2-nuevos-dominios-y-boundaries)
3. [Finanzas de alimentación](#3-finanzas-de-alimentación)
4. [Importación de boletas y compras](#4-importación-de-boletas-y-compras)
5. [Desperdicio](#5-desperdicio)
6. [Procurement: ciclos, proveedores y pedidos](#6-procurement-ciclos-proveedores-y-pedidos)
7. [Pronóstico de demanda y cobertura](#7-pronóstico-de-demanda-y-cobertura)
8. [Prep & Storage](#8-prep--storage)
9. [Equipamiento opcional y capacidades](#9-equipamiento-opcional-y-capacidades)
10. [Seguridad de almacenamiento](#10-seguridad-de-almacenamiento)
11. [Etiquetas, QR e impresión](#11-etiquetas-qr-e-impresión)
12. [Precisión sobre LOCK_WEEK: ClinicalImpactReview](#12-precisión-sobre-lock_week-clinicalimpactreview)
13. [Revisión del modelo: permanece / se modifica / nuevo / se elimina](#13-revisión-del-modelo)
14. [Dependencias entre dominios y flujo completo](#14-dependencias-entre-dominios-y-flujo-completo)
15. [Garantías de no-doble-conteo](#15-garantías-de-no-doble-conteo)
16. [Decisiones estructurales nuevas (K-11…K-17)](#16-decisiones-estructurales-nuevas)

---

## 1. La decisión central: inventario por lotes

Casi todos los requisitos nuevos (paquetes de pollo etiquetables, sobras, FEFO, costo consumido vs desperdiciado, QR, batch prep, descongelación) son **vistas del mismo objeto físico**. Por eso el cambio estructural clave del 0.1 es promover el inventario de "ítems de despensa + movimientos" a un **ledger de lotes**:

### `inventory_lots` — el objeto físico identificable

Cada cosa concreta que existe en la casa es un lote:

- `id` (identificador opaco — es lo que va en el QR), `household_id`
- `ingredient_id | product_id` y `origin`: `purchase_item_id null` | `parent_lot_id null` | `source_assignment_id null` (cocción/sobras)
- `quantity_canonical` + `unit`, `weight_basis` (RAW/COOKED/…)
- `state`: `RAW | PREPPED | COOKED | FROZEN | THAWED`
- `location_id` (→ `storage_locations`), `vacuum_sealed boolean`
- `unit_cost null` (heredado del purchase_item; se propaga en splits/transformaciones — base del costeo, §3)
- `expiry_date null` / `use_by null` (calculada por el FoodStorageSafetyEngine al cambiar de estado)
- **Uso previsto** (opcional): `planned_assignment_id`, `planned_use_date`, `planned_cooking_method`, `planned_member_id null`
- `prep_metadata` (método de corte/disco usado, instrucciones breves — para la etiqueta)
- `status`: `AVAILABLE | RESERVED | CONSUMED | DISCARDED` (derivado de movimientos, cacheado)

### `inventory_movements` — único mecanismo de variación

Sin cambios de filosofía (libro mayor, nunca edición directa), con dos extensiones:

- referencia obligatoria a `lot_id` (o creación de lote en entradas), y
- `reason` explícita: `PURCHASE | CONSUMED | USED_IN_RECIPE | SPOILED | EXPIRED | DAMAGED | DISCARDED_LEFTOVER | PURCHASE_PROBLEM | ADJUSTMENT | SPLIT | MERGE | TRANSFORM | COOK | THAW | MOVE | LABEL_WEIGHT_UPDATE | OTHER`
- `group_id`: los movimientos de una misma operación física (un split, una cocción) comparten grupo, y el grupo tiene un **invariante verificable** (abajo).

### Semántica de las operaciones (sin inventario ficticio)

| Operación | Movimientos del grupo | Invariante del grupo |
|---|---|---|
| **SPLIT** (4 kg pollo → 4 paquetes de 1 kg) | `SPLIT −4000 g` sobre el lote padre + 4 × `SPLIT +1000 g` creando lotes hijos (`parent_lot_id`) | Σ deltas = 0 en base cruda; el total sigue siendo 4 kg |
| **MERGE** (juntar dos restos de arroz) | 2 × `MERGE −x` + 1 × `MERGE +Σx` | Σ deltas = 0 |
| **MOVE** (congelador → refrigerador) | 1 × `MOVE` (cambia `location_id`; delta 0); si implica THAW, ver abajo | Cantidad intacta |
| **TRANSFORM** (rallar, porcionar, marinar) | `TRANSFORM −x` padre + `TRANSFORM +x` hijo con `state=PREPPED` y `prep_metadata` | Σ = 0 salvo merma declarada explícita (parte no comestible → movimiento WASTE del mismo grupo) |
| **COOK** | `COOK −x` (lote crudo) + `COOK +y` (lote `COOKED`), con `y = x × yield_factor`; el grupo guarda ambas bases | Conservación en base cruda: la equivalencia cruda del lote cocido = x − merma declarada |
| **THAW** | 1 × `THAW` (delta 0; `state FROZEN→THAWED`); el SafetyEngine recalcula `use_by` y prohíbe re-congelar según regla | Cantidad intacta |
| **WASTE** (manzana podrida) | 1 × movimiento con reason `SPOILED/EXPIRED/…` −1 unit | Disminuye stock **y** dispara la asignación de costo WASTED (§3) — un solo evento, dos vistas |
| **CONSUME** | movimiento `CONSUMED/USED_IN_RECIPE` −x, referenciando `consumption_log` o `member_serving` | El log de consumo es la fuente; el movimiento es su efecto — nunca dos registros de consumo |

**Relación con conceptos del Sprint 0**:

- `pantry_items` **desaparece**: era el lote sin identidad. Una "vista de despensa" agrega lotes por producto+ubicación.
- `leftovers` **desaparece como tabla**: una sobra es un lote con `origin = source_assignment_id` y `state = COOKED`. Conserva todo su comportamiento (sugerible en once/cena, participa en inventario, FEFO).
- Las **reservas por plan** del Sprint 0 ahora se materializan mejor: reservar = `status=RESERVED` + `planned_assignment_id` sobre lotes concretos (elegidos por FEFO), lo que además alimenta etiquetas ("JUEVES — POLLO 1.150 g").

### FEFO

Orden de consumo/reserva/sugerencia: `use_by` asc → `expiry_date` asc → fecha de preparación asc. El RecommendationService y "¿Qué puedo comer?" reciben esta lista priorizada del InventoryEngine (opcional para el usuario, por defecto activa en perecibles).

---

## 2. Nuevos dominios y boundaries

Se agregan **tres dominios** (el mapa completo actualizado está en [B](./B-domain-model.md)):

- **Procurement** — canales de adquisición: ciclos de compra por producto, proveedores, pedidos, entregas y recepción. *Shopping* queda enfocado en **consolidar demanda** (la lista viva y explicable); *Procurement* la **ejecuta** por el canal correcto (supermercado ahora, proveedor de carnes quincenal, arroz mensual). Ambos convergen en `purchases` al recibir.
- **Prep & Storage** — de la compra recibida a lotes listos: sesiones "PREPARAR COMPRA", tareas de lavado/corte/porcionado, instrucciones de almacenamiento y descongelación (motor de reglas), etiquetas/QR, equipamiento y capacidades.
- **Finance** — capa **derivada y de solo lectura** sobre purchases + movimientos + asignaciones de costo: nunca es fuente de verdad de cantidades; por eso no puede introducir doble conteo.

---

## 3. Finanzas de alimentación

### Principio contable

Separar **caja** de **consumo** (inventario perpetuo):

- `PURCHASED` — gasto de caja: pertenece al período de la compra (agosto pagó los 5 kg de arroz).
- `INVENTORY` — valor restante: `Σ (cantidad restante del lote × unit_cost)`.
- `CONSUMED` — costo atribuible: se devenga cuando ocurren los movimientos de consumo (2 kg consumidos en agosto → solo ese costo es consumo de agosto).
- `WASTED` — costo de movimientos con causa de desperdicio.

**Invariante por lote**: `costo de compra del lote = CONSUMED + WASTED + INVENTORY` (± redondeo). Verificable por job.

### Entidades

- **`purchases`** — el acto de adquisición, cualquiera sea el canal: `household_id`, `channel` (SUPERMARKET/SUPPLIER_ORDER/OTHER), `store_or_supplier_id`, `purchased_at`, `total_paid`, `source` (MANUAL/RECEIPT_IMPORT/ORDER_RECEIPT), `receipt_id null`, `shopping_list_id null` / `purchase_order_id null` (→ planificado vs real).
- **`purchase_items`** — línea de compra: `product_id|ingredient_id`, `quantity_canonical`, `unit_price`, `discount`, `final_price`, `shopping_list_item_id null` (match planificado↔real; ítems sin match = compra no planificada, visible en métricas). Al confirmar recepción, cada línea **crea lotes** con `unit_cost = final_price / quantity`.
- **`purchase_receipts`** — documento de boleta (ver §4).
- **`price_observations`** — reemplaza a `price_history`: una observación por (producto, comercio, fecha, precio, `source` MANUAL/RECEIPT/ORDER). Las compras generan observaciones automáticamente; también se puede anotar un precio visto sin comprar.
- **`cost_allocations`** — el puente costo↔realidad: `movement_id` (único → imposible asignar dos veces el mismo movimiento), `lot_id`, `category` (CONSUMED/WASTED), `amount`, `member_id null`, `assignment_id null`, `period_date`.
- **`household_food_budgets`** — presupuesto: `period_type` (WEEK/MONTH), `amount`, `category_id null`, vigencia.

### Métricas (todas derivadas — vistas/consultas, sin estado propio)

| Métrica | Fuente |
|---|---|
| Gasto semanal/mensual, por categoría, por comercio | `purchases`/`purchase_items` |
| Costo por receta / por porción | `cost_allocations` vía `member_servings` de la asignación (costo real de los lotes usados) |
| **Costo consumido por integrante** | Σ `cost_allocations` con su `member_id` — atribución por **cantidad realmente consumida/servida** (member_servings y consumption_logs), jamás gasto ÷ nº de integrantes. Ítems compartidos sin atribución individual (aceite de la sartén común) se reparten en proporción a las cantidades servidas de esa preparación, no por cabeza |
| Costo desperdiciado (y por causa) | `cost_allocations` WASTED + `reason` del movimiento |
| Valor de inventario | lotes vivos × `unit_cost` |
| Planificado vs real | `shopping_list_items.price_estimate` vs `purchase_items.final_price` + ítems sin match |
| Proyección futura | DemandForecast × última/mediana `price_observation` por producto |

---

## 4. Importación de boletas y compras

Misma arquitectura probada del pipeline de exámenes (subir → extraer → confirmar → aplicar), sin datos clínicos de por medio:

```
BOLETA (PDF/foto/captura/pedido online/lista Lider)
  → purchase_receipts (bucket privado del hogar, processing_status)
  → ReceiptExtractionService (IA): por línea → producto, marca, cantidad, unidad,
    precio unitario, descuentos, precio final, fecha, comercio + confidence por campo
  → matching contra commercial_products / ingredients (por barcode, nombre, historial
    de compras del hogar); candidatos con score, nunca match silencioso de baja confianza
  → CONFIRMACIÓN del usuario cuando hay incertidumbre (líneas ilegibles quedan vacías,
    jamás inventadas; producto nuevo → alta rápida de commercial_product)
  → purchase + purchase_items confirmados
  → lotes de inventario + price_observations + conciliación con la shopping_list
```

Se diseña ahora; se implementa en un sprint posterior (la tabla y los estados existen desde que exista `purchases`, con `source=MANUAL` como único camino inicial).

---

## 5. Desperdicio

No existe una entidad `WasteEvent` separada: **un desperdicio es un `inventory_movement` con causa de desperdicio** (`SPOILED/EXPIRED/DAMAGED/DISCARDED_LEFTOVER/PURCHASE_PROBLEM`), lo que garantiza que un único registro:

1. disminuye inventario (es un movimiento del ledger);
2. registra costo desperdiciado (su `cost_allocation` categoría WASTED);
3. alimenta métricas (vistas sobre movimientos+allocations, por causa/categoría/período);
4. alimenta el pronóstico (§7) como historial de merma por producto.

UX: registrar "−1 manzana, se pudrió" es una acción de dos toques desde el lote o desde la vista de despensa (y desde el QR de la etiqueta).

---

## 6. Procurement: ciclos, proveedores y pedidos

### Ciclos de compra por producto — `reorder_rules`

Reemplaza y amplía a `stock_targets`. Por (household, producto/categoría):

- `strategy`: `WEEKLY | BIWEEKLY | MONTHLY | MIN_STOCK | PER_PLAN | ON_DEMAND`
- `minimum_stock`, `target_stock`, `safety_stock` (para MIN_STOCK)
- `preferred_channel`: SUPERMARKET | `supplier_id`
- `review_day null` (día habitual de esa compra)

Defaults sugeridos y configurables por hogar (frutas/verduras/lácteos semanal; pollo/carne quincenal-mensual; arroz mensual; aceite por stock mínimo). El consumo aprendido ya no vive aquí: vive en `demand_forecasts` (§7).

### `reorder_suggestions`

Salida materializada del DemandForecastEngine: producto, cantidad recomendada, fecha recomendada, canal, razones (demanda planificada, cobertura, lead time). El planificador/comprador las acepta hacia la lista o hacia un pedido.

### Proveedores y pedidos

- **`suppliers`** — `name`, `contact null`, `delivery_days` (días de la semana), `default_lead_time_days`, `notes`.
- **`supplier_products`** — producto, `known_price` (+fecha), `minimum_quantity`, `lead_time_days` (override), formato de venta.
- **`purchase_orders`** + **`purchase_order_items`** — estado: `SUGGESTED → PLANNED → ORDERED → READY → DELIVERING → RECEIVED → STORED | CANCELLED`. Sin integración externa: el pedido es un registro que una persona gestiona por teléfono/web del proveedor.
- **`deliveries`** — recepción: fecha esperada/real, quién recibió, incidencias (`PURCHASE_PROBLEM` → movimiento + costo).

**Convergencia**: recibir un pedido (RECEIVED→STORED) o cerrar una compra de supermercado crea el mismo objeto `purchase` → lotes. Aguas abajo (finanzas, inventario, prep) no distinguen el canal.

### `purchase_schedules` (vista/plan)

Agenda derivada: qué canal toca qué día (según reorder_rules + delivery_days + plan semanal), visible en la pantalla COMPRAS.

---

## 7. Pronóstico de demanda y cobertura

### `DemandForecastEngine` (motor nuevo — se suma a los 7 de [E](./E-calculation-engines.md))

**Inputs**: plan semanal futuro (`member_servings` planificadas → demanda exacta por ingrediente y fecha), consumo habitual aprendido (media móvil robusta sobre movimientos CONSUMED/USED_IN_RECIPE, excluyendo semanas atípicas por eventos), historial de merma por producto (tasa, no unidades), lotes vivos + reservas + pedidos en tránsito, `reorder_rules` (safety stock, lead time del canal), eventos/estacionalidad futura cuando exista.

**Outputs** (materializados en `demand_forecasts` + `reorder_suggestions`):

- demanda proyectada por producto y período;
- `days_of_supply` / `weeks_of_supply` = stock disponible no reservado ÷ demanda diaria proyectada (arroz: 3 kg ÷ 1 kg/semana ≈ 3 semanas);
- `recommended_purchase_quantity = max(0, demanda_planificada + demanda_habitual + safety_stock − stock_disponible − en_tránsito)`, redondeada a formato comercial;
- `recommended_order_date` = fecha en que la cobertura caerá por debajo de `lead_time + safety_days`.

**Reglas**: la demanda prevista manda — la merma entra como **tasa histórica** que infla ligeramente la compra recomendada de productos con desperdicio recurrente y genera una observación ("se pierde ~1 de 7 manzanas: ¿comprar 6 o cambiar cantidad?"); jamás la regla simplista "se desperdició una → comprar una menos". Sin historial suficiente, el motor se abstiene (igual que el aprendizaje de consumo del Sprint 0). Determinista y explicable como todos los motores.

---

## 8. Prep & Storage

Dominio nuevo: convertir una compra recibida en lotes listos para la semana.

### `prep_batches` + `prep_batch_items`

Al confirmar la recepción (STORED), la app puede generar la sesión **PREPARAR COMPRA**:

- `prep_batches`: `household_id`, `trigger` (PURCHASE/MANUAL), `status`, fecha.
- `prep_batch_items`: una tarea por acción física — `task_type` (`WASH | CUT | PORTION | LEAVE_WHOLE | REFRIGERATE | FREEZE | COOK_AHEAD | THAW_PLAN`), lote(s) objetivo, cantidad, `cut_spec null` (método de corte; si hay equipo compatible, capacidad concreta, §9), instrucción, orden sugerido.

Cada tarea **ejecutada** se materializa como movimientos del ledger (§1): PORTION = SPLIT; CUT = TRANSFORM; FREEZE/REFRIGERATE = MOVE; COOK_AHEAD = COOK. **No existe stock propio de "prep"**: `PreparedFood` del enunciado = lotes con `state PREPPED/COOKED`; no se duplica nada. Las `StorageInstruction`/`ThawingInstruction` no son tablas de estado sino **salidas del FoodStorageSafetyEngine** adjuntas a la tarea y al lote (`use_by`, "mover a refrigerador: miércoles noche").

El plan de la semana alimenta el prep: si el jueves se cocinan 1.150 g de pollo, la sesión propone ese paquete con su etiqueta y su instrucción de descongelado calculada hacia atrás desde la fecha prevista.

### `BatchPrepOptimizer` (motor nuevo)

Ordena las tareas de una sesión para minimizar trabajo: agrupa por equipo y por capacidad concreta (todas las tareas "Shred 4 mm" juntas → un solo montaje y lavado del disco), respeta seguridad (crudo/cocido separados, carne al final o tabla aparte), intercala esperas (mientras hierve X, cortar Y — mismo enfoque de pasos paralelos del Modo Cocina). Determinista; con hogar sin equipamiento produce la secuencia manual base.

---

## 9. Equipamiento opcional y capacidades

**Regla de oro**: la app funciona completa con cuchillo + tabla + sartén + olla + horno básico. El equipamiento adicional **optimiza**, nunca condiciona.

- **`household_equipment`** (evolución de `kitchen_equipment`): `equipment_type` (AIRFRYER, VACUUM_SEALER, FOOD_PROCESSOR, MANDOLINE, PRESSURE_COOKER, GRILL, BLENDER, THERMAL_PRINTER, …), `capacity null`, `notes`.
- **`equipment_capabilities`**: capacidades concretas de un equipo concreto — `equipment_id`, `capability_type` (`DICE | SHRED | SLICE | WAVY | SEAL | BATCH_G | …`), `parameter` (6 mm, 9 mm, 4 mm…). Los discos del hogar inicial (Dice 6/9/12/16, Shred 2.5/4, Slice 2.5, Wavy 9) son **datos de su equipo**, jamás enums globales ni valores hardcodeados.
- **`preparation_alternatives`**: sobre pasos de receta y tareas de prep — `base_method` (manual, siempre presente y suficiente) + 0..N métodos optimizados, cada uno con `required_capability` (tipo + parámetro tolerado). Resolución en runtime: si el hogar tiene la capacidad → se sugiere el método optimizado ("Zanahoria: Shred 4 mm"); si no → método base ("rallar"). El matching es por capacidad, no por marca/modelo.

---

## 10. Seguridad de almacenamiento

**`FoodStorageSafetyEngine`** (motor nuevo, hermano metodológico del ClinicalRulesEngine):

- **`storage_safety_rules`** versionadas con fuente verificable (`storage_rule_sources`): por (categoría/ingrediente × estado RAW/COOKED × ubicación FRIDGE/FREEZER/PANTRY × envasado normal/vacío) → duración segura, método de descongelación permitido, si admite re-congelado, notas.
- Calcula `use_by` de cada lote en cada transición (COOK, THAW, MOVE, SEAL) y las instrucciones de descongelado hacia atrás desde `planned_use_date`.
- **Sellar al vacío no convierte un perecible en estable a temperatura ambiente**: el vacío es solo una dimensión más de la regla, nunca un multiplicador mágico.
- Determinista; la IA puede **explicar** una regla citándola, nunca inventarla ni relajarla. Sin regla aplicable → "sin dato de seguridad", nunca un valor inventado.

## Capacidad de almacenamiento

`pantry_locations` se generaliza a **`storage_locations`**: `household_id`, `location_type` (PANTRY/FRIDGE/FREEZER/OTHER), `name` ("segundo congelador"), `capacity null` + `capacity_unit null`, `estimated_used_capacity` (derivada de lotes). Todo opcional: sin capacidades configuradas el sistema funciona igual; con ellas, el ShoppingEngine/Procurement advierte compras al por mayor que no caben ("el pedido de 8 kg no cabe en el congelador: ~2 kg libres").

---

## 11. Etiquetas, QR e impresión

- **`label_templates`**: tamaño configurable (mm), campos activos y diseño (el **día de uso en GRANDE** como variante por defecto: "JUEVES / POLLO / 1.150 g / Congelado / Mover a refrigerador: miércoles noche"). Campos disponibles: nombre, cantidad/peso, día y fecha prevista de uso, fecha de preparación, ubicación, refrigerado/congelado, método de corte, receta, comida, persona (cuando la porción es individual), instrucciones breves, identificador de lote.
- **`print_jobs`**: lote(s) → render → **PDF imprimible primero** (cualquier impresora); la impresión térmica directa se evalúa después como driver adicional del mismo job. La impresora térmica del hogar inicial es `household_equipment` opcional — jamás requisito.
- **QR**: contiene únicamente la URL con el **id opaco del lote** — nunca datos médicos, nombres ni contenido. Al escanear (autenticado y del mismo household): se abre el lote con acciones `USED | THAWED | PARTIALLY_USED | MOVE | UPDATE_WEIGHT | SPOILED | DISCARD` — cada una genera sus movimientos del ledger y auditoría. Un QR de un lote consumido/ajeno muestra estado o error, sin filtrar información.

---

## 12. Precisión sobre LOCK_WEEK: ClinicalImpactReview

**Se modifica la decisión del Sprint 0** (D-Caso 7 y H decían que una restricción clínica confirmada "ajusta porciones de inmediato" atravesando el lock):

Una restricción clínica confirmada de alta prioridad ahora:

1. **INVALIDA inmediatamente** las recomendaciones y porciones afectadas: `member_servings.status = CLINICALLY_INVALIDATED` — visibles para el cocinero como "no servir sin revisar", desaparecen de sugerencias. La seguridad sigue siendo inmediata.
2. **NO modifica silenciosamente** compras ya realizadas, inventario ni cantidades cocinadas — ningún dato del mundo físico se reescribe.
3. Genera un **`clinical_impact_reviews`**: comida(s) afectada(s), riesgo/conflicto (referencia a la constraint, sin exponer datos clínicos a quien no tiene grant), propuesta de modificación (porción/método/sustitución/plato alternativo, calculada por los motores), impacto en compra (delta) e impacto en inventario (lotes reservados que quedarían sin uso → sugerencia de re-destino).
4. El usuario resuelve la revisión (aceptar propuesta / elegir alternativa / marcar resuelto externamente); recién entonces se emiten los movimientos y revisiones de compra correspondientes. Todo trazable en `change_impacts` y auditoría.

Los documentos [D](./D-data-flows.md) (Caso 7) y [H](./H-event-recalculation.md) quedan corregidos en este sentido.

---

## 13. Revisión del modelo

### A. Permanecen sin cambios estructurales

Todo Family, Nutrition, Meals (salvo notas abajo), Health, Planning (salvo `member_servings`), AI, Notifications/Audit: `households`, `household_members`, roles, `nutrition_goals`, `member_nutrition_profiles`, `meal_patterns`, `day_templates`, `member_daily_nutrition_plans`, `nutrition_events`, `nutrition_conflicts`, `ingredients` + nutrición/unidades/efectos de cocción, `commercial_products`, `meal_templates`/slots/options, sustituciones, ensaladas, postres, `recipe_steps`*, preferencias/favoritos/staples/fruit_plans, todo Health 🔒, `weekly_plans`/days/assignments, votos, `meal_compatibilities`, `family_meal_fits`, `consumption_logs`, `shopping_lists`/items/sources/revisions, `domain_events`, `change_impacts`, `audit_events`, `consent_records`.

### B. Se modifican

| Tabla | Cambio |
|---|---|
| `inventory_movements` | + `lot_id`, + `reason` ampliada, + `group_id` con invariantes (§1) |
| `pantry_locations` | → **`storage_locations`** con capacidad opcional (§10) |
| `kitchen_equipment` | → **`household_equipment`** + tabla `equipment_capabilities` (§9) |
| `member_servings` | + estado `CLINICALLY_INVALIDATED`; + referencia opcional a lotes reservados |
| `shopping_list_items` | + `channel` (supermercado/pedido); + match con `purchase_items` (planificado vs real) |
| `recipe_steps` / prep | + `preparation_alternatives` (método base manual + optimizados por capacidad) |
| `consumption_logs` | sin cambio de forma; ahora su efecto de inventario referencia lotes |

### C. Nuevas

**Inventory**: `inventory_lots`.
**Finance**: `purchases`, `purchase_items`, `purchase_receipts`, `price_observations`, `cost_allocations`, `household_food_budgets`.
**Procurement**: `suppliers`, `supplier_products`, `purchase_orders`, `purchase_order_items`, `deliveries`, `reorder_rules`, `reorder_suggestions`, `demand_forecasts`.
**Prep & Storage**: `prep_batches`, `prep_batch_items`, `storage_safety_rules`, `storage_rule_sources`, `label_templates`, `print_jobs`.
**Health/Planning**: `clinical_impact_reviews`.

### D. Se eliminan por redundantes

| Tabla del Sprint 0 | Absorbida por |
|---|---|
| `pantry_items` | `inventory_lots` (vista de despensa = agregación de lotes) |
| `leftovers` | `inventory_lots` con `origin=assignment`, `state=COOKED` |
| `price_history` | `price_observations` (alimentada por compras + manual) |
| `stock_targets` | `reorder_rules` (configuración) + `demand_forecasts` (aprendizaje) |
| `pantries` | innecesaria: `storage_locations` cuelga directo del household |

### Motores: de 7 a 10

Se agregan `DemandForecastEngine` (§7), `FoodStorageSafetyEngine` (§10) y `BatchPrepOptimizer` (§8). `InventoryEngine` pasa a operar sobre lotes; `ShoppingEngine` entrega su salida dividida por canal. [E](./E-calculation-engines.md) actualizado con referencias.

---

## 14. Dependencias entre dominios y flujo completo

### Dependencias (dirección permitida)

```
Family ◄── todos (identidad, aislamiento)

Health ──constraints──► Nutrition ◄──consulta── Planning, Shopping, AI
                             │
Meals ◄── Planning, Shopping, Prep&Storage, AI
                             │
Planning ──MemberServing──► Shopping (demanda consolidada)
     │                          │
     │                    Procurement (canales, pedidos, recepción)
     │                          │ purchase → lotes
     ▼                          ▼
  reservas ──────────► Inventory (ledger de lotes) ◄── Prep&Storage (movimientos)
                            │        ▲
                            │   FoodStorageSafetyEngine (use_by, thaw)
                            ▼
              DemandForecastEngine ──sugerencias──► Shopping/Procurement
                            │
                  Finance (solo lectura: purchases + movements + allocations)

AI: servicios transversales (extracción de boletas/exámenes, explicación,
ranking) — siempre vía confirmación; nunca escribe ledger ni costos.
```

### Flujo operativo completo

```
PLAN ──► PROCURE ──► RECEIVE ──► PREP ──► STORE ──► COOK ──► SERVE ──► CONSUME
  │    (lista por      │       (batch     (lotes    (COOK    (porción  (log →
  │     canal +        │        prep:      etiqueta  movim.)  por       movim. +
  │     pedidos)   purchase +   split/     dos+QR,            persona)  costo
  │                 lotes       transform) use_by)                      CONSUMED)
  │                                                                        │
  └──◄── FORECAST ◄── WASTE / LEFTOVERS ◄──────────────────────────────────┘
          │            (movimiento con causa → costo WASTED → tasa de merma;
          │             sobra = lote COOKED reutilizable)
          ▼
     NEXT PURCHASE (reorder_suggestions: demanda prevista + cobertura
                    + lead time + safety stock)
```

---

## 15. Garantías de no-doble-conteo

1. **Inventario**: una sola fuente (`inventory_movements` sobre lotes). SPLIT/MERGE/MOVE conservan cantidad por invariante de grupo (Σ deltas = 0, verificado en la transacción); TRANSFORM/COOK registran merma explícita y mantienen la equivalencia en base cruda; los reportes eligen una base (cruda o cocida) y la declaran. `PreparedFood`, sobras y paquetes **son** lotes: no existe segunda tabla de stock.
2. **Costo**: la caja se cuenta solo en `purchases` (por fecha de compra); el costo económico se cuenta solo en `cost_allocations`, con `movement_id` **único** — un movimiento no puede asignarse dos veces, y un lote cumple `compra = consumido + desperdiciado + restante`. Finance es derivado: no escribe cantidades ni costos propios.
3. **Consumo**: `consumption_logs` es el único registro de "alguien comió"; el movimiento de inventario y la asignación de costo lo **referencian** (no lo duplican). "Comí lo planificado" genera log + movimiento + allocation en una sola operación.
4. **Desperdicio**: un desperdicio es exactamente un movimiento con causa de merma + su allocation WASTED — un evento físico, un registro, dos vistas (stock y costo). Las métricas y el pronóstico leen esos mismos registros.

---

## 16. Decisiones estructurales nuevas

Se suman a K-1…K-10 (mismo criterio: costosas de revertir; ver [K](./K-decisions.md)):

- **K-11 — Inventario por lotes con costo por lote.** `inventory_lots` + movimientos con causa e invariantes de grupo como única representación del stock; sobras, paquetes y prep son lotes. *Es la decisión más cara de cambiar del 0.1: absorbe pantry_items/leftovers y sostiene FEFO, etiquetas, QR, costos y desperdicio.*
- **K-12 — Costeo a costo real por lote** (no promedio global): `unit_cost` heredado de la compra y propagado en splits/transformaciones; asignación a CONSUMED/WASTED por movimiento con unicidad. Promedio móvil solo como fallback para ajustes sin lote de origen.
- **K-13 — `purchases` como convergencia de todos los canales** (supermercado, pedido a proveedor, importación de boleta): aguas abajo nadie distingue el canal. Shopping consolida demanda; Procurement ejecuta.
- **K-14 — Reglas de seguridad de almacenamiento como datos versionados con fuente** (`storage_safety_rules`), mismo patrón que las reglas clínicas: motor determinista, IA solo explica. El vacío no estabiliza perecibles.
- **K-15 — Equipamiento como capacidades-datos, no enums**: `equipment_capabilities` con tipo+parámetro; recetas y prep declaran método base manual obligatorio + alternativas por capacidad. Nada del hogar inicial (discos, impresora) se hardcodea.
- **K-16 — QR = id opaco de lote, nada más.** Resolución server-side con autenticación y household; imprimible en PDF genérico primero.
- **K-17 — Lo clínico invalida, no modifica** (reemplaza la excepción del Sprint 0): `CLINICALLY_INVALIDATED` + `clinical_impact_reviews`; el mundo físico (compras, inventario, cocinado) solo cambia por decisión humana trazable.

### Pendientes del director (adicionales a los del Sprint 0)

1. **Fuente inicial de las reglas de seguridad de almacenamiento** (§10): igual que las reglas clínicas, requieren fuente verificable (se propone partir de guías públicas de inocuidad alimentaria reconocidas, curadas manualmente).
2. **Posición de los nuevos bloques en el roadmap**: propuesta — lotes+causas de merma entran con el sprint de Despensa (8); finanzas base (purchases/costos) con Compras (7)–Despensa (8); Procurement/pedidos, pronóstico, prep/etiquetas como sprints 9bis–13; boletas con IA tras el pipeline de exámenes. El roadmap detallado se reordenará al aprobar este addendum.
