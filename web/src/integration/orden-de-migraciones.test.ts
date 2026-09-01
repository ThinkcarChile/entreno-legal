import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN: el ORDEN de la cadena y el ESTADO de producción tienen un dueño cada
 * uno, y todo lo demás —la guía, el README y el script de CI— son lectores.
 *
 * Esto existe porque `docs/setup-supabase.md` llegó a decir «en orden numérico»
 * y a entregar dos bucles copiables (`for f in supabase/migrations/*.sql` y un
 * `Get-ChildItem | Sort-Object Name`). Ese NO es el orden de aplicación de este
 * repo: la 0036 va DESPUÉS de la 0037, porque cuando se escribió, las 0033-0035
 * y la 0037 ya estaban puestas en producción.
 *
 * Y `scripts/aplicar-migracion.mjs --pendientes` llegó a deducir por su cuenta
 * qué tenía puesto producción, leyendo los .sql y adivinando un testigo por
 * migración, mientras al lado se construía el libro `supabase/estado-produccion.json`
 * con testigos probados uno por uno en PGlite. Los dos mecanismos ya discrepaban
 * en 0004, 0010, 0019, 0028, 0031 y 0034. Dos dueños del mismo dato es
 * exactamente cómo el repo y producción se separaron sin que nada lo notara.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ ESTE ARCHIVO EJECUTA EN VEZ DE LEER
 *
 * La primera versión se conformaba con buscar textos: que el aplicador
 * CONTUVIERA «spawnSync» y «verificar-estado-produccion.mjs», que la guía
 * CONTUVIERA «harness.ts». Eso vigila la ortografía del último bug, no la
 * propiedad. Se demostró: dejando el `spawnSync` vivo pero inalcanzable (un
 * `return` antes) y devolviendo una lista inventada de pendientes, los nueve
 * tests seguían verdes. Y mientras tanto `scripts/db-test.sh` —el job `db` de
 * CI, que corre en cada push— aplicaba la cadena con el mismo `for` sobre el
 * glob que la guía acababa de prohibir, sin que nada mirara para allá.
 *
 * Ahora al aplicador se le PREGUNTA (se corre `--pendientes` y se compara su
 * salida y su código con los del verificador corrido a solas) y a
 * `scripts/db-test.sh` se le PREGUNTA (se corre `--imprimir-orden` y se compara
 * la secuencia con la que declara el arnés). Un guardián que reconoce la forma
 * del último bug no sirve para el siguiente.
 * ---------------------------------------------------------------------------
 */

const RAIZ = path.resolve(__dirname, "../../..");
const GUIA = path.join(RAIZ, "docs", "setup-supabase.md");
const LEEME = path.join(RAIZ, "web", "README.md");
const APLICADOR = path.join(RAIZ, "scripts", "aplicar-migracion.mjs");
const DUENO_DEL_ORDEN = path.join(RAIZ, "scripts", "poner-al-dia.mjs");
const DUENO_DEL_ESTADO = path.join(RAIZ, "scripts", "verificar-estado-produccion.mjs");
const SCRIPT_DE_CI = path.join(RAIZ, "scripts", "db-test.sh");
const DIR_MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const ARNES = path.join(__dirname, "harness.ts");

/** Los documentos de instalación. Todos son lectores; ninguno dicta el orden. */
const DOCUMENTOS: Array<{ nombre: string; ruta: string }> = [
  { nombre: "docs/setup-supabase.md", ruta: GUIA },
  { nombre: "web/README.md", ruta: LEEME },
];

const leer = (archivo: string): string => readFileSync(archivo, "utf8");

/** Tope de los subprocesos, y tope del test: el segundo más alto que el primero. */
const TOPE_SUBPROCESO_MS = 45_000;
const TOPE_TEST_MS = 60_000;

interface Corrida {
  estado: number;
  stdout: string;
  stderr: string;
}

/**
 * Corre un proceso hijo y devuelve su veredicto, o revienta diciendo POR QUÉ no
 * hay veredicto.
 *
 * UNKNOWN != ZERO también acá: un proceso que no arrancó, o al que matamos por
 * el tope, no trae código de salida. Comparar ese `null` contra el esperado deja
 * una máquina cargada indistinguible de un guardián roto — que es justo lo que
 * pasó: una corrida de nueve salió roja sin que nadie pudiera atribuirla, porque
 * estos subprocesos vivían con el tope de 5 s de vitest por defecto mientras
 * seis forks levantaban su propio PostgreSQL al lado.
 */
function correr(comando: string, args: string[], extraEnv: Record<string, string> = {}): Corrida {
  const r = spawnSync(comando, args, {
    encoding: "utf8",
    cwd: RAIZ,
    timeout: TOPE_SUBPROCESO_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, ...extraEnv },
  });
  if (r.error) {
    throw new Error(`No pude correr «${comando} ${args.join(" ")}»: ${r.error.message}`);
  }
  if (typeof r.status !== "number") {
    throw new Error(
      `«${comando} ${args.join(" ")}» terminó sin código de salida (señal ${
        r.signal ?? "desconocida"
      }). No se sabe cómo le fue, así que no se da por bueno ni por malo.`,
    );
  }
  return { estado: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Comentarios fuera antes de buscar.
 *
 * Un guardián que se conforma con lo escrito en un comentario no guarda nada: el
 * encabezado del aplicador CUENTA lo que hacía antes («llegó a imprimir "Para
 * aplicarlas, en este orden"», «readdirSync().sort()»), y esa memoria tiene que
 * poder quedarse escrita sin que este test la confunda con código vivo.
 */
function sinComentarios(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Los bloques cercados de un .md: lo único del documento que alguien copia y pega. */
function bloquesDeCodigo(md: string): string[] {
  return [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/**
 * Frases de un documento, POR FRASE y no por línea.
 *
 * En un .md un párrafo entero es una sola línea, y una instrucción vieja se
 * esconde perfectamente adentro de un párrafo que más abajo la niega. Se
 * demostró con la mutación: reponer «aplicar `migrations/*.sql` (SQL editor o
 * `supabase db push`)» al principio del párrafo del README pasaba inadvertido
 * mientras el guardián miraba la línea completa, porque el resto del párrafo
 * decía «no». La unidad de una instrucción es la frase.
 */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.:;!?])\s+|\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * Las frases donde el documento NOMBRA algo prohibido sin negarlo, o sea donde
 * lo ofrece como camino. Nombrarlo para decir que no sirve es justamente lo que
 * estos documentos tienen que hacer.
 */
function ofrecidas(texto: string, prohibido: RegExp): string[] {
  const niega = /\bno\b|\bnunca\b|\bjam[aá]s\b|\bning[uú]n[ao]?\b|\bsin\b|\bni\b/i;
  return frases(texto).filter((f) => prohibido.test(f) && !niega.test(f));
}

/** Una lista del arnés, leída con la MISMA expresión que usan los dos scripts. */
function listaDelArnes(nombre: string, carpeta: string): string[] {
  const bloque = leer(ARNES).match(new RegExp(`const ${nombre}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  const cuerpo = bloque?.[1];
  if (cuerpo === undefined) {
    throw new Error(
      `No pude leer la lista ${nombre} del arnés con la misma expresión que usan ` +
        "scripts/poner-al-dia.mjs y scripts/db-test.sh. Si la lista cambió de forma, esos dos " +
        "se quedan sin orden y hay que actualizarlos a ellos también.",
    );
  }
  const patron = new RegExp(`"supabase/${carpeta}/([^"]+)"`, "g");
  return [...cuerpo.matchAll(patron)].map((m) => m[1] ?? "");
}

const ordenDelArnes = (): string[] => listaDelArnes("MIGRACIONES", "migrations");
const seedsDelArnes = (): string[] => listaDelArnes("SEEDS", "seed");

const numeroDe = (archivo: string): string => archivo.slice(0, 4);

/** Pares consecutivos donde el número BAJA: la prueba viva de que el orden no es el alfabético. */
function inversiones(orden: string[]): Array<{ antes: string; despues: string }> {
  const pares: Array<{ antes: string; despues: string }> = [];
  for (let i = 1; i < orden.length; i += 1) {
    const previa = orden[i - 1];
    const actual = orden[i];
    if (previa === undefined || actual === undefined) continue;
    if (numeroDe(actual) < numeroDe(previa)) {
      pares.push({ antes: numeroDe(previa), despues: numeroDe(actual) });
    }
  }
  return pares;
}

/**
 * La secuencia COMPLETA que le corresponde aplicar al script de CI: la cadena
 * del arnés, después las migraciones que están en el disco y el arnés todavía no
 * nombra —ahí las aplican también sus propias pruebas, sobre la base completa— y
 * al final los seeds en el orden de `SEEDS`.
 */
function secuenciaEsperada(): string[] {
  const cadena = ordenDelArnes();
  const huerfanas = readdirSync(DIR_MIGRACIONES)
    .filter((f) => f.endsWith(".sql") && !cadena.includes(f))
    .sort();
  return [
    ...cadena.map((f) => `supabase/migrations/${f}`),
    ...huerfanas.map((f) => `supabase/migrations/${f}`),
    ...seedsDelArnes().map((f) => `supabase/seed/${f}`),
  ];
}

/** Deja una copia del arnés con una lista renombrada, para ver si el lector se planta. */
function arnesMutilado(antes: string, despues: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arnes-mutilado-"));
  const copia = path.join(dir, "harness.ts");
  const texto = leer(ARNES);
  if (!texto.includes(antes)) {
    throw new Error(`El arnés ya no contiene «${antes}»: este guardián quedó mirando a otro lado.`);
  }
  writeFileSync(copia, texto.replace(antes, despues), "utf8");
  return copia;
}

describe("el orden de la cadena tiene un solo dueño", () => {
  it("el arnés declara un orden que NO es el alfabético", () => {
    const orden = ordenDelArnes();
    expect(orden.length).toBeGreaterThan(30);

    // Si algún día esto se vuelve alfabético, el test cae y hay que revisar la
    // guía y los dos scripts: media docena de comentarios advierten de esta
    // inversión y quedarían mintiendo.
    expect(inversiones(orden).length).toBeGreaterThan(0);
    expect(orden).not.toEqual([...orden].sort());
  });

  it("ningún documento OFRECE aplicar la cadena por nombre de archivo", () => {
    // Los documentos SÍ nombran estas formas, para decir que no sirven; lo que
    // no puede haber es una que se ofrezca como camino.
    const porNombre =
      /migrations[/\\]\*\.sql|seed[/\\]\*\.sql|Sort-Object|Get-ChildItem|readdir|\bls\s+supabase/i;
    for (const doc of DOCUMENTOS) {
      const texto = leer(doc.ruta);
      expect(
        bloquesDeCodigo(texto).filter((b) => porNombre.test(b)),
        `${doc.nombre} tiene un comando copiable que ordena por nombre`,
      ).toEqual([]);
      expect(
        ofrecidas(texto, porNombre),
        `${doc.nombre} ofrece aplicar la cadena por nombre de archivo`,
      ).toEqual([]);
    }
  });

  it("ningún documento manda a la CLI de Supabase, que este repo no usa", () => {
    // El README decía «SQL editor o `supabase db push`». Ese camino no existe
    // acá: no hay `supabase/config.toml` ni nada aplicado por la CLI, todo va
    // por la Management API. Un runbook que nombra una herramienta que el repo
    // no tiene manda a pelearse con una instalación que no va a servir de nada.
    expect(existsSync(path.join(RAIZ, "supabase", "config.toml"))).toBe(false);

    const cli = /supabase\s+(db\s+(push|reset|pull)|migration\s+up|link)/i;
    for (const doc of DOCUMENTOS) {
      const texto = leer(doc.ruta);
      expect(
        bloquesDeCodigo(texto).filter((b) => cli.test(b)),
        `${doc.nombre} tiene un comando copiable de la CLI de Supabase`,
      ).toEqual([]);
      expect(ofrecidas(texto, cli), `${doc.nombre} ofrece la CLI de Supabase como camino`).toEqual(
        [],
      );
    }
  });

  it("todo script que nombra un documento existe de verdad", () => {
    for (const doc of DOCUMENTOS) {
      const nombrados = [...leer(doc.ruta).matchAll(/scripts\/[\w.-]+\.(?:mjs|sh|ts)/g)].map(
        (m) => m[0],
      );
      expect(nombrados.length, `${doc.nombre} no nombra ningún script`).toBeGreaterThan(0);
      for (const s of new Set(nombrados)) {
        expect(existsSync(path.join(RAIZ, s)), `${doc.nombre} nombra ${s}, que no existe`).toBe(
          true,
        );
      }
    }
  });

  it("la guía manda al dueño del orden y explica la inversión que hoy tiene la cadena", () => {
    const guia = leer(GUIA);
    expect(guia).toContain("web/src/integration/harness.ts");
    expect(guia).toContain("MIGRACIONES");
    expect(guia).toContain("scripts/poner-al-dia.mjs");
    expect(existsSync(DUENO_DEL_ORDEN)).toBe(true);

    const parrafos = guia.split(/\r?\n\s*\r?\n/);
    for (const { antes, despues } of inversiones(ordenDelArnes())) {
      const explicado = parrafos.some(
        (p) => p.includes(antes) && p.includes(despues) && /despu[eé]s/i.test(p),
      );
      expect(explicado, `la guía no dice que la ${despues} va DESPUÉS de la ${antes}`).toBe(true);
    }
  });

  it("el aplicador no dicta orden: no lee el directorio ni ordena nada", () => {
    const codigo = sinComentarios(leer(APLICADOR));
    for (const prohibido of ["readdirSync", ".sort(", "en este orden"]) {
      expect(codigo, `el aplicador volvió a ordenar la cadena (${prohibido})`).not.toContain(
        prohibido,
      );
    }
  });
});

describe("el script de CI aplica la MISMA cadena que el arnés", () => {
  it(
    "la secuencia que imprime db-test.sh es, archivo por archivo, la que declara el arnés",
    () => {
      // Se le PREGUNTA al script, no se le lee el código: si mañana vuelve el
      // `for` sobre el glob, esta comparación cae, porque el glob pone la 0036
      // antes que la 0037 y la biblioteca de recetas antes que su seed.
      const r = correr("bash", [SCRIPT_DE_CI, "--imprimir-orden"]);
      expect(r.estado, `db-test.sh --imprimir-orden falló:\n${r.stderr}`).toBe(0);

      const esperada = secuenciaEsperada();

      // Que lo esperado NO sea el alfabético: si lo fuera, esta comparación
      // pasaría con cualquier glob y no probaría nada.
      expect(esperada).not.toEqual([...esperada].sort());
      const i36 = esperada.indexOf("supabase/migrations/0036_foodlog_plan_vs_reality.sql");
      const i37 = esperada.indexOf("supabase/migrations/0037_invitacion_no_cruza_hogares.sql");
      expect(i37).toBeGreaterThanOrEqual(0);
      expect(i36).toBeGreaterThan(i37);
      const iSeed = esperada.indexOf("supabase/seed/dev_recipes_seed.sql");
      const iBiblioteca = esperada.indexOf("supabase/seed/dev_recipes_biblioteca.sql");
      expect(iSeed).toBeGreaterThanOrEqual(0);
      expect(iBiblioteca).toBeGreaterThan(iSeed);

      expect(r.stdout.trim().split(/\r?\n/)).toEqual(esperada);
    },
    TOPE_TEST_MS,
  );

  it(
    "sin la lista MIGRACIONES del arnés, db-test.sh se planta en vez de ordenar por nombre",
    () => {
      const copia = arnesMutilado("const MIGRACIONES = [", "const MIGRACIONES_RENOMBRADA = [");
      const r = correr("bash", [SCRIPT_DE_CI, "--imprimir-orden", copia]);
      expect(r.estado, "db-test.sh siguió adelante sin poder leer el orden").not.toBe(0);
      expect(r.stderr).toContain("MIGRACIONES");
      // Ni media secuencia: una lista a medias se aplica igual y deja la base a
      // medio migrar, que es peor que no correr nada.
      expect(r.stdout.trim()).toBe("");
    },
    TOPE_TEST_MS,
  );

  it(
    "sin la lista SEEDS del arnés, db-test.sh tampoco inventa el orden de los seeds",
    () => {
      const copia = arnesMutilado("const SEEDS = [", "const SEEDS_RENOMBRADA = [");
      const r = correr("bash", [SCRIPT_DE_CI, "--imprimir-orden", copia]);
      expect(r.estado).not.toBe(0);
      expect(r.stderr).toContain("SEEDS");
      expect(r.stdout.trim()).toBe("");
    },
    TOPE_TEST_MS,
  );

  it(
    "sin arnés no hay orden: db-test.sh no cae al alfabético",
    () => {
      const r = correr("bash", [SCRIPT_DE_CI, "--imprimir-orden", path.join(RAIZ, "no-existe.ts")]);
      expect(r.estado).not.toBe(0);
      expect(r.stdout.trim()).toBe("");
    },
    TOPE_TEST_MS,
  );
});

/**
 * Un retrato del esquema: columnas, funciones, políticas y restricciones de
 * `public` y `app`. Lo que sobrevive a la cadena, no el camino que tomó.
 */
const RETRATO_DEL_ESQUEMA = `
  select 'columna' as clase, table_schema||'.'||table_name||'.'||column_name||':'||data_type as objeto
    from information_schema.columns where table_schema in ('public','app')
  union all
  select 'funcion', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','app')
  union all
  select 'politica', schemaname||'.'||tablename||'.'||policyname
    from pg_policies where schemaname in ('public','app')
  union all
  select 'restriccion', c.conrelid::regclass::text||'.'||c.conname
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname in ('public','app')
  order by 1, 2
`;

async function retratoTrasAplicar(orden: string[]): Promise<string[]> {
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
  try {
    await db.exec(readFileSync(path.join(RAIZ, "supabase", "tests", "auth_stub.sql"), "utf8"));
    for (const archivo of orden) {
      await db.exec(readFileSync(path.join(DIR_MIGRACIONES, archivo), "utf8"));
    }
    const r = await db.query<{ clase: string; objeto: string }>(RETRATO_DEL_ESQUEMA);
    return r.rows.map((f) => `${f.clase} ${f.objeto}`);
  } finally {
    await db.close();
  }
}

describe("lo que la guía afirma del orden alfabético es verdad hoy", () => {
  it(
    "las dos secuencias dejan el MISMO esquema: la alfabética está sin probar, no rota",
    async () => {
      // La guía decía que contra una base recién creada el orden alfabético «sí
      // se nota». No se nota: la 0036 y la 0037 no comparten un solo objeto. La
      // guía ahora dice la verdad —es una secuencia que ninguna prueba ejercita,
      // y el orden del arnés es de procedencia— y esta prueba la sostiene
      // APLICANDO las dos cadenas, no leyendo el párrafo.
      //
      // El día que dos migraciones sí compartan un objeto, esto se pone rojo
      // primero: ahí la alfabética deja de estar sin probar y pasa a estar rota,
      // y hay que reescribir ese párrafo de docs/setup-supabase.md antes de que
      // alguien lo siga con el runbook en la mano.
      const cadena = ordenDelArnes();
      const alfabetica = [...cadena].sort();
      expect(cadena, "la cadena YA es alfabética: esta comparación no probaría nada").not.toEqual(
        alfabetica,
      );

      const conElArnes = await retratoTrasAplicar(cadena);
      const conElAlfabetico = await retratoTrasAplicar(alfabetica);

      expect(conElArnes.length).toBeGreaterThan(1000);
      expect(
        conElAlfabetico,
        "las dos secuencias ya NO dejan el mismo esquema: el párrafo de docs/setup-supabase.md " +
          "que dice que hoy no se nota quedó mintiendo, y el orden alfabético pasó de no " +
          "probado a roto",
      ).toEqual(conElArnes);
    },
    TOPE_TEST_MS,
  );
});

describe("el estado de producción tiene un solo dueño", () => {
  it("el aplicador no deduce testigos: no le pregunta nada al catálogo de la base", () => {
    const codigo = sinComentarios(leer(APLICADOR));
    // Así se pregunta «¿qué objetos tiene esta base?». Este script no lo hace:
    // aplica el archivo que le nombran y punto. La única consulta que arma es la
    // de --check (current_database + version), que no mira el esquema.
    const preguntaPorElEsquema =
      /pg_temp|pg_catalog|information_schema|pg_class|pg_proc|to_regclass|coalesce/i;
    expect(preguntaPorElEsquema.test(codigo)).toBe(false);
  });

  it(
    "--pendientes no contesta él: devuelve la salida y el código del verificador, tal cual",
    () => {
      expect(existsSync(DUENO_DEL_ESTADO)).toBe(true);

      // Sin token el verificador corta ANTES de tocar la red: la comparación es
      // determinista y no depende de que la máquina tenga un .env.deploy ni de
      // que Supabase conteste. `""` no es nullish, así que gana sobre el archivo.
      const sinToken = { SUPABASE_ACCESS_TOKEN: "" };
      const dueno = correr(process.execPath, [DUENO_DEL_ESTADO], sinToken);
      const brazo = correr(process.execPath, [APLICADOR, "--pendientes"], sinToken);

      // Si el propio dueño no dijera nada, comparar contra él no probaría nada.
      expect(dueno.estado, "el verificador no dio un veredicto que comparar").not.toBe(0);
      expect(dueno.stderr.length).toBeGreaterThan(0);

      // LA PROPIEDAD: el aplicador no agrega ni traduce ningún veredicto sobre
      // este dato. Por stdout sale lo del verificador y nada más; por stderr
      // sale el aviso de que está delegando y TERMINA con lo del verificador; y
      // el código de salida es el suyo, sin reinterpretar.
      //
      // Con esto, dejar el spawnSync vivo pero inalcanzable —la mutación con la
      // que el guardián de texto se dejó pasar— cae acá: la lista inventada
      // aparece en stdout y el código deja de ser el del verificador.
      expect(brazo.stdout).toBe(dueno.stdout);
      expect(
        brazo.stderr.endsWith(dueno.stderr),
        `--pendientes no terminó con la respuesta del verificador:\n${brazo.stderr}`,
      ).toBe(true);
      expect(brazo.estado).toBe(dueno.estado);
      expect(brazo.stderr).toContain("verificar-estado-produccion.mjs");
    },
    TOPE_TEST_MS,
  );

  it("la guía no le enseña a nadie a preguntar el estado con --pendientes", () => {
    const copiables = bloquesDeCodigo(leer(GUIA));
    expect(copiables.filter((b) => b.includes("--pendientes"))).toEqual([]);
    expect(leer(GUIA)).toContain("verificar-estado-produccion.mjs");
  });
});

describe("el aplicador termina sin reventar", () => {
  it("no llama a process.exit()", () => {
    // process.exit() con el socket de fetch abierto revienta libuv en Windows
    // («!(handle->flags & UV_HANDLE_CLOSING)»): el proceso muere con 127 y se
    // pierde el código que el script quería devolver. Quien lo llama desde
    // afuera —poner-al-dia.mjs -- no puede distinguir «falló la migración» de
    // «reventó el proceso», y terminó juzgando por el texto impreso.
    expect(sinComentarios(leer(APLICADOR))).not.toContain("process.exit(");
  });

  it(
    "sin argumentos explica el uso, sale con 1 y no deja una aserción de libuv",
    () => {
      const r = correr(process.execPath, [APLICADOR]);
      const salida = `${r.stdout}${r.stderr}`;
      expect(salida).toContain("Uso: node scripts/aplicar-migracion.mjs");
      expect(salida).not.toContain("Assertion failed");
      expect(r.estado).toBe(1);
    },
    TOPE_TEST_MS,
  );
});
