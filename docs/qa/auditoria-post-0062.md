# Auditoría post-despliegue de la 0062

Fecha: **2026-09-04**. Producción: 61 migraciones aplicadas, 0 pendientes.
Esta ronda **no tocó producción**: ni migración, ni DDL, ni DML, ni grant, ni
revoke. Se creó un script de sólo lectura y se leyó.

## Lo primero: hay un defecto abierto en producción

**`/api/health` devuelve HTTP 503 desde que se aplicó la 0062.**

La app corriendo contra la base real contesta
`{"ok":false,"version":null,"schema":null}`.

### Cómo pasa

1. `/api/health` lee `public.households` **como `anon`** — es la única consulta
   anónima a propósito del proyecto.
2. `anon` tiene privilegio de TABLA sobre las 137 tablas de `public`. Así viene
   Supabase, y está bien: la RLS es la que protege.
3. La política `households_select` (de `0001_family.sql`) se escribió **sin
   cláusula `TO`**. Una política sin `TO` nace `TO PUBLIC`, y PUBLIC incluye a
   `anon`. Son **12** las políticas así, todas del núcleo familiar.
4. Evaluar esa política llama a `app.is_household_member`.
5. La 0062 le quitó a `anon` el `USAGE` sobre el esquema `app`.

Resultado: `ERROR: permission denied for function is_household_member`.

### Medido, no razonado

| dónde | resultado |
|---|---|
| cadena hasta **0061** en PGlite | `OK, 0 filas` — la RLS filtra y la sonda anda |
| cadena hasta **0062** en PGlite | `permission denied for function is_household_member` |
| **la app real contra producción** | **HTTP 503** |

### La premisa que falló

La 0062 escribió como justificación: *"no hay ni una sola `to anon` en las 59
migraciones, así que anon no evalúa ninguna política"*. Es una inferencia falsa:
**ausencia de `to anon` no es ausencia de política aplicable.** Es el mismo error
de forma que este proyecto ya cometió otras veces — mirar cómo se escribió algo
en vez de preguntar qué hace.

### Es de DISPONIBILIDAD, no de confidencialidad

`anon` no lee ni una fila del hogar: recibe un error en vez de una lista vacía.
Está afirmado aparte en `anon-rls.test.ts` para que no se confunda un problema
con el otro.

### Qué hay que decidir (no se toca sin que Francisco elija)

- **(a)** Que `/api/health` no consulte una tabla con RLS. **No necesita
  migración**: es una línea del route handler. Rápido y reversible.
- **(b)** Una 0063 que le ponga `to authenticated` a las 12 políticas de
  `0001_family.sql`. Más limpio de raíz, pero toca la RLS del núcleo familiar y
  se aplica con el protocolo completo.

Queda registrado en el código con `it.fails`, que no tiñe el CI de rojo crónico y
**se pone rojo el día que alguien lo arregle**, obligando a actualizar el archivo.

## Por qué no se había visto: el arnés emulaba un `anon` más débil que el real

`harness.ts` le daba privilegios de tabla **sólo a `authenticated`**. Con eso, un
`select` de `anon` moría en el privilegio de tabla y **la política de RLS nunca se
evaluaba**: una política rota para anon era invisible para las 2.441 pruebas.

Corregido: ahora `anon` recibe los mismos privilegios de tabla que Supabase le
da. Las 2.441 siguen pasando — el arreglo no rompió nada, sólo dejó de tapar.

> Una corrección a lo que se informó la ronda pasada: se dijo que los `SELECT` de
> anon devolvían `permission denied for table`, y se presentó como "mejor de lo
> que el test pedía". Era un artefacto del arnés. En Supabase real anon **sí**
> llega a la tabla; lo que lo frena es la RLS.

## §1 — Antes y después, medido sobre la misma cadena

| | SECURITY DEFINER | `anon` ejecuta | `usage` sobre `app` |
|---|---|---|---|
| hasta **0061** | 275 | **268** | `true` |
| hasta **0062** | 275 | **0** | `false` |

`authenticated`: las 84 RPC del contrato, **idénticas antes y después**.

## §9 — Inventario vivo de producción (privilegio EFECTIVO)

Alcanzable de verdad = privilegio sobre la función **Y** `usage` sobre su
esquema. Preguntar sólo por `has_function_privilege` exagera; preguntar sólo por
el esquema esconde.

| esquema | funciones | ACL de anon | **efectivo** | de ésas, SECDEF |
|---|---|---|---|---|
| `app` | 221 | 80 | **0** | 0 |
| `public` | 168 | 33 | **33** | **0** |

- `ANON_EFFECTIVE_EXECUTE` sobre SECURITY DEFINER = **0**
- `EXPECTED_PUBLIC` = **33**: 31 de la extensión `pg_trgm` más
  `adaptive_max_validity_days` (inmutable, devuelve una constante) y
  `touch_updated_at` (función de trigger). **Ninguna es SECURITY DEFINER**, así
  que corren con los privilegios de quien llama: anon no gana nada.
- `REVIEW_REQUIRED` = **0**
- `anon` sobre el esquema `app`: `usage` = **false**

Se obtiene con `node scripts/auditar-privilegios-produccion.mjs` (sólo lectura).

## §2 y §3 — Ejecutadas, no consultadas al catálogo

`rpc-ejecucion.test.ts` arma la llamada de **cada una de las 84** desde su firma
real en `pg_proc` —un `null` tipado por argumento— y la corre con los dos roles:

- **como `anon`**: las 84 fallan por privilegio, y el censo de las 123 tablas
  queda idéntico.
- **como `authenticated`**: **ninguna** falla por privilegio. Pueden fallar por
  falta de datos, por no ser de ese hogar, por argumento nulo — nunca por
  permiso.

Esa asimetría es la prueba. No hace falta armarle a cada función un caso de uso
válido: alcanza con separar *"la base no te deja"* de *"los datos no dan"*.

Y un control que impide el verde por vacuidad: la MISMA llamada tiene que dar
resultados distintos según el rol. Si `set role` no tomara, los dos tests
pasarían igual.

## §4 y §5 — El guardián del inventario tenía cuatro agujeros

| agujero | qué se escapaba |
|---|---|
| miraba sólo `src/app` y `src/lib` | todo `src/domain` y `src/components` |
| leía comentarios | un `.rpc("x")` comentado entraba al inventario (eran **12** nombres de más) |
| exigía el paréntesis pegado | `.rpc<T>(`, `.rpc (`, `.rpc` con salto de línea |
| declaraba variables por archivo | una segunda `.rpc(variable)` heredaba la declaración de la primera |

Los cuatro cerrados, cada uno con su test. Las variables se declaran por
`archivo:identificador` — la primera corrección usó la LÍNEA y estuvo mal:
cualquiera que agregara un comentario más arriba rompía la declaración por un
motivo que no tiene nada que ver con lo que el guardián vigila.

**El contrato (§5)** vive en `contrato-rpc.ts`, con un solo dueño y dos
consumidores. Clasifica las 84 con `lado`, `rol` y `anonimo_permitido`, y el CI
falla si aparece una RPC sin clasificar **o** si el contrato clasifica una que la
app ya no llama. Cada campo se contrasta contra los privilegios reales.

También entraron al inventario las dos RPC de lectura del asistente
(`assistant_row_stamps`, `assistant_engine_stamps`), que no se llaman por
`.rpc()` sino por una lista blanca y por eso nunca aparecían. Y con ellas se
escribió la guarda de volatilidad que `tool.ts` **prometía en un comentario y no
existía en ningún archivo**: `grep provolatile` sobre el repo entero no devolvía
nada.

## §7 — `service_role`

No llega al navegador: no hay `NEXT_PUBLIC_*` que lo contenga, ningún archivo con
`"use client"` lo importa, la app no crea ningún cliente de Supabase en el
navegador, y ninguna RPC depende de darle privilegios a `anon` para suplirlo.

**Pero el detector de credenciales estaba vigilando la ortografía vieja.**
Conocía dos formas (`sbp_` + 40 hex, y JWT) y Supabase emitió un formato nuevo
que **este proyecto ya usa**: la llave publicable del bundle compilado empieza
así. Una llave secreta del formato nuevo pegada en el código pasaba en verde.

Además barría sólo `web/src` y `.env.example`, dejando afuera `scripts/` —donde
vive el único código que le pide la llave de servicio a la Management API— y
`web/e2e/`.

Las dos cosas corregidas. Y una tercera, que es la que más enseña:

> Al agregar los formatos nuevos, el borde de palabra del patrón entró al archivo
> como un **byte de retroceso (0x08)** en vez de como el escape del regex. El
> patrón no calzaba con nada — y el barrido siguió **en verde**. Un guardián que
> no encuentra nada y uno que no *puede* encontrar nada se ven exactamente igual.
> El byte ni se veía con `grep`: hizo falta `cat -A`.
>
> Ahora cada forma tiene que reconocer un ejemplo sintético. Ese test pone rojo
> con el mensaje "el patrón está roto".

## §6 — `ANONYMOUS_RPC_REQUIRED = FALSE`, confirmado

Revisadas una por una: login, registro, middleware, raíz, invitación, arranque de
la PWA (service worker, manifest, página sin conexión). Ninguna llama `.rpc()` de
aplicación antes de tener sesión. La Auth API de Supabase
(`signInWithPassword`, `signUp`) no cuenta: va por otro endpoint y otro
mecanismo.

`/invite/[token]` es la única ruta genuinamente previa a la sesión, y
`accept_invitation` **empieza** rechazando cuando no hay `auth.uid()`.

`ANONYMOUS_RPC_ALLOWLIST = []` sigue siendo correcto.

### Dos cosas que aparecieron mirando esto

1. **Las server actions son endpoints POST propios.** En Next, una server action
   es alcanzable con el header `Next-Action` sin que la página se llegue a
   servir, así que el gate de la página no la protege.
   `invite/[token]/actions.ts` y `family/actions.ts` no comprueban sesión por su
   cuenta. **Hoy no es una brecha** —post-0062 el cliente sin sesión es `anon` y
   no ejecuta nada, y las funciones comprueban de nuevo por dentro— pero se
   apoya en dos capas y no en tres.
2. **No existen las rutas de recuperar clave, confirmar correo ni auth
   callback.** Cero coincidencias de `exchangeCodeForSession`, `verifyOtp`,
   `resetPasswordForEmail` o `auth/callback` en todo el repo. Toda la
   autenticación son tres llamadas en `login/actions.ts`. **Esto cambia el orden
   del lanzamiento**: activar Confirm Email sin una ruta que reciba el redirect
   deja a la gente sin poder terminar de registrarse.

## §10 — Smoke contra producción, separado por capa

| capa | estado | evidencia |
|---|---|---|
| carga de páginas | **PASS** | las 10 rutas protegidas → `/login?next=<ruta>`, HTTP 200, ni un 500 |
| compuerta de sesión | **PASS** | redirige y conserva el destino |
| pantalla de login | **PASS** | renderiza con sus dos acciones |
| compatibilidad de RPC | **PASS** | las 84 ejecutadas con sesión: ninguna bloqueada por privilegio |
| `/api/health` | **FAIL** | HTTP 503 (el defecto de arriba) |
| datos por pantalla | **BLOCKED** | necesita una sesión de la familia; crear un usuario de prueba en producción sería DML, prohibido en esta ronda |

`Error != vacío` se respetó en cada fila: ninguna de las que dice PASS lo dice por
no haber encontrado nada.
