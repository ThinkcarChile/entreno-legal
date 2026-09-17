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
| `npm run check` | Lint + typecheck + build |
| `npm run seed:geo` | Regenera la semilla de regiones y comunas |
| `npm run db:test` | Aplica el esquema a un PostgreSQL y corre todas las pruebas |
| `npm run db:contract` | Comprueba que el código y el esquema coincidan |
| `npm run verify:supabase` | Recorre el marketplace completo contra un Supabase real |
| `npm run db:push:hosted` | Aplica las migraciones a un proyecto alojado por HTTPS, cuando el puerto 5432 está cerrado |
| `npm run db:seed:hosted` | Aplica la semilla geográfica oficial a un proyecto alojado de desarrollo, por HTTPS |
| `npm run verify:schema:hosted` | Inventario del esquema alojado y advisors de seguridad y rendimiento |
| `npm run e2e` | Recorrido por navegador con Playwright |

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
| `PAYMENT_PROVIDER` | No | `mock` o `transbank`. `mock` está prohibido en producción |
| `TRANSBANK_ENVIRONMENT` | No | `integration` o `production` |
| `TRANSBANK_COMMERCE_CODE` | Al integrar | Credencial de Transbank |
| `TRANSBANK_API_KEY` | Al integrar | Credencial de Transbank |
| `PLATFORM_COMMISSION_BPS` | No | Comisión por defecto en puntos base. `1400` = 14%. En modo Supabase manda `platform_settings` |
| `DISPUTE_WINDOW_HOURS` | No | Plazo para reportar un problema. Por defecto 12 |

`SUPABASE_SERVICE_ROLE_KEY` nunca debe llevar el prefijo `NEXT_PUBLIC_`.

---

## Poner en marcha Supabase

Guía completa, con la configuración del panel que no cabe en una migración:
[`docs/DESPLIEGUE-SUPABASE.md`](docs/DESPLIEGUE-SUPABASE.md).

Resumen:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push --include-seed      # esquema + 16 regiones y 346 comunas

npx supabase gen types typescript --linked --schema public \
  > src/lib/supabase/database.types.ts
```

Si tu red no deja salir al puerto 5432 y `db push` se queda colgado, hay una vía
por HTTPS con las mismas migraciones (necesita `SUPABASE_ACCESS_TOKEN`):

```bash
npm run db:push:hosted -- --plan                       # qué se aplicaría
npm run db:push:hosted                                 # aplicar
npm run db:seed:hosted -- --project-ref <project-ref>  # 16 regiones, 346 comunas
npm run verify:schema:hosted                           # inventario + advisors
```

El token `sbp_…` que usan estos tres da acceso a **todos** los proyectos de la
cuenta: es para desarrollo, vive solo en `.env.local` y se revoca desde el panel
si se filtra. Ni `--include-seed` ni las semillas de demostración deben tocar
producción: crean cuentas con contraseña conocida.

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
- [`docs/DESPLIEGUE-SUPABASE.md`](docs/DESPLIEGUE-SUPABASE.md) — poner el proyecto en marcha
- [`docs/HOJA-DE-RUTA.md`](docs/HOJA-DE-RUTA.md) — qué falta, por etapas

---

## Estado

Etapa 2 completada: el marketplace funciona de extremo a extremo sobre Supabase.
Un cliente publica, recibe ofertas, conversa, acepta y paga; un trabajador se
registra, se verifica, explora, oferta, conversa y recibe el trabajo asignado.

Lo que **todavía es simulado**:

| Función | Estado |
|---|---|
| Pago con Webpay Plus | Simulado. El flujo es el definitivo, cambia solo el `PaymentProvider` |
| Verificación de identidad | Real pero manual. La resuelve una persona desde `/admin/verificaciones`, sin proveedor biométrico |
| Transferencia al trabajador | El payout se calcula y registra; la transferencia es manual |
| Imágenes | Los buckets y columnas existen; la carga no está implementada |
| Notificaciones | Solo dentro de la aplicación. Sin push, email ni SMS |

El proyecto Supabase de desarrollo ya existe (`hagotufila-dev`, ref
`xwgobslgldxzatjrcxhl`) y la aplicación está conectada a él: con la URL y la
clave pública en `.env.local`, el indicador de desarrollo pasa a
«Supabase conectado · xwgobslgldxzatjrcxhl.supabase.co».

Lo que **todavía no se ha ejecutado** es aplicar el esquema a ese proyecto, y con
ello `npm run verify:supabase` y las pruebas E2E del marketplace. Falta una
credencial que el repositorio no tiene ni debe tener: un token de acceso personal
o la contraseña de la base para las migraciones, y `SUPABASE_SECRET_KEY` para las
cuentas de prueba. Mientras tanto el proyecto responde `PGRST205` a cada consulta,
porque está vacío. Ver `docs/DESPLIEGUE-SUPABASE.md` §3.

Ver `docs/HOJA-DE-RUTA.md` para el detalle y los riesgos pendientes.
