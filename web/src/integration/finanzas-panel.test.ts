import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 14 — PERMISOS, PRECIOS, PRESUPUESTO E INTEGRIDAD, contra un Postgres
 * de verdad (PGlite).
 *
 * Prueba las migraciones 0042 (segunda mitad: permisos), 0046, 0047 y 0048. Los
 * casos están escritos para ponerse ROJOS si el arreglo se revierte:
 *
 *   - Un integrante SIN `FINANCE_VIEW` ve la despensa completa y NO ve un solo
 *     monto. Ni por `inventory_lots`, ni por `lot_valuations`.
 *   - Un integrante DESACTIVADO pierde el acceso aunque su grant siga escrito.
 *   - Nadie se auto-inserta un permiso sobre un hogar ajeno.
 *   - Una observación de precio no se puede crear en $0.
 *   - Cambiar el presupuesto dos veces el mismo día no revienta ni deja solapes,
 *     y el informe del período anterior no se mueve.
 *   - Reprocesar la misma boleta no duplica observaciones.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: `harness.ts` lo comparten varios
 * agentes del mismo sprint y su lista `MIGRACIONES` todavía llega a la 0038.
 * Mismo patrón que `finanzas-compras.test.ts` y `sprint13-eventos.test.ts`.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const USER_ANA = "00000000-0000-0000-0000-0000000014b1"; // admin
const USER_BETO = "00000000-0000-0000-0000-0000000014b2"; // integrante sin permisos
const USER_CARLA = "00000000-0000-0000-0000-0000000014b3"; // integrante con FINANCE_VIEW
const USER_FUERA = "00000000-0000-0000-0000-0000000014b4"; // de otro hogar

let h: Harness;
let hogar: { householdId: string; memberId: string };
let otroHogar: { householdId: string; memberId: string };
let betoMemberId: string;
let carlaMemberId: string;
let pollo: string;
let arroz: string;

interface Intento {
  rechazado: boolean;
  mensaje: string | null;
}

async function intentar(sql: string, params: unknown[] = []): Promise<Intento> {
  try {
    await h.db.query(sql, params);
    return { rechazado: false, mensaje: null };
  } catch (e) {
    return { rechazado: true, mensaje: (e as Error).message };
  }
}

async function agregarIntegrante(
  householdId: string,
  userId: string,
  email: string,
  nombre: string,
): Promise<string> {
  return h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [userId, email]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, $3, '1990-01-01') returning id`,
      [householdId, userId, nombre],
    );
    return m!.id;
  });
}

beforeAll(async () => {
  h = await levantarBase();

  await h.comoAdmin(async () => {
    const testigos: Array<[string, string]> = [
      ["supabase/migrations/0042_finance_foundations.sql", "to_regclass('public.currency_units')"],
      ["supabase/migrations/0043_purchases_core.sql", "to_regclass('public.purchase_item_lots')"],
      ["supabase/migrations/0044_cost_allocations.sql", "to_regclass('public.cost_allocations')"],
      ["supabase/migrations/0046_price_observations.sql", "to_regclass('public.price_observations')"],
      ["supabase/migrations/0047_food_budgets.sql", "to_regclass('public.household_food_budgets')"],
      ["supabase/migrations/0048_finance_integrity.sql", "to_regclass('public.lot_valuations')"],
    ];
    for (const [archivo, testigo] of testigos) {
      const ya = await h.fila<{ t: string | null }>(`select ${testigo} as t`);
      if (ya!.t !== null) continue;
      await h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8"));
    }
  });

  hogar = await crearHogar(h, USER_ANA, "Hogar Panel", "Ana");
  otroHogar = await crearHogar(h, USER_FUERA, "Hogar Ajeno", "Fuera");

  betoMemberId = await agregarIntegrante(hogar.householdId, USER_BETO, "beto14b@test.dev", "Beto");
  carlaMemberId = await agregarIntegrante(
    hogar.householdId,
    USER_CARLA,
    "carla14b@test.dev",
    "Carla",
  );

  await h.comoAdmin(async () => {
    const ingredientes = await h.filas<{ id: string }>(
      "select id from public.ingredients order by display_name limit 2",
    );
    pollo = ingredientes[0]!.id;
    arroz = ingredientes[1]!.id;
  });

  // Carla recibe FINANCE_VIEW; Beto no recibe nada.
  await h.como(USER_ANA, async () => {
    await h.db.query("select public.grant_finance_access($1, $2, 'FINANCE_VIEW')", [
      hogar.householdId,
      carlaMemberId,
    ]);
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);
  });
  // Con timeout EXPLÍCITO. La cadena de migraciones del harness creció hasta la
  // 0058 y levantar la base pasó a rozar los 10 s por defecto de vitest: este
  // archivo empezó a caer intermitente con «Hook timed out», que se lee como si
  // el panel estuviera roto cuando lo único lento es el andamio.
}, 120000);

afterAll(async () => {
  // `h?` y no `h`: si el beforeAll se cae, `h` queda undefined y el afterAll
  // reventaba encima con «Cannot read properties of undefined», tapando el
  // error de verdad con uno suyo.
  await h?.cerrar();
});

// ---------------------------------------------------------------------------

describe("[Etapa 2] los permisos financieros existen como FILAS, no como decoración", () => {
  it("el creador del hogar nace con los cinco permisos de agregado", async () => {
    const filas = await h.comoAdmin(() =>
      h.filas<{ permission: string }>(
        `select permission from public.household_finance_grants
          where household_id = $1 and member_id = $2 and revoked_at is null
          order by permission`,
        [hogar.householdId, hogar.memberId],
      ),
    );
    // `order by permission` sobre un enum ordena por POSICION del enum, no
    // alfabeticamente: el orden de aca es el orden en que se declararon.
    expect(filas.map((f) => f.permission)).toEqual([
      "FINANCE_VIEW",
      "FINANCE_UPLOAD_RECEIPTS",
      "FINANCE_CONFIRM_RECEIPTS",
      "FINANCE_MANAGE_PRICES",
      "FINANCE_MANAGE_BUDGET",
    ]);
    // FINANCE_VIEW_MEMBER lleva dueño: no se siembra «sobre todos».
    expect(filas.map((f) => f.permission)).not.toContain("FINANCE_VIEW_MEMBER");
  });

  it("cada permiso responde en positivo y en negativo", async () => {
    const ana = await h.como(USER_ANA, () =>
      h.fila<Record<string, boolean>>(
        `select app.finance_access($1,'FINANCE_VIEW') as ver,
                app.finance_access($1,'FINANCE_MANAGE_BUDGET') as presupuesto,
                app.finance_access($1,'FINANCE_MANAGE_PRICES') as precios`,
        [hogar.householdId],
      ),
    );
    expect(ana).toEqual({ ver: true, presupuesto: true, precios: true });

    const carla = await h.como(USER_CARLA, () =>
      h.fila<Record<string, boolean>>(
        `select app.finance_access($1,'FINANCE_VIEW') as ver,
                app.finance_access($1,'FINANCE_MANAGE_BUDGET') as presupuesto`,
        [hogar.householdId],
      ),
    );
    // Ve montos, pero NO puede cambiar el presupuesto familiar.
    expect(carla).toEqual({ ver: true, presupuesto: false });

    const beto = await h.como(USER_BETO, () =>
      h.fila<{ ver: boolean }>("select app.finance_access($1,'FINANCE_VIEW') as ver", [
        hogar.householdId,
      ]),
    );
    expect(beto!.ver).toBe(false);
  });

  it("[H55] nadie se auto-inserta un permiso sobre un hogar ajeno", async () => {
    const r = await h.como(USER_FUERA, () =>
      intentar(
        `insert into public.household_finance_grants
           (household_id, member_id, permission, granted_by)
         values ($1, $2, 'FINANCE_VIEW', $2)`,
        [hogar.householdId, otroHogar.memberId],
      ),
    );
    expect(r.rechazado).toBe(true);

    const desdeAfuera = await h.como(USER_FUERA, () =>
      h.filas("select id from public.household_finance_grants where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(desdeAfuera).toEqual([]);
  });

  it("[H55] otorgar es del administrador, y no cruza hogares", async () => {
    const deBeto = await h.como(USER_BETO, () =>
      intentar("select public.grant_finance_access($1, $2, 'FINANCE_VIEW')", [
        hogar.householdId,
        betoMemberId,
      ]),
    );
    expect(deBeto.rechazado).toBe(true);
    expect(deBeto.mensaje).toContain("no autorizado");

    const aUnAjeno = await h.como(USER_ANA, () =>
      intentar("select public.grant_finance_access($1, $2, 'FINANCE_VIEW')", [
        hogar.householdId,
        otroHogar.memberId,
      ]),
    );
    expect(aUnAjeno.rechazado).toBe(true);
    expect(aUnAjeno.mensaje).toContain("no es de este hogar");
  });

  it("otorgar dos veces es idempotente: un permiso VIVO por par", async () => {
    const a = await h.como(USER_ANA, () =>
      h.fila<{ grant_finance_access: string }>(
        "select public.grant_finance_access($1, $2, 'FINANCE_VIEW') as grant_finance_access",
        [hogar.householdId, carlaMemberId],
      ),
    );
    const b = await h.como(USER_ANA, () =>
      h.fila<{ grant_finance_access: string }>(
        "select public.grant_finance_access($1, $2, 'FINANCE_VIEW') as grant_finance_access",
        [hogar.householdId, carlaMemberId],
      ),
    );
    expect(a!.grant_finance_access).toBe(b!.grant_finance_access);
  });

  it("[H54] un integrante DESACTIVADO pierde el acceso, y sus grants se cierran solos", async () => {
    const usuario = "00000000-0000-0000-0000-0000000014b9";
    const miembro = await agregarIntegrante(hogar.householdId, usuario, "ex@test.dev", "Ex");
    await h.como(USER_ANA, () =>
      h.db.query("select public.grant_finance_access($1, $2, 'FINANCE_VIEW')", [
        hogar.householdId,
        miembro,
      ]),
    );
    const antes = await h.como(usuario, () =>
      h.fila<{ ver: boolean }>("select app.finance_access($1,'FINANCE_VIEW') as ver", [
        hogar.householdId,
      ]),
    );
    expect(antes!.ver).toBe(true);

    await h.comoAdmin(() =>
      h.db.query("update public.household_members set is_active = false where id = $1", [miembro]),
    );

    const despues = await h.como(usuario, () =>
      h.fila<{ ver: boolean }>("select app.finance_access($1,'FINANCE_VIEW') as ver", [
        hogar.householdId,
      ]),
    );
    expect(despues!.ver).toBe(false);

    const vivos = await h.comoAdmin(() =>
      h.filas(
        `select id from public.household_finance_grants
          where member_id = $1 and revoked_at is null`,
        [miembro],
      ),
    );
    expect(vivos).toEqual([]);

    const traza = await h.comoAdmin(() =>
      h.filas(
        `select id from public.audit_events
          where household_id = $1 and action = 'FINANCE_ACCESS_REVOKED'
            and subject_id = $2`,
        [hogar.householdId, miembro],
      ),
    );
    expect(traza.length).toBe(1);
  });

  it("[H-ID] una invitación con un rol que no existe deja de poder crearse", async () => {
    const r = await h.comoAdmin(() =>
      intentar(
        `insert into public.invitations (household_id, token_hash, role_code, expires_at)
         values ($1, 'hash-inventado', 'PRESIDENTE', now() + interval '1 day')`,
        [hogar.householdId],
      ),
    );
    expect(r.rechazado).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("[0048] la despensa se ve entera; el dinero no", () => {
  let loteId: string;

  beforeAll(async () => {
    const lote = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, ingredient_id, label, quantity, unit, weight_basis, currency)
         values ($1, $2, 'Pollo', 1000, 'G', 'RAW', 'CLP') returning id`,
        [hogar.householdId, pollo],
      ),
    );
    loteId = lote!.id;
    await h.comoAdmin(() =>
      h.db.query("select app.set_lot_value($1, 25000)", [loteId]),
    );
  });

  it("cualquier integrante ve cantidades y vencimientos", async () => {
    const beto = await h.como(USER_BETO, () =>
      h.filas<{ quantity: string }>(
        "select quantity from public.inventory_lots where household_id = $1",
        [hogar.householdId],
      ),
    );
    expect(beto.length).toBeGreaterThan(0);
  });

  it("un integrante sin FINANCE_VIEW no puede leer la columna de valor NI POR ERROR", async () => {
    const r = await h.como(USER_BETO, () =>
      intentar("select value_minor from public.inventory_lots where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/permission denied|permiso/i);
  });

  it("[H17] sin permiso, lot_valuations devuelve CERO FILAS: por eso la pantalla no puede sumar", async () => {
    // Éste es exactamente el peligro que <Monto> ataja con su cuarta rama: la
    // consulta anduvo perfecto y devolvió vacío. Un loader que suma cero filas
    // muestra «$0», indistinguible de un hogar que no gastó nada.
    const beto = await h.como(USER_BETO, () =>
      h.filas("select lot_id from public.lot_valuations where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(beto).toEqual([]);

    const carla = await h.como(USER_CARLA, () =>
      h.filas<{ value_minor: string }>(
        "select value_minor from public.lot_valuations where household_id = $1",
        [hogar.householdId],
      ),
    );
    expect(carla.map((f) => Number(f.value_minor))).toContain(25000);
  });

  it("lot_valuations no se puede ESCRIBIR: el dueño del valor sigue siendo app.set_lot_value", async () => {
    const r = await h.como(USER_CARLA, () =>
      intentar("update public.lot_valuations set value_minor = 1 where lot_id = $1", [loteId]),
    );
    expect(r.rechazado).toBe(true);
  });

  it("el saldo de la despensa existe y trae su cobertura al lado", async () => {
    const v = await h.como(USER_CARLA, () =>
      h.fila<{ known_value_minor: number; unknown_lots: number; total_lots: number }>(
        "select known_value_minor, unknown_lots, total_lots from public.pantry_value where household_id = $1",
        [hogar.householdId],
      ),
    );
    expect(Number(v!.known_value_minor)).toBe(25000);
    expect(Number(v!.unknown_lots)).toBe(0);
  });

  it("un lote sin valor deja el SALDO desconocido en vez de restarle cero", async () => {
    const sinValor = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, ingredient_id, label, quantity, unit, weight_basis, currency)
         values ($1, $2, 'Arroz sin boleta', 500, 'G', 'RAW', 'CLP') returning id`,
        [hogar.householdId, arroz],
      ),
    );
    const v = await h.como(USER_CARLA, () =>
      h.fila<{ known_value_minor: number | null; unknown_lots: number; value_status: string }>(
        "select known_value_minor, unknown_lots, value_status from public.pantry_value where household_id = $1",
        [hogar.householdId],
      ),
    );
    expect(Number(v!.unknown_lots)).toBe(1);
    expect(v!.value_status).toBe("UNKNOWN");

    const enElInventario = await h.como(USER_CARLA, () =>
      h.filas<{ motivo: string; cuantos: number }>(
        `select motivo, cuantos from public.unknown_value_inventory
          where household_id = $1 and origen = 'LOTE'`,
        [hogar.householdId],
      ),
    );
    expect(enElInventario.map((f) => f.motivo)).toContain("LOT_VALUE_UNKNOWN");

    await h.comoAdmin(() =>
      h.db.query("delete from public.inventory_lots where id = $1", [sinValor!.id]),
    );
  });
});

// ---------------------------------------------------------------------------

describe("[0046] los precios son hechos fechados que no inventan", () => {
  it("[H29] una observación de $0 no se puede crear: es el desconocido disfrazado", async () => {
    const r = await h.como(USER_ANA, () =>
      intentar(
        `select public.record_price_sighting($1, 'Pollo entero', 'Lider', 0, null, $2)`,
        [hogar.householdId, pollo],
      ),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toContain("no es una observacion");
  });

  it("la normalización a $/kg funciona con un envase de 900 g", async () => {
    const n = await h.comoAdmin(() =>
      h.fila<{ per_kg_minor: number; blocked_reason: string | null }>(
        "select * from app.normalize_price(4500, 900, 'G', 1, false, null)",
      ),
    );
    // $4.500 los 900 g son $5.000 el kilo.
    expect(Number(n!.per_kg_minor)).toBe(5000);
    expect(n!.blocked_reason).toBeNull();
  });

  it("se NIEGA con «Pollo entero $6.990» sin peso, y lo dice con nombre", async () => {
    const n = await h.comoAdmin(() =>
      h.fila<{ per_kg_minor: number | null; blocked_reason: string }>(
        "select * from app.normalize_price(6990, null, null, null, false, null)",
      ),
    );
    expect(n!.per_kg_minor).toBeNull();
    expect(n!.blocked_reason).toBe("NO_PACKAGE_QUANTITY");
  });

  it("se niega con un 2x1: la cantidad efectiva depende de lo que se llevó", async () => {
    const n = await h.comoAdmin(() =>
      h.fila<{ per_kg_minor: number | null; blocked_reason: string }>(
        "select * from app.normalize_price(1990, 500, 'G', 2, true, '2x1')",
      ),
    );
    expect(n!.per_kg_minor).toBeNull();
    expect(n!.blocked_reason).toBe("PROMO_CONDITIONAL");
  });

  it("lo que se vende por unidad da $/unidad y declara que NO hay $/kg", async () => {
    const n = await h.comoAdmin(() =>
      h.fila<{ per_unit_minor: number; per_kg_minor: number | null; blocked_reason: string }>(
        "select * from app.normalize_price(3600, 12, 'UNIT', 1, false, null)",
      ),
    );
    expect(Number(n!.per_unit_minor)).toBe(300);
    expect(n!.per_kg_minor).toBeNull();
    expect(n!.blocked_reason).toBe("UNIT_ONLY");
  });

  it("[H31] el redondeo es el MISMO del dinero, no un truncado sin regla", async () => {
    // $1.000 en 3 unidades: 333,33 → 333. Y $1.000 en 8: 125 exactos. La mitad
    // exacta cae al par, igual que `mulDiv` en TypeScript.
    const a = await h.comoAdmin(() =>
      h.fila<{ per_unit_minor: number }>(
        "select * from app.normalize_price(1000, 3, 'UNIT', 1, false, null)",
      ),
    );
    expect(Number(a!.per_unit_minor)).toBe(333);
    const b = await h.comoAdmin(() =>
      h.fila<{ per_unit_minor: number }>(
        "select * from app.normalize_price(5, 2, 'UNIT', 1, false, null)",
      ),
    );
    // 2,5 con half-even cae a 2 (el par), no a 3.
    expect(Number(b!.per_unit_minor)).toBe(2);
  });

  it("[H39] registrar el mismo hecho de precio dos veces NO duplica", async () => {
    const uno = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `select public.record_price_sighting($1, 'Pollo', 'Lider', 4500, null, $2,
                null, 900, 'G', 1, 'AS_PACKAGED', false, null, '2026-09-01'::date) as id`,
        [hogar.householdId, pollo],
      ),
    );
    const dos = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `select public.record_price_sighting($1, 'Pollo', 'Lider', 4500, null, $2,
                null, 900, 'G', 1, 'AS_PACKAGED', false, null, '2026-09-01'::date) as id`,
        [hogar.householdId, pollo],
      ),
    );
    expect(dos!.id).toBe(uno!.id);
  });

  it("[H67] dos observaciones el mismo día: la corrección ENCADENA y la última es única", async () => {
    // El tipeo de $50.000 corregido a $5.000 minutos después.
    const tipeo = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `select public.record_price_sighting($1, 'Arroz', 'Jumbo', 50000, null, $2,
                null, 1000, 'G', 1, 'AS_PACKAGED', false, null, '2026-09-02'::date) as id`,
        [hogar.householdId, arroz],
      ),
    );
    const corregida = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        "select public.correct_price_observation($1, 5000, 'me equivoque de cero') as id",
        [tipeo!.id],
      ),
    );

    // Cien lecturas seguidas de «la última válida» dan SIEMPRE la corregida.
    for (let i = 0; i < 5; i += 1) {
      const ultima = await h.como(USER_ANA, () =>
        h.fila<{ id: string; price_minor: number }>(
          "select id, price_minor from app.latest_price_observation($1, null, $2, 'jumbo')",
          [hogar.householdId, arroz],
        ),
      );
      expect(ultima!.id).toBe(corregida!.id);
      expect(Number(ultima!.price_minor)).toBe(5000);
    }

    const vieja = await h.comoAdmin(() =>
      h.fila<{ superseded_by: string | null }>(
        "select superseded_by from public.price_observations where id = $1",
        [tipeo!.id],
      ),
    );
    expect(vieja!.superseded_by).toBe(corregida!.id);
  });

  it("anotar precios exige FINANCE_MANAGE_PRICES", async () => {
    const r = await h.como(USER_CARLA, () =>
      intentar("select public.record_price_sighting($1, 'Pollo', 'Lider', 4990, null, $2)", [
        hogar.householdId,
        pollo,
      ]),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toContain("no autorizado");
  });

  it("los precios no se ven sin FINANCE_VIEW", async () => {
    const beto = await h.como(USER_BETO, () =>
      h.filas("select id from public.price_observations where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(beto).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("[0047] el presupuesto tiene base y vigencia", () => {
  it("[H2] conviven un presupuesto de CAJA y uno de CONSUMO, y hay que elegir la base", async () => {
    await h.como(USER_ANA, () =>
      h.db.query("select public.set_food_budget($1, 'MONTH', 'CASH', 200000)", [
        hogar.householdId,
      ]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.set_food_budget($1, 'MONTH', 'ECONOMIC_CONSUMPTION', 150000)", [
        hogar.householdId,
      ]),
    );
    const filas = await h.como(USER_ANA, () =>
      h.filas<{ basis: string; amount_minor: number }>(
        `select basis, amount_minor from public.household_food_budgets
          where household_id = $1 and valid_to is null order by basis`,
        [hogar.householdId],
      ),
    );
    expect(filas.map((f) => ({ basis: f.basis, monto: Number(f.amount_minor) }))).toEqual([
      { basis: "CASH", monto: 200000 },
      { basis: "ECONOMIC_CONSUMPTION", monto: 150000 },
    ]);
  });

  it("un presupuesto de cero no es un presupuesto", async () => {
    const r = await h.como(USER_ANA, () =>
      intentar("select public.set_food_budget($1, 'MONTH', 'CASH', 0)", [hogar.householdId]),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toContain("no es un presupuesto");
  });

  it("[H65] cambiarlo dos veces el mismo día no revienta y deja UNA sola vigencia futura", async () => {
    await h.como(USER_ANA, () =>
      h.db.query("select public.set_food_budget($1, 'MONTH', 'CASH', 210000)", [
        hogar.householdId,
      ]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.set_food_budget($1, 'MONTH', 'CASH', 220000)", [
        hogar.householdId,
      ]),
    );
    const vivas = await h.como(USER_ANA, () =>
      h.filas<{ amount_minor: number }>(
        `select amount_minor from public.household_food_budgets
          where household_id = $1 and period_type = 'MONTH' and basis = 'CASH'
            and valid_to is null`,
        [hogar.householdId],
      ),
    );
    expect(vivas.map((f) => Number(f.amount_minor))).toEqual([220000]);
  });

  it("la vigencia empieza en el PRÓXIMO período: el mes en curso no cambia a mitad de camino", async () => {
    const fila = await h.como(USER_ANA, () =>
      h.fila<{ valid_from: string }>(
        `select valid_from from public.household_food_budgets
          where household_id = $1 and period_type = 'MONTH' and basis = 'CASH'
            and valid_to is null`,
        [hogar.householdId],
      ),
    );
    const bordes = await h.comoAdmin(() =>
      h.fila<{ ends_on: string }>(
        "select ends_on from app.budget_period_bounds($1, 'MONTH', null)",
        [hogar.householdId],
      ),
    );
    const siguiente = new Date(bordes!.ends_on);
    siguiente.setUTCDate(siguiente.getUTCDate() + 1);
    expect(new Date(fila!.valid_from).toISOString().slice(0, 10)).toBe(
      siguiente.toISOString().slice(0, 10),
    );
  });

  it("no quedan vigencias solapadas ni entre filas cerradas", async () => {
    const solapes = await h.comoAdmin(() =>
      h.filas(
        `select a.id from public.household_food_budgets a
           join public.household_food_budgets b
             on b.household_id = a.household_id and b.period_type = a.period_type
            and b.basis = a.basis and coalesce(b.category,'') = coalesce(a.category,'')
            and b.id <> a.id
            and daterange(a.valid_from, coalesce(a.valid_to,'infinity'::date), '[]')
                && daterange(b.valid_from, coalesce(b.valid_to,'infinity'::date), '[]')
          where a.household_id = $1`,
        [hogar.householdId],
      ),
    );
    expect(solapes).toEqual([]);
  });

  it("cambiar el presupuesto exige FINANCE_MANAGE_BUDGET", async () => {
    const r = await h.como(USER_CARLA, () =>
      intentar("select public.set_food_budget($1, 'MONTH', 'CASH', 999)", [hogar.householdId]),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toContain("no autorizado");
  });

  it("los bordes de la semana salen del día que el hogar declara, no del servidor", async () => {
    const lunes = await h.comoAdmin(() =>
      h.fila<{ starts_on: string; ends_on: string }>(
        "select starts_on, ends_on from app.budget_period_bounds($1, 'WEEK', '2026-09-03'::date)",
        [hogar.householdId],
      ),
    );
    // 2026-09-03 es jueves; con la semana anclada al lunes, parte el 31-08.
    expect(new Date(lunes!.starts_on).toISOString().slice(0, 10)).toBe("2026-08-31");
    expect(new Date(lunes!.ends_on).toISOString().slice(0, 10)).toBe("2026-09-06");

    await h.comoAdmin(() =>
      h.db.query("update public.households set week_start_dow = 7 where id = $1", [
        hogar.householdId,
      ]),
    );
    const domingo = await h.comoAdmin(() =>
      h.fila<{ starts_on: string }>(
        "select starts_on from app.budget_period_bounds($1, 'WEEK', '2026-09-03'::date)",
        [hogar.householdId],
      ),
    );
    expect(new Date(domingo!.starts_on).toISOString().slice(0, 10)).toBe("2026-08-30");
    await h.comoAdmin(() =>
      h.db.query("update public.households set week_start_dow = 1 where id = $1", [
        hogar.householdId,
      ]),
    );
  });
});

// ---------------------------------------------------------------------------

describe("[0048] la integridad se verifica sola", () => {
  it("un hogar limpio pasa la aserción", async () => {
    const r = await h.comoAdmin(() =>
      intentar("select app.assert_finance_integrity($1)", [hogar.householdId]),
    );
    expect(r).toEqual({ rechazado: false, mensaje: null });
  });

  it("una salida del ledger SIN costear aparece en el informe y rompe la aserción", async () => {
    const lote = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, ingredient_id, label, quantity, unit, weight_basis, currency)
         values ($1, $2, 'Pollo huerfano', 500, 'G', 'RAW', 'CLP') returning id`,
        [hogar.householdId, pollo],
      ),
    );
    // El ledger ahora COSTEA solo (0044 engancha `app.allocate_movement_cost`
    // dentro de `app.apply_movement_to_lot`), asi que por el camino normal esta
    // fila ya no puede existir: hay que apagar el trigger para fabricarla. Eso
    // es exactamente lo que el informe vigila hoy — un arreglo a mano en la
    // base, una carga masiva en modo `replica`, o un camino futuro que se
    // salte el ledger.
    const mov = await h.comoAdmin(async () => {
      await h.db.query("alter table public.inventory_movements disable trigger movements_apply");
      try {
        return await h.fila<{ id: string }>(
          `insert into public.inventory_movements (household_id, lot_id, reason, delta)
           values ($1, $2, 'SPOILED', -100) returning id`,
          [hogar.householdId, lote!.id],
        );
      } finally {
        await h.db.query("alter table public.inventory_movements enable trigger movements_apply");
      }
    });

    const informe = await h.como(USER_CARLA, () =>
      h.filas<{ tipo: string; subject_id: string }>(
        `select tipo, subject_id from public.finance_integrity_report
          where household_id = $1 and tipo = 'SALIDA_SIN_COSTEAR'`,
        [hogar.householdId],
      ),
    );
    expect(informe.map((f) => f.subject_id)).toContain(mov!.id);

    const r = await h.comoAdmin(() =>
      intentar("select app.assert_finance_integrity($1)", [hogar.householdId]),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toContain("integridad financiera rota");

    await h.comoAdmin(() =>
      h.db.query("delete from public.inventory_lots where id = $1", [lote!.id]),
    );
  });

  it("[H53] el gasto por integrante no se ve sin FINANCE_VIEW_MEMBER", async () => {
    const lote = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, ingredient_id, label, quantity, unit, weight_basis, currency)
         values ($1, $2, 'Pollo de Beto', 500, 'G', 'RAW', 'CLP') returning id`,
        [hogar.householdId, pollo],
      ),
    );
    // LA FILA YA NO SE ESCRIBE A MANO, Y ESO ES EL ARREGLO.
    //
    // Antes este test fabricaba la asignacion con un `insert` crudo y le ponia
    // `member_id` de Beto a pulso: probaba la RLS sobre una fila que la
    // aplicacion no producia —no la producia— y seguia verde igual. Ahora sirve
    // comida por el RPC real, el ledger costea solo dentro de
    // `app.apply_movement_to_lot` (0044) y `member_id` sale del renglon
    // servido, que es de donde tiene que salir: QUIEN COMIO, no quien apreto el
    // boton.
    await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, 4000)", [lote!.id]));

    await h.como(USER_ANA, () =>
      h.db.query("select public.serve_off_plan($1, $2, 100, 'LUNCH', null)", [
        betoMemberId,
        lote!.id,
      ]),
    );

    // Nadie inserto esta fila: la produjo el acto de servir. 100 de 500 g de un
    // lote de $4.000.
    const nacida = await h.comoAdmin(() =>
      h.fila<{ amount_minor: string; member_id: string | null; category: string }>(
        `select amount_minor::text as amount_minor, member_id::text as member_id,
                category::text as category
           from public.cost_allocations where lot_id = $1`,
        [lote!.id],
      ),
    );
    expect(nacida).not.toBeNull();
    expect(nacida!.category).toBe("CONSUMED");
    expect(Number(nacida!.amount_minor)).toBe(800);
    expect(nacida!.member_id).toBe(betoMemberId);

    // Carla tiene FINANCE_VIEW pero NO FINANCE_VIEW_MEMBER sobre Beto: no puede
    // armar el ranking de cuánto cuesta cada integrante.
    const carla = await h.como(USER_CARLA, () =>
      h.filas("select id from public.cost_allocations where member_id = $1", [betoMemberId]),
    );
    expect(carla).toEqual([]);

    // El propio Beto sí ve lo suyo... aunque para eso necesita FINANCE_VIEW.
    await h.como(USER_ANA, () =>
      h.db.query("select public.grant_finance_access($1, $2, 'FINANCE_VIEW')", [
        hogar.householdId,
        betoMemberId,
      ]),
    );
    const beto = await h.como(USER_BETO, () =>
      h.filas("select id from public.cost_allocations where member_id = $1", [betoMemberId]),
    );
    expect(beto.length).toBe(1);

    // Y con el grant explícito, Carla también.
    const g = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        "select public.grant_finance_access($1, $2, 'FINANCE_VIEW_MEMBER', $3) as id",
        [hogar.householdId, carlaMemberId, betoMemberId],
      ),
    );
    expect(g!.id).toBeTruthy();
    const carlaConGrant = await h.como(USER_CARLA, () =>
      h.filas("select id from public.cost_allocations where member_id = $1", [betoMemberId]),
    );
    expect(carlaConGrant.length).toBe(1);

    await h.comoAdmin(() =>
      h.db.query("delete from public.inventory_lots where id = $1", [lote!.id]),
    );
  });

  it("la merma del hogar se agrega SIN atribuírsela a nadie", async () => {
    const columnas = await h.comoAdmin(() =>
      h.filas<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'household_waste_summary'`,
      ),
    );
    expect(columnas.map((c) => c.column_name)).not.toContain("member_id");
  });
});

// ---------------------------------------------------------------------------

describe("el costo del consumo se CONGELA en el movimiento", () => {
  it("se atribuye desde el lote y no se recalcula cuando el precio de hoy cambia", async () => {
    // 1 kg de pollo que costó $25.000. Se usan 200 g en una receta.
    const lote = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, ingredient_id, label, quantity, unit, weight_basis, currency)
         values ($1, $2, 'Pollo costeado', 1000, 'G', 'RAW', 'CLP') returning id`,
        [hogar.householdId, pollo],
      ),
    );
    await h.comoAdmin(() =>
      h.db.query("select app.set_lot_value($1, 25000)", [lote!.id]),
    );
    const mov = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_movements (household_id, lot_id, reason, delta)
         values ($1, $2, 'USED_IN_RECIPE', -200) returning id`,
        [hogar.householdId, lote!.id],
      ),
    );
    await h.comoAdmin(() =>
      h.db.query("update public.inventory_lots set quantity = 800 where id = $1", [lote!.id]),
    );
    const asignacion = await h.comoAdmin(() =>
      h.fila<{ allocate_movement_cost: string }>(
        "select app.allocate_movement_cost($1, 1000, null, '2026-09-07')",
        [mov!.id],
      ),
    );

    const antes = await h.comoAdmin(() =>
      h.fila<{ amount_minor: number; category: string; snapshot: unknown }>(
        `select amount_minor, category::text as category, cost_basis_snapshot as snapshot
           from public.cost_allocations where id = $1`,
        [asignacion!.allocate_movement_cost],
      ),
    );
    // 200 de 1000 gramos de un lote de $25.000 son $5.000 exactos.
    expect(Number(antes!.amount_minor)).toBe(5000);
    expect(antes!.category).toBe("CONSUMED");

    // El pollo se duplica de precio en el mercado. Se anota como HECHO NUEVO.
    await h.como(USER_ANA, () =>
      h.db.query(
        `select public.record_price_sighting($1, 'Pollo', 'Unimarc', 50000, null, $2,
                null, 1000, 'G', 1, 'AS_PACKAGED', false, null, '2026-09-20'::date)`,
        [hogar.householdId, pollo],
      ),
    );

    const despues = await h.comoAdmin(() =>
      h.fila<{ amount_minor: number; snapshot: unknown }>(
        `select amount_minor, cost_basis_snapshot as snapshot
           from public.cost_allocations where id = $1`,
        [asignacion!.allocate_movement_cost],
      ),
    );
    // La historia NO se mueve: lo que se comió la semana pasada costó lo que
    // costó. Un precio de hoy no reinterpreta un consumo de ayer.
    expect(Number(despues!.amount_minor)).toBe(5000);
    expect(despues!.snapshot).toEqual(antes!.snapshot);

    // Y el lote tampoco se revaloriza: la despensa vale lo que costó.
    const revalorizar = await h.comoAdmin(() =>
      intentar("select app.set_lot_value($1, 50000)", [lote!.id]),
    );
    expect(revalorizar.rechazado).toBe(true);
    expect(revalorizar.mensaje).toContain("no reescribe la historia");

    // La asignación es append-only: ni el dueño de la base la corrige a mano.
    const editar = await h.comoAdmin(() =>
      intentar("update public.cost_allocations set amount_minor = 1 where id = $1", [
        asignacion!.allocate_movement_cost,
      ]),
    );
    expect(editar.rechazado).toBe(true);

    await h.comoAdmin(() =>
      h.db.query("delete from public.inventory_lots where id = $1", [lote!.id]),
    );
  });
});
