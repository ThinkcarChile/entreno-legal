# Migraciones pendientes en Supabase (mesa-familiar)

> **Regla vigente**: las migraciones listadas como pendientes están **CONGELADAS**.
> No se editan; cualquier cambio posterior va en una migración NUEVA. El checksum
> permite comprobar que lo que se aplique sea EXACTAMENTE lo revisado.
> Fuente de verdad del desarrollo mientras tanto: la cadena local (PGlite + CI).

## Estado remoto conocido

**Aplicado en Supabase** (proyecto `smwyxfnlxoohenhsdcjx`): `0001 → 0025` **COMPLETO** (0026/0027 del Sprint 11 pendientes, abajo)
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

- **0022 — identidad de producto en el consumo** · `b25657ea…` · **verificada
  en vivo** (§1 del Final Closure): atún 320→160→0 de SU lote, jurel y pollo
  intactos, faltante de 140 g con `product_id`.
- **0023 — confirm/consume serializados** · `a13a60e3…` · **verificada en
  vivo**: doble confirm simultáneo → ambos corren EN ORDEN (confirm_count 2,
  UNA proyección); consume∥confirm simultáneos → estado final único
  (CONSUMED, un solo −140).
- **0024 — función demo con dueño migración** · `d591e64b…` · aplicada
  (idéntica a la del seed; la paridad la vigila `gate-schema-parity`).
- **0025 — UNKNOWN nunca es normal** · `e47ee86c…` · **verificada en vivo**:
  columna 200, `unverifiable_constraints: ["ENERGY_MAX"]` congelada por el
  RPC, dedupe obligatorio rechaza con su mensaje, `/plan/comida` volvió a 200.

## Pendientes de aplicar (en este orden exacto)

### 0026 — Sprint 11: documentos médicos, biomarcadores y grants

- **Archivo:** `supabase/migrations/0026_health_documents.sql`
- **Propósito:** catálogo de biomarcadores (17 globales, solo ESTRUCTURA),
  `lab_documents` con consentimiento IA, `lab_extraction_candidates` (la capa
  IA propone), `lab_observations` (unidad NULL = desconocida; rango del
  laboratorio propio; corrección encadenada), `medical_data_grants` +
  `app.medical_access` (self / grant / tutor — los roles del hogar NO dan
  acceso), `member_lab_schedules`, y los RPC del pipeline. Bucket privado
  `medical-documents` en un bloque condicional (solo si existe el schema
  `storage`).
- **Dependencias:** 0001→0025 aplicadas.
- **Checksum SHA-256:** `bcaeba23f2988dc4ce6adad0ca1edde06a9863a05cbc948f7381d36b6666432a`
- **¿Destructiva?:** NO (100% aditiva).
- **Notas:** un solo pegado. Tras aplicarla, `/health` deja de dar el error
  honesto "Algo falló de nuestro lado" (hoy falla porque
  `medical_data_grants` no existe — verificado en vivo).

### 0027 — Sprint 11: reglas clínicas, restricciones e impacto

- **Archivo:** `supabase/migrations/0027_clinical_rules.sql`
- **Propósito:** `member_conditions` (registro, jamás generador de reglas),
  `clinical_rule_sets/versions` (inmutables tras publicar, doble capa
  RLS+trigger), `member_clinical_restrictions` (con fuente y confirmación),
  `meal_clinical_assessments` (snapshot explicable por referencia),
  `clinical_impact_reviews` (idempotentes), y
  `member_serving_projections.clinical_status` (divulgación mínima; historia
  SERVED/CONSUMED intocable).
- **Dependencias:** 0026 aplicada.
- **Checksum SHA-256:** `31e7d6a4ef48cb3817a0b326aa0a8fe54f7fc792cf5d5748cf001b16039d02ca`
- **¿Destructiva?:** NO (aditiva + dos columnas nuevas con default).
- **Notas:** un solo pegado, DESPUÉS de 0026. Validadas en PGlite (cadena
  0001→0027, 672 tests).

### Referencia: 0021### Referencia: 0021 — Gate tanda 4: neteo lista↔proveedor por base física

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
| Gate 0→10 | **PASS** (Final Closure 2026-08-25; informe §54 + sección Final Closure) — canario §50 PASS en vivo; tandas 1-3 de fixes aplicadas; tanda 4 de motores lista (weight_basis en prep + planningCoveredDates + reorder por base); quedan product_id extremo a extremo y el informe §54 |
