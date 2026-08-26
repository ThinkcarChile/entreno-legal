import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * CONCURRENCIA Y OUTBOX (Integration Gate §39 y §40).
 *
 * Dos personas de la misma familia tocan el mismo botón a la vez. Cada
 * operación con efecto FÍSICO debe ocurrir exactamente una vez: el segundo
 * intento devuelve lo ya registrado o falla, pero jamás duplica materia.
 *
 * Las llamadas van en paralelo de verdad (Promise.all sobre la misma conexión
 * PGlite, que las serializa como haría PostgreSQL con dos sesiones).
 */

const USER = "00000000-0000-0000-0000-00000000cc01";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;
let plan: string;
let asignacion: string;
let perfil: string;
let versionPollo: string;

/** Ejecuta dos veces la misma llamada y devuelve ambos resultados. */
async function dobleSubmit<T>(fn: () => Promise<T>): Promise<[PromiseSettledResult<T>, PromiseSettledResult<T>]> {
  const [a, b] = await Promise.allSettled([fn(), fn()]);
  return [a, b];
}

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar Concurrencia", "Fran");
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  await h.como(USER, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);
    perfil = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-conc', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'conc')`,
      [hogar.memberId],
    ))!.publish_nutrition_profile;
    plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
      [hogar.householdId],
    ))!.ensure_weekly_plan;
    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
      [plan],
    ))!.id;
    asignacion = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2 returning id`,
      [dia, versionPollo],
    ))!.id;
  });
}, 120000);

afterAll(async () => {
  await h?.cerrar();
});

function porciones(fecha: string) {
  return JSON.stringify([
    {
      member_id: hogar.memberId,
      version_id: versionPollo,
      profile_id: perfil,
      optimizer_version: "portion-optimizer/1.0.0",
      meal_type: "LUNCH",
      serving_date: fecha,
      fit: "COMPATIBLE",
      adaptation_level: 0,
      score: 90,
      nutrition: {},
      completeness: {},
      reasons: [],
      unmet_constraints: [],
      components: [
        {
          label: "Pechuga de pollo",
          base_quantity: 200,
          proposed_quantity: 200,
          unit: "G",
          weight_basis: "RAW",
          cooking_method: "BAKED",
          added_fat_g: 0,
          sort_order: 1,
          ingredient_id: polloId,
        },
      ],
      substitutions: [],
    },
  ]);
}

describe("§39 — doble submit: un solo efecto físico", () => {
  it("doble CONFIRM de la misma comida deja UNA porción por participante", async () => {
    const fecha = (await h.fila<{ d: string }>(
      "select plan_date::text as d from public.weekly_plan_days where id = (select day_id from public.meal_assignments where id = $1)",
      [asignacion],
    ))!.d;
    await dobleSubmit(() =>
      h.como(USER, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [asignacion, porciones(fecha)]),
      ),
    );
    const n = await h.como(USER, () =>
      h.filas("select id from public.member_serving_projections where assignment_id = $1", [asignacion]),
    );
    expect(n).toHaveLength(1);
  });

  it("doble ALTA de lote no duplica el movimiento de compra", async () => {
    // add_manual_lot NO es idempotente por diseño (cada alta es un lote real):
    // lo que se verifica es que cada llamada produzca exactamente UN lote con
    // UN movimiento, sin efectos cruzados.
    const [r1, r2] = await dobleSubmit(() =>
      h.como(USER, async () =>
        (await h.fila<{ add_manual_lot: string }>(
          "select public.add_manual_lot($1, 'Pollo conc', 500, 'G', $2)",
          [hogar.householdId, polloId],
        ))!.add_manual_lot,
      ),
    );
    const ids = [r1, r2].filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<string>).value);
    expect(ids.length).toBe(2);
    for (const id of ids) {
      const movs = await h.como(USER, () =>
        h.filas("select id from public.inventory_movements where lot_id = $1", [id]),
      );
      expect(movs).toHaveLength(1);
    }
  });

  it("doble SPLIT del mismo lote no parte dos veces (el segundo no encuentra cantidad)", async () => {
    const lote = await h.como(USER, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Pollo split', 1000, 'G', $2)",
        [hogar.householdId, polloId],
      ))!.add_manual_lot,
    );
    const [r1, r2] = await dobleSubmit(() =>
      h.como(USER, () => h.db.query("select public.split_lot($1, array[600, 400]::numeric[])", [lote])),
    );
    const exitos = [r1, r2].filter((x) => x.status === "fulfilled").length;
    const hijos = await h.como(USER, () =>
      h.filas<{ quantity: string }>(
        "select quantity::text from public.inventory_lots where parent_lot_id = $1",
        [lote],
      ),
    );
    // Uno de los dos parte; el otro se encuentra el lote en 0 y falla.
    expect(exitos).toBeGreaterThanOrEqual(1);
    expect(hijos).toHaveLength(2);
    expect(hijos.reduce((a, x) => a + Number(x.quantity), 0)).toBe(1000);
  });

  it("doble SERVIDO de la misma comida descuenta una sola vez", async () => {
    const fecha = (await h.fila<{ d: string }>(
      "select plan_date::text as d from public.weekly_plan_days where id = (select day_id from public.meal_assignments where id = $1)",
      [asignacion],
    ))!.d;
    await h.como(USER, () =>
      h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [asignacion, porciones(fecha)]),
    );
    await h.como(USER, () =>
      h.db.query("select public.add_manual_lot($1, 'Pollo consumo', 1000, 'G', $2)", [
        hogar.householdId,
        polloId,
      ]),
    );
    // FEFO puede tomar de cualquier lote del alimento: lo que importa es el
    // TOTAL en la despensa, que debe bajar exactamente una vez.
    const total = async () =>
      Number(
        (await h.como(USER, () =>
          h.fila<{ s: string }>(
            "select coalesce(sum(quantity), 0)::text as s from public.inventory_lots where household_id = $1 and ingredient_id = $2 and status = 'AVAILABLE'",
            [hogar.householdId, polloId],
          ),
        ))!.s,
      );
    const antes = await total();

    await dobleSubmit(() =>
      h.como(USER, () => h.db.query("select public.consume_planned_meal($1)", [asignacion])),
    );

    // 200 g de UNA porción, una sola vez. Jamás 400.
    expect(antes - (await total())).toBe(200);
    // La porción se movió UNA vez. Desde 0036 el estado que gana la carrera es
    // SERVED (servir no es comer): cambia el nombre del estado, no el hecho de
    // que solo uno de los dos submits lo mueve.
    const servidas = await h.como(USER, () =>
      h.filas(
        "select id from public.member_serving_projections where assignment_id = $1 and status = 'SERVED'",
        [asignacion],
      ),
    );
    expect(servidas).toHaveLength(1);
    // Y hay UN solo acto físico: el segundo submit no escribió un segundo
    // registro de servido, que es lo único que autoriza descontar.
    const registros = await h.como(USER, () =>
      h.filas(
        `select id from public.meal_serving_records
         where assignment_id = $1 and status = 'ACTIVE'`,
        [asignacion],
      ),
    );
    expect(registros).toHaveLength(1);
  });

  it("doble APROBACIÓN de la misma orden crea UNA orden", async () => {
    const proveedor = await h.como(USER, async () =>
      (await h.fila<{ id: string }>(
        "insert into public.suppliers (household_id, name) values ($1, 'Prov conc') returning id",
        [hogar.householdId],
      ))!.id,
    );
    const items = JSON.stringify([
      { ingredient_id: polloId, label: "Pollo", required_quantity: 500, suggested_quantity: 500, unit: "G" },
    ]);
    const [r1, r2] = await dobleSubmit(() =>
      h.como(USER, async () =>
        (await h.fila<{ create_procurement_order: string }>(
          "select public.create_procurement_order($1, $2, null, null, 'CONC:1', 'v', $3::jsonb)",
          [hogar.householdId, proveedor, items],
        ))!.create_procurement_order,
      ),
    );
    const ids = new Set(
      [r1, r2].filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<string>).value),
    );
    expect(ids.size).toBe(1);
    const ordenes = await h.como(USER, () =>
      h.filas("select id from public.procurement_orders where dedupe_key = 'CONC:1'"),
    );
    expect(ordenes).toHaveLength(1);
  });

  it("doble RECEPCIÓN de la misma orden crea los lotes una sola vez", async () => {
    const proveedor = await h.como(USER, async () =>
      (await h.fila<{ id: string }>(
        "insert into public.suppliers (household_id, name) values ($1, 'Prov recibo') returning id",
        [hogar.householdId],
      ))!.id,
    );
    const orden = await h.como(USER, async () =>
      (await h.fila<{ create_procurement_order: string }>(
        "select public.create_procurement_order($1, $2, null, null, 'CONC:2', 'v', $3::jsonb)",
        [
          hogar.householdId,
          proveedor,
          JSON.stringify([
            { ingredient_id: polloId, label: "Pollo recibo", required_quantity: 700, suggested_quantity: 700, unit: "G" },
          ]),
        ],
      ))!.create_procurement_order,
    );
    await h.como(USER, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [orden]));
    await dobleSubmit(() =>
      h.como(USER, () => h.db.query("select public.receive_procurement_order($1)", [orden])),
    );
    const lotes = await h.como(USER, () =>
      h.filas("select id from public.inventory_lots where label = 'Pollo recibo'"),
    );
    expect(lotes).toHaveLength(1);
  });

  it("doble REGENERACIÓN de la lista no crea dos revisiones con el mismo número", async () => {
    await h.como(USER, () =>
      h.db.query(
        "insert into public.shopping_lists (household_id, plan_id, status) values ($1, $2, 'ACTIVE') on conflict do nothing",
        [hogar.householdId, plan],
      ),
    );
    const lista = (await h.como(USER, () =>
      h.fila<{ id: string }>("select id from public.shopping_lists where plan_id = $1", [plan]),
    ))!.id;
    await dobleSubmit(() =>
      h.como(USER, () =>
        h.db.query(
          "select public.generate_shopping_revision($1, 'firma-conc', 'motor/1.0', '[]'::jsonb, '{}'::jsonb, $2::jsonb)",
          [
            lista,
            JSON.stringify([
              { line_key: "k1", ingredient_id: polloId, label: "Pollo", unit: "G", required_quantity: 100,
                purchase_basis: "RAW", provenance: [] },
            ]),
          ],
        ),
      ),
    );
    const revs = await h.como(USER, () =>
      h.filas<{ revision_number: number }>(
        "select revision_number from public.shopping_list_revisions where list_id = $1",
        [lista],
      ),
    );
    const numeros = revs.map((r) => r.revision_number);
    expect(new Set(numeros).size).toBe(numeros.length); // sin números repetidos
  });
});

describe("§40 — outbox sin duplicados funcionales", () => {
  it("las claves de dedupe son únicas y estables", async () => {
    const eventos = await h.comoAdmin(() =>
      h.filas<{ dedupe_key: string; event_type: string }>(
        "select dedupe_key, event_type from public.domain_events where household_id = $1",
        [hogar.householdId],
      ),
    );
    const claves = eventos.map((e) => e.dedupe_key);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it("reintentar una operación no agrega un evento equivalente", async () => {
    const lote = await h.como(USER, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Pollo evento', 300, 'G', $2)",
        [hogar.householdId, polloId],
      ))!.add_manual_lot,
    );
    const freezer = (await h.como(USER, () =>
      h.fila<{ id: string }>(
        "select id from public.storage_locations where household_id = $1 and kind = 'FREEZER' limit 1",
        [hogar.householdId],
      ),
    ))!.id;
    await h.como(USER, () => h.db.query("select public.move_lot($1, $2)", [lote, freezer]));
    const antes = (await h.comoAdmin(() =>
      h.filas("select id from public.domain_events where event_type = 'LOT_FROZEN'"),
    )).length;
    // Mover otra vez al MISMO congelador: ya está congelado, no hay evento nuevo.
    await h.como(USER, () => h.db.query("select public.move_lot($1, $2)", [lote, freezer]));
    const despues = (await h.comoAdmin(() =>
      h.filas("select id from public.domain_events where event_type = 'LOT_FROZEN'"),
    )).length;
    expect(despues).toBe(antes);
  });
});

// ---------------------------------------------------------------------------
// GATE FINAL §2/§15 — lo que falta de la matriz de doble invocación
// ---------------------------------------------------------------------------

describe("gate final §2/§15", () => {
  it("doble RECEPCIÓN de la lista de compras crea los lotes UNA vez", async () => {
    await h.como(USER, async () => {
      const lista = (await h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, status)
         values ($1, $2, 'ACTIVE')
         on conflict (plan_id) do update set status = 'ACTIVE'
         returning id`,
        [hogar.householdId, plan],
      ))!.id;
      await h.db.query(
        `insert into public.shopping_list_items
           (list_id, ingredient_id, label, required_quantity, planned_quantity, unit,
            purchase_basis, status, source)
         values ($1, $2, 'Pollo recepción doble', 900, 900, 'G', 'RAW', 'PURCHASED', 'MANUAL')`,
        [lista, polloId],
      );
      await h.db.query("update public.shopping_lists set status = 'COMPLETED' where id = $1", [
        lista,
      ]);

      await dobleSubmit(() => h.db.query("select public.receive_shopping_list($1)", [lista]));

      const lotes = await h.filas(
        `select id from public.inventory_lots
         where household_id = $1 and label = 'Pollo recepción doble'`,
        [hogar.householdId],
      );
      expect(lotes).toHaveLength(1);
      const movs = await h.filas(
        `select id from public.inventory_movements
         where lot_id = $1 and reason = 'PURCHASE'`,
        [(lotes[0] as { id: string }).id],
      );
      expect(movs).toHaveLength(1);
    });
  });

  it("confirm y serve v6 llevan el candado (contrato de serialización)", async () => {
    // PGlite es mono-sesión: la carrera REAL se prueba en vivo con doble
    // disparo contra Supabase. Acá se congela el CONTRATO: si alguien borra el
    // `for update of a`, este test lo delata.
    //
    // Desde 0036 el que sirve —y por lo tanto el que descuenta— es
    // `serve_meal_assignment`; `consume_planned_meal` quedó como envoltorio de
    // compatibilidad. El candado se exige DONDE OCURRE EL ACTO FÍSICO, y al
    // envoltorio se le exige que siga delegando: si mañana se escribe un camino
    // propio adentro de él, no tendría el candado y este test lo delata igual.
    const defs = await h.filas<{ nombre: string; def: string }>(
      `select p.proname as nombre, pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('confirm_meal_assignment', 'serve_meal_assignment',
                           'consume_planned_meal')`,
    );
    expect(defs.map((d) => d.nombre).sort()).toEqual([
      "confirm_meal_assignment",
      "consume_planned_meal",
      "serve_meal_assignment",
    ]);
    for (const fn of defs.filter((d) => d.nombre !== "consume_planned_meal")) {
      expect(fn.def, `${fn.nombre} perdió el candado de la asignación`).toMatch(
        /for update of a/i,
      );
    }
    const envoltorio = defs.find((d) => d.nombre === "consume_planned_meal")!;
    expect(
      envoltorio.def,
      "consume_planned_meal dejó de delegar en el dueño del acto físico",
    ).toMatch(/serve_meal_assignment/i);

    // Y el recorrido FEFO del descuento bloquea los lotes. También se mudó: hoy
    // vive en el único escritor de movimientos CONSUMED.
    const fefo = await h.fila<{ def: string }>(
      `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'fefo_deduct_serving_item'`,
    );
    expect(fefo, "app.fefo_deduct_serving_item desapareció").not.toBeNull();
    expect(fefo!.def).toMatch(/for update of l/i);
  });

  it("tras consumir, confirmar ESPERA el candado y rechaza con la verdad", async () => {
    // Secuencial (mono-sesión): consumir deja CONSUMED; reconfirmar debe
    // rechazar — la misma decisión que tomará el que pierda la carrera viva.
    const fecha = (await h.fila<{ f: string }>("select current_date::text as f"))!.f;
    await h.como(USER, async () => {
      const dia2 = (await h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1 offset 2",
        [plan],
      ))!.id;
      const asig = (await h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
         select $1, 'DINNER', 'RECIPE', v.template_id, v.id
         from public.meal_template_versions v where v.id = $2 returning id`,
        [dia2, versionPollo],
      ))!.id;
      await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        asig,
        porciones(fecha).replace(/"LUNCH"/g, '"DINNER"'),
      ]);
      await h.db.query("select public.consume_planned_meal($1)", [asig]);
      await expect(
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          asig,
          porciones(fecha).replace(/"LUNCH"/g, '"DINNER"'),
        ]),
      ).rejects.toThrow(/ya se sirvió/);
    });
  });
});
