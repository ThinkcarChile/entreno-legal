# Puesta en marcha: los pasos a mano, en orden

Esta es la **lista única** de lo que el dueño del proyecto tiene que hacer a
mano para llevar HagoTuFila del repositorio a producción. Va en el orden en que
conviene hacerlo —primero el proyecto de desarrollo, después Webpay en
integración, al final producción—, y cada paso apunta a la sección que lo
explica. Aquí no se repiten las explicaciones: si un paso no se entiende, la
respuesta está en la sección citada.

Lo que **no** está en esta lista lo hacen las migraciones solas: esquema,
políticas, funciones, buckets, tareas programadas de pg_cron y datos de
referencia (país, categorías, 16 regiones y 346 comunas).

Cada paso se comprobó contra el código del repositorio, no contra un proyecto
alojado: lo que dice de `hagotufila-dev` o de producción **no está validado
allí**. En particular, el envío atómico de `db:push:hosted`, la opción
`--produccion` de `verify:schema:hosted` y la reparación del paso A3 se
probaron contra un PostgreSQL local (y, el primero, contra un doble de la
Management API), no contra Supabase.

Abreviaturas: **D** = `docs/DESPLIEGUE-SUPABASE.md`, **T** = `docs/TRANSBANK.md`,
**P** = `docs/PRUEBAS-WEBPAY.md`.

---

## A. El proyecto de desarrollo, `hagotufila-dev`

Ya existe (ref `xwgobslgldxzatjrcxhl`, región `sa-east-1`, PostgreSQL 17.6,
plan Free sin respaldos).

> **Estado al 2026-10-02.** Hechos en `hagotufila-dev`: A2 (las 79 migraciones
> aplicadas; el plan queda en cero), A3 (reparación de restos e2e: 0 restos,
> 0 invariantes rotos), A4 (mínimo 8), A6, A8 (pg_cron instalado, job
> `hagotufila-tareas-programadas` cada 10 minutos, primera pasada correcta), A9,
> A10 y A12 (todas las verificaciones en verde y las 51 e2e sin omisiones).
> **No hecho:** A5. Supabase no permite cambiar las plantillas de correo en un
> proyecto Free que usa su proveedor de correo por omisión (la Management API
> responde `400 Email template modification is not available for free tier
> projects using the default email provider`). Hace falta SMTP propio (decisión
> pendiente: proveedor y DNS) o un plan de pago. Mientras tanto
> `verify:schema:hosted` falla en V20–V22 en este proyecto, y recuperar la
> contraseña solo funciona abriendo el enlace en el mismo navegador.
> Antes de migrar se tomó un respaldo lógico por la Management API (datos de
> todas las tablas, `auth.users`, Storage y el SQL de las migraciones
> aplicadas), guardado fuera del repositorio: D §3.e.

**A1. Variables de `.env.local`.** Copia `.env.example` a `.env.local` y completa
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY` y `SUPABASE_ACCESS_TOKEN` (token personal `sbp_…`: da
acceso a todos los proyectos de la cuenta, solo para desarrollo, se revoca si se
filtra). Deja `PAYMENT_PROVIDER=mock` y `TRANSBANK_ENVIRONMENT` comentada.
→ D §2, D §3.b, D §3.c; `.env.example` §2 y §7.
Comprobación: con `npm run dev`, la banda de arriba dice «Supabase conectado»
(D §7).

**A2. Migraciones pendientes.**

```bash
npm run db:push:hosted -- --plan     # qué falta; no escribe nada
npm run db:push:hosted               # aplica
```

Con el puerto 5432 abierto vale también `npx supabase db push`. Si se detiene en
un archivo con un error de PostgreSQL, no aplicó nada de él: corrige la causa y
vuelve a ejecutarlo. Si fue un corte de conexión o un tiempo de espera, espera
unos minutos antes de reintentar: lo que haya terminado aparece registrado y se
salta.
→ D §1 (recuadro), D §3.a, D §3.b, D §10.

**A3. Restos de las pruebas e2e antiguas.** Justo después del push, antes de que
pg_cron haga su primera pasada (cada 10 minutos), pega en el editor SQL del
panel el contenido de `supabase/ops/reparar-restos-e2e-dev.sql`. La consulta del
final debe dar `restos_e2e = 0`; si no, queda un trabajo de la prueba que no se
borra a propósito (cobro de Webpay, disputa o devolución) y se revisa a mano. Si
la alerta de integridad ya había saltado, la misma reparación la deja resuelta.
→ D §8.3.

**A4. Mínimo de 8 caracteres en Auth.** En el panel, o con el `PATCH` de la
Management API. → D §4.1.b.

**A5. Plantillas de correo con `token_hash`.** Requiere SMTP propio o un plan
de pago: en Free con el correo por omisión, Supabase no deja editarlas.
*Confirm signup*, *Reset password*, *Change email address* y *Magic link*. Sin quitar las *Redirect
URLs* de §4.1 (`http://localhost:3000/auth/callback`,
`http://localhost:3100/auth/callback` y la de producción). → D §4.1.c, D §4.1.

**A6. Verificación del esquema.**

```bash
npm run verify:schema:hosted
```

Tiene que terminar en verde. Hasta hacer A4 y A5 falla en cuatro comprobaciones,
a propósito. En desarrollo, sin `--produccion`: el proyecto es Free y el aviso de
contraseñas filtradas se acepta con su motivo. → D §3 «Comprobar que quedó
completo», D §4 (recuadro).

**A7. Confirmación de correo y Realtime.** Decide *Confirm email* (D §4.2) y
comprueba que `messages`, `job_evidence`, `notifications` y `conversations`
estén en la publicación de Realtime (D §4.3; A6 también lo comprueba).

**A8. pg_cron.**

```sql
select jobname, schedule, active from cron.job;
-- hagotufila-tareas-programadas | */10 * * * * | t
select status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 5;
select source, kind, violation_count
  from app_private.integrity_alerts where resolved_at is null;   -- vacío tras A3
```

→ D §4.4.

**A9. Solo desarrollo: transferencias sobre cobros de prueba.**

```sql
update public.platform_settings set allow_non_production_payouts = true where id;
```

Sin esto `verify:execution` se niega a correr. **Nunca en producción.** → D §4.5.

**A10. Solo desarrollo: límites por persona.**

```sql
update public.platform_settings
   set rate_limit_jobs_per_day = 500, rate_limit_offers_per_hour = 1000
 where id;
```

Sin esto una pasada de verificación se corta a la mitad. → D §8.1;
`docs/BASE-DE-DATOS.md`, «Límites por usuario».

**A11. Cuentas de control de calidad.** `E2E_CLIENT_*`, `E2E_WORKER_*`,
`E2E_OUTSIDER_*` y `E2E_ADMIN_*` en `.env.local`; las crea el primer script que
las usa. → D §8.1; `.env.example` §6.

**A12. Verificaciones contra el proyecto**, con `PAYMENT_PROVIDER=mock`:

```bash
npm run verify:schema:hosted
npm run verify:supabase
npm run verify:payments
RACE_REPS=10 npm run verify:payments
npm run verify:execution
RACE_REPS=10 npm run verify:execution
npm run e2e
```

Y el recorrido a mano de D §8.4. En ese recorrido, además: abre una disputa como
cliente, adjunta una prueba, contesta como trabajador, y como administración
entra a `/admin/disputas` → «Ver el trabajo y su evidencia»: tienen que verse la
línea de tiempo, las fotos y las pruebas de las dos partes, y cada archivo tiene
que abrirse (`docs/EJECUCION.md` §10). → D §8.2–§8.4.

**A13. Límites de Auth.** Revisa *Authentication → Rate Limits* teniendo en
cuenta que Supabase ve la IP del servidor, no la del navegador. **No actives el
CAPTCHA**: los formularios todavía no envían `captchaToken` y nadie podría
entrar. → D §4.6.

---

## B. Webpay en integración

Desde una red que alcance `webpay3gint.transbank.cl` (una VPN de centro de datos
no sirve). Con A completo.

**B1. Variables.** En `.env.local`: `PAYMENT_PROVIDER=transbank`,
`TRANSBANK_ENVIRONMENT=integration` (fuera de producción es opcional: sin
escribirla ya es integración) y `NEXT_PUBLIC_SITE_URL=http://localhost:3000`.
**Ninguna** variable `TRANSBANK_PRODUCTION_*`. → P §2.1; T §8.

**B2. Ensayo en seco (opcional).** Con el proveedor simulado y
`npm run evidence:webpay -- --ambiente mock --caso "Ensayo" --sin-archivo`.
→ P §2.3.

**B3. Las pruebas de integración**, con `npm run evidence:webpay -- --caso "…"`
después de cada una. En la prueba 14 (conciliación), espera al menos 15 minutos
desde que se creó la transacción antes de «Conciliar pendientes». → P §3–§5;
T §8.

**B4. La batería completa.** Primero **vuelve a `PAYMENT_PROVIDER=mock`** en
`.env.local`: `e2e` y las verificaciones usan el proveedor simulado. Después la
batería, con `verify:transbank` sin ninguna OMITIDA y sin `ALLOW_OFFLINE`. Las
condiciones de A9 y A10 siguen haciendo falta. → P §6.

**B5. Entrega a Transbank**, solo con autorización expresa: órdenes de compra
(`npm run evidence:webpay -- --lista`), capturas y logotipo. → P §7; T §10.

---

## C. Producción

Solo después de que Transbank apruebe el comercio. Ningún paso de esta parte se
ha ejecutado todavía.

**C1. Proyecto aparte, de pago.** Otro proyecto Supabase, no `hagotufila-dev`;
de pago, porque la protección de contraseñas filtradas lo exige. Migraciones
desde la integración continua con el CLI y un token de servicio propio, no con
el token personal. Las regiones y comunas llegan con ellas; **nunca** las
semillas de demostración `002`/`003`. Comprobación: la consulta de D §3
(`regiones` 16, `comunas` 346). → D §9 (1–2), D §3.a, D §3.c, D §3.d.

**C2. Panel de Auth, con el dominio real.**

- *Site URL* `https://hagotufila.cl` y `https://hagotufila.cl/auth/callback` en
  *Redirect URLs* (D §4.1).
- Mínimo de 8 y *Prevent use of leaked passwords* activado (D §4.1.b).
- Las plantillas de correo de A5 (D §4.1.c).
- *Confirm email* activado (D §4.2) y Realtime (D §4.3).
- Límites de Auth y de correo, con SMTP propio si hace falta; el CAPTCHA sigue
  apagado mientras la aplicación no envíe `captchaToken` (D §4.6).

→ D §9 (3, 9).

**C3. Verificación estricta.**

```bash
SUPABASE_PROJECT_REF=<ref de producción> NEXT_PUBLIC_SITE_URL=https://hagotufila.cl \
  npm run verify:schema:hosted -- --produccion
```

Necesita `SUPABASE_ACCESS_TOKEN`: uno creado para esto y revocado al terminar
(D §3.c). Con `--produccion` exige HTTPS y **no** acepta el aviso de contraseñas
filtradas: falla mientras C2 no esté completo. → D §9 (4), D §4.1.b.

**C4. Base de producción.**

```sql
select jobname, schedule, active from cron.job;                    -- activo, */10
select * from app_private.payment_invariant_violations();          -- sin filas
select * from app_private.refund_invariant_violations();           -- sin filas
select * from app_private.integrity_alerts where resolved_at is null;  -- vacío
select allow_non_production_payouts from public.platform_settings; -- false
select rate_limit_jobs_per_day, rate_limit_offers_per_hour
  from public.platform_settings;                                   -- los de omisión
```

Y decide por dónde avisar de un invariante roto fuera de la aplicación (correo,
Slack, un servicio de errores): hoy solo avisa dentro. → D §9 (5–8), D §4.4,
D §4.5.

**C5. Variables del hosting**, escritas una por una con la tabla de T §9
«Variables del hosting». **No** uses `.env.example` como base.

- `NODE_ENV=production`, `NEXT_PUBLIC_SITE_URL=https://hagotufila.cl`.
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y
  `SUPABASE_SECRET_KEY` del proyecto de C1 (la secreta, solo servidor).
- `PAYMENT_PROVIDER=transbank` y `TRANSBANK_ENVIRONMENT=production`, escrita.
- `TRANSBANK_PRODUCTION_COMMERCE_CODE` y `TRANSBANK_PRODUCTION_API_KEY_SECRET`.
- `TRANSBANK_PRODUCTION_ENABLED=false` todavía: se enciende en C7.
- `CRON_SECRET` de 32 caracteres o más (`openssl rand -hex 32`).

→ D §9 (10); T §9; `README.md`, «Variables de entorno».

**C6. Programador externo.** Que llame a `/api/cron/conciliar-pagos` cada 10
minutos con `Authorization: Bearer $CRON_SECRET` (Vercel Cron en plan Pro,
GitHub Actions o un cron del servidor). Comprobación: responde `200` con
`ok: true`; `503` es que falta el secreto o es corto, `401` que no coincide.
→ T §7 «Cómo ejecutarla»; D §9 (11).

**C7. El primer cobro real.** Encender `TRANSBANK_PRODUCTION_ENABLED=true` es el
acto explícito de cobrar; después, la «Lista para el primer cobro real» entera:
antes, durante y después del cobro. → T §9; D §9 (12).

**Si hay que volver atrás**: T §9 «Rollback» y el runbook de T §11.
