# Base de datos — HagoTuFila

Referencia del esquema. Las migraciones están en `supabase/migrations/` y se aplican
en orden alfabético.

---

## Convenciones

| Regla | Motivo |
|---|---|
| Claves primarias `uuid` con `gen_random_uuid()` | No filtran volumen de negocio ni son adivinables |
| Fechas siempre `timestamptz` | Trabajos nocturnos y overnight cruzan días y cambios de horario |
| Dinero: `bigint` en unidad mínima + `currency char(3)` | Sin errores de redondeo; listo para otra moneda |
| `created_at` / `updated_at` con trigger | La aplicación no puede olvidarse de actualizarlos |
| Enums de PostgreSQL para estados | Coinciden uno a uno con `src/lib/domain/enums.ts` |
| RLS activo en todas las tablas | La autorización no depende del cliente |

`public.users` **no existe**: la identidad la administra `auth.users` de Supabase.
`public.profiles` es su proyección pública y la crea un trigger al registrarse.

---

## Migraciones

| Archivo | Contenido |
|---|---|
| `…000000_foundation.sql` | Esquemas, extensiones, todos los enums, utilidades |
| `…000100_reference_data.sql` | Países, regiones, comunas, categorías + semilla de categorías |
| `…000200_identity.sql` | Perfiles, datos privados, trabajadores, verificación, cuentas de pago |
| `…000300_jobs.sql` | Trabajos, imágenes, ofertas, asignaciones, extensiones, PIN |
| `…000400_payments.sql` | Pagos, eventos de pago, payouts |
| `…20260501000000_transbank_enums.sql` | `refund_status`, `refund_kind` y dos avisos |
| `…20260501000100_transbank_payments.sql` | Columnas de Webpay, `payment_refunds`, intento, retorno sin cobro y cola de conciliación |
| `…20260501000200_refund_invariants.sql` | Devolución total retiene el payout; invariantes al día |
| `…20260501000300_payment_no_rollback.sql` | Un pago cobrado no vuelve a estar «en vuelo» |
| `…20260501000400_hold_payout_on_review.sql` | Un pago en revisión, fallido o devuelto congela el payout |
| `…20260501000500_reconciliation_window.sql` | La ventana de conciliación pasa a ser configuración; los rezagados van a revisión |
| `…20260601000900_refund_unknown_enum.sql` | `refund_status.UNKNOWN`: devolución enviada sin respuesta en firme |
| `…20260601000910_refund_outcome_unknown.sql` | Clave de devolución por petición, una abierta por pago, máquina de estados, devoluciones por confirmar y su resolución |
| `…20260601000920_payments_worker_privacy.sql` | La fila del pago es del cliente y de administración; `assignment_payment_states` para las dos partes |
| `…20260601001000_payment_attempts.sql` | `payment_attempts`: historial de intentos con su token; el token se ata a su intento; cola de intentos anteriores; la vista de administración los cuenta |
| `…20260601001010_attempt_aware_confirmation.sql` | `confirm_payment_result` resuelve el intento del token (cobro duplicado → `DOUBLE_CHARGE`) y manda un descuadre a revisión sin pasar por `PAID` |
| `…20260601001020_abandonment_scoped_to_attempt.sql` | Un retorno sin cobro cierra solo su intento; los intentos anteriores también vencen con la ventana |
| `…20260601001400_refund_after_payout.sql` | Con el payout transferido, una devolución no pasa de lo que queda de la plataforma; una confirmada que descuadra las cifras retiene el payout; pedir, cerrar y resolver a mano una devolución bloquean trabajo → asignación → pagos → devolución |
| `…20260601001410_attempt_clock_and_lock_order.sql` | La ventana de conciliación corre desde el intento vigente; `register_payment_attempt` bloquea trabajo → asignación → pago |
| `…20260601001420_attempt_refunds.sql` | `payment_attempt_refunds`: devolver un cobro duplicado contra el token de su intento, con su conciliación y su cierre a mano |
| `…20260601001500_integrity_alert_notification.sql` | `notification_type.INTEGRITY_ALERT`: aviso a administración de un invariante roto |
| `…20260601001510_payment_review_queue.sql` | La cola «En revisión» de `/admin/pagos` se define una vez (`payment_review_queue`); `admin_pending_reviews.refunds` cuenta sus filas, cada pago una vez |
| `…20260601001520_invariants_in_scheduled_tasks.sql` | `run_scheduled_tasks` corre todos los invariantes, registra las reglas rotas en `app_private.integrity_alerts` y avisa a administración como mucho una vez al día por regla |
| `…20260601001600_payout_adjusted_notification.sql` | `notification_type.PAYOUT_ADJUSTED`: aviso al trabajador de que su pago se bajó o se canceló |
| `…20260601001610_payout_decisions.sql` | Lo que debe una disputa se reparte entre los cobros de su asignación (trabajo y tiempo adicional) y una devolución solo se liga a la disputa en su parte; CLIENT_WINS cubre el tiempo adicional y descuenta lo que está en devolución; el bono negado sale del payout en cualquier estado sin transferir; `adjust_payout` baja o cancela un payout que no cuadra; `approve_payout` ya no aprueba sin mirar las cifras |
| `…000500_evidence_and_chat.sql` | Evidencia, vistas `checkins` y `job_updates`, conversaciones, mensajes |
| `…000600_reviews_disputes.sql` | Reseñas con validación, disputas, evidencia de disputa |
| `…000700_loyalty_notifications_audit.sql` | FilaPuntos, notificaciones, `audit_logs` y sus triggers |
| `…000800_rls.sql` | Todas las políticas RLS y los privilegios de tabla y de columna |
| `…000900_views_functions_storage.sql` | Vistas `public_reviews` y `admin_kpis`, PIN, buckets de Storage |

### Etapa 2

| Archivo | Contenido |
|---|---|
| `20260201000000_job_location_privacy.sql` | `job_private_location`, punto aproximado en `jobs`, RLS |
| `20260201000050_notification_types.sql` | Nuevos valores del enum de notificaciones |
| `20260201000100_chat_and_notifications.sql` | Conversación por trabajo y trabajador, `notify_user`, avisos automáticos |
| `20260201000200_job_lifecycle.sql` | `accept_job_offer` atómica, congelado de precio y de campos críticos, pago previo obligatorio |
| `20260201000300_accounts_and_verification.sql` | Onboarding, modos de cuenta, zonas, solicitud y resolución de verificación |
| `20260201000400_publish_job.sql` | `publish_job` y `update_open_job` |
| `20260201000500_settings_and_payments.sql` | `platform_settings`, `start_protected_payment`, payout automático, vista de desglose |
| `20260201000600_offer_write_scope.sql` | Corrige el permiso que dejaba al cliente reescribir una oferta |

---

## Mapa de tablas

### Ubicación

| Tabla | Visibilidad | Notas |
|---|---|---|
| `jobs` | Pública mientras está publicado | Comuna, región, lugar y punto redondeado a ~1 km. `instructions` no: sin privilegio de lectura con la clave pública; las entrega `get_job_instructions` (`…001100`) |
| `job_private_location` | Cliente, trabajador asignado y administración | Dirección exacta, referencias y coordenadas |

### Identidad

| Tabla | Visibilidad | Notas |
|---|---|---|
| `profiles` | Titular, administración y contrapartes (oferta, conversación o asignación); cualquiera si es trabajador verificado | Se leen nombre, inicial del apellido, foto (ruta en `avatars`), bio, comuna y región. `role`, `roles`, `is_suspended` y el estado del onboarding no son legibles con la clave pública: la propia cuenta, con `get_my_account` (`…001110`) |
| `user_private_data` | Titular + administración | RUT, teléfono, correo de contacto, dirección |
| `worker_profiles` | Cualquiera si está verificado; si no, titular, administración y contrapartes | Tarifa, verificaciones booleanas, reputación, nivel |
| `worker_verifications` | Titular + administración | Rutas en Storage privado, resultado del proveedor |
| `worker_payout_accounts` | Titular + administración | Cuenta bancaria |
| `worker_service_areas` | Como `worker_profiles` | Región, comuna y radio |
| `worker_categories` | Como `worker_profiles` | Categorías que atiende |

### Trabajos

`jobs` → `job_images`, `job_offers` → `assignments` → `job_extensions`, `handoff_codes`.

Restricciones que codifican reglas de producto:

- `jobs_objective_position_required`: un objetivo "dentro de los primeros X" exige X.
- `jobs_bonus_conditions_required`: un bono exige explicar cuándo se paga.
- `job_offers_single_accepted_idx`: una sola oferta aceptada por trabajo.
- `assignments_worker_not_client`: nadie se contrata a sí mismo.
- `worker_profiles_verified_to_accept`: sin verificación no se aceptan trabajos.
- `job_offers_compute_total` (disparador): el total de una oferta pendiente es
  `round(tarifa × duración / 60)`; lo que envíe quien oferta se ignora (`…001130`).
  Lee la duración con la fila del trabajo bloqueada, así que una oferta que
  llega mientras el cliente cambia la duración se calcula con la nueva.
- `assignments_agreed_total` (disparador): al crearse una asignación,
  `agreed_total` —lo que se cobra— es `round(tarifa × duración / 60)` de la
  tarifa y la duración que ella misma registra, aunque `accept_job_offer` haya
  leído la oferta antes de que el cliente cambiara la duración (`…001130`).
- `profiles_first_name_valid`, `profiles_last_name_initial_valid` y
  `profiles_avatar_own_path`: el nombre público va recortado, de 1 a 60
  caracteres, sin saltos de línea, caracteres invisibles, comillas, direcciones
  web ni «HagoTuFila»; la inicial es una letra; la foto es una ruta dentro de la propia
  carpeta del bucket `avatars` (`…001120`). Los avisos citan el nombre entre
  comillas angulares: «Camila F.».

#### Total de una oferta

Las ofertas aceptadas antes de `…001130` conservan su importe (están congeladas
y su asignación ya lo copió). Para ver si alguna se aparta de la fórmula:

```sql
select o.id, o.status, o.estimated_total,
       app_private.offer_total(o.hourly_rate, j.estimated_duration_minutes) as esperado
  from public.job_offers o join public.jobs j on j.id = o.job_id
 where o.estimated_total <> app_private.offer_total(o.hourly_rate, j.estimated_duration_minutes);
```

Una que difiera y cuya asignación siga en `AWAITING_PAYMENT` se revisa a mano
antes de cobrarla.

### Dinero

`payments` (cobro al cliente) → `payment_events` (append-only, escrito por trigger)
y `payouts` (liquidación al trabajador, con monto bruto, comisión, descuentos, bono,
retenciones, monto neto, estado y referencia bancaria).

`payment_attempts` guarda cada intento de un pago en Webpay —orden de compra,
sesión, número, token, fechas y resultado (`CREATED`, `FAILED`, `SETTLED`,
`DOUBLE_CHARGE`, `UNDER_REVIEW`)—. El pago lleva el token del intento vigente;
los anteriores no se sobrescriben. Solo lo escribe el rol de servicio y solo lo
lee administración, sin el token.

`payment_attempt_refunds` guarda las devoluciones del cobro de UN intento —un
cobro duplicado o un intento en revisión—, contra el token de ese intento y por
su cobro entero. Mismos estados y mismo disparador de transiciones que
`payment_refunds`, una sola comprometida por intento, y no toca el pago. Solo la
escribe el rol de servicio por RPC y solo la lee administración.

### Evidencia

`job_evidence` es la única tabla de bitácora. `checkins` y `job_updates` son vistas
con `security_invoker = true`.

### Resto

`conversations` + `messages` (chat por trabajo, en Realtime), `reviews`, `disputes` +
`dispute_evidence`, `loyalty_accounts` + `loyalty_transactions`, `notifications`,
`audit_logs`.

---

## Funciones

### Públicas (RPC)

| Función | Quién puede llamarla | Qué hace |
|---|---|---|
| `generate_handoff_code(assignment)` | El cliente del trabajo | Crea o recupera el PIN de 4 dígitos |
| `verify_handoff_code(assignment, code)` | El trabajador asignado | Valida el PIN, marca la entrega y registra evidencia |
| `complete_onboarding(...)` | Cualquier usuario conectado | Escribe perfil público y datos privados, y fija los modos |
| `set_account_modes(client, worker)` | Cualquier usuario conectado | Activa o desactiva el modo trabajador |
| `set_worker_service_areas(jsonb)` | El trabajador | Reemplaza sus zonas en bloque |
| `request_worker_verification(...)` | El trabajador | Crea la solicitud y deja el estado en `PENDING` |
| `review_worker_verification(...)` | Administración | Aprueba, rechaza o suspende una solicitud **pendiente**, y avisa a la persona. Una ya resuelta no se vuelve a resolver: falla diciendo en qué quedó (`…001140`) |
| `get_job_instructions(job)` | Cliente, trabajador asignado (asignación viva) y administración | Las instrucciones del trabajo. A cualquier otro, `NULL` |
| `get_my_account()` | Cualquier usuario conectado | Su propio perfil con rol, modos y estado de la cuenta |
| `publish_job(jsonb)` | El cliente | Crea el trabajo y su dirección privada en una sola operación |
| `update_open_job(id, jsonb)` | El cliente | Edita mientras el trabajo siga abierto y avisa a quien ofertó |
| `cancel_job(id, motivo)` | El cliente | Cancela mirando el pago: sin dinero en juego, en el acto; con un pago en vuelo, deja el trabajo en `CANCELLATION_PENDING` hasta que el proveedor responda; con pago confirmado, la rechaza (reembolso o disputa). Ver `PAGOS.md` |
| `accept_job_offer(offer)` | El cliente | **Atómica**: asigna, rechaza el resto, abre chat, audita y notifica |
| `withdraw_job_offer(offer)` | El trabajador | Retira su propia oferta pendiente |
| `open_job_conversation(job, worker)` | Cliente o trabajador con oferta | Abre o recupera el hilo del par |
| `mark_conversation_read(id)` | Participante | Marca leídos los mensajes de la contraparte (`SECURITY INVOKER`) |
| `mark_notifications_read(ids)` | Cualquier usuario conectado | Marca leídas sus notificaciones (`SECURITY INVOKER`) |
| `start_protected_payment(assignment)` | El cliente | Crea el pago con los montos calculados en la base |
| `confirm_payment_result(pago, proveedor, evento, resultado, importe, detalles)` | **Solo la clave de servicio** (`EXECUTE` revocado a todo usuario) | Única entrada de resultados del proveedor: registra el evento una vez por identificador, decide bajo bloqueo `jobs → assignments → payments` y devuelve qué pasó |
| `assignment_payment_states(asignaciones)` | Cliente y trabajador de cada asignación, y administración | Propósito, estado, importe y fechas de sus pagos. Nada del proveedor ni de la tarjeta: el trabajador no lee filas de `payments` |
| `request_payment_refund(pago, importe, motivo, clave, disputa)` | **Administración** | Deja pedida una devolución. Idempotente por petición; una sola abierta por pago. Ligada a una disputa, solo la de la misma asignación, resuelta, y por la parte que la cola le asigna a ESE cobro; sin ligar, sin tocar esa parte (`…001610`) |
| `resolve_unknown_refund(devolución, hecha, tipo, nota)` | **Administración** | Cierra una devolución por confirmar con lo que muestra el portal de Transbank |
| `claim_payment_refund`, `settle_payment_refund`, `mark_payment_refund_unknown`, `refunds_pending_reconciliation` | **Solo la clave de servicio** | Reservar el envío al banco, cerrar con su respuesta, dejarla por confirmar y encontrar las que hay que conciliar. Ver `TRANSBANK.md` §7 |
| `request_attempt_refund(intento, motivo, clave)` | **Administración** | Deja pedida la devolución del cobro entero de un intento `DOUBLE_CHARGE` o `UNDER_REVIEW` que no respalda el pago. Idempotente por petición; una sola comprometida por intento |
| `resolve_unknown_attempt_refund(devolución, hecha, tipo, nota)` | **Administración** | Cierra la devolución por confirmar de un cobro duplicado con lo que muestra el portal de Transbank |
| `claim_attempt_refund`, `settle_attempt_refund`, `mark_attempt_refund_unknown`, `attempt_refunds_pending_reconciliation` | **Solo la clave de servicio** | Lo mismo que las de arriba, para la devolución de un intento. Ver `PAGOS.md` §8 quater |

### Ejecución del trabajo (Bloque 3)

Todas bloquean `jobs → assignments` por `app_private.lock_assignment_for`, que
exige sesión y comprueba el papel de quien llama. Ver `docs/EJECUCION.md`.

| Función | Quién puede llamarla | Qué hace |
|---|---|---|
| `mark_on_the_way(assignment)` | El trabajador asignado | Avisa que salió. Idempotente |
| `register_check_in(assignment, consentimiento, lat, lng, precisión, origen)` | El trabajador asignado | Registra la llegada, calcula la distancia contra la dirección real y decide si queda verificada o en revisión. Se puede repetir |
| `start_job_work(assignment)` | El trabajador asignado | Comienza el trabajo. Exige un check-in verificado o aprobado a mano |
| `add_job_evidence(assignment, tipo, título, cuerpo, ruta, mime, tamaño, fila)` | Las dos partes | Publica una actualización o un archivo. Rechaza los tipos reservados al sistema |
| `request_job_extension(assignment, minutos, motivo)` | El trabajador asignado | Pide más tiempo. El importe lo calcula la base |
| `answer_job_extension(extensión, aceptar)` | El cliente | Responde, una sola vez. Al aceptar crea el cobro adicional |
| `start_extension_payment(extensión)` | El cliente | Devuelve el cobro adicional para llevarlo al proveedor |
| `generate_handoff_code(assignment)` | El cliente | Crea o renueva el PIN de 4 dígitos |
| `get_handoff_code(assignment)` | El cliente | Única vía de lectura del PIN |
| `request_handoff_code(assignment)` | El trabajador asignado | Avisa al cliente. No devuelve el código |
| `verify_handoff_code(assignment, código)` | El trabajador asignado | Valida la entrega. Un solo uso, cinco intentos, solo los fallos gastan intento |
| `request_job_completion(assignment, nota)` | El trabajador asignado | Da el trabajo por terminado. **No libera el pago** |
| `approve_job_completion(assignment, bono)` | El cliente | Aprueba y libera el pago al trabajador |
| `submit_review(assignment, notas…)` | Las dos partes | Reseña, solo tras la aprobación y una por persona |
| `open_dispute(assignment, motivo, descripción)` | Las dos partes | Abre la disputa y retiene el pago |
| `add_dispute_evidence(disputa, texto, ruta, mime, tamaño)` | Partes y administración | Aporta una prueba |
| `resolve_dispute(disputa, resultado, motivo, importe)` | **Administración** | Decide. No ejecuta ninguna devolución bancaria. No paga al trabajador sobre un cobro devuelto entero ni deja un payout aprobado que no cuadre con lo devuelto. El importe se mide contra lo cobrado en la asignación (trabajo más tiempo adicional) y lo que todavía se puede devolver; CLIENT_WINS sin importe anota todo lo que queda por devolver (`…001610`) |
| `review_check_in(check-in, aprobado, motivo)` | **Administración** | Aprueba o rechaza una llegada |
| `approve_payout(payout, nota)` | **Administración** | Aprueba el pago al trabajador. No sobre un cobro devuelto entero ni en revisión, con una devolución sin respuesta o con cifras que no cuadran; descuenta un bono que el cliente negó (`…001610`) |
| `adjust_payout(payout, neto, motivo)` | **Administración** | Baja el neto de un payout sin transferir (`PENDING`, `APPROVED`, `HELD`), o lo cancela con 0. Nunca lo sube; con una disputa abierta solo baja, no cancela. Auditoría, línea de tiempo y aviso `PAYOUT_ADJUSTED` al trabajador (`…001610`) |
| `mark_payout_paid(payout, referencia, fecha, nota)` | **Administración** | Registra una transferencia hecha por fuera. Idempotente. Exige el cobro del cliente sano, las cifras cuadradas, la ventana cerrada y un cobro de producción (o `allow_non_production_payouts` en una base de pruebas). Ver `PAGOS.md` §4 bis |
| `hold_payout(payout, motivo)` | **Administración** | Retiene con motivo escrito |
| `admin_pending_reviews()` | **Administración** | Recuentos de las colas del panel. `refunds` es el número de filas de `admin_payment_review_queue`: un pago cuenta una vez aunque tenga varios motivos (`…001510`) |
| `admin_payment_review_queue()` | **Administración** | La cola «En revisión» de `/admin/pagos`: un pago por fila —en revisión, con una devolución sin resultado final, con un intento en revisión o con su parte de la devolución de una disputa resuelta sin pedir— y el porqué. `dispute_id` es la disputa a la que se liga una devolución de ESE cobro. Admite `order`, `limit` y filtros de PostgREST |
| `admin_integrity_alerts()` | **Administración** | Las reglas de invariante rotas según la última pasada de las tareas programadas, y si alguien ya las vio (`…001520`) |
| `acknowledge_integrity_alerts()` | **Administración** | Marca como vistas las reglas rotas sin ver; queda en `audit_logs`. No las resuelve ni detiene el aviso diario |

El trabajador **no puede leer** `handoff_codes`: RLS solo permite la lectura al
cliente. Por eso el PIN sirve como prueba de presencia simultánea.

### Por qué cada una es `SECURITY DEFINER`, una por una

El advisor de seguridad de Supabase avisa de toda función `SECURITY DEFINER` que
un usuario con sesión pueda ejecutar. Son catorce, y aceptarlas en bloque
«porque son la API» no es una respuesta: se auditaron una por una en la Etapa
2.5 y el motivo concreto de cada una está en `AVISOS_ACEPTADOS`, dentro de
`scripts/verify-schema-hosted.ts`, que además falla si aparece una función nueva
sin auditar o si sobra una que el advisor ya no reporta.

El criterio es siempre el mismo: **qué escritura le negaría RLS al llamante**.
Si no hay ninguna, la función no necesita `SECURITY DEFINER`. Dos no la
necesitaban:

| Función | Era | Es | Por qué |
|---|---|---|---|
| `mark_conversation_read` | DEFINER | **INVOKER** | Solo escribe `messages.read_at` en filas que `messages_mark_read` ya autoriza al participante |
| `mark_notifications_read` | DEFINER | **INVOKER** | Solo escribe `notifications.read_at` de sus propias filas, que es lo que permite `notifications_own_update` |

Pasarlas a `INVOKER` no es cosmética: vuelve a aplicarse RLS, de modo que si
mañana se endurece una de esas políticas, la RPC hereda el cambio en vez de
seguir aplicando en silencio la regla antigua.

Las catorce restantes sí la necesitan, y la prueba negativa de cada una está
en `supabase/tests/06_rpc_hardening.sql` (local) y en la sección «Escritura
directa» de `scripts/verify-supabase.ts` (contra el proyecto real).

### Las RPC no son el único camino, y ese era el problema

Auditar las funciones dejó claro que estaban razonablemente escritas y que el
agujero estaba al lado: **no hacía falta llamarlas**. La Etapa 1 restringió con
cuidado el `UPDATE` por columna, pero el `INSERT` quedó abierto a todas las
columnas de todas las tablas, y casi todas tienen una política del tipo «inserta
tus propias filas». Cinco abusos comprobados contra el esquema real, no
supuestos, y todos rodean a una de las dieciséis:

| Abuso | Rodeaba a | Corregido en |
|---|---|---|
| Insertarse un `worker_profiles` ya `VERIFIED`, nivel `EXPERTO` y reputación inventada | `request_worker_verification` + `review_worker_verification` | `…000100` |
| Insertar una oferta ya `ACCEPTED` | `accept_job_offer` | `…000100` |
| Multiplicar por diez el `agreed_total` de la propia asignación | `accept_job_offer` (que congela los importes) | `…000100` |
| Marcar el propio trabajo como `PAID` sin pagar | `start_protected_payment` | `…000100` |
| Insertarse una verificación ya `VERIFIED` | `review_worker_verification` | `…000100` |
| Poner la propia oferta en `ACCEPTED` por `UPDATE`, bloqueando el trabajo | `accept_job_offer` | `…000200` |
| Reescribir el texto de un mensaje de la contraparte | `mark_conversation_read` | `…000200` |
| Reescribir el contenido de los propios avisos | `mark_notifications_read` | `…000200` |
| Crear un payout a mano, sobre un pago sin confirmar o sobre un trabajo cancelado | `confirm_payment_result` (y `payouts_guard` para el propio sistema) | `…000400` |
| Reescribir o borrar `payments`, `payment_events` o `payouts` | ninguna: el usuario perdió `UPDATE`, `DELETE` y `TRUNCATE` | `…000400` |
| Escribir en `payment_refunds` | ninguna: sin `INSERT`, `UPDATE`, `DELETE` ni `TRUNCATE` para `authenticated`; solo lectura y solo administración | `…20260501000100` |
| Devolver más de lo cobrado | la suma de lo pedido y lo confirmado no puede superar el importe | `…20260501000100` |
| Marcar devuelto sin respuesta del proveedor | `CONFIRMED` exige decir si fue reversa o anulación, y solo lo escribe `service_role` | `…20260501000200` |
| Devolver dos veces: una segunda devolución mientras la primera está en curso o sin respuesta en firme del banco | índice único de una devolución abierta por pago, y `request_payment_refund` | `…20260601000910` |
| Saltarse los pasos de una devolución (reabrir una fallida, deshacer una confirmada) | disparador `payment_refunds_guard_transitions`, sin exención para `service_role` | `…20260601000910` |
| Leer, como trabajador, los dígitos de la tarjeta y la autorización del pago del cliente | `payments_read` es del cliente y de administración; el trabajador usa `assignment_payment_states` | `…20260601000920` |
| Leer el token de Webpay por `provider_transaction_id` | sin `SELECT` de esa columna para `authenticated` | `…20260601000920` |
| Hacer retroceder un pago cobrado a «en vuelo» | disparador `a_payments_no_rollback`, sin exención para `service_role` | `…20260501000300` |
| Pagar al trabajador con el pago del cliente en revisión, fallido o devuelto | el payout se retiene solo | `…20260501000400` |
| Que un pago sin resolver se pierda al salir de la ventana de conciliación | `expire_stale_payments()` lo lleva a `FAILED` o a `UNDER_REVIEW`, y el invariante `stale_payment_out_of_window` lo delata si nadie lo hizo | `…20260501000500` |
| Leer o escribir el historial de intentos, o el token de uno | ninguna: sin privilegios para `anon`; `authenticated` solo lee columnas sin token y solo administración ve filas | `…20260601001000` |
| Que un segundo cobro de otro intento se pierda, o que un descuadre habilite el trabajo | `confirm_payment_result` resuelve el intento del token bajo cerrojo: `DOUBLE_CHARGE` a la vista, revisión sin pasar por `PAID` | `…20260601001010` |
| Devolver, con el trabajador ya pagado, más de lo que queda de la plataforma | `request_payment_refund` (`refund_after_payout_blocker`) | `…20260601001400` |
| Ligar una devolución a una disputa de otro trabajo, abierta, que ya no debe nada o sobre un cobro que no es el suyo, o devolver sin ligar la parte reservada a una disputa | `request_payment_refund` (`dispute_refund_allocation`) | `…20260601001610` |
| Transferir un bono que el cliente negó | `approve_completion_core` lo descuenta en cualquier estado sin transferir; `payout_money_blocker` (`payout_bonus_blocker`) | `…20260601001610` |
| Escribir en `payment_attempt_refunds`, devolver dos veces el cobro de un intento o devolver por ahí el cobro que pagó el trabajo | ninguna para el usuario; `request_attempt_refund`, índice de una comprometida por intento, disparadores `payment_attempt_refunds_guard_*` y `payment_attempts_guard_money` | `…20260601001420` |
| «Confirmar» el propio pago llamando a la función de confirmación | `confirm_payment_result` es solo del servicio | `…000400` |
| Marcar «voy en camino» en nombre del trabajador siendo el cliente | `mark_on_the_way` | Bloque 3 `…000100` |
| Escribir el estado de la asignación a mano, para saltarse el orden | ninguna: el usuario perdió el `UPDATE` | Bloque 3 `…000100` |
| Forjar un hito del sistema escribiendo `job_evidence.evidence_type` | `add_job_evidence` | Bloque 3 `…000100` |
| Aceptarse la propia extensión, o cambiarle el importe a una aceptada | `answer_job_extension` | Bloque 3 `…000100` |
| Leer el PIN de entrega con una consulta a `handoff_codes` | `get_handoff_code` | Bloque 3 `…000100` |
| Insertar una disputa ya RESUELTA a favor de quien la abre | `open_dispute` | Bloque 3 `…000200` |
| Borrar cualquier fila de `public` | ninguna: el `DELETE` se revocó en 28 relaciones | Bloque 3 `…000200` |
| Leer sin sesión las instrucciones («accesos») de un trabajo publicado | `get_job_instructions` | `20260601001100` |
| Listar sin sesión todos los perfiles, clientes incluidos, y saber quién administra | ninguna: RLS por relación y privilegio de columna | `20260601001110` |
| Ponerse un nombre que se lee como aviso de la plataforma, o una foto de otro dominio | ninguna: restricciones `CHECK` sobre `profiles` | `20260601001120` |
| Fijar el total de la propia oferta, que es lo que se cobra | `accept_job_offer` (copia el total) | `20260601001130` |
| Resolver dos veces una verificación, o aprobar una ya rechazada | `review_worker_verification` | `20260601001140` |

Y ocho de las dieciséis **no fallaban sin sesión**: se apoyaban en una
comparación `dueño <> auth.uid()`, y con `auth.uid()` nulo esa expresión vale
NULL, así que el `if` no entra en la rama y la comprobación se salta sola.
Comprobado: sin sesión, `cancel_job` cancelaba el trabajo de otro cliente. No
era alcanzable desde internet —`anon` no tiene `EXECUTE`— pero dejaba la
autorización en una sola línea de defensa. Corregido en `…000200`, y lo prueba
`H01` de `supabase/tests/06_rpc_hardening.sql`.

### Privadas (`app_private`)

`is_admin`, `is_job_participant`, `is_assignment_participant`, `is_verified_worker`,
`touch_updated_at`, `generate_reference`, `handle_new_user`, `sync_offer_count`,
`log_payment_event`, `validate_review`, `refresh_worker_reputation`,
`hold_payout_on_dispute`, `apply_loyalty_transaction`, `write_audit_log`.

Y las del Bloque 3: `lock_assignment_for` (bloqueo canónico y comprobación del
papel), `timeline_event` (línea de tiempo idempotente por `event_key`),
`distance_m` (haversine, sin PostGIS), `on_extension_paid` (suma el cobro
adicional al payout), `refresh_worker_stats` (completados, minutos,
cancelaciones, cumplimiento y puntualidad) y `guard_payout_transitions` (copia
en la base de `payoutTransitions`).

Y las del dinero, desde la Etapa 2.5 (`…000400`): `guard_payment_settlement`
(BEFORE UPDATE en `payments`: decide habilitar o revisar, bajo bloqueo),
`on_payment_paid` (AFTER UPDATE: habilita, crea el payout, avisa),
`guard_payout` (ningún payout sin pago `PAID`, sobre cancelado o a otro
trabajador), `guard_job_terminal` (un trabajo cancelado no revive),
`finalize_job_cancellation` (lo que comparten `cancel_job` y la confirmación
tardía), `create_payout_for_assignment` (idempotente) y
`payment_invariant_violations()` (devuelve toda fila que rompa los invariantes;
las pruebas exigen cero, y desde `…001520` también la corren las tareas
programadas).

Y las del seguimiento de pagos (`20260601001400`–`…001420`):
`refund_after_payout_blocker` (lo que queda de la plataforma con el payout
transferido), `hold_payout_on_unhealthy_payment` ampliada (retiene el payout
cuando una devolución confirmada descuadra las cifras), `payment_window_start`
(desde cuándo corre la ventana del proveedor: el intento vigente),
`guard_attempt_refund_identity` y `guard_attempt_money` (un intento devuelto no
pasa a ser el dinero del pago; un `DOUBLE_CHARGE` registra su cobro), y
`refund_invariant_violations()` con `attempt_refund_on_payment_money` y
`attempt_refund_over_charge`.

Y las de qué se lee y qué se escribe en público (`20260601001100`–`…001140`):
`can_see_profile` (la regla única de visibilidad de `profiles`,
`worker_profiles`, zonas y categorías), `review_author_card` (nombre, inicial y
foto de quien escribió una reseña publicada, para `public_reviews`),
`person_name_problem`, `is_valid_initial`, `is_own_avatar_path` y
`clean_person_name` (las reglas del nombre y la foto, usadas por las
restricciones `CHECK` y por el alta), `quoted_display_name` (el nombre citado en
los avisos), y `offer_total`, `compute_offer_total`,
`sync_pending_offer_totals` y `compute_agreed_total` (el total de una oferta y
el importe acordado de la asignación que sale de ella).

Y las de vigilancia (`20260601001510`–`…001520`): `payment_review_queue` (la
única definición de la cola «En revisión»: la cuenta `admin_pending_reviews` y
la listan `admin_payment_review_queue` y `/admin/pagos`; los motivos del pago
los lee de la vista `admin_payments`, la misma de la pantalla, y desde
`…001610` la parte de cada disputa sobre cada cobro de
`dispute_refund_allocation`, que también usa `request_payment_refund`) y `check_invariants`
(corre cada `app_private.*_invariant_violations()` —las que no reciben
argumentos y devuelven `(rule text, entity_id uuid)`, buscadas en el
catálogo—, cada una aislada; guarda las reglas rotas en
`app_private.integrity_alerts`, una fila por función y regla, con cuántos casos,
hasta cinco ejemplos y desde cuándo; y avisa a cada administrador con
`INTEGRITY_ALERT` como mucho una vez cada 24 horas por regla mientras siga
rota). La llama `run_scheduled_tasks`, que devuelve lo encontrado en la clave
`invariantes`. Una regla que deja de aparecer se da por resuelta, salvo que la
función que la delata haya fallado en esa pasada; la de una función que ya no
existe, también; si vuelve, es un caso nuevo, sin ver. Nadie con sesión lee ni escribe `integrity_alerts`: el panel pasa por
`admin_integrity_alerts` y `acknowledge_integrity_alerts`.

Y las de abuso y archivos (`20260601001200`–`…001210`): `enforce_rate_limit`
(BEFORE INSERT en `jobs`, `job_offers` y `messages`, ver abajo),
`rate_limit_wait_text`, `storage_upload_allowed` y `storage_object_deletable`
(las evalúan las políticas de Storage como `authenticated`),
`storage_lock_key` y `verified_upload` (el archivo que registran
`add_job_evidence` y `add_dispute_evidence` es el que está en
`storage.objects`).

### Límites por usuario

Cada alta que una persona hace **con su sesión** en `jobs`, `job_offers` o
`messages` deja una marca en `app_private.rate_limit_events`, y un disparador
rechaza la siguiente si ya llegó al límite de la ventana:

| Columna de `platform_settings` | Por omisión | Ventana |
|---|---|---|
| `rate_limit_jobs_per_day` | 30 trabajos | 24 horas móviles |
| `rate_limit_offers_per_hour` | 30 ofertas, retiradas incluidas | 1 hora móvil |
| `rate_limit_messages_per_minute` | 20 mensajes | 1 minuto móvil |

Vale para cualquier cliente, también para quien llama a PostgREST directo con
la clave pública. No cuentan ni se limitan: lo que crea el sistema sin sesión
(rol de servicio, tareas programadas, semillas), la administración, ni los
avisos `SYSTEM` del chat. El error sale con SQLSTATE `PT429` —PostgREST lo
devuelve como HTTP 429— y dice cuándo se puede volver a intentar («Podrás
publicar otro en 3 h 20 min.»). Cambiar un límite es un `update` sobre
`platform_settings`, no una migración.

> Las verificaciones contra el proyecto alojado (`verify:execution`,
> `verify:payments`, `verify:supabase`) publican y ofertan por el camino real,
> con las mismas cuentas de control de calidad: con `RACE_REPS` en 5, 18 + 19 +
> 2 trabajos del mismo cliente y casi otras tantas ofertas del mismo
> trabajador, y más con `RACE_REPS=10`. Una pasada completa **no** cabe en los
> valores por omisión: antes de la primera, sube `rate_limit_jobs_per_day` y
> `rate_limit_offers_per_hour` en `hagotufila-dev` (`DESPLIEGUE-SUPABASE.md`
> §8.1, con el `update` y las cuentas). En producción, no.

El registro y el ingreso no pasan por aquí: los limita Supabase Auth, que se
configura en el panel (`DESPLIEGUE-SUPABASE.md` §4.6).

---

## Storage

| Bucket | Público | Contenido | Subir (con sesión) | Borrar (con sesión) |
|---|---|---|---|---|
| `avatars` | Sí | Fotos de perfil | Carpeta propia | Carpeta propia |
| `job-images` | Sí | Fotos del trabajo publicado | Carpeta propia, en un trabajo propio en `DRAFT` o `PUBLISHED` | Nadie |
| `evidence` | No | Fotos de check-in y avance | Carpeta propia, en una asignación en la que participa | Lo propio, mientras no esté registrado |
| `verification` | No | Documento y selfie de verificación | Carpeta propia | Nadie |
| `dispute-files` | No | Archivos adjuntos a una disputa | Carpeta propia, en una disputa sin resolver en la que participa | Lo propio, mientras no esté registrado |

La primera carpeta de la ruta es siempre el identificador del usuario, y en
`evidence`, `dispute-files` y `job-images` la segunda es el ámbito: la
asignación, la disputa o el trabajo (`<usuario>/<ámbito>/<archivo>`). Lo exigen
las políticas de Storage (migración `20260601001210`), no solo la aplicación.
Una evidencia registrada no la borra nadie con sesión. Tamaño y tipos por
bucket: migración `20260601000600`.

---

## Verificar el esquema

```bash
PGHOST=/tmp PGPORT=55432 PGUSER=postgres npm run db:test
```

Aplica el stub de Supabase, las 46 migraciones, la semilla geográfica y 340
comprobaciones de inventario, RLS, flujo completo, concurrencia, semilla de
demostración, endurecimiento de las RPC, política de cancelación y pago,
ejecución completa del trabajo, integración con Webpay y lo que leen y escriben
un visitante sin sesión y los demás usuarios (`14_public_data.sql` y
`14_race_duration.sh`, prefijo U).
Todo con carreras reales entre dos sesiones, `RACE_REPS` repeticiones. Ver `supabase/tests/`.

Contra el proyecto alojado, los mismos escenarios corren con
`npm run verify:payments` (ver `PAGOS.md` §8) y `npm run verify:execution`
(ver `EJECUCION.md` §14).

Contra un proyecto Supabase alojado el equivalente es
`npm run verify:schema:hosted`. Las cifras esperadas son las mismas a propósito;
lo que solo se ve en un proyecto real son los privilegios que trae de fábrica
—ver la migración `20260301000000_hosted_privileges.sql`— y los advisors.

## Semilla de demostración

```bash
psql "$DATABASE_URL" -f supabase/seed/002_demo_accounts.sql
psql "$DATABASE_URL" -f supabase/seed/003_demo_content.sql
```

Crea once cuentas (`…@demo.cl`, contraseña `hagotufila2026`), trabajadores con
distintos niveles de reputación y estados de verificación, trabajos abiertos en
seis regiones, ofertas, un trabajo asignado y pagado, conversaciones con
mensajes y una reseña verificada.

**Solo para desarrollo.** Crea usuarios con contraseña conocida.

## Regenerar la semilla geográfica

```bash
npm run seed:geo
```

Lee `src/lib/geo/chile.ts` y reescribe `supabase/seed/001_geo.sql`
(16 regiones, 346 comunas).

## Regenerar los tipos de TypeScript

Con un proyecto Supabase activo:

```bash
npx supabase gen types typescript --project-id <id> --schema public \
  > src/lib/supabase/database.types.ts
```
