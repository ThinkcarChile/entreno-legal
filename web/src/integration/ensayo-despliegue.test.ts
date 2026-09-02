import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levantarBase, MIGRACIONES, migracionesDeProduccion, type Harness } from "./harness";

/**
 * EL ENSAYO DEL DESPLIEGUE.
 *
 * Todo lo demás levanta la base DESDE CERO con la cadena completa, y eso
 * responde una pregunta: "¿esto funciona si aplicamos todo de una?". No es la
 * pregunta del despliegue.
 *
 * Producción no está en cero. Tiene 38 migraciones puestas y le faltan 19. Lo
 * que va a pasar el día que se apliquen no es "la cadena entera sobre una base
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

/** Las que faltan: la diferencia entre la cadena del repo y lo que produccion tiene. */
function pendientes(): string[] {
  const puestas = new Set(migracionesDeProduccion());
  return MIGRACIONES.filter((m) => !puestas.has(m));
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
  });
});
