# Migraciones pendientes en Supabase (mesa-familiar)

> **Regla vigente**: las migraciones listadas como pendientes están **CONGELADAS**.
> No se editan; cualquier cambio posterior va en una migración NUEVA. El checksum
> permite comprobar que lo que se aplique sea EXACTAMENTE lo revisado.
> Fuente de verdad del desarrollo mientras tanto: la cadena local (PGlite + CI).

## Estado remoto conocido

**Aplicado en Supabase** (proyecto `smwyxfnlxoohenhsdcjx`): `0001 → 0021` **COMPLETO**
+ bloque de reglas USDA del seed. Verificado en vivo el 2026-08-25:

- `0001 → 0015` — Sprints 0-10, aplicadas con checksum verificado.
- **0016 — reglas de congelado/refrigerado por categoría** · SHA-256
  `a44691d4864a1cdd68139d08db5cef963fd984d0e4c59e5958b7f564db7ef3bd` ·
  datos idempotentes (demo viva Sprint 10).
- **0017 — sin pgcrypto** · SHA-256
  `57c04125981ac327084d620d16dfada029a8ba7fa0ffbd444b35c71ecf4ce5d5` ·
  `gen_random_uuid` en vez de `gen_random_bytes` (demo viva Sprint 10).
- **0018 — decisiones de reemplazo persistidas** · SHA-256
  `f868f5f2c8b7ada73baee1004c736f654ed8351f9823088579b9bd8832f5ec68` ·
  tabla `meal_substitution_choices` + RPCs `set/clear_substitution_choice`.
  Corrige el CANARIO §50 del gate (la sustitución vivía en un query param).
  **Verificada en vivo**: Sebastián quedó con Merluza 360 g y 0 g de pollo.
- **0019 — arreglos de ledger del gate (tanda 1)** · SHA-256
  `b4e3025b507af68dbe707f12753ebfedf196822af016b0bbf862a8c2b89ce8e2` ·
  `move_lot` v3 (temperatura del DESTINO), `add_manual_lot` v3
  (`processing_state` explícito), `receive_shopping_list` v2,
  `merge_lots` v2 (debita a los padres, compara `product_id`), trigger que
  protege asignaciones servidas, RLS de servings solo-SELECT.

- **0020 — gate tanda 3 (ámbito de UUIDs + base física + preferencia de cocción)**
  · SHA-256 `489e7f37e21a3e383a8e6fafe766df1dafaf9049a765371dca76734bb741c288` ·
  **Verificada en vivo** 2026-08-25: `ingredient_basis_conversions` responde 200
  con RLS, `set_cooking_preference` actualiza en una sola fila (2 opiniones →
  1 fila, stance final correcto) y un UUID ajeno rebota con `no autorizado`.

- **0021 — gate tanda 4 (neteo lista↔proveedor por base física)** · SHA-256
  `9451867c2fc48f4c2027fbb557f3e5f7dab2bbada3c07e160afc9b519a3c8fdf` ·
  **Verificada en vivo** 2026-08-25: la guarda `known_pending_in_list` rechaza
  con "la lista de compras cambió: recarga" y la transacción revierte entera
  (cero filas escritas).

## Pendientes de aplicar (en este orden exacto)

### 0022 — Gate tanda 5: la identidad por PRODUCTO llega al ledger de consumo

- **Archivo:** `supabase/migrations/0022_consume_product_identity.sql`
- **Propósito:** **[I-1]** `consume_planned_meal` v4. Antes iteraba SOLO
  componentes con `ingredient_id`: la porción de un producto comercial se
  comía, su lote quedaba intacto y no se registraba ni movimiento ni faltante
  (física falsificada en silencio). Ahora el match de lotes usa LA identidad
  del componente (producto contra producto, alimento contra alimento), la
  conversión cocido→crudo sigue siendo solo para alimentos (los rendimientos
  se anotan por ingrediente), y `consumption_shortfalls` gana la columna
  `product_id` para el linaje del faltante.
- **Dependencias:** 0001→0021 aplicadas.
- **Checksum SHA-256:** `b25657ea399d79cb4a1fb7fe9a29969adf253d5d2008ae0d1d5dde020f28c513`
- **¿Destructiva?:** NO (una columna aditiva + `create or replace`).
- **Notas de aplicación:** un solo pegado, DESPUÉS de 0021. Validada en PGlite
  (cadena 0001→0022, 598 tests, 2 regresiones propias por el camino REAL
  `confirm_meal_assignment`→`consume_planned_meal` en
  `web/src/integration/gate-tanda5.test.ts`).

### 0023 — Gate FINAL §2: confirm/consume serializados

- **Archivo:** `supabase/migrations/0023_confirm_consume_serialization.sql`
- **Propósito:** cierra el ALTO residual 1. `confirm_meal_assignment` v5 y
  `consume_planned_meal` v5 toman `for update` sobre LA MISMA fila de
  `meal_assignments` antes de leer o tocar estado físico: dos confirmaciones
  simultáneas (o confirmar mientras se consume) ya no pueden ambas ver "0
  servidas" — la segunda espera y decide con la verdad. Además los recorridos
  FEFO del consumo toman `for update of l` (dos consumos de comidas distintas
  no sobregiran el mismo lote). Cuerpos idénticos a 0010/0022 salvo los locks.
- **Dependencias:** 0001→0022 aplicadas (¡después de 0022!).
- **Checksum SHA-256:** `a13a60e34532a4024d303e55a44abedaf462708cbc92d9831fefd8c089bf384f`
- **¿Destructiva?:** NO (`create or replace` ×2).
- **Regresiones:** contrato de candado + doble recepción + consumir→confirmar
  en `gate-concurrency.test.ts`; la carrera real se prueba en vivo con doble
  disparo tras aplicar.

### 0024 — Gate FINAL §3: la función demo es schema real

- **Archivo:** `supabase/migrations/0024_demo_family_function.sql`
- **Propósito:** cierra el ALTO residual 2. `seed_demo_family_profiles` (que
  la APP llama en `loadDemoFamily`) pasa del seed a migración: schema de test
  == schema producible mediante migraciones. El seed queda como puntero y el
  arnés ya no lo carga. En el remoto la función YA existe (el seed se corrió
  a mano): aplicar esta migración la deja idéntica y con dueño correcto.
- **Dependencias:** ninguna nueva (función autónoma). Aplicar tras 0023 por
  orden del manifiesto.
- **Checksum SHA-256:** `d591e64b593d53973c2a1d422348f10b87548c86c51885c411fa8dd9cbf831ca`
- **¿Destructiva?:** NO (`create or replace` idéntica a la del seed).
- **Regresiones:** `gate-schema-parity.test.ts` — levanta la base SOLO con
  migraciones y exige que todo `.rpc()`/`.from()` de la app exista (probado
  por mutación: sin 0024 delata `seed_demo_family_profiles`); además prohíbe
  que un seed defina objetos permanentes de schema.

### 0025 — Gate FINAL §6: UNKNOWN nunca significa normal

- **Archivo:** `supabase/migrations/0025_unknown_never_normal.sql`
- **Propósito:** columna `unverifiable_constraints` en
  `member_serving_projections` (los límites SIN verificar se congelan como
  desconocidos, no desaparecen) + `confirm_meal_assignment` v6 (= v5 con la
  columna) + `create_procurement_order` v3 (dedupe_key OBLIGATORIO: con NULL
  no había idempotencia alguna y dos aprobaciones paralelas creaban dos
  órdenes).
- **Dependencias:** 0001→0024 aplicadas.
- **Checksum SHA-256:** `e47ee86c28966c7055b3f87b80bc7235fbe8b44ec65cbb14a1cdc386cba4b62d`
- **¿Destructiva?:** NO (columna aditiva con default + `create or replace` ×2).
- **Regresiones:** dedupe obligatorio en `gate-tanda4.test.ts`; veredicto
  verde ganado en `stock/engine.test.ts`; persistencia del desconocido cubierta
  por la cadena 0001→0025 (612 tests).

### Referencia: 0021 — Gate tanda 4: neteo lista↔proveedor por base física

- **Archivo:** `supabase/migrations/0021_gate_netting_basis.sql`
- **Propósito:**
  - **[S-2]** el índice único de sugerencias pasa de `(list_id, ingredient_id)`
    a `(list_id, ingredient_id, unit, purchase_basis)`: la sugerencia DRAINED
    ya no pisa a la RAW del mismo alimento.
  - **[P-1]** `create_procurement_order` v2: revalida TAMBIÉN
    `known_pending_in_list` contra la lista viva (antes solo `known_incoming`).
    Aprobar desde una pestaña vieja recibe "recarga la página", no una orden
    que duplica lo que la lista ya pide en el súper.
- **Dependencias:** 0001→0020 aplicadas.
- **Checksum SHA-256:** `9451867c2fc48f4c2027fbb557f3e5f7dab2bbada3c07e160afc9b519a3c8fdf`
- **¿Destructiva?:** NO en datos (un `drop index` + recreación ensanchada — la
  clave vieja era subconjunto, no puede chocar — y un `create or replace`).
- **Notas de aplicación:** un solo pegado, DESPUÉS de 0020. Validada en PGlite
  (cadena 0001→0021, 596 tests, 5 regresiones propias en
  `web/src/integration/gate-tanda4.test.ts`).

### Referencia: 0020 — Gate tanda 3: ámbito de UUIDs + base física + preferencia de cocción

- **Archivo:** `supabase/migrations/0020_gate_scope_and_basis.sql`
- **Propósito:** cierra 4 familias de defectos ALTO de la auditoría de 13 lentes:
  - **[G-1]** `replace_draft_content` v4: valida los CINCO UUID que manda el
    navegador (alimento, producto, sub-receta, medida casera, ficha
    nutricional) contra el hogar. Antes entraban sin revisar.
  - **[G-2]** `publish_meal_template_version` v3: rechaza publicar si un
    componente apunta a una ficha nutricional de OTRO hogar. Antes publicar la
    COPIABA dentro de `frozen_nutrition` (exfiltración vía SECURITY DEFINER).
    Conserva intactos los guardianes de 0004 (receta vacía, unidad/base,
    congelado, auditoría).
  - **[B-1]** `receive_shopping_list` v3: la base física de la compra se
    traduce al lote (`COMMERCIAL_PACKAGE`/`UNIT` → `AS_PACKAGED`) en vez de
    aplastarse a RAW. Antes un componente en AS_PACKAGED jamás encontraba lote
    y la comida se servía sin descontar la despensa.
  - **[B-1b]** tabla nueva `ingredient_basis_conversions` + `app.basis_factor`:
    factores EXPLÍCITOS entre bases físicas (nace vacía a propósito: sin fila
    no hay conversión, el faltante se declara).
  - **[M-2]** `set_cooking_preference` (RPC nuevo) + índices únicos parciales
    en `member_cooking_preferences`: cambiar de opinión ACTUALIZA. El upsert
    viejo nunca chocaba (NULLS DISTINCT) y acumulaba filas contradictorias.
    Incluye limpieza de duplicados heredados (conserva la última opinión).
- **Dependencias:** 0001→0019 aplicadas.
- **Checksum SHA-256:** `489e7f37e21a3e383a8e6fafe766df1dafaf9049a765371dca76734bb741c288`
- **¿Destructiva?:** un `delete` acotado a duplicados EXACTOS de
  `member_cooking_preferences` (conserva la última fila de cada grupo, que es
  la opinión vigente de la persona); el resto es aditivo + `create or replace`.
  El aviso "destructive operations" del editor es el falso positivo de siempre.
- **Notas de aplicación:** un solo pegado, DESPUÉS de 0019. Validada completa
  en PGlite (cadena 0001→0020, 584 tests, 14 regresiones propias en
  `web/src/integration/gate-tanda3.test.ts`).

## Cómo verificar un checksum antes de aplicar

```bash
sha256sum supabase/migrations/0022_consume_product_identity.sql
sha256sum supabase/migrations/0023_confirm_consume_serialization.sql
sha256sum supabase/migrations/0024_demo_family_function.sql
sha256sum supabase/migrations/0025_unknown_never_normal.sql
```

Debe coincidir EXACTAMENTE con el registrado acá. Si no coincide, NO aplicar:
revisar `git log` del archivo y regenerar este manifiesto.

## Estados de sprint

| Sprint | Estado |
|---|---|
| 8 — Stock Intelligence | verificado en vivo dentro del Integration Gate 0→10 (reorder, netting, forecast) |
| 9 — Procurement | demo viva ejecutada (orden creada/avanzada/recibida contra Supabase real) |
| 10 — Batch prep | demo viva ejecutada (`docs/qa/sprint-10-demo-viva.md`); 0016/0017 nacieron de ella |
| Gate 0→10 | EN CURSO — canario §50 PASS en vivo; tandas 1-3 de fixes aplicadas; tanda 4 de motores lista (weight_basis en prep + planningCoveredDates + reorder por base); quedan product_id extremo a extremo y el informe §54 |
