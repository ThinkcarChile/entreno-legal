# Pagos: política de cancelación, atomicidad y candados

Guía del dinero en HagoTuFila: qué garantiza la base, qué hace la aplicación y
cómo se comporta ante una cancelación con un pago en vuelo. Complementa
`ARQUITECTURA.md` (§3.8, §3.9, §6.7 y §8) y `BASE-DE-DATOS.md`.

> **La integración con Webpay Plus está en `docs/TRANSBANK.md`.** Este
> documento cubre el dominio —estados, candados, cancelación— que es
> independiente del proveedor y que no cambió al integrarlo.

> **Las devoluciones ya existen** (`payment_refunds`, y el proveedor las
> ejecuta), pero ninguna se ha hecho en producción. Un pago `UNDER_REVIEW` con
> `captured_at` sigue siendo la cola de entrada: dinero recibido que hay que
> devolver, y que ahora sí tiene botón. Cómo se evita devolver dos veces está
> en §8 ter.

---

## 1. La garantía

Para cualquier orden de llegada de una confirmación aprobada, un rechazo, un
duplicado y una cancelación:

> **Nunca coexisten** un trabajo cancelado, un pago `PAID`, una asignación
> habilitada y un payout.

Y, además:

- un pago tiene **a lo sumo un efecto financiero**: un evento del proveedor se
  registra una sola vez por su identificador;
- un pago tiene **a lo sumo un payout**;
- un trabajo cancelado **nunca** tiene payout;
- una asignación cancelada **nunca** vuelve a habilitarse, ni siquiera con la
  clave de servicio;
- `payment_events` es solo de escritura para la aplicación.

Lo comprueban 225 comprobaciones locales (`npm run db:test`, con las carreras
de `07_race_payment.sh` y `08_race_execution.sh`) y 23 contra `hagotufila-dev`
(`npm run verify:payments`).

---

## 2. Política de cancelación

`cancel_job` mira el pago antes de decidir. Las reglas, en orden:

| Situación al pedir cancelar | Qué pasa |
|---|---|
| Sin pago iniciado | Se cancela en el acto: trabajo `CANCELLED`, ofertas pendientes `REJECTED`, asignación (si la hay) `CANCELLED_BY_CLIENT` |
| Pago `PENDING` que **nunca llegó al proveedor** (sin `provider_transaction_id`) | No hay dinero en juego: el pago pasa a `FAILED` y se cancela en el acto |
| Pago **en vuelo** (`CREATED`, `AUTHORIZED`, o `PENDING` con transacción) | El trabajo pasa a **`CANCELLATION_PENDING`**. No se da por cancelado hasta saber qué pasó con ese pago. Se rechazan las ofertas pendientes y se avisa a las dos partes |
| Pago ya `PAID` (trabajo `PAID` o posterior) | **No es una cancelación simple**: `cancel_job` la rechaza con «corresponde un reembolso o una disputa». Esa ruta es de la Etapa 4 |
| Pago `UNDER_REVIEW` | Igual que el anterior: hay dinero de por medio y lo resuelve administración |
| Trabajo ya `CANCELLATION_PENDING` | Se rechaza: «la cancelación ya está en curso» |

Y cuando el proveedor responde sobre un trabajo en `CANCELLATION_PENDING`:

| Respuesta tardía | Qué pasa |
|---|---|
| **Aprobada** | El dinero se **registra**: pago `UNDER_REVIEW`, `captured_at`, `review_reason = late_confirmation_after_cancellation`, datos de autorización guardados. **No** habilita el trabajo, **no** crea payout. El trabajo termina `CANCELLED` |
| **Rechazada** | No hay dinero: pago `FAILED` y la cancelación se completa |
| Aprobada sobre un pago que ya era `FAILED` (contradictoria) | `UNDER_REVIEW` con `review_reason = approved_after_failed`. El trabajo sigue cancelado. Lo mira una persona |
| Con otro importe que el esperado | `UNDER_REVIEW` con `review_reason = amount_mismatch`, sin habilitar nada |

### Estados usados y añadidos

- **Añadido** `job_status.CANCELLATION_PENDING`, entre `PAYMENT_PENDING` y
  `CANCELLED`. Solo puede ir a `CANCELLED`. Se necesitaba un estado explícito:
  ni `PAYMENT_PENDING` (el cliente ya pidió cancelar) ni `CANCELLED` (todavía
  puede haber dinero cobrado) decían la verdad.
- **Añadido** `notification_type.JOB_CANCELLED`.
- **Reutilizado** `payment_status.UNDER_REVIEW` para «devolución pendiente»,
  con dos columnas nuevas que lo hacen inequívoco: `captured_at` (el proveedor
  dijo que cobró) y `review_reason` (por qué está en revisión). No se inventó
  un `REFUND_PENDING`: `REFUNDED` y `PARTIALLY_REFUNDED` ya existen para cuando
  la devolución ocurra de verdad.
- **Columnas nuevas**: `jobs.cancellation_requested_at`,
  `payment_events.provider_event_id`, `payouts.payment_id`.

---

## 3. La transacción atómica

Todo lo que decide sobre dinero corre en **una** transacción con los tres
bloqueos tomados en el **mismo orden en todas partes**:

```
jobs  →  assignments  →  payments
```

Un orden único es lo que impide el interbloqueo entre una cancelación y una
confirmación simultáneas: la segunda en llegar espera a la primera y decide
sobre el estado ya escrito.

Las piezas:

1. **`confirm_payment_result(pago, proveedor, id_evento, resultado, importe, detalles)`**
   es la única vía por la que un resultado del proveedor llega a `payments`.
   Solo la ejecuta la clave de servicio (`EXECUTE` revocado a `public`, `anon`
   y `authenticated`). Bloquea trabajo → asignación → pago, comprueba que el
   proveedor sea el del pago, **registra el evento una sola vez** por
   `(provider, provider_event_id)` —si ya estaba, devuelve `duplicate` sin
   tocar nada— y escribe el nuevo estado del pago.
2. **`app_private.guard_payment_settlement`** (BEFORE UPDATE en `payments`)
   decide, bajo esos bloqueos y **antes** de que `PAID` se escriba, si el pago
   habilita el trabajo o queda en revisión. Vale para cualquier vía: la RPC, un
   script o un `UPDATE` con la clave de servicio. Si el trabajo está en
   `CANCELLATION_PENDING` y el resultado es definitivo, completa la cancelación
   en la misma transacción.
3. **`app_private.on_payment_paid`** (AFTER UPDATE) solo actúa cuando el
   disparador anterior dejó el pago en `PAID`: asignación `CONFIRMED`, trabajo
   `PAID`, payout, mensaje de sistema y notificaciones.
4. **`cancel_job`** bloquea en el mismo orden y aplica la política de la sección 2.
5. **`app_private.finalize_job_cancellation`** es lo que ambos comparten para
   dejar el trabajo `CANCELLED`, las ofertas `REJECTED`, la asignación
   `CANCELLED_BY_CLIENT` y avisar.

El resultado de `confirm_payment_result` dice qué pasó, para que la ruta de
retorno muestre la pantalla correcta sin volver a consultar:

```json
{ "outcome": "applied", "payment_status": "UNDER_REVIEW",
  "review_reason": "late_confirmation_after_cancellation",
  "job_status": "CANCELLED", "assignment_status": "CANCELLED_BY_CLIENT",
  "payout_id": null }
```

---

## 4. Candados en la base

Lo que impide que un error de código —o un `UPDATE` a mano— rompa la garantía:

| Candado | Impide |
|---|---|
| Índice único `payment_events (provider, provider_event_id)` | Dos registros del mismo evento del proveedor |
| Índice único `payouts (payment_id)` | Dos payouts por el mismo pago |
| Índice único `payouts (assignment_id)` (ya existía) | Dos payouts por la misma asignación |
| Disparador `payouts_guard` | Un payout sin pago `PAID` de tipo `JOB`, sobre una asignación cancelada, sobre un trabajo `CANCELLED` / `CANCELLATION_PENDING` / `EXPIRED`, a otro trabajador, o cambiar de asignación, pago o trabajador después |
| Disparador `assignments_guard_transitions` (endurecido) | Salir de `CANCELLED_BY_CLIENT`, `CANCELLED_BY_WORKER` o `COMPLETED`, **también** para la clave de servicio y la administración |
| Disparador `jobs_guard_terminal` | Revivir un trabajo `CANCELLED` o `EXPIRED` (solo pueden ir a `CLOSED`); `CANCELLATION_PENDING` solo va a `CANCELLED` |
| Disparador `payments_a_guard_settlement` | `REFUNDED` → en vuelo; `PAID` / `UNDER_REVIEW` → `FAILED`; y toda decisión de `PAID` fuera de los bloqueos |
| Disparador `payouts_guard_transitions` (Bloque 3) | Saltarse la máquina de estados del pago al trabajador: `PAID` y `CANCELLED` son terminales para todos |
| `app_private.payout_transfer_blocker` → `payout_money_blocker` | Transferir sobre un cobro devuelto, en revisión, con una devolución sin respuesta, con cifras que no cuadran o de un ambiente que no es producción (§4 bis) |
| `app_private.refund_after_payout_blocker` (en `request_payment_refund`) | Devolver, con el trabajador ya pagado, más de lo que queda de la plataforma (§4 bis) |
| Disparador `payments_hold_payout_on_review` (ampliado en `20260601001400`) | Que una devolución confirmada que deja las cifras sin cuadrar deje el payout pagable: pasa a `HELD` con el motivo |
| Índice único `payment_attempt_refunds_one_committed_idx` y disparador `payment_attempts_guard_money` | Devolver dos veces el cobro de un intento, o que un intento devuelto pase después a ser el dinero del pago (§8 quater) |
| Disparador `platform_settings_guard_payout_flag` | Cambiar `allow_non_production_payouts` desde una sesión de la aplicación, también la de administración |
| `REVOKE UPDATE, DELETE, TRUNCATE` a `authenticated` en `payments`, `payment_events`, `payouts` | Que un usuario con sesión toque dinero, incluso si una política de RLS se equivocara |
| `EXECUTE` de `confirm_payment_result` solo para el servicio | Que un usuario «confirme» su propio pago |

`app_private.payment_invariant_violations()` recorre la base y devuelve
cualquier fila que rompa las reglas de la sección 1. Las pruebas la ejecutan al
final; debe devolver cero filas.

---

## 4 bis. Antes de pagarle al trabajador, el cobro del cliente

Los disparadores retienen el payout (`HELD`) cuando el pago del trabajo se
devuelve entero, falla o pasa a revisión. Retener no bastaba: `approve_payout`
y `resolve_dispute` lo sacaban de ahí, y `mark_payout_paid` lo transfería sin
mirar el cobro. El cliente podía terminar con su dinero devuelto y el
trabajador pagado por el mismo trabajo. Desde la migración `20260601000800`:

| Quién | Qué exige del pago del trabajo |
|---|---|
| `mark_payout_paid` (la transferencia, barrera definitiva) | `PAID` o `PARTIALLY_REFUNDED`; ninguna devolución sin respuesta del banco (cualquier estado de `payment_refunds` que no sea `CONFIRMED`, `FAILED` ni `CANCELLED`); y cifras que cuadren: lo devuelto al cliente, lo pedido y sin respuesta, lo que se le debe por una disputa resuelta y el neto del payout no pueden sumar más de lo que el cliente pagó por la asignación (trabajo más tiempo adicional). Se comprueba antes de la excepción de la disputa resuelta: una resolución exime de esperar la ventana, no de que el cobro siga en pie |
| `approve_payout` | No aprueba sobre un pago devuelto entero, en revisión ni en ningún estado que no sea un cobro confirmado |
| `resolve_dispute` | A favor del trabajador o repartida, no sobre un pago devuelto entero. Si deja el payout aprobado, las cifras tienen que cuadrar o no se resuelve nada. Si el pago está en revisión o con una devolución sin respuesta, la decisión se registra pero el payout queda `HELD` hasta que `approve_payout` lo encuentre sano |

Además, desde `20260601000810`, `mark_payout_paid` no transfiere si algún cobro
que respalda el payout tiene un `environment` que no sea `production` —simulado
o de integración: no hubo dinero—. Se mira el cobro del trabajo y también cada
cobro del tiempo adicional que llegó a cobrarse, porque ese también sube el
neto del payout. La excepción es `platform_settings.allow_non_production_payouts`
encendida, cosa que solo se hace en SQL y solo en bases de desarrollo o de
pruebas (`DESPLIEGUE-SUPABASE.md` §4.5). Un cobro de producción se transfiere
igual que siempre, sujeto a lo de la tabla y a la ventana de disputa.

Todas las negativas dicen el motivo con las cifras y qué hacer, en las palabras
que ve administración. Pruebas: `supabase/tests/11_payment_health.sql`
(`L01`–`L44`).

**Y del lado de la devolución** (migración `20260601001400`). La transferencia
medía el invariante; pedir una devolución no, así que con el payout ya `PAID`
se podía devolver el cobro entero: cliente y trabajador pagados por el mismo
trabajo. Ahora:

| Payout | Una devolución nueva |
|---|---|
| `PAID` (o `PROCESSING`, mientras se registra la transferencia) | Solo hasta lo que queda de la plataforma: lo cobrado en la asignación (trabajo y tiempo adicional, también un cobro en revisión) menos lo devuelto, lo pedido y sin respuesta, lo que se debe por disputas resueltas y lo transferido al trabajador (neto más retención). Una devolución ligada a una disputa salda primero lo que esa disputa debe. Más allá, `request_payment_refund` se niega con las cifras y con cuánto se puede devolver todavía |
| `PENDING`, `APPROVED`, `HELD` | Se acepta: el dinero del trabajador no salió y la transferencia la mide después. Pero si, **confirmada**, deja las cifras sin cuadrar, el payout pagable pasa a `HELD` con un motivo como «Se devolvieron $5.000 al cliente y las cifras de este trabajo ya no cuadran: …», en el mismo disparador que ya lo retenía por devolución total o revisión. Pedida y sin respuesta no retiene: puede fallar, y mientras tanto la transferencia ya se niega por ella (también si quedó `UNKNOWN`) |

`request_payment_refund` bloquea ahora trabajo → asignación → todos los pagos de
la asignación, el orden de `mark_payout_paid`: una transferencia que se registra
a la vez espera a la devolución o la ve. `settle_payment_refund` y
`resolve_unknown_refund` cierran la devolución en el mismo orden (trabajo →
asignación → pagos → la devolución): antes tomaban la devolución y el pago
primero, y la guarda de liquidación el trabajo después, así que cerrar una
devolución que el banco ya había hecho podía abortar por interbloqueo frente a
una petición o una transferencia sobre el mismo trabajo. Pruebas: J01–J12
(`supabase/tests/17_payments_followup.sql`) y J42
(`supabase/tests/17_race_refund_settle.sh`).

---

## 5. Comportamiento ante confirmaciones tardías y duplicadas

| Caso | Resultado |
|---|---|
| Confirmación aprobada **antes** de cancelar | Trabajo `PAID`, asignación `CONFIRMED`, payout. Cancelar después se rechaza (reembolso o disputa) |
| Cancelación pedida, **después** llega aprobada | Dinero registrado (`UNDER_REVIEW`, `captured_at`), sin payout, trabajo `CANCELLED` |
| Cancelación pedida, después llega rechazada | Pago `FAILED`, cancelación completada |
| Aprobada después de la cancelación **completada** | `UNDER_REVIEW (approved_after_failed)`, trabajo sigue `CANCELLED`, sin payout |
| Misma confirmación dos veces, en secuencia | Primera `applied`, segunda `duplicate`. Un evento, un payout |
| Misma confirmación dos veces, **a la vez** | Igual: la segunda espera el bloqueo del pago y encuentra el evento registrado |
| Aprobada y cancelación **a la vez** | Gana quien toma el bloqueo del trabajo primero. Si gana el pago: `PAID` + payout y la cancelación se rechaza. Si gana la cancelación: `UNDER_REVIEW` sin payout y trabajo `CANCELLED`. **Nunca las dos**, nunca a medias |
| Autorizada pero **no cuadra** (orden de compra, sesión, código de autorización) | `UNDER_REVIEW` con el motivo, **sin pasar por `PAID`**: ni trabajo habilitado, ni asignación confirmada, ni payout, ni aviso al trabajador (migración `20260601001010`) |
| Autorizada en un **intento anterior** cuando el pago ya tenía el dinero de otro | Cobro duplicado: el intento queda `DOUBLE_CHARGE` con motivo, su cobro (`provider_amount`), evento, auditoría y aviso a administración. Pago, trabajo y payout no cambian. Se devuelve desde `/admin/pagos` (§8 quater) |
| Autorizada en un intento anterior cuando el pago aún no tenía dinero | Ese intento paga: el pago pasa a apuntar a su token y se asienta como siempre. Si después cobra el otro, ese es el duplicado |
| Retorno sin cobro (abandono, tiempo agotado) de un **intento anterior** | Solo ese intento queda `FAILED`. El pago sigue con el intento vigente, que puede aprobarse con normalidad (antes caía en `approved_after_failed`) |

Resultados de las carreras, tal como se ejecutaron:

| Carrera | Local (PostgreSQL 16, dos sesiones `psql`) | `hagotufila-dev` (dos peticiones PostgREST) |
|---|---|---|
| Duplicado simultáneo | 10 de 10: 1 aplicada, 1 duplicada, 1 evento, 1 payout | 25 de 25 en tres ejecuciones (5 + 10 + 10): idem |
| Aprobación contra cancelación | 10 de 10 coherentes (ganó el pago 4, la cancelación 6) | 25 de 25 coherentes (ganó el pago 10, la cancelación 15) |
| Invariantes al final | 0 violaciones | 0 violaciones |

---

## 6. El proveedor simulado retardado

`MockPaymentProvider` aprueba en el acto, y por eso nunca podía reproducir la
carrera. `DelayedMockPaymentProvider` (`PAYMENT_PROVIDER=mock-delayed`) crea el
pago y **no responde** hasta que alguien decide con `settle(token, 'PAID' | 'FAILED')`.
Mientras tanto, cada `confirmPayment` espera en una promesa. Cuando llega el
resultado, todos los que esperaban se liberan **en el mismo tick**: es una
barrera, no un `sleep`. Así dos confirmaciones lanzadas antes de `settle`
llegan a la base de forma simultánea y determinista.

- Está prohibido en producción, igual que el inmediato (`getPaymentProvider`
  lanza si `NODE_ENV=production`).
- Un token que no emitió se rechaza siempre (`FAILED`, `token_no_reconocido`):
  no hay «recuperación» tras reiniciar, a diferencia del inmediato.
- Dos confirmaciones del mismo token son **el mismo evento**: mismo
  `providerEventId`. Es lo que la base usa para registrarlo una sola vez.
- En la interfaz, con `mock-delayed`, el botón de simulación crea el pago y la
  ruta de retorno se queda esperando: sirve para ver a mano la pantalla de
  «cancelación en verificación» cancelando desde otra pestaña.

`PaymentProvider` conserva la superficie que Webpay necesitará: creación,
confirmación, consulta de estado, reversa/reembolso. La conciliación ya tiene
dónde apoyarse (`provider_event_id`, `captured_at`, `review_reason`).

---

## 7. Lo que ve cada persona

| Estado | Cliente | Trabajador |
|---|---|---|
| `CANCELLATION_PENDING` | «Cancelación en verificación» y **«Estamos verificando el estado del pago antes de completar la cancelación.»** Sin botón de pagar, sin botón de cancelar otra vez | Mismo aviso, con «No inicies el trabajo». Sin acciones de avance |
| `CANCELLED` + pago `UNDER_REVIEW` | «Trabajo cancelado · devolución pendiente»: el proveedor confirmó el cobro después; el importe está registrado para devolución | «El pago que llegó después no lo habilita y no genera un pago para ti» |
| `CANCELLED` sin dinero | «Trabajo cancelado» | «El cliente canceló este trabajo» |
| Vuelta del proveedor (pago del trabajo) | `?pago=ok` (confirmado), `?pago=revision` (llegó tras la cancelación, o el cobro no cuadró: el aviso depende del estado del trabajo), `?pago=cancelado` (rechazado y cancelación completada), `?pago=rechazado`, `?pago=verificando` (sin respuesta en firme: no volver a pagar), `?pago=duplicado` (un segundo cobro quedó registrado para devolución) | — |
| Vuelta del proveedor (tiempo adicional) | Siempre en la página de la asignación, nunca en la pantalla de pago del trabajo: `?pago=extension-ok`, `extension-rechazado`, `extension-cancelado`, `extension-tiempo`, `extension-incompleto`, `extension-verificando`, `extension-revision`, `extension-duplicado`. Solo `extension-ok` dice que está pagado, y solo cuando lo está | — |

Lo que **no** se muestra nunca: «Cancelado» antes de que sea definitivo, «Pago
protegido» sobre un pago que se va a devolver, botones de iniciar el trabajo
sobre una asignación cancelada o en verificación, ni un payout disponible por un
trabajo cancelado. `isPayable(job.status)` y `isCancellationPending(job.status)`
en `src/lib/domain/job-actions.ts` son la única fuente de esas decisiones.

El trabajador sabe **si** el trabajo está pagado, nunca **cómo**: la fila de
`payments` es del cliente que pagó y de administración (política
`payments_read`, migración `20260601000920`). Las pantallas del trabajo leen el
estado con `assignment_payment_states`, que devuelve propósito, estado, importe y
fechas, sin dígitos de tarjeta, código de autorización, orden de compra ni nada
de lo que contestó Webpay. `provider_transaction_id` —con Webpay, el token— no
es legible para ninguna sesión.

---

## 8. Pruebas permanentes

| Dónde | Qué |
|---|---|
| `supabase/tests/07_payment_cancellation.sql` | P01–P17: los escenarios de las secciones 2 y 5, lo que nadie puede hacer a mano, invariantes y `payment_events` append-only |
| `supabase/tests/07_race_payment.sh` | R10 duplicado simultáneo, R11 aprobación contra cancelación, R12 invariantes. `RACE_REPS` repeticiones (5 por defecto), dos sesiones `psql` reales |
| `scripts/verify-payments.ts` | Lo mismo contra `hagotufila-dev`, con `DelayedMockPaymentProvider` y `applyProviderResult` —las piezas que usa la aplicación— hablando con PostgREST. `RACE_REPS=10 npm run verify:payments` |
| `supabase/tests/11_payment_health.sql` | L01–L44: la §4 bis. Devolución total, revisión, devolución sin respuesta y cifras que no cuadran frente a aprobar, resolver y transferir; el ambiente de cada cobro (el del trabajo y el del tiempo adicional) y la bandera `allow_non_production_payouts` |
| `supabase/tests/13_payment_attempts.sql` | N01–N47: historial de intentos, guardas del reintento, cobro duplicado, retornos sin cobro de otro intento, revisión sin pasar por `PAID`, cola y vencimiento de intentos (también el vigente con commit pedido, y su autorización tardía), privilegios |
| `src/lib/payments/return-handler.test.ts`, `reconcile.test.ts`, `return-target.test.ts` | Qué intento resuelve cada retorno, cuándo se llama al banco, con qué identidad se asienta, el barrido de intentos anteriores y a qué pantalla vuelve cada resultado según lo pagado |

Sin `sleep` en ninguna: en SQL serializan los bloqueos de fila; en Node, la
barrera del proveedor.

---

## 8 bis. El cobro del tiempo adicional

Una extensión aceptada crea un pago aparte, con `purpose = 'EXTENSION'` y su
propio `extension_id`. No toca el pago original ni el acuerdo inicial.

`guard_payment_settlement` decide sobre los pagos del trabajo: un `PAID` solo
habilita si el trabajo está esperando ese pago. Un cobro de extensión llega con
el trabajo YA en curso, así que caía en la rama de «confirmación tardía» y
terminaba en `UNDER_REVIEW` por `job_not_awaiting_payment`: el cliente pagaba el
tiempo adicional y el dinero quedaba marcado como devolución pendiente.

Tiene su propia rama, con las mismas exigencias: la extensión aceptada, el
trabajo vivo y la asignación sin cancelar. Lo único que produce al confirmarse
es que el payout existente sube —importe menos comisión—; no habilita nada, no
cambia el estado del trabajo y no crea un payout nuevo. Si la extensión no está
aceptada, el pago va a `UNDER_REVIEW` con `review_reason = 'extension_not_accepted'`.

Al volver de Webpay, el cobro de la extensión va a la página de la asignación
con sus propios avisos (`?pago=extension-…`), nunca a `/pagar/{asignación}`:
esa pantalla es la del pago del trabajo, que ya está pagado, y redirigía a
«Pago confirmado» aunque el cobro adicional se hubiera rechazado o abandonado.
Un cobro adicional rechazado se puede reintentar: el intento fallido ya no
bloquea uno nuevo (`register_payment_attempt`, migración `20260601001000`).

Ver `docs/EJECUCION.md` §7.

---

## 8 ter. Devoluciones: una sola vez, y nunca «fallida» sin saberlo

Una devolución (`payment_refunds`) pasa por estos estados, y un disparador
impide cualquier otro paso, también con la clave de servicio:

| Estado | Qué significa | Compromete saldo | Sale a |
|---|---|---|---|
| `REQUESTED` | pedida; se envía al banco | sí | `UNKNOWN`, `CONFIRMED`, `FAILED`, `CANCELLED` |
| `UNKNOWN` | enviada, y el banco no dio respuesta en firme | sí | `CONFIRMED`, `FAILED` |
| `CONFIRMED` | el banco la hizo; baja `payments.refunded_amount` | — | final |
| `FAILED` | el banco dijo que no, o no llegó a salir | no | final |
| `CANCELLED` | descartada antes de salir (una enviada no se puede descartar) | no | final |

Tres reglas, todas en la base (migración `20260601000910`):

1. **Una petición, una devolución.** La clave de idempotencia es de la petición
   de administración —un identificador que nace con el formulario—, no del
   importe. Repetir la petición devuelve la misma fila; dos devoluciones
   parciales iguales son dos peticiones. Y `claim_payment_refund` deja que solo
   una llamada la envíe al banco.
2. **Una abierta por pago.** Con una `REQUESTED` o `UNKNOWN`, no se pide otra
   (índice único `payment_refunds_one_open_idx`). Si la primera salió de
   verdad, la segunda sería dinero devuelto dos veces.
3. **Lo devuelto no supera lo cobrado**: ni lo confirmado (restricción de
   `payments` y comprobación en `settle_payment_refund`), ni lo confirmado más lo
   abierto (`request_payment_refund` y el invariante
   `refund_committed_over_amount`).

Una `UNKNOWN` la cierra la conciliación cuando la consulta de estado de Webpay
la explica, o una persona con lo que muestra el portal de Transbank
(`resolve_unknown_refund`). El detalle está en `TRANSBANK.md` §7 y §11. Lo
prueban D01–D51 y D68–D70 (`supabase/tests/12_refunds_privacy.sql`) y
`src/lib/payments/refund.test.ts` y `refund-reconcile.test.ts`.

Riesgo que queda, a sabiendas: mientras una devolución **total** está por
confirmar, el pago al trabajador no se retiene solo (se retiene al confirmarse,
como cualquier devolución total). Si administración transfiere en ese intervalo
y la devolución resulta hecha, queda para resolución manual.

---

## 8 quater. Devolver un cobro duplicado

Un cobro duplicado (`payment_attempts.status = 'DOUBLE_CHARGE'`) o un intento
que salió de la ventana con indicios de cobro (`UNDER_REVIEW`) no es dinero del
pago: su transacción es otra, con otro token. Devolverlo con `payment_refunds`
habría ido al token del pago —el del cobro bueno— y descuadrado su saldo. Tiene
su propia devolución (migración `20260601001420`):

| Pieza | Qué hace |
|---|---|
| `payment_attempt_refunds` | Una fila por petición. Los estados y el disparador de transiciones son los de `payment_refunds` (§8 ter). Una sola comprometida (abierta o hecha) por intento |
| `request_attempt_refund` | Solo administración. Intento `DOUBLE_CHARGE` o `UNDER_REVIEW`, con token, que no respalde el pago. El importe lo fija la base: el cobro entero del intento (`provider_amount`, que se registra al pasar a `DOUBLE_CHARGE` aunque la confirmación no lo trajera; si no, el importe del pago con que se creó la transacción) |
| `claim_attempt_refund` → `refundTransaction(token del intento)` → `settle_attempt_refund` / `mark_attempt_refund_unknown` | Una sola llamada al banco, y la respuesta se lee igual que la de un pago (`dispatchRefund` en `refund.ts`, `classifyRefundError` / `classifyRefundResult`). No toca el pago ni el payout |
| `attempt_refunds_pending_reconciliation` + `reconcileAttemptRefunds` | La conciliación cierra una `UNKNOWN` con `status()` del intento, con las reglas de `decideUnknownRefund` |
| `resolve_unknown_attempt_refund` | Cierre a mano con lo que muestra el portal de Transbank, nota obligatoria y `audit_logs` |
| `admin_payments.attempts_review` | Cada intento en revisión con su cobro y su última devolución. `attempts_in_review` deja de contar el que ya se devolvió |

Y un disparador sobre `payment_attempts`: un intento con su devolución pedida,
por confirmar o hecha no pasa a `SETTLED` —la autorización tardía de un intento
en revisión sería, si no, un cobro ya devuelto asentado como pago del trabajo—.
El invariante `attempt_refund_on_payment_money` delata una devolución de intento
sobre el dinero del pago, y `attempt_refund_over_charge` una que supere el cobro
del intento. Runbook: `TRANSBANK.md` §11 «Me cobraron dos veces».

---

## 9. Riesgos que quedan para Webpay real

Lo que esta etapa **no** resolvía y había que tener delante al integrar
Transbank. Los puntos 1, 3 y 5 ya están resueltos y se conservan con su número,
porque otros documentos los citan; el 4 sigue abierto (`TRANSBANK.md` §12).

1. **Resuelto: el reembolso real.** Antes no existía. Ahora las devoluciones existen
   (`payment_refunds`, ejecutadas contra el proveedor), sin devolver dos veces
   ni dar por fallida una sin saberlo: §8 ter, y §8 quater para los cobros
   duplicados. Ninguna se ha hecho todavía en producción.
2. **Identidad del evento.** Con Webpay Plus el `provider_event_id` tendrá que
   derivarse de lo que el SDK devuelve en `commit` (token + `buy_order` +
   fecha de transacción). Si se elige mal, dos respuestas legítimas distintas
   podrían tratarse como duplicado, o una repetida como nueva. Se decide con el
   SDK delante, no antes.
3. **Resuelto: la confirmación sin retorno.** La conciliación existe:
   `reconcilePayments` consulta los pagos en vuelo pasado un margen y los
   asienta con `confirm_payment_result`, desde «Conciliar pendientes» en
   `/admin/pagos` y desde `/api/cron/conciliar-pagos`, que en producción llama un
   programador externo cada 10 minutos con `CRON_SECRET` (`TRANSBANK.md` §7).
4. **Ventana de `commit`.** Transbank exige confirmar en un plazo tras el
   retorno; una transacción autorizada y no confirmada se revierte sola. La
   máquina de estados lo representa (`AUTHORIZED` → `FAILED`), pero el plazo
   concreto y qué mostrar al cliente se definen con el ambiente de integración.
5. **Resuelto: `CANCELLATION_PENDING` sin salida.** Si el proveedor
   nunca responde, lo cierra la conciliación del punto 3, programada; y pg_cron
   corre `run_scheduled_tasks()` cada 10 minutos, que con
   `expire_stale_payments` cierra lo que sale de la ventana de conciliación
   (`DESPLIEGUE-SUPABASE.md` §4.4, `TRANSBANK.md` §7 «Los rezagados no
   desaparecen»).
6. **Importe verificado, moneda no.** `confirm_payment_result` compara el
   importe; asume CLP. Webpay Plus solo opera en CLP, pero hay que dejarlo
   explícito al mapear la respuesta.
7. **Devoluciones de disputa.** Una resolución parcial o a favor del cliente
   anota el importe en `disputes.refund_amount` y deja el pago en `PAID`,
   porque el dinero se cobró de verdad. La devolución se ejecuta desde
   `/admin/pagos`: mientras no se pida, el pago del trabajo de esa disputa está
   en la cola «Devoluciones por procesar» (filtro «En revisión», con el aviso
   «Devolución de una disputa sin pedir»), y el enlace «Devolución pendiente»
   de `/admin/disputas` lleva directo a él. Pedida, sigue en la cola como
   devolución abierta, una sola vez; sale cuando el banco confirma todo lo
   resuelto (migraciones `20260601000910` y `20260601001510`).
   Ver `docs/EJECUCION.md` §10.
8. **Reembolso parcial y bonos.** El importe cobrado incluye el bono
   comprometido. Devolver solo el bono, o solo el servicio, necesita
   `PARTIALLY_REFUNDED` y reglas que hoy no están escritas.
