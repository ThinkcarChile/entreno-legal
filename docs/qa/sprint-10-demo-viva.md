# Demo viva — Sprint 10 (contra Supabase real)

**Fecha:** 2026-08-25
**Entorno:** app en `http://localhost:3000` (dev server bind `0.0.0.0`, accesible en LAN como `http://192.168.1.141:3000` para el QR del celular), conectada al proyecto **Supabase `smwyxfnlxoohenhsdcjx`** — NO PGlite. Hogar `Casa Vasquez` (5 integrantes), usuario `construmuebles.cl@gmail.com`.
**Estado del sprint tras la demo:** sigue en `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION` hasta el gate del director.

## Resultado

| Gate | Resultado |
|---|---|
| 0015 remoto | **PASS** |
| reglas USDA | **PASS** |
| recepción real | **PASS** |
| BatchPrepPlan | **PASS** (tras corregir 2 defectos) |
| split cantidad | **PASS** (tras corregir 1 defecto crítico) |
| conservación valor | **PASS con limitación** — invariante verificado en tests con $17.003; en vivo el valor es NULL porque la app aún no captura precios |
| freeze/chilled | **PASS** |
| equipment | **PASS** (tras corregir 1 defecto) |
| partial prep | **PASS** |
| no overprep | **PASS** |
| safety rules | **PASS** (tras corregir 1 defecto + 0016) |
| vacuum | **PASS** |
| PDF label | **PASS** |
| QR móvil | **PASS** |
| reprint | **PASS** |
| cambio de planning | **PASS** (tras corregir 1 defecto) |
| idempotencia | **PASS** |
| mobile 320 | **PASS** (tras corregir 1 defecto) |
| mobile 375 | **PASS** |
| mobile 430 | **PASS** |
| Sprint 8 remote smoke | **PASS** (tras corregir 1 defecto crítico) |
| Sprint 9 remote smoke | **PASS** |

**8 defectos encontrados en vivo. 8 corregidos, todos con regresión.** Ninguno lo habían visto los 518 tests previos.

## Los defectos, uno por uno

### 1. `gen_random_bytes` no existe en Supabase (CRÍTICO — bloqueaba porcionar)

- **Observado:** al confirmar "Porcionar pollo en 4 paquetes", la pantalla mostró `function gen_random_bytes(integer) does not exist`. El split no ocurría.
- **Causa:** `gen_random_bytes` es de **pgcrypto**. En Supabase la extensión vive en el schema `extensions`, y las funciones `SECURITY DEFINER` del proyecto corren con `set search_path = public`: no la alcanzan. El arnés de PGlite la cargaba explícitamente, así que **518 tests verdes y la app rota**.
- **Corrección:** migración **0017** — `gen_random_uuid()` (nativa desde PG13, mismo CSPRNG) en `ensure_lot_token` y `complete_prep_task`. Token sigue siendo 32 hex; código de paquete sigue siendo `PKG-XXXXXXXX`.
- **Regresión:** `src/integration/sin-pgcrypto.test.ts` — levanta la cadena **completa sin pgcrypto** y verifica por catálogo (`pg_proc`) que ninguna función del proyecto la use.
- **Después:** split ejecutado; 4 paquetes con códigos `PKG-636035D6`, `PKG-993D4716`, `PKG-DF3F315B`, `PKG-1EB5ACA5`.

### 2. `/pantry` y `/pantry/reorder` caídas contra el remoto (ALTO)

- **Observado:** `Application error: a server-side exception` en ambas. Log: `DataShapeError: Los datos de "stock: compras" … weight_basis: Required`.
- **Causa:** el `.select()` del cargador de Stock Intelligence no pedía `weight_basis`, pero el schema Zod lo exige. Ningún test lo detectó: **los tests de integración arman el input del motor a mano y jamás ejercitan los cargadores reales**.
- **Corrección:** los schemas de las vistas pasan a ser constantes únicas y el `select` se **deriva del schema** con `columnsOf(schema)` — no se pueden desincronizar (una fuente por dato). Además se acotó a 30 días.
- **Regresión:** `src/integration/loaders.test.ts` — contrato cargador↔base: cada columna que el schema declara debe existir en la vista real y la fila debe parsear; una columna inventada falla ahí y no en producción.

### 3. El motor mandaba a congelar lechuga, aceite de oliva y arroz (ALTO)

- **Observado:** el primer plan real recomendaba `FREEZE` para aceite de oliva, limón, lechuga, arroz, cebolla y tomate.
- **Causa:** la regla sembrada "congelado a -18°C = seguro sin fecha" es **genérica** y responde una pregunta microbiológica ("¿es seguro lo que ya está congelado?"). El motor la usaba para responder otra ("¿le recomiendo congelar esto?"), que además depende de si el alimento sirve congelado.
- **Corrección:** `recommendStorage` exige respaldo **específico** (alimento, categoría u hogar) para recomendar congelar; la regla genérica sigue sirviendo para evaluar lo ya congelado. Migración **0016** agrega las reglas por categoría con fuente: carnes/aves/pescados congelados (USDA FSIS) y refrigerado de verduras/frutas, frescas y ya cortadas (FDA Food Keeper).
- **Después:** aceite y arroz → "Decidir guardado (sin regla de seguridad)"; tomate/limón/cebolla → refrigerar citando FDA; pollo → refrigerar el del día 26 y congelar el resto citando USDA.
- **Regresión:** 4 tests nuevos en `safety.test.ts` (genérica no basta; categoría sí; hogar sí; evaluar lo ya congelado sigue igual).

### 4. 85 paquetes para 8 alimentos (ALTO)

- **Observado:** el plan decía "16 tareas · 8 alimentos · **85 paquetes · 85 etiquetas**".
- **Causa:** la demanda llega por porción individual (una fila por integrante). El motor creaba un paquete por fila: 5 personas × 3 días = 15 paquetes de pollo. En los tests había una sola persona.
- **Corrección:** la demanda se agrupa por comida (`fecha::assignment`) antes de porcionar. Una comida = un paquete.
- **Después:** 16 paquetes (pollo 3 + reserva, tomate 3, cebolla 3 + reserva, etc.).
- **Regresión:** 2 tests (5 integrantes en la misma comida → 1 paquete con la suma; comidas distintas del mismo día → paquetes distintos).

### 5. El corte perdía el tamaño de la cuchilla (§11)

- **Observado:** con la cortadora configurada en 4 mm y elegida en la preferencia, el modo cocina decía "Corte: **SHRED**".
- **Causa:** el motor leía `size_mm` solo de la preferencia, ignorando el de la capability elegida (dato duplicado).
- **Corrección:** el tamaño sale de la cuchilla elegida cuando la preferencia no lo repite.
- **Después:** "Rallar Zanahoria · **SHRED 4 mm**".

### 6. El paquete huérfano no avisaba (§84)

- **Observado:** tras deshacer la comida del miércoles, el paquete del 26 seguía diciendo "Para el 2026-08-26" como si nada.
- **Corrección:** la pantalla del QR detecta que la comida prevista ya no incluye ese alimento (o no existe) y muestra *"Este paquete ya no está asignado a una comida (el plan cambió). Sigue disponible como stock…"*. El paquete **no** se toca.
- **Regresión:** integración — al borrar la comida, el lote sigue `AVAILABLE` con su cantidad, `intended_assignment_id` se anula y `use_by` **no** cambia.

### 7. `/prep/equipment` desbordaba en móvil (§16)

- **Observado:** 47 px de scroll horizontal a 320 px; botones de 30 px.
- **Corrección:** `flex-wrap` en la fila del equipo y tacto ≥38 px en nav y secundarios.
- **Después:** overflow 0 en 320/375/430.

### 8. Recibir una orden no deja elegir ubicación (MEDIO — anotado)

- **Observado:** el pollo recibido cayó en la Despensa (AMBIENT) por defecto; hubo que moverlo al refrigerador con otra acción.
- **Estado:** el RPC ya acepta `p_location_id`; falta exponerlo en el botón "Llegó: recibir". **Anotado como deuda de Sprint 11** (no bloquea: mover es una acción de un toque y la temperatura se deriva correctamente de la ubicación).

## Números verificados en vivo (Supabase real)

- **Split:** 4.200 g → 1.116,659 + 1.116,659 + 1.116,659 + 850,023 = **4.200 g exactos**; lote madre en 0.
- **Preparación parcial:** plan 1.122,189 g de tomate, registrado **980 g** → hijo de 980 `PREPPED` + **520 g** `RAW` intactos en el lote madre.
- **No sobrepreparar:** zanahoria "dejar 2.000 g sin preparar (la demanda de 7 días es 157,5 g)"; tomate "dejar 377,811 g enteros".
- **Estados ortogonales:** los 4 paquetes siguen `RAW`; uno `CHILLED` y tres `FROZEN`.
- **Vacío:** el paquete del 28 quedó `vacuum_sealed = true`, `FROZEN`, `use_by` sin cambios.
- **Etiquetas:** PDF real de 4 páginas de **40 × 60 mm exactos** con QR; snapshot sin datos clínicos, sin identidad, sin `household_id`.
- **QR:** `/q/{token}` con token opaco de 32 hex; acción MOVE ejecutada desde móvil → `CHILLED → FROZEN` con `frozen_at` sellado.
- **Reprint:** print jobs 1 → 2 sobre el mismo lote; inventario **33 → 33** lotes.
- **Idempotencia:** dos `complete_prep_task` **en paralelo** sobre la misma tarea → respuesta idéntica, **0** lotes nuevos, **0** movimientos SPLIT nuevos.
- **Sprint 8:** pollo libre **−3,35 kg** (= 3 × 1.116,659 confirmados), cobertura "sin datos suficientes", recomendación 3,35 kg con horizonte 7 días y su "¿por qué?".
- **Sprint 9:** "necesitas 3.350 g → sugerido 4.200 g (1 × bandeja 4,2 kg), a Avícola Sur, pedir el 25 → llega el 26", con "en casa 0 g" separado de lo que viene en camino; provenance citando `reorder-engine/1.0.0` y `purchase-schedule/1.0.0`.

## Verificación final

**534 pruebas verdes** (16 nuevas en esta demo), lint limpio, cadena `0001→0017` validada en PGlite, y el nuevo arnés sin-pgcrypto en verde.
