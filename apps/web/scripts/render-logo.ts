/**
 * Render del logotipo de HagoTuFila en el tamaño que exige el formulario de
 * validación de Transbank: 130 × 59 px exactos.
 *
 *   npm run brand:logo
 *
 * Toma `brand/logo-130x59.html` —que trae la fuente Inter del sitio incrustada
 * en `brand/inter-latin.woff2`, para que el resultado no dependa de la red ni
 * de las fuentes de la máquina— y captura dos PNG: uno con fondo blanco, que
 * es el que se entrega, y otro transparente por si hiciera falta.
 *
 * Antes de capturar mide el conjunto y falla si se sale del lienzo o si la
 * tipografía que se acabó usando no es Inter. Un logotipo recortado o con la
 * fuente de reserva se ve casi bien en una miniatura y mal en el formulario de
 * pago, así que conviene que el recorte rompa el script en vez de pasar
 * inadvertido.
 *
 * Sale con código distinto de cero si alguna comprobación falla.
 */
import { chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const CANVAS = { width: 130, height: 59 } as const;
const SOURCE = resolve(root, "brand/logo-130x59.html");

interface Salidas {
  archivo: string;
  transparente: boolean;
}

const SALIDAS: Salidas[] = [
  { archivo: "brand/logo-transbank-130x59.png", transparente: false },
  { archivo: "brand/logo-transbank-130x59-transparente.png", transparente: true },
];

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    for (const salida of SALIDAS) {
      const page = await browser.newPage({ viewport: { ...CANVAS }, deviceScaleFactor: 1 });
      await page.goto(`file://${SOURCE}`);
      await page.evaluate(() => document.fonts.ready);

      const medida = await page.evaluate(() => {
        const lockup = document.getElementById("lockup");
        const word = document.querySelector(".word");
        if (!lockup || !word) throw new Error("no se encontró el conjunto del logotipo");
        const caja = lockup.getBoundingClientRect();
        return {
          ancho: caja.width,
          alto: caja.height,
          izquierda: caja.left,
          arriba: caja.top,
          fuente: getComputedStyle(word).fontFamily,
          inter: document.fonts.check("700 15px Inter"),
        };
      });

      if (!medida.inter || !medida.fuente.startsWith("Inter")) {
        throw new Error(`la tipografía usada no es Inter: ${medida.fuente} (cargada: ${medida.inter})`);
      }
      if (medida.izquierda < 0 || medida.arriba < 0) {
        throw new Error(`el conjunto se sale por arriba o por la izquierda: ${medida.izquierda}, ${medida.arriba}`);
      }
      if (medida.izquierda + medida.ancho > CANVAS.width || medida.arriba + medida.alto > CANVAS.height) {
        throw new Error(
          `el conjunto no cabe en ${CANVAS.width}×${CANVAS.height}: ` +
            `${medida.ancho.toFixed(1)}×${medida.alto.toFixed(1)} en (${medida.izquierda.toFixed(1)}, ${medida.arriba.toFixed(1)})`,
        );
      }

      if (salida.transparente) {
        await page.addStyleTag({ content: "body { background: transparent !important; }" });
      }
      await page.screenshot({ path: resolve(root, salida.archivo), omitBackground: salida.transparente });
      await page.close();

      const margenDerecho = CANVAS.width - (medida.izquierda + medida.ancho);
      const margenInferior = CANVAS.height - (medida.arriba + medida.alto);
      console.log(
        `${salida.archivo}: conjunto ${medida.ancho.toFixed(1)}×${medida.alto.toFixed(1)} px, ` +
          `margen ${medida.izquierda.toFixed(1)}/${margenDerecho.toFixed(1)} horizontal y ` +
          `${medida.arriba.toFixed(1)}/${margenInferior.toFixed(1)} vertical`,
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
