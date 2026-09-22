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
- [x] `npm run db:push:hosted`: las 27 migraciones aplicadas por HTTPS
- [x] `npm run db:seed:hosted`: 1 país, 16 regiones, 346 comunas
- [x] `npm run verify:schema:hosted`: inventario, RLS, `security_invoker`, grants
      de `anon`, `search_path`, publicación de Realtime, URLs de retorno y advisors
- [x] `npm run verify:supabase`: 61 de 61 comprobaciones
- [x] `npm run e2e`: 17 de 17, con las siete del marketplace y las seis de la
      ejecución del trabajo ejecutándose de verdad
- [x] `npm run db:test`: 179 comprobaciones contra PostgreSQL 16 local
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

El último hallazgo de esa auditoría se cerró sin esperar a Webpay, porque era
una carrera del dominio y no del proveedor (`docs/PAGOS.md`):

- [x] **`cancel_job` no tocaba el pago en vuelo.** Si se cancelaba un trabajo
      en `PAYMENT_PENDING` y el proveedor confirmaba después, el disparador de
      payout —sin ninguna comprobación— pagaba al trabajador por un trabajo
      cancelado y el dinero del cliente quedaba cobrado sin ruta de devolución.
      Resuelto en `…000300` y `…000400`: estado `CANCELLATION_PENDING`, decisión
      única bajo bloqueo `jobs → assignments → payments`, entrada única de
      resultados (`confirm_payment_result`, solo del servicio) idempotente por
      identificador de evento, «devolución pendiente» como
      `UNDER_REVIEW + captured_at + review_reason`, y candados en la base:
      ningún payout sin pago `PAID` ni sobre cancelado, ninguna asignación
      cancelada vuelve a habilitarse, ningún trabajo cancelado revive, y el
      usuario perdió `UPDATE`/`DELETE` sobre las tres tablas de dinero
- [x] **No se podía reproducir.** El proveedor simulado aprobaba en el acto.
      `DelayedMockPaymentProvider` (`mock-delayed`) espera a `settle()` y libera
      a todos los que esperaban en el mismo tick: una barrera, sin `sleep`.
      Con él corren P01–P17 y las carreras R10–R12 en local (dos sesiones
      `psql`, `RACE_REPS` veces) y las 23 comprobaciones de
      `npm run verify:payments` contra `hagotufila-dev` (tres ejecuciones,
      25 carreras de cada tipo, los dos desenlaces observados, cero
      violaciones de invariantes)
- [x] **Dos defectos latentes que destapó.** `start_protected_payment` nunca
      reutilizaba un pago existente (comprobaba `record IS NOT NULL`, que en
      PL/pgSQL exige todas las columnas no nulas) y bloqueaba la asignación
      antes que el trabajo, al revés que `cancel_job`: candidato a
      interbloqueo. Corregidos los dos

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
2. **Conciliación**: la idempotencia por evento y la entrada única
   (`confirm_payment_result`) ya existen; falta la tarea que consulte los pagos
   en vuelo (`getStatus`) pasado un plazo y los asiente, y que saque de
   `CANCELLATION_PENDING` a un trabajo cuyo proveedor nunca respondió.
   Definir el `provider_event_id` de Webpay con el SDK delante.
3. **Reembolsos** totales y parciales. Los pagos `UNDER_REVIEW` con
   `captured_at` son la cola de entrada: hoy son un registro contable, no un
   reembolso bancario. Ver los riesgos de `docs/PAGOS.md` §9.
4. **Payouts**: aprobación en `/admin/payouts` con referencia bancaria y
   liberación automática al vencer `DISPUTE_WINDOW_HOURS`.

## Bloque 3 — Ejecución completa del trabajo (completada)

El recorrido terminaba en «pago confirmado». Las tablas de lo que venía después
existían desde la Etapa 1 y nadie las escribía. Ver `docs/EJECUCION.md`.

- [x] **Avance del trabajo por funciones del servidor**, no por `UPDATE`:
      ir en camino, check-in, comenzar, informar, entregar y cerrar. Cada paso
      comprueba el papel de quien llama y bloquea `jobs → assignments`
- [x] **Matriz de permisos central** (`src/lib/domain/permissions.ts`): una sola
      función decide qué se muestra, y la base vuelve a comprobar qué se permite
- [x] **Check-in con consentimiento y geolocalización**, con las coordenadas
      fuera del alcance de la contraparte, revisión manual cuando no se verifica
      y tolerancias en `platform_settings`
- [x] **Evidencia real en Storage privado**, validada por contenido y no por el
      tipo declarado, con URL firmadas de 60 segundos
- [x] **Extensiones de extremo a extremo**: solicitud del trabajador, respuesta
      definitiva del cliente, importe calculado en la base y cobro separado que
      solo suma al payout cuando se confirma
- [x] **PIN de entrega** completo, con un solo uso, cinco intentos, caducidad,
      regeneración y sin viajar por el chat ni por los avisos
- [x] **Finalización en dos pasos**: el trabajador pide, el cliente aprueba, y
      solo la aprobación libera el pago. Con evaluación del bono
- [x] **Disputas** con pruebas de ambas partes y resolución administrativa que
      libera, recorta o cancela el pago al trabajador
- [x] **Payouts**: aprobación, retención con motivo y registro de la
      transferencia con referencia bancaria, todo desde `/admin/payouts`
- [x] **Reputación calculada**: trabajos completados, minutos, cancelaciones,
      cumplimiento y puntualidad salen de los hechos
- [x] **Mis ganancias** para el trabajador, con el estado real de cada pago
- [x] **Panel interno** con las colas que esperan una decisión
- [x] `npm run db:test`: 179 comprobaciones · `npm run verify:execution`: 24 ·
      `npm run e2e`: 17

Defectos reales que destapó, todos corregidos:

- [x] **El cliente podía marcar «voy en camino» por el trabajador.** El
      privilegio de columna sobre `assignments.status` existía y la comprobación
      del rol vivía solo en TypeScript
- [x] **Un participante podía aceptar su propia extensión.** `job_extensions`
      tenía `UPDATE` sobre todas sus columnas y una política que dejaba pasar a
      cualquiera de los dos
- [x] **Una disputa se podía insertar ya resuelta a favor de quien la abría**,
      añadiendo `status` y `resolution` al `INSERT` directo
- [x] **Nadie podía aportar una prueba a una disputa**: `dispute_evidence` tenía
      política de `INSERT` y ningún privilegio
- [x] **Un código de entrega vencido no se podía regenerar nunca**, así que la
      entrega quedaba bloqueada para siempre
- [x] **La contraparte no podía abrir la evidencia**: la política de Storage solo
      alcanzaba al autor del archivo
- [x] **`dispute_deadline_at` no lo escribía nadie**, así que la ventana de
      reclamo no se aplicaba en ninguna parte
- [x] **Abrir una disputa sobre un trabajo cancelado reventaba**:
      `hold_payout_on_dispute` forzaba `DISPUTED` sin mirar el estado previo
- [x] **Un hito del sistema se podía forjar** escribiendo `job_evidence`
      directamente con `evidence_type = 'SYSTEM'`
- [x] **`DELETE` seguía concedido en 28 relaciones** de `public`, con la sola
      barrera de que no hubiera política

## Etapa 5 — Ejecución del trabajo

5. **Carga de imágenes** del trabajo publicado y del perfil del trabajador (la
   evidencia del trabajo y de las disputas ya sube de verdad).
7. **Imágenes en el chat** (el modelo y el bucket ya existen).
10. **Liberación automática** del payout al vencer la ventana de disputa: hoy la
    aprobación es siempre del cliente.
11. **Proceso que marque `EXPIRED`** los trabajos cuya fecha pasó sin asignación.
12. **FilaPuntos**: `apply_loyalty_transaction` existe y nadie la llama.

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
| Ubicación del check-in falseable | Un teléfono puede mentir su posición: comprobar la distancia no lo descarta | Revisión manual con evidencia, y el registro con hora del servidor como respaldo en una disputa |
| Transferencias al trabajador manuales | Se registran con referencia bancaria, pero las hace una persona fuera de la plataforma | Integración bancaria o de payouts, posterior a la Etapa 4 |
| Devolución pendiente sin reembolso real | Un pago que llegó tras la cancelación queda `UNDER_REVIEW` con `captured_at`; nadie lo devuelve todavía y ninguna tarea vigila los trabajos que se quedan en `CANCELLATION_PENDING` si el proveedor no responde | Etapa 4: reembolso con el SDK y conciliación de pagos en vuelo (`docs/PAGOS.md` §9) |
| Realtime no visto desde un navegador | La entrega funciona entre sesiones reales por API, pero el navegador del entorno donde se validó no alcanza Supabase | Repetir M15 y M16 del recorrido a mano en una máquina con salida normal |
| `database.types.ts` genérico | Los tipos no reflejan las columnas reales, así que un error de nombre solo lo detecta `db:contract` | Generar los tipos con la CLI al crear el proyecto |
| Sin pruebas automatizadas del front | La lógica de dominio es pura y testeable, pero no hay pruebas | Añadir Vitest antes de la Etapa 4 |
| Realtime sin reconexión explícita | Si se corta la conexión, el hilo deja de recibir mensajes ajenos hasta recargar. Los propios ya se ven siempre | Manejar el estado del canal y reconsultar al reconectar |
| Notificaciones solo in-app | Un trabajador que no abre la aplicación no se entera de una oferta aceptada | Push y email en la Etapa 6 |
| Sin límite de frecuencia propio | Se depende del de Supabase Auth; las acciones de negocio no tienen tope | Añadir control por usuario en ofertas y mensajes |
| Términos y política de privacidad provisionales | Texto de relleno | Redacción legal antes de abrir al público |
| Imágenes de trabajos sin implementar | La foto de perfil ya sube a Storage; las imágenes asociadas a un trabajo no, porque requieren subir antes de crear el trabajo y ampliar `publish_job` | Etapa 5 |
