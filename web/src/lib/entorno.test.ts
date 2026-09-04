import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * §46 — ENTORNOS: qué secreto puede vivir dónde.
 *
 * Dos secretos de este proyecto no pueden entrar JAMÁS al proceso del servidor
 * web, y menos al navegador:
 *
 *  · `SUPABASE_ACCESS_TOKEN` — token de la Management API. Corre SQL arbitrario
 *    sobre TODA la cuenta de Supabase, no sobre un hogar. Por eso `.gitignore`
 *    lo manda a `.env.deploy` y no a `web/.env.local`: Next carga ese último
 *    dentro del proceso del servidor, y ahí un bug de render lo deja a un
 *    `fetch` de distancia.
 *  · La clave `service_role` — se salta toda la RLS. Con RLS puesta en el 100%
 *    de las tablas, meter esa clave al servidor web es desactivar de un plumazo
 *    el único mecanismo que separa a un hogar de otro.
 *
 * Y una regla de forma: TODA variable `NEXT_PUBLIC_*` viaja al navegador. Next
 * las inserta en el bundle en tiempo de build; no hay forma de "publicar solo un
 * poco". Un secreto con ese prefijo no está mal configurado: está publicado.
 *
 * Estos tests leen ARCHIVOS, no el entorno de quien corre la suite: preguntar
 * por `process.env` acá daría verde en una máquina que simplemente no tiene la
 * variable puesta, que es el falso verde más fácil de escribir.
 */

const SRC = path.resolve(__dirname, "..");
const WEB = path.resolve(SRC, "..");
const RAIZ = path.resolve(WEB, "..");
const EJEMPLO = path.join(WEB, ".env.example");
/** Este mismo archivo NOMBRA los secretos para prohibirlos: no se escanea a sí mismo. */
const YO = path.join(SRC, "lib", "entorno.test.ts");

function fuentes(raiz: string, extensiones = /\.tsx?$/): string[] {
  const out: string[] = [];
  if (!existsSync(raiz)) return out;
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) {
      if (nombre === "node_modules" || nombre === ".next") continue;
      out.push(...fuentes(ruta, extensiones));
    } else if (extensiones.test(nombre)) out.push(ruta);
  }
  return out;
}

/**
 * DONDE BUSCAR UNA CREDENCIAL PEGADA. No alcanza con `web/src`.
 *
 * El barrido miraba sólo el código de la app y `.env.example`, y dejaba afuera
 * las dos carpetas donde de verdad se manipulan secretos: `scripts/` —ahí vive
 * `staging-bootstrap.mjs`, el único código del repo que le PIDE la service_role
 * a la Management API— y `web/e2e/`, cuyos fixtures se autentican. Un token
 * pegado en cualquiera de esas dos se versionaba sin que nadie chistara.
 */
const DONDE_BUSCAR = (): string[] => [
  ...fuentes(SRC),
  ...fuentes(path.join(RAIZ, "scripts"), /\.(mjs|js|tsx?)$/),
  ...fuentes(path.join(WEB, "e2e"), /\.(mjs|js|tsx?)$/),
  EJEMPLO,
];

const rel = (p: string) => path.relative(RAIZ, p).split(path.sep).join("/");

const FORMAS: [string, RegExp][] = [
  ["token de la Management API (sbp_…)", /\bsbp_[0-9a-f]{40}\b/],
  ["JWT largo (anon o service_role)", /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\./],
  // LAS DOS DE ARRIBA NO ALCANZABAN. Supabase emitio un formato nuevo y
  // este proyecto YA lo usa: la llave publicable que viaja en el bundle
  // compilado empieza con el prefijo publicable nuevo. O sea que este
  // guardian estaba vigilando la ORTOGRAFIA VIEJA de la credencial: una
  // llave secreta del formato nuevo pegada en el codigo pasaba en verde.
  ["llave SECRETA de Supabase, formato nuevo", /\bsb_secret_[A-Za-z0-9_-]{20,}/],
  ["llave publicable de Supabase, formato nuevo", /\bsb_publishable_[A-Za-z0-9_-]{20,}/],
];


/** Las variables que el código de PRODUCCIÓN lee de verdad (los tests no cuentan). */
function variablesQueLeeLaApp(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const archivo of fuentes(SRC)) {
    if (/\.test\.tsx?$/.test(archivo)) continue;
    const fuente = readFileSync(archivo, "utf8");
    for (const m of fuente.matchAll(/process\.env\.([A-Z_0-9]+)/g)) {
      const lista = out.get(m[1]!) ?? [];
      lista.push(rel(archivo));
      out.set(m[1]!, lista);
    }
  }
  return out;
}

/** Los nombres declarados en `.env.example`, en orden. */
function nombresDelEjemplo(): string[] {
  return readFileSync(EJEMPLO, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.split("=")[0]!.trim());
}

/**
 * `NODE_ENV` no se declara: la pone Node/Next, no el despliegue. Ponerla en el
 * ejemplo invitaría a fijarla a mano, que es como se termina sirviendo un build
 * de desarrollo en producción.
 */
const LAS_PONE_EL_RUNTIME = new Set(["NODE_ENV"]);

describe("§46 — los secretos que no pueden entrar al servidor web", () => {
  const PROHIBIDOS: [string, RegExp, string][] = [
    [
      "SUPABASE_ACCESS_TOKEN",
      /SUPABASE_ACCESS_TOKEN/,
      "corre SQL arbitrario sobre toda la cuenta; vive en .env.deploy y solo lo leen los scripts",
    ],
    [
      "service_role",
      /service[_-]?role/i,
      "se salta toda la RLS; la app se apoya en la RLS para separar un hogar de otro",
    ],
  ];

  for (const [nombre, patron, porque] of PROHIBIDOS) {
    it(`\`${nombre}\` no aparece en el código de producción de web/src (${porque})`, () => {
      // SOLO código de producción. Los tests SÍ nombran los dos secretos, y a
      // propósito: `estado-produccion.test.ts` comprueba que el script se niegue
      // sin token, y `superficie.test.ts` prohíbe `service_role` en la frontera
      // del asistente. Prohibir la PALABRA en los tests dejaría al repo sin
      // forma de probar que el secreto está prohibido.
      const ofensas: string[] = [];
      for (const archivo of fuentes(SRC)) {
        if (archivo === YO || /\.test\.tsx?$/.test(archivo)) continue;
        const fuente = readFileSync(archivo, "utf8");
        fuente.split("\n").forEach((linea, i) => {
          if (patron.test(linea)) ofensas.push(`${rel(archivo)}:${i + 1} · ${linea.trim().slice(0, 80)}`);
        });
      }
      expect(ofensas).toEqual([]);
    });
  }

  it("no hay NINGÚN valor con forma de credencial de verdad, ni en los tests", () => {
    // El test de arriba mira el NOMBRE; éste mira la FORMA. Un token pegado en
    // un fixture no lleva su nombre al lado, y ése es el que de verdad se filtra.
    //   sbp_ + 40 hex  — token de la Management API de Supabase.
    //   eyJ… . eyJ… .  — un JWT; la clave `service_role` viaja así.
    const ofensas: string[] = [];
    for (const archivo of DONDE_BUSCAR()) {
      if (archivo === YO) continue;
      const fuente = readFileSync(archivo, "utf8");
      for (const [que, forma] of FORMAS) {
        fuente.split("\n").forEach((linea, i) => {
          if (forma.test(linea)) ofensas.push(`${rel(archivo)}:${i + 1} · ${que}`);
        });
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("CADA forma reconoce un ejemplo sintético, y rechaza uno de mentira", () => {
    /**
     * ESTE TEST EXISTE PORQUE UNA DE LAS FORMAS ESTUVO ROTA Y NADIE SE ENTERÓ.
     *
     * Al agregar los formatos nuevos, el `\b` del patrón entró al archivo
     * como un byte de retroceso (0x08) en vez de como el borde de palabra del
     * regex. El patrón quedó en `/<retroceso>sb_secret_.../`, que no calza con
     * nada — y el barrido siguió en VERDE, porque un guardián que no encuentra
     * nada y uno que no puede encontrar nada se ven exactamente igual. El byte
     * ni siquiera se veía con `grep`: hizo falta `cat -A`.
     *
     * Un test que sólo dice "el repo está limpio" nunca distingue esos dos
     * casos. Éste sí: le da a cada patrón algo que TIENE que reconocer.
     */
    const positivos: [string, string][] = [
      ["token de la Management API", `sbp_${"a1".repeat(20)}`],
      ["JWT", `eyJ${"a".repeat(40)}.${"b".repeat(40)}.firma`],
      // Se arman por pedazos para que el propio barrido no acuse a este archivo.
      ["llave SECRETA", "sb" + "_secret_" + "x".repeat(24)],
      ["llave publicable", "sb" + "_publishable_" + "y".repeat(24)],
    ];
    expect(positivos.length, "hay formas sin ejemplo: agregarlo").toBe(FORMAS.length);

    for (const [que, ejemplo] of positivos) {
      expect(
        FORMAS.some(([, forma]) => forma.test(ejemplo)),
        `ninguna forma reconoce ${que}: el patrón está roto`,
      ).toBe(true);
    }

    // Y que no acuse de más: los fixtures del repo usan tokens de mentira.
    for (const falso of ["sbp_estonoesuntokendeverdad", "sb" + "_secret_" + "corta", "const x = 1;"]) {
      expect(
        FORMAS.some(([, forma]) => forma.test(falso)),
        `una forma acusa a "${falso}", que no es una credencial`,
      ).toBe(false);
    }
  });

  it("el barrido mira scripts/ y web/e2e/, no sólo la app", () => {
    // Sin esto, alguien vuelve a acotar el alcance a `web/src` y el barrido
    // sigue en verde sobre un repo con un token en `scripts/` — que es donde
    // vive el único código que manipula la llave de servicio de verdad.
    const mirados = DONDE_BUSCAR().map(rel);
    expect(mirados.some((r) => r.startsWith("scripts/")), "scripts/ salió del barrido").toBe(true);
    expect(mirados.some((r) => r.startsWith("web/e2e/")), "web/e2e/ salió del barrido").toBe(true);
    expect(mirados.length, "el barrido se quedó sin archivos").toBeGreaterThan(100);
  });

  it("ninguna variable NEXT_PUBLIC_* tiene nombre de secreto", () => {
    // Un `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` no está "mal configurado":
    // está PUBLICADO, y ningún despliegue posterior lo puede despublicar.
    const HUELE_A_SECRETO = /(SERVICE_ROLE|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE)/;
    const ofensas: string[] = [];
    for (const [nombre, archivos] of variablesQueLeeLaApp()) {
      if (nombre.startsWith("NEXT_PUBLIC_") && HUELE_A_SECRETO.test(nombre)) {
        ofensas.push(`${nombre} — leída en ${archivos.join(", ")}`);
      }
    }
    for (const nombre of nombresDelEjemplo()) {
      if (nombre.startsWith("NEXT_PUBLIC_") && HUELE_A_SECRETO.test(nombre)) {
        ofensas.push(`${nombre} — declarada en web/.env.example`);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("el guardián de NEXT_PUBLIC_* reconoce un nombre de secreto de verdad", () => {
    // Sin esto, un error en la expresión regular dejaría los dos tests de arriba
    // en verde para siempre sin mirar nada.
    const HUELE_A_SECRETO = /(SERVICE_ROLE|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE)/;
    expect(HUELE_A_SECRETO.test("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(HUELE_A_SECRETO.test("NEXT_PUBLIC_SUPABASE_ANON_KEY")).toBe(false);
  });
});

describe("§46 — los archivos con valores no entran a git", () => {
  const gitignore = () => readFileSync(path.join(RAIZ, ".gitignore"), "utf8").split("\n").map((l) => l.trim());

  it("`.env.deploy` está ignorado", () => {
    expect(gitignore()).toContain(".env.deploy");
  });

  it("todo `.env*.local` está ignorado", () => {
    expect(gitignore()).toContain(".env*.local");
  });

  it("`.env.example` NO está ignorado: es el contrato y va versionado", () => {
    const patrones = gitignore().filter((l) => l.length > 0 && !l.startsWith("#"));
    // Un `.env*` a secas se comería también al ejemplo y nadie sabría qué
    // variables hay que poner.
    expect(patrones).not.toContain(".env*");
    expect(patrones).not.toContain("*.env");
    expect(patrones).not.toContain(".env.example");
  });
});

describe("§46 — `.env.example` está al día", () => {
  it("declara exactamente las variables que el código lee", () => {
    const leidas = [...variablesQueLeeLaApp().keys()].filter((v) => !LAS_PONE_EL_RUNTIME.has(v));
    const declaradas = nombresDelEjemplo();
    // Faltar es peor que sobrar —un despliegue sin la variable se cae en
    // producción— pero las dos se dicen, porque una que sobra es una que alguien
    // va a poner creyendo que sirve para algo.
    expect(declaradas.filter((v) => !leidas.includes(v)), "declaradas y no leídas").toEqual([]);
    expect(leidas.filter((v) => !declaradas.includes(v)), "leídas y no declaradas").toEqual([]);
  });

  it("no trae ni un valor: es un ejemplo, no una copia del `.env.local`", () => {
    const conValor = readFileSync(EJEMPLO, "utf8")
      .split("\n")
      .map((l, i) => [l.trim(), i + 1] as const)
      .filter(([l]) => l.length > 0 && !l.startsWith("#"))
      .filter(([l]) => l.split("=").slice(1).join("=").trim().length > 0)
      .map(([l, n]) => `${n}: ${l.split("=")[0]}`);
    expect(conValor).toEqual([]);
  });
});
