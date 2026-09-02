import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cargarPanelFinanzas } from "./queries";

/**
 * EL CARGADOR DEL PANEL, CONTRA UNA BASE DE MENTIRA PERO CON PREGUNTAS DE VERDAD.
 *
 * `cargarPanelFinanzas` no tenía UN solo test, y ahí se escondían los tres
 * defectos que el ataque encontró: dos alarmas escritas a mano en cero, una
 * cobertura fabricada y un gasto no capitalizado que se mostraba como $0
 * conocido. Ninguno era visible desde los tests del motor, porque el motor
 * recibía los números ya cocinados.
 *
 * Qué prueba esta doble y qué NO:
 *   - SÍ: qué le pregunta el cargador a la base, y cómo traduce lo que vuelve.
 *     Si alguien vuelve a escribir `uncostedOutflows: 0`, la consulta deja de
 *     hacerse y estos casos se ponen rojos.
 *   - NO: que las columnas existan en el esquema real. Eso lo verifica
 *     `contract-loaders.test.ts` corriendo los `.select()` contra PostgreSQL.
 */

type Fila = Record<string, unknown>;

interface BaseFalsa {
  readonly tablas: Record<string, Fila[]>;
  readonly permisos: Record<string, boolean>;
  /** Tablas donde el conteo exacto vuelve NULL: «no se pudo medir». */
  readonly sinConteo?: readonly string[];
  /** Lo que el cargador terminó preguntando, tabla por tabla. */
  readonly consultadas: string[];
}

function baseFalsa(
  tablas: Record<string, Fila[]>,
  opciones: { permisos?: Record<string, boolean>; sinConteo?: readonly string[] } = {},
): { db: SupabaseClient; estado: BaseFalsa } {
  const estado: BaseFalsa = {
    tablas,
    permisos: opciones.permisos ?? {
      FINANCE_VIEW: true,
      FINANCE_VIEW_MEMBER: false,
      FINANCE_UPLOAD_RECEIPTS: false,
      FINANCE_CONFIRM_RECEIPTS: false,
      FINANCE_MANAGE_PRICES: false,
      FINANCE_MANAGE_BUDGET: false,
    },
    sinConteo: opciones.sinConteo,
    consultadas: [],
  };

  const constructor = (tabla: string) => {
    estado.consultadas.push(tabla);
    let filas: Fila[] = [...(tabla in tablas ? tablas[tabla]! : [])];
    let contar = false;
    let soloCabecera = false;

    const resultado = () => {
      const count = contar
        ? estado.sinConteo?.includes(tabla) === true
          ? null
          : filas.length
        : null;
      return { data: soloCabecera ? null : filas, error: null, count };
    };

    const api = {
      select(_columnas: string, opciones?: { count?: string; head?: boolean }) {
        contar = opciones?.count === "exact";
        soloCabecera = opciones?.head === true;
        return api;
      },
      eq(columna: string, valor: unknown) {
        filas = filas.filter((f) => f[columna] === valor);
        return api;
      },
      in(columna: string, valores: readonly unknown[]) {
        filas = filas.filter((f) => valores.includes(f[columna]));
        return api;
      },
      // El alcance por fecha y los `or` no cambian lo que estos casos afirman:
      // las filas de prueba ya vienen dentro del período.
      gte: () => api,
      lte: () => api,
      is: () => api,
      or: () => api,
      not: () => api,
      /**
       * Ordena DE VERDAD. Un doble que ignorara el `.order()` dejaría pasar la
       * consulta sin orden —el defecto— con el mismo verde.
       */
      order(columna: string) {
        filas = [...filas].sort((a, b) => String(a[columna]).localeCompare(String(b[columna])));
        return api;
      },
      maybeSingle() {
        return Promise.resolve({ data: filas.length === 0 ? null : filas[0]!, error: null });
      },
      then<T>(resolver: (valor: ReturnType<typeof resultado>) => T) {
        return Promise.resolve(resultado()).then(resolver);
      },
    };
    return api;
  };

  const db = {
    from: constructor,
    rpc: (nombre: string) => {
      if (nombre !== "finance_permissions") throw new Error(`RPC inesperado: ${nombre}`);
      return Promise.resolve({ data: estado.permisos, error: null });
    },
  };
  return { db: db as unknown as SupabaseClient, estado };
}

const HOGAR = "hogar-1";
const COMPRA = "00000000-0000-0000-0000-0000000014c1";
const CARGO_REDONDEO = "00000000-0000-0000-0000-0000000014c2";
const CARGO_PRORRATEO = "00000000-0000-0000-0000-0000000014c3";
const HOY = "2026-09-15";

/** Un mes con consumo costeado, sin sorpresas: la línea base de comparación. */
function tablasBase(): Record<string, Fila[]> {
  return {
    finance_period_accruals: [
      {
        household_id: HOGAR,
        period_starts_on: "2026-09-01",
        category: "CONSUMED",
        currency: "CLP",
        movimientos: 4,
        known_minor: "96480",
        unknown_count: 0,
      },
    ],
    purchase_cash_summary: [],
    pantry_value: [
      {
        household_id: HOGAR,
        currency: "CLP",
        known_value_minor: "45820",
        unknown_lots: 0,
        total_lots: 3,
        value_status: "KNOWN",
      },
    ],
    household_food_budgets: [],
    unknown_value_inventory: [],
    late_recognition_report: [],
    finance_integrity_report: [],
    purchase_charges: [],
    cost_allocations: [],
  };
}

async function cargar(tablas: Record<string, Fila[]>) {
  const { db, estado } = baseFalsa(tablas);
  const r = await cargarPanelFinanzas(db, HOGAR, HOY);
  if (r.estado !== "OK") throw new Error("el hogar de prueba sí tiene FINANCE_VIEW");
  return { panel: r.datos, estado };
}

describe("las dos alarmas se MIDEN: no se declaran en cero", () => {
  it("consulta late_recognition_report y finance_integrity_report", async () => {
    const { estado } = await cargar(tablasBase());
    expect(estado.consultadas).toContain("late_recognition_report");
    expect(estado.consultadas).toContain("finance_integrity_report");
  });

  it("las salidas sin costear salen del conteo de la base, no de un 0 escrito a mano", async () => {
    const t = tablasBase();
    t.finance_integrity_report = [
      { household_id: HOGAR, tipo: "SALIDA_SIN_COSTEAR", subject_id: "m1" },
      { household_id: HOGAR, tipo: "SALIDA_SIN_COSTEAR", subject_id: "m2" },
      { household_id: HOGAR, tipo: "SALIDA_SIN_COSTEAR", subject_id: "m3" },
      // Otro tipo de descuadre: no es una salida sin costear y no se cuenta.
      { household_id: HOGAR, tipo: "COMPRA_DESCUADRADA", subject_id: "c1" },
    ];
    const { panel } = await cargar(t);
    expect(panel.pronostico.warnings).toContainEqual({
      code: "SHORTFALLS_NOT_COSTED",
      count: 3,
    });
  });

  it("los reconocimientos tardíos traen su monto y su período de ocurrencia", async () => {
    const t = tablasBase();
    t.late_recognition_report = [
      {
        household_id: HOGAR,
        recognized_period: "2026-09-01",
        occurred_period: "2026-08-01",
        currency: "CLP",
        cuantos: 2,
        known_minor: "3200",
        unknown_count: 0,
      },
      // De otro mes de reconocimiento: no es de este período y no entra.
      {
        household_id: HOGAR,
        recognized_period: "2026-07-01",
        occurred_period: "2026-06-01",
        currency: "CLP",
        cuantos: 9,
        known_minor: "99999",
        unknown_count: 0,
      },
    ];
    const { panel } = await cargar(t);
    expect(panel.pronostico.lateRecognitions.count).toBe(2);
    expect(panel.pronostico.lateRecognitions.amount).toEqual({
      known: true,
      amount: { currency: "CLP", minor: 3200n },
    });
    expect(panel.pronostico.lateRecognitions.occurredPeriods).toEqual(["2026-08-01"]);
    expect(panel.pronostico.warnings).toContainEqual({ code: "LATE_RECOGNITION", count: 2 });
  });

  it("un tardío sin costear NO se suma como $0: el monto queda DESCONOCIDO", async () => {
    const t = tablasBase();
    t.late_recognition_report = [
      {
        household_id: HOGAR,
        recognized_period: "2026-09-01",
        occurred_period: "2026-08-01",
        currency: "CLP",
        cuantos: 1,
        known_minor: null,
        unknown_count: 1,
      },
    ];
    const { panel } = await cargar(t);
    expect(panel.pronostico.lateRecognitions.amount.known).toBe(false);
  });

  it("sin reconocimientos tardíos el cero es MEDIDO y no hay aviso", async () => {
    const { panel } = await cargar(tablasBase());
    expect(panel.pronostico.lateRecognitions.count).toBe(0);
    expect(panel.pronostico.warnings.map((w) => w.code)).not.toContain("LATE_RECOGNITION");
    expect(panel.pronostico.warnings.map((w) => w.code)).not.toContain("SHORTFALLS_NOT_COSTED");
  });

  it("si la base no devuelve el conteo, revienta: un conteo que falta no es cero", async () => {
    const { db } = baseFalsa(tablasBase(), { sinConteo: ["finance_integrity_report"] });
    await expect(cargarPanelFinanzas(db, HOGAR, HOY)).rejects.toThrow(/salidas sin costear/i);
  });
});

describe("la cobertura del período no se puede fabricar", () => {
  it("con TODAS las asignaciones sin costear no hay cobertura KNOWN ni semáforo verde", async () => {
    const t = tablasBase();
    t.finance_period_accruals = [
      {
        household_id: HOGAR,
        period_starts_on: "2026-09-01",
        category: "WASTED_AVOIDABLE",
        currency: "CLP",
        movimientos: 3,
        known_minor: null,
        unknown_count: 3,
      },
    ];
    t.household_food_budgets = [
      {
        household_id: HOGAR,
        period_type: "MONTH",
        category: null,
        basis: "ECONOMIC_CONSUMPTION",
        amount_minor: "100000",
        valid_from: "2026-09-01",
        currency: "CLP",
      },
    ];
    const { panel } = await cargar(t);
    const cubeta = panel.pronostico.economicConsumption.byCategory[0]!;
    expect(cubeta.knownCount).toBe(0);
    expect(cubeta.unknownCount).toBe(3);
    // La mutación que el atacante nombró: knownQuantityMilli === totalQuantityMilli
    // hacía que esto diera "KNOWN" y encendiera el semáforo verde.
    expect(panel.pronostico.confidence).not.toBe("KNOWN");
    expect(panel.pronostico.coverage.unknownItems).toBe(3);
    const v = panel.pronostico.budgets.find((b) => b.basis === "ECONOMIC_CONSUMPTION")!;
    expect(v.state).toBe("UNKNOWN_COVERAGE");
    expect(panel.pronostico.economicConsumption.total.known).toBe(false);
  });

  it("con todo costeado sí se puede afirmar KNOWN", async () => {
    const { panel } = await cargar(tablasBase());
    expect(panel.pronostico.coverage.knownItems).toBe(4);
    expect(panel.pronostico.coverage.unknownItems).toBe(0);
    expect(panel.pronostico.confidence).toBe("KNOWN");
  });

  it("una cubeta con más desconocidos que movimientos es un dato roto y revienta", async () => {
    const t = tablasBase();
    t.finance_period_accruals = [
      {
        household_id: HOGAR,
        period_starts_on: "2026-09-01",
        category: "CONSUMED",
        currency: "CLP",
        movimientos: 1,
        known_minor: null,
        unknown_count: 4,
      },
    ];
    const { db } = baseFalsa(t);
    await expect(cargarPanelFinanzas(db, HOGAR, HOY)).rejects.toThrow(/sin costear/i);
  });
});

describe("la misma pantalla, cargada dos veces, dice lo mismo", () => {
  /** Dos cubetas sin costear, con motivos DISTINTOS y precedencias distintas. */
  function dosCubetas(): Fila[] {
    return [
      {
        household_id: HOGAR,
        period_starts_on: "2026-09-01",
        category: "WASTED_AVOIDABLE",
        currency: "CLP",
        movimientos: 1,
        known_minor: null,
        unknown_count: 1,
      },
      {
        household_id: HOGAR,
        period_starts_on: "2026-09-01",
        category: "CONSUMED",
        currency: "CLP",
        movimientos: 1,
        known_minor: null,
        unknown_count: 1,
      },
    ];
  }

  it("las categorías salen siempre en el mismo orden, venga como venga la base", async () => {
    const t1 = tablasBase();
    t1.finance_period_accruals = dosCubetas();
    const t2 = tablasBase();
    t2.finance_period_accruals = [...dosCubetas()].reverse();
    const a = await cargar(t1);
    const b = await cargar(t2);
    const categorias = (p: typeof a.panel) =>
      p.pronostico.economicConsumption.byCategory.map((c) => c.category);
    expect(categorias(a.panel)).toEqual(["CONSUMED", "WASTED_AVOIDABLE"]);
    expect(categorias(b.panel)).toEqual(categorias(a.panel));
  });

  // El motivo del desconocido tampoco puede depender del orden, pero eso NO se
  // puede demostrar desde acá: el cargador etiqueta todo desconocido de accruals
  // con el mismo `LOT_VALUE_UNKNOWN`, así que las dos cubetas traen el mismo
  // motivo y el caso pasaría igual con el defecto puesto. Vive donde los motivos
  // sí pueden diferir: forecast-engine.test.ts, «el motivo que se muestra».
});

describe("[H12] el gasto que no queda en la despensa no se muestra como $0 conocido", () => {
  function compraConDespacho(): Record<string, Fila[]> {
    const t = tablasBase();
    t.purchase_cash_summary = [
      {
        household_id: HOGAR,
        purchase_id: COMPRA,
        label: "Súper",
        purchased_on: "2026-09-03",
        currency: "CLP",
        declared_total_minor: "10003",
        total_status: "KNOWN",
        capitalized_known_minor: "10000",
        capitalized_unknown_count: 0,
        // La vista suma ASIGNACIONES: sin ellas devuelve 0 conocido.
        expensed_only_known_minor: "0",
        expensed_only_unknown_count: 0,
      },
    ];
    t.purchase_charges = [
      {
        household_id: HOGAR,
        id: CARGO_REDONDEO,
        purchase_id: COMPRA,
        policy: "EXPENSE_ONLY",
      },
      // Un cargo que SÍ capitaliza: no tiene por qué tener asignación de gasto.
      {
        household_id: HOGAR,
        id: CARGO_PRORRATEO,
        purchase_id: COMPRA,
        policy: "PRO_RATA_VALUE",
      },
    ];
    return t;
  }

  it("un cargo EXPENSE_ONLY sin asignación deja el gasto DESCONOCIDO, no en cero", async () => {
    const { panel } = await cargar(compraConDespacho());
    expect(panel.pronostico.cash.expensedOnly.known).toBe(false);
    expect(panel.faltantes).toContainEqual({
      origen: "CARGO",
      motivo: "POLICY_NOT_APPLICABLE",
      cuantos: 1,
    });
  });

  it("con su asignación puesta, el mismo gasto vuelve a ser un número", async () => {
    const t = compraConDespacho();
    t.cost_allocations = [
      {
        household_id: HOGAR,
        category: "NON_CAPITALIZED_EXPENSE",
        purchase_charge_id: CARGO_REDONDEO,
      },
    ];
    // Sin `!`: si la fila de prueba no existiera, el caso pasaría a afirmar
    // otra cosa que la que dice su nombre, y eso no se avisa con un no-nulo.
    const resumen = t["purchase_cash_summary"];
    const fila = resumen === undefined ? undefined : resumen[0];
    if (fila === undefined) throw new Error("la compra de prueba tiene que existir");
    fila["expensed_only_known_minor"] = "3";
    const { panel } = await cargar(t);
    expect(panel.pronostico.cash.expensedOnly).toEqual({
      known: true,
      amount: { currency: "CLP", minor: 3n },
    });
    expect(panel.faltantes.map((f) => f.origen)).not.toContain("CARGO");
  });
});

describe("[H17] sin permiso no se consulta nada y no se pinta ningún monto", () => {
  it("devuelve SIN_PERMISO en vez de un mes de $0", async () => {
    const { db, estado } = baseFalsa(tablasBase(), {
      permisos: {
        FINANCE_VIEW: false,
        FINANCE_VIEW_MEMBER: false,
        FINANCE_UPLOAD_RECEIPTS: false,
        FINANCE_CONFIRM_RECEIPTS: false,
        FINANCE_MANAGE_PRICES: false,
        FINANCE_MANAGE_BUDGET: false,
      },
    });
    const r = await cargarPanelFinanzas(db, HOGAR, HOY);
    expect(r.estado).toBe("SIN_PERMISO");
    expect(estado.consultadas).toEqual([]);
  });
});
