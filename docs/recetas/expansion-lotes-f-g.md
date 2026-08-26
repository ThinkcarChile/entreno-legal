# Expansión de contenido — lotes F y G (182 platos)

De 100 recetas tipadas a **282**. El lote F trae 126 platos y ensaladas
chilenas; el lote G, 56 postres. Con las 9 que ya vivían en la base, el catálogo
publicado queda en **291 recetas y 173 alimentos**.

Todo entra por el mismo camino de siempre —JSON validado → TypeScript →
guardianes → seed generado— así que nada de esto se escribió a mano en SQL.

---

## Lo que NO se escribió, y por qué

Dos platos de la lista quedaron fuera a propósito:

- **Reineta con salsa de alcaparras.** Contra la publicada "Reineta a la plancha
  con ensalada" el único cambio es la salsa: mismo pescado, misma plancha,
  mismos tiempos, misma guarnición. Publicarla sería un duplicado con otro
  nombre. Corresponde como componente opcional de la que ya existe.
- **Arrope de uvas.** No es un postre que alguien se sirva en un plato: es un
  jarabe para bañar otra cosa. Declararlo como postre de 6 porciones le
  entregaría al motor clínico una porción falsa de azúcar concentrada. Y la
  única fuente no publica cantidades: reconstruir la relación uva/rendimiento de
  memoria sería inventar justo la parte que más importa.

---

## Verificación: qué corrió y qué no

El lote se escribió con tres lentes de verificación en paralelo. **Dos murieron
por el tope de gasto mensual de la cuenta** (`You've hit your monthly spend
limit`), así que solo corrió la de cocina.

En vez de volver a pagarlas, las otras dos se resolvieron donde tenían que estar
desde el principio: **como código que se ejecuta**, no como opinión de un
verificador.

- La lente **física** (base física que exista, unidad que calce, rendimiento
  solo donde corresponde, límites min ≤ cantidad ≤ max) la ejecuta el propio
  seed contra un Postgres real: `pg_temp.fact_a` revienta nombrando el alimento
  y la base si una ficha no existe. Las 282 recetas aplican limpias.
- La lente de **integración** (roles, capacidades con alternativa manual, notas
  de lote sin plazos, RAPIDA de verdad rápida, alternativas sobre slots que
  existen, slugs únicos) son los guardianes de `biblioteca.test.ts`, que ya
  existían y ahora corren sobre 282 recetas en vez de 100.

Un test que se ejecuta es mejor verificador que un agente que opina, y no se
queda sin presupuesto.

### Lo que encontraron al correr sobre el lote nuevo

1. **Tres fichas huérfanas** (`ostiones`, `ravioles frescos`, `limon de pica`)
   que el separador de lotes había dejado fuera porque solo miraba los
   componentes. Aparecen como ALTERNATIVAS, que también piden identidad: una
   alternativa que apunta a un alimento inexistente es el mismo agujero.
2. **Un guardián equivocado.** "Toda alternativa se declara sobre un slot que la
   receta tiene" miraba solo `components` e ignoraba `nested`. Las empanadas
   fritas no declaran carne: la proteína entra por receta anidada. Acusaba de
   huérfana a una alternativa válida — y un test que enseña a ignorarlo es peor
   que no tenerlo.
3. **Cinco ceros defendibles** que la regla general rechazaba: la fibra 0 del
   vino, la cerveza y los destilados, y el azúcar 0 de la maicena. Salen de una
   fruta o de un grano, así que el catálogo los guarda en FRUITS/GRAINS y ahí la
   regla dice, con razón, que un vegetal sin fibra es sospechoso. Pero el sólido
   se quedó en el orujo: ese cero es un hecho medido. La excepción va por nombre
   y no por categoría, para que la fibra 0 de una harina integral siga siendo un
   hueco tapado.

---

## Ortografía: 29 recetas llegaron sin tildes

Dos de los agentes escribieron el español entero sin diacríticos: "azucar flor",
"Estirala fina", "coccion". No es un detalle de estilo — el texto lo lee una
familia chilena.

`scripts/tildes-desde-corpus.mjs` lo repara **usando como diccionario el propio
corpus**: las recetas que sí escriben bien, más las 100 ya publicadas. Si una
palabra aparece siempre acentuada, se restituye; si el corpus la escribe de las
dos formas ("si"/"sí", "mas"/"más", "esta"/"está"), es ambigua de verdad y NO se
toca. Adivinar ahí es cambiarle el sentido a la frase.

Tres cosas que costaron y valen la pena anotar:

- El umbral de quién ENSEÑA es la mediana entera, no la mitad. Con la mitad
  entraban al diccionario recetas medio reparadas de una corrida anterior, que
  arrastraban sus propias faltas y hacían que "azúcar" se vetara a sí misma para
  siempre.
- El veto va por PROPORCIÓN (90 %) y no por un conteo absoluto: tres deslices
  entre cuarenta no pueden vetar una palabra.
- La reparación se aplica a TODO el lote, no solo a las recetas malas. Una
  errata suelta vive justamente dentro de una receta que por lo demás escribe
  bien, y ahí sería intocable.

Quedan unas pocas palabras que no aparecen acentuadas en ninguna parte del
corpus; van en una lista revisada a mano dentro de
`scripts/correcciones-contenido-ad.mjs`.

---

## Correcciones de cocina: 41 cambios

Todas en `scripts/correcciones-contenido-ad.mjs`, cada una con su razón. El
script **revienta sin escribir nada** si un parche no calza: una corrección que
falla en silencio deja el registro diciendo que el problema está resuelto
mientras el plato sigue malo.

**Bloqueantes** (no se podían cocinar):

- **Churros** — 250 g de harina contra 500 ml de agua. La masa escaldada es 1:1;
  con el doble de agua sale un batido que jamás se despega de la olla ni se
  puede manguear.
- **Chupe de locos** — hervir locos crudos 25 minutos sin aporrearlos los deja
  como goma. La propia biblioteca lo desmentía: `locos-mayo` exige mazo y 45
  minutos.

**Altos:** el rebozado del pescado frito declarado en dos bases distintas; 1.100
g de láminas que no caben en una lata; y cuatro pasos de armado declarados en 0
minutos, que falseaban el total justo en el paso más largo.

**Identidades que se partieron** (el peor tipo de error de este lote, porque cada
nombre es una ficha nutricional propia, una línea propia en la lista de compra y
un alimento distinto para el motor clínico):

- `champinones` → `champinon`
- `pimienta negra molida` → `pimienta negra`
- `jugo de naranja` → retirado; el adobo usa `naranja` en porción comestible,
  como ya hacía otra receta del mismo lote

`camarones` y `camarones pelados` **se quedan separados**, revisado a propósito:
uno declara factor 0,55 desde el camarón con caparazón y cabeza, el otro 1 desde
la colita pelada. Fusionarlos haría que la lista de compra pidiera casi la mitad
de lo necesario.

---

## Lo que necesita una decisión de Francisco

Los cuatro huecos que el registro 8 muestra sin resolver. **Ninguno se rellenó
con un número inventado**, que es la regla:

| qué falta | recetas bloqueadas | valor conocido |
|---|---|---|
| porción comestible de `pan marraqueta` | 22 | el pan se come entero: el factor real es **1** |
| porción comestible de `yema de huevo` | 4 | un huevo de 55 g da ~18 g de yema → **0,33** |
| porción comestible de `clara de huevo` | 5 | un huevo de 55 g da ~33 g de clara → **0,60** |
| rendimiento de `quinoa` | 1 | absorbe parecido al arroz → **~2,7x** |

Los tres primeros no son invenciones: son aritmética sobre el huevo de 55 g que
`MEDIDAS_POR_UNIDAD` ya declara. Pero un factor equivocado hace mal la lista de
compra de esas recetas en silencio, así que se declaran como hueco y esperan
confirmación.

Y una decisión de receta: **los chilenitos** llevan cubierta de yema en vez del
merengue blanco de vitrina. Se dejó como está y la descripción ahora lo dice.
`clara de huevo` existe en el catálogo, así que cambiar a merengue es posible si
esa es la versión que corresponde.
