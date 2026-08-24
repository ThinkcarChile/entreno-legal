# 0009 — Stock Intelligence: derivado en vivo, reservas lógicas, motores versionados

- Estado: APROBADO (implementado en Sprint 8)
- Fecha: 2026-08-24
- Decisión de baseline afectada: implementa `stock_targets` y el InventoryEngine analítico (E §5) + DemandForecastEngine inicial. No cambia el ledger (K-11) ni ningún objetivo nutricional.
- Migración: `supabase/migrations/0013_stock_intelligence.sql`

## Contexto

El sprint pide que la app responda "qué tengo, qué está reservado, qué queda libre, cuánto consumo, cuánto me durará, cuándo y cuánto comprar, por qué, y qué tan confiable es" — sin doble contar, sin inventar conversiones y sin comprar sola.

## Decisiones

### 1. Todo derivado, nada persistido (§37)

- **Stock actual**: derivado del libro mayor (cantidad cacheada por trigger del Sprint 7).
- **Reservas**: derivadas de las porciones `PLANNED` futuras con `serving_date` — la misma fila que confirma la comida ES la reserva. Reconfirmar reemplaza (delete+insert del Sprint 5) → imposible duplicar; consumir cambia el status → sale sola de las reservas; cancelar borra → retira la reserva. No hay tabla de reservas que pueda desincronizarse.
- **Forecast y recomendación**: calculados en vivo por funciones puras versionadas (`demand-forecast/1.0.0`, `reorder-engine/1.0.0`). Mismos inputs → misma salida byte a byte (test explícito): la idempotencia (§35) es estructural, no un mecanismo. No se persisten snapshots todavía — no hay consumidor que los necesite y duplicarían estado físico; cuando el Sprint 9 quiera histórico de recomendaciones, se agregará con `input_signature` como en las revisiones de lista.

### 2. Reservas lógicas por identidad, no por lote (§5)

Una comida confirmada compromete `ingrediente + unidad` en base cruda; FEFO decide el lote concreto recién al consumir. `available = onHand usable − reserved`, y el negativo NO se esconde: es el faltante confirmado (§40).

### 3. No doble conteo (§2, §17)

`planningCoveredUntil` = la última fecha con porciones confirmadas del hogar. Hasta ahí, la demanda es SOLO la confirmada (el forecast no agrega pollo estadístico a un martes ya planificado); después, SOLO forecast. La necesidad del reorder es `faltante_confirmado + max(0, forecast_no_cubierto + seguridad − libre)` — lo confirmado ya está dentro de `libre` vía reservas, restarlo de nuevo sería doble conteo del propio motor (bug encontrado y matado por los tests de dominio).

### 4. Consumo observado = consumo DECLARADO (§7, §12)

La tasa sale de las porciones `CONSUMED` (X), no de los movimientos (Y): el shortfall ES consumo. Trazado/no-trazado se separan solo para auditoría y confianza. La ventana elegida es la más larga que la historia respalda (30/14/7 según ≥21/≥10/≥4 días) — promediar 6 días de consumo sobre 30 diluiría la tasa a un quinto (§13). Variabilidad = CV de cubetas de 7 días (§16), simple y explicable.

### 5. Bases físicas: conversión explícita o UNRESOLVED (§6)

La única conversión es cocido→crudo con rendimiento declarado. g≠ml≠UNIT siempre; DRAINED es su propia identidad. Sin conversión: `coverage_status = UNRESOLVED` con razón estructurada. Jamás ∞ días, jamás un peso promedio inventado, jamás 1:1.

### 6. Confianza como calidad de datos (§14, §15)

Escalera determinista: <7 días de historia u <3 observaciones → LOW directo con el texto pedido ("Tenemos pocos datos…"); después degradaciones por historia corta, variabilidad alta, shortfalls >20%, stock aproximado y unidades sin resolver — cada una con su razón visible. No es un health score.

### 7. El sistema sugiere, la persona decide (§9, §25, §33)

- `stock_targets.source` distingue USER_DEFINED de SYSTEM_SUGGESTED, y el RPC siempre escribe USER_DEFINED: no existe camino que sobreescriba un target manual.
- La sobrecompra (compras > consumo con merma repetida) es una SEÑAL en pantalla, nunca un ajuste del target.
- "Agregar a próxima compra" crea un item con `source = STOCK_INTELLIGENCE` en la lista — Shopping sigue siendo el dueño; nada se compra solo, no se crean lotes ni compras recibidas.

## Deuda declarada

- `safety_stock` y capacidad de almacenamiento tienen columna y soporte de motor, sin UI (§27: capacidad UNKNOWN no se inventa).
- `preferred_purchase_multiple` no entró (§8 lo permitía diferir).
- Snapshots de recomendación para auditoría histórica → cuando exista consumidor (Sprint 9).
- El forecast usa yields globales+hogar sin priorización por hogar en el motor (el RPC de consumo sí prioriza); anotado para unificar.
