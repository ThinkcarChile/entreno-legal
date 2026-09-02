import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levantarBase, type Harness } from "./harness";

/**
 * §35 PARA EL PANEL DE FINANZAS: las columnas que el cargador pide EXISTEN.
 *
 * `contract-loaders.test.ts` hace esto para toda la app, pero su base llega
 * hasta la 0038 —`harness.ts` lo comparten varios agentes de este sprint— y ahí
 * `finance_period_accruals` todavía no existe: los cargadores de finanzas caen
 * en su lista de fallos por la BASE, no por el cargador, y un fallo que ya
 * estaba rojo deja de avisar cuando se rompe algo nuevo.
 *
 * Acá se aplican a mano las migraciones del sprint (mismo patrón que
 * `finanzas-panel.test.ts` y `finanzas-compras.test.ts`) y se corre el
 * `.select()` de verdad contra PostgreSQL. Si alguien agrega una columna al
 * cargador y no existe en la vista, este test se pone rojo antes de que la
 * pantalla reviente en producción con un DataShapeError.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const CARGADOR = path.resolve(__dirname, "../app/finanzas/queries.ts");

/** `.from("x").select("a, b, c")` con literales. Los interpolados se declaran. */
function extraerConsultas(fuente: string): { tabla: string; columnas: string[] }[] {
  const consultas: { tabla: string; columnas: string[] }[] = [];
  const re = /\.from\(\s*"([a-z_]+)"\s*\)\s*\.select\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fuente)) !== null) {
    const tabla = m[1]!;
    let i = m.index + m[0].length;
    let nivel = 1;
    const inicio = i;
    while (i < fuente.length && nivel > 0) {
      const ch = fuente[i]!;
      if (ch === "(") nivel += 1;
      else if (ch === ")") nivel -= 1;
      i += 1;
    }
    const argumento = fuente.slice(inicio, i - 1);
    if (argumento.includes("${")) continue;
    const literales = [...argumento.matchAll(/(["'`])([\s\S]*?)\1/g)].map((x) => x[2]!);
    // El primer literal es la lista de columnas; los siguientes son opciones
    // (`count: "exact"`), que NO son columnas.
    const cuerpo = (literales[0] ?? "").replace(/\s+/g, " ").trim();
    if (cuerpo.length === 0 || cuerpo === "*") continue;
    consultas.push({
      tabla,
      columnas: cuerpo
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
    });
  }
  return consultas;
}

let h: Harness;

beforeAll(async () => {
  h = await levantarBase();
  await h.comoAdmin(async () => {
    const testigos: Array<[string, string]> = [
      ["supabase/migrations/0042_finance_foundations.sql", "to_regclass('public.currency_units')"],
      ["supabase/migrations/0043_purchases_core.sql", "to_regclass('public.purchase_charges')"],
      ["supabase/migrations/0044_cost_allocations.sql", "to_regclass('public.cost_allocations')"],
      ["supabase/migrations/0046_price_observations.sql", "to_regclass('public.price_observations')"],
      ["supabase/migrations/0047_food_budgets.sql", "to_regclass('public.household_food_budgets')"],
      [
        "supabase/migrations/0048_finance_integrity.sql",
        "to_regclass('public.finance_period_accruals')",
      ],
    ];
    for (const [archivo, testigo] of testigos) {
      const ya = await h.fila<{ t: string | null }>(`select ${testigo} as t`);
      if (ya!.t !== null) continue;
      await h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8"));
    }
  });
}, 120000);

afterAll(async () => {
  await h?.cerrar();
});

describe("§35 — el cargador de /finanzas le pide a la base columnas que existen", () => {
  it("encontró las consultas del cargador (no está mirando el vacío)", () => {
    const consultas = extraerConsultas(readFileSync(CARGADOR, "utf8"));
    const tablas = consultas.map((c) => c.tabla);
    expect(tablas).toContain("finance_period_accruals");
    // Las dos alarmas que antes iban escritas a mano en cero: si alguien vuelve
    // a apagarlas, sus consultas desaparecen y este caso lo dice.
    expect(tablas).toContain("late_recognition_report");
    expect(tablas).toContain("finance_integrity_report");
    // Y la pregunta por los cargos que nunca llegaron a los libros.
    expect(tablas).toContain("purchase_charges");
  });

  it("ninguna consulta pide una columna inexistente", async () => {
    const fallos: string[] = [];
    for (const c of extraerConsultas(readFileSync(CARGADOR, "utf8"))) {
      try {
        await h.comoAdmin(() =>
          h.db.query(`select ${c.columnas.join(", ")} from public.${c.tabla} limit 0`),
        );
      } catch (e) {
        fallos.push(`${c.tabla}: ${(e as Error).message}`);
      }
    }
    expect(fallos).toEqual([]);
  });
});
