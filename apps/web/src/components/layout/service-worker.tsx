"use client";

import { useEffect } from "react";

/**
 * Registro del service worker.
 *
 * Se registra después de cargar la página para no competir con lo que el
 * usuario está esperando ver, y solo en producción: en desarrollo, una caché
 * intermedia convierte cada cambio en un misterio.
 *
 * No hace nada más. Todo lo que el service worker guarda —y lo que no— está en
 * `public/sw.js`, con su motivo.
 */
// El nombre evita `ServiceWorkerRegistration`, que es un tipo del propio DOM:
// con el mismo nombre, TypeScript resuelve el global y no el componente.
export function ServiceWorkerSetup() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Sin service worker la aplicación funciona igual: solo pierde la
        // pantalla de cortesía sin conexión. No se molesta al usuario con esto.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
