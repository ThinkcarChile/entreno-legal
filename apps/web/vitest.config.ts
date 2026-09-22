import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Pruebas unitarias del dominio financiero.
 *
 * Deliberadamente pequeñas y deliberadamente limitadas a una cosa: la lógica
 * pura que decide sobre dinero. No hay pruebas de componentes, ni de páginas,
 * ni instantáneas —eso sería otra suite, con otro coste de mantenimiento, y no
 * es lo que hace falta ahora—.
 *
 * Lo que sí hace falta probar así es lo que no se puede ejercitar de otra
 * forma: la clasificación de los cuatro retornos de Webpay, el criterio de
 * aprobación, el saneado de credenciales y las guardas de producción. Son
 * funciones sin red ni base, con decenas de combinaciones cada una, y un
 * recorrido de navegador solo pasa por una.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
