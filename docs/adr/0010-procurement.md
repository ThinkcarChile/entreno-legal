# ADR 0010 — Procurement: planificar el abastecimiento sin falsificar el stock

**Estado:** PROPUESTO (Sprint 9, `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION`)
**Fecha:** 2026-08-24

## Contexto

El Sprint 8 responde "¿cuánto voy a necesitar?" (ReorderEngine). Falta el paso
comercial: ¿a quién se lo pido, cuánto conviene pedir dadas sus reglas (envase,
mínimo, múltiplo), cuándo pedir para que llegue a tiempo? El director fija
además fronteras duras: lo que viene en camino NO es stock; nada se compra
solo; la necesidad calculada no se pierde al redondearla a lo comprable.

## Decisiones

1. **Motor determinista y versionado** (`purchase-schedule/1.0.0`), puro, sin
   reloj propio: el "hoy" entra como día del HOGAR. Mismos insumos → mismo
   resultado byte a byte (test explícito). Sin IA en el número (igual que 0009).

2. **Una fuente por dato** (regla del proyecto): las CANTIDADES objetivo viven
   en `stock_targets` (0013). `purchase_policies` solo agrega lo propio del
   abastecimiento: proveedor preferido y días de pedido/recepción del hogar.
   No existen frecuencias universales por categoría: cada alimento su política.

3. **`required_quantity` ≠ `suggested_order_quantity`** y ambas se persisten en
   el item de la orden. La cadena envase→mínimo→múltiplo→capacidad se registra
   paso a paso en `provenance` (jsonb) — el "¿Por qué 10 kg?" completo
   sobrevive al ciclo de vida de la orden.

4. **En camino jamás es stock físico.** El motor NETEA la recomendación contra
   órdenes vivas (PLANNED/ORDERED/READY/DELIVERING; SUGGESTED no cuenta porque
   nadie la aceptó; RECEIVED/STORED ya son lotes). El neteo respeta la BASE
   FÍSICA (`ingredientId::unit::weight_basis`): una orden de crudo no cubre la
   necesidad de escurrido. La UI muestra "en casa X · en camino Y", nunca X+Y.
   Si lo en camino cubre todo, se informa (`coveredByIncoming`) y NO se sugiere
   de nuevo. Una orden que netea pero viene ATRASADA (entrega vencida, o
   PLANNED con fecha de pedido pasada) genera advertencia fuerte: se netea
   igual (no compramos doble solos) pero jamás en silencio.

4b. **La lista de compras semanal también netea, en AMBAS direcciones**: las
   líneas PENDIENTES (listas DRAFT/ACTIVE) descuentan la sugerencia de
   procurement, y "agregar a próxima compra" (Sprint 8) descuenta las órdenes
   de procurement vivas — la misma necesidad no se compra en el supermercado Y
   se pide al proveedor.

5. **Ciclo de vida con transiciones explícitas** en un RPC
   (`advance_procurement_order`): SUGGESTED→PLANNED exige humano (las
   sugerencias ni siquiera se persisten como órdenes: nacen PLANNED al
   aprobar); recibir pasa SOLO por `receive_procurement_order`. Reintentar el
   estado actual es no-op (idempotencia de reintento). Escritura directa a las
   tablas de órdenes cerrada (RLS solo-select).

6. **Recepción = el MISMO libro mayor del Sprint 7.** `receive_procurement_order`
   replica el mecanismo de `receive_shopping_list`: lote en 0 + movimiento
   PURCHASE con clave `RECEIVE-PO:{item_id}` (K-22: recibir dos veces jamás
   duplica). No existe un segundo sistema de recepción.

7. **Aceptación idempotente por `dedupe_key`** determinista
   (hogar+alimento+base+fecha+cantidad+presentación): el doble clic y las dos
   pestañas crean UNA orden (índice único parcial + relectura en el RPC, con
   la carrera insert-insert absorbida por `unique_violation`). La búsqueda
   filtra por HOGAR y por estado ≠ CANCELLED: la clave de otro hogar responde
   'no autorizado' (sin oráculo) y cancelar LIBERA la clave — re-aprobar crea
   una orden nueva, jamás revive la muerta con mensaje de éxito. Dos guardas
   anti-pantalla-vieja: `order_date` en el pasado del hogar se rechaza, y
   `known_incoming` (lo que la pantalla creía en camino) se compara contra lo
   VIVO — si difiere, "recarga la página" en vez de una segunda orden.

7b. **Historia que no se reescribe**: `supplier_name` y `presentation` se
   CONGELAN en la orden al crearla (como la etiqueta del lote); cada
   transición queda en `procurement_order_events` (append-only: quién, desde
   qué estado, hacia cuál, cuándo); las advertencias aceptadas (confianza
   baja, riesgo de quiebre) se persisten en la provenance del item; y la
   provenance corrupta se lee salvando los pasos legibles y declarando los
   omitidos, jamás vaciándose en silencio. Los permisos usan
   `app.can_manage_shopping` — el MISMO guard del receiving del Sprint 7.

8. **Fechas**: entrega válida más temprana que cumpla días del proveedor Y
   días de recepción del hogar; el pedido se ubica en el día permitido MÁS
   TARDÍO dentro de [hoy, entrega−lead] (menos anticipación = pronóstico más
   fresco; el lead time es mínimo, no exacto: pedir antes nunca atrasa). Si la
   entrega llega después del quiebre proyectado, se avisa — no se esconde.

9. **v1 multi-proveedor** (§18): preferido de la política o mejor prioridad;
   las alternativas se listan, no se combinan. La optimización combinatoria
   queda explícitamente fuera. Una presentación en OTRA unidad no participa
   (sin conversiones inventadas); se avisa.

10. **Capacidad**: el motor la respeta cuando se CONOCE (recorte hacia abajo en
    envases enteros, jamás bajo el mínimo del proveedor — en ese caso avisa).
    Hoy el cargador pasa capacidad vacía: la capacidad del Sprint 8 es por
    UBICACIÓN y repartirla por alimento sería inventar. Deuda declarada.

## Limitaciones aceptadas (documentadas, no silenciosas)

- La cantidad RECIBIDA se acredita según lo sugerido; si llegó otra cantidad,
  el ajuste es el del Sprint 8 (`adjust_lot`, con `is_approximate`) sobre el
  lote recién creado. Cantidades reales por boleta → sprint de recepción.
- `price` existe pero no decide: la comparación por precio llega con el sprint
  de recepción con boleta (`cost_allocations`).
- Las sugerencias no se persisten: se recalculan en vivo (coherente con 0009);
  el histórico auditable empieza al APROBAR (la orden guarda provenance y
  engine_version).

## Consecuencias

- `/procurement` puede explicar cada número y cada fecha con datos reales.
- Shopping (Sprint 6) sigue siendo el dueño de la LISTA semanal; Procurement
  planifica pedidos a proveedores. Ambos nacen de la misma recomendación pero
  el neteo de órdenes vivas evita pedir dos veces.
- Nada de este sprint toca porciones, nutrición, targets ni el ledger fuera de
  la recepción.
