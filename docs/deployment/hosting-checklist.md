# Checklist para elegir hosting (v1)

La decisión de hosting está pendiente de las respuestas de los proveedores o del
cPanel. Este documento existe para que esas respuestas se evalúen contra
**criterios escritos antes de leerlas**, y no al revés. Cada ítem tiene un
criterio de aprobación; un proveedor que falle un ítem marcado **BLOQUEANTE** no
sirve para esta app, por bueno que sea en todo lo demás.

**Regla de fondo:** no se fuerza un Next.js moderno (App Router, server
actions, SSR) en un hosting que no está hecho para procesos Node persistentes.
Si ninguna respuesta pasa los bloqueantes, la respuesta correcta es "ninguno
sirve" y se va por un host de Node con el dominio propio adelante (CNAME), que
es lo que ya describe `alojar-en-servidor-propio.md` como camino B.

## Lo que la app necesita, medido sobre el código de hoy

| hecho | valor |
|---|---|
| server actions (`"use server"`) | 19 archivos |
| páginas que leen sesión en el servidor | 54 |
| páginas estáticas | prácticamente ninguna |
| bundle a subir | `web/.next/standalone` + `.next/static` + `public` (~68 MB) |
| arranque | `node server.js` con `PORT` y `HOSTNAME` |
| memoria en reposo | 150–250 MB por proceso |
| salidas de red | HTTPS a `*.supabase.co` (PostgREST, Auth, Storage) y al proveedor de IA |
| persistencia en disco | **ninguna**: todo vive en Supabase |
| WebSockets | no requeridos por la app (Supabase Realtime no se usa) |
| cron / trabajos de fondo | no requeridos en v1 |

## Los ítems, con su criterio

| # | ítem | pregunta exacta al proveedor | aprueba si | bloqueante |
|---|---|---|---|---|
| 1 | Versión de Node | ¿Qué versiones de Node ofrece y cómo se elige? | **≥ 20** (la app se desarrolla en 24; 18 está fuera de soporte) | **SÍ** |
| 2 | Proceso Node persistente | ¿Puede correr `node server.js` como proceso que atiende HTTP de forma continua (Passenger, PM2 o similar)? | Sí, no solo "scripts que terminan" | **SÍ** |
| 3 | SSR / App Router | ¿Sirve una app Next.js con renderizado en servidor, no solo estáticos? | Sí | **SÍ** |
| 4 | Reverse proxy | ¿El servidor web (Apache/Nginx) enruta el dominio al puerto del proceso Node? | Sí, con HTTPS terminando en el proxy | **SÍ** |
| 5 | Variables de entorno | ¿Cómo se definen sin escribirlas en archivos del sitio? | Panel o archivo fuera del docroot | **SÍ** |
| 6 | Comando de build | ¿Se compila en el servidor o se sube compilado? | Cualquiera; **subir compilado es lo preferido** (el bundle ya es autocontenido) | no |
| 7 | Memoria por proceso | ¿Cuánta RAM garantiza por proceso Node? | **≥ 512 MB** (256 MB cae bajo carga) | **SÍ** |
| 8 | Gestor de procesos | ¿Reinicia el proceso si muere? ¿Se puede reiniciar a mano? | Sí a ambas | **SÍ** |
| 9 | Cron / fondo | ¿Hay cron o workers? | Deseable, no requerido en v1 | no |
| 10 | SSL | ¿AutoSSL / Let's Encrypt en el subdominio, renovación automática? | Sí, automático | **SÍ** (sin HTTPS no hay PWA instalable) |
| 11 | Dominio propio | ¿Se puede apuntar `app.tudominio.cl` (o el que elijas)? | Sí | **SÍ** |
| 12 | Método de despliegue | ¿SFTP, git, panel, CLI? | Cualquiera reproducible; documentar el elegido | no |
| 13 | Logs | ¿Se pueden leer stdout/stderr del proceso y los logs del proxy? | Sí, con retención ≥ 7 días | **SÍ** |
| 14 | HTTPS de salida | ¿El proceso puede hacer requests HTTPS a dominios externos? | Sí, sin allowlist restrictiva | **SÍ** |
| 15 | Persistencia de archivos | ¿El disco del sitio es persistente entre reinicios? | Irrelevante para la app (no escribe disco), pero preguntar | no |
| 16 | Límites | ¿Tope de procesos, conexiones, CPU, ancho de banda, tiempo de request? | Request ≥ 30 s; sin tope de conexiones absurdo | **SÍ** si el tope de request < 30 s |
| 17 | Compatibilidad Supabase | ¿Algún bloqueo a `*.supabase.co` o a puertos 443 salientes? | Ninguno | **SÍ** |
| 18 | Passenger específico | Si es cPanel + Passenger: ¿versión de Passenger y si soporta `server.js` de Next standalone? | Passenger ≥ 6 | **SÍ** si es esa ruta |

## Cómo se decide

1. Se llena la tabla con las tres respuestas, ítem por ítem, sin interpretar de
   más: si el proveedor no responde un ítem, se anota **NO_RESPONDE** y cuenta
   como no aprobado hasta que responda.
2. Cualquier **BLOQUEANTE** no aprobado descarta al proveedor.
3. Entre los que pasan, gana el que tenga despliegue más simple (ítem 12) y
   mejores logs (ítem 13). Todo lo demás es empate.
4. Si ninguno pasa: **camino B** — un host de Node (Vercel, Render, Fly,
   Railway) con `CNAME` desde tu dominio. La PWA queda en tu dominio igual; lo
   que cambia es quién mantiene el servidor.

## Lo que viene después de elegir, en orden

1. Publicar el RC (`npm run pwa:empaquetar` en `web/` deja el paquete listo).
2. Verificar que responde `/manifest.webmanifest`, `/sw.js` y `/sin-conexion.html` por HTTPS.
3. Supabase → Authentication → URL Configuration: *Site URL* al dominio real y
   el dominio en *Redirect URLs*. Hoy están en `localhost:3000` y vacío.
4. **Activar Confirm Email** (hoy está desactivado; el lanzamiento público está
   bloqueado mientras siga así).
5. Recién ahí, el Launch Gate real (§60 del cierre).
