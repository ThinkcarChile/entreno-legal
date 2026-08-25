# Migraciones pendientes en Supabase (mesa-familiar)

> **Regla vigente**: las migraciones listadas como pendientes están **CONGELADAS**.
> No se editan; cualquier cambio posterior va en una migración NUEVA. El checksum
> permite comprobar que lo que se aplique sea EXACTAMENTE lo revisado.
> Fuente de verdad del desarrollo mientras tanto: la cadena local (PGlite + CI).

## Estado remoto conocido

**Aplicado en Supabase** (proyecto `smwyxfnlxoohenhsdcjx`): `0001 → 0012`
(última aplicación verificada por API el 2026-08-24; `consumption_shortfalls` responde).

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

- Se documenta al quedar congelada (ver más abajo cuando exista).

## Cómo verificar un checksum antes de aplicar

```bash
sha256sum supabase/migrations/0013_stock_intelligence.sql
```

Debe coincidir EXACTAMENTE con el registrado acá. Si no coincide, NO aplicar:
revisar `git log` del archivo y regenerar este manifiesto.

## Checklist para la vuelta al PC (orden estricto, sin omitir pasos)

1. **Verificar checksums** de todas las pendientes contra este manifiesto.
2. **Aplicar 0013** (portapapeles → SQL Editor → Run) y verificar por API:
   `stock_targets`, vistas `waste_movements`/`purchase_movements` → 200.
3. **Aplicar las siguientes** (0014, …) en orden, verificando cada una por API.
4. **Smoke tests contra Supabase real**: `/pantry`, `/pantry/reorder`,
   `/shopping` cargan sin error; `set_stock_target` guarda; consumir una comida
   con lote vencido presente lo deja intacto y registra shortfall.
5. **Demo §59 del Sprint 8** (BLOCKED_BY_REMOTE_MIGRATION_0013): pollo 4.500 g
   → reservas 3.200 → libre 1.300 → cobertura/forecast/confianza → consumir →
   merma → recibir compra → agregar comida confirmada → sustitución a merluza.
6. **Mobile review** 320/375/430 contra la app viva (pantry, item, reorder).
7. **Demo viva del Sprint 9** (procurement de punta a punta).
8. **Entregar resultados al director** para los gates de Sprint 8 y 9.

## Estados de sprint mientras tanto

| Sprint | Estado |
|---|---|
| 8 — Stock Intelligence | `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION` — demo §59 `BLOCKED_BY_REMOTE_MIGRATION_0013` |
| 9 — Procurement | en construcción local contra 0001→0013 (PGlite); quedará `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION` |
