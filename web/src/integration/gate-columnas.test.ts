import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levantarBase, type Harness } from "./harness";
import { migracionPendienteQueCrea } from "./estado-produccion";

/**
 * GATE DE COLUMNAS — el eslabón que le faltaba a la paridad de schema.
 *
 * `gate-schema-parity` comprueba que la TABLA exista y que la FUNCIÓN exista.
 * No mira lo que la app le pide adentro. O sea que esto pasa en verde:
 *
 *     .from("ingredients").select("id, nombre_que_no_existe")
 *
 * La tabla está, el gate aprueba, y PostgREST responde 400 la primera vez que
 * alguien abre esa pantalla en producción.
 *
 * No es un riesgo teórico: es la misma familia del defecto que este proyecto ya
 * pagó tres veces en una semana. Una migración crea la columna, el código la
 * usa, la migración no llega a producción, y todo lo que se ejecuta antes de
 * abrir la pantalla dice que está bien. El `.from()` lo cachó el gate viejo; el
 * `.select()` no lo cachaba nadie.
 *
 * CÓMO SE LEE UN `.select()`, y qué NO se intenta:
 *
 * La sintaxis de PostgREST admite mucho más que una lista de columnas: embeds
 * (`meal_serving_records ( served_on )`), alias (`total:count`), casts
 * (`quantity::text`), modificadores (`!inner`, `!left`) y filtros. Este guardián
 * NO reimplementa ese parser — reimplementarlo mal sería peor que no tenerlo,
 * porque un falso positivo entrena a la gente a silenciar el test.
 *
 * Lo que hace es acotado a propósito: extrae los identificadores de PRIMER
 * NIVEL, descarta todo lo que no sea un nombre de columna simple, y compara
 * contra `information_schema.columns`. Lo dudoso se SALTA y se cuenta, y ese
 * conteo se afirma: si el guardián empieza a saltarse la mitad de lo que mira,
 * el test lo dice en vez de aprobar por omisión.
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

/** Una columna pedida: de qué tabla, cuál, y desde qué archivo. */
interface Pedido {
  tabla: string;
  columna: string;
  archivo: string;
}

/**
 * Corta el argumento de `.select(...)` en sus partes de PRIMER nivel.
 *
 * Cuenta paréntesis a mano en vez de partir por comas: un embed trae comas
 * adentro (`recetas ( id, nombre )`) y partir a ciegas produciría "nombre )"
 * como si fuera una columna de la tabla de afuera.
 */
function partesDePrimerNivel(seleccion: string): string[] {
  const partes: string[] = [];
  let profundidad = 0;
  let actual = "";
  for (const c of seleccion) {
    if (c === "(") profundidad += 1;
    if (c === ")") profundidad -= 1;
    if (c === "," && profundidad === 0) {
      partes.push(actual);
      actual = "";
      continue;
    }
    actual += c;
  }
  partes.push(actual);
  return partes.map((p) => p.trim()).filter(Boolean);
}

/** Lo que este guardián NO se atreve a interpretar, con su razón. */
function esDudoso(parte: string): boolean {
  return (
    parte === "*" ||
    parte.includes("(") || // embed: la columna es de OTRA tabla
    parte.includes("::") || // cast
    parte.includes("!") || // !inner / !left
    parte.includes(":") || // alias
    parte.includes("$") || // interpolación: el nombre no está en el fuente
    !/^[a-z_][a-z_0-9]*$/.test(parte)
  );
}

function pedidos(): { lista: Pedido[]; saltadas: number } {
  const lista: Pedido[] = [];
  let saltadas = 0;

  for (const archivo of [...archivosDeApp(APP), ...archivosDeApp(LIB)]) {
    const fuente = readFileSync(archivo, "utf8");
    const rel = path.relative(path.resolve(__dirname, "../.."), archivo).replace(/\\/g, "/");

    // `.from("x")` seguido, más adelante, de `.select(...)`. Se toma el PRIMER
    // select después de cada from: encadenar dos selects sobre la misma consulta
    // no es algo que este código haga, y suponerlo complicaría el barrido sin
    // cubrir ningún caso real.
    for (const m of fuente.matchAll(/\.from\(\s*"([a-z_0-9]+)"\s*\)([\s\S]{0,2000}?)\.select\(/g)) {
      const tabla = m[1]!;

      // EL HUECO ENTRE `.from()` Y `.select()` TIENE QUE SER UNA CADENA DE
      // MÉTODOS, NO CÓDIGO CUALQUIERA.
      //
      // Sin esta comprobación el barrido emparejaba cosas que no van juntas. Le
      // pasó en la primera corrida, y vale la pena dejarlo escrito porque es el
      // modo de fallar típico de este tipo de guardián:
      //
      //     await supabase.from("meal_assignments").delete().eq("id", id);
      //     ...
      //     await supabase.from("meal_substitution_choices")
      //       .select("member_id, component_id, to_ingredient_id")
      //
      // El `.select()` está a 28 líneas del `.from()` de arriba, o sea DENTRO de
      // la ventana. El barrido acusó a `meal_assignments` de pedir tres columnas
      // que en realidad le pide otra tabla, y las tres existen donde
      // corresponde. Tres denuncias falsas.
      //
      // Eso no es un detalle molesto: un guardián que acusa en falso se termina
      // silenciando, y el día que encuentre algo de verdad nadie le va a creer.
      // Vale más callar de más que acusar de menos.
      //
      // El corte son dos marcas que una cadena real nunca tiene en el medio: un
      // `;` (la consulta anterior terminó) y otro `.from(` (empezó otra). Los
      // encadenados legítimos que sí devuelven columnas propias —el
      // `.insert(...).select("id")` de PostgREST, por ejemplo— pasan enteros,
      // porque adentro de una sola expresión no hay ninguna de las dos.
      const hueco = m[2]!;
      if (hueco.includes(";") || hueco.includes(".from(")) continue;

      const desde = m.index! + m[0].length;
      // El argumento del select puede ser una plantilla con backticks o una
      // cadena normal; se toma hasta el cierre del paréntesis balanceado.
      let profundidad = 1;
      let i = desde;
      let arg = "";
      while (i < fuente.length && profundidad > 0) {
        const c = fuente[i]!;
        if (c === "(") profundidad += 1;
        else if (c === ")") profundidad -= 1;
        if (profundidad > 0) arg += c;
        i += 1;
      }
      const cadena = arg.match(/^\s*[`"']([\s\S]*?)[`"']\s*(?:,|$)/);
      if (!cadena) {
        // Un select cuyo argumento no es un literal (por ejemplo `columnsOf(...)`,
        // que el proyecto usa a propósito para derivar del esquema Zod). No se
        // inventa: se salta y se cuenta.
        saltadas += 1;
        continue;
      }
      for (const parte of partesDePrimerNivel(cadena[1]!)) {
        if (esDudoso(parte)) {
          saltadas += 1;
          continue;
        }
        lista.push({ tabla, columna: parte, archivo: rel });
      }
    }
  }
  return { lista, saltadas };
}

async function columnasDe(h: Harness): Promise<Map<string, Set<string>>> {
  const filas = await h.filas<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public'`,
  );
  const mapa = new Map<string, Set<string>>();
  for (const f of filas) {
    const set = mapa.get(f.table_name) ?? new Set<string>();
    set.add(f.column_name);
    mapa.set(f.table_name, set);
  }
  return mapa;
}

let completa: Harness;

beforeAll(async () => {
  completa = await levantarBase({ conSeeds: false });
}, 60_000);

afterAll(async () => {
  await completa?.cerrar();
});

describe("gate de columnas — la app no le pide a una tabla algo que no tiene", () => {
  it("toda columna de un .select() literal existe en su tabla", async () => {
    const { lista } = pedidos();
    const columnas = await columnasDe(completa);

    const rotas = lista
      .filter(({ tabla, columna }) => {
        const dela = columnas.get(tabla);
        // Si la TABLA no existe, ese es problema de gate-schema-parity y ya lo
        // reporta con su propio mensaje. Acá se calla para no duplicar el ruido.
        if (dela === undefined) return false;
        return !dela.has(columna);
      })
      .map(({ tabla, columna, archivo }) => {
        const culpable = migracionPendienteQueCrea(tabla);
        const pista = culpable ? ` (la tabla la crea ${culpable})` : "";
        return `${tabla}.${columna} — pedida en ${archivo}${pista}`;
      })
      .sort();

    expect([...new Set(rotas)]).toEqual([]);
  });

  it("el barrido mira de verdad: encuentra columnas y no se salta casi todo", () => {
    // UN GUARDIÁN QUE NO MIRA NADA APRUEBA SIEMPRE.
    //
    // Este test es el que impide que el de arriba se vuelva decorativo: si un
    // cambio de estilo en las consultas hiciera que el barrido dejara de
    // reconocerlas, `rotas` quedaría vacío y el gate seguiría verde para
    // siempre. Acá se afirma que sigue viendo, y cuánto se está saltando.
    const { lista, saltadas } = pedidos();

    expect(lista.length, "el barrido dejó de encontrar columnas").toBeGreaterThan(150);

    // Lo saltado es legítimo (embeds, casts, alias, `columnsOf`) pero no puede
    // ser la mayoría: si lo fuera, este gate estaría aprobando por omisión.
    const proporcion = saltadas / (saltadas + lista.length);
    expect(
      proporcion,
      `se está saltando el ${Math.round(proporcion * 100)} % de lo que mira (${saltadas} de ${saltadas + lista.length})`,
    ).toBeLessThan(0.5);
  });

  it("toda columna que la app pide, authenticated PUEDE leerla", async () => {
    /**
     * QUE LA COLUMNA EXISTA NO SIGNIFICA QUE SE PUEDA LEER.
     *
     * La 0048 le quita a `authenticated` el `select` sobre la tabla
     * `inventory_lots` entero y se lo devuelve columna por columna, dejando
     * afuera las cuatro del dinero: la despensa la ve toda la casa
     * —cantidades, vencimientos, ubicación— y el precio sólo quien tiene
     * FINANCE_VIEW, que lo lee por la vista `lot_valuations`. Es la única
     * herramienta que distingue las dos cosas, porque RLS filtra FILAS y acá lo
     * que sobra es una COLUMNA.
     *
     * La consecuencia es que un `.select()` puede nombrar una columna que
     * existe y aun así morir con "permission denied for table". El test de más
     * arriba no lo ve: la columna está en `information_schema.columns`, y por
     * ahí todo se ve bien.
     *
     * Este cierra ese hueco, y no es hipotético: encontró que
     * `finanzas/boletas/queries.ts` seguía pidiéndole `value_status` y
     * `value_unknown_reason` a la tabla después de que la 0048 los mudó a la
     * vista. La pantalla habría fallado para TODO EL MUNDO —incluso para quien
     * tiene FINANCE_VIEW, porque el permiso que falta es el de la tabla— el
     * primer día que ese sprint llegara a producción.
     */
    const { lista } = pedidos();
    const columnas = await columnasDe(completa);

    const candidatas = lista.filter(({ tabla, columna }) => columnas.get(tabla)?.has(columna));
    expect(candidatas.length, "el barrido no dejó nada que comprobar").toBeGreaterThan(150);

    const sinPermiso = await completa.filas<{ tabla: string; columna: string }>(
      `select t.tabla, t.columna
         from (values ${candidatas
           .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
           .join(", ")}) as t(tabla, columna)
        where not has_column_privilege('authenticated', 'public.' || t.tabla, t.columna, 'SELECT')`,
      candidatas.flatMap(({ tabla, columna }) => [tabla, columna]),
    );

    const porColumna = new Map(candidatas.map((c) => [`${c.tabla}|${c.columna}`, c.archivo]));
    const rotas = [
      ...new Set(
        sinPermiso.map(
          (f) =>
            `${f.tabla}.${f.columna} — pedida en ${porColumna.get(`${f.tabla}|${f.columna}`)}: la columna EXISTE pero authenticated no puede leerla. Se cerró a propósito; hay que pedirla por la vista que la expone con su permiso, no por la tabla.`,
        ),
      ),
    ].sort();

    expect(rotas).toEqual([]);
  });

  it("el permiso se comprueba de verdad: una columna cerrada SÍ sale", async () => {
    // Comprobación por mutación con el caso REAL que motivó el test. Sin ella,
    // "la lista salió vacía" no distingue entre "todo se puede leer" y
    // "has_column_privilege me está diciendo que sí a todo".
    const puede = await completa.fila<{ ok: boolean }>(
      `select has_column_privilege('authenticated', 'public.inventory_lots', 'value_minor', 'SELECT') as ok`,
    );
    expect(puede?.ok, "la 0048 dejó de cerrar el dinero del lote").toBe(false);

    const abierta = await completa.fila<{ ok: boolean }>(
      `select has_column_privilege('authenticated', 'public.inventory_lots', 'quantity', 'SELECT') as ok`,
    );
    expect(abierta?.ok, "la despensa dejó de ser visible para la casa").toBe(true);
  });

  it("una columna inventada SÍ se detecta (el guardián tiene dientes)", async () => {
    // Comprobación por mutación, dentro del propio test: se le pasa a mano un
    // pedido imposible y se exige que el mismo criterio lo marque. Sin esto,
    // "la lista salió vacía" no distingue entre "está todo bien" y "el criterio
    // no detecta nada".
    const columnas = await columnasDe(completa);
    const inventado: Pedido = {
      tabla: "households",
      columna: "columna_que_no_existe_jamas",
      archivo: "prueba/mutacion.ts",
    };
    const dela = columnas.get(inventado.tabla);
    expect(dela, "la tabla households no existe: el arnés está mal").toBeDefined();
    expect(dela!.has(inventado.columna)).toBe(false);
  });
});
