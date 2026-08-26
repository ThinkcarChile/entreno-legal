# Auditoría de expansión de contenido — biblioteca de recetas

**Fecha de la auditoría:** 2026-08-25
**Estado:** propuesta para aprobación. **NO se ha insertado nada.**
**Alcance:** contenido. No se toca ninguna migración ni ningún motor.

Este informe responde las doce preguntas del director en orden. Al final está la
declaración honesta de qué fuentes no se pudieron leer.

---

## Nota de método (léela antes que las tablas)

Esta pasada tiene dos capas y conviene no confundirlas:

1. **Capa heredada.** Seis lectores de fuente recorrieron gourmet.cl, recetasnestle.cl,
   trekkingchile.com, cookpad.com/cl, tanta.cl y queresto.com (Casa China) y reportaron
   404 platos con procedencia. Las cantidades y tiempos que aparecen más abajo vienen de
   esos lectores.
2. **Capa verificada por mí hoy.** Volví a abrir una muestra de fuentes con acceso web
   real para comprobar que la capa heredada no estuviera inventada, y en particular para
   resolver las fichas marcadas como "no abiertas". Lo que verifiqué está marcado
   ✅ **VERIFICADO HOY**. Lo que no volví a abrir queda como reporte heredado.

**Tres cosas cambiaron con la verificación de hoy** y están explicadas en la sección L:
la carta de Tanta no es legible, tres fichas dadas por perdidas sí abren, y una de ellas
no era lo que se creía.

---

## A. Número REAL de recetas actuales

**109 recetas publicadas** y **84 alimentos** en catálogo, según
`docs/recetas/vocabulario-catalogo.md`, que leí completo.

Ahora bien, 109 es el conteo de filas, no el de platos distintos. Al canonicalizar
(normalizando acentos, mayúsculas, plurales y artículos) aparecen **8 solapes internos**,
de los cuales **2 son duplicados fuertes**. Ver sección H.

| Medida | Cantidad |
|---|---|
| Filas publicadas | 109 |
| Duplicados fuertes detectados | 2 |
| **Platos realmente distintos (estimado)** | **107** |
| Solapes medios/por revisar | 6 |
| Alimentos en catálogo | 84 |
| Capacidades de equipamiento | 11 |

**Dato accionable:** hay **5 recetas de pollo al horno o adobado** entre las 109. Esa
familia está inflada y es el mejor lugar para ganar espacio antes de sumar nada.

---

## B. Listado actual canonicalizado

Las 109 filas, agrupadas por familia y con el nombre canónico normalizado. La marca 🔁
señala filas que colapsan entre sí (detalle en H).

**Sopas, caldos y cazuelas (12)**
Ajiaco · Caldillo de huevo · Caldillo de merluza · Caldo de pollo casero 🔁 ·
Carbonada · Cazuela de pollo · Cazuela de vacuno · Crema de zapallo · Chupe de pescado ·
Pantrucas · Sopa de arvejas partidas · Sopa de pollo con fideos 🔁 · Sopa de verduras con fideos

**Legumbres (9)**
Arvejas frescas guisadas con huevo · Garbanzos con longaniza · Garbanzos guisados ·
Lentejas guisadas · Porotos con longaniza · Porotos con mazamorra 🔁 · Porotos con riendas ·
Porotos granados 🔁 · Guiso de porotos verdes con papas y huevo

**Vacuno (10)**
Albóndigas en salsa de tomate · Anticuchos de posta con cebolla y pimiento ·
Asado de tira a la parrilla con ensalada chilena · Bistec a lo pobre · Bistec con puré 🔁 ·
Carne magra con papas y ensalada 🔁 · Carne mechada · Niños envueltos ·
Pino de carne para congelar · Tomaticán

**Cerdo y embutidos (3)**
Arrollado de huaso · Chuletas de cerdo a la plancha con puré · Costillar de cerdo al horno con papas

**Pollo (13)**
Alitas de pollo al horno con papas · Arroz con pollo 🔁 · Escalopas de pollo apanadas con puré ·
Pasta con pollo · Pechuga a la plancha con dos ensaladas · Pollo adobado al horno con ensalada chilena 🔁 ·
Pollo al horno con papas 🔁 · Pollo al horno con tomate y cebolla 🔁 · Pollo al jugo con arroz ·
Pollo arvejado · Pollo cocido desmenuzado · Pollo con arroz y ensalada chilena 🔁 ·
Pollo frito con papas fritas · Pollo guisado con choclo y zapallo italiano · Pollo salteado con verduras y arroz

**Pescados y mariscos (11)**
Arroz con choritos · Ceviche de reineta · Choritos al vapor con limón · Ensalada de atún con papas y huevo ·
Fideos con atún · Merluza con arroz y ensalada verde 🔁 · Merluza frita con arroz 🔁 · Paila marina ·
Pescado al horno con verduras 🔁 · Reineta a la plancha con ensalada · Reineta apanada con puré ·
Salmón a la plancha con arroz · Salmón al horno con papas 🔁 · Sándwich de atún con cebolla

**Verduras, papas y choclo (10)**
Budín de zapallo italiano al horno · Charquicán · Cochayuyo guisado con papas · Humitas ·
Milcao · Pastel de choclo · Pastel de papas · Tortilla de papas · Tortilla de verduras ·
Zapallo italiano guisado con carne molida

**Ensaladas (10)**
Ensalada chilena · Ensalada de betarraga con cebolla · Ensalada de choclo con tomate y albahaca ·
Ensalada de garbanzos con huevo y tomate · Ensalada de pollo con papas y arvejas ·
Ensalada de porotos con cebolla y huevo · Ensalada de repollo con zanahoria · Ensalada rusa ·
Ensalada surtida de papa, betarraga y huevo · Ensalada verde

**Pastas y salsas (4)**
Salsa de tomate casera en tanda · Tallarines con salsa de carne molida · Tallarines con salsa de tomate · Pebre

**Masas, panes y sánguches (9)**
Empanadas de pino al horno · Hamburguesas caseras en marraqueta · Pan amasado ·
Sandwich de ave palta · Churrasco con tomate y palta · Sopaipillas · Sopaipillas pasadas ·
Guatitas a la jardinera

**Desayuno, once y postres (11)**
Arroz con leche · Avena con leche y plátano · Budín de pan · Huevo a la copa con marraqueta ·
Huevos revueltos con pan · Leche asada · Mote con huesillo · Once con quesillo y palta ·
Pan con huevo y tomate · Panqueques con manjar · Queque casero de naranja · Yogur con arándanos y plátano

**Canonicalizaciones que ya apliqué al comparar:** "Porotos con Rienda" = "Porotos con
Riendas"; "fideos" = "tallarines"; "mechada" = "desmechada"; "cazuela de osobuco" =
"cazuela de vacuno" (cambio de corte, no de receta); "pastel de papa" = "pastel de papas".

---

## C. Todos los platos nuevos encontrados, por fuente

Resumen por fuente. El detalle plato por plato con procedencia va en la matriz de la
sección G y en la sección L.

| Fuente | Tipo | Platos leídos | Publica cantidades | Publica porciones | Publica tiempo | Candidatos caseros que aportó |
|---|---|---|---|---|---|---|
| gourmet.cl | Recetario de marca | ~150 | Sí | Sí | Sí | 62 |
| recetasnestle.cl | Recetario de marca | ~120 | Sí | Sí | Sí | 55 |
| cookpad.com/cl | Recetario de usuarios | ~35 | Sí | Sí | Parcial | 21 |
| trekkingchile.com | Divulgación + cocina outdoor | ~55 | Solo en la sección outdoor | Solo outdoor | Casi nunca | 17 |
| tanta.cl | Carta de restaurante | ~62 (heredado, ver L) | No | No | No | 0 caseros |
| queresto.com (Casa China ×2) | Carta de restaurante | ~110 | No | No | No | 2 caseros |

**Salados nuevos por familia** (candidatos caseros, ya deduplicados):

| Familia | Candidatos | Ejemplos |
|---|---|---|
| Sopas, caldos, cazuelas | 12 | Caldillo de congrio, Cazuela de albóndigas, Cazuela de cerdo, Valdiviano, Menestrón, Sopa de choclo, Crema de zanahoria, Chairo |
| Legumbres | 5 | Porotos con mote, Garbanzos con arroz, Lentejas con arroz, Ensalada de porotos granados |
| Carnes de vacuno | 8 | Carne al jugo, Plateada, Malaya rellena, Asado alemán, Chorrillana |
| Cerdo y embutidos | 6 | Fricasé de cerdo, Prietas con papas, Pernil, Chuletas al jugo, Costillar a la parrilla |
| Pescados y mariscos | 12 | Pastel de jaiba, Chupe de mariscos, Curanto en olla, Machas a la parmesana, Camarones al pil pil, Budín de atún |
| Verduras, papas, choclo | 11 | Guiso de acelga, Pastelera de choclo, Papas rellenas, Puré de betarraga, Papas duquesas, Papas con chuchoca |
| Masas saladas y panes | 11 | Churrascas, Empanadas fritas de pino y de queso, Masa de empanadas, Pan de huevo, Pan de completo, Marraqueta casera |
| Sánguches y picoteo | 6 | Barros Luco, Chacarero, Palta reina, Pichanga fría |
| Acompañamientos | 5 | Arroz graneado a la chilena, Arroz árabe, Arroz con crema de choclo |
| Salsas frías | 1 | Chancho en piedra |

**Total salados nuevos deduplicados: 77.**

---

## D. Todos los postres nuevos

**Total dulces nuevos deduplicados: 33.** Ninguno lleva etiqueta de salud (regla 7).

| Postre | Clasificación | Prioridad | Procedencias | Alimentos nuevos | Nota |
|---|---|---|---|---|---|
| Calzones rotos | NUEVA | P0 | 4 | azúcar flor | ✅ Verificado hoy: 30 porciones, 60 min. El aguardiente se omite |
| Empolvados | NUEVA | P0 | 4 | azúcar flor | La ficha de gourmet usa mezcla lista de marca: hay que rehacer el bizcocho |
| Brazo de reina | NUEVA | P0 | 2 | azúcar flor | Mejor relación esfuerzo/resultado: 40 min |
| Leche nevada | NUEVA | P0 | 2 | maicena, vainilla | Distinta de leche asada: merengue pochado |
| Sémola con leche | NUEVA | P0 | 2 | sémola | Complementa arroz con leche |
| Manzanas asadas | NUEVA | P0 | 2 | ninguno | 3 ingredientes, todos en catálogo. El postre más barato de la tanda |
| Kuchen de fruta | NUEVA | P1 | 2 | levadura o polvos, fruta según variante | Un candidato, no cinco: la fruta es variable |
| Chilenitos | NUEVA | P1 | 4 | pisco o vinagre, margarina | "Alfajores chilenos con merengue" es el MISMO plato |
| Picarones | VARIANTE de Sopaipillas pasadas | P1 | 3 | levadura, maicena, clavo de olor | Comparten almíbar; la masa del picarón leuda |
| Flan de manjar | VARIANTE de Leche asada | P1 | 1 | ninguno | 4 ingredientes, los 4 en catálogo |
| Pastel de manzana | NUEVA | P1 | 1 | ninguno | Solapa con Kuchen: aprobar UNO |
| Alfajores de maicena | NUEVA | P2 | 2 | maicena, azúcar flor | ✅ Verificado hoy: 25 unidades, 67 min. Distinto de chilenitos |
| Torta mil hojas | NUEVA | P2 | 2 | nueces (opcional) | Trabajo real ~3 h, el resto es frío. Ninguna torta en las 109 |
| Cocadas | NUEVA | P2 | 2 | coco rallado, leche condensada | Caso legítimo de la regla 6: la condensada es material |
| Berlines con crema pastelera | NUEVA | P2 | 2 | levadura | Canonizar el frito; el horneado va como nota |
| Pan de Pascua | NUEVA | P2 | 3 | nueces, almendras, fruta confitada, miel, clavo | Estacional pero obligatorio |
| Queque de plátano y nuez | VARIANTE de Queque de naranja | P2 | 1 | nueces (opcional) | El plátano cambia la estructura, no solo el sabor |
| Kuchen sureño de frutilla | VARIANTE de Kuchen | P3 | 1 | frutilla | Recomiendo colapsar en Kuchen con dos rellenos |
| Pajaritos | NUEVA | P3 | 2 | azúcar flor, margarina | ⚠️ Las dos fuentes describen dulces DISTINTOS. Elegir la galleta |
| Postre de manzana con merengue | NUEVA | P3 | 1 | ninguno | Solapa con Manzanas asadas |
| Pie de mote con huesillo | NUEVA | P3 | 1 | galletas, almendras, maicena | No es duplicado de Mote con huesillo: uno es bebida, otro tarta |
| Torta de piña | NUEVA | P3 | 1 | piña en conserva, crema | La torta de cumpleaños más común |
| Torta tres leches | NUEVA | P3 | 2 | leche evaporada, condensada, crema | Caso legítimo de regla 6: sin los tres, no es tres leches |
| Tortas curicanas | NUEVA | P4 | 2 | vino o vinagre, nueces, azúcar flor | Regional del Maule |
| Cuchuflís con manjar | NUEVA | P4 | 1 | azúcar flor, chocolate | ⚠️ Destreza real: enrollar en caliente |
| Torta de cuchuflí | NUEVA | P4 | 1 | por confirmar | Ficha no abierta |
| Calugas de manjar y nuez | NUEVA | P4 | 2 | nueces | ⚠️ Lleva huevo crudo: hay que rehacer el método o descartarla |
| Prestigio casero | NUEVA | P4 | 1 | coco, condensada, chocolate | 4 ingredientes, 20 min, sin horno |
| Chumbeque | NUEVA | P4 | 1 | miel, sésamo | Único dulce NORTINO de las seis fuentes |
| Torta merengue lúcuma | NUEVA | P4 | 1 | puré de lúcuma, crema | Sin reemplazo posible |
| Cachitos de manjar | NUEVA | P4 | 1 | chocolate cobertura | Misma masa que chilenitos, otro formato |
| Dulce de membrillo | NUEVA | P4 | 1 | membrillo | ⚠️ La fuente lo etiqueta Española, no chilena |
| Helado de mote con huesillo | NUEVA | P4 | 1 | por confirmar | Ficha no abierta |
| Rollos de canela | NUEVA | P4 | 1 | levadura, azúcar rubia | No es cocina chilena |
| Torta de hojarasca | VARIANTE de Mil hojas | P4 | 2 | — | ⚠️ La fuente hierve tarros CERRADOS: no se replica |

**Dulces que recomiendo DESCARTAR:** Crema volteada (es el flan otra vez), Queque de
vainilla (cambio de saborizante), Pan dulce casero (SEO genérico), Turrón de vino tinto
(clara cruda + alcohol), Panqueque desgarrado (variante y no es chileno).

---

## E. Todos los platos de Tanta

⚠️ **Acá tengo que ser franco: no pude leer la carta de Tanta.**

`https://tanta.cl/cartaqr/` **es una galería de imágenes.** La página no contiene texto:
son 6 archivos de imagen con la carta fotografiada. Un lector de texto no puede
extraer de ahí ni un solo nombre de plato de forma confiable. Lo verifiqué hoy y el
resultado fue explícito: la página no entrega nombres, ingredientes ni porciones.

Busqué una alternativa y encontré `lacarta.pro/tanta`, que **sí** publica texto — pero
al abrirla resultó ser **la carta de Tanta PERÚ**, no la chilena. Los platos coinciden
en parte, pero no es la misma carta y no puedo hacerlas pasar por lo mismo.

**Lo que sí puedo afirmar con procedencia verificada hoy:**

| Plato | Fuente verificada | Sección | ¿Publica cantidades? |
|---|---|---|---|
| Lomo Saltado | lacarta.pro/tanta (Perú) + búsqueda de precios Chile | Platos principales | No |
| Ají de Gallina | lacarta.pro/tanta (Perú) + búsqueda de precios Chile | Platos principales | No |
| Cebiche Clásico | lacarta.pro/tanta (Perú) | Piqueos | No |
| Causa Peruana (pollo / langostinos) | lacarta.pro/tanta (Perú) | Piqueos | No |
| Crema de Zapallo | lacarta.pro/tanta (Perú) | Sopas | No |
| Tacu Tacu a lo Pobre | lacarta.pro/tanta (Perú) | Platos principales | No |
| El Asado de la Abuela | lacarta.pro/tanta (Perú) | Platos principales | No |
| Seco de Res | lacarta.pro/tanta (Perú) | Platos principales | No |
| Tallarines Saltados Criollos al Wok | lacarta.pro/tanta (Perú) | Pastas | No |
| Ravioles de Asado | lacarta.pro/tanta (Perú) | Pastas | No |
| Suprema de Pollo Maryland | lacarta.pro/tanta (Perú) | Platos principales | No |
| Ensaladas Barranco / Nikkei / Tanta / Cobb | lacarta.pro/tanta (Perú) | Ensaladas | No |
| Rocoto Relleno, Tamalitos, Papa a la Huancaína, Tequeños, Tanta Wings, Salchipapa | lacarta.pro/tanta (Perú) | Piqueos | No |

**Lo que la capa heredada reportó y yo NO pude confirmar:** una lista de ~62 platos
atribuida a `tanta.cl/cartaqr` (menestrón, suspiro limeño, crema volteada, chorrillana de
salmón, los 8 hot rolls, la pastelería de vitrina, etc.). No digo que sea falsa; digo que
**no es verificable con las herramientas de esta pasada** y por lo tanto **no la doy por
buena**.

**Recomendación al director sobre Tanta:**
1. **No sembrar nada de Tanta en esta tanda.** Ni siquiera en el catálogo separado.
2. Si te interesa el catálogo de restaurante peruano, la vía honesta es que alguien
   transcriba las imágenes de `tanta.cl/cartaqr` a mano, o usar la carta de Uber Eats /
   Rappi de una sucursal chilena, que sí publica texto y precios.
3. **Lomo saltado** es el candidato #1 si alguna vez abres cocina peruana casera —
   pero la receta habría que sacarla de un recetario, no de una carta.

---

## F. Todos los platos de Casa China

✅ **Verificado hoy en las dos sucursales.** `queresto.com/CASACHINA` (La Florida) y
`queresto.com/casachinapuentealto` (Puente Alto) sí publican texto, con descripción
corta por plato. **Ninguno publica cantidades, gramajes ni porciones.**

| Grupo | Líneas aprox. | Contenido | Notas de canonicalización |
|---|---|---|---|
| Entradas y frituras | 12 | Wantán frito, arrollado jamón-queso, arrollado de queso, arrollado primavera, camarón mandarín, empanadas de pollo mandarín, copa de oro, ají hunán, suimay, arrollado de mariscos, papas fritas, papas con nuggets | ✅ Ají hunán confirmado en Puente Alto como "pasta de pescado frito con ají". La descripción difiere entre sucursales |
| Sopas | 5 | Wantán, especial, hanchón, mariscos, fuchifú | ⚠️ "Sopa fuchifú" aparece en La Florida y NO en Puente Alto. Sin descripción publicada: no inventé qué lleva |
| Arroces y fideos | 27 | Chaufán, chaufán especial, chaufán veggie, arroz blanco, chaumín ×5, tallarines ×4, chaufansí, papo choy, chow fun ×4, diente de dragón ×5 | El "chaufansí" NO lleva arroz sino fideo de arroz. "Diente de dragón" es un brote que no está en los 84 |
| Salteados por proteína | ~35 | Matriz proteína (vacuno, pollo, cerdo, camarón, congrio) × salsa (mongoliano, tausí/sichiu, a la china, chitén, ajo, champiñón, cebollín, pekín, jengibre, piña, apanado) + costillar cantonés, calamar, camarón fuyón, 4 parrilladas | "Carne Tausí" = "Carne Sichiu" solo en vacuno; en pollo y camarón el sichiu suma ajo y cebolla morada. "Costillar cantonés" = "Costillar con piña". "Camarón apanado" = "Camarón chicharrón". ⚠️ Alérgeno declarado: la familia "chitén" lleva maní |
| Chapsui | 7 | Especial, carne, pollo, cerdo, camarón, congrio, verduras | ✅ "Chapsui de pollo" confirmado: "verduras salteadas con pollo". Se cruza con el candidato casero del mismo nombre |
| Sushi y promociones | ~14 | Nigiri, gyozas, california, avocado, sake, hot roll ×8, cheese, futomaki, especiales, sin arroz, handroll, gohan mixto, ceviche mixto, promo 40 piezas | La carta NO publica la composición de ningún roll. Los 8 hot rolls son nombres de fantasía sin descripción |
| Menús combinados | 8 | 2A/2B/3A/3B/4A/4B/5A/5B | NO son platos: son paquetes que referencian fichas ya listadas. Si se modelan, que sea como combo |
| Postres | ~13 | Torta de merengue (frambuesa/lúcuma), copa de merengue, banana split, crème brûlée, copa de helado, brownie con helado, café helado, celestino | ⚠️ **Corrección respecto de la capa heredada:** "Torta tres leches" y "Leche asada" NO aparecen en Puente Alto. La atribución heredada de esos dos ítems a Casa China no se sostuvo en la verificación |

**Total Casa China: ~110 líneas de carta.** Todas SOLO_RESTAURANTE.

**Los dos únicos platos de Casa China con contraparte casera real** son *Chapsui de
pollo* y *Arrollado primavera*, y en ambos casos la receta casera viene de otra fuente
(nestlé y cookpad respectivamente), **no de la carta**.

---

## G. Matriz EXISTE / VARIANTE / NUEVO / SOLO_RESTAURANTE

### Resumen

| Clasificación | Cantidad | Qué significa |
|---|---|---|
| EXISTE_EXACTA | 4 | Ya publicada. **No insertar.** Solo sirve para validar proporciones |
| EXISTE_VARIANTE | 42 | Diferencia culinaria real contra una publicada (técnica, composición o base) |
| NUEVA | 68 | Plato con nombre propio ausente de las 109 |
| SOLO_RESTAURANTE | ~172 | Ítem de carta. **No es una receta casera y no lo afirmamos como tal** |

### EXISTE_EXACTA — no insertar (4)

| Candidato | Choca con | Valor rescatable |
|---|---|---|
| Pan amasado (3 fichas cookpad) | Pan amasado | Validan la proporción harina : agua : grasa = 500 : 250 : 80 en las tres |
| Porotos con riendas (3 fichas cookpad) | Porotos con riendas | Confirman 200 g de tallarines por taza de porotos |
| Carne desmechada | Carne mechada | Nota: corte tapapecho y uso de PRESSURE_COOKER con manualAlternative |
| Pollo asado de Á. Barrientos | Pollo al horno con papas | Nota de variación: adobo licuado con naranja y paprika, marinado de una noche |

### EXISTE_VARIANTE — muestra de las 42 más relevantes

| Candidato | Receta existente | Diferencia culinaria real | Prio |
|---|---|---|---|
| Chancho en piedra | Pebre | ✅ Verificado hoy: tomate majado en mortero con ajo, ají y orégano, **sin cilantro**. El pebre va picado en crudo. 6 porciones, 10 min | P0 |
| Caldillo de congrio | Caldillo de merluza | ✅ Verificado hoy: 6 porciones, 40 min. Suma choritos/almejas, vino blanco y fondo de espinas. Congrio, choritos y almejas ya están en los 84 | P0 |
| Cazuela de albóndigas | Cazuela de vacuno | La presa se reemplaza por albóndigas: no hay que ablandar presa, baja a 50 min | P0 |
| Empanadas fritas de pino | Empanadas de pino al horno | Doble diferencia: masa con manteca y leche caliente sin huevo, + fritura | P0 |
| Empanadas fritas de queso | Empanadas de pino al horno | Relleno y cocción distintos. 7 ingredientes, todos en catálogo, rinde 24 | P0 |
| Chapaleles | Milcao | El milcao lleva papa cruda rallada; el chapalel es papa cocida amasada y va hervido | P0 |
| Garbanzos con arroz | Garbanzos guisados | El arroz se cocina DENTRO del guiso. Mismo criterio que separa riendas de granados | P0 |
| Tortilla de porotos verdes | Tortilla de verduras | La verdura es el centro, no un surtido. Plato de verano con nombre propio | P0 |
| Cazuela de cerdo | Cazuela de vacuno / de pollo | Tercera proteína clásica. Distinto de "cazuela de osobuco", que sí es cambio de corte | P1 |
| Lentejas con arroz | Lentejas guisadas | Arroz dentro del guiso. **Consistencia:** si se rechaza, hay que rechazar también Garbanzos con arroz | P1 |
| Zapallitos italianos rellenos | Zapallo italiano guisado / Budín | Se ahueca, se rellena y se gratina entero | P1 |
| Picarones | Sopaipillas pasadas | Mismo almíbar, pero la masa leuda y va en anillo | P1 |
| Flan de manjar | Leche asada | Caramelo en el molde, se desmolda, lleva manjar. Cero alimentos nuevos | P1 |
| Sopaipillas sureñas | Sopaipillas | Sin zapallo y con levadura. **Verificar primero** que la publicada lleve zapallo | P2 |
| Pescado frito en batido | Merluza frita con arroz | Batido con polvos de hornear, no apanado. **Verificar** cómo está escrita la publicada | P2 |
| Picante de guatitas | Guatitas a la jardinera | Liga con pan remojado, queso y ají; queda espeso, no en caldo claro | P2 |
| Pastel de choclo vegetariano | Pastel de choclo | Pino de champiñón + callampa aporta el umami perdido. Solapa con el de papas | P2 |
| Estofado de carne con papas | Carne magra con papas | Guiso de olla de 2 h vs plancha con guarnición. ⚠️ Se acerca a Carne al jugo | P2 |
| Ensalada de porotos granados | Porotos granados | Fría, 10 min, aprovecha sobra | P2 |
| Chuletas de cerdo al jugo | Chuletas a la plancha con puré | Se termina guisada en jugo con sofrito y limón | P2 |
| Hamburguesas de atún | Hamburguesas caseras | Otra proteína, otro precio, otro día de la semana | P2 |
| Costillar de cerdo a la parrilla | Costillar al horno con papas | ✅ **Verificado hoy** (la ficha SÍ abre): 4 porciones, 2h50, adobo de miel, mostaza, vinagre y vino. **No es "el mismo con otro aliño"** | P3 |
| Chupe de pollo / Chupe de atún | Chupe de pescado | Cambio de proteína. ⚠️ Aprobar **uno solo** de los dos | P3 |
| Chapsui de pollo | Pollo salteado con verduras | Brotes de soya y ligado con maicena. Nombre propio de plato en Chile | P3 |
| Empanadas de atún | Empanadas de pino al horno | Relleno de vigilia. ⚠️ La ficha de nestlé está mal escrita (habla de tortillas de maíz): canonizar la de gourmet | P3 |
| Anticuchos mixtos | Anticuchos de posta | Vacuno + cerdo + longaniza en el mismo palito | P3 |
| Salpicón de verduras | Ensalada surtida | Lechuga + choclo + apio con salsa cremosa licuada. Riesgo medio de solape | P4 |
| Cazuela nogada | Cazuela de pollo | Salsa de nuez molida: cambia textura y aporte nutricional. ⚠️ Fuente muy escueta | P4 |

### NUEVA — muestra de las 68

| Candidato | Categoría | Alimentos nuevos | Procedencias | Prio |
|---|---|---|---|---|
| Chorrillana | Fondo para compartir | Ninguno | 3 | P0 |
| Barros Luco | Sánguches | Ninguno | 1 | P0 |
| Chacarero | Sánguches | Ninguno | 1 | P0 |
| Palta reina | Entrada fría | Ninguno | 1 | P0 |
| Churrascas | Panadería | Ninguno | 2 | P0 |
| Ensalada de mote | Ensaladas | Ninguno | 3 (mismo plato) | P0 |
| Porotos con mote | Legumbres | Ninguno | 1 | P0 |
| Carne al jugo | Carnes de olla | Ninguno | 2 | P0 |
| Croquetas de atún | Conservas | Ninguno | 1 | P0 |
| Malaya rellena | Carnes | Ninguno (activa `malaya de cerdo`, hoy sin uso) | 2 | P0 |
| Pastelera de choclo | Componente | Ninguno | 1 | P1 |
| Arroz graneado a la chilena | Acompañamiento | Ninguno | 1 | P1 |
| Asado alemán | Horno | Ninguno | 1 | P1 |
| Budín de atún | Horno | Ninguno (marraqueta remojada) | 1 | P1 |
| Crema de zanahoria | Sopas | Ninguno | 1 | P1 |
| Papas rellenas | Papas | Ninguno | 2 | P1 |
| Pan de huevo | Once | azúcar flor, bicarbonato | 2 | P1 |
| Masa de empanadas | Componente | vino o vinagre | 3 (una masa, tres proporciones) | P1 |
| Pastel de jaiba | Mariscos | **jaiba** | 3 | P1 |
| Budín de pescado | Horno | Ninguno (salsa blanca casera) | 1 | P1 |
| Plateada al horno | Carnes | plateada, vino, vinagre | 3 | P1 |
| Guiso de acelga | Verduras | **acelga** | 1 | P1 |
| Fideos con jurel y acelga | Pastas | **jurel en conserva**, acelga | 1 | P1 |
| Chupe de mariscos | Mariscos | mariscos en conserva o jaiba, crema, parmesano, pan de molde | 3 (mismo plato) | P2 |
| Curanto en olla (pulmay) | Sur | Ninguno en la versión gourmet | 2 | P2 |
| Valdiviano | Sopas | ⚠️ charqui NO está y no es fácil de comprar | 3 | P2 |
| Menestrón | Sopas de legumbre | Ninguno | 1 casero | P2 |
| Guiso de verduras | Vegetariano | Ninguno (berenjena y champiñón son sustituibles) | 1 | P2 |
| Pan de completo | Panadería | levadura seca | 1 | P2 |
| Marraqueta casera | Panadería | levadura seca | 1 (⚠️ vocabulario argentino) | P2 |
| Machas a la parmesana | Mariscos | machas, parmesano, vino | 2 | P3 |
| Camarones al pil pil | Picoteo | camarones, ají cacho de cabra, vino | 2 (mismo plato) | P3 |
| Prietas con papas | Cerdo | prieta | 1 | P3 |
| Papas con chuchoca | Papas | **chuchoca** | 1 | P3 |
| Arrollado primavera | Frituras | lomo de cerdo, cebollín, salsa de soya | 2 | P3 |
| Agua con harina tostada | Bebida | **harina tostada** | 2 | P3 |
| Chairo | Sopa del norte | **chuño** ⚠️ no confundir con el "chuño"=maicena | 1 | P4 |

### SOLO_RESTAURANTE (~172)

| Bloque | Líneas | Estado |
|---|---|---|
| Casa China (2 sucursales) | ~110 | ✅ Verificado hoy, texto legible, sin cantidades |
| Tanta Perú (lacarta.pro) | ~40 | ✅ Verificado hoy, pero **es la carta peruana, no la chilena** |
| Tanta Chile (tanta.cl/cartaqr) | ~62 heredadas | ❌ **No verificable: la página es solo imágenes** |

**Colisiones de nombre que hay que vigilar si algún día se modela el catálogo de
restaurante:** "Salmón a la chorrillana" de Tanta **no** es la chorrillana chilena y
confundiría al usuario; "Bistec a la sartén" vs "Bistec a lo pobre"; "Asado de la abuela"
vs "Carne mechada"; "Escalopa apanada" vs "Escalopas de pollo apanadas con puré".

---

## H. Duplicados detectados dentro del catálogo actual

| Gravedad | Par | Diagnóstico | Acción propuesta |
|---|---|---|---|
| 🔴 FUERTE | Pollo al horno con papas ↔ Pollo adobado al horno con ensalada chilena | Es el mismo pollo al horno. Cambia el adobo y la guarnición, y la guarnición no es diferencia culinaria | **Fusionar.** El adobo queda como nota de variación — justo donde calza el adobo de naranja de cookpad |
| 🔴 FUERTE | Arroz con pollo ↔ Pollo con arroz y ensalada chilena | Mismo plato con una ensalada agregada al nombre | **Fusionar.** La ensalada chilena ya es receta propia; el optimizador la suma como acompañamiento |
| 🟠 MEDIO | Pollo al horno con papas ↔ Pollo al horno con tomate y cebolla | Tercer pollo al horno. Si no cambia técnica, es la misma receta con otra guarnición | Revisar las tres juntas. **Hoy hay 5 recetas de pollo al horno o adobado entre las 109** |
| 🟠 MEDIO | Pescado al horno con verduras ↔ Salmón al horno con papas | Mismo molde con otra guarnición si la primera se escribió con salmón | Revisar qué especie usa cada una |
| 🟡 REVISAR | Porotos granados ↔ Porotos con mazamorra | En Chile el plato clásico es "porotos granados con mazamorra" | Si la de mazamorra ya usa granados, decidir cuál queda canónica |
| 🟡 REVISAR | Caldo de pollo casero ↔ Sopa de pollo con fideos | Si el caldo no es preparación base reutilizable (tipo "Salsa de tomate en tanda") sino sopa servida, se solapan | Definir el caldo como componente |
| 🟡 REVISAR | Merluza con arroz y ensalada verde ↔ Merluza frita con arroz | Solo se sostienen como dos si la primera NO va frita | De esto depende también el candidato "Pescado frito en batido" |
| 🟡 REVISAR | Bistec con puré ↔ Carne magra con papas y ensalada | Ambas son carne a la plancha con guarnición | Si corte y técnica coinciden, es una sola receta |

### Verificaciones pendientes en NUESTRAS propias recetas

Esto no se resuelve leyendo fuentes: hay que abrir el texto publicado de cada receta.
**Cinco decisiones dependen de esto:**

| # | Pregunta | De qué depende |
|---|---|---|
| 1 | ¿La "Sopaipillas" publicada lleva zapallo? | Que "Sopaipillas sureñas" sea variante o duplicado |
| 2 | ¿La "Merluza frita con arroz" va apanada o en batido? | Que "Pescado frito en batido" entre o se caiga |
| 3 | ¿El "Pino de carne para congelar" usa carne molida o en cubos? | Que sirva para reutilizar en las empanadas fritas |
| 4 | ¿El "Pollo arvejado" lleva papas? | Descartar o no el "Estofado de pollo" |
| 5 | ¿El "Churrasco con tomate y palta" lleva mayonesa? | Si el "Churrasco italiano" ya está publicado de hecho |

---

## I. Propuesta final del catálogo casero

Propongo **cuatro olas**, no una carga masiva. El criterio de orden es: primero lo que
no exige alimentos nuevos y tiene varias procedencias, al final lo caro y lo dudoso.

### Ola 0 — 24 recetas · sembrar de inmediato

Cero o casi cero alimentos nuevos, varias procedencias, platos con nombre propio.

**Salados (18):** Chorrillana · Chancho en piedra · Caldillo de congrio · Cazuela de
albóndigas · Barros Luco · Chacarero · Palta reina · Churrascas · Chapaleles ·
Empanadas fritas de pino · Empanadas fritas de queso · Ensalada de mote · Porotos con
mote · Garbanzos con arroz · Carne al jugo · Tortilla de porotos verdes · Croquetas de
atún · Malaya rellena

**Dulces (6):** Calzones rotos · Empolvados · Brazo de reina · Leche nevada · Sémola con
leche · Manzanas asadas

*Alimentos nuevos que exige la Ola 0:* **azúcar flor**, **maicena**, **sémola**,
**vainilla**. Cuatro, todos de despensa y baratos.

### Ola 1 — 20 recetas · siguiente

Componentes reutilizables, familia de pescados y mariscos, panadería.

Pastelera de choclo · Masa de empanadas · Arroz graneado a la chilena · Asado alemán ·
Budín de atún · Budín de pescado · Crema de zanahoria · Papas rellenas · Pan de huevo ·
Pastel de jaiba · Plateada al horno · Guiso de acelga · Fideos con jurel y acelga ·
Zapallitos italianos rellenos · Cazuela de cerdo · Lentejas con arroz · Kuchen de fruta ·
Chilenitos · Picarones · Flan de manjar

*Alimentos nuevos:* jaiba, acelga, jurel en conserva, plateada, vino/vinagre, levadura
seca, bicarbonato, margarina (o normalizar a mantequilla).

### Ola 2 — 26 recetas

Chupe de mariscos · Caldillo de mariscos · Curanto en olla (pulmay) · Valdiviano ·
Sopa de choclo · Menestrón · Guiso de verduras · Puré de betarraga · Papas duquesas ·
Arroz con crema de choclo · Arroz árabe · Pan de completo · Marraqueta casera ·
Lasaña · Sopaipillas sureñas · Pescado frito en batido · Picante de guatitas ·
Pastel de choclo vegetariano *(o el de papas con champiñones, no ambos)* ·
Chuletas de cerdo al jugo · Ensalada de porotos granados · Hamburguesas de atún ·
Alfajores de maicena · Torta mil hojas · Cocadas · Berlines con crema pastelera ·
Pan de Pascua

### Ola 3 — 21 recetas

Costillar de cerdo a la parrilla · Anticuchos mixtos · Chupe de pollo *o* de atún *(uno)* ·
Camarones al pil pil · Machas a la parmesana · Fricasé de cerdo con verduras ·
Prietas con papas · Pernil con papas salteadas · Papas con chuchoca · Chapsui de pollo ·
Empanadas de atún · Pan de molde integral · Pan de hamburguesa casero ·
Arrollado primavera · Agua con harina tostada · Queque de plátano y nuez ·
Pajaritos · Postre de manzana con merengue · Pie de mote con huesillo · Torta de piña ·
Torta tres leches

### Colapsos que aplico ANTES de contar (para no inflar la biblioteca)

| Se aprueba | Se descarta por solape | Por qué |
|---|---|---|
| Arroz graneado a la chilena | Arroz con arvejas | Si entra uno, el otro pierde sentido |
| Plateada al horno | Plateada a la cacerola | Una sola plateada; la de horno es más usable |
| Carne al jugo | Estofado de carne con papas | Prácticamente el mismo guiso de olla |
| Kuchen de fruta | Pastel de manzana · Kuchen sureño de frutilla | La fruta y el relleno son variables, no recetas |
| Chupe de pollo **o** de atún | el otro | Cuatro chupes casi iguales no aportan |
| Pastel de choclo vegetariano **o** el de papas con champiñones | el otro | Es dos veces la misma idea |
| Torta mil hojas | Torta de hojarasca con manjar | Dos tortas de discos con manjar |
| Churrascas | Pan de sartén relleno | Misma familia de pan sin horno |
| Chupe/Caldillo de mariscos | Mariscal | Mismo sofrito y mismo tarro |
| Queque de naranja *(ya publicada)* | Queque de vainilla | Cambio de saborizante: va como nota |

### Backlog explícito — 27 recetas P4 que NO propongo ahora

Sanco de harina tostada, Guiso de papas con longaniza, Pichanga fría, Chairo, Cazuela
nogada, Chupe de locos, Mote con machas, Crema de choritos, Pollo al cognac, Sánguche de
lengua, Pascualina, Pan relleno de carne y longaniza, Salpicón de verduras, Lomo vetado,
Molde de porotos verdes, Sopa de lentejas con longaniza, Pollo con choclo a la crema,
Rollos de canela, Tortas curicanas, Cuchuflís, Torta de cuchuflí, Calugas de manjar,
Prestigio casero, Chumbeque, Torta merengue lúcuma, Cachitos de manjar, Dulce de
membrillo, Helado de mote con huesillo.

### Descartes recomendados — 12

Masa de pizza a la piedra · Sopa de papas con chorizo *(contenido mexicano en dominio
chileno)* · Ensalada de papas con mayonesa *(variante de aliño)* · Estofado de pollo ·
Mariscal · Anticuchos de pollo · Tortitas de papa con queso *(no es la tortita chilena)* ·
Pan dulce casero *(página SEO)* · Turrón de vino tinto *(clara cruda + alcohol)* ·
Panqueque desgarrado · Crema volteada · Queque de vainilla.

**Más los 4 EXISTE_EXACTA, que no se insertan por definición.**

---

## J. Cantidad final estimada

| Concepto | Cantidad |
|---|---|
| Recetas publicadas hoy | 109 |
| − fusión de los 2 duplicados fuertes (sección H) | −2 |
| **Base real depurada** | **107** |
| + Ola 0 | +24 |
| + Ola 1 | +20 |
| + Ola 2 | +26 |
| + Ola 3 | +21 |
| **TOTAL CATÁLOGO CASERO PROPUESTO** | **198** |

**Catálogo de restaurante: SEPARADO y, por ahora, prácticamente vacío.**

| Catálogo de restaurante | Líneas | Estado |
|---|---|---|
| Casa China | ~110 | ✅ Legible, sin cantidades. Se puede modelar como carta, nunca como receta |
| Tanta | 0 utilizables | ❌ Bloqueado: la carta chilena es solo imágenes |

### Mi lectura honesta del número

**198 cae dentro del rango 150–200 que pediste, pero quiero ser explícito en tres cosas:**

1. **El techo real de esta tanda son 128 candidatos caseros insertables**, no 91. Si se
   aprobara todo el backlog P4 llegaríamos a ~235, y eso **no lo recomiendo**: la cola
   larga son platos con una sola procedencia, sin cantidades publicadas o con alimentos
   caros de rotación baja (locos, lúcuma, lengua, membrillo, chuño).

2. **Si tuviera que apretar, el número que defiendo es 175**, no 198: Ola 0 + Ola 1 +
   Ola 2 sobre la base depurada de 107 = 177, y ahí la biblioteca ya cubre todas las
   familias de la mesa chilena sin cola. La Ola 3 es buena pero es donde empiezan los
   alimentos nuevos que solo usa una receta.

3. **El costo real de esta expansión no son las recetas, son los alimentos.** Las cuatro
   olas exigen **~45 alimentos nuevos** sobre los 84 actuales. La Ola 0 sola exige
   cuatro. Si el director quiere el máximo de recetas por el mínimo de catálogo, la
   respuesta es Ola 0 + Ola 1 (44 recetas por ~12 alimentos nuevos).

---

## K. Platos de restaurante que deberían tener adaptación casera

**Recordatorio conceptual, y va en serio:** un plato de restaurante **no es** una receta
casera. No afirmamos conocer la receta de Tanta ni la de Casa China. Una adaptación
casera es un **objeto relacionado**, con su propia receta, escrita por nosotros desde un
recetario — nunca desde una carta. La carta solo sirve como **señal de que el plato está
instalado**, jamás como fuente de método.

| Plato de restaurante | Casa | ¿Ya hay candidato casero? | Fuente de la receta casera | Recomendación |
|---|---|---|---|---|
| Chapsui de pollo | Casa China | ✅ Sí | recetasnestle.cl | **Adaptar.** La carta confirma vigencia; la receta viene de nestlé. Ola 3 |
| Arrollado primavera | Casa China | ✅ Sí | cookpad.cl | **Adaptar.** Se arma y congela: sirve al plan semanal. Ola 3 |
| Arroz chaufán | Casa China | ❌ No | — | **Vale la pena.** Es el plato chino más pedido en casa chilena y aprovecha arroz sobrante. Falta conseguir fuente |
| Wantán frito | Casa China | ❌ No | — | Segundo lugar. Exige masa de wantán como alimento nuevo |
| Costillar con piña / cantonés | Casa China | ❌ No | — | Interesante: reutiliza `costillar de cerdo` del catálogo. Requiere piña en conserva |
| Lomo saltado | Tanta | ❌ No | — | **Candidato #1 si se abre cocina peruana.** Casi todo está en los 84; faltan ají amarillo y salsa de soya. ⚠️ La receta hay que buscarla en un recetario, la carta no la publica |
| Causa limeña | Tanta | ❌ No | — | Un plato, tres proteínas: **no se separa**, la proteína es variable |
| Ají de gallina | Tanta | ❌ No | — | Requiere ají amarillo, ají mirasol y queso serrano: tres alimentos nuevos para una receta. Prioridad baja |
| Suspiro limeño | Tanta | ❌ No | — | El manjar ya está. Postre de ocasión |

**Los que NO recomiendo adaptar:**

- **Crema de zapallo (Tanta)** — ya está publicada entre las 109. Es duplicado.
- **El pollito palteado (Tanta)** — es el "Sandwich de ave palta" publicado con papas al hilo.
- **Ceviches de carta (Tanta)** — el pescado es indeterminado ("el más fresco del día") y
  ya tenemos "Ceviche de reineta" casero. No tocar.
- **Leche asada (Casa China)** — ya publicada. Y además la verificación de hoy **no
  encontró** ese ítem en la carta de Puente Alto.
- **Los 8 hot rolls y toda la familia de sushi** — nombres de fantasía sin composición
  publicada. No se puede fichar sin inventar, y no vamos a inventar.
- **Los 8 menús combinados** — son paquetes, no platos.

---

## L. Fuentes y procedencia

### Fuentes usadas

| # | Fuente | URL raíz | Tipo | Leído | Cantidades | Porciones | Tiempos |
|---|---|---|---|---|---|---|---|
| 1 | Gourmet | `https://www.gourmet.cl/recetas/` | Recetario de marca | 2026-08-25 | Sí | Sí | Sí |
| 2 | Recetas Nestlé Chile | `https://www.recetasnestle.cl/recetas/` | Recetario de marca | 2026-08-25 | Sí | Sí | Sí |
| 3 | Cookpad Chile | `https://cookpad.com/cl/recetas/` | Recetario de usuarios | 2026-08-25 | Sí | Sí | Parcial |
| 4 | Trekking Chile — cocina chilena | `https://www.trekkingchile.com/es/informaciones/cocina-chilena/` | Divulgación | 2026-08-25 | **No** | No | No |
| 5 | Trekking Chile — cocina outdoor | `https://www.trekkingchile.com/en/outdoor/outdoor-kitchen/recipes/` | Recetario | 2026-08-25 | Sí (por persona) | Sí | Casi no |
| 6 | Tur.com | `https://www.tur.com/es/blog/` | Divulgación | 2026-08-25 | No | No | No |
| 7 | Tanta | `https://tanta.cl/cartaqr/` | Carta | 2026-08-25 | **Ilegible** | — | — |
| 8 | La Carta / Tanta Perú | `https://lacarta.pro/tanta/` | Carta | 2026-08-25 | No | No | No |
| 9 | Casa China La Florida | `https://queresto.com/CASACHINA` | Carta | 2026-08-25 | No | No | No |
| 10 | Casa China Puente Alto | `https://queresto.com/casachinapuentealto` | Carta | 2026-08-25 | No | No | No |

**Regla de procedencia aplicada:** cada candidato guarda nombre de la fuente, URL, nombre
del plato en el origen y fecha de lectura (2026-08-25). Un plato en cuatro fuentes es
**un** candidato con cuatro procedencias, no cuatro recetas.

### ❌ Lo que NO se pudo leer, y por qué

Esto es información útil, no una falla que esconder.

| Fuente / ficha | Qué pasó | Consecuencia |
|---|---|---|
| **`tanta.cl/cartaqr/`** | La página **es una galería de 6 imágenes**. No contiene texto: ni nombres de plato, ni ingredientes, ni porciones. Un lector de texto no extrae nada confiable | 🔴 **Grave.** La lista de ~62 platos de Tanta que traía la capa heredada **no es verificable**. No la doy por buena y recomiendo no sembrar nada de Tanta |
| **`gourmet.cl/recetas/chorrillana/`** | Devolvió solo la plantilla de navegación del sitio, sin el cuerpo de la receta. Reintenté y salió igual | 🟠 El candidato "Chorrillana" se sostiene por otras dos procedencias (trekkingchile, tur.com), pero **sus cantidades no están verificadas** |
| Fichas de gourmet marcadas "solo índice" | Ver corrección abajo | 🟢 Resueltas |

### ✅ Correcciones a la capa heredada, tras verificar hoy

Tres cosas que el informe anterior daba por perdidas o por ciertas, y que **cambian**:

1. **`gourmet.cl/recetas/pastel-de-pescado-gourmetpastel-de-pescado/` SÍ abre.** Y
   resuelve el riesgo que estaba abierto: **no es** el mismo plato que "Budín de
   pescado". Es un terrine — 800 g de filete, 8 huevos, 600 ml de crema, horno a baño
   maría 45 min, se enfría, se desmolda y se sirve **frío en rebanadas** con tostadas.
   4 porciones, 60 min. → Es un **candidato aparte**, no un duplicado. Ojo: exige crema
   como alimento nuevo.

2. **`gourmet.cl/recetas/crema-de-choritos/` SÍ abre.** 4 porciones, 20 min, 400 g de
   choritos cocidos (sirve de tarro), base de salsa blanca con leche y crema, se sirve
   con pan frito. Deja de ser "NO VERIFICADA". Alimento nuevo: crema.

3. **`gourmet.cl/recetas/costillar-a-la-parrilla/` SÍ abre.** 4 porciones, 2 h 50 min
   (2 h son adobo). Y **contradice** el supuesto de que era "el costillar de siempre con
   otro aliño": el adobo lleva miel, mostaza, vinagre blanco y vino blanco — **cuatro
   alimentos nuevos**. Sube de "variante trivial" a variante con costo real de catálogo.

Además, dos ajustes de menor tamaño:

4. **Casa China Puente Alto no lista "Torta tres leches" ni "Leche asada".** La
   atribución heredada de esos ítems a la carta de Casa China no se sostuvo. "Sopa
   fuchifú" aparece en La Florida pero no en Puente Alto: las sucursales difieren de
   verdad.

5. **`trekkingchile.com/es/informaciones/cocina-chilena/platos/` trae más platos de los
   que la capa heredada levantó**: aparecen también **Pataska, Pollo al barro,
   Chunchules, Lisa a la teja, Charqui de caballo, Curanto en hoyo y Locos**. No los
   propuse como candidatos porque la página **no publica cantidades ni método**, y varios
   son inviables en casa (curanto en hoyo, pollo al barro) o de casquería de rotación muy
   baja. Los dejo anotados para que la decisión quede registrada.

### Reglas de normalización aplicadas a todos los candidatos

- **Regla 6 — sin marcas.** Todas las fuentes de marca se normalizaron: tableta/sobre
  MAGGI → caldo casero; puré MAGGI → papa cocida y molida; Crema NESTLÉ → crema de leche;
  manjar NESTLÉ → manjar; leche evaporada IDEAL → leche; polvo de hornear IMPERIAL →
  polvos de hornear; Sal de Mar / Orégano / Esencia de Vainilla **Gourmet** → genéricos.
  **Dos excepciones legítimas**, donde la marca-producto sí cambia la nutrición de forma
  material y no se puede sustituir sin rehacer la receta: **leche condensada** en Cocadas
  y en Torta tres leches, y **leche evaporada + condensada + crema** en Torta tres leches.
- **Regla 7 — sin etiquetas de salud.** Ninguna receta se marca renal, diabética ni
  saludable. El "Pan de molde integral" es pan integral, no pan fitness.
- **Regla 8 — nutrición.** No se toma la nutrición publicada por la fuente en ninguna
  receta donde cambiamos ingredientes o cantidades. Sirve como referencia de control.
- **Regla 2 — sin texto protegido.** De cada fuente se extrajo estructura: ingredientes,
  cantidades cuando estaban publicadas, método, tiempos y porciones. Las instrucciones se
  redactan propias y concisas.
- **Porciones mal expresadas que hay que corregir antes de que el optimizador las lea:**
  Calzones rotos (30 unidades, no porciones), Papas duquesas (40 unidades de 2 cm),
  Cocadas (48-60 unidades), Calugas (30 unidades), Chapaleles (16 unidades), Churrascas
  (8 panes), Alfajores de maicena (25 galletas), Pastel de jaiba (6 pailas).

### ⚠️ Advertencias de seguridad y calidad que NO se pueden copiar de la fuente

| Receta | Problema en la fuente | Qué hacemos |
|---|---|---|
| Calugas de manjar y nuez | 1 huevo **crudo** que solo pasa 15 min por manjar caliente | Rehacer el método para cocinar bien el huevo, o descartarla |
| Torta de hojarasca (nestlé) | Hace el manjar hirviendo **tarros cerrados** de leche condensada en olla a presión | Reescribir con el manjar del catálogo. **Nunca hervir tarros cerrados** |
| Turrón de vino tinto | Clara cruda montada con almíbar a 118 °C + alcohol que no evapora | Recomiendo descartar |
| Kuchen (cookpad) | Declara **30 g** de polvos de hornear para 250 g de harina (debería ser ~10 g) | Error de fuente: no copiar |
| Kuchen sureño (cookpad) | Repite el error: 20 g para 250 g de harina | No copiar |
| Empanadillas de atún (nestlé) | Habla de "tortillas de maíz" siendo masa de empanada: contenido mexicano reciclado | Canonizar la ficha de gourmet |
| Sopa de papa con chorizo (nestlé) | Ingredientes y keywords de contenido mexicano en dominio chileno | Descartar |
| Valdiviano | Exige **charqui**, que no está en los 84 y no es fácil de comprar | Si se publica con vacuno deshilachado, **decirlo en la receta**: no es el valdiviano histórico |
| Marraqueta casera / Pan de hamburguesa / Masa de pizza (cookpad) | Vocabulario argentino: asadera, repasador, harina 0000, azúcar mascabo, manteca | Traducir a chileno neutro antes de publicar |
| Pascualina (nestlé) | El JSON-LD solo publica la **masa**; el relleno clásico no trae cantidades | No publicarla con esta fuente sola |

---

## Lo que necesito que apruebes

1. **La fusión de los 2 duplicados fuertes** (109 → 107) y el criterio para revisar los 6 solapes restantes.
2. **La Ola 0 completa (24 recetas)** y sus 4 alimentos nuevos: azúcar flor, maicena, sémola, vainilla.
3. **El criterio "guiso con almidón dentro = plato propio"**, que gobierna a la vez
   Garbanzos con arroz y Lentejas con arroz. Si lo rechazas, caen los dos.
4. **Los 10 colapsos de la sección I** (aprobar uno de cada par).
5. **Que Tanta queda fuera de esta tanda** hasta conseguir una fuente legible.
6. **Las dos excepciones a la regla 6** (leche condensada en Cocadas y Tres leches).

Con eso sembramos. Sin eso, no se inserta nada.
