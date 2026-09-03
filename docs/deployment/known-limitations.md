# Limitaciones conocidas de v1

Esto separa dos cosas que se confunden fácil: lo que **falta y bloquea** el
lanzamiento, y lo que **no está y no bloquea** porque quedó fuera de v1 a
propósito. Lo primero vive en `launch-gate.md` con estado y evidencia; acá va lo
segundo, para que nadie lo lea como un olvido.

## Fuera de v1, por decisión

| no está | por qué no bloquea |
|---|---|
| Glucómetros continuos (CGM) y wearables | La app modela lo que la familia **declara y confirma**; ningún flujo depende de un sensor. Un CGM entraría como otra fuente de observaciones clínicas, sobre el mismo modelo. |
| Importar exámenes desde Gmail u otro correo | La carga es manual (foto/PDF) con revisión humana. Es más lento y es más seguro para datos de salud; la importación automática es una decisión de privacidad, no un detalle técnico. |
| Pedido automático al supermercado | La lista de compras es la salida; comprar la hace una persona. No hay integración con ningún retailer. |
| Sincronización bancaria | El dinero entra por boletas revisadas. Un lote sin boleta tiene valor **DESCONOCIDO**, no `$0`, y la app lo dice. |
| WhatsApp, notificaciones push, delivery, marketplace | Ningún flujo de v1 los necesita. Están explícitamente fuera del cierre. |
| Múltiples monedas por hogar | La moneda se congela por lote al nacer; el hogar tiene una. Cambiar la moneda del hogar no reinterpreta lotes históricos (0042). |
| Relevo de una segunda comida por duración del evento | Un evento cubre las comidas que se **declaran** (`event_covered_meals`), no las que su horario sugiere. Un asado de nueve horas releva la cena solo si el planificador lo marca. Sin heurística oculta, por diseño. |
| Ejecución de E2E contra un entorno local | La app habla PostgREST con Supabase; PGlite no lo tiene. Los E2E corren solo contra **staging**. |
| Real-device testing automatizado | Playwright emula 320/375/430 px; instalar la PWA, la cámara, el QR y la foto de boleta/examen se prueban en un teléfono real con el checklist de `release-checklist.md`. |

## Decisiones de producto que siguen siendo del dueño

Estas no son limitaciones técnicas: son elecciones que el código respeta hasta
que alguien las cambie.

- **Un evento nace en borrador (`DRAFT`)** y se puede borrar mientras no haya
  producido nada físico; desde `PLANNED` se cancela, nunca se borra. La historia
  de un evento que existió no desaparece.
- **La nutrición del recetario es `DEV_SEED`**: valores de referencia
  razonables, **no** la tabla del INTA. La base tiene un candado
  (`nutrition_unverifiable_sources`) que impide marcarlos como verificados. Lo
  que la familia ve en pantalla sale de ahí, y la app nunca dice que está
  verificado.
- **Un valor que nadie asignó es DESCONOCIDO.** No hay estimación proporcional
  de costos de merma ni de precios: sin boleta no hay número. Esto es doctrina,
  no una funcionalidad pendiente.

## Lo que sí bloquea, y por eso no está acá

Hosting sin decidir, staging inexistente, Auth de producción apuntando a
`localhost`, Confirm Email desactivado, E2E sin ejecutar. Cada uno con su
estado y su evidencia en `launch-gate.md`.
