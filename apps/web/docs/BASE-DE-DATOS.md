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
| `jobs` | Pública mientras está publicado | Comuna, región, lugar y punto redondeado a ~1 km |
| `job_private_location` | Cliente, trabajador asignado y administración | Dirección exacta, referencias y coordenadas |

### Identidad

| Tabla | Visibilidad | Notas |
|---|---|---|
| `profiles` | Lectura pública | Solo nombre, inicial del apellido, foto, bio, comuna |
| `user_private_data` | Titular + administración | RUT, teléfono, correo de contacto, dirección |
| `worker_profiles` | Lectura pública | Tarifa, verificaciones booleanas, reputación, nivel |
| `worker_verifications` | Titular + administración | Rutas en Storage privado, resultado del proveedor |
| `worker_payout_accounts` | Titular + administración | Cuenta bancaria |
| `worker_service_areas` | Lectura pública | Región, comuna y radio |
| `worker_categories` | Lectura pública | Categorías que atiende |

### Trabajos

`jobs` → `job_images`, `job_offers` → `assignments` → `job_extensions`, `handoff_codes`.

Restricciones que codifican reglas de producto:

- `jobs_objective_position_required`: un objetivo "dentro de los primeros X" exige X.
- `jobs_bonus_conditions_required`: un bono exige explicar cuándo se paga.
- `job_offers_single_accepted_idx`: una sola oferta aceptada por trabajo.
- `assignments_worker_not_client`: nadie se contrata a sí mismo.
- `worker_profiles_verified_to_accept`: sin verificación no se aceptan trabajos.

### Dinero

`payments` (cobro al cliente) → `payment_events` (append-only, escrito por trigger)
y `payouts` (liquidación al trabajador, con monto bruto, comisión, descuentos, bono,
retenciones, monto neto, estado y referencia bancaria).

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
| `review_worker_verification(...)` | Administración | Aprueba, rechaza o suspende, y avisa a la persona |
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
| `resolve_dispute(disputa, resultado, motivo, importe)` | **Administración** | Decide. No ejecuta ninguna devolución bancaria |
| `review_check_in(check-in, aprobado, motivo)` | **Administración** | Aprueba o rechaza una llegada |
| `approve_payout(payout, nota)` | **Administración** | Aprueba el pago al trabajador |
| `mark_payout_paid(payout, referencia, fecha, nota)` | **Administración** | Registra una transferencia hecha por fuera. Idempotente |
| `hold_payout(payout, motivo)` | **Administración** | Retiene con motivo escrito |
| `admin_pending_reviews()` | **Administración** | Recuentos de las colas del panel |

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
| Hacer retroceder un pago cobrado a «en vuelo» | disparador `a_payments_no_rollback`, sin exención para `service_role` | `…20260501000300` |
| Pagar al trabajador con el pago del cliente en revisión, fallido o devuelto | el payout se retiene solo | `…20260501000400` |
| Que un pago sin resolver se pierda al salir de la ventana de conciliación | `expire_stale_payments()` lo lleva a `FAILED` o a `UNDER_REVIEW`, y el invariante `stale_payment_out_of_window` lo delata si nadie lo hizo | `…20260501000500` |
| «Confirmar» el propio pago llamando a la función de confirmación | `confirm_payment_result` es solo del servicio | `…000400` |
| Marcar «voy en camino» en nombre del trabajador siendo el cliente | `mark_on_the_way` | Bloque 3 `…000100` |
| Escribir el estado de la asignación a mano, para saltarse el orden | ninguna: el usuario perdió el `UPDATE` | Bloque 3 `…000100` |
| Forjar un hito del sistema escribiendo `job_evidence.evidence_type` | `add_job_evidence` | Bloque 3 `…000100` |
| Aceptarse la propia extensión, o cambiarle el importe a una aceptada | `answer_job_extension` | Bloque 3 `…000100` |
| Leer el PIN de entrega con una consulta a `handoff_codes` | `get_handoff_code` | Bloque 3 `…000100` |
| Insertar una disputa ya RESUELTA a favor de quien la abre | `open_dispute` | Bloque 3 `…000200` |
| Borrar cualquier fila de `public` | ninguna: el `DELETE` se revocó en 28 relaciones | Bloque 3 `…000200` |

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
las pruebas exigen cero).

---

## Storage

| Bucket | Público | Contenido |
|---|---|---|
| `avatars` | Sí | Fotos de perfil |
| `job-images` | Sí | Fotos del trabajo publicado |
| `evidence` | No | Fotos de check-in y avance |
| `verification` | No | Documento y selfie de verificación |
| `dispute-files` | No | Archivos adjuntos a una disputa |

En los buckets privados la primera carpeta de la ruta debe ser el identificador del
usuario: las políticas de Storage lo exigen.

---

## Verificar el esquema

```bash
PGHOST=/tmp PGPORT=55432 PGUSER=postgres npm run db:test
```

Aplica el stub de Supabase, las 33 migraciones, la semilla geográfica y 225
comprobaciones de inventario, RLS, flujo completo, concurrencia, semilla de
demostración, endurecimiento de las RPC, política de cancelación y pago,
ejecución completa del trabajo e integración con Webpay. Todo con carreras reales entre dos sesiones,
`RACE_REPS` repeticiones. Ver `supabase/tests/`.

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
