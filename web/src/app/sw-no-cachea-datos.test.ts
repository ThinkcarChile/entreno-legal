import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GUARDIÁN: el service worker no guarda datos, nunca.
 *
 * public/sw.js no lo compila TypeScript ni lo cubre ningún test de pantalla:
 * vive suelto en public/. Y es justo el archivo donde un error no se ve —
 * cachear de más no rompe nada, se ve idéntico a la app andando, solo que con
 * la despensa de ayer. Por eso acá se ejecuta el worker de verdad, con `self`,
 * `caches` y `fetch` de mentira, y se revisa QUÉ quedó guardado.
 *
 * POR QUÉ CADA CASO USA LA URL QUE USA: la primera versión de este archivo
 * probaba las guardas con /api/labels y /pantry?_rsc=1, y pasaba igual si le
 * borrabas la guarda completa — esas dos rutas no tienen extensión, así que
 * `esEstatico()` las descartaba igual por el final del manejador. Un test que
 * pasa con el arreglo revertido no prueba nada. Ahora cada guarda se prueba con
 * una petición que SIN esa guarda terminaría guardada o contestada mal, y eso
 * está comprobado por mutación: borrando la línea, el caso se pone rojo.
 */

const RAIZ_WEB = path.resolve(__dirname, "..", "..");
const ORIGEN = "https://nutrifamilia.test";
const FUENTE = readFileSync(path.join(RAIZ_WEB, "public", "sw.js"), "utf8");

/** Lo mínimo que el worker usa de una respuesta: no hace falta una real. */
interface RespuestaFalsa {
  ok: boolean;
  status: number;
  type: string;
  etiqueta: string;
  clone(): RespuestaFalsa;
}

function respuesta(etiqueta: string, type = "basic", ok = true, status = ok ? 200 : 404) {
  const r: RespuestaFalsa = {
    ok,
    status,
    type,
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

/**
 * El caché real indexa por URL absoluta, aunque le pases una ruta relativa.
 * Acá se normaliza igual: el worker guarda el armazón con rutas ("/icon.svg") y
 * lo lee con peticiones (url completa), y un doble que no normalice haría pasar
 * un worker que en el navegador nunca encontraría lo que guardó.
 */
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
  /** Cambia la red DESPUÉS de instalar: caerse es algo que pasa en el camino. */
  ponerRed(nueva: Red): void;
}

const RED_OK: Red = (peticion) => Promise.resolve(respuesta(`red ${peticion.url}`));
const RED_CAIDA: Red = () => Promise.reject(new Error("sin red"));

/** Ejecuta public/sw.js contra un navegador de mentira y devuelve sus ganchos. */
function arrancarWorker(redInicial: Red = RED_OK): Worker {
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

  const arrancar = new Function("self", "caches", "fetch", "Request", FUENTE) as (
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

/** Dispara un evento y espera lo que el worker haya respondido, si respondió. */
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

/**
 * Arma la petición de una navegación (abrir/recargar una pantalla).
 *
 * Node prohíbe construir un Request con mode "navigate" — en el navegador lo
 * pone él, no el código. Se lo montamos encima para poder probarlo.
 */
function navegacion(url: string): Request {
  const peticion = new Request(url);
  Object.defineProperty(peticion, "mode", { value: "navigate" });
  return peticion;
}

/** Lo que el worker dejó dicho en consola: "se declara" también se comprueba. */
let avisos: string[] = [];
let worker: Worker;

beforeEach(async () => {
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((...partes: unknown[]) => {
    avisos.push(partes.map(String).join(" "));
  });
  worker = arrancarWorker();
  await disparar(worker, "install");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("qué se guarda al instalar", () => {
  it("solo archivos estáticos, ninguna pantalla con datos", async () => {
    const guardado = worker.caches.todo();
    expect(guardado.length).toBeGreaterThan(0);
    for (const url of guardado) {
      expect(new URL(url).pathname).toMatch(/\.(html|webmanifest|svg|png)$/);
    }
    expect(guardado).toContain(`${ORIGEN}/sin-conexion.html`);
  });

  it("si la pantalla de sin conexión no se puede guardar, la instalación FALLA fuerte", async () => {
    // UNKNOWN != NORMAL. Un worker instalado sin esa pantalla queda aparentando
    // que la app anda sin conexión y mostrando el error del navegador. Antes
    // esto dependía de que `cache.addAll` fuera todo-o-nada, o sea que un icono
    // en 404 también volteaba la instalación entera; ahora la única que es
    // fatal es la pantalla, y eso se comprueba en los dos sentidos.
    const roto = arrancarWorker((peticion) =>
      peticion.url.endsWith("/sin-conexion.html")
        ? Promise.reject(new Error("el middleware contestó 500"))
        : RED_OK(peticion),
    );
    await expect(disparar(roto, "install")).rejects.toThrow(/sin-conexion\.html/);
  });

  it("si falla solo un icono, se instala igual pero lo DICE", async () => {
    const cojo = arrancarWorker((peticion) =>
      peticion.url.endsWith("/apple-touch-icon.png")
        ? Promise.resolve(respuesta("404", "basic", false))
        : RED_OK(peticion),
    );
    await disparar(cojo, "install");

    // ERROR != VACÍO: el icono que faltó no se guarda Y queda anotado.
    expect(cojo.caches.todo()).toContain(`${ORIGEN}/sin-conexion.html`);
    expect(cojo.caches.todo()).not.toContain(`${ORIGEN}/apple-touch-icon.png`);
    expect(avisos.join(" | ")).toContain("/apple-touch-icon.png");
  });
});

describe("qué NO toca el worker", () => {
  it("no guarda una imagen de Supabase aunque el nombre termine en .png", async () => {
    // Este caso existe porque es el que rompe si sacas la guarda de origen: la
    // URL termina en .png, así que `esEstatico()` diría que sí y la foto de una
    // receta quedaría cacheada para siempre, con su token de acceso adentro.
    const antes = worker.caches.todo();
    const foto = "https://proyecto.supabase.co/storage/v1/object/public/recetas/foto.png";
    const evento = await disparar(worker, "fetch", new Request(foto));
    expect(evento.respondio).toBe(false);
    expect(worker.caches.todo()).toEqual(antes);
  });

  it("no guarda un .png que sale de /api", async () => {
    // La etiqueta de un producto se genera en /api y sale como PNG. Sin la
    // guarda de /api, `esEstatico()` da true por la extensión y esa etiqueta
    // —que es un dato, no un archivo— se queda pegada en el caché.
    const antes = worker.caches.todo();
    const evento = await disparar(
      worker,
      "fetch",
      new Request(`${ORIGEN}/api/etiquetas/almuerzo.png`),
    );
    expect(evento.respondio).toBe(false);
    expect(worker.caches.todo()).toEqual(antes);
  });

  it("a un pedido con _rsc no le contesta la pantalla de sin conexión", async () => {
    // Sin la guarda de `_rsc`, este pedido cae en la rama de navegación y sin
    // red recibe el HTML de /sin-conexion.html como si fuera un payload de
    // React: el router se rompe con un error que no dice nada. Por eso la
    // guarda va ANTES de la rama de navegación y no después.
    worker.ponerRed(RED_CAIDA);
    const evento = await disparar(worker, "fetch", navegacion(`${ORIGEN}/plan?_rsc=1a2b3`));
    expect(evento.respondio).toBe(false);
  });

  it("no se mete con las mutaciones (server actions van por POST)", async () => {
    const evento = await disparar(
      worker,
      "fetch",
      new Request(`${ORIGEN}/pantry`, { method: "POST", body: "consumir" }),
    );
    expect(evento.respondio).toBe(false);
  });
});

describe("pantallas", () => {
  it("con red, la pantalla viene del servidor y NO queda guardada", async () => {
    const antes = worker.caches.todo();
    const evento = await disparar(worker, "fetch", navegacion(`${ORIGEN}/pantry`));
    expect(evento.respondio).toBe(true);
    expect((evento.resultado as RespuestaFalsa).etiqueta).toBe(`red ${ORIGEN}/pantry`);
    // Lo importante: la despensa renderizada NO entró al caché.
    expect(worker.caches.todo()).toEqual(antes);
  });

  it("sin red, muestra la pantalla que lo DICE, no una copia vieja", async () => {
    // Se instala con red y DESPUÉS se cae: es el orden real de los hechos, y es
    // el único en que el worker llega a tener la pantalla guardada.
    worker.ponerRed(RED_CAIDA);
    const evento = await disparar(worker, "fetch", navegacion(`${ORIGEN}/pantry`));
    expect(evento.respondio).toBe(true);
    expect((evento.resultado as RespuestaFalsa).etiqueta).toBe(
      `red ${ORIGEN}/sin-conexion.html`,
    );
  });
});

describe("archivos estáticos", () => {
  it("un bundle de /_next/static se guarda y la segunda vez no pide red", async () => {
    const bundle = `${ORIGEN}/_next/static/chunks/4bd1b696-f785427dddbba9fb.js`;
    await disparar(worker, "fetch", new Request(bundle));
    expect(worker.caches.todo()).toContain(bundle);

    worker.pedidosDeRed.length = 0;
    const segunda = await disparar(worker, "fetch", new Request(bundle));
    expect(segunda.respondio).toBe(true);
    // Lleva el hash en el nombre: si cambió el contenido, cambió la URL. Pedir
    // red acá sería gastarla en algo que no puede haber cambiado.
    expect(worker.pedidosDeRed).toEqual([]);
  });

  it("un estático SIN hash se sirve del caché pero se renueva por detrás", async () => {
    // El bug que puso esto acá: al cambiar el color de marca de #2f7d4f a
    // #3a684d, la versión anterior del worker dejaba el icono viejo pegado para
    // siempre en cualquier celular que ya tuviera la app instalada, porque
    // VERSION es un literal que ningún paso de build sube y el `activate`
    // entonces nunca borraba nada. La revalidación no depende de que alguien se
    // acuerde de subir un número al desplegar.
    const icono = `${ORIGEN}/icon.svg`;
    await disparar(worker, "fetch", new Request(icono));

    worker.pedidosDeRed.length = 0;
    const segunda = await disparar(worker, "fetch", new Request(icono));
    expect(segunda.respondio).toBe(true);
    expect(worker.pedidosDeRed, "el icono quedó congelado en la primera versión").toEqual([
      icono,
    ]);
  });

  it("TODO lo que el install dejó guardado se sirve sin red", async () => {
    // La regresión que puso esto acá: el armazón (manifiesto, icon.svg,
    // apple-touch-icon) se guardaba en CACHE_ARMAZON al instalar, pero el
    // manejador de estáticos consultaba SOLO CACHE_ESTATICOS — un caché de solo
    // escritura, precacheado e inservible a la vez. El test de revalidación no
    // lo veía porque calentaba CACHE_ESTATICOS con un primer pedido CON red.
    // Acá la propiedad se prueba entera: se corta la red inmediatamente después
    // del install y CADA URL que quedó guardada (se leen del caché, no de una
    // lista copiada del worker) tiene que servirse igual.
    const precacheado = worker.caches.todo();
    expect(precacheado.length, "el install no guardó nada: no hay qué probar").toBeGreaterThan(0);

    worker.ponerRed(RED_CAIDA);
    for (const url of precacheado) {
      // La pantalla de sin conexión se pide como navegación, que es como llega
      // en la vida real; el resto son pedidos de archivo comunes.
      const peticion = new URL(url).pathname.endsWith(".html")
        ? navegacion(url)
        : new Request(url);
      const evento = await disparar(worker, "fetch", peticion);
      expect(evento.respondio, `${url} está precacheado y el worker ni respondió`).toBe(true);
      expect(
        (evento.resultado as RespuestaFalsa).etiqueta,
        `${url} está precacheado y aun así no se sirvió del caché`,
      ).toBe(`red ${url}`);
    }
  });

  it("sin red y sin copia, un estático se declara con un 503, no con una promesa rota", async () => {
    // Antes el `await fetch` de la rama de estáticos no tenía try/catch: sin
    // red, el respondWith quedaba con una promesa RECHAZADA y el navegador lo
    // mostraba como un error de red anónimo. ERROR != VACÍO: se contesta
    // diciendo qué faltó.
    worker.ponerRed(RED_CAIDA);
    const evento = await disparar(
      worker,
      "fetch",
      new Request(`${ORIGEN}/fuentes/manrope.woff2`),
    );
    expect(evento.respondio).toBe(true);
    expect((evento.resultado as Response).status).toBe(503);
  });

  it("una respuesta rota no queda guardada como si fuera el archivo", async () => {
    const url = `${ORIGEN}/_next/static/chunks/no-existe.js`;
    worker.ponerRed(() => Promise.resolve(respuesta("404", "basic", false)));
    await disparar(worker, "fetch", new Request(url));
    expect(worker.caches.todo()).not.toContain(url);
  });
});
