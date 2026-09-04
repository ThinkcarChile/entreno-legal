import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acotarHasta,
  crearHogar,
  levantarBase,
  MIGRACIONES,
  migracionesDeProduccion,
  type Harness,
} from "./harness";
import { pathToFileURL } from "node:url";
import { cargarLibroDeProduccion } from "./estado-produccion";


/**
 * EL ENSAYO DEL DESPLIEGUE.
 *
 * Todo lo demás levanta la base DESDE CERO con la cadena completa, y eso
 * responde una pregunta: "¿esto funciona si aplicamos todo de una?". No es la
 * pregunta del despliegue.
 *
 * Producción no está en cero: tiene una parte de la cadena puesta y le faltan
 * las demás (el libro dice cuáles, y cambia solo al aplicar). Lo que va a pasar
 * vacía" sino "estas 19, en orden, ENCIMA de lo que ya hay" — y esas dos cosas
 * pueden diferir. Una migración que crea una tabla sin `if not exists` funciona
 * desde cero y muere sobre una base que ya la tiene. Un `alter table ... add
 * column` que la primera vez encuentra la tabla vacía, sobre datos reales choca
 * con un `not null` sin default. Nada de eso lo ve una corrida desde cero.
 *
 * Este archivo hace el ensayo: levanta la base EN EL ESTADO DE PRODUCCIÓN y
 * aplica las pendientes una por una, en el orden real. Si algo va a fallar el
 * día del despliegue, falla acá primero — con el nombre del archivo y sobre una
 * base de mentira, en vez de a mitad de camino sobre los datos de una familia.
 *
 * No reemplaza a la corrida desde cero: las dos preguntas son distintas y las
 * dos importan. Una base nueva (otra familia, otro entorno) sí parte de cero.
 */

const RAIZ = path.resolve(__dirname, "../../..");

/**
 * El escritor del SQL de los testigos se IMPORTA del script, no se reescribe:
 * si el test armara su propia consulta, probaría su copia y no la que corre
 * contra producción de verdad.
 */
const escritor = (await import(
  pathToFileURL(path.join(RAIZ, "scripts", "verificar-estado-produccion.mjs")).href
)) as { sqlDeTodosLosTestigos: (e: [string, { testigo: string }][]) => string };
const USUARIO = "11111111-1111-4111-8111-111111111111";

/**
 * Las que faltan: la diferencia entre la cadena del repo y lo que produccion
 * tiene.
 *
 * `ENSAYO_HASTA=0061` acota el ensayo a las pendientes HASTA ese número
 * inclusive. Existe para el despliegue CONTROLADO: cuando se va a aplicar una
 * sola migración —porque la siguiente pertenece a otro frente de trabajo y no
 * corresponde mezclarla— el ensayo tiene que probar exactamente eso y no "todo
 * lo pendiente". Ensayar de más es tan engañoso como ensayar de menos: diría
 * que probamos algo que no vamos a hacer.
 *
 * Sin la variable, el comportamiento es el de siempre: todas las pendientes.
 */
function pendientes(): string[] {
  const puestas = new Set(migracionesDeProduccion());
  const faltan = MIGRACIONES.filter((m) => !puestas.has(m));
  const hasta = process.env.ENSAYO_HASTA;
  if (!hasta) return faltan;
  // La regla de cortar por número vive en el arnés, no acá: dos copias de la
  // misma regla terminan discrepando, y la que discrepe hará que un ensayo diga
  // que probó algo que no probó.
  const acotadas = acotarHasta(faltan, hasta);
  // ERROR != VACÍO: pedir un ensayo acotado a un número que no está pendiente es
  // un error de quien lo pide, no un ensayo de cero migraciones que pasa solo.
  if (acotadas.length === 0) {
    throw new Error(
      `ENSAYO_HASTA=${hasta} no deja ninguna pendiente que ensayar. Pendientes: ${faltan.join(", ")}`,
    );
  }
  return acotadas;
}

let base!: Harness;

beforeAll(async () => {
  // Sin seeds a proposito: los seeds son fixtures de demo. Lo que se ensaya es
  // el SCHEMA, que es lo unico que las migraciones tocan.
  base = await levantarBase({ conSeeds: false, soloProduccion: true });
}, 180_000);

afterAll(async () => {
  await base?.cerrar();
});

describe("ensayo del despliegue: las pendientes, encima de lo que produccion ya tiene", () => {
  it("hay algo que ensayar, y es exactamente lo que el libro declara pendiente", () => {
    // Si esto queda en cero porque produccion se puso al dia, el test de abajo
    // pasaria sin aplicar nada — un verde que no significa nada. Se afirma
    // primero que hay trabajo, y se dice cuando ya no lo hay.
    const faltan = pendientes();
    if (faltan.length === 0) {
      // Caso legitimo: se aplicaron todas. Se declara en vez de fingir un ensayo.
      expect(migracionesDeProduccion()).toEqual(MIGRACIONES);
      return;
    }
    expect(faltan.length).toBeGreaterThan(0);
    // Van en el orden de la cadena, no en orden alfabetico: la 0036 va DESPUES
    // de la 0037, y aplicarlas por numero seria una secuencia que nadie probo.
    expect(faltan).toEqual(MIGRACIONES.filter((m) => faltan.includes(m)));
  });

  it("se aplican todas, en orden, sobre el estado real de produccion", async () => {
    const faltan = pendientes();
    const aplicadas: string[] = [];

    for (const archivo of faltan) {
      const sql = readFileSync(path.join(RAIZ, archivo), "utf8");
      try {
        await base.db.exec(sql);
        aplicadas.push(archivo);
      } catch (e) {
        // SE DETIENE Y DICE CUAL. Un "fallo el despliegue" sin nombre manda a
        // leer diecinueve archivos; con el nombre y el error de Postgres, la
        // reparacion empieza en la linea correcta.
        const detalle = e instanceof Error ? e.message : String(e);
        throw new Error(
          [
            `${archivo} NO se puede aplicar sobre el estado actual de produccion.`,
            "",
            `Postgres dijo: ${detalle}`,
            "",
            `Las ${aplicadas.length} anteriores si entraron. El dia del despliegue`,
            "esto habria dejado la base a medio migrar, que es el escenario del que",
            "no se sale sin respaldo.",
          ].join(String.fromCharCode(10)),
        );
      }
    }

    expect(aplicadas).toEqual(faltan);
  });

  it("despues del ensayo, el schema es el MISMO que sale de la cadena desde cero", async () => {
    /**
     * LO QUE ESTE TEST IMPIDE, Y QUE EL DE ARRIBA NO VE.
     *
     * "Las 19 se aplicaron sin reventar" no es lo mismo que "produccion quedo
     * como el repo dice". Una migracion con `create table if not exists` entra
     * sin quejarse sobre una tabla que ya existe con OTRA forma, y desde ese dia
     * produccion tiene un schema que ninguna prueba reproduce: todo verde acá,
     * y la app rompiendose alla. Es exactamente la familia de defecto que este
     * proyecto viene pagando.
     *
     * Se comparan las columnas —tabla, nombre, tipo y nulabilidad— de las dos
     * bases: la que acaba de hacer el ensayo y una levantada desde cero con la
     * cadena entera. Tienen que ser identicas.
     */
    const desdeCero = await levantarBase({ conSeeds: false });
    try {
      const consulta = `select table_name, column_name, data_type, is_nullable
                          from information_schema.columns
                         where table_schema = 'public'
                         order by table_name, column_name`;
      const ensayo = await base.filas<Record<string, string>>(consulta);
      const limpia = await desdeCero.filas<Record<string, string>>(consulta);

      const clave = (f: Record<string, string>) =>
        `${f.table_name}.${f.column_name} ${f.data_type} ${f.is_nullable}`;
      const a = new Set(ensayo.map(clave));
      const b = new Set(limpia.map(clave));

      const soloEnsayo = [...a].filter((k) => !b.has(k)).sort();
      const soloLimpia = [...b].filter((k) => !a.has(k)).sort();

      expect(
        { deMasEnProduccion: soloEnsayo, faltariaEnProduccion: soloLimpia },
        "aplicar las pendientes NO deja produccion igual que la cadena desde cero",
      ).toEqual({ deMasEnProduccion: [], faltariaEnProduccion: [] });

      // Que las dos bases tengan columnas: sin esto, dos consultas vacias
      // pasarian el test sin haber comparado nada.
      expect(a.size, "el ensayo no produjo ninguna columna").toBeGreaterThan(300);
    } finally {
      await desdeCero.cerrar();
    }
  }, 180_000);
});

/**
 * EL MISMO ENSAYO, PERO CON LA BASE OCUPADA.
 *
 * El bloque de arriba aplica las pendientes sobre el estado de producción y eso
 * ya encuentra mucho. Pero esa base está VACÍA DE DATOS, y hay una familia
 * entera de fallas que sólo existe cuando hay filas:
 *
 *   · `add column ... not null` sin default: intachable sobre cero filas,
 *     imposible sobre una.
 *   · `create unique index`: pasa siempre sobre una tabla vacía; muere si los
 *     datos que ya están tienen un duplicado.
 *   · `add constraint ... check`: Postgres lo VALIDA contra todas las filas
 *     existentes al crearlo. Sobre cero filas es un trámite.
 *
 * Y no es hipotético acá: la 0046 le agrega a `shopping_list_items` un check de
 * coherencia del precio, y producción tiene veinticinco líneas de lista que ese
 * check va a tener que aprobar una por una. Sobre la base vacía del bloque de
 * arriba, ese check se crea sin mirar nada.
 *
 * Así que esto siembra —con los RPC y las formas que usa el resto de la suite—
 * un hogar con su plan, su lista con líneas, sus lotes en la despensa y sus
 * porciones proyectadas, y RECIÉN AHÍ aplica las diecinueve. Los datos son
 * inventados y de laboratorio; lo que se copia de producción no son los valores
 * sino la FORMA: que las tablas que estas migraciones alteran no estén vacías.
 */
describe("ensayo del despliegue, con la base ocupada", () => {
  let base!: Harness;

  beforeAll(async () => {
    // Con seeds: el catálogo y el recetario son lo que producción de verdad
    // tiene adentro (464 recetas, 234 alimentos), y varias de las pendientes
    // tocan tablas que cuelgan de ahí.
    base = await levantarBase({ conSeeds: true, soloProduccion: true });

    const hogar = await crearHogar(base, USUARIO, "Ensayo", "Ana");

    await base.comoAdmin(async () => {
      // TRES alimentos distintos, no uno repetido: `shopping_items_suggestion_uniq`
      // impide dos sugerencias del mismo alimento en la misma lista, que es
      // justamente la clase de regla que sólo se descubre con datos adentro.
      const alimentos = await base.filas<{ id: string }>(
        "select id from public.ingredients where household_id is null order by canonical_name limit 3",
      );

      // Un plan de la semana con su día y una comida confirmada.
      const plan = (await base.fila<{ id: string }>(
        `insert into public.weekly_plans (household_id, week_start, status)
         values ($1, date_trunc('week', current_date)::date, 'DRAFT') returning id`,
        [hogar.householdId],
      ))!;
      await base.db.query(
        `insert into public.weekly_plan_days (plan_id, plan_date) values ($1, current_date)`,
        [plan.id],
      );

      // La lista de compras CON LÍNEAS: son las filas que el check de la 0046
      // va a tener que aprobar.
      const lista = await base.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, status)
         values ($1, $2, 'ACTIVE') returning id`,
        [hogar.householdId, plan!.id],
      );
      const lineas = [
        ["Pollo crudo", 500],
        ["Arroz", 300],
        ["Zanahoria", 250],
      ] as const;
      for (let i = 0; i < lineas.length; i += 1) {
        const [etiqueta, gramos] = lineas[i]!;
        await base.db.query(
          `insert into public.shopping_list_items
             (list_id, source, ingredient_id, label, unit, planned_quantity, purchase_basis)
           values ($1, 'STOCK_INTELLIGENCE', $2, $3, 'G', $4, 'RAW')`,
          [lista!.id, alimentos[i]!.id, etiqueta, gramos],
        );
      }

      // Y la despensa, que es la otra tabla que las pendientes alteran a fondo.
      // El resto de las tablas que las pendientes alteran y que producción tiene
      // ocupadas. No es decoración: cada una es una superficie donde un check o
      // un índice único de las 19 se va a validar contra filas de verdad. Las
      // cantidades no importan; que NO estén vacías, sí.
      const receta = (await base.fila<{ id: string }>(
        `select v.id from public.meal_template_versions v
          join public.meal_templates m on m.id = v.template_id
         where m.household_id is null and v.status = 'PUBLISHED' limit 1`,
      ))!;
      const dia = (await base.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 limit 1",
        [plan.id],
      ))!;
      const comida = (await base.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status, confirmed_at)
         values ($1, 'LUNCH', 'RECIPE', $2, 'CONFIRMED', now()) returning id`,
        [dia.id, receta.id],
      ))!;
      // El perfil se PUBLICA por su RPC, no se busca: un integrante recién creado
      // no tiene ninguno, y sin perfil no hay porción proyectada ni evaluación
      // clínica que sembrar — que son dos de las tablas que las pendientes
      // alteran.
      const publicado = (await base.fila<{ publish_nutrition_profile: string }>(
        `select public.publish_nutrition_profile($1, 'BASIC', $2, '{}'::jsonb,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'ensayo de despliegue')`,
        [hogar.memberId, `firma-ensayo-${hogar.memberId}`],
      ))!;
      const perfil = { id: publicado.publish_nutrition_profile };
      if (perfil.id !== null) {
        await base.db.query(
          `insert into public.member_serving_projections
             (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
              fit, adaptation_level, assignment_id, status)
           values ($1, $2, $3, 'ensayo/1.0.0', 'LUNCH', current_date, 'COMPATIBLE', 0, $4, 'PLANNED')`,
          [hogar.memberId, receta.id, perfil.id, comida.id],
        );
        await base.db.query(
          `insert into public.meal_clinical_assessments
             (member_id, version_id, assignment_id, assessed_on, engine_version, status)
           values ($1, $2, $3, current_date, 'ensayo/1.0.0', 'COMPATIBLE')`,
          [hogar.memberId, receta.id, comida.id],
        );
      }
      await base.db.query(
        `insert into public.nutrition_goals
           (member_id, goal_type, scope, meal_type, minimum, preferred, maximum, unit)
         values ($1, 'PROTEIN_G', 'PER_MEAL', 'LUNCH', 60, 90, 110, 'g')`,
        [hogar.memberId],
      );
      await base.db.query(
        `insert into public.member_clinical_restrictions
           (member_id, type, target, value, unit, severity, source, verification_status, valid_from)
         values ($1, 'NUTRIENT_MAX'::public.clinical_restriction_type, 'SODIUM_MG', 2000, 'mg',
                 'HARD', 'CLINICIAN_ENTERED', 'CONFIRMED', current_date - 1)`,
        [hogar.memberId],
      );
      await base.db.query(
        `insert into public.nutrition_events (household_id, event_date, event_type, title)
         values ($1, current_date, 'BARBECUE', 'Asado del ensayo')`,
        [hogar.householdId],
      );

      const lotes = [
        ["Lote viejo", 1200],
        ["Lote nuevo", 800],
      ] as const;
      for (let i = 0; i < lotes.length; i += 1) {
        const [etiqueta, cantidad] = lotes[i]!;
        // POR `add_manual_lot`, no por un insert directo: ese RPC escribe además la
        // fila de `inventory_movements`, que es otra de las tablas que las
        // pendientes alteran (la 0043 le agrega un índice único). Un insert a
        // mano deja el lote sin su movimiento y la tabla vacía — o sea, sin nada
        // contra lo que ese índice pueda chocar.
        await base.db.query(
          "select public.add_manual_lot($1, $2, $3, 'G', $4)",
          [hogar.householdId, etiqueta, cantidad, alimentos[i]!.id],
        );
      }
    });
  }, 180_000);

  afterAll(async () => {
    await base?.cerrar();
  });

  it("la base de ensayo quedó de verdad ocupada", async () => {
    // SIN ESTO EL TEST DE ABAJO NO SIGNIFICA NADA. Si la siembra fallara en
    // silencio, aplicar sobre cero filas volvería a pasar y el verde diría
    // exactamente lo mismo que decía antes de escribir todo esto.
    const conteo = await base.fila<Record<string, number>>(
      `select (select count(*) from public.shopping_list_items) as items,
              (select count(*) from public.inventory_lots)      as lotes,
              (select count(*) from public.ingredients)         as alimentos,
              (select count(*) from public.household_members)   as gente`,
    );
    expect(Number(conteo!.items), "sin líneas de lista no se valida el check de la 0046").toBeGreaterThan(0);
    expect(Number(conteo!.lotes), "sin lotes no se ejercita lo que la 0042/0048 le agregan").toBeGreaterThan(0);
    expect(Number(conteo!.alimentos)).toBeGreaterThan(100);
    expect(Number(conteo!.gente)).toBeGreaterThan(0);
  });

  // El nombre NO dice cuántas: decía "las 19" y quedó viejo el día que se
  // aplicaron. Un test que miente en su título hace perder tiempo al leer un
  // informe de CI.
  it("las pendientes se aplican sobre datos, no sobre una base vacía", async () => {
    // UN SOLO DUEÑO del conjunto pendiente: `pendientes()`. Calcularlo acá
    // de nuevo dejaba a este ensayo fuera de ENSAYO_HASTA, o sea aplicando
    // migraciones que el despliegue controlado NO va a aplicar.
    const faltan = pendientes();
    const aplicadas: string[] = [];

    for (const archivo of faltan) {
      const sql = readFileSync(path.join(RAIZ, archivo), "utf8");
      try {
        await base.db.exec(sql);
        aplicadas.push(archivo);
      } catch (e) {
        const detalle = e instanceof Error ? e.message : String(e);
        throw new Error(
          [
            `${archivo} se aplica sobre una base VACÍA pero NO sobre una con datos.`,
            "",
            `Postgres dijo: ${detalle}`,
            "",
            "Es la familia de falla que el ensayo de arriba no puede ver: un check que",
            "se valida contra las filas que ya están, un índice único que choca con un",
            "duplicado que ya existe, una columna not null sobre una tabla ocupada.",
            "",
            `Las ${aplicadas.length} anteriores sí entraron.`,
          ].join(String.fromCharCode(10)),
        );
      }
    }
    expect(aplicadas).toEqual(faltan);
  });

  it("los TESTIGOS del libro sobreviven al ensayo, no sólo el schema", async () => {
    /**
     * DESPUÉS DE APLICAR, CADA MIGRACIÓN TIENE QUE PODER RECONOCERSE.
     *
     * El test de arriba comprueba que las pendientes se aplican y que los datos
     * siguen ahí. Eso todavía no dice que el DÍA DEL DESPLIEGUE vayamos a poder
     * saber qué quedó puesto: eso lo dicen los testigos, y un testigo puede
     * quedar falso aunque la migración se haya aplicado perfecto — pasó dos
     * veces, con la 0022 y la 0023, cuando una migración posterior reescribió
     * justo lo que el testigo miraba.
     *
     * Acá se corren los 61 sobre la base del ensayo —estado de producción, con
     * datos, y las pendientes aplicadas encima— y se exige que TODOS contesten
     * verdadero. Si alguno no, el libro no va a poder decir qué tiene producción
     * después de desplegar, que es exactamente el estado "no se sabe" del que
     * este proyecto ya salió una vez.
     */
    const libro = cargarLibroDeProduccion();
    // EL ENSAYO PUEDE ESTAR ACOTADO, Y ENTONCES NO TODOS LOS TESTIGOS DEBEN DAR
    // VERDADERO. Con `ENSAYO_HASTA` se aplican sólo algunas pendientes; el
    // testigo de una que NO se aplicó tiene que dar FALSO, y exigirle verdadero
    // sería exigirle que mienta. Se parte en dos grupos y se afirman los dos:
    // los aplicados en verdadero, los no aplicados en falso — esa segunda mitad
    // es la que demuestra que el acotado funcionó de verdad y no aplicó de más.
    const aplicadasEnElEnsayo = new Set(
      pendientes().map((m) => m.split("/").pop() ?? m),
    );
    const entradas = libro.entradas.map(
      (e) => [e.archivo, { testigo: e.testigo }] as [string, { testigo: string }],
    );
    const deberiaDarVerdadero = (archivo: string): boolean =>
      libro.aplicadas.has(archivo) || aplicadasEnElEnsayo.has(archivo);
    const resultados = await base.db.exec(escritor.sqlDeTodosLosTestigos(entradas));
    const ultimo = resultados[resultados.length - 1];
    const filas = (ultimo?.rows ?? []) as unknown as { archivo: string; presente: unknown }[];

    // Contestaron TODOS: sin esto, cero filas dejaría la lista de mentirosos
    // vacía y el test verde por no haber mirado.
    expect(filas.length, "no contestaron todos los testigos").toBe(entradas.length);

    const mienten = filas
      .filter((f) => deberiaDarVerdadero(f.archivo) && f.presente !== true)
      .map(
        (f) =>
          `${f.archivo} — contestó ${f.presente === null ? "NULL" : "FALSO"} después del ensayo: ` +
          "tras desplegar, el libro no podría reconocer esta migración",
      )
      .sort();
    expect(mienten).toEqual([]);

    // La otra mitad: lo que NO se aplicó no puede dar verdadero. Un testigo que
    // dice "sí" sobre una migración ausente daría por desplegado algo que no
    // está, que es peor que no tener testigo.
    const mientenAlReves = filas
      .filter((f) => !deberiaDarVerdadero(f.archivo) && f.presente === true)
      .map((f) => `${f.archivo} — contestó VERDADERO sin haberse aplicado en este ensayo`)
      .sort();
    expect(mientenAlReves).toEqual([]);
  });

  it("y los datos que ya estaban siguen ahí, con su valor DESCONOCIDO y no en cero", async () => {
    // Migrar no puede perder filas, y tampoco puede inventarles un valor. Las
    // columnas de dinero que la 0042 agrega nacen UNKNOWN a propósito: una línea
    // de lista sin precio conocido no vale $0.
    const despues = await base.fila<Record<string, number>>(
      `select (select count(*) from public.shopping_list_items) as items,
              (select count(*) from public.inventory_lots)      as lotes,
              (select count(*) from public.inventory_lots where value_status = 'UNKNOWN') as lotes_sin_precio,
              (select count(*) from public.shopping_list_items where price_estimate_status = 'UNKNOWN') as items_sin_precio`,
    );
    expect(Number(despues!.items)).toBe(3);
    expect(Number(despues!.lotes)).toBe(2);
    expect(Number(despues!.lotes_sin_precio), "un lote sin precio quedó valorizado en algo").toBe(2);
    expect(Number(despues!.items_sin_precio), "una línea sin precio quedó valorizada en algo").toBe(3);
  });

  /**
   * QUÉ TABLAS TIENE QUE TENER FILAS EL ENSAYO, DERIVADO DE LAS PROPIAS MIGRACIONES.
   *
   * Sembrar "unas cuantas tablas" no sirve: la que se olvida es justamente la que
   * no se prueba. Esto lee las pendientes, saca las tablas que ALTERAN y que NO
   * crean ellas mismas —o sea, las que ya existían con datos adentro— y exige que
   * el ensayo las tenga ocupadas.
   *
   * Es la lección del defecto de la 0042 subida un nivel: ahí faltaban filas en
   * `inventory_lots` y por eso el backfill no disparaba el trigger. Arreglar ese
   * caso y seguir sembrando a mano habría dejado la misma trampa armada para la
   * próxima tabla.
   */
  function tablasQueAlteranLasPendientes(archivos: string[]): string[] {
    const alteradas = new Set<string>();
    const creadas = new Set<string>();
    for (const archivo of archivos) {
      const sql = readFileSync(path.join(RAIZ, archivo), "utf8");
      for (const m of sql.matchAll(/^alter\s+table\s+(?:only\s+)?public\.([a-z_0-9]+)/gim)) {
        alteradas.add(m[1]!.toLowerCase());
      }
      for (const m of sql.matchAll(/^create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_0-9]+)/gim)) {
        creadas.add(m[1]!.toLowerCase());
      }
    }
    return [...alteradas].filter((t) => !creadas.has(t)).sort();
  }

  /**
   * Tablas que las pendientes alteran y que el ensayo NO siembra, cada una con su
   * razón. Estar acá es una DECLARACIÓN, no un olvido: si mañana una migración
   * altera una tabla nueva y nadie la siembra, el test se pone rojo y obliga a
   * elegir entre sembrarla o escribir por qué no hace falta.
   *
   * Las razones de hoy salieron de contar filas en la producción real.
   */
  const NO_SE_SIEMBRAN: Readonly<Record<string, string>> = {
    // Vacío A PROPÓSITO, y eso es una afirmación, no un olvido.
    //
    // Las pendientes de hoy (0061 eventos, 0062 seguridad) alteran UNA sola
    // tabla que ya existía: `nutrition_events`. El ensayo la siembra, así que no
    // hay nada que eximir.
    //
    // Las tres exenciones que vivían acá —household_observed_yields,
    // meal_serving_records e invitations— se escribieron para el conjunto de
    // pendientes ANTERIOR, el de las 19 que ya se aplicaron. Al cambiar el
    // conjunto dejaron de corresponder a nada, y el segundo test de este bloque
    // las marcó como sobrantes. Se borran en vez de conservarse: una exención
    // que no aplica a ninguna migración pendiente se lee como "este caso está
    // pensado" cuando en realidad quedó colgando de un trabajo terminado, y la
    // próxima persona confía en ella sin motivo.
  };

  describe("el ensayo cubre TODAS las tablas que las pendientes alteran", () => {
    it("ninguna tabla alterada se queda sin filas por olvido", async () => {
      // UN SOLO DUEÑO del conjunto pendiente: `pendientes()`. Calcularlo acá
      // de nuevo dejaba a este ensayo fuera de ENSAYO_HASTA, o sea aplicando
      // migraciones que el despliegue controlado NO va a aplicar.
      const faltan = pendientes();
      const alteradas = tablasQueAlteranLasPendientes(faltan);

      // SIN PENDIENTES NO HAY NADA QUE CUBRIR, Y ESO ES LA META, NO UNA FALLA.
      //
      // El 2026-09-02 producción se puso al día con el repo entero y este
      // guardián se quedó sin trabajo. Se declara en vez de fingir: exigirle
      // tablas alteradas cuando no hay migración que las altere sería un rojo
      // que no señala ningún defecto, y un rojo que no señala nada es cómo un
      // equipo aprende a ignorar los rojos.
      //
      // Vuelve solo en cuanto alguien escriba la 0059.
      // QUE EL BARRIDO FUNCIONE se comprueba contra la cadena ENTERA, no contra
      // las pendientes: una pendiente puede legitimamente no alterar ninguna
      // tabla (la 0059 solo redefine funciones) y eso no significa que el
      // barrido se haya roto. Antes las dos preguntas iban juntas y la segunda
      // hacia fallar a la primera.
      const alterTablesEnTodaLaCadena = MIGRACIONES.reduce((n, m) => {
        const sql = readFileSync(path.join(RAIZ, m), "utf8");
        return n + (sql.match(/^alter\s+table\s+/gim) ?? []).length;
      }, 0);
      expect(alterTablesEnTodaLaCadena, "el barrido dejó de reconocer alter table").toBeGreaterThan(20);

      // Sin pendientes, o con pendientes que no alteran ninguna tabla que ya
      // existiera, no hay nada que cubrir. Eso es un estado legitimo y se
      // declara; no se finge un rojo.
      if (faltan.length === 0 || alteradas.length === 0) {
        expect(alteradas).toEqual([]);
        return;
      }

      const vacias: string[] = [];
      for (const tabla of alteradas) {
        if (tabla in NO_SE_SIEMBRAN) continue;
        const fila = await base.fila<{ n: string }>(`select count(*) as n from public.${tabla}`);
        if (Number(fila!.n) === 0) vacias.push(tabla);
      }

      expect(
        vacias,
        "estas tablas las alteran las migraciones pendientes y el ensayo las deja VACÍAS: " +
          "sobre cero filas un check no valida nada y un índice único no choca con nada. " +
          "Siémbralas en el beforeAll, o agrégalas a NO_SE_SIEMBRAN con su razón escrita.",
      ).toEqual([]);
    });

    it("lo declarado como no-sembrado sigue existiendo y sigue siendo alterado", () => {
      // Una exención que ya no corresponde a nada es peor que ninguna: se lee como
      // que el caso está pensado cuando en realidad quedó colgando.
      // UN SOLO DUEÑO del conjunto pendiente: `pendientes()`. Calcularlo acá
      // de nuevo dejaba a este ensayo fuera de ENSAYO_HASTA, o sea aplicando
      // migraciones que el despliegue controlado NO va a aplicar.
      const faltan = pendientes();
      const alteradas = new Set(tablasQueAlteranLasPendientes(faltan));
      // Mientras NO haya pendientes, las exenciones no sobran: quedan guardadas
      // esperando a la próxima migración. Revisarlas contra una lista vacía las
      // declararía a todas obsoletas y empujaría a borrar un conocimiento que
      // costó contar filas en la producción real.
      if (faltan.length === 0 || alteradas.size === 0) return;

      const sobrantes = Object.keys(NO_SE_SIEMBRAN).filter((t) => !alteradas.has(t));
      expect(
        sobrantes,
        "estas exenciones ya no aplican: ninguna migración pendiente altera esas tablas",
      ).toEqual([]);
    });
  });

});
