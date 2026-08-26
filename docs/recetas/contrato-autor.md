# Contrato del autor de recetas — biblioteca chilena

Este documento es la fuente de verdad para escribir recetas de los lotes C, D y E.
Cada regla acá está escrita porque algo se rompió: las marcadas **[LOTE B]** salieron
de los tres verificadores del lote anterior.

Lo que se está construyendo no es un recetario: es la entrada de un sistema que calcula
porciones por persona, nutrición, listas de compra y compatibilidad clínica. Un error en
una receta puede terminar en que el sistema declare compatible una comida que no lo es.

---

## 1 · La base física es obligatoria y tiene que EXISTIR

Cada componente declara `basis`, y esa base tiene que estar en el vocabulario para ese
alimento. Si no está, el generador de seed revienta con
`El alimento X no tiene ficha nutricional en base Y`.

Errores que se cometen siempre:

| se escribe | pero el catálogo solo tiene |
|---|---|
| `huevo de gallina` en RAW | EDIBLE_PORTION |
| `platano` en RAW | EDIBLE_PORTION |
| `palta` en RAW | EDIBLE_PORTION |
| `pan marraqueta` en AS_PACKAGED | EDIBLE_PORTION |
| `aceite de oliva` en RAW o en G | AS_PACKAGED **en ML** |
| `atun en conserva al agua` en RAW | DRAINED |

**[LOTE B]** Si declaras un alimento nuevo, declara también la base que tu receta le pide.
Si tu receta lo usa en RAW y quien escribe la ficha elige AS_PACKAGED, el seed se cae.

## 2 · La unidad sale de la ficha, no de la costumbre

Si el vocabulario dice `AS_PACKAGED (ML)`, el componente va en ML. Solo
`huevo de gallina` y `pan marraqueta` pueden ir en `UNIT`, porque son los únicos con
medida doméstica declarada.

## 3 · El rendimiento se declara SOLO donde se conoce

`yieldFactor` únicamente en: arroz 2.5, fideos 2.4, legumbres secas 2.4.

**Nunca en carnes, pescados ni verduras.** Su merma depende del corte, del fuego y del
tiempo. Omitir el campo significa DESCONOCIDO, que es la respuesta correcta y que el
sistema sabe manejar. Poner un número plausible es inventar.

## 4 · Roles

- `ADDED_FAT` → **solo** aceites añadidos (el `canonical_name` empieza con "aceite").
  La palta, la mantequilla, la manteca y las semillas son comida: van `MAIN`.
- `SEASONING` → sal, especias, hierbas, el limón como aliño. También el azúcar cuando
  es un espolvoreo. Si el azúcar **es** el plato (un postre), va `MAIN`.
- Todo lo demás, `MAIN`.

## 5 · **[LOTE B]** El aceite que se declara es el que se COME

El motor suma el 100 % de lo declarado. Si pones los 250 ml del baño de fritura, le
cargas ~340 kcal por persona a un plato que nadie se comió.

Declara el aceite **retenido** (merluza frita del LOTE A: 60 ml para 4 porciones) y
explica en el paso que en la sartén va mucho más. Lo mismo vale para el pan rallado y la
harina de un apanado: se declara lo que se pega, no lo que queda en el plato.

## 6 · Opcionales y límites

- `optional: true` ⟹ `adjustability: "OPTIONAL"`.
- `minQuantity <= quantity <= maxQuantity`.

## 7 · Equipamiento

Códigos válidos, y no hay otros: `STOVETOP`, `OVEN`, `AIR_FRYER`, `MICROWAVE`, `GRILL`,
`BLENDER`, `FOOD_PROCESSOR`, `POT`, `PAN`, `KNIFE`, `PRESSURE_COOKER`.

Siempre con `manualAlternative`. Y **[LOTE B]** dos cosas más:

- El paso con capacidad va **inmediatamente después del paso que sustituye**, redactado
  como sustitución explícita: *"En vez de freír en sartén: dora las escalopas en la air
  fryer…"*. Si va al final, quien siga la receta cocina dos veces.
- El tiempo del paso base es el del método **sin** el equipo. Si el zapallo toma 40
  minutos en olla común y 20 en olla a presión, el paso base dice 40.

## 8 · Notas de lote sin plazos

`batchPrepNotes` nunca dice "dura 3 días". Cuánto dura algo lo decide el motor de
seguridad con la fecha real del lote.

## 9 · Las etiquetas tienen que ser verdad

`RAPIDA` solo si `prepMinutes + cookMinutes <= 45`. Y los minutos declarados tienen que
cuadrar con la suma de los pasos de fuego (descontando lo que corre en paralelo).
**[LOTE B]** Si el plato toma 55 minutos, se le saca la etiqueta; no se le miente al reloj.

## 10 · Porciones base

`baseServings` es la preparación FAMILIAR normal: **4** para almuerzo o cena, **2** para
desayuno u once, **6** para un postre de olla. No es la porción de una persona.
**[LOTE B]** Una once declarada para 4 deforma la porción que ve el motor clínico, porque
`baseServings` es el divisor de toda la nutrición.

## 11 · **[LOTE B]** Las alternativas no pueden apuntar al mismo ingrediente

Una alternativa que reemplaza `pan marraqueta` por `pan marraqueta` es una operación nula
que igual se publica y se le muestra al usuario. Si lo que quieres es otro pan, declara
el alimento nuevo; si lo que quieres es más cantidad, usa `minQuantity`/`maxQuantity`.

Tampoco puede apuntar a un ingrediente que ya es componente **del mismo slot**: el motor
deja el slot duplicado.

## 12 · **[LOTE B]** Un `parallelGroup` de un solo miembro no dice nada

Si un paso lleva grupo, tiene que haber otro paso con el mismo grupo. Y los pasos de un
grupo tienen que poder correr **de verdad** al mismo tiempo: moler las papas no va en el
mismo grupo que cocerlas, porque depende de ellas.

## 13 · Porción comestible

Si el alimento nuevo se compra con hueso, cáscara o partes que no se comen, declara
`necesitaPorcionComestible: true`. **[LOTE B]** Sin ese factor, el ShoppingEngine no puede
convertir a cantidad de compra y la receta aparece como hueco en el registro acumulado.

Si el alimento se come entero (pan, harina, aceite), el factor es 1 y también hay que
declararlo: sin él el motor tampoco puede convertir.

## 14 · Nutrición: lo que no se sabe, no se escribe

Las fichas entran como `DEV_SEED`. Un nutriente que no puedes sostener **se omite**. En la
base, ausente significa DESCONOCIDO. Un 0 inventado en potasio haría que el sistema le
diga a alguien con restricción renal que un alimento cumple, cuando nadie lo sabe.

El único 0 legítimo es el derivable: el congrio no tiene fibra, el aceite no tiene proteína.

## 15 · Estilo

Español chileno neutro, **tuteo**. Nunca voseo argentino. Los pasos se escriben como le
hablarías a alguien en su cocina ("Sala las presas y dóralas"), no en infinitivo
("Salar las presas"). Las descripciones dicen qué **es** el plato y por qué alguien lo
cocinaría, en una o dos frases.

## 16 · Recetas anidadas

Una receta puede reutilizar otra en un slot (`nested`). Sirven los slugs de recetas ya
publicadas (`ensalada-chilena`, `ensalada-verde`) y los de cualquier receta de la
biblioteca, incluidos los de tu propio lote: el generador ordena la creación para que la
receta anidada exista primero.

El peso del componente anidado es el **peso total** de esa receta, no su número de
porciones: usa `servingsFactor` para pedir media ensalada (0.5) o dos (2).
