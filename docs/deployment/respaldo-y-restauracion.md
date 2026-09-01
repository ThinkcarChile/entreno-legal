# Respaldo y restauración

**Para el que llega apurado.** Producción tiene un hogar real: seis integrantes,
sus lotes de comida y sus fichas clínicas —exámenes de laboratorio, condiciones
y restricciones médicas—. Nada de eso se puede volver a escribir a mano.

---

## Se cayó la base. Qué hacer, en este orden

```bash
# 1. ¿Hay respaldo, y sirve? (no toca producción: restaura en un Postgres desechable)
node scripts/respaldo-restaurar.mjs ultimo

# 2. Si la base todavía responde, saca un respaldo del estado ACTUAL antes de tocar nada.
#    Aunque esté a medio romper: es la última foto de lo que había.
node scripts/respaldo.mjs

# 3. Ensaya el CAMINO REAL contra el destino de verdad, sin escribirle nada.
#    Le pregunta su esquema, sus permisos y sus cuentas, genera las sentencias
#    y las corre en un Postgres desechable para verificar que vuelven idénticas.
node scripts/respaldo-restaurar.mjs ultimo --destino supabase --en-seco

# 4. Restaurar de verdad — recién después de que 1 y 3 hayan dicho OK
node scripts/respaldo-restaurar.mjs ultimo --destino supabase --si-estoy-seguro --sobrescribir
```

Los pasos 1 y 3 imprimen al final una de dos frases. **No hay ambigüedad**:

- `ENSAYO OK` / `ENSAYO DEL CAMINO REAL OK` → el archivo sirve.
- `RESTAURACIÓN CON PROBLEMAS` → el archivo **no** sirve. Lee la lista de `✗`.

Si el paso 4 va a un **proyecto nuevo** (no al mismo), antes hay que preparar el
destino: ver [Restaurar en un proyecto nuevo](#restaurar-en-un-proyecto-nuevo).

---

## Los cuatro comandos

| Comando | Qué hace | ¿Toca producción? |
| --- | --- | --- |
| `node scripts/respaldo.mjs` | Saca el respaldo **y lo ensaya solo** | Sólo lee |
| `node scripts/respaldo-restaurar.mjs ultimo` | Ensayo: restaura en PGlite y verifica | No |
| `… --destino supabase --en-seco` | Ensayo del camino real: le pregunta a producción y genera las sentencias, pero las corre en un Postgres desechable | Sólo lee |
| `… --destino supabase --si-estoy-seguro --sobrescribir` | Restaura de verdad | **Sí: borra e inserta** |

`ultimo` toma el `.ndjson` más nuevo de `%USERPROFILE%\respaldos-mesa-familiar`.
También puedes pasar la ruta completa de un archivo.

Banderas útiles:

- `--salida D:\ruta` — otra carpeta de destino para el respaldo.
- `--sin-ensayo` — respalda sin ensayar. **No lo uses**: un respaldo que nadie
  probó restaurar todavía no es un respaldo.
- `--por-tabla` — una consulta por tabla. Sólo si la base creció tanto que ya no
  cabe en una sola consulta. Pierde la coherencia entre tablas y el archivo lo
  deja anotado.

---

## Dónde NO se puede guardar este archivo, y por qué

El `.ndjson` trae exámenes de laboratorio, condiciones médicas y restricciones
clínicas de **seis personas reales**. Es un dato de salud, no un dump cualquiera.

**Prohibido, y el script se planta solo si lo intentas:**

- **Dentro del repositorio.** Basta un `git add .` y queda publicado; de la
  historia de git ya no sale, y sigue en cada clon que alguien haya hecho.
- **OneDrive, Dropbox, Google Drive, iCloud, Box, Mega, pCloud.** Guardarlo ahí
  no es guardarlo: es subirlo a un servidor de un tercero que nunca acordó nada
  sobre datos de salud. En Windows pasa **sin avisar**, porque OneDrive redirige
  «Documentos» y «Escritorio» de fábrica. Por eso el script mira la ruta y se
  niega.

**Prohibido, y esto no lo puede vigilar ningún script — depende de ti:**

- Adjuntarlo a un correo, a WhatsApp o a un chat de soporte. «Te mando el dump
  para que lo mires» es una filtración.
- Subirlo a un bucket, a un pastebin, a un issue de GitHub o a un ticket.
- Dejarlo en un pendrive sin cifrar que anda en la mochila.
- Pasárselo a un modelo de IA para que «lo revise».

**Dónde sí:** la carpeta por defecto
(`%USERPROFILE%\respaldos-mesa-familiar`, que se crea con permisos 0700), o un
disco externo cifrado que no se sincronice con nada. Si algún día hay que
sacarlo de la casa, primero se cifra el archivo, y la clave viaja por otro
canal.

Los archivos se escriben con permisos `0600`. En Windows eso es poco más que una
buena intención: el control real es la carpeta y quién entra al equipo.

---

## Qué trae el respaldo y qué NO

**Trae**, en una sola foto coherente (una sola transacción, así que las tablas
calzan entre sí):

- Las 82 tablas de `public`, completas. Hoy son ~1.078 filas.
- De `auth.users`: **sólo** `id`, `email` y `created_at`.

**No trae, y está declarado en la cabecera del archivo:**

- **Los PDF del bucket `medical-documents`.** El respaldo guarda la *fila* de
  `lab_documents`, no el archivo del examen. Si hay documentos subidos, hay que
  bajarlos aparte desde Storage. El respaldo inventaría cuáles había; si no
  pudo leer el inventario, escribe `DESCONOCIDO` — que **no es cero**.
- **Las credenciales.** `auth.users` guarda hashes de contraseña y tokens de
  recuperación. Meter eso en un archivo que anda dando vueltas es un problema
  más grande que el que este respaldo viene a resolver. Consecuencia: restaurar
  en un proyecto nuevo **no devuelve las cuentas**; hay que crearlas de nuevo
  (ver más abajo).
- **El esquema.** La fuente de verdad del esquema son las migraciones del repo.
  El respaldo guarda el SHA-256 de cada una para saber contra cuál se sacó.

---

## Cómo se sabe que la restauración quedó bien

El ensayo no es «no salió error». Comprueba cinco cosas, y las cinco tienen
que pasar:

1. **El archivo está completo.** Termina con una línea `cierre` que trae el
   SHA-256 de todo lo anterior. Si el proceso murió a mitad, esa línea no está y
   el archivo se rechaza antes de tocar nada. Si alguien editó el archivo, el
   hash no calza y también se rechaza.
2. **El destino puede recibir la carga.** Antes de borrar una sola fila se le
   pregunta si permite apagar la integridad referencial (ver
   [más abajo](#por-qué-el-ensayo-en-pglite-no-puede-reemplazar-a-la-sonda-de-permisos)).
   Si no puede, se planta ahí, con la base todavía intacta.
3. **Conteo por tabla.** Las filas que salieron son las que entraron.
4. **Hash por tabla.** Se releen las filas restauradas con las mismas
   expresiones con que se leyeron, en el mismo orden (`collate "C"`, igual en
   todas partes), y el SHA-256 tiene que ser **idéntico**. Esto es lo que prueba
   que un `numeric(12,4)` de gramos y un `timestamptz` volvieron **exactos** y
   no «parecidos». Cuando hubo reenlace de cuentas, la comparación se hace
   contra las filas **ya reenlazadas**: antes esas tablas —`household_members`
   e `invitations`, las que llevan la identidad de la ficha clínica— se sumaban
   al conteo de «hash idéntico» sin haberse comparado nunca.
5. **Huérfanos.** Los datos se cargan con las llaves foráneas apagadas (ver
   abajo), así que después se recorren las 221 llaves foráneas del esquema
   contando filas que apunten a algo que no existe. Tiene que dar **0**. Si
   alguna no se alcanzó a mirar, se dice: no se cuenta como comprobada.

Además aplica encima las migraciones que estén pendientes, para probar que el
camino completo de recuperación funciona con los datos reales adentro.

---

## Qué está probado, exactamente

Esta sección existe porque durante una ronda entera el runbook presentaba
`--destino supabase` como un comando más de la tabla, y ese comando **nunca
había ejecutado una sola escritura en ninguna parte**. Lo que estaba probado era
el ensayo en PGlite, que es un camino **distinto**: no reenlaza cuentas, filtra
otras llaves foráneas y restaura `auth.users` en vez de dejarla en manos de
Supabase Auth. Un respaldo cuya restauración real nadie probó no es un respaldo:
es un archivo.

| Qué | Cómo se prueba | Estado |
| --- | --- | --- |
| El archivo está completo y no fue alterado | `respaldo-camino-real.test.ts`, §7 | Automatizado |
| Los datos vuelven idénticos (hash por tabla) | Ensayo en PGlite + el test, §1 | Automatizado |
| El **camino real** completo: reenlace de cuentas, borrado, insert, relectura, hashes y huérfanos | El test corre `respaldo-nucleo.mjs` en `modo: "real"`, `seco: false`, escribiendo de verdad contra un Postgres desechable | Automatizado |
| Que una tabla reenlazada que vuelve distinta se caza | El test la ensucia a propósito entre el insert y la verificación | Automatizado |
| Que el destino permite `set session_replication_role` | El motor **lo pregunta** antes de borrar nada; `--en-seco` lo pregunta contra producción | Comprobado en producción el 2026-09-01: rol `postgres`, `is_superuser = off`, y el SET **sí** toma efecto |
| Que producción recibe este respaldo (esquema, cuentas) | `--destino supabase --en-seco` | Comprobado, y repetible sin riesgo |
| Que la **base viva** aguanta la escritura de verdad | Nada lo prueba | **NO PROBADO** — ver abajo |

### Lo que sigue sin probarse, y por qué no se va a probar

La escritura real sobre la base de la familia **no se ensaya**: el único ensayo
posible sería borrarla y volver a cargarla, y eso es exactamente el accidente
del que este respaldo protege. Lo que queda fuera de toda red:

- Cuota de disco del proyecto y tamaño máximo de la sentencia que acepta la
  Management API con la base llena.
- Tiempo total: hoy son 82 sentencias, una llamada HTTP cada una.
- Cualquier disparador o extensión que exista en Supabase y no en PGlite.

Si algo de eso falla, falla **a mitad de la carga**, con la base ya borrada. Por
eso el paso 2 del runbook (sacar un respaldo del estado actual antes de tocar
nada) no es opcional: es lo único que queda si la restauración se cae por la
mitad.

### Por qué el ensayo en PGlite no puede reemplazar a la sonda de permisos

`set session_replication_role = replica` es un parámetro de contexto de
superusuario. PGlite corre como superusuario, así que **ahí siempre da verde,
por construcción**. La Management API de Supabase corre como `postgres`, que
`is_superuser = off`. Si ese SET no estuviera permitido, la carga abortaría en
la primera tabla — el día del desastre, con la base ya borrada.

Por eso el motor lo **pregunta** (sube el parámetro, lo lee de vuelta y lo
devuelve a `origin`) antes del primer `delete`, y no asume que sí. Leerlo de
vuelta importa: un SET que no falla y tampoco toma efecto sería el peor de los
casos, porque la carga entraría con las llaves foráneas vivas.

### Por qué se cargan los datos con las FK apagadas

Este esquema tiene un ciclo real: `meal_templates` apunta a
`meal_template_versions` y `meal_template_versions` apunta de vuelta a
`meal_templates`. **No existe un orden de inserción que funcione.** Se carga
como lo hace `pg_restore`: `session_replication_role = replica`, que apaga los
disparadores de integridad referencial mientras entran los datos.

Lo que **sigue activo** durante la carga: llaves primarias, índices únicos y
`CHECK`. Esos no son disparadores. Lo único que se apaga son las FK, y por eso
se comprueban a mano después (punto 4).

---

## Restaurar en un proyecto nuevo

El orden importa y no es el obvio.

1. **Crea el proyecto** en Supabase y pon su URL en `.env.deploy`
   (`NEXT_PUBLIC_SUPABASE_URL=...`). El token de la Management API ya vive ahí y
   **nunca se imprime**.

2. **Aplica las migraciones hasta el nivel del respaldo, no más.** El ensayo te
   dice cuál es y **de dónde sacó ese número**:

   ```
   Base de ensayo: 36 migraciones, hasta 0037_invitacion_no_cruza_hogares.sql.
     Nivel elegido por: libro-de-produccion.
   ```

   Ese `Nivel elegido por` importa y hay que leerlo:

   - `libro-de-produccion` → salió de `supabase/estado-produccion.json`, que se
     llena preguntándole a la base **real** por un testigo de cada migración. Es
     la respuesta buena.
   - `calce-de-esquema` → salió de aplicar migraciones y comparar columnas. Es
     una **pista**, no una respuesta: 0033, 0034 y 0035 no cambian ninguna
     columna, así que las tres «calzan» con el mismo respaldo. Cuando hay
     empate se elige la **primera** y el ensayo lo dice en voz alta. Equivocarse
     hacia atrás se arregla después; hacia adelante, no (ver más abajo).
   - `sin-calce` → **ningún** punto de la cadena reproduce el esquema del
     respaldo. No sigas sin entender por qué.

   ```bash
   node scripts/aplicar-migracion.mjs 0001_family.sql
   # … una por una, hasta la que dijo el ensayo
   ```

   **El orden NO es el numérico.** La `0037` va **antes** que la `0036` en este
   repo. La secuencia buena está escrita en un solo lugar —`MIGRACIONES` en
   `web/src/integration/harness.ts`— y es la que usa el ensayo. No la deduzcas
   ordenando nombres de archivo.

3. **Crea las cuentas** en Supabase Auth **con los mismos correos** que tenían.
   El restaurador reenlaza `household_members.user_id` e
   `invitations.accepted_by` por correo y **imprime cada reenlace**. Si falta
   alguna cuenta, se detiene y te dice cuál: restaurar sin resolverla dejaría
   una ficha médica colgando de nadie.

4. **Ensaya el camino real contra ese proyecto, sin escribirle nada.**

   ```bash
   node scripts/respaldo-restaurar.mjs ultimo --destino supabase --en-seco
   ```

   Comprueba las tres cosas que sólo se pueden saber preguntándole al destino
   de verdad: que su esquema recibe este respaldo, que deja apagar las llaves
   foráneas para cargar, y que **todas** las cuentas están creadas. Después
   corre las sentencias que generó para él en un Postgres desechable y verifica
   que los datos vuelven idénticos.

5. **Carga los datos.**

   ```bash
   node scripts/respaldo-restaurar.mjs ultimo --destino supabase --si-estoy-seguro --sobrescribir
   ```

6. **Recién ahora, las migraciones posteriores** (las que el ensayo listó como
   «quedan fuera»), una por una con `aplicar-migracion.mjs`.

7. **Sube de nuevo los archivos** del bucket `medical-documents`. No están en el
   respaldo.

8. **Comprueba en la app**: que cada integrante ve su ficha y **nada** de la
   ajena.

### Por qué las migraciones nuevas van al final y no al principio

Porque si van al principio, la carga **no puede correr**, y eso está bien.

La `0038` agrega `consumption_logs.source` obligatoria, rellena las filas
existentes con un valor declarado, y después **le quita el default a propósito**
para que nadie vuelva a escribir un consumo sin decir de dónde salió. Meter
filas de *antes* de la 0038 en un esquema de *después* obligaría a inventarles
un `source` que nadie declaró — justo lo que esa migración vino a impedir.

Por eso el restaurador se planta con `EL DESTINO VA MÁS ADELANTE QUE EL
RESPALDO` en vez de rellenar el hueco solo. El esquema del respaldo primero, los
datos, y las migraciones nuevas al final: ellas traen su propio relleno
declarado para las filas viejas.

---

## Programarlo

El respaldo es un comando de línea, así que se agenda como cualquier otro. Tiene
que correr en un equipo que tenga **el repo** y **`.env.deploy`**.

Windows, todos los días a las 03:00:

```powershell
schtasks /create /tn "Respaldo mesa-familiar" /sc daily /st 03:00 /f `
  /tr "cmd /c cd /d C:\Users\franc\entreno-legal && node scripts\respaldo.mjs >> %USERPROFILE%\respaldos-mesa-familiar\bitacora.txt 2>&1"
```

Dos cosas que no son opcionales:

- **Mira la bitácora.** Un respaldo automático que falla en silencio durante tres
  semanas es peor que no tener ninguno: crees que estás cubierto. El script
  termina con código distinto de cero cuando algo sale mal, y siempre ensaya la
  restauración antes de darse por bueno.
- **Borra los viejos a mano, con criterio.** Todavía no hay rotación automática.
  Cada archivo son ~750 KiB con datos clínicos adentro: no se acumulan «por si
  acaso» en cualquier carpeta.

---

## Los mensajes de error, traducidos

| Lo que dice | Qué pasó | Qué haces |
| --- | --- | --- |
| `NO TIENE LÍNEA DE CIERRE: está TRUNCADO` | El respaldo se cortó a mitad | Corre `respaldo.mjs` de nuevo. Ese archivo no sirve |
| `NO CALZA CON SU PROPIO HASH` | El archivo cambió después de crearse | No lo restaures. Usa otro respaldo |
| `no es JSON: el archivo está corrupto` | Archivo dañado o cortado | Igual que arriba |
| `EL DESTINO NO PUEDE RECIBIR ESTE RESPALDO: le falta esquema` | Al destino le faltan tablas o columnas | Aplica las migraciones que le falten |
| `EL DESTINO VA MÁS ADELANTE QUE EL RESPALDO` | El destino tiene columnas obligatorias posteriores al respaldo | Ver [el orden de arriba](#por-qué-las-migraciones-nuevas-van-al-final-y-no-al-principio) |
| `Hay cuentas del respaldo que NO existen en el proyecto destino` | Faltan cuentas en Supabase Auth | Créalas con el mismo correo y repite |
| `los datos VOLVIERON DISTINTOS` | Una tabla no volvió idéntica | **No confíes en ese respaldo.** Compara los hashes que imprime |
| `Llave foránea X: N fila(s) apuntan a algo que no existe` | El respaldo estaba incompleto | Ídem |
| `El proyecto destino YA TIENE DATOS` | Ibas a pisar datos vivos | Si es a propósito, agrega `--sobrescribir` |
| `El inventario de Storage quedó DESCONOCIDO` | No se pudo leer el bucket | **No asumas cero.** Míralo en el panel de Supabase |
| `HALLAZGO: la migración pendiente X no aplica` | El respaldo está bien; la migración está rota | Arréglala **antes** de aplicarla en vivo |
| `NO SE PUEDE APAGAR LA INTEGRIDAD REFERENCIAL EN ESTE DESTINO` | El rol del destino no puede hacer el SET que la carga necesita | Restaura con `psql` como dueño de la base (la cadena directa del panel), no por la Management API |
| `Hay columnas que apuntan a una cuenta que el respaldo NO conoce` | El archivo se sacó con `--por-tabla` y no es una foto coherente | Saca uno nuevo sin esa bandera |
| `El respaldo no trae el bloque auth.users` | Archivo incompleto | No lo uses: cero cuentas y «no hacía falta reenlazar» no son lo mismo |

---

## Lo que este respaldo todavía no resuelve

Dicho acá para que nadie se confíe de más:

- **La escritura sobre la base viva nunca se ejecutó.** Todo lo que se prueba
  del camino real se prueba contra un Postgres desechable. Ver
  [Qué está probado, exactamente](#qué-está-probado-exactamente).
- **Los binarios de Storage.** Hay que bajarlos a mano. Hoy el bucket está
  vacío, pero el día que tenga exámenes en PDF esto deja de ser un detalle.
- **Rotación y retención.** Los archivos se acumulan hasta que alguien los borre.
- **Respaldo fuera de la casa.** Todo vive en un solo equipo. Un incendio o un
  robo se lleva la base y el respaldo juntos. Para arreglarlo hay que cifrar el
  archivo y recién ahí sacarlo a otra parte — no antes.
- **`--por-tabla` no es una foto coherente.** Cada tabla se lee en un momento
  distinto. Sirve como salida de emergencia si la base creció, pero el archivo
  queda marcado y hay que saberlo.
- **El `--en-seco` no reserva nada.** Entre el ensayo y la carga de verdad
  alguien puede borrar una cuenta o aplicar una migración en el destino. El
  motor vuelve a comprobar todo en la corrida real; el ensayo no es un permiso
  con vencimiento.

---

## Archivos

- `scripts/respaldo.mjs` — saca el respaldo y lo ensaya.
- `scripts/respaldo-restaurar.mjs` — **sólo la línea de comandos**: argumentos,
  destinos, mensajes y código de salida.
- `scripts/respaldo-nucleo.mjs` — **el motor**: borra, inserta, verifica hashes
  y cuenta huérfanos. No sabe nada de `argv` y no llama a `process.exit`. Está
  separado justamente para que una prueba pueda correr el camino real completo.
- `scripts/respaldo-lib.mjs` — lo compartido: credenciales, expresiones de
  lectura y escritura, armado del archivo, hashes, guardas de destino.
- `web/src/integration/respaldo-camino-real.test.ts` — la red de seguridad:
  34 pruebas, incluida la del camino real escribiendo de verdad.
