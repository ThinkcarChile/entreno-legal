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
- [x] 83 comprobaciones automatizadas en `npm run db:test`

## Etapa 3 — Validación contra Supabase real (conectada, esquema NO aplicado)

El proyecto alojado ya existe: `hagotufila-dev`, ref `xwgobslgldxzatjrcxhl`,
región `sa-east-1`. La aplicación está conectada a él y lo confirma el indicador
de origen de datos, que en desarrollo muestra
«Supabase conectado · xwgobslgldxzatjrcxhl.supabase.co».

**Falta aplicar el esquema**, y eso necesita una credencial que el repositorio no
tiene ni debe tener: un token de acceso personal (`sbp_…`) o la contraseña de la
base. Hasta entonces el proyecto responde `PGRST205` —"no existe la tabla"— a
cada consulta, que es exactamente lo que se ve hoy.

Construido y verificado:

- [x] Autorización con `getClaims()` en lugar de `getUser()` / `getSession()`
- [x] Soporte de las claves `publishable` y `secret`, con las heredadas de respaldo
- [x] `supabase/config.toml` para que la CLI aplique migraciones y semilla
- [x] Migraciones repetibles donde el proyecto de destino puede traer el objeto
- [x] Carga de fotografía de perfil a Storage, con nombre generado por la aplicación
- [x] Indicador de origen de datos visible solo en desarrollo
- [x] `npm run verify:supabase`: 49 comprobaciones del recorrido completo por API (36 de camino feliz y 13 de operaciones que deben fallar)
- [x] `npm run e2e`: recorrido por navegador con Playwright
- [x] Inventario del esquema dentro de `npm run db:test`
- [x] `docs/DESPLIEGUE-SUPABASE.md` con los pasos exactos

Añadido al conectar el proyecto real:

- [x] Proyecto `hagotufila-dev` creado y alcanzable; clave pública verificada
      contra `/auth/v1/settings` y `/rest/v1/`
- [x] `.env.local` con la URL y la clave pública; la aplicación cambia a modo
      Supabase y lo muestra en el indicador
- [x] Corregido: una variable presente pero vacía (`SUPABASE_SECRET_KEY=`, como
      pide la propia plantilla) hacía fallar la validación de entorno y devolvía
      500 en todas las páginas. Ahora vacío equivale a ausente
- [x] `npm run db:push:hosted`: aplica las migraciones del repositorio por HTTPS
      cuando el puerto de PostgreSQL está cerrado. Probado de extremo a extremo
      contra un PostgreSQL 16 local: 18 migraciones, 32 tablas, 5 vistas,
      16 funciones, 73 políticas, 19 enums, y la segunda ejecución no repite nada
- [x] `npm run db:seed:hosted`: la semilla geográfica oficial por HTTPS, con
      cinco salvaguardas comprobadas por la máquina. Probado: niega producción,
      niega el ref equivocado, niega la falta de confirmación, aplica 1 país /
      16 regiones / 346 comunas, repite sin duplicar y deja el historial de
      migraciones en 18
- [x] `npm run verify:schema:hosted`: inventario del esquema alojado, RLS,
      `security_invoker`, grants del rol `anon`, `search_path` de las funciones
      privilegiadas, publicación de Realtime y advisors. 17 comprobaciones,
      todas verdes contra el esquema real
- [x] Las ocho credenciales E2E generadas y guardadas solo en `.env.local`

Pendiente, y es lo único que cierra la etapa. Todo esto está bloqueado por
credenciales, no por código:

- [ ] Que `SUPABASE_ACCESS_TOKEN` y `SUPABASE_SECRET_KEY` lleguen al entorno
      donde corren los scripts. Este contenedor es efímero y se clona limpio:
      editar `.env.local` en otra máquina no lo alcanza. La vía que sí llega son
      las variables de entorno del entorno de ejecución
- [ ] `npm run db:push:hosted` — aplicar las 18 migraciones
- [ ] `npm run db:seed:hosted -- --project-ref xwgobslgldxzatjrcxhl`
- [ ] `npm run verify:schema:hosted` — inventario y advisors contra el proyecto
- [ ] `npm run verify:supabase` — 49 comprobaciones del recorrido por API
- [ ] `npm run e2e` sin omitir las seis pruebas de `marketplace.spec.ts`
- [ ] Recorrer a mano, con dos navegadores, el flujo de cliente y de trabajador

---

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
| **Sin recorrido contra Supabase real** | El entorno de desarrollo no tiene ni credenciales ni Docker, así que todo se probó contra PostgreSQL más un contraste código–esquema. Las diferencias entre PostgreSQL a secas y Supabase (Auth, Realtime, Storage, permisos sobre `storage.objects`) no se han visto en funcionamiento | Ejecutar `npm run verify:supabase` y `npm run e2e` en cuanto exista el proyecto. Son 49 comprobaciones ya escritas |
| Políticas de Storage sobre `storage.objects` | En un proyecto alojado esa tabla pertenece a otro rol; si la migración no puede crear las políticas, Storage queda sin reglas | La guía de despliegue lo anticipa y explica cómo crearlas desde el panel |
| `getClaims()` no ejercitado contra un proyecto real | El cambio está hecho según la documentación vigente y compila, pero no se ha visto validar un token de verdad | Lo cubre `verify:supabase`, que abre cuatro sesiones simultáneas |
| `database.types.ts` genérico | Los tipos no reflejan las columnas reales, así que un error de nombre solo lo detecta `db:contract` | Generar los tipos con la CLI al crear el proyecto |
| Sin pruebas automatizadas del front | La lógica de dominio es pura y testeable, pero no hay pruebas | Añadir Vitest antes de la Etapa 4 |
| Realtime sin reconexión explícita | Si se corta la conexión, el hilo deja de recibir mensajes hasta recargar | Manejar el estado del canal y reconsultar al reconectar |
| Notificaciones solo in-app | Un trabajador que no abre la aplicación no se entera de una oferta aceptada | Push y email en la Etapa 6 |
| Sin límite de frecuencia propio | Se depende del de Supabase Auth; las acciones de negocio no tienen tope | Añadir control por usuario en ofertas y mensajes |
| Términos y política de privacidad provisionales | Texto de relleno | Redacción legal antes de abrir al público |
| Imágenes de trabajos sin implementar | La foto de perfil ya sube a Storage; las imágenes asociadas a un trabajo no, porque requieren subir antes de crear el trabajo y ampliar `publish_job` | Etapa 5 |
