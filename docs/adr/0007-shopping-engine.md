# 0007 — ShoppingEngine: la lista de compras sale de las porciones confirmadas

- Estado: APROBADO (implementado en Sprint 6)
- Fecha: 2026-08-24
- Decisión de baseline afectada: implementa ShoppingList / ShoppingListItem / ShoppingListRevision. Precisa §C-6 con dos columnas congeladas nuevas.
- Migración: `supabase/migrations/0009_shopping.sql`

## Contexto

El Sprint 6 pide transformar una semana planificada en una lista de compras exacta. La tentación obvia — `cantidad de la receta × número de personas` — está prohibida por el propio sprint (§1), y con razón: las porciones reales difieren por persona (Sebastián come 255 g de pollo, Paula 180), hay sustituciones (la merluza de Sebastián no es pollo), participantes excluidos (Ricardo comió afuera) y estados crudo/cocido.

## Decisiones

### 1. La fuente de verdad son los componentes confirmados, con identidad congelada

`member_serving_components` gana `ingredient_id` y `product_id`: el alimento que esa persona come DE VERDAD, con la sustitución ya aplicada, escrito en la propia fila al confirmar. Antes había que reconstruirlo cruzando `meal_slot_components` y `member_serving_substitutions` — dos joins con `on delete set null` en el camino, es decir, dos maneras de que la lista agrupe mal en silencio. El backfill puebla lo ya confirmado.

### 2. El motor es puro y no opina

`domain/shopping/engine.ts` (`shopping-engine/1.0.0`): entra `{servings, yields, ingredients, products}`, sale `DemandLine[]`. Determinista, sin IA, sin acceso a datos. No cambia porciones, no sustituye, no ajusta (§29). Reglas duras:

- **Crudo ≠ cocido**: demanda cocida se convierte con `ingredient_yields` (factor por alimento, opcionalmente por método; el específico le gana al genérico). Sin factor → `PURCHASE_QUANTITY_UNRESOLVED` con explicación; jamás un 1.0 inventado (§47). `EDIBLE_PORTION` convierte con `edible_portion_factor` del catálogo; `DRAINED` y `AS_PACKAGED` son bases propias.
- **Unidades incompatibles no se suman**: la clave de línea es `identidad::unidad::base`. Gramos, mililitros y unidades viven en líneas separadas (§7, §9). DRAINED no se mezcla con crudo, y un producto en base DRAINED no sugiere envases — dividir gramos escurridos por contenido envasado es la misma mentira que crudo÷cocido.
- **La firma cubre todo lo que el motor lee**: servings + rendimientos + porción comestible + formatos de envase, por contenido y no por ids de fila. Deshacer y reconfirmar idéntico da la misma firma (§51); curar un factor en el catálogo la cambia y la lista avisa.

### 3. Revisiones inmutables, regeneración transaccional

Cada generación es una fila de `shopping_list_revisions` con número, firma, versión del motor, deltas y el payload completo congelado (§49). La política RLS solo permite `INSERT`: la historia no se edita ni se borra, ni siquiera el dueño.

Todo el ciclo — insertar revisión, upsert de items por `line_key`, retirar huérfanos, avanzar la cabecera — vive en el RPC `generate_shopping_revision`, en UNA transacción. Una secuencia de escrituras desde la aplicación podía morir a mitad de camino y dejar la revisión N insertada con la cabecera en N-1: el próximo intento chocaría con el unique y la lista quedaría muerta para siempre.

### 4. El checklist sobrevive; lo comprado es historia

Los items se reconcilian por `line_key`: regenerar actualiza cantidades y conserva el estado (`PURCHASED` sigue comprado). Un item comprado que se queda sin demanda NO se borra — la compra ocurrió; queda con demanda 0. Uno pendiente sin demanda se retira (§14).

`required_quantity` (lo calculado) y `planned_quantity` (lo que el comprador decide) son columnas separadas (§21). `set_planned_quantity` escribe cantidad y auditoría juntas; los sellos de identidad (`changed_by`, `purchased_by`, `added_by`) los estampa la base con quien está autenticado — el cliente no puede firmarse como otra persona.

### 5. Lista oficial = solo confirmado (§31)

Sin demanda provisional mezclada: lo pendiente de confirmar se informa en un banner con el detalle de qué falta. Menos riesgo, cero ambigüedad sobre qué significa cada número.

### 6. Coherencia hogar↔plan por FK compuesta

`shopping_lists (plan_id, household_id)` referencia `weekly_plans (id, household_id)`: una lista solo puede existir sobre un plan de SU hogar. Sin esto, un hogar ajeno podía "ocupar" el plan de otro (el unique de `plan_id`) y bloquearle la lista para siempre.

## Precisiones del Sprint 5 aplicadas acá

- **§0A**: los parámetros de estrategia de evento son `EventStrategyParams` versionados (`event-strategy/1.0.0`); cada porción confirmada guarda en `event_effect` la configuración efectiva usada. Cambiar los defaults no reescribe semanas históricas.
- **§0B**: al confirmar, `confirm_meal_assignment` materializa el conjunto exacto de participantes en filas explícitas. Un sexto integrante nuevo no entra a comidas históricas (test de regresión §42). Des-confirmar CONSERVA el conjunto explícito — es visible en el tablero ("Comen: …"), y borrarlo perdería exclusiones puestas a mano.

## Deuda y descartes

- La grasa añadida por preparación se agrega como línea genérica "Grasa para cocinar" en gramos: no apunta a un aceite del catálogo porque inventarle identidad sería mentir. Futuro: mapear a la grasa preferida del hogar.
- `confirm_meal_assignment` no valida que `profile_id`/`daily_plan_id` pertenezcan al integrante (los escribe un server action confiable; PostgREST directo podría cruzarlos). Anotado para el hardening pre-producción.
- Realtime multiusuario (§37): persistencia correcta primero; la colaboración en vivo queda para cuando haya dos compradores reales.
- Sin inventario, lotes, recepción, precios ni proveedores (§54): sprints siguientes.
