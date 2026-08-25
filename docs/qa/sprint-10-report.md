# QA adversarial — Sprint 10 (Batch prep, conservación y etiquetas)

**Fecha:** 2026-08-25
**Método:** el workflow §92 de 12 lentes murió por el límite mensual de subagentes (0 de 12 alcanzó a correr), así que la revisión se hizo MANUALMENTE, lente por lente (A-L), leyendo el código completo de 0015 + motores + UI — igual que la segunda pasada del Sprint 8. **11 hallazgos únicos: 8 corregidos con regresión, 3 documentados como limitación en ADR 0011.** Además, el propio test de integración §73 encontró 1 defecto real durante la construcción (ya corregido antes de esta pasada).

## Corregidos (8)

1. **[H, ALTO] La regeneración del plan quedaba bloqueada por el dedupe del día**: cambiada la demanda (§83, sustitución pollo→merluza), `generatePrepPlan` devolvía el plan VIEJO con tareas obsoletas — exactamente el "preparar pollo para una demanda que ya no existe" que el director prohíbe. La clave de dedupe ahora lleva el hash SHA-256 del contenido (mismo contenido = idempotente; contenido distinto = plan nuevo) y `save_prep_plan` cancela las sugerencias READY/DRAFT del mismo día al crear la nueva. Un plan **IN_PROGRESS no se toca**: hay alguien cocinando con él (regresión para ambos casos).
2. **[A, MEDIO] `merge_lots` con valores mixtos falsificaba K-19**: unir un lote valorado con uno de valor DESCONOCIDO producía un lote con la suma parcial como si fuera el valor total (valor por gramo mentiroso). Ahora el desconocido DOMINA: cualquier parte NULL → resultado NULL (regresión: 300 g/$1.000 + 200 g/null → 500 g/null).
3. **[B, MEDIO] El motor consultaba la seguridad del estado equivocado**: los paquetes de un porcionado SIN corte siguen CRUDOS, pero `recommendStorage` preguntaba siempre por PREPPED — con solo una regla RAW válida, el guardado caía a un REVIEW_REQUIRED falso. Ahora consulta el estado que el paquete REALMENTE tendrá (PREPPED solo si la cadena corta).
4. **[C, MEDIO] Saltar la última tarea pendiente dejaba el plan colgado** en IN_PROGRESS para siempre (`skip_prep_task` no recalculaba el estado). Ahora cierra el plan igual que `complete`.
5. **[C, BAJO] Un plan COMPLETADO podía "cancelarse"** retroactivamente, reescribiendo la historia. Ahora es error explícito.
6. **[K, MEDIO] La capacidad por tanda ignoraba su unidad**: un equipo con máximo "2 UNIT" contra un lote de 1.500 g calculaba tandas sin conversión. `max_batch_unit` viaja hasta el motor y solo se compara cuando calza con la unidad del lote.
7. **[L, MEDIO] §19 sin cumplir: la ubicación concreta no se podía elegir** — el modo cocina mandaba cada paquete a la PRIMERA nevera/congelador del hogar. Ahora cada paquete tiene su selector de ubicación (la sugerida es el default; "cajón inferior" = otra fila de storage_locations elegible).
8. **[A/F, BAJO] Bordes de mensaje**: utilizable negativo en la cuadratura de merma rebotaba con un error de constraint ilegible (ahora mensaje claro); `/api/labels` con ids parcialmente ajenos generaba un PDF parcial en silencio (ahora todo-o-nada con 404 unificado).

## Encontrado por los propios tests durante la construcción (1, corregido antes de esta pasada)

- **`add_manual_lot` creaba lotes AMBIENT dentro del congelador** (falsificaba el estado térmico desde el primer segundo). v2 deriva la temperatura de la ubicación (misma regla que `move_lot`) y sella `frozen_at`.

## Documentados como limitación (3, en ADR 0011)

- **[B] `use_by` evaluado no se borra al transformar el lote**: una fecha evaluada para RAW persiste tras el corte a PREPPED. Borrarla automáticamente destruiría fechas puestas a mano; la UI recalcula el veredicto en vivo con las reglas y `set_lot_safety` permite re-evaluar. Anotado para el sprint que preste la UI de seguridad.
- **[I] Los paquetes sugeridos se calculan al GENERAR el plan**: si el lote cambió después (se consumió una parte), completar con las cantidades sugeridas rebota con el error honesto de `split_lot` ("las partes suman X pero el lote tiene Y") y la persona ajusta los gramos en pantalla — jamás una mentira silenciosa, pero tampoco una pre-carga del valor vigente (anotado como mejora).
- **[B/§29] Las sugerencias de descongelado se calculan por generación de plan**: un paquete congelado HOY aparece como sugerencia de descongelado recién en la próxima generación. Coherente con "derivado en vivo" (ADR 0009); el recordatorio activo llega con el sistema de notificaciones (§30: los eventos ya quedan en el outbox).

## Verificado sin hallazgo (muestra)

Conservación K-19 en split parcial con valor (residuo al padre, exacto); `for update` en tarea y lote con relectura fresca (dos tareas sobre el mismo lote se serializan); token QR de 128 bits sin oráculo (ajeno = inexistente); snapshot de etiqueta sin datos clínicos/identidad/hogar; RLS de las 9 tablas nuevas con escritura cerrada donde corresponde; vacío jamás toca temperatura ni `use_by`; recongelar sin dato de descongelado → revisar; el outbox reutiliza `domain_events` del Sprint 1 con dedupe.

## Verificación

**518 pruebas verdes** (35 dominio prep + 7 PDF + 32 integración prep + 6 demo §90 + las previas), typecheck/lint/build limpios, cadena 0001→0015 validada completa en PGlite. Tope de workers en vitest (6) para eliminar la flakiness de 13 PGlite simultáneos. Todo LOCAL: nada se presenta como verificado contra Supabase real hasta aplicar 0015.
