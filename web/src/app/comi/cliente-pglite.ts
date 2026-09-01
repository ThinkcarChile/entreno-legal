import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * UN CLIENTE DE SUPABASE DE MENTIRA SOBRE PGLITE, PARA LOS TESTS DE ESTA
 * PANTALLA.
 *
 * Los lectores de /comi hablan el dialecto del cliente de Supabase
 * (`from/select/eq/gte/lte/is/in/order`) y el harness de integración habla SQL.
 * Esto traduce EXACTAMENTE ese subconjunto y nada más: si mañana un lector usa
 * un método nuevo, revienta acá con nombre y apellido en vez de dar un verde
 * silencioso.
 *
 * Vive en un archivo propio —y no copiado en cada test— porque ya son dos los
 * archivos que lo necesitan, y una copia que se queda atrás es un test que
 * prueba un cliente que la aplicación ya no usa.
 *
 * El `as unknown as SupabaseClient` del final es la única mentira al compilador,
 * y es a propósito: la alternativa era no ejercitar NUNCA los lectores de verdad
 * contra un Postgres de verdad, que es exactamente el hueco que el Sprint 10
 * pagó caro con /pantry.
 */

/** Lo mínimo del harness de integración que este adaptador necesita. */
export interface FuenteDeFilas {
  filas<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function clienteSobrePGlite(fuente: FuenteDeFilas): SupabaseClient {
  const from = (tabla: string) => {
    const condiciones: string[] = [];
    const ordenes: string[] = [];
    const parametros: unknown[] = [];
    let columnas = "*";

    const marcador = (valor: unknown): string => {
      parametros.push(valor);
      return `$${parametros.length}`;
    };

    // El nombre de columna NO se interpola sin mirar: viene del código de la
    // aplicación y no de nadie de afuera, pero un identificador raro tiene que
    // reventar acá y no llegar armado a la consulta.
    const identificador = (col: string): string => {
      if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
        throw new Error(`el adaptador no ordena por «${col}»: no parece un nombre de columna`);
      }
      return col;
    };

    const ejecutar = async () => {
      const donde = condiciones.length === 0 ? "" : ` where ${condiciones.join(" and ")}`;
      const orden = ordenes.length === 0 ? "" : ` order by ${ordenes.join(", ")}`;
      try {
        const filas = await fuente.filas(
          `select ${columnas} from public.${tabla}${donde}${orden}`,
          parametros,
        );
        return { data: filas, error: null };
      } catch (e) {
        // Se devuelve con la forma de PostgREST para que el lector tome su
        // camino de error de verdad y lance `DataAccessError`.
        return {
          data: null,
          error: { message: (e as Error).message, code: "TEST", details: null, hint: null },
        };
      }
    };

    const builder = {
      select(cols: string) {
        columnas = cols;
        return builder;
      },
      eq(col: string, valor: unknown) {
        condiciones.push(`${col} = ${marcador(valor)}`);
        return builder;
      },
      gte(col: string, valor: unknown) {
        condiciones.push(`${col} >= ${marcador(valor)}`);
        return builder;
      },
      lte(col: string, valor: unknown) {
        condiciones.push(`${col} <= ${marcador(valor)}`);
        return builder;
      },
      is(col: string, valor: unknown) {
        if (valor !== null) throw new Error("el adaptador solo traduce `is null`");
        condiciones.push(`${col} is null`);
        return builder;
      },
      in(col: string, valores: readonly unknown[]) {
        if (valores.length === 0) {
          condiciones.push("false");
          return builder;
        }
        condiciones.push(`${col} in (${valores.map((v) => marcador(v)).join(", ")})`);
        return builder;
      },
      order(col: string, opciones?: { ascending?: boolean }) {
        const asc = opciones === undefined || opciones.ascending !== false;
        ordenes.push(`${identificador(col)} ${asc ? "asc" : "desc"}`);
        return builder;
      },
      then<T>(resolver: (v: unknown) => T, rechazar?: (e: unknown) => T) {
        return ejecutar().then(resolver, rechazar);
      },
    };
    return builder;
  };

  return { from } as unknown as SupabaseClient;
}
