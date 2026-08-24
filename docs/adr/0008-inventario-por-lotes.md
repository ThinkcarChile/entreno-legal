# 0008 — Despensa: lotes con libro mayor append-only

- Estado: APROBADO (implementado en Sprint 7)
- Fecha: 2026-08-24
- Decisión de baseline afectada: implementa K-11 (lotes + movimientos como única representación del stock), K-18 (estados ortogonales), K-19 (valor total conservado), K-22 (efectos idempotentes). No cambia el modelo congelado: lo materializa.
- Migración: `supabase/migrations/0011_inventory.sql`

## Contexto

El roadmap pide "la casa sabe qué tiene". El baseline ya decidió CÓMO: no existe una tabla de "pantry_items" editable — cada cosa física es un **lote** (`inventory_lots`) y toda variación es un **movimiento** (`inventory_movements`) con causa explícita. Las sobras, los paquetes partidos y lo cocinado por adelantado SON lotes, no entidades aparte.

## Decisiones de implementación

### El libro mayor manda, con triple candado

1. La cantidad del lote es un **cacheo** que mantiene un trigger sumando movimientos; el cliente no tiene política de INSERT/UPDATE sobre lotes ni movimientos — todo pasa por RPC.
2. El libro es **append-only**: editar o borrar un movimiento explota con mensaje. Se corrige con un movimiento nuevo (ADJUSTMENT), como en contabilidad.
3. Un movimiento que dejaría el lote en negativo se rechaza ANTES de aplicarse, con mensaje claro; el CHECK de la columna queda de segundo cinturón. **El inventario nunca inventa stock.**

### Invariante de grupo verificable (K-11)

SPLIT y MERGE comparten `group_id` y un **constraint trigger deferred** verifica Σ deltas = 0 al cierre de la transacción: partir 4 kg en paquetes no puede crear ni perder un gramo. `split_lot` además reparte `acquisition_value` proporcional a la cantidad (K-19: se conserva el VALOR, no el precio unitario).

### Idempotencia en todo efecto (K-22)

- Recibir la compra: clave `RECEIVE:{item_id}` única → recibir dos veces = no-op.
- Consumo: `consumption_logs` único por porción + claves `CONSUME:{porción}:{componente}:{lote}` → registrar dos veces jamás descuenta dos veces.

### "Comimos lo planificado" cierra el círculo

`consume_planned_meal` conecta tres sprints: porciones `PLANNED → CONSUMED` (ciclo de vida del Sprint 5, que ahora usa el estado CONSUMED definido entonces), registro en `consumption_logs`, y descuento **FEFO** de la despensa (`use_by` → `expiry_date` → antigüedad, el orden del baseline) **capado al stock real**: si no hay suficiente en la despensa, el resto simplemente no se descuenta — la despensa dice la verdad que conoce. La comida pasa a `SERVED` y la guardia del §13 impide reconfirmarla.

### Descuento en compra: informar, no restar en silencio

La lista de compras muestra "en casa: X" por línea (solo lotes AVAILABLE de la **misma representación** — 300 g de arroz cocido no son 300 g de arroz crudo comprables) y sugiere en el detalle: "alcanzaría sin comprar" o "te faltarían Y". La demanda calculada NO se toca: restar automáticamente escondería el número real, y el comprador ya tiene "Ya lo tengo" para decidir. La resta automática con reservas llega con el stock inteligente (roadmap 9).

### Estados térmicos como evidencia (K-18)

Mover al congelador → `FROZEN`; sacar → `CHILLED` + `thawed_at` sellado como **evidencia**, nunca prohibición: la decisión de re-congelar es del futuro FoodStorageSafetyEngine con reglas versionadas.

## Deuda declarada

- `use_by` existe pero nadie lo calcula todavía (es del SafetyEngine); hoy manda `expiry_date` ingresada a mano.
- `acquisition_value` queda NULL: los precios llegan con la recepción con boleta.
- `RESERVED` definido y sin uso: las reservas de planes activos son del stock inteligente.
- MERGE/TRANSFORM/COOK tienen semántica en el enum y el invariante, pero sin RPC ni UI (llegan con el modo cocina/batch prep).
- El consumo descuenta por FEFO automáticamente; elegir lote a mano ("usé el paquete abierto") queda para cuando exista QR/etiquetas.
