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
| `npm run db:test` | Aplica el esquema a un PostgreSQL y corre las pruebas de RLS |

---

## Variables de entorno

Todas en `.env.example`. Ninguna credencial real vive en el repositorio.

| Variable | Obligatoria | Para qué |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Recomendada | Metadata, OpenGraph, sitemap, robots |
| `NEXT_PUBLIC_SUPABASE_URL` | Para datos reales | Proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Para datos reales | Clave anónima, sujeta a RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo servidor | Operaciones administrativas. Omite RLS |
| `NEXT_PUBLIC_DATA_SOURCE` | No | `demo`, `supabase` o `auto` (por defecto) |
| `PAYMENT_PROVIDER` | No | `mock` o `transbank`. `mock` está prohibido en producción |
| `TRANSBANK_ENVIRONMENT` | No | `integration` o `production` |
| `TRANSBANK_COMMERCE_CODE` | Al integrar | Credencial de Transbank |
| `TRANSBANK_API_KEY` | Al integrar | Credencial de Transbank |
| `PLATFORM_COMMISSION_BPS` | No | Comisión en puntos base. `1500` = 15% |
| `DISPUTE_WINDOW_HOURS` | No | Plazo para reportar un problema. Por defecto 12 |

`SUPABASE_SERVICE_ROLE_KEY` nunca debe llevar el prefijo `NEXT_PUBLIC_`.

---

## Base de datos

```bash
# Con la CLI de Supabase y un proyecto enlazado
npx supabase db push
psql "$DATABASE_URL" -f supabase/seed/001_geo.sql
```

El esquema se verifica contra un PostgreSQL real, no solo se escribe:

```bash
PGHOST=/tmp PGPORT=55432 PGUSER=postgres npm run db:test
```

Detalle en [`docs/BASE-DE-DATOS.md`](docs/BASE-DE-DATOS.md).

---

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — capas, decisiones y deuda evitada
- [`docs/BASE-DE-DATOS.md`](docs/BASE-DE-DATOS.md) — esquema, RLS, funciones, Storage
- [`docs/HOJA-DE-RUTA.md`](docs/HOJA-DE-RUTA.md) — qué falta, por etapas

---

## Estado

Etapa 1 completada: cimientos, esquema, sistema de diseño, Home, autenticación,
perfiles, publicación de trabajos, listado y detalle.

Los pagos con Webpay Plus **no están integrados todavía**. La interfaz
`PaymentProvider` está lista y `TransbankPaymentProvider` define la forma del flujo,
pero sin llamadas a la red: la integración se hará con el SDK oficial vigente, en
ambiente de integración.
