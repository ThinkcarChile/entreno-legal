# Auditoría de PII en los logs (§50)

## Qué se buscó

Todo sitio de `web/src` que pueda IMPRIMIR datos de una familia en un archivo
que sobrevive a la aplicación. El barrido fue por `console.(log|error|warn|
info|debug)` y por cualquier logger — no hay ninguno: el proyecto no tiene
`pino`, `winston` ni nada parecido, así que el único destino posible era la
consola del proceso.

Los cinco tipos de dato que jamás pueden salir, por orden de daño:

1. Valores de laboratorio y biomarcadores.
2. Diagnósticos, condiciones declaradas y restricciones clínicas.
3. Notas médicas y contenido de documentos subidos (exámenes, boletas).
4. El detalle de una boleta: qué compró la familia, dónde y por cuánto.
5. Tokens, claves y URLs firmadas.

## Lo que se encontró

Cinco sitios en total. Tres en el servidor, dos en el navegador.

| # | sitio | qué imprimía | veredicto |
|---|---|---|---|
| 1 | `web/src/app/finanzas/boletas/actions.ts` · `uploadReceipt` | `errorRegistro: error.message` y `errorBorrado: retiro.error?.message` | **CORREGIDO** |
| 2 | `web/src/app/finanzas/boletas/actions.ts` · `archiveReceipt` | `error: retiro.error.message` | **CORREGIDO** |
| 3 | `web/src/app/health/actions.ts` · `uploadExam` | `errorRegistro: error.message` y `errorBorrado: retiro.error?.message` | **CORREGIDO** |
| 4 | `web/src/components/RegistroServiceWorker.tsx:46` | un texto fijo sobre el service worker | limpio, se deja |
| 5 | `web/src/components/RegistroServiceWorker.tsx:55` | la causa de un `register()` fallido | limpio, se deja |

### Por qué los tres primeros eran un defecto y no una molestia

Ninguno imprimía un valor de laboratorio *a propósito*. Los tres imprimían
`error.message`, y ahí está el problema: **un `error.message` no siempre es
nuestro**. Los mensajes que escribimos en las migraciones son inofensivos
("no autorizado", "esta reserva ya está liquidada"), pero cuando lo que falla es
una restricción de la base, el mensaje lo redacta PostgreSQL y trae la fila
adentro:

```
duplicate key value violates unique constraint "lab_observations_..."
DETAIL: Key (member_id, biomarker_id, value_numeric)=(…, …, 312.5) already exists.
```

En el módulo de salud eso es un valor de laboratorio escrito en el log de un
servidor compartido. Y el defecto de fondo no es lo que imprimían: es que
**nadie podía saber, leyendo la línea del `console.error`, si lo que iba a salir
era un id o el colesterol de alguien**. Una regla de estilo ("no imprimas PII")
no arregla eso, porque el que escribe la línea cree que está imprimiendo un
error, no un dato.

### Los dos del navegador se dejan, y por qué

`RegistroServiceWorker.tsx` corre en el cliente. Su `console.error` va a la
consola del navegador **de la persona dueña de esos datos**, no a un archivo del
servidor, y lo que imprime es un `DOMException` sobre el registro del service
worker: ni una fila de la base pasa por ahí. Borrarlos sería perder el único
aviso de que la app quedó sin pantalla de "sin conexión" — el modo de falla
silencioso que ese archivo existe para gritar.

## Lo que se hizo

Los tres sitios del servidor ya no llaman a `console.error`: llaman a
`registrarError` de `web/src/lib/observabilidad.ts`, que es un embudo con dos
cerrojos (ver ese archivo para el detalle y `observabilidad.test.ts` para las
afirmaciones):

1. **Lista negra de claves.** `mensaje`, `error`, `valor`, `nota`,
   `diagnostico`, `contenido`, `token`, `url`… no salen nunca, aunque quien
   llama insista. `errorRegistro` y `errorBorrado` caen las dos por `error`.
2. **Forma segura del valor.** Lo que sí sale tiene que parecer un identificador
   o un estado: uuid, código en mayúsculas, SQLSTATE, fecha ISO, ruta. Cualquier
   cosa con espacios —o sea, cualquier frase— se reemplaza por su largo. Un
   mensaje de PostgreSQL no pasa ese filtro ni disfrazado bajo una clave
   inocente como `detalle`.

Lo que sale ahora, y alcanza para arreglar el problema:

```json
{"nivel":"error","evento":"salud.examen.archivo_huerfano","ts":"2026-09-03T…",
 "bucket":"medical","ruta":"member/<uuid>/<uuid>.pdf","memberId":"<uuid>",
 "codigoRegistro":"23505","borrado":"NO_RETIRO_NADA"}
```

**Ids y estados, nunca contenido.** Para sacar el archivo huérfano hace falta la
ruta; para entender por qué falló, el SQLSTATE. El contenido no ayuda a nadie a
arreglar nada y sí puede terminar en el disco de un hosting compartido.

## Lo que queda abierto

1. **No hay una guarda que impida el próximo `console.error`.** Los cinco sitios
   están revisados hoy; nada evita que mañana aparezca el sexto. Una regla de
   ESLint (`no-console` con excepción para los dos del cliente) o un test que
   recorra `web/src` como hace `gate-error-contract.test.ts` cerraría eso. Es
   trabajo de v2: se anota acá para que no se pierda.
2. **Los mensajes que ve la persona SÍ traen `error.message`.** Por ejemplo
   `No se pudo registrar el examen: <mensaje>`. Eso NO es una filtración: se lo
   está mostrando a quien es dueño del dato, en su propia pantalla, y sirve para
   que entienda qué pasó. Pero conviene tenerlo dicho para que nadie lo confunda
   con el caso del log.
3. **Nadie recoge estos logs.** Van a stderr y ahí se quedan, con lo que dure el
   proceso. Qué se hace con ellos en el servidor propio está en
   `docs/deployment/observabilidad.md`.
