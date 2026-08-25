# ADR 0012 — Arquitectura clínica: frontera IA/reglas, grants médicos, inmutabilidad

**Estado:** ACEPTADA · **Sprint:** 11 · **Fecha:** 2026-08-25

## Contexto

Desde Sprint 11 la aplicación toca decisiones relacionadas con salud. El
estándar cambia: un error ya no es "compraste de más" sino "presentamos una
comida como compatible sin fundamento". Rigen dos principios nuevos sobre el
baseline congelado (K-1…K-25):

- `UNKNOWN NEVER MEANS NORMAL` (heredado del gate, ahora con peso clínico).
- `AI NEVER OVERRIDES CLINICAL RULES`.

## Decisión 1 — Dos capas con frontera dura

**NutritionAIEngine** (sustituible, no-autoridad): extrae texto de documentos,
resume, propone, clasifica, redacta. Su output SIEMPRE aterriza en entidades
`*_candidates` o texto sugerido; JAMÁS escribe en las tablas que el motor
clínico lee. La frontera es estructural, no disciplinaria: el
ClinicalRulesEngine solo lee `lab_observations` con `verification_status =
'CONFIRMED'` y `member_clinical_restrictions` con `verification_status =
'CONFIRMED'` — filas que solo un humano produce vía RPC de confirmación.

**ClinicalRulesEngine** (`clinical-rules/1.0.0`): puro, determinista,
versionado. Inputs: restricciones confirmadas, observaciones confirmadas (con
unidad conocida), vigencia de exámenes, completeness nutricional. Outputs
categóricos: `COMPATIBLE | COMPATIBLE_WITH_CAUTION | REVIEW_REQUIRED |
CLINICALLY_INVALIDATED` + razones estructuradas + datos faltantes + versiones
de regla. Prefiere `REVIEW_REQUIRED` a una afirmación falsa de seguridad.

## Decisión 2 — Grants médicos independientes de roles

Los roles del hogar (ADMIN/PLANNER/SHOPPER/COOK) NO otorgan acceso a datos
médicos. Nueva tabla `medical_data_grants`: una fila por
(dueño, receptor, permiso), revocable (`revoked_at`). Permisos: `READ_LABS`,
`UPLOAD_LABS`, `EDIT_UNVERIFIED`, `CONFIRM_LABS`, `VIEW_CLINICAL_RESTRICTIONS`,
`MANAGE_CLINICAL_RESTRICTIONS`.

Acceso efectivo (`app.medical_access(owner_member, permission)`):

1. **Self**: el usuario vinculado al propio `household_member` accede a sus
   datos.
2. **Grant activo**: fila no revocada hacia un member vinculado al usuario.
3. **Tutor de dependiente** (regla explícita, no un default silencioso): si el
   dueño NO tiene `user_id` vinculado (niños, adultos a cargo), el ADMIN del
   hogar tiene acceso de gestión implícito. Sin esta regla los dependientes
   quedarían sin nadie que suba/confirme sus exámenes. Queda auditado igual
   que cualquier acceso, y desaparece si el dependiente vincula su cuenta.

Aislamiento **intra-hogar**: dos integrantes con cuenta propia del MISMO hogar
no se leen los exámenes sin grant. RLS lo aplica en cada tabla clínica.

## Decisión 3 — Divulgación mínima por superficie

- **Cocina**: ve solo `clinical_status` del serving ("adaptación requerida" /
  "NO SERVIR sin revisión") — nunca biomarcador, valor ni diagnóstico. El
  status vive en `member_serving_projections` (columna nueva) y es el ÚNICO
  dato clínico visible sin grant.
- **Compras**: recibe cantidades y un reason code neutro
  (`CLINICAL_ADJUSTMENT`); jamás valores médicos.
- **Etiquetas/QR/lotes**: prohibido todo dato clínico; solo instrucción
  culinaria. Test de regresión lo vigila.

## Decisión 4 — Inmutabilidad y versionado

- Observación confirmada NO se edita: una corrección crea una observación
  nueva (`corrected_from` → cadena auditable), la vieja pasa a `CORRECTED`.
- `clinical_rule_versions` es inmutable tras publicar (trigger); una versión
  nueva NO reescribe evaluaciones históricas: los servings confirmados citan
  `rule_version` y referencias a observaciones usadas (referencias, no copias
  — minimizar duplicación sensible).
- Historia consumida es historia: una regla nueva genera
  `clinical_impact_review`, jamás UPDATE de servings CONSUMED, lotes, compras
  ni paquetes.

## Decisión 5 — Diagnóstico ≠ regla

`member_conditions` registra condiciones declaradas/confirmadas, pero ninguna
condición genera límites por sí sola. Los límites nacen SOLO de
`member_clinical_restrictions` confirmadas con fuente (`CLINICIAN_ENTERED`,
`DIETITIAN_ENTERED`, `VALIDATED_PROTOCOL`, `USER_CONFIRMED_LIMIT`). El seed
NO incluye límites médicos "universales": solo definiciones de biomarcadores
(estructura) y un perfil demo claramente sintético.

## Decisión 6 — Almacenamiento

Documentos médicos en bucket privado `medical-documents` (Supabase Storage),
ruta `household/{hid}/member/{mid}/{doc}`. Acceso por URL firmada de TTL corto
generada tras validar `medical_access` en el servidor; nunca URL pública. En
PGlite el schema `storage` se stubea en el arnés (misma técnica que `auth`).

## Consecuencias

- Dos migraciones nuevas (0026 documentos/observaciones/grants, 0027
  reglas/restricciones/evaluaciones/impacto); 0001→0025 intactas.
- El PortionOptimizer acepta constraints clínicos cuantitativos SOLO
  confirmados y compatibles en unidad/base; si no puede: `TARGET_CONFLICT`
  con razón clínica. Nunca toca componentes FIXED ni incompatibilidades HARD.
- La prioridad queda: alergia/seguridad > restricción médica confirmada >
  objetivo clínico > nutricional > deportivo > estético > preferencia >
  variedad. `FAVORITE` jamás gana a una restricción confirmada.
