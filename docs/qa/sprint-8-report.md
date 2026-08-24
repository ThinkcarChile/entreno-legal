# QA adversarial — Sprint 8 (Stock Intelligence)

**Fecha:** 2026-08-24
**Método:** workflow de 9 lentes (§58) con refutación por hallazgo, en DOS pasadas: la primera chocó con los límites de uso a mitad de la verificación y sus 24 hallazgos se verificaron manualmente; el reintento completó los 53 agentes y confirmó 28 (16 refutados). Entre ambas: **21 defectos únicos confirmados, 21 corregidos**, cada uno con regresión.

## Confirmados y corregidos (21)

### Segunda pasada (los que la primera no alcanzó a verificar)

14. **`consume_planned_meal` consumía lotes VENCIDOS — y FEFO los ponía PRIMERO** (lente A, ALTO) — el motor decía "faltan 300 g" y el consumo se los comía de un lote vencido sin registrar nada: dos sistemas contando despensas distintas. El RPC ahora aplica la MISMA regla de usabilidad (fecha vencida = no usable, medida en el día del HOGAR), el faltante cae naturalmente como shortfall, y el lote vencido queda esperando su descarte con causa EXPIRED. Regresión: vencido 500 g intacto + fresco 100 g consumido + shortfall 200 g.
15. **La cobertura del plan apagaba el forecast de alimentos NO planificados** (lente C, ALTO) — el yogur diario jamás planificado perdía su forecast durante la semana planificada → quiebre. La supresión aplica solo a alimentos que aparecen en el plan confirmado.
16. **Día 0 contado doble** (lentes C y G) — lo consumido HOY ya bajó el lote y el forecast volvía a cobrar hoy completo. El forecast estadístico parte MAÑANA.
17. **Doble conteo entre la línea del plan y la sugerencia en la MISMA lista** (lente C) — la recomendación incluye el faltante confirmado que la línea FOOD_PLAN ya pide. "Agregar a próxima compra" descuenta lo pendiente del plan y lo dice.
18. **Prioridad de yields OPUESTA entre motor y RPC** (lente B, ALTO) — el motor prefería método>hogar y el RPC hogar>método: dos conversiones distintas para la misma despensa. Alineados: hogar domina, método desempata (igual que el RPC).
19. **AS_PACKAGED quedaba UNRESOLVED contra su propio stock** (lente H) — la masa envasada ES la masa comprable: equivale a crudo en ambos lados.
20. **Vistas de merma/compra sin base física** (lente H) — waste30/purchases30/overbuySignal mezclaban bases. Las vistas exponen `weight_basis` y el motor filtra por bucket.
21. **Costeo de merma sobre lotes "sucios"** (lente F, ALTO) — un lote partido o ajustado al alza mezclaba modelos contables (padre subvaluado, denominador inflado). El costo se calcula SOLO para lotes limpios (la entrada por split de un hijo es exacta; el padre partido y el ajustado quedan en NULL hasta `cost_allocations`). Más: sello del trigger de compra valida ámbito del ingrediente, vistas con cota de 30 días, hogar determinista para multi-hogar, sugerencias hidratadas desde el servidor, texto numérico inválido ya no borra objetivos en silencio, y la acción de sugerencia audita sus re-cuantificaciones y no revienta la página con throws.

### Primera pasada (13)

1. **onHand mezclaba bases físicas** (lente H, ALTO) — el atún escurrido se sumaba al crudo como si fueran lo mismo. La identidad ahora incluye la base del bucket (`ingrediente::unidad::base`): RAW, DRAINED y COOKED (sobras) son items separados, y la demanda se enruta a su bucket (RAW/COOKED→crudo con conversión explícita; DRAINED→escurrido). De regalo, el pipeline DRAINED completo (lata→demanda→consumo) ahora funciona de punta a punta con tasa propia.
2. **Tasa inflada para alimentos esporádicos** (lente B, ALTO) — un alimento comido UNA vez hace 3 días fabricaba "125 g/día". Sin al menos 3 observaciones no hay tasa (§14): el plan confirmado sigue mandando por su lado.
3. **Consultas de porciones sin filtro de hogar** (lente D) — una persona en DOS hogares mezclaba consumos y reservas de ambos en el forecast. Las proyecciones ahora se filtran por los integrantes del hogar analizado.
4. **Shortfall en base declarada restado de totales en otra base** (lente H) — un shortfall COCIDO se restaba 1:1 de un total CRUDO. Se convierte con la misma regla que todo (rendimiento explícito) o degrada aparte, jamás se mezcla ni desaparece.
5. **El objetivo ignoraba su unidad** (lente H) — un mínimo declarado en UNIDADES se comparaba contra gramos. El target aplica solo cuando su unidad calza con el bucket.
6. **Prioridad de rendimientos indefinida** (lente B) — con factor global Y del hogar para el mismo alimento, ganaba el orden de llegada. La segunda pasada afinó la regla final (ver #18): hogar domina, método desempata.
7. **Fechas futuras colándose en las ventanas de 30 días** (lente G) — mermas/compras con fecha futura contaban como historia. Guarda `edad >= 0`.
8. **Fechas de merma/compra en día UTC** (lente G) — a las 22:30 de Santiago un descarte caía en "mañana". El cargador convierte `created_at` al día del hogar con su zona horaria.
9. **Costo de merma como suma parcial** (lente F) — mitad de las mermas con costo y mitad sin, presentado junto a la cantidad total: un número que miente. §26 aplicado en serio: el costo se muestra solo cuando se puede calcular ENTERO.
10. **Carrera en "Agregar a próxima compra"** (lente I) — dos clics simultáneos duplicaban la sugerencia y el duplicado envenenaba `maybeSingle()` para siempre. Índice único parcial por (lista, alimento) + inserción que absorbe el 23505 + re-cuantificación SOLO de sugerencias PENDIENTES (una ya comprada no se reescribe en silencio).
11. **`ensure_weekly_plan` con carrera crear-crear** (lente I, preexistente desde el Sprint 5) — dos personas creando la misma semana → 23505 en la cara de una. Upsert con `on conflict do nothing` + relectura.
12. **Detección de duplicados por sniffing del mensaje** (lente I) — `error.message.includes("duplicate")` → `error.code === "23505"`.
13. **`set_stock_target` pisaba `safety_stock` con null** (lente I) — la UI no lo expone y cada guardado lo borraba. NULL ahora significa "no lo toco".

## Refutados o aceptados como diseño documentado (11)

- **Débito del padre en split con `greatest(…,0)` traga valor** — refutado por el verificador: la resta es exacta; el residuo va al último hijo.
- **planningCoveredUntil asume cobertura contigua** — es el diseño del director (§17: días 1-7 cubiertos por el plan, sin forecast), documentado en ADR 0009. Un hueco dentro de la semana planificada se considera decisión de la familia, no demanda estadística.
- **HOY puede pronosticarse completo aunque ya se consumió** — solapamiento ≤1 día en el borde; anotado como limitación conocida (el forecast por día-parcial llegaría con consumo intradía real).
- **Porciones PLANNED de ayer desaparecen de ambos lados** — real pero es deuda de higiene de planificación (comidas nunca marcadas), no del motor: anotada para Sprint 9 ("comidas vencidas sin registrar" como aviso).
- **Vista de mermas re-costea historia tras split/ajustes** — el modelo de costo definitivo es `cost_allocations` (baseline §3, sprint de recepción con boleta); mientras `acquisition_value` sea NULL en todo camino productivo, la vista es una estimación best-effort ya etiquetada como tal. Anotado como riesgo para ese sprint, junto con las variantes del mismo tema (denominador con ADJUSTMENT positivo, débito por cantidad vigente).
- **`agregados` local se resetea al navegar** — con el guard de PENDIENTes + unique, re-agregar es inocuo (actualiza cantidad de una sugerencia pendiente o falla con mensaje).
- **Consumo declarado en otra unidad desaparece** — falso: entra a `unresolvedDeclared` y degrada la confianza (test explícito nuevo).

## Regresiones agregadas

Regresión por cada corrección: buckets por base, tasa mínima de observaciones, target por unidad, prioridad de yields, fechas futuras, costo entero-o-null, shortfall inconvertible, forecast desde mañana, y la integración del lote vencido (intacto + shortfall exacto). Total del proyecto: **376 verdes**, lint/typecheck/build limpios.
