# Observabilidad y degradación (§51 y §52)

Sin servicio externo y sin dependencias nuevas. Un SDK de logs es una salida de
datos más que auditar, y la decisión de qué proveedor usar no está tomada. Lo
que hay es: una línea de JSON a **stderr** por cada error del servidor, y
consultas de SQL para lo que vive en la base.

**Todo lo que sale por stderr pasa por `web/src/lib/observabilidad.ts`.** Ese
módulo filtra por lista negra de claves y por forma del valor: ids y estados,
nunca contenido. El porqué y los cinco sitios auditados están en
`docs/qa/logging-pii-audit.md`.

---

## 1. Errores del servidor

**Cómo se ven.** Una línea por error en la salida estándar de error del proceso:

```json
{"nivel":"error","evento":"salud.examen.archivo_huerfano","ts":"2026-09-03T14:02:11.004Z",
 "bucket":"medical","ruta":"member/<uuid>/<uuid>.pdf","memberId":"<uuid>",
 "codigoRegistro":"23505","borrado":"NO_RETIRO_NADA"}
```

**Dónde queda eso.** Depende de cómo corra el proceso:

| forma de correr | dónde está el log |
|---|---|
| `node server.js` a mano | la terminal; se pierde al cerrarla |
| systemd | `journalctl -u <servicio> -f` |
| PM2 | `pm2 logs <app>` (archivos en `~/.pm2/logs`) |
| Docker | `docker logs -f <contenedor>` |
| cPanel / Passenger | el archivo de log de la aplicación en el panel |

**Cómo se busca.** Cada error tiene un `evento` estable y sin texto variable
adentro, justamente para poder filtrar:

```bash
journalctl -u nutrifamilia | grep '"nivel":"error"'
journalctl -u nutrifamilia | grep '"evento":"salud.'
```

**Lo que NO vas a encontrar ahí:** el mensaje del error. Es a propósito (§50).
Lo que hay es el `evento`, el `ruta`/`id` para localizar la fila o el archivo, y
el SQLSTATE en `codigo`. Con eso se reproduce; con el mensaje se filtraría un
valor de laboratorio.

**Los que no pasan por `registrarError`:** una excepción no atrapada de Next
sale con su propio formato y su `digest`. Ese `digest` es el mismo que la
persona ve en pantalla ("Código: …"), así que si te lo dicta, búscalo en el log.

## 2. Caídas del cliente

**Qué ve la persona:**

- `web/src/app/error.tsx` — falla una pantalla. En castellano, con botón
  Reintentar, y diciendo explícitamente que es un error al LEER, no un estado
  real de su casa.
- `web/src/app/global-error.tsx` — falla el armazón (el layout raíz, o el propio
  `error.tsx`). Trae su propio `<html>` y estilos en línea: si lo que no cargó
  es la hoja de estilos, una pantalla de error sin estilos sería una página en
  blanco, que es el modo de falla que esa pantalla existe para evitar.

Ninguna de las dos vuelca el error: solo el `digest`.

**Qué NO hay.** No hay reporte automático de errores del navegador al servidor.
Una caída de cliente se entera si la persona la cuenta, o si el error también
pasó en el servidor. Montarlo pide un endpoint que reciba datos del navegador
—una superficie sin sesión y con contenido arbitrario— y esa decisión no se toma
al cierre de v1. **Queda dicho como agujero conocido, no como algo resuelto.**

## 3. ¿Está viva la app?

```bash
curl -s https://<dominio>/api/health
{"ok":true,"version":"…","schema":"…"}
```

- `ok:false` con HTTP 503 significa que **la app está arriba pero la base no le
  contesta**. El motivo va al log como `health.base_no_responde` (con el
  SQLSTATE), `health.sin_configuracion` o `health.excepcion`.
- Sin respuesta significa que el proceso está caído o el proxy no llega.
- `version` y `schema` salen de `APP_VERSION` y `SCHEMA_VERSION` (ver
  `entornos.md`). Si no están declaradas, responde `null` — **null, no
  "0.0.0"**: un número inventado hace que alguien crea que sabe qué versión está
  corriendo el día que importa.

Es un endpoint **sin sesión** y por eso devuelve tres campos y nada más: ni el
mensaje del error, ni la URL de Supabase, ni conteos.

## 4. Escrituras fallidas

En esta app una escritura fallida **no puede pasar desapercibida por diseño**,
así que no hace falta un panel para descubrirlas:

- `web/src/lib/supabase/unwrap.ts` — toda lectura pasa por ahí y un error de
  PostgREST se convierte en `DataAccessError`, jamás en "no hay nada".
- `gate-error-contract.test.ts` — recorre todas las server actions y falla si
  alguna descarta el resultado de un `insert/update/upsert/delete/rpc`.
- La persona ve el error en pantalla, con texto propio.

Lo que sí conviene mirar en producción, porque es el caso que deja basura:

```sql
-- Archivos huérfanos: subidos al bucket y sin fila que los referencie.
-- Salen en el log como `finanzas.boleta.archivo_huerfano` y
-- `salud.examen.archivo_huerfano`, con la ruta exacta para poder borrarlos.
```

## 5. Backlog del outbox — **ojo con esto**

`public.domain_events` es el outbox (0001): `status` arranca en `PENDING` y el
diseño contempla `PROCESSING`, `PROCESSED`, `FAILED` y `DEAD`.

**Hoy no hay ningún consumidor.** Dieciséis funciones escriben eventos ahí y
NADIE los procesa: no existe una sola sentencia en el repo —ni en las
migraciones, ni en `web/src`, ni en `scripts/`— que mueva una fila fuera de
`PENDING`. La tabla crece y nada la vacía.

Eso significa que **"backlog de outbox" no es una alarma útil todavía**: el
backlog es el total, siempre, y no mide ningún atraso. Medirlo como si midiera
algo sería inventar una señal. Lo que sí sirve mirar es el TAMAÑO, porque es
crecimiento puro sobre la base de la familia:

```sql
-- Cuánto pesa el outbox que nadie consume.
select count(*) as filas, min(created_at) as la_mas_vieja
  from public.domain_events where status = 'PENDING';

-- Y de qué tipo, por si alguna función se disparó de más.
select event_type, count(*) from public.domain_events
 where status = 'PENDING' group by 1 order by 2 desc limit 10;
```

Cuando exista el consumidor, la alarma correcta es "la más vieja tiene más de N
minutos" y no el conteo. **Hasta entonces, un conteo alto no es un incidente.**

## 6. Fallas de IA

Tres señales, y las tres viven en la base (`0057_asistente_presupuesto.sql`):

```sql
-- Cortafuegos abierto = el proveedor viene fallando y se dejó de llamar.
select household_id, fallas_seguidas, abierto_hasta
  from public.assistant_budget_policies
 where abierto_hasta is not null and abierto_hasta > now();

-- Reservas que se tomaron y nunca se liquidaron: el turno murió a mitad.
select count(*) from public.assistant_usage
 where liquidada_at is null and created_at < now() - interval '15 minutes';
```

En pantalla, una falla del proveedor se ve como una tarjeta `NO_PUDE` con causa
`PROVEEDOR_CAIDO` — nombrada, nunca un silencio (`AssistantShell.tsx`).

## 7. Fallas de extracción de boletas y de laboratorio

Las dos dejan el documento en `FAILED`, que es una fila que se puede contar:

```sql
-- Boletas cuya lectura automática falló (0045).
select count(*) from public.purchase_receipts where processing_status = 'FAILED';

-- Exámenes cuya extracción falló (0026).
select count(*) from public.lab_documents where processing_status = 'FAILED';
```

`FAILED` **no** es un incidente por sí solo: hoy el extractor solo entiende
`text/*`, así que una foto o un PDF caen en `FAILED` por diseño y no por avería
(ver §52 más abajo). Lo que hay que mirar es un cambio brusco: si venían
extrayéndose bien y de golpe todo cae en `FAILED`, ahí sí pasó algo.

---

# §52 — Degradación: qué sigue funcionando cuando algo se cae

Lo verificado, con el archivo donde está. Lo que no existe se dice que no
existe.

## IA caída → la app sigue. **Verificado.**

- `web/src/lib/ai/provider.ts` — `modoProveedor()` devuelve `fake` salvo que
  `ASSISTANT_PROVIDER` diga exactamente `remoto`. El default es el falso: al
  revés, un test que se olvidara de la variable saldría a la red.
- `cargarProveedorRemoto()` devuelve `null` —no lanza— cuando falta el entorno,
  y el adaptador real se carga con `await import()` perezoso, así que ni siquiera
  entra al árbol de módulos de la página.
- `web/src/app/asistente/page.tsx` muestra primero los pendientes de la bandeja
  y los atajos deterministas: **la pantalla sirve aunque el proveedor no exista**.
- Una excepción del servidor se convierte en una tarjeta `NO_PUDE` con causa
  `PROVEEDOR_CAIDO`, no en un chat mudo.
- Lo afirman `web/src/lib/ai/guardas-ia.test.ts` (que `fake` es el default, que
  nadie importa el adaptador real de forma estática, que `hasAiEnv()` responde
  `false` en vez de reventar).

**Y la app entera no depende de la IA:** las 47 rutas menos `/asistente` no
tocan `lib/ai` ni de lejos.

## OCR de boletas caído → carga manual. **NO EXISTE. Hallazgo.**

Lo que sí está bien: cuando el archivo no es texto,
`web/src/app/finanzas/boletas/actions.ts` **no improvisa un OCR**. Registra la
extracción con cero candidatos, el documento queda en `FAILED` y el mensaje a la
persona dice "revísala a mano". Eso es honesto y es lo correcto.

Lo que falta es la otra mitad: **no hay dónde revisarla a mano.** La pantalla de
revisión (`/finanzas/boletas/[id]/review`) pinta los CANDIDATOS de la extracción;
con `extraction_pass = 0` la lista llega vacía y no hay ningún control para
agregar una línea.

La compra sí se crea sola cuando la extracción funcionó: `record_purchase`
(0043) la llama `confirm_receipt_extraction` por dentro. Pero **la app no llama
`record_purchase` en ninguna parte por sí misma**, así que el único camino a una
compra pasa por tener candidatos, y los candidatos solo salen de una extracción
que funcionó.

Resultado real: si subes la foto de una boleta, hoy no se convierte en compra
por ningún camino. No es una avería: es una funcionalidad que no está. Se anota
acá, no se inventa.

## Extracción de laboratorio caída → revisión manual. **NO EXISTE. Hallazgo.**

Exactamente la misma forma, y por eso se nombra aparte: es el módulo de salud.
`web/src/app/health/actions.ts` deja el documento en `FAILED` sin inventar nada
—correcto— y dice "revisa a mano". Pero
`/health/exams/[id]/review` también pinta solo candidatos, y
`correct_lab_observation` corrige una observación **ya confirmada**: no crea la
primera. Sin extracción no hay forma de anotar un examen.

**Peso de este hallazgo:** hoy el extractor solo entiende `text/*`, y los
exámenes de laboratorio en Chile llegan en PDF. O sea que el camino manual no es
el plan B: es el único camino real, y no está construido.

## Supabase caído → la app dice que no puede. **Verificado.**

Ninguna lectura devuelve vacío ante un error (`unwrap.ts`), así que la persona
ve "algo falló", nunca "no tienes nada". `/api/health` responde 503, que es lo
que un monitor necesita.

## Sin conexión → queda la pantalla offline. **Verificado, con su trampa.**

El service worker cachea `/sin-conexion.html` y el middleware EXCLUYE esa ruta
de su matcher: si Supabase está caído y el middleware contestara 500 en
`/sin-conexion.html`, el worker no se instalaría y la app se quedaría sin
pantalla de sin conexión. Lo vigila `pwa-coherencia.test.ts`.
