# HagoTuFila — Sistema de diseño y especificación UX/UI

**Versión conceptual:** 1.0 · **Mercado:** Chile · **Base de implementación:** Next.js / Tailwind CSS 4 · **Enfoque:** mobile-first, WCAG 2.2 AA. Este documento acompaña al prototipo navegable `index.html`. Los datos del prototipo son ilustrativos y no están conectados al backend.

## 1. Concepto de marca

**Idea:** «Tu lugar está asegurado. Tu día sigue». El producto no vende tiempo en abstracto: reduce incertidumbre durante un encargo que otra persona hace presencialmente. La interfaz transmite seguridad, seguimiento claro y trato directo entre personas.

**Logo propuesto:** símbolo de flecha ascendente ↗ integrada en una silueta suave que evoca marcador o ticket de turno, acompañado por el logotipo tipográfico `hagotufila.` en minúsculas. El símbolo es conceptual: el logotipo final debe redibujarse en vector para uso comercial.

**Personalidad:** práctica, humana, serena, precisa al hablar de dinero. Fondo marfil frío, verde petróleo dominante, verde lima de acción puntual. Evitar adornos infantiles, mapas con posiciones exactas y mensajes promocionales en estados financieros.

## 2. Variables CSS / tokens

| Variable | Valor | Uso |
|---|---|---|
| `--color-brand-950` | `#12393A` | Encabezados oscuros y CTA principal |
| `--color-brand-700` | `#14766C` | Foco, progresos y navegación activa |
| `--color-brand-100` | `#DDF3E9` | Confirmaciones y fondos suaves |
| `--color-accent-300` | `#D9F27E` | Acciones destacadas en hero |
| `--color-bg` | `#F7F8F4` | Fondo de vistas |
| `--color-surface` | `#FFFFFF` | Tarjetas y formularios |
| `--color-text` | `#142F33` | Texto primario |
| `--color-text-muted` | `#627371` | Texto secundario |
| `--color-border` | `#DCE5E1` | Separadores y bordes |
| `--color-success` | `#155D4A` | Confirmado/transferido |
| `--color-warning` | `#97631E` | Pendiente/en revisión |
| `--color-danger` | `#A33333` | Rechazo/disputa/cancelación |
| `--color-info` | `#245DA3` | Avisos neutrales |
| `--font-sans` | `Inter, ui-sans-serif, system-ui, sans-serif` | Texto y cifras |
| `--radius-sm` | `9px` | Chips y botones compactos |
| `--radius-md` | `12px` | Inputs y botones |
| `--radius-lg` | `19px` | Tarjetas |
| `--radius-xl` | `28px` | Contenedores hero |
| `--shadow-card` | `0 14px 36px rgb(20 47 51 / 7%)` | Elevación baja |
| `--space-1` → `--space-8` | `4, 8, 12, 16, 20, 24, 32, 40px` | Escala base |

Las variables Tailwind 4 pueden declararse con `@theme` y referenciarse mediante utilidades (`bg-brand-950`, `text-text-muted`, etc.). Tipos sugeridos: cuerpo 14–16 px / línea 1.5, encabezados 28–40 px, hero 40–68 px; ancho máximo de contenido 1240 px. Íconos lineales consistentes en producción (Lucide), no emojis ni glifos del prototipo.

## 3. Librería de componentes

- **Button:** `primary`, `accent`, `secondary`, `outline`, `danger`, `text`; tamaños `sm`, `md`, `lg`; estados normal, hover, focus, disabled, loading. Una sola acción primaria por bloque de decisión.
- **TextField / CurrencyField / DurationPicker:** etiquetas persistentes, ayuda/errores conectados con `aria-describedby`, montos enteros CLP, duración expresable en minutos. El importe del trabajo es derivado, nunca editable manualmente.
- **Select / RegionCommuneSelector:** búsqueda de regiones/comunas; lista completa de 16 regiones y 346 comunas tomada de catálogo de aplicación, nunca inferida del prototipo.
- **JobCard:** categoría, urgencia, título, lugar y comuna, fecha de inicio, duración, tarifa por hora, estado y CTA. Jamás dirección exacta en vistas públicas.
- **OfferCard:** nombre + inicial, nivel, verificación, insignias, historial y reseñas si existen, tarifa del trabajador, duración, total calculado, mensaje y decisión de selección.
- **StatusChip:** etiquetas de estados de trabajo, oferta, asignación, pago de cliente, transferencia y verificación. **Color + texto** siempre, no solo color.
- **TrustBadge:** identidad verificada / Pro / Experto / insignia relevante. No sugerir verificación donde no existe.
- **Alert / InlineNotice:** informativo, advertencia, error, éxito; mensajes recuperables en lenguaje claro.
- **MoneyConfirmationDialog:** título, operación, valor y desglose exactos, consecuencias, botón de cancelar y de confirmar; doble confirmación para devoluciones.
- **Tabs / Pagination:** tabs con estado accesible (`aria-selected`), paginación con página actual y número de resultados.
- **Timeline / EvidenceItem:** secuencia con fecha-hora local de Chile, autor, evidencia, estado, foto descargable/accesible, y distinción entre llegada verificada/en revisión.
- **WorkTimer:** visual grande y legible; fuente real basada en tiempos del servidor, no cronómetro de pestaña como fuente de verdad; estado de sincronización.
- **DeliveryPIN:** panel para mostrar PIN al cliente, entrada para trabajador, nunca exponer código en mensajes o registro público; límite de intentos, bloqueo explicado.
- **EvidenceUploader:** fotos/PDF hasta 8 MB donde corresponda, progreso, vista previa, peso, validación de formato y error por archivo.
- **PriceBreakdown:** valor base (tarifa/hora × duración), bono potencial, tarifa HagoTuFila (14% configurable), total; conceptos de devolución y tiempo extra separados. Mantener fórmula idéntica en cliente, trabajador y administración según permisos.
- **Navigation:** barra superior escritorio, barra inferior móvil (mínimo 44 × 44 CSS px por control), cambio explícito de modo cliente/trabajador.
- **EmptyState / Skeleton / ErrorState / PermissionState:** textos y acciones concretas; recuperación sin pérdida de datos.

## 4. Arquitectura de navegación

**Visitante:** Inicio / Trabajos disponibles / Detalle / Trabajadores verificados / Perfil público / Cómo funciona / Pago Protegido / Precios / Trabajar / Verificación / Reglas y términos / Ayuda y contacto / Entrar / Crear cuenta / Recuperar / Confirmar enlace / PWA sin conexión.

**Cliente:** Mis trabajos (por estado) / Publicar (4 pasos) / Confirmación / Detalle propio y ofertas / Editar / Resumen y pago Webpay / Resultado de pago / Seguimiento / Solicitud de tiempo adicional / PIN / Aprobar + decidir bono / Disputa / Reseña / Devoluciones / Mensajes / Notificaciones / Cuenta.

**Trabajador:** Perfil y zonas / Disponibilidad / Verificación / Explorar y ofertar / Mis trabajos / Trabajo asignado / En camino / Consentimiento ubicación / Llegada GPS / Comenzar / Actualizaciones / Tiempo adicional / PIN / Entrega / Estado de pago / Ganancias / Disputa / Reseña / Mensajes / Notificaciones / Cuenta.

**Administración:** Resumen de colas + anomalías / Verificaciones / Llegadas por revisar / Disputas / Pagos de clientes / Devoluciones / Conciliación / Cobros duplicados / Pagos a trabajadores / Caso del trabajo (solo lectura). Acciones con autorización, auditoría y motivos requeridos.

## 5. Inventario de pantallas y criterios

| Familia | Pantalla / variante | Diseño y acciones clave |
|---|---|---|
| Público | Inicio | Hero de propuesta de valor, búsqueda y tareas destacadas, CTA publicar y trabajar; tres garantías visibles. |
| Público | Cómo funciona / Pago Protegido | Explicación paso a paso y línea temporal del dinero. No prometer liberación inmediata. |
| Público | Precios sugeridos | Ejemplos CLP, sin decimales, desglose de 14%, duración y bono. |
| Público | Trabajar / Verificación | Beneficios, requisitos, estados y CTA de registro. |
| Público | Reglas / Términos / Privacidad / Ayuda / Contacto | Páginas de contenido con encabezados, navegación de apoyo, contacto disponible. Texto jurídico sujeto a validación. |
| Público | Trabajos disponibles | Filtro texto/región/comuna/categoría/urgencia/fecha; paginación y vacíos. |
| Público | Detalle trabajo | Variantes: anónimo (iniciar sesión), no verificado (verificación), verificado (oferta), propietario (administrar). |
| Público | Trabajadores verificados / Perfil | Foto, nombre + inicial, nivel, distintivos, regiones, comunas, estadísticas y reseñas; jamás perfiles públicos de clientes. |
| Auth | Entrar / Crear / Recuperar / Nueva contraseña | Validaciones, enlace expirado, confirmación «revisa tu correo» y reintento con límites. |
| Auth | Confirmar enlace | Pantalla intermedia con Continuar, advertencia sobre otra sesión y correo no solicitado. |
| Auth | Onboarding | Nombre, apellido, modo inicial; ambos modos disponibles para la misma cuenta. |
| Cliente | Publicar 1–4 | Categoría; lugar/fecha/duración/privacidad; objetivo/bono/urgencia; precio/desglose/condiciones. |
| Cliente | Publicación exitosa / Mis trabajos | Vista previa pública sin dirección, tabs de estados y avisos del pago. |
| Cliente | Mi trabajo / Editar / Ofertas | Lista de ofertas con nivel, tarifa, mensaje y elección; edición solo si estado lo permite. |
| Cliente | Pago / Salida a Webpay / Regreso | Estado confirmado, rechazado, cancelado, tiempo agotado, verificando, en revisión y duplicado. En revisión/verificando bloquear reintento. |
| Cliente | Trabajo asignado | Llegada sin coordenadas, línea temporal de evidencias, chat, PIN y cambios de estado. |
| Cliente | Tiempo adicional / Aprobar / Bono | Autorizar/rechazar minutos y pagarlos aparte; al aprobar elegir bono sí/no. |
| Cliente | Disputa / Devolución / Reseña | Motivo, evidencia, estado visible, devolución con desglose, reseñas mutuas después de aprobar. |
| Trabajador | Perfil / Verificación | Presentación, tarifa base, disponibilidad, categorías, zonas, radio km, cuatro estados. |
| Trabajador | Mis trabajos | En curso, próximos, terminados, cancelados. |
| Trabajador | Asignado y ejecución | Dirección solo tras pago, en camino → consentimiento → llegada → comenzar → actualizar → PIN → entrega. |
| Trabajador | Más tiempo / Estado de pago | Solicitud de minutos, confirmación pagada aparte, estados de transferencia sin revelar cifras privadas del cliente. |
| Trabajador | Ganancias | Transferido, por transferir y retenido, lista con referencia de transferencia y motivo genérico de retención. |
| Ambos | Mensajes / Notificaciones / Mi cuenta | Conversaciones desde oferta, avisos internos solamente, foto/datos/modos. |
| Admin | Panel | Colas de verificación, llegada, disputa, pagos, devoluciones y transferencias; alerta de integridad monetaria. |
| Admin | Verificación / Llegada | Evidencia, decisión aprobar/rechazar, motivo, traza de auditoría. |
| Admin | Disputas | Pruebas separadas por parte, resolución total cliente / trabajador / parcial y monto. |
| Admin | Pagos clientes | Filtros, detalle, revisión, devolución doblemente confirmada, conciliación y duplicados. |
| Admin | Pagos trabajadores | Por resolver/historial, aprobar, retener, ajuste solo a la baja, transferencia con referencia y fecha habilitada. |
| Admin | Caso de trabajo | Expediente integral *solo lectura*: estados, tiempos, evidencias y pagos. |
| PWA | Sin conexión | Indicador persistente, contenido seguro ya disponible, acción «Reintentar»; nunca confirmar acciones financieras offline. |

**Responsive por pantalla:** 320–639 px una columna y navegación inferior; 640–939 px tarjetas 1–2 columnas; ≥940 px navegación superior, 2 columnas contenido/aside o panel de administración con menú lateral. Formularios en móvil secuenciales con CTA al final, sin cortar los diálogos. Modal de pago ocupa casi toda la anchura móvil; en escritorio máximo 430–560 px.

**Todos los estados obligatorios:** vacío, carga, error, permisos, éxito, revisión, acción bloqueada con motivo y confirmación de acción irreversible. Las etiquetas de trabajo, asignación, oferta, pago de cliente y pago de trabajador se deben mapear 1:1 desde el estado del backend. Nunca suponer un pago confirmado por haber vuelto del navegador.

## 6. Microcopy prioritario

| Situación | Texto sugerido |
|---|---|
| Sin ofertas | «Todavía no llegan ofertas. Te avisaremos aquí cuando alguien proponga una tarifa». |
| No verificado | «Para enviar ofertas, primero necesitamos verificar tu identidad». |
| Verificación pendiente | «Estamos revisando tu identidad. Todavía no puedes ofertar». |
| Dirección oculta | «Compartiremos la dirección exacta solo con el trabajador asignado, después del pago». |
| Pago en proceso | «Estamos confirmando tu pago. No vuelvas a pagar». |
| Pago en revisión | «Tu pago está en revisión. Puedes volver a esta pantalla para ver el resultado». |
| Pago rechazado | «No pudimos confirmar el pago. Revisa el motivo antes de intentarlo de nuevo». |
| Pago duplicado | «Detectamos un cobro o intento duplicado. Lo revisaremos antes de continuar». |
| GPS no verificado | «Registramos tu llegada, pero necesitamos revisarla antes de marcarla como verificada». |
| GPS sin permiso | «Necesitamos permiso de ubicación para verificar tu llegada. Puedes activarlo en tu navegador». |
| Solicitud de tiempo extra | «¿Apruebas 30 minutos adicionales? Si aceptas, deberás pagarlos por separado». |
| PIN incorrecto | «El código no coincide. Revísalo con el cliente. Te quedan [N] intentos». |
| Entrega completada | «La entrega quedó registrada. El cliente puede aprobarla o reportar un problema». |
| Aprobación automática | «Si no respondes dentro de 12 horas, aprobaremos automáticamente la entrega». |
| Ventana de reclamos | «Después de aprobar, tienes 12 horas para reportar un problema». |
| Pago a trabajador retenido | «Tu pago está retenido mientras se revisa el trabajo». |
| Límite de frecuencia | «Has realizado varias acciones seguidas. Puedes volver a intentarlo en [N] minutos». |
| Error general | «No pudimos completar la acción. Tus datos siguen guardados. Intenta nuevamente». |
| No hay conexión | «Sin conexión. Puedes revisar información cargada, pero no enviar acciones nuevas». |

## 7. Accesibilidad, seguridad e interacción

1. Foco visible en todos los controles, orden de tabulación coherente, etiquetas asociadas con IDs y `aria-describedby`, anuncios `aria-live` para resultado de guardado o error sin quitar el foco.
2. Control táctil mínimo de 44×44 px. Evitar dependencia de deslizar; todas las operaciones deben poder realizarse con un toque/botón. Compatibilidad con zoom 200% y reducción de movimiento.
3. Contraste WCAG AA real en producción: validar colores contra los fondos y estados específicos, incluidos chips y placeholders; evitar texto sobre lima con tono bajo.
4. Formularios preservan datos tras errores. Validaciones en línea sin bloquear lectura; indicar a qué campo pertenece el error.
5. Confirmaciones financieras detallan importe, destinatario, consecuencia y opción de cancelar; doble confirmación explícita para devoluciones. Acciones administrativas exigen motivo registrado.
6. PWA/cache: evitar cachear datos privados o financieros sin control. No ejecutar pagos, actualizaciones de estado, PIN ni acciones admin mientras no hay red.
7. Llegadas: solo resultado (verificada/en revisión) al cliente; coordenadas únicamente en ámbitos con permiso operativo. Direcciones y códigos privados después de pago confirmado.
8. Prevención de pagos repetidos: botones bloqueados en estados verificando/en revisión y consultas de estado antes de ofrecer reintento. La UI no es la fuente de verdad monetaria.
9. Los nombres públicos son primer nombre + inicial. No exponer el perfil del cliente como ficha pública.
10. Mostrar estados correctamente para cancelación en verificación; nunca presentar devolución o transferencia como completadas antes de confirmación administrativa/bancaria.

## 8. Alcance del prototipo entregado

El HTML es un **prototipo interactivo de concepto visual**, no una aplicación operativa: muestra navegación y flujos clave con contenido de demostración, diálogos de muestra, formulario de 4 pasos y varias vistas por rol. No tiene autenticación real, geolocalización, backend, persistencia, pagos ni verificación. Hay pantallas y estados documentados aquí cuyo diseño de detalle y su integración todavía deben completarse antes de producción, especialmente recuperación de contraseña, todas las acciones administrativas, todas las variantes de errores y reseñas. Los controles de demostración no implican acciones reales.

**Fuera de lanzamiento:** FilaPuntos. Podría explorarse más adelante únicamente como **propuesta**, no se muestra como capacidad disponible.
