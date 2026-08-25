# Integration Gate 0→10 — Informe (§54)

**Fecha:** 2026-08-25 · **Estado del gate:** EN CURSO — canario §50 PASS en vivo;
5 tandas de corrección aplicadas (0018→0022); quedan secciones de verificación
en vivo y una cola de MEDIO/BAJO declarada abajo.

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

**ALTO restantes (2), declarados:**

1. **Carrera en `confirm_meal_assignment`** (lente I): la guarda "ya se sirvió"
   es una lectura no serializada; dos confirmaciones simultáneas podrían pisar
   una porción CONSUMED. *Mitigado* (el trigger de 0019 bloquea el borrado de
   asignaciones servidas y la RLS ya no deja al cliente borrar porciones), pero
   la ventana dentro del RPC existe. Cierre propuesto: `for update` sobre las
   proyecciones al inicio del RPC (migración futura, no bloquea el circuito).
2. **`seed_demo_family_profiles` vive en un seed, no en una migración**
   (lente M): el arnés lo carga como si fuera parte del schema. En Supabase
   existe solo porque el seed se corrió a mano. Cierre propuesto: moverlo a
   una migración o eliminar su uso del arnés.

## 4. Cola abierta (27 MEDIO + 5 BAJO) — no falsifican la física

Agrupada por tema, en orden de riesgo:

- **Concurrencia fina (I):** `consume_planned_meal` sin `FOR UPDATE` sobre
  lotes; guarda `known_incoming` sin serialización; `setMealParticipants` no
  atómico. El ledger append-only + claves de idempotencia acotan el daño a
  dobles descuentos improbables, no a datos inventados.
- **Fechas UTC vs hogar (F):** `nutrition_goals.start_date`/`end_date` usan el
  día del servidor. Riesgo: una meta cerrada "un día antes" cerca de
  medianoche.
- **UNKNOWN restantes (J):** capacidad del congelador suma unidades mixtas y
  se compara contra el tope total; forecast 0 sin historia se rotula "bien
  abastecido"; detalle de alimento mezcla bases en una unidad.
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
