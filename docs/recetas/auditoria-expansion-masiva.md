# Auditoría de expansión masiva — el recetario de lo que esta familia podría comer

**Fecha:** 2026-08-25
**Estado:** propuesta para aprobación. **NO se ha insertado ni una sola receta.**
**Alcance:** contenido. No se toca ninguna migración, ningún motor, ningún seed.

Este informe reemplaza a `auditoria-expansion-contenido.md`, que quedó corto a propósito
(proponía 4 olas y ~91 recetas). El director corrigió el alcance en dos puntos:

1. **Barrido completo, no muestra representativa.** Si las fuentes dan para 300, que sean 300.
2. **Las cartas de Tanta y Casa China no son referencias: son descubrimiento de comidas.**
   Un plato de la carta se convierte en una **receta casera nuestra**, con formulación
   doméstica propia. En ninguna parte afirmamos conocer la receta del restaurante.

Con eso, la biblioteca deja de ser "recetario chileno" y pasa a ser el recetario de lo que
esta familia realmente come: **chilena, peruana, china/chifa e internacional casera**.

---

## 0 · Cómo leer esto (léelo antes que las tablas)

- **Un plato = un candidato.** Si el pastel de choclo aparece en cuatro fuentes, es UN
  candidato con cuatro procedencias. Por eso los "platos leídos" por fuente suman mucho
  más que el total propuesto.
- **Variante real vs misma receta.** Se separa cuando cambia la técnica, la proteína o la
  base (empanada al horno contra frita). NO se separa por cantidad ni por método trivial:
  el mismo pescado en air fryer o frito es UNA receta con variante de cocción.
- **De la fuente se extrae estructura**, nunca texto: ingredientes, cantidades publicadas,
  método, tiempos y porciones. Las instrucciones se redactan propias y concisas.
- **Cero etiquetas de salud.** No existe la "versión diabética". El motor clínico evalúa
  cada porción para cada persona.
- **El aceite añadido va explícito y es el RETENIDO**, no el baño de la sartén: el motor
  suma el 100 % de lo declarado.

---

## 1 · Punto de partida: qué hay HOY

| Medida | Cantidad |
|---|---|
| **Recetas publicadas** | **109** |
| **Alimentos en catálogo** | **84** |
| Capacidades de equipamiento | 11 |
| Platos realmente distintos (tras canonicalizar) | ~107 (ver sección 7) |
| Duplicados fuertes dentro de las 109 | 2 |
| Solapes medios / por revisar | 6 |

Fuente: `docs/recetas/vocabulario-catalogo.md`, leído completo. Las 109 filas y los 84
alimentos son la única lista contra la que se compara. Toda propuesta se normalizó por
acentos, mayúsculas, plurales y artículos antes de clasificarse.

---

## 2 · Barrido por fuente: cuánto se alcanzó a recorrer

Acá voy a ser franco, porque el dato sirve más que la lista bonita.

| # | Fuente | URL raíz | Tipo | Cantidades | Porciones | Tiempos | Candidatos que aportó | ¿Barrido entero? |
|---|---|---|---|---|---|---|---|---|
| 1 | Gourmet | `gourmet.cl/recetas/` | Recetario de marca | Sí | Sí | Sí | **157** | 🟡 Parcial alto |
| 2 | Recetas Nestlé Chile | `recetasnestle.cl` | Recetario de marca | Sí | Sí | Sí | **40** | 🟡 Parcial |
| 3 | Cookpad Chile | `cookpad.com/cl` | Recetario de usuarios | Sí | Sí | Parcial | **22** | 🔴 Imposible por definición |
| 4 | Trekking Chile | `trekkingchile.com/es/informaciones/cocina-chilena/` | Divulgación + outdoor | Casi nunca | Solo outdoor | Casi nunca | **34** | 🟢 Sí (es finita) |
| 5 | Tur.com | `tur.com/es/blog/` | Divulgación | No | No | No | **7** | 🟢 Sí (es finita) |
| 6 | **Tanta Chile** | carta (ver abajo) | Carta de restaurante | No | No | No | **81** | 🟡 Parcial |
| 7 | **Casa China** (2 sucursales) | `queresto.com/CASACHINA` y `/casachinapuentealto` | Carta de restaurante | Solo unidades | No | No | **63** | 🟢 Sí |

**404 atribuciones de procedencia** repartidas en **351 candidatos**: 53 platos llegaron
por más de una fuente y se colapsaron en uno solo.

### Lo que NO se pudo recorrer entero, y por qué

| Fuente | Qué pasó (verificado hoy) | Consecuencia honesta |
|---|---|---|
| **`tanta.cl/cartaqr/`** | 🔴 **La carta oficial sigue siendo ilegible.** Es una galería de **6 imágenes PNG** más un pop-up. No entrega ni un nombre de plato como texto. La reabrí hoy y el resultado fue el mismo | La procedencia "tanta.cl" **no existe** y no la uso |
| **Tanta Chile por agregador** | 🟢 `rappi.cl/restaurantes/900024875-tanta` (Las Condes) **sí publica la carta chilena en texto**, con secciones (Entradas, Piqueos, Ensaladas, Sánguches, Sopas, Pastas, Guisos, Macarrones, Postres, Bebidas) y precios en pesos. Uber Eats devolvió **403** | ✅ Los 81 candidatos de Tanta tienen procedencia real, pero es **el agregador, no el sitio del restaurante**. Así queda declarado en cada receta |
| **Tanta: ítems no reconfirmados hoy** | En la lectura de hoy **no vi** en el listado: *Menestrón, Pescado a lo macho, Pollo chijaukay, Cerdo crocante a la miel, Milanesa a la napolitana, Pan de ajo, Batidos, Guacamole*. Sí confirmé, entre otros: Salmón a la Chorrillana ($21.900), Bistec a la Sartén, Cebiche carretillero, Causa limeña (atún/pollo/camarón), Sopa Capón, Lima Thai, Cobb Casera, Tacu Tacu, Risottos, Macarrones, Suspiro Limeño, Crema Volteada, Tarta de Limón, Tartita de Maracuyá | 🟡 Esos 8 candidatos quedan marcados **"procedencia por reconfirmar"**. Con criterio duro se caen y el total baja a **343** |
| **`lacarta.pro/tanta`** | 🟡 Abre y es completa… pero es **Tanta PERÚ**, con precios en soles | No se usa como procedencia chilena. Sirve solo como control cruzado de nombres |
| **gourmet.cl** | 🟡 El índice `/recetas/` carga por JavaScript ("Cargando recetas…") y **no publica un total**. Se recorrió por taxonomías paginadas (`/tipo-plato/…/page/N/`, `/cocinas-mundo/…/page/6/`, `/dia-especial/…/page/12/`). Las fichas individuales sí abren completas: verifiqué `pastel-de-jaiba` (6 porciones, 50 min, ingredientes con gramaje) | No puedo afirmar "recorrí gourmet.cl entero". Sí que recorrí sus categorías paginadas y que quedaron fichas sin abrir |
| **recetasnestle.cl** | 🟡 Tampoco publica índice enumerable: es un portal de categorías (`/categorias/postres-chilenos`, `/categorias/tipicos-dulces-chilenos`, `/categorias/pasteleria-chilena`). Se recorrió por categoría | Mismo caso: barrido por categorías, no exhaustivo comprobable |
| **cookpad.com/cl** | 🔴 Es un recetario **abierto de usuarios**: no tiene fondo. Se recorrió por búsqueda dirigida (ej.: "plateada" devuelve 10+ fichas, todas con cantidades y raciones) | Recorrerlo entero **no es posible ni deseable**: aporta variantes, no identidades nuevas |
| **trekkingchile.com** | 🟢 Finita y recorrida (`/platos/` y `/once-y-postres/`), pero **casi nunca publica cantidades ni método**: es divulgación | 21 de sus 34 candidatos exigen formulación doméstica nuestra, declarada como tal |
| **Casa China** | 🟢 Las dos sucursales legibles y recorridas: 27 secciones, ~110 líneas. Publica descripción corta y a veces unidades ("Wantán frito, 10 unidades"; "Copa de Oro, 8 unidades"; rolls "8 piezas"), **nunca gramajes ni porciones**. Las sucursales difieren de verdad: la "sopa fuchifú" está en La Florida y no en Puente Alto | La composición de los rolls **no está publicada**: toda su formulación es nuestra |

**Dos cosas que NO salen de la carta y hay que declararlas así:** en el listado que abre,
Casa China **no tiene sección de sopas propia**, así que *Sopa wantán* y *Sopa de mariscos
chifa* vienen de práctica chifa general apoyada en que el wantán sí está en la carta. Y la
*Masa de wantán casera* no sale de ninguna carta: es el componente que necesitamos para no
depender de comprar la lámina.

---

## 3 · Matriz EXISTE / VARIANTE / NUEVA

**No hay ni un EXISTE_EXACTA en la propuesta:** los platos ya publicados se descartaron
antes de entrar (van listados en la sección 4, no acá).

### 3.1 Global

| Clasificación | Cantidad | Qué significa |
|---|---|---|
| **NUEVA** | **307** | Plato con nombre propio ausente de las 109 |
| **EXISTE_VARIANTE** | **44** | Diferencia culinaria real contra una publicada (técnica, proteína o base) |
| EXISTE_EXACTA | 0 | Ya descartadas |
| **Total propuesto** | **351** | |

### 3.2 Por cocina

| Cocina | NUEVA | VARIANTE | Total | Peso |
|---|---|---|---|---|
| CHILENA | 177 | 31 | **208** | 59 % |
| PERUANA | 53 | 10 | **63** | 18 % |
| CHINA_CHIFA | 44 | 0 | **44** | 13 % |
| INTERNACIONAL | 33 | 3 | **36** | 10 % |
| **Total** | **307** | **44** | **351** | |

La biblioteca queda **59 % chilena** después de la expansión. No se diluye: se completa.

### 3.3 Por categoría

| Categoría | NUEVA | VARIANTE | Total |
|---|---|---|---|
| TRADICIONAL | 70 | 7 | **77** |
| POSTRE | 58 | 3 | **61** |
| PESCADO | 31 | 14 | **45** |
| VACUNO | 36 | 9 | **45** |
| POLLO | 25 | 5 | **30** |
| COMPONENTE | 28 | 0 | **28** |
| DESAYUNO_ONCE | 22 | 0 | **22** |
| ENSALADA | 17 | 3 | **20** |
| SOPA | 13 | 2 | **15** |
| LEGUMBRES | 4 | 1 | **5** |
| HUEVO | 3 | 0 | **3** |
| **Total** | **307** | **44** | **351** |

**Dónde se concentran las variantes:** PESCADO (14) y VACUNO (9). Tiene sentido: ahí la
biblioteca ya tenía familia (chupes, caldillos, asado de tira, mechada) y lo que llega son
técnicas distintas sobre la misma base, no platos inéditos.

### 3.4 Cocina × lote

| Lote | CHILENA | PERUANA | CHINA_CHIFA | INTERNACIONAL | Total |
|---|---|---|---|---|---|
| A | 112 | — | — | 15 | **127** |
| B | 32 | — | — | — | **32** |
| C | 13 | 7 | — | 3 | **23** |
| D | 51 | — | — | 6 | **57** |
| E | — | 56 | — | 1 | **57** |
| F | — | — | 44 | 11 | **55** |
| **Total** | **208** | **63** | **44** | **36** | **351** |

### 3.5 Las 44 variantes, una por una

| Candidato | Variante de | Qué la separa de verdad |
|---|---|---|
| Pebre de coliflor | Pebre | La coliflor cruda picada fina reemplaza a la cebolla como cuerpo |
| Ensalada verde con frutillas y queso | Ensalada verde | Fruta y queso la vuelven plato, con vinagreta dulce |
| Caldillo de congrio | Caldillo de merluza | Medallón con espinazo, fondo con cabeza, vino y crema |
| Chupe de mariscos | Chupe de pescado | Marisco desglasado en vino y gratinado final |
| Chupe de jaiba | Chupe de pescado | Sofrito en mantequilla, jaiba desmenuzada, gratén individual |
| Chupe de locos | Chupe de pescado | Loco laminado con su caldo; pide alternativa a choritos |
| Chupe de atún | Chupe de pescado | Atún en conserva DRAINED: el chupe de despensa |
| Chupe de jibia | Chupe de pescado | La hora de cocción previa de la jibia ES la receta |
| Pescado frito | Merluza frita con arroz | Rebozado líquido contra enharinado: cambia grasa y textura |
| Pescado gratinado con costra de pan rallado | Pescado al horno con verduras | La costra define el plato |
| Reineta con salsa de alcaparras | Reineta a la plancha con ensalada | Solo cambia la salsa: **el más discutible del lote A** |
| Salmón pochado con reducción cítrica | Salmón a la plancha con arroz | Método POACHED y salsa reducida |
| Asado de tira al horno | Asado de tira a la parrilla | Horno lento tapado 2 h 30 sobre cebolla |
| Asado de tira a la cerveza | Asado de tira a la parrilla | Braseado sumergido hasta soltar el hueso |
| Pie de carne y papas | Pastel de papas | Carne en cubos guisada y papa en láminas |
| Pastel de papas con pino de champiñones | Pastel de papas | Cambia la proteína entera |
| Pastel de choclo vegetariano | Pastel de choclo | Pino de champiñón y callampas bajo la misma pastelera |
| Albóndigas en salsa de mostaza | Albóndigas en salsa de tomate | Salsa de mostaza y crema: otro plato |
| Zapallitos italianos rellenos con carne | Zapallo italiano guisado con carne molida | Continente ahuecado y horneado, no guiso |
| Empanadas fritas de pino | Empanadas de pino al horno | El ejemplo textual de la regla; 4 procedencias |
| Spaghetti mediterráneo | Tallarines con salsa de tomate | El tomate va crudo y nunca ve el fuego |
| Pollo entero asado al jugo de naranja | Pollo adobado al horno | Adobo licuado, marinada de noche, 230 °C en dos etapas |
| Hamburguesas de pavo | Hamburguesas caseras en marraqueta | El pavo molido se seca y se liga distinto |
| Suprema de pollo Maryland | Escalopas de pollo apanadas con puré | El conjunto Maryland reemplaza el puré entero |
| Garbanzos con arroz | Garbanzos guisados | El arroz cocido dentro: cremoso, no caldoso |
| Cazuela de ave nogada | Cazuela de pollo | Nuez molida disuelta en el caldo |
| Charquicán de cochayuyo | Charquicán | Alga en vez de carne y ligue de choclo en leche |
| Crema de zapallo italiano y albahaca | Crema de zapallo | La publicada es de zapallo camote: otro alimento |
| Carne desmechada en olla a presión | Carne mechada | Tapapecho deshilachado, no posta entera al jugo |
| Picante de guatitas | Guatitas a la jardinera | Liga con pan, leche y queso |
| Sopaipillas al horno de zapallo y betarraga | Sopaipillas | El aceite va DENTRO de la masa, no retenido |
| Queque marmoleado | Queque casero de naranja | Media masa con cacao, dividida y rayada |
| Panqueques con salsa de naranja | Panqueques con manjar | La salsa se cocina y el panqueque se termina dentro |
| Cebiche mixto | Ceviche de reineta | Mariscos blanqueados incorporados fríos |
| Cebiche carretillero | Ceviche de reineta | Leche de tigre al rocoto más calamar frito encima |
| Sopa criolla de cabello de ángel | Sopa de pollo con fideos | Aderezo de ají panca, huevo escalfado, cancha |
| Saltado criollo de pollo | Pollo salteado con verduras y arroz | Wok violento con sillao y vinagre |
| Bistec a la sartén peruano | Bistec a lo pobre | **Casi-duplicado declarado**: lo separa el plátano y el arroz con choclo |
| Anticuchos peruanos al ají panca | Anticuchos de posta | La marinada de ají panca define el plato |
| Salmón a la florentina | Salmón al horno con papas | Cama de espinaca y papas a la crema gratinadas |
| Salmón a la chorrillana | Salmón a la plancha con arroz | Saltado criollo desglasado sobre el fondo |
| Asado a la olla al vino tinto | Carne mechada | **Casi-duplicado declarado**: vino tinto y aderezo de ají panca |
| Chalaquita | Ensalada chilena | Choclo y picadillo fino: **la más discutible del lote E** |
| Crema volteada | Leche asada | Condensada + evaporada, baño maría y caramelo en el molde |

---

## 4 · Los platos que el director pidió expresamente

Pidió 36. La lista quedó en **37 filas** porque *Plateada* se abre en dos platos distintos
y *Chancho en piedra* entró pegado a *Pebre*. Uno por uno:

| # | Plato pedido | Estado | Qué hacemos |
|---|---|---|---|
| 1 | Fideos con carne | ✅ EXISTE | Es *Tallarines con salsa de carne molida*. No se toca |
| 2 | Arroz con pollo arvejado | ✅ EXISTE | Cubierto por *Arroz con pollo* + *Pollo arvejado*. El combinado se resuelve anidando, no con receta nueva |
| 3 | Pollo arvejado | ✅ EXISTE | Publicada |
| 4 | Garbanzos | ✅ EXISTE | *Garbanzos guisados* (y *Garbanzos con longaniza*) |
| 5 | Garbanzos con arroz | 🟡 VARIANTE | Entra (lote B, nestlé). El arroz cocido dentro cambia el plato |
| 6 | Lentejas | ✅ EXISTE | *Lentejas guisadas* |
| 7 | **Lentejas con arroz** | 🔴 POR CONSTRUIR | **Hueco real: ninguna fuente lo trajo.** Se arma como variante de *Lentejas guisadas* con *Arroz blanco graneado* anidado. No inventamos procedencia |
| 8 | Porotos con riendas | ✅ EXISTE | Publicada |
| 9 | Porotos granados | ✅ EXISTE | Publicada |
| 10 | Porotos con mazamorra | ✅ EXISTE | Publicada |
| 11 | Porotos granados con mazamorra | 🟡 VARIANTE | La mazamorra entra como componente opcional de *Porotos granados*. La cuarta forma que sí falta es *Porotos con mote*, que entra nueva |
| 12 | Tortilla de acelga | 🆕 NUEVA | Lote A (gourmet). La biblioteca ya separa tortilla de papas de tortilla de verduras |
| 13 | Cazuela de pollo | ✅ EXISTE | Publicada |
| 14 | Cazuela de vacuno | ✅ EXISTE | Publicada |
| 15 | Cazuela de osobuco | 🟡 VARIANTE | **No es receta nueva**: solo cambia el corte. Va como alternativa del slot proteína. Lo que sí entra: *Cazuela de cerdo* y *Cazuela de albóndigas* |
| 16 | Charquicán | ✅ EXISTE | Publicada. Entra *Charquicán de cochayuyo* como variante |
| 17 | Carbonada | ✅ EXISTE | Publicada |
| 18 | Sopaipillas | ✅ EXISTE | Publicada. Entra la variante al horno de zapallo y betarraga |
| 19 | Sopaipillas pasadas | ✅ EXISTE | Publicada. Su almíbar de chancaca se anida en *Picarones* |
| 20 | Pescado frito | 🟡 VARIANTE | Publicada la enharinada; entra el rebozado (cerveza o maicena). Aceite **retenido**, nunca el litro de la olla |
| 21 | Humitas | ✅ EXISTE | Publicada |
| 22 | Pastel de choclo | ✅ EXISTE | Publicada. Entra el vegetariano y *Pastelera de choclo* como componente |
| 23 | Pastel de papa | ✅ EXISTE | Es *Pastel de papas*. Entran dos variantes |
| 24 | Empanadas de pino | ✅ EXISTE | Publicada al horno. Entra la frita (4 procedencias) + las dos masas base |
| 25 | Pantrucas | ✅ EXISTE | Publicada |
| 26 | **Completos** | 🔴 POR CONSTRUIR | **Hueco real: ninguna de las siete fuentes lo trajo.** Pide alimento nuevo (vienesa) y formulación propia |
| 27 | Ensalada chilena | ✅ EXISTE | Publicada y ya sirve de acompañamiento anidable |
| 28 | Carne mechada | ✅ EXISTE | Entran dos variantes reales (desmechada en olla a presión, asado a la olla al vino) y el sándwich, que es otro momento |
| 29 | Carne al jugo | 🆕 NUEVA | Lote B. **Tres procedencias colapsadas** en una receta con corte y líquido ajustables |
| 30 | Plateada | 🆕 NUEVA ×2 | *Plateada al horno* (seca, grasa arriba) y *Plateada al jugo* (cubierta, braseada). Asado contra braseado es diferencia real. **Ninguna lleva yieldFactor**: la merma es desconocida |
| 31 | Ajiaco | ✅ EXISTE | Publicada |
| 32 | Caldillo de congrio | 🟡 VARIANTE | Tres procedencias. Lo separa el medallón con espinazo y el fondo con la cabeza |
| 33 | Paila marina | ✅ EXISTE | Ojo: *Sopa de mariscos con pan y leche* y *Mariscal caliente* rozan con ella y quedan declarados como riesgo |
| 34 | Chupe de jaiba | 🟡 VARIANTE | Entra. Los piñones quedan opcionales; ingrediente caro, rango min/max amplio |
| 35 | Pastel de jaiba | 🆕 NUEVA | Tres procedencias. No es chupe: liga con pan en leche y se gratina |
| 36 | Pebre | ✅ EXISTE | Entran *Pebre de coliflor* y *Pebre de mote* |
| 37 | Chancho en piedra | 🆕 NUEVA | Tres procedencias. Distinto del pebre: se maja en mortero y manda el tomate |

**Resumen de los pedidos:** 20 ya existen, 8 entran como variante real, 7 entran nuevas,
**2 son huecos que ninguna fuente cubrió** (*Lentejas con arroz* y *Completos*).

---

## 5 · Postres y once

### 5.1 Postres pedidos

| Postre pedido | Estado | Nota |
|---|---|---|
| Leche asada | ✅ EXISTE | *Crema volteada* entra como variante (baño maría, caramelo en el molde) |
| Arroz con leche | ✅ EXISTE | Publicada |
| Leche nevada | 🆕 NUEVA | Nada va al horno: merengues pochados en leche |
| Sémola con leche | 🆕 NUEVA | Postre de olla: 6 porciones |
| Mote con huesillos | ✅ EXISTE | Es *Mote con huesillo* |
| Sopaipillas pasadas | ✅ EXISTE | Publicada |
| Calzones rotos | 🆕 NUEVA | Tres procedencias. **Aceite retenido obligatorio** |
| Empolvados | 🆕 NUEVA | Tres procedencias. El manjar del relleno lo formulamos nosotros |
| Chilenitos | 🆕 NUEVA | Riesgo con *Alfajores de hojarasca*: lo separa la cubierta de yema y su segundo horno |
| Alfajores | 🆕 NUEVA ×3 | Hojarasca, maicena y chocolate: tres masas realmente distintas |
| Brazo de reina | 🆕 NUEVA | Se enrolla **tibio** o se quiebra: va en el paso |
| Kuchen / Kuchen de frambuesa | 🆕 NUEVA | Un candidato, no cinco: la fruta y el relleno van como alternativas |
| Queque | ✅ EXISTE | *Queque casero de naranja*. Entran 5 más: marmoleado (variante), miel, especias, yogur, manzanas y nueces |
| Panqueques | ✅ EXISTE | Entra *Panqueques con salsa de naranja* como variante |
| Pan de Pascua | 🆕 NUEVA | El ron va declarado con cantidad: el motor tiene que ver el alcohol residual |
| Suspiro limeño | 🆕 NUEVA | Merengue con almíbar caliente sobre manjar. El azúcar acá **es** el postre: va MAIN |
| Crema volteada | 🟡 VARIANTE | De *Leche asada* |

**Total del bloque dulce en la propuesta: 61 recetas** (57 en el lote D + 4 postres
peruanos en el lote E). Ninguna lleva etiqueta de salud; el *Merengón con berries* se
reformula con azúcar granulada porque la fuente usa endulzante sin calorías.

### 5.2 La once

| Pedido | Estado | Nota |
|---|---|---|
| Pan amasado | ✅ EXISTE | Publicada |
| Churrascas | 🆕 NUEVA | Tres procedencias. Sin horno, directo a la sartén |
| Sándwiches | 🆕 NUEVA ×5 | Lengua con palta, carne mechada, Barros Luco, Chacarero, pescado frito |
| Churrasco | ✅ EXISTE | *Churrasco con tomate y palta* |
| Barros Luco | 🆕 NUEVA | Lote C |
| Barros Jarpa | 🟡 VARIANTE | Ninguna fuente lo trajo suelto: sale como alternativa del slot proteína del Barros Luco |
| Ave palta | ✅ EXISTE | *Sandwich de ave palta* |
| Ave mayo | 🟡 VARIANTE | Ninguna fuente lo trajo: variante del ave palta con mayonesa, declarada como formulación nuestra |
| **Completo** | 🔴 POR CONSTRUIR | Hueco real. Pide vienesa como alimento nuevo |
| **Italiano** | 🔴 POR CONSTRUIR | Hueco real. Se construye como variante del completo, una vez que exista |
| **Tostadas** | 🔴 POR CONSTRUIR | Hueco real. Lo más cercano publicado es *Pan con huevo y tomate*. Se formula con marraqueta EDIBLE_PORTION y mantequilla |
| Queques | ✅ EXISTE | Más los cinco nuevos del lote D: la once queda bien cubierta |

**El lote C aporta 23 recetas de once:** 6 panes (marraqueta, churrascas, molde integral,
hamburguesa semi integral, pan de huevo, pan de ajo), 5 sándwiches, 4 de picoteo y
colación, 7 bebidas peruanas de la carta de Tanta y 1 variante de sopaipillas al horno.

---

## 6 · Acompañamientos reutilizables que faltan

Esta es la deuda estructural de la biblioteca: hoy no puede armar un plato completo sin
escribir el arroz otra vez adentro de cada receta.

| Acompañamiento | ¿Existe hoy? | Entra en |
|---|---|---|
| Arroz blanco graneado | ❌ | Lote A · COMPONENTE |
| Arroz a la chilena | ❌ | Lote A |
| Arroz con choclo | ❌ | Lote E · COMPONENTE (la guarnición más repetida de Tanta: 8 platos) |
| Chaufa blanco | ❌ | Lote E · COMPONENTE |
| Puré de zapallo camote | ❌ | Lote A · COMPONENTE |
| Papas fritas caseras | ❌ | Lote A · COMPONENTE |
| Papas asadas a las finas hierbas | ❌ | Lote A · COMPONENTE |
| Papas salteadas con ajo y romero | ❌ | Lote A · COMPONENTE |
| Pastelera de choclo | ❌ | Lote A · COMPONENTE (la pide el pastel de choclo y las empanadas) |
| Masa de empanadas al horno | ❌ | Lote A · COMPONENTE |
| Masa de empanadas fritas | ❌ | Lote A · COMPONENTE |
| Masa de pizza a la piedra | ❌ | Lote A · COMPONENTE |
| Masa de wantán casera | ❌ | Lote F · COMPONENTE (sostiene wantán, suimay, copa de oro y empanaditas) |
| Arroz de sushi | ❌ | Lote F · COMPONENTE (base de todos los rolls) |
| Chancho en piedra | ❌ | Lote A |
| Salsa verde chilena | ❌ | Lote A |
| Leche de tigre | ❌ | Lote E · COMPONENTE (aparece nombrada en 4 platos) |
| Salsa huancaína | ❌ | Lote E · COMPONENTE (aparece en 4 platos) |
| Salsa acevichada | ❌ | Lote E · COMPONENTE |
| Pesto peruano de albahaca y espinaca | ❌ | Lote E · COMPONENTE |
| Sarza criolla | ❌ | Lote E |
| Crema de rocoto | ❌ | Lote E · COMPONENTE |
| Salsa agridulce casera | ❌ | Lote F · COMPONENTE |
| Salsa teriyaki casera | ❌ | Lote F · COMPONENTE |
| Ají chino casero | ❌ | Lote F · COMPONENTE |
| Papo choy salteado con ajo | ❌ | Lote F · COMPONENTE |
| Diente de dragón salteado | ❌ | Lote F · COMPONENTE |
| Ensalada chilena | ✅ | Ya anidable |
| Ensalada verde | ✅ | Ya anidable |
| Pebre | ✅ | Ya anidable |
| Salsa de tomate casera en tanda | ✅ | Ya anidable |
| Pino de carne para congelar | ✅ | Se anida en las empanadas fritas |
| Caldo de pollo casero | ✅ | Se anida en el pollo al cognac |
| Pollo cocido desmenuzado | ✅ | Se anida en la torta de panqueques salada y el guiso de alcachofas |

**28 componentes nuevos** en total. Son los que hacen que las otras 323 recetas no se
repitan a sí mismas.

---

## 7 · Duplicados detectados DENTRO de las 109 actuales

Esto se arregla **antes** de sumar 351, no después.

| Gravedad | Par | Diagnóstico | Acción |
|---|---|---|---|
| 🔴 FUERTE | Pollo al horno con papas ↔ Pollo adobado al horno con ensalada chilena | Es el mismo pollo al horno: cambia el adobo y la guarnición, y la guarnición no es diferencia culinaria | **Fusionar.** El adobo queda como variación — justo donde calza el adobo de naranja |
| 🔴 FUERTE | Arroz con pollo ↔ Pollo con arroz y ensalada chilena | Mismo plato con una ensalada agregada al nombre | **Fusionar.** La ensalada ya es receta propia y se anida |
| 🟠 MEDIO | Pollo al horno con papas ↔ Pollo al horno con tomate y cebolla | Tercer pollo al horno. **Hoy hay 5 recetas de pollo al horno o adobado entre las 109** | Revisar las tres juntas |
| 🟠 MEDIO | Pescado al horno con verduras ↔ Salmón al horno con papas | Mismo molde con otra guarnición si la primera se escribió con salmón | Revisar qué especie usa cada una |
| 🟡 REVISAR | Porotos granados ↔ Porotos con mazamorra | En Chile el clásico es "granados con mazamorra" | Decidir cuál queda canónica |
| 🟡 REVISAR | Caldo de pollo casero ↔ Sopa de pollo con fideos | Si el caldo no es preparación base reutilizable, se solapan | Definir el caldo como componente |
| 🟡 REVISAR | Merluza con arroz y ensalada verde ↔ Merluza frita con arroz | Solo se sostienen como dos si la primera NO va frita | De esto depende el candidato *Pescado frito* |
| 🟡 REVISAR | Bistec con puré ↔ Carne magra con papas y ensalada | Ambas son carne a la plancha con guarnición | Si corte y técnica coinciden, es una sola |

### Cinco preguntas que hay que responder abriendo NUESTRAS recetas

| # | Pregunta | De qué depende |
|---|---|---|
| 1 | ¿La *Sopaipillas* publicada lleva zapallo? | Que la sopaipilla al horno sea variante o duplicado |
| 2 | ¿La *Merluza frita con arroz* va apanada o en batido? | Que *Pescado frito* entre o se caiga |
| 3 | ¿El *Pino de carne para congelar* usa molida o en cubos? | Que sirva para anidarlo en las empanadas fritas |
| 4 | ¿El *Pollo arvejado* lleva papas? | Descartar o no platos de pollo guisado |
| 5 | ¿El *Churrasco con tomate y palta* lleva mayonesa? | Si el "italiano" ya está publicado de hecho |

---

## 8 · El reparto en lotes A–F

| Lote | Título | NUEVA | VARIANTE | **Total** |
|---|---|---|---|---|
| **A** | Chilenas saladas y caseras internacionales — carnes, pescados, ensaladas, salsas, acompañamientos, masas y empanadas | 103 | 24 | **127** |
| **B** | Legumbres y guisos de olla — cazuelas, estofados, sopas, cremas y platos de olla larga | 26 | 6 | **32** |
| **C** | Once y panes — panes, sándwiches, picoteo de once y bebidas | 22 | 1 | **23** |
| **D** | Postres — repostería chilena, queques, tortas, flanes, conservas y confites | 55 | 2 | **57** |
| **E** | Peruana — criolla, chifa peruano, bases anidables y postres limeños | 46 | 11 | **57** |
| **F** | China-chifa y sushi — salteados al wok, frituras, chapsui, fideos, salsas y rolls | 55 | 0 | **55** |
| | **Total** | **307** | **44** | **351** |

**Por qué este orden.** El lote A trae los componentes que todos los demás anidan (arroces,
masas, papas, pastelera): si no va primero, los lotes siguientes se escriben repitiendo
ingredientes en vez de anidar. B cierra la olla larga chilena. C y D son los momentos que
la biblioteca hoy casi no cubre (once y postre: 11 recetas de 109). E y F son las dos
cocinas nuevas, y van al final porque son las que traen más alimentos nuevos.

**Lo que hay que decidir dentro de cada lote antes de escribirlo:**

- **A:** *Reineta con salsa de alcaparras* (¿variante o componente opcional?) y
  *Empanadas de verduras al horno* vs *de pino de champiñón* (se solapan).
- **B:** *Sopa de mariscos con pan y leche* roza *Paila marina*; *Carne a la cerveza* roza
  *Estofado de carne*. Si el director aprieta, cae una de cada par.
- **E:** *Bistec a la sartén peruano* y *Asado a la olla al vino tinto* son casi-duplicados
  declarados de *Bistec a lo pobre* y *Carne mechada*. *Chalaquita* es la más frágil.
- **F:** cero variantes porque no hay con qué chocar: la biblioteca no tiene nada chifa.

---

## 9 · El total final propuesto: **351 recetas**

La biblioteca pasaría de **109 → 460** recetas.

### Por qué 351 y no otro número

**Por qué no menos.** El barrido honesto de siete fuentes dio 404 atribuciones. Después de
colapsar (un plato = una receta) quedan 351 identidades distintas. Bajar de ahí obliga a
botar platos que existen, se cocinan en esta casa y ninguna otra receta cubre. Los recortes
disponibles son chicos: los 8 candidatos de Tanta sin reconfirmar (→ 343) y los ~6
casi-duplicados declarados (→ 337). Menos que eso ya es amputar cocina.

**Por qué no más.** Podrían ser 600 si contara cada línea de carta como receta. No lo hago:

- **150 líneas de carta colapsadas en 30 recetas.** En Casa China la matriz proteína ×
  salsa da ~35 entradas y son 8 técnicas: *Salteado mongoliano* colapsa 5 entradas,
  *Salteado a la china* otras 5, *Chapsui* 5, *Diente de dragón* 4, *Salteado al ajo* 4.
  Los 20+ rolls colapsan en 9 recetas de sushi.
- **53 platos multi-fuente colapsados.** *Empanadas fritas de pino* venía en 4 fuentes;
  *Pulmay* y *Chapaleles* en 4; *Torta de mil hojas* en 4.
- **Todo lo que es alternativa de slot quedó fuera del conteo:** cazuela de osobuco, Barros
  Jarpa, camarón vs pollo en el chaufán, la fruta del kuchen.
- **Lo irreproducible en casa no entra:** curanto en hoyo (va como *Pulmay*), cordero al
  palo (va al horno), pollo al barro, las piedras calientes de la calapurca (dato cultural
  en la descripción, jamás instrucción).

**Lo que el número NO incluye:** las **5 recetas por construir sin procedencia** (Lentejas
con arroz, Completo, Italiano, Tostadas, Ave mayo). Si el director las quiere, son 356 y
hay que declarar que su formulación es enteramente nuestra.

---

## 10 · Alimentos nuevos que hay que crear (~125)

Cada uno necesita ficha `DEV_SEED` con **la base física que la receta le pide** (regla 1) y
`necesitaPorcionComestible` cuando se compra con hueso, cáscara o partes que no se comen
(regla 13). Lo que no se sabe, no se escribe (regla 14).

**Abarrotes, harinas y granos (16)** — maicena · azúcar flor · azúcar rubia · levadura seca ·
harina integral · sémola de trigo · chuchoca · chuño · mote de maíz pelado · quínoa ·
arroz arborio · arroz grano corto para sushi · fideo de arroz · panko · masa de hojaldre ·
galletas de vainilla
> Ojo: la quínoa entra en **dos estados** (RAW para la costra, COOKED para el relleno) o el
> motor suma mal. El arroz de sushi es grano corto: otro rendimiento que el arroz blanco.

**Lácteos y grasas (7)** — crema de leche · leche condensada · leche evaporada · queso
parmesano rallado · queso crema · ricotta · aceite de sésamo
> La condensada y la evaporada son la excepción legítima a la regla de marcas: sin ellas la
> torta tres leches y la crema volteada no existen.

**Vacuno y carnes rojas (9)** — vacuno plateada · vacuno tapapecho · vacuno lomo vetado ·
vacuno filete · vacuno palanca · vacuno osobuco · lengua de vacuno · charqui · pierna de cordero
> Plateada **sin yieldFactor** (merma desconocida). Osobuco y lengua exigen porción comestible.
> El charqui es sodio alto: se declara o se deja ausente, nunca un cero inventado.

**Cerdo y embutidos (7)** — pulpa de cerdo · filete de cerdo · pernil de cerdo · prieta ·
tocino · jamón · vienesa
> La prieta y la vienesa se **compran hechas**: hacer el embutido en casa es charcutería.
> La vienesa solo se crea si se aprueba el Completo.

**Aves (2)** — pavo entero · pavo molido

**Pescados y mariscos (10)** — carne de jaiba · machas · locos · jibia · calamar · camarones ·
ostiones · atún fresco · lisa · kanikama
> **Atún fresco es alimento distinto** del `atun en conserva al agua` (DRAINED) que ya
> existe: si no se declara aparte, el seed revienta.

**Algas (2)** — alga nori · alga china deshidratada

**Verduras y brotes (17)** — coliflor · acelga · espinaca · champiñón · callampas secas ·
berenjena · alcachofa · pepino ensalada · pimiento verde · cebolla morada · cebollín ·
brotes de soja · papo choy · nabo · yuca · alcayota · digüeñes
> "Diente de dragón" es brote de soja, confirmado. Los digüeñes existen dos meses al año:
> el candidato queda marcado como marginal.

**Ajíes y aromáticos (12)** — ají amarillo en pasta · ají panca en pasta · rocoto · merquén ·
ají seco cacho de cabra · jengibre · huacatay · hierba luisa · romero · tomillo · laurel ·
nuez moscada

**Condimentos y salsas envasadas (10)** — mostaza · alcaparras · vinagre tinto · vinagre
blanco · vinagre de arroz · salsa de soya (sillao) · salsa hoisin · salsa de ostión ·
tausi · miel
> El **tausi** y la **soya** son sodio muy alto en poca cantidad: van con gramaje real,
> sin adjetivos, porque el motor renal necesita verlo.

**Frutos secos y semillas (6)** — nueces · almendras · maní · semillas de sésamo ·
coco rallado · fruta confitada
> El **maní** va MAIN (es comida, no grasa añadida) y con alérgeno declarado en el componente.

**Frutas (13)** — frambuesa · frutilla · durazno en conserva · piña · mango · maracuyá ·
chirimoya · puré de lúcuma · ciruela seca · pera · uva · membrillo · plátano de freír
> El **puré de lúcuma se compra endulzado**: es alimento propio, no "lúcuma". El **plátano
> de freír** es otra fruta que el `platano` EDIBLE_PORTION del catálogo. El membrillo exige
> porción comestible.

**Repostería (6)** — cacao amargo en polvo · chocolate cobertura · esencia de vainilla ·
clavo de olor · anís en grano · gelatina sin sabor

**Alcoholes y líquidos de cocina (7)** — vino tinto · vino blanco · cerveza · pisco · ron ·
cognac · oporto
> El alcohol va **con cantidad declarada** (pan de Pascua, peras al vino): el motor clínico
> tiene que poder verlo. Sin etiquetas de salud, solo el dato.

**Proteína vegetal (1)** — carne de soya texturizada

---

## 11 · Procedencia: qué aportó cada fuente

| Fuente | Candidatos | Qué aportó, concretamente |
|---|---|---|
| **gourmet.cl** | **157** (45 %) | La columna vertebral. Casi toda la repostería del lote D (45 de 57), el grueso de pescados y mariscos, las carnes de horno y parrilla, los sándwiches del lote C y las tortillas. Es la única fuente que publica cantidades, porciones y tiempos en todas sus fichas |
| **recetasnestle.cl** | **40** | Las salsas frías (chancho en piedra, salsa verde, chimichurri, pebre de coliflor), la familia de chupes (jaiba, locos, atún, mariscos), los pinos de empanada sin carne, cazuelas de cerdo y albóndigas, y el charquicán de cochayuyo |
| **trekkingchile.com** | **34** | Los platos que **ninguna otra fuente tiene**: Valdiviano, Pataska, Pichanga, papas con chuchoca, lengua con puré de palta, prietas, pernil, arrope de uvas, dulces de alcayota y membrillo, chilenitos, alfajores de hojarasca. Casi todos sin cantidades: la formulación es nuestra |
| **cookpad.com/cl** | **22** | Panadería casera real (marraqueta, molde integral, pan de hamburguesa, churrascas), masa de pizza de fermentación larga, carne desmechada en olla a presión, pollo al cognac, sándwich de lengua, rollos de canela |
| **tur.com** | **7** | Lo andino y lo chilote que no está en ningún recetario: Chairo, Calapurca, Pulmay, Chapaleles, pierna de cordero, y procedencia de apoyo para caldillo de congrio y pastel de jaiba |
| **Tanta (vía Rappi)** | **81** | **Toda la cocina peruana**: lomo saltado, ají de gallina, causa, cebiches, tiraditos, tacu tacu, chaufa, risottos, las pastas, los anticuchos, las cuatro bases anidables (leche de tigre, huancaína, acevichada, pesto peruano), las 7 bebidas del lote C y 5 postres. Más 10 platos internacionales caseros del lote A (pizza y pastas, milanesa napolitana, cobb, guacamole) |
| **Casa China** | **63** | **Todo el chifa y el sushi**: las 8 técnicas de salteado al wok, chapsui, los fideos (chaumín, chaufansí, chow fun), frituras y wantán, parrilladas, las 4 salsas anidables y las 9 recetas de sushi. Más el arroz blanco graneado y las papas fritas del lote A |

### Reglas de procedencia aplicadas

- Cada candidato guarda **nombre de la fuente, URL, nombre del plato en el origen y fecha
  de lectura (2026-08-25)**.
- **Tanta se cita como el agregador**, no como `tanta.cl`: la carta oficial es ilegible.
- **De las cartas no se afirma receta.** Cada receta de los lotes E y F dice, en su
  descripción, que es una **preparación casera inspirada en un plato conocido**. En ningún
  caso decimos conocer la fórmula del restaurante.
- **Sin marcas:** tableta de caldo → caldo casero; crema de marca → crema de leche; mezcla
  lista de bizcocho → bizcocho desde cero; especias de marca → especias genéricas.
- **Sin nutrición copiada:** la nutrición publicada por la fuente no se usa en ninguna
  receta donde cambiamos ingredientes o cantidades.

---

## 12 · Lo que necesito que apruebes

1. **El número: 351** (o 343 si prefieres botar los 8 candidatos de Tanta sin reconfirmar).
2. **Que Tanta se cite como agregador** y no como `tanta.cl`, con la nota de que la carta
   oficial es una galería de imágenes.
3. **Los 5 huecos por construir** (Lentejas con arroz, Completo, Italiano, Tostadas, Ave
   mayo): ¿se formulan desde cero declarando que son nuestros, o se dejan pendientes?
4. **Arreglar los 2 duplicados fuertes de las 109 ANTES de sembrar**, y responder las cinco
   preguntas de la sección 7.
5. **Los ~125 alimentos nuevos**, que son el costo real de esta expansión: cada uno necesita
   ficha con su base física, y sin ficha la receta no se puede sembrar.
6. **El orden A → B → C → D → E → F**, porque los componentes del lote A los anidan todos
   los demás.
