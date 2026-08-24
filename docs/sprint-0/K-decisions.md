# K. Decisiones que debemos tomar ahora

Solo decisiones **costosas de revertir**. Para cada una: la opción propuesta (lista para ejecutar si el director no objeta) y qué la haría cambiar. Las decisiones cosméticas o reversibles no aparecen: se tomarán directamente durante los sprints.

---

## K-1. Stack: Next.js (App Router) + TypeScript strict + Tailwind + Supabase — monolito modular
**Propuesta**: un solo repositorio/aplicación Next.js con capas internas estrictas (UI / Application / Domain / Engines / AI / Data). PostgreSQL, Auth, Storage y Realtime de Supabase. Zod para validación, Vitest (unit/integration) + Playwright (e2e), PWA mobile-first. Sin microservicios, sin colas externas, sin versiones beta.
**Por qué**: equipo pequeño, un producto; la separación que importa es lógica (motores puros), no de despliegue.
**Revertiríamos si**: apareciera necesidad real de procesamiento pesado independiente (p. ej. OCR masivo) — el outbox ya deja la costura hecha.

## K-2. Identidad: `HouseholdMember` separado de `User`, miembros sin cuenta permitidos
**Propuesta**: la persona del hogar es `household_member`; la cuenta (`auth.users`) es opcional y vinculable después. Todos los datos cuelgan del member, no del user.
**Por qué**: familias reales tienen niños/personas sin cuenta; migrar esto después tocaría todas las FKs del sistema. Es la decisión de esquema más cara de cambiar.
**Costo**: algo más de complejidad en RLS (pertenencia vía member↔user).

## K-3. Perfil nutricional: snapshots inmutables versionados + fuente relacional
**Propuesta**: `member_nutrition_profiles` como snapshot materializado inmutable (v1..vN) calculado desde tablas relacionales (goals con vigencia, patterns, constraints). Toda salida derivada (compatibilidad, porción, compra) registra la versión de perfil usada.
**Por qué**: exigencias del producto: "saber qué cambió", recálculo selectivo y trazabilidad clínica son imposibles con un perfil mutable.
**Costo**: más filas y disciplina de invalidación (mitigado en H).

## K-4. Nutrición y cantidades: base canónica por 100 g + estado explícito + efectos de cocción
**Propuesta**: nutrición por 100 g con `weight_basis` (RAW/COOKED/…) obligatorio; cantidades siempre en unidad canónica (g/ml/unit) con tabla de equivalencias; métodos de cocción modelados como `yield_factor` + grasa añadida/absorbida explícita.
**Por qué**: es el contrato de datos de TODOS los motores; cambiarlo después invalida cada número almacenado.
**Alternativa descartada**: nutrición "por porción" como base (ambigua, no componible).

## K-5. Recalculo: outbox en Postgres + dispatcher idempotente (sin cola externa)
**Propuesta**: `domain_events` transaccional + pg_cron/handler server-side + invalidación por versiones (`is_stale`), como se detalla en H.
**Por qué**: da trazabilidad y recálculo selectivo desde el sprint 4 sin operar infraestructura extra; migrable a cola real sin cambiar contratos.

## K-6. Clínico: motor determinista con reglas versionadas; IA jamás produce constraints
**Propuesta**: `clinical_rules` como DSL JSON validado (condición→acción), versionado, con fuente y estado VALIDATED; separación física ClinicalRulesEngine / NutritionAIEngine; confirmación humana en resultados y en objetivos clínicos nuevos.
**Por qué**: es la frontera de seguridad del producto; introducirla tarde (con un LLM ya "decidiendo") sería imposible de desandar de forma creíble.

## K-7. Proveedor IA: API de Anthropic detrás de `AIProvider`, salidas con schema Zod
**Propuesta**: un solo proveedor al inicio (modelo capaz para extracción de laboratorio; modelo rápido/económico para explicaciones y ranking), interfaz `AIProvider` intercambiable + provider fake determinista para tests. Consentimiento y minimización según F/G.
**Por qué**: la abstracción es lo caro de improvisar después; el proveedor concreto sí es reversible gracias a ella.

## K-8. Privacidad médica: grants explícitos independientes de roles + RLS total desde el sprint 1
**Propuesta**: `health_data_grants` (SUMMARY/CONSTRAINTS_ONLY/FULL) como único camino a datos clínicos ajenos; RLS activada en toda tabla desde su creación; bucket clínico privado con signed URLs; auditoría append-only.
**Por qué**: retro-instalar RLS/permIsos médicos sobre datos ya poblados es el clásico error irreversible en productos de salud.

## K-9. Compras e inventario como libro mayor (movimientos), no como estados editables
**Propuesta**: `inventory_movements` como fuente de verdad del stock; reservas por plan; `shopping_list_revisions` inmutables post-LOCK.
**Por qué**: sincronización multiusuario, explicabilidad ("¿por qué?") y el flujo LOCK_WEEK dependen estructuralmente de esto; con updates destructivos no hay vuelta atrás del historial perdido.

## K-10. Idioma y localización: es-CL como locale primario, esquema en inglés
**Propuesta**: nombres de tablas/código/enums en inglés (BREAKFAST…, con etiquetas es-CL en UI: "Once", "Colación"); contenidos (recetas, ingredientes) con campos traducibles desde el inicio (`name` + tabla de localización simple); unidades métricas; formato chileno (1.000,5).
**Por qué**: renombrar esquema o retro-instalar i18n de contenido con 500 recetas cargadas es prohibitivo; hacerlo ahora cuesta casi cero.

---

## Decisiones agregadas por el Addendum 0.1

**K-11…K-17** (inventario por lotes con costo por lote, costeo a costo real, `purchases` como convergencia de canales, reglas de seguridad de almacenamiento como datos versionados, equipamiento como capacidades-datos, QR = id opaco, lo clínico invalida en vez de modificar): ver [Addendum §16](./12-addendum.md#16-decisiones-estructurales-nuevas). K-17 **reemplaza** la parte de la excepción clínica descrita en D/H del Sprint 0.

## Pendientes de decisión del director (bloquean sprints específicos, no el 1–2)

1. **Fuente nutricional inicial** (sprint 2): base de composición de alimentos a usar como `nutrition_source` primaria para el seed curado (se propone partir de una base pública reconocida + verificación manual de los ~150 ingredientes iniciales).
2. **Quién cura las `clinical_rules` iniciales** (sprint 11): las reglas requieren una fuente profesional/protocolo validado; el equipo técnico implementa el DSL pero no redacta reglas clínicas.
3. **Posición de los sprints de salud** (I): confirmación del orden propuesto (salud en sprints 10–11) o adelantamiento.
