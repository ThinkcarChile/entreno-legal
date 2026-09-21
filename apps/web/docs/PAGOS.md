# Pagos: política de cancelación, atomicidad y candados

Guía del dinero en HagoTuFila tal como está hoy: qué garantiza la base, qué
hace la aplicación, qué es simulado y qué queda para la integración real con
Webpay Plus. Complementa `ARQUITECTURA.md` (§3.8, §3.9, §6.7 y §8) y
`BASE-DE-DATOS.md`.

> **Nada de esto afirma que exista un reembolso bancario real.** Hasta integrar
> Transbank, «devolución pendiente» es un registro contable: hay dinero recibido
> que la plataforma debe devolver. El reembolso real es de la Etapa 4.

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

Lo comprueban 141 comprobaciones locales (`npm run db:test`, con las carreras
de `07_race_payment.sh`) y 23 contra `hagotufila-dev` (`npm run verify:payments`).

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
| `REVOKE UPDATE, DELETE, TRUNCATE` a `authenticated` en `payments`, `payment_events`, `payouts` | Que un usuario con sesión toque dinero, incluso si una política de RLS se equivocara |
| `EXECUTE` de `confirm_payment_result` solo para el servicio | Que un usuario «confirme» su propio pago |

`app_private.payment_invariant_violations()` recorre la base y devuelve
cualquier fila que rompa las reglas de la sección 1. Las pruebas la ejecutan al
final; debe devolver cero filas.

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
| Vuelta del proveedor | `?pago=ok` (confirmado), `?pago=revision` (llegó tras la cancelación), `?pago=cancelado` (rechazado y cancelación completada), `?pago=rechazado` | — |

Lo que **no** se muestra nunca: «Cancelado» antes de que sea definitivo, «Pago
protegido» sobre un pago que se va a devolver, botones de iniciar el trabajo
sobre una asignación cancelada o en verificación, ni un payout disponible por un
trabajo cancelado. `isPayable(job.status)` y `isCancellationPending(job.status)`
en `src/lib/domain/job-actions.ts` son la única fuente de esas decisiones.

---

## 8. Pruebas permanentes

| Dónde | Qué |
|---|---|
| `supabase/tests/07_payment_cancellation.sql` | P01–P17: los escenarios de las secciones 2 y 5, lo que nadie puede hacer a mano, invariantes y `payment_events` append-only |
| `supabase/tests/07_race_payment.sh` | R10 duplicado simultáneo, R11 aprobación contra cancelación, R12 invariantes. `RACE_REPS` repeticiones (5 por defecto), dos sesiones `psql` reales |
| `scripts/verify-payments.ts` | Lo mismo contra `hagotufila-dev`, con `DelayedMockPaymentProvider` y `applyProviderResult` —las piezas que usa la aplicación— hablando con PostgREST. `RACE_REPS=10 npm run verify:payments` |

Sin `sleep` en ninguna: en SQL serializan los bloqueos de fila; en Node, la
barrera del proveedor.

---

## 9. Riesgos que quedan para Webpay real

Lo que esta etapa **no** resuelve y hay que tener delante al integrar Transbank:

1. **El reembolso real no existe.** `UNDER_REVIEW + captured_at` dice que hay
   dinero que devolver; devolverlo (reversa o anulación con el SDK) y pasar el
   pago a `REFUNDED` es de la Etapa 4, con su propio registro en `payment_events`.
2. **Identidad del evento.** Con Webpay Plus el `provider_event_id` tendrá que
   derivarse de lo que el SDK devuelve en `commit` (token + `buy_order` +
   fecha de transacción). Si se elige mal, dos respuestas legítimas distintas
   podrían tratarse como duplicado, o una repetida como nueva. Se decide con el
   SDK delante, no antes.
3. **Confirmación sin retorno.** Si el cliente cierra el navegador entre Webpay
   y `/pagos/retorno`, nadie llama a `confirmPayment`. Hace falta la
   conciliación: consultar el estado de los pagos en vuelo (`getStatus`) pasado
   un plazo y asentarlos con `confirm_payment_result`. La función ya sirve
   para eso.
4. **Ventana de `commit`.** Transbank exige confirmar en un plazo tras el
   retorno; una transacción autorizada y no confirmada se revierte sola. La
   máquina de estados lo representa (`AUTHORIZED` → `FAILED`), pero el plazo
   concreto y qué mostrar al cliente se definen con el ambiente de integración.
5. **`CANCELLATION_PENDING` sin salida.** Si el proveedor nunca responde, el
   trabajo se queda en verificación. Con el simulado no pasa (alguien decide);
   con Webpay lo cierra la conciliación del punto 3 o una persona desde
   administración. Hoy no hay tarea programada que lo haga.
6. **Importe verificado, moneda no.** `confirm_payment_result` compara el
   importe; asume CLP. Webpay Plus solo opera en CLP, pero hay que dejarlo
   explícito al mapear la respuesta.
7. **Reembolso parcial y bonos.** El importe cobrado incluye el bono
   comprometido. Devolver solo el bono, o solo el servicio, necesita
   `PARTIALLY_REFUNDED` y reglas que hoy no están escritas.
