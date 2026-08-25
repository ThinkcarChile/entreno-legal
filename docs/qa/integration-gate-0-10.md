# Integration Gate 0→10 — Informe (§54)

**Fecha:** 2026-08-25 · **Estado del gate:** **INTEGRATION_GATE_0_10 = PASS**
— Final Closure completo, remoto al día (0001→0025), todas las condiciones de
§18 verificadas con evidencia. Detalle en la sección **Final Closure**.

**Pregunta del gate:** ¿puede una familia planificar, comprar, recibir,
preparar, cocinar, consumir y volver a planificar sin que ninguna costura
falsifique datos?

**Respuesta a hoy:** el circuito completo se recorrió EN VIVO contra Supabase
real y las falsificaciones encontradas (10 ALTO verificadas en la app viva, 68
defectos confirmados por la auditoría de 13 lentes) están corregidas en su
núcleo: identidad, base física, ledger y ámbito de hogar. Queda cola de
robustez (concurrencia fina, zonas horarias de metas, UI de etiquetas) que NO
falsifica la física del sistema y está declarada como deuda.

---

## 1. El canario (§50) — PASS en vivo

Sebastián cambia pollo → merluza. Evidencia real (Supabase producción,
2026-08-25):

| Paso | Antes del fix | Después (verificado en vivo) |
|---|---|---|
| Aceptar reemplazo | vivía en un query param; se perdía al recargar | fila en `meal_substitution_choices` (`guardadasEnBase: 1`), URL limpia |
| Confirmar desde la semana | Sebastián quedaba con **pollo 321 g** | Sebastián: **Merluza 360 g**; los otros 4 conservan pollo (255/180/180/180) |
| Trazabilidad | sin rastro de la decisión | `member_serving_substitutions`: from=pollo, to=merluza, `SOFT_PREFERENCE` |
| Gramos fantasmas | 321 g de pollo atribuidos a Sebastián | **0 g** (query agregada sobre las proyecciones del sábado) |
| Aguas abajo | Shopping pedía pollo para él | `/pantry/reorder` muestra **Merluza −1,3 kg · comprar ahora** |

## 2. Verificado EN VIVO contra Supabase real

| Área | Resultado | Evidencia |
|---|---|---|
| Canario §50 completo | **PASS** | tabla anterior |
| RPCs de sustitución rechazan UUID ajenos | **PASS** | `set_substitution_choice` con ids inventados → 400 `no autorizado` |
| Porción servida no se reescribe | **PASS** | RPC rechaza con "esa porción ya se sirvió" (errcode check_violation) |
| 0018/0019/0020/0021 aplicadas y vivas | **PASS** | sondas: tabla conversiones 200 + RLS; `set_cooking_preference` 2 opiniones → 1 fila; guarda `known_pending_in_list` rechaza y revierte entero (0 filas escritas) |
| Demo viva Sprint 10 (prep, etiquetas, QR) | **PASS** | `docs/qa/sprint-10-demo-viva.md`; parió 0016 y 0017 |
| Demo viva Sprint 9 (orden crear/avanzar/recibir) | **PASS** | orden real contra Supabase, lote con su base física |
| Stock Intelligence en vivo (/pantry, /pantry/reorder) | **PASS** | reorder de merluza tras el canario; /pantry carga tras el fix `columnsOf` |

**Bugs que SOLO aparecieron contra el Supabase real** (los tests locales
estructuralmente no podían verlos):

1. `gen_random_bytes` no existe (pgcrypto vive en schema `extensions`) → 0017
   + arnés PGlite ahora corre SIN pgcrypto.
2. `/pantry` caído por columna no pedida (`weight_basis`) → `columnsOf()` +
   test de contrato §35 (hoy con prueba de mutación que confirma que vigila).
3. El canario §50: la sustitución se perdía SOLO en el flujo real de la UI
   (query param); ninguna suite lo cubría porque el RPC funcionaba bien.

## 3. Auditoría de 13 lentes — 68 defectos confirmados

**Totales:** 26 ALTO · 36 MEDIO · 6 BAJO.

**Corregidos: 24 de 26 ALTO, 9 MEDIO, 1 BAJO** — en 5 tandas, cada una con
migración congelada + regresiones que fallan contra el código anterior:

| Tanda | Migración | Qué cierra | Regresiones |
|---|---|---|---|
| 1 — ledger | 0019 (`b4e3025b…`) | `move_lot` temperatura del DESTINO; sobras COOKED alcanzables; `receive_shopping_list` con lock y temperatura de la ubicación; `merge_lots` debita valor, compara `product_id` y `vacuum_sealed`, historia térmica conservadora; trigger anti-borrado de asignaciones servidas; RLS de porciones solo-SELECT; `meal_participants` valida hogar | 12 (`gate-fixes.test.ts`) |
| 2 — canario | 0018 (`f868f5f2…`) | decisión de reemplazo PERSISTIDA (`meal_substitution_choices` + RPCs con ámbito); `confirmMeal` la lee de la base | vivo + suite |
| 3 — ámbito y UNKNOWN | 0020 (`489e7f37…`) | `replace_draft_content` valida los 5 UUID del cliente; `publish` no exfiltra fichas ajenas; base física sobrevive a la compra (AS_PACKAGED/DRAINED); tabla `ingredient_basis_conversions` (factores explícitos o nada); upsert de cocción que ACTUALIZA; `loadEventsForDate` por hogar; `enabled` del día respetado ("ese día no almuerzo"); techo de calorías UNKNOWN = "sin verificar", nunca verde; línea UNRESOLVED dice "por confirmar", no «0 g»; «Sin mover» respetado; estado del modo cocina no se filtra entre pasos | 14 (`gate-tanda3.test.ts`) |
| 4 — motores | 0021 (`9451867c…`) | BatchPrepEngine con base física (cocido→crudo SOLO con rendimiento anotado; sin factor → nota "Sin planificar" visible); `planningCoveredDates` día a día (una comida el sábado ya no apaga el forecast de la semana); reorder conserva la base (DRAINED ya netea con Procurement); índice de sugerencias por `unidad+base`; `create_procurement_order` revalida AMBOS ejes del neteo; botón "Agregado" solo si se escribió | 4+3+5 (`engine.test.ts` B-2/S-1, `gate-tanda4.test.ts`) |
| 5 — identidad producto | 0022 (`b25657ea…`) | `consume_planned_meal` v4: componentes con `product_id` descuentan SU lote (producto contra producto, jamás uno a cuenta de otro), faltante con linaje `product_id`; lotes de producto EXCLUIDOS del análisis de stock ahora se CUENTAN y la pantalla lo dice; guardián §35 ya no se apaga por archivo (probado por mutación) | 2 (`gate-tanda5.test.ts`) |

**ALTO restantes (2) — CERRADOS en el Final Closure** (ver sección al final):

1. **Carrera en `confirm_meal_assignment`** → cerrada por 0023 (candado
   `for update` compartido entre confirm v5 y consume v5 + `for update of l`
   en los FEFO). Regresiones en `gate-concurrency.test.ts`.
2. **`seed_demo_family_profiles` vivía en un seed** → cerrada por 0024 (la
   función es schema real y la app la llama); paridad vigilada por
   `gate-schema-parity.test.ts` (probado por mutación).

## 4. Cola abierta (27 MEDIO + 5 BAJO) — no falsifican la física

Agrupada por tema, en orden de riesgo:

- ~~Concurrencia fina: FOR UPDATE de lotes~~ → cerrado en 0023; quedan los
  guards `known_*` sin serialización total y `setMealParticipants` no atómico
  (demostrado que no falsifican física — POST-SPRINT-11).
- ~~Fechas UTC de nutrition_goals~~ → cerrado (día civil del hogar +
  `gate-fechas.test.ts`).
- **UNKNOWN restantes (J):** capacidad del congelador (unidades mixtas + tope
  total); detalle de alimento mezcla bases en una unidad. ~~forecast sin
  historia rotulado "bien abastecido"~~ → cerrado en el Final Closure.
- **Historia (D):** trigger de inmutabilidad del perfil no cubre
  `computed_inputs`; `setItemStatus` borra el comprador al reprocesar; cascada
  de revisiones sin RLS; factor congelado puede venir de otro hogar (BAJO).
- **UI de etiquetas y formularios (L):** reimprimir bota el id del job; el PDF
  del plan vive en `useState`; el formulario de política no se hidrata;
  "Planificada ✓" queda muerta tras cancelar la orden; hidratación de
  "Agregado" sin filtrar semana.
- **Neteo (E):** `loadPendingListItems` sin cota de semana (listas viejas
  ACTIVE netean para siempre); planes de prep de días anteriores conviven.
- **Otros (B/C/G/M):** PREP_LOSS cierra como CONSUMED; shortfall convertido
  con otra regla; `receive_procurement_order` no deriva temperatura de la
  ubicación; oráculos de existencia en 3 RPC; `saveMealGoals` traga errores;
  sobra manual COOKED con basis RAW (BAJO).

## 5. Deuda aceptada (decisiones, no descuidos)

- **Stock Intelligence y Prep trabajan por alimento**: los lotes con identidad
  de producto quedan FUERA del análisis, pero ahora se cuentan y la pantalla
  lo declara ("N lotes con identidad de producto quedan fuera…"). El ledger
  (consumo) SÍ respeta la identidad de producto desde 0022.
- **`ingredient_basis_conversions` nace vacía**: sin factor anotado no hay
  conversión entre bases y el faltante se declara. Poblarla es trabajo de
  datos (USDA/pesadas de la casa), no de schema.
- **Bucket COOKED en reorder** se convierte a compra RAW solo con el
  rendimiento genérico; sin factor, la acción se rechaza con la razón.
- **Zonas horarias de metas** (F MEDIO) quedan para una tanda de fechas
  dedicada: tocar `nutrition_goals` exige regresiones propias.

## 6. Secciones del gate aún no ejecutadas en vivo

Master-flow §6–§34 parciales (evento con estrategia congelada, fronteras de
zona horaria, revisiones de compra, item manual, reconstrucción del ledger
desde cero, sobras, real vs planificado), §41 manejo de errores, §43/§44
móvil+escritorio, §45 rendimiento, §46/§47 refresh e interrupción de sesión
(la sustitución ya probó supervivencia a la recarga), §48 auditabilidad, §49
linaje completo (el canario cubrió plan→shopping→reorder), §51 marcado de
datos demo.

## 7. Estado frente a las condiciones de §55

| Condición | Estado |
|---|---|
| Canario pollo→merluza extremo a extremo | **PASS en vivo** |
| Prep sin conversión 1:1 (weight_basis) | **CERRADO** (tanda 4, 4 regresiones) |
| Identidad product_id en el ledger | **CERRADO** (0022); stock/prep = deuda declarada y visible |
| EDIBLE_PORTION/AS_PACKAGED descuentan | **CERRADO** (0020: la base sobrevive a la compra) |
| planningCoveredUntil máximo global | **CERRADO** (fechas día a día) |
| addReorderToShoppingList colapsa base | **CERRADO** (0021 + acción) |
| replace_draft_content / publish sin validar | **CERRADO** (0020, con regresiones cross-household) |
| loadEventsForDate sin hogar | **CERRADO** (hogar de la comida, explícito) |
| UNKNOWN como 0 (J) | techo de calorías y línea UNRESOLVED **CERRADOS**; 3 MEDIO en cola |
| UI persistencia (L) | «Sin mover», fuga entre pasos y «Agregado» **CERRADOS**; 5 MEDIO en cola |
| Suite completa | **598 tests / 38 archivos, todo verde** sobre la cadena 0001→0022 |

**Recomendación:** el corazón del sistema (identidad, base física, ledger,
ámbito) quedó íntegro y probado en vivo. Sprint 11 puede abrirse cuando el
director lo decida, con la cola del §4 como backlog priorizado y los 2 ALTO
residuales (concurrencia del confirm + seed del arnés) como primeras tareas.


---

# Final Closure (orden del director, 2026-08-25)

## Tabla de cierre

| Ítem | Estado | Evidencia |
|---|---|---|
| 0022 en remoto | **PASS en vivo** (aplicada 2026-08-25) — prueba §1 por el camino REAL: producto → lista → recepción (lote AS_PACKAGED, ingredient NULL) → comida confirmada → `consume_planned_meal`: el lote del atún bajó 320→160→0, el jurel (otro producto) quedó en 425, el pollo genérico intacto en 4.200, y el faltante de 140 g conserva `product_id` | movimientos `CONSUMED:-160/-160` anclados a log; shortfall con linaje ATÚN |
| Confirm concurrency (ALTO 1) | **PASS en vivo** — 0023 aplicada; doble confirm simultáneo: ambos 200 EN ORDEN (confirm_count 2), UNA proyección, sin duplicados; consume∥confirm simultáneos: estado final único CONSUMED, UN movimiento −140 (jurel 425→285), historia intacta | doble disparo real + 12 tests |
| Paridad schema test/producción (ALTO 2) | **PASS** — `seed_demo_family_profiles` movida a 0024 (la app la llama en `loadDemoFamily`); seed = puntero; `gate-schema-parity` levanta la base SOLO con migraciones y exige todo `.rpc()`/`.from()` (probado por mutación); los seeds ya no pueden definir schema | `0024` (`d591e64b…`) + 3 tests |
| Timezone de nutrition goals | **PASS** — `saveMealGoals` usa el día CIVIL del hogar; probado 23:30 dom / 00:30 lun Santiago Y el salto de hora del 06-sep; contrato: ningún `toISOString().slice(0,10)` decide vigencias | `gate-fechas.test.ts` (4 tests) |
| saveMealGoals no traga errores | **PASS** — las 7 escrituras chequean su error; regla generalizada: `gate-error-contract` recorre TODAS las server actions y exige 0 escrituras con resultado descartado (3 infractores más corregidos de paso) | contrato con 0 ofensas |
| ERROR ≠ VACÍO (§41) | **PASS en vivo** — UUID inválido/inexistente → 404 honesto en 4 rutas; loader/RPC/shape error → boundary propio ("Algo falló de nuestro lado" + digest + Reintentar), probado con `DataShapeError` forzado; `uuidParam` en las 8 páginas dinámicas | texto renderizado en vivo |
| Refresh (§46) | **PASS en vivo** — A sustitución (canario), B comida confirmada, C shopping (item manual + comprado sobreviven F5, contador 1/11), D orden aprobada ("En camino · planificada" tras F5, sugerencia neteada), E tarea de prep | evidencia por caso |
| Interrupción de sesión (§47) | **PASS en vivo** — plan de 17 tareas; completar paso 1 → salir → volver: retoma en PASO 2 DE 17 desde la base; el lote del tomate conserva exactamente SPLIT+TRANSFORM (cero duplicados) | ids en transcript |
| Auditabilidad (§48) | **PASS en vivo** — A: porción con optimizer_version + perfil congelado + códigos de razón; B: línea de merluza con procedencia por comida (incluye los 360 g del sábado de Sebastián); C: orden con motor + pasos necesidad→proveedor→envase→fechas; D: tarea con razones + alternativa manual | 4 consultas sin recalcular |
| Linaje (§49) | **PASS en vivo** — RecipeVersion (`Pollo con arroz… v1`) → porción → RECEIVE-PO +4200 g → lote raíz (SPLIT, saldo 0) → 4 hijos congelados → consumo −8,9 g anclado a log; canario: identidad original (pollo) + decisión (SOFT_PREFERENCE, chosen_by) + identidad final (merluza) coexisten | cadena completa |
| Móvil (§43) | **PASS en vivo** — 320 px: 11 rutas con overflow 0; 430 px spot-check overflow 0 (misma banda de breakpoints) | medición scrollWidth |
| Escritorio (§44) | **PASS con nota** — columna centrada de 416 px en 1280: diseño móvil-primero deliberado, centrado y funcional (no un layout roto); aprovechar el ancho = POST-SPRINT-11 | medición main |
| Performance (§45) | **PASS** — 500 lotes + 90 días de historia + 60 demandas: `analyzeStock` y `planPrep` < 2 s; consultas críticas del ledger con Index Scan (EXPLAIN); sin N+1 dependiente del tamaño de datos (el único fan-out es por integrante, acotado a 5) | `gate-performance.test.ts` |
| Concurrencia crítica (§15) | **PASS** — matriz completa protegida (auditoría adversarial) + doble disparo REAL en vivo del confirm y de consume∥confirm; dedupe obligatorio verificado en vivo (rechaza con su mensaje) | doble disparo real + auditoría + 12 tests |
| UNKNOWN clínicamente relevante (§6) | **PASS** — 5 áreas auditadas (19 confirmados, 4 refutados); los 8 accionables corregidos; regla documentada | `docs/architecture/unknown-nunca-es-normal.md` |
| Tests / lint / typecheck / build | **PASS** — 615+ tests en verde (cadena 0001→0025), `tsc --noEmit` limpio, ESLint 0 errores, `next build` compila | corrida completa |

## Bugs encontrados EN ESTA tanda (Final Closure)

1. **[ALTO]** INSUFFICIENT_DATA en el grupo verde "Bien abastecido" → corregido.
2. **[MEDIO]** "El stock libre cubre el horizonte" afirmado sin datos → corregido.
3. **[MEDIO]** /pantry/reorder y Procurement omitían UNRESOLVED → corregidos.
4. **[MEDIO]** `unverifiable_constraints` no se persistía → corregido (0025 + chip).
5. **[MEDIO]** `create_procurement_order` sin idempotencia con dedupe NULL → corregido (0025).
6. **[MEDIO]** UUID inválido en URL → 500 crudo "Application error" → corregido (`uuidParam` + boundaries).
7. **[BAJO ×4]** delta "+0 g (nuevo)"; "alcanzaría sin comprar" sobre línea unresolved; fit sin aviso de tope no verificable; abastecimiento saltando UNRESOLVED → corregidos.
8. 4 hallazgos de auditoría REFUTADOS con evidencia (3 eran fixes presentes sin commitear; 1 ya cerrado por 0023).
9. `/plan/comida/[id]` → 500 contra el remoto actual: es la columna de 0025 aún no aplicada (se re-verifica tras el pegado).

## Deuda restante reclasificada (§16)

**PRE-SPRINT-11**: *(vacío — lo clasificado acá se cerró en esta tanda)*.

**POST-SPRINT-11** (backlog, no bloquea):
- D: `setItemStatus` borra el comprador al reprocesar; trigger de inmutabilidad sin `computed_inputs`.
- L: reimprimir bota el job id; PDF del plan en `useState`; formulario de política sin hidratar; "Planificada ✓" muerta tras cancelar; hidratación de "Agregado" sin filtrar semana.
- E: `loadPendingListItems` sin cota de semana; planes de prep de días anteriores conviven.
- J: capacidad del congelador (unidades mixtas + tope total); detalle de alimento mezcla bases.
- Concurrencia MEDIO restantes (guards `known_*` sin serialización total, `setMealParticipants` no atómico) — demostrado que NO falsifican cantidad/identidad/valor/historia: acotan a rechazos espurios.
- Escritorio: aprovechar el ancho.

**BEFORE-PRODUCTION**:
- Confirm email ON + rotación de secretos.
- Oráculos de existencia en 3 RPC; actor no estampado en `storage_safety_rules`/`suppliers`/`purchase_policies`.
- PREP_LOSS cierra como CONSUMED; shortfall con regla de conversión propia (antes de reportes de merma reales).
- `receive_procurement_order` sin temperatura de la ubicación.
- Poblar `ingredient_basis_conversions` y rendimientos con datos curados.

## Estado formal

**INTEGRATION_GATE_0_10 = PASS** (declarado 2026-08-25, tras aplicar y
verificar 0022→0025 en el remoto).

Criterio §18 completo con evidencia: 0022 verificada en vivo (§1 producto:
atún 320→160→0 de SU lote, jurel/pollo intactos, shortfall con product_id) ·
doble confirm simultáneo serializado (ambos 200 EN ORDEN, confirm_count 2,
UNA proyección) · consume∥confirm simultáneos con estado final único
(CONSUMED, un solo −140) · `unverifiable_constraints: ["ENERGY_MAX"]`
congelada por el RPC v6 · dedupe NULL rechazado con su mensaje ·
`/plan/comida/[id]` → 200 con la merluza del canario · 615/615 tests + tsc +
lint + build verdes.

*(Nota de historia: una versión intermedia de este informe declaró
`PENDING_REMOTE_APPLY` mientras las migraciones esperaban el pegado; ese
estado quedó superado el mismo día y se corrige aquí sin reescribir la
evidencia que lo rodeaba.)*

**Sprint 11 en curso** (prompt del director recibido 2026-08-25).
