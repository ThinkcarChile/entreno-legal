import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN: la app instalada y la app abierta tienen que ser la misma.
 *
 * El manifiesto decía una marca y el documento decía otra: en el cajón de
 * Android aparecía un nombre y al tocarlo se abría otro. Nadie lo ve revisando
 * código, porque los dos archivos por separado están bien.
 *
 * La primera versión de este guardián miraba SOLO el manifiesto, layout.tsx y
 * AppShell.tsx, y por eso pasó en verde mientras el h1 de /login —la primera
 * pantalla que ve cualquiera— seguía con la marca muerta. Por eso ahora la
 * regla no es "los tres archivos que me acordé de listar coinciden" sino "la
 * marca muerta no existe en ninguna parte del árbol".
 *
 * También vigila los iconos: Chrome no ofrece instalar sin PNG de 192 y 512,
 * y un `src` del manifiesto que apunta a un archivo que no existe no da error
 * en ninguna parte, simplemente no se instala. ERROR != VACÍO: si falta un
 * archivo, que falle acá y no en el celular de alguien.
 */

const RAIZ_WEB = path.resolve(__dirname, "..", "..");
const PUBLICO = path.join(RAIZ_WEB, "public");
const FUENTES = path.join(RAIZ_WEB, "src");

interface IconoManifiesto {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface Manifiesto {
  name: string;
  short_name: string;
  theme_color: string;
  icons: IconoManifiesto[];
}

const manifiesto = JSON.parse(
  readFileSync(path.join(PUBLICO, "manifest.webmanifest"), "utf8"),
) as Manifiesto;
const layout = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");
const armazonEnPantalla = readFileSync(
  path.join(RAIZ_WEB, "src", "components", "AppShell.tsx"),
  "utf8",
);

/** La marca manda desde donde el usuario la lee: el encabezado del armazón. */
const MARCA = "NutriFamilia";

/**
 * La marca anterior. Queda prohibida en todo el árbol: mientras existiera en un
 * solo archivo, la app tenía dos nombres y el usuario veía el que le tocara.
 */
const MARCA_MUERTA = "Mesa Familiar";

/** Extensiones donde puede esconderse un texto que el usuario termina leyendo. */
const EXTENSIONES_CON_TEXTO = new Set([".ts", ".tsx", ".html", ".webmanifest", ".md", ".json"]);

/**
 * Este archivo se excluye del barrido porque es el ÚNICO que tiene que escribir
 * la marca muerta: es el que la busca. Cualquier otro archivo que la nombre es
 * el bug que este guardián existe para cazar.
 */
const ARCHIVO_GUARDIAN = path.join(__dirname, "pwa-coherencia.test.ts");

function archivosConTexto(raiz: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(raiz, { withFileTypes: true })) {
    const completo = path.join(raiz, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name !== "node_modules") encontrados.push(...archivosConTexto(completo));
      continue;
    }
    if (EXTENSIONES_CON_TEXTO.has(path.extname(entrada.name))) encontrados.push(completo);
  }
  return encontrados;
}

/**
 * El texto se aplana antes de buscar.
 *
 * No es paranoia: la marca muerta ya estuvo partida en dos líneas por el
 * formateador (un comentario que la citaba quedó como «"Mesa\n Familiar"») y
 * una búsqueda literal la habría dejado pasar. Un guardián que se rinde ante un
 * salto de línea no es un guardián.
 */
function aplanar(texto: string) {
  return texto.replace(/\s+/g, " ");
}

/** Cada `clave: "valor"` del archivo, para poder exigirlos TODOS a la vez. */
function valoresDe(fuente: string, clave: string): string[] {
  return [...fuente.matchAll(new RegExp(`\\b${clave}:\\s*"([^"]*)"`, "g"))].map(
    (m) => m[1] as string,
  );
}

describe("la marca es una sola", () => {
  it("la marca muerta no vive en ninguna parte del árbol", () => {
    const revisables = [
      ...archivosConTexto(FUENTES),
      ...archivosConTexto(PUBLICO),
      path.join(RAIZ_WEB, "README.md"),
    ].filter((archivo) => archivo !== ARCHIVO_GUARDIAN);

    const culpables = revisables.filter((archivo) =>
      aplanar(readFileSync(archivo, "utf8")).includes(MARCA_MUERTA),
    );

    expect(
      culpables.map((archivo) => path.relative(RAIZ_WEB, archivo)),
      `estos archivos todavía dicen "${MARCA_MUERTA}"`,
    ).toEqual([]);
  });

  it("el armazón que se ve en pantalla usa la marca", () => {
    expect(armazonEnPantalla).toContain(MARCA);
  });

  it("el manifiesto dice la marca", () => {
    expect(manifiesto.name).toBe(MARCA);
    expect(manifiesto.short_name).toBe(MARCA);
  });

  it("TODOS los nombres que declara el documento son la marca", () => {
    // Antes esto era un `toContain('title: "NutriFamilia"')` y se satisfacía
    // solo con appleWebApp.title: metadata.title podía volver a la marca vieja
    // sin que el guardián se moviera. Ahora se exigen todos los valores, así
    // que basta que UNO se desvíe para que caiga, sin depender del orden.
    const nombres = [...valoresDe(layout, "title"), ...valoresDe(layout, "applicationName")];
    expect(nombres.length, "layout.tsx dejó de declarar nombres").toBeGreaterThanOrEqual(3);
    expect(nombres).toEqual(nombres.map(() => MARCA));
  });

  it("el color de tema del manifiesto es el mismo del documento", () => {
    expect(layout).toContain(`themeColor: "${manifiesto.theme_color}"`);
  });
});

describe("iconos instalables", () => {
  it("cada icono declarado existe en public/", () => {
    const faltantes = manifiesto.icons
      .map((icono) => icono.src)
      .filter((src) => !existsSync(path.join(PUBLICO, src.replace(/^\//, ""))));
    expect(faltantes).toEqual([]);
  });

  it("hay PNG de 192 y 512, y además en versión maskable", () => {
    const png = manifiesto.icons.filter((icono) => icono.type === "image/png");
    for (const lado of ["192x192", "512x512"]) {
      expect(png.some((i) => i.sizes === lado && i.purpose === "any")).toBe(true);
      expect(png.some((i) => i.sizes === lado && i.purpose === "maskable")).toBe(true);
    }
  });

  it("iOS tiene su apple-touch-icon en disco y enlazado", () => {
    expect(existsSync(path.join(PUBLICO, "apple-touch-icon.png"))).toBe(true);
    expect(layout).toContain("/apple-touch-icon.png");
  });
});

/**
 * Esto no es una optimización: es el modo de falla que lo puso acá.
 *
 * Al instalarse, el worker baja /sin-conexion.html y los iconos, y el navegador
 * baja /sw.js. Si esos pedidos pasan por el middleware de sesión y Supabase está
 * caído, el middleware puede contestar 500 y la instalación del worker se cae
 * entera — en silencio, porque register() ya resolvió. Fuera del matcher, esos
 * archivos salen del disco pase lo que pase con la base.
 *
 * Se EVALÚA el matcher (son expresiones regulares), no se hace grep: un grep se
 * conforma con la ruta escrita dentro de un comentario. Y se evalúa el array
 * ENTERO: Next corre el middleware si CUALQUIER entrada calza, así que leer
 * solo la primera —como hacía la versión anterior de este guardián— dejaba
 * pasar en verde un matcher al que le agregaran "/sw.js" como segunda entrada,
 * que es exactamente el modo de falla que este bloque existe para impedir.
 */
describe("los archivos de la PWA no pasan por el middleware de sesión", () => {
  const middleware = readFileSync(path.join(RAIZ_WEB, "src", "middleware.ts"), "utf8");
  const arreglo = /matcher:\s*\[([\s\S]*?)\]/.exec(middleware)?.[1];
  const patrones = [...(arreglo ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => m[1] as string,
  );

  it("el matcher se puede leer del archivo, entero", () => {
    // Si alguien cambia la forma de declararlo, el guardián deja de vigilar en
    // silencio. Mejor que se caiga y alguien lo mire.
    expect(arreglo, "no se encontró el matcher en middleware.ts").toBeTruthy();
    expect(patrones.length, "el matcher quedó sin ninguna regla").toBeGreaterThan(0);
  });

  const rutasDeArchivo = [
    "/sw.js",
    "/sin-conexion.html",
    "/manifest.webmanifest",
    "/icon.svg",
    "/apple-touch-icon.png",
    "/icons/icon-192.png",
    "/icons/icon-maskable-512.png",
  ];

  it.each(rutasDeArchivo)("%s queda fuera de TODAS las reglas del matcher", (ruta) => {
    const culpables = patrones.filter((patron) => new RegExp(`^${patron}$`).test(ruta));
    expect(
      culpables,
      `estas reglas del matcher SÍ agarran ${ruta} y le cuelgan el auth del middleware`,
    ).toEqual([]);
  });

  it("las pantallas de verdad SÍ siguen pasando por el middleware", () => {
    // El contrapeso: un matcher que excluya de más deja la app sin refresco de
    // sesión y nadie se entera hasta que la gente empieza a caerse a /login.
    for (const pantalla of ["/", "/plan", "/pantry", "/login"]) {
      expect(
        patrones.some((patron) => new RegExp(`^${patron}$`).test(pantalla)),
        `${pantalla} dejó de pasar por el middleware`,
      ).toBe(true);
    }
  });
});

describe("la PWA tiene sus dos archivos en disco", () => {
  // QUÉ guarda y qué NO guarda el worker se prueba ejecutándolo, en
  // sw-no-cachea-datos.test.ts. Acá solo se comprueba que existan: un grep
  // sobre el texto del worker se satisface con una cadena escrita dentro de un
  // comentario, así que no sirve como guardián de comportamiento.
  it("existen sw.js y la pantalla de sin conexión", () => {
    expect(existsSync(path.join(PUBLICO, "sw.js"))).toBe(true);
    expect(existsSync(path.join(PUBLICO, "sin-conexion.html"))).toBe(true);
  });

  it("el registro del worker apunta al archivo que existe", () => {
    const registro = readFileSync(
      path.join(RAIZ_WEB, "src", "components", "RegistroServiceWorker.tsx"),
      "utf8",
    );
    expect(registro).toContain('register("/sw.js"');
  });
});
