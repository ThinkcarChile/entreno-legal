# Poner HagoTuFila sobre un proyecto Supabase real

Guía para partir de un proyecto vacío y llegar a la aplicación funcionando, sin
pasos manuales no documentados.

Tiempo aproximado: 20 minutos.

---

## 1. Crear el proyecto

1. Entra a <https://supabase.com/dashboard> y crea un proyecto.
2. Elige la región más cercana a Chile (hoy `sa-east-1`, São Paulo).
3. Guarda la contraseña de la base de datos que te pide. La vas a necesitar para
   aplicar migraciones y semillas.

Anota el **project ref**: es el identificador que aparece en la URL del panel,
`https://supabase.com/dashboard/project/<project-ref>`.

> **Proyecto de desarrollo de HagoTuFila.** Ya existe y no hay que crearlo de
> nuevo: `hagotufila-dev`, ref `xwgobslgldxzatjrcxhl`, región `sa-east-1`,
> `https://xwgobslgldxzatjrcxhl.supabase.co`. **El esquema ya está aplicado**
> —21 migraciones y la semilla geográfica—, así que si trabajas contra él,
> `db:push:hosted` no tendrá nada pendiente. Para ponerte a trabajar basta con
> la sección 2 y la 8.

---

## 2. Copiar las credenciales

En el panel: **Project Settings → API Keys**.

| Valor en el panel | Variable en `.env.local` |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| Publishable key (`sb_publishable_…`) | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Secret key (`sb_secret_…`) | `SUPABASE_SECRET_KEY` |

Si tu proyecto todavía muestra las claves antiguas `anon` y `service_role`, usa
`NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. La aplicación
acepta las dos formas y prefiere las nuevas.

```bash
cd apps/web
cp .env.example .env.local
# completa los valores
```

La clave secreta **nunca** lleva el prefijo `NEXT_PUBLIC_`: Next incrustaría en
el navegador una credencial que omite RLS.

---

## 3. Aplicar el esquema

### 3.a Vía normal: el CLI de Supabase

```bash
cd apps/web

npx supabase login
npx supabase link --project-ref <project-ref>

# Vista previa: muestra qué migraciones se aplicarían
npx supabase db push --dry-run

# Aplicar. Incluye la semilla geográfica (16 regiones, 346 comunas),
# que es obligatoria: los trabajos referencian comunas por clave foránea.
npx supabase db push --include-seed
```

Esto crea, en orden: extensiones, enums, funciones auxiliares, tablas, triggers,
vistas, políticas RLS, privilegios de tabla y de columna, buckets de Storage y
las funciones RPC.

### 3.b Si el puerto de PostgreSQL está cerrado

`supabase db push` abre una conexión PostgreSQL directa al puerto 5432 del
proyecto, o al 6543 del pooler. Hay entornos —contenedores de integración
continua, redes corporativas, el entorno remoto de un agente— donde solo sale
tráfico HTTPS. Ahí `db push` no falla con un mensaje claro: se queda esperando
hasta agotar el tiempo.

Cómo saber si es tu caso, antes de perder diez minutos:

```bash
# 443 responde y 5432 no → estás en este caso
node -e 'const s=require("net").connect(5432,"aws-1-sa-east-1.pooler.supabase.com");
s.setTimeout(6000);
s.on("connect",()=>{console.log("5432 abierto");s.end()});
s.on("timeout",()=>{console.log("5432 bloqueado");s.destroy()});
s.on("error",e=>console.log("5432 bloqueado:",e.code))'
```

Para ese caso el repositorio trae:

```bash
# Requiere SUPABASE_ACCESS_TOKEN en .env.local (token personal `sbp_…`,
# se crea en https://supabase.com/dashboard/account/tokens)
npm run db:push:hosted -- --plan    # vista previa, no escribe nada
npm run db:push:hosted              # aplica
```

`scripts/push-migrations-hosted.ts` envía el contenido de cada archivo de
`supabase/migrations/` tal cual, en el mismo orden, a través de la Management
API sobre HTTPS, y lleva el mismo registro en
`supabase_migrations.schema_migrations` que usa el CLI. Un `supabase db push`
posterior desde otra máquina ve las migraciones como aplicadas y no las repite.
No reconstruye SQL ni omite comprobaciones: si una migración falla, se detiene
en ese archivo, no la registra y sale con código distinto de cero.

### 3.c Riesgos del token de acceso personal

Un token `sbp_…` no está limitado a un proyecto: da acceso a **todos** los
proyectos de la cuenta, y a la Management API entera. Trátalo como la contraseña
de la cuenta, no como una clave de proyecto.

- Vive solo en `.env.local` (ignorado por git) o en el gestor de variables de
  entorno del servidor. Nunca en el repositorio, en un registro ni en un ticket.
- Úsalo solo desde el servidor o desde tu máquina, nunca desde el navegador.
- Es para desplegar en **desarrollo o staging**. En producción el despliegue lo
  hace el CLI en integración continua, con un token de servicio propio y de vida
  corta.
- Si se filtra, revócalo de inmediato en
  <https://supabase.com/dashboard/account/tokens>. Revocar no rompe la
  aplicación: ella no usa este token, solo estos dos scripts.

---

### 3.d La semilla geográfica, por HTTPS

`--include-seed` no tiene equivalente en la Management API, y sin las 346
comunas no se puede publicar un trabajo: `jobs.commune_id` es una clave foránea.
Para eso está:

```bash
npm run db:seed:hosted -- --plan                        # lee, no escribe
npm run db:seed:hosted -- --project-ref <project-ref>   # aplica
```

Aplica `supabase/seed/001_geo.sql`, el mismo archivo que usan `db push
--include-seed` y `npm run db:test`, generado desde `src/lib/geo/chile.ts`.

**No se registra en el historial de migraciones**, y es deliberado: las
migraciones describen el esquema, esto son datos de referencia. Anotarla allí
haría que `supabase db push` creyera aplicada una migración inexistente.

Salvaguardas, todas comprobadas por la máquina y no solo prometidas:

| Qué impide | Cómo |
|---|---|
| Sembrar producción | Se niega con `NODE_ENV=production` |
| Sembrar el proyecto equivocado | Hay que escribir el ref en la orden, y debe coincidir con el del entorno |
| Que la semilla haga algo más | Analiza el SQL antes de enviarlo: solo `countries`, `regions` y `communes`; nada de `auth.` ni `storage.`; nada que parezca contraseña o credencial; ningún `drop`/`truncate`/`alter table` |
| Duplicados al repetir | Exige que cada `insert` traiga `on conflict`; el archivo lo cumple |
| Filtrar datos por el registro | Solo imprime conteos |

Al terminar comprueba que queden exactamente 1 país, 16 regiones y 346 comunas,
y falla si no.

> **Nunca en producción.** Ni `--include-seed`, ni `db:seed:hosted`, ni las
> semillas `002_demo_accounts.sql` / `003_demo_content.sql`: estas dos últimas
> crean cuentas con una contraseña conocida y publicada en esta misma guía.

### Comprobar que quedó completo

Lo más rápido, y lo que no se olvida de nada:

```bash
npm run verify:schema:hosted
```

Comprueba contra el proyecto alojado el inventario completo —tablas, vistas,
funciones, enums, políticas, buckets, políticas de Storage, datos de referencia,
comisión y las 21 migraciones del historial— y además que ninguna tabla esté sin
RLS, que ninguna vista se salte `security_invoker`, que el rol `anon` no tenga
escritura en ninguna tabla, que toda función `SECURITY DEFINER` fije su
`search_path`, y que la publicación de Realtime traiga las cuatro tablas
esperadas. Comprueba además que la URL de retorno de autenticación esté
autorizada en el panel (§4.1), que es lo único de esa sección que se puede
verificar desde fuera. Termina leyendo los **advisors** de seguridad y
rendimiento del proyecto. Solo lee; sale con código distinto de cero si algo no
cuadra.

Un aviso de seguridad cuenta como fallo, y no poder leer el advisor también: no
haber podido mirar no es lo mismo que estar limpio.

La única excepción es una lista explícita dentro del propio script,
`AVISOS_ACEPTADOS`: cada aviso aceptado va con su objeto y el motivo por el que
se acepta. Hoy tiene una sola entrada, las 16 RPC que un usuario con sesión debe
poder ejecutar. La lista se comprueba en los dos sentidos: un aviso que no esté
en ella falla aunque sea del mismo tipo que otro ya aceptado —una función nueva
se revisa antes de aceptarse—, y una entrada que el advisor ya no reporte
también falla, para que la lista no envejezca sola.

Los avisos del advisor de **rendimiento** se resumen por tipo y no bloquean: son
consejos de optimización, no agujeros.

Alternativas manuales:

```bash
npx supabase db push --dry-run     # debe decir que no hay migraciones pendientes
```

O desde el editor SQL del panel:

```sql
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE')       as tablas,
  (select count(*) from information_schema.views
    where table_schema = 'public')                                     as vistas,
  (select count(*) from information_schema.routines
    where routine_schema = 'public')                                   as funciones_rpc,
  (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e')                    as enums,
  (select count(*) from pg_policies where schemaname = 'public')       as politicas_rls,
  (select count(*) from public.communes)                               as comunas,
  (select count(*) from storage.buckets)                               as buckets,
  (select commission_bps from public.platform_settings)                as comision_pb;
```

| Columna | Valor esperado |
|---|---|
| `tablas` | 32 |
| `vistas` | 5 |
| `funciones_rpc` | 16 |
| `enums` | 19 |
| `politicas_rls` | 73 |
| `comunas` | 346 |
| `buckets` | 5 |
| `comision_pb` | 1400 |

Las mismas cifras las comprueba `npm run db:test` contra un PostgreSQL local, así
que si difieren es que faltó aplicar alguna migración.

---

## 4. Configuración del panel que NO viene en las migraciones

Estas tres cosas se configuran en el panel. No hay forma de dejarlas en una
migración, así que quedan documentadas aquí.

### 4.1 URLs de redirección (obligatorio)

**Authentication → URL Configuration**

- *Site URL*: `http://localhost:3000` en desarrollo, `https://hagotufila.cl` en
  producción.
- *Redirect URLs*: agrega `http://localhost:3000/auth/callback`,
  `http://localhost:3100/auth/callback` (el puerto de las pruebas E2E) y
  `https://hagotufila.cl/auth/callback`.

Sin esto, los enlaces de confirmación de correo y de recuperación de contraseña
llevan al lugar equivocado.

`npm run verify:schema:hosted` lo comprueba y falla si falta. Antes esta sección
solo lo pedía y nadie lo verificaba: `hagotufila-dev` llevaba la lista vacía sin
que nada lo dijera, y eso no se nota hasta que alguien pincha el enlace de un
correo. Ya está puesta.

### 4.1.b Protección contra contraseñas filtradas (obligatorio)

**Authentication → Policies → Password protection**, activar *Prevent use of
leaked passwords*. Supabase contrasta la contraseña contra HaveIBeenPwned al
registrarse o al cambiarla.

No se puede dejar en una migración: es configuración del proyecto. Y **solo está
disponible desde el plan Pro**: en un proyecto Free la Management API responde
`402`. `hagotufila-dev` es Free, así que el aviso figura en la lista
`AVISOS_ACEPTADOS` de `verify:schema:hosted` con ese motivo escrito.

Mientras tanto quien cubre el mínimo es la aplicación: exige 8 caracteres al
registrarse y al cambiar la clave, por encima de los 6 que trae Supabase.

> **Al pasar a producción**, que será un proyecto de pago: activa esta casilla y
> **quita la entrada de `AVISOS_ACEPTADOS`**. No hay que acordarse: en cuanto
> esté activa, el advisor deja de reportarla y la verificación falla por tener
> en la lista algo que ya no corresponde.

### 4.2 Confirmación de correo (decisión tuya)

**Authentication → Providers → Email**

- *Confirm email* **activado**: más seguro, es lo correcto en producción. Quien
  se registre debe abrir el enlace antes de entrar.
- *Confirm email* **desactivado**: cómodo para probar el recorrido completo sin
  revisar buzones.

En un proyecto de pruebas conviene desactivarlo. La aplicación funciona igual en
los dos casos: si Supabase exige confirmación, el registro muestra "revisa tu
correo" en vez de entrar directo.

Para saber cómo está un proyecto sin entrar al panel, la clave es
`mailer_autoconfirm`: `true` significa confirmación desactivada.

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/settings" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const s=JSON.parse(d);
    console.log("registro abierto :", !s.disable_signup);
    console.log("correo+contraseña:", s.external.email);
    console.log("autoconfirmación :", s.mailer_autoconfirm);
  })'
```

`hagotufila-dev` responde hoy `mailer_autoconfirm: false`, es decir, con
confirmación exigida. Eso **no** bloquea las pruebas: `npm run verify:supabase` y
las pruebas E2E no se registran por el formulario, sino que crean sus cuentas con
`auth.admin.createUser({ email_confirm: true })` usando la clave privada, que es
justamente la excepción para la que esa clave está permitida.

### 4.3 Realtime (verificar)

**Database → Replication**

Las migraciones ya agregan `messages`, `job_evidence`, `notifications` y
`conversations` a la publicación `supabase_realtime`. Comprueba que aparezcan
marcadas. Si no, el chat no recibe mensajes sin recargar.

---

## 5. Datos de demostración (solo entornos de prueba)

Crean usuarios con contraseña conocida. **No los apliques en producción.**

```bash
# La cadena de conexión está en: Project Settings → Database → Connection string
export DATABASE_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'

psql "$DATABASE_URL" -f supabase/seed/002_demo_accounts.sql
psql "$DATABASE_URL" -f supabase/seed/003_demo_content.sql
```

Deja once cuentas `…@demo.cl` con la contraseña `hagotufila2026`, trabajos en
seis regiones, ofertas, un trabajo pagado y conversaciones. `admin@demo.cl` entra
al panel interno.

---

## 6. Generar los tipos de TypeScript

```bash
npx supabase gen types typescript --linked --schema public \
  > src/lib/supabase/database.types.ts
```

Reemplaza el archivo genérico que trae el repositorio. A partir de ahí,
TypeScript detecta un nombre de columna equivocado en tiempo de compilación.

---

## 7. Levantar la aplicación

```bash
npm install
npm run dev
```

En desarrollo, arriba de la página aparece una banda verde que dice
**Supabase conectado** con el nombre del proyecto. Si dice **Modo demo** en
naranja, falta alguna credencial: revisa `.env.local`.

---

## 8. Validar el recorrido completo

### 8.1 Cuentas de control de calidad

Crea cuatro cuentas y ponlas en `.env.local`. No uses contraseñas que uses en
otro sitio; el repositorio no trae ninguna.

```bash
E2E_CLIENT_EMAIL=qa.cliente@tudominio.cl
E2E_CLIENT_PASSWORD=<contraseña>
E2E_WORKER_EMAIL=qa.trabajador@tudominio.cl
E2E_WORKER_PASSWORD=<contraseña>
E2E_OUTSIDER_EMAIL=qa.tercero@tudominio.cl
E2E_OUTSIDER_PASSWORD=<contraseña>
E2E_ADMIN_EMAIL=qa.admin@tudominio.cl
E2E_ADMIN_PASSWORD=<contraseña>
```

El script las crea si no existen, ya confirmadas, y le da el rol de
administración a la última.

### 8.2 Verificación por API

```bash
npm run verify:supabase
```

Recorre el marketplace entero y comprueba, además del camino feliz, que lo
prohibido falle de verdad: un trabajador sin verificar no puede ofertar, un
tercero no lee conversaciones ajenas, el cliente no reescribe el precio de una
oferta ni el importe de un pago, dos aceptaciones simultáneas dejan una sola
asignación, nadie escribe en la carpeta de Storage de otro y la bitácora de
auditoría no se puede alterar.

Sale con código distinto de cero si algo falla e indica qué.

### 8.3 Recorrido por el navegador

```bash
npm run e2e
```

Son once pruebas: cuatro de páginas públicas y siete del marketplace, que
recorren entrar como cliente → publicar → entrar como trabajador → ofertar →
conversar → aceptar → simular pago → ver las dos listas de «mis trabajos».

Playwright levanta el servidor por su cuenta, **en modo desarrollo**. No es un
descuido ni una comodidad: `npm run start` corre con `NODE_ENV=production`, y
ahí la aplicación se niega —a propósito— a iniciar un pago con el proveedor
simulado. Con el servidor en producción el recorrido llegaba hasta el pago y se
quedaba frente a un botón «Pagar con Webpay» que todavía no hace nada. La
prohibición es correcta; lo que estaba mal era pedir un pago simulado en un
entorno que se declara de producción.

Las credenciales salen de `.env.local`, que `playwright.config.ts` carga con el
mismo lector que los scripts. Si faltan, las siete pruebas del marketplace se
omiten indicando el motivo. Conviene mirar ese motivo: una omisión silenciosa se
parece demasiado a un éxito.

Si tu entorno ya trae Chromium instalado aparte, y con una versión distinta a la
que Playwright espera:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/ruta/al/chromium npm run e2e
```

### 8.4 Recorrido a mano

Con dos navegadores distintos (o uno normal y otro en incógnito) para tener las
dos sesiones a la vez:

**Cliente**: registrarse → completar perfil → publicar un trabajo → recibir la
oferta → abrir el perfil del trabajador → conversar → aceptar → simular el pago
→ ver el trabajo asignado.

**Trabajador**: registrarse → completar perfil → solicitar verificación →
(desde `admin@…` aprobar en `/admin/verificaciones`) → explorar trabajos →
enviar oferta → conversar → ser seleccionado → ver el trabajo asignado.

Con las dos ventanas abiertas, escribe desde una: el mensaje debe aparecer en la
otra sin recargar.

Ese último punto necesita que **el navegador** alcance Supabase por WebSocket, no
solo el servidor. Es lo primero que falla detrás de un proxy corporativo o en un
contenedor de integración continua, y se distingue de un defecto de la
aplicación mirando la consola del navegador: si dice que la conexión al
`wss://<ref>.supabase.co/realtime/v1/websocket` no se pudo establecer, es la red.
Tu propio mensaje sí aparece en tu hilo aunque el socket esté caído; lo que no
llega es el de la otra persona hasta recargar.

---

## 9. Producción

1. Proyecto Supabase aparte del de pruebas. No compartas la base.
2. `NEXT_PUBLIC_SITE_URL` con el dominio real y HTTPS.
3. `PAYMENT_PROVIDER` **no** puede quedar en `mock`: la aplicación se niega a
   iniciar un pago con `NODE_ENV=production` y proveedor simulado.
4. No apliques las semillas de demostración.
5. Revisa que la clave secreta esté solo en las variables del servidor de tu
   plataforma de despliegue, nunca en el repositorio.
6. En **Authentication → Rate Limits**, ajusta los límites de envío de correo.

---

## 10. Si algo falla

| Síntoma | Causa habitual |
|---|---|
| "Supabase no está configurado en este entorno" | Falta `NEXT_PUBLIC_SUPABASE_URL` o la clave pública en `.env.local` |
| El registro no envía correo | Confirmación desactivada, o límite de envío alcanzado |
| El enlace del correo lleva a otro sitio | Falta la URL en *Redirect URLs* |
| El chat no actualiza sin recargar | La tabla `messages` no está en la publicación de Realtime |
| "Falta la clave privada de Supabase" al pagar | Falta `SUPABASE_SECRET_KEY` |
| `db push` falla al crear políticas de Storage | El rol no puede escribir en `storage.objects`: crea esas políticas desde **Storage → Policies** con las reglas de la migración `…000900` |
| Un trabajador verificado no puede ofertar | Revisa `worker_profiles.verification_status`; debe ser `VERIFIED` |
| `db push` se queda colgado sin mensaje | El puerto 5432/6543 está bloqueado en tu red: usa `npm run db:push:hosted` (sección 3.b) |
| Todas las páginas dan 500 con `PGRST205` | Hay credenciales pero el esquema no está aplicado: la aplicación habla con el proyecto y el proyecto está vacío |
| "Variables de entorno inválidas" al arrancar | Un valor presente pero mal formado. Una variable *vacía* no da este error: se trata como ausente |
| Las pruebas del marketplace salen «omitidas» | Playwright no encontró las cuentas. Mira el motivo que imprime: falta alguna `E2E_*` en `.env.local` |
| `npm run e2e` no encuentra el navegador | La versión de Chromium instalada no es la que espera Playwright: `PLAYWRIGHT_CHROMIUM_PATH=/ruta/al/chromium npm run e2e` |
| El pago simulado devuelve a un puerto donde no escucha nadie | `NEXT_PUBLIC_SITE_URL` no coincide con la URL real del servidor. La URL de retorno se construye con esa variable |
| El chat no recibe los mensajes de la otra persona | El navegador no logra abrir el WebSocket con Supabase. Míralo en la consola: si la conexión ni se establece, es la red, no la aplicación |
| El registro deja el correo y la contraseña en la URL | No debería volver a pasar: los formularios de credenciales van por POST desde la Etapa 2.5. Si lo ves, la página no hidrató Y el formulario perdió su `method` |
| `verify:schema:hosted` falla con un aviso de seguridad nuevo | Es lo que tiene que hacer. Corrígelo, o —si es correcto por diseño— añádelo a `AVISOS_ACEPTADOS` con su motivo |
