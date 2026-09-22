# Arquitectura — HagoTuFila.cl

Documento de referencia de la Etapa 1. Describe decisiones, capas y los puntos donde
deliberadamente se evitó deuda técnica.

---

## 1. Ubicación del proyecto dentro del repositorio

El repositorio `entreno-legal` ya publica en GitHub Pages un `index.html` en la raíz
(política de privacidad de otra aplicación, enlazada desde Google Play). Crear el proyecto
Next.js en la raíz habría sobreescrito ese archivo y roto un enlace legal en producción.

La aplicación vive en `apps/web/`. La estructura `apps/*` deja espacio para
`apps/mobile` y `packages/*` compartidos sin reorganizar nada más adelante.

---

## 2. Capas

```
UI (React Server Components + Client Components)
   ↓  solo consume tipos de dominio y repositorios
Repositorios (interfaces de acceso a datos)
   ↓  dos implementaciones intercambiables: demo | supabase
Servicios de dominio (pricing, reputación, máquina de estados, dinero, fechas)
   ↓  puros, sin dependencias de framework ni de base de datos
Proveedores externos (PaymentProvider, IdentityVerificationProvider, NotificationChannel)
```

Reglas que sostienen la separación:

- `src/lib/domain/**` es **código puro**: sin `next/*`, sin `@supabase/*`, sin `process.env`.
  Se puede testear y reutilizar en una app nativa.
- La UI nunca importa el cliente de Supabase directamente. Pasa por `src/lib/data/**`.
- Los proveedores externos se declaran como interfaz y se resuelven en un único
  punto (`src/lib/payments/index.ts`, etc.). Cambiar Transbank por otro proveedor
  no toca la UI.

---

## 3. Decisiones técnicas y deuda evitada

### 3.1 Dinero: enteros en unidad mínima, nunca `float`

Todos los montos se guardan como `bigint` en la unidad mínima de la moneda, junto a un
código ISO-4217 (`currency`). Para CLP la unidad mínima es el peso (0 decimales).

Se evita: `numeric`/`float` con redondeos inconsistentes, y un rediseño completo al
internacionalizar. `formatMoney()` centraliza el formato con `Intl.NumberFormat`.

### 3.2 Fechas: `timestamptz` siempre, presentación en `America/Santiago`

Chile tiene horario de verano y además regiones con husos distintos (Magallanes, Pascua).
Guardar `timestamp` sin zona genera errores en trabajos nocturnos y overnight, que son
exactamente el caso de uso principal del producto.

Se guarda UTC y se presenta con `date-fns-tz` usando la zona del trabajo
(`jobs.timezone`, por defecto `America/Santiago`).

### 3.3 Datos sensibles: separación por tabla, no por columna

PostgreSQL RLS es **row-level**, no column-level. Guardar RUT, teléfono, selfie y cuenta
bancaria en la misma tabla que el perfil público obliga a exponer la fila completa o a
depender de vistas frágiles.

Por eso el modelo separa:

| Tabla | Contenido | Acceso |
|---|---|---|
| `profiles` | nombre, inicial del apellido, foto, bio | lectura pública |
| `user_private_data` | RUT, teléfono, email de contacto, dirección | solo titular + admin |
| `worker_profiles` | tarifa, disponibilidad, reputación calculada | lectura pública |
| `worker_verifications` | documento, selfie, resultado del proveedor | solo titular + admin |
| `worker_payout_accounts` | cuenta bancaria | solo titular + admin |

Cambiar un ID en la API nunca devuelve datos privados porque esos datos no están en la
fila pública.

### 3.4 Roles y RLS: función `SECURITY DEFINER`, no políticas recursivas

Consultar `profiles.role` dentro de una política sobre `profiles` provoca recursión
infinita en RLS. Se usa `app_private.is_admin()` como `SECURITY DEFINER STABLE` con
`search_path` fijo, invocada desde las políticas.

Se declara en PL/pgSQL y no en SQL puro por una razón concreta: un cuerpo SQL se
valida al crear la función, y `public.profiles` todavía no existe en la primera
migración, donde las políticas de las tablas de referencia ya la necesitan.

### 3.5 Columnas protegidas: privilegios de columna, no triggers correctores

RLS decide a qué **filas** se accede. Para restringir qué **columnas** puede escribir
un usuario final se usan privilegios de columna, el mecanismo nativo de PostgreSQL:

```sql
revoke update on public.worker_profiles from authenticated;
grant update (headline, base_hourly_rate, availability_note,
              accepts_overnight, is_accepting_jobs)
  on public.worker_profiles to authenticated;
```

Así nadie se autoverifica, se sube el nivel ni se edita su propia reputación.

La alternativa habitual (un trigger `BEFORE UPDATE` que reponga las columnas
sensibles) se probó y se descartó: también revierte las escrituras legítimas del
propio sistema. En las pruebas, ese trigger anulaba el recálculo de reputación
disparado al insertar una reseña, y la calificación quedaba en cero.

Consecuencia deliberada: las escrituras administrativas (verificar identidad,
suspender una cuenta, aprobar un payout) no se hacen desde el navegador. Van por
código de servidor con la clave de servicio, que es además la postura correcta.

### 3.6 Geografía: tablas de referencia, no texto libre ni enum

`regions` y `communes` son tablas con códigos oficiales chilenos y un `country_code`.
Un enum de 346 comunas sería inmodificable sin migración; texto libre rompe el filtrado
y las futuras páginas SEO regionales.

PostGIS **no** se activa en la Etapa 1. Se guardan `lat`/`lng` como `numeric(10,7)`.
Migrar después es aditivo: agregar una columna `geography` generada más un índice GIST.
No es deuda, es una decisión de secuencia.

La lista de comunas vive en un único archivo (`src/lib/geo/chile.ts`) del que se
genera la semilla SQL con `npm run seed:geo`. Ese archivo no importa nada del resto
de la aplicación justamente para poder ejecutarse desde un script de Node. Así la
interfaz y la base nunca ofrecen listas distintas.

### 3.7 Precios: motor reemplazable detrás de una interfaz

`PricingEngine.suggest(input): PriceSuggestion` es la única superficie que conoce la UI.
La v1 (`RuleBasedPricingEngine`) aplica multiplicadores declarativos desde
`src/config/pricing.ts`. Cambiar a un modelo de demanda no altera firmas ni tablas.

La plataforma **sugiere**; el precio final lo fija cada trabajador en su oferta.

### 3.8 Pagos: `PaymentProvider` con implementación Transbank aislada

`TransbankPaymentProvider` existe como clase con la forma correcta del flujo
(crear transacción → redirección → confirmación → consulta de estado →
reversa/reembolso), pero **no** inventa endpoints ni SDK. Los métodos lanzan
`PaymentProviderNotConfiguredError` hasta que se integre el SDK oficial vigente
en ambiente de integración.

En desarrollo hay dos proveedores simulados, ambos prohibidos en producción:
`MockPaymentProvider` (`mock`) aprueba en el acto, y `DelayedMockPaymentProvider`
(`mock-delayed`) crea el pago y **no responde hasta que alguien decide** con
`settle()`. El segundo existe porque el primero no podía reproducir la carrera
entre una confirmación tardía y una cancelación; ver `docs/PAGOS.md` §6.

Sea cual sea el proveedor, su respuesta llega a la base por una sola vía:
`applyProviderResult` → `confirm_payment_result`, que la registra una sola vez
por identificador de evento y decide bajo bloqueo. Ver §8.

Nunca se almacenan datos de tarjeta. Ninguna credencial vive en el repositorio.

### 3.9 Pago Protegido, no "escrow"

El término "escrow" no aparece en la interfaz ni en textos de producto. El dinero entra a
la cuenta comercial de HagoTuFila y queda **asociado a un trabajo específico**
(`payments.job_id`). No existe billetera del cliente, no hay saldo retirable.

Internamente el campo se llama `protected_payment_state`.

### 3.10 Evidencia y auditoría: append-only

Una sola tabla (`job_evidence`) es la fuente de verdad de todo lo ocurrido durante un
trabajo. `checkins` y `job_updates` existen como **vistas** sobre ella, con
`security_invoker = true` para que apliquen las políticas del usuario que consulta.

Tres tablas con el mismo ciclo de vida obligarían a escribir en varias a la vez y a
mantenerlas sincronizadas. Una bitácora inmutable no puede quedar inconsistente, que
es justo lo que importa al resolver una disputa.


`job_evidence`, `payment_events`, `dispute_evidence`, `loyalty_transactions` y
`audit_logs` no tienen políticas de `UPDATE` ni `DELETE` para ningún rol de aplicación.
Corregir significa insertar un registro nuevo, no reescribir el anterior.

### 3.11 PIN de entrega: el trabajador nunca puede leerlo

El PIN vive en `handoff_codes`, con RLS que permite lectura únicamente al cliente.
El trabajador lo envía a una función del servidor que compara y registra el intento.
Así el PIN sigue siendo evidencia real de presencia simultánea.

### 3.12 Capa de datos con dos implementaciones

La Etapa 1 se construye sin una instancia de Supabase activa. En vez de rellenar la UI
con datos inventados dentro de los componentes, existe:

```
src/lib/data/repositories.ts   ← interfaces
src/lib/data/demo/*            ← datos de demostración realistas en CLP
src/lib/data/supabase/*        ← implementación real
src/lib/data/index.ts          ← selector por variables de entorno
```

Si faltan credenciales de Supabase, la app funciona en modo demo. Cuando existen, se usa
la implementación real. La UI no cambia ni una línea.

---

## 4. Estructura de carpetas

```
apps/web/
├── docs/                      Arquitectura, base de datos, hoja de ruta
├── supabase/migrations/       Esquema SQL versionado
├── public/
└── src/
    ├── app/                   App Router
    │   ├── (marketing)/       Home y páginas indexables
    │   ├── (auth)/            Entrar / crear cuenta
    │   ├── (app)/             Producto autenticado
    │   └── admin/             Panel interno
    ├── components/
    │   ├── ui/                Sistema de diseño
    │   ├── layout/            Header, footer, navegación móvil
    │   ├── home/              Secciones de la portada
    │   ├── jobs/              Tarjetas, filtros, wizard, timeline
    │   └── profile/           Índice de Confianza, niveles
    ├── config/                Constantes de producto y plataforma
    └── lib/
        ├── domain/            Tipos, enums, máquinas de estado (puro)
        ├── pricing/           Motor de precios sugeridos
        ├── reputation/        Índice de Confianza y niveles
        ├── payments/          PaymentProvider + Transbank + Mock
        ├── verification/      IdentityVerificationProvider
        ├── notifications/     Canales y despachador
        ├── geo/               Regiones y comunas de Chile
        ├── data/              Repositorios (demo | supabase)
        ├── supabase/          Clientes browser/server/admin
        └── utils/             Dinero, fechas, formato, cn
```

---

## 5. Máquinas de estado

Las transiciones válidas viven en `src/lib/domain/state-machines.ts` como mapas
explícitos. Ningún componente cambia un estado sin pasar por `canTransition()`.

- **Trabajo:** `DRAFT → PUBLISHED → OFFER_ACCEPTED → PAYMENT_PENDING → PAID →
  IN_PROGRESS → HANDOFF_COMPLETED → COMPLETED → CLOSED`, con ramas `CANCELLED`,
  `DISPUTED` y, desde `PAYMENT_PENDING`, `CANCELLATION_PENDING → CANCELLED`
  (el cliente pidió cancelar con un pago en vuelo; ver §8).
- **Pago:** `PENDING → CREATED → AUTHORIZED → PAID`, con `FAILED`, `REFUNDED`,
  `PARTIALLY_REFUNDED`, `UNDER_REVIEW`. `UNDER_REVIEW` + `captured_at` significa
  «dinero recibido que hay que devolver».
- **Payout:** `PENDING → APPROVED → PROCESSING → PAID`, con `HELD` y `CANCELLED`.
- **Verificación:** `UNVERIFIED → PENDING → VERIFIED | REJECTED`, más `SUSPENDED`.
- **Extensión:** `PENDING → ACCEPTED | REJECTED | EXPIRED | CANCELLED`.

Regla dura del producto: un trabajo no llega a `IN_PROGRESS` sin un `payment` en estado
`PAID`. Está codificado en la máquina de estados y reforzado por un `CHECK` en la base.

---

## 6. Etapa 2: decisiones nuevas

### 6.1 Modo demostración y modo Supabase, nunca mezclados

`resolveDataSource()` decide una vez y vale para toda la aplicación. El modo
demostración es de **solo lectura**: no hay sesión, las escrituras lanzan
`DemoModeError` y una banda superior lo dice en pantalla.

Se corrigió un caso en el que la portada importaba reseñas de demostración
directamente, con lo que en modo Supabase se habrían mostrado testimonios falsos
junto a datos reales. Ahora todo sale del mismo repositorio.

### 6.2 La dirección exacta no es pública

Mismo patrón que los datos personales: tabla aparte (`job_private_location`).

| Momento | Qué se ve |
|---|---|
| Antes de asignar | Comuna, región, nombre del lugar y un punto redondeado a ~1 km |
| Después de asignar | Dirección exacta, referencias de acceso y coordenadas precisas |

Sólo el cliente, el trabajador asignado y la administración acceden a la fila
privada. En el dominio la dirección vive en `location.exact`, que llega en `null`
cuando no corresponde: si no está, la interfaz no puede filtrarla por descuido.

El motivo es concreto. Un trabajo de fila de madrugada publicado con su
dirección exacta le dice a cualquiera dónde va a estar sola una persona a las
cinco de la mañana.

### 6.3 Verificación obligatoria para ofertar, no solo para ser asignado

Un trabajador necesita estar `VERIFIED` para **enviar ofertas**. Quien está
`PENDING` explora todo el catálogo y prepara su perfil, pero no oferta.

Se eligió así porque un cliente que compara ofertas de personas que quizá nunca
se verifiquen pierde el tiempo, y porque la regla ya estaba en RLS desde la
Etapa 1 y probada. La regla vive en un solo lugar del código
(`src/lib/domain/eligibility.ts`) y en dos de la base
(`app_private.worker_can_be_assigned` y la política de INSERT de `job_offers`).

### 6.4 Aceptar una oferta es atómico, y se probó con concurrencia

`accept_job_offer` bloquea la fila del trabajo con `FOR UPDATE` y valida cliente,
estado, elegibilidad y unicidad antes de crear la asignación. Encima hay dos
defensas más: `assignments.job_id` es `UNIQUE` y existe un índice único parcial
que admite una sola oferta `ACCEPTED` por trabajo.

La prueba no se limita a llamarla dos veces seguidas: `supabase/tests/03_race_accept.sh`
lanza dos aceptaciones **en paralelo** sobre el mismo trabajo y comprueba que
quede exactamente una asignación y una oferta aceptada.

### 6.5 El cliente no escribe sobre las ofertas

Defecto encontrado al escribir las pruebas de esta etapa: la Etapa 1 dejó una
política que permitía al dueño del trabajo actualizar cualquier fila de
`job_offers` de ese trabajo, incluido el precio propuesto por el trabajador.
La intención era que pudiera aceptarlas, pero el permiso es de fila completa.

Se eliminó esa política. Aceptar y rechazar pasan por la función atómica, y el
importe de una oferta quedó fuera de las columnas escribibles incluso para su
propio autor: para cambiar de precio se retira la oferta y se envía otra, que es
además lo transparente de cara al cliente.

### 6.6 La comisión vive en la base, no en el código

`platform_settings.commission_bps` es la fuente de verdad. La usan tanto la
aplicación (para mostrar el desglose) como la base (para calcular el payout).
Tenerla en dos sitios garantizaba que tarde o temprano divergieran.

`src/config/platform.ts` conserva los valores por defecto: son la semilla de esa
tabla y el respaldo del modo demostración. El valor inicial es 1400 puntos base,
es decir 14 %.

### 6.7 El pago simulado recorre el flujo real

No hay un botón que escriba `PAID` a mano. El botón crea el pago en la base,
pide una transacción al `PaymentProvider`, redirige y confirma en la ruta de
retorno `/pagos/retorno`. Con el proveedor simulado esa redirección vuelve a la
propia aplicación; cuando se integre Webpay Plus cambiará el proveedor y ni la
acción ni la ruta de retorno se tocan.

Los montos los calcula `start_protected_payment` en la base desde la asignación.
El navegador nunca envía el total a cobrar.

La ruta de retorno tampoco decide: le entrega la respuesta del proveedor a
`confirm_payment_result` y muestra lo que la base resolvió (§8).

### 6.8 Estados: se reutilizó el enum existente

No se creó un vocabulario paralelo. La equivalencia con los nombres de producto:

| Producto | Enum |
|---|---|
| OPEN | `PUBLISHED` |
| ASSIGNED | `OFFER_ACCEPTED` |
| READY | `PAID` |

Las transiciones válidas siguen en `src/lib/domain/state-machines.ts`, y qué
puede hacer cada parte en `src/lib/domain/job-actions.ts`. Una transición
inválida falla también en la base: un trigger impide avanzar sin pago confirmado
y otro congela los campos críticos del trabajo una vez asignado.

### 6.9 Rutas privadas nunca prerenderizadas

Los grupos `(app)` y `admin` declaran `dynamic = "force-dynamic"`. Una página de
sesión servida desde caché mostraría los datos de otra persona.

`getSession` está envuelta en `cache()` de React para que la cabecera y la página
no pidan la sesión dos veces en la misma petición.

## 7. Etapa 3: preparación para Supabase alojado

### 7.1 Autorización con `getClaims()`, no con `getUser()` ni `getSession()`

Tres formas de saber quién pregunta, y solo una es la adecuada hoy:

| Método | Qué hace | Sirve para autorizar |
|---|---|---|
| `getSession()` | Lee la cookie sin revalidarla | **No.** La cookie se puede fabricar |
| `getUser()` | Pregunta al servidor de Auth en cada llamada | Sí, pero con un viaje de red cada vez |
| `getClaims()` | Verifica la firma del token | Sí, y con claves asimétricas sin red |

Se pasó a `getClaims()`, que es lo que recomienda la documentación vigente. Con
claves asimétricas verifica la firma localmente contra el JWKS cacheado; con
claves simétricas consulta al servidor igual que `getUser()`. En ambos casos el
identificador sale de un token verificado y nunca de un parámetro del navegador.

El ayudante propio pasó a llamarse `getViewer()`. Antes se llamaba `getSession()`
y, aunque por dentro hacía lo correcto, un nombre idéntico al del método inseguro
de Supabase es una trampa esperando a que alguien cambie uno por otro.

La autorización real sigue siendo RLS. Esto solo decide qué página se pinta.

### 7.2 Claves nuevas de Supabase, con las heredadas como respaldo

Supabase reemplazó `anon` y `service_role` por `publishable` y `secret`, y retira
las antiguas a fines de 2026. La aplicación acepta las dos parejas y prefiere las
nuevas:

```
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  →  NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SECRET_KEY                   →  SUPABASE_SERVICE_ROLE_KEY
```

La clave privada se lee solo desde `src/lib/supabase/admin.ts`, marcado con
`server-only`: si alguien la importara desde un componente de cliente, el build
falla en vez de publicar la credencial.

En el navegador las variables se leen como literales `process.env.NEXT_PUBLIC_…`
y no a través de una función: Next solo sustituye la forma escrita, y un acceso
dinámico llegaría como `undefined`.

### 7.3 Migraciones repetibles donde el entorno lo exige

Dos sentencias fallaban si el objeto ya existía en el proyecto de destino:

- `alter publication supabase_realtime add table …`. Un proyecto Supabase trae la
  publicación creada y puede traer tablas dentro. Ahora pasa por
  `app_private.publish_realtime()`, que comprueba antes de agregar.
- Las políticas de Storage. Ahora se hace `drop policy if exists` antes de
  crearlas.

El resto de las migraciones no es idempotente a propósito: la CLI de Supabase
lleva su propio registro de cuáles aplicó, y una migración que se pueda reaplicar
sin querer esconde errores en vez de mostrarlos.

### 7.4 Storage: el nombre del archivo nunca lo decide quien sube

La foto de perfil se guarda en `avatars/<userId>/<uuid>.<ext>`:

- La extensión sale del tipo MIME declarado, no del nombre original. Un archivo
  llamado `foto.jpg.html` no puede servirse como HTML.
- El identificador es aleatorio, así que reemplazar la foto no deja la anterior
  servida desde la caché del CDN.
- La primera carpeta es el identificador del usuario, que es justo lo que exige
  la política del bucket. Manipular la ruta desde el navegador no sirve: Storage
  la rechaza.

La subida va directo del navegador a Storage con la sesión del usuario. El
servidor solo guarda la URL, y antes comprueba que la ruta sea suya.

### 7.5 Indicador de origen de datos, solo en desarrollo

Una banda arriba de la página dice **Supabase conectado** (verde, con el nombre
del proyecto) o **Modo demo** (naranja). En producción no se pinta nunca.

Existe por una razón concreta: una prueba de aceptación hecha sin darse cuenta
contra datos de ejemplo no vale, y es un error fácil de cometer.

### 7.6 Aplicar migraciones donde solo sale HTTPS

`supabase db push` abre una conexión PostgreSQL directa al puerto 5432 del
proyecto, o al 6543 del pooler. Eso es lo correcto y es la vía normal. Pero hay
entornos donde ese puerto está cerrado y solo sale tráfico HTTPS: contenedores
de integración continua, redes corporativas, el entorno remoto de un agente. Ahí
`db push` no falla con un mensaje útil: espera hasta agotar el tiempo.

`scripts/push-migrations-hosted.ts` (`npm run db:push:hosted`) cubre ese caso.
Envía el contenido de cada archivo de `supabase/migrations/` tal cual, en el
mismo orden, a la Management API sobre HTTPS, y registra cada versión en
`supabase_migrations.schema_migrations` con el mismo formato que el CLI, de modo
que un `supabase db push` posterior desde otra máquina las vea aplicadas y no las
repita.

Tres decisiones deliberadas:

- **No reconstruye SQL.** Las migraciones del repositorio son el esquema oficial;
  el script es transporte, no una segunda fuente de verdad.
- **No ignora errores.** Si una migración falla, se detiene en ese archivo, no la
  registra y sale con código distinto de cero. La siguiente ejecución retoma
  desde ahí.
- **No sustituye al CLI.** Es la salida de emergencia, y la documentación dice
  cuándo usarla (`docs/DESPLIEGUE-SUPABASE.md` §3.b).

No cubre `--include-seed`: la semilla se aplica aparte.

### 7.7 Una variable vacía es una variable ausente

`.env.example` pide dejar en blanco lo que todavía no se tiene:
`SUPABASE_SECRET_KEY=`, las cuentas de prueba, las credenciales de Transbank. Al
conectar el proyecto real esa instrucción resultó ser una trampa: Next carga una
línea `X=` como la cadena vacía, no como ausente, y el esquema de zod la rechazaba
contra `min(1)`. Resultado: la aplicación devolvía 500 en todas las páginas por
seguir su propia plantilla.

`src/lib/env.ts` normaliza ahora cada valor antes de validarlo: vacío o solo
espacios equivale a no definido. La validación sigue siendo ruidosa cuando el
valor está presente y es inválido, que es cuando de verdad conviene fallar.

### 7.8 La semilla de referencia no es una migración

`db:seed:hosted` aplica `supabase/seed/001_geo.sql` al proyecto alojado, y **no**
lo anota en `supabase_migrations.schema_migrations`. La distinción no es
cosmética: las migraciones describen el esquema y el CLI decide por ese historial
qué falta aplicar. Anotar allí una semilla haría que `supabase db push` creyera
aplicada una migración que no existe como archivo, y la siguiente migración real
con ese mismo sello quedaría fuera en silencio.

La separación también permite tratarlas con reglas distintas, que es lo que de
verdad importa: una migración se aplica en todos los entornos, incluida
producción; esta semilla se niega a correr con `NODE_ENV=production` y exige que
quien la ejecute escriba el ref del proyecto de destino.

El script analiza el SQL antes de enviarlo y se niega si toca algo que no sean
`countries`, `regions` y `communes`, si menciona `auth.` o `storage.`, si parece
traer contraseñas o credenciales, o si algún `insert` no lleva `on conflict`. Es
deliberado que sea una comprobación de la máquina: el archivo está generado desde
`src/lib/geo/chile.ts` y podría cambiar sin que nadie vuelva a leerlo entero.

## 8. Etapa 2.5: cancelar con un pago en vuelo, sin carreras

La auditoría de las RPC dejó un hallazgo abierto: `cancel_job` cancelaba un
trabajo en `PAYMENT_PENDING` sin mirar el pago, y si el proveedor confirmaba
después, el disparador de payout —que no comprobaba nada— pagaba al trabajador
por un trabajo cancelado. No es un defecto del proveedor: es una carrera del
dominio, y se resolvió en el dominio. `docs/PAGOS.md` es la guía completa; aquí
van las decisiones.

### 8.1 Un estado explícito para «cancelar con dinero en vuelo»

`CANCELLATION_PENDING` es un valor nuevo de `job_status`. Ni `PAYMENT_PENDING`
ni `CANCELLED` decían la verdad mientras el proveedor no respondía: el primero
oculta que el cliente ya pidió cancelar, el segundo promete que no hay dinero
cobrado. Un trabajo en ese estado solo puede ir a `CANCELLED`, la interfaz no
ofrece pagar ni avanzar, y el cliente lee «Estamos verificando el estado del
pago antes de completar la cancelación».

«Devolución pendiente» **no** es un enum nuevo: es `payments.status = UNDER_REVIEW`
con `captured_at` y `review_reason`. `REFUNDED` ya existe para cuando la
devolución ocurra de verdad; hasta integrar Transbank no se afirma que exista.

### 8.2 La decisión se toma en la base, bajo tres bloqueos en un orden fijo

Todo lo que decide sobre dinero bloquea `jobs → assignments → payments`, en ese
orden, en una transacción. `start_protected_payment` bloqueaba al revés y se
corrigió: un orden único es lo que impide el interbloqueo entre una cancelación
y una confirmación simultáneas.

Un disparador BEFORE UPDATE sobre `payments` decide, antes de que `PAID` llegue
a escribirse, si el pago habilita el trabajo o queda en revisión. Así vale para
cualquier vía —la RPC, un script, un `UPDATE` con la clave de servicio— y no
depende de que el código de la aplicación se acuerde de comprobar. El payout se
crea después de esa decisión, nunca antes.

### 8.3 Idempotencia por identificador de evento, no por transacción

`confirm_payment_result` es la única entrada de resultados del proveedor y solo
la ejecuta la clave de servicio. Registra cada evento una vez por
`(provider, provider_event_id)` con un índice único; la segunda llegada del
mismo evento —en secuencia o a la vez— devuelve `duplicate` sin tocar nada.
`provider_transaction_id` no servía: una misma transacción puede producir
varios eventos legítimos (autorización, confirmación, reversa).

### 8.4 Los estados terminales lo son también para el sistema

`guard_assignment_transitions` dejaba pasar al rol de servicio y a la
administración; para ordenar los pasos está bien, para revivir una asignación
cancelada no. Ahora los terminales se comprueban antes de ese permiso, un
disparador equivalente protege `jobs`, y `payouts_guard` rechaza cualquier
payout sin pago `PAID`, sobre asignación cancelada o sobre trabajo cancelado.
`authenticated` perdió `UPDATE`, `DELETE` y `TRUNCATE` sobre las tres tablas de
dinero: el append-only de `payment_events` ya no descansa solo en RLS.

### 8.5 Las carreras se prueban con carreras, sin `sleep`

En SQL, dos sesiones `psql` reales lanzadas a la vez, repetidas; serializan los
bloqueos de fila. En Node, `DelayedMockPaymentProvider` es una barrera: las
confirmaciones esperan una promesa y `settle()` las libera en el mismo tick, así
que dos peticiones llegan a PostgREST simultáneas y deterministas. Las dos
baterías comprueban los mismos escenarios y terminan ejecutando
`payment_invariant_violations()`, que debe devolver cero filas. Un `sleep`
habría hecho la prueba lenta y, peor, verde por casualidad.

---

## 9. Bloque 3: ejecutar el trabajo, no solo contratarlo

Hasta aquí el recorrido terminaba en «pago confirmado». Las tablas de lo que
viene después —evidencia, extensiones, PIN de entrega, disputas, payouts—
estaban creadas desde la Etapa 1, pero nadie las escribía. `docs/EJECUCION.md`
es la guía completa; aquí van las decisiones.

### 9.1 Ningún estado nuevo: el vocabulario ya existía

`ON_THE_WAY`, `CHECKED_IN`, `IN_PROGRESS`, `HANDOFF_COMPLETED` y `COMPLETED`
estaban en los enums desde el principio. El modelo conceptual del producto
—READY, COMPLETION_PENDING, APPROVED— se mapea sobre ellos sin inventar un
vocabulario paralelo, igual que se hizo en §6.8 con OPEN y ASSIGNED. Lo único
nuevo son tres enumeraciones pequeñas para el check-in y la evidencia, que no
tenían equivalente.

### 9.2 Una matriz de permisos, no condiciones por pantalla

`src/lib/domain/permissions.ts` recibe los hechos del trabajo y devuelve qué
puede hacer quien mira. La interfaz pregunta ahí y nada más.

El motivo no es la elegancia: cuando cada pantalla encadena sus propias
condiciones, esas condiciones divergen, y aparecen las dos formas de error que
peor se ven —un botón que no hace nada y una acción válida escondida— sin que el
compilador diga una palabra. La base vuelve a comprobarlo todo, así que un botón
de más no abre nada; uno de menos deja a alguien sin poder trabajar.

### 9.3 El avance del trabajo dejó de ser un `UPDATE`

`authenticated` tenía concedido `UPDATE (status, checked_in_at, started_at)`
sobre `assignments`, y la aplicación escribía la hora con el reloj del navegador.
Con ese privilegio, el CLIENTE podía marcar «voy en camino» en nombre del
trabajador: la comprobación del rol vivía solo en TypeScript.

Ahora cada paso es una función que exige sesión, comprueba el papel de quien
llama y bloquea `jobs → assignments` en el orden canónico de la Etapa 2.5. El
privilegio de escritura directa se revocó, y con él los de `job_evidence`,
`job_extensions`, `handoff_codes`, `disputes` y `reviews`. También el `DELETE`
sobre todo `public`: ningún punto de la aplicación borra filas, y la única
barrera era que no hubiera política.

### 9.4 La ubicación del check-in no es parte de la línea de tiempo

La prueba de llegada le importa a las dos partes; la posición del teléfono de
una persona es dato suyo. Se separan: las coordenadas viven en
`assignment_check_ins`, que solo lee el propio trabajador y la administración, y
la línea de tiempo recibe el hecho y la distancia. Las columnas `lat`/`lng` que
`job_evidence` heredaba dejaron de ser legibles para nadie con sesión.

Que un check-in no se verifique no bloquea a nadie sin salida: se puede
reintentar, adjuntar evidencia y pedir revisión manual. Lo que no se hace nunca
es dar por buena una llegada que no se pudo comprobar.

### 9.5 Terminar y cobrar son dos acciones de dos personas

El botón del trabajador deja el trabajo esperando; la aprobación del cliente es
lo único que libera el pago. Sin esa separación, «terminé» y «me pagan» serían
la misma acción decidida por una sola parte.

### 9.6 La evidencia se valida por contenido, no por lo que dice el navegador

Los archivos se suben desde el servidor. Ahí se pueden mirar los primeros bytes
antes de guardar, y no solo el tipo declarado: un ejecutable renombrado a `.jpg`
declara `image/jpeg` en el formulario; su firma, no. SVG queda fuera a
propósito: es un documento que puede llevar script y se serviría desde el mismo
origen.

### 9.7 El cobro del tiempo adicional tiene su propio camino

Un pago de extensión llega con el trabajo ya en curso, así que caía en la rama
de «confirmación tardía» de la Etapa 2.5 y terminaba marcado para devolución.
Se le dio su propia rama, con las mismas exigencias, y lo único que produce al
confirmarse es más dinero en el payout que ya existe: no habilita nada.

### 9.8 Las métricas del trabajador se calculan

Trabajos completados, minutos, cancelaciones, cumplimiento y puntualidad salen
de los hechos, no de un contador que alguien incrementa. Hasta ahora se quedaban
en cero para siempre. El Índice de Confianza se deriva de esas cifras en la
aplicación, donde ya vivía: replicarlo en SQL sería la tercera copia de la misma
regla.

---

## 10. Verificación del esquema

El esquema no se entrega "escrito y sin ejecutar". Se aplica y se prueba contra un
PostgreSQL real:

```bash
PGHOST=/tmp PGPORT=55432 PGUSER=postgres npm run db:test
```

El script levanta la base, aplica el stub de Supabase (auth, storage, roles,
realtime), las diez migraciones, la semilla geográfica y una batería de pruebas que
verifica, entre otras cosas:

- que un usuario no lea datos privados de otro cambiando un identificador;
- que un trabajador sin verificar no pueda ofertar;
- que un trabajador no pueda leer el PIN de entrega, pero sí validarlo;
- que abrir una disputa retenga el payout;
- que solo un participante de un trabajo completado pueda reseñar;
- que la bitácora de auditoría sea invisible para quien no es administrador.

Esta verificación encontró y corrigió cuatro defectos reales antes de entregar el
esquema: orden de creación de `is_admin`, una dependencia del esquema `extensions`
sin permisos, triggers de protección que bloqueaban al rol de servicio, y esos mismos
triggers anulando el recálculo de reputación.

La Etapa 2 sumó a la misma batería el recorrido completo cliente ↔ trabajador, la
prueba de concurrencia, las comprobaciones sobre la semilla de demostración y un
contraste entre el código y el esquema (`scripts/check-db-contract.sh`) que verifica
que cada tabla, vista, función y columna que usa la aplicación exista de verdad.
Ese contraste encontró el defecto descrito en §6.5.

### 10.1 Niveles de verificación, con propósitos distintos

| Comando | Contra qué | Qué cubre |
|---|---|---|
| `npm run db:test` | PostgreSQL local | Esquema, RLS, flujo, concurrencia, semillas, inventario, endurecimiento de las RPC, política de cancelación y pago, ejecución completa del trabajo e integración con Webpay. Todo con carreras reales. 225 comprobaciones |
| `npm run db:push:hosted -- --plan` | Supabase real | Qué migraciones faltan por aplicar, sin escribir nada |
| `npm run verify:schema:hosted` | Supabase real | Inventario, RLS, `security_invoker`, grants, Realtime y advisors. 18 comprobaciones |
| `npm run verify:supabase` | Supabase real | El mismo recorrido por API, más Realtime, Storage y Auth, y las escrituras directas que deben fallar. 62 comprobaciones |
| `npm run verify:payments` | Supabase real | Cancelación contra confirmación tardía, duplicada y simultánea, con el proveedor retardado y las piezas de la aplicación. 23 comprobaciones |
| `npm run verify:execution` | Supabase real | Ejecución del trabajo con sesiones reales: papeles, privacidad de la ubicación, extensiones, PIN, disputas, transferencia y carreras. 24 comprobaciones |
| `npm run verify:pwa` | Estático | Manifiesto, iconos, service worker, metadatos y tokens de diseño. 30 comprobaciones |
| `npm run verify:transbank` | Webpay Integration | Configuración, guardas de producción, identificadores, criterio de aprobación e ida y vuelta real contra Transbank. 31 comprobaciones |
| `npm run e2e` | Supabase real, por navegador | Entrar, publicar, ofertar, aceptar, pagar y ejecutar el trabajo hasta la aprobación. 51 pruebas |

Todos se mantienen. El local es rápido y corre siempre, incluso sin
credenciales; el de integración prueba lo que solo existe en Supabase (Auth,
Realtime, Storage); el de navegador prueba que la interfaz conecta bien las dos
cosas. Ninguno reemplaza a los otros.

El inventario del esquema (`05_schema_inventory.sql`) comprueba además que las
33 tablas tengan RLS activo y que las 6 vistas usen `security_invoker`. Es la
comprobación que impide que una tabla nueva quede abierta por olvido.

## 11. Qué queda fuera todavía

Ver `docs/HOJA-DE-RUTA.md`.
