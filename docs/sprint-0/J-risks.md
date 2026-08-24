# J. Riesgos principales (Top 10)

Ordenados por severidad × probabilidad. Cada uno con mitigación concreta ya reflejada en la arquitectura.

## 1. Precisión nutricional de base (datos de ingredientes)
Todo el sistema (porciones, compras, salud) se apoya en `ingredient_nutrition`. Datos incorrectos o de fuentes mezcladas producen cálculos convincentes pero falsos.
**Mitigación**: fuente única curada por ingrediente con `nutrition_source`/`source_version`/`verified`; seed inicial pequeño y revisado (los ~150 ingredientes de los 28 platos) antes que un catálogo masivo sin curar; la IA jamás inserta nutrición; discrepancias producto-comercial vs genérico se resuelven a favor de la etiqueta del producto.

## 2. Datos clínicos: extracción errónea o uso indebido
Un valor mal extraído de un PDF, una unidad mal mapeada o una regla mal escrita puede producir una restricción médica falsa (o la ausencia de una real).
**Mitigación**: confirmación humana obligatoria, unidades solo contra catálogo, confianza visible, reglas clínicas versionadas con fuente y estado VALIDATED, constraints trazables a resultados, propuestas (no aplicación) para objetivos clínicos nuevos, y el descargo permanente: la app no es un reemplazo médico.

## 3. Complejidad del optimizador familiar
El espacio (N personas × slots × opciones × métodos × rangos) puede volverse inabordable o, peor, impredecible para el usuario.
**Mitigación**: búsqueda escalonada por niveles 0–4 (no solver genérico), determinismo estricto, límites duros (máx. 1 sustitución), casos dorados como tests, y REVIEW_REQUIRED como salida honesta en vez de soluciones rebuscadas.

## 4. Privacidad de datos médicos intra-familia
El riesgo más sensible no es un atacante externo: es que un integrante vea datos clínicos de otro sin permiso, o que se filtren por logs/eventos/IA.
**Mitigación**: grants explícitos independientes de roles, RLS por operación, bucket privado + signed URLs cortas, eventos con ids (no valores), consentimiento IA revocable, auditoría append-only. Test de RLS automatizado por tabla en CI.

## 5. Sincronización y concurrencia (lista compartida, recálculos)
Dos personas editando la lista mientras compran, o un recálculo pisando un cambio manual, destruyen la confianza en un dato que debe ser exacto.
**Mitigación**: inventario y compras como movimientos/eventos (no updates destructivos), reservas de despensa por plan, outbox idempotente con SKIP LOCKED, Realtime para convergencia visual, LOCK_WEEK para congelar la base de comparación.

## 6. Inventario que se desvía de la realidad
La despensa digital diverge de la física (nadie registra la merma, se cocina distinto) y el descuento de compra se vuelve dañino ("no compres pollo" cuando no hay).
**Mitigación**: fricción mínima de corrección (ajuste en un toque, auditado), "comí lo planificado" de un botón, confirmación de cocción genera los movimientos, el descuento muestra siempre qué asumió ("descontamos 650 g congelados — ¿correcto?"), y el aprendizaje de consumo tolera ruido (promedios, no valores puntuales).

## 7. Unidades y estados de peso
Sumar gramos con unidades, o confundir crudo/cocido (150 g arroz crudo ≈ 450 g cocido), corrompe silenciosamente porciones y compras.
**Mitigación**: unidad canónica obligatoria en cada cantidad, `unit_equivalences` requerida para toda conversión (falla explícita si falta), `weight_basis` explícito en nutrición y en cada porción, yield factors por método, property-based tests de conversión.

## 8. Dependencia y variabilidad de la IA
Salidas no estructuradas, alucinaciones, cambios de modelo/proveedor, costos, o LLM tomando decisiones que no le corresponden.
**Mitigación**: AIProvider único con schema Zod y retry acotado, IA solo en extracción/explicación/ranking sobre candidatos ya filtrados, plantillas deterministas para razones comunes, provider fake para tests, presupuesto/limitación de llamadas, todo confirmable por humanos.

## 9. Sobrecarga de recálculo o inconsistencia de snapshots
Recalcular todo ante cada cambio no escala; recalcular de menos deja porciones/compras obsoletas sin que nadie lo note.
**Mitigación**: grafo de invalidación explícito por evento (H), versiones de insumos en cada snapshot, `is_stale` + recomputación perezosa de lo visible, jobs idempotentes, y monitoreo de eventos FAILED/dead-letter.

## 10. Mantenimiento y alcance (riesgo de producto nº 1)
La visión abarca ocho dominios; el riesgo real es un sistema a medio construir en todos y utilizable en ninguno, o una base de código que una sola persona no puede sostener.
**Mitigación**: roadmap de entregables utilizables por sprint (I), motores puros con tests como red de seguridad, principio de producto §80 como filtro de features, dependencias mínimas y estables (K-1), documentación de decisiones (K) y este Sprint 0 como contrato: nada se elimina del diseño sin indicarlo, nada se agrega sin pasar el filtro.
