# Activar Supabase (paso a paso)

Guía para dejar el proyecto corriendo de verdad en el navegador. Son ~20 minutos,
casi todos esperando que la base termine de aplicar migraciones.
La app usa **email + contraseña** (`signInWithPassword` / `signUp`), no magic link.

---

## 1. Crear el proyecto

1. Entra a <https://supabase.com/dashboard> con tu cuenta.
2. **New project**.
   - **Name**: `mesa-familiar` (o el que quieras).
   - **Database password**: genera una fuerte y **guárdala en tu gestor de contraseñas**.
     No la necesitas para la app, sí para conectarte por `psql` o para restaurar.
   - **Region**: **South America (São Paulo)** — es la más cercana a Chile.
   - **Plan**: Free alcanza y sobra para esto.
3. Espera ~2 minutos a que termine de aprovisionar.

## 2. Copiar las credenciales

En **Project Settings → API**:

- **Project URL** → `https://xxxxxxxxxxxx.supabase.co`
- **Project API keys → `anon` / `public`** → un JWT largo.

> La `anon key` es **pública por diseño** (viaja al navegador); quien protege los datos es la RLS.
> La **`service_role` key NO se usa en este proyecto y no debe salir del dashboard** — se salta toda la RLS.

## 3. Crear `web/.env.local`

En `C:\Users\franc\entreno-legal\web`, copia `.env.example` a `.env.local` y complétalo:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

`.env.local` ya está en `.gitignore`: no se sube al repo.

## 4. Aplicar las migraciones — **TODAS**, y en el orden real

Se aplican **todas las de `supabase/migrations/`**, pero **el orden no es el
número del archivo**: la `0036` va **DESPUÉS** de la `0037`. Cuando se escribió
la 0036, las 0033-0035 y la 0037 ya estaban puestas en producción, y esa —no la
alfabética— es la secuencia que ejercitan las pruebas.

> El orden real vive en **un solo lugar**: la lista `MIGRACIONES` de
> `web/src/integration/harness.ts`, la misma que levanta la base de las pruebas.
> Quien la lee y aplica en ese orden es **`scripts/poner-al-dia.mjs`**.
>
> Ningún `for` sobre `supabase/migrations/*.sql` ni ningún `Sort-Object Name` te
> va a dar esa secuencia: te dan la alfabética, que ninguna prueba ejercita.
>
> **Y eso es exactamente lo que es: no probada, ni más ni menos.** Hoy las dos
> secuencias dejan el MISMO esquema —se aplicaron las dos cadenas completas
> contra un PostgreSQL de verdad y las dos quedaron verdes—, porque la 0036 y la
> 0037 no comparten un solo objeto: la 0036 crea las tablas de porciones
> servidas, la 0037 sólo toca `accept_invitation`. El orden del arnés no está
> para que la cadena no reviente hoy: está porque es de **procedencia**
> —producción tiene puesta la 0037 y no la 0036, que es de lo que vive
> `supabase/estado-produccion.json`— y porque es la secuencia que ejercitan las
> pruebas. El día que dos migraciones sí compartan un objeto, la alfabética deja
> de ser una secuencia no probada y pasa a ser una rota, y nada va a avisar.
>
> Con los **seeds** el mismo atajo ya había mordido, y ahí sí se notaba:
> `scripts/db-test.sh` los aplicaba por glob, o sea `dev_recipes_biblioteca.sql`
> antes que `dev_recipes_seed.sql` —«biblioteca» < «seed»—, y la biblioteca anida
> recetas que aquel publica. El job `db` de CI moría ahí, en cada push. Ese
> script ahora deriva las dos secuencias de las listas `MIGRACIONES` y `SEEDS`
> del arnés, y se planta si no puede leerlas.

**No es una lista de la que puedas cortar un pedazo.** Cada migración asume el
esquema que dejó la anterior, y la app usa tablas y funciones de casi todas: si
paras a mitad de camino, la base queda con un esquema que ninguna versión del
código conoce y las pantallas revientan una por una. Las 0001..0038 están
**congeladas** (no se editan: las correcciones entran en migraciones nuevas), así
que la lista solo crece por el final.

### 4.1 Camino recomendado: los scripts

Son tres, y cada uno contesta **una** pregunta. Ninguno contesta la del otro, a
propósito: cuando dos cosas contestaban lo mismo se contradijeron, y así fue como
el repo y producción se separaron sin que nadie lo notara.

| Script | Contesta | No contesta |
|---|---|---|
| `scripts/poner-al-dia.mjs` | en qué **orden** va la cadena (lo lee del arnés) y las aplica | qué tiene puesto producción |
| `scripts/verificar-estado-produccion.mjs` | qué tiene puesto **producción hoy**, preguntándole a la base | el orden |
| `scripts/aplicar-migracion.mjs` | aplica **un** archivo, el que le nombres | ni el orden ni el estado |

`scripts/aplicar-migracion.mjs` es el brazo de los otros dos: manda los bytes del
archivo tal cual por la Management API, con guardián de codificación y checksum.
Nació de un incidente real: el portapapeles de Windows reescribió el UTF-8 y
llegaron acentos rotos a una base clínica (eso es lo que arregla la 0028).

`scripts/db-test.sh` —el job `db` de CI, que levanta un PostgreSQL efímero y
corre los tests SQL— lee la **misma** lista del arnés, y `--imprimir-orden` la
muestra sin tocar nada. No es un cuarto dueño: es otro lector del mismo. Si no
puede leerla, se planta.

1. Crea un token en <https://supabase.com/dashboard/account/tokens>
   («Generate new token», nómbralo por ejemplo `claude-code-migraciones`).
2. Crea `.env.deploy` en la **raíz del repo** (no en `web/`) con una sola línea:

   ```
   SUPABASE_ACCESS_TOKEN=sbp_...
   ```

   > Va en la raíz a propósito. Next.js carga `web/.env.local` entero dentro del
   > proceso del servidor web, y este token corre SQL arbitrario sobre **toda** la
   > cuenta: la app no lo necesita y no debe tenerlo al alcance. `.env.deploy` está
   > ignorado por git, y el token se revoca desde esa misma página cuando quieras.

3. Comprueba que llegas al proyecto correcto:

   ```bash
   node scripts/aplicar-migracion.mjs --check
   ```

4. Mira el orden real y qué falta. Ninguno de los dos toca nada:

   ```bash
   node scripts/poner-al-dia.mjs                  # imprime la cadena EN ORDEN
   node scripts/verificar-estado-produccion.mjs   # le pregunta a la base qué tiene
   ```

   Si `poner-al-dia.mjs` se planta diciendo que hay migraciones en disco que el
   arnés **no nombra**, eso no es un estorbo: es una migración escrita que
   ninguna prueba ejercita. Se agrega a la lista `MIGRACIONES` de
   `web/src/integration/harness.ts` antes de aplicarla. Pasa con toda migración
   recién escrita: nace en el disco y alguien tiene que engancharla. (Acá no va
   una lista de cuáles: sería una foto de un día, y el que la lea después la va a
   creer. La lista viva la imprime el script.)

5. Aplícalas nombrándolas. El script las ordena solo, así que da igual en qué
   orden las escribas:

   ```bash
   node scripts/poner-al-dia.mjs --aplicar 0036 0038
   ```

   En una base recién creada faltan **todas**: los números salen de la lista que
   imprimió el paso 4, y se le pasan todos.

   Se piden explícitas a propósito. **No existe una tabla de migraciones
   aplicadas**: aplicar «lo que falte» sería adivinar, y adivinar mal sobre una
   base clínica deja un esquema que ningún archivo del repo describe. Por lo
   mismo se detiene en la primera que falle, sin seguir con las de más abajo.

   Para saber qué está aplicado, el dueño de ese dato es
   `scripts/verificar-estado-produccion.mjs` con el libro
   `supabase/estado-produccion.json`: cada migración declara ahí un **testigo**
   —una expresión SQL falsa antes de aplicarla y verdadera después— y el script
   evalúa los testigos **contra la base real**. Lee efectos, no un registro de
   ejecución, porque lo único que la base sabe contestar es qué objetos tiene.
   Que cada testigo distinga de verdad lo prueba
   `web/src/integration/estado-produccion.test.ts` en PGlite.

   `aplicar-migracion.mjs --pendientes` sigue existiendo por costumbre de los
   dedos, pero no contesta él: llama a ese script.

### 4.2 Camino manual: SQL Editor del dashboard

Sirve si no quieres crear un token. **SQL Editor → New query**, pega y ejecuta
cada archivo, uno por uno, esperando el "Success" de cada uno.

**En el orden que imprime `node scripts/poner-al-dia.mjs`**, no en el del
explorador de archivos: ahí la 0036 aparece antes que la 0037 y esa secuencia no
la probó nadie.

> **En Windows, copia con `Get-Content -Raw -Encoding UTF8 | Set-Clipboard`, nunca
> con `clip`.** `clip` reescribe el UTF-8 en la página de códigos del sistema y
> los acentos llegan rotos a la base. Ya pasó una vez (migración 0028) y lo que se
> rompió fueron los mensajes que le explican a una persona por qué el sistema se
> niega a algo.

Si una falla, **no sigas**: avísame con el mensaje de error en vez de saltártela.

## 5. Cargar los seeds de desarrollo (opcional pero recomendado)

Mismo canal que las migraciones, **después** de aplicarlas todas, y **en este
orden** (el script acepta rutas relativas a `supabase/migrations`):

```bash
node scripts/aplicar-migracion.mjs ../seed/dev_catalog_seed.sql
node scripts/aplicar-migracion.mjs ../seed/dev_recipes_seed.sql
node scripts/aplicar-migracion.mjs ../seed/dev_recipes_biblioteca.sql
```

| Archivo | Qué trae | Necesita antes |
|---|---|---|
| `dev_catalog_seed.sql` | 19 ingredientes, 3 productos comerciales, medidas caseras y reglas de guardado | las migraciones |
| `dev_recipes_seed.sql` | 9 recetas de demostración en la biblioteca global, más papa, fideos, cilantro y limón | el catálogo de arriba |
| `dev_recipes_biblioteca.sql` | la biblioteca chilena: **282 recetas** y 150 alimentos nuevos | los **dos** anteriores |

El orden no es estético: hay recetas de la biblioteca que **anidan** «Ensalada
chilena» y «Ensalada verde», que nacen en `dev_recipes_seed.sql`. Si la
biblioteca entra antes, se cae con `La receta anidada ... no existe o no está
publicada` — y hace bien en caerse: la alternativa sería una receta con un hueco
adentro.

`dev_recipes_biblioteca.sql` pesa 1,1 MB y es un archivo **generado** (sale de
`web/src/domain/recipes/library/`, no se edita a mano). Si el editor SQL del
dashboard se atora con ese tamaño, aplícalo con el script; si tampoco pasa, queda
el camino de `psql` con la cadena de conexión del proyecto.

`dev_family_profiles.sql` **no se aplica**: es un puntero. Su contenido real vive
en la migración `0024_demo_family_function.sql`, porque `seed_demo_family_profiles`
es esquema de verdad (la app la llama en `loadDemoFamily`).

Todo entra marcado `DEV_SEED`: valores plausibles para validar la arquitectura,
**nunca** se muestran como datos oficiales ni verificados. La nutrición de la
biblioteca chilena no está curada contra la tabla del INTA, y eso está declarado
en el propio archivo.

## 6. Ajustar autenticación

En **Authentication → Providers → Email**: debe estar habilitado (lo está por defecto).

En **Authentication → Sign In / Providers** (o **Settings**), busca **Confirm email**:

- **Desactívalo mientras desarrollamos.** Si queda activo, al registrarte Supabase no te
  entrega sesión hasta que hagas clic en un correo de confirmación, y la app te va a
  devolver al login como si la clave estuviera mala.
- Antes de que esto lo use gente de verdad, se vuelve a activar.

En **Authentication → URL Configuration**, agrega a **Redirect URLs**:

```
http://localhost:3000/**
```

## 7. Levantar la app

```bash
cd C:\Users\franc\entreno-legal\web && npm run dev
```

Abre <http://localhost:3000>:

1. **Crear cuenta** con tu correo y una contraseña.
2. Te lleva a **Familia** → crea el hogar (nombre del hogar + tu nombre).
3. **Catálogo** → deberías ver **173 alimentos** (19 del catálogo + 4 del seed de
   recetas + 150 de la biblioteca).
4. **Recetas** → **291 recetas** publicadas en la biblioteca global: las 9 de
   demostración más las 282 chilenas.

Si aplicaste solo el segundo seed, vas a ver 9 y no 291: te falta terminar el
paso 5, no está roto.

---

## Si algo falla

| Síntoma | Causa casi siempre |
|---|---|
| `Supabase no está configurado` | Falta `web/.env.local`, o no reiniciaste `npm run dev` después de crearlo. |
| "Credenciales incorrectas" recién registrado | **Confirm email** sigue activo (paso 6). |
| Una pantalla responde "Algo falló de nuestro lado" | Casi siempre falta una migración: corre `node scripts/verificar-estado-produccion.mjs` y aplica lo que salga PENDIENTE. |
| `relation "..." does not exist` | Migraciones aplicadas fuera de orden o alguna falló a la mitad. `verificar-estado-produccion.mjs` te dice hasta dónde llegó la base; el orden correcto lo imprime `poner-al-dia.mjs`. |
| Catálogo vacío pero sin error | Faltan los seeds (paso 5), o los corriste antes de las migraciones. |
| Ves 9 recetas y no 291 | Falta `dev_recipes_biblioteca.sql` (paso 5). |
| `La receta anidada ... no existe o no está publicada` | Aplicaste la biblioteca antes de `dev_recipes_seed.sql`. Aplica ese y vuelve a correr la biblioteca. |
| Acentos rotos en los mensajes de la base | Pegaste una migración con `clip`. Es exactamente el defecto de la 0028: vuelve a aplicarla con el script. |
| Ves 0 recetas teniendo seed | Estás en un hogar distinto al del seed: el seed carga recetas **globales**, que sí deberían verse. Si no, avísame: es un problema de RLS y quiero verlo. |

Las variables de entorno de Next se leen **al arrancar**: cada vez que toques `.env.local`,
corta el `npm run dev` y vuelve a levantarlo.
