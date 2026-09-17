# Hoja de ruta — HagoTuFila

Qué quedó construido en la Etapa 1 y qué falta, en orden de dependencia.

---

## Etapa 1 — Cimientos (completada)

- [x] Análisis de requisitos y decisiones de arquitectura documentadas
- [x] Esquema de base de datos completo, con RLS, aplicado y probado contra PostgreSQL
- [x] Estructura de carpetas por capas
- [x] Clientes de Supabase (navegador, servidor, servicio) y refresco de sesión
- [x] Autenticación: registro, inicio de sesión, retorno del enlace de confirmación
- [x] Sistema de diseño y componentes reutilizables
- [x] Home con todas las secciones pedidas
- [x] Perfiles públicos de trabajador con Índice de Confianza y niveles
- [x] Flujo "Publicar trabajo" en siete pasos, mobile-first
- [x] Listado de trabajos con filtros en la URL
- [x] Detalle del trabajo con ofertas, línea de tiempo y precio sugerido
- [x] Motor de precios sugeridos reemplazable
- [x] `PaymentProvider` con Transbank aislado y proveedor simulado para desarrollo
- [x] Panel `/admin` con KPIs
- [x] SEO: metadata, OpenGraph, sitemap, robots, datos estructurados
- [x] Manifiesto web y bases para PWA

---

## Etapa 2 — Conectar el backend

Lo mínimo para que el producto funcione con datos reales.

1. **Crear el proyecto Supabase** y aplicar las diez migraciones más la semilla
   geográfica. Generar `database.types.ts` con la CLI.
2. **Publicar un trabajo de verdad**: acción de servidor que valide con
   `publishJobSchema`, inserte con RLS, calcule el rango sugerido y lo guarde en
   `suggested_hourly_min` / `suggested_hourly_max`.
3. **Carga de imágenes** a Storage desde el paso 4 del asistente.
4. **Ofertas**: enviar, editar, retirar. Aceptar una oferta crea la asignación de
   forma transaccional y rechaza el resto.
5. **Perfil propio y onboarding de trabajador**: tarifa, zonas de trabajo,
   disponibilidad, categorías.
6. **Verificación de identidad**: carga de documento y selfie al bucket privado, cola
   de revisión en `/admin/verificaciones`, aprobación y rechazo con motivo.
7. **Rutas protegidas**: comprobación de sesión y de rol en el servidor, no solo en
   el proxy.

## Etapa 3 — Pagos

8. **Integrar Webpay Plus** con el SDK oficial vigente de Transbank, en ambiente de
   integración. Implementar los cuatro métodos de `TransbankPaymentProvider` y mapear
   sus respuestas a los estados internos. No inventar endpoints.
9. **Flujo de Pago Protegido completo**: aceptar oferta → crear pago → redirección →
   confirmación → `PAID` → el trabajo puede comenzar.
10. **Webhook y conciliación**: reintentos, idempotencia por
    `provider_transaction_id`, registro en `payment_events`.
11. **Payouts**: generación automática al completarse el trabajo, aprobación manual en
    `/admin/payouts` con referencia bancaria, y liberación automática al vencer
    `DISPUTE_WINDOW_HOURS`.
12. **Reembolsos**, totales y parciales, según resolución de disputa.

## Etapa 4 — Ejecución del trabajo

13. **Check-in con geolocalización** y evidencia fotográfica desde el teléfono.
14. **Línea de tiempo en vivo** con Supabase Realtime.
15. **Chat por trabajo**: texto, imágenes y mensajes automáticos del sistema.
16. **Extensiones**: solicitud del cliente, aceptación explícita del trabajador, cobro
    del tiempo adicional antes de continuar.
17. **PIN de entrega** en la interfaz: generación para el cliente, validación para el
    trabajador.
18. **Evaluación del bono por objetivo**, separada del pago por tiempo.

## Etapa 5 — Confianza y comunidad

19. **Reseñas** con las cuatro dimensiones, tras completar el trabajo.
20. **Recálculo periódico** del Índice de Confianza y de los niveles, con la misma
    función pura que ya usa la interfaz.
21. **Disputas** de extremo a extremo: apertura, evidencia de ambas partes, mensajería,
    resolución administrativa y su efecto en el payout.
22. **Notificaciones in-app** con Realtime y centro de notificaciones.
23. **FilaPuntos**: acreditación automática y canje como descuento de comisión.

## Etapa 6 — Crecimiento

24. **Páginas regionales** para SEO (`/hacer-fila/santiago`, `/tramites/valparaiso`).
25. **Búsqueda por cercanía** con PostGIS: columna `geography` generada e índice GIST.
26. **PWA**: service worker, estrategia de caché, instalación y trabajo sin conexión
    para el registro de evidencia.
27. **Push, email y SMS/WhatsApp** como canales del despachador de notificaciones.
28. **Panel de administración completo**: cada cola con sus acciones y reportes.
29. **Precios por demanda**: sustituir `RuleBasedPricingEngine` sin tocar la interfaz.
30. **App nativa**, una vez validado el producto.

---

## Deuda consciente que conviene saldar pronto

| Tema | Estado | Cuándo |
|---|---|---|
| Pruebas automatizadas del front | No hay | Antes de la Etapa 3 |
| `database.types.ts` genérico | Reemplazar por tipos generados | Al crear el proyecto Supabase |
| Feriados chilenos en código | Mover a tabla | Etapa 4 |
| Reputación en tabla, sin recálculo programado | Falta el proceso periódico | Etapa 5 |
| Términos y política de privacidad | Texto provisional | Antes de abrir al público |
| Registro de trabajos vencidos | Falta el proceso que marque `EXPIRED` | Etapa 2 |
