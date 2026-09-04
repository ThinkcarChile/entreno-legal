import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levantarBase, migracionesDeProduccion, MIGRACIONES, type Harness } from "./harness";
import {
  armarEstadoDelContrato,
  clasificarObjetos,
  demostrarQueCreanLasPendientes,
  type DemostracionDePendientes,
  type ObjetoDelContrato,
} from "./contrato-schema";
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
  const { sinProductor, brechaDeDespliegue } = clasificarFaltantes(usos, existentes);
  return [...sinProductor, ...brechaDeDespliegue].sort();
}

/**
 * FALTAR NO ES UNA SOLA COSA, Y TRATARLO COMO SI LO FUERA ROMPE EL GATE.
 *
 * Un objeto que la app usa y la base no tiene puede serlo por dos motivos que no
 * se parecen en nada:
 *
 *   · SIN PRODUCTOR — ninguna migración del repo lo crea. Nadie lo va a crear
 *     nunca. Es el defecto original de este gate: la app pedía
 *     `meal_serving_record_items` y todo salía verde. Esto FALLA, siempre.
 *
 *   · BRECHA DE DESPLIEGUE — lo crea una migración que está escrita, SELLADA y
 *     todavía sin aplicar. No es un defecto del código: es que producción va
 *     atrás, que es el estado normal entre escribir una migración y que su dueño
 *     autorice aplicarla, y esa autorización puede tardar días.
 *
 * Mezclarlas dejaba CI ROJO durante toda esa ventana. Un CI crónicamente rojo se
 * deja de mirar, y el día que aparezca un SIN PRODUCTOR de verdad nadie lo va a
 * distinguir del rojo de siempre. La protección se pierde por desgaste, no por
 * un cambio de código.
 *
 * Ojo con lo que NO se afloja: la brecha no se silencia. Se deriva del libro
 * —que es quien sabe qué está pendiente— y su propio test la afirma entera, así
 * que un objeto nuevo no se puede colar adentro sin que se vea. Y en cuanto la
 * migración se aplica, el libro cambia y la brecha desaparece sola: no hay
 * ninguna lista escrita a mano que alguien tenga que acordarse de limpiar.
 */
function clasificarFaltantes(
  usos: Map<string, string[]>,
  existentes: Set<string>,
): { sinProductor: string[]; brechaDeDespliegue: string[] } {
  const sinProductor: string[] = [];
  const brechaDeDespliegue: string[] = [];
  for (const [nombre, archivos] of usos.entries()) {
    if (existentes.has(nombre)) continue;
    const culpable = migracionPendienteQueCrea(nombre);
    if (culpable) {
      brechaDeDespliegue.push(
        `${nombre} — la crea ${culpable}, que producción NO tiene aplicada — usada en ${archivos.join(", ")}`,
      );
    } else {
      sinProductor.push(
        `${nombre} — ninguna migración del repo la crea — usada en ${archivos.join(", ")}`,
      );
    }
  }
  return { sinProductor: sinProductor.sort(), brechaDeDespliegue: brechaDeDespliegue.sort() };
}

let completa: Harness;
let produccion: Harness;

const ARTEFACTO = path.resolve(__dirname, "../../../supabase/schema-contract-status.json");

let demostracion: DemostracionDePendientes;
/**
 * ¿El contrato contra la CADENA COMPLETA pasa? (§3). Es la condición 7: si el
 * repo no garantiza el objeto ni con todo aplicado, prometer que "ya viene" es
 * prometer algo que no existe. Lo calculan los tests de §3 y lo lee §3-bis.
 */
let targetSchemaPasa = true;

beforeAll(async () => {
  // SIN seeds las dos: exactamente lo que las migraciones pueden producir.
  completa = await levantarBase({ conSeeds: false });
  // Si el libro de producción no se puede leer, auditar o está vencido, esto
  // revienta acá con el motivo escrito. ERROR != VACÍO: el archivo entero se
  // pone rojo antes que dejar pasar una comparación contra una base inventada.
  produccion = await levantarBase({ conSeeds: false, soloProduccion: true });
  // QUIÉN CREA QUÉ SE DEMUESTRA, NO SE ADIVINA: se aplican las pendientes sobre
  // el estado de producción y se observa qué objeto aparece con cada una.
  demostracion = await demostrarQueCreanLasPendientes();
}, 180_000);

afterAll(async () => {
  await completa?.cerrar();
  await produccion?.cerrar();
});

describe("§3 — la app solo depende de schema producible por migraciones", () => {
  it("toda función que la app invoca con .rpc() existe SIN seeds", async () => {
    const { rpcs } = referencias();
    expect(rpcs.size).toBeGreaterThan(5); // el scanner encontró algo real

    const rotos = faltantes(rpcs, await funcionesDe(completa));
    // La condición 7 del contrato se MIDE acá, no se supone: si la cadena
    // completa no sostiene lo que la app pide, §3-bis no puede clasificar nada
    // como "ya viene en camino".
    if (rotos.length > 0) targetSchemaPasa = false;
    expect(rotos).toEqual([]);
  });

  it("toda tabla/vista que la app lee con .from() existe SIN seeds", async () => {
    const { tablas } = referencias();
    expect(tablas.size).toBeGreaterThan(10);

    const rotos = faltantes(tablas, await relacionesDe(completa));
    // La condición 7 del contrato se MIDE acá, no se supone: si la cadena
    // completa no sostiene lo que la app pide, §3-bis no puede clasificar nada
    // como "ya viene en camino".
    if (rotos.length > 0) targetSchemaPasa = false;
    expect(rotos).toEqual([]);
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

    // -----------------------------------------------------------------------
    // LLEGÓ EL DÍA QUE EL COMENTARIO DE ARRIBA ANTICIPABA.
    //
    // El 2026-09-02 producción se puso al día con el repo entero: cero
    // pendientes. Y ahí este canario se quedaba sin trabajo exactamente como
    // estaba escrito que iba a pasar — con el `not.toEqual([])` en rojo,
    // pidiendo que alguien lo revisara.
    //
    // Revisado: la respuesta NO es apagarlo. Es que en ese estado la afirmación
    // que importa cambia, y sigue siendo una afirmación de verdad, no vacía:
    // que la cadena recortada a lo que producción tiene SEA la cadena completa.
    // Si mañana alguien agrega una migración nueva, vuelve a haber pendientes y
    // el canario retoma su trabajo de siempre sin que nadie toque nada.
    //
    // Lo que se conserva es el principio: este test NUNCA pasa por vacuidad. O
    // hay pendientes y se demuestra que producción no las tiene, o no las hay y
    // se demuestra que producción tiene TODO. Nunca "no había nada que mirar".
    // -----------------------------------------------------------------------
    if (pendientes.length === 0) {
      expect(
        migracionesDeProduccion(),
        "el libro no declara ninguna pendiente pero la cadena de producción no es la completa",
      ).toEqual(MIGRACIONES);
      return;
    }

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

  it("CONTRACT_DEFECT: ningún objeto que la app usa se queda sin quien lo cree", async () => {
    /**
     * LA COMPUERTA DURA, Y LA ÚNICA QUE FALLA.
     *
     * Un objeto entra acá cuando falta en producción Y alguna de las siete
     * condiciones del contrato no se cumple. Cada motivo viene escrito, así que
     * el rojo dice CUÁL falló y no un "no cumple" que obliga a adivinar:
     *
     *   1. nadie lo crea (se aplicaron las pendientes y no apareció)
     *   2. quien lo crea revienta al aplicarse
     *   3. no tiene entrada en el libro
     *   4. el libro la da por APLICADA y producción no la tiene
     *   5. no está sellada
     *   6. su checksum cambió después de sellarse
     *   7. el contrato contra la cadena completa no pasa
     *
     * Nada de esto se degrada a aviso. Es el defecto que este gate existe para
     * gritar: la app pedía `meal_serving_record_items`, la 0036 no estaba
     * aplicada, y todo salía verde.
     */
    const { rpcs, tablas } = referencias();
    const objetos = [
      ...clasificarObjetos(tablas, "tabla", await relacionesDe(produccion), demostracion, targetSchemaPasa),
      ...clasificarObjetos(rpcs, "funcion", await funcionesDe(produccion), demostracion, targetSchemaPasa),
    ];
    const defectos = objetos
      .filter((o) => o.estado === "CONTRACT_DEFECT")
      .map((o) => `${o.objeto} (${o.tipo}) — ${o.motivo} — usada en ${o.usado_en.join(", ")}`);
    expect(defectos).toEqual([]);
  });

  it("ninguna migración pendiente revienta al aplicarse sobre producción", () => {
    // Condición 6 del contrato, aislada: si una pendiente no aplica, no está en
    // camino a ninguna parte y todo lo que prometía es un defecto. Se afirma
    // aparte para que el rojo diga "esta migración no aplica" en vez de
    // aparecer como N objetos sin productor.
    expect(
      demostracion.fallaronAlAplicar.map((f) => `${f.archivo}: ${f.error}`),
      "una migración pendiente falla al aplicarse sobre el estado real de producción",
    ).toEqual([]);
  });

  it("el artefacto schema-contract-status.json dice la verdad y está al día", async () => {
    /**
     * NO UNA LÍNEA AMARILLA: UN ARTEFACTO.
     *
     * Un aviso en la salida de CI se ignora en tres días. Esto es un archivo
     * versionado: para que cambie hay que confirmarlo, y quien lo revise ve qué
     * objeto quedó pendiente, de qué migración, con qué checksum y en qué estado
     * está producción.
     *
     * Se REGENERA con `REGENERAR_CONTRATO=1 npx vitest run gate-schema-parity`,
     * el mismo patrón que el vocabulario del catálogo. Si el archivo quedó
     * atrás, este test se pone rojo y dice el comando.
     */
    const { rpcs, tablas } = referencias();
    const objetos: ObjetoDelContrato[] = [
      ...clasificarObjetos(tablas, "tabla", await relacionesDe(produccion), demostracion, targetSchemaPasa),
      ...clasificarObjetos(rpcs, "funcion", await funcionesDe(produccion), demostracion, targetSchemaPasa),
    ];
    const libro = cargarLibroDeProduccion();
    const anterior = existsSync(ARTEFACTO)
      ? (JSON.parse(readFileSync(ARTEFACTO, "utf8")) as { release_candidate_declarado?: boolean })
      : {};
    const estado = armarEstadoDelContrato(
      objetos,
      targetSchemaPasa,
      // Lo declara una PERSONA y se conserva entre corridas: el gate no puede
      // ponerlo ni quitarlo solo, o el candado no sería un candado.
      anterior.release_candidate_declarado === true,
      libro.proyecto,
      // TODAS las pendientes del libro, no sólo las que la app referencia: la
      // 0062 es endurecimiento de seguridad y ningún `.from()` la nombra.
      libro.entradas
        .filter((e) => e.estado === "PENDIENTE")
        .map((e) => ({ archivo: e.archivo, sellada: e.sha256 !== null, checksum: e.sha256 })),
    );

    const texto = `${JSON.stringify(estado, null, 2)}${String.fromCharCode(10)}`;
    if (process.env.REGENERAR_CONTRATO === "1") {
      writeFileSync(ARTEFACTO, texto, "utf8");
      return;
    }
    expect(
      existsSync(ARTEFACTO) ? readFileSync(ARTEFACTO, "utf8").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)) : "",
      "supabase/schema-contract-status.json quedó atrás. Regenéralo: " +
        "  cd web && REGENERAR_CONTRATO=1 npx vitest run src/integration/gate-schema-parity.test.ts",
    ).toBe(texto);
  });

  it("RELEASE GATE: bloqueado mientras haya UN objeto pendiente de desplegar", async () => {
    /**
     * QUE CI PASE NO SIGNIFICA QUE SE PUEDA LANZAR.
     *
     * Esa confusión ya costó una vez —"CI verde con producción vieja"— y este
     * test es el candado. Separa las dos realidades y no las mezcla nunca en un
     * solo booleano:
     *
     *   TARGET SCHEMA      repo + cadena limpia + app  →  tiene que PASAR
     *   PRODUCTION SCHEMA  app vs lo que producción tiene HOY  →  IN_SYNC o
     *                      BLOCKED_PENDING_DEPLOYMENT
     *
     * Y sobre todo: `release_candidate_declarado` sólo puede ser `true` cuando
     * el despliegue está READY. Declararlo con una brecha abierta pone esto
     * rojo, que es exactamente lo que se pidió: que un Release Candidate no se
     * pueda declarar de paso.
     */
    const estado = JSON.parse(readFileSync(ARTEFACTO, "utf8")) as {
      target_schema: string;
      production_schema: string;
      release_deployment_state: string;
      release_candidate_declarado: boolean;
      pending_objects: ObjetoDelContrato[];
    };

    expect(estado.target_schema, "el contrato contra la cadena completa NO pasa").toBe("PASS");

    if (estado.pending_objects.length > 0) {
      expect(
        estado.release_deployment_state,
        "hay objetos pendientes de desplegar y el despliegue NO figura bloqueado",
      ).toBe("BLOCKED");
    }

    expect(
      estado.release_candidate_declarado && estado.release_deployment_state !== "READY",
      "SE DECLARÓ RELEASE CANDIDATE CON UNA BRECHA ABIERTA. Aplica las pendientes " +
        "(node scripts/poner-al-dia.mjs --pendientes --aplicar), verifica " +
        "(node scripts/verificar-estado-produccion.mjs --escribir) y recién ahí decláralo.",
    ).toBe(false);

    if (estado.pending_objects.length > 0) {
      console.log(
        [
          "",
          `TARGET_SCHEMA: ${estado.target_schema}`,
          `PRODUCTION_SCHEMA: ${estado.production_schema}`,
          "",
          "Pending:",
          ...estado.pending_objects.map(
            (o: ObjetoDelContrato) =>
              [
                `- ${o.objeto}`,
                `  provided_by: ${o.provisto_por}`,
                `  sealed: ${o.sellada ? "yes" : "no"}`,
                `  checksum: ${o.checksum}`,
                `  creation_demonstrated: ${o.creacion_demostrada ? "yes" : "no"}`,
              ].join(String.fromCharCode(10)),
          ),
          "",
          `CI: PASS      DEPLOYMENT: ${estado.release_deployment_state}`,
          "",
        ].join(String.fromCharCode(10)),
      );
    }
  });
});
