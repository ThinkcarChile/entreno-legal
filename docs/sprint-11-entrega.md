# Sprint 11 — Salud, laboratorios y motor de reglas clínicas

**Estado:** `IMPLEMENTED_LOCAL_PENDING_LIVE_VERIFICATION` — migraciones
0026/0027 se congelan tras QA (§103); demo viva §101 pendiente de aplicarlas
en el remoto.

## Principio rector (§0)

Desde este sprint un error puede significar presentar una comida como
compatible sin fundamento. Dos reglas gobiernan el módulo:

- **`UNKNOWN NEVER MEANS NORMAL`** — heredada del gate, ahora con peso
  clínico: el sistema prefiere `REVIEW_REQUIRED` a una falsa afirmación.
- **`AI NEVER OVERRIDES CLINICAL RULES`** — la frontera es ESTRUCTURAL: lo
  que extrae la IA vive en `lab_extraction_candidates`; el motor solo lee
  observaciones `CONFIRMED`, que únicamente produce un humano.

## Las dos capas (§2, ADR 0012)

- **NutritionAIEngine** (`demo-parser/1.0.0`, sustituible): extrae candidatos
  de documentos de texto estructurado. PDF/imagen → `FAILED` honesto (§54).
  Sin consentimiento explícito el RPC del SERVIDOR rechaza la extracción (§4).
- **ClinicalRulesEngine** (`clinical-rules/1.0.0`): puro y determinista.
  Salida categórica (COMPATIBLE / COMPATIBLE_WITH_CAUTION / REVIEW_REQUIRED /
  CLINICALLY_INVALIDATED) con razones, datos faltantes, violaciones, ajustes
  propuestos y referencias (ids, no copias — §61).

## Schema (0026 + 0027)

- `biomarker_definitions`: catálogo global de 17, extensible por hogar; solo
  ESTRUCTURA, cero límites (§25).
- `lab_documents` (estados §3, consentimiento IA §4, bucket privado §47),
  `lab_extraction_candidates`, `lab_observations` (unidad NULL = desconocida
  §7; el rango del laboratorio pertenece a la observación §8; corrección
  encadenada `corrected_from` §11).
- `medical_data_grants` + `app.medical_access`: permisos INDEPENDIENTES de
  roles (§41), self-access (§42), regla del tutor para dependientes sin
  cuenta (explícita en ADR 0012). Aislamiento INTRA-hogar nuevo (§49).
- `member_lab_schedules` (§15: la frecuencia la define USER/DOCTOR/
  NUTRITIONIST/PROTOCOL, jamás la app), vigencia §14 con
  `NO_SCHEDULE_CONFIGURED`.
- `member_conditions` (§18: DIAGNOSIS ≠ RULE), `member_clinical_restrictions`
  (§19-§20, severidades propias), `clinical_rule_sets/versions` (§23:
  inmutables tras publicar, doble capa RLS+trigger),
  `meal_clinical_assessments` (§30/§96), `clinical_impact_reviews` (§35:
  idempotentes), `member_serving_projections.clinical_status` (§37:
  divulgación mínima; historia SERVED/CONSUMED intocable).

## Integración con el PortionOptimizer (§31/§74)

`clinicalCeilings` confirmados capan los objetivos: el deportivo jamás gana
al límite médico. Techos de otros nutrientes reducen componentes AJUSTABLES
respetando mínimos (§32: sin porciones-migaja); si no alcanza →
`TARGET_CONFLICT` + razón `CLINICAL_CONFLICT`. FIXED jamás se toca.

## Privacidad por superficie (§43-§45, §58)

- Cocina/planner: SOLO el estado categórico ("⚠ requiere revisión para N",
  "⛔ NO SERVIR SIN REVISIÓN"). Guarda estructural: `app/q`, `lib/labels`,
  `app/shopping`, `app/prep`, `app/procurement`, `app/pantry`, `app/stock` no
  pueden importar del dominio clínico (test lo vigila).
- Compras: cantidades + reason code neutro; jamás valores médicos.
- Etiquetas/QR: cero datos clínicos (test §84).

## UI (§51-§56)

`/health` (dashboard sobrio) · `/health/exams/upload` (miembro →
consentimiento → archivo) · `/health/exams/[id]/review` (fila a fila, dudosas
destacadas, "Confirmar todo" solo con forma válida) · `/health/member/[id]`
(resumen + confianza de DATOS §17 + restricciones SEPARADAS de preferencias
§56 + frecuencias + grants) · `/health/member/[id]/biomarker/[code]` (series
por unidad sin mezclar §12, tendencia descriptiva §13, sin alarmismo
§55/§94).

## Números

- 25 tests del motor (casos §66-§74 + bordes UNKNOWN).
- 5 tests de techos clínicos en el optimizador.
- 21 tests de integración (pipeline completo, RLS intra-hogar, grants y
  revocación inmediata, corrección encadenada, versionado inmutable,
  concurrencia §86, historia §78, divulgación mínima §82).
- 6 guardas estructurales (§45/§83/§84/§88/§95 + reloj prohibido en el motor).
- Repo completo: 672 tests / 46 archivos, tsc y ESLint limpios.

## Qué NO hace (a propósito — §63-§65, §99)

Sin AdaptiveNutritionEngine, sin predicción de glicemia, sin interacción
medicamentosa, sin CGM, sin OCR genérico, sin diagnóstico. Las condiciones se
REGISTRAN; los límites solo nacen de restricciones confirmadas con fuente.

## Pendiente para cerrar el sprint

1. Revisión adversarial §100 → fixes + regresiones (`docs/qa/sprint-11-report.md`).
2. Congelar 0026/0027 con checksum (§103).
3. Aplicar en remoto + demo viva §101 (18 pasos, datos sintéticos).
4. Smoke móvil 320/375/430 de las pantallas nuevas (§93).
