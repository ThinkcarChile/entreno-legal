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
| `cancel_job(id, motivo)` | El cliente | Cancela y rechaza las ofertas pendientes |
| `accept_job_offer(offer)` | El cliente | **Atómica**: asigna, rechaza el resto, abre chat, audita y notifica |
| `withdraw_job_offer(offer)` | El trabajador | Retira su propia oferta pendiente |
| `open_job_conversation(job, worker)` | Cliente o trabajador con oferta | Abre o recupera el hilo del par |
| `mark_conversation_read(id)` | Participante | Marca leídos los mensajes de la contraparte |
| `mark_notifications_read(ids)` | Cualquier usuario conectado | Marca leídas sus notificaciones |
| `start_protected_payment(assignment)` | El cliente | Crea el pago con los montos calculados en la base |

El trabajador **no puede leer** `handoff_codes`: RLS solo permite la lectura al
cliente. Por eso el PIN sirve como prueba de presencia simultánea.

### Privadas (`app_private`)

`is_admin`, `is_job_participant`, `is_assignment_participant`, `is_verified_worker`,
`touch_updated_at`, `generate_reference`, `handle_new_user`, `sync_offer_count`,
`log_payment_event`, `validate_review`, `refresh_worker_reputation`,
`hold_payout_on_dispute`, `apply_loyalty_transaction`, `write_audit_log`.

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

Aplica el stub de Supabase, las migraciones, la semilla geográfica y 32
comprobaciones de RLS y de flujo completo. Ver `supabase/tests/`.

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
