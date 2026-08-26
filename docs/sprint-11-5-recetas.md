# Sprint 11.5 — Biblioteca chilena de recetas

**Estado:** COMPLETO. 100 recetas en 5 lotes (A→E), integradas y verificadas.
**Fecha:** 2026-08-25 (cerrado)

---

## Qué se construyó

> El grueso de este documento describe el LOTE A, que fue la primera entrega y donde
> se fijaron las reglas. El cierre con las 100 recetas está al final.

Veinte recetas chilenas reales, cargadas como **entidades funcionales** de la
biblioteca global: no son texto ni fotos, son plantillas que todos los motores
que ya existían pueden usar sin ningún caso especial.

La decisión central del sprint fue **modelar la biblioteca como datos tipados en
TypeScript** (`web/src/domain/recipes/library/`) y **derivar el SQL** de ahí, en
vez de escribir el seed a mano.

El motivo no es estético. Una biblioteca de recetas no se rompe de golpe: se
degrada por acumulación silenciosa — un ingrediente escrito distinto, una
cantidad sin base física, un rendimiento inventado para que "cuadre". Con la
biblioteca como datos, esas reglas se ejecutan en cada commit
(`biblioteca.test.ts`, 30 guardianes) en vez de revisarse a ojo cada 100
recetas. Y el seed no puede separarse de la biblioteca, porque un test compara
el archivo commiteado con lo que produce el generador, byte a byte.

```
web/src/domain/recipes/library/
  types.ts       contrato tipado (base física, rol, ajustabilidad, corte, pasos)
  catalog.ts     61 alimentos nuevos + las identidades que YA existen
  lote-a.ts … lote-e.ts   las 100 recetas, 20 por lote
  seed.ts        generador: biblioteca → SQL
  index.ts       API pública
  biblioteca.test.ts   30 guardianes de calidad (§28-§31)

web/src/integration/
  recetas-lote-a.test.ts   15 canarios contra PostgreSQL real (§32-§35)

supabase/seed/dev_recipes_biblioteca.sql   ← GENERADO, no editar a mano
```

---

## Las 20 recetas

| # | Receta | Categoría | Porciones | Tiempo | Notas |
|---|---|---|---|---|---|
| 1 | Cazuela de pollo | Pollo | 4 | 70 min | olla única, alternativa a vacuno |
| 2 | Pollo arvejado | Pollo | 4 | 50 min | con arroz |
| 3 | Pollo al jugo con arroz | Pollo | 4 | 40 min | rápida |
| 4 | Pollo al horno con papas | Pollo | 4 | 70 min | una sola fuente |
| 5 | Cazuela de vacuno | Vacuno | 4 | 95 min | olla única |
| 6 | Carne mechada | Vacuno | 4 | 110 min | con puré; congela bien |
| 7 | Bistec con puré | Vacuno | 4 | 45 min | rápida |
| 8 | Reineta a la plancha con ensalada | Pescado | 4 | 37 min | anida Ensalada chilena |
| 9 | Merluza frita con arroz | Pescado | 4 | 40 min | anida Ensalada chilena |
| 10 | Pescado al horno con verduras | Pescado | 4 | 60 min | una sola fuente |
| 11 | Porotos con riendas | Legumbres | 4 | 105 min | olla a presión opcional |
| 12 | Porotos granados | Legumbres | 4 | 65 min | de temporada |
| 13 | Garbanzos guisados | Legumbres | 4 | 95 min | congela bien |
| 14 | Charquicán | Tradicional | 4 | 60 min | huevo frito opcional |
| 15 | Pastel de choclo | Tradicional | 4 | 85 min | procesadora opcional |
| 16 | Tortilla de verduras | Tradicional | 4 | 35 min | sirve de once |
| 17 | Avena con leche y plátano | Desayuno/once | 2 | 11 min | |
| 18 | Once con quesillo y palta | Desayuno/once | 2 | 6 min | sin cocción |
| 19 | Ensalada de atún con papas y huevo | Ensalada | 4 | 40 min | plato completo frío |
| 20 | Arroz con leche | Postre | 6 | 50 min | |

Ninguna repite las 9 que la base ya tenía. Un guardián lo verifica normalizando
acentos, así que "Ensalada Chilena" tampoco pasaría.

---

## Reglas que gobiernan el lote

### La base física es obligatoria y explícita (§7)

Cada cantidad declara en qué estado está el alimento: `RAW`, `COOKED`,
`DRAINED`, `EDIBLE_PORTION`, `AS_PACKAGED`. "100 g de arroz" no significa nada
por sí solo. El atún de lata se declara `DRAINED` porque así se usa; la palta,
`EDIBLE_PORTION` porque el cuesco no se come.

El generador **falla ruidosamente** si un alimento no tiene ficha para la base
que la receta pide. Esa validación encontró un defecto preexistente (ver abajo).

### El rendimiento se declara solo cuando se conoce (§18)

`yieldFactor` aparece en arroz (2,5), fideos (2,4) y legumbres secas (2,4).
**No aparece en ninguna carne.** La merma de un trutro depende del corte, del
fuego y del tiempo; poner 0,75 para que la tabla se vea completa es inventar.
Ausente significa desconocido, y el sistema ya sabe tratar lo desconocido.

Hay un guardián que falla si alguien le pone rendimiento a una carne.

### Lo que se cuenta por unidad conserva su forma (§28)

Nadie escribe "440 g de huevo" en una receta. La biblioteca dice **8 huevos**;
la base guarda 440 g para poder calcular **y además** `measure_count = 8` con su
`measure_id`, para poder mostrarlo como se dijo. Si un alimento se cuenta por
unidad y nadie declaró cuánto pesa una, el generador revienta en vez de suponer.

### ADDED_FAT es solo la grasa añadida (ADR 0004)

El optimizador puede quitar el chorro de aceite de la sartén. La palta del pan
es comida, aunque sea grasa, y no se puede borrar por preferencia. Un guardián
verifica que todo componente marcado `ADDED_FAT` sea efectivamente un aceite.

### El azúcar cambia de rol según el plato

En el arroz con leche el azúcar **es** el postre: `role: MAIN`, ajustable entre
40 y 120 g. En el pastel de choclo es un espolvoreo: `role: SEASONING`,
opcional, lo primero que sale si alguien tiene restricción de azúcar. La misma
sustancia, dos roles distintos, declarados.

### Nadie queda afuera por no tener un equipo (§13)

Cinco pasos mencionan equipamiento opcional (olla a presión ×3, air fryer,
procesadora). **Los cinco traen su alternativa manual**, verificado tanto en
TypeScript como con una consulta a la base.

Un sexto paso, el dorado final del pollo al horno, se escribió primero como
"capacidad GRILL_SUPERIOR". Se corrigió: el grill superior no es un equipo
aparte, es usar distinto el mismo horno. Declararlo como capacidad le habría
mentido al motor de equipamiento.

### Las notas de lote no prometen plazos (§25)

Ninguna nota de preparación por lotes dice "dura 3 días". Cuánto dura algo lo
decide el motor de seguridad con la fecha real del lote, no un texto escrito
hace meses. Un guardián lo verifica con expresión regular.

---

## La nutrición: qué es y qué no es

Las 28 fichas nuevas entran como `DEV_SEED`. Son valores de referencia
razonables para que los motores tengan con qué trabajar. **No son datos de una
tabla oficial chilena.**

Tres candados independientes sostienen eso:

1. La base tiene el constraint `nutrition_unverifiable_sources`, que impide
   marcar como `verified` cualquier ficha `DEV_SEED` o `AI_ESTIMATE`.
2. El `ClinicalRulesEngine` las trata con la misma desconfianza que a cualquier
   dato no oficial.
3. Un canario consulta la base y falla si alguna receta del lote apareciera con
   `frozen_source.verified = true`.

**Trabajo pendiente declarado:** curar estas 28 fichas contra la Tabla de
Composición Química de los Alimentos Chilenos (INTA, Universidad de Chile).
Hasta que eso ocurra, los números son de desarrollo y el sistema lo dice.

Un nutriente que no aparece en una ficha es **desconocido**, no cero. Por eso
varias fichas traen solo macronutrientes: es lo que se puede sostener sin
inventar. El canario 3 lo comprueba en el charquicán: la energía vuelve
`COMPLETE` y el fósforo vuelve `PARTIAL`, en vez de sumar los que se saben y
presentarlo como si fuera el total.

---

## Cambios de esquema que este lote hizo necesarios

Los dos son aditivos y ninguno toca datos existentes. Están congelados con
checksum en `docs/deployment/pending-supabase-migrations.md`.

### 0031 — el techo del rendimiento estaba en 2, y era falso

`meal_slot_components.yield_factor` traía `check (<= 2)` desde la 0003, con la
misma cota espejada en Zod. Es incorrecto para todos los alimentos que absorben
agua: arroz 2,5, fideos 2,4, legumbres secas 2,4.

El tope no era una barrera contra datos absurdos, era una afirmación falsa sobre
la cocina. Con él, la única forma de cargar arroz era mentir (poner 2) o
declarar como desconocido un rendimiento que sí se conoce. Se subió a 5 —sigue
rechazando un 25 o un 250 por tipeo— y se actualizó el Zod para que sigan
diciendo lo mismo.

### 0032 — faltaba la olla a presión

`equipment_capabilities` traía diez códigos y ninguno representa una olla a
presión. En la cocina chilena es la diferencia entre 60 y 25 minutos en
cualquier legumbre. Sin el código, las recetas de porotos y garbanzos tenían dos
salidas y las dos malas: mapearla a `POT` (mentir) o borrar el paso (esconderle
a quien sí la tiene que puede usarla).

---

## Cómo se agrega el LOTE B

1. Escribir las recetas en un archivo nuevo `lote-b.ts` con el mismo contrato.
2. Agregar los alimentos que falten a `INGREDIENTES_NUEVOS`.
3. Sumar el lote a `BIBLIOTECA` en `index.ts`.
4. Regenerar el seed: `REGENERAR_SEED=1 npx vitest run biblioteca`.
5. Los 30 guardianes y los 15 canarios corren solos.

Si alguno falla, el lote no entra. Ese es el punto.

---

# Cierre — las 100 recetas

| lote | recetas | alimentos nuevos | hallazgos de los verificadores | correcciones aplicadas |
|---|---|---|---|---|
| A | 20 | 28 | revisión manual | — |
| B | 20 | 10 | 51 | 30 |
| C | 20 | 9 | 41 | 19 |
| D | 20 | 5 | 50 | 10 |
| E | 20 | 9 | 42 | 5 |
| **total** | **100** | **61** | **184** | **64** |

**109 recetas publicadas** (100 de la biblioteca + 9 que ya existían) · **84 alimentos** en
catálogo · **748 tests** en verde · typecheck y lint limpios.

## Cómo se construyó

El plan de los 80 lo diseñaron seis miradas en paralelo (cocina de olla, semana apurada,
desayuno y once, cocina de campo, verduras y legumbres, dulce y domingo) y lo depuraron tres
críticos (repetición, autenticidad chilena, cobertura). De 98 propuestas quedaron 80 tras
fusionar 22 grupos de duplicados y eliminar los platos que no eran cocina chilena de casa.

Cada lote lo escribieron cuatro autores en paralelo contra
[el contrato del autor](recetas/contrato-autor.md), un nutricionista de datos escribió las
fichas de los alimentos nuevos, y tres verificadores adversariales revisaron desde ángulos
distintos: física de los datos, cocina real, integración con el sistema.

**El contrato creció con cada lote.** Las reglas marcadas `[LOTE B]` nacieron de lo que se
rompió ahí, y el efecto se ve en los números: el LOTE B tuvo 51 hallazgos y 30 correcciones;
el E, 42 y 5. Los lotes tardíos llegaron sin un solo problema de base física, identidad o
unidad — justo las tres cosas que revientan el seed.

## Los defectos que valieron el sprint

**Riesgo sanitario.** «Arroz con pollo» hervía el trutro con hueso 18 minutos: queda crudo
pegado al hueso. Ahora son 26, con señal de punto («se separa del hueso, el jugo sale claro»).
«Pollo frito» tenía el mismo problema: 22 minutos para dos tandas de presas con hueso.

**Proteína que no existía.** «Caldo de pollo casero» sacaba toda la carne y la mandaba a otra
receta. El sistema atribuía ~175 g de pollo por persona a cuatro platos de caldo colado.

**Aceite de fritura contado entero.** «Bistec a lo pobre» declaraba los 150 ml del baño:
~340 kcal por persona que nadie se comió. Criterio unificado: se declara el aceite RETENIDO.

**Un flan disfrazado de leche asada.** Horneada a baño maría a 160 °C hasta que el centro
temblara. La leche asada chilena va directo al horno a 180 °C hasta que la superficie se dora
y se ampolla — esa cara tostada es lo que le da el nombre.

**Un ceviche sin jugo.** 200 g de limón entero rinden ~75 ml; el paso exige cubrir 700 g de
pescado. El pescado se marinaba por arriba y quedaba crudo abajo.

**Sodio fantasma.** Las humitas declaraban la sal del agua de hervor, que se bota.

**Dos platos nombrados por un método opcional.** «Pollo a la parrilla» y «Anticuchos a la
parrilla» tenían el horno y la plancha como método base. Quien no tiene parrilla —la
mayoría— recibía un plato que no se parecía a su nombre.

## Defectos de infraestructura, míos

- **El guardián del seed generaba desde `LOTE_A`, no desde la biblioteca.** El LOTE B nunca
  llegó al SQL y el test pasaba feliz comparando el archivo viejo con la generación vieja. Un
  test que solo se compara consigo mismo no vigila nada.
- **`WEIGHT` donde el enum de la base dice `MASS`.** Viajó latente desde el LOTE A porque
  nadie usaba el campo, y reventó al cargar diez fichas de golpe.
- **El peso de una ensalada anidada era su número de porciones.** La ensalada chilena entraba
  pesando 4 gramos dentro del plato. Lo destapó el registro acumulado, no un test.
- **El registro no era reproducible**: los UUID aleatorios cambiaban el orden de un par.
- **La regla de los ceros duplicada en dos lenguajes** discrepó a la primera tanda: una copia
  rechazaba la fibra 0 de la mantequilla, que es un hecho.

## Cambios de esquema

| migración | qué hace | estado |
|---|---|---|
| `0031_yield_factor_bounds.sql` | tope de rendimiento de 2 → 5 | aplicada y verificada en producción |
| `0032_pressure_cooker_capability.sql` | agrega `PRESSURE_COOKER` | aplicada y verificada en producción |

Las dos aditivas. Verificadas consultando el esquema real, no confiando en el «OK» del script.

## Herramientas que quedan

| archivo | para qué |
|---|---|
| `docs/recetas/contrato-autor.md` | las 16 reglas, cada una con el defecto que la originó |
| `docs/recetas/vocabulario-catalogo.md` | generado desde la base: identidades válidas y sus bases físicas |
| `scripts/lote-desde-json.mjs` | JSON validado → TypeScript. Probado sin pérdida contra el LOTE A |
| `scripts/alimentos-desde-json.mjs` | fichas → catálogo |
| `scripts/integrar-lote.mjs` | integra un lote en un comando |
| `scripts/aplicar-migracion.mjs` | migraciones por Management API, con guardián de codificación |
