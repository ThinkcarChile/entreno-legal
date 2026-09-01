import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Empaquetado para ALOJAR EN SERVIDOR PROPIO.
   *
   * `standalone` deja en .next/standalone un servidor Node autocontenido, con
   * solo las dependencias que de verdad se usan. Es lo que permite correr la
   * app en un hosting propio en vez de en una plataforma que sepa de Next.
   *
   * Lo que NO se puede es exportarla estática: la app tiene 19 archivos con
   * server actions y 54 páginas que leen la sesión en el servidor. Sin un Node
   * corriendo no hay login, no hay plan, no hay despensa.
   */
  output: "standalone",
};

export default nextConfig;
