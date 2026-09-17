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
| `PLATFORM_COMMISSION_BPS` | No | Comisión por defecto en puntos base. `1400` = 14%. En modo Supabase manda `platform_settings` |
| `DISPUTE_WINDOW_HOURS` | No | Plazo para reportar un problema. Por defecto 12 |

`SUPABASE_SERVICE_ROLE_KEY` nunca debe llevar el prefijo `NEXT_PUBLIC_`.

---

## Poner en marcha Supabase

```bash
# 1. Crear el proyecto en supabase.com y copiar URL y claves a .env.local
# 2. Aplicar el esquema
npx supabase db push

# 3. Semillas
psql "$DATABASE_URL" -f supabase/seed/001_geo.sql          # 16 regiones, 346 comunas
psql "$DATABASE_URL" -f supabase/seed/002_demo_accounts.sql # solo desarrollo
psql "$DATABASE_URL" -f supabase/seed/003_demo_content.sql  # solo desarrollo

# 4. Tipos de TypeScript
npx supabase gen types typescript --project-id <id> --schema public \
  > src/lib/supabase/database.types.ts
```

Las cuentas de demostración usan la contraseña `hagotufila2026`. La cuenta
`admin@demo.cl` entra al panel interno y resuelve verificaciones.

Para que un trabajador pueda ofertar necesita estar verificado: entra como
administración, abre `/admin/verificaciones` y aprueba la solicitud.

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

Ver `docs/HOJA-DE-RUTA.md` para el detalle y los riesgos pendientes.
