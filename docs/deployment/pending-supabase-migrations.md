# Migraciones pendientes en Supabase (mesa-familiar)

> **Regla vigente**: las migraciones listadas como pendientes están **CONGELADAS**.
> No se editan; cualquier cambio posterior va en una migración NUEVA. El checksum
> permite comprobar que lo que se aplique sea EXACTAMENTE lo revisado.
> Fuente de verdad del desarrollo mientras tanto: la cadena local (PGlite + CI).

## Estado remoto conocido

<!-- ESTADO:INICIO — generado, no editar a mano -->

**Proyecto:** `smwyxfnlxoohenhsdcjx` · **58 aplicadas** · **0 pendientes**

Método: `TESTIGOS_EN_VIVO` · verificado el 2026-09-02 · vale hasta el 2026-12-01.

Esto NO se escribe a mano: sale de `supabase/estado-produccion.json`, donde cada
migración declara un testigo —una expresión SQL falsa antes de aplicarla y verdadera
después— que se le pregunta a la base de verdad. Para actualizarlo:

```bash
node scripts/verificar-estado-produccion.mjs --escribir
node scripts/estado-a-documento.mjs --escribir
```

**No queda ninguna pendiente:** producción tiene la cadena completa.

<sub>Aplicadas: 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025, 0026, 0027, 0028, 0029, 0030, 0031, 0032, 0033, 0034, 0035, 0037, 0036, 0038, 0039, 0040, 0041, 0042, 0043, 0044, 0045, 0046, 0047, 0048, 0050, 0051, 0052, 0053, 0054, 0055, 0056, 0057, 0058, 0059</sub>

<!-- ESTADO:FIN -->


### El registro de qué hace cada una

Lo que sigue NO es el estado —ese es el bloque de arriba, que sale del libro— sino
el registro de qué hace cada migración, con qué checksum se revisó y qué se
comprobó en vivo cuando se aplicó. Eso se escribe a mano y se conserva.

Acá decía además, a mano, hasta dónde estaba aplicada la cadena. Se sacó: ese dato
ya tenía dueño y los dos discreparon —el documento anunciaba la 0036 y la 0038 como
pendientes cuando producción ya las tenía puestas—. Una lista de "qué falta
aplicar" equivocada es la lista con la que alguien decide qué correr contra una
base con datos de una familia.

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

- **0026 — Sprint 11 salud parte 1** · `bcaeba23f2988dc4ce6adad0ca1edde06a9863a05cbc948f7381d36b6666432a` · aplicada y verificada en vivo.
- **0027 — Sprint 11 salud parte 2** · `31e7d6a4ef48cb3817a0b326aa0a8fe54f7fc792cf5d5748cf001b16039d02ca` · aplicada y verificada en vivo.
- **0028 — corrección de codificación** · `8d9b868f9138818e9dc0234ac503444b1db22997c8542ae4e484af11cb3de5d1` · aplicada: 5 nombres de biomarcador y 22 funciones tenían los acentos rotos porque las entregué con `clip` en vez de `Set-Clipboard` UTF-8. **Regla: entregar SIEMPRE con `Get-Content -Raw -Encoding UTF8 | Set-Clipboard` y verificar con `Get-Clipboard` antes de avisar.**

- **0029 — fuente de nutrición clínica** · `c52a1c56ebb21162b776efeeb2d141aa54a07722999c3338d0c272cda1f4974b` · aplicada.
- **0030 — impacto clínico sobre la lista de compras** · `00bcd9a8b6928d5c30d86a63b3a535b4a4895ff4b8227b8279b9d86c190ef2c4` · aplicada.

- **0031 — cota del rendimiento crudo/cocido** · `5d96f3a824ed92ef77832286d86cbc8d9334443856287429d9b3de4f24a083e6` · **aplicada y verificada en vivo 2026-08-25** por la Management API. Verificado contra la base: los dos checks dicen `<= 5`.
- **0032 — capacidad olla a presión** · `392d23f904c0956a18f077e1ae651f7fe99a8f08fcae31a82115be7b0953575a` · **aplicada y verificada en vivo 2026-08-25**. Verificado: `PRESSURE_COOKER` existe, 11 capacidades en total.

- **0033 — cerrar el salto entre hogares** · `fc37714d1224088736d03bb4889dcfcaa0f1d4ac11d2d9f11b5829e4c3facb1d` · aplicada (auditoría post-11.5, DEFECTO 1).
- **0034 — storage médico: lectura y borrado** · `d54eb59e40f8e1e9fa0e021d6b19b506df6fa1c81533b4c5b8f8b87ca57541b4` · aplicada (auditoría post-11.5, DEFECTO 2).
- **0035 — la porción que nadie evaluó lo dice** · `1a6feafd7892ee119a505abd95733038871130d3db6b9068b85d684fef87fcb4` · aplicada (auditoría post-11.5, DEFECTO 3).
- **0037 — la invitación no cruza hogares** · `6715b3bfcb0b18fd5dab094c43a44c2fc6c4ca744b766da9d475532dbddee85f` · aplicada.

## Pendientes de aplicar

### 0036 + 0038 — FoodLog: el plan no es la realidad, y el consumo real tiene eje propio

> ### LAS DOS SE APLICAN JUNTAS, EN ESTE ORDEN Y EN LA MISMA VENTANA
>
> No es una preferencia de orden. La **0036 le QUITA** a `consume_planned_meal`
> la escritura del consumo —porque el servido pasa a ser el ÚNICO dueño del
> efecto físico— y la **0038 es quien la RECUPERA**, ahora en el eje
> nutricional. Aplicar la 0036 sola deja al sistema descontando la despensa y
> sin anotar en ninguna parte lo que la familia comió: el eje ACTUAL queda
> mudo, y ese hueco después se lee como un cero. **Si la 0038 no puede
> aplicarse, la 0036 tampoco entra.**

**El principio que aplican las dos:** PLANNED, SERVIDO y ACTUAL_CONSUMED son
tres hechos distintos, en tres tablas distintas, y ninguno se fabrica del otro.
Un solo dueño del efecto físico (el servido); el eje ACTUAL es nutricional y no
toca inventario nunca — garantizado por CHECK, no por confianza.

### 0036 — servido: el dueño único del efecto físico

- **Archivo:** `supabase/migrations/0036_foodlog_plan_vs_reality.sql`
- **SHA-256:** `8081a08995f3de8f5dbe113339a1699bfc422efd87c245aa122c1e93015ccab2`
- **Qué hace:** tablas de servido (`meal_serving_records` +
  `meal_serving_record_items`), `serve_meal_assignment`, la devolución y la
  merma de lo servido (`return_serving_to_inventory`, `discard_serving`,
  `undo_discard_serving`), el candado `app.movement_owner_guard` y la vista
  `waste_movements` reescrita.
- **Efecto sobre datos:** aditivo en tablas. `consume_planned_meal` deja de
  escribir el consumo (lo recupera la 0038). Ninguna fila histórica se borra.
- **Dependencias:** 0001→0035 y 0037 aplicadas.

### 0038 — el eje ACTUAL_CONSUMED

- **Archivo:** `supabase/migrations/0038_foodlog_intake.sql`
- **SHA-256:** `b54d3cd9eae17f25e30223284ecb7267956b10ecc9afdcc6152f4f760cc05f26`
- **Qué hace:** `consumption_logs` + `intake_log_items`, los RPC `log_intake`,
  `assume_intake_from_plan`, `log_off_plan_intake`, `log_away_intake`,
  `correct_intake_log` y `void_intake_log`. Historia inmutable: nada se borra,
  se supera o se anula. UNKNOWN != ZERO en cada renglón.
- **Efecto sobre datos:** 100% aditivo.
- **Dependencias:** **la 0036, en la misma ventana.**

#### Tres agujeros MÁS, encontrados corriendo los ataques contra estas migraciones

Los ataques del sprint habían quedado como sondas que imprimían a consola y
afirmaban `expect(true).toBe(true)`: ocho casos que se leían como cobertura y no
verificaban nada. Al convertirlos en afirmaciones aparecieron tres huecos que
seguían abiertos, los tres en la misma costura —el eje ACTUAL no gastaba la
porción física— y los tres cerrados acá antes de aplicar:

- **B1 · comido Y devuelto al refrigerador.** Servir 200 g, declarar que se
  comieron los 200, devolver 200 g: la devolución pasaba, el lote volvía a su
  saldo original y la declaración seguía viva. La misma comida en dos lugares.
- **B2 · comido Y botado.** Lo mismo contra `discard_serving`: el informe de
  desperdicio sumaba una merma que nunca existió.
- **B3 · comer 5.000 g de una porción de 200.** Aceptado sin chistar, y ese
  número entraba al eje ACTUAL y de ahí a la nutrición real de una persona.

La causa era una sola y estaba escrita en el propio comentario de
`void_serving_record`, que sí traía la guarda: contemplaba que la comida no se
hubiera comido, no que **alguien ya hubiera dicho que sí**. La guarda estaba en
una puerta y quedaban dos abiertas. Ahora las tres formas de gastar una porción
—comerla, devolverla, botarla— comen del mismo saldo:
`servido − botado − declarado comido`. La devolución parcial legítima (sirvo
200, declaro 120, vuelven 80) no se toca.

Queda ABIERTO y anotado, porque es decisión de producto y no de migración: dos
actos idénticos fuera de plan el mismo día, sin token de reintento, se colapsan
en uno (dos manzanas a las tres y a las cinco quedan como una). Está afirmado en
`zz-ataque-final.test.ts` para que el día que cambie, el cambio se vea.

#### Los cuatro ALTO que se cerraron antes de aplicar (y su regresión)

Los cuatro salieron del re-ataque final y están cerrados EN estas dos
migraciones, cada uno con su prueba. Las pruebas no solo verifican el arreglo:
reproducen además la resolución vieja y afirman que habría fallado, así que si
alguien revierte el arreglo la prueba se pone roja sola (verificado por
mutación, no por confianza).

- **A1 — la `dedupe_key` se buscaba SIN filtro de hogar y la mandaba el
  cliente.** Ahora la clave la ARMA el servidor (`app.intake_dedupe_key`:
  prefijo + hogar + ancla del acto, y del cliente solo un discriminador
  acotado a 120 caracteres y sin caracteres de control), y se RESUELVE siempre
  dentro de la casa (`app.live_intake_by_key`). El índice único pasó a ser
  `(household_id, dedupe_key)`. Prueba:
  `web/src/integration/sprint12-clave-intake.test.ts`.
- **A2 — re-declarar después de anular no escribía nada y no avisaba.** La
  resolución mira `status = 'ACTIVE'`: un VOIDED o un CORRECTED no es un
  reintento, es alguien corrigiendo, y tiene que escribir fila nueva. El índice
  único es PARCIAL sobre lo vivo para que quepan las dos, y el outbox se
  dedupica por la FILA y no por la clave de reintento. Misma prueba.
- **A3 — la merma de lo servido era invisible para el informe de merma.**
  `waste_movements` deja de leer solo `delta`: si el movimiento trae
  `waste_lot_quantity` la cantidad sale de ahí, y las dos mermas se suman en la
  misma columna sin que el inventario se descuente dos veces. `waste_kind`
  separa SERVING de INVENTORY. El CHECK `movements_waste_lot_qty_shape` impide
  que un escritor futuro vuelva a dejar la merma del plato sin peso. Prueba:
  `web/src/integration/merma-servida.test.ts`.
- **A4 — un ADJUSTMENT podía revertir una merma y devolver a la despensa
  comida que está en la basura.** El bloque (6) del candado ahora exige que lo
  revertido sea un **CONSUMED**, con lista blanca y el porqué de cada razón
  excluida escrito al lado. Prueba: `web/src/integration/sprint12-regresiones.test.ts`.

#### Notas de aplicación

- Validadas en PGlite sobre la cadena completa 0001→0038: **852 tests verdes**,
  `npm run typecheck` y `npm run lint` limpios (2026-08-25).
- Verificación en vivo sugerida, después de aplicar las dos: servir una comida
  y comprobar que el lote se descuenta UNA vez; declarar el consumo y comprobar
  que el lote NO se mueve; anular esa declaración y volver a declararla, y
  comprobar que la segunda queda `ACTIVE` con sus renglones.


El canal ya no es el portapapeles: `node scripts/aplicar-migracion.mjs <archivo.sql>`
manda los bytes del archivo tal cual por la Management API, con guardián de
codificación y checksum. El token vive en `web/.env.local` (ignorado por git) y
el script nunca lo imprime.

### Referencia: las dos del Sprint 11.5

Las dos son ADITIVAS: no borran ni reescriben ninguna fila existente.

### 0031 — el rendimiento crudo→cocido podía llegar hasta 2, y eso es falso

- **Archivo:** `supabase/migrations/0031_yield_factor_bounds.sql`
- **Propósito:** ensanchar de 2 a 5 el tope de `yield_factor` en
  `meal_slot_components` y de `total_yield_factor` en
  `meal_template_versions`.
- **Por qué:** el tope viejo no era una barrera contra datos absurdos, era una
  afirmación falsa sobre la cocina. El arroz rinde 2,5 (100 g crudos → ~250 g
  cocidos); los fideos y las legumbres secas, 2,4. Con el tope en 2 la única
  forma de cargar arroz era mentir (poner 2) o declarar el rendimiento como
  desconocido teniéndolo. El `> 0` sigue firme y NULL sigue significando
  DESCONOCIDO.
- **Dependencias:** 0001→0030 aplicadas.
- **Checksum SHA-256:** `5d96f3a824ed92ef77832286d86cbc8d9334443856287429d9b3de4f24a083e6`
- **¿Destructiva?:** no. Solo ensancha un rango permitido; ninguna fila
  cargada hasta hoy cambia de validez.
- **Notas de aplicación:** verificada contra un PostgreSQL real (PGlite):
  los dos checks pasan de `<= 2` a `<= 5` y el resto del schema queda intacto.
  Sin esta migración, el seed del LOTE A rebota.

### 0032 — faltaba la olla a presión en el catálogo de equipos

- **Archivo:** `supabase/migrations/0032_pressure_cooker_capability.sql`
- **Propósito:** agregar el código `PRESSURE_COOKER` a
  `equipment_capabilities`.
- **Por qué:** los diez códigos de la 0003 no incluían la olla a presión. En la
  cocina chilena es la diferencia entre 60 y 25 minutos en cualquier legumbre
  seca. Sin el código, las recetas de porotos y garbanzos tenían dos salidas y
  las dos malas: mapearla a `POT` (mentir) o borrar el paso (esconderle a quien
  sí la tiene que puede usarla). Entra siempre como capacidad OPCIONAL, con
  alternativa manual obligatoria.
- **Dependencias:** 0031 aplicada.
- **Checksum SHA-256:** `392d23f904c0956a18f077e1ae651f7fe99a8f08fcae31a82115be7b0953575a`
- **¿Destructiva?:** no. Un `insert ... on conflict do nothing`.
- **Notas de aplicación:** un solo pegado, después de 0031.

### Referencia: 0026 — Sprint 11: documentos médicos, biomarcadores y grants

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
sha256sum supabase/migrations/0036_foodlog_plan_vs_reality.sql
sha256sum supabase/migrations/0038_foodlog_intake.sql
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

## Sprint 14 — finanzas del hogar (0042 → 0048)

> **Todavía NO están congeladas.** Los siete archivos se están escribiendo en
> paralelo por varios frentes del mismo sprint, así que su SHA-256 sigue en
> `null` en `supabase/estado-produccion.json` (misma convención que la 0039).
> **Se sellan al cerrar el sprint**, y recién ahí se copian acá los checksums.
> Aplicar una de estas contra Supabase antes de ese sello es aplicar algo que
> puede cambiar.

Orden de aplicación: **estrictamente 0042 → 0048**. No es el orden alfabético
por casualidad: cada una depende de la anterior y la cadena real la fija la
lista `MIGRACIONES` de `web/src/integration/harness.ts`.

| # | Archivo | Qué trae | ¿Destructiva? |
|---|---|---|---|
| 0042 | `0042_finance_foundations.sql` | La escala del dinero (`currency_units`, entero en unidad menor), aritmética exacta de reparto (`app.apportion`, half-even), `inventory_lots.value_minor` + moneda congelada, y **los permisos financieros** (`finance_permission`, `household_finance_grants`, `app.finance_access`) | **No.** Aditiva. Reescribe `split_lot`, `merge_lots` y `create_household`; agrega la FK `invitations_role_fk` — que **falla si hay invitaciones con un `role_code` que no existe en su hogar** (revisar antes) |
| 0043 | `0043_purchases_core.sql` | `purchases`, `purchase_items`, `purchase_charges`, `purchase_item_lots` y el receptor único `app.receive_lot_from_purchase` | **No.** Aditiva. Reapunta `receive_shopping_list`, `receive_procurement_order` y `add_manual_lot` |
| 0044 | `0044_cost_allocations.sql` | `cost_allocations`: el puente entre el ledger y el dinero. Clasificación de merma, invariante de valor, `lot_cost_balance` | **No.** Aditiva |
| 0045 | `0045_receipts_pipeline.sql` | Boletas: subir, extraer, revisar, confirmar. Bucket privado `purchase-receipts` + la policy de SELECT que faltaba en `medical-documents` | **No.** Aditiva |
| 0046 | `0046_price_observations.sql` | Precios como hechos fechados, normalización que se niega a inventar, estimación en la lista de compra | **Estrecha permisos**: parte la policy `for all` de `supplier_products` (0014:71) y la escritura de `price` pasa a RPC con `FINANCE_MANAGE_PRICES` |
| 0047 | `0047_food_budgets.sql` | Presupuesto con vigencia y con **base declarada** (caja / consumo), cortes de período en la zona del hogar, `pantry_value`, `budget_period_summary` | **No.** Aditiva. Agrega `households.week_start_dow` con default 1 |
| 0048 | `0048_finance_integrity.sql` | Informes de integridad, `lot_valuations`, y **el cierre por columna** del dinero de `inventory_lots` | **Estrecha permisos**: `revoke select on public.inventory_lots` + `grant select` por columna. Ver la nota de abajo |

### La nota de la 0048 que no se puede saltar

La 0048 revoca el `select` de tabla sobre `public.inventory_lots` y lo vuelve a
otorgar **columna por columna**, dejando fuera `acquisition_value`,
`value_minor`, `value_status` y `value_unknown_reason`. Consecuencia directa:

> **Toda migración posterior que agregue una columna a `inventory_lots` tiene
> que terminar con `select app.grant_lot_columns();`**

Sin eso, esa columna nueva queda sin permiso y cualquier `select` que la pida
falla con «permission denied for column». Falla ruidoso —que es lo correcto—
pero falla. A la fecha esto afecta a `0058_idempotencia_acciones.sql`, que
agrega `inventory_lots.dedupe_key`.

Después de aplicar la 0048, el valor de un lote se lee **sólo** por
`public.lot_valuations`, que exige `FINANCE_VIEW`. `web/src/app/stock/queries.ts`
ya dejó de pedir `acquisition_value` en el mismo cambio.
