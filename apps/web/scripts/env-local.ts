/**
 * Carga `.env.local` (y `.env`) en `process.env`.
 *
 * Lo comparten los scripts de `scripts/` y `playwright.config.ts`. Existe como
 * módulo y no como copia en cada archivo porque las copias ya habían divergido:
 * una recortaba los espacios del valor y otra no, así que un `.env.local`
 * guardado con finales de línea de Windows dejaba un `\r` pegado a la clave y el
 * error resultante no apuntaba a nada reconocible.
 *
 * Reglas, iguales a las de Next:
 *   · lo que ya está en el entorno MANDA sobre el archivo;
 *   · un valor vacío es lo mismo que una variable ausente;
 *   · las comillas envolventes se quitan.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvLocal(root: string): void {
  for (const file of [".env.local", ".env"]) {
    let raw: string;
    try {
      raw = readFileSync(resolve(root, file), "utf8");
    } catch {
      // Puede no existir: las variables pueden venir del entorno.
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, "").trim();
      if (value && !process.env[match[1]]) process.env[match[1]] = value;
    }
  }
}
