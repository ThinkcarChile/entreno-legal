# Sprint 10 — Entrega: Batch prep, conservación y etiquetas

**Fecha:** 2026-08-25
**Verificación:** 518 pruebas verdes (35 dominio prep + 18 seguridad + 7 PDF + 32 integración + 6 demo §90 sobre PostgreSQL real vía PGlite, rol authenticated + las previas), lint/typecheck/build limpios, cadena 0001→0015 validada completa. QA §92 en [qa/sprint-10-report.md](./qa/sprint-10-report.md) (12 lentes revisados a mano tras la caída del workflow por límite de uso: 11 hallazgos → 8 corregidos + 3 documentados). Decisiones en [ADR 0011](./adr/0011-batch-prep.md).
**Estado: `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION`** (§96 — techo permitido; NO CLOSED). 0013 y 0014 YA están aplicadas en el Supabase remoto (verificadas por API el 2026-08-25); **0015 congelada y pendiente de aplicar** (checksum en el [manifiesto](./deployment/pending-supabase-migrations.md)) junto con el bloque de reglas USDA del seed. La demo viva (§91) y la revisión móvil quedan para después de aplicarla.

---

## 1. El gate (§96), punto por punto

| Exigencia | Cómo se cumple |
|---|---|
| BatchPrepEngine determinista | `batch-prep/1.0.0` puro, sin reloj, test byte a byte; complejidad §55 sin IA |
| Ledger conserva cantidad/valor | Reutiliza `split_lot`/`move_lot` del Sprint 7 (§3: cero inventarios paralelos); §69/§70 con $17.003 exactos y grupo Σ=0; merge con desconocido-domina |
| Prep real ≠ plan | §71: plan 1.200 / real 980 → ledger 980, resto intacto; paquetes editables al gramo; merma con cuadratura entrada = utilizable + causa (§44) |
| No sobrepreparar | Con corte declarado: solo lo demandado, resto ENTERO con razón (tomate 700/1.300 §2); sin demanda, cero tareas (§8) |
| RAW/PREPPED/COOKED ⊥ CHILLED/FROZEN | Jamás estados combinados; congelar no "prepara", cortar no enfría; `frozen_at`+`thawed_at` completan la historia térmica (§24) |
| SafetyEngine no inventa | `storage-safety/1.0.0` SOLO lee reglas con fuente (USDA sembradas, mínimas); sin regla → SAFETY_REVIEW_REQUIRED (§21); tomate sin regla lo DICE |
| Vacuum ≠ shelf stable | Empaque puro: no toca temperatura ni `use_by`; sin regla específica no gana ni un día (§22/§74) |
| Thaw/refreeze sin simplificar | Ledger no prohíbe recongelar; el veredicto exige saber CÓMO se descongeló + regla (§25); descongelado programado solo con regla THAW (§29) |
| Labels PDF | PDF real (pdf-lib), mm→pt exactos, día de uso GRANDE, snapshot congelado (§40), reimprimir = nuevo job (§39) |
| QR sin datos sensibles | Token opaco 128 bits; `/q/{token}` exige sesión+hogar; ajeno = inexistente; snapshot sin clínica/identidad/hogar (§77-78) |
| Split/merge transaccionales | RPCs con `for update`, grupo Σ=0 diferido del Sprint 7, merge validado (§43) |
| Concurrencia sin duplicar | Tarea PENDING→DONE una vez: la segunda confirmación devuelve el resultado registrado, jamás doble split (§82) |
| RLS | 9 tablas nuevas con policies; escritura de planes/tareas/etiquetas solo vía RPC; pruebas adversariales hogar B (§63-64) |
| Mobile | Modo cocina §16/§58: un paso por vez, botones/tipografía grandes; revisión 320/375/430 en vivo pendiente del checklist §28 |
| Tests verdes | 518 (lint/typecheck/build incluidos en los checks §95) |

## 2. Piezas

- **Migración `0015_batch_prep.sql`** (congelada, pendiente en remoto): equipamiento del hogar + configuraciones (cuchillas de la cortadora real como filas con params — 6/9/12/16 mm DICE, 2,5/4 SHRED…, jamás enum global §11), `prep_preferences` por alimento con alternativa manual obligatoria de facto (§12), `storage_safety_rules` con fuente obligatoria, `household_observed_yields` append-only (§45: observación, jamás sobrescritura de `ingredient_yields`), `batch_prep_plans`/`tasks` estructurados (§6), plantillas y print jobs de etiquetas con snapshot (§31-40), QR token opaco (§35), `merge_lots`, `complete_prep_task` (única puerta al ledger), `use_lot`, `set_lot_safety`/`set_intended_use` (intended ≠ safe §26), v2 de `split_lot`/`move_lot`/`add_manual_lot` (frozen_at; temperatura desde la ubicación).
- **Motores**: `storage-safety/1.0.0` y `batch-prep/1.0.0` — deterministas, versionados, sin IA en el número.
- **PDF**: `lib/labels/pdf.ts` (pdf-lib + qrcode); ruta `/api/labels?jobs=…` todo-o-nada.
- **UI**: `/prep` (resumen §15 con bloques Lavar/Cortar/Porcionar/Guardar/Etiquetar, dejar-sin-preparar y sugerencias de descongelado), `/prep/[planId]` modo cocina (§16: PASO X DE N, LISTO gigante, cantidad real editable, ubicación concreta por paquete §19), `/prep/equipment` (equipos + cuchillas + preferencias), `/q/[token]` (§36: usado/parcial/mover/peso/merma/reimprimir), atajos "¿Qué quieres hacer?" en el home (§57).
- **Outbox**: reutiliza `domain_events` del Sprint 1 (§61) — LOT_SPLIT/LOT_PREPPED/LOT_FROZEN/LOT_THAWED/LOT_MOVED/LABEL_GENERATED/SAFETY_ASSESSED con dedupe.

## 3. Demo §90 (LOCAL, PGlite — no simulada como remota)

Ejecutada como test de integración (`prep-demo.test.ts`) con el motor REAL sobre filas reales: compra de pollo 4.200 g ($17.003) + zanahoria 2 kg + tomate 1,5 kg; plan semanal confirmado martes/viernes/domingo. Verificado A-J: **A** pollo en paquetes 1.100/1.300/900 + 900 de reserva por comida; **B** martes refrigerado (regla USDA 2 días) y el resto congelado; **C** zanahoria rallada 4 mm con la cortadora declarada (alternativa: rallador manual); **D** tomate 700 g preparados / 800 g enteros con razón; **E** PDF real de 4 etiquetas con QR; **F** QR resuelto y "usé 400 g" descontado; **G** tareas completadas → plan COMPLETED; **H** Σ hijos = 4.200 g y $17.003 exactos; **I/J** borrada la comida del viernes, el paquete FÍSICO persiste como "sin asignar" y se reasigna al domingo sin tocar su fecha de seguridad. **La demo §91 contra Supabase real queda BLOQUEADA hasta aplicar 0015** (en el checklist del manifiesto).

## 4. Deuda declarada

- `use_by` evaluado no se auto-borra al transformar (limitación en ADR 0011; la UI recalcula en vivo).
- Paquetes sugeridos no pre-cargan la cantidad vigente del lote si cambió tras generar (el error del split es honesto; mejora anotada).
- Recordatorios activos (§30): eventos ya en el outbox; notificaciones en sprint posterior. Impresión térmica directa: PrinterAdapter futuro (§67).
- `PrepComplexity` explica, no optimiza (§56 v1 heurística documentada).

## 5. Fuera de alcance respetado (§93)

Sin Health/Labs, reglas clínicas, AdaptiveNutrition, calculadora BBQ, OCR, finanzas, drivers térmicos, forecast IA ni compra automática.
