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

---

## Etapa 3 — Pagos reales

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

## Etapa 4 — Ejecución del trabajo

5. **Carga de imágenes** a Supabase Storage: en el asistente de publicación, en
   el perfil del trabajador y en la evidencia del trabajo.
6. **Check-in con geolocalización** desde el teléfono.
7. **Imágenes en el chat** (el modelo y el bucket ya existen).
8. **Extensiones de trabajo** de extremo a extremo: solicitud, aceptación
   explícita del trabajador y cobro del tiempo adicional.
9. **PIN de entrega** en la interfaz. Las funciones de la base ya están.
10. **Evaluación del bono por objetivo** al cerrar el trabajo.
11. **Proceso que marque `EXPIRED`** los trabajos cuya fecha pasó sin asignación.

## Etapa 5 — Confianza y comunidad

12. **Reseñas** desde la interfaz, con las cuatro dimensiones.
13. **Recálculo programado** del Índice de Confianza y de los niveles.
14. **Disputas** completas: apertura, evidencia de ambas partes y resolución.
15. **FilaPuntos**: acreditación automática y canje como descuento de comisión.
16. **Solicitudes de modificación**: hoy los campos críticos se congelan tras la
    asignación; deben convertirse en una propuesta que el trabajador acepta o
    rechaza.

## Etapa 6 — Crecimiento

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
| Sin recorrido end-to-end con Supabase real | El entorno de desarrollo no tiene Docker ni proyecto Supabase, así que el flujo se probó contra PostgreSQL y con un contraste código–esquema, no con la aplicación en marcha contra Supabase | Primer paso de la Etapa 3: crear el proyecto, aplicar migraciones y recorrer el flujo con dos cuentas |
| `database.types.ts` genérico | Los tipos no reflejan las columnas reales, así que un error de nombre solo lo detecta `db:contract` | Generar los tipos con la CLI al crear el proyecto |
| Sin pruebas automatizadas del front | La lógica de dominio es pura y testeable, pero no hay pruebas | Añadir Vitest antes de la Etapa 4 |
| Realtime sin reconexión explícita | Si se corta la conexión, el hilo deja de recibir mensajes hasta recargar | Manejar el estado del canal y reconsultar al reconectar |
| Notificaciones solo in-app | Un trabajador que no abre la aplicación no se entera de una oferta aceptada | Push y email en la Etapa 6 |
| Sin límite de frecuencia propio | Se depende del de Supabase Auth; las acciones de negocio no tienen tope | Añadir control por usuario en ofertas y mensajes |
| Términos y política de privacidad provisionales | Texto de relleno | Redacción legal antes de abrir al público |
| Imágenes sin implementar | Los buckets y las columnas existen, la carga no | Etapa 4 |
