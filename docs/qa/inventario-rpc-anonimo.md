# La app no necesita ninguna RPC anónima

Corte: **2026-09-04**. Producción: 61 migraciones aplicadas, 0 pendientes.

**ANONYMOUS_RPC_REQUIRED = FALSE.**

La prueba más fuerte no es este documento: la 0062 **ya está aplicada en
producción** y la aplicación funciona. Si alguna ruta necesitara una RPC sin
sesión, estaría rota en este momento. Lo que sigue explica por qué eso no es
suerte, y qué queda puesto para que siga siendo cierto.

## Lo que la 0062 cambió, medido

Misma cadena, cortada antes y después:

| | funciones SECURITY DEFINER | ejecutables por `anon` | `usage` sobre el esquema `app` |
|---|---|---|---|
| cadena hasta **0061** | 275 | **268** | `true` |
| cadena hasta **0062** | 275 | **0** | `false` |

El `usage` revocado es lo que cierra las funciones que se escriban **mañana**:
en PostgreSQL toda función nueva nace con `EXECUTE` para `PUBLIC`.

## §3 — El inventario, derivado del código

**82 RPC distintas, 89 llamadas.** Por tipo de llamador:

| tipo de llamador | llamadas | ¿corre en el navegador? |
|---|---|---|
| server action (`"use server"`) | 79 | no |
| server component / lib | 10 | no |
| **componente de cliente** | **0** | — |

Ninguna llamada a `.rpc()` viaja al bundle del navegador. El `anon key` que sí
llega al cliente no tiene con qué llamar a nada.

### El que un grep no veía

Todas las llamadas usan un nombre literal menos una:

```ts
const rpc = parsed.data.donde === "AFUERA" ? "log_intake_away" : "log_intake_off_plan";
const { error } = await db.rpc(rpc, { … });        // src/app/comi/actions.ts:262
```

`log_intake_away` no aparecía en los inventarios anteriores por eso. **No hubo
brecha** —el cierre de la 0062 recorre el catálogo, no la lista de la app, así
que las tres quedaron cerradas igual— pero el inventario que sustentaba la
decisión estaba incompleto, y un inventario incompleto es peor que ninguno:
da confianza. Hoy la llamada está declarada y el guardián la exige.

## §4 — Las rutas previas a la sesión

El middleware no bloquea: sólo refresca la sesión. La compuerta está en cada
página y cada acción, con su propio `auth.getUser()`. De los archivos que llaman
RPC, once no lo hacen por su cuenta:

- **nueve** reciben el cliente ya autenticado de quien los llama (`queries.ts`,
  `assess-service.ts`, `profile-publish.ts`, `lib/auth/actor.ts`);
- **dos** crean el suyo y se apoyan en la cookie de sesión más la guarda de la
  propia función (`family/actions.ts`, `finanzas/boletas/actions.ts`). Sin
  sesión, ese cliente **es** `anon`, y desde la 0062 no ejecuta nada. Se intentó
  de verdad: ver §13.

Queda **una sola** ruta que por su naturaleza se visita antes de pertenecer al
hogar: `/invite/[token]`. Tampoco necesita RPC anónima —

```sql
if auth.uid() is null then
  raise exception 'authentication required';
end if;
```

— es la primera línea de `accept_invitation`. Quien recibe una invitación crea
su cuenta y entra; recién después el enlace hace algo. La guarda vive DENTRO de
la función, que es donde no se puede saltar desde el cliente.

## §7 — La regresión que pone rojo el CI

`web/src/integration/inventario-rpc.test.ts`, 12 pruebas. No es un framework:
es un archivo que barre `src/app` y `src/lib`, arma el inventario y lo afirma
contra una base con la cadena completa.

| afirma | qué pasa si se rompe |
|---|---|
| toda llamada de nombre **variable** está declarada | rojo con archivo y línea |
| el barrido encuentra >60 llamadas y ve `log_intake_away` | rojo si el barrido queda vacío |
| toda RPC que la app llama **existe** | rojo con el nombre inventado |
| **ninguna** es ejecutable por `anon` | rojo con los nombres abiertos |
| todas **sí** son ejecutables por `authenticated` | rojo si el cierre se pasó de largo |
| `anon` no tiene `usage` sobre `app` | rojo |

La segunda fila es la que evita el modo de falla clásico: **un inventario vacío
aprueba todo**. Sin ella, un cambio de estilo en las llamadas dejaría la lista en
cero y las demás pasarían por no haber mirado nada.

Una RPC nueva no se puede colar: si se llama con literal, entra sola al
inventario y tiene que estar cerrada a `anon`; si se llama con variable, el
primer test la exige declarada.

## §13 — Intentos de mutación anónima, ejecutados

No se le pregunta al catálogo: se intenta. Sobre una base efímera con datos
**sintéticos** (nada del hogar real, ningún dato clínico), se censan las 123
tablas de `public`, se toma el rol `anon`, se corre la batería y se recuenta.

| intento | resultado |
|---|---|
| `insert / update / delete` sobre `households` | rechazado |
| `delete` sobre `household_members` | rechazado |
| `log_intake`, `log_intake_away` | rechazado |
| `create_household`, `ensure_weekly_plan` | rechazado |
| `accept_invitation` | rechazado |
| `select count(*)` sobre las tablas del hogar | `permission denied for table` |

Censo antes == censo después, tabla por tabla.

El último renglón salió **mejor** de lo que el test pedía. La primera versión
exigía "devuelve cero filas", dando por hecho que filtraría la RLS. La base
contestó `permission denied`: `anon` no tiene ni `SELECT`, así que la RLS ni
llega a evaluarse. El test ahora acepta las dos negativas y afirma lo único que
importa — que no salga ni una fila.

## Cómo se sabe que estos tests sirven

Seis mutaciones, cada una roja:

| mutación | qué se puso rojo |
|---|---|
| `.rpc(n)` con nombre variable sin declarar | el test 1, nombrando `route.ts:71` |
| borrar la entrada declarada de `comi/actions.ts` | los tests 1 y 2 |
| `.rpc("funcion_que_nadie_creo_jamas")` | el test 3, con el nombre |
| `grant insert` a `anon` sobre `households` | **nada** — la RLS igual rechazó |
| `grant insert` + `disable row level security` | el censo, con las 123 tablas |
| correr el "antes" contra la cadena **con** 0062 | 0 abiertas en vez de >20 |

La cuarta merece leerse dos veces: el permiso a secas no alcanzó para escribir,
porque la RLS es una segunda capa. Hizo falta apagar las dos para abrir la
brecha — y recién ahí el censo la vio.

## Lo que este documento NO afirma

- **Las 275 SECURITY DEFINER no tienen todas prueba de comportamiento.** De las
  doce que la 0062 redefinió, seis tienen oráculo antes/después en
  `cierre-seguridad.test.ts`; las otras seis están verificadas
  estructuralmente (todas usan `if <fila> is null or not <permiso>`), y así está
  declarado en ese archivo. Es una brecha conocida, escrita, no tapada.
- **Todo esto corre sobre PGlite**, no sobre el Postgres de Supabase. Los
  privilegios y la RLS son del mismo motor, pero el ensayo contra la instancia
  real sigue esperando staging (Launch Gate #19).
