# QA adversarial — Sprint 9 (Procurement)

**Fecha:** 2026-08-24
**Método:** workflow §26 de 9 lentes (A doble compra, B frontera inventario, C fechas/timezone, D restricciones del proveedor, E concurrencia/idempotencia, F seguridad entre hogares, G cantidades/unidades, H UI/frontera de datos, I auditoría/historia), cada lente con verificador escéptico independiente. 18 agentes; 54 hallazgos confirmados brutos, 1 refutado. Al deduplicar (el mismo defecto confirmado por varios lentes es señal, no doble conteo): **17 defectos únicos — 16 corregidos con regresión, 1 documentado como limitación en ADR 0010**.

## Corregidos (16)

1. **La base física se perdía en TODO el ciclo** (A/B/F/G/H/I, ALTO — el hallazgo estrella, 6 lentes lo encontraron por caminos distintos). `ProcurementNeed` botaba `weightBasis`, el item de orden no lo guardaba y `receive_procurement_order` hardcodeaba `'RAW'`: una necesidad DRAINED se recibía en el balde crudo → el bucket escurrido seguía en cero → recompra en loop infinito con stock fantasma RAW. Ahora `weight_basis` viaja por necesidad → sugerencia → item → lote, `supplier_products` declara su base, y el motor no elige presentaciones de otra base ("no se convierte a ciegas"). Regresiones: motor (RAW no netea DRAINED) + integración (lote nace DRAINED con 320 g).
2. **El neteo de "en camino" colapsaba RAW y DRAINED** (clave `ingredientId::unit`): una orden de crudo dejaba la necesidad de escurrido en "ya viene cubierta" — quiebre con mensaje tranquilizador. Clave ahora `ingredientId::unit::weightBasis`.
3. **Doble compra entre la lista semanal y las órdenes** (A, ALTO): cero neteo cruzado. Ahora en AMBAS direcciones: las líneas PENDING (listas DRAFT/ACTIVE) descuentan la sugerencia de procurement con paso de provenance, y "agregar a próxima compra" del Sprint 8 descuenta las órdenes vivas.
4. **El dedupe devolvía órdenes CANCELLED** (A/E/G/I, ALTO): cancelar y re-aprobar era un no-op con "Orden planificada ✓" — quiebre con mensaje de éxito. El índice único y la búsqueda excluyen CANCELLED: cancelar libera la clave y re-aprobar crea una orden NUEVA (regresión de integración).
5. **Dedupe sin filtro de hogar en el RPC SECURITY DEFINER** (E/F/H): la clave de otro hogar devolvía su uuid (oráculo + secuestro silencioso de la aprobación). Búsqueda filtrada por hogar; el choque del índice con clave ajena responde el 'no autorizado' unificado.
6. **Carrera check-then-insert del dedupe** (A/B/E): dos aprobaciones simultáneas reventaban con 23505 crudo. El `unique_violation` se absorbe y relee.
7. **Pestaña desactualizada creaba una SEGUNDA orden viva** (A/E, la clave cambia con fecha/cantidad): dos guardas nuevas en el RPC — `order_date` en el pasado del hogar se rechaza ("recarga la página"), y cada item declara `known_incoming` que se compara contra lo VIVO en camino; si difiere, error explicado. Pedir lo ADICIONAL neto sigue siendo legítimo (regresión con ambos caminos).
8. **`suggestQuantity` rompía el invariante sugerido = envases × tamaño** (D/G/H): con múltiplo no conmensurable con el envase entregaba un par contradictorio y el ledger acreditaba menos de lo físico. Ahora busca el menor número de envases que cumpla mínimo Y múltiplo (350 y 1.000 se encuentran en 7.000 = 7 envases); si no existe en rango razonable, `packageCount` null + aviso "confirma con el proveedor" + la sugerencia cae a "necesita acción".
9. **El recorte por capacidad ignoraba el múltiplo** (D/B/G): podía sugerir cantidades que el proveedor no acepta. El recorte baja en envases enteros que sigan cumpliendo el múltiplo.
10. **El neteo ignoraba el atraso de la orden que netea** (C, ALTO + A/B/H "PLANNED abandonada netea para siempre"): mercadería fantasma cubría necesidades en silencio. Se sigue neteando (no pedimos doble solos) pero con advertencia fuerte — entrega vencida y PLANNED con fecha de pedido pasada, en sugerencias Y en `coveredByIncoming`; la UI marca "(la fecha de pedido ya pasó)".
11. **`coverageAfterDays` inflado dos veces** (G/H): recortaba el `available` negativo a 0 (escondía el faltante confirmado) y no descontaba el consumo entre hoy y la entrega. Ahora `(libre + en camino + sugerido − tasa×días_hasta_entrega) / tasa` (regresiones: 3,5 días con faltante; 6 días con entrega en 2).
12. **`receive_procurement_order` no era idempotente al reintento** (E): el segundo "recibir" tras el éxito devolvía error. Ahora RECEIVED/STORED → no-op con 0 (el guard K-22 por item sigue intacto).
13. **`supplier_product_id` sin validar** (B/F/G/I): aceptaba presentaciones de otro hogar, de otro proveedor o de otro alimento/unidad. El RPC valida ámbito ('no autorizado' unificado) y coherencia (proveedor de la orden, alimento y unidad del item).
14. **Permisos divergentes con el Sprint 7** (B): recibir por procurement usaba `is_household_member` mientras el receiving del Sprint 7 exige `can_manage_shopping`. Los tres RPC usan ahora el MISMO guard.
15. **Historia reescribible** (I): nombre del proveedor por JOIN vivo, sin actor ni timestamp por transición, advertencias no persistidas, `received_at` mostrado en día UTC, `provenance.catch([])` que tragaba el rastro completo. Ahora: `supplier_name` y `presentation` congelados al crear, tabla append-only `procurement_order_events` (quién/desde/hacia/cuándo — regresión: PLANNED→ORDERED→RECEIVED con actor), advertencias aceptadas dentro de la provenance, día del hogar en la UI, y lectura de provenance que salva los pasos legibles declarando los omitidos.
16. **`saveSupplierProduct`/`saveSupplier` con éxito de 0 filas** (F): un update filtrado por RLS reportaba éxito. Ambos verifican lo tocado con `select("id")`.

## Documentado como limitación (1)

- **La cantidad recibida se acredita según lo sugerido** (G): no hay captura de "llegó otra cantidad" en la recepción v1. El ajuste es el del Sprint 8 (`adjust_lot` + `is_approximate`) sobre el lote recién creado; cantidades reales por boleta llegan con el sprint de recepción (`cost_allocations`). En ADR 0010.

## Refutado (1)

- `app.procurement_household` como fuga SECURITY DEFINER: solo resuelve el hogar para que las POLICIES lo comparen con `is_household_member` — no expone datos por sí misma.

## Verificación

436 pruebas verdes (40 dominio procurement + 20 integración PGlite con rol authenticated + las 376 previas), typecheck/lint/build limpios, cadena 0001→0014 completa validada en PGlite. Todo LOCAL: nada de esto se presenta como verificado contra el Supabase real (regla vigente).
