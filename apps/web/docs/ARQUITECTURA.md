# Arquitectura — HagoTuFila.cl

Documento de referencia de la Etapa 1. Describe decisiones, capas y los puntos donde
deliberadamente se evitó deuda técnica.

---

## 1. Ubicación del proyecto dentro del repositorio

El repositorio `entreno-legal` ya publica en GitHub Pages un `index.html` en la raíz
(política de privacidad de otra aplicación, enlazada desde Google Play). Crear el proyecto
Next.js en la raíz habría sobreescrito ese archivo y roto un enlace legal en producción.

La aplicación vive en `apps/web/`. La estructura `apps/*` deja espacio para
`apps/mobile` y `packages/*` compartidos sin reorganizar nada más adelante.

---

## 2. Capas

```
UI (React Server Components + Client Components)
   ↓  solo consume tipos de dominio y repositorios
Repositorios (interfaces de acceso a datos)
   ↓  dos implementaciones intercambiables: demo | supabase
Servicios de dominio (pricing, reputación, máquina de estados, dinero, fechas)
   ↓  puros, sin dependencias de framework ni de base de datos
Proveedores externos (PaymentProvider, IdentityVerificationProvider, NotificationChannel)
```

Reglas que sostienen la separación:

- `src/lib/domain/**` es **código puro**: sin `next/*`, sin `@supabase/*`, sin `process.env`.
  Se puede testear y reutilizar en una app nativa.
- La UI nunca importa el cliente de Supabase directamente. Pasa por `src/lib/data/**`.
- Los proveedores externos se declaran como interfaz y se resuelven en un único
  punto (`src/lib/payments/index.ts`, etc.). Cambiar Transbank por otro proveedor
  no toca la UI.

---

## 3. Decisiones técnicas y deuda evitada

### 3.1 Dinero: enteros en unidad mínima, nunca `float`

Todos los montos se guardan como `bigint` en la unidad mínima de la moneda, junto a un
código ISO-4217 (`currency`). Para CLP la unidad mínima es el peso (0 decimales).

Se evita: `numeric`/`float` con redondeos inconsistentes, y un rediseño completo al
internacionalizar. `formatMoney()` centraliza el formato con `Intl.NumberFormat`.

### 3.2 Fechas: `timestamptz` siempre, presentación en `America/Santiago`

Chile tiene horario de verano y además regiones con husos distintos (Magallanes, Pascua).
Guardar `timestamp` sin zona genera errores en trabajos nocturnos y overnight, que son
exactamente el caso de uso principal del producto.

Se guarda UTC y se presenta con `date-fns-tz` usando la zona del trabajo
(`jobs.timezone`, por defecto `America/Santiago`).

### 3.3 Datos sensibles: separación por tabla, no por columna

PostgreSQL RLS es **row-level**, no column-level. Guardar RUT, teléfono, selfie y cuenta
bancaria en la misma tabla que el perfil público obliga a exponer la fila completa o a
depender de vistas frágiles.

Por eso el modelo separa:

| Tabla | Contenido | Acceso |
|---|---|---|
| `profiles` | nombre, inicial del apellido, foto, bio | lectura pública |
| `user_private_data` | RUT, teléfono, email de contacto, dirección | solo titular + admin |
| `worker_profiles` | tarifa, disponibilidad, reputación calculada | lectura pública |
| `worker_verifications` | documento, selfie, resultado del proveedor | solo titular + admin |
| `worker_payout_accounts` | cuenta bancaria | solo titular + admin |

Cambiar un ID en la API nunca devuelve datos privados porque esos datos no están en la
fila pública.

### 3.4 Roles y RLS: función `SECURITY DEFINER`, no políticas recursivas

Consultar `profiles.role` dentro de una política sobre `profiles` provoca recursión
infinita en RLS. Se usa `app_private.is_admin()` como `SECURITY DEFINER STABLE` con
`search_path` fijo, invocada desde las políticas.

Se declara en PL/pgSQL y no en SQL puro por una razón concreta: un cuerpo SQL se
valida al crear la función, y `public.profiles` todavía no existe en la primera
migración, donde las políticas de las tablas de referencia ya la necesitan.

### 3.5 Columnas protegidas: privilegios de columna, no triggers correctores

RLS decide a qué **filas** se accede. Para restringir qué **columnas** puede escribir
un usuario final se usan privilegios de columna, el mecanismo nativo de PostgreSQL:

```sql
revoke update on public.worker_profiles from authenticated;
grant update (headline, base_hourly_rate, availability_note,
              accepts_overnight, is_accepting_jobs)
  on public.worker_profiles to authenticated;
```

Así nadie se autoverifica, se sube el nivel ni se edita su propia reputación.

La alternativa habitual (un trigger `BEFORE UPDATE` que reponga las columnas
sensibles) se probó y se descartó: también revierte las escrituras legítimas del
propio sistema. En las pruebas, ese trigger anulaba el recálculo de reputación
disparado al insertar una reseña, y la calificación quedaba en cero.

Consecuencia deliberada: las escrituras administrativas (verificar identidad,
suspender una cuenta, aprobar un payout) no se hacen desde el navegador. Van por
código de servidor con la clave de servicio, que es además la postura correcta.

### 3.6 Geografía: tablas de referencia, no texto libre ni enum

`regions` y `communes` son tablas con códigos oficiales chilenos y un `country_code`.
Un enum de 346 comunas sería inmodificable sin migración; texto libre rompe el filtrado
y las futuras páginas SEO regionales.

PostGIS **no** se activa en la Etapa 1. Se guardan `lat`/`lng` como `numeric(10,7)`.
Migrar después es aditivo: agregar una columna `geography` generada más un índice GIST.
No es deuda, es una decisión de secuencia.

La lista de comunas vive en un único archivo (`src/lib/geo/chile.ts`) del que se
genera la semilla SQL con `npm run seed:geo`. Ese archivo no importa nada del resto
de la aplicación justamente para poder ejecutarse desde un script de Node. Así la
interfaz y la base nunca ofrecen listas distintas.

### 3.7 Precios: motor reemplazable detrás de una interfaz

`PricingEngine.suggest(input): PriceSuggestion` es la única superficie que conoce la UI.
La v1 (`RuleBasedPricingEngine`) aplica multiplicadores declarativos desde
`src/config/pricing.ts`. Cambiar a un modelo de demanda no altera firmas ni tablas.

La plataforma **sugiere**; el precio final lo fija cada trabajador en su oferta.

### 3.8 Pagos: `PaymentProvider` con implementación Transbank aislada

`TransbankPaymentProvider` existe como clase con la forma correcta del flujo
(crear transacción → redirección → confirmación), pero **no** inventa endpoints ni SDK.
Los métodos lanzan `PaymentProviderNotConfiguredError` hasta que se integre el SDK
oficial vigente en ambiente de integración.

En desarrollo se usa `MockPaymentProvider`, que simula la máquina de estados completa.

Nunca se almacenan datos de tarjeta. Ninguna credencial vive en el repositorio.

### 3.9 Pago Protegido, no "escrow"

El término "escrow" no aparece en la interfaz ni en textos de producto. El dinero entra a
la cuenta comercial de HagoTuFila y queda **asociado a un trabajo específico**
(`payments.job_id`). No existe billetera del cliente, no hay saldo retirable.

Internamente el campo se llama `protected_payment_state`.

### 3.10 Evidencia y auditoría: append-only

Una sola tabla (`job_evidence`) es la fuente de verdad de todo lo ocurrido durante un
trabajo. `checkins` y `job_updates` existen como **vistas** sobre ella, con
`security_invoker = true` para que apliquen las políticas del usuario que consulta.

Tres tablas con el mismo ciclo de vida obligarían a escribir en varias a la vez y a
mantenerlas sincronizadas. Una bitácora inmutable no puede quedar inconsistente, que
es justo lo que importa al resolver una disputa.


`job_evidence`, `payment_events`, `dispute_evidence`, `loyalty_transactions` y
`audit_logs` no tienen políticas de `UPDATE` ni `DELETE` para ningún rol de aplicación.
Corregir significa insertar un registro nuevo, no reescribir el anterior.

### 3.11 PIN de entrega: el trabajador nunca puede leerlo

El PIN vive en `handoff_codes`, con RLS que permite lectura únicamente al cliente.
El trabajador lo envía a una función del servidor que compara y registra el intento.
Así el PIN sigue siendo evidencia real de presencia simultánea.

### 3.12 Capa de datos con dos implementaciones

La Etapa 1 se construye sin una instancia de Supabase activa. En vez de rellenar la UI
con datos inventados dentro de los componentes, existe:

```
src/lib/data/repositories.ts   ← interfaces
src/lib/data/demo/*            ← datos de demostración realistas en CLP
src/lib/data/supabase/*        ← implementación real
src/lib/data/index.ts          ← selector por variables de entorno
```

Si faltan credenciales de Supabase, la app funciona en modo demo. Cuando existen, se usa
la implementación real. La UI no cambia ni una línea.

---

## 4. Estructura de carpetas

```
apps/web/
├── docs/                      Arquitectura, base de datos, hoja de ruta
├── supabase/migrations/       Esquema SQL versionado
├── public/
└── src/
    ├── app/                   App Router
    │   ├── (marketing)/       Home y páginas indexables
    │   ├── (auth)/            Entrar / crear cuenta
    │   ├── (app)/             Producto autenticado
    │   └── admin/             Panel interno
    ├── components/
    │   ├── ui/                Sistema de diseño
    │   ├── layout/            Header, footer, navegación móvil
    │   ├── home/              Secciones de la portada
    │   ├── jobs/              Tarjetas, filtros, wizard, timeline
    │   └── profile/           Índice de Confianza, niveles
    ├── config/                Constantes de producto y plataforma
    └── lib/
        ├── domain/            Tipos, enums, máquinas de estado (puro)
        ├── pricing/           Motor de precios sugeridos
        ├── reputation/        Índice de Confianza y niveles
        ├── payments/          PaymentProvider + Transbank + Mock
        ├── verification/      IdentityVerificationProvider
        ├── notifications/     Canales y despachador
        ├── geo/               Regiones y comunas de Chile
        ├── data/              Repositorios (demo | supabase)
        ├── supabase/          Clientes browser/server/admin
        └── utils/             Dinero, fechas, formato, cn
```

---

## 5. Máquinas de estado

Las transiciones válidas viven en `src/lib/domain/state-machines.ts` como mapas
explícitos. Ningún componente cambia un estado sin pasar por `canTransition()`.

- **Trabajo:** `DRAFT → PUBLISHED → OFFER_ACCEPTED → PAYMENT_PENDING → PAID →
  IN_PROGRESS → HANDOFF_COMPLETED → COMPLETED → CLOSED`, con ramas `CANCELLED` y `DISPUTED`.
- **Pago:** `PENDING → CREATED → AUTHORIZED → PAID`, con `FAILED`, `REFUNDED`,
  `PARTIALLY_REFUNDED`, `UNDER_REVIEW`.
- **Payout:** `PENDING → APPROVED → PROCESSING → PAID`, con `HELD` y `CANCELLED`.
- **Verificación:** `UNVERIFIED → PENDING → VERIFIED | REJECTED`, más `SUSPENDED`.
- **Extensión:** `PENDING → ACCEPTED | REJECTED | EXPIRED | CANCELLED`.

Regla dura del producto: un trabajo no llega a `IN_PROGRESS` sin un `payment` en estado
`PAID`. Está codificado en la máquina de estados y reforzado por un `CHECK` en la base.

---

## 6. Verificación del esquema

El esquema no se entrega "escrito y sin ejecutar". Se aplica y se prueba contra un
PostgreSQL real:

```bash
PGHOST=/tmp PGPORT=55432 PGUSER=postgres npm run db:test
```

El script levanta la base, aplica el stub de Supabase (auth, storage, roles,
realtime), las diez migraciones, la semilla geográfica y una batería de pruebas que
verifica, entre otras cosas:

- que un usuario no lea datos privados de otro cambiando un identificador;
- que un trabajador sin verificar no pueda ofertar;
- que un trabajador no pueda leer el PIN de entrega, pero sí validarlo;
- que abrir una disputa retenga el payout;
- que solo un participante de un trabajo completado pueda reseñar;
- que la bitácora de auditoría sea invisible para quien no es administrador.

Esta verificación encontró y corrigió cuatro defectos reales antes de entregar el
esquema: orden de creación de `is_admin`, una dependencia del esquema `extensions`
sin permisos, triggers de protección que bloqueaban al rol de servicio, y esos mismos
triggers anulando el recálculo de reputación.

## 7. Qué queda fuera de la Etapa 1

Ver `docs/HOJA-DE-RUTA.md`.
