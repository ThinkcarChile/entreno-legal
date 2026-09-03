import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRACIONES } from "./harness";

/**
 * EL BOOTSTRAP DE STAGING, POR SUS PIEZAS, Y LOS SCRIPTS CON `--ref`, CORRIDOS.
 *
 * Staging NO existe todavía (2026-09-02: la organización tiene un solo proyecto,
 * producción), así que el camino vivo del bootstrap no se puede correr. Lo que
 * sí se puede —y es lo que impide que el día que exista se aprenda a golpes—
 * es probar lo que decide sin red: el plan (qué se aplica y en qué orden), las
 * guardas (ref de producción, hogares ajenos, desconocidas), el diff de Auth, y
 * que los cuatro scripts que el bootstrap reutiliza aceptan `--ref` SIN cambiar
 * lo que hacen sin él.
 *
 * Nada de acá toca la red: la Management API se reemplaza por un servidor de
 * mentira en 127.0.0.1 (misma técnica que respaldo-camino-real.test.ts), y los
 * caminos que se niegan lo hacen ANTES de cualquier `fetch`.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const SCRIPTS = path.join(RAIZ, "scripts");
const BOOTSTRAP = path.join(SCRIPTS, "staging-bootstrap.mjs");
const APLICADOR = path.join(SCRIPTS, "aplicar-migracion.mjs");
const PONER_AL_DIA = path.join(SCRIPTS, "poner-al-dia.mjs");
const RECETARIO = path.join(SCRIPTS, "publicar-recetario.mjs");
const VERIFICADOR = path.join(SCRIPTS, "verificar-estado-produccion.mjs");
const ENV_STAGING = path.join(RAIZ, "web", ".env.staging.local");
const LIBRO = path.join(RAIZ, "supabase", "estado-produccion.json");

const PRODUCCION_DE_LABORATORIO = "proyectodelaboratorio";
const URL_DE_LABORATORIO = `https://${PRODUCCION_DE_LABORATORIO}.supabase.co`;
const STAGING_DE_LABORATORIO = "stagingdelaboratorio";

type Estado = "PRESENTE" | "AUSENTE" | "DESCONOCIDO";

interface ModuloBootstrap {
  NOMBRES: Record<string, string>;
  VARIABLES_E2E: string[];
  extraerArgumentos: (argv: string[]) => { ref: string | null; enSeco: boolean; desconocidasComoAusentes: boolean };
  refDeUrl: (url: unknown) => string | null;
  ordenDelArnes: (texto: string) => string[];
  motivoParaNoTocar: (x: { refStaging: string | null; refProduccion: string | null }) => string | null;
  clasificarCadena: (
    orden: string[],
    entradas: [string, unknown][],
    presentes: Map<string, boolean>,
  ) => Map<string, Estado>;
  planDeMigraciones: (
    orden: string[],
    estados: Map<string, Estado>,
    opciones?: { desconocidasComoAusentes?: boolean },
  ) => { plan: string[]; notas: string[] };
  hogaresAjenos: (nombres: string[], propios?: string[]) => string[];
  configAuthDeseada: (baseUrl: string) => { site_url: string; uri_allow_list: string[]; mailer_autoconfirm: boolean };
  planDeAuth: (
    actual: Record<string, unknown>,
    deseada: { site_url: string; uri_allow_list: string[]; mailer_autoconfirm: boolean },
  ) => Record<string, unknown> | null;
}

const bootstrap = (await import(pathToFileURL(BOOTSTRAP).href)) as ModuloBootstrap;

/** Tope de los subprocesos y del test (el segundo más alto, como en orden-de-migraciones). */
const TOPE_SUBPROCESO_MS = 45_000;
const TOPE_TEST_MS = 60_000;

interface Corrida {
  estado: number;
  stdout: string;
  stderr: string;
  texto: string;
}

function correr(args: string[], extraEnv: Record<string, string> = {}): Corrida {
  const r = spawnSync(process.execPath, args, {
    cwd: RAIZ,
    encoding: "utf8",
    timeout: TOPE_SUBPROCESO_MS,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      // Fijos y falsos: ningún camino de acá puede llegar al proyecto real.
      SUPABASE_ACCESS_TOKEN: "sbp_estonoesuntokendeverdad",
      NEXT_PUBLIC_SUPABASE_URL: URL_DE_LABORATORIO,
      STAGING_PROJECT_REF: "",
      NODE_OPTIONS: "",
      ...extraEnv,
    },
  });
  if (r.error) throw new Error(`No pude correr «node ${args.join(" ")}»: ${r.error.message}`);
  if (typeof r.status !== "number") {
    throw new Error(`«node ${args.join(" ")}» terminó sin código de salida (señal ${r.signal ?? "desconocida"}).`);
  }
  return { estado: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", texto: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Lo que jamás puede acompañar a un mensaje de estos scripts. */
function sinVolcado(texto: string) {
  expect(texto).not.toContain("Assertion failed");
  expect(texto).not.toContain("UV_HANDLE_CLOSING");
  expect(texto).not.toContain("at ModuleJob.run");
}

// ---------------------------------------------------------------------------
// Piezas puras
// ---------------------------------------------------------------------------

describe("los argumentos del bootstrap", () => {
  it("lee --ref en sus dos formas y saca el valor de la lista", () => {
    expect(bootstrap.extraerArgumentos(["--ref", "abc", "--en-seco"])).toEqual({
      ref: "abc",
      enSeco: true,
      desconocidasComoAusentes: false,
    });
    expect(bootstrap.extraerArgumentos(["--ref=abc"]).ref).toBe("abc");
  });

  it("un --ref sin valor CORTA en vez de caer a producción", () => {
    expect(() => bootstrap.extraerArgumentos(["--ref"])).toThrow(/necesita el ref/);
    expect(() => bootstrap.extraerArgumentos(["--ref", "--en-seco"])).toThrow(/necesita el ref/);
    expect(() => bootstrap.extraerArgumentos(["--ref", "ABC"])).toThrow(/forma de un ref/);
  });

  it("una opción que no existe se rechaza con nombre", () => {
    expect(() => bootstrap.extraerArgumentos(["--aplicar"])).toThrow(/Opción desconocida: --aplicar/);
  });

  it("deduce el ref de una URL pública, y null de cualquier otra cosa", () => {
    expect(bootstrap.refDeUrl("https://abc123.supabase.co")).toBe("abc123");
    expect(bootstrap.refDeUrl("")).toBeNull();
    expect(bootstrap.refDeUrl(null)).toBeNull();
    expect(bootstrap.refDeUrl("https://abc123.supabase.co.evil.com")).toBe("abc123");
  });
});

describe("el orden lo pone el arnés", () => {
  it("el bootstrap lee EXACTAMENTE la lista MIGRACIONES del arnés", () => {
    const texto = readFileSync(path.join(__dirname, "harness.ts"), "utf8");
    const leida = bootstrap.ordenDelArnes(texto);
    expect(leida).toEqual(MIGRACIONES.map((m) => m.replace("supabase/migrations/", "")));
    // Y ese orden no es el alfabético (la 0036 va después de la 0037).
    expect(leida.indexOf("0036_foodlog_plan_vs_reality.sql")).toBeGreaterThan(
      leida.indexOf("0037_invitacion_no_cruza_hogares.sql"),
    );
  });

  it("sin la lista, no hay orden y se dice", () => {
    expect(() => bootstrap.ordenDelArnes("const OTRA = [];")).toThrow(/MIGRACIONES/);
  });
});

describe("la guarda del ref va antes que todo", () => {
  it("sin ref no se construye nada: staging no es un valor por defecto", () => {
    expect(bootstrap.motivoParaNoTocar({ refStaging: null, refProduccion: "prod" })).toMatch(/No sé cuál es el proyecto de staging/);
  });

  it("el ref de producción se corta aunque lo hayan escrito a mano", () => {
    const motivo = bootstrap.motivoParaNoTocar({ refStaging: "prod", refProduccion: "prod" });
    expect(motivo).toMatch(/ES EL DE PRODUCCIÓN/);
  });

  it("otro ref pasa", () => {
    expect(bootstrap.motivoParaNoTocar({ refStaging: "staging", refProduccion: "prod" })).toBeNull();
  });

  it("un hogar que el script no creó deja el proyecto intocable", () => {
    const { NOMBRES } = bootstrap;
    expect(bootstrap.hogaresAjenos([NOMBRES.hogarAB!, NOMBRES.hogarAjeno!])).toEqual([]);
    expect(bootstrap.hogaresAjenos([NOMBRES.hogarAB!, "Familia Pérez"])).toEqual(["Familia Pérez"]);
  });
});

describe("el plan de migraciones", () => {
  const orden = ["0001_a.sql", "0002_b.sql", "0003_c.sql", "0004_d.sql"];
  const estados = (...xs: Estado[]) => new Map(orden.map((f, i) => [f, xs[i]!] as const));

  it("clasifica por NÚMERO contra el libro y las respuestas de los testigos", () => {
    const entradas: [string, unknown][] = [
      ["0001_a.sql", {}],
      ["0002_renombrada.sql", {}], // sufijo distinto: empareja igual
      ["0003_c.sql", {}],
      // 0004 no está en el libro
    ];
    const presentes = new Map([
      ["0001_a.sql", true],
      ["0002_renombrada.sql", true],
      ["0003_c.sql", false],
    ]);
    const clasificado = bootstrap.clasificarCadena(orden, entradas, presentes);
    expect([...clasificado.values()]).toEqual(["PRESENTE", "PRESENTE", "AUSENTE", "DESCONOCIDO"]);
  });

  it("base vacía (la primera AUSENTE): se aplica todo, desconocidas incluidas, y se dice", () => {
    const { plan, notas } = bootstrap.planDeMigraciones(orden, estados("AUSENTE", "AUSENTE", "DESCONOCIDO", "AUSENTE"));
    expect(plan).toEqual(orden);
    expect(notas.join(" ")).toMatch(/Base vacía/);
    expect(notas.join(" ")).toContain("0003_c.sql");
  });

  it("un prefijo puesto: se aplica lo que sigue, en orden", () => {
    const { plan, notas } = bootstrap.planDeMigraciones(orden, estados("PRESENTE", "PRESENTE", "AUSENTE", "AUSENTE"));
    expect(plan).toEqual(["0003_c.sql", "0004_d.sql"]);
    expect(notas).toEqual([]);
  });

  it("todo puesto: plan vacío (idempotente)", () => {
    expect(bootstrap.planDeMigraciones(orden, estados("PRESENTE", "PRESENTE", "PRESENTE", "PRESENTE")).plan).toEqual([]);
  });

  it("un HUECO antes de una puesta es una base a medio migrar por otro camino: se corta", () => {
    expect(() => bootstrap.planDeMigraciones(orden, estados("PRESENTE", "AUSENTE", "PRESENTE", "AUSENTE"))).toThrow(
      /A MEDIO MIGRAR/,
    );
  });

  it("una DESCONOCIDA antes de la última puesta se infiere presente, y la inferencia queda escrita", () => {
    const { plan, notas } = bootstrap.planDeMigraciones(orden, estados("PRESENTE", "DESCONOCIDO", "PRESENTE", "AUSENTE"));
    expect(plan).toEqual(["0004_d.sql"]);
    expect(notas.join(" ")).toMatch(/inferido/);
    expect(notas.join(" ")).toContain("0002_b.sql");
  });

  it("una DESCONOCIDA después de la última puesta NO se aplica a ciegas: UNKNOWN no es AUSENTE", () => {
    expect(() => bootstrap.planDeMigraciones(orden, estados("PRESENTE", "PRESENTE", "DESCONOCIDO", "AUSENTE"))).toThrow(
      /UNKNOWN no es AUSENTE/,
    );
  });

  it("…salvo que se pida por escrito, y entonces queda dicho en las notas", () => {
    const { plan, notas } = bootstrap.planDeMigraciones(orden, estados("PRESENTE", "PRESENTE", "DESCONOCIDO", "AUSENTE"), {
      desconocidasComoAusentes: true,
    });
    expect(plan).toEqual(["0003_c.sql", "0004_d.sql"]);
    expect(notas.join(" ")).toMatch(/--desconocidas-como-ausentes/);
  });

  it("si ni siquiera la primera tiene testigo, no se sabe nada y no se aplica nada", () => {
    expect(() => bootstrap.planDeMigraciones(orden, estados("DESCONOCIDO", "DESCONOCIDO", "DESCONOCIDO", "DESCONOCIDO"))).toThrow(
      /No sé si 0001_a.sql está puesta/,
    );
  });
});

describe("la configuración de Auth de staging", () => {
  it("pide site_url = E2E_BASE_URL, redirecciones y autoconfirmación (solo staging)", () => {
    const deseada = bootstrap.configAuthDeseada("https://staging.ejemplo.cl/");
    expect(deseada.site_url).toBe("https://staging.ejemplo.cl");
    expect(deseada.uri_allow_list).toEqual(["https://staging.ejemplo.cl/**", "http://localhost:3000/**"]);
    expect(deseada.mailer_autoconfirm).toBe(true);
  });

  it("si ya está como se pide, no hay nada que cambiar (idempotente)", () => {
    const deseada = bootstrap.configAuthDeseada("https://staging.ejemplo.cl");
    const actual = {
      site_url: "https://staging.ejemplo.cl",
      uri_allow_list: "https://staging.ejemplo.cl/**,http://localhost:3000/**",
      mailer_autoconfirm: true,
    };
    expect(bootstrap.planDeAuth(actual, deseada)).toBeNull();
  });

  it("COMPLETA la lista de redirecciones sin borrar lo que alguien agregó a mano", () => {
    const deseada = bootstrap.configAuthDeseada("https://staging.ejemplo.cl");
    const actual = {
      site_url: "http://localhost:3000",
      uri_allow_list: "https://*-preview.vercel.app/**",
      mailer_autoconfirm: false,
    };
    const cambios = bootstrap.planDeAuth(actual, deseada);
    expect(cambios).toEqual({
      site_url: "https://staging.ejemplo.cl",
      uri_allow_list: "https://*-preview.vercel.app/**,https://staging.ejemplo.cl/**,http://localhost:3000/**",
      mailer_autoconfirm: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Los scripts, corridos de verdad, sin red
// ---------------------------------------------------------------------------

/**
 * Un Management API de mentira en 127.0.0.1. Contesta lo mínimo que cada camino
 * necesita para llegar hasta donde el test quiere mirar. Todo lo demás es 500.
 */
function preloadDeApiFalsa(): string {
  return `
import http from "node:http";

function responderSql(sql) {
  if (sql.includes("current_database()")) return [{ db: "postgres", v: "PostgreSQL de mentira" }];
  if (sql.includes("as sin_factor")) return [{ alimentos: "7", recetas: "2", sin_factor: "0" }];
  if (sql.includes("information_schema.tables")) return [{ hay: false }];
  if (sql.includes("pg_temp.testigo_presente")) {
    // Una fila por migración nombrada en el VALUES, todas AUSENTES: base vacía.
    const archivos = [...sql.matchAll(/\\('(\\d{4}_[^']+\\.sql)'/g)].map((m) => m[1]);
    return archivos.sort().map((archivo) => ({ archivo, presente: false }));
  }
  return null;
}

const servidor = http.createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://127.0.0.1");
    let salida = null;
    if (/\\/projects\\/[a-z0-9]+$/.test(u.pathname) && req.method === "GET") {
      salida = { name: "Mesa familiar STAGING (de mentira)", region: "sa-east-1", status: "ACTIVE_HEALTHY" };
    } else if (u.pathname.endsWith("/config/auth") && req.method === "GET") {
      salida = { site_url: "http://localhost:3000", uri_allow_list: "", mailer_autoconfirm: false };
    } else if (u.pathname.endsWith("/database/query")) {
      let sql = "";
      try { sql = JSON.parse(cuerpo).query ?? ""; } catch { /* cuerpo ilegible */ }
      salida = responderSql(sql);
    }
    res.writeHead(salida === null ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(salida === null ? { message: "camino no previsto por la API de mentira: " + req.method + " " + u.pathname } : salida));
  });
});

await new Promise((listo) => servidor.listen(0, "127.0.0.1", listo));
const puerto = servidor.address().port;
servidor.unref();

const fetchReal = globalThis.fetch;
globalThis.fetch = (recurso, init) => {
  const u = new URL(String(recurso));
  if (u.hostname === "api.supabase.com") {
    return fetchReal("http://127.0.0.1:" + puerto + u.pathname + u.search, init);
  }
  throw new Error("fetch fuera de la API de mentira: " + u.hostname);
};
`;
}

describe("los scripts corridos de verdad, contra una Management API de mentira", () => {
  let taller = "";
  let preload = "";

  beforeAll(() => {
    taller = mkdtempSync(path.join(os.tmpdir(), "staging-bootstrap-"));
    preload = path.join(taller, "api-falsa.mjs");
    writeFileSync(preload, preloadDeApiFalsa(), "utf8");
  });

  afterAll(() => {
    if (taller) rmSync(taller, { recursive: true, force: true });
  });

  const conApiFalsa = (script: string, args: string[], extraEnv: Record<string, string> = {}) =>
    correr(["--import", pathToFileURL(preload).href, script, ...args], extraEnv);

  it(
    "aplicar-migracion.mjs SIN --ref sigue yendo al proyecto de NEXT_PUBLIC_SUPABASE_URL",
    () => {
      const r = conApiFalsa(APLICADOR, ["--check"]);
      expect(r.estado, r.texto).toBe(0);
      expect(r.stdout).toContain(`Conectado a ${PRODUCCION_DE_LABORATORIO} (NEXT_PUBLIC_SUPABASE_URL)`);
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "aplicar-migracion.mjs --ref va al proyecto nombrado, y lo dice",
    () => {
      const r = conApiFalsa(APLICADOR, ["--ref", STAGING_DE_LABORATORIO, "--check"]);
      expect(r.estado, r.texto).toBe(0);
      expect(r.stdout).toContain(`Conectado a ${STAGING_DE_LABORATORIO} (--ref)`);
      expect(r.stdout).not.toContain(PRODUCCION_DE_LABORATORIO);
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "aplicar-migracion.mjs --ref sin valor corta ANTES de tocar la red",
    () => {
      // Sin API falsa: si llegara a un fetch, no habría a dónde ir y se notaría.
      const r = correr([APLICADOR, "--ref"]);
      expect(r.estado).toBe(1);
      expect(r.stderr).toMatch(/--ref necesita el ref/);
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "poner-al-dia.mjs --ref reenvía el ref al aplicador y no lo confunde con una migración",
    () => {
      // poner-al-dia lanza `node aplicar-migracion.mjs` como hijo: la API falsa
      // tiene que llegarle por NODE_OPTIONS, no por el --import del padre.
      const r = correr([PONER_AL_DIA, "--ref", STAGING_DE_LABORATORIO, "0001"], {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      });
      expect(r.estado, r.texto).toBe(0);
      expect(r.stdout).toContain(`Proyecto: ${STAGING_DE_LABORATORIO} (por --ref`);
      expect(r.stdout).toContain(`Conectado a ${STAGING_DE_LABORATORIO} (--ref)`);
      // El plan es la 0001 y nada más: el ref no se coló como número.
      const plan = r.stdout.split("Plan (")[1] ?? "";
      expect(plan).toContain("0001_family.sql");
      expect(plan).not.toContain(STAGING_DE_LABORATORIO);
      expect(r.stdout).toContain("Esto fue sólo la revisión");
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "poner-al-dia.mjs --ref --pendientes se niega: el libro describe producción",
    () => {
      const r = correr([PONER_AL_DIA, "--ref", STAGING_DE_LABORATORIO, "--pendientes"]);
      expect(r.estado).toBe(1);
      expect(r.stderr).toMatch(/--pendientes no se combina con --ref/);
      // Se negó ANTES de conectar: no hay marca de conexión.
      expect(r.stdout).not.toContain("Conectando");
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "publicar-recetario.mjs --ref revisa el proyecto nombrado y NO lo llama producción",
    () => {
      const r = conApiFalsa(RECETARIO, ["--ref", STAGING_DE_LABORATORIO]);
      expect(r.estado, r.texto).toBe(0);
      expect(r.stdout).toContain(`Proyecto ${STAGING_DE_LABORATORIO} (--ref) ahora: 7 alimentos · 2 recetas publicadas`);
      expect(r.stdout).not.toContain("Producción ahora");
      expect(r.stdout).toContain("no se escribió nada");
    },
    TOPE_TEST_MS,
  );

  it(
    "publicar-recetario.mjs SIN --ref sigue diciendo Producción",
    () => {
      const r = conApiFalsa(RECETARIO, []);
      expect(r.estado, r.texto).toBe(0);
      expect(r.stdout).toContain("Producción ahora: 7 alimentos · 2 recetas publicadas");
    },
    TOPE_TEST_MS,
  );

  it(
    "verificar-estado-produccion.mjs --ref --escribir se niega antes de preguntar nada",
    () => {
      // Sin API falsa a propósito: si preguntara, el fetch no tendría a dónde ir.
      const r = correr([VERIFICADOR, "--ref", STAGING_DE_LABORATORIO, "--escribir"]);
      expect(r.estado).toBe(1);
      expect(r.stderr).toMatch(/--escribir se niega/);
      const proyectoDelLibro = (JSON.parse(readFileSync(LIBRO, "utf8")) as { proyecto: string }).proyecto;
      expect(r.stderr).toContain(proyectoDelLibro);
      expect(r.stdout).not.toContain("Preguntándole");
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "el bootstrap con el ref de PRODUCCIÓN se corta antes de cualquier red, también en seco",
    () => {
      const r = correr([BOOTSTRAP, "--ref", PRODUCCION_DE_LABORATORIO, "--en-seco"]);
      expect(r.estado).toBe(1);
      expect(r.stderr).toMatch(/ES EL DE PRODUCCIÓN/);
      expect(r.stdout).not.toContain("PLAN");
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "el bootstrap --en-seco sin ref imprime el plan completo, en el orden del arnés, sin red",
    () => {
      // Si en esta máquina ya hay un staging configurado, el archivo define el
      // ref y este camino deja de ser "sin red": se salta con motivo.
      if (existsSync(ENV_STAGING)) return;
      const r = correr([BOOTSTRAP, "--en-seco"]);
      expect(r.estado, r.texto).toBe(0);
      expect(r.stdout).toContain("PLAN (en seco, sin tocar nada)");
      const primera = MIGRACIONES[0]!.replace("supabase/migrations/", "");
      const ultima = MIGRACIONES[MIGRACIONES.length - 1]!.replace("supabase/migrations/", "");
      expect(r.stdout).toContain(primera);
      expect(r.stdout).toContain(ultima);
      expect(r.stdout.indexOf("0037_invitacion_no_cruza_hogares.sql")).toBeLessThan(
        r.stdout.indexOf("0036_foodlog_plan_vs_reality.sql"),
      );
      expect(r.stdout).toContain("mailer_autoconfirm = true   (SOLO staging; en producción va false)");
      for (const v of bootstrap.VARIABLES_E2E) expect(r.stdout).toContain(v);
      expect(r.stdout).toContain("Nada se tocó.");
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );

  it(
    "el bootstrap --ref --en-seco contra un proyecto VACÍO planea la cadena entera y no escribe",
    () => {
      const r = conApiFalsa(BOOTSTRAP, ["--ref", STAGING_DE_LABORATORIO, "--en-seco"], {
        E2E_BASE_URL: "https://staging.ejemplo.cl",
      });
      expect(r.estado, r.texto).toBe(0);
      expect(r.stdout).toContain("Mesa familiar STAGING (de mentira)");
      const total = MIGRACIONES.length;
      expect(r.stdout).toContain(`Migraciones: 0 puestas, ${total} por aplicar.`);
      // NO se afirma la nota "Base vacía" acá. Esa nota solo aparece cuando hay
      // migraciones SIN testigo en el libro, y cuando se escribió este test las
      // había: dos stubs vacíos que reservaban número para agentes en paralelo.
      // Al borrarlos, la nota desapareció y el test se puso rojo sin que nada se
      // hubiera roto — estaba clavado a un estado transitorio del repositorio.
      // La rama ya la cubre, y mejor, la prueba unitaria de `planDeMigraciones`
      // con una cadena sintética donde el DESCONOCIDO se declara a mano.
      //
      // Lo que sí se afirma es lo contrario, que es la propiedad sana: con todas
      // las migraciones declarando su testigo, el plan no tiene nada que excusar.
      expect(r.stdout).not.toMatch(/Base vacía/);
      expect(r.stdout).toContain("Auth: cambiaría site_url, uri_allow_list, mailer_autoconfirm");
      expect(r.stdout).toContain("EN SECO: no se escribió nada.");
      sinVolcado(r.texto);
    },
    TOPE_TEST_MS,
  );
});
