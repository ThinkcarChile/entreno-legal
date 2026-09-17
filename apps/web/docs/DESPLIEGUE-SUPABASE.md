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

### Comprobar que quedó completo

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
- *Redirect URLs*: agrega `http://localhost:3000/auth/callback` y
  `https://hagotufila.cl/auth/callback`.

Sin esto, los enlaces de confirmación de correo y de recuperación de contraseña
llevan al lugar equivocado.

### 4.2 Confirmación de correo (decisión tuya)

**Authentication → Providers → Email**

- *Confirm email* **activado**: más seguro, es lo correcto en producción. Quien
  se registre debe abrir el enlace antes de entrar.
- *Confirm email* **desactivado**: cómodo para probar el recorrido completo sin
  revisar buzones.

En un proyecto de pruebas conviene desactivarlo. La aplicación funciona igual en
los dos casos: si Supabase exige confirmación, el registro muestra "revisa tu
correo" en vez de entrar directo.

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
npm run build
npm run e2e
```

Sin credenciales, las pruebas del marketplace se omiten indicando el motivo y
solo corren las de páginas públicas. Con credenciales, recorre: entrar como
cliente → publicar → entrar como trabajador → ofertar → aceptar → simular pago.

Si tu entorno ya trae Chromium instalado aparte:

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
