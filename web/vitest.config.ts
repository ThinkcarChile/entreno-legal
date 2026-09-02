import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // Runtime JSX AUTOMÁTICO, igual que Next. Sin esto, un test que renderiza un
  // componente revienta con «React is not defined»: el transform clásico emite
  // `React.createElement` y ningún archivo del repo importa React por nombre.
  // Lo necesita `money-format.test.ts`, la prueba de pantalla del dinero: la
  // única forma de demostrar que un error NO se muestra como $0 es renderizando
  // el componente de verdad, no un espejo escrito a mano.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * EL PROVEEDOR DE IA ES FALSO EN CI, SIEMPRE.
     *
     * No es una precaución de costo: es que una suite que puede salir a la red
     * deja de ser determinista y, peor, deja de probar lo que dice probar — un
     * test de inyección que "pasa" porque el modelo de verdad se portó bien esta
     * vez no prueba ninguna defensa. `modoProveedor()` ya devuelve `fake` por
     * omisión; esto lo deja escrito para que se vea, y la guarda de
     * `src/lib/ai/guardas-ia.test.ts` falla si alguien lo saca o lo cambia.
     */
    env: { ASSISTANT_PROVIDER: "fake" },
    // 13+ archivos de integración levantan cada uno un PostgreSQL WASM (PGlite):
    // sin tope, la memoria revienta esporádicamente en máquinas modestas.
    poolOptions: { forks: { maxForks: 6 } },
    /**
     * EL `beforeAll` DE UN ARCHIVO DE INTEGRACIÓN NO CABE EN LOS 10 s QUE TRAE
     * VITEST POR OMISIÓN.
     *
     * Levantar la base es replayar la cadena de migraciones —57 desde que se
     * engancharon las de los sprints 13-16— sobre un PostgreSQL WASM. El arnés
     * cachea el volcado y por eso casi todos los archivos arrancan rápido, pero
     * el PRIMERO que corre con el caché frío lo paga entero, y con seis forks en
     * paralelo son varios los que lo pagan a la vez.
     *
     * Los archivos que declaran su propio timeout (60_000, 120_000) ya estaban a
     * salvo; los que no lo declaran heredaban 10 s y caían con "Hook timed out"
     * —un rojo que no dice nada sobre el código y manda a buscar un defecto que
     * no existe—. Se sube acá, en un solo lugar, en vez de repetir el número en
     * treinta archivos.
     *
     * No afloja ninguna comprobación: es cuánto se espera a que la base ARRANQUE,
     * no cuánto puede tardar una prueba en decidir si pasa.
     */
    hookTimeout: 120_000,
  },
});
