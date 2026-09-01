"use client";

import { useEffect } from "react";

/**
 * Registra /sw.js. Va montado en el layout raíz, no pinta nada.
 *
 * SOLO en producción, y en desarrollo hace lo contrario: da de baja cualquier
 * service worker que haya quedado instalado. En `next dev` los archivos de
 * /_next/static NO llevan hash del contenido, así que la estrategia
 * "caché primero" del worker te devolvería el bundle de hace media hora y
 * andarías depurando código que ya no existe. Un worker de producción
 * instalado una vez sigue vivo en localhost hasta que alguien lo saca.
 */
export function RegistroServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((registros) => {
        for (const registro of registros) void registro.unregister();
      });
      return;
    }

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registro) => {
        // register() resuelve apenas el navegador ACEPTA el archivo, mucho
        // antes de que termine el evento `install`. Así que si el install falla
        // —por ejemplo porque /sin-conexion.html contestó 500 cuando Supabase
        // estaba caído— este .then() igual se cumple y el .catch() de abajo no
        // se entera nunca: la app queda creyendo que está instalada y nadie ve
        // nada. UNKNOWN != NORMAL, así que hay que ir a buscarlo.
        //
        // La única señal que da el navegador es que ese worker pase a
        // "redundant" SIN haber pasado antes por "installed". Eso se escucha
        // acá.
        const instalando = registro.installing;
        if (!instalando) return; // ya venía instalado de una visita anterior

        let llegoAInstalarse = false;
        instalando.addEventListener("statechange", () => {
          if (instalando.state === "installed") llegoAInstalarse = true;
          if (instalando.state === "redundant" && !llegoAInstalarse) {
            console.error(
              "El service worker se registró pero NO se instaló: falló su evento install. La app anda con red, pero se quedó sin pantalla de sin conexión. El motivo sale en DevTools > Application > Service Workers.",
            );
          }
        });
      })
      .catch((causa) => {
        // ERROR != VACÍO: si el registro falla, la app sigue andando online,
        // pero queremos saber por qué no quedó instalable en vez de suponerlo.
        console.error("No se pudo registrar el service worker:", causa);
      });
  }, []);

  return null;
}
