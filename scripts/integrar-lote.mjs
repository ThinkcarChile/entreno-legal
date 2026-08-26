#!/usr/bin/env node
/**
 * Integra un lote ya escrito y corregido a la biblioteca.
 *
 *   node scripts/integrar-lote.mjs C
 *
 * Espera encontrar `.plan/lote-c-alimentos.json` y `.plan/lote-c-recetas.json`.
 * Hace las tres cosas mecánicas —cargar alimentos, generar el TypeScript,
 * enganchar el lote a `BIBLIOTECA`— y después te dice qué correr.
 *
 * Lo que NO hace, a propósito: aplicar las correcciones de los verificadores.
 * Esas son decisiones, no mecánica, y quedan escritas en su propio script por
 * lote para que se pueda ver qué se cambió y por qué.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const letra = (process.argv[2] ?? "").toUpperCase();
if (!/^[B-Z]$/.test(letra)) {
  console.error("uso: node scripts/integrar-lote.mjs <B..Z>");
  process.exit(1);
}
const min = letra.toLowerCase();

const alimentos = `.plan/lote-${min}-alimentos.json`;
const recetas = `.plan/lote-${min}-recetas.json`;
for (const f of [alimentos, recetas]) {
  if (!existsSync(f)) { console.error(`falta ${f}`); process.exit(1); }
}

const corre = (script, arg) => {
  const salida = execFileSync("node", arg ? [script, ...arg] : [script], { encoding: "utf8" });
  process.stdout.write(salida);
};

console.log(`\n── 1/3 · alimentos nuevos ──`);
corre("scripts/alimentos-desde-json.mjs", [alimentos]);

console.log(`\n── 2/3 · recetas → TypeScript ──`);
corre("scripts/lote-desde-json.mjs", [letra, recetas]);

console.log(`\n── 3/3 · enganchar a BIBLIOTECA ──`);
const RUTA = "web/src/domain/recipes/library/index.ts";
let idx = readFileSync(RUTA, "utf8");
if (idx.includes(`LOTE_${letra} }`)) {
  console.log(`   LOTE_${letra} ya estaba enganchado`);
} else {
  const previa = String.fromCharCode(letra.charCodeAt(0) - 1);
  idx = idx.replace(
    `export { LOTE_${previa} } from "./lote-${previa.toLowerCase()}";`,
    `export { LOTE_${previa} } from "./lote-${previa.toLowerCase()}";\nexport { LOTE_${letra} } from "./lote-${min}";`,
  );
  idx = idx.replace(
    `import { LOTE_${previa} } from "./lote-${previa.toLowerCase()}";`,
    `import { LOTE_${previa} } from "./lote-${previa.toLowerCase()}";\nimport { LOTE_${letra} } from "./lote-${min}";`,
  );
  idx = idx.replace(
    `...LOTE_${previa}];`,
    `...LOTE_${previa}, ...LOTE_${letra}];`,
  );
  writeFileSync(RUTA, idx, "utf8");
  console.log(`   LOTE_${letra} enganchado a BIBLIOTECA`);
}

console.log(`
── ahora, en este orden ──

  cd web
  npm run typecheck
  REGENERAR_SEED=1 npx vitest run src/domain/recipes/library/     # guardianes + seed
  npx vitest run src/integration/recetas-lote-a.test.ts           # canarios
  REGENERAR_REGISTRO=1 npx vitest run src/integration/registro-acumulado.test.ts
  npx vitest run && npm run lint

El registro acumulado va a cambiar: revísalo antes de darlo por bueno. Ahí
aparecen los huecos nuevos que trajo el lote.
`);
