# NutriFamilia — aplicación web

[Plataforma Familiar Inteligente de Alimentación](../docs/sprint-0/README.md). Arquitectura: [BASELINE 1.0](../docs/architecture/BASELINE.md).

Puesta en marcha desde cero: [Activar Supabase paso a paso](../docs/setup-supabase.md).

## Desarrollo

```bash
cd web
cp .env.example .env.local   # completar con URL y anon key del proyecto Supabase
npm install
npm run dev
```

Migraciones: **no se aplican por nombre de archivo**. El orden real vive en la lista `MIGRACIONES` de `src/integration/harness.ts` —la misma secuencia que ejercitan las pruebas— y quien la lee y la aplica es `scripts/poner-al-dia.mjs`; el paso a paso está en [Activar Supabase](../docs/setup-supabase.md). Este repo **no usa la CLI de Supabase** (no hay `supabase/config.toml`, y `supabase db push` nunca corrió acá): todo va por la Management API, con `scripts/aplicar-migracion.mjs` de brazo. RLS queda activa en todas las tablas; la creación de hogar y la aceptación de invitaciones van por funciones `security definer` (`create_household`, `accept_invitation`).

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Tests de base de datos

`scripts/db-test.sh` levanta un PostgreSQL local efímero, aplica la cadena **en el orden que declara `MIGRACIONES` en `src/integration/harness.ts`** más los seeds en el orden de `SEEDS`, y ejecuta todos los `supabase/tests/rls_*.sql`. Corre también en CI (job `db`) y funciona en Linux y en Windows/Git Bash (allá con socket Unix, acá con TCP en loopback).

Las dos secuencias salen de esas listas y de ningún otro lado: si no puede leerlas se planta, porque un orden de repuesto deducido del nombre de archivo daría verde sobre una base que no es la que prueban los tests. `scripts/db-test.sh --imprimir-orden` la imprime sin tocar nada, y `orden-de-migraciones.test.ts` compara esa salida contra el arnés ejecutando el script de verdad.

Qué cubren:

- `rls_catalog.sql` — aislamiento entre hogares, barcode único por ámbito, UNKNOWN ≠ ZERO, DEV_SEED nunca verificado.
- `rls_recipes.sql` — la biblioteca global es intocable para un hogar (pero copiable), las recetas del hogar son invisibles para otros hogares, publicar congela la ficha nutricional, y una versión publicada no se puede editar ni por SQL directo.

## Qué incluye el Sprint 5

- **Semana**: siete días, cuatro comidas por día, con recetas publicadas o sin receta (comemos afuera, sobras, evento, libre). La semana se ancla al día del **hogar**, no al de UTC, y empieza el lunes.
- **Eventos**: asado, cumpleaños, viaje o comida libre, con su estrategia (`con margen`, `más liviano alrededor`, `sin conteo ese día`). Dan margen ese día sin compensar en los otros: nadie "paga" una comida con un día de ayuno.
- **Porciones confirmadas** ([ADR 0005](../docs/adr/0005-confirmed-servings-share-the-projection-table.md)). Confirmar una comida recalcula con el motor y **persiste** cantidades, nutrición, razones, reemplazos aceptados y las versiones exactas de receta, perfil y optimizador. Meses después se puede responder "¿por qué se sirvió esto?" abriendo la comida.
- **Los reemplazos dejan de vivir en la URL**: al confirmar quedan en `member_serving_substitutions`, con quién los aceptó.
- Confirmar dos veces **reemplaza**, no duplica; deshacer devuelve la comida a planificada y borra sus porciones.
- Ver porciones **sigue sin persistir nada**: es exploratorio y recalcula al vuelo.

### Preflight de endurecimiento

- **Cero `as unknown as`** sobre datos de Supabase: schemas Zod en el límite de Data Access. Una fila con forma inesperada lanza `DataShapeError` con el detalle en vez de convertirse en un objeto de dominio incompleto. Los `numeric` (que PostgREST entrega como texto) y las columnas `date` (que según el cliente llegan como texto o como `Date`) se normalizan una sola vez, en el borde.
- **Pruebas de integración** base → capa de datos → dominio contra un PostgreSQL real (PGlite) con migraciones y seeds aplicados: carga de familia, alergia HARD, dislike SOFT con sustitución, cambio de objetivo selectivo, totales corregidos, excepción del día, porciones familiares, semana, confirmación y aislamiento entre hogares.
- El editor de recetas declara el **rol** de cada componente y permite crear **alternativas de slot**.

## Qué incluye el Sprint 4

- **Una misma receta, una porción por persona** ([ADR 0003](../docs/adr/0003-portion-optimizer-and-member-profiles.md)). `PortionOptimizer` determinista y sin IA: porción estándar → restricciones HARD → preparación y grasa añadida → ensalada preferida → proteína hacia el rango → techo de calorías.
- **Tracking OFF / BASIC / FULL** (K-25). OFF no es estar excluido: participa de recetas, porciones y planificación, pero no se le pide ni se le muestra conteo. Nunca se le dice "te quedan 0 kcal" a quien no tiene presupuesto.
- **Objetivos con rango y vigencia**: mínimo, ideal y máximo, cualquiera opcional. La tabla es el historial: nada se actualiza en destructivo. Objetivos diarios y por comida.
- **Patrón de comidas y ayuno**: cada comida ENABLED/DISABLED/OPTIONAL, primera comida del día, ventana de alimentación. Con el desayuno desactivado no se le reserva nada al desayuno.
- **Preferencias HARD y SOFT**: una alergia bloquea el plato entero (no "una porción más chica"); un "no me gusta" penaliza, explica y como mucho sugiere un reemplazo.
- **Preferencias de preparación** con prioridad ingrediente > categoría > global, y **grasa añadida** como preferencia propia: freír no cuesta lo mismo que air fryer sin aceite, y esa diferencia va en la porción de quien la eligió.
- **Perfil versionado con huella**: cambiar un objetivo de Sebastián recalcula el perfil de Sebastián, no el de toda la familia. Emite `NUTRITION_PROFILE_CHANGED` al outbox con `dedupe_key`.
- **`TARGET_CONFLICT` en vez de números inventados**: si el mínimo de proteína no cabe bajo el máximo de calorías, la app lo dice.
- **Totales para cocinar**: la suma exacta de las porciones reales (no la receta × personas), agrupada por método de cocción.
- Pantallas: perfil del integrante (seguimiento, objetivos del día, mis comidas, preparación, preferencias) y **"Ver porciones para mi familia"** con tarjeta por persona, "¿Por qué?" y totales.

## Qué incluye el Sprint 3

- Recetas modulares y **versionadas** ([ADR 0002](../docs/adr/0002-recipe-versioning-and-nutrition-aggregation.md)): `MealTemplate` + `MealTemplateVersion` inmutable. Publicar congela la ficha nutricional de cada componente; editar crea la versión siguiente y la anterior queda intacta (reforzado con triggers, no solo en la UI).
- Slots con **varios** ingredientes (la ensalada chilena son tomate + cebolla + cilantro + limón), alternativas de **compatibilidad culinaria** que explícitamente no afirman equivalencia nutricional, y aderezos como ingredientes reales con sus calorías.
- Ensaladas y postres reutilizables dentro de la misma arquitectura (`kind = SALAD | DESSERT`), referenciados por versión: "Pollo + arroz + Ensalada Chilena v2".
- Motor `calculateMealNutrition`: cada ingrediente se resuelve con **su** ficha y **su** estado, y recién ahí se suman los vectores absolutos — por eso una receta con pollo crudo y arroz cocido se calcula sin problema, mientras leer una ficha con la base equivocada sigue siendo un error.
- **Completitud por nutriente** COMPLETE / PARTIAL / UNKNOWN: si un ingrediente no informa fósforo, el plato dice "cálculo incompleto" en vez de inventar un total.
- `scaleMealTemplateVersion`: escalar 5 → 6 porciones es una proyección; la receta guardada no se toca.
- Pantallas: RECETAS (búsqueda + filtros por momento del día y por ámbito), DETALLE con calculadora de porciones en vivo y procedencia de cada dato, CREAR/EDITAR con lenguaje de cocina ("Agregar proteína") y nutrición actualizándose mientras se escribe, DUPLICAR y "Copiar a mis recetas".
- Seed: 9 recetas globales de demostración (7 platos + 2 ensaladas reutilizables), `DEV_SEED`.
- Tabla `member_favorites` creada y con RLS, sin UI todavía (Sprint 4).

## Qué incluye el Sprint 2

- Catálogo nutricional multi-fuente ([ADR 0001](../docs/adr/0001-food-data-provenance.md)): ingredientes genéricos globales/privados, productos comerciales del hogar, nutrición por 100 g/ml con estado (crudo/cocido/…), procedencia completa y **nutrientes desconocidos como NULL, nunca 0**.
- Seed de desarrollo (~19 ingredientes + 3 productos demo, `source=DEV_SEED`, explícitamente no oficial).
- Dominio puro testeado: normalización etiqueta→100 g (conservando el original), cálculo por cantidad, porciones con peso real prioritario, no-mezcla crudo/cocido ni g/ml, validación GS1 de barcodes (EAN-8/UPC-A/EAN-13/GTIN-14).
- Pantallas: CATÁLOGO (búsqueda por nombre/marca/barcode + filtros), detalle de ingrediente y de producto con calculadora inmediata, AGREGAR PRODUCTO con resumen de confirmación ("Interpretamos: …").
- Abstracciones `FoodDataProvider` / `BarcodeProductProvider` para USDA y Open Food Facts futuros (sin implementación productiva).

## Qué incluye el Sprint 1

- Next.js 15 (App Router) + TypeScript strict + Tailwind 4, PWA shell mobile-first.
- Auth email+contraseña (Supabase Auth) con refresh de sesión en middleware.
- Dominio Family: hogares, integrantes (con o sin cuenta), roles semilla (ADMIN/MEMBER/PLANNER/SHOPPER/COOK), permisos por unión de roles.
- Invitaciones por link de un solo uso (hash SHA-256 almacenado, TTL 7 días) para unirse o vincular un miembro sin cuenta.
- Pantalla FAMILIA mínima: crear hogar, listar integrantes con roles, generar invitación.
- Outbox (`domain_events` con `dedupe_key`) y auditoría append-only, listos para los sprints siguientes.
