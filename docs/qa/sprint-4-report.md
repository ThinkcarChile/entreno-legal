# QA Sprint 4 — Revisión adversarial

- **Fecha**: 2026-08-24
- **Alcance**: PortionOptimizer, perfiles nutricionales, porciones familiares, RLS y UI del Sprint 4
- **Objetivo**: encontrar dónde falla, no demostrar que funciona
- **Resultado**: **7 bugs encontrados, 7 corregidos.** Todos los checks verdes.

## Resumen

| | |
|---|---|
| Tests de dominio | **138** (antes 98) |
| Tests SQL | `rls_catalog` + `rls_recipes` + `rls_profiles`, todos verdes |
| Migraciones nuevas | `0006_component_roles.sql` |
| ADR | [0004](../adr/0004-explicit-component-roles.md) |
| lint / typecheck / build | verdes |

**Los tres bugs más graves no se veían en los tests: solo aparecieron ejecutando la app contra Supabase real.** Uno de ellos hacía que **una alergia no bloqueara el plato**.

---

## Bugs encontrados y corregidos

### B-1 · Las preferencias nunca llegaban al motor · **CRÍTICO**

`loadMemberProfile` hacía `as unknown as MemberPreference[]` sobre las filas de `member_preferences`. La base devuelve `preference_type`, `target_kind`, `target_id`; el dominio lee `preferenceType`, `targetKind`, `targetId`. El casteo compilaba, no daba error en ningún momento, y el optimizador recibía objetos cuyas claves nunca leía.

**Consecuencia real**: una **alergia no bloqueaba el plato** y un "no me gusta" no se anotaba. Los tests de dominio pasaban porque construyen los perfiles a mano, con las claves correctas.

**Corregido**: se mapea explícitamente en vez de castear. Verificado en la app: al marcarle a Sebastián que no le gusta el pollo, aparece la sugerencia de reemplazo que antes no salía.

### B-2 · Un reemplazo se sumaba al total del alimento original · **ALTO**

Al aceptar cambiar pollo por merluza, `preparationTotals` agrupaba por identificador de componente de la receta. Los 360 g de merluza de Sebastián se sumaban a la línea "Pechuga de pollo": el total decía **1.155 g de pollo** y **0 g de merluza**.

**Consecuencia real**: el precursor del `ShoppingEngine` mandaría a comprar pollo de más y nada de merluza.

**Corregido**: se agrupa por alimento (`ingredientId` + etiqueta). Ahora son dos líneas: **Pollo 795 g** y **Merluza 360 g**, misma masa total, atribuida bien. Con test de regresión.

### B-3 · La heurística del 70 % borraba comida del plato · **ALTO**

La detección de grasa añadida inferia el rol desde los macros. Medida contra ocho alimentos reales:

| alimento | % energía de grasa | heurística | correcto |
|---|---|---|---|
| Aceite de oliva | 100,0 % | grasa añadida | grasa añadida |
| Mantequilla | 101,7 % | grasa añadida | grasa añadida |
| Mayonesa | 99,3 % | grasa añadida | grasa añadida |
| **Palta** | 82,7 % | grasa añadida | **ALIMENTO** ← falso positivo |
| **Semillas de girasol** | 78,6 % | grasa añadida | **ALIMENTO** ← falso positivo |
| Queso gouda | 69,3 % | alimento | ALIMENTO ← se salva por 0,7 puntos |
| Yogur natural | 48,7 % | alimento | ALIMENTO |
| Limón | 9,3 % | alimento | ALIMENTO |

A quien evita la grasa añadida se le borraba **la palta** del plato. Un queso algo más graso habría caído también. Ningún umbral arregla esto: el rol culinario no se deduce de la composición.

**Corregido**: columna `role` (`MAIN` / `ADDED_FAT` / `SEASONING`) declarada por la receta. Migración `0006`, relleno por categoría del ingrediente (dato declarado, no inferencia), y [ADR 0004](../adr/0004-explicit-component-roles.md).

### B-4 · 28 consultas convertían un error en "no hay datos" · **ALTO**

Auditoría del §25: veintiocho llamadas destructuraban solo `data` e ignoraban `error`. Es el patrón que ya había escondido tres bugs (recetario vacío, lista de integrantes vacía desde el Sprint 1, porciones que no salían).

El peor caso estaba en `loadMemberProfile`: siete consultas en paralelo sin revisar. Ahí un fallo silencioso no produce una pantalla vacía, produce **una porción calculada con un perfil incompleto**.

**Corregido**: helper `DataAccessError` y revisión en las 28. Quedan **cero** lecturas que ignoren el error. El propio arreglo destapó B-5 de inmediato.

### B-5 · Embed inválido sobre una columna polimórfica · **MEDIO**

`member_preferences.target_id` apunta a un ingrediente, una categoría, una receta o un producto según `target_kind`: no tiene clave foránea y no admite embed de PostgREST. La consulta fallaba con `PGRST200`. Antes de B-4 habría devuelto una lista vacía en silencio.

**Corregido**: se resuelve el nombre con el mapa de ingredientes que ya se cargaba.

### B-6 · Constante exportada desde un módulo `"use server"` · **MEDIO**

`USER_SETTABLE_PREFERENCES` vivía junto a las server actions. Next.js solo permite exportar funciones async desde ahí, así que al cliente le llegaba algo que no era un array: `USER_SETTABLE_PREFERENCES.map is not a function` y la pantalla de preferencias caía entera.

**Corregido**: la constante vive en `domain/nutrition/types.ts`.

### B-7 · Áreas táctiles bajo el mínimo cómodo · **BAJO**

Los chips de filtro medían 26 px de alto en móvil.

**Corregido**: 36 px (`py-2`) en las siete pantallas que los usan.

---

## Pruebas ejecutadas

### Motor de porciones

| # | Caso | Resultado |
|---|---|---|
| §1 | Caso base familiar, suma de componentes = totales | **PASS** — probado con 3 y 5 integrantes; la suma cuadra a 9 decimales |
| §2 | Tracking OFF: recibe porción, aparece en totales, sin kcal ni objetivos falsos | **PASS** |
| §3 | Tracking FULL: proteína 50–80 (ideal 65), kcal ≤ 800, ensalada no recortada | **PASS** — 65,0 g exactos, 584 kcal |
| §4 | Objetivo imposible (100 g proteína / 250 kcal) | **PASS** — `TARGET_CONFLICT` |
| §5 | Receta sin slot de proteína | **PASS** — conflicto declarado, el arroz **no** se infla |
| §6 | Receta sin carbohidrato | **PASS** — recorta lo que existe, no asume |
| §7 | Prefiere ensalada, receta sin ensalada | **PASS** — no inventa gramos ni razones |
| §8 | Aliño mixto (aceite + limón + hierbas) con `added_oil = AVOID` | **FALLÓ → corregido (B-3)** |
| §9 | Ocho alimentos contra la heurística | **FALLÓ → corregido (B-3)** |
| §10 | HARD con 1 g y con 400 g | **PASS** en dominio · **FALLÓ en la app → corregido (B-1)** |
| §11 | SOFT dislike | **PASS** en dominio · **FALLÓ en la app → corregido (B-1)** |
| §12 | Jerarquía global / categoría / ingrediente | **PASS** — salmón pochado, merluza air fryer, pollo al horno |
| §13 | Grasa personal: solo B incorpora el aceite | **PASS** — diferencia exacta del aceite |
| §14 | Excepción del día: 800 / 1000 / 800 | **PASS** — el patrón habitual no se toca |
| §15 | Zona horaria | **PASS** tras implementarlo — 22:30 del domingo en Santiago sigue siendo domingo |
| §16 | Cambio selectivo | **PASS** — Sebastián 235 → 321 g, Francisco intacto, total +86 g |
| §17 | Determinismo | **PASS** — 10 ejecuciones, una sola salida |
| §18 | Objetivo absurdo (500 g proteína) | **PASS** — respeta el máximo, declara conflicto |
| §19 | min/max al subir proteína y al recortar kcal | **PASS**; `FIXED` no se toca |
| §20 | Nutriente UNKNOWN | **PASS** — nunca 0; PARCIAL cuando corresponde |
| §21 | Versión de receta | **PASS** — la porción declara `versionId` |
| §22 | Versión de perfil | **PASS** — declara `profileVersion` y huella |
| §26 | Sustitución SOFT | **PASS** tras B-1 y B-2 — se propone, no se aplica sola |

### Base de datos

| # | Caso | Resultado |
|---|---|---|
| §23 | Hogar B no lee objetivos, preferencias, patrones, perfiles, porciones ni excepciones de A | **PASS** |
| §23 | B no puede escribir en el hogar de A | **PASS** |
| §27 | Un usuario no puede crear ni degradar una `MEDICAL_RESTRICTION` | **PASS** — trigger en la base, no solo en la UI |
| — | Perfil publicado es inmutable | **PASS** |
| — | Objetivo sin ningún número, o con rango invertido | **PASS** — rechazados |

> Durante esta QA un test de RLS dio un falso fallo: el bloque nuevo corría como `postgres`, y un superusuario **se salta la RLS por definición**. El test no probaba nada. Corregido volviendo a `authenticated`. Vale como recordatorio: un test de aislamiento que corre como superusuario siempre pasa.

### Interfaz

| # | Caso | Resultado |
|---|---|---|
| §24 | 320 / 375 / 430 px | **PASS** — cero desborde horizontal en las tres |
| §24 | Áreas táctiles | **FALLÓ → corregido (B-7)** |
| §25 | Errores silenciosos | **FALLÓ → corregido (B-4)**; quedan cero |
| §27 | UI de preferencias de alimentos y de preparación | **implementada** |
| §28 | UI de excepción de un día | **implementada** |
| §29 | Nombre del hogar ≠ nombre de la persona | **PASS** — campos y tablas distintos. Se agregó "Cambiar nombre", que no existía |

---

## Flujo verificado en la app real

Sobre "Pollo con arroz y ensalada chilena", hogar con cinco integrantes:

1. **Casa** (FULL, ayuno, sin grasa añadida, air fryer): pollo **255 g**, sin aceite, **con limón**, ensalada subida por preferencia, 584 kcal, **65 g de proteína** — su ideal exacto.
2. **Paula** y **Ricardo** (OFF): porción estándar, sin macros a la vista, con el texto "recibe su porción sin conteo de calorías".
3. **Constanza** (BASIC): estándar con macros.
4. **Sebastián** (BASIC, frito, acepta aceite): pollo **321 g** frito, 80 g de proteína.
5. **Totales**: pollo 1.155 g repartido en air fryer 255 · horno 540 · frito 360.
6. Al marcarle a Sebastián que no le gusta el pollo aparece **"Sugerencia: cambiar Pechuga de pollo por Merluza"** con botón *Aplicar*. Al aplicarlo: merluza **360 g** frita, 70,1 g de proteína, 621 kcal, y los totales pasan a **Pollo 795 g** + **Merluza 360 g**, con opción *Deshacer*.

---

## Deuda restante

1. **La proyección de porciones no se persiste.** Las tablas `member_serving_projections` y `member_serving_components` existen con RLS, pero la pantalla calcula al vuelo y no guarda. Para §46 completo (auditar "por qué se calculó así" meses después) falta escribirlas al confirmar una comida — cosa que llega con la planificación semanal.
2. **El rol de componente no se edita desde la UI de recetas.** Se declara en el seed y en el RPC; el formulario siempre manda `MAIN`. Una receta creada a mano no puede marcar su aceite como `ADDED_FAT`.
3. **Las alternativas de slot tampoco se crean desde la UI** (deuda que viene del Sprint 3). Sin alternativas no hay sugerencias de reemplazo en recetas propias.
4. **La sustitución vive en la URL, no en la base.** Funciona y es reproducible, pero se pierde al navegar. `MemberServingSubstitution` como tabla queda pendiente.
5. **`day_templates`** (NORMAL / TRAINING / LARGE_LUNCH…) existe en la base sin pantalla.
6. **Objetivos diarios de solo lectura**: se muestran, se editan únicamente los de comida.
7. **`Confirm email` sigue apagado** en Supabase. Hay que reactivarlo antes de que esto lo use gente real.
8. Quedó en el hogar de demostración un **"no me gusta el pollo" para Sebastián**, puesto para probar la sustitución. Se quita desde su pantalla de preferencias.

---

## Riesgos antes del Sprint 5

1. **El patrón `as unknown as` sobre filas de la base sigue vivo en otros puntos** (catálogo y recetas). B-1 demostró que convierte un error de forma en un fallo silencioso de seguridad. Vale una pasada de mapeo explícito antes de que el motor clínico dependa de esos datos.
2. **La suma familiar es el precursor del `ShoppingEngine`.** B-2 habría llegado directo a una lista de compras equivocada. Cuando exista el ShoppingEngine, cualquier error de agrupación se traduce en plata.
3. **Las porciones no persistidas** impiden auditar hacia atrás. Antes de que las decisiones de porción tengan consecuencias clínicas (Sprint 11), hay que poder reconstruir qué se calculó y con qué perfil.
4. **El diálogo destructivo de Supabase se confirmó solo dos veces** durante estos sprints. No es del proyecto sino del entorno, pero conviene aplicar migraciones desde un canal sin diálogos (CLI o CI) en vez del editor web.
5. **Cobertura de UI**: el motor tiene 138 tests; las pantallas, ninguno automatizado. Los tres bugs más graves de esta QA vivían justo en la costura entre base y UI, que es exactamente lo que ningún test cubre hoy.
