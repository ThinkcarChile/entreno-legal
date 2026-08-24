# Sprint 6 — Entrega: ShoppingEngine y lista de compras familiar

**Fecha:** 2026-08-24
**Estado de verificación:** 267 pruebas verdes (31 de dominio del motor + 31 de integración de compras sobre PostgreSQL real + las 205 previas), `lint`, `typecheck` y `build` limpios.
**Revisión adversarial:** workflow de 35 agentes en 5 lentes (correctitud, falla silenciosa, seguridad/RLS, cumplimiento de spec, UI) — 26 hallazgos confirmados, todos corregidos antes de esta entrega.

---

## 1. Qué se construyó

### Precisiones del Sprint 5 (§0)

**§0A — Estrategias de evento versionadas.** `EventStrategyParams` (`event-strategy/1.0.0`): `energyCeilingMultiplier` 1,25 · `aroundTargetMultiplier` 0,9 · `minimumFloorPolicy` NEVER_BELOW_DECLARED_MINIMUM. Ya no son constantes enterradas: `applyEventEffect` las recibe como parámetro y cada porción confirmada guarda en `member_serving_projections.event_effect` la configuración EFECTIVA usada (versión + parámetros + evento). Cambiar el default mañana no toca ninguna semana histórica.

**§0B — Participantes congelados al confirmar.** "Sin filas = todos" sigue valiendo para una comida sin confirmar. `confirm_meal_assignment` ahora materializa el conjunto exacto en `meal_assignment_participants` al confirmar. Test de regresión §42 en verde: confirmar para cinco → agregar sexto integrante → los participantes y las porciones siguen siendo cinco, y la demanda es 5×180 g, no 6×180 g. Des-confirmar conserva el conjunto explícito (visible en el tablero; borrarlo perdería exclusiones puestas a mano).

### Migración `0009_shopping.sql`

- `member_serving_components` + `ingredient_id`/`product_id` congelados (identidad real, sustitución aplicada) con backfill de lo ya confirmado.
- `ingredient_yields` (crudo→cocido por alimento y método; seed: arroz ×2,8 · fideos ×2,4 · lentejas ×2,5).
- `shopping_lists` (una por semana, FK compuesta plan↔hogar), `shopping_list_revisions` (inmutables por RLS), `shopping_list_items` (con `line_key` estable, `required` vs `planned`, provenance jsonb, estados), `shopping_item_overrides` (auditoría).
- RPCs transaccionales: `generate_shopping_revision` (todo o nada) y `set_planned_quantity` (cantidad + auditoría juntas).
- Triggers que estampan la identidad real (`changed_by`, `purchased_by`, `added_by`) desde la sesión autenticada.
- `app.can_manage_shopping` + arreglo del anclaje de rol a hogar (también en `app.is_household_admin`, que traía el mismo hueco desde el Sprint 1).

### Motor (`domain/shopping/engine.ts`)

`aggregateDemand`, `demandSignature`, `computeDeltas`, `formatQuantity`, grupos §18 mapeados desde el catálogo. Determinista y sin opinión (§29): PortionOptimizer decide porciones, Planning decide personas, ShoppingEngine solo suma y explica.

### UI `/shopping` (§32-§36, §38)

Progreso X/Y, secciones por categoría, checkbox grande, detalle con "¿Por qué necesito esto?" (procedencia por comida con fecha, tipo y personas), editar cantidad (vacío = volver a la calculada), Ya lo tengo / No lo llevo / Volver a pendiente, banner de comidas sin confirmar, banner "Tu planificación cambió" con deltas y decisión explícita (Actualizar / Mantener), producto manual, Finalizar/Reabrir compra. Pestaña "Compras" en la navegación.

---

## 2. Los casos que definen el sprint, probados

| Caso | Resultado |
|---|---|
| §40 suma exacta de servings (nunca receta×personas) | ✓ dominio |
| §41 excluido no genera demanda | ✓ dominio + integración |
| §42 sexto integrante no entra a comidas históricas | ✓ integración (regresión pedida) |
| §43/§27 sustitución: pollo −360, merluza +340 (masa de la serving final) | ✓ dominio |
| §44 500 g + 1,2 kg = 1.700 g (presentado "1,7 kg") | ✓ dominio |
| §45/§9 g/ml/unidades jamás se suman entre sí | ✓ dominio |
| §46 cocido→crudo con rendimiento; §47 sin rendimiento = UNRESOLVED explicado | ✓ dominio |
| §48 versión nueva de receta no cambia demanda histórica (doble capa: RLS + inmutabilidad) | ✓ integración |
| §49 v1 auditable tras v2; historial inmutable incluso para el dueño | ✓ integración |
| §50 hogar B no lee/escribe listas de A; no puede ocupar su plan | ✓ integración, rol authenticated |
| §51 misma firma = misma revisión, sin duplicar | ✓ dominio + integración |
| §52 manual (detergente) separado de lo calculado | ✓ integración |
| B-2 Sprint 4: agrupar por alimento real | ✓ regresión explícita |

## 3. Hallazgos de la revisión adversarial (los que importan)

1. **La firma omitía la porción comestible y los formatos de envase** — una línea UNRESOLVED por falta de `edible_portion_factor` jamás se habría podido resolver: curar el catálogo no cambiaba la firma y "Actualizar lista" nunca aparecía. La firma ahora cubre TODO lo que el motor lee.
2. **Regenerar no era atómico** — un fallo a mitad de camino dejaba una revisión huérfana y la lista muerta para siempre (unique violado en cada reintento). Ahora es un RPC transaccional.
3. **El hogar B podía "ocupar" el plan del A** — `shopping_lists` no exigía coherencia plan↔hogar; el unique de `plan_id` se volvía un bloqueo permanente. FK compuesta.
4. **Regenerar borraba items ya comprados** — destruía el registro de compra y su auditoría en cascada. Lo comprado ahora es historia: queda con demanda 0.
5. **Éxito fantasma** — updates que RLS dejaba en 0 filas devolvían "listo". Todas las acciones verifican filas afectadas.
6. **Identidad de auditoría falsificable** — `changed_by`/`purchased_by` los ponía el cliente; ahora los estampa la base.
7. **El historial de revisiones era editable** por el shopper; ahora es INSERT-only.
8. **COMPLETED solo se respetaba en la UI**; ahora el servidor y los RPCs lo rechazan.
9. **Vaciar el campo de cantidad guardaba 0** ("comprar cero" accidental); vacío ahora significa "volver a la calculada".
10. Más: envases sobre base DRAINED eliminados (subestimaban latas), procedencia honesta en líneas sin resolver, `previewDeltas` fallido ya no dice "no cambia nada", "Volver a pendiente", toasts visibles en móvil, tablero con `key` por semana, anclaje de roles a su hogar.

## 4. Deuda declarada

- **Grasa añadida**: línea genérica en gramos, sin identidad de aceite (inventarla sería mentir). Futuro: grasa preferida del hogar.
- `confirm_meal_assignment` no valida pertenencia de `profile_id`/`daily_plan_id` (server actions confiables hoy; hardening pre-producción).
- Realtime multiusuario (§37): persistencia correcta primero.
- Curado de `ingredient_yields` desde la UI: hoy solo seed.
- Migración **0009 pendiente de aplicar en Supabase** (el editor SQL no carga en las pestañas que yo abro; esperando la de Francisco). Hasta aplicarla, `/shopping` no funciona contra la base real.

## 5. Riesgos antes del InventoryEngine

1. **"Ya lo tengo" no descuenta nada** — es una declaración, no un movimiento de inventario. Cuando exista InventoryEngine, este estado debe RECALCULARSE, no confiarse.
2. **Finalizar compra no crea lotes** — COMPLETED es un estado de la lista, no una recepción. La conversión a Purchase real con cantidades/precios efectivos es del sprint de recepción; no construir nada que asuma que COMPLETED implica stock.
3. **Los rendimientos son globales** — cuando el hogar pueda curarlos, habrá que decidir si un factor del hogar pisa al global y cómo entra a la firma (hoy: cualquier cambio de factor regenera, que es lo correcto).
4. **Items manuales sin `ingredient_id`** no podrán descontarse de inventario automáticamente; el InventoryEngine necesitará un paso de vinculación opcional.
5. **La procedencia guarda nombres, no ids de personas** — suficiente para explicar; si el inventario necesita trazar por persona, agregar `member_id` al provenance antes de acumular semanas de datos.
