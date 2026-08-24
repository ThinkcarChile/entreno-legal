# F. AI Architecture

## Principio rector

**Determinista decide, IA extrae/explica/ordena/propone.** Un LLM nunca es el único responsable de una decisión crítica (clínica, de seguridad alimentaria o de cálculo nutricional). Toda salida de IA es estructurada, validada por schema, marcada con confianza y —cuando se convierte en dato del sistema— **confirmada por un humano**.

## Qué DEBE hacer la IA

| Capacidad | Servicio | Salida |
|---|---|---|
| Extraer resultados de exámenes desde PDF/imagen | `LabExtractionService` | `lab_results` en estado EXTRACTED (pendiente de confirmación) |
| Explicar en lenguaje natural decisiones ya tomadas por los motores | `NutritionReasoningService` | Textos "¿Por qué?" a partir de `reasons[]` estructuradas |
| Rankear/proponer entre opciones **ya filtradas como elegibles** por los motores | `RecommendationService` | Orden + razones para semana asistida/automática y "¿Qué puedo comer?" |
| Importar recetas desde URL/texto/imagen | `RecipeImportService` | Borrador de `MealTemplate` (slots clasificados) pendiente de confirmación |
| Interpretar registro de consumo por texto/voz/foto/código de barras | `FoodLoggingService` | Estimación de items+cantidades **siempre confirmable**, nunca medición exacta |
| Proponer objetivos (nunca imponerlos) | vía `nutrition_goals` con `source=AI_PROPOSAL`, `status=PROPOSED` | Propuesta revisable |

## Qué NO debe hacer la IA (reglas duras)

- **No** diagnosticar, modificar medicamentos, inventar restricciones, inventar valores de laboratorio ni determinar terapias.
- **No** inventar información nutricional de ingredientes (si falta, se marca faltante y se pide fuente).
- **No** calcular porciones, macros ni listas de compra (eso es de los motores deterministas).
- **No** aplicar constraints clínicas: eso es exclusivo del `ClinicalRulesEngine`.
- **No** asumir unidades inexistentes ni ocultar baja confianza.
- **No** ser llamada directamente desde componentes React: solo a través de servicios del Application Layer.
- **No** recibir más datos personales que los estrictamente necesarios para la tarea (minimización, ver [G](./G-security-model.md)).

## Abstracciones

### `AIProvider`

Interfaz única sobre el proveedor de modelos (propuesta: API de Anthropic; modelo capaz para extracción de laboratorio, modelo rápido para explicaciones/ranking — decisión K-7):

```ts
interface AIProvider {
  extractStructured<T>(input: { files?: FileRef[]; text?: string; schema: ZodSchema<T>;
                               task: TaskId; maxRetries?: number }): Promise<AIResult<T>>;
  // AIResult<T> = { data: T; confidence: ConfidenceReport; model: string; usage; traceId }
}
```

- Toda respuesta se valida con **Zod**; una respuesta que no cumple el schema se reintenta y luego falla explícitamente (nunca se "arregla" silenciosamente).
- `traceId` enlaza con `audit_events`; los prompts/versiones de prompt se versionan en código.
- Proveedor intercambiable (tests con provider fake determinista).

### `LabExtractionService`

- Input: `lab_document` (archivo privado, con `consent_record` vigente) + catálogo `biomarker_definitions`.
- Pipeline: normalización del archivo → extracción estructurada (schema por resultado: test_name, biomarker, value, unit, reference_min/max, date, laboratory, confidence por campo) → mapeo de unidades contra el catálogo (falla visible si la unidad no existe) → persistir EXTRACTED → flujo de confirmación humana (§48).
- Confianza por campo, mostrada siempre; campos ilegibles quedan vacíos, jamás inventados.

### `NutritionReasoningService`

- Input: `reasons[]` estructuradas emitidas por los motores (código + parámetros) + contexto mínimo (nombres, no datos clínicos salvo permiso).
- Output: explicación legible ("Aumentamos tu porción de pollo porque tu objetivo de proteína de esta comida es 50–80 g y la porción anterior aportaba menos"). 
- Para razones comunes se usan **plantillas deterministas primero**; el LLM entra solo para composición/resúmenes complejos ("¿Qué cambió?" semanal). Así la explicación nunca contradice el cálculo.

### `RecommendationService`

- Input: candidatos **ya elegibles** (filtrados por MealCompatibility/FamilyOptimizer — la IA no puede reintroducir un plato NOT_COMPATIBLE), señales (favoritos, votos, variedad, por-vencer, tiempo, eventos, macros restantes).
- Output: ranking + `RecommendationReason` por ítem; persistido en `ai_recommendations`; `recommendation_feedback` (aceptada/editada/rechazada) cierra el loop de aprendizaje.
- Cubre: recomendador semanal, "¿Qué puedo comer?" y sugerencias de once/postre con lo disponible.

### `RecipeImportService` (futuro, arquitectura preparada)

- URL/texto/imagen → extracción a borrador de MealTemplate (slots clasificados, cantidades, pasos) → **usuario confirma** → nutrición calculada por NutritionEngine desde ingredientes estructurados (no la que "diga" la receta) → validación.

### `FoodLoggingService` (futuro, arquitectura preparada)

- Texto/voz/foto/barcode → estimación de consumo con bandas de incertidumbre → confirmación → `consumption_logs` (`ai_estimated=true`, `confirmed=true`).

## Flujo de validación estándar (toda llamada IA)

```
consentimiento (si aplica) → minimizar payload → AIProvider → schema Zod
  → ¿válido? no → retry acotado → error explícito
  → sí → persistir como PENDIENTE/PROPUESTA (+confianza)
  → confirmación humana cuando el dato entrará en cálculo
  → audit_event + traceId
```

## Datos hacia el proveedor de IA (minimización)

- Exámenes: solo con `consent_record` vigente y revocable; se envía el documento y el catálogo de biomarcadores — no el historial completo de la persona.
- Recomendaciones/explicaciones: se envían señales agregadas y razones estructuradas, **no** documentos clínicos ni identificadores innecesarios (los nombres pueden seudonimizarse en el payload y re-mapearse localmente).
- Nada de datos médicos en logs normales; trazas de IA con referencias por id.
