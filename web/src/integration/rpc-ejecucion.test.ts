import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";
import { CONTRATO_RPC } from "./contrato-rpc";

/**
 * §2 y §3 — SE LLAMAN DE VERDAD, no se le pregunta al catálogo.
 *
 * `has_function_privilege` dice lo que el catálogo CREE. Este archivo ejecuta:
 * toma cada RPC del contrato, arma la llamada desde su firma real en `pg_proc`
 * —un `null` tipado por argumento— y la corre dos veces, como `anon` y como un
 * usuario con sesión.
 *
 * QUÉ SE AFIRMA, Y POR QUÉ ASÍ:
 *
 *   como anon:           tiene que fallar POR PRIVILEGIO ("permission denied"),
 *                        y el censo de las 123 tablas no puede moverse.
 *   como authenticated:  puede fallar por lo que quiera —falta un uuid, el hogar
 *                        no es suyo, el argumento es null— MENOS por privilegio.
 *
 * Esa asimetría es la clave. No hace falta armarle a cada función un caso de uso
 * válido (serían 84 fixtures y ninguno probaría lo que acá importa): alcanza con
 * separar "la base no te deja" de "los datos no dan". Un `permission denied`
 * como authenticated es una pantalla rota; cualquier otro error es la función
 * haciendo su trabajo.
 *
 * Los argumentos van todos en `null` a propósito. Es lo más lejos que se puede
 * llegar sin inventar datos, y todas estas funciones comprueban pertenencia
 * antes de escribir, así que un `null` se estrella contra la guarda y no contra
 * una tabla. Igual se mide el censo antes y después: si alguna escribiera, se ve.
 */

let base: Harness;
const USUARIO = "00000000-0000-4000-8000-0000000000e1";
let hogar: { householdId: string; memberId: string };

/** `select public.fn(null::uuid, null::jsonb, ...)`, armado desde la firma real. */
async function llamadasGeneradas(): Promise<{ rpc: string; sql: string }[]> {
  const filas = await base.filas<{ proname: string; sql: string }>(
    `select p.proname,
            'select public.' || quote_ident(p.proname) || '(' ||
              coalesce(
                (select string_agg('null::' || format_type(t.oid, null), ', ' order by a.ord)
                   from unnest(p.proargtypes) with ordinality as a(oid, ord)
                   join pg_type t on t.oid = a.oid),
                '') || ')' as sql
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1)
      order by p.proname`,
    [CONTRATO_RPC],
  );
  // Una función puede estar sobrecargada; se prueba la primera de cada nombre.
  const vistas = new Set<string>();
  return filas
    .filter((f) => (vistas.has(f.proname) ? false : (vistas.add(f.proname), true)))
    .map((f) => ({ rpc: f.proname, sql: f.sql }));
}

async function censo(): Promise<Record<string, number>> {
  const ts = (
    await base.filas<{ t: string }>(
      `select tablename as t from pg_tables where schemaname = 'public' order by 1`,
    )
  ).map((r) => r.t);
  const sql = ts
    .map((t) => `select '${t}' as t, count(*)::int as n from public.${t}`)
    .join(" union all ");
  const f = await base.filas<{ t: string; n: number }>(sql);
  return Object.fromEntries(f.map((r) => [r.t, r.n]));
}

/** Corre `sql` con el rol indicado y devuelve el mensaje de error, o "" si pasó. */
async function correrComo(rol: "anon" | "authenticated", sql: string): Promise<string> {
  await base.db.query("select set_config('request.jwt.claim.sub', $1, false)", [
    rol === "authenticated" ? USUARIO : "",
  ]);
  await base.db.exec(`set role ${rol};`);
  try {
    await base.db.query(sql);
    return "";
  } catch (e) {
    return String((e as Error).message ?? e);
  } finally {
    await base.db.exec("reset role;");
  }
}

const ES_PRIVILEGIO = (m: string) =>
  m.includes("permission denied") || m.includes("must be owner");

let generadas: { rpc: string; sql: string }[];

beforeAll(async () => {
  base = await levantarBase({ conSeeds: false });
  hogar = await crearHogar(base, USUARIO, "Hogar de ejecución", "Elena");
  void hogar;
  generadas = await llamadasGeneradas();
}, 240_000);

afterAll(async () => {
  await base?.cerrar();
});

describe("§2 — anon llama TODAS las RPC del contrato y no consigue nada", () => {
  it("se generó una llamada por cada RPC del contrato", () => {
    // SIN ESTO EL RESTO ES VACUO. Si la consulta de firmas devolviera cero, los
    // dos tests de abajo recorrerían una lista vacía y pasarían sin ejecutar
    // nada. Se afirma la cobertura antes de afirmar el resultado.
    const faltan = CONTRATO_RPC.filter((r) => !generadas.some((g) => g.rpc === r));
    expect(faltan, "estas RPC del contrato no existen en el esquema").toEqual([]);
    expect(generadas.length).toBeGreaterThan(70);
  });

  it("todas fallan POR PRIVILEGIO, y el censo no se mueve", async () => {
    const antes = await censo();
    const noBloqueadas: string[] = [];
    for (const g of generadas) {
      const error = await correrComo("anon", g.sql);
      if (error === "") noBloqueadas.push(`${g.rpc}: EJECUTÓ SIN ERROR`);
      else if (!ES_PRIVILEGIO(error)) noBloqueadas.push(`${g.rpc}: ${error.slice(0, 80)}`);
    }
    expect(
      noBloqueadas,
      "anon llegó a estas RPC sin que la base lo frenara por privilegio",
    ).toEqual([]);
    expect(await censo(), "el censo cambió: anon escribió algo").toEqual(antes);
  });
});

describe("§3 — con sesión, ninguna RPC está bloqueada por privilegio", () => {
  it("AUTH_RPC_COMPATIBILITY: ningún `permission denied` con sesión", async () => {
    const bloqueadas: string[] = [];
    for (const g of generadas) {
      const error = await correrComo("authenticated", g.sql);
      if (error !== "" && ES_PRIVILEGIO(error)) bloqueadas.push(`${g.rpc}: ${error.slice(0, 90)}`);
    }
    expect(
      bloqueadas,
      "la app llama estas RPC y a un usuario con sesión la base se lo niega",
    ).toEqual([]);
  });

  it("y la sesión SÍ cambia el resultado: no pasa por dar lo mismo", async () => {
    /**
     * El control de la afirmación de arriba. Si `correrComo` estuviera roto —si
     * el `set role` no tomara, o si los errores no llegaran— los dos tests
     * pasarían igual: uno por ver siempre "permission denied" y el otro por no
     * verlo nunca. Acá se exige que la MISMA llamada dé resultados distintos
     * según el rol, que es la única forma de saber que el rol se está aplicando.
     */
    const una = generadas.find((g) => g.rpc === "log_intake");
    expect(una, "log_intake salió del contrato: elegir otra para este control").toBeDefined();
    const comoAnon = await correrComo("anon", una!.sql);
    const comoUsuario = await correrComo("authenticated", una!.sql);
    expect(ES_PRIVILEGIO(comoAnon)).toBe(true);
    expect(ES_PRIVILEGIO(comoUsuario)).toBe(false);
    expect(comoUsuario).not.toBe(comoAnon);
  });
});
