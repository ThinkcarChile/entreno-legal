import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { MIGRACIONES, recorrerCadena } from "./harness";
import {
  archivosDeMigracion,
  AUSENCIA_DEL_OBJETO,
  cargarLibroDeProduccion,
  consultaDelTestigo,
  esAusenciaDelObjeto,
  LibroSchema,
  motivoDeVigenciaInvalida,
  numeroDeMigracion,
  respuestaDelTestigo,
  soloLoQueProduccionTiene,
  TestigoSinRespuesta,
  VIGENCIA_MAXIMA_EN_DIAS,
} from "./estado-produccion";

const RAIZ = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(RAIZ, "scripts", "verificar-estado-produccion.mjs");
const DIR_MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const LIBRO = path.join(RAIZ, "supabase", "estado-produccion.json");

/** Lo que el escritor del libro exporta, y que estos tests EJECUTAN. */
interface EntradaCruda {
  estado?: unknown;
  sha256?: unknown;
  testigo?: unknown;
  prueba?: unknown;
  solo_en_produccion?: unknown;
}

interface ModuloDelEscritor {
  DIAS_DE_VIGENCIA: number;
  numeroDeMigracion: (nombre: string) => string | null;
  emparejarLibroConDisco: (
    entradas: [string, EntradaCruda][],
    archivosEnDisco: string[],
  ) => { rutaPorClave: Map<string, string>; problemas: string[] };
  validarFormaDelLibro: (crudo: unknown) => string[];
  sqlDeTodosLosTestigos: (entradas: [string, { testigo: string }][]) => string;
  clasificarFilas: (
    filas: { archivo: string; presente: unknown }[],
    entradas: [string, { testigo: string }][],
  ) => { real: Map<string, boolean>; mudos: string[] };
  anotarEnElLibro: (
    desacuerdos: { archivo: string; entrada: EntradaCruda; enLaBase: boolean }[],
    rutaPorClave: Map<string, string>,
    dirMigraciones?: string,
  ) => void;
  literal: (s: unknown) => string;
}

/**
 * El escritor se IMPORTA, no se lee.
 *
 * Todo lo que este archivo afirma del `.mjs` —el emparejamiento por número, la
 * validación de la forma del libro, el SQL de los testigos, la clasificación de
 * las filas— se afirma corriéndolo. Importarlo no dispara nada: el script mira
 * `process.argv[1]` y sólo corre `principal()` cuando lo invocan directo.
 */
const escritor = (await import(pathToFileURL(SCRIPT).href)) as ModuloDelEscritor;

/**
 * EL LIBRO DE PRODUCCIÓN SE PRUEBA A SÍ MISMO.
 *
 * `supabase/estado-produccion.json` es lo que el gate de paridad usa para saber
 * qué tiene puesto el Supabase real, y todo el mecanismo se apoya en una sola
 * propiedad: que el TESTIGO de cada migración discrimine. Si el testigo de la
 * 0022 ya era verdadero antes de la 0022, entonces preguntarle a la base real
 * respondería "aplicada" para algo que no lo está, y volveríamos al falso verde
 * por otra puerta — esta vez una más difícil de ver.
 *
 * Acá se replaya la cadena completa parando en cada escalón y se exige, para
 * cada migración: FALSO antes, VERDADERO después. Un testigo mal elegido no
 * pasa de acá.
 */

async function evaluar(db: PGlite, archivo: string, expresion: string): Promise<boolean> {
  try {
    const r = await db.query<{ presente: unknown }>(consultaDelTestigo(expresion));
    // Nada de `?.presente === true`: eso aplasta NULL y "no vino fila" contra
    // false, y las dos son un desconocido, no un "no está aplicada".
    return respuestaDelTestigo(r.rows[0], archivo, expresion);
  } catch (e) {
    // "No existe la tabla / la función / la columna" es la respuesta correcta a
    // "¿ya está aplicada?" cuando todavía no lo está. No es tragarse un error:
    // la lista de códigos es cerrada y cualquier otro se propaga.
    if (esAusenciaDelObjeto(e)) return false;
    throw e;
  }
}

describe("el libro de estado de producción", () => {
  it("declara todas las migraciones del repo, y solo esas", () => {
    // Ojo: `cargarLibroDeProduccion` ya revienta si falta una o sobra otra.
    // Esta afirmación existe igual para que el rojo se lea acá, con nombre, y no
    // como un beforeAll caído en el archivo del gate.
    const libro = cargarLibroDeProduccion();
    expect(libro.entradas.map((e) => e.archivo)).toEqual(archivosDeMigracion());
    expect(libro.aplicadas.size + libro.pendientes.size).toBe(libro.entradas.length);
  });

  it("toda migración que producción tiene aplicada está en la cadena de los tests", () => {
    /**
     * La base contra la que el gate compara se ARMA replayando la cadena de
     * `MIGRACIONES`. Una migración declarada APLICADA que no esté ahí no se
     * replaya, así que sus objetos faltarían en la base "de producción" aunque
     * en producción existan: el gate rechazaría código que anda perfecto, y
     * nadie confía mucho tiempo en un gate que miente para el otro lado.
     *
     * Al revés no se exige: una PENDIENTE recién escrita puede estar en el disco
     * y todavía no en la cadena mientras alguien la termina. Eso no impide saber
     * qué tiene producción — no la tiene — que es lo único que este libro
     * promete. Igual queda DECLARADA, porque `cargarLibroDeProduccion` no deja
     * pasar una migración sin entrada.
     */
    const libro = cargarLibroDeProduccion();
    // Se compara por NÚMERO y no por nombre: `MIGRACIONES` puede traer un sufijo
    // viejo que `resolverMigracion()` resuelve igual (el número es el contrato),
    // y ese renombre no puede disfrazarse de "producción tiene algo fuera de la
    // cadena", que es un rojo distinto y grave.
    const enCadena = new Set(MIGRACIONES.map((r) => numeroDeMigracion(r)));
    const aplicadasFueraDeLaCadena = libro.entradas
      .filter((e) => e.estado === "APLICADA" && !enCadena.has(e.numero))
      .map((e) => e.archivo)
      .sort();
    expect(aplicadasFueraDeLaCadena).toEqual([]);
  });

  it(
    "cada testigo es falso ANTES de su migración y verdadero DESPUÉS",
    async () => {
      // Se empareja por NÚMERO: `MIGRACIONES` puede traer un sufijo viejo que
      // `resolverMigracion()` resuelve igual, y el libro tiene que resolver igual.
      const { porNumero } = cargarLibroDeProduccion();

      const mudos: string[] = []; // el testigo no se enciende con su migración
      const adelantados: string[] = []; // ya estaba encendido antes: no prueba nada
      const marcaDeMas: string[] = []; // dice no ser observable en local, y lo es

      await recorrerCadena(MIGRACIONES, async (db, ruta, momento) => {
        const numero = numeroDeMigracion(ruta);
        const entrada = numero === null ? undefined : porNumero.get(numero);
        if (!entrada) return; // el test de arriba ya se encarga de este caso
        const encendido = await evaluar(db, entrada.archivo, entrada.testigo);

        if (entrada.solo_en_produccion) {
          // A esta se le exige lo contrario, y con la misma dureza: que en local
          // NO cambie nada. Si algún día su testigo empieza a encenderse recién
          // con ella, la marca dejó de ser cierta y hay que sacarla.
          if (!encendido) marcaDeMas.push(`${entrada.archivo} (${momento}): ${entrada.prueba}`);
          return;
        }

        if (momento === "antes" && encendido) {
          adelantados.push(`${entrada.archivo}: ${entrada.prueba}`);
        }
        if (momento === "despues" && !encendido) {
          mudos.push(`${entrada.archivo}: ${entrada.prueba}`);
        }
      });

      expect(mudos).toEqual([]);
      expect(adelantados).toEqual([]);
      expect(marcaDeMas).toEqual([]);
    },
    120_000,
  );
});

describe("el método con el que se supo decide cuánto vale lo que dice el libro", () => {
  /**
   * `metodo` estuvo un tiempo validado por Zod y sin que nadie lo leyera: el
   * libro prometía por escrito distinguir un estado COMPROBADO de uno escrito a
   * mano, y después trataba los dos igual. Acá esa promesa tiene consecuencias.
   */
  it("un MANIFIESTO no puede reclamar la vigencia de una verificación en vivo", () => {
    const aMano = {
      metodo: "MANIFIESTO",
      verificadoEl: "2026-01-01",
      caducaEl: "2026-04-01", // 90 días: lo que sí aguanta una verificación real
    } as const;
    const motivo = motivoDeVigenciaInvalida(aMano, "2026-01-02");
    expect(motivo).toContain("MANIFIESTO");

    // Y la MISMA ventana, con el mismo día de hoy, es legítima si los estados
    // salieron de correr los testigos contra la base.
    expect(
      motivoDeVigenciaInvalida({ ...aMano, metodo: "TESTIGOS_EN_VIVO" }, "2026-01-02"),
    ).toBeNull();
  });

  it("dentro de su techo, un MANIFIESTO vale", () => {
    expect(
      motivoDeVigenciaInvalida(
        { metodo: "MANIFIESTO", verificadoEl: "2026-01-01", caducaEl: "2026-01-15" },
        "2026-01-10",
      ),
    ).toBeNull();
  });

  it("una verificación vencida no vale, la haya hecho quien la haya hecho", () => {
    for (const metodo of ["MANIFIESTO", "TESTIGOS_EN_VIVO"] as const) {
      expect(
        motivoDeVigenciaInvalida(
          { metodo, verificadoEl: "2026-01-01", caducaEl: "2026-01-10" },
          "2026-01-11",
        ),
      ).toContain("suposición");
    }
  });

  it("el libro de verdad respeta el techo de SU método", () => {
    const libro = cargarLibroDeProduccion();
    expect(
      motivoDeVigenciaInvalida(
        { metodo: libro.metodo, verificadoEl: libro.verificadoEl, caducaEl: libro.caducaEl },
        libro.verificadoEl,
      ),
    ).toBeNull();
  });

  it("el script escribe la vigencia que este módulo acepta", () => {
    // Dos números que tienen que ser el mismo y viven en archivos distintos: el
    // script anota `caduca_el` y este módulo lo audita. Si se separan, el script
    // escribe libros que el gate rechaza en el acto. Se comparan los VALORES
    // importados, no el texto de una declaración: `const DIAS_DE_VIGENCIA = 90`
    // escrito de cualquier otra forma —un `export const` con salto de línea, una
    // suma, un cálculo— dejaba al regex sin encontrar nada.
    expect(escritor.DIAS_DE_VIGENCIA).toBe(VIGENCIA_MAXIMA_EN_DIAS.TESTIGOS_EN_VIVO);
  });
});

/**
 * EL SQL QUE EL ESCRITOR LE MANDA A PRODUCCIÓN, CORRIDO CONTRA UN POSTGRES.
 *
 * Acá vivían dos guardias de texto, y los dos vigilaban la ORTOGRAFÍA del último
 * bug en vez de la propiedad:
 *
 *   · "no convierte el NULL en no aplicada" prohibía la cadena
 *     `coalesce(v_resultado`. El MISMO aplastamiento escrito en el select de
 *     afuera —`coalesce(pg_temp.testigo_presente(t.expresion), false)`— pasaba
 *     limpio, con el defecto entero vivo.
 *   · "atrapa exactamente los mismos SQLSTATE" leía el bloque `exception` con
 *     `/exception\s+when([\s\S]*?)then/`, que por no-codicioso se queda con el
 *     PRIMER handler. Agregarle un `when others then return false;` convertía
 *     cualquier error de Postgres en "todavía no aplicada" —justo lo que ese
 *     test decía impedir— sin que el regex se enterara.
 *
 * Lo que sigue no reconoce formas: genera el SQL con `sqlDeTodosLosTestigos()`,
 * lo CORRE contra PGlite con testigos de laboratorio y mira qué contesta. Un
 * aplastamiento del NULL, escrito donde sea, devuelve `false` donde el test
 * exige `null`; un `when others` de más devuelve `false` donde el test exige que
 * la consulta reviente.
 */
describe("el SQL de los testigos, ejecutado", () => {
  let db!: PGlite;

  beforeAll(async () => {
    // Se ESPERA a que la base esté arriba. Antes decía `db = new PGlite()` en un
    // callback síncrono: `beforeAll` se daba por cumplido con el arranque a
    // medias y el primer test empezaba a consultar encima del bootstrap. De ahí
    // salían los rojos que aparecían una corrida de cada tantas —siempre con
    // otro archivo de integración levantando su propio PostgreSQL al lado— y que
    // a solas no se reproducían nunca. Los demás archivos de integración ya
    // usaban `await PGlite.create(...)`; éste era el único que no.
    db = await PGlite.create();
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  /**
   * Un testigo de laboratorio por cada condición de ausencia, elegido para
   * disparar EXACTAMENTE ese SQLSTATE. La igualdad de claves de abajo es la que
   * impide que alguien agregue una sexta condición sin testigo que la ejercite.
   */
  const TESTIGOS_DE_LABORATORIO: Readonly<Record<string, string>> = {
    undefined_table: "exists(select 1 from tabla_que_no_existe)",
    undefined_function: "funcion_que_no_existe()",
    undefined_column: "columna_que_no_existe",
    undefined_object: "null::tipo_que_no_existe is null",
    invalid_schema_name: "esquema_inexistente.f()",
  };

  /** Errores que NO son "el objeto no existe": tienen que tumbar la corrida. */
  const ERRORES_DE_VERDAD: Readonly<Record<string, string>> = {
    "22012": "(1/0) = 1", // division_by_zero
    "22P02": "'no soy un numero'::int = 1", // invalid_text_representation
  };

  const filasDe = async (entradas: [string, { testigo: string }][]) => {
    const resultados = await db.exec(escritor.sqlDeTodosLosTestigos(entradas));
    const ultimo = resultados[resultados.length - 1];
    return (ultimo?.rows ?? []) as unknown as { archivo: string; presente: unknown }[];
  };

  it("hay un testigo de laboratorio por cada condición de ausencia declarada", () => {
    expect(Object.keys(TESTIGOS_DE_LABORATORIO).sort()).toEqual(
      Object.keys(AUSENCIA_DEL_OBJETO).sort(),
    );
  });

  it("cada testigo de laboratorio dispara el SQLSTATE que el módulo le atribuye", async () => {
    /**
     * Antes de exigirle nada al script, se comprueba que la tabla de códigos de
     * ESTE módulo dice la verdad: que `undefined_object` es de veras 42704 y no
     * un número copiado a mano. Sin esto, el test de abajo podría estar verde
     * midiendo contra una tabla equivocada.
     */
    for (const [condicion, testigo] of Object.entries(TESTIGOS_DE_LABORATORIO)) {
      let codigo: unknown = "(no reventó)";
      try {
        await db.query(consultaDelTestigo(testigo));
      } catch (e) {
        codigo = (e as { code?: unknown }).code;
        expect(esAusenciaDelObjeto(e), `${condicion}: ${testigo}`).toBe(true);
      }
      expect(codigo, `${condicion}: ${testigo}`).toBe(AUSENCIA_DEL_OBJETO[condicion]);
    }
  }, 60_000);

  it("una ausencia del objeto vuelve como FALSE, que es el dato 'todavía no aplicada'", async () => {
    const entradas: [string, { testigo: string }][] = Object.entries(TESTIGOS_DE_LABORATORIO)
      .map(([condicion, testigo]): [string, { testigo: string }] => [`${condicion}.sql`, { testigo }])
      .sort(([a], [b]) => a.localeCompare(b));
    const filas = await filasDe(entradas);
    expect(filas.map((f) => [f.archivo, f.presente])).toEqual(
      entradas.map(([archivo]) => [archivo, false]),
    );
  }, 60_000);

  it("un error que NO es ausencia tumba la corrida en vez de volver como FALSE", async () => {
    /**
     * Ésta es la propiedad que el regex del bloque `exception` no vigilaba. Un
     * `when others then return false;` haría que una división por cero se anote
     * como "producción no tiene esta migración": un error convertido en dato, en
     * la dirección que degrada APLICADA a PENDIENTE y deja al gate levantando
     * una base a la que le faltan objetos que producción sí tiene.
     */
    const codigosDeAusencia = new Set(Object.values(AUSENCIA_DEL_OBJETO));
    for (const [codigo, testigo] of Object.entries(ERRORES_DE_VERDAD)) {
      // Que el caso siga siendo un caso: si algún día alguien mete 22012 en la
      // lista de ausencias, este test tiene que gritar, no acomodarse.
      expect(codigosDeAusencia.has(codigo), `${codigo} no puede ser una ausencia`).toBe(false);
      await expect(filasDe([["x.sql", { testigo }]])).rejects.toThrow();
    }
  }, 60_000);

  it("el NULL del testigo sube como NULL, no aplastado a 'no aplicada'", async () => {
    /**
     * El `coalesce` iba en la dirección cómoda y por eso es tan fácil de volver
     * a escribir: convierte "el testigo no supo contestar" en el dato
     * "producción no la tiene". Se prueba mirando lo que la base DEVUELVE, así
     * que da lo mismo dónde se escriba el aplastamiento —dentro de la función,
     * en el select de afuera, en un `case`—: si aplasta, acá aparece `false`.
     *
     * El `coalesce` explícito en el TESTIGO de una entrada del libro no está
     * prohibido: ahí lo escribe alguien que justifica en `prueba` por qué ese
     * NULL sí es una ausencia. Lo que no puede es vivir en el motor.
     */
    const entradas: [string, { testigo: string }][] = [
      ["a_null.sql", { testigo: "true and null" }],
      ["b_falso.sql", { testigo: "1 = 2" }],
      ["c_verdadero.sql", { testigo: "1 = 1" }],
    ];
    const filas = await filasDe(entradas);
    expect(filas.map((f) => [f.archivo, f.presente])).toEqual([
      ["a_null.sql", null],
      ["b_falso.sql", false],
      ["c_verdadero.sql", true],
    ]);

    // Y lo que el script HACE con ese NULL: no lo anota. Va a `mudos`, y con
    // mudos la corrida se detiene sin escribir el libro.
    const { real, mudos } = escritor.clasificarFilas(filas, entradas);
    expect(mudos).toHaveLength(1);
    expect(mudos[0]).toContain("a_null.sql");
    expect(mudos[0]).toContain("NULL");
    expect([...real.entries()].sort()).toEqual([
      ["b_falso.sql", false],
      ["c_verdadero.sql", true],
    ]);
  }, 60_000);

  it("un testigo con comilla simple no rompe la sentencia", async () => {
    // `literal()` es lo único que separa un testigo del libro de una inyección
    // en la sentencia que se le manda a producción.
    const filas = await filasDe([["q.sql", { testigo: "'a''b' = 'a''b'" }]]);
    expect(filas).toEqual([{ archivo: "q.sql", presente: true }]);
  }, 60_000);
});

describe("el script que le pregunta a la base", () => {
  /**
   * Lo único que queda leyéndose como texto, y con una razón: la propiedad es
   * la AUSENCIA de una llamada en TODO el archivo —incluidos los caminos que
   * sólo se distinguen con un socket abierto contra api.supabase.com, que
   * ningún test puede montar acá—. Los códigos de salida sí se comprueban
   * corriendo el script de verdad, más abajo.
   *
   * Se le sacan los comentarios antes de mirarlo: si no, el comentario que
   * explica POR QUÉ `process.exit()` ya no está lo vuelve a "encontrar" en el
   * archivo y el rojo aparece con el arreglo puesto.
   */
  const fuente = readFileSync(SCRIPT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // comentario de bloque JS
    .replace(/^[ \t]*\/\/.*$/gm, " ") // comentario de línea JS
    .replace(/^[ \t]*--.*$/gm, " "); // comentario de línea SQL, dentro del template

  it("no corta el proceso con process.exit()", () => {
    /**
     * En Windows, `process.exit()` con el socket de `fetch` todavía abierto
     * revienta libuv con un assert y el código de salida se pierde (queda 127).
     * Estuvo arreglado SÓLO en el camino del informe, así que todos los caminos
     * de error —los que más importa leer— seguían muriendo mal: quien corría el
     * script veía 127 en vez del 1 ("no se pudo saber") o el 2 ("hay
     * desacuerdos"), y un código que no significa nada no se puede encadenar.
     */
    expect(fuente).not.toMatch(/process\s*(?:\.\s*exit\b|\[\s*["'`]exit)/);
    expect(fuente).toMatch(/process\s*\.\s*exitCode\s*=/);
  });
});

describe("el número es el contrato, no el sufijo", () => {
  /**
   * `resolverMigracion()` en harness.ts resuelve una migración por su prefijo de
   * cuatro dígitos porque "el sufijo descriptivo lo elige quien las escribe".
   * El libro indexaba por nombre completo, así que un renombre —cosa que pasa
   * mientras varios agentes escriben migraciones en paralelo— ponía el gate en
   * rojo diciendo "no se puede saber qué tiene producción" sin que producción
   * hubiera cambiado en nada. Ese rojo enseña a ignorar los rojos.
   */
  it("empareja una migración aplicada aunque el sufijo del archivo cambie", () => {
    const conOtroSufijo = "supabase/migrations/0001_como_se_llame_hoy.sql";
    expect(soloLoQueProduccionTiene([conOtroSufijo])).toEqual([conOtroSufijo]);
  });

  it("sigue reventando si el NÚMERO no está declarado", () => {
    expect(() => soloLoQueProduccionTiene(["supabase/migrations/9999_no_existe.sql"])).toThrow(
      /no.*declara/i,
    );
    expect(() => soloLoQueProduccionTiene(["supabase/migrations/sin_numero.sql"])).toThrow(
      /no.*declara/i,
    );
  });

  it("lee el número del nombre y declara cuando no hay", () => {
    expect(numeroDeMigracion("supabase/migrations/0038_foodlog_intake.sql")).toBe("0038");
    expect(numeroDeMigracion("0007_weekly_planning.sql")).toBe("0007");
    expect(numeroDeMigracion("weekly_planning.sql")).toBeNull();
    expect(numeroDeMigracion("007_corto.sql")).toBeNull();
  });

  it("el LECTOR y el ESCRITOR leen el mismo número del mismo nombre", () => {
    /**
     * Dos implementaciones de la misma regla en dos lenguajes. La correspondencia
     * no la sostiene un comentario: se corren las dos sobre los mismos nombres,
     * incluidos los bordes (sin número, tres dígitos, sin guión bajo, con ruta,
     * con separador de Windows).
     */
    const nombres = [
      "0001_family.sql",
      "supabase/migrations/0040_adaptive_reviews.sql",
      "supabase\\migrations\\0040_revisiones_adaptativas.sql",
      "0040_lo_que_sea.sql",
      "9999_no_existe.sql",
      "sin_numero.sql",
      "007_corto.sql",
      "00401_cinco_digitos.sql",
      "0001-guion.sql",
      "",
    ];
    for (const nombre of nombres) {
      expect(escritor.numeroDeMigracion(nombre), nombre).toBe(numeroDeMigracion(nombre));
    }
  });
});

/**
 * EL ESCRITOR EMPAREJA LIBRO Y DISCO POR NÚMERO, IGUAL QUE EL LECTOR.
 *
 * El arreglo del renombre quedó una vuelta entera puesto sólo en el lector: el
 * `.mjs` seguía emparejando por NOMBRE COMPLETO. Y el `.mjs` es el único
 * ESCRITOR del libro y el remedio al que apuntan todos los mensajes de error del
 * lector, así que un renombre de sufijo dejaba el gate diciendo "corre el
 * script" y el script negándose a correr —encima acusando "las migraciones
 * aplicadas están CONGELADAS" por una PENDIENTE que jamás se aplicó—.
 *
 * Se ejercita la función pura, y más abajo el script entero contra un árbol
 * simulado.
 */
describe("el escritor empareja libro y disco por número", () => {
  const entrada = (estado: string): EntradaCruda => ({
    estado,
    sha256: null,
    testigo: "true",
    prueba: "de laboratorio",
  });

  it("un renombre de sufijo empareja igual, y apunta al archivo del DISCO", () => {
    const { rutaPorClave, problemas } = escritor.emparejarLibroConDisco(
      [
        ["0001_family.sql", entrada("APLICADA")],
        ["0040_adaptive_reviews.sql", entrada("PENDIENTE")],
      ],
      ["0001_family.sql", "0040_revisiones_adaptativas.sql"],
    );
    expect(problemas).toEqual([]);
    expect(rutaPorClave.get("0001_family.sql")).toBe("0001_family.sql");
    // Lo que importa: la ruta es la del DISCO, no la clave del libro. De ahí
    // sale el sha256 que `--escribir` congela.
    expect(rutaPorClave.get("0040_adaptive_reviews.sql")).toBe("0040_revisiones_adaptativas.sql");
  });

  it("dos archivos con el mismo número es error ruidoso, no una elección al azar", () => {
    const { rutaPorClave, problemas } = escritor.emparejarLibroConDisco(
      [["0040_adaptive_reviews.sql", entrada("APLICADA")]],
      ["0040_adaptive_reviews.sql", "0040_revisiones_adaptativas.sql"],
    );
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain("0040");
    expect(problemas[0]).toContain("0040_revisiones_adaptativas.sql");
    // Y sobre todo: NO se eligió ninguno de los dos.
    expect(rutaPorClave.has("0040_adaptive_reviews.sql")).toBe(false);
  });

  it("un número sin archivo se acusa según lo que el libro declara, no siempre como congelada", () => {
    /**
     * El mensaje importa tanto como el rojo. Acusar "las migraciones aplicadas
     * están CONGELADAS: producción y el repo dejaron de ser lo mismo" por una
     * PENDIENTE con sha256 null y jamás aplicada es un rojo que enseña a
     * ignorar los rojos.
     */
    const pendiente = escritor.emparejarLibroConDisco(
      [["0040_adaptive_reviews.sql", entrada("PENDIENTE")]],
      [],
    ).problemas;
    expect(pendiente).toHaveLength(1);
    expect(pendiente[0]).toContain("0040");
    expect(pendiente[0]).not.toMatch(/CONGELAD/i);
    expect(pendiente[0]).not.toMatch(/producción la tiene/i);

    const aplicada = escritor.emparejarLibroConDisco(
      [["0036_meal_serving.sql", entrada("APLICADA")]],
      [],
    ).problemas;
    expect(aplicada).toHaveLength(1);
    expect(aplicada[0]).toMatch(/APLICADA/);
    expect(aplicada[0]).toMatch(/historial/i);
  });

  it("un archivo del disco que el libro no declara también detiene al escritor", () => {
    /**
     * La punta contraria del emparejamiento, y la que cierra el círculo: el
     * lector rechaza un libro al que le falta una migración del disco y manda a
     * correr el script. Si el script preguntara igual y anotara, escribiría un
     * libro que el lector vuelve a rechazar por lo mismo — el gate manda a
     * correr, el script escribe, el gate manda a correr. El script no puede
     * inventar el testigo, así que lo dice y se detiene.
     */
    const { problemas } = escritor.emparejarLibroConDisco(
      [["0001_family.sql", entrada("APLICADA")]],
      ["0001_family.sql", "0041_recien_escrita.sql"],
    );
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain("0041_recien_escrita.sql");
    expect(problemas[0]).toMatch(/testigo/i);
  });

  it("una clave del libro sin NNNN_ se declara, no se adivina", () => {
    const { rutaPorClave, problemas } = escritor.emparejarLibroConDisco(
      [["sin_numero.sql", entrada("PENDIENTE")]],
      ["sin_numero.sql"],
    );
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain("sin_numero.sql");
    expect(rutaPorClave.size).toBe(0);
  });

  it("al ANOTAR, el checksum sale del archivo del disco y no de la clave del libro", () => {
    /**
     * El segundo lugar donde el nombre importa, y el que quedó abierto una vuelta
     * más: `--escribir` congela el sha256 de una recién aplicada. Emparejar por
     * número arriba y volver a leer por la clave acá deja el mismo renombre
     * reventando justo en el camino que anota.
     *
     * Se le da una clave (el sufijo viejo) y un archivo de disco con OTRO nombre.
     * Leer por la clave no encuentra nada.
     */
    const dir = mkdtempSync(path.join(os.tmpdir(), "anotar-"));
    try {
      const contenido = "-- la 0040, con el sufijo nuevo\nselect 1;\n";
      writeFileSync(path.join(dir, "0040_revisiones_adaptativas.sql"), contenido);
      const entradaPendiente: EntradaCruda = {
        estado: "PENDIENTE",
        sha256: null,
        testigo: "true",
        prueba: "de laboratorio",
      };
      const yaCongelada: EntradaCruda = {
        estado: "PENDIENTE",
        sha256: "b".repeat(64),
        testigo: "true",
        prueba: "de laboratorio",
      };
      escritor.anotarEnElLibro(
        [
          { archivo: "0040_adaptive_reviews.sql", entrada: entradaPendiente, enLaBase: true },
          { archivo: "0040_adaptive_reviews.sql", entrada: yaCongelada, enLaBase: false },
        ],
        new Map([["0040_adaptive_reviews.sql", "0040_revisiones_adaptativas.sql"]]),
        dir,
      );
      expect(entradaPendiente.estado).toBe("APLICADA");
      expect(entradaPendiente.sha256).toBe(
        createHash("sha256").update(readFileSync(path.join(dir, "0040_revisiones_adaptativas.sql"))).digest("hex"),
      );
      // Y una que la base dice que NO tiene: se degrada a PENDIENTE y su
      // checksum congelado no se toca.
      expect(yaCongelada.estado).toBe("PENDIENTE");
      expect(yaCongelada.sha256).toBe("b".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no congela un checksum a ciegas cuando no sabe qué archivo es", () => {
    const entrada: EntradaCruda = {
      estado: "PENDIENTE",
      sha256: null,
      testigo: "true",
      prueba: "de laboratorio",
    };
    expect(() =>
      escritor.anotarEnElLibro(
        [{ archivo: "0040_adaptive_reviews.sql", entrada, enLaBase: true }],
        new Map(),
      ),
    ).toThrow(/0040_adaptive_reviews\.sql/);
  });

  it("el libro y las migraciones de verdad emparejan sin un solo problema", () => {
    const libro = JSON.parse(readFileSync(LIBRO, "utf8")) as {
      migraciones: Record<string, EntradaCruda>;
    };
    const { rutaPorClave, problemas } = escritor.emparejarLibroConDisco(
      Object.entries(libro.migraciones),
      archivosDeMigracion(),
    );
    expect(problemas).toEqual([]);
    expect([...rutaPorClave.values()].sort()).toEqual(archivosDeMigracion());
  });
});

/**
 * LA FORMA DEL LIBRO SE AUDITA EN LAS DOS PUNTAS, Y CON EL MISMO CONTRATO.
 *
 * El lector valida con Zod; el escritor no validaba nada. Una entrada sin
 * `testigo` llegaba a `literal()` como el texto "undefined", Postgres tiraba
 * 42703 (undefined_column), el bloque `exception` lo atrapaba como ausencia y el
 * libro malformado salía anotado como el DATO "producción no la tiene" — con
 * `--escribir`, degradando una APLICADA a PENDIENTE. ERROR != VACÍO también en
 * la entrada.
 *
 * El escritor no puede importar el Zod del lector: corre con `node` pelado,
 * fuera del toolchain de `web/`. Así que replica el contrato en JS puro, y que
 * los dos no se separen se sostiene acá: los MISMOS libros pasan por los DOS
 * validadores y tienen que recibir el MISMO veredicto.
 */
describe("la forma del libro: escritor y lector dicen lo mismo", () => {
  const entradaSana = {
    estado: "APLICADA",
    sha256: "a".repeat(64),
    testigo: "true",
    prueba: "por qué ese testigo y no otro",
  };
  const libroSano = {
    proyecto: "entreno-legal",
    verificado_el: "2026-01-01",
    caduca_el: "2026-04-01",
    metodo: "TESTIGOS_EN_VIVO",
    migraciones: { "0001_family.sql": entradaSana },
  };
  const con = (cambio: Record<string, unknown>) => ({ ...libroSano, ...cambio });
  const conEntrada = (cambio: Record<string, unknown>) =>
    con({ migraciones: { "0001_family.sql": { ...entradaSana, ...cambio } } });
  const sinCampo = (campo: string) => {
    const e: Record<string, unknown> = { ...entradaSana };
    delete e[campo];
    return con({ migraciones: { "0001_family.sql": e } });
  };

  const CASOS: [string, unknown, boolean][] = [
    ["el libro sano", libroSano, true],
    ["sha256 null en una pendiente", conEntrada({ estado: "PENDIENTE", sha256: null }), true],
    ["solo_en_produccion booleano", conEntrada({ solo_en_produccion: true }), true],
    ["migraciones vacío", con({ migraciones: {} }), true],
    ["sin testigo", sinCampo("testigo"), false],
    ["testigo vacío", conEntrada({ testigo: "" }), false],
    ["testigo que no es texto", conEntrada({ testigo: 7 }), false],
    ["sin prueba", sinCampo("prueba"), false],
    ["prueba vacía", conEntrada({ prueba: "" }), false],
    ["sin estado", sinCampo("estado"), false],
    ["estado inventado", conEntrada({ estado: "QUIZÁS" }), false],
    ["sin sha256", sinCampo("sha256"), false],
    ["sha256 que no es hexadecimal", conEntrada({ sha256: "no-es-un-sha" }), false],
    ["sha256 corto", conEntrada({ sha256: "abc123" }), false],
    ["solo_en_produccion que no es booleano", conEntrada({ solo_en_produccion: "sí" }), false],
    ["una entrada que es null", con({ migraciones: { "0001_family.sql": null } }), false],
    ["una entrada que es texto", con({ migraciones: { "0001_family.sql": "APLICADA" } }), false],
    ["migraciones que es un arreglo", con({ migraciones: [entradaSana] }), false],
    ["sin migraciones", con({ migraciones: undefined }), false],
    ["metodo inventado", con({ metodo: "RECUERDO" }), false],
    ["fecha al revés", con({ verificado_el: "01-01-2026" }), false],
    ["caduca_el que no es fecha", con({ caduca_el: "pronto" }), false],
    ["proyecto vacío", con({ proyecto: "" }), false],
    ["el libro es un arreglo", [libroSano], false],
    ["el libro es null", null, false],
    ["el libro es un número", 7, false],
  ];

  for (const [nombre, libro, valido] of CASOS) {
    it(`${nombre}: ${valido ? "lo aceptan los dos" : "lo rechazan los dos"}`, () => {
      const problemasDelEscritor = escritor.validarFormaDelLibro(libro);
      const veredictoDelLector = LibroSchema.safeParse(libro).success;
      // El veredicto del lector, primero: si esto se cae, el que cambió es el
      // contrato, y el escritor tiene que seguirlo.
      expect(veredictoDelLector, `lector · ${nombre}`).toBe(valido);
      expect(problemasDelEscritor.length === 0, `escritor · ${nombre}`).toBe(valido);
    });
  }

  it("el libro de verdad pasa por los dos validadores", () => {
    const crudo: unknown = JSON.parse(readFileSync(LIBRO, "utf8"));
    expect(escritor.validarFormaDelLibro(crudo)).toEqual([]);
    expect(LibroSchema.safeParse(crudo).success).toBe(true);
  });
});

/**
 * EL SCRIPT ENTERO, CORRIDO CONTRA UN ÁRBOL SIMULADO.
 *
 * Las funciones puras de arriba prueban las piezas; esto prueba que están
 * enchufadas. Se copia el script y `supabase/` a un directorio temporal, se le
 * hace al árbol la avería exacta que el crítico reprodujo, y se corre `node` de
 * verdad mirando el CÓDIGO DE SALIDA y lo que imprime. Ninguno de estos caminos
 * llega a la red: todos cortan antes del `fetch`.
 */
describe("el script corrido de verdad contra un árbol simulado", () => {
  let arbol = "";

  beforeAll(() => {
    arbol = mkdtempSync(path.join(os.tmpdir(), "libro-produccion-"));
    mkdirSync(path.join(arbol, "scripts"), { recursive: true });
    mkdirSync(path.join(arbol, "supabase", "migrations"), { recursive: true });
    copyFileSync(SCRIPT, path.join(arbol, "scripts", path.basename(SCRIPT)));
    for (const sql of archivosDeMigracion()) {
      copyFileSync(path.join(DIR_MIGRACIONES, sql), path.join(arbol, "supabase", "migrations", sql));
    }
    copyFileSync(LIBRO, path.join(arbol, "supabase", "estado-produccion.json"));
  });

  afterAll(() => {
    rmSync(arbol, { recursive: true, force: true });
  });

  const correr = () =>
    spawnSync(process.execPath, [path.join(arbol, "scripts", path.basename(SCRIPT))], {
      encoding: "utf8",
      env: {
        ...process.env,
        // Token y URL sintéticos: con forma válida para que el script pase los
        // dos primeros cortes, y sin que ningún camino de estos llegue al fetch.
        SUPABASE_ACCESS_TOKEN: "sbp_de_laboratorio",
        NEXT_PUBLIC_SUPABASE_URL: "https://proyectodelaboratorio.supabase.co",
      },
    });

  const libroDelArbol = () => path.join(arbol, "supabase", "estado-produccion.json");
  const restaurarLibro = () => copyFileSync(LIBRO, libroDelArbol());

  it("un renombre de sufijo NO lo detiene, y el checksum se calcula contra el disco", () => {
    /**
     * La reproducción del crítico, al pie: renombrar el sufijo de una migración
     * dejaba al lector en verde y al escritor negándose a correr. Para que el
     * script se detenga ANTES de la red sin que el renombre sea la causa, se le
     * ensucia OTRA migración: si el emparejamiento por número funciona, la única
     * queja es la de esa otra; si volviera a emparejar por nombre completo, la
     * queja sería sobre la renombrada.
     */
    const viejo = path.join(arbol, "supabase", "migrations", "0001_family.sql");
    const nuevo = path.join(arbol, "supabase", "migrations", "0001_familia_renombrada.sql");
    const sucia = path.join(arbol, "supabase", "migrations", "0002_catalog.sql");
    const original = readFileSync(sucia);
    renameSync(viejo, nuevo);
    appendFileSync(sucia, "\n-- una edición que no debió existir\n");
    try {
      const r = correr();
      expect(r.status, r.stderr).toBe(1); // 1 = "no se pudo saber"; 127 sería libuv
      expect(r.stderr).toContain("0002_catalog.sql");
      expect(r.stderr).toMatch(/CONGELADAS/);
      // Ni una palabra sobre la renombrada: emparejó por número.
      expect(r.stderr).not.toContain("0001_family.sql");
      expect(r.stderr).not.toContain("0001_familia_renombrada.sql");
      expect(r.stdout).not.toContain("Preguntándole");
    } finally {
      writeFileSync(sucia, original);
      renameSync(nuevo, viejo);
    }
  }, 60_000);

  it("dos archivos con el mismo número lo detienen, sin adivinar cuál", () => {
    const clon = path.join(arbol, "supabase", "migrations", "0001_familia_clonada.sql");
    copyFileSync(path.join(arbol, "supabase", "migrations", "0001_family.sql"), clon);
    try {
      const r = correr();
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("0001_familia_clonada.sql");
      expect(r.stdout).not.toContain("Preguntándole");
    } finally {
      rmSync(clon, { force: true });
    }
  }, 60_000);

  it("una migración que el libro no declara NO se arregla corriendo el script", () => {
    /**
     * El lector, cuando encuentra una migración del disco sin entrada, ofrecía
     * "o deja que la escriba el script". Acá se comprueba qué pasa de verdad si
     * alguien le hace caso: el script tampoco puede inventar el testigo, así que
     * se detiene con el mismo reclamo. Ésa es la razón por la que el remedio del
     * lector ahora dice "a mano" — y se sostiene corriéndolo, no leyéndolo.
     */
    const nueva = path.join(arbol, "supabase", "migrations", "0041_recien_escrita.sql");
    writeFileSync(nueva, "-- todavía nadie le escribió un testigo\nselect 1;\n");
    try {
      const r = correr();
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("0041_recien_escrita.sql");
      expect(r.stderr).toMatch(/testigo/i);
      expect(r.stdout).not.toContain("Preguntándole");
    } finally {
      rmSync(nueva, { force: true });
    }
  }, 60_000);

  it("un libro malformado lo detiene ANTES de generar una sola sentencia", () => {
    /**
     * Sin esto, la entrada sin `testigo` llegaba a la base como el texto
     * "undefined", volvía como 42703 disfrazado de ausencia, y con `--escribir`
     * se anotaba "producción no la tiene". Un libro roto no es un dato.
     */
    const libro = JSON.parse(readFileSync(libroDelArbol(), "utf8")) as {
      migraciones: Record<string, Record<string, unknown>>;
    };
    const clave = Object.keys(libro.migraciones)[0]!;
    delete libro.migraciones[clave]!.testigo;
    writeFileSync(libroDelArbol(), JSON.stringify(libro, null, 2));
    try {
      const r = correr();
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("testigo");
      expect(r.stderr).toContain(clave);
      expect(r.stdout).not.toContain("Preguntándole");
      // Y no tocó el libro: sigue siendo el que se escribió recién.
      const despues = JSON.parse(readFileSync(libroDelArbol(), "utf8")) as {
        migraciones: Record<string, Record<string, unknown>>;
      };
      expect(despues.migraciones[clave]!.testigo).toBeUndefined();
    } finally {
      restaurarLibro();
    }
  }, 60_000);

  it("sin token no supone nada: se detiene diciendo que no se puede saber", () => {
    const r = spawnSync(process.execPath, [path.join(arbol, "scripts", path.basename(SCRIPT))], {
      encoding: "utf8",
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: "", NEXT_PUBLIC_SUPABASE_URL: "" },
    });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/token/i);
  }, 60_000);
});

describe("un testigo que no contesta no es un testigo que dice que no", () => {
  /**
   * El camino cómodo era `fila?.presente === true`, que convierte NULL y "no
   * vino ninguna fila" en `false`, o sea en "producción no tiene esta
   * migración". Un testigo mal escrito (un `and` con NULL, un `max()` sobre
   * cero filas) daría por PENDIENTE algo aplicado, y el gate levantaría una base
   * "de producción" a la que le faltan objetos que en producción sí están.
   */
  it("un NULL revienta en vez de pasar por 'no aplicada'", () => {
    expect(() => respuestaDelTestigo({ presente: null }, "0036_x.sql", "select null")).toThrow(
      TestigoSinRespuesta,
    );
  });

  it("una consulta sin filas revienta en vez de pasar por 'no aplicada'", () => {
    expect(() => respuestaDelTestigo(undefined, "0036_x.sql", "select true where false")).toThrow(
      TestigoSinRespuesta,
    );
  });

  it("un booleano de verdad pasa tal cual", () => {
    expect(respuestaDelTestigo({ presente: true }, "0001_x.sql", "select true")).toBe(true);
    expect(respuestaDelTestigo({ presente: false }, "0001_x.sql", "select false")).toBe(false);
  });
});
