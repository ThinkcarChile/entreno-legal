# Sprint 7 — Entrega: despensa e inventario por lotes

**Fecha:** 2026-08-24
**Alcance:** roadmap "Despensa e inventario" sobre el modelo congelado (K-11, K-18, K-19, K-22). Decisión de implementación en [ADR 0008](./adr/0008-inventario-por-lotes.md).
**Verificación:** 315 pruebas verdes (7 dominio FEFO + 24 integración despensa sobre PostgreSQL real + las 284 previas), lint/typecheck/build limpios, revisión adversarial por workflow (ver §4).

---

## 1. Qué se construyó

### Migración `0011_inventory.sql`

- **`storage_locations`** — despensa/refrigerador/congelador por hogar, creadas al primer uso.
- **`inventory_lots`** — el objeto físico: identidad (ingrediente/producto + etiqueta congelada), cantidad cacheada desde el libro mayor, estados ortogonales K-18 (`processing_state` × `temperature_state` + `thawed_at` como evidencia), `acquisition_value` K-19 (NULL hasta la recepción con boleta), vencimientos, origen (compra / lote padre / comida), estado derivado AVAILABLE/RESERVED/CONSUMED/DISCARDED.
- **`inventory_movements`** — el ÚNICO mecanismo de variación: causa explícita (17 razones del baseline), `group_id` con invariante Σ=0 verificable en la transacción para SPLIT/MERGE, `idempotency_key` única (K-22), **append-only por trigger** — la historia se corrige con movimientos nuevos, jamás editándola.
- **`consumption_logs`** — "alguien comió", único por porción; el movimiento de inventario lo referencia, no lo duplica.
- **RPCs**: `receive_shopping_list` (lo COMPRADO de una lista COMPLETED → lotes, idempotente; el detergente manual sin identidad de alimento NO entra), `consume_planned_meal` (porciones → CONSUMED + log + descuento FEFO capado al stock real), `adjust_lot` (auditado), `discard_lot` (exige causa de merma), `move_lot` (congelar/descongelar con evidencia), `split_lot` (Σ y valor conservados), `add_manual_lot` (feria, regalo, sobra — con validación de ámbito del alimento), `ensure_storage_locations`.

### Dominio y UI

- `domain/inventory/fefo.ts` — orden FEFO del baseline (`use_by` → `expiry_date` → antigüedad, fechas DATE-only comparadas como texto), estado de vencimiento (vencido / usar hoy / pronto ≤3 días / ok / **sin fecha, no inventado**), stock por alimento en la misma representación.
- **`/pantry`** — lotes por ubicación en orden FEFO, badges de vencimiento y "Para usar pronto" arriba, ajustar/mover/descartar/alta manual. Pestaña **Despensa** en la navegación.
- **`/shopping`** — hint "en casa: X" por línea (solo misma representación RAW) + sugerencia en el detalle ("alcanzaría sin comprar" / "te faltarían Y") **sin tocar la demanda calculada**; botón **"Recibir compra en la despensa"** al finalizar.
- **`/plan`** — botón **"Comimos lo planificado"** en comidas confirmadas: cierra el ciclo Sprint 5 → 6 → 7 (porción CONSUMED + despensa descontada + comida SERVED + reconfirmación bloqueada).

## 2. Los invariantes, probados en PostgreSQL real

| Garantía | Prueba |
|---|---|
| La cantidad del lote ES la suma de sus movimientos | integración |
| Append-only: editar/borrar un movimiento explota | integración (incluso como admin) |
| Ningún movimiento deja stock negativo, con mensaje claro | integración |
| SPLIT conserva Σ cantidad y reparte el VALOR (450 g/$4.500 → 3×150 g/$1.500) | integración |
| Grupo SPLIT desbalanceado viola el invariante al cierre de transacción | integración |
| Recibir dos veces = no-op; consumir dos veces = ni doble log ni doble descuento (K-22) | integración |
| Congelar → FROZEN; sacar → CHILLED + `thawed_at` sellado (K-18) | integración |
| FEFO capado al stock: la despensa nunca queda negativa por un consumo | integración |
| Comida consumida no se reconfirma (§13 Sprint 5 sigue vivo) | integración |
| RLS: hogar B no ve ni toca lotes/movimientos/listas del A; `add_manual_lot` rechaza alimentos privados ajenos | integración, rol authenticated |
| Orden FEFO, estados de vencimiento, stock por representación | dominio (7 pruebas) |

## 3. Qué NO entra (a propósito)

- Precios/`acquisition_value` reales → recepción con boleta (sprint futuro).
- Reservas (`RESERVED`), stock_targets, reposición aprendida → roadmap 9.
- MERGE/TRANSFORM/COOK con UI → modo cocina / batch prep.
- `use_by` calculado → FoodStorageSafetyEngine.
- Resta automática despensa→lista: hoy es un hint informativo; restar en silencio escondería el número real.

## 4. Revisión adversarial

Workflow de 28 agentes en 4 lentes (libro mayor, falla silenciosa, seguridad, UX) con refutación por hallazgo: **21 confirmados, 21 corregidos** antes de esta entrega. Los que importan:

1. **El status del lote se derivaba solo del ÚLTIMO movimiento** — mover un lote descartado lo reetiquetaba CONSUMED y un split total dejaba al padre como "consumido" sin que nadie comiera. Ahora el estado respeta la historia: delta 0 no cambia nada, el cierre dice POR QUÉ (nuevo estado `SPLIT` para particiones), y un lote cerrado ni se mueve ni se ajusta — "la historia no se mueve de lugar".
2. **split_lot violaba K-19** — el padre conservaba el 100% del valor Y los hijos cargaban su fracción: la despensa se inflaba en cada partición. Ahora el padre queda debitado, el último hijo cierra el residuo del redondeo, y el test verifica que la despensa completa vale exacto lo mismo antes y después.
3. **adjust_lot calculaba el delta sin FOR UPDATE** — dos ajustes simultáneos partían de la misma lectura. Lock explícito.
4. **NaN atravesaba las guardas** — en PostgreSQL `'NaN'::numeric` es MAYOR que todo: pasaba un `>= 0` y envenenaba el stock para siempre. Guarda `app.assert_finite` en todos los RPC numéricos (también `set_planned_quantity` y `generate_shopping_revision` del Sprint 6).
5. **El trigger append-only bloqueaba los ON DELETE CASCADE** declarados (borrar un hogar se volvía imposible) — ahora distingue el DELETE directo (bloqueado) del que llega por cascada de integridad referencial.
6. **El hint "en casa" sumaba lotes vencidos** y codificaba la base RAW a mano (los lotes DRAINED de la propia app nunca calzaban). Excluye vencidos y usa la base real del item.
7. **El alta manual nunca vinculaba `ingredient_id`** — esos lotes quedaban invisibles para el hint y el FEFO, en silencio. Selector de catálogo con aviso explícito cuando no se vincula.
8. **«Descartar…» disparaba la acción destructiva al primer cambio del select** — ahora es en dos pasos con confirmación. Ajustar con el campo vacío ya no significa 0, y ajustar a 0 avisa que el lote saldrá de la despensa.
9. **FEFO cruzaba representaciones** — un lote cocido podía pagar demanda cruda. El descuento exige la misma base de peso.
10. Más: FK + índice para `consumption_log_id`, validación de `source_assignment_id` contra el hogar, ubicaciones con lotes no se borran, mensajes de error que no delatan existencia de recursos ajenos, y mensajes de consumo honestos ("donde había stock", no "por vencimiento").

## 5. Riesgos para el stock inteligente (roadmap 9)

1. El aprendizaje de consumo debe leer `consumption_logs` + movimientos CONSUMED — nunca inventar consumos iniciales (regla del baseline).
2. Cuando lleguen las reservas, `AVAILABLE` del hint de compra debe pasar a "no reservado": hoy son lo mismo.
3. El hint "en casa" compara por representación exacta; con conversiones de unidad (§7 del catálogo) habrá que decidir qué mostrar sin mentir.
