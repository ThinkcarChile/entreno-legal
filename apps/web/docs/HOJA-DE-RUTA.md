# Hoja de ruta — HagoTuFila

Qué está construido y qué falta, en orden de dependencia.

---

## Etapa 1 — Cimientos (completada)

- [x] Arquitectura por capas y decisiones documentadas
- [x] Esquema con RLS, aplicado y probado contra PostgreSQL real
- [x] Sistema de diseño, Home, perfiles públicos, listado y detalle de trabajos
- [x] Motor de precios sugeridos reemplazable
- [x] `PaymentProvider` con Transbank aislado
- [x] SEO, sitemap, robots, manifiesto

## Etapa 2 — Marketplace funcional sobre Supabase (completada)

- [x] Conexión real a Supabase: Auth, PostgreSQL, RLS, Storage, Realtime
- [x] Separación explícita entre modo demostración y modo Supabase, sin mezcla
- [x] Registro, inicio y cierre de sesión, recuperación de contraseña
- [x] Rutas protegidas en el servidor, además de RLS
- [x] Onboarding de cuenta con elección de modo (cliente, trabajador o ambos)
- [x] Onboarding de trabajador: tarifa, zonas, disponibilidad, términos
- [x] Solicitud de verificación y resolución desde el panel de administración
- [x] Publicación real de trabajos, con dirección exacta en tabla privada
- [x] Edición mientras el trabajo sigue abierto, con aviso a quien ofertó
- [x] Explorar trabajos con filtros por región, comuna, categoría, fecha, pago,
      duración, nocturnidad y bono
- [x] Ofertas: enviar, editar, retirar, comparar
- [x] Aceptación atómica, probada con concurrencia real
- [x] Pago Protegido simulado recorriendo el flujo definitivo
- [x] Comisión configurable en base de datos y función de cálculo central
- [x] Chat por trabajo con Supabase Realtime y mensajes automáticos del sistema
- [x] Mis trabajos para cliente y para trabajador, con estados agrupados
- [x] Pantalla central del trabajo asignado, con acciones según estado y rol
- [x] Notificaciones in-app con indicador de no leídas
- [x] Semilla de demostración multi-región
- [x] Comprobaciones automatizadas en `npm run db:test` (hoy 122, con inventario y contraste código–esquema)

## Etapa 3 — Validación contra Supabase real (completada)

Proyecto `hagotufila-dev`, ref `xwgobslgldxzatjrcxhl`, región `sa-east-1`. El
esquema está aplicado y el recorrido completo se ejecutó contra él.

Construido y verificado:

- [x] Autorización con `getClaims()` en lugar de `getUser()` / `getSession()`
- [x] Soporte de las claves `publishable` y `secret`, con las heredadas de respaldo
- [x] `supabase/config.toml` para que la CLI aplique migraciones y semilla
- [x] Migraciones repetibles donde el proyecto de destino puede traer el objeto
- [x] Carga de fotografía de perfil a Storage, con nombre generado por la aplicación
- [x] Indicador de origen de datos visible solo en desarrollo
- [x] `npm run db:push:hosted`: las 21 migraciones aplicadas por HTTPS
- [x] `npm run db:seed:hosted`: 1 país, 16 regiones, 346 comunas
- [x] `npm run verify:schema:hosted`: inventario, RLS, `security_invoker`, grants
      de `anon`, `search_path`, publicación de Realtime, URLs de retorno y advisors
- [x] `npm run verify:supabase`: 61 de 61 comprobaciones
- [x] `npm run e2e`: 11 de 11, con las siete del marketplace ejecutándose de verdad
- [x] `npm run db:test`: 122 comprobaciones contra PostgreSQL 16 local
- [x] Recorrido a mano con dos ventanas: 19 de 21 pasos (los dos restantes
      necesitan que el navegador alcance Supabase, ver abajo)
- [x] `docs/DESPLIEGUE-SUPABASE.md` con los pasos exactos

## Etapa 2.5 — Lo que apareció al ejecutarlo de verdad (completada)

Nada de esto se veía sin un proyecto alojado y un navegador recorriendo la
aplicación. Cada punto se corrigió y quedó cubierto por una comprobación
automática, para que no vuelva en silencio.

- [x] **`anon` podía escribir en las 37 tablas y vistas.** Un proyecto Supabase
      trae `alter default privileges … grant all on tables to anon`, y la
      migración de RLS concedía privilegios pero nunca revocaba. RLS lo tapaba,
      pero la segunda línea de defensa no existía. Migración
      `20260301000000_hosted_privileges.sql`; lo comprueban V15 y I13
- [x] **Las 16 RPC se podían ejecutar sin sesión.** PostgreSQL concede EXECUTE a
      PUBLIC en toda función nueva. Revocado; lo comprueba el advisor
- [x] **Cuatro funciones de `app_private` sin `search_path`.** Fijado; V16 e I14
- [x] **`verify:supabase` no podía pasar nunca sus dos pruebas de Realtime.**
      Lanzaban el `insert` con `void`, y el constructor de PostgREST es perezoso:
      la petición sale dentro de `then`, así que la escritura nunca ocurría y el
      error decía «no llegó por Realtime», que apunta al sitio equivocado
- [x] **Playwright no leía `.env.local`.** Las pruebas del marketplace se
      omitían en silencio con las credenciales puestas. Cargador de entorno
      compartido en `scripts/env-local.ts`
- [x] **La prueba de publicación buscaba un botón «5 h» que no existe.** Los
      preajustes son 30 min, 1, 2, 4, 6, 8, 12 y 24 h
- [x] **El servidor de las E2E corría en producción**, donde el proveedor de
      pagos simulado está prohibido por diseño, así que el pago no se podía
      recorrer. Ahora corre en desarrollo, y con su propia `NEXT_PUBLIC_SITE_URL`
      para que la vuelta del pago no caiga en otro puerto
- [x] **Los formularios de credenciales se enviaban por GET si la página no
      había hidratado**, dejando correo y contraseña en la URL, en el historial y
      en el registro del servidor. Ahora son POST
- [x] **Las dos listas de «mis trabajos» fallaban en cuanto había algo que
      mostrar**: pasaban funciones de un componente de servidor a uno de cliente.
      Con la cuenta vacía se ve el estado vacío y no se llegaba a la parte rota,
      así que ninguna prueba lo tocaba. Corregido y cubierto por la prueba E2E 7
- [x] **Un mensaje enviado desaparecía de la pantalla de quien lo escribió si el
      socket de Realtime no estaba vivo.** El hilo dependía de `realtimeEnabled`,
      que solo dice si hay credenciales, no si la conexión existe. Ahora
      `sendMessageAction` devuelve la fila creada y el hilo la añade siempre,
      descartando el duplicado cuando el evento llega

## Etapa 2.5 bis — Auditoría individual de las 16 RPC (completada)

El advisor avisa de toda función `SECURITY DEFINER` ejecutable por un usuario con
sesión. Se auditaron una por una, con su motivo concreto, en vez de aceptarlas en
bloque. El detalle está en `docs/BASE-DE-DATOS.md` y el motivo de cada una vive
en `AVISOS_ACEPTADOS`, dentro de `scripts/verify-schema-hosted.ts`.

- [x] **Dos no necesitaban `SECURITY DEFINER`.** `mark_conversation_read` y
      `mark_notifications_read` solo escriben `read_at` en filas que RLS ya
      autoriza al llamante. Pasan a `SECURITY INVOKER`, con el privilegio de
      columna correspondiente. El advisor baja de 16 avisos a 14
- [x] **Ocho no fallaban sin sesión.** Se apoyaban en `dueño <> auth.uid()`, y
      con `auth.uid()` nulo esa comparación vale NULL: el `if` no entra en la
      rama y el único control de autorización se salta solo. Comprobado sobre el
      esquema real: sin sesión, `cancel_job` cancelaba el trabajo de otro
      cliente. Guarda explícita añadida a las ocho
- [x] **Las funciones no eran el único camino, y ese era el agujero de verdad.**
      Cinco abusos comprobados rodeaban a cinco de las dieciséis escribiendo la
      tabla a mano: autoverificarse, insertar una oferta ya aceptada, multiplicar
      por diez el importe pactado, marcar un trabajo como pagado sin pagar y
      autoaprobarse una verificación. El `UPDATE` estaba restringido por columna
      desde la Etapa 1; el `INSERT` no lo estaba en ninguna tabla
- [x] **Tres tablas con `UPDATE` abierto a todas sus columnas.** `job_offers`
      dejaba al trabajador poner su propia oferta en `ACCEPTED` —y con ello
      bloquear el trabajo, porque solo cabe una aceptada—; `messages` dejaba a un
      participante reescribir el texto de lo que dijo el otro, que es prueba en
      una disputa; `notifications` dejaba reescribir el contenido de los avisos
- [x] **Las transiciones de la asignación, ahora también en la base.** Estaban
      solo en TypeScript, y el propio archivo decía que la intención era
      replicarlas como restricción. `npm run db:contract` compara las dos copias
      y falla si divergen
- [x] **El arnés de pruebas se tragaba los errores de SQL.** `db-test.sh` buscaba
      `^psql:.*ERROR`, pero su propio filtro quita ese prefijo: un archivo de
      pruebas que reventaba a media ejecución salía en verde con menos
      comprobaciones. Corregido, y es lo que destapó los dos puntos siguientes
- [x] **El stub local no imitaba los permisos de Supabase sobre el esquema
      `auth`.** No se notaba mientras todo lo que llamaba a `auth.uid()` desde
      una sesión era `SECURITY DEFINER`

Pendiente de esta auditoría, y es de la Etapa 4 porque necesita reembolsos:

- [ ] **`cancel_job` no toca el pago en vuelo.** Si se cancela un trabajo en
      `PAYMENT_PENDING` y el proveedor confirma el pago después, el disparador
      `payments_create_payout` crea un payout a favor del trabajador por un
      trabajo cancelado, y el dinero del cliente queda cobrado sin ruta de
      devolución. Hoy no se alcanza con el proveedor simulado, que confirma de
      inmediato. Se cierra al integrar Webpay Plus y la conciliación

---

También apareció, y se resolvió, la configuración del proyecto que ninguna
migración puede llevar:

- [x] **URLs de retorno de autenticación.** `uri_allow_list` estaba vacía en
      `hagotufila-dev`: la guía lo pedía como obligatorio desde el principio y
      nada lo comprobaba. Puestas las tres, y ahora lo comprueba V18
- [x] **Protección contra contraseñas filtradas.** No se puede activar: Supabase
      la ofrece desde el plan Pro y el proyecto de desarrollo es Free (la API
      responde 402). Queda en `AVISOS_ACEPTADOS` con ese motivo y con la
      instrucción de quitarla al pasar a producción. El mínimo de 8 caracteres
      lo impone mientras tanto la propia aplicación

Pendiente, y no es código:
- [ ] **Entrega por Realtime vista en un navegador.** Está probada entre dos
      sesiones reales por API (`verify:supabase` V25 y V26, entrega en menos de
      un segundo), pero no desde el navegador: el contenedor donde se ejecutó
      esto no deja salir tráfico del navegador hacia Supabase —su proxy no
      admite la actualización a WebSocket—, así que los pasos M15 y M16 del
      recorrido a mano quedaron sin ejecutar. En una máquina con salida normal
      son dos ventanas y treinta segundos
- [ ] **Avisos de rendimiento del advisor**: 215 `multiple_permissive_policies` y
      39 `auth_rls_initplan`. Son consejos de optimización de RLS —envolver
      `auth.uid()` en un subselect y unificar políticas permisivas—, no agujeros.
      Tocan las 73 políticas, así que van en su propia tanda

## Etapa 4 — Pagos reales

1. **Integrar Webpay Plus** con el SDK oficial vigente de Transbank, en ambiente
   de integración. Implementar los cuatro métodos de `TransbankPaymentProvider`
   y mapear sus respuestas a los estados internos. No inventar endpoints.
   La acción de servidor y la ruta `/pagos/retorno` ya están escritas para no
   tener que cambiarlas.
2. **Conciliación**: idempotencia por `provider_transaction_id`, reintentos y
   registro completo en `payment_events`.
3. **Reembolsos** totales y parciales.
4. **Payouts**: aprobación en `/admin/payouts` con referencia bancaria y
   liberación automática al vencer `DISPUTE_WINDOW_HOURS`.

## Etapa 5 — Ejecución del trabajo

5. **Carga de imágenes** a Supabase Storage: en el asistente de publicación, en
   el perfil del trabajador y en la evidencia del trabajo.
6. **Check-in con geolocalización** desde el teléfono.
7. **Imágenes en el chat** (el modelo y el bucket ya existen).
8. **Extensiones de trabajo** de extremo a extremo: solicitud, aceptación
   explícita del trabajador y cobro del tiempo adicional.
9. **PIN de entrega** en la interfaz. Las funciones de la base ya están.
10. **Evaluación del bono por objetivo** al cerrar el trabajo.
11. **Proceso que marque `EXPIRED`** los trabajos cuya fecha pasó sin asignación.

## Etapa 6 — Confianza y comunidad

12. **Reseñas** desde la interfaz, con las cuatro dimensiones.
13. **Recálculo programado** del Índice de Confianza y de los niveles.
14. **Disputas** completas: apertura, evidencia de ambas partes y resolución.
15. **FilaPuntos**: acreditación automática y canje como descuento de comisión.
16. **Solicitudes de modificación**: hoy los campos críticos se congelan tras la
    asignación; deben convertirse en una propuesta que el trabajador acepta o
    rechaza.

## Etapa 7 — Crecimiento

17. **Páginas regionales** para SEO.
18. **Búsqueda por cercanía** con PostGIS: columna `geography` generada e índice
    GIST sobre las coordenadas que ya se guardan.
19. **PWA**: service worker y registro de evidencia sin conexión.
20. **Push, email y SMS/WhatsApp** como canales del despachador que ya existe.
21. **Panel de administración completo**: pagos, payouts, disputas y reportes.
22. **Precios por demanda**: sustituir `RuleBasedPricingEngine` sin tocar la
    interfaz.
23. **Aplicación nativa**, una vez validado el producto.

---

## Riesgos técnicos pendientes

| Tema | Riesgo | Mitigación prevista |
|---|---|---|
| ~~Sin recorrido contra Supabase real~~ | Resuelto: el esquema está aplicado en `hagotufila-dev` y pasaron `verify:supabase` (61/61), `e2e` (11/11) y el recorrido a mano | — |
| ~~Políticas de Storage sobre `storage.objects`~~ | Resuelto: la migración `…000900` creó las 11 políticas en el proyecto alojado sin intervención manual, y V07 las cuenta | — |
| ~~`getClaims()` no ejercitado contra un proyecto real~~ | Resuelto: `verify:supabase` abre cuatro sesiones simultáneas y comprueba que ninguna se cruza | — |
| Realtime no visto desde un navegador | La entrega funciona entre sesiones reales por API, pero el navegador del entorno donde se validó no alcanza Supabase | Repetir M15 y M16 del recorrido a mano en una máquina con salida normal |
| `database.types.ts` genérico | Los tipos no reflejan las columnas reales, así que un error de nombre solo lo detecta `db:contract` | Generar los tipos con la CLI al crear el proyecto |
| Sin pruebas automatizadas del front | La lógica de dominio es pura y testeable, pero no hay pruebas | Añadir Vitest antes de la Etapa 4 |
| Realtime sin reconexión explícita | Si se corta la conexión, el hilo deja de recibir mensajes ajenos hasta recargar. Los propios ya se ven siempre | Manejar el estado del canal y reconsultar al reconectar |
| Notificaciones solo in-app | Un trabajador que no abre la aplicación no se entera de una oferta aceptada | Push y email en la Etapa 6 |
| Sin límite de frecuencia propio | Se depende del de Supabase Auth; las acciones de negocio no tienen tope | Añadir control por usuario en ofertas y mensajes |
| Términos y política de privacidad provisionales | Texto de relleno | Redacción legal antes de abrir al público |
| Imágenes de trabajos sin implementar | La foto de perfil ya sube a Storage; las imágenes asociadas a un trabajo no, porque requieren subir antes de crear el trabajo y ampliar `publish_job` | Etapa 5 |
