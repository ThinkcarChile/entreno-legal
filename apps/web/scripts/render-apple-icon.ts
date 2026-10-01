/**
 * Render del icono de iOS: `brand/apple-icon.svg` → `src/app/apple-icon.png`,
 * 180 × 180 px.
 *
 *   CHROMIUM_PATH=/ruta/a/chromium npm run brand:apple-icon
 *
 * Por qué un PNG: la convención `apple-icon` de Next solo acepta `.jpg`, `.jpeg`
 * y `.png`. Había un `src/app/apple-icon.svg` que Next ignoraba sin avisar, así
 * que la página no llevaba `<link rel="apple-touch-icon">` y un iPhone que
 * instalaba la aplicación no encontraba un icono que ponerle.
 *
 * Se dibuja con el Chromium de Playwright, como `render-logo.ts`, para que el
 * resultado no dependa de un programa de imágenes instalado en la máquina.
 * iOS no admite transparencia en este icono (la rellena de negro): el SVG trae
 * su propio fondo a sangre y además se pinta sobre el crema de la marca.
 *
 * Antes de escribir comprueba que el SVG sea cuadrado y cubra el lienzo, y
 * después que el PNG mida lo que debe. Sale con código distinto de cero si algo
 * no cuadra.
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { brand } from "@/config/brand";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SIZE = 180;
const SOURCE = resolve(root, "brand/apple-icon.svg");
const OUTPUT = resolve(root, "src/app/apple-icon.png");

/** Ancho, alto y tipo de color de un PNG, leídos de su cabecera IHDR. */
function pngHeader(file: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(file);
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error(`${file} no es un PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

async function main(): Promise<void> {
  const svg = readFileSync(SOURCE, "utf8");
  const viewBox = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!viewBox || viewBox[1] !== viewBox[2]) {
    throw new Error("el SVG del icono de iOS tiene que ser cuadrado y declarar su viewBox");
  }
  if (!new RegExp(`<rect[^>]*width="${viewBox[1]}"[^>]*height="${viewBox[2]}"`).test(svg)) {
    throw new Error("el SVG no trae fondo a sangre: iOS rellenaría la transparencia de negro");
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><style>
        html, body { margin: 0; padding: 0; background: ${brand.canvas}; }
        svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
      </style></head><body>${svg}</body></html>`,
    );
    await page.screenshot({
      path: OUTPUT,
      omitBackground: false,
      clip: { x: 0, y: 0, width: SIZE, height: SIZE },
    });
  } finally {
    await browser.close();
  }

  const { width, height, colorType } = pngHeader(OUTPUT);
  if (width !== SIZE || height !== SIZE) {
    throw new Error(`el PNG salió de ${width}×${height}, no de ${SIZE}×${SIZE}`);
  }
  // 2 es RGB y 0 gris: sin canal alfa. `verify:pwa` comprueba lo mismo.
  if (colorType !== 2 && colorType !== 0) {
    throw new Error(`el PNG salió con transparencia (tipo de color ${colorType})`);
  }
  console.log(`src/app/apple-icon.png: ${width}×${height} px desde brand/apple-icon.svg`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
