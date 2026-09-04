# La app no necesita ninguna RPC anónima

Corte: **2026-09-04**. Producción: 61 migraciones aplicadas, 0 pendientes.

**ANONYMOUS_RPC_REQUIRED = FALSE.**

La prueba más fuerte no es este documento: la 0062 **ya está aplicada en
producción** y la aplicación funciona. Si alguna ruta necesitara una RPC sin
sesión, estaría rota en este momento. Lo que sigue explica por qué eso no es
suerte, y qué queda puesto para que siga siendo cierto.

## Lo que la 0062 cambió, medido

Misma cadena, cortada antes y después:

| | SECURITY DEFINER | ejecutables por `anon` | `usage` sobre `app` |
|---|---|---|---|
| cadena hasta **0061** | 275 (134 en `public` + 141 en `app`) | **268** (133 + 135) | `true` |
| cadena hasta **0062** | 275 | **0** | `false` |

Tres números distintos han circulado para lo mismo — 262 en el Launch Gate, 269
en el commit del despliegue, 268 acá — y conviene decir por qué en vez de elegir
uno: **cuentan conjuntos distintos**. Éste cuenta `public` **más** `app` sobre la
cadena replayada en PGlite. Los otros dos se midieron contra producción, donde
el esquema `public` también aloja funciones que no vienen de estas migraciones.
Ninguno contradice a los otros; los tres terminan en **cero**.

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

`web/src/integration/inventario-rpc.test.ts`, 13 pruebas. No es un framework:
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

## §10 — Compatibilidad: `authenticated` no perdió nada

Un endurecimiento que además cierre algo a quien **sí** tiene sesión rompe
pantallas, y eso se descubriría en producción con la familia adentro.

Se compara la lista completa de RPC ejecutables por `authenticated` sobre las dos
cadenas —hasta 0061 y hasta 0062— nombre por nombre: **las 82, idénticas**. El
otro test afirma que después están todas abiertas; éste afirma que ninguna se
abrió de más, que es el modo de falla contrario.

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

Siete mutaciones, cada una roja:

| mutación | qué se puso rojo |
|---|---|
| `.rpc(n)` con nombre variable sin declarar | el test 1, nombrando `route.ts:71` |
| borrar la entrada declarada de `comi/actions.ts` | los tests 1 y 2 |
| `.rpc("funcion_que_nadie_creo_jamas")` | el test 3, con el nombre |
| `grant insert` a `anon` sobre `households` | **nada** — la RLS igual rechazó |
| `grant insert` + `disable row level security` | el censo, con las 123 tablas |
| correr el "antes" contra la cadena **con** 0062 | 0 abiertas en vez de >20 |
| quitarle a `authenticated` **un solo** `grant` | la comparación de §10, 81 contra 82 |

La cuarta merece leerse dos veces: el permiso a secas no alcanzó para escribir,
porque la RLS es una segunda capa. Hizo falta apagar las dos para abrir la
brecha — y recién ahí el censo la vio.

## §11 — Lo que se encontró mirando el esquema interno

El esquema `app` guarda las funciones que no son API: guardas, conversiones,
comprobaciones de permiso. La 0062 le quitó a `anon` el `usage` sobre él, que es
lo que cierra las funciones que se escriban mañana.

**`authenticated` sí lo tiene**, y con él llega a `app.event_actual_gate`
directamente. Se descubrió porque un test escrito para afirmar lo contrario
—"es interna, nadie la alcanza, por eso no necesita oráculo"— salió rojo al
medirlo.

No es una brecha: para ser `authenticated` hay que tener sesión, y las funciones
de `app` comprueban pertenencia igual. Pero cambia quién tiene que probarlas.
"Es interna" dejó de ser una razón válida para no darle oráculo, y por eso la
doceava está ahora en la tabla como las demás.

## §12 — Las doce redefinidas, todas con oráculo

`cierre-seguridad.test.ts`, 19 pruebas. Once en una tabla que compara, actuando
como el hogar B: un id **real del hogar A** contra un id **inventado**. Las dos
respuestas tienen que ser idénticas, y ninguna puede ser "no lanzó".

| función | con qué id ajeno se prueba |
|---|---|
| `set_event_status`, `event_menu_blocks`, `save_event_estimate_revision` | evento de A |
| `record_event_attendance`, `record_event_guest_observation` | participante de A |
| `generate_shopping_revision` | lista de A |
| `create_draft_from_version` | versión de receta de A |
| `reconcile_purchase` | compra de A |
| `set_supplier_product_price` | producto de proveedor de A |
| `assistant_usage_settle` | traza de asistente de A |
| `app.event_actual_gate` | evento de A |

La doceava, `apply_clinical_shopping_delta`, tiene test propio: su fuga no era un
mensaje distinto sino un `status` clínico **devuelto sin error** a quien
adivinara un uuid.

Seis de estas no tenían prueba de conducta hasta hoy, y el motivo escrito era que
sembrar una compra, un producto de proveedor y una traza exigía un fixture de
hogar completo. Resultó ser cinco `insert` de columnas escalares. **El hueco
estaba declarado en el archivo**, y eso es lo único que permitió volver a él.

### Que estos oráculos sirven, comprobado

Se reintrodujo la fuga en `set_supplier_product_price` sobre una base
descartable —dos mensajes distintos para las dos formas de "no"— y la comparación
la vio:

```
AJENO:     no autorizado
INVENTADO: esa presentacion no existe
```

Con la forma de la 0062, las dos dicen `no autorizado`.

## Lo que este documento NO afirma

- **Las 275 SECURITY DEFINER no tienen todas prueba de comportamiento.** Las
  doce que la 0062 redefinió sí (arriba). Las otras 263 no se tocaron en esa
  migración: se les revocó el `EXECUTE` a `anon` y nada más. Su conducta la
  cubren los tests de sus propios encargos, no este.
- **Todo esto corre sobre PGlite**, no sobre el Postgres de Supabase. Los
  privilegios y la RLS son del mismo motor, pero el ensayo contra la instancia
  real sigue esperando staging (Launch Gate #19).
