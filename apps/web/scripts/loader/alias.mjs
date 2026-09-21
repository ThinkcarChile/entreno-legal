/**
 * Resuelve el alias `@/` de `tsconfig.json` cuando un script de `scripts/` se
 * ejecuta con Node directamente (type stripping nativo, sin empaquetador).
 *
 * Existe para que las pruebas de pagos contra Supabase real usen EXACTAMENTE
 * las mismas piezas que la aplicación (`DelayedMockPaymentProvider`,
 * `applyProviderResult`) en vez de una copia que pueda divergir. Esos módulos
 * importan `@/lib/domain/enums`, y Node no sabe qué es `@/`.
 *
 *   node --import ./scripts/loader/alias.mjs scripts/verify-payments.ts
 *
 * Reglas, mínimas a propósito:
 *   · `@/x` se busca en `src/x`, `src/x.ts`, `src/x.tsx`, `src/x/index.ts`;
 *   · un import relativo sin extensión dentro de `src/` recibe `.ts`/`.tsx`.
 * Nada más: no es un empaquetador, es un traductor de rutas.
 */
import { existsSync, statSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const SRC = new URL("../../src/", import.meta.url);

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

function withExtension(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const found = withExtension(new URL(specifier.slice(2), SRC).href);
    if (found) return next(found, context);
  }

  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith(SRC.href) &&
    !/\.[a-z]+$/i.test(specifier)
  ) {
    const found = withExtension(new URL(specifier, context.parentURL).href);
    if (found) return next(found, context);
  }

  return next(specifier, context);
}

// Los ganchos corren en un hilo aparte: registrar solo desde el principal.
if (isMainThread && existsSync(fileURLToPath(SRC))) {
  register(pathToFileURL(fileURLToPath(import.meta.url)).href);
}
