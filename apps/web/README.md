# HagoTuFila.cl

**Tu tiempo vale más que una fila.**

Marketplace chileno que conecta a quien necesita delegar una tarea presencial con
personas verificadas dispuestas a realizarla. Disponible en todo Chile, con una
arquitectura preparada para expandirse a otros países.

---

## Ejecutar en local

```bash
cd apps/web
npm install
cp .env.example .env.local
npm run dev
```

Abre <http://localhost:3000>.

**Sin credenciales de Supabase la aplicación funciona igual**, en modo demostración,
con datos realistas en pesos chilenos. Es la forma más rápida de revisar la interfaz.

### Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Compilación de producción |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript sin emitir |
| `npm run check` | Lint + typecheck + pruebas unitarias + build |
| `npm run seed:geo` | Regenera la semilla de regiones y comunas |
| `npm run db:test` | Aplica el esquema a un PostgreSQL y corre todas las pruebas |
| `npm run db:contract` | Comprueba que el código y el esquema coincidan |
| `npm run verify:supabase` | Recorre el marketplace completo contra un Supabase real |
| `npm run verify:payments` | Cancelación contra confirmación tardía, duplicada y simultánea, contra un Supabase real y con el proveedor retardado |
| `npm run verify:execution` | Ejecución completa del trabajo contra un Supabase real, con sesiones de cliente, trabajador, tercero y administración |
| `npm run db:push:hosted` | Aplica las migraciones a un proyecto alojado por HTTPS, cuando el puerto 5432 está cerrado |
| `npm run db:seed:hosted` | Reaplica la semilla geográfica en un proyecto alojado de desarrollo, por HTTPS. Desde `20260601001900` las regiones y comunas ya llegan con las migraciones |
| `npm run verify:schema:hosted` | Inventario del esquema alojado y advisors de seguridad y rendimiento |
| `npm run verify:transbank` | Webpay Plus: SDK, guardas, identificadores, retornos, secretos y ambiente de integración |
| `npm run test:unit` | Pruebas unitarias del dominio financiero (Vitest) |
| `npm run verify:pwa` | Manifiesto, iconos, service worker, tokens y contrastes. Sin servidor ni Supabase |
| `npm run evidence:webpay` | Evidencia de una prueba contra Webpay Integration: las doce comprobaciones, sin secretos |
| `npm run brand:logo` | Rehace el logotipo de 130 × 59 px para la validación de Transbank |
| `npm run brand:apple-icon` | Rehace `src/app/apple-icon.png` (180 × 180, el icono de iOS) desde `brand/apple-icon.svg` |
| `npm run e2e` | Recorrido por navegador con Playwright, más la revisión responsive, de consola y de accesibilidad |

---

## Variables de entorno

Todas en `.env.example`. Ninguna credencial real vive en el repositorio.

| Variable | Obligatoria | Para qué |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Recomendada | Metadata, OpenGraph, sitemap, robots |
| `NEXT_PUBLIC_SUPABASE_URL` | Para datos reales | Proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Para datos reales | Clave pública, sujeta a RLS. Reemplaza a `ANON_KEY` |
| `SUPABASE_SECRET_KEY` | Solo servidor | Omite RLS. Reemplaza a `SERVICE_ROLE_KEY`. Nunca con prefijo `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_DATA_SOURCE` | No | `demo`, `supabase` o `auto` (por defecto) |
| `PAYMENT_PROVIDER` | No | `mock`, `mock-delayed` o `transbank`. Los dos simulados están prohibidos en producción |
| `TRANSBANK_ENVIRONMENT` | Con `NODE_ENV=production` y `PAYMENT_PROVIDER=transbank` | `integration` (por defecto fuera de producción) o `production`. En producción hay que escribirla: si falta, Webpay no opera; `integration` junto con `TRANSBANK_PRODUCTION_ENABLED=true` se contradice y tampoco opera. En `.env.example` va comentada. En integración no se cargan credenciales: las trae el SDK |
| `TRANSBANK_PRODUCTION_ENABLED` | Solo para cobrar de verdad | `true` habilita Webpay productivo. Sin ella, el proveedor productivo se niega a crear cobros |
| `TRANSBANK_PRODUCTION_COMMERCE_CODE` | Solo producción | Código de comercio que entrega Transbank al certificar. Solo servidor |
| `TRANSBANK_PRODUCTION_API_KEY_SECRET` | Solo producción | Llave secreta que entrega Transbank al certificar. Solo servidor |
| `CRON_SECRET` | En producción | Autoriza `/api/cron/conciliar-pagos`, que un programador externo llama cada 10 minutos (`docs/TRANSBANK.md` §7). Al menos 32 caracteres (`openssl rand -hex 32`): con menos, esa ruta responde 503 «CRON_SECRET inválido» y lo deja en el registro; el resto de la aplicación sigue funcionando |
| `PLATFORM_COMMISSION_BPS` | No | Comisión por defecto en puntos base. `1400` = 14%. En modo Supabase manda `platform_settings` |
| `DISPUTE_WINDOW_HOURS` | No | Plazo para reportar un problema. Por defecto 12. En modo Supabase manda `platform_settings`, también en las páginas públicas |

`SUPABASE_SERVICE_ROLE_KEY` nunca debe llevar el prefijo `NEXT_PUBLIC_`.

Las credenciales productivas de Transbank y `CRON_SECRET` se cargan **solo** en
las variables de entorno del hosting. Nunca en el repositorio, en
`.env.example`, en un registro ni en una conversación. Los nombres
`TRANSBANK_COMMERCE_CODE` y `TRANSBANK_API_KEY` no existen: el código no los lee.

`.env.example` es la plantilla de `.env.local` en desarrollo, **no** la base de
las variables del hosting de producción: esas se escriben una por una, con la
lista de `docs/TRANSBANK.md` §9.

---

## Poner en marcha Supabase

**Todos los pasos a mano, en orden** —primero el proyecto de desarrollo,
después producción—, cada uno con la sección que lo explica:
[`docs/PUESTA-EN-MARCHA.md`](docs/PUESTA-EN-MARCHA.md).

Guía completa, con la configuración del panel que no cabe en una migración:
[`docs/DESPLIEGUE-SUPABASE.md`](docs/DESPLIEGUE-SUPABASE.md).

Resumen:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push                     # esquema, con las 16 regiones y 346 comunas

npx supabase gen types typescript --linked --schema public \
  > src/lib/supabase/database.types.ts
```

Si tu red no deja salir al puerto 5432 y `db push` se queda colgado, hay una vía
por HTTPS con las mismas migraciones (necesita `SUPABASE_ACCESS_TOKEN`):

```bash
npm run db:push:hosted -- --plan                       # qué se aplicaría
npm run db:push:hosted                                 # aplicar
npm run verify:schema:hosted                           # inventario + advisors
```

El token `sbp_…` que usan estos scripts da acceso a **todos** los proyectos de
la cuenta: es para desarrollo, vive solo en `.env.local` y se revoca desde el
panel si se filtra.

Las regiones y comunas son datos de referencia, no de demostración, y hacen
falta en **todos** los entornos, producción incluida: sin ellas nadie termina el
registro ni publica un trabajo. Llegan con la migración
`20260601001900_geo_reference_data.sql`, así que cualquier `db push` o
`db:push:hosted` las deja. `supabase/seed/001_geo.sql` —lo único que aplica
`--include-seed` (ver `supabase/config.toml`), sin cuentas— trae las mismas
filas y reaplicarlo no cambia nada. Lo que **nunca** debe tocar producción son
las semillas de demostración, `002_demo_accounts.sql` y `003_demo_content.sql`:
crean cuentas con contraseña conocida.

Semillas de demostración, **solo en entornos de prueba** (crean cuentas con
contraseña conocida):

```bash
psql "$DATABASE_URL" -f supabase/seed/002_demo_accounts.sql
psql "$DATABASE_URL" -f supabase/seed/003_demo_content.sql
```

Las cuentas de demostración usan la contraseña `hagotufila2026`. La cuenta
`admin@demo.cl` entra al panel interno y resuelve verificaciones.

Para que un trabajador pueda ofertar necesita estar verificado: entra como
administración, abre `/admin/verificaciones` y aprueba la solicitud.

En desarrollo, una banda arriba de la página indica si estás sobre **Supabase
conectado** o en **Modo demo**. En producción no se muestra.

## Base de datos

El esquema se verifica contra un PostgreSQL real, no solo se escribe:

```bash
PGHOST=/tmp PGPORT=55432 PGUSER=postgres npm run db:test
```

Detalle en [`docs/BASE-DE-DATOS.md`](docs/BASE-DE-DATOS.md).

---

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — capas, decisiones y deuda evitada
- [`docs/BASE-DE-DATOS.md`](docs/BASE-DE-DATOS.md) — esquema, RLS, funciones, Storage
- [`docs/PUESTA-EN-MARCHA.md`](docs/PUESTA-EN-MARCHA.md) — la lista ordenada de pasos a mano, de desarrollo a producción
- [`docs/DESPLIEGUE-SUPABASE.md`](docs/DESPLIEGUE-SUPABASE.md) — poner el proyecto en marcha
- [`docs/TRANSBANK.md`](docs/TRANSBANK.md) — Webpay Plus: integración, conciliación, devoluciones y producción
- [`docs/PRUEBAS-WEBPAY.md`](docs/PRUEBAS-WEBPAY.md) — las diecisiete pruebas contra el ambiente de integración, paso a paso
- [`docs/DISENO.md`](docs/DISENO.md) — identidad, tokens, componentes, responsive y PWA
- [`docs/EJECUCION.md`](docs/EJECUCION.md) — del pago confirmado a la aprobación
- [`docs/PAGOS.md`](docs/PAGOS.md) — el dinero hasta la confirmación, y la cancelación
- [`docs/HOJA-DE-RUTA.md`](docs/HOJA-DE-RUTA.md) — qué falta, por etapas

---

## Estado

Etapa 2 completada: el marketplace funciona de extremo a extremo sobre Supabase.
Un cliente publica, recibe ofertas, conversa, acepta y paga; un trabajador se
registra, se verifica, explora, oferta, conversa y recibe el trabajo asignado.

Lo que **todavía es simulado**:

| Función | Estado |
|---|---|
| Pasarela de pago | **Webpay Plus integrado con el SDK oficial, en ambiente de integración.** Producción está desactivada y necesita `TRANSBANK_PRODUCTION_ENABLED=true` más credenciales (`docs/TRANSBANK.md` §9). `MockPaymentProvider` se conserva para desarrollo. Las devoluciones están implementadas contra el proveedor; ninguna se ha ejecutado en producción |
| Verificación de identidad | Real pero manual. La resuelve una persona desde `/admin/verificaciones`, sin proveedor biométrico |
| Transferencia al trabajador | El payout se calcula, se aprueba y se registra con su referencia bancaria; la transferencia se hace fuera de la plataforma |
| Imágenes | La evidencia del trabajo y de las disputas sube de verdad, validada por contenido; faltan las del trabajo publicado y las del chat |
| Notificaciones | Solo dentro de la aplicación. Sin push, email ni SMS |
| Identidad visual | Provisional y dibujada en código. No está registrada ni es definitiva (`docs/DISENO.md` §1) |

El proyecto Supabase de desarrollo ya existe (`hagotufila-dev`, ref
`xwgobslgldxzatjrcxhl`), **el esquema está aplicado** y la aplicación está
conectada: el indicador de desarrollo muestra
«Supabase conectado · xwgobslgldxzatjrcxhl.supabase.co».

El 2026-10-02 se le aplicaron las 79 migraciones del repositorio (tenía 33), y
contra él pasaron, sin omisiones: `npm run verify:supabase` (63),
`verify:payments` (23), `verify:execution` (24), las 51 pruebas de `npm run e2e`
y `verify:schema:hosted` salvo las plantillas de correo (abajo). La primera
pasada de pg_cron corrió bien y los invariantes quedaron en cero. Estado paso a
paso en [`docs/PUESTA-EN-MARCHA.md`](docs/PUESTA-EN-MARCHA.md) §A.

Del proyecto alojado quedan pasos que no caben en una migración. El mínimo de 8
caracteres de Auth (§4.1.b) ya está en `hagotufila-dev`; falta en producción.
Las plantillas de correo con `token_hash` (§4.1.c) **no se pueden cambiar** en
un proyecto Free con el correo por omisión de Supabase: necesitan SMTP propio o
un plan de pago, y `verify:schema:hosted` las marca en rojo mientras tanto. La
protección contra contraseñas filtradas, que Supabase solo ofrece desde el plan
Pro: hay que activarla en producción, y `verify:schema:hosted -- --produccion`
falla mientras no lo esté. Y los límites de Supabase Auth y el CAPTCHA del
registro y el ingreso, que **no están configurados**: el CAPTCHA además
necesita que los formularios envíen el token antes de activarlo. Ver
`docs/DESPLIEGUE-SUPABASE.md` §4.1.b, §4.1.c y §4.6.

Ver `docs/HOJA-DE-RUTA.md` para el detalle y los riesgos pendientes.
