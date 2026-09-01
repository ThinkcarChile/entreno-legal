import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN: la pantalla de sin conexión se puede LEER.
 *
 * public/sin-conexion.html es el único archivo de la app con estilos escritos a
 * mano: no pasa por Tailwind, no lo revisa ningún linter de accesibilidad y —
 * peor— casi nadie lo abre, porque para verlo hay que quedarse sin red. Ahí se
 * coló que la nota final usara `--outline-variant` (#c1c9c0), que es el color de
 * BORDE del kit, como color de TEXTO: 1,70:1 sobre el blanco de la tarjeta,
 * cuando AA pide 4,5:1.
 *
 * Este archivo ya tuvo dos versiones que vigilaban la ortografía del último bug
 * y no la propiedad, y las dos regresiones están cubiertas acá:
 *
 *  - Los FONDOS ya no van escritos a mano: se leen del `background:` que
 *    declara el CSS real. La versión anterior tenía los colores de fondo en una
 *    tabla, así que pintar la tarjeta de casi negro dejaba el h1 en 1,00:1 y el
 *    test seguía verde midiendo contra un fondo que ya no existía. Lo único
 *    declarado a mano es la ESTRUCTURA (qué elemento pinta detrás de cuál), y
 *    esa se verifica contra el HTML en su propio caso.
 *
 *  - El parser ya no exige punto y coma final. El anterior sí, y una
 *    declaración sin `;` —CSS perfectamente válido, lo que deja cualquier
 *    edición a mano— desaparecía del barrido EN SILENCIO: la cuenta de casos
 *    bajaba de 9 a 8 y nada se ponía rojo. Ahora el bloque se parte por `;` (la
 *    última declaración se lee igual, con o sin cierre) y además se afirma QUÉ
 *    selectores se midieron, para que la cobertura no pueda caer callada.
 */

const RAIZ_WEB = path.resolve(__dirname, "..", "..");
const FUENTE = readFileSync(path.join(RAIZ_WEB, "public", "sin-conexion.html"), "utf8");

/** AA para texto normal. La pantalla no tiene texto grande que valga 3:1. */
const MINIMO_AA = 4.5;

/**
 * Los comentarios se sacan ANTES de parsear.
 *
 * No es cosmético: sin sacarlos, el comentario que explica la regresión del
 * contraste quedaba pegado al selector `.nota` y el parser leía un selector de
 * diez líneas que no calzaba con nada. Un test que se confunde con un
 * comentario deja de vigilar el CSS.
 */
const estilos = /<style>([\s\S]*?)<\/style>/
  .exec(FUENTE)?.[1]
  ?.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Qué elemento pinta DETRÁS de cada texto.
 *
 * Esto es estructura, no color: acá no hay motor de cascada, así que quién está
 * detrás de quién sí se declara — pero se verifica contra el HTML real en su
 * propio caso, para que no sea un dato inventado. DE QUÉ COLOR es ese fondo no
 * se escribe en ninguna parte de este archivo: se lee del `background:` que el
 * elemento declara en el CSS (fondoDe). Un elemento con fondo propio es su
 * propio contenedor; si su regla deja de declarar `background`, el fondo pasa a
 * ser UNKNOWN y el test se cae en vez de suponer uno.
 */
const PINTA_DETRAS: Record<string, string> = {
  body: "body",
  ".medallon": ".medallon",
  // h1, p y .nota viven dentro de .tarjeta (verificado contra el HTML abajo).
  h1: ".tarjeta",
  p: ".tarjeta",
  ".nota": ".tarjeta",
  ".boton": ".boton",
};

/** h1 no declara color: hereda el de body, pero sobre el fondo de la tarjeta. */
const HEREDAN_DEL_BODY = ["h1"];

type Declaraciones = Record<string, string>;

/**
 * Cada regla del CSS con TODAS sus declaraciones.
 *
 * El bloque se parte por `;` y cada pedazo se lee como `propiedad: valor`, así
 * que la última declaración cuenta igual con o sin `;` de cierre. La versión
 * anterior usaba un regex que exigía el `;` final y una declaración sin él se
 * volvía invisible sin poner nada en rojo.
 */
function reglasDelCss(css: string): Record<string, Declaraciones> {
  const mapa: Record<string, Declaraciones> = {};
  for (const [, selector, cuerpo] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const nombre = (selector as string).trim();
    const decls: Declaraciones = mapa[nombre] ?? {};
    for (const fragmento of (cuerpo as string).split(";")) {
      const declaracion = /^\s*(-{0,2}[a-zA-Z][\w-]*)\s*:\s*(.+?)\s*$/.exec(fragmento);
      if (declaracion) {
        decls[(declaracion[1] as string).toLowerCase()] = declaracion[2] as string;
      }
    }
    mapa[nombre] = decls;
  }
  return mapa;
}

const reglas = reglasDelCss(estilos ?? "");

/** Las variables salen de la regla :root, parseada igual que las demás. */
function variablesDeRaiz(): Record<string, string> {
  const raiz = reglas[":root"];
  expect(raiz, "sin-conexion.html dejó de declarar sus variables en :root").toBeTruthy();
  const mapa: Record<string, string> = {};
  for (const [nombre, valor] of Object.entries(raiz ?? {})) {
    if (nombre.startsWith("--")) mapa[nombre] = valor;
  }
  return mapa;
}

/** Resuelve `var(--x)` una vez; el archivo no encadena variables. */
function resolverColor(valor: string, vars: Record<string, string>): string {
  const referencia = /var\((--[\w-]+)\)/.exec(valor)?.[1];
  const crudo = referencia ? vars[referencia] : valor;
  expect(crudo, `no se pudo resolver el color ${valor}`).toBeTruthy();
  return (crudo as string).trim();
}

function canal(componente: number) {
  const s = componente / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa según WCAG 2.1. */
function luminancia(hex: string) {
  const limpio = hex.replace("#", "");
  expect(limpio, `${hex} no es un color hexadecimal de 6 dígitos`).toMatch(/^[0-9a-fA-F]{6}$/);
  const [r, g, b] = [0, 2, 4].map((i) => canal(parseInt(limpio.slice(i, i + 2), 16)));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

function contraste(frente: string, fondo: string) {
  const [a, b] = [luminancia(frente), luminancia(fondo)].sort((x, y) => y - x);
  return ((a as number) + 0.05) / ((b as number) + 0.05);
}

const vars = variablesDeRaiz();

/**
 * El color de fondo REAL de un contenedor: el `background` (o
 * `background-color`) que declara su regla en el CSS. Si no declara ninguno, el
 * fondo es UNKNOWN y eso se declara en vez de asumir blanco.
 */
function fondoDe(contenedor: string): string {
  const decls = reglas[contenedor];
  expect(decls, `${contenedor} ya no existe en el CSS: no se sabe de qué color pinta`).toBeTruthy();
  const declarado = decls?.["background-color"] ?? decls?.["background"];
  expect(
    declarado,
    `${contenedor} no declara background: su fondo es UNKNOWN y no se puede medir contraste contra él`,
  ).toBeTruthy();
  return resolverColor(declarado as string, vars);
}

/** Todas las reglas que declaran `color:` (texto), fuera de :root. */
const conColor = Object.entries(reglas)
  .filter(([selector, decls]) => selector !== ":root" && "color" in decls)
  .map(([selector, decls]) => ({ selector, color: decls["color"] as string }));

describe("la pantalla de sin conexión se puede leer", () => {
  it("el archivo trae sus estilos en línea (si no, no hay nada que medir)", () => {
    expect(estilos, "sin-conexion.html perdió su bloque <style>").toBeTruthy();
  });

  it("la estructura que asume PINTA_DETRAS es la del HTML real", () => {
    // La mitad escrita a mano de este guardián es solo QUIÉN está detrás de
    // quién; acá se comprueba contra el documento para que tampoco eso quede
    // siendo un dato de fe.
    const dentroDeTarjeta = /<main class="tarjeta">([\s\S]*?)<\/main>/.exec(FUENTE)?.[1];
    expect(dentroDeTarjeta, 'el HTML perdió su <main class="tarjeta">').toBeTruthy();
    for (const [texto, contenedor] of Object.entries(PINTA_DETRAS)) {
      if (contenedor !== ".tarjeta") continue;
      const huella = texto.startsWith(".") ? `class="${texto.slice(1)}"` : `<${texto}`;
      expect(
        dentroDeTarjeta,
        `${texto} ya no vive dentro de la tarjeta: PINTA_DETRAS quedó mintiendo`,
      ).toContain(huella);
    }
  });

  it("se midió exactamente el conjunto de textos conocido (la cobertura no puede caer callada)", () => {
    // Doble filo a propósito: un selector nuevo con `color:` obliga a decir qué
    // pinta detrás de él (UNKNOWN no se asume blanco), y un selector que el
    // parser deje de ver — como pasó con `.nota` sin `;` final — hace caer la
    // cuenta y esto se pone rojo en vez de pasar con un caso menos.
    const medidos = conColor.map((r) => r.selector).sort();
    const esperados = Object.keys(PINTA_DETRAS)
      .filter((selector) => !HEREDAN_DEL_BODY.includes(selector))
      .sort();
    expect(medidos).toEqual(esperados);
  });

  it.each(conColor.map((r) => [r.selector, r.color] as const))(
    "%s cumple AA sobre el fondo que el CSS le pinta detrás",
    (selector, color) => {
      const contenedor = PINTA_DETRAS[selector];
      expect(
        contenedor,
        `${selector} no está en PINTA_DETRAS: no se sabe qué pinta detrás de él`,
      ).toBeTruthy();
      const frente = resolverColor(color, vars);
      const fondo = fondoDe(contenedor as string);
      const ratio = contraste(frente, fondo);
      expect(
        ratio,
        `${selector}: ${frente} sobre ${fondo} da ${ratio.toFixed(2)}:1 y AA pide ${MINIMO_AA}:1`,
      ).toBeGreaterThanOrEqual(MINIMO_AA);
    },
  );

  it.each(HEREDAN_DEL_BODY)("%s hereda un color legible sobre su propio fondo", (selector) => {
    const delBody = reglas["body"]?.["color"];
    expect(delBody, "body dejó de declarar color y h1 hereda de ahí").toBeTruthy();
    const frente = resolverColor(delBody as string, vars);
    const fondo = fondoDe(PINTA_DETRAS[selector] as string);
    const ratio = contraste(frente, fondo);
    expect(ratio, `${selector}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(MINIMO_AA);
  });

  it("el token de borde no se usa como color de texto", () => {
    // La regresión concreta que puso este archivo acá. Se comprueba aparte del
    // cálculo porque el mensaje importa: no es "el número quedó bajo", es "ese
    // token es de BORDE, el de texto secundario es --on-surface-variant".
    const conBorde = conColor.filter((r) => r.color.includes("--outline-variant"));
    expect(
      conBorde.map((r) => r.selector),
      "--outline-variant es color de borde; para texto va --on-surface-variant",
    ).toEqual([]);
  });
});
