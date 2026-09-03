import { readFileSync, readdirSync, statSync } from "node:fs";
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

function fuentes(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...fuentes(ruta));
    else if (/\.tsx?$/.test(nombre)) out.push(ruta);
  }
  return out;
}

const rel = (p: string) => path.relative(RAIZ, p).split(path.sep).join("/");

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
    const FORMAS: [string, RegExp][] = [
      ["token de la Management API (sbp_…)", /\bsbp_[0-9a-f]{40}\b/],
      ["JWT largo (anon o service_role)", /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\./],
    ];
    const ofensas: string[] = [];
    for (const archivo of [...fuentes(SRC), EJEMPLO]) {
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

  it("el guardián de FORMAS reconoce una credencial de verdad", () => {
    // Los fixtures del repo usan tokens de mentira ("sbp_estonoesuntokendeverdad"),
    // que NO tienen la forma real. Si el patrón estuviera mal escrito, el test de
    // arriba pasaría en verde sobre un repo con el token de verdad adentro.
    const sbp = /\bsbp_[0-9a-f]{40}\b/;
    expect(sbp.test(`sbp_${"a1".repeat(20)}`)).toBe(true);
    expect(sbp.test("sbp_estonoesuntokendeverdad")).toBe(false);
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
