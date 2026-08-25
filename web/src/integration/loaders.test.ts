import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { columnsOf } from "@/lib/supabase/rows";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Contrato CARGADOR ↔ BASE (hueco encontrado en la demo viva del Sprint 10).
 *
 * Los tests de integración arman el input del motor a mano, así que nunca
 * ejercitaban el `.select()` real de los cargadores: `purchase_movements` se
 * pedía SIN `weight_basis` mientras el schema lo exigía, y /pantry reventaba
 * contra el Supabase real con DataShapeError.
 *
 * Estos tests van al grano: cada columna que el schema del cargador declara
 * debe EXISTIR en la vista/tabla real, y la fila que vuelve debe parsear.
 */

const USER = "00000000-0000-0000-0000-0000000000fa";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;

const unitSchema = z.enum(["G", "ML", "UNIT"]);
const weightBasis = z.enum(["RAW", "COOKED", "DRAINED", "EDIBLE_PORTION", "AS_PACKAGED"]);
const numerico = z.union([z.number(), z.string().transform(Number)]);

// Los MISMOS schemas que declara el cargador de stock.
const wasteRow = z.object({
  ingredient_id: z.string().nullable(),
  unit: unitSchema,
  weight_basis: weightBasis,
  quantity: numerico,
  estimated_cost: numerico.nullable(),
  // PGlite entrega Date en timestamptz; PostgREST entrega texto. El contrato
  // que importa acá es la EXISTENCIA de la columna y el resto de los tipos.
  created_at: z.union([z.string(), z.date()]),
});
const purchaseRow = z.object({
  ingredient_id: z.string(),
  unit: unitSchema,
  weight_basis: weightBasis,
  quantity: numerico,
  created_at: z.union([z.string(), z.date()]),
});

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar Cargadores", "Fran");
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  await h.como(USER, async () => {
    const lote = (await h.fila<{ add_manual_lot: string }>(
      "select public.add_manual_lot($1, 'Pollo cargador', 1000, 'G', $2)",
      [hogar.householdId, polloId],
    ))!.add_manual_lot;
    // Una merma con causa, para que la vista de merma tenga fila.
    await h.db.query("select public.discard_lot($1, 'SPOILED')", [lote]);
  });
}, 60000);

afterAll(async () => {
  await h.cerrar();
});

describe("las columnas que el cargador pide EXISTEN y parsean", () => {
  it("purchase_movements: columnsOf(schema) trae filas que el schema acepta", async () => {
    const cols = columnsOf(purchaseRow);
    expect(cols).toContain("weight_basis"); // la que faltaba en producción
    const filas = await h.como(USER, () =>
      h.filas(`select ${cols} from public.purchase_movements where household_id = $1`, [
        hogar.householdId,
      ]),
    );
    expect(filas.length).toBeGreaterThan(0);
    expect(() => z.array(purchaseRow).parse(filas)).not.toThrow();
  });

  it("waste_movements: idem, con estimated_cost incluido", async () => {
    const cols = columnsOf(wasteRow);
    expect(cols).toContain("weight_basis");
    const filas = await h.como(USER, () =>
      h.filas(`select ${cols} from public.waste_movements where household_id = $1`, [
        hogar.householdId,
      ]),
    );
    expect(filas.length).toBeGreaterThan(0);
    expect(() => z.array(wasteRow).parse(filas)).not.toThrow();
  });

  it("una columna inventada por el schema explota acá, no en producción", async () => {
    const conFantasma = wasteRow.extend({ columna_que_no_existe: z.string() });
    await expect(
      h.como(USER, () =>
        h.filas(`select ${columnsOf(conFantasma)} from public.waste_movements`),
      ),
    ).rejects.toThrow();
  });
});

describe("columnsOf deriva del schema, no de una lista escrita a mano", () => {
  it("incluye todas las claves y respeta los embeds extra", () => {
    expect(columnsOf(purchaseRow).split(", ")).toEqual([
      "ingredient_id",
      "unit",
      "weight_basis",
      "quantity",
      "created_at",
    ]);
    expect(columnsOf(z.object({ id: z.string() }), "otra ( x )")).toBe("id, otra ( x )");
  });
});
