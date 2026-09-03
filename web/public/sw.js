/**
 * Service worker de NutriFamilia. Escrito a mano, sin librería: lo único que
 * hace es (1) dejar la app instalable y arrancable rápido y (2) decir la
 * verdad cuando no hay red.
 *
 * LA REGLA QUE MANDA ACÁ: no se guarda NADA que venga de Supabase ni de las
 * pantallas renderizadas en el servidor. En esta app el HTML de /pantry o de
 * /plan trae la despensa y el plan escritos adentro; una copia guardada se ve
 * exactamente igual a la app funcionando, y mostrar una despensa de ayer como
 * si fuera la de hoy es la mentira que este proyecto no permite. Un dato que
 * no se sabe se declara: por eso, sin red, va la pantalla /sin-conexion.html
 * en vez de una copia vieja.
 *
 * QUÉ SE GUARDA Y CON QUÉ ESTRATEGIA (son dos casos, no uno):
 *
 *  1. /_next/static/** — caché primero y para siempre, sin revalidar. Se puede
 *     porque el nombre del archivo lleva el hash del contenido: un archivo
 *     distinto es una URL distinta, así que una copia guardada nunca queda
 *     vieja.
 *
 *  2. El armazón (/sin-conexion.html, el manifiesto, los iconos) y cualquier
 *     otro estático SIN hash — caché primero pero revalidando en segundo plano.
 *     Acá el nombre no cambia nunca, así que la copia guardada SÍ puede quedar
 *     vieja. No es teórico: al cambiar el color de marca de #2f7d4f a #3a684d,
 *     la versión anterior de este worker dejaba a cualquiera que ya tuviera la
 *     app instalada con el icono viejo pegado hasta que borrara los datos del
 *     sitio, porque VERSION era un literal que ningún paso de build subía y el
 *     `activate` entonces nunca borraba nada. Con la revalidación el archivo
 *     nuevo entra al caché solo y aparece en la carga siguiente, sin depender
 *     de que alguien se acuerde de subir un número al desplegar.
 *
 * QUÉ NO SE GUARDA NUNCA, Y POR QUÉ. Cada guarda tiene su caso en
 * sw-no-cachea-datos.test.ts o en lib/pwa.test.ts, comprobado por mutación:
 *
 *  - Nada de OTRO ORIGEN. Supabase Storage entrega los documentos médicos y
 *    las boletas por URL firmada (el token de acceso va en la URL), PostgREST
 *    entrega la despensa y el plan, Auth entrega la sesión. Una copia de
 *    cualquiera de esas es un dato viejo o un secreto escrito en el disco de
 *    un celular: no se toca ni se inspecciona, se deja pasar derecho.
 *  - Ningún archivo bajo /health, /salud ni /finanzas (PREFIJOS_PRIVADOS),
 *    tenga la extensión que tenga: son exámenes y boletas, y un documento
 *    médico en el caché de un celular compartido no se arregla después.
 *  - Nada de /api ni ningún payload RSC (`?_rsc=`): son datos, no archivos.
 *  - Ninguna pantalla (HTML): la navegación es red o /sin-conexion.html.
 *  - Ninguna respuesta que el servidor marque `Cache-Control: no-store` o
 *    `private` (ver `sirveParaGuardar`): es la red de seguridad para una ruta
 *    privada que nadie listó, porque Next marca así todo lo que renderiza con
 *    sesión.
 *  - Nada que no sea GET: las mutaciones (server actions) van por POST.
 */

/**
 * En este FUENTE, VERSION es siempre "v1". No es la versión: es el MARCADOR
 * que scripts/empaquetar-pwa.mjs reemplaza EN LA COPIA del bundle por
 * `<version de package.json>-<sha corto>` al empaquetar. Así cada despliegue
 * estrena nombres de caché y el `activate` bota los del despliegue anterior
 * (antes ningún build subía este número y los cachés viejos vivían para
 * siempre). La revalidación en segundo plano se queda igual: cubre un archivo
 * sin hash reemplazado a mano en el servidor sin volver a empaquetar.
 *
 * No lo cambies a mano: lib/pwa.test.ts vigila que esta línea exista tal cual,
 * exactamente una vez, y el empaquetador se niega a estampar si no la encuentra.
 */
const VERSION = "v1";
const CACHE_ARMAZON = `nutrifamilia-armazon-${VERSION}`;
const CACHE_ESTATICOS = `nutrifamilia-estaticos-${VERSION}`;

/** Ruta que se muestra cuando una navegación no llega al servidor. */
const SIN_CONEXION = "/sin-conexion.html";

/**
 * Lo que se baja al instalar. Es corto a propósito: mientras más larga la
 * lista, más chances de que un 404 tonto en un icono arrastre a la instalación
 * entera. Por eso además NO se usa `cache.addAll`, que es todo-o-nada por
 * diseño: acá cada archivo se pide por separado y los que fallen se declaran.
 */
const ARMAZON = [SIN_CONEXION, "/manifest.webmanifest", "/icon.svg", "/apple-touch-icon.png"];

/**
 * Tope de archivos guardados en el caché de estáticos.
 *
 * Cada despliegue de Next genera bundles con hash nuevo; sin tope, el caché
 * crece para siempre con los chunks de todas las versiones anteriores y el
 * navegador termina botándolo completo (incluido el armazón) por espacio.
 */
const MAX_ESTATICOS = 80;

/** Extensiones que sí se pueden guardar: son archivos, no respuestas de datos. */
const EXTENSIONES_ESTATICAS = new Set([
  ".js",
  ".css",
  ".woff",
  ".woff2",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  // El manifiesto es parte del armazón. Si no cuenta como estático, el
  // manejador de fetch no lo intercepta y la copia que el install dejó guardada
  // no se sirve nunca (pasó: quedaba precacheado e inservible a la vez).
  ".webmanifest",
]);

function esEstatico(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  const punto = url.pathname.lastIndexOf(".");
  if (punto === -1) return false;
  return EXTENSIONES_ESTATICAS.has(url.pathname.slice(punto).toLowerCase());
}

/**
 * ¿El nombre del archivo garantiza que el contenido no cambió?
 *
 * Solo /_next/static lo garantiza (hash del contenido en el nombre). Los
 * iconos, el manifiesto y la pantalla de sin conexión conservan la misma URL
 * entre despliegues, así que hay que revalidarlos.
 */
function esInmutable(url) {
  return url.pathname.startsWith("/_next/static/");
}

/**
 * Rutas del propio origen bajo las que NO se guarda ningún archivo, tenga la
 * URL la extensión que tenga:
 *
 *  - /health y /salud: los exámenes y documentos médicos de la familia.
 *  - /finanzas: las boletas.
 *
 * Los documentos en sí viven en Supabase Storage (otro origen, ya excluido);
 * esta lista cubre lo que el propio servidor pudiera contestar bajo esas rutas
 * —una miniatura, una imagen generada, una exportación— y que `esEstatico`
 * tomaría por un archivo del sitio por la pura extensión. Un examen o una
 * boleta guardados en el caché de un celular compartido son un dato privado
 * fuera de la app, y eso no se arregla después: por eso la guarda es por
 * prefijo, antes de mirar la extensión.
 *
 * /api no está acá porque tiene su guarda propia más arriba en `fetch`: esa
 * rige también para navegaciones y payloads RSC, y esta solo para archivos.
 *
 * Esta lista es una lista, o sea incompleta por naturaleza: la red de
 * seguridad para una ruta privada que nadie anotó es `sirveParaGuardar`, que
 * mira lo que el servidor declara en Cache-Control.
 */
const PREFIJOS_PRIVADOS = ["/health", "/salud", "/finanzas"];

function esRutaPrivada(url) {
  return PREFIJOS_PRIVADOS.some(
    (prefijo) => url.pathname === prefijo || url.pathname.startsWith(`${prefijo}/`),
  );
}

/**
 * Lee una cabecera de la respuesta, o "" si no viene.
 *
 * En el navegador `headers` existe siempre; el doble de prueba de
 * sw-no-cachea-datos.test.ts entrega respuestas sin cabeceras. Sin cabecera no
 * hay directiva, y sin directiva rigen las demás reglas: no es un desconocido
 * tapado, es la ausencia de una orden del servidor.
 */
function cabecera(respuesta, nombre) {
  const cabeceras = respuesta.headers;
  if (!cabeceras || typeof cabeceras.get !== "function") return "";
  return cabeceras.get(nombre) ?? "";
}

/**
 * Solo se guarda lo que llegó completo, del propio origen y que el servidor NO
 * marcó como privado.
 *
 * Lo tercero es la red de seguridad de PREFIJOS_PRIVADOS: Next contesta toda
 * pantalla y todo route handler que lee la sesión con
 * `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, y
 * los archivos de public/ y de /_next/static nunca llevan eso. Así una ruta
 * privada nueva que nadie agregó a la lista igual queda fuera del caché, porque
 * lo dice el servidor y no una lista escrita a mano.
 */
function sirveParaGuardar(respuesta) {
  if (!respuesta.ok || respuesta.type !== "basic") return false;
  const control = cabecera(respuesta, "cache-control").toLowerCase();
  return !control.includes("no-store") && !control.includes("private");
}

/**
 * Deja el caché en `maximo` entradas botando las más viejas.
 *
 * `keys()` devuelve las claves en orden de inserción, así que las primeras son
 * las que llevan más tiempo sin renovarse.
 */
async function recortar(nombre, maximo) {
  const cache = await caches.open(nombre);
  const claves = await cache.keys();
  if (claves.length <= maximo) return;
  await Promise.all(claves.slice(0, claves.length - maximo).map((clave) => cache.delete(clave)));
}

/**
 * Baja el armazón de nuevo y devuelve QUÉ no se pudo guardar.
 *
 * `reload` evita que el propio caché HTTP del navegador nos entregue la versión
 * vieja del archivo justo cuando estamos tratando de renovarla.
 *
 * No devuelve una lista vacía cuando algo falla: devuelve la falla, para que
 * quien llama decida si eso es fatal o solo digno de aviso.
 */
async function bajarArmazon() {
  const cache = await caches.open(CACHE_ARMAZON);
  const faltaron = [];
  await Promise.all(
    ARMAZON.map(async (ruta) => {
      let respuesta;
      try {
        respuesta = await fetch(new Request(ruta, { cache: "reload" }));
      } catch (causa) {
        // No es un catch vacío: la ruta queda anotada y el que llama la reporta.
        faltaron.push({ ruta, porque: String(causa) });
        return;
      }
      if (!sirveParaGuardar(respuesta)) {
        faltaron.push({ ruta, porque: `respondió ${respuesta.status}` });
        return;
      }
      await cache.put(ruta, respuesta);
    }),
  );
  return faltaron;
}

/** Deja dicho en consola qué parte del armazón no se pudo traer. */
function avisarArmazonIncompleto(cuando, faltaron) {
  if (faltaron.length === 0) return;
  console.warn(
    `${cuando}: no se pudo traer parte del armazón —`,
    faltaron.map((f) => `${f.ruta} (${f.porque})`).join(", "),
  );
}

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    (async () => {
      const faltaron = await bajarArmazon();

      const sinPantalla = faltaron.find((f) => f.ruta === SIN_CONEXION);
      if (sinPantalla) {
        // ERROR != VACÍO. Sin esta pantalla el worker no tiene nada que decir
        // cuando se cae la red: la app quedaría instalada aparentando que
        // funciona sin conexión y mostrando el error del navegador. Se prefiere
        // que la instalación falle FUERTE — RegistroServiceWorker escucha el
        // paso a "redundant" y lo escribe en consola, así no se pierde en
        // silencio (register() ya resolvió para cuando esto pasa).
        throw new Error(
          `No se pudo guardar ${SIN_CONEXION} (${sinPantalla.porque}). El service worker no se instala: sin esa pantalla no puede decir la verdad cuando no hay red.`,
        );
      }

      // Estos sí se pueden perder: la app sigue instalable y el armazón se
      // vuelve a intentar en la próxima navegación con red. Pero se DICEN.
      avisarArmazonIncompleto("Al instalar el service worker", faltaron);

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      const vigentes = new Set([CACHE_ARMAZON, CACHE_ESTATICOS]);
      const nombres = await caches.keys();
      await Promise.all(
        nombres.filter((nombre) => !vigentes.has(nombre)).map((nombre) => caches.delete(nombre)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * ¿Ya renovamos el armazón desde que arrancó este worker?
 *
 * El navegador prende y apaga el service worker todo el rato, así que esto se
 * reinicia solo cada tantas navegaciones: es la frecuencia justa para que una
 * pantalla de sin conexión o un icono nuevos entren sin pedir red de más en
 * cada pantalla que se abre. Nadie más pide /sin-conexion.html —solo se sirve
 * desde el caché—, así que si no la renovamos acá no la renueva nadie.
 */
let armazonRevisado = false;

/** Trae la copia nueva al caché sin bloquear lo que el usuario está viendo. */
async function revalidar(peticion) {
  let respuesta;
  try {
    respuesta = await fetch(peticion);
  } catch (causa) {
    // Quedarse sin red acá no es un desconocido tapado: la copia guardada ya se
    // entregó y lo único que se pierde es la renovación. Igual se deja dicho.
    console.warn("No se pudo revalidar", peticion.url, "-", String(causa));
    return;
  }
  if (!sirveParaGuardar(respuesta)) return;
  const cache = await caches.open(CACHE_ESTATICOS);
  await cache.put(peticion, respuesta);
}

self.addEventListener("fetch", (evento) => {
  const peticion = evento.request;

  // POST/PATCH/DELETE: mutaciones y server actions. Nunca se tocan.
  if (peticion.method !== "GET") return;

  const url = new URL(peticion.url);

  // Otro origen = Supabase (datos), Google Fonts, cualquier API. Se deja pasar
  // derecho al navegador: acá no se guarda ni se inspecciona nada ajeno.
  if (url.origin !== self.location.origin) return;

  // Peticiones de datos del propio servidor: las rutas /api y los payloads RSC
  // de la navegación cliente (`?_rsc=`). Son datos frescos o no son nada.
  //
  // Esta guarda va ANTES de las otras dos ramas a propósito, y las dos razones
  // están cubiertas por sw-no-cachea-datos.test.ts:
  //   - antes de la rama de navegación, porque si no un pedido RSC sin red
  //     recibiría el HTML de /sin-conexion.html como si fuera un payload de
  //     React y el router se rompería con un error ilegible;
  //   - antes de la rama de estáticos, porque /api puede devolver un .png (una
  //     etiqueta generada, por ejemplo) y ahí `esEstatico` diría que sí y lo
  //     dejaría guardado para siempre.
  if (url.pathname.startsWith("/api/") || url.searchParams.has("_rsc")) return;

  if (peticion.mode === "navigate") {
    evento.respondWith(
      (async () => {
        try {
          const respuesta = await fetch(peticion);
          if (!armazonRevisado) {
            armazonRevisado = true;
            // Hay red y la pantalla ya salió: momento barato para renovar el
            // armazón, que si no queda congelado en la primera versión.
            evento.waitUntil(
              bajarArmazon().then((faltaron) => {
                avisarArmazonIncompleto("Al renovar el armazón", faltaron);
              }),
            );
          }
          return respuesta;
        } catch {
          // Sin red y sin dato: la pantalla lo DICE. No hay copia guardada de
          // esta ruta, y es a propósito (ver el comentario de arriba).
          const guardada = await caches.match(SIN_CONEXION, { cacheName: CACHE_ARMAZON });
          return (
            guardada ??
            new Response("Estás sin conexión y no alcanzamos a guardar la pantalla de aviso.", {
              status: 503,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Un archivo bajo una ruta privada (PREFIJOS_PRIVADOS) no se guarda ni se
  // sirve del caché, tenga la extensión que tenga: pasa derecho al navegador.
  // Va DESPUÉS de la rama de navegación a propósito: abrir /finanzas sin red
  // tiene que seguir mostrando /sin-conexion.html, no el error del navegador.
  // Lo vigila lib/pwa.test.ts en los dos sentidos.
  if (esRutaPrivada(url) || !esEstatico(url)) return;

  evento.respondWith(
    (async () => {
      // Se consulta TAMBIÉN el caché del armazón, que es donde el install deja
      // el manifiesto y los iconos. La versión anterior solo miraba
      // CACHE_ESTATICOS y el armazón quedaba en un caché de solo escritura: sin
      // red no se servía nunca, y con red el primer pedido igual salía a la
      // red — o sea el precacheo del install no servía para nada. Lo vigila
      // sw-no-cachea-datos.test.ts cortando la red justo después del install y
      // exigiendo que cada URL guardada se sirva igual.
      const guardado =
        (await caches.match(peticion, { cacheName: CACHE_ESTATICOS })) ??
        (await caches.match(peticion, { cacheName: CACHE_ARMAZON }));
      if (guardado) {
        // Los bundles con hash no se revalidan nunca (no pueden haber cambiado);
        // todo lo demás sí, o queda pegado para siempre en la primera versión.
        if (!esInmutable(url)) evento.waitUntil(revalidar(peticion));
        return guardado;
      }

      let respuesta;
      try {
        respuesta = await fetch(peticion);
      } catch (causa) {
        // Sin red y sin copia guardada: se contesta DICIENDO qué faltó, no con
        // una promesa rechazada, que el navegador reporta como un error de red
        // anónimo como si el worker no existiera.
        return new Response(
          `Sin conexión y sin copia guardada de ${url.pathname} (${String(causa)}).`,
          { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }
      // Un 404 o una respuesta opaca guardada se vuelve un archivo roto
      // permanente: mejor devolverla y no guardarla.
      if (sirveParaGuardar(respuesta)) {
        const cache = await caches.open(CACHE_ESTATICOS);
        await cache.put(peticion, respuesta.clone());
        evento.waitUntil(recortar(CACHE_ESTATICOS, MAX_ESTATICOS));
      }
      return respuesta;
    })(),
  );
});
