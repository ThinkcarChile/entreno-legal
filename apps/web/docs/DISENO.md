# Diseño, sistema visual y aplicación instalable

Guía del Bloque 4: la identidad de HagoTuFila, los tokens de los que sale todo
el color y toda la tipografía, el catálogo de componentes, cómo se comporta la
interfaz de 320 a 1440 píxeles y qué hace —y qué no hace— la aplicación
instalable.

> **Identidad provisional.** El logotipo de este documento sirve para construir
> el producto. No está registrado, no es definitivo y está pensado para
> sustituirse sin tocar más que dos archivos.

---

## 1. La marca en una frase

Una marca chilena de servicios entre personas: cálida, clara y seria con el
dinero. Coral para lo que se pulsa, azul profundo para lo que se lee, crema para
el fondo. Ni un gradiente decorativo ni un efecto que no signifique nada: aquí
la estética comunica confianza, y la confianza es el producto.

### Isotipo

Tres ideas en una figura: el **pin** de ubicación (dónde), el **reloj** que
lleva dentro (cuánto tiempo) y el **visto** verde que lo cierra (cumplido).

Está dibujado en código (`src/components/layout/logo.tsx`) y no como imagen:
hereda el color del contexto, se ve nítido a 16 px y a 512, y no hay un PNG que
se olvide de actualizar. Variantes:

| Variante | Dónde | Cómo |
|---|---|---|
| Horizontal | Cabecera, pie | `<Logo />` |
| Compacta (solo símbolo) | Espacios estrechos | `<Logo compact />` |
| Monocroma sobre oscuro | Bloques oscuros | `<Logo tone="invert" />` |
| Favicon | Pestaña del navegador | `src/app/icon.svg` |
| Icono de aplicación | PWA, iOS | `public/icons/*`, `src/app/apple-icon.svg` |

---

## 2. Tokens: un solo sitio para cada valor

Todo vive en `src/app/globals.css`, dentro de `@theme`. **Ningún componente
escribe un color, un radio o una sombra a mano.** `npm run verify:pwa` lo
comprueba: recorre todos los `.tsx` y falla si encuentra un hexadecimal suelto.

La única excepción declarada es `src/config/brand.ts`, con tres colores que
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
| Azul profundo (marca, texto) | `--color-ink-950` | `#152238` |
| Coral (marca gráfica) | `--color-brand-500` | `#e8476b` |
| Coral de acción | `--color-brand-600` | `#ce2f59` |
| Crema (fondo) | `--color-canvas` | `#fff9f4` |
| Blanco (superficie) | `--color-surface` | `#ffffff` |
| Verde de verificación | `--color-success-500` | `#20b486` |

Los grises no son grises: son azules desaturados. Es lo que hace que el crema se
vea cálido y no sucio.

### Contraste

Los tonos de texto están elegidos para cumplir **WCAG AA** sobre blanco y sobre
crema, y `verify:pwa` **recalcula** los diez pares críticos en cada ejecución: un
comentario que dice «4,98:1» y una paleta que ya no lo cumple es peor que no
tener el comentario.

| Par | Ratio |
|---|---|
| Texto blanco sobre `brand-600` | 4,98:1 |
| `brand-700` sobre blanco | 6,70:1 |
| `ink-600` sobre blanco | 7,14:1 |
| `ink-500` sobre blanco | 4,78:1 |
| `success-700` sobre blanco | 5,31:1 |
| `ink-400` sobre `ink-950` | 5,63:1 |

`ink-400` **no se usa para texto**: es de iconos y separadores. Donde acompañaba
a un tamaño de texto se subió a `ink-500`.

---

## 3. Tipografía

Inter, cargada con `next/font` (sin petición a un tercero en tiempo de carga).
Una sola escala, la de los tokens:

| Token | Tamaño | Uso |
|---|---|---|
| `text-display` | 3 rem | Portada en escritorio |
| `text-h1` | 2,25 rem | Título de página |
| `text-h2` | 1,75 rem | Título de sección |
| `text-h3` | 1,25 rem | Título de tarjeta o bloque |
| `text-body` | 1 rem | Texto corrido |
| `text-small` | 0,875 rem | Texto secundario |
| `text-caption` | 0,8125 rem | Marcas de tiempo, referencias |
| `text-label` | 0,75 rem | Etiquetas en versalitas |

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
| Acción | `Button` (5 variantes, 3 tamaños, estado `loading`), `ButtonLink`, `IconButton` |
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
| Portada | «Tu tiempo vale. Nosotros hacemos la fila.» + los dos caminos |
| Buscador | Categoría, comuna y fecha, sin registrarse. Formulario `GET` real |
| Franja de confianza | Verificación, pago protegido, soporte durante el trabajo |
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

`npm run verify:pwa` — 30 comprobaciones estáticas, sin servidor ni Supabase.
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

### Barra inferior

Cinco destinos —Inicio, Explorar, **Publicar**, Mensajes o Mis trabajos según el
modo, y Perfil—. Publicar está destacado de verdad: sale de la rejilla, va
elevado y en coral. Antes tenía una marca `emphasis` que no producía ningún
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
