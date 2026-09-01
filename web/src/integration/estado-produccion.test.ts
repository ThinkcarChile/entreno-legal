import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { MIGRACIONES, recorrerCadena } from "./harness";
import {
  archivosDeMigracion,
  AUSENCIA_DEL_OBJETO,
  cargarLibroDeProduccion,
  consultaDelTestigo,
  esAusenciaDelObjeto,
  motivoDeVigenciaInvalida,
  numeroDeMigracion,
  respuestaDelTestigo,
  soloLoQueProduccionTiene,
  TestigoSinRespuesta,
  VIGENCIA_MAXIMA_EN_DIAS,
} from "./estado-produccion";

const SCRIPT = path.resolve(__dirname, "../../../scripts/verificar-estado-produccion.mjs");

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
    // escribe libros que el gate rechaza en el acto.
    const fuente = readFileSync(SCRIPT, "utf8");
    const declarado = /const DIAS_DE_VIGENCIA = (\d+);/.exec(fuente)?.[1];
    expect(declarado).toBeDefined();
    expect(Number(declarado)).toBe(VIGENCIA_MAXIMA_EN_DIAS.TESTIGOS_EN_VIVO);
  });
});

/**
 * EL SCRIPT ES LA OTRA MITAD DE ESTE MECANISMO y no lo corre ningún test: pide
 * un token de la Management API y habla con el Supabase de verdad. Lo que sí se
 * puede sostener desde acá son las tres promesas suyas que, si se rompen, dejan
 * al libro diciendo cosas que nadie comprobó. Se leen del texto del archivo a
 * propósito: importarlo lo ejecutaría.
 */
describe("el script que le pregunta a la base", () => {
  /**
   * Se le sacan los comentarios antes de mirarlo. Si no, estos tests se
   * autoengañan de la forma más tonta: el comentario que explica POR QUÉ el
   * `coalesce` y el `process.exit()` ya no están los vuelve a "encontrar" en el
   * archivo, y el rojo aparece con el arreglo puesto. Se mira lo que el script
   * HACE, no lo que cuenta.
   */
  const fuente = readFileSync(SCRIPT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // comentario de bloque JS
    .replace(/^[ \t]*\/\/.*$/gm, " ") // comentario de línea JS
    .replace(/^[ \t]*--.*$/gm, " "); // comentario de línea SQL, dentro del template

  it("atrapa exactamente los mismos SQLSTATE de ausencia que este módulo", () => {
    /**
     * `esAusenciaDelObjeto` clasifica por CÓDIGO (PGlite devuelve `error.code`)
     * y el script por NOMBRE DE CONDICIÓN (plpgsql no entiende otra cosa). Son
     * dos escrituras de la misma lista en dos archivos, y ya se desincronizaron
     * una vez de la peor manera: el comentario decía cuántas eran y la lista
     * tenía otra cantidad. Un nombre de más acá es un error de verdad tragado
     * como "todavía no aplicada"; uno de menos tumba la corrida por algo que ES
     * la respuesta esperada.
     */
    const bloque = /exception\s+when([\s\S]*?)then/.exec(fuente)?.[1];
    expect(bloque).toBeDefined();
    const enElScript = bloque!
      .split(/\s+or\s+/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .sort();
    expect(enElScript).toEqual(Object.keys(AUSENCIA_DEL_OBJETO).sort());
  });

  it("no convierte el NULL del testigo en 'no aplicada'", () => {
    /**
     * Vivía un `coalesce(v_resultado, false)` en la función de pg_temp. Va en la
     * dirección segura y por eso es tan cómodo, pero convierte "el testigo no
     * supo contestar" en el dato "producción no la tiene": el script anotaría
     * PENDIENTE una migración aplicada y el gate levantaría una base a la que le
     * faltan objetos que en producción sí están.
     *
     * El `coalesce` explícito NO está prohibido en un testigo del libro —ahí lo
     * escribe alguien que puede justificar en `prueba` por qué ese NULL sí es
     * una ausencia—. Lo que no puede es vivir en el motor, aplicándose a todos
     * los testigos por igual y sin que nadie lo justifique.
     */
    expect(fuente).not.toMatch(/coalesce\s*\(\s*v_resultado/i);
    expect(fuente).toMatch(/return v_resultado;/);
    // Y del lado JS, la misma regla: nada de `presente === true` como forma de
    // leer la respuesta. El booleano se exige, no se asume.
    expect(fuente).toMatch(/typeof f\.presente === "boolean"/);
  });

  it("no corta el proceso con process.exit()", () => {
    /**
     * En Windows, `process.exit()` con el socket de `fetch` todavía abierto
     * revienta libuv con un assert y el código de salida se pierde (queda 127).
     * Estuvo arreglado SÓLO en el camino del informe, así que todos los caminos
     * de error —los que más importa leer— seguían muriendo mal: quien corría el
     * script veía 127 en vez del 1 ("no se pudo saber") o el 2 ("hay
     * desacuerdos"), y un código que no significa nada no se puede encadenar.
     */
    expect(fuente).not.toMatch(/process\.exit\s*\(/);
    expect(fuente).toMatch(/process\.exitCode\s*=/);
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
