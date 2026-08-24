# 0002 — Versionado de recetas y agregación nutricional

- Estado: APROBADO (implementado en Sprint 3)
- Fecha: 2026-08-24
- Decisión de baseline afectada: desarrolla K-21 (recetas versionadas e inmutables). **Modifica Sprint 0 §C-3** en un punto: las cantidades de los componentes son del total de la receta base, no por porción (§1 de este ADR). El resto del §C-3 se mantiene.

## Contexto

Sprint 2 dejó el catálogo con nutrición trazable por 100 g/ml y la regla `UNKNOWN != ZERO`.
Sprint 3 construye la representación de una comida. Al implementarlo aparecieron cuatro
decisiones que tocan invariantes de dominio y por lo tanto requieren ADR según el régimen
de cambios de la Baseline.

---

## 1. Las cantidades pertenecen a la receta total, no a la porción

**Decisión**: `meal_slot_components.quantity` es la cantidad de la **receta completa** para
`meal_template_versions.base_servings` porciones. La cantidad por persona se **deriva**.

**Desvío respecto de Sprint 0 §C-3**, que definía `meal_slot_options.base_quantity_per_serving`.

**Por qué**: las porciones individuales van a diferir por integrante (Sprint 5, PortionOptimizer).
Si lo persistido fuera "por persona", cada porción personalizada obligaría a reinterpretar
qué significa la cantidad base, y una receta de 5 personas con 900 g de pollo se volvería
"180 g por persona" — un número que nadie escribió y que se rompe apenas alguien coma más.
Guardar el total es lo que el cocinero realmente mide, y dividir es trivial; multiplicar de
vuelta desde un promedio, no.

**Consecuencia**: `scaleMealTemplateVersion(version, servings)` devuelve una proyección
(`factor = requested / base`) y nunca toca lo persistido.

---

## 2. Sumar nutrientes absolutos es válido aunque los estados difieran

**Decisión**: se separan dos operaciones que antes se confundían en una sola:

| Función | Qué combina | Cuándo rechaza |
|---|---|---|
| `combineNutrition` | fichas en la **misma representación** (por 100, misma base y unidad) | bases o unidades distintas |
| `sumAbsoluteNutrients` | **vectores absolutos** ya resueltos a una cantidad | nunca por base: esa dimensión ya se consumió |

**Por qué**: una receta real mezcla estados — pollo 220 g RAW, arroz 150 g COOKED,
tomate 200 g RAW. Rechazar esa suma haría inútil al motor. Lo que sí es inválido es
*interpretar* una ficha con la base equivocada. El orden correcto es:

1. resolver cada componente con **su** ficha;
2. calcular su vector para **su** cantidad y **su** base;
3. el resultado ya no arrastra RAW/COOKED ni g/ml — es absoluto;
4. recién ahí sumar.

**Sigue prohibido**: leer una ficha COOKED como si fuera RAW, convertir g ↔ ml sin densidad
o equivalencia explícita, y fusionar dos fichas incompatibles como si fueran la misma
representación. `resolveComponentNutrition` lanza excepción en los tres casos.

---

## 3. Publicar congela la ficha nutricional usada

**Decisión**: al publicar una versión, cada componente guarda un snapshot
(`frozen_nutrition`, `frozen_source`) de la `nutrition_facts` que usó, además de la
referencia `nutrition_fact_id`. El cálculo de una versión publicada usa el snapshot.

**Por qué**: K-21 exige que el historial no se reescriba. Si mañana se corrige el fósforo
del arroz, la receta que la familia cocinó en septiembre debe seguir diciendo lo que decía
entonces — de lo contrario cualquier análisis histórico, y más adelante el motor clínico,
estarían leyendo datos que nadie vio nunca. La corrección se refleja al publicar una
**versión nueva**, que es exactamente el mecanismo de versionado.

**Refuerzo en la base, no solo en la UI**: triggers (`versions_immutable`,
`slots_immutable`, `components_immutable`, `alternatives_immutable`, `steps_immutable`)
rechazan cualquier cambio de contenido sobre una versión `PUBLISHED`. Lo único permitido
es archivarla. La política RLS `can_write_version` además exige `status = 'DRAFT'`.

---

## 4. Compatibilidad culinaria ≠ equivalencia nutricional

**Decisión**: `meal_slot_alternatives` expresa **solo** que un reemplazo es válido en la
cocina (`culinary_compatibility`, y un `quantity_equivalence` opcional que es un ajuste de
cantidad culinario). No existe ni existirá en esta tabla un campo de equivalencia nutricional.

**Por qué**: 200 g de pollo no son 200 g de merluza. Dejar que el modelo insinúe lo
contrario produciría sustituciones que parecen correctas y no lo son. Las cantidades
finales de un reemplazo las calculará el PortionOptimizer contra los objetivos de cada
integrante (Sprint 5), con los datos nutricionales reales de ambos alimentos.

---

## 5. Completitud: `COMPLETE` / `PARTIAL` / `UNKNOWN`

**Decisión**: toda agregación devuelve, por nutriente, un estado además del valor:

- `COMPLETE` — todos los componentes aportaron ese nutriente;
- `PARTIAL` — algunos sí y otros no: el valor es una suma parcial y **jamás** se presenta
  como total (la UI muestra "cálculo incompleto");
- `UNKNOWN` — ninguno lo conocía: valor `null`, nunca 0.

**Por qué**: `UNKNOWN != ZERO` (ADR 0001) resuelve el dato faltante de **un** alimento,
pero no el de una suma. Una receta donde 4 de 5 ingredientes informan fósforo produce un
número que se ve como un total y no lo es. Para el futuro `ClinicalRulesEngine` la
diferencia entre "el plato tiene 510 mg de fósforo" y "tiene al menos 510 mg, y de un
ingrediente no sabemos" es la diferencia entre una recomendación y un error clínico.

**Consecuencia**: `recipe_nutrition.completeness` (jsonb) se persiste junto al cache, y
ninguna pantalla muestra un valor `PARTIAL` sin su advertencia.

---

## Alternativas descartadas

- **Versionar solo el "diff" de cada edición**: reconstruir una versión histórica exigiría
  replay de todos los cambios. Con recetas de ~10 componentes, copiar la versión completa
  es más barato de leer, de auditar y de explicar.
- **Recalcular la nutrición al vuelo desde `nutrition_facts` siempre**: viola §3 — la
  historia cambiaría sola al corregirse el catálogo.
- **Un subsistema propio para ensaladas y postres**: se descartó por duplicación. Son
  `meal_templates` con `kind = 'SALAD' | 'DESSERT'`, referenciables desde un slot por
  **versión** (`nested_version_id`), de modo que "Ensalada Chilena v2" queda congelada
  igual que cualquier otro componente.
