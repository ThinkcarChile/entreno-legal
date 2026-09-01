import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levantarBase, migracionesDeProduccion, MIGRACIONES, type Harness } from "./harness";
import {
  cargarLibroDeProduccion,
  consultaDelTestigo,
  esAusenciaDelObjeto,
  migracionPendienteQueCrea,
  numeroDeMigracion,
  respuestaDelTestigo,
} from "./estado-produccion";

/**
 * GATE FINAL §3 — PARIDAD DE SCHEMA: test == producción.
 *
 * Regla del director: "schema test == schema producible mediante migraciones;
 * un seed de demo no puede esconder una dependencia de producción".
 *
 * Este archivo levanta DOS bases y hace DOS preguntas distintas, porque son dos
 * preguntas distintas y confundirlas fue exactamente el defecto:
 *
 *  §3   contra la cadena COMPLETA del repo, sin seeds.
 *       "¿Todo lo que la app usa es reproducible por migraciones, o hay algo que
 *       solo existe porque alguien corrió un seed a mano?" (el caso original:
 *       `seed_demo_family_profiles`).
 *
 *  §3-bis contra la cadena que producción TIENE APLICADA, sin seeds.
 *       "¿Todo lo que la app usa existe HOY en la base que atiende a la
 *       familia?" — que es la pregunta que este archivo decía por escrito estar
 *       contestando y no contestaba.
 *
 * POR QUÉ EXISTE §3-bis: §3 corría contra `MIGRACIONES`, que incluye 0036 y
 * 0038. Producción no las tiene. Con la 0036 aplicada en la base de prueba,
 * `meal_serving_record_items` existía, el gate la dio por buena, y
 * `src/app/stock/queries.ts` quedó consultando una tabla que en el Supabase real
 * no está. El gate era incapaz de ver lo único que decía vigilar, porque en el
 * repo no había ningún dato que dijera hasta dónde llega producción. Ahora sí lo
 * hay: `supabase/estado-produccion.json`.
 */

const APP = path.resolve(__dirname, "../app");
const LIB = path.resolve(__dirname, "../lib");

function archivosDeApp(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivosDeApp(ruta));
    else if (/\.tsx?$/.test(nombre) && !/\.test\./.test(nombre)) out.push(ruta);
  }
  return out;
}

function referencias(): { rpcs: Map<string, string[]>; tablas: Map<string, string[]> } {
  const rpcs = new Map<string, string[]>();
  const tablas = new Map<string, string[]>();
  for (const archivo of [...archivosDeApp(APP), ...archivosDeApp(LIB)]) {
    const fuente = readFileSync(archivo, "utf8");
    const rel = path.relative(APP, archivo);
    for (const m of fuente.matchAll(/\.rpc\(\s*"([a-z_0-9]+)"/g)) {
      const lista = rpcs.get(m[1]!) ?? [];
      lista.push(rel);
      rpcs.set(m[1]!, lista);
    }
    for (const m of fuente.matchAll(/\.from\(\s*"([a-z_0-9]+)"\s*\)/g)) {
      const lista = tablas.get(m[1]!) ?? [];
      lista.push(rel);
      tablas.set(m[1]!, lista);
    }
  }
  return { rpcs, tablas };
}

async function funcionesDe(h: Harness): Promise<Set<string>> {
  return new Set(
    (
      await h.filas<{ proname: string }>(
        `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'`,
      )
    ).map((f) => f.proname),
  );
}

async function relacionesDe(h: Harness): Promise<Set<string>> {
  return new Set(
    (
      await h.filas<{ relname: string }>(
        `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')`,
      )
    ).map((f) => f.relname),
  );
}

/**
 * Arma el reporte de faltantes. Decir "falta meal_serving_record_items" obliga a
 * ir a averiguar de dónde salía; decir "la crea la 0036, que producción no
 * tiene" deja el diagnóstico cerrado en la misma línea del rojo.
 */
function faltantes(usos: Map<string, string[]>, existentes: Set<string>): string[] {
  return [...usos.entries()]
    .filter(([nombre]) => !existentes.has(nombre))
    .map(([nombre, archivos]) => {
      const culpable = migracionPendienteQueCrea(nombre);
      const origen = culpable
        ? `la crea ${culpable}, que producción NO tiene aplicada`
        : `ninguna migración del repo la crea`;
      return `${nombre} — ${origen} — usada en ${archivos.join(", ")}`;
    })
    .sort();
}

let completa: Harness;
let produccion: Harness;

beforeAll(async () => {
  // SIN seeds las dos: exactamente lo que las migraciones pueden producir.
  completa = await levantarBase({ conSeeds: false });
  // Si el libro de producción no se puede leer, auditar o está vencido, esto
  // revienta acá con el motivo escrito. ERROR != VACÍO: el archivo entero se
  // pone rojo antes que dejar pasar una comparación contra una base inventada.
  produccion = await levantarBase({ conSeeds: false, soloProduccion: true });
}, 60_000);

afterAll(async () => {
  await completa?.cerrar();
  await produccion?.cerrar();
});

describe("§3 — la app solo depende de schema producible por migraciones", () => {
  it("toda función que la app invoca con .rpc() existe SIN seeds", async () => {
    const { rpcs } = referencias();
    expect(rpcs.size).toBeGreaterThan(5); // el scanner encontró algo real

    expect(faltantes(rpcs, await funcionesDe(completa))).toEqual([]);
  });

  it("toda tabla/vista que la app lee con .from() existe SIN seeds", async () => {
    const { tablas } = referencias();
    expect(tablas.size).toBeGreaterThan(10);

    expect(faltantes(tablas, await relacionesDe(completa))).toEqual([]);
  });

  it("los seeds ya no definen objetos permanentes de schema", () => {
    // pg_temp.* es sesión-local y muere sola: permitida. Todo lo demás
    // (functions/tables/views/triggers/policies en public) va en migraciones.
    const seedDir = path.resolve(__dirname, "../../../supabase/seed");
    const ofensas: string[] = [];
    for (const nombre of readdirSync(seedDir)) {
      if (!nombre.endsWith(".sql")) continue;
      const fuente = readFileSync(path.join(seedDir, nombre), "utf8");
      for (const m of fuente.matchAll(
        /create\s+(?:or\s+replace\s+)?(function|table|view|trigger|policy)\s+([a-z_."]+)/gi,
      )) {
        if (m[2]!.startsWith("pg_temp.")) continue;
        ofensas.push(`${nombre}: create ${m[1]} ${m[2]}`);
      }
    }
    expect(ofensas).toEqual([]);
  });
});

describe("§3-bis — la app solo depende de lo que producción tiene puesto HOY", () => {
  /**
   * CANARIO DEL PROPIO GATE. Si mañana `soloProduccion` dejara de recortar nada
   * —un bug en el filtro, un libro que declara todo aplicado sin haberlo
   * comprobado— los dos tests de abajo volverían a correr contra la cadena
   * completa y volverían a dar el visto bueno a lo que no existe, en verde y en
   * silencio. Este test es lo que impide que eso pase sin ruido: cada migración
   * declarada PENDIENTE tiene que estar DEMOSTRABLEMENTE ausente de esta base.
   */
  it("la base de producción no tiene ninguna de las migraciones pendientes", async () => {
    const libro = cargarLibroDeProduccion();
    const pendientes = libro.entradas.filter((e) => e.estado === "PENDIENTE");
    const pendientesPorNumero = new Set(pendientes.map((e) => e.numero));

    // -----------------------------------------------------------------------
    // El canario tiene que TENER algo que atrapar. Este `expect` parece de más
    // hasta que no lo está: el día que producción se ponga al día con todo el
    // repo, las dos afirmaciones de abajo se vuelven verdaderas por vacuidad
    // —filtrar una lista sin nada que sacar da la misma lista, y buscar
    // testigos de un conjunto vacío no encuentra ninguno— y este archivo
    // seguiría en verde vigilando exactamente nada. Prefiero un rojo que diga
    // "el canario se quedó sin trabajo, revísalo" antes que un verde vacío.
    // -----------------------------------------------------------------------
    const pendientesEnLaCadenaCompleta = MIGRACIONES.filter((r) => {
      const numero = numeroDeMigracion(r);
      return numero !== null && pendientesPorNumero.has(numero);
    });
    expect(pendientesEnLaCadenaCompleta).not.toEqual([]);

    // Ahora sí: ninguna de esas puede sobrevivir al recorte. Se compara por
    // NÚMERO y no por nombre de archivo —como hacía antes con `basename()`—
    // porque `MIGRACIONES` puede traer un sufijo viejo que `resolverMigracion()`
    // resuelve igual: bastaba un renombre para que la comparación por nombre
    // dejara de emparejar y el canario diera verde con la pendiente adentro.
    const cadena = migracionesDeProduccion();
    const coladas = cadena.filter((r) => {
      const numero = numeroDeMigracion(r);
      return numero !== null && pendientesPorNumero.has(numero);
    });
    expect(coladas).toEqual([]);

    // Y lo último es lo que de verdad importa: que su huella no esté en la
    // base. El testigo de una pendiente tiene que dar FALSO acá.
    const presentes: string[] = [];
    for (const entrada of pendientes) {
      let presente: boolean;
      try {
        // `respuestaDelTestigo` y no `?.presente === true`: ese atajo aplasta
        // NULL y "no vino ninguna fila" contra `false`, o sea contra "producción
        // no la tiene", que es justo lo que este test quiere demostrar. Un
        // testigo mudo haría pasar el canario sin haber comprobado nada.
        presente = respuestaDelTestigo(
          await produccion.fila<{ presente: unknown }>(consultaDelTestigo(entrada.testigo)),
          entrada.archivo,
          entrada.testigo,
        );
      } catch (e) {
        // El objeto por el que pregunta el testigo no existe: eso ES la
        // ausencia que esperamos. Cualquier otro error sube tal cual —incluido
        // `TestigoSinRespuesta`, que es un desconocido y no una ausencia.
        if (!esAusenciaDelObjeto(e)) throw e;
        presente = false;
      }
      if (presente) presentes.push(`${entrada.archivo} (testigo: ${entrada.prueba})`);
    }
    expect(presentes).toEqual([]);
  });

  it("toda función que la app invoca con .rpc() existe en producción", async () => {
    const { rpcs } = referencias();
    expect(rpcs.size).toBeGreaterThan(5);

    expect(faltantes(rpcs, await funcionesDe(produccion))).toEqual([]);
  });

  it("toda tabla/vista que la app lee con .from() existe en producción", async () => {
    const { tablas } = referencias();
    expect(tablas.size).toBeGreaterThan(10);

    expect(faltantes(tablas, await relacionesDe(produccion))).toEqual([]);
  });
});
