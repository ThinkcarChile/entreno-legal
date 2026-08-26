# QA — Sprint 11.5, LOTE A (20 recetas chilenas)

**Fecha:** 2026-08-25
**Veredicto:** LOTE A **PASS**. 736/736 tests del proyecto en verde, typecheck y
lint limpios. Quedan pendientes declarados, ninguno bloqueante para revisar el
lote.

---

## 1. Cobertura de pruebas

| Archivo | Tests | Qué prueba |
|---|---|---|
| `web/src/domain/recipes/library/biblioteca.test.ts` | 30 | los DATOS: base física, identidad, honestidad, unicidad, completeness, sincronía del seed |
| `web/src/integration/recetas-lote-a.test.ts` | 15 | las recetas DESPUÉS de viajar a un PostgreSQL real y volver, por los motores existentes |
| Suite completa | **736** | ninguna regresión en 49 archivos |

La distinción entre los dos archivos importa. Los guardianes revisan la
biblioteca como dato en TypeScript. Los canarios revisan otra cosa: que esas
recetas sigan funcionando después de pasar por la base. Una receta puede ser
impecable como dato y romperse igual en el viaje — y de hecho eso pasó cuatro
veces durante este sprint.

### Los 15 canarios (§32-§35)

| # | Canario | Qué protege |
|---|---|---|
| 1 | Las 20 llegaron enteras | publicadas y vigentes; sin borradores huérfanos |
| 2 | Nutrición congelada con su fuente | ningún componente publicado sin ficha ni procedencia |
| 2b | Nada se presenta como verificado | `frozen_source.verified` falso en todo el lote |
| 3 | El motor de nutrición calcula | cazuela: porción en rango humano, total = 4 × porción |
| 3b | Desconocido llega como desconocido | charquicán: energía `COMPLETE`, fósforo `PARTIAL` |
| 4 | El rendimiento 2,5 sobrevivió | imposible antes de la 0031 |
| 4b | Las carnes vuelven con rendimiento NULL | no se rellena con 1 |
| 5 | Lo contado por unidad conserva su forma | 440 g **y** `measure_count = 8` |
| 6 | Las ensaladas anidadas son reales | apunta a una versión publicada, no a un texto |
| 7 | Equipamiento opcional con salida manual | consulta a la base, no solo al TypeScript |
| 7b | La olla a presión es opcional, nunca requerida | |
| 8 | Escalar 4 → 7 no deforma | proporción exacta; nutrición recalculada, no multiplicada |
| 9 (§34) | Una olla, porciones distintas | tres perfiles reales dan tres proteínas distintas |
| 10 (§35) | Alternativa culinaria ≠ equivalencia nutricional | reineta → salmón recalcula desde cero |

---

## 2. Defectos encontrados y corregidos

### D-1 · Identidades duplicadas (mío, atrapado antes de aplicar)

Escribí fichas nuevas para `papa`, `fideos`, `limon` y `cilantro fresco` sin
revisar que `dev_recipes_seed.sql` ya crea `papa`, `fideos`, `limon` y
`cilantro`. Cuatro identidades duplicadas para el mismo alimento — con dos
stocks, dos precios y dos historiales que no vuelven a juntarse nunca.

Lo peor era `cilantro fresco`: como el nombre difería, ningún constraint lo
habría rechazado. Habría entrado limpio y roto en silencio.

**Corregido:** las cuatro salieron de `INGREDIENTES_NUEVOS`; se agregó
`INGREDIENTES_EXISTENTES` como lista contra la que resolver, y un guardián que
falla si un alimento nuevo choca con uno existente.

### D-2 · Tres componentes de las recetas demo publicados SIN nutrición (preexistente)

El canario 2 encontró que `dev_recipes_seed.sql` pedía bases físicas que no
existen en el catálogo:

| Componente | Pedía | Existe |
|---|---|---|
| `pan marraqueta` en "Pan con huevo y tomate" | `AS_PACKAGED` | `EDIBLE_PORTION` |
| `palta` en "Pan con huevo y tomate" | `RAW` | `EDIBLE_PORTION` |
| `platano` en "Yogur con arándanos y plátano" | `RAW` | `EDIBLE_PORTION` |

El helper `pg_temp.comp` aceptaba el `NULL` en silencio, así que los tres
componentes quedaron publicados con `nutrition_fact_id` nulo. Dos recetas demo
que el usuario ve tenían nutrición incompleta y nadie se enteró en tres sprints.

El motor de nutrición se comportó bien (devuelve `UNKNOWN`, no cero), así que
no era una falsa seguridad clínica — pero sí volvía esas recetas inservibles
para cualquier meta nutricional.

**Corregido:** las tres bases y, sobre todo, **la causa raíz**: el helper ahora
lanza excepción si no encuentra ficha. Un componente sin base resoluble es una
cantidad sin significado.

### D-3 · El techo del rendimiento negaba la cocina

Ver §3. Migración 0031.

### D-4 · La olla a presión no existía

Ver §3. Migración 0032.

### D-5 · Errores míos en los canarios (no en el sistema)

Tres canarios fallaron por leer mal la API del dominio, no por defectos del
código bajo prueba:

- `perServing.unknown` no existe; la incompletitud vive en
  `perServing.completeness` como `COMPLETE | PARTIAL | UNKNOWN`.
- El escalado deja la cantidad escalada en `quantity` y la original en
  `baseQuantity`; no hay `scaledQuantity`.
- La porción servida está en `proposedQuantity`, no en `quantity` — por eso el
  canario 9 veía tres porciones idénticas cuando el optimizador estaba
  funcionando bien.

Corregidos los tres. Vale la pena registrarlos: el primer diagnóstico de un
canario rojo no siempre es "el sistema está mal".

---

## 3. Cambios de esquema (aditivos, congelados con checksum)

| Migración | Qué hace | Destructiva |
|---|---|---|
| `0031_yield_factor_bounds.sql` | tope de `yield_factor` y `total_yield_factor` de 2 → 5 | no |
| `0032_pressure_cooker_capability.sql` | agrega `PRESSURE_COOKER` a `equipment_capabilities` | no |

Ambas verificadas contra un PostgreSQL real antes de entregarse. La 0031 se
espejó en Zod (`web/src/domain/recipes/schemas.ts`) para que la base y el
dominio sigan diciendo lo mismo.

**Sin la 0031, el seed del LOTE A rebota.** El orden es 0031 → 0032 → seed.

---

## 4. Alimentos nuevos (28)

Todos genéricos (§16): la receta dice "posta negra", no "posta marca X".

**Carnes (4):** pollo trutro entero con piel · carne molida de vacuno · vacuno
posta negra · vacuno asiento
**Pescado (2):** reineta · atún en conserva al agua (base `DRAINED`)
**Legumbres (4):** porotos secos · porotos granados frescos · garbanzos secos ·
arvejas frescas
**Verduras (9):** zapallo camote · choclo en grano · poroto verde · zapallo
italiano · pimiento rojo · ajo · perejil · albahaca · (cilantro ya existía)
**Despensa (9):** aceite vegetal · harina de trigo · leche entera · quesillo ·
azúcar · sal · ají de color · comino · orégano · canela

Cuatro traen `edible_portion_factor` declarado (trutro 0,70; papa —ya existente—
sin factor; zapallo 0,75; pimiento 0,82; ajo 0,87), porque lo que se compra no
es lo que se come.

---

## 5. Problemas de catálogo detectados (no corregidos: son decisión tuya)

Estos los encontré al cargar el lote. No los toqué porque cambian datos que ya
existen.

| # | Problema | Impacto |
|---|---|---|
| C-1 | `papa` no tiene `edible_portion_factor`. Se pela: se compra ~15 % más de lo que se come. | La lista de compras pide de menos en toda receta con papa. |
| C-2 | `limon` no tiene `edible_portion_factor`. Se usa el jugo (~45 % de la fruta). | Igual que C-1, más marcado. |
| C-3 | `pan marraqueta` no tenía medida "unidad". La creé en el seed (100 g) porque el lote la necesita. | Verificar que 100 g sea la marraqueta que ustedes compran. |
| C-4 | Solo `arroz blanco`, `lentejas` y `pechuga de pollo` tienen ficha `COOKED` además de `RAW`. El resto solo tiene una base. | Limita las recetas que pueden expresar cantidades en cocido. |
| C-5 | Las 28 fichas nuevas son `DEV_SEED`, sin curar contra la tabla del INTA. | Los números son de desarrollo, y el sistema lo declara en todas partes. |

---

## 6. Completeness del LOTE A

| Dimensión | Estado |
|---|---|
| Reparto pedido (4/3/3/3/3/2/1/1) | ✅ exacto |
| Sin repetir las 9 existentes | ✅ verificado normalizando acentos |
| Base física en todo componente | ✅ 218 componentes |
| Identidad resuelta | ✅ 100 % contra el catálogo real |
| Rendimiento solo donde se conoce | ✅ ninguna carne lo declara |
| Alternativas culinarias | 8 declaradas, todas sobre slots que existen |
| Recetas anidadas | 2 (Ensalada chilena en reineta y merluza) |
| Pasos con equipo opcional | 5, **todos** con alternativa manual |
| Notas de lote sin plazos de seguridad | ✅ |
| Nutrición presentada como verificada | ✅ ninguna |

---

## 7. Lo que NO se hizo

- **Curar la nutrición contra el INTA.** Es el pendiente grande. Las 28 fichas
  son `DEV_SEED` y el sistema lo declara en cada superficie.
- **Los 80 restantes.** El director pidió entregar el LOTE A antes de seguir.
- **Corregir C-1 y C-2.** Cambian datos existentes; queda a tu decisión.
- **Fotos de las recetas.** No estaban en el alcance del sprint.
- **Aplicar 0031 y 0032 al Supabase remoto.** Requieren tus manos (o el token
  de Management API, que sigue sin aparecer en `web/.env.local`).

---

## 8. Verificación reproducible

```bash
cd web
npx vitest run src/domain/recipes/library/biblioteca.test.ts   # 30 guardianes
npx vitest run src/integration/recetas-lote-a.test.ts          # 15 canarios
npx vitest run                                                  # 736 tests
npm run typecheck && npm run lint
```

Para regenerar el seed después de tocar la biblioteca:

```bash
REGENERAR_SEED=1 npx vitest run src/domain/recipes/library/biblioteca.test.ts
```
