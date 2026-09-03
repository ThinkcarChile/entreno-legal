import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * GUARDIÁN DEL EMPAQUETADO PWA (§7-§8).
 *
 * `scripts/empaquetar-pwa.mjs` arma el bundle para el servidor propio, estampa
 * la versión del service worker y se niega a escribir el zip si falta algo.
 * Ese script corre en Node, sin TypeScript, y lo que busca en public/ (el
 * marcador `const VERSION = "v1";`, los campos del manifiesto, los iconos) vive
 * en archivos sueltos que ningún compilador mira. Acá se comprueban las dos
 * puntas a la vez, con las funciones DEL SCRIPT y no con una copia:
 *
 *  - que el fuente tenga exactamente lo que el script va a buscar: si alguien
 *    reescribe el marcador, el empaquetado dejaría de invalidar los cachés del
 *    despliegue anterior y nadie se enteraría hasta el celular de alguien;
 *  - que el validador del script de verdad FALLE cuando falta cada pieza. Un
 *    validador que deja pasar un bundle cojo es peor que ninguno: da confianza;
 *  - que el worker no guarde nada de otro origen ni nada bajo una ruta privada,
 *    EJECUTÁNDOLO contra un navegador de mentira. Un grep sobre el texto del
 *    worker se satisface con una cadena escrita dentro de un comentario.
 *
 * Cada caso está comprobado por mutación: rompiendo lo que protege, se pone
 * rojo. sw-no-cachea-datos.test.ts cubre el resto del comportamiento del
 * worker (armazón, revalidación, 503 declarado); acá van las guardas nuevas y
 * lo que el empaquetador necesita del fuente.
 */

const RAIZ_WEB = path.resolve(__dirname, "..", "..");
const RAIZ_REPO = path.resolve(RAIZ_WEB, "..");
const PUBLICO = path.join(RAIZ_WEB, "public");
const SCRIPT = path.join(RAIZ_REPO, "scripts", "empaquetar-pwa.mjs");
const ORIGEN = "https://nutrifamilia.test";
const ESTAMPA_DE_PRUEBA = "0.1.0-abc1234";

/** Lo que el test usa del script. El script exporta más; esto es lo que se ejerce. */
interface Empaquetador {
  MARCADOR_VERSION: string;
  vecesQueApareceElMarcador(fuenteSw: string): number;
  estampar(fuenteSw: string, estampa: string): string;
  leerVersion(fuenteSw: string): string | null;
  estampaDeVersion(entrada: { version: string; sha: string; sucio: boolean; ahora?: Date }): string;
  validarManifiesto(dirPublico: string): string[];
  validarBundle(dirBundle: string): string[];
}

interface IconoManifiesto {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifiesto {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: IconoManifiesto[];
}

const RUTA_MANIFIESTO = path.join(PUBLICO, "manifest.webmanifest");
const RUTA_SW = path.join(PUBLICO, "sw.js");
const manifiesto = JSON.parse(readFileSync(RUTA_MANIFIESTO, "utf8")) as Manifiesto;
const FUENTE_SW = readFileSync(RUTA_SW, "utf8");

let empaquetador: Empaquetador;

beforeAll(async () => {
  // Se importa el script de verdad (tsconfig tiene allowJs en false, así que
  // va por URL y se tipa a mano). Si el script deja de exportar algo, el test
  // revienta acá y no en un `undefined is not a function` a mitad de camino.
  empaquetador = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as Empaquetador;
  for (const nombre of [
    "MARCADOR_VERSION",
    "vecesQueApareceElMarcador",
    "estampar",
    "leerVersion",
    "estampaDeVersion",
    "validarManifiesto",
    "validarBundle",
  ] as const) {
    expect(empaquetador[nombre], `el script dejó de exportar ${nombre}`).toBeDefined();
  }
});

/** Los propósitos de un icono como los lee el navegador: lista separada por espacios. */
function propositosDe(icono: IconoManifiesto): string[] {
  return (icono.purpose ?? "any").trim().split(/\s+/);
}

/* ------------------------------------------------------------------ */
/* Manifiesto                                                            */
/* ------------------------------------------------------------------ */

describe("manifiesto: lo que Chrome exige para ofrecer la instalación", () => {
  it("trae todos los campos obligatorios, con display standalone", () => {
    for (const campo of [
      "name",
      "short_name",
      "start_url",
      "scope",
      "theme_color",
      "background_color",
    ] as const) {
      expect(typeof manifiesto[campo], `falta "${campo}"`).toBe("string");
      expect(manifiesto[campo].trim(), `"${campo}" está vacío`).not.toBe("");
    }
    expect(manifiesto.display).toBe("standalone");
    expect(manifiesto.start_url.startsWith(manifiesto.scope), "start_url fuera de scope").toBe(
      true,
    );
  });

  it("cada icono referenciado existe en disco y pesa más que cero", () => {
    // ERROR != VACÍO: un src que apunta a un archivo que no existe no da error
    // en ningún navegador, simplemente no se instala. Acá se abre el archivo.
    expect(manifiesto.icons.length).toBeGreaterThan(0);
    for (const icono of manifiesto.icons) {
      const archivo = path.join(PUBLICO, icono.src.replace(/^\//, ""));
      expect(existsSync(archivo), `${icono.src} no existe en public/`).toBe(true);
      expect(statSync(archivo).size, `${icono.src} pesa 0`).toBeGreaterThan(0);
    }
  });

  it("hay PNG de 192 y 512 con purpose any Y con purpose maskable", () => {
    const png = manifiesto.icons.filter((i) => i.type === "image/png");
    for (const lado of ["192x192", "512x512"]) {
      for (const proposito of ["any", "maskable"]) {
        expect(
          png.some((i) => i.sizes === lado && propositosDe(i).includes(proposito)),
          `falta un PNG ${lado} con purpose "${proposito}"`,
        ).toBe(true);
      }
    }
  });

  it("el validador del empaquetador lo da por bueno tal como está en el repo", () => {
    expect(empaquetador.validarManifiesto(PUBLICO)).toEqual([]);
  });

  /**
   * El validador se prueba ROMPIENDO una copia: un validador que no falla
   * cuando falta algo es el que deja subir un bundle que no se instala.
   */
  const roturasDelManifiesto: [string, (m: Record<string, unknown>) => unknown, RegExp][] = [
    ["sin theme_color", (m) => ({ ...m, theme_color: undefined }), /theme_color/],
    ["sin short_name", (m) => ({ ...m, short_name: "" }), /short_name/],
    ["con display browser", (m) => ({ ...m, display: "browser" }), /display/],
    ["con start_url fuera de scope", (m) => ({ ...m, scope: "/app/" }), /scope/],
    [
      "sin el maskable de 512",
      (m) => ({
        ...m,
        icons: (m.icons as IconoManifiesto[]).filter(
          (i) => !(i.sizes === "512x512" && propositosDe(i).includes("maskable")),
        ),
      }),
      /maskable/,
    ],
    [
      "con un icono que apunta a un archivo que no existe",
      (m) => ({
        ...m,
        icons: [...(m.icons as IconoManifiesto[]), { ...(m.icons as IconoManifiesto[])[0], src: "/icons/no-existe.png" }],
      }),
      /no-existe\.png/,
    ],
    ["sin iconos", (m) => ({ ...m, icons: [] }), /icons/],
    ["que no es JSON", () => "{ esto no es json", /JSON/],
  ];

  it.each(roturasDelManifiesto)("FALLA con un manifiesto %s", (_nombre, romper, esperado) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pwa-manifiesto-"));
    try {
      cpSync(PUBLICO, dir, { recursive: true });
      const original = JSON.parse(readFileSync(RUTA_MANIFIESTO, "utf8")) as Record<string, unknown>;
      const roto = romper(original);
      writeFileSync(
        path.join(dir, "manifest.webmanifest"),
        typeof roto === "string" ? roto : JSON.stringify(roto),
        "utf8",
      );
      const problemas = empaquetador.validarManifiesto(dir);
      expect(problemas.length, "el validador no vio nada").toBeGreaterThan(0);
      expect(problemas.some((p) => esperado.test(p)), problemas.join(" | ")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* El marcador de versión                                                */
/* ------------------------------------------------------------------ */

describe("service worker: la versión es reemplazable por el empaquetador", () => {
  it("el fuente trae el marcador exacto que el empaquetador busca, una sola vez", () => {
    // El marcador se toma DEL SCRIPT: si alguien lo cambia allá o acá, esto
    // deja de coincidir y se ve. Dos apariciones también fallan: el script
    // exige exactamente una para no estampar a ciegas.
    expect(empaquetador.MARCADOR_VERSION).toContain('"v1"');
    expect(FUENTE_SW).toContain(empaquetador.MARCADOR_VERSION);
    expect(empaquetador.vecesQueApareceElMarcador(FUENTE_SW)).toBe(1);
    expect(empaquetador.leerVersion(FUENTE_SW)).toBe("v1");
  });

  it("estampar deja la versión nueva y no toca nada más", () => {
    const estampado = empaquetador.estampar(FUENTE_SW, ESTAMPA_DE_PRUEBA);
    expect(empaquetador.leerVersion(estampado)).toBe(ESTAMPA_DE_PRUEBA);
    expect(empaquetador.vecesQueApareceElMarcador(estampado)).toBe(0);
    // Solo cambió esa línea: el resto del worker es byte a byte el mismo.
    expect(estampado.replace(`const VERSION = "${ESTAMPA_DE_PRUEBA}";`, empaquetador.MARCADOR_VERSION)).toBe(FUENTE_SW);
  });

  it("estampar se niega si el marcador no está o está dos veces", () => {
    expect(() => empaquetador.estampar(FUENTE_SW.replace(empaquetador.MARCADOR_VERSION, 'const VERSION = "v2";'), "x")).toThrow(/0 veces/);
    expect(() => empaquetador.estampar(`${FUENTE_SW}\n${empaquetador.MARCADOR_VERSION}\n`, "x")).toThrow(/2 veces/);
  });

  it("la estampa lleva versión y sha, y declara el árbol sucio con fecha", () => {
    expect(empaquetador.estampaDeVersion({ version: "0.1.0", sha: "abc1234", sucio: false })).toBe("0.1.0-abc1234");
    expect(
      empaquetador.estampaDeVersion({
        version: "0.1.0",
        sha: "abc1234",
        sucio: true,
        ahora: new Date("2026-09-02T15:04:00Z"),
      }),
    ).toBe("0.1.0-abc1234-sucio-202609021504");
  });
});

/* ------------------------------------------------------------------ */
/* El worker en ejecución                                                */
/* ------------------------------------------------------------------ */

/** Lo mínimo que el worker usa de una respuesta; con cabeceras, porque las lee. */
interface RespuestaFalsa {
  ok: boolean;
  status: number;
  type: string;
  headers: Headers;
  etiqueta: string;
  clone(): RespuestaFalsa;
}

function respuesta(etiqueta: string, cabeceras: Record<string, string> = {}): RespuestaFalsa {
  const r: RespuestaFalsa = {
    ok: true,
    status: 200,
    type: "basic",
    headers: new Headers(cabeceras),
    etiqueta,
    clone: () => r,
  };
  return r;
}

interface EventoFalso {
  request: Request;
  respondWith(promesa: Promise<unknown>): void;
  waitUntil(promesa: Promise<unknown>): void;
}

type Manejador = (evento: EventoFalso) => void;
type Red = (peticion: Request) => Promise<RespuestaFalsa>;

/** El caché real indexa por URL absoluta aunque le pases una ruta; acá igual. */
function resolver(peticion: Request | string) {
  return typeof peticion === "string" ? new URL(peticion, ORIGEN).href : peticion.url;
}

class CacheFalso {
  readonly contenido = new Map<string, RespuestaFalsa>();
  async match(peticion: Request | string) {
    return this.contenido.get(resolver(peticion));
  }
  async put(peticion: Request | string, valor: RespuestaFalsa) {
    this.contenido.set(resolver(peticion), valor);
  }
  async keys() {
    return [...this.contenido.keys()];
  }
  async delete(clave: string) {
    return this.contenido.delete(clave);
  }
}

class CachesFalsos {
  readonly abiertos = new Map<string, CacheFalso>();
  async open(nombre: string) {
    const existente = this.abiertos.get(nombre);
    if (existente) return existente;
    const nuevo = new CacheFalso();
    this.abiertos.set(nombre, nuevo);
    return nuevo;
  }
  async match(peticion: Request | string, opciones?: { cacheName?: string }) {
    const donde = opciones?.cacheName
      ? [this.abiertos.get(opciones.cacheName)]
      : [...this.abiertos.values()];
    for (const cache of donde) {
      const hallado = await cache?.match(peticion);
      if (hallado) return hallado;
    }
    return undefined;
  }
  async keys() {
    return [...this.abiertos.keys()];
  }
  async delete(nombre: string) {
    return this.abiertos.delete(nombre);
  }
  /** Todo lo guardado, de todos los cachés, para revisarlo de una. */
  todo() {
    return [...this.abiertos.values()].flatMap((c) => [...c.contenido.keys()]);
  }
}

/** `new Request("/x")` no existe fuera del navegador: hay que darle el origen. */
class RequestConOrigen extends Request {
  constructor(entrada: RequestInfo | URL, init?: RequestInit) {
    super(typeof entrada === "string" ? new URL(entrada, ORIGEN) : entrada, init);
  }
}

interface Worker {
  manejadores: Map<string, Manejador[]>;
  caches: CachesFalsos;
  pedidosDeRed: string[];
  ponerRed(nueva: Red): void;
}

const RED_OK: Red = (peticion) => Promise.resolve(respuesta(`red ${peticion.url}`));
const RED_CAIDA: Red = () => Promise.reject(new Error("sin red"));

/** Ejecuta un fuente de worker contra un navegador de mentira y devuelve sus ganchos. */
function arrancarWorker(fuente: string, redInicial: Red = RED_OK): Worker {
  const manejadores = new Map<string, Manejador[]>();
  const cachesFalsos = new CachesFalsos();
  const pedidosDeRed: string[] = [];
  let red = redInicial;
  const self = {
    addEventListener(tipo: string, fn: Manejador) {
      manejadores.set(tipo, [...(manejadores.get(tipo) ?? []), fn]);
    },
    location: new URL(ORIGEN),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const fetchFalso = (peticion: Request) => {
    pedidosDeRed.push(peticion.url);
    return red(peticion);
  };
  const arrancar = new Function("self", "caches", "fetch", "Request", fuente) as (
    ...args: unknown[]
  ) => void;
  arrancar(self, cachesFalsos, fetchFalso, RequestConOrigen);
  return {
    manejadores,
    caches: cachesFalsos,
    pedidosDeRed,
    ponerRed(nueva) {
      red = nueva;
    },
  };
}

async function disparar(worker: Worker, tipo: string, peticion?: Request) {
  const pendientes: Promise<unknown>[] = [];
  let respondio: Promise<unknown> | undefined;
  const evento: EventoFalso = {
    request: peticion as Request,
    respondWith: (p) => {
      respondio = p;
    },
    waitUntil: (p) => {
      pendientes.push(p);
    },
  };
  for (const manejador of worker.manejadores.get(tipo) ?? []) manejador(evento);
  const resultado = respondio ? await respondio : undefined;
  await Promise.all(pendientes);
  return { respondio: respondio !== undefined, resultado };
}

/** Node prohíbe construir un Request con mode "navigate"; se le monta encima. */
function navegacion(url: string): Request {
  const peticion = new Request(url);
  Object.defineProperty(peticion, "mode", { value: "navigate" });
  return peticion;
}

describe("service worker: qué NO guarda nunca", () => {
  let worker: Worker;

  beforeAll(async () => {
    worker = arrancarWorker(FUENTE_SW);
    await disparar(worker, "install");
  });

  it("al instalar guardó la pantalla de sin conexión, que existe en disco", () => {
    const enDisco = path.join(PUBLICO, "sin-conexion.html");
    expect(existsSync(enDisco)).toBe(true);
    expect(statSync(enDisco).size).toBeGreaterThan(0);
    expect(worker.caches.todo()).toContain(`${ORIGEN}/sin-conexion.html`);
  });

  it.each([
    [
      "una boleta por URL firmada de Supabase Storage",
      "https://proyecto.supabase.co/storage/v1/object/sign/boletas/2026-09.png?token=eyJhbGciOi",
    ],
    ["un documento médico de Storage", "https://proyecto.supabase.co/storage/v1/object/sign/examenes/hemograma.png?token=abc"],
    ["una respuesta de PostgREST", "https://proyecto.supabase.co/rest/v1/pantry_items.json?select=*"],
    ["la sesión de Auth", "https://proyecto.supabase.co/auth/v1/user.json"],
    ["una fuente de otro origen", "https://fonts.gstatic.com/s/manrope/v15/x.woff2"],
  ])("no toca %s (otro origen)", async (_nombre, url) => {
    // Las URL terminan en extensión "estática" a propósito: sin la guarda de
    // origen, `esEstatico` diría que sí y quedarían guardadas con su token.
    const antes = worker.caches.todo();
    const evento = await disparar(worker, "fetch", new Request(url));
    expect(evento.respondio, "el worker interceptó un pedido ajeno").toBe(false);
    expect(worker.caches.todo()).toEqual(antes);
  });

  it("no toca un archivo que sale de /api", async () => {
    const antes = worker.caches.todo();
    const evento = await disparar(worker, "fetch", new Request(`${ORIGEN}/api/labels/almuerzo.png`));
    expect(evento.respondio).toBe(false);
    expect(worker.caches.todo()).toEqual(antes);
  });

  it.each([
    ["una imagen bajo /finanzas (boletas)", `${ORIGEN}/finanzas/boletas/7/imagen.png`],
    ["un archivo bajo /health (exámenes)", `${ORIGEN}/health/exams/3/informe.png`],
    ["un archivo bajo /salud", `${ORIGEN}/salud/documento.svg`],
  ])("no guarda %s aunque la extensión parezca de archivo", async (_nombre, url) => {
    const antes = worker.caches.todo();
    const evento = await disparar(worker, "fetch", new Request(url));
    expect(evento.respondio, "el worker interceptó un archivo privado").toBe(false);
    expect(worker.caches.todo()).toEqual(antes);
  });

  it("abrir /finanzas sin red sigue mostrando la pantalla de sin conexión", async () => {
    // El contrapeso de la guarda de rutas privadas: si se pusiera ANTES de la
    // rama de navegación, /finanzas sin red mostraría el error del navegador.
    const propio = arrancarWorker(FUENTE_SW);
    await disparar(propio, "install");
    propio.ponerRed(RED_CAIDA);
    const evento = await disparar(propio, "fetch", navegacion(`${ORIGEN}/finanzas`));
    expect(evento.respondio).toBe(true);
    expect((evento.resultado as RespuestaFalsa).etiqueta).toBe(`red ${ORIGEN}/sin-conexion.html`);
  });

  it("con red, /finanzas viene del servidor y NO queda guardada", async () => {
    const antes = worker.caches.todo();
    const evento = await disparar(worker, "fetch", navegacion(`${ORIGEN}/finanzas/boletas`));
    expect(evento.respondio).toBe(true);
    expect((evento.resultado as RespuestaFalsa).etiqueta).toBe(`red ${ORIGEN}/finanzas/boletas`);
    expect(worker.caches.todo()).toEqual(antes);
  });

  it.each([
    ["no-store", "private, no-cache, no-store, max-age=0, must-revalidate"],
    ["private", "private, max-age=60"],
  ])("no guarda una respuesta que el servidor marca %s, aunque la ruta parezca de archivo", async (_nombre, control) => {
    // La red de seguridad para una ruta privada que nadie listó: Next marca así
    // todo lo que renderiza con sesión. El archivo se entrega igual, pero no
    // queda en el caché.
    const url = `${ORIGEN}/informes/semana-36.png`;
    worker.ponerRed(() => Promise.resolve(respuesta(`red ${url}`, { "cache-control": control })));
    try {
      const evento = await disparar(worker, "fetch", new Request(url));
      expect(evento.respondio).toBe(true);
      expect((evento.resultado as RespuestaFalsa).etiqueta).toBe(`red ${url}`);
      expect(worker.caches.todo()).not.toContain(url);
    } finally {
      worker.ponerRed(RED_OK);
    }
  });

  it("el contrapeso: un bundle público con hash SÍ se guarda", async () => {
    // Sin esto, "no guarda nada" pasaría con un worker que no guarda NADA.
    const url = `${ORIGEN}/_next/static/chunks/app-1a2b3c4d.js`;
    worker.ponerRed(() =>
      Promise.resolve(respuesta(`red ${url}`, { "cache-control": "public, max-age=31536000, immutable" })),
    );
    try {
      await disparar(worker, "fetch", new Request(url));
      expect(worker.caches.todo()).toContain(url);
    } finally {
      worker.ponerRed(RED_OK);
    }
  });
});

describe("service worker: la estampa cambia los nombres de caché y bota los viejos", () => {
  it("un worker estampado usa la estampa en sus cachés y el activate borra los de v1", async () => {
    // §8 "version update": esto es lo que hace que un despliegue nuevo no deje
    // el icono viejo pegado. Se ejecuta el worker ESTAMPADO, no el fuente.
    const estampado = arrancarWorker(empaquetador.estampar(FUENTE_SW, ESTAMPA_DE_PRUEBA));
    // Cachés del despliegue anterior, como los dejaría el fuente sin estampar.
    await estampado.caches.open("nutrifamilia-armazon-v1");
    await estampado.caches.open("nutrifamilia-estaticos-v1");

    await disparar(estampado, "install");
    await disparar(estampado, "activate");

    const nombres = await estampado.caches.keys();
    expect(nombres.length).toBeGreaterThan(0);
    for (const nombre of nombres) {
      expect(nombre, "quedó un caché sin la estampa nueva").toContain(ESTAMPA_DE_PRUEBA);
    }
    expect(nombres).not.toContain("nutrifamilia-armazon-v1");
    expect(nombres).not.toContain("nutrifamilia-estaticos-v1");
  });
});

/* ------------------------------------------------------------------ */
/* El validador del bundle                                               */
/* ------------------------------------------------------------------ */

/**
 * Un bundle de mentira con TODO lo que `validarBundle` exige: server.js,
 * package.json, .next/BUILD_ID, .next/static con algo adentro, node_modules y
 * el public/ real del repo con el worker ya estampado. Sobre esto se rompe de
 * a una pieza.
 */
function armarBundleFalso(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pwa-bundle-"));
  writeFileSync(path.join(dir, "server.js"), "// servidor de mentira\n");
  writeFileSync(path.join(dir, "package.json"), "{}\n");
  mkdirSync(path.join(dir, ".next", "static", "chunks"), { recursive: true });
  writeFileSync(path.join(dir, ".next", "BUILD_ID"), "build-de-prueba\n");
  writeFileSync(path.join(dir, ".next", "static", "chunks", "app-1a2b3c4d.js"), "1;\n");
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  cpSync(PUBLICO, path.join(dir, "public"), { recursive: true });
  const sw = path.join(dir, "public", "sw.js");
  writeFileSync(sw, empaquetador.estampar(readFileSync(sw, "utf8"), ESTAMPA_DE_PRUEBA), "utf8");
  return dir;
}

describe("validador del bundle: falla si falta cualquier pieza", () => {
  const abiertos: string[] = [];

  afterEach(() => {
    for (const dir of abiertos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("da por bueno un bundle completo y estampado", () => {
    const dir = armarBundleFalso();
    abiertos.push(dir);
    expect(empaquetador.validarBundle(dir)).toEqual([]);
  });

  const roturas: [string, (dir: string) => void, RegExp][] = [
    ["sin server.js", (d) => rmSync(path.join(d, "server.js")), /server\.js/],
    ["sin .next/BUILD_ID", (d) => rmSync(path.join(d, ".next", "BUILD_ID")), /BUILD_ID/],
    ["sin node_modules", (d) => rmSync(path.join(d, "node_modules"), { recursive: true }), /node_modules/],
    ["sin .next/static", (d) => rmSync(path.join(d, ".next", "static"), { recursive: true }), /static/],
    ["con .next/static vacío", (d) => rmSync(path.join(d, ".next", "static", "chunks"), { recursive: true }), /static/],
    ["sin public/", (d) => rmSync(path.join(d, "public"), { recursive: true }), /public/],
    ["sin public/sw.js", (d) => rmSync(path.join(d, "public", "sw.js")), /sw\.js/],
    [
      "con el sw.js SIN estampar (sigue en v1)",
      (d) => writeFileSync(path.join(d, "public", "sw.js"), FUENTE_SW, "utf8"),
      /v1/,
    ],
    [
      "con un sw.js que no declara VERSION",
      (d) => writeFileSync(path.join(d, "public", "sw.js"), "self.addEventListener('fetch', () => {});\n"),
      /VERSION/,
    ],
    ["sin sin-conexion.html", (d) => rmSync(path.join(d, "public", "sin-conexion.html")), /sin-conexion/],
    ["con sin-conexion.html vacío", (d) => writeFileSync(path.join(d, "public", "sin-conexion.html"), ""), /sin-conexion/],
    ["sin el icono maskable de 512", (d) => rmSync(path.join(d, "public", "icons", "icon-maskable-512.png")), /icon-maskable-512/],
    ["sin manifiesto", (d) => rmSync(path.join(d, "public", "manifest.webmanifest")), /manifest/],
    ["con el manifiesto que no es JSON", (d) => writeFileSync(path.join(d, "public", "manifest.webmanifest"), "{ roto"), /JSON/],
  ];

  it.each(roturas)("FALLA %s", (_nombre, romper, esperado) => {
    const dir = armarBundleFalso();
    abiertos.push(dir);
    romper(dir);
    const problemas = empaquetador.validarBundle(dir);
    expect(problemas.length, "el validador dejó pasar el bundle cojo").toBeGreaterThan(0);
    expect(problemas.some((p) => esperado.test(p)), problemas.join(" | ")).toBe(true);
  });

  it("un directorio que no existe se declara, no se da por vacío", () => {
    const problemas = empaquetador.validarBundle(path.join(os.tmpdir(), "no-existe-" + Date.now()));
    expect(problemas.length).toBe(1);
    expect(problemas[0]).toMatch(/no existe/);
  });
});
