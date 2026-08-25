# ADR 0011 — Batch prep: sugerir arriba, transformar solo al confirmar

**Estado:** PROPUESTO (Sprint 10, `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION`)
**Fecha:** 2026-08-24

## Contexto

Con la compra recibida (Sprint 7/9) y la demanda confirmada (Sprint 5/8), falta
el paso físico: lavar, cortar, porcionar, guardar, etiquetar. El director fija
fronteras: no preparar porque sí; el ledger sigue siendo la ÚNICA fuente
física; la seguridad alimentaria jamás se inventa; el plan es una sugerencia y
la realidad de la persona manda.

## Decisiones

1. **El plan es sugerencia; el ledger, verdad** (§17). `batch_prep_plans` +
   `batch_prep_tasks` son estructura (jamás texto generado); guardarlos no toca
   lotes. `complete_prep_task` es la ÚNICA puerta del prep al ledger, y por
   dentro REUTILIZA `split_lot`/`move_lot` del Sprint 7 — cero inventarios
   paralelos (§3). Idempotente por estado de la tarea (`for update`,
   PENDING→DONE una sola vez): dos personas confirmando lo mismo = UNA
   transformación (§60).

2. **La cantidad REAL manda** (§18): `p_actual_quantity` y los paquetes
   digitados pisan lo planificado; el resto queda físicamente donde estaba
   (split parcial deja el remanente en el lote madre, RAW). La merma exige
   cuadratura explícita `entrada = utilizable + merma` con causa
   (PEEL/TRIM/PREP_LOSS → movimiento `PREP_LOSS`, §44).

3. **Dos flujos con políticas distintas** — los dos ejemplos del director:
   con CORTE declarado (tomate/zanahoria), cortar degrada → preparar SOLO lo
   demandado y dejar el resto ENTERO con razón (§2/§9); sin corte (pollo),
   porcionar es empaque → el lote abierto se porciona completo en usos
   confirmados + reserva (§8/§42). La distinción es DATO (prep_preferences),
   no heurística.

4. **Cortes solo declarados** (§11-§12): `prep_preferences` por alimento
   ("zanahoria: SHRED 4 mm") apuntando opcionalmente a una configuración del
   equipo del hogar (`household_equipment` + `household_equipment_configs`,
   cuchillas como FILAS con params — jamás enum global; el catálogo
   `equipment_capabilities` del Sprint 2 sigue siendo el registro de códigos
   para recetas, concepto distinto). La alternativa manual SIEMPRE viaja con
   la tarea; equipo desactivado → manual, jamás bloqueo (§86).

5. **FoodStorageSafetyEngine (`storage-safety/1.0.0`)**: la única fuente son
   `storage_safety_rules` con FUENTE obligatoria (sembradas: USDA FSIS,
   mínimas a propósito). Sin regla → `SAFETY_REVIEW_REQUIRED`; `max_days null`
   = "seguro sin fecha" EXPLÍCITO (congelado), distinto de sin-regla (§21).
   El vacío es empaque: solo refina el matching, jamás regala días (§22/§74).
   Refrigerar vs congelar solo con respaldo (§23); recongelar solo si se sabe
   CÓMO se descongeló y hay regla (§24-§25); descongelado programado solo con
   regla THAW — sin regla, "revisar", sin horas inventadas (§29).
   `set_lot_safety` exige citar la regla para escribir `use_by`.

6. **intended ≠ safe** (§26-§28): `intended_use_date`/`intended_assignment_id`
   son planificación (reasignables; si la comida se borra, el vínculo se anula
   y el paquete FÍSICO persiste como "sin asignar", §84); `use_by` es
   seguridad evaluada. Cambiar una jamás toca la otra.

7. **Historia térmica completa** (K-18 + §24): `frozen_at` se suma a
   `thawed_at`; `move_lot`/`add_manual_lot` derivan la temperatura de la
   UBICACIÓN (hallazgo del QA interno: un lote creado en el congelador nacía
   AMBIENT). El ledger no prohíbe recongelar — esa política es del
   SafetyEngine (§25, documentado).

8. **Etiquetas**: print jobs con SNAPSHOT congelado en la base (§40) — la
   etiqueta histórica no cambia aunque cambie el alimento. PDF REAL
   (pdf-lib, mm→pt exactos, §66) con el DÍA DE USO grande (§34), pensado para
   térmica monocroma; reimprimir = nuevo job, mismo lote (§39). Plantillas
   configurables por mm (global 40 mm por defecto). Impresión directa queda
   para un PrinterAdapter futuro (§67).

9. **QR opaco** (§35-§37): token de 32 hex por lote (`gen_random_bytes`),
   jamás secuencial; `/q/{token}` exige sesión y pertenencia — token ajeno e
   inexistente responden IGUAL. El snapshot y el QR no llevan datos clínicos,
   identidad ni hogar. Acciones del QR (§36) reutilizan RPCs del ledger
   (`use_lot` nuevo para consumo directo).

10. **Outbox reutilizado** (§61): `app.emit_event` escribe en el
    `domain_events` del Sprint 1 (jamás un segundo outbox), con `dedupe_key`
    determinista para efectos una-sola-vez (`LOT_SPLIT:{task}`) y sufijo
    aleatorio para ocurrencias repetibles (congelar/descongelar).

11. **Rendimiento observado** (§45-§46): `household_observed_yields`
    append-only con factor GENERADO por la base; una observación jamás pisa
    `ingredient_yields` de referencia. El análisis multi-observación queda
    para un motor futuro.

12. **Merge validado** (§43): solo lotes disponibles del mismo hogar,
    alimento, unidad, base, processing y temperatura; fechas heredan la MÁS
    restrictiva; valor y cantidad se suman con grupo Σ=0.

## Limitaciones aceptadas (documentadas)

- El motor no porciona lotes CONGELADOS (genera sugerencia de descongelado);
  porcionarlos pasa por descongelar primero.
- `PrepComplexity` es una métrica simple (§55) usada para explicar, no un
  solver (§56): la agrupación es heurística determinista por bloque y
  herramienta.
- La capacidad del congelador se compara solo si TODOS los congeladores del
  hogar la declaran en gramos; parcial = desconocida (no se inventa, §54).
- Recordatorios (§30): los eventos quedan persistidos en el outbox; el
  sistema de notificación llega en un sprint posterior.

## Consecuencias

- La cocina obtiene un modo paso a paso que registra la realidad al gramo sin
  que el plan la fuerce, y la despensa queda etiquetada y trazable (QR→lote).
- Los Sprints siguientes pueden leer `household_observed_yields` y el outbox
  sin tocar nada de este diseño.
