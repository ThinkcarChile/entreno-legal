# Diseño, sistema visual y aplicación instalable

Guía del Bloque 4: la identidad de HagoTuFila, los tokens de los que sale todo
el color y toda la tipografía, el catálogo de componentes, cómo se comporta la
interfaz de 320 a 1440 píxeles y qué hace —y qué no hace— la aplicación
instalable.

> **Identidad conceptual.** La identidad actual sale del diseño entregado el
> 27 de octubre de 2026 (`docs/diseno-entregado/`: la especificación y el
> prototipo navegable, que es solo de concepto y no está conectado a nada).
> El logotipo no está registrado y debe redibujarse en vector antes de su uso
> comercial; está pensado para sustituirse sin tocar más que los archivos que
> nombra la tabla del isotipo.

---

## 1. La marca en una frase

«Tu lugar está asegurado. Tu día sigue». El producto no vende tiempo en
abstracto: reduce la incertidumbre de un encargo que otra persona hace en
persona. Práctica, humana, serena y precisa cuando habla de dinero. Verde
petróleo dominante, lima solo para la acción destacada, fondo marfil frío. Sin
adornos infantiles, sin mapas con posiciones exactas y sin mensajes
promocionales en los estados financieros.

### Isotipo

Una **flecha ascendente** ↗ dentro de una silueta suave y ladeada que recuerda
al número de turno de una fila, con una esquina más aguda, como el corte de un
ticket. El logotipo es la palabra en minúsculas con un punto verde:
**hagotufila.**

Está dibujado en código (`src/components/layout/logo.tsx`) y no como imagen:
se ve nítido a 16 px y a 512, y no hay un PNG que se olvide de actualizar.
Variantes:

| Variante | Dónde | Cómo |
|---|---|---|
| Horizontal | Cabecera, pie | `<Logo />` |
| Compacta (solo símbolo) | Espacios estrechos | `<Logo compact />` |
| Sobre oscuro | Bloques oscuros | `<Logo tone="invert" />` (palabra blanca, punto lima) |
| Favicon | Pestaña del navegador | `src/app/icon.svg` |
| Icono de aplicación | PWA, iOS | `public/icons/*`; en iOS, `src/app/apple-icon.png` (generado desde `brand/apple-icon.svg`) |
| Formulario de Transbank | Logotipo de comercio, 130 × 59 | `brand/logo-transbank-130x59.png` (generado desde `brand/logo-130x59.html`) |

---

## 2. Tokens: un solo sitio para cada valor

Todo vive en `src/app/globals.css`, dentro de `@theme`. **Ningún componente
escribe un color, un radio o una sombra a mano.** `npm run verify:pwa` lo
comprueba: recorre todos los `.tsx` y falla si encuentra un hexadecimal suelto.

La única excepción declarada es `src/config/brand.ts`, con los colores que
hacen falta fuera del CSS —el manifiesto, `theme-color`, el símbolo del
logotipo— y que antes estaban copiados a mano en cuatro archivos.

### Familias

| Familia | Prefijo | Ejemplo |
|---|---|---|
| Color | `--color-*` | `--color-brand-600` |
| Tipografía | `--text-*` | `--text-h2`, con su interlineado y peso |
| Radio | `--radius-*` | `--radius-card`, `--radius-control`, `--radius-pill` |
| Sombra | `--shadow-*` | `--shadow-raised`, `--shadow-overlay` |
| Espaciado | `--spacing-*` | `--spacing-header`, `--spacing-tabbar` |
| Animación | `--animate-*` | `--animate-sheet-up` |
| Capa | `--z-index-*` | `--z-index-header`, `--z-index-overlay` |

### Paleta

| Papel | Token | Valor |
|---|---|---|
| Verde petróleo: acción principal, encabezados oscuros | `--color-brand-950` | `#12393a` |
| Foco, progreso, navegación activa, enlaces | `--color-brand-700` | `#14766c` |
| Confirmaciones y fondos suaves | `--color-brand-100` | `#ddf3e9` |
| Lima: acción destacada, acentos sobre oscuro | `--color-accent-300` | `#d9f27e` |
| Fondo de las vistas (marfil) | `--color-canvas` | `#f7f8f4` |
| Tarjetas y formularios | `--color-surface` | `#ffffff` |
| Texto primario | `--color-ink-950` | `#142f33` |
| Texto secundario | `--color-ink-500` | `#627371` |
| Separadores y bordes | `--color-line` | `#dce5e1` |
| Confirmado / transferido | `--color-success-800` | `#155d4a` |
| Pendiente / en revisión | `--color-warning-700` | `#97631e` |
| Rechazo / disputa / cancelación | `--color-danger-700` | `#a33333` |
| Avisos neutrales | `--color-info-700` | `#245da3` |

Los grises no son grises: son verdes desaturados. Es lo que hace que el marfil
se vea limpio. El lima nunca lleva texto claro encima ni texto largo.

### Contraste

Los tonos de texto están elegidos para cumplir **WCAG AA** sobre blanco y sobre
el marfil, y `verify:pwa` **recalcula** los veinte pares críticos en cada
ejecución: un comentario que dice «5,47:1» y una paleta que ya no lo cumple es
peor que no tener el comentario.

| Par | Ratio |
|---|---|
| Texto blanco sobre `brand-950` (botón principal) | 12,56:1 |
| `brand-950` sobre `accent-300` (botón lima) | 10,14:1 |
| `brand-700` sobre blanco | 5,47:1 |
| `ink-600` sobre blanco | 6,75:1 |
| `ink-500` sobre blanco / sobre el marfil | 4,99:1 / 4,68:1 |
| Chips: éxito, aviso, error, información | 6,70 · 4,54 · 5,78 · 5,71 |

`ink-400` **no se usa para texto**: es de iconos y separadores. Donde acompañaba
a un tamaño de texto se subió a `ink-500`.

---

## 3. Tipografía

Inter, cargada con `next/font` (sin petición a un tercero en tiempo de carga).
Una sola escala, la de los tokens:

| Token | Tamaño | Uso |
|---|---|---|
| `text-display` | 3,5 rem | Portada en escritorio |
| `text-h1` | 2,375 rem | Título de página |
| `text-h2` | 1,75 rem | Título de sección |
| `text-h3` | 1,1875 rem | Título de tarjeta o bloque |
| `text-body` | 1 rem | Texto corrido |
| `text-small` | 0,875 rem | Texto secundario |
| `text-caption` | 0,8125 rem | Marcas de tiempo, referencias |
| `text-label` | 0,6875 rem | La «ceja» sobre los títulos, siempre en mayúsculas |

Los encabezados van apretados y con peso (700–800, espaciado negativo): la
marca habla corto y seguro.

`cn()` (`src/lib/utils/cn.ts`) conoce esta escala. Sin eso, `tailwind-merge`
tomaba `text-small` o `text-body` por colores y borraba el color de texto que
venía antes: los botones `sm` y `lg` perdían su color y heredaban el del
contexto. Lo cubre `cn.test.ts`.

Cada token trae su interlineado, su peso y su espaciado de letra. Por eso los
titulares ya no llevan `font-semibold tracking-tight` pegado detrás: estaba
repetido en cuarenta y cuatro archivos y bastaba con que uno se olvidara para
que dos títulos «iguales» no lo fueran.

La escala por defecto de Tailwind (`text-sm`, `text-xs`, `text-2xl`…) ya no se
usa en la aplicación: tener dos escalas conviviendo es exactamente lo que hace
que dos textos del mismo tamaño no lo sean.

Los campos de formulario usan 16 px en móvil a propósito: por debajo de eso iOS
hace zoom al enfocar y la pantalla salta.

---

## 4. Componentes

Todo sale de `src/components/ui/index.ts`. Un solo barril, para que no haya
media aplicación importando por ruta directa y la otra media por el barril.

| Grupo | Componentes |
|---|---|
| Acción | `Button` (6 variantes: `primary` verde petróleo, `accent` lima, `secondary` suave, `outline`, `ghost`, `danger`; 3 tamaños, estado `loading`), `ButtonLink`, `IconButton` |
| Formulario | `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Radio`, `Switch` |
| Superficie | `Card` y su familia, `Section` |
| Identidad | `Avatar`, `Badge`, `StatusChip`, `Rating`, `StarRow` |
| Dinero | `Amount`, `AmountRange`, `HourlyRate`, `PriceBreakdown`, `Stat` |
| Navegación | `Tabs`, `SegmentedControl`, `BucketTabs`, `MobileTabBar` |
| Estados | `EmptyState`, `ErrorState`, `Skeleton`, `JobCardSkeleton`, `TrustItem` |
| Capas | `Overlay` (diálogo y hoja), `Alert`, `PendingButton` |
| Dominio | `JobCard`, `MyJobCard`, `OfferCard`, `WorkerCard`, `ReviewCard`, `JobTimeline`, `EvidenceGallery` |

Dos criterios que se repiten en todos:

- **Altura mínima táctil de 44 px** en los tamaños `md` y `lg`. Es el área que
  se puede acertar de pie, con una mano y el teléfono en la otra, que es la
  situación real de quien usa esto mientras trabaja.
- **La forma además del color.** `StatusChip` lleva un punto a la izquierda; sin
  él, distinguir dos estados depende de ver el color, que es el requisito de
  accesibilidad que más se incumple en paneles como este.

### `Overlay`

Un solo componente para el diálogo de escritorio y la hoja que sube desde abajo
en móvil, porque es la misma idea —algo que exige atención y se cierra— y porque
mantener dos habría significado mantener dos veces lo que de verdad importa:
Escape, clic fuera, foco atrapado dentro, foco devuelto al cerrar y fondo sin
desplazar. `role="dialog"`, `aria-modal`, título anunciado.

---

## 5. La portada

| Sección | Qué hace |
|---|---|
| Cabecera | Cuatro enlaces y ninguno más. Lo que no está aquí está en el pie |
| Portada | Bloque verde petróleo: «Tu lugar está asegurado. Tu día sigue.» + los dos caminos (lima: publicar; blanco: ganar dinero) y, en escritorio, la ilustración del aviso de llegada |
| Franja de confianza | Identidad verificada, Pago Protegido HagoTuFila, seguimiento de cada etapa |
| Buscador | Categoría, comuna y fecha, sin registrarse. Formulario `GET` real |
| Trabajos publicados | Datos reales. Comuna y región, **nunca la dirección exacta** |
| Cómo funciona | Dos columnas: quien contrata y quien trabaja |
| Seguridad | Bloque oscuro con las cuatro garantías del pago |
| Categorías | Las dos familias, con precio de referencia |
| Trabajadores | Solo si hay perfiles reales |
| Reseñas | **Solo si existen.** Si no hay, la sección no se pinta |
| Preguntas frecuentes | `<details>` nativo: funciona sin JavaScript |
| Pie | Producto, confianza, ayuda y legal |

**Lo que no hay, y es deliberado:** ni una cifra de uso inventada, ni un
testimonio escrito por nosotros, ni una promesa de atención 24/7, ni un
«procesamos pagos con X» de un proveedor que todavía no está integrado. Con un
producto sin volumen, un «1.047 trabajos completados» es exactamente lo que
destruye lo único que se está vendiendo.

El buscador es un `<form method="get" action="/trabajos">`: sin JavaScript
navega igual, y con JavaScript se queda la transición del enrutador y la
limpieza de los campos vacíos, para no dejar `?categoria=&comuna=` colgando en
una URL que la gente comparte.

---

## 6. Responsive

Siete anchos, comprobados **automáticamente** en `e2e/responsive.spec.ts`: 320,
375, 390, 430, 768, 1024 y 1440. Para cada página pública y cada ancho se
comprueba que el documento no sea más ancho que la ventana, y si lo es, la
prueba **nombra los elementos culpables** con sus coordenadas.

En la misma prueba, por página: cero errores de consola (los avisos de
hidratación de React llegan como `error`, así que quedan dentro), cero errores
de JavaScript, cero peticiones caídas y cero respuestas 500.

Reglas de fondo:

- Una sola interfaz, no dos. Los mismos componentes cambian de disposición; no
  hay un árbol «móvil» y otro «escritorio» que mantener en paralelo.
- `overflow-x: hidden` en `html` como red de seguridad, **no** como excusa: la
  prueba mide `scrollWidth`, que el `hidden` no disimula.
- Las filas de pestañas se desplazan en móvil y **se reparten en varias líneas
  desde `lg`**: una fila recortada en una pantalla ancha esconde estados sin que
  nadie sepa que están ahí.
- La administración lleva menú lateral oscuro desde `lg` y, por debajo, una
  fila desplazable con la sección activa marcada (`aria-current`).
- Los filtros del listado: lo habitual siempre a la vista, lo raro detrás de
  «Más filtros», que se abre solo si ya hay alguno puesto —si no, se aplican
  filtros invisibles y los resultados parecen equivocados—.

---

## 7. Accesibilidad

`e2e/responsive.spec.ts` audita cada página pública: idioma declarado en
`<html>`, exactamente un `<h1>`, un `<main>`, `alt` en todas las imágenes,
nombre accesible en todo enlace y botón visible, etiqueta en todo campo de
formulario y ningún `tabindex` positivo.

Además, a mano y por componente: foco visible con `focus-visible` en todo lo
pulsable, `aria-current="page"` en la navegación, pestañas con flechas del
teclado y `tabindex` rotativo, y el `Overlay` con foco atrapado y devuelto.

---

## 8. Aplicación instalable

`npm run verify:pwa` — 31 comprobaciones estáticas, sin servidor ni Supabase.
Existe porque los fallos de una PWA son silenciosos: un icono que falta, un
`start_url` fuera de alcance o un service worker que guarda una respuesta
autenticada no rompen ninguna pantalla; simplemente hacen que la aplicación no
se instale, o que alguien vea los datos de otra persona.

### Manifiesto

`display: standalone`, `start_url` dentro de `scope`, `orientation: "any"` —el
trabajo se usa de pie, con el teléfono en cualquier posición—, colores desde
`config/brand`, `lang: "es-CL"`, tres iconos (192, 512 y **maskable** de 512 con
fondo a sangre y el símbolo al 62 % para sobrevivir al recorte de Android) y
tres accesos directos.

### Icono de iOS

Para la pantalla de inicio, iOS usa `<link rel="apple-touch-icon">`; los iconos
del manifiesto son SVG y no le sirven para eso. Next genera esa etiqueta desde
`src/app/apple-icon.*` **solo si es `.png`, `.jpg` o `.jpeg`**. Había un
`apple-icon.svg`, que Next ignoraba sin avisar: la página salía sin esa
etiqueta y el iPhone instalaba la aplicación sin su icono. Ahora es un PNG de 180 × 180 sin transparencia —iOS
pinta de negro lo transparente— dibujado desde `brand/apple-icon.svg` con
`npm run brand:apple-icon` (el Chromium de Playwright; `CHROMIUM_PATH` si no
es el que trae). Si cambia la marca, se cambia el SVG y se vuelve a generar.
`verify:pwa` comprueba el tamaño, que no tenga canal alfa y que no vuelva a
aparecer un `apple-icon.svg`.

### Barra inferior

Cinco destinos —Inicio, Explorar, **Publicar**, Mensajes o Mis trabajos según el
modo, y Perfil—. Publicar está destacado de verdad: sale de la rejilla, va
elevado, en verde petróleo con el signo en lima. Antes tenía una marca `emphasis` que no producía ningún
estilo, así que estaba declarado como destacado y se veía igual que los demás.

- Solo bajo `lg`. Por encima, la navegación vive en la cabecera.
- Respeta `env(safe-area-inset-bottom)`.
- El layout reserva su alto con `.pb-tabbar` **en la columna entera**, no solo
  en el `main`: con el relleno solo en el contenido, el pie quedaba debajo de la
  barra. Lo encontró la prueba, no el ojo.
- No aparece sobre los diálogos: el `Overlay` va en una capa superior
  (`--z-index-overlay`).

### Sin conexión

El service worker hace **una** cosa: que la aplicación instalada no muestre el
dinosaurio cuando se cae la red. El «nada más» es deliberado.

| Guarda | No guarda |
|---|---|
| `/_next/static/*` (nombres con huella) | El HTML de cualquier página |
| `/icons/*` y el manifiesto | Nada que vaya a Supabase |
| La página `/sin-conexion` | Nada con `Authorization` ni cookies |

Solo intercepta `GET` —un `POST` cacheado sería un envío repetido, justo lo que
no se quiere en una acción que mueve un trabajo o un pago— y solo del propio
origen. La navegación va **siempre a la red**; si no hay red, se muestra la
página de cortesía, que no lleva datos de nadie. Cuando vuelve, se recupera
sola: no hay nada obsoleto que reconciliar porque no se guardó nada.

**Por construcción, el service worker no puede mostrar los datos de otra
persona:** nunca guarda una respuesta autenticada.

---

## 9. Datos de demostración

Cubren Santiago, Valparaíso, Viña del Mar, Concepción, La Serena, Antofagasta,
Temuco y Puerto Montt, con códigos de comuna reales de `src/lib/geo/chile.ts`.
Chile no es solo Santiago, y una demostración que solo muestra la Metropolitana
enseña un producto que no es el que se está construyendo.

Ninguna persona de los datos de demostración es real. El modo demostración va
siempre con su aviso en pantalla y es de solo lectura.

---

## 10. Lo que se arregló por el camino

Defectos reales encontrados al construir este bloque, no mejoras estéticas:

1. **El pie quedaba debajo de la barra inferior en móvil.** El relleno que
   reserva su alto estaba en `<main>` y el pie está fuera de `<main>`. Lo
   encontró la prueba de solapamiento, no una revisión visual.
2. **La página 404 pintaba dos cabeceras dentro de la aplicación** y dejaba una
   pantalla entera en blanco: traía su propia cabecera y su propio `min-h-dvh`
   encima de los del layout. Ahora hay una 404 por grupo de rutas.
3. **El campo de búsqueda navegaba en cada pulsación.** Escribir «notaría» eran
   siete navegaciones y siete consultas, y el cursor saltaba a media palabra.
4. **`text-ink-400` se usaba como color de texto** en dieciséis sitios: 3,1:1
   sobre blanco, por debajo de AA.
5. **El menú de móvil se cerraba en un efecto,** así que la página nueva se
   pintaba una vez con la hoja todavía encima y luego otra sin ella.
6. **La interfaz afirmaba que los pagos se procesan con una pasarela que no está
   integrada.** Corregido en la portada, en «cómo funciona», en «pago protegido»
   y en el botón de pagar.
7. **El asistente de publicación pedía seis «Continuar»** para once campos.
   Ahora son cuatro pantallas, con la misma validación exacta.
