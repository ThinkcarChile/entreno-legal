/*
  Service worker de HagoTuFila.
 
  Hace UNA cosa: que la aplicación instalada no muestre el dinosaurio cuando se
  cae la red. Nada más, y el «nada más» es deliberado.
 
  Lo que SÍ guarda: el esqueleto estático —los archivos de `/_next/static`, los
  iconos y la página «sin conexión»—. Son archivos con huella en el nombre,
  iguales para todo el mundo y sin un solo dato de nadie.
 
  Lo que NO guarda, y por qué:
    · el HTML de cualquier página. Casi todas dependen de quién esté conectado,
      y una caché compartida es exactamente el mecanismo por el que a alguien le
      aparecen los trabajos de otra persona;
    · nada que vaya a Supabase: mensajes, ubicaciones, pagos, evidencia;
    · nada con `Authorization` o cookies de sesión.
 
  La navegación va siempre a la red. Si la red no está, se muestra la página de
  cortesía, que no lleva datos. Cuando vuelve, se vuelve solo: no hay nada
  obsoleto que reconciliar porque no se guardó nada.
*/

const VERSION = "htf-v1";
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = "/sin-conexion";

const PRECACHE = [OFFLINE_URL, "/icons/icon-192.svg", "/icons/icon-512.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/** ¿Es un archivo estático, igual para todo el mundo y sin datos de nadie? */
function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/manifest.webmanifest")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Solo GET. Un POST cacheado sería un envío repetido, que es justo lo que no
  // se quiere en una acción que mueve un trabajo o un pago.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Todo lo que no sea de este origen —Supabase, fuentes, cualquier API— pasa
  // de largo: el service worker no lo toca ni lo guarda.
  if (url.origin !== self.location.origin) return;

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((hit) => hit ?? Response.error()),
      ),
    );
  }
});
