# Registro acumulado — Biblioteca chilena (Sprint 11.5)

**ARCHIVO GENERADO.** Se produce desde la base real y la biblioteca con
`web/src/integration/registro-acumulado.test.ts`, y se regenera después de cada
lote. No editar a mano: el test falla si este archivo y la realidad se separan.

**Estado de la BASE DE PRUEBAS**, que es donde se mide esto: 458 recetas · 234 alimentos · 211 agregados por la biblioteca · 449 recetas en la biblioteca tipada.

> **Esto NO es producción.** El número sale de aplicar migraciones y seeds sobre un Postgres
> efímero, no de consultar la base real. La biblioteca vive en
> `supabase/seed/dev_recipes_biblioteca.sql`, cuya primera línea dice "NO aplicar en
> producción sin revisión" — porque su nutrición es `DEV_SEED`, valores de referencia de
> desarrollo y no datos del INTA. Mientras ese seed no se aplique, producción sigue con los 23
> alimentos originales y ninguna de estas recetas.
>
> Acá decía "recetas publicadas", y eso se leía como "están en la base". No lo estaban. Una
> auditoría lo levantó como una promesa que el sistema no cumple, y tenía razón: el número era
> aritmética sobre los arreglos del código.

> **Regla que gobierna estos registros:** señalan huecos, no los rellenan.
> Ningún factor de porción comestible ni de rendimiento se inventa para que una
> tabla se vea completa. Un hueco declarado es información; un número inventado
> es un error que viaja hasta la lista de compras.

---

## 1 · Alimentos con nutrición `DEV_SEED`

Valores de referencia de desarrollo. **No** son datos de la Tabla de Composición
Química de los Alimentos Chilenos (INTA). El constraint
`nutrition_unverifiable_sources` impide marcarlos como verificados; la columna
"¿verificado?" debe decir "no" en todas las filas.

| alimento | bases | ¿verificado? |
|---|---|---|
| `aceite de oliva` | AS_PACKAGED | no |
| `aceite de sesamo` | AS_PACKAGED | no |
| `aceite vegetal` | AS_PACKAGED | no |
| `aceitunas` | DRAINED | no |
| `acelga` | RAW | no |
| `aji de color` | AS_PACKAGED | no |
| `aji seco en hojuelas` | AS_PACKAGED | no |
| `aji verde` | RAW | no |
| `ajo` | RAW | no |
| `albahaca fresca` | RAW | no |
| `alcachofa` | RAW | no |
| `alcayota` | RAW | no |
| `alga nori` | AS_PACKAGED | no |
| `alga wakame seca` | AS_PACKAGED | no |
| `alitas de pollo` | RAW | no |
| `almejas` | RAW | no |
| `almendras` | AS_PACKAGED | no |
| `anis en grano` | AS_PACKAGED | no |
| `apio` | RAW | no |
| `arandanos` | RAW | no |
| `arroz arborio` | RAW | no |
| `arroz blanco` | COOKED, RAW | no |
| `arroz grano corto` | RAW | no |
| `arroz integral` | RAW | no |
| `arvejas frescas` | RAW | no |
| `arvejas partidas secas` | RAW | no |
| `atun en conserva al agua` | DRAINED | no |
| `atun fresco` | RAW | no |
| `avena tradicional` | RAW | no |
| `azucar flor` | AS_PACKAGED | no |
| `azucar granulada` | AS_PACKAGED | no |
| `berenjena` | RAW | no |
| `betarraga` | RAW | no |
| `brotes de soya` | RAW | no |
| `cacao amargo en polvo` | AS_PACKAGED | no |
| `calamar` | RAW | no |
| `callampa seca` | AS_PACKAGED | no |
| `camarones` | RAW | no |
| `camarones pelados` | RAW | no |
| `canela en rama` | AS_PACKAGED | no |
| `canela molida` | AS_PACKAGED | no |
| `carne de jaiba` | RAW | no |
| `carne de soya` | AS_PACKAGED | no |
| `carne molida de vacuno` | RAW | no |
| `cebolla` | RAW | no |
| `cebolla morada` | RAW | no |
| `cebollin` | RAW | no |
| `cerveza` | AS_PACKAGED | no |
| `champinon` | RAW | no |
| `chancaca` | AS_PACKAGED | no |
| `charqui` | AS_PACKAGED | no |
| `chirimoya` | EDIBLE_PORTION | no |
| `choclo en grano` | RAW | no |
| `choclo fresco entero` | RAW | no |
| `chocolate amargo de reposteria` | AS_PACKAGED | no |
| `chocolate semiamargo` | AS_PACKAGED | no |
| `choritos` | RAW | no |
| `chuchoca` | AS_PACKAGED | no |
| `chuleta de cerdo` | RAW | no |
| `chuno` | AS_PACKAGED | no |
| `cilantro` | RAW | no |
| `ciruelas secas` | AS_PACKAGED | no |
| `clara de huevo` | EDIBLE_PORTION | no |
| `clavo de olor molido` | AS_PACKAGED | no |
| `cochayuyo` | AS_PACKAGED | no |
| `coco rallado` | AS_PACKAGED | no |
| `cognac` | AS_PACKAGED | no |
| `coliflor` | RAW | no |
| `comino molido` | AS_PACKAGED | no |
| `congrio` | RAW | no |
| `costillar de cerdo` | RAW | no |
| `crema de leche` | AS_PACKAGED | no |
| `crema para batir` | AS_PACKAGED | no |
| `cuero de cerdo` | RAW | no |
| `diguenes` | RAW | no |
| `duraznos en conserva` | DRAINED | no |
| `esencia de vainilla` | AS_PACKAGED | no |
| `espinaca` | RAW | no |
| `fideos` | RAW | no |
| `fideos de arroz` | RAW | no |
| `filete de cerdo` | RAW | no |
| `frambuesas` | RAW | no |
| `fruta confitada` | AS_PACKAGED | no |
| `frutillas` | RAW | no |
| `galletas de soda` | AS_PACKAGED | no |
| `galletas de vainilla` | AS_PACKAGED | no |
| `galletas de vino` | AS_PACKAGED | no |
| `garbanzos secos` | RAW | no |
| `gelatina sin sabor` | AS_PACKAGED | no |
| `guatitas` | RAW | no |
| `guindas en conserva` | DRAINED | no |
| `gyozas de pollo congeladas` | AS_PACKAGED | no |
| `harina de almendras` | AS_PACKAGED | no |
| `harina de trigo` | RAW | no |
| `harina de trigo integral` | RAW | no |
| `helado de vainilla` | AS_PACKAGED | no |
| `hierba luisa` | RAW | no |
| `huesillos` | AS_PACKAGED | no |
| `huevo de gallina` | EDIBLE_PORTION | no |
| `jamon de cerdo cocido` | AS_PACKAGED | no |
| `jengibre fresco` | RAW | no |
| `jengibre molido` | AS_PACKAGED | no |
| `jibia` | RAW | no |
| `kanikama` | AS_PACKAGED | no |
| `laurel seco` | AS_PACKAGED | no |
| `leche condensada` | AS_PACKAGED | no |
| `leche evaporada` | AS_PACKAGED | no |
| `leche liquida entera` | AS_PACKAGED | no |
| `lechuga` | RAW | no |
| `lengua de vaca` | RAW | no |
| `lentejas` | COOKED, RAW | no |
| `levadura seca` | AS_PACKAGED | no |
| `limon` | RAW | no |
| `limon de pica` | RAW | no |
| `lisa` | RAW | no |
| `locos` | RAW | no |
| `longaniza` | RAW | no |
| `lucuma` | EDIBLE_PORTION | no |
| `machas` | RAW | no |
| `maicena` | AS_PACKAGED | no |
| `maiz chulpe` | AS_PACKAGED | no |
| `maiz morado seco` | AS_PACKAGED | no |
| `malaya de cerdo` | RAW | no |
| `mango` | EDIBLE_PORTION | no |
| `mani tostado` | AS_PACKAGED | no |
| `manjar` | AS_PACKAGED | no |
| `manteca de cerdo` | AS_PACKAGED | no |
| `mantequilla` | AS_PACKAGED | no |
| `manzana` | EDIBLE_PORTION | no |
| `maracuya` | EDIBLE_PORTION | no |
| `masa de hojaldre` | AS_PACKAGED | no |
| `masa de wantan` | AS_PACKAGED | no |
| `masa para arrollado primavera` | AS_PACKAGED | no |
| `mayonesa` | AS_PACKAGED | no |
| `membrillo` | EDIBLE_PORTION | no |
| `menta fresca` | RAW | no |
| `merluza` | RAW | no |
| `mermelada` | AS_PACKAGED | no |
| `merquen` | AS_PACKAGED | no |
| `miel` | AS_PACKAGED | no |
| `mostaza` | AS_PACKAGED | no |
| `mote de maiz` | RAW | no |
| `mote de trigo` | RAW | no |
| `nabo` | RAW | no |
| `naranja` | EDIBLE_PORTION | no |
| `nueces` | AS_PACKAGED | no |
| `nuez moscada molida` | AS_PACKAGED | no |
| `oregano seco` | AS_PACKAGED | no |
| `osobuco de vacuno` | RAW | no |
| `ostiones` | RAW | no |
| `palta` | EDIBLE_PORTION | no |
| `pan de molde` | AS_PACKAGED | no |
| `pan marraqueta` | EDIBLE_PORTION | no |
| `pan rallado` | AS_PACKAGED | no |
| `panko` | AS_PACKAGED | no |
| `papa` | RAW | no |
| `papo choy` | RAW | no |
| `pasas` | AS_PACKAGED | no |
| `pasta de aji amarillo` | AS_PACKAGED | no |
| `pasta de aji panca` | AS_PACKAGED | no |
| `pasta de huacatay` | AS_PACKAGED | no |
| `pasta de rocoto` | AS_PACKAGED | no |
| `pavo entero` | RAW | no |
| `pavo molido` | RAW | no |
| `pechuga de pollo sin piel` | COOKED, RAW | no |
| `pepinillos en conserva` | DRAINED | no |
| `pepino` | RAW | no |
| `pera` | EDIBLE_PORTION | no |
| `perejil fresco` | RAW | no |
| `pernil de cerdo` | RAW | no |
| `pierna de cordero` | RAW | no |
| `pimienta negra` | AS_PACKAGED | no |
| `pimiento rojo` | RAW | no |
| `pina` | EDIBLE_PORTION | no |
| `pina en conserva` | DRAINED | no |
| `pisco` | AS_PACKAGED | no |
| `platano` | EDIBLE_PORTION | no |
| `platano macho` | EDIBLE_PORTION | no |
| `plateada de vacuno` | RAW | no |
| `pollo entero con piel` | RAW | no |
| `pollo trutro entero con piel` | RAW | no |
| `polvos de hornear` | AS_PACKAGED | no |
| `poroto verde` | RAW | no |
| `porotos granados frescos` | RAW | no |
| `porotos secos` | RAW | no |
| `prieta` | RAW | no |
| `pulpa de cerdo` | RAW | no |
| `pulpa de maracuya` | AS_PACKAGED | no |
| `pure de lucuma endulzado` | AS_PACKAGED | no |
| `quesillo` | AS_PACKAGED | no |
| `queso crema` | AS_PACKAGED | no |
| `queso mantecoso` | AS_PACKAGED | no |
| `queso parmesano rallado` | AS_PACKAGED | no |
| `quinoa` | COOKED, RAW | no |
| `ravioles frescos` | AS_PACKAGED | no |
| `reineta` | RAW | no |
| `repollo` | RAW | no |
| `ricotta` | AS_PACKAGED | no |
| `rocoto` | RAW | no |
| `romero seco` | AS_PACKAGED | no |
| `ron` | AS_PACKAGED | no |
| `sal` | AS_PACKAGED | no |
| `salmon` | RAW | no |
| `salsa de soya` | AS_PACKAGED | no |
| `salsa de tomate envasada` | AS_PACKAGED | no |
| `salsa hoisin` | AS_PACKAGED | no |
| `semillas de sesamo` | AS_PACKAGED | no |
| `semola de trigo` | RAW | no |
| `tausi` | AS_PACKAGED | no |
| `te negro` | AS_PACKAGED | no |
| `tocino` | RAW | no |
| `tomate` | RAW | no |
| `tomates secos` | AS_PACKAGED | no |
| `vacuno asado de tira` | RAW | no |
| `vacuno asiento picana` | RAW | no |
| `vacuno filete` | RAW | no |
| `vacuno lomo liso` | RAW | no |
| `vacuno lomo vetado` | RAW | no |
| `vacuno palanca` | RAW | no |
| `vacuno posta magra` | RAW | no |
| `vacuno posta negra` | RAW | no |
| `vacuno tapapecho` | RAW | no |
| `vinagre` | AS_PACKAGED | no |
| `vinagre blanco` | AS_PACKAGED | no |
| `vinagre de arroz` | AS_PACKAGED | no |
| `vinagre tinto` | AS_PACKAGED | no |
| `vino blanco` | AS_PACKAGED | no |
| `vino tinto` | AS_PACKAGED | no |
| `yema de huevo` | EDIBLE_PORTION | no |
| `yogur natural` | AS_PACKAGED | no |
| `yuca` | RAW | no |
| `zanahoria` | RAW | no |
| `zapallo camote` | RAW | no |
| `zapallo italiano` | RAW | no |

**Pendiente declarado:** curar estas fichas contra la tabla del INTA.

---

## 2 · Alimentos que necesitan porción comestible o rendimiento y no lo tienen

La expectativa se declara en
`web/src/domain/recipes/library/expectativas.ts` con su razón culinaria. El
factor **no** se inventa acá.

### 2a · Sin porción comestible

Impacto: la lista de compras pide de menos. Si la papa se pela y no hay factor,
el sistema compra el peso que se come en vez del que se compra.

| alimento | por qué la necesita | estado |
|---|---|---|
| `papa` | se pela | sin factor |


### 2b · Sin rendimiento crudo→cocido

Impacto: si una receta expresa cantidades en cocido, el ShoppingEngine no puede
llegar al crudo a comprar y lo declara sin resolver (ver registro 8).

| alimento | por qué lo necesita | estado |
|---|---|---|
| `avena tradicional` | absorbe líquido al cocerse | sin rendimiento en ninguna receta ni en `ingredient_yields` |
| `vacuno posta negra` | mismo caso: las recetas que parten de carne ya cocida no se pueden convertir a cantidad de compra | sin rendimiento en ninguna receta ni en `ingredient_yields` |


---

## 3 · Micronutrientes `PARTIAL` o `UNKNOWN` por receta

`PARTIAL` significa que algunos componentes aportaron el nutriente y otros no:
el número que sale **no es el total**, y el sistema lo dice en vez de fingir que
lo es. `UNKNOWN` significa que nadie lo sabía.

Frecuencia por nutriente sobre 458 recetas:

| nutriente | recetas afectadas |
|---|---|
| `saturated_fat_g` | 458 |
| `phosphorus_mg` | 458 |
| `sugars_g` | 454 |
| `potassium_mg` | 453 |
| `fiber_g` | 451 |
| `sodium_mg` | 389 |
| `energy_kcal` | 5 |
| `protein_g` | 5 |
| `carbohydrates_g` | 5 |
| `fat_g` | 5 |

Detalle:

| receta | nutrientes incompletos |
|---|---|
| Ajiaco | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ají chino casero | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ají de gallina | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Albóndigas en salsa de mostaza | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Albóndigas en salsa de tomate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Alfajores de chocolate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Alfajores de hojarasca | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Alfajores de maicena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Alitas de pollo al horno con papas | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Almendras caramelizadas al merquén | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Anticuchos de posta con cebolla y pimiento | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Anticuchos de verduras a la parrilla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Anticuchos peruanos al ají panca | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Apanado chifa en batido de maicena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arrollado de huaso | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arrollado de jamón y queso frito | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arrollado de marisco al vapor | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arrollado primavera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arroz a la chilena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Arroz al cilantro | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Arroz blanco graneado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Arroz chaufán de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arroz chaufán especial | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arroz con choclo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Arroz con choritos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arroz con crema de choclo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arroz con huevo frito | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arroz con leche | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Arroz con pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Arroz de sushi | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:UNKNOWN, phosphorus_mg:UNKNOWN |
| Arroz primavera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Arvejas frescas guisadas con huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Asado a la olla al vino tinto | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Asado de tira a la cerveza | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Asado de tira a la parrilla con ensalada chilena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Asado de tira al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Asado de vacuno al horno con papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Atún sellado con miel de ajonjolí | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Avena con leche y plátano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Banana split | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Banoffee de plátano | sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Barras de avena, frutos secos y chocolate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Batido de chirimoya, arándanos y avena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Batido tropical de mango y piña | saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Berlines con crema pastelera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Bistec a la sartén peruano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Bistec a lo pobre | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Bistec con puré | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Bizcocho de chocolate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Brazo de reina | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Brochetas de cerdo adobadas a la parrilla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Brownie con mousse de chocolate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Budín de atún | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Budín de pan | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Budín de zapallo italiano al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Calamar Casa China | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Calapurca | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Caldillo de congrio | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Caldillo de huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Caldillo de merluza | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Caldo de pollo casero | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| California roll casero | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Calugas caseras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Calzones rotos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Camarones al pil pil | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Camarón fuyón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Canapés de charqui | sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cancha serrana | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Carbonada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne a la cerveza | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne a la mostaza con champiñones | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne al jugo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Carne desmechada en olla a presión | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne especial china | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne magra con papas y ensalada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne mechada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne rellena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Carne salteada a la soya | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Causa limeña | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cazuela de albóndigas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cazuela de ave nogada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cazuela de cerdo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cazuela de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cazuela de vacuno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cebiche carretillero | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cebiche mixto | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cerdo asado con pimentón y cebolla morada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cerdo crocante a la miel picante | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ceviche de cochayuyo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ceviche de reineta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chacarero | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chairo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chalaquita | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chancho en piedra | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chapaleles | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chapsui | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chapsui de verduras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chapsui especial | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Charquicán | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Charquicán de cochayuyo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chaufa blanco | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chaufansí de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chaumín de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chaumín de verduras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chaumín especial | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chicha morada | energy_kcal:PARTIAL, protein_g:PARTIAL, carbohydrates_g:PARTIAL, fat_g:PARTIAL, fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Chicharrón chifa | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chicharrón mixto de mar | energy_kcal:PARTIAL, protein_g:PARTIAL, carbohydrates_g:PARTIAL, fat_g:PARTIAL, fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chilenitos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chimichurri chileno de cebollín y cilantro | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chips de vegetales al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Choclo a la mantequilla | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Choritos al vapor con limón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chorrillana | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chow fun de verduras con huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chuletas de cerdo a la plancha con pure | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chumbeque | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chupe de atún | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chupe de camarones | energy_kcal:PARTIAL, protein_g:PARTIAL, carbohydrates_g:PARTIAL, fat_g:PARTIAL, fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chupe de jaiba | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chupe de jibia | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chupe de locos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chupe de mariscos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Chupe de pescado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Churrascas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Churrasco con tomate y palta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Churros | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cocadas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Cochayuyo guisado con papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Congrio al horno en papillote | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Copa de merengue con crema y duraznos | fiber_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Copa de oro | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Costillar cantonés | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Costillar de cerdo al horno con papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Costillitas de choclo a la barbacoa | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Crema de arvejas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Crema de choritos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Crema de rocoto | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Crema de verduras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Crema de zapallo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Crema de zapallo italiano y albahaca | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Crema volteada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Croquetas de atún y arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Diente de dragón con proteína | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Diente de dragón salteado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Dip de pastelera de choclo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Dulce de alcayota | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Dulce de membrillo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de jamón, queso y cebolla caramelizada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de lomo saltado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de machas a la parmesana | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de mariscos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de pastelera de choclo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de pino al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de pino de berenjena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de pino de champiñón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de queso fritas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas de verduras al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas fritas de ají de gallina | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas fritas de manzana | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanadas fritas de pino | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empanaditas fritas de camarón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Empolvados | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Encurtido rápido de nabo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada chilena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Ensalada cobb casera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de atún con papas y huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de betarraga con cebolla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de choclo con tomate y albahaca | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Ensalada de digüeñes | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de garbanzos con huevo y tomate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de mote | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de pepino con tomate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de pollo con papas y arvejas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de porotos con cebolla y huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de porotos granados | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada de repollo con zanahoria | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada nikkei con pollo crocante | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada rusa | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada surtida de papa, betarraga y huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ensalada verde | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Ensalada verde con frutillas y queso | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Escalopas de pollo apanadas con puré | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Escalopas de vacuno rellenas con tocino y queso | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Estofado de carne | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Estofado de osobuco | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Fetuccinis a la crema con pollo y champiñones | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Fetuccinis a la huancaína con saltado de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Fideos con atún | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Filete a la parrilla con papas asadas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Filete a la pimienta con gratín de papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Filete de cerdo al merquén | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Flan de anís | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Flan de manjar | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Fritos de pollo al sésamo y almendras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Galletas de Navidad con especias | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Galletas de anís | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Galletas de canela y chocolate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Garbanzos con arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Garbanzos con longaniza | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Garbanzos guisados | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Gohan mixto | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Gratín de jaiba | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Guacamole | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Guatitas a la jardinera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Guiso de alcachofas y pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Guiso de porotos verdes con papas y huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Guiso de verduras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Gyozas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Hamburguesas caseras en marraqueta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Hamburguesas de carne de soya | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Hamburguesas de lentejas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Hamburguesas de pavo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Handroll de sushi | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Hot roll frito en panko | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Huevo a la copa con marraqueta | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Huevos revueltos con pan | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Humitas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Hunán de pescado con ají | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Jugo de betarraga, zanahoria y limón | sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, phosphorus_mg:PARTIAL |
| Jugo verde de pepino, manzana y apio | sugars_g:PARTIAL, saturated_fat_g:PARTIAL, phosphorus_mg:PARTIAL |
| Kuchen de frambuesa | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Leche asada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Leche de tigre | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Leche nevada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Lengua de vaca con puré de palta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Lentejas guisadas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Limonada de hierba luisa | energy_kcal:PARTIAL, protein_g:PARTIAL, carbohydrates_g:PARTIAL, fat_g:PARTIAL, fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Lisa al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Locos mayo | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Lomo con salsa al vino | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Lomo saltado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Lomo vetado a la parrilla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Macarrones franceses | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Machas a la parmesana | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Machas en salsa verde | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Macho ruso | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Malaya rellena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Manzanas acarameladas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Manzanas asadas rellenas con nueces | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Mariscal caliente | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Marraqueta casera | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:UNKNOWN, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Masa de empanadas al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Masa de empanadas fritas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Masa de pizza a la piedra | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Masa de wantán casera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Menestrón peruano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Merengón con berries | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Merluza con arroz y ensalada verde | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Merluza frita con arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Milanesa a la napolitana | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Milanesa con tallarines al pesto peruano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Milcao | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Mote con huesillo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Mote con machas y salsa verde | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Mousse de atún | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Mousse de lúcuma | saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Nigiri de salmón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Niños envueltos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Once con quesillo y palta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Paila marina | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pajaritos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Palanca a la parrilla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Palmeritas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Palta reina | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pan amasado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Pan con huevo y tomate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pan de Pascua | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pan de ajo al horno | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pan de hamburguesa semi integral | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pan de huevo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pan de molde integral | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Panqueques con manjar | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Panqueques con salsa de naranja | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pantrucas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papas asadas a las finas hierbas | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papas con chuchoca | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papas fritas caseras | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papas gringas rellenas con choclo y queso | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papas mayo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papas rellenas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papas salteadas con ajo y romero | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Papo choy salteado con ajo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Parrilla china de carnes | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Parrilla china de mariscos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pasta Lima thai de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pasta con mariscos a la criolla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pasta con pollo | sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastel de choclo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastel de choclo vegetariano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastel de jaiba | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastel de papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastel de papas con pino de champiñones | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastel de pescado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastel de salmón, camarones y papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastelera de choclo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pastelera de choclo con verduras asadas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pataska | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pavo al horno marinado con hierbas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pebre | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pebre de coliflor | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pebre de mote | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pechuga a la plancha con dos ensaladas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Peras al vino tinto | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pernil de cerdo con papas doradas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pescado a lo macho | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pescado al horno con verduras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pescado con costra de quínoa | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pescado con salsa de mariscos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pescado frito | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pescado gratinado con costra de pan rallado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pesto peruano de albahaca y espinaca | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Picante de guatitas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Picarones | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pichanga | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pie de carne y papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pie de limón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pie de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pierna de cordero al horno con papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pimientos rellenos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pino de carne para congelar | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Pizza casera de queso y tomate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Plateada al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Plateada al jugo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Plátano maduro frito | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Pollo a la mostaza | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo a la parrilla con verduras asadas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo adobado al horno con ensalada chilena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Pollo al champiñón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo al cognac con champiñones | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo al horno con papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo al horno con tomate y cebolla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Pollo al jugo con arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo al vino blanco | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo arvejado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Pollo asado al limón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo cocido desmenuzado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo con arroz y ensalada chilena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo con piña agridulce | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo crocante en salsa chijaukay | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo entero asado al jugo de naranja | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo escabechado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo frito con papas fritas | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo guisado con choclo y zapallo italiano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Pollo pekín | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo salteado a la piña con sésamo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pollo salteado con verduras y arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Porotos con longaniza | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Porotos con mazamorra | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Porotos con mote | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Porotos con riendas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Porotos granados | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Postre de lúcuma con galletas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Prietas con papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pulmay (curanto en olla) | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Pulpa de cerdo con ciruelas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Puré de zapallo camote | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Queque casero de naranja | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Queque de especias | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Queque de manzanas y nueces | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Queque de miel | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Queque de yogur | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Queque marmoleado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ravioles de asado al vino tinto | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Ravioles de ricotta en salsa de tomate fresco | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Reineta a la plancha con ensalada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Reineta apanada con puré | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Reineta en salsa atomatada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Risotto acevichado con mariscos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Risotto criollo de zapallo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Roll envuelto en palta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Roll envuelto en salmón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Roll sin arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, phosphorus_mg:PARTIAL |
| Roll tempura | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Rollitos de pan de molde con huevo y jamón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Rollos de canela | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salmón a la chorrillana | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Salmón a la florentina | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salmón a la plancha con arroz | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Salmón al horno con papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salmón pochado con reducción cítrica | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salpicón de verduras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salsa acevichada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salsa agridulce casera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salsa de tomate casera en tanda | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Salsa huancaína | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salsa teriyaki casera | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salsa verde chilena | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Saltado criollo de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salteado a la china con alga y champiñón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salteado al ajo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salteado chitén con maní | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salteado con champiñones | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salteado mongoliano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salteado sichiu | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Salteado tausi | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sandwich de ave palta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sarza criolla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Selva negra | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Solomillo de cerdo a la pimienta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa capón con gyozas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa criolla de cabello de ángel | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa de arvejas partidas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa de mariscos chifa | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa de mariscos con pan y leche | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa de pollo con fideos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa de verduras con fideos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopa wantán | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopaipillas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Sopaipillas al horno de zapallo y betarraga | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sopaipillas pasadas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Spaghetti al ajillo | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Spaghetti mediterráneo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Spring rolls de lomo saltado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sudado de pescado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Suimay al vapor | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Suprema de pollo Maryland | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Suspiro limeño | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sándwich Barros Luco | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sándwich de atún con cebolla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Sándwich de carne mechada | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Sándwich de lengua con palta | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sándwich de pescado frito | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Sémola con leche | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tacu tacu a lo pobre | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tacu tacu de porotos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tallarines con salsa de carne molida | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tallarines con salsa de tomate | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Tallarín saltado | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tarta de duraznos y limón | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tarta de manzana | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tartaleta de maracuyá | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tequeños de ají de gallina | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tiradito de reineta en crema de ají amarillo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tomatican | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Torta de merengue con lúcuma | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Torta de mil hojas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Torta de panqueques con manjar | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Torta de panqueques salada de pollo | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Torta de yogur con base de galletas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Torta tres leches | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tortilla de acelga | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tortilla de cebolla | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tortilla de papas | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tortilla de porotos verdes | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Tortilla de verduras | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Trutros al horno con arroz integral y champiñones | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Turron de vino | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Té helado de maracuyá y naranja | energy_kcal:PARTIAL, protein_g:PARTIAL, carbohydrates_g:PARTIAL, fat_g:PARTIAL, fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:UNKNOWN, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Valdiviano | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Wantán frito | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Yogur con arándanos y plátano | fiber_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Yuca cocida al ajo | fiber_g:PARTIAL, sugars_g:UNKNOWN, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |
| Zapallitos italianos rellenos con carne | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Zapallitos italianos rellenos con pesto de tomates secos | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Zapallo italiano apanado al horno | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:PARTIAL |
| Zapallo italiano guisado con carne molida | fiber_g:PARTIAL, sugars_g:PARTIAL, saturated_fat_g:PARTIAL, sodium_mg:PARTIAL, potassium_mg:PARTIAL, phosphorus_mg:UNKNOWN |


---

## 4 · Alias e identidades potencialmente duplicadas

Similitud `pg_trgm` sobre los nombres canónicos, más los alias declarados que
chocan con un nombre canónico. **Es una sospecha, no una sentencia**: hay pares
legítimamente parecidos (`porotos secos` / `porotos granados frescos` son
alimentos distintos). Lo que este registro impide es que una identidad duplicada
entre sin que nadie la mire.

| a | b | similitud |
|---|---|---|
| `pollo entero con piel` | `pollo trutro entero con piel` | 0.778 |
| `vacuno posta magra` | `vacuno posta negra` | 0.652 |
| `harina de trigo` | `harina de trigo integral` | 0.640 |
| `vinagre blanco` | `vino blanco` | 0.588 |
| `platano` | `platano macho` | 0.571 |
| `vinagre` | `vinagre tinto` | 0.571 |
| `vinagre tinto` | `vino tinto` | 0.563 |
| `camarones` | `camarones pelados` | 0.556 |
| `cebolla` | `cebollin` | 0.545 |
| `galletas de soda` | `galletas de vino` | 0.545 |
| `vacuno lomo liso` | `vacuno lomo vetado` | 0.545 |
| `pepinillos en conserva` | `pina en conserva` | 0.538 |
| `cebolla` | `cebolla morada` | 0.533 |
| `vinagre` | `vinagre blanco` | 0.533 |
| `galletas de vainilla` | `galletas de vino` | 0.520 |
| `pasta de aji amarillo` | `pasta de aji panca` | 0.520 |
| `almendras` | `harina de almendras` | 0.500 |
| `malaya de cerdo` | `manteca de cerdo` | 0.500 |
| `maracuya` | `pulpa de maracuya` | 0.500 |
| `guindas en conserva` | `pina en conserva` | 0.480 |
| `pernil de cerdo` | `pulpa de cerdo` | 0.476 |
| `coco rallado` | `pan rallado` | 0.471 |
| `vinagre` | `vinagre de arroz` | 0.471 |
| `duraznos en conserva` | `pina en conserva` | 0.462 |
| `galletas de soda` | `galletas de vainilla` | 0.462 |
| `chuleta de cerdo` | `filete de cerdo` | 0.455 |


---

## 5 · Ingredientes presentes en 20 o más recetas

Un ingrediente muy transversal concentra riesgo: si su ficha nutricional está
mal, el error se propaga a todas esas recetas a la vez. Son los primeros
candidatos a curar contra la tabla del INTA.

| ingrediente | recetas | % de la biblioteca |
|---|---|---|
| Sal | 386 | 84 % |
| Cebolla | 255 | 56 % |
| Aceite vegetal | 249 | 54 % |
| Ajo | 232 | 51 % |
| Huevo | 137 | 30 % |
| Limón | 135 | 29 % |
| Orégano | 117 | 26 % |
| Papa | 111 | 24 % |
| Azúcar | 107 | 23 % |
| Harina de trigo | 103 | 22 % |
| Perejil | 98 | 21 % |
| Zanahoria | 95 | 21 % |
| Ají de color | 91 | 20 % |
| Aceite de oliva | 90 | 20 % |
| Leche entera | 89 | 19 % |
| Arroz blanco | 89 | 19 % |
| Tomate | 81 | 18 % |
| Mantequilla | 79 | 17 % |
| Comino | 70 | 15 % |
| Cilantro | 70 | 15 % |
| Salsa de soya | 67 | 15 % |
| Pimiento rojo | 54 | 12 % |
| Pechuga de pollo (sin piel) | 45 | 10 % |
| Maicena (almidón de maíz) | 42 | 9 % |
| Queso mantecoso | 42 | 9 % |
| Cebollín | 40 | 9 % |
| Ají verde fresco | 38 | 8 % |
| Choclo (grano) | 35 | 8 % |
| Pan marraqueta (genérico) | 34 | 7 % |
| Pimienta negra | 31 | 7 % |
| Aceite de sésamo | 30 | 7 % |
| Polvos de hornear | 30 | 7 % |
| Vino blanco | 28 | 6 % |
| Canela | 27 | 6 % |
| Jengibre fresco | 26 | 6 % |
| Manteca de cerdo | 25 | 5 % |
| Apio | 25 | 5 % |
| Albahaca | 25 | 5 % |
| Crema de leche | 23 | 5 % |
| Camarones pelados | 23 | 5 % |
| Jengibre molido | 23 | 5 % |
| Palta | 23 | 5 % |
| Zapallo camote | 23 | 5 % |
| Pan rallado | 21 | 5 % |
| Pollo, trutro entero (con piel) | 21 | 5 % |
| Zapallo italiano | 20 | 4 % |
| Lechuga | 20 | 4 % |


---

## 6 · Recetas que comparten más del 80 % de sus componentes principales

Se comparan solo los componentes con `role: MAIN` (condimentos y aceite
aparecen en todo y ensuciarían la señal). Se muestran DOS medidas porque una
sola miente:

- **solape sobre la más chica** — detecta "B es casi un subconjunto de A".
- **Jaccard** — dice si las dos recetas son de verdad la misma cosa.

Un 100 % de solape con Jaccard bajo es una receta chica contenida en una grande
(pollo + papa + cebolla cabe dentro de una cazuela), no un duplicado. Un par con
las dos altas sí hay que justificarlo.

Solo entran los pares con Jaccard de 65 % o más, que son los candidatos de
verdad. Otros **1342** pares pasan el 80 % de solape pero quedan bajo ese
Jaccard: son recetas chicas contenidas en grandes, y listarlas acá enterraría a
las que sí hay que mirar. El número está a la vista justamente para que acotar
no se lea como "no había nada más".

| receta A | receta B | solape | Jaccard | componentes comunes |
|---|---|---|---|---|
| Ajiaco | Tortilla de papas | 100 % | 75 % | 3 de 3 |
| Arroz a la chilena | Arroz con pollo | 100 % | 83 % | 5 de 5 |
| Arroz al cilantro | Arroz blanco graneado | 100 % | 100 % | 2 de 2 |
| Arroz al cilantro | Arroz con huevo frito | 100 % | 67 % | 2 de 2 |
| Arroz blanco graneado | Arroz con huevo frito | 100 % | 67 % | 2 de 2 |
| Arroz con huevo frito | Tacu tacu de porotos | 100 % | 75 % | 3 de 3 |
| Arroz con huevo frito | Tortilla de cebolla | 100 % | 67 % | 2 de 2 |
| Arroz con pollo | Pollo arvejado | 100 % | 83 % | 5 de 5 |
| Asado a la olla al vino tinto | Asado de vacuno al horno con papas | 100 % | 80 % | 4 de 4 |
| Asado de tira a la cerveza | Asado de tira al horno | 100 % | 67 % | 4 de 4 |
| Berlines con crema pastelera | Kuchen de frambuesa | 86 % | 75 % | 6 de 7 |
| Berlines con crema pastelera | Pan de hamburguesa semi integral | 86 % | 67 % | 6 de 7 |
| Berlines con crema pastelera | Rollos de canela | 86 % | 75 % | 6 de 7 |
| Berlines con crema pastelera | Tarta de duraznos y limón | 86 % | 75 % | 6 de 7 |
| Bistec a lo pobre | Tortilla de papas | 100 % | 75 % | 3 de 3 |
| Bizcocho de chocolate | Galletas de anís | 100 % | 86 % | 6 de 6 |
| Bizcocho de chocolate | Galletas de canela y chocolate | 86 % | 75 % | 6 de 7 |
| Bizcocho de chocolate | Pan de huevo | 100 % | 86 % | 6 de 6 |
| Bizcocho de chocolate | Queque de especias | 86 % | 75 % | 6 de 7 |
| Bizcocho de chocolate | Queque marmoleado | 100 % | 100 % | 7 de 7 |
| Brazo de reina | Empolvados | 100 % | 80 % | 4 de 4 |
| Brazo de reina | Panqueques con manjar | 100 % | 80 % | 4 de 4 |
| Brownie con mousse de chocolate | Selva negra | 100 % | 78 % | 7 de 7 |
| Calamar Casa China | Salteado tausi | 83 % | 71 % | 5 de 6 |
| Caldillo de huevo | Tortilla de papas | 100 % | 75 % | 3 de 3 |
| Caldo de pollo casero | Sopa de pollo con fideos | 100 % | 80 % | 4 de 4 |
| California roll casero | Handroll de sushi | 100 % | 86 % | 6 de 6 |
| Calugas caseras | Macho ruso | 100 % | 75 % | 3 de 3 |
| Calzones rotos | Galletas de Navidad con especias | 83 % | 71 % | 5 de 6 |
| Calzones rotos | Galletas de anís | 83 % | 71 % | 5 de 6 |
| Calzones rotos | Pan de huevo | 83 % | 71 % | 5 de 6 |
| Calzones rotos | Queque casero de naranja | 83 % | 71 % | 5 de 6 |
| Carbonada | Cazuela de cerdo | 88 % | 70 % | 7 de 8 |
| Carbonada | Cazuela de pollo | 88 % | 70 % | 7 de 8 |
| Carbonada | Cazuela de vacuno | 100 % | 89 % | 8 de 8 |
| Carne especial china | Chapsui especial | 100 % | 75 % | 9 de 9 |
| Carne especial china | Parrilla china de carnes | 88 % | 70 % | 7 de 8 |
| Carne especial china | Salteado tausi | 100 % | 67 % | 6 de 6 |
| Carne salteada a la soya | Salteado mongoliano | 100 % | 80 % | 4 de 4 |
| Cazuela de ave nogada | Cazuela de pollo | 88 % | 78 % | 7 de 8 |
| Cazuela de cerdo | Cazuela de pollo | 88 % | 78 % | 7 de 8 |
| Cazuela de cerdo | Cazuela de vacuno | 88 % | 78 % | 7 de 8 |
| Cazuela de pollo | Cazuela de vacuno | 88 % | 78 % | 7 de 8 |
| Ceviche de reineta | Leche de tigre | 100 % | 75 % | 3 de 3 |
| Chalaquita | Ensalada de choclo con tomate y albahaca | 100 % | 100 % | 3 de 3 |
| Chalaquita | Pebre | 100 % | 67 % | 2 de 2 |
| Chalaquita | Salsa de tomate casera en tanda | 100 % | 67 % | 2 de 2 |
| Chapaleles | Milcao | 100 % | 67 % | 2 de 2 |
| Chapsui | Chapsui de verduras | 90 % | 69 % | 9 de 10 |
| Chapsui | Chapsui especial | 90 % | 69 % | 9 de 10 |
| Chapsui especial | Parrilla china de carnes | 100 % | 67 % | 8 de 8 |
| Chaufansí de pollo | Pasta Lima thai de pollo | 83 % | 71 % | 5 de 6 |
| Chicharrón chifa | Diente de dragón con proteína | 100 % | 67 % | 4 de 4 |
| Chicharrón chifa | Salteado tausi | 100 % | 67 % | 4 de 4 |
| Chilenitos | Torta de mil hojas | 86 % | 75 % | 6 de 7 |
| Chupe de atún | Chupe de jaiba | 83 % | 71 % | 5 de 6 |
| Chupe de atún | Chupe de jibia | 83 % | 71 % | 5 de 6 |
| Chupe de atún | Chupe de locos | 83 % | 71 % | 5 de 6 |
| Chupe de atún | Chupe de pescado | 83 % | 71 % | 5 de 6 |
| Chupe de jaiba | Chupe de jibia | 83 % | 71 % | 5 de 6 |
| Chupe de jaiba | Chupe de locos | 83 % | 71 % | 5 de 6 |
| Chupe de jaiba | Chupe de pescado | 83 % | 71 % | 5 de 6 |
| Chupe de jibia | Chupe de locos | 83 % | 71 % | 5 de 6 |
| Chupe de jibia | Chupe de pescado | 83 % | 71 % | 5 de 6 |
| Chupe de locos | Chupe de pescado | 83 % | 71 % | 5 de 6 |
| Churrascas | Pan amasado | 100 % | 100 % | 3 de 3 |
| Churrascas | Sopaipillas | 100 % | 75 % | 3 de 3 |
| Diente de dragón con proteína | Salteado tausi | 83 % | 71 % | 5 de 6 |
| Dip de pastelera de choclo | Papas gringas rellenas con choclo y queso | 100 % | 83 % | 5 de 5 |
| Empanadas de lomo saltado | Empanadas fritas de ají de gallina | 100 % | 67 % | 2 de 2 |
| Empanadas fritas de ají de gallina | Sopaipillas pasadas | 100 % | 67 % | 2 de 2 |
| Empanaditas fritas de camarón | Suimay al vapor | 100 % | 80 % | 4 de 4 |
| Ensalada chilena | Pebre | 100 % | 67 % | 2 de 2 |
| Ensalada chilena | Salsa de tomate casera en tanda | 100 % | 67 % | 2 de 2 |
| Ensalada de choclo con tomate y albahaca | Pebre | 100 % | 67 % | 2 de 2 |
| Ensalada de choclo con tomate y albahaca | Salsa de tomate casera en tanda | 100 % | 67 % | 2 de 2 |
| Ensalada de pepino con tomate | Pebre | 100 % | 67 % | 2 de 2 |
| Ensalada de pepino con tomate | Salsa de tomate casera en tanda | 100 % | 67 % | 2 de 2 |
| Ensalada de pollo con papas y arvejas | Ensalada rusa | 100 % | 80 % | 4 de 4 |
| Ensalada de porotos con cebolla y huevo | Tacu tacu de porotos | 100 % | 75 % | 3 de 3 |
| Ensalada de porotos con cebolla y huevo | Tortilla de cebolla | 100 % | 67 % | 2 de 2 |
| Ensalada surtida de papa, betarraga y huevo | Tortilla de papas | 100 % | 75 % | 3 de 3 |
| Escalopas de pollo apanadas con puré | Reineta apanada con puré | 86 % | 75 % | 6 de 7 |
| Fetuccinis a la huancaína con saltado de pollo | Pasta con pollo | 100 % | 80 % | 4 de 4 |
| Flan de anís | Flan de manjar | 100 % | 75 % | 3 de 3 |
| Flan de anís | Leche asada | 100 % | 100 % | 3 de 3 |
| Flan de anís | Leche nevada | 100 % | 75 % | 3 de 3 |
| Flan de manjar | Leche asada | 100 % | 75 % | 3 de 3 |
| Flan de manjar | Panqueques con manjar | 100 % | 80 % | 4 de 4 |
| Galletas de Navidad con especias | Galletas de anís | 83 % | 71 % | 5 de 6 |
| Galletas de Navidad con especias | Pan de huevo | 83 % | 71 % | 5 de 6 |
| Galletas de Navidad con especias | Queque casero de naranja | 83 % | 71 % | 5 de 6 |
| Galletas de anís | Galletas de canela y chocolate | 100 % | 86 % | 6 de 6 |
| Galletas de anís | Pan de huevo | 100 % | 100 % | 6 de 6 |
| Galletas de anís | Panqueques con salsa de naranja | 83 % | 71 % | 5 de 6 |
| Galletas de anís | Queque casero de naranja | 83 % | 71 % | 5 de 6 |
| Galletas de anís | Queque de especias | 100 % | 86 % | 6 de 6 |
| Galletas de anís | Queque marmoleado | 100 % | 86 % | 6 de 6 |
| Galletas de canela y chocolate | Pan de huevo | 100 % | 86 % | 6 de 6 |
| Galletas de canela y chocolate | Queque de especias | 86 % | 75 % | 6 de 7 |
| Galletas de canela y chocolate | Queque marmoleado | 86 % | 75 % | 6 de 7 |
| Guacamole | Pebre | 100 % | 67 % | 2 de 2 |
| Guacamole | Salsa de tomate casera en tanda | 100 % | 67 % | 2 de 2 |
| Handroll de sushi | Roll envuelto en palta | 83 % | 71 % | 5 de 6 |
| Handroll de sushi | Roll envuelto en salmón | 83 % | 71 % | 5 de 6 |
| Huevo a la copa con marraqueta | Huevos revueltos con pan | 100 % | 75 % | 3 de 3 |
| Huevo a la copa con marraqueta | Pan de ajo al horno | 100 % | 67 % | 2 de 2 |
| Kuchen de frambuesa | Tarta de duraznos y limón | 86 % | 75 % | 6 de 7 |
| Leche asada | Leche nevada | 100 % | 75 % | 3 de 3 |
| Marraqueta casera | Masa de pizza a la piedra | 100 % | 100 % | 2 de 2 |
| Merluza con arroz y ensalada verde | Merluza frita con arroz | 100 % | 75 % | 3 de 3 |
| Mote con machas y salsa verde | Pebre de mote | 100 % | 75 % | 3 de 3 |
| Pan amasado | Sopaipillas | 100 % | 75 % | 3 de 3 |
| Pan de Pascua | Queque de especias | 100 % | 70 % | 7 de 7 |
| Pan de hamburguesa semi integral | Rollos de canela | 86 % | 67 % | 6 de 7 |
| Pan de huevo | Panqueques con salsa de naranja | 83 % | 71 % | 5 de 6 |
| Pan de huevo | Queque casero de naranja | 83 % | 71 % | 5 de 6 |
| Pan de huevo | Queque de especias | 100 % | 86 % | 6 de 6 |
| Pan de huevo | Queque marmoleado | 100 % | 86 % | 6 de 6 |
| Panqueques con manjar | Torta de panqueques con manjar | 100 % | 71 % | 5 de 5 |
| Panqueques con salsa de naranja | Queque casero de naranja | 83 % | 71 % | 5 de 6 |
| Papas asadas a las finas hierbas | Papas fritas caseras | 100 % | 100 % | 1 de 1 |
| Papas asadas a las finas hierbas | Papas salteadas con ajo y romero | 100 % | 100 % | 1 de 1 |
| Papas fritas caseras | Papas salteadas con ajo y romero | 100 % | 100 % | 1 de 1 |
| Papas mayo | Tortilla de papas | 100 % | 75 % | 3 de 3 |
| Pebre | Pebre de mote | 100 % | 67 % | 2 de 2 |
| Pebre | Salsa de tomate casera en tanda | 100 % | 100 % | 2 de 2 |
| Pebre de mote | Salsa de tomate casera en tanda | 100 % | 67 % | 2 de 2 |
| Pechuga a la plancha con dos ensaladas | Pollo con arroz y ensalada chilena | 100 % | 67 % | 2 de 2 |
| Pollo a la mostaza | Pollo al champiñón | 83 % | 71 % | 5 de 6 |
| Pollo al horno con papas | Pollo asado al limón | 100 % | 100 % | 3 de 3 |
| Pollo al jugo con arroz | Pollo salteado con verduras y arroz | 100 % | 67 % | 4 de 4 |
| Queque de especias | Queque marmoleado | 86 % | 75 % | 6 de 7 |
| Roll envuelto en palta | Roll envuelto en salmón | 83 % | 71 % | 5 de 6 |
| Roll envuelto en palta | Roll tempura | 83 % | 71 % | 5 de 6 |
| Roll envuelto en salmón | Roll sin arroz | 83 % | 71 % | 5 de 6 |
| Salteado a la china con alga y champiñón | Salteado con champiñones | 100 % | 71 % | 5 de 5 |
| Salteado al ajo | Salteado chitén con maní | 100 % | 71 % | 5 de 5 |
| Salteado chitén con maní | Salteado mongoliano | 100 % | 71 % | 5 de 5 |
| Tallarines con salsa de carne molida | Tallarines con salsa de tomate | 100 % | 67 % | 4 de 4 |
| Tortilla de cebolla | Tortilla de papas | 100 % | 67 % | 2 de 2 |
| Tortilla de papas | Valdiviano | 100 % | 75 % | 3 de 3 |


---

## 7 · Capacidades de equipo que el schema no representaba

| código | nombre | por qué hace falta | recetas | resuelta en |
|---|---|---|---|---|
| `PRESSURE_COOKER` | Olla a presión | Diferencia entre 60 y 25 minutos en cualquier legumbre seca. Sin el código había que mentir (mapearla a POT) o esconder el paso. | Porotos con riendas, Garbanzos guisados, Carne mechada | 0032_pressure_cooker_capability.sql |


### Capacidades usadas por una receta y ausentes del catálogo

Esto sería un error duro: una receta apuntando a un equipo que no existe.

_ninguna — toda capacidad usada existe en `equipment_capabilities`_


---

## 8 · Recetas que el ShoppingEngine no puede convertir a cantidad de compra

Cada receta se pasa por el motor real (`aggregateDemand`) como si fuera una
comida confirmada. Una línea "sin resolver" es el motor diciendo *no sé cuánto
comprar* — que es lo correcto — pero también un hueco de datos que alguien tiene
que llenar con un dato real.

| receta | alimento | base de compra | razón |
|---|---|---|---|
| Arroz chaufán de pollo | Arroz blanco | RAW | No hay rendimiento crudo→cocido para Arroz blanco: no se puede calcular cuánto comprar sin inventar un factor. |
| Chaufa blanco | Arroz blanco | RAW | No hay rendimiento crudo→cocido para Arroz blanco: no se puede calcular cuánto comprar sin inventar un factor. |
| Ensalada de pollo con papas y arvejas | Pechuga de pollo (sin piel) | RAW | No hay rendimiento crudo→cocido para Pechuga de pollo (sin piel) (poached): no se puede calcular cuánto comprar sin inventar un factor. |
| Hamburguesas de lentejas | Lentejas | RAW | No hay rendimiento crudo→cocido para Lentejas: no se puede calcular cuánto comprar sin inventar un factor. |
| Sandwich de ave palta | Pechuga de pollo (sin piel) | RAW | No hay rendimiento crudo→cocido para Pechuga de pollo (sin piel) (boiled): no se puede calcular cuánto comprar sin inventar un factor. |
| Tacu tacu a lo pobre | Arroz blanco | RAW | No hay rendimiento crudo→cocido para Arroz blanco: no se puede calcular cuánto comprar sin inventar un factor. |
| Tacu tacu de porotos | Arroz blanco | RAW | No hay rendimiento crudo→cocido para Arroz blanco: no se puede calcular cuánto comprar sin inventar un factor. |

