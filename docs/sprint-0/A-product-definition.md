# A. Product Definition

## Qué estamos construyendo

Una **plataforma familiar inteligente de alimentación**: un sistema que conecta a las personas de un hogar (Household) con sus gustos, objetivos nutricionales, condiciones de salud y exámenes de laboratorio, y a partir de eso resuelve de punta a punta el ciclo semanal de comida de la familia:

**decidir qué comer → planificar la semana → calcular porciones individuales → cocinar un solo plato base con personalizaciones mínimas → comprar una sola vez lo justo → mantener despensa y stock → registrar consumo real → aprender y recomendar mejor.**

No es una app de recetas, ni un contador de calorías, ni un gestor de listas de compras: es la integración de todos esos dominios sobre un modelo de datos común, con un motor de cálculo determinista y una capa de IA explicativa.

## Usuario principal

**La familia como unidad** (Household), operada día a día por sus integrantes según roles:

- **El planificador/a**: elige los 7 platos de la semana con ayuda del sistema.
- **El cocinero/a**: recibe instrucciones operativas exactas (cuánto preparar, cómo dividir por método de cocción, cuánto servir a cada uno) sin interpretar cálculos.
- **El comprador/a**: recibe una lista consolidada, real y explicable (recetas + habituales + reposición − despensa).
- **Cada integrante**: gestiona sus gustos, favoritos, objetivos, patrón de comidas, ayuno, días especiales y su salud.

La familia inicial tiene 5 integrantes (Ricardo, Paula, Francisco, Sebastián, Constanza), pero el sistema soporta N integrantes y múltiples households.

## Usuarios secundarios

- **Integrantes con objetivos deportivos/nutricionales activos** que registran consumo real y usan "¿Qué puedo comer?".
- **Integrantes con condiciones de salud** cuyos exámenes confirmados influyen en compatibilidad de platos, porciones y selección de ingredientes.
- **Profesionales de salud (indirectos)**: no usan la app, pero sus indicaciones entran como objetivos/reglas con `source = CLINICIAN`, y la app recuerda cuándo corresponde repetir exámenes.

## Problema principal

Alimentar bien a una familia heterogénea es hoy un problema de coordinación sin herramientas: cada día se improvisa qué cocinar, se cocina de más o de menos, se compran cosas que ya había y faltan las que no, se desperdicia comida, y las necesidades individuales (más proteína, sin aceite, restricción médica, a alguien no le gusta el cerdo) o se ignoran o multiplican el trabajo de cocina por cinco.

## Diferenciadores

1. **Plato base familiar con personalización por niveles (0–4)**: el sistema optimiza para cocinar UNA comida y resolver diferencias con cantidad → método de cocción → una sustitución, nunca cinco platos distintos.
2. **Porciones individuales calculadas, no receta × personas**: la compra nace de `SUM(member_final_serving)` y se explica producto por producto.
3. **Salud real integrada con seguridad**: exámenes de laboratorio subidos, extraídos por IA, **confirmados por humanos**, convertidos en restricciones por un motor de reglas determinista — nunca por un LLM en solitario.
4. **Ciclo cerrado con inventario**: despensa, sobras, vencimientos, stock mínimo y consumo real alimentan la siguiente semana.
5. **Explicabilidad total**: pantalla "¿Qué cambió?" y "¿Por qué?" en cada recomendación, cantidad y sustitución.
6. **Bloqueo de semana**: después de comprar, los cambios no reescriben silenciosamente el plan; generan un impacto revisable (aplicar ahora / próxima semana / revisar).

## Principio de producto (filtro de features)

Antes de agregar cualquier función: *"¿Esto ayuda a decidir qué comer, cocinar mejor, comprar mejor o cuidar mejor la alimentación de la familia?"* Si no, no pertenece al producto principal.

## Regla de seguridad

La aplicación no diagnostica, no modifica medicamentos, no inventa restricciones ni valores de laboratorio, no determina terapias. Los datos de salud **confirmados** sí influyen en la alimentación, a través de datos estructurados + reglas validadas + objetivos + IA explicativa.
