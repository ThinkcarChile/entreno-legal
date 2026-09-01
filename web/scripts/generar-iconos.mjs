/**
 * Genera los PNG del manifiesto a partir de public/icon.svg.
 *
 * POR QUÉ existe: Chrome en Android no instala la app con un icono SVG suelto,
 * pide PNG de 192 y 512, y además uno "maskable" (el sistema le recorta un
 * círculo/squircle encima). iOS ignora el manifiesto entero y usa
 * apple-touch-icon.png, que además no admite transparencia: los pixeles
 * transparentes salen NEGROS en la pantalla de inicio.
 *
 * El dibujo NO se inventa acá: se lee icon.svg y se re-escala. Si hay que
 * cambiar la marca, se cambia el SVG y se vuelve a correr esto:
 *
 *   cd web && node scripts/generar-iconos.mjs
 *
 * Los PNG resultantes se versionan en el repo, así el build no depende de
 * sharp (que hoy llega como dependencia transitiva de Next, no propia).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLICO = path.join(RAIZ, "public");
const DESTINO = path.join(PUBLICO, "icons");

/** Fondo opaco de la marca. Es el mismo `fill` del <rect> de icon.svg. */
const VERDE_MARCA = "#3a684d";

/**
 * Cuánto del lienzo ocupa el dibujo en la versión "maskable".
 *
 * La zona segura es el círculo central del 80% del lado: todo lo que quede
 * afuera puede ser recortado por el sistema. A 0.72 el plato entra completo
 * con holgura incluso en el recorte más agresivo (círculo).
 */
const PROPORCION_SEGURA = 0.72;

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch (causa) {
  // ERROR != VACÍO: si no se puede rasterizar, el script cae con ruido en vez
  // de dejar iconos viejos o a medias en public/.
  throw new Error(
    "No se pudo cargar sharp, que es quien rasteriza el SVG. Instálalo (npm i -D sharp) y repite.",
    { cause: causa },
  );
}

const svgOriginal = readFileSync(path.join(PUBLICO, "icon.svg"), "utf8");

/**
 * Envuelve el SVG original centrado y encogido sobre un fondo a sangre.
 *
 * El <rect> redondeado del original queda del mismo color que el fondo, así
 * que se funde con él: lo que se ve es el plato flotando dentro de la zona
 * segura, que es exactamente lo que pide el recorte de Android.
 */
function svgConMargen(lado, proporcion) {
  const dibujo = Math.round(lado * proporcion);
  const desplazamiento = Math.round((lado - dibujo) / 2);
  const interior = svgOriginal
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}">
  <rect width="${lado}" height="${lado}" fill="${VERDE_MARCA}"/>
  <g transform="translate(${desplazamiento} ${desplazamiento}) scale(${dibujo / 64})">${interior}</g>
</svg>`;
}

async function escribirPng(svg, lado, destino) {
  const png = await sharp(Buffer.from(svg)).resize(lado, lado).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(destino, png);
  console.log(`${path.relative(RAIZ, destino)} — ${lado}×${lado}, ${png.length} bytes`);
}

mkdirSync(DESTINO, { recursive: true });

for (const lado of [192, 512]) {
  // purpose "any": el dibujo tal cual, con sus esquinas redondeadas propias.
  await escribirPng(svgOriginal, lado, path.join(DESTINO, `icon-${lado}.png`));
  // purpose "maskable": fondo a sangre y el plato dentro de la zona segura.
  await escribirPng(
    svgConMargen(lado, PROPORCION_SEGURA),
    lado,
    path.join(DESTINO, `icon-maskable-${lado}.png`),
  );
}

// iOS: 180×180 y SIN transparencia. Le dejamos un poco menos de margen que a
// Android porque iOS solo redondea las esquinas, no recorta un círculo.
await escribirPng(svgConMargen(180, 0.86), 180, path.join(PUBLICO, "apple-touch-icon.png"));
