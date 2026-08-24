# G. Security Model

## 1. Autenticación

- **Supabase Auth** (email+password y magic link; OAuth opcional después). Cada `User` ↔ `auth.users`.
- Un `HouseholdMember` puede existir **sin cuenta** (menores u otros); un admin familiar lo administra y puede emitir invitación para vincular cuenta después (`invitations` con token de un solo uso y expiración).
- Sesiones estándar de Supabase (JWT); server-side en Next.js con verificación en cada request; sin lógica de permisos en el cliente (el cliente solo *oculta*, la base *impide*).

## 2. Aislamiento por Household

- Toda tabla de datos lleva `household_id` (directo o por FK inmediata a una tabla que lo tiene).
- **RLS activada en el 100 % de las tablas**; sin excepciones "temporales". Patrón base:
  - función `is_household_member(household_id)` (SECURITY DEFINER, cacheable) que valida la pertenencia del `auth.uid()`;
  - política por operación (SELECT/INSERT/UPDATE/DELETE), no una política única permisiva;
  - escritura adicionalmente condicionada por rol donde aplica (p. ej. editar `weekly_plans` requiere permiso de planificador; cerrar compras, de comprador).
- Tablas globales (ingredients, biomarker_definitions, clinical_rules): lectura pública autenticada, escritura solo rol de servicio/curador.
- Los jobs del sistema (recálculo, recordatorios) corren con service role **en el servidor únicamente**, nunca expuesto al cliente, y escriben `audit_events`.

## 3. Permisos por rol

- Roles configurables (`household_roles` + flags): integrante, planificador, comprador, cocinero, administrador familiar; una persona puede tener varios.
- Todos los integrantes con cuenta pueden: ver recetas, marcar favoritos, registrar gustos, ver la planificación familiar según permisos, editar **sus propios** objetivos/preferencias/patrones.
- Cambiar roles y gestionar integrantes: solo admin familiar.

## 4. Datos médicos (capa adicional, independiente de roles)

- Las tablas 🔒 de Health tienen RLS **más estricta**: `subject_member` (la persona, si tiene cuenta) + quienes tengan `health_data_grants` vigente con el scope necesario (SUMMARY / CONSTRAINTS_ONLY / FULL). Ser admin o planificador **no** otorga acceso médico.
- Para menores sin cuenta: el admin familiar actúa como responsable y sus accesos quedan auditados igualmente.
- El resto del sistema solo ve **efectos** no clínicos: `meal_compatibilities` ("requiere adaptación"), porciones, constraints referenciadas por id — sin diagnóstico ni valores.
- `NutritionDataConfidence` se muestra como recencia/completitud ("datos clínicos: incompletos"), nunca como puntaje de salud.

## 5. Archivos privados

- Bucket **privado** exclusivo para `lab_documents` (jamás bucket público para exámenes).
- Acceso solo por **signed URLs de corta duración**, emitidas server-side tras verificar `health_data_grants`; cada emisión deja `audit_event`.
- Estructura de paths por household/member; límites de tamaño y tipos permitidos (PDF/JPG/PNG/HEIC); antivirus/validación de tipo real en el upload.
- Fotos de perfil y de recetas en bucket separado con reglas propias (no mezclar con clínico).

## 6. Consentimiento IA

- Antes de enviar cualquier documento médico a un proveedor externo: pantalla de consentimiento explícita → `consent_records` (persona, scope, proveedor, quién otorgó, cuándo).
- Revocable: la revocación bloquea **futuros** análisis (los datos ya confirmados permanecen, con su origen registrado).
- Sin consentimiento: siempre existe el camino manual (tipear valores del examen).
- Minimización de payload hacia IA (ver [F](./F-ai-architecture.md)).

## 7. Logs y datos sensibles

- Prohibido: información médica en logs de aplicación normales, en mensajes de error, en analytics y en payloads de eventos de dominio (los eventos referencian ids, no valores clínicos).
- Trazas de IA con `traceId` + referencias; el contenido clínico solo en las tablas 🔒.

## 8. Auditoría

- `audit_events` append-only (sin UPDATE/DELETE, garantizado por permisos de tabla): accesos y modificaciones a datos de salud, confirmaciones de exámenes, otorgamiento/revocación de grants y consentimientos, cambios de roles, locks de semana, aplicación de reglas clínicas (regla+versión), overrides.
- Cada snapshot materializado (perfil, porciones, compras) registra insumos y versiones → trazabilidad completa de "por qué el sistema hizo X".

## 9. Eliminación y retención

- Salida de un integrante / derecho al olvido: borrado de datos personales y clínicos (documentos incluidos), conservando agregados no identificables donde sea necesario para la contabilidad del hogar (movimientos de inventario quedan como "integrante eliminado").
- Export de datos propios (JSON) por persona.
- Retención de `lab_documents`: configurable por el sujeto; por defecto se conservan mientras exista la cuenta.

## 10. Amenazas consideradas (resumen)

| Amenaza | Mitigación |
|---|---|
| Integrante ve exámenes de otro | RLS por grant + auditoría; UI solo muestra efectos |
| Fuga por bucket público | No existe bucket público clínico; signed URLs cortas |
| Cliente manipulado escribe datos ajenos | RLS por operación; permisos en DB, no en JS |
| Datos clínicos hacia IA sin permiso | ConsentRecord obligatorio + minimización + revocación |
| LLM "decide" algo clínico | Arquitectura: solo ClinicalRulesEngine determinista produce constraints |
| Cambios silenciosos post-compra | LOCK_WEEK + revisiones explícitas + change_impacts |
| Pérdida de trazabilidad | Snapshots versionados + audit append-only |
