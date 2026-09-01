# Vocabulario del catálogo — generado, no editar a mano

**ARCHIVO GENERADO** desde la base real por
`web/src/integration/vocabulario-catalogo.test.ts`, que falla si este archivo y
la base se separan. Se regenera con `REGENERAR_VOCABULARIO=1`.

Es la ÚNICA lista de identidades contra la que la biblioteca puede escribir. Un
nombre que no esté acá no existe: o se usa el que sí está, o se declara en
`alimentosNuevos`. La primera versión de este archivo la escribió un agente a
mano y quedó pegada en "84 alimentos" mientras la base llegaba a 234: un
autor que la leyera habría redeclarado identidades que ya existían.

## Alimentos disponibles (234)

La columna **bases** manda: si una receta pide una base que el alimento no
tiene, el generador de seed revienta nombrando alimento y base.

| canonical_name | categoría | bases disponibles | porción comestible | medidas |
|---|---|---|---|---|
| `aceite de oliva` | FATS_OILS | AS_PACKAGED (ML) | — | cucharada = 15.00 ML, cucharadita = 5.00 ML |
| `aceite de sesamo` | FATS_OILS | AS_PACKAGED (ML) | 1 | — |
| `aceite vegetal` | FATS_OILS | AS_PACKAGED (ML) | — | — |
| `aceitunas` | VEGETABLES | DRAINED (G) | 0.82 | — |
| `acelga` | VEGETABLES | RAW (G) | 0.7 | — |
| `aji de color` | VEGETABLES | AS_PACKAGED (G) | — | — |
| `aji seco en hojuelas` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `aji verde` | VEGETABLES | RAW (G) | 0.8 | — |
| `ajo` | VEGETABLES | RAW (G) | 0.87 | — |
| `albahaca fresca` | VEGETABLES | RAW (G) | — | — |
| `alcachofa` | VEGETABLES | RAW (G) | 0.35 | — |
| `alcayota` | VEGETABLES | RAW (G) | 0.55 | — |
| `alga nori` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `alga wakame seca` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `alitas de pollo` | POULTRY | RAW (G) | 0.54 | — |
| `almejas` | FISH | RAW (G) | 0.3 | — |
| `almendras` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `anis en grano` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `apio` | VEGETABLES | RAW (G) | 0.75 | — |
| `arandanos` | FRUITS | RAW (G) | — | — |
| `arroz arborio` | GRAINS | RAW (G) | 1 | — |
| `arroz blanco` | GRAINS | COOKED (G), RAW (G) · rinde BOILED 2.8x | — | taza (crudo) = 195.00 G |
| `arroz grano corto` | GRAINS | RAW (G) | 1 | — |
| `arroz integral` | GRAINS | RAW (G) | 1 | — |
| `arvejas frescas` | LEGUMES | RAW (G) | — | — |
| `arvejas partidas secas` | LEGUMES | RAW (G) | 1 | — |
| `atun en conserva al agua` | FISH | DRAINED (G) | — | — |
| `atun fresco` | FISH | RAW (G) | 1 | — |
| `avena tradicional` | GRAINS | RAW (G) | — | cucharada = 10.00 G |
| `azucar flor` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `azucar granulada` | GRAINS | AS_PACKAGED (G) | — | — |
| `berenjena` | VEGETABLES | RAW (G) | 0.92 | — |
| `betarraga` | VEGETABLES | RAW (G) | 0.8 | — |
| `brotes de soya` | VEGETABLES | RAW (G) | 1 | — |
| `cacao amargo en polvo` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `calamar` | FISH | RAW (G) | 0.75 | — |
| `callampa seca` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `camarones` | FISH | RAW (G) | 0.55 | — |
| `camarones pelados` | FISH | RAW (G) | 1 | — |
| `canela en rama` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `canela molida` | VEGETABLES | AS_PACKAGED (G) | — | — |
| `carne de jaiba` | FISH | RAW (G) | 1 | — |
| `carne de soya` | LEGUMES | AS_PACKAGED (G) | 1 | — |
| `carne molida de vacuno` | MEAT | RAW (G) | — | — |
| `cebolla` | VEGETABLES | RAW (G) | 0.9 | — |
| `cebolla morada` | VEGETABLES | RAW (G) | 0.9 | — |
| `cebollin` | VEGETABLES | RAW (G) | 0.8 | — |
| `cerveza` | GRAINS | AS_PACKAGED (ML) | 1 | — |
| `champinon` | VEGETABLES | RAW (G) | 0.97 | — |
| `chancaca` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `charqui` | MEAT | AS_PACKAGED (G) | 1 | — |
| `chirimoya` | FRUITS | EDIBLE_PORTION (G) | 0.68 | — |
| `choclo en grano` | VEGETABLES | RAW (G) | — | — |
| `choclo fresco entero` | VEGETABLES | RAW (G) | 0.33 | — |
| `chocolate amargo de reposteria` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `chocolate semiamargo` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `choritos` | FISH | RAW (G) | 0.3 | — |
| `chuchoca` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `chuleta de cerdo` | MEAT | RAW (G) | 0.8 | — |
| `chuno` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `cilantro` | VEGETABLES | RAW (G) | — | — |
| `ciruelas secas` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `clara de huevo` | EGGS | EDIBLE_PORTION (G) | 0.6 | — |
| `clavo de olor molido` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `cochayuyo` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `coco rallado` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `cognac` | FRUITS | AS_PACKAGED (ML) | 1 | — |
| `coliflor` | VEGETABLES | RAW (G) | 0.6 | — |
| `comino molido` | VEGETABLES | AS_PACKAGED (G) | — | — |
| `congrio` | FISH | RAW (G) | 1 | — |
| `costillar de cerdo` | MEAT | RAW (G) | 0.7 | — |
| `crema de leche` | DAIRY | AS_PACKAGED (ML) | 1 | — |
| `crema para batir` | DAIRY | AS_PACKAGED (ML) | 1 | — |
| `cuero de cerdo` | MEAT | RAW (G) | 1 | — |
| `diguenes` | VEGETABLES | RAW (G) | — | — |
| `duraznos en conserva` | FRUITS | DRAINED (G) | 1 | — |
| `esencia de vainilla` | GRAINS | AS_PACKAGED (ML) | 1 | — |
| `espinaca` | VEGETABLES | RAW (G) | 0.85 | — |
| `fideos` | GRAINS | RAW (G) | — | — |
| `fideos de arroz` | GRAINS | RAW (G) | 1 | — |
| `filete de cerdo` | MEAT | RAW (G) | 1 | — |
| `frambuesas` | FRUITS | RAW (G) | 1 | — |
| `fruta confitada` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `frutillas` | FRUITS | RAW (G) | 0.94 | — |
| `galletas de soda` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `galletas de vainilla` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `galletas de vino` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `garbanzos secos` | LEGUMES | RAW (G) | — | — |
| `gelatina sin sabor` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `guatitas` | MEAT | RAW (G) | 1 | — |
| `guindas en conserva` | FRUITS | DRAINED (G) | 1 | — |
| `gyozas de pollo congeladas` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `harina de almendras` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `harina de trigo` | GRAINS | RAW (G) | — | — |
| `harina de trigo integral` | GRAINS | RAW (G) | 1 | — |
| `helado de vainilla` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `hierba luisa` | VEGETABLES | RAW (G) | 1 | — |
| `huesillos` | FRUITS | AS_PACKAGED (G) | 0.7 | — |
| `huevo de gallina` | EGGS | EDIBLE_PORTION (G) | 0.88 | unidad = 55.00 G |
| `jamon de cerdo cocido` | MEAT | AS_PACKAGED (G) | 1 | — |
| `jengibre fresco` | VEGETABLES | RAW (G) | 0.85 | — |
| `jengibre molido` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `jibia` | FISH | RAW (G) | 1 | — |
| `kanikama` | FISH | AS_PACKAGED (G) | 1 | — |
| `laurel seco` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `leche condensada` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `leche evaporada` | DAIRY | AS_PACKAGED (ML) | 1 | — |
| `leche liquida entera` | DAIRY | AS_PACKAGED (ML) | — | — |
| `lechuga` | VEGETABLES | RAW (G) | — | — |
| `lengua de vaca` | MEAT | RAW (G) | 0.7 | — |
| `lentejas` | LEGUMES | COOKED (G), RAW (G) · rinde BOILED 2.5x | — | — |
| `levadura seca` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `limon` | FRUITS | RAW (G) | 0.45 | — |
| `limon de pica` | FRUITS | RAW (G) | 0.45 | — |
| `lisa` | FISH | RAW (G) | 0.45 | — |
| `locos` | FISH | RAW (G) | 1 | — |
| `longaniza` | MEAT | RAW (G) | 1 | — |
| `lucuma` | FRUITS | EDIBLE_PORTION (G) | 0.65 | — |
| `machas` | FISH | RAW (G) | 0.25 | — |
| `maicena` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `maiz chulpe` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `maiz morado seco` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `malaya de cerdo` | MEAT | RAW (G) | 1 | — |
| `mango` | FRUITS | EDIBLE_PORTION (G) | 0.65 | — |
| `mani tostado` | LEGUMES | AS_PACKAGED (G) | 1 | — |
| `manjar` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `manteca de cerdo` | FATS_OILS | AS_PACKAGED (G) | 1 | — |
| `mantequilla` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `manzana` | FRUITS | EDIBLE_PORTION (G) | 0.9 | unidad = 150.00 G |
| `maracuya` | FRUITS | EDIBLE_PORTION (G) | 0.5 | — |
| `masa de hojaldre` | BREAD | AS_PACKAGED (G) | 1 | — |
| `masa de wantan` | BREAD | AS_PACKAGED (G) | 1 | — |
| `masa para arrollado primavera` | BREAD | AS_PACKAGED (G) | 1 | — |
| `mayonesa` | FATS_OILS | AS_PACKAGED (G) | 1 | — |
| `membrillo` | FRUITS | EDIBLE_PORTION (G) | 0.75 | — |
| `menta fresca` | VEGETABLES | RAW (G) | 1 | — |
| `merluza` | FISH | RAW (G) | — | — |
| `mermelada` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `merquen` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `miel` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `mostaza` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `mote de maiz` | GRAINS | RAW (G) | 1 | — |
| `mote de trigo` | GRAINS | RAW (G) | 1 | — |
| `nabo` | VEGETABLES | RAW (G) | 0.85 | — |
| `naranja` | FRUITS | EDIBLE_PORTION (G) | 0.72 | — |
| `nueces` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `nuez moscada molida` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `oregano seco` | VEGETABLES | AS_PACKAGED (G) | — | — |
| `osobuco de vacuno` | MEAT | RAW (G) | 0.75 | — |
| `ostiones` | FISH | RAW (G) | 1 | — |
| `palta` | FRUITS | EDIBLE_PORTION (G) | 0.74 | — |
| `pan de molde` | BREAD | AS_PACKAGED (G) | 1 | — |
| `pan marraqueta` | BREAD | EDIBLE_PORTION (G) | 1 | — |
| `pan rallado` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `panko` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `papa` | VEGETABLES | RAW (G) | — | — |
| `papo choy` | VEGETABLES | RAW (G) | 0.85 | — |
| `pasas` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `pasta de aji amarillo` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `pasta de aji panca` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `pasta de huacatay` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `pasta de rocoto` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `pavo entero` | POULTRY | RAW (G) | 0.62 | — |
| `pavo molido` | POULTRY | RAW (G) | 1 | — |
| `pechuga de pollo sin piel` | POULTRY | COOKED (G), RAW (G) | 1 | — |
| `pepinillos en conserva` | VEGETABLES | DRAINED (G) | 1 | — |
| `pepino` | VEGETABLES | RAW (G) | 0.75 | — |
| `pera` | FRUITS | EDIBLE_PORTION (G) | 0.78 | — |
| `perejil fresco` | VEGETABLES | RAW (G) | — | — |
| `pernil de cerdo` | MEAT | RAW (G) | 0.75 | — |
| `pierna de cordero` | MEAT | RAW (G) | 0.73 | — |
| `pimienta negra` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `pimiento rojo` | VEGETABLES | RAW (G) | 0.82 | — |
| `pina` | FRUITS | EDIBLE_PORTION (G) | 0.5 | — |
| `pina en conserva` | FRUITS | DRAINED (G) | 1 | — |
| `pisco` | GRAINS | AS_PACKAGED (ML) | 1 | — |
| `platano` | FRUITS | EDIBLE_PORTION (G) | 0.64 | unidad = 120.00 G |
| `platano macho` | FRUITS | EDIBLE_PORTION (G) | 0.65 | — |
| `plateada de vacuno` | MEAT | RAW (G) | 0.85 | — |
| `pollo entero con piel` | POULTRY | RAW (G) | 0.68 | — |
| `pollo trutro entero con piel` | POULTRY | RAW (G) | 0.7 | — |
| `polvos de hornear` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `poroto verde` | VEGETABLES | RAW (G) | — | — |
| `porotos granados frescos` | LEGUMES | RAW (G) | — | — |
| `porotos secos` | LEGUMES | RAW (G) | — | — |
| `prieta` | MEAT | RAW (G) | 1 | — |
| `pulpa de cerdo` | MEAT | RAW (G) | 1 | — |
| `pulpa de maracuya` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `pure de lucuma endulzado` | FRUITS | AS_PACKAGED (G) | 1 | — |
| `quesillo` | DAIRY | AS_PACKAGED (G) | — | — |
| `queso crema` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `queso mantecoso` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `queso parmesano rallado` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `quinoa` | GRAINS | COOKED (G), RAW (G) · rinde BOILED 2.7x | 1 | — |
| `ravioles frescos` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `reineta` | FISH | RAW (G) | — | — |
| `repollo` | VEGETABLES | RAW (G) | 0.8 | — |
| `ricotta` | DAIRY | AS_PACKAGED (G) | 1 | — |
| `rocoto` | VEGETABLES | RAW (G) | 0.75 | — |
| `romero seco` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `ron` | GRAINS | AS_PACKAGED (ML) | 1 | — |
| `sal` | FATS_OILS | AS_PACKAGED (G) | — | — |
| `salmon` | FISH | RAW (G) | — | — |
| `salsa de soya` | VEGETABLES | AS_PACKAGED (ML) | 1 | — |
| `salsa de tomate envasada` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `salsa hoisin` | LEGUMES | AS_PACKAGED (G) | 1 | — |
| `semillas de sesamo` | GRAINS | AS_PACKAGED (G) | 1 | — |
| `semola de trigo` | GRAINS | RAW (G) | 1 | — |
| `tausi` | LEGUMES | AS_PACKAGED (G) | 1 | — |
| `te negro` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `tocino` | MEAT | RAW (G) | 1 | — |
| `tomate` | VEGETABLES | RAW (G) | — | — |
| `tomates secos` | VEGETABLES | AS_PACKAGED (G) | 1 | — |
| `vacuno asado de tira` | MEAT | RAW (G) | 0.7 | — |
| `vacuno asiento picana` | MEAT | RAW (G) | — | — |
| `vacuno filete` | MEAT | RAW (G) | 0.85 | — |
| `vacuno lomo liso` | MEAT | RAW (G) | 0.9 | — |
| `vacuno lomo vetado` | MEAT | RAW (G) | 0.9 | — |
| `vacuno palanca` | MEAT | RAW (G) | 0.85 | — |
| `vacuno posta magra` | MEAT | RAW (G) | — | — |
| `vacuno posta negra` | MEAT | RAW (G) | — | — |
| `vacuno tapapecho` | MEAT | RAW (G) | 1 | — |
| `vinagre` | VEGETABLES | AS_PACKAGED (ML) | 1 | — |
| `vinagre blanco` | GRAINS | AS_PACKAGED (ML) | 1 | — |
| `vinagre de arroz` | GRAINS | AS_PACKAGED (ML) | 1 | — |
| `vinagre tinto` | FRUITS | AS_PACKAGED (ML) | 1 | — |
| `vino blanco` | FRUITS | AS_PACKAGED (ML) | 1 | — |
| `vino tinto` | FRUITS | AS_PACKAGED (ML) | 1 | — |
| `yema de huevo` | EGGS | EDIBLE_PORTION (G) | 0.33 | — |
| `yogur natural` | DAIRY | AS_PACKAGED (G) | — | — |
| `yuca` | VEGETABLES | RAW (G) | 0.78 | — |
| `zanahoria` | VEGETABLES | RAW (G) | 0.89 | — |
| `zapallo camote` | VEGETABLES | RAW (G) | 0.75 | — |
| `zapallo italiano` | VEGETABLES | RAW (G) | — | — |

## Recetas ya publicadas (458) — NO repetir

Ni el nombre exacto ni el mismo plato con otro nombre. Un plato que solo cambia
la salsa contra uno publicado es una variante: o la diferencia culinaria se nota
de verdad, o va a `noEscritos` con su razón.

- Ají chino casero
- Ají de gallina
- Ajiaco
- Albóndigas en salsa de mostaza
- Albóndigas en salsa de tomate
- Alfajores de chocolate
- Alfajores de hojarasca
- Alfajores de maicena
- Alitas de pollo al horno con papas
- Almendras caramelizadas al merquén
- Anticuchos de posta con cebolla y pimiento
- Anticuchos de verduras a la parrilla
- Anticuchos peruanos al ají panca
- Apanado chifa en batido de maicena
- Arrollado de huaso
- Arrollado de jamón y queso frito
- Arrollado de marisco al vapor
- Arrollado primavera
- Arroz a la chilena
- Arroz al cilantro
- Arroz blanco graneado
- Arroz chaufán de pollo
- Arroz chaufán especial
- Arroz con choclo
- Arroz con choritos
- Arroz con crema de choclo
- Arroz con huevo frito
- Arroz con leche
- Arroz con pollo
- Arroz de sushi
- Arroz primavera
- Arvejas frescas guisadas con huevo
- Asado a la olla al vino tinto
- Asado de tira a la cerveza
- Asado de tira a la parrilla con ensalada chilena
- Asado de tira al horno
- Asado de vacuno al horno con papas
- Atún sellado con miel de ajonjolí
- Avena con leche y plátano
- Banana split
- Banoffee de plátano
- Barras de avena, frutos secos y chocolate
- Batido de chirimoya, arándanos y avena
- Batido tropical de mango y piña
- Berlines con crema pastelera
- Bistec a la sartén peruano
- Bistec a lo pobre
- Bistec con puré
- Bizcocho de chocolate
- Brazo de reina
- Brochetas de cerdo adobadas a la parrilla
- Brownie con mousse de chocolate
- Budín de atún
- Budín de pan
- Budín de zapallo italiano al horno
- Calamar Casa China
- Calapurca
- Caldillo de congrio
- Caldillo de huevo
- Caldillo de merluza
- Caldo de pollo casero
- California roll casero
- Calugas caseras
- Calzones rotos
- Camarón fuyón
- Camarones al pil pil
- Canapés de charqui
- Cancha serrana
- Carbonada
- Carne a la cerveza
- Carne a la mostaza con champiñones
- Carne al jugo
- Carne desmechada en olla a presión
- Carne especial china
- Carne magra con papas y ensalada
- Carne mechada
- Carne rellena
- Carne salteada a la soya
- Causa limeña
- Cazuela de albóndigas
- Cazuela de ave nogada
- Cazuela de cerdo
- Cazuela de pollo
- Cazuela de vacuno
- Cebiche carretillero
- Cebiche mixto
- Cerdo asado con pimentón y cebolla morada
- Cerdo crocante a la miel picante
- Ceviche de cochayuyo
- Ceviche de reineta
- Chacarero
- Chairo
- Chalaquita
- Chancho en piedra
- Chapaleles
- Chapsui
- Chapsui de verduras
- Chapsui especial
- Charquicán
- Charquicán de cochayuyo
- Chaufa blanco
- Chaufansí de pollo
- Chaumín de pollo
- Chaumín de verduras
- Chaumín especial
- Chicha morada
- Chicharrón chifa
- Chicharrón mixto de mar
- Chilenitos
- Chimichurri chileno de cebollín y cilantro
- Chips de vegetales al horno
- Choclo a la mantequilla
- Choritos al vapor con limón
- Chorrillana
- Chow fun de verduras con huevo
- Chuletas de cerdo a la plancha con pure
- Chumbeque
- Chupe de atún
- Chupe de camarones
- Chupe de jaiba
- Chupe de jibia
- Chupe de locos
- Chupe de mariscos
- Chupe de pescado
- Churrascas
- Churrasco con tomate y palta
- Churros
- Cocadas
- Cochayuyo guisado con papas
- Congrio al horno en papillote
- Copa de merengue con crema y duraznos
- Copa de oro
- Costillar cantonés
- Costillar de cerdo al horno con papas
- Costillitas de choclo a la barbacoa
- Crema de arvejas
- Crema de choritos
- Crema de rocoto
- Crema de verduras
- Crema de zapallo
- Crema de zapallo italiano y albahaca
- Crema volteada
- Croquetas de atún y arroz
- Diente de dragón con proteína
- Diente de dragón salteado
- Dip de pastelera de choclo
- Dulce de alcayota
- Dulce de membrillo
- Empanadas de jamón, queso y cebolla caramelizada
- Empanadas de lomo saltado
- Empanadas de machas a la parmesana
- Empanadas de mariscos
- Empanadas de pastelera de choclo
- Empanadas de pino al horno
- Empanadas de pino de berenjena
- Empanadas de pino de champiñón
- Empanadas de queso fritas
- Empanadas de verduras al horno
- Empanadas fritas de ají de gallina
- Empanadas fritas de manzana
- Empanadas fritas de pino
- Empanaditas fritas de camarón
- Empolvados
- Encurtido rápido de nabo
- Ensalada chilena
- Ensalada cobb casera
- Ensalada de arroz
- Ensalada de atún con papas y huevo
- Ensalada de betarraga con cebolla
- Ensalada de choclo con tomate y albahaca
- Ensalada de digüeñes
- Ensalada de garbanzos con huevo y tomate
- Ensalada de mote
- Ensalada de pepino con tomate
- Ensalada de pollo con papas y arvejas
- Ensalada de porotos con cebolla y huevo
- Ensalada de porotos granados
- Ensalada de repollo con zanahoria
- Ensalada nikkei con pollo crocante
- Ensalada rusa
- Ensalada surtida de papa, betarraga y huevo
- Ensalada verde
- Ensalada verde con frutillas y queso
- Escalopas de pollo apanadas con puré
- Escalopas de vacuno rellenas con tocino y queso
- Estofado de carne
- Estofado de osobuco
- Fetuccinis a la crema con pollo y champiñones
- Fetuccinis a la huancaína con saltado de pollo
- Fideos con atún
- Filete a la parrilla con papas asadas
- Filete a la pimienta con gratín de papas
- Filete de cerdo al merquén
- Flan de anís
- Flan de manjar
- Fritos de pollo al sésamo y almendras
- Galletas de anís
- Galletas de canela y chocolate
- Galletas de Navidad con especias
- Garbanzos con arroz
- Garbanzos con longaniza
- Garbanzos guisados
- Gohan mixto
- Gratín de jaiba
- Guacamole
- Guatitas a la jardinera
- Guiso de alcachofas y pollo
- Guiso de porotos verdes con papas y huevo
- Guiso de verduras
- Gyozas
- Hamburguesas caseras en marraqueta
- Hamburguesas de carne de soya
- Hamburguesas de lentejas
- Hamburguesas de pavo
- Handroll de sushi
- Hot roll frito en panko
- Huevo a la copa con marraqueta
- Huevos revueltos con pan
- Humitas
- Hunán de pescado con ají
- Jugo de betarraga, zanahoria y limón
- Jugo verde de pepino, manzana y apio
- Kuchen de frambuesa
- Leche asada
- Leche de tigre
- Leche nevada
- Lengua de vaca con puré de palta
- Lentejas guisadas
- Limonada de hierba luisa
- Lisa al horno
- Locos mayo
- Lomo con salsa al vino
- Lomo saltado
- Lomo vetado a la parrilla
- Macarrones franceses
- Machas a la parmesana
- Machas en salsa verde
- Macho ruso
- Malaya rellena
- Manzanas acarameladas
- Manzanas asadas rellenas con nueces
- Mariscal caliente
- Marraqueta casera
- Masa de empanadas al horno
- Masa de empanadas fritas
- Masa de pizza a la piedra
- Masa de wantán casera
- Menestrón peruano
- Merengón con berries
- Merluza con arroz y ensalada verde
- Merluza frita con arroz
- Milanesa a la napolitana
- Milanesa con tallarines al pesto peruano
- Milcao
- Mote con huesillo
- Mote con machas y salsa verde
- Mousse de atún
- Mousse de lúcuma
- Nigiri de salmón
- Niños envueltos
- Once con quesillo y palta
- Paila marina
- Pajaritos
- Palanca a la parrilla
- Palmeritas
- Palta reina
- Pan amasado
- Pan con huevo y tomate
- Pan de ajo al horno
- Pan de hamburguesa semi integral
- Pan de huevo
- Pan de molde integral
- Pan de Pascua
- Panqueques con manjar
- Panqueques con salsa de naranja
- Pantrucas
- Papas asadas a las finas hierbas
- Papas con chuchoca
- Papas fritas caseras
- Papas gringas rellenas con choclo y queso
- Papas mayo
- Papas rellenas
- Papas salteadas con ajo y romero
- Papo choy salteado con ajo
- Parrilla china de carnes
- Parrilla china de mariscos
- Pasta con mariscos a la criolla
- Pasta con pollo
- Pasta Lima thai de pollo
- Pastel de choclo
- Pastel de choclo vegetariano
- Pastel de jaiba
- Pastel de papas
- Pastel de papas con pino de champiñones
- Pastel de pescado
- Pastel de salmón, camarones y papas
- Pastelera de choclo
- Pastelera de choclo con verduras asadas
- Pataska
- Pavo al horno marinado con hierbas
- Pebre
- Pebre de coliflor
- Pebre de mote
- Pechuga a la plancha con dos ensaladas
- Peras al vino tinto
- Pernil de cerdo con papas doradas
- Pescado a lo macho
- Pescado al horno con verduras
- Pescado con costra de quínoa
- Pescado con salsa de mariscos
- Pescado frito
- Pescado gratinado con costra de pan rallado
- Pesto peruano de albahaca y espinaca
- Picante de guatitas
- Picarones
- Pichanga
- Pie de carne y papas
- Pie de limón
- Pie de pollo
- Pierna de cordero al horno con papas
- Pimientos rellenos
- Pino de carne para congelar
- Pizza casera de queso y tomate
- Plátano maduro frito
- Plateada al horno
- Plateada al jugo
- Pollo a la mostaza
- Pollo a la parrilla con verduras asadas
- Pollo adobado al horno con ensalada chilena
- Pollo al champiñón
- Pollo al cognac con champiñones
- Pollo al horno con papas
- Pollo al horno con tomate y cebolla
- Pollo al jugo con arroz
- Pollo al vino blanco
- Pollo arvejado
- Pollo asado al limón
- Pollo cocido desmenuzado
- Pollo con arroz y ensalada chilena
- Pollo con piña agridulce
- Pollo crocante en salsa chijaukay
- Pollo entero asado al jugo de naranja
- Pollo escabechado
- Pollo frito con papas fritas
- Pollo guisado con choclo y zapallo italiano
- Pollo pekín
- Pollo salteado a la piña con sésamo
- Pollo salteado con verduras y arroz
- Porotos con longaniza
- Porotos con mazamorra
- Porotos con mote
- Porotos con riendas
- Porotos granados
- Postre de lúcuma con galletas
- Prietas con papas
- Pulmay (curanto en olla)
- Pulpa de cerdo con ciruelas
- Puré de zapallo camote
- Queque casero de naranja
- Queque de especias
- Queque de manzanas y nueces
- Queque de miel
- Queque de yogur
- Queque marmoleado
- Ravioles de asado al vino tinto
- Ravioles de ricotta en salsa de tomate fresco
- Reineta a la plancha con ensalada
- Reineta apanada con puré
- Reineta en salsa atomatada
- Risotto acevichado con mariscos
- Risotto criollo de zapallo
- Roll envuelto en palta
- Roll envuelto en salmón
- Roll sin arroz
- Roll tempura
- Rollitos de pan de molde con huevo y jamón
- Rollos de canela
- Salmón a la chorrillana
- Salmón a la florentina
- Salmón a la plancha con arroz
- Salmón al horno con papas
- Salmón pochado con reducción cítrica
- Salpicón de verduras
- Salsa acevichada
- Salsa agridulce casera
- Salsa de tomate casera en tanda
- Salsa huancaína
- Salsa teriyaki casera
- Salsa verde chilena
- Saltado criollo de pollo
- Salteado a la china con alga y champiñón
- Salteado al ajo
- Salteado chitén con maní
- Salteado con champiñones
- Salteado mongoliano
- Salteado sichiu
- Salteado tausi
- Sándwich Barros Luco
- Sándwich de atún con cebolla
- Sandwich de ave palta
- Sándwich de carne mechada
- Sándwich de lengua con palta
- Sándwich de pescado frito
- Sarza criolla
- Selva negra
- Sémola con leche
- Solomillo de cerdo a la pimienta
- Sopa capón con gyozas
- Sopa criolla de cabello de ángel
- Sopa de arvejas partidas
- Sopa de mariscos chifa
- Sopa de mariscos con pan y leche
- Sopa de pollo con fideos
- Sopa de verduras con fideos
- Sopa wantán
- Sopaipillas
- Sopaipillas al horno de zapallo y betarraga
- Sopaipillas pasadas
- Spaghetti al ajillo
- Spaghetti mediterráneo
- Spring rolls de lomo saltado
- Sudado de pescado
- Suimay al vapor
- Suprema de pollo Maryland
- Suspiro limeño
- Tacu tacu a lo pobre
- Tacu tacu de porotos
- Tallarín saltado
- Tallarines con salsa de carne molida
- Tallarines con salsa de tomate
- Tarta de duraznos y limón
- Tarta de manzana
- Tartaleta de maracuyá
- Té helado de maracuyá y naranja
- Tequeños de ají de gallina
- Tiradito de reineta en crema de ají amarillo
- Tomatican
- Torta de merengue con lúcuma
- Torta de mil hojas
- Torta de panqueques con manjar
- Torta de panqueques salada de pollo
- Torta de yogur con base de galletas
- Torta tres leches
- Tortilla de acelga
- Tortilla de cebolla
- Tortilla de papas
- Tortilla de porotos verdes
- Tortilla de verduras
- Trutros al horno con arroz integral y champiñones
- Turron de vino
- Valdiviano
- Wantán frito
- Yogur con arándanos y plátano
- Yuca cocida al ajo
- Zapallitos italianos rellenos con carne
- Zapallitos italianos rellenos con pesto de tomates secos
- Zapallo italiano apanado al horno
- Zapallo italiano guisado con carne molida
