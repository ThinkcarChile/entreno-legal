import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  CURRENCY_UNITS,
  apportion,
  apportionOrThrow,
  money,
  type CurrencyCode,
} from "@/domain/finance/money";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 14 — la migración 0042 contra un PostgreSQL de verdad.
 *
 * Prueba las cuatro cosas que la revisión adversarial encontró rotas EN EL
 * DISEÑO, más el error que este repo ya conocía de otro sprint:
 *
 *   [H13] La suma de los hijos de un split TIENE que ser el valor del padre, al
 *         peso, en la escala entera (antes: $17.000 → $16.998 y $2 sin dueño).
 *   [H15] apportion con total negativo y con pesos en cero: los casos normales
 *         de una boleta con descuento de orden y líneas de promo en $0.
 *   [H19] El rango del dinero no se vigila con literales de coma flotante.
 *   [H57] La moneda del lote se congela al nacer y el exponente de la moneda no
 *         se edita: cambiar la configuración no reinterpreta historia cerrada.
 *   [sum] sum() en Postgres IGNORA los NULL. app.sum_money no puede: para sacar
 *         un número hay que decidir qué se hace con los huecos.
 *
 * Y la PARIDAD entre app.apportion (SQL) y apportion() (TypeScript): dos
 * implementaciones del mismo reparto divergen en los empates si nadie las corre
 * lado a lado con la misma tabla de casos.
 *
 * POR QUÉ APLICA LA MIGRACIÓN A MANO: `harness.ts` lo comparten varios agentes
 * trabajando en el mismo árbol y su lista `MIGRACIONES` llega hasta la 0038.
 * Mismo patrón que permisos-plan.test.ts (0039), sprint12-adaptive.test.ts
 * (0040) y sprint13-eventos.test.ts (0041).
 */

const RAIZ = path.resolve(__dirname, "../../..");
const PENDIENTES: Array<[string, string]> = [
  ["supabase/migrations/0042_finance_foundations.sql", "to_regclass('public.currency_units')"],
];

const USER_ANA = "00000000-0000-0000-0000-0000000042a1";
const CLP = "CLP" as const;

let h: Harness;
let hogar: { householdId: string; memberId: string };

/** Un lote de la despensa con la cantidad pedida, sin valor todavía. */
async function crearLote(label: string, cantidad: number): Promise<string> {
  const fila = await h.como(USER_ANA, () =>
    h.fila<{ add_manual_lot: string }>(
      "select public.add_manual_lot($1, $2, $3, 'G', null, null, null, null)",
      [hogar.householdId, label, cantidad],
    ),
  );
  return fila!.add_manual_lot;
}

interface FilaLote {
  quantity: string;
  acquisition_value: string | null;
  value_minor: string | null;
  value_status: string;
  value_unknown_reason: string | null;
  currency: string;
  parent_lot_id: string | null;
}

async function lote(id: string): Promise<FilaLote> {
  const fila = await h.comoAdmin(() =>
    h.fila<FilaLote>(
      `select quantity, acquisition_value, value_minor::text as value_minor, value_status,
              value_unknown_reason, currency, parent_lot_id
       from public.inventory_lots where id = $1`,
      [id],
    ),
  );
  return fila!;
}

/**
 * Lee un monto de la fila SIN rellenar con cero: si el lote no tiene valor y el
 * test lo daba por hecho, el test tiene que fallar ahí mismo y no sumar un cero
 * de consuelo. Es la misma regla que vigila la guarda de CI.
 */
function minorDe(l: { value_minor: string | null }): bigint {
  if (l.value_minor === null) {
    throw new Error("el lote llegó con valor DESCONOCIDO y este test lo daba por conocido");
  }
  return BigInt(l.value_minor);
}

async function rechaza(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await h.db.query(sql, params);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`la base ACEPTÓ lo que tenía que rechazar: ${sql}`);
}

beforeAll(async () => {
  h = await levantarBase();
  // La cadena del arnés ya llegó a la 0058, así que la 0042 puede venir puesta.
  // Aplicarla igual reventaba con «relation currency_units already exists» y el
  // archivo entero se reportaba rojo sin correr un solo test. El testigo decide.
  await h.comoAdmin(async () => {
    for (const [archivo, testigo] of PENDIENTES) {
      const ya = await h.fila<{ t: string | null }>(`select ${testigo} as t`);
      if (ya!.t !== null) continue;
      await h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8"));
    }
  });
  hogar = await crearHogar(h, USER_ANA, "Hogar Dinero", "Ana");
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("la escala del dinero es la misma en la base y en el motor", () => {
  it("currency_units y CURRENCY_UNITS declaran exactamente lo mismo", async () => {
    const filas = await h.comoAdmin(() =>
      h.filas<{
        code: string;
        minor_exponent: number;
        reconciliation_tolerance_minor: string;
        reconciliation_tolerance_per_line_minor: string;
      }>("select * from public.currency_units order by code"),
    );
    expect(filas.map((f) => f.code)).toEqual([...CURRENCY_CODES].sort());
    for (const fila of filas) {
      const espejo = CURRENCY_UNITS[fila.code as CurrencyCode];
      expect(Number(fila.minor_exponent)).toBe(espejo.minorExponent);
      expect(BigInt(fila.reconciliation_tolerance_minor)).toBe(espejo.reconciliationToleranceMinor);
      expect(BigInt(fila.reconciliation_tolerance_per_line_minor)).toBe(
        espejo.reconciliationTolerancePerLineMinor,
      );
    }
  });

  it("[H57] el exponente de una moneda NO se edita: es la vara del pasado", async () => {
    const mensaje = await rechaza(
      "update public.currency_units set minor_exponent = 2 where code = 'CLP'",
    );
    expect(mensaje).toMatch(/no se cambia/);
    const borrado = await rechaza("delete from public.currency_units where code = 'EUR'");
    expect(borrado).toMatch(/no se borra/);
  });

  it("[H19] el rango se vigila con enteros y revienta al desbordarse", async () => {
    const ok = await h.comoAdmin(() =>
      h.fila<{ c: boolean }>(
        "select app.money_coherent('KNOWN', 1000000000000000::bigint, null) as c",
      ),
    );
    expect(ok!.c).toBe(true);
    const pasado = await h.comoAdmin(() =>
      h.fila<{ c: boolean }>(
        "select app.money_coherent('KNOWN', 1000000000000001::bigint, null) as c",
      ),
    );
    expect(pasado!.c).toBe(false);
  });

  it("la coherencia KNOWN/UNKNOWN no admite estados a medias", async () => {
    const casos: Array<{ sql: string; esperado: boolean }> = [
      { sql: "app.money_coherent('KNOWN', 0::bigint, null)", esperado: true },
      { sql: "app.money_coherent('KNOWN', null, null)", esperado: false },
      { sql: "app.money_coherent('KNOWN', 100::bigint, 'NO_PRICE_RECORDED')", esperado: false },
      { sql: "app.money_coherent('UNKNOWN', null, 'LOT_VALUE_UNKNOWN')", esperado: true },
      { sql: "app.money_coherent('UNKNOWN', null, null)", esperado: false },
      { sql: "app.money_coherent('UNKNOWN', 100::bigint, 'LOT_VALUE_UNKNOWN')", esperado: false },
    ];
    for (const caso of casos) {
      const fila = await h.comoAdmin(() => h.fila<{ c: boolean }>(`select ${caso.sql} as c`));
      expect([caso.sql, fila!.c]).toEqual([caso.sql, caso.esperado]);
    }
  });
});

describe("app.apportion: el mismo reparto que el motor de TypeScript", () => {
  const CASOS: Array<{ total: bigint; pesos: bigint[] }> = [
    { total: 17000n, pesos: [1n, 1n, 1n] },
    { total: 100n, pesos: [1n, 1n, 1n] },
    { total: -100n, pesos: [1n, 1n, 1n] },
    { total: 5n, pesos: [1n, 0n, 1n] },
    { total: 25000n, pesos: [2000n, 3000n] },
    { total: -1234n, pesos: [7n, 11n, 13n] },
    { total: 0n, pesos: [5n, 5n] },
    { total: 999999n, pesos: [7n, 11n, 13n, 17n] },
    { total: 7n, pesos: [3n] },
  ];

  it("paridad byte a byte con web/src/domain/finance/money.ts", async () => {
    for (const caso of CASOS) {
      const fila = await h.comoAdmin(() =>
        h.fila<{ partes: string[] }>("select app.apportion($1::bigint, $2::bigint[]) as partes", [
          caso.total.toString(),
          `{${caso.pesos.map((p) => p.toString()).join(",")}}`,
        ]),
      );
      const enSql = fila!.partes.map((p) => BigInt(p));
      const enTs = apportionOrThrow(money(CLP, caso.total), caso.pesos).map((m) => m.minor);
      expect([caso.total, enSql]).toEqual([caso.total, enTs]);
      expect(enSql.reduce((a, b) => a + b, 0n)).toBe(caso.total);
    }
  });

  it("[H15] los bloqueos son tipados y coinciden en los dos motores", async () => {
    const bloqueos: Array<{ total: bigint; pesos: string; esperado: string }> = [
      { total: 2500n, pesos: "{0,0}", esperado: "PESOS_SUMAN_CERO" },
      { total: 1000n, pesos: "{500,-100}", esperado: "PESO_NEGATIVO" },
      { total: 1000n, pesos: "{}", esperado: "SIN_PARTES" },
    ];
    for (const caso of bloqueos) {
      const fila = await h.comoAdmin(() =>
        h.fila<{ ok: boolean; blocked: string }>(
          "select (app.apportion_checked($1::bigint, $2::bigint[])).*",
          [caso.total.toString(), caso.pesos],
        ),
      );
      expect(fila!.ok).toBe(false);
      expect(fila!.blocked).toBe(caso.esperado);
    }
    // Y el motor de TypeScript bloquea por los mismos motivos.
    expect(apportion(money(CLP, 2500n), [0n, 0n]).ok).toBe(false);
    expect(apportion(money(CLP, 1000n), [500n, -100n]).ok).toBe(false);
    expect(apportion(money(CLP, 1000n), []).ok).toBe(false);
  });

  it("repartir un total DESCONOCIDO revienta: el desconocido no se reparte", async () => {
    const mensaje = await rechaza("select app.apportion(null::bigint, array[1,1]::bigint[])");
    expect(mensaje).toMatch(/desconocido/);
  });
});

describe("mul_div_round redondea a la par, igual que en TypeScript", () => {
  it("2,5 → 2 y 3,5 → 4, también bajo el cero", async () => {
    const fila = await h.comoAdmin(() =>
      h.fila<{ a: string; b: string; c: string; d: string }>(
        `select app.mul_div_round(5, 1, 2)::text as a,
                app.mul_div_round(7, 1, 2)::text as b,
                app.mul_div_round(-5, 1, 2)::text as c,
                app.mul_div_round(10, 2, 3)::text as d`,
      ),
    );
    expect([fila!.a, fila!.b, fila!.c, fila!.d]).toEqual(["2", "4", "-2", "7"]);
  });
});

describe("sumar dinero con huecos: sum() miente, app.sum_money no puede", () => {
  it("cuatro montos y dos huecos NO dan el total de los cuatro", async () => {
    const fila = await h.comoAdmin(() =>
      h.fila<{
        sum_ingenuo: string;
        conocido: string | null;
        al_menos: string;
        desconocidos: string;
        estado: string;
      }>(
        `with montos(minor) as (values (12000::bigint), (3000::bigint), (null), (null))
         select coalesce(sum(minor), 0)::text                                as sum_ingenuo,
                app.money_known(app.sum_money(minor, 'CLP'))::text           as conocido,
                app.money_at_least(app.sum_money(minor, 'CLP'))::text        as al_menos,
                (app.sum_money(minor, 'CLP')).unknown_count::text            as desconocidos,
                app.money_status_of(app.sum_money(minor, 'CLP'))::text       as estado
         from montos`,
      ),
    );
    // sum() ignora los NULL y devuelve un número que se lee como completo.
    expect(fila!.sum_ingenuo).toBe("15000");
    // app.sum_money no deja sacar ese número sin decidir qué pasa con los huecos.
    expect(fila!.conocido).toBeNull();
    expect(fila!.al_menos).toBe("15000");
    expect(fila!.desconocidos).toBe("2");
    expect(fila!.estado).toBe("UNKNOWN");
  });

  it("sin huecos, el total es el total", async () => {
    const fila = await h.comoAdmin(() =>
      h.fila<{ conocido: string; estado: string }>(
        `with montos(minor) as (values (12000::bigint), (3000::bigint))
         select app.money_known(app.sum_money(minor, 'CLP'))::text     as conocido,
                app.money_status_of(app.sum_money(minor, 'CLP'))::text as estado
         from montos`,
      ),
    );
    expect(fila!.conocido).toBe("15000");
    expect(fila!.estado).toBe("KNOWN");
  });

  it("mezclar monedas en una suma revienta", async () => {
    const mensaje = await rechaza(
      `with montos(minor, cur) as (values (100::bigint, 'CLP'::char(3)), (100::bigint, 'USD'::char(3)))
       select app.sum_money(minor, cur) from montos`,
    );
    expect(mensaje).toMatch(/monedas distintas/);
  });
});

describe("el valor del lote vive en entero, con su moneda congelada", () => {
  it("un lote nace con la moneda del hogar y con valor DESCONOCIDO declarado", async () => {
    const id = await crearLote("Pollo sin boleta", 1000);
    const l = await lote(id);
    expect(l.currency).toBe("CLP");
    expect(l.value_status).toBe("UNKNOWN");
    expect(l.value_minor).toBeNull();
    // El desconocido viaja con su motivo: la pantalla no dice "—", dice por qué.
    // El motivo lo fija el receptor único de la 0043 (`add_manual_lot` pasa por
    // `app.receive_lot_from_purchase`): un lote agregado a mano no es «entró sin
    // boleta», es «nadie registró un precio». Cuando este archivo aplicaba la
    // 0042 sola, acá corría todavía el `add_manual_lot` de la 0019.
    expect(l.value_unknown_reason).toBe("NO_PRICE_RECORDED");
  });

  it("[H57] la moneda del lote no se cambia después", async () => {
    const id = await crearLote("Pollo moneda", 500);
    const mensaje = await rechaza(
      "update public.inventory_lots set currency = 'USD' where id = $1",
      [id],
    );
    expect(mensaje).toMatch(/no se cambia/);
  });

  it("un lote no puede quedar KNOWN sin monto ni UNKNOWN sin motivo", async () => {
    const id = await crearLote("Pollo incoherente", 500);
    const sinMonto = await rechaza(
      "update public.inventory_lots set value_status = 'KNOWN' where id = $1",
      [id],
    );
    expect(sinMonto).toMatch(/lot_value_coherente/);
    const sinMotivo = await rechaza(
      "update public.inventory_lots set value_unknown_reason = null where id = $1",
      [id],
    );
    expect(sinMotivo).toMatch(/lot_value_coherente/);
  });

  it("«me lo regalaron» es CERO CONOCIDO, y no se confunde con no saber", async () => {
    const id = await crearLote("Zapallo del vecino", 800);
    await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, 0)", [id]));
    const l = await lote(id);
    expect(l.value_status).toBe("KNOWN");
    expect(l.value_minor).toBe("0");
    expect(l.value_unknown_reason).toBeNull();
  });

  it("la historia no se reescribe: un lote que ya costó algo no cambia de precio", async () => {
    const id = await crearLote("Pollo con boleta", 1000);
    await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, 12000)", [id]));
    const mensaje = await rechaza("select app.set_lot_value($1, 9000)", [id]);
    expect(mensaje).toMatch(/no reescribe la historia/);
    // Reponer el MISMO monto es idempotente, no un choque.
    await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, 12000)", [id]));
    expect((await lote(id)).value_minor).toBe("12000");
  });
});

describe("[H13] partir un lote conserva el valor AL PESO", () => {
  it("$17.000 en tres partes suman $17.000, no $16.998", async () => {
    const padre = await crearLote("Pollo K19 entero", 4200);
    await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, 17000)", [padre]));

    await h.como(USER_ANA, () =>
      h.db.query("select public.split_lot($1, array[1400, 1400, 1400]::numeric[])", [padre]),
    );

    const familia = await h.comoAdmin(() =>
      h.filas<FilaLote>(
        `select quantity, acquisition_value, value_minor::text as value_minor, value_status,
                value_unknown_reason, currency, parent_lot_id
         from public.inventory_lots
         where household_id = $1 and (id = $2 or parent_lot_id = $2)
         order by created_at`,
        [hogar.householdId, padre],
      ),
    );
    const hijos = familia.filter((l) => l.parent_lot_id !== null);
    expect(hijos).toHaveLength(3);
    expect(hijos.map((l) => l.value_minor)).toEqual(["5667", "5667", "5666"]);

    const total = familia.reduce((acc, l) => acc + minorDe(l), 0n);
    expect(total).toBe(17000n);
    // Truncar cada hijo por separado daba 5666 × 3 = 16.998 y $2 sin dueño.
  });

  it("una partición PARCIAL deja al padre el resto exacto", async () => {
    const padre = await crearLote("Pollo parcial", 450);
    await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, 4500)", [padre]));

    await h.como(USER_ANA, () =>
      h.db.query("select public.split_lot($1, array[150]::numeric[])", [padre]),
    );

    const hijos = await h.comoAdmin(() =>
      h.filas<FilaLote>(
        `select quantity, acquisition_value, value_minor::text as value_minor, value_status,
                value_unknown_reason, currency, parent_lot_id
         from public.inventory_lots where parent_lot_id = $1`,
        [padre],
      ),
    );
    expect(hijos).toHaveLength(1);
    expect(hijos[0]!.value_minor).toBe("1500");
    expect((await lote(padre)).value_minor).toBe("3000");
  });

  it("con cantidades de tres decimales el reparto sigue cerrando al peso", async () => {
    const padre = await crearLote("Pollo decimales", 1000);
    await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, 9999)", [padre]));
    await h.como(USER_ANA, () =>
      h.db.query("select public.split_lot($1, array[333.333, 333.333]::numeric[])", [padre]),
    );
    const familia = await h.comoAdmin(() =>
      h.filas<{ value_minor: string | null; parent_lot_id: string | null }>(
        `select value_minor::text as value_minor, parent_lot_id from public.inventory_lots
         where id = $1 or parent_lot_id = $1`,
        [padre],
      ),
    );
    const total = familia.reduce((acc, l) => acc + minorDe(l), 0n);
    expect(total).toBe(9999n);
  });

  it("un padre sin valor deja hijos DESCONOCIDOS con el mismo motivo, no en cero", async () => {
    const padre = await crearLote("Pollo sin precio", 600);
    await h.como(USER_ANA, () =>
      h.db.query("select public.split_lot($1, array[200, 200]::numeric[])", [padre]),
    );
    const hijos = await h.comoAdmin(() =>
      h.filas<FilaLote>(
        `select quantity, acquisition_value, value_minor::text as value_minor, value_status,
                value_unknown_reason, currency, parent_lot_id
         from public.inventory_lots where parent_lot_id = $1`,
        [padre],
      ),
    );
    expect(hijos).toHaveLength(2);
    for (const hijo of hijos) {
      expect(hijo.value_status).toBe("UNKNOWN");
      expect(hijo.value_minor).toBeNull();
      // El hijo HEREDA el motivo del padre, y el del padre lo puso el receptor
      // de la 0043: NO_PRICE_RECORDED. Lo que se prueba acá es la herencia, no
      // la etiqueta: un hijo en cero sería la mentira.
      expect(hijo.value_unknown_reason).toBe("NO_PRICE_RECORDED");
    }
  });

  it("K-19 congelado: 4.200 g / $17.003 en cuatro partes desparejas sigue cerrando", async () => {
    // El assert que el Sprint 7 dejó congelado, corrido AHORA con la 0042
    // puesta: la partición total tiene que dar exactamente los mismos números.
    const padre = await crearLote("Pollo K19 desparejo", 4200);
    await h.comoAdmin(() =>
      h.db.query("update public.inventory_lots set acquisition_value = 17003 where id = $1", [
        padre,
      ]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.split_lot($1, array[1100, 1300, 900, 900]::numeric[])", [padre]),
    );
    const familia = await h.comoAdmin(() =>
      h.filas<{ acquisition_value: string | null; parent_lot_id: string | null }>(
        `select acquisition_value, parent_lot_id from public.inventory_lots
         where id = $1 or parent_lot_id = $1`,
        [padre],
      ),
    );
    const hijos = familia.filter((l) => l.parent_lot_id !== null);
    expect(hijos).toHaveLength(4);
    const suma = hijos.reduce((acc, l) => acc + Number(l.acquisition_value), 0);
    expect(suma).toBeCloseTo(17003, 4); // ni un peso creado ni perdido
    expect(Number(familia.find((l) => l.parent_lot_id === null)!.acquisition_value)).toBe(0);
  });

  it("K-19 en numeric sigue igual: el padre queda debitado, sin clamp mudo", async () => {
    const padre = await crearLote("Pollo K19 numeric", 450);
    await h.comoAdmin(() =>
      h.db.query("update public.inventory_lots set acquisition_value = 4500 where id = $1", [padre]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.split_lot($1, array[150, 150, 150]::numeric[])", [padre]),
    );
    const familia = await h.comoAdmin(() =>
      h.filas<{ acquisition_value: string | null; parent_lot_id: string | null }>(
        `select acquisition_value, parent_lot_id from public.inventory_lots
         where id = $1 or parent_lot_id = $1`,
        [padre],
      ),
    );
    const hijos = familia.filter((l) => l.parent_lot_id !== null);
    for (const hijo of hijos) expect(Number(hijo.acquisition_value)).toBe(1500);
    const padreFila = familia.find((l) => l.parent_lot_id === null)!;
    expect(Number(padreFila.acquisition_value)).toBe(0);
  });
});

describe("fusionar: si una parte es DESCONOCIDA, el resultado es DESCONOCIDO", () => {
  async function conValor(label: string, cantidad: number, minor: number | null): Promise<string> {
    const id = await crearLote(label, cantidad);
    if (minor !== null) {
      await h.comoAdmin(() => h.db.query("select app.set_lot_value($1, $2)", [id, minor]));
    }
    return id;
  }

  it("dos lotes con precio dan la suma exacta y los orígenes quedan en CERO CONOCIDO", async () => {
    const a = await conValor("Merge A", 300, 1000);
    const b = await conValor("Merge B", 200, 700);
    const nuevo = await h.como(USER_ANA, async () =>
      (await h.fila<{ merge_lots: string }>("select public.merge_lots(array[$1, $2]::uuid[])", [
        a,
        b,
      ]))!.merge_lots,
    );
    const hijo = await lote(nuevo);
    expect(hijo.value_minor).toBe("1700");
    expect(hijo.value_status).toBe("KNOWN");
    // Cero CONOCIDO: entregaron todo lo que tenían y sabemos perfectamente que
    // ya no vale nada, que no es lo mismo que no saber cuánto valía.
    for (const origen of [a, b]) {
      const l = await lote(origen);
      expect(l.value_minor).toBe("0");
      expect(l.value_status).toBe("KNOWN");
    }
  });

  it("uno sin precio contagia: el resultado NO es la suma de la parte conocida", async () => {
    const a = await conValor("Merge C", 300, 1000);
    const b = await conValor("Merge D", 200, null);
    const nuevo = await h.como(USER_ANA, async () =>
      (await h.fila<{ merge_lots: string }>("select public.merge_lots(array[$1, $2]::uuid[])", [
        a,
        b,
      ]))!.merge_lots,
    );
    const hijo = await lote(nuevo);
    expect(hijo.value_status).toBe("UNKNOWN");
    expect(hijo.value_minor).toBeNull();
    expect(hijo.value_unknown_reason).toBe("MIXED_UNKNOWN_MERGE");
  });
});
