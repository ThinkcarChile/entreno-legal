# Sprint 11 — QA (§100/§104/§105)

**Fecha:** 2026-08-25 · **Estado:** `SPRINT_11_COMPLETE_PENDING_DIRECTOR_REVIEW` — remoto al día (0001→0028), demo viva ejecutada.

## 1. Cómo se hizo la revisión adversarial (§100) — nota honesta

El workflow de 15 lentes se lanzó y **murió completo**: los 15 agentes
fallaron con `You've hit your monthly spend limit`. Es el mismo bloqueo que
tumbó el QA del Sprint 10 (§92). La revisión se hizo entonces **a mano**, con
lectura dirigida del código (Grep/Read) lente por lente.

Consecuencia declarada: esta revisión tiene **menos amplitud** que las
automatizadas de sprints anteriores (68 hallazgos en el gate 0→10 con 13
lentes paralelas). Lo que sigue es lo que una revisión manual alcanzó a
cubrir; **no** equivale a las 15 lentes completas del §100. Queda como deuda
explícita re-correr el workflow cuando haya presupuesto.

## 2. Hallazgos confirmados y corregidos

| # | Lente | Sev | Defecto | Corrección |
|---|---|---|---|---|
| A-1 | A · clinical false-safe | **ALTO** | `assessMeal` comparaba `recipe_nutrition` (TOTAL de la receta para `base_servings` personas) contra restricciones que son **por porción**. En un máximo invalidaba comidas seguras; en un **mínimo declaraba cumplido** lo que la porción individual no alcanza — falso-seguro clínico. | La evaluación usa, en orden: (1) la porción CONFIRMADA de esa persona en esa comida; (2) total ÷ porciones base, declarado como estimación. `quantitiesByIngredient` también se divide; sin porciones base conocidas NO se manda nada y el motor pide revisión. La fuente queda persistida en `nutrition_source` (§96). |
| M-1 | M · concurrencia | MEDIO | `create_clinical_rule_version` calculaba `max(version)+1` sin lock: dos creaciones simultáneas obtenían el mismo número y la segunda moría con error crudo de índice único. | `for update` sobre `clinical_rule_sets` + `on conflict do nothing` con relectura. La numeración se serializa. |
| O-1 | O · error vs vacío | MEDIO | Confirmar un candidato sin valor reventaba con un `NOT NULL` crudo de Postgres. | Validación explícita antes del insert: "la fila «X» no tiene valor: edítala o descártala". |
| B-1 | B · UNKNOWN | MEDIO | `esDudosa` en la tabla de revisión usaba `(fila.confidence ?? 0) < 0.7`: confianza DESCONOCIDA se trataba como 0 (funcionaba, pero por accidente y con el patrón prohibido). | Comparación explícita: `confidence === null` es dudosa por derecho propio. Lo cazó el guardián `salud-privacidad.test.ts`. |
| B-2 | B · UNKNOWN | BAJO | Mensaje `${valor ?? 0}` en la razón de mínimo incumplido: mostraba "0" cuando el valor era desconocido. | Ahora dice "sin dato". Cazado por el mismo guardián. |
| E-1 | — (demo viva) | MEDIO | **Defecto de entrega, no de código**: entregué 0026/0027 con `clip` de Windows, que reescribe el UTF-8 en la página de códigos del sistema. En el remoto quedaron 5 nombres de biomarcador y los mensajes de 22 funciones con acentos mutilados ("Fósforo"). Datos clínicos intactos; texto ilegible — inaceptable en un módulo de salud. | Migración **0028** (idempotente): corrige los nombres por código y reemite las 22 funciones con texto sano. Entrega ahora con `Set-Clipboard` UTF-8 **verificada antes de avisar**. Regla guardada en memoria. |

## 3. Lentes revisadas a mano — resultado

| Lente | Resultado |
|---|---|
| A · clinical false-safe | **1 ALTO corregido** (A-1). Resto: el motor sube nivel en cada rama y ninguna deja COMPATIBLE sin fundamento (25 tests). |
| B · UNKNOWN | 2 corregidos. Guardián automático prohíbe `?? 0` / `\|\| 0` en `domain/clinical` y `app/health`. |
| C · procedencia | Sin hallazgos: rango impreso, snippet y documento viajan con la observación; correcciones encadenan (`corrected_from`); los assessments citan ids, no copias. |
| D · versionado | Sin hallazgos de integridad: trigger de inmutabilidad (doble capa RLS+trigger, probado en ambas), publicar v2 retira v1 sin tocar su lógica. |
| E · privacidad intra-hogar | Sin hallazgos: 6 tests cubren self / grant / revocación / tutor / ADMIN-sin-acceso. |
| F · RLS cross-household | Sin hallazgos: vecina no ve documentos, observaciones ni puede invocar RPCs. |
| G · frontera IA/reglas | Sin hallazgos: solo 2 caminos escriben `lab_observations` y ambos exigen `CONFIRM_LABS`; el consentimiento se valida en el SERVIDOR. |
| H · unidades/fechas | Sin hallazgos: unidad ausente → NULL en toda la cadena; el parser solo acepta `YYYY-MM-DD`; DATE-only civil. |
| I · inmutabilidad histórica | Sin hallazgos: SERVED/CONSUMED rebotan; resolver un impacto no toca lotes ni movimientos (probado por conteo antes/después). |
| J · impacto en planificación | 1 hallazgo (A-1, mismo origen). Flujo confirmar→impacto→resolver es idempotente. |
| K · compras/privacidad | Sin hallazgos: ninguna superficie de compras importa del dominio clínico (guardián). |
| L · cocina/etiqueta/QR | Sin hallazgos: `clinical_status` es lo único visible sin grant; guardián estructural sobre 7 directorios. |
| M · concurrencia | **1 MEDIO corregido** (M-1). Doble confirmación de extracción probada. |
| N · remoto vs test | Sin hallazgos verificables localmente: el bloque `storage` es condicional (PGlite lo salta, Supabase lo aplica). **Riesgo residual**: la política de storage solo se puede probar contra Supabase real — va en la demo viva. |
| O · error vs vacío | **1 MEDIO corregido** (O-1). |

## 4. Checks obligatorios (§104)

| Check | Estado |
|---|---|
| lint | ✅ `next lint` sin warnings ni errores |
| typecheck | ✅ `tsc --noEmit` limpio |
| domain tests | ✅ 25 motor clínico + 5 techos en optimizador |
| integration | ✅ 21 tests de salud + suite completa **672/672 en 45 archivos** |
| SQL/RLS | ✅ cross-household + intra-household con rol `authenticated` real |
| contract tests | ✅ `columnsOf`/§35 y guardas nuevas de privacidad y UNKNOWN |
| build | ✅ `next build` compila |

## 5. Migraciones congeladas (§103)

| Migración | SHA-256 |
|---|---|
| `0026_health_documents.sql` | `bcaeba23f2988dc4ce6adad0ca1edde06a9863a05cbc948f7381d36b6666432a` |
| `0027_clinical_rules.sql` | `31e7d6a4ef48cb3817a0b326aa0a8fe54f7fc792cf5d5748cf001b16039d02ca` |
| `0028_fix_encoding.sql` | `8d9b868f9138818e9dc0234ac503444b1db22997c8542ae4e484af11cb3de5d1` |

0001→0025 intactas. Toda corrección posterior va en 0029.

## 6. Estado frente al gate §105

| Condición | Estado |
|---|---|
| AI extraction no activa reglas sin confirmación | ✅ estructural (dos tablas, dos permisos) |
| unidades desconocidas no se inventan | ✅ NULL en toda la cadena, probado |
| ClinicalRulesEngine determinista | ✅ puro, sin reloj (guardián), test byte-a-byte |
| reglas con fuente/versión | ✅ obligatorias; versiones inmutables |
| UNKNOWN nunca se presenta como seguro | ✅ motor + guardián estático |
| medical restrictions ganan sobre preferences/sports | ✅ techos capan objetivos; test §74 |
| nueva información genera impacto, no reescritura | ✅ impact reviews idempotentes |
| servings consumidas son historia | ✅ rebote probado |
| compra/inventario no se altera automáticamente | ✅ conteo antes/después |
| intra-household privacy | ✅ 6 tests |
| cross-household RLS | ✅ probado |
| cook/shopping/label/QR sin filtración | ✅ guardián estructural |
| auditabilidad | ✅ `audit_events` en upload/confirm/corrección/grants/impacto |
| mobile | ✅ 320 px sin overflow en las pantallas nuevas |
| remote demo | ✅ ejecutada (ver §7) |
| tests/lint/typecheck/build | ✅ completos |

**Conclusión:** el sprint cumple §105.

## 7. Demo viva §101 — ejecutada contra Supabase real (0026→0028 aplicadas)

Datos 100% sintéticos: integrante "Demo Sintético", regla "demo-fosforo"
declarada como NO clínica, recetas "DEMO A/B/C (sintética)".

| Paso | Resultado |
|---|---|
| 1-2 Member Demo + examen sintético | ✅ documento creado, estado UPLOADED |
| §4 sin consentimiento | ✅ el RPC del SERVIDOR rechaza: "Sin consentimiento para extracción por IA…" |
| 3 extracción con consentimiento | ✅ 2 candidatos; doc → `NEEDS_REVIEW` porque uno viene **sin unidad** |
| §7 unidad faltante | ✅ guardada como `NULL`, jamás "mmol/L" |
| §68 antes de confirmar | ✅ **0 observaciones**: el motor no ve nada |
| 4 revisión humana en la UI | ✅ `/health/exams/[id]/review` muestra las dos filas, marca "revisar: sin unidad", confianza 90%/60% y el texto original |
| 5 confirmar + editar unidad | ✅ `{confirmed: 2}`, doc → `CONFIRMED`, rango del laboratorio (3.5) conservado en la observación |
| 5b regla demo v1 + restricción | ✅ publicada y confirmada con fuente `USER_CONFIRMED_LIMIT` |
| **6 Receta A (400, COMPLETE)** | ✅ **COMPATIBLE** — razón: "Dentro del máximo confirmado (400 ≤ 500 mg)" |
| **7 Receta B (650, COMPLETE)** | ✅ **CLINICALLY_INVALIDATED** — "excede el máximo confirmado de 500 mg" |
| **8 Receta C (UNKNOWN)** | ✅ **REVIEW_REQUIRED** — "No contamos con información completa de phosphorus_mg" |
| §96 explicabilidad | ✅ cada evaluación cita motor, restricción, versión de regla, qué faltó y el techo para el optimizador |
| 9 impact review | ✅ creado e **idempotente** (dos llamadas → el mismo id) |
| 12 inventario NO cambia | ✅ lotes 35→35, movimientos 102→102 tras resolver APPLIED |
| 17 publicar v2 | ✅ v1 → RETIRED con su lógica **intacta** (max=500), v2 PUBLISHED (max=450) |
| 18 historia conserva v1 | ✅ la evaluación histórica sigue citando `ruleVersionId` de v1 |
| inmutabilidad | ✅ PATCH directo a la v1 publicada → 400 |

**No ejecutados en vivo** (declarado, no disimulado): pasos 10-11 (cambio
propuesto de serving y shopping impact) y 14-16 (grant/revocación con dos
usuarios reales del mismo hogar) — el hogar demo tiene un solo usuario con
cuenta, así que esos caminos están cubiertos por los 21 tests de integración
con dos usuarios `authenticated` reales, no por la demo. Paso 13 (cook view)
verificado por estructura: no hay servings con estado clínico en el hogar demo
todavía.
