# Sprint 8 — Entrega: Stock Intelligence

**Fecha:** 2026-08-24
**Verificación:** 376 pruebas verdes (38 dominio stock + 12 integración stock sobre PostgreSQL real + las previas), lint/typecheck/build limpios. QA adversarial en [qa/sprint-8-report.md](./qa/sprint-8-report.md) (21 defectos confirmados y corregidos en dos pasadas). Decisiones en [ADR 0009](./adr/0009-stock-intelligence.md).
**Estado:** demo viva §59 pendiente de aplicar la migración 0013 en Supabase (flujo acordado: portapapeles → Francisco).

---

## 1. Qué responde ahora la aplicación (el gate)

| Pregunta | Cómo |
|---|---|
| ¿Cuánto tengo? | `onHand` derivado del libro mayor, por bucket físico (crudo ≠ escurrido ≠ cocinado), excluyendo no usables (§21) y marcando aproximados con ~ |
| ¿Cuánto está comprometido? | `reserved` = porciones PLANNED futuras, convertidas a la base del bucket solo con rendimiento explícito |
| ¿Qué queda libre? | `available = onHand − reserved`; el negativo ES el faltante confirmado, nunca se esconde |
| ¿Cuántos días me dura? | `coverage` determinista; INSUFFICIENT_DATA / NO_EXPECTED_DEMAND / UNRESOLVED con razón — jamás ∞ |
| ¿Cuánto consumo? | Ventanas 7/14/30 del consumo DECLARADO (el shortfall ES consumo), trazado/no-trazado separados para auditoría |
| ¿Cuándo/cuánto comprar? | ReorderEngine: NO_ACTION/WATCH/REORDER_SOON/REORDER_NOW/UNRESOLVED + cantidad jamás negativa |
| ¿Por qué? | Razones estructuradas en cada recomendación + botón "¿Por qué?" en detalle y dashboard |
| ¿Qué tan confiable? | LOW/MEDIUM/HIGH en escalera determinista con sus razones (historia, variabilidad, shortfalls, aproximados, unidades sin resolver) |

Sin doble contar (lo confirmado GANA sobre el forecast hasta `planningCoveredUntil`; la necesidad no resta dos veces la propia reserva), sin inventar conversiones (única permitida: cocido→crudo con rendimiento; UNKNOWN ≠ 1:1), sin falsificar stock, sin tocar objetivos nutricionales, sin comprar solo, sin tocar el ledger.

## 2. Piezas

- **Migración `0013_stock_intelligence.sql`**: `stock_targets` (mínimo/objetivo/días/ciclo/reorder_enabled, fuente USER_DEFINED jamás sobreescrita), `is_approximate` en lotes + `adjust_lot` v3, capacidad opcional en ubicaciones (UNKNOWN no se inventa), fuente `STOCK_INTELLIGENCE` en la lista + índice único de sugerencias, vistas `waste_movements`/`purchase_movements` con `security_invoker`, `ensure_weekly_plan` v2 sin carrera, índices §55.
- **Motores**: `demand-forecast/1.0.0` + `reorder-engine/1.0.0` — puros, deterministas (test byte a byte), versionados en cada recomendación. Sin IA en el número (§38).
- **Cargador** `app/stock/queries.ts`: 9 consultas agregadas fijas (jamás una por lote), Zod completo, filtro por integrantes del hogar, fechas del ledger convertidas al día del hogar.
- **UI**: `/pantry` con bloques (por reponer / stock bajo / bien abastecido / sin datos) + fila por alimento (en casa · reservado · libre · cobertura · estado); `/pantry/item/[id]` con lotes, use-first, señales (merma, sobrecompra, no trazado), "¿Por qué?" con versiones, y el formulario de objetivo (§32); `/pantry/reorder` ordenado por urgencia con "Agregar a próxima compra" (sugerencia con procedencia, Shopping sigue siendo el dueño).

## 3. Políticas del ReorderEngine (§19, testeables)

- `necesidad = faltante_confirmado + max(0, forecast_no_cubierto(H) + seguridad − libre)`
- Piso por `minimum_quantity` (repone hacia `target_quantity`), objetivo de cantidad puro, horizonte = `target_days` > ciclo de revisión > 7 días por defecto.
- Estados por días-libres vs horizonte; sin historia, la recomendación nace SOLO del plan confirmado con confianza LOW (§40).
- `reorder_enabled=false` se respeta con la razón dicha.

## 4. Deuda

- Capacidad de almacenamiento y `safety_stock`: columna + motor listos, sin UI.
- Snapshots de recomendación para histórico → cuando exista consumidor (con `input_signature`).
- Porciones PLANNED de fechas pasadas sin registrar → aviso de higiene en Sprint 9.
- Costeo definitivo de merma → `cost_allocations` en el sprint de recepción con boleta (la vista actual es estimación best-effort, null cuando no puede ser exacta).
- Solapamiento ≤1 día entre consumo de HOY y forecast de HOY.

## 5. Riesgos para el Sprint 9

1. El aprendizaje fino de consumo debe seguir leyendo lo DECLARADO (porciones + shortfalls), nunca solo movimientos.
2. Si llegan reservas por lote (allocation), `available` debe pasar de lógico a físico sin romper la semántica actual.
3. Las sugerencias `STOCK_INTELLIGENCE` en la lista deben sobrevivir a `generate_shopping_revision` (hoy el RPC solo toca FOOD_PLAN — verificado, pero cualquier cambio ahí debe testear esto).
4. Con multi-hogar real, TODO cargador debe filtrar por hogar explícito como ahora hace stock.
