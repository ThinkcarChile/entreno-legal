# Sprint 9 — Entrega: Procurement / Abastecimiento

**Fecha:** 2026-08-24
**Verificación:** 436 pruebas verdes (40 dominio + 20 integración sobre PostgreSQL real vía PGlite, rol authenticated + las previas), lint/typecheck/build limpios, cadena de migraciones 0001→0014 validada completa. QA adversarial §26 en [qa/sprint-9-report.md](./qa/sprint-9-report.md) (9 lentes, 17 defectos únicos: 16 corregidos + 1 documentado). Decisiones en [ADR 0010](./adr/0010-procurement.md).
**Estado: `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION`** (§27 — techo permitido; NO CLOSED). Todo lo anterior es LOCAL: la migración 0014 está congelada y pendiente de aplicar en Supabase (checksum en [pending-supabase-migrations.md](./deployment/pending-supabase-migrations.md)); la demo viva, los smoke tests y la revisión móvil esperan la vuelta al PC (checklist §28 en el manifiesto).

---

## 1. Qué responde ahora la aplicación

| Pregunta | Cómo |
|---|---|
| ¿A quién le pido? | Proveedor preferido de la política del hogar, o el de mejor prioridad; alternativas listadas (v1 §18, sin optimización combinatoria) |
| ¿Cuánto pido? | `required` (necesidad neta, jamás se pierde) ≠ `suggested` (tras envase→mínimo→múltiplo→capacidad, cada paso explicado §17); invariante sugerido = envases × tamaño, o declarado roto con aviso |
| ¿Cuándo pido y cuándo llega? | Entrega más temprana que cumpla días del proveedor Y de recepción del hogar; pedido en el día permitido más tardío (lead time es mínimo: pedir antes nunca atrasa). Ejemplo §12 como test con nombre: "pedir miércoles para recepción viernes, 5 kg" |
| ¿Y lo que ya viene? | Neteo por `alimento::unidad::base física` contra órdenes vivas Y líneas pendientes de la lista semanal — en camino JAMÁS se suma a "en casa" (§15: "En casa 4 kg / En camino 5 kg", nunca 9) |
| ¿Por qué? | Provenance paso a paso persistida en la orden (con las advertencias aceptadas), versión del motor `purchase-schedule/1.0.0` |
| ¿Quién hizo qué? | `procurement_order_events` append-only por transición; `supplier_name`/`presentation` congelados al crear |

## 2. Piezas

- **Migración `0014_procurement.sql`** (pendiente de aplicar en remoto): `suppliers`, `supplier_products` (presentación, envase, base física, mínimo, múltiplo, lead time, días de entrega, prioridad), `purchase_policies` (proveedor preferido + días de pedido/recepción — las cantidades siguen en `stock_targets`, una fuente por dato), `procurement_orders` + items + events, RPCs `create/advance/receive` (SECURITY DEFINER con `can_manage_shopping`, dedupe por hogar y estado, transiciones explícitas, recepción por el MISMO ledger del Sprint 7 con claves `RECEIVE-PO:{item_id}`).
- **Motor** `purchase-schedule/1.0.0`: puro, determinista (test byte a byte), sin reloj propio, sin conversiones de unidad NI de base física.
- **Cargador** `app/procurement/queries.ts` + **acciones** (aprobar con `known_incoming` anti-pantalla-vieja, avanzar, recibir, CRUD de proveedores con verificación de filas tocadas).
- **UI** `/procurement`: Próximos pedidos (producto, necesitas/sugerido, envases, proveedor, fechas, en casa/en camino/en lista SEPARADOS, cobertura al recibir, ¿Por qué?) · Necesita acción (sin proveedor, sin fechas, envases sin calzar) · En camino (avanzar/recibir/cancelar, avisos de atraso) · Recibidos recientemente (día del hogar). `/procurement/suppliers`: proveedores, presentaciones (con base física) y políticas por alimento.

## 3. Reglas §13-§22 verificadas con test

Aceptar es humano (nada nace sin clic); doble clic/dos pestañas/carrera insert-insert = UNA orden; cancelar libera la clave (jamás revive la muerta); reintentos idempotentes (advance mismo estado = no-op, receive tras éxito = 0); fecha de pedido pasada y `known_incoming` desfasado se rechazan con "recarga"; hogar B no ve, no crea, no avanza ni adivina nada del hogar A (mensaje unificado); recibir crea lotes en la BASE pedida y dos recepciones jamás duplican.

## 4. Deuda declarada

- Capacidad por alimento sin fuente de datos (la del Sprint 8 es por ubicación): motor listo y testeado, cargador pasa `{}`.
- Cantidad real recibida ≠ sugerida → `adjust_lot` del Sprint 8 sobre el lote nuevo; cantidades por boleta en el sprint de recepción.
- Aviso de higiene "porciones PLANNED de fechas pasadas" (deuda del Sprint 8) sigue pendiente — las órdenes atrasadas SÍ avisan ya.

## 5. Fuera de alcance (§ NO scope, respetado)

OCR de boletas, comparación Líder/Jumbo, pagos, facturas, contabilidad, costos familiares completos, batch prep, etiquetas/impresora, forecast con IA.
