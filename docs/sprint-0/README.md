# SPRINT 0 — Arquitectura de la Plataforma Familiar Inteligente de Alimentación

> Estado: **PARA REVISIÓN DEL DIRECTOR DEL PROYECTO**
> Fecha: 2026-08-24
> Fuente de verdad funcional: el **Prompt Maestro** (documento maestro entregado por el director del proyecto). Este Sprint 0 lo convierte en arquitectura ejecutable; no elimina ninguna funcionalidad del diseño.

Este directorio contiene el entregable completo del Sprint 0. No incluye código de aplicación, migraciones SQL definitivas, las 28 recetas ni el motor clínico: eso corresponde a sprints posteriores, tras la revisión de este documento.

## Índice

| Sección | Documento | Contenido |
|---|---|---|
| A | [A-product-definition.md](./A-product-definition.md) | Definición de producto |
| B | [B-domain-model.md](./B-domain-model.md) | Modelo de dominios y responsabilidades |
| C | [C-database-architecture.md](./C-database-architecture.md) | Esquema relacional inicial (para revisión, sin migraciones) |
| D | [D-data-flows.md](./D-data-flows.md) | Los 7 casos de flujo de datos |
| E | [E-calculation-engines.md](./E-calculation-engines.md) | Motores de cálculo (Nutrition, Portion, Compatibility, Family, Inventory, Shopping, Clinical) |
| F | [F-ai-architecture.md](./F-ai-architecture.md) | Arquitectura de IA: qué hace y qué NO hace |
| G | [G-security-model.md](./G-security-model.md) | Seguridad, privacidad, RLS, datos médicos, consentimiento |
| H | [H-event-recalculation.md](./H-event-recalculation.md) | Arquitectura de eventos y recálculo selectivo |
| I | [I-roadmap.md](./I-roadmap.md) | Roadmap de 13 sprints |
| J | [J-risks.md](./J-risks.md) | Los 10 riesgos principales |
| K | [K-decisions.md](./K-decisions.md) | Decisiones que deben tomarse ahora |

## Principios rectores (resumen del Prompt Maestro)

1. **Una familia → un plato base → personalizaciones mínimas**, resueltas en orden: cantidades → método de cocción → una sustitución → adaptación especial (Nivel 0–4).
2. **Todo conectado**: personas → gustos → objetivos → macros → salud → exámenes → recetas → porciones → cocción → planificación → compra → despensa → consumo real → recomendaciones.
3. **Una sola fuente de estado nutricional por persona** (`MemberNutritionProfile`, versionado). Ningún módulo calcula objetivos por su cuenta.
4. **Determinismo antes que IA**: las reglas clínicas y los cálculos nutricionales son deterministas y trazables; la IA extrae, explica, ordena y propone — nunca decide sola algo crítico ni inventa datos.
5. **Explicabilidad**: toda recomendación, cantidad de compra y cambio automático responde "¿por qué?".
6. **Seguridad clínica sobre simplicidad culinaria**; datos médicos con permisos y consentimiento explícitos.
7. **La app no es un reemplazo médico.**

## Forma de trabajo

Cada sprint futuro seguirá el ciclo definido en el Prompt Maestro §83: revisar estado → definir alcance → explicar decisiones → implementar → migraciones → tests → lint → typecheck → tests → build → corregir → resumen. Un sprint no se declara terminado con el build roto.
