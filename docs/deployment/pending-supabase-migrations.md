# Migraciones pendientes en Supabase (mesa-familiar)

> **Regla vigente**: las migraciones listadas como pendientes están **CONGELADAS**.
> No se editan; cualquier cambio posterior va en una migración NUEVA. El checksum
> permite comprobar que lo que se aplique sea EXACTAMENTE lo revisado.
> Fuente de verdad del desarrollo mientras tanto: la cadena local (PGlite + CI).

## Estado remoto conocido

**Aplicado en Supabase** (proyecto `smwyxfnlxoohenhsdcjx`): `0001 → 0014`
(0013 y 0014 aplicadas por Francisco el 2026-08-25 y verificadas por API:
`stock_targets`, `waste_movements`, `purchase_movements`, `suppliers`,
`procurement_orders`, `procurement_order_events` → 200).
**Pendiente: 0015** (esperando el cierre de la revisión adversarial del Sprint 10
para congelarla) + el bloque de reglas USDA del seed.

## Pendientes de aplicar (en este orden exacto)

### 0013 — Stock Intelligence

- **Archivo:** `supabase/migrations/0013_stock_intelligence.sql`
- **Propósito:** `stock_targets` + RPCs (`set_stock_target`, `delete_stock_target`), calidad de stock (`is_approximate` + `adjust_lot` v3), capacidad opcional en `storage_locations`, fuente `STOCK_INTELLIGENCE` en la lista + índice único de sugerencias, vistas `waste_movements`/`purchase_movements` (security_invoker, con `weight_basis` y regla de costo "lote limpio"), `ensure_weekly_plan` v2 sin carrera, `consume_planned_meal` v3 (lotes vencidos NO se consumen — misma regla que el motor, en el día del hogar), trigger de items de compra con validación de ámbito, índices §55.
- **Dependencias:** 0001→0012 aplicadas (usa `inventory_lots`, `consumption_shortfalls`, `shopping_list_items`, `ingredient_yields`).
- **Checksum SHA-256:** `75dbe5c1e8e3f6664bd8d8b4dcf33753771e86eef561e24b43296bae5a03d7d3`
- **Congelada en commit:** `bb4e5ca`
- **¿Destructiva?:** NO en datos (aditiva + `create or replace` de funciones + un `drop function` de `adjust_lot`/`consume_planned_meal` para cambiar firma/retorno, recreados en la misma transacción). El aviso "destructive operations" del editor es el falso positivo de siempre (DML dentro de cuerpos de función).
- **Notas de aplicación:** un solo pegado; `alter type … add value` de `shopping_item_source` está al final de su uso (el índice único evita el literal nuevo a propósito). Validada completa en PGlite sobre réplica del estado 0001→0012.

### 0014 — Procurement (Sprint 9)

- **Archivo:** `supabase/migrations/0014_procurement.sql`
- **Propósito:** proveedores (`suppliers`, `supplier_products` con presentación/envase/base física/mínimo/múltiplo/lead time/días de entrega), `purchase_policies` (proveedor preferido + días de pedido/recepción; las cantidades siguen en `stock_targets`), órdenes de abastecimiento (`procurement_orders` + items + `procurement_order_events` append-only) y RPCs `create_procurement_order` (dedupe por hogar/estado, guardas anti-pantalla-vieja, validación de supplier_product), `advance_procurement_order` (máquina de estados §13) y `receive_procurement_order` (MISMO ledger del Sprint 7, claves `RECEIVE-PO:{item_id}`, base física del item, reintento = no-op). Incluye `app.household_today`.
- **Dependencias:** 0001→0013 aplicadas (usa `weight_basis`, `inventory_lots/movements`, `ensure_storage_locations`, `can_manage_shopping`, `ingredient_in_scope`, `assert_finite`, `current_member_id`, `storage_locations`).
- **Checksum SHA-256:** `000f29a5743fc7fd3b561df4bb9b2733eb7521a97bb016d41e441e618e8ac935`
- **Congelada en commit:** `6d17bfd`
- **¿Destructiva?:** NO (100% aditiva: tablas/tipos/índices/funciones nuevos; no toca nada existente). El aviso "destructive operations" del editor, si aparece, es el falso positivo de siempre (DML dentro de cuerpos de función).
- **Notas de aplicación:** un solo pegado, DESPUÉS de 0013. Validada completa en PGlite sobre la cadena 0001→0013 + QA adversarial de 9 lentes (16 defectos corregidos ANTES de congelar — ver `docs/qa/sprint-9-report.md`).

### 0015 — Batch prep, conservación y etiquetas (Sprint 10)

- **Archivo:** `supabase/migrations/0015_batch_prep.sql`
- **Propósito:** equipamiento del hogar + configuraciones (`household_equipment`, `household_equipment_configs`), `prep_preferences`, `storage_safety_rules` (fuente obligatoria), `household_observed_yields`, `batch_prep_plans`/`batch_prep_tasks`, `label_templates` (+ plantilla global 40 mm) / `label_print_jobs` (snapshot congelado), columnas nuevas en `inventory_lots` (frozen_at, intended_use_date, intended_assignment_id, package_code, qr_token), enum `PREP_LOSS`, RPCs `merge_lots`, `save_prep_plan`, `cancel_prep_plan`, `complete_prep_task`, `skip_prep_task`, `use_lot`, `set_lot_safety`, `set_intended_use`, `ensure_lot_token`, `resolve_lot_token`, `create_label_job`, `mark_label_job`, `app.emit_event`, y v2 de `split_lot`/`move_lot`/`add_manual_lot`.
- **Dependencias:** 0001→0014 aplicadas (ledger, storage_locations, meal_assignments, domain_events del 0001, household_today del 0014).
- **Checksum SHA-256:** `c26f3ae09bdfc50cbc7920eb73c568d394d9fbab1a7b6fd8249589d2f8deecb3`
- **Congelada en commit:** `7607360`
- **¿Destructiva?:** NO en datos (aditiva + `create or replace` de funciones existentes: split_lot/move_lot/add_manual_lot cambian cuerpo, misma firma). El aviso "destructive operations" del editor, si aparece, es el falso positivo de siempre.
- **Notas de aplicación:** un solo pegado, DESPUÉS de 0014. Tras aplicarla, correr el **bloque de reglas USDA** (sección final de `supabase/seed/dev_catalog_seed.sql`, idempotente con `where not exists`) para que el SafetyEngine tenga reglas con fuente. Validada completa en PGlite + QA manual de 12 lentes (8 defectos corregidos ANTES de congelar — `docs/qa/sprint-10-report.md`).

## Cómo verificar un checksum antes de aplicar

```bash
sha256sum supabase/migrations/0013_stock_intelligence.sql
sha256sum supabase/migrations/0014_procurement.sql
sha256sum supabase/migrations/0015_batch_prep.sql
```

Debe coincidir EXACTAMENTE con el registrado acá. Si no coincide, NO aplicar:
revisar `git log` del archivo y regenerar este manifiesto.

## Checklist para la vuelta al PC (orden estricto, sin omitir pasos)

1. ~~Verificar checksums~~ ✔ (0013/0014 verificados y aplicados 2026-08-25).
2. ~~Aplicar 0013~~ ✔ (`stock_targets`, vistas → 200).
3. ~~Aplicar 0014~~ ✔ (`suppliers`, `procurement_orders`, `…_events` → 200).
3b. **Aplicar 0015** (checksum arriba) y verificar por API: `batch_prep_plans`,
   `storage_safety_rules`, `label_print_jobs` → 200. Luego el bloque USDA del seed.
4. **Smoke tests contra Supabase real**: `/pantry`, `/pantry/reorder`,
   `/shopping` cargan sin error; `set_stock_target` guarda; consumir una comida
   con lote vencido presente lo deja intacto y registra shortfall.
5. **Demo §59 del Sprint 8** (BLOCKED_BY_REMOTE_MIGRATION_0013): pollo 4.500 g
   → reservas 3.200 → libre 1.300 → cobertura/forecast/confianza → consumir →
   merma → recibir compra → agregar comida confirmada → sustitución a merluza.
6. **Mobile review** 320/375/430 contra la app viva (pantry, item, reorder).
7. **Demo viva del Sprint 9**: crear proveedor con presentación (mínimo 5 kg,
   lead 2, entrega viernes) → sugerencia con "pedir miércoles para recepción
   viernes" → aprobar (doble clic = una orden) → "Ya lo pedí" → "Llegó: recibir"
   → el lote aparece en /pantry con su base física → la sugerencia no reaparece.
7b. **Demo viva del Sprint 10** (§91): recibir compra → generar plan → modo
   cocina → porcionar/congelar → etiquetas PDF → QR desde el celular.
8. **Entregar resultados al director** para los gates de Sprint 8, 9 y 10.

## Estados de sprint mientras tanto

| Sprint | Estado |
|---|---|
| 8 — Stock Intelligence | `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION` — demo §59 `BLOCKED_BY_REMOTE_MIGRATION_0013` |
| 9 — Procurement | `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION` — 0014 APLICADA en remoto; falta demo viva |
| 10 — Batch prep | `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION` — 518 tests, QA 12 lentes manual, 0015 congelada |
