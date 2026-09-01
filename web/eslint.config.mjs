import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Globales del service worker.
 *
 * Se escriben a mano en vez de traer el paquete `globals`: son seis nombres y
 * agregar una dependencia para eso es peor negocio que la lista. Van declarados
 * porque public/sw.js no lo compila TypeScript ni lo cubre ningún test de
 * pantalla — es EL archivo donde un `typo` no se nota — y sin esto `npm run
 * lint` lo dejaba fuera de todo análisis estático o lo llenaba de `no-undef`.
 */
const GLOBALES_SERVICE_WORKER = {
  self: "readonly",
  caches: "readonly",
  fetch: "readonly",
  console: "readonly",
  Request: "readonly",
  Response: "readonly",
  URL: "readonly",
  Promise: "readonly",
};

/** Globales de los scripts de build/mantención, que corren en Node. */
const GLOBALES_NODE = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  fetch: "readonly",
  __dirname: "readonly",
};

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: GLOBALES_SERVICE_WORKER,
      sourceType: "script",
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      globals: GLOBALES_NODE,
      sourceType: "module",
    },
  },
);
