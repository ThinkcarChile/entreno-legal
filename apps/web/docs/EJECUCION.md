# Ejecución del trabajo: del pago confirmado a la aprobación

Guía del recorrido que empieza cuando el dinero ya está confirmado y termina
cuando el cliente aprueba. Complementa `PAGOS.md` (que cubre el dinero hasta la
confirmación) y `ARQUITECTURA.md` §9.

> **Lo que aquí no ocurre:** ninguna transferencia bancaria y ningún reembolso.
> Un pago al trabajador «transferido» solo existe cuando una persona del equipo
> registró la operación con su referencia. Una devolución resuelta en una
> disputa queda anotada, no ejecutada. Eso es de la Etapa 4, con el proveedor de
> pago integrado.

---

## 1. Los estados, sin vocabulario nuevo

El esquema ya tenía los estados que hacían falta desde la Etapa 1. No se añadió
ninguno: se llenó el recorrido que los usa.

| Momento del producto | `jobs.status` | `assignments.status` |
|---|---|---|
| Pagado y listo | `PAID` | `CONFIRMED` |
| En camino | `PAID` | `ON_THE_WAY` |
| En el lugar | `PAID` | `CHECKED_IN` |
| En curso | `IN_PROGRESS` | `IN_PROGRESS` |
| Finalización pendiente | `HANDOFF_COMPLETED` | `HANDOFF_COMPLETED` |
| Aprobado | `COMPLETED` | `COMPLETED` |
| En disputa | `DISPUTED` | (el que tuviera) |
| Cerrado | `CLOSED` | — |

Las transiciones válidas viven en `src/lib/domain/state-machines.ts` y su copia
literal en `app_private.guard_assignment_transitions`. `npm run db:contract` las
compara en cada ejecución: si una cambia y la otra no, falla.

Lo nuevo son tres enumeraciones pequeñas, para el check-in y la evidencia:
`check_in_result` (`VERIFIED`, `OUT_OF_RANGE`, `LOW_ACCURACY`, `NO_LOCATION`),
`check_in_review` (`NOT_REQUIRED`, `PENDING`, `APPROVED`, `REJECTED`) y
`evidence_visibility` (`PARTICIPANTS`, `ADMIN_ONLY`), más siete valores de
`notification_type`.

---

## 2. La matriz de acciones

`src/lib/domain/permissions.ts` es la única fuente de qué puede hacer cada
parte. Recibe los hechos —rol, estado del trabajo, estado de la asignación,
estado del pago, si hay disputa abierta, si hay una extensión esperando, si hay
un check-in válido— y devuelve un objeto con una decisión por acción.

La interfaz pregunta ahí y nada más. Antes cada pantalla encadenaba sus propias
condiciones, y cuando esas condiciones divergen aparecen las dos formas de error
que peor se ven: un botón que no hace nada y una acción válida escondida.
Ninguna de las dos la detecta el compilador.

**No es una frontera de seguridad.** Cada acción se vuelve a comprobar en la
base, dentro de una función `SECURITY DEFINER` que mira quién llama y bajo qué
bloqueo. La matriz decide qué se **muestra**; la base decide qué se **permite**.

Resumen de quién puede qué, cuando el trabajo está vivo y pagado:

| Acción | Trabajador | Cliente | Tercero |
|---|---|---|---|
| Voy en camino | sí, desde `CONFIRMED` | no | no |
| Check-in | sí, y se puede repetir | no | no |
| Comenzar | sí, con check-in válido | no | no |
| Actualización o evidencia | sí | sí | no |
| Pedir más tiempo | sí, en curso y sin otra pendiente | no | no |
| Responder al tiempo extra | no | sí, una sola vez | no |
| Generar y ver el PIN | no | sí | no |
| Validar el PIN | sí | no | no |
| Pedir la finalización | sí | no | no |
| Aprobar | no | sí | no |
| Abrir disputa | sí | sí | no |
| Reseñar | sí, tras aprobar | sí, tras aprobar | no |

Un tercero no ve la dirección exacta, ni la evidencia, ni el chat, ni el PIN, ni
la disputa, y no puede ejecutar ninguna acción. Lo impone RLS, y lo comprueban
`E09` en local y `W10`–`W11` contra el proyecto alojado.

---

## 3. Check-in: privacidad de la ubicación

El consentimiento es explícito y se guarda con el hecho. La pantalla lo dice
antes de pedir nada:

> Usaremos tu ubicación únicamente para comprobar tu llegada a este trabajo.

La ubicación se pide **solo tras pulsar el botón**, nunca al cargar la página.

### Dónde vive cada dato

| Dato | Dónde | Quién lo ve |
|---|---|---|
| Latitud, longitud, precisión, origen | `assignment_check_ins` | El propio trabajador y la administración |
| Resultado, distancia, estado de revisión | `assignment_check_ins` y la vista `checkins` | Idem |
| «Llegada registrada · verificada a 40 m» | `job_evidence` (línea de tiempo) | Cliente y trabajador |

El cliente **no** ve el punto. Ve que la llegada se verificó y a cuántos metros.
Las columnas `lat`, `lng` y `accuracy_m` que `job_evidence` heredaba de la
Etapa 1 dejaron de ser legibles para cualquier usuario con sesión: el `SELECT`
de tabla se revocó y se concedió columna a columna.

Las coordenadas no aparecen en perfiles, tarjetas públicas, URLs, mensajes
automáticos ni notificaciones. `E07` y `W04` lo comprueban.

### Tolerancias, en un solo sitio

`platform_settings.check_in_radius_m` (300 m por defecto) y
`check_in_max_accuracy_m` (250 m). Ningún componente las lleva escritas.

### Qué pasa cuando no cuadra

| Situación | Resultado | Consecuencia |
|---|---|---|
| Dentro del radio y con precisión suficiente | `VERIFIED` | Se puede comenzar |
| Lejos del lugar | `OUT_OF_RANGE` | Queda en revisión, no se puede comenzar |
| Precisión insuficiente | `LOW_ACCURACY` | Idem |
| Sin ubicación (negada, no disponible) | `NO_LOCATION` | Idem |

Se puede **reintentar**: cada intento deja su fila, y basta uno verificado.
También se puede adjuntar una foto y pedir revisión: la administración aprueba o
rechaza con motivo escrito desde `/admin/check-ins`, y eso desbloquea el inicio.
Nunca se falsifica un check-in exitoso.

> **Esto no evita del todo un GPS falseado.** Un teléfono puede mentir su
> posición. Lo que da es un registro con hora del servidor, una distancia
> calculada contra la dirección real y una vía de revisión manual. Se dice así
> en la pantalla de administración, no solo aquí.

---

## 4. Tiempo del trabajo

`assignments.started_at` y `expected_end_at` los escribe el servidor.
`expected_end_at` = inicio real + duración acordada + extensiones aceptadas.

El contador de la pantalla se reconstruye desde esas marcas en cada render y en
cada recarga. No se guarda en React: si el estado viviera solo ahí, recargar la
página haría que el trabajo pareciera empezar de nuevo, y ese número acaba
delante de alguien que discute una hora.

---

## 5. Línea de tiempo y auditoría, separadas

Son dos cosas distintas y se mantienen distintas:

- **`job_evidence`** es la línea de tiempo de los participantes. Append-only,
  sin `UPDATE` ni `DELETE` para nadie con sesión, y desde el Bloque 3 tampoco
  con `INSERT`: entra por `add_job_evidence`, que rechaza los tipos reservados
  al sistema. Antes, con el privilegio de columna, cualquier participante podía
  escribir un hito falso de tipo `SYSTEM` o `HANDOFF`.
- **`audit_logs`** es la bitácora interna. Solo la lee la administración, y
  desde el Bloque 3 tampoco se puede alterar ni borrar por falta de privilegio,
  no solo por falta de política.

Cada hito lleva un `event_key` (`on_the_way`, `check_in`, `work_started`,
`handoff_verified`, `completion_requested`, `completion_approved`…) con índice
único por asignación: **repetir una acción no duplica la línea de tiempo**.
`E25` y la carrera `X12` lo comprueban.

---

## 6. Evidencia y Storage

La subida es **del servidor**, no del navegador. La diferencia importa: aquí se
miran los primeros bytes del archivo antes de guardarlo, y no solo lo que el
navegador dice que es. Un ejecutable renombrado a `.jpg` declara `image/jpeg` en
el formulario; su firma, no.

| Control | Cómo |
|---|---|
| Formatos | JPG, PNG, WebP y PDF. **SVG queda fuera**: es un documento que puede llevar script |
| Tipo real | Se comprueban las firmas de los primeros bytes (`validateEvidence`) |
| Tamaño | 8 MB por archivo, en el cliente, en el servidor y en `platform_settings` |
| Cantidad | Máximo por asignación, en `platform_settings` |
| Nombre | Lo genera la aplicación: `<usuario>/<asignación>/<uuid>.<ext>`. La extensión sale del tipo, nunca del nombre original |
| Path traversal | Se rechaza cualquier ruta con `..` o que no empiece por el identificador de quien sube |
| Sobrescritura | `upsert: false`, y la política de Storage exige que la primera carpeta sea la propia |
| Lectura | Bucket privado. Se abre con URL firmada de 60 segundos, emitida solo si quien pregunta puede leer la fila con SU sesión |
| Huérfanos | Si la fila no se registra, el archivo subido se retira |

La política `evidence_read` se corrigió: antes solo dejaba leer al autor del
archivo, así que el cliente veía en la línea de tiempo que había una fotografía
y no podía abrirla. Ahora alcanza también a los participantes del trabajo, por
la fila de `job_evidence` que referencia esa ruta. Lo mismo para
`dispute-files`.

No se guardan URLs públicas de archivos privados: una dirección permanente a un
archivo privado deja de ser privada en cuanto alguien la copia.

---

## 7. Extensiones de tiempo

El trabajador propone, el cliente decide.

- Solo con el trabajo **en curso** y sin otra solicitud pendiente.
- Bloques de 15 minutos, entre 15 y `extension_max_minutes` (480 por defecto).
- El importe lo calcula la base desde la tarifa acordada, prorrateada. Si
  llegara del navegador sería editable.
- La solicitud vence sola (`extension_window_minutes`, 120 minutos).
- La respuesta es **definitiva**: aceptar y rechazar a la vez deja una sola
  respuesta, y la carrera `X10` lo repite cinco veces.
- **El acuerdo original no cambia.** `agreed_duration_minutes` y `agreed_total`
  siguen siendo los mismos; los minutos concedidos se acumulan aparte en
  `extension_minutes`.

Aceptar crea un pago **separado** con `purpose = 'EXTENSION'`, en `PENDING`. El
cliente lo paga por el mismo recorrido que el pago protegido
(`start_extension_payment`). Hasta que ese cobro se confirma, no sube nada.

Cuando se confirma, lo único que ocurre es que el pago al trabajador aumenta:
importe y comisión se suman al payout existente. No habilita nada, no cambia el
estado del trabajo y no crea un payout nuevo. Hizo falta darle su propia rama en
`guard_payment_settlement`: sin ella, un cobro de extensión sobre un trabajo ya
en curso caía en «confirmación tardía» y terminaba marcado para devolución.

Defecto real que se cerró aquí: `job_extensions` tenía `UPDATE` concedido sobre
todas sus columnas y una política que dejaba pasar a cualquier participante. El
trabajador podía aceptar su propia extensión, o cambiarle el importe a una ya
aceptada.

---

## 8. Código de entrega

Es la prueba de que las dos personas estuvieron en el mismo lugar al mismo
tiempo. Por eso el cliente lo ve y el trabajador lo escribe, nunca al revés.

| Regla | Cómo |
|---|---|
| Se genera en el servidor | `generate_handoff_code`, solo el cliente, y solo con el trabajo en curso |
| Se lee por función | `get_handoff_code`, solo el cliente. `handoff_codes` dejó de tener política de lectura: el PIN no sale por una consulta a la tabla |
| Caduca | 12 horas |
| Intentos | 5. **Solo los fallos consumen intento** |
| Un solo uso | Un código validado no vuelve a servir |
| Regenerable | Un código vencido se puede volver a generar. Antes era imposible: `on conflict do update set code = code` conservaba el código y no tocaba la expiración, así que la entrega quedaba bloqueada para siempre |
| No viaja | No aparece en el chat, ni en las notificaciones, ni en la bitácora de auditoría |

Validarlo deja la asignación en `HANDOFF_COMPLETED` y escribe el hito
`handoff_verified`. Dos validaciones simultáneas del mismo código dejan una sola
entrega, un solo hito y cero intentos gastados: es la carrera `X11`.

---

## 9. Finalización en dos pasos

Pedirla y aprobarla son acciones distintas, de personas distintas:

1. El trabajador pide el cierre (`request_job_completion`), o valida el PIN.
   La asignación pasa a `HANDOFF_COMPLETED`. **El pago no se libera.**
2. El cliente revisa el tiempo, la línea de tiempo, el check-in, la evidencia,
   las actualizaciones, la extensión, el precio, el bono y el PIN.
3. El cliente aprueba (`approve_job_completion`). Y solo entonces, en una
   transacción: asignación `COMPLETED`, trabajo `COMPLETED`, `completed_at`,
   `dispute_deadline_at` = ahora + `dispute_window_hours`, el payout pasa a
   `APPROVED`, se avisa a las dos partes y se recalculan las métricas del
   trabajador.

Sin esa separación, «terminé» y «me pagan» serían la misma acción decidida por
una sola parte.

El bono es una decisión del cliente al aprobar: si el objetivo no se cumplió, el
bono sale del payout. Aprobar dos veces no cambia nada (`E18`), y con una
disputa abierta no se puede aprobar (`E22`).

`dispute_deadline_at` no lo escribía nadie hasta ahora, así que la ventana de
reclamo no se aplicaba en ninguna parte.

---

## 10. Disputas

| Momento | Qué ocurre |
|---|---|
| Abrir (`open_dispute`) | El payout pasa a `HELD`, el trabajo a `DISPUTED`, se avisa a las dos partes. El cliente ya no puede aprobar |
| Pruebas (`add_dispute_evidence`) | Texto, archivo o las dos cosas, con las mismas validaciones que la evidencia del trabajo |
| Resolver (`resolve_dispute`) | **Solo la administración.** Exige motivo escrito |

Resultados y su efecto sobre el pago al trabajador:

| Resolución | Payout | Devolución al cliente |
|---|---|---|
| `WORKER_WINS` | `APPROVED`, neto completo | ninguna |
| `CLIENT_WINS` | `CANCELLED`, neto 0 | la que se indique |
| `PARTIAL` | `APPROVED`, neto menos el importe devuelto | la que se indique |

El importe a devolver queda en `disputes.refund_amount`. **El pago del cliente
sigue en `PAID`**: el dinero se cobró de verdad, y mover ese estado borraría el
hecho y rompería el invariante «un payout se apoya en un pago confirmado», que
es justo el que protege al trabajador en una resolución parcial. La cola de
devoluciones son las disputas resueltas con importe pendiente.

Defectos reales que se cerraron: `dispute_evidence` tenía política de `INSERT` y
ningún privilegio, así que nadie podía aportar una prueba; y
`hold_payout_on_dispute` forzaba `jobs.status = 'DISPUTED'` sin mirar el estado
previo, de modo que sobre un trabajo ya cancelado chocaba con
`guard_job_terminal` y tumbaba la apertura entera.

Abrir una disputa tampoco era una acción: era un `INSERT` directo con columnas
concedidas, y bastaba añadir `status` y `resolution` para insertarla ya resuelta
a favor de quien la abría. Ese `INSERT` ya no existe.

---

## 11. Reseñas y reputación

Reseñar es una función (`submit_review`), no un `INSERT`. Reglas:

- solo con el trabajo **aprobado**;
- una por persona y asignación;
- sin autorreseña: el sujeto lo calcula la base desde la asignación;
- puntuaciones de 1 a 5 en las cuatro dimensiones.

Las métricas del trabajador se **calculan**, no se escriben: nadie tiene
privilegio para tocar esas columnas.

| Métrica | De dónde sale |
|---|---|
| Nota media y número de reseñas | `reviews` no ocultas (`refresh_worker_reputation`) |
| Trabajos completados, minutos trabajados | asignaciones `COMPLETED` |
| Cancelaciones | asignaciones `CANCELLED_BY_WORKER` |
| Cumplimiento | completados ÷ (completados + cancelados por él) |
| Puntualidad | de los completados con llegada registrada, en cuántos llegó antes de la hora de inicio |

Hasta el Bloque 3, todas menos las tres primeras se quedaban en cero para
siempre. El Índice de Confianza se deriva de estas cifras en la aplicación
(`src/lib/reputation/`), no en la base: ahí vive una sola vez.

---

## 12. Ganancias y pago al trabajador

`/mis-trabajos/ganancias` lee la vista `worker_earnings`, que es
`security_invoker`: manda la RLS de `payouts`, así que nadie ve las de otro
aunque la consulta no filtre.

| Estado | Qué significa |
|---|---|
| `PENDING` | El cliente todavía no aprueba |
| `APPROVED` | Aprobado, listo para transferir |
| `HELD` | Retenido: hay una disputa o una retención manual |
| `PROCESSING` → `PAID` | Transferido, con su referencia bancaria |
| `CANCELLED` | Una disputa se resolvió a favor del cliente |

La máquina de estados de los payouts vivía solo en TypeScript. Ahora tiene su
copia en `app_private.guard_payout_transitions`, por la misma razón que la de la
asignación: la interfaz no es una frontera de seguridad.

Desde `/admin/payouts` se aprueba, se retiene con motivo y se registra la
transferencia. Registrarla exige referencia bancaria y es idempotente: hacerlo
dos veces no duplica nada. **Ninguna de estas acciones mueve dinero**, y la
pantalla lo dice con esas palabras.

---

## 13. Notificaciones

Las emite la base, desde las mismas funciones que cambian el estado, con
`app_private.notify_user`. Así no puede haber un cambio de estado sin su aviso.

Siete valores nuevos: `JOB_STARTED`, `JOB_UPDATE`, `NEW_EVIDENCE`,
`HANDOFF_REQUESTED`, `JOB_APPROVED`, `DISPUTE_RESOLVED`, `PAYOUT_PAID`. Los que
ya existían se reutilizan tal cual.

Realtime actualiza la interfaz; la base sigue siendo la fuente de verdad.

---

## 14. Pruebas permanentes

| Dónde | Qué |
|---|---|
| `supabase/tests/08_job_execution.sql` | E01–E28: recorrido completo, check-in y sus cuatro resultados, papeles, escrituras directas, extensiones, PIN, finalización, disputas, payouts, reseñas, idempotencia de hitos e invariantes |
| `supabase/tests/08_race_execution.sh` | X10 aceptar y rechazar la misma extensión a la vez, X11 dos validaciones del mismo PIN, X12 dos aprobaciones, X13 invariantes. `RACE_REPS` repeticiones, dos sesiones `psql` reales |
| `scripts/verify-execution.ts` | W01–W24 contra `hagotufila-dev`, con sesiones reales y RLS del proyecto: separación de roles, privacidad de la ubicación, extensiones, disputas, transferencia, reseñas y dos carreras |
| `e2e/execution.spec.ts` | Seis pruebas de navegador: el recorrido con el ratón, que cada parte ve solo sus acciones, y que la línea de tiempo no lleva coordenadas |

Sin `sleep` en ninguna: en SQL serializan los bloqueos de fila, en el navegador
la espera es por elemento visible.

---

## 15. Lo que queda fuera

1. **Transferencias y reembolsos reales.** Etapa 4.
2. **Liberación automática** del payout al vencer la ventana de disputa: hoy la
   aprobación es siempre del cliente y no hay proceso programado.
3. **FilaPuntos**: `apply_loyalty_transaction` existe y nadie la llama.
4. **Caducidad de trabajos** sin asignación (`EXPIRED`): no hay proceso que la
   marque.
5. **Retirar una disputa** (`WITHDRAWN`) desde la interfaz.
6. **Chat con imágenes**: el bucket y el tipo de mensaje existen; la subida no
   está conectada.
