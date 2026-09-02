import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { dateString, uuid } from "@/lib/supabase/rows";
import {
  moneyMinor,
  moneyMinorNullable,
  moneyStatus,
  currencyCode as currencyCodeSchema,
} from "@/domain/finance/rows";
import {
  MoneyError,
  known,
  money,
  sumStrict,
  unknown,
  type CurrencyCode,
  type Money,
  type MoneyOrUnknown,
} from "@/domain/finance/money";
import { UMBRALES_POR_DEFECTO } from "@/domain/finance/confidence";
import {
  ACCRUAL_CATEGORIES,
  forecast,
  type AccrualBucket,
  type AccrualCategory,
  type CashSpendEntry,
  type FinanceForecastResult,
  type HouseholdBudget,
} from "@/domain/finance/forecast-engine";

type Db = SupabaseClient;

/**
 * EL CARGADOR DEL PANEL DE FINANZAS.
 *
 * Dos reglas mandan acá, y las dos vienen de cómo se rompe una pantalla de
 * plata:
 *
 *   ERROR != VACÍO. Toda consulta que falla lanza `DataAccessError`. Ninguna se
 *   traga en un `catch` ni devuelve una lista vacía de consuelo.
 *
 *   [H17] SIN PERMISO != $0. La RLS de este sprint no devuelve error a quien no
 *   tiene `FINANCE_VIEW`: le devuelve CERO FILAS. Un loader que suma cero filas
 *   pinta «$0 gastado», indistinguible de un hogar que no gastó nada — y el test
 *   que vigila `DataAccessError` no lo ve, porque la consulta anduvo perfecto.
 *   Por eso lo PRIMERO que hace este módulo es PREGUNTAR por el permiso
 *   (`public.finance_permissions`) y devolver un estado tipado `SIN_PERMISO`, y
 *   por eso el retorno es un `Result` y no los datos pelados: no hay forma de
 *   usar este loader sin decidir qué se muestra cuando no hay permiso.
 */

export type ResultadoFinanzas<T> =
  | { readonly estado: "OK"; readonly datos: T }
  | { readonly estado: "SIN_PERMISO" };

/**
 * NO se llama `permisosRow` a propósito: no es una FILA de ninguna tabla, es el
 * `jsonb` que devuelve el RPC `public.finance_permissions`. El guardián §35
 * (`contract-loaders.test.ts`) exige que cada `xRow` tenga un `.select()` que
 * pida sus columnas, y acá no hay columnas que pedir — el nombre honesto evita
 * un falso positivo que después alguien apagaría con una excepción.
 */
const esquemaPermisos = z.object({
  FINANCE_VIEW: z.boolean(),
  FINANCE_VIEW_MEMBER: z.boolean(),
  FINANCE_UPLOAD_RECEIPTS: z.boolean(),
  FINANCE_CONFIRM_RECEIPTS: z.boolean(),
  FINANCE_MANAGE_PRICES: z.boolean(),
  FINANCE_MANAGE_BUDGET: z.boolean(),
});

export type PermisosFinancieros = z.infer<typeof esquemaPermisos>;

export const SIN_PERMISOS: PermisosFinancieros = {
  FINANCE_VIEW: false,
  FINANCE_VIEW_MEMBER: false,
  FINANCE_UPLOAD_RECEIPTS: false,
  FINANCE_CONFIRM_RECEIPTS: false,
  FINANCE_MANAGE_PRICES: false,
  FINANCE_MANAGE_BUDGET: false,
};

export async function cargarPermisos(
  db: Db,
  householdId: string,
): Promise<PermisosFinancieros> {
  const { data, error } = await db.rpc("finance_permissions", { p_household: householdId });
  if (error) throw new DataAccessError("los permisos financieros del hogar", error);
  // `null` acá significa «no eres integrante de este hogar»: cero permisos, no
  // un error. Cualquier otra forma sí es un problema del esquema y revienta.
  if (data === null) return SIN_PERMISOS;
  return esquemaPermisos.parse(data);
}

// ---------------------------------------------------------------------------

/**
 * Un CONTEO que llega de la base.
 *
 * No usa `z.coerce.number()` a propósito, y no es manía: ese helper convierte
 * `""` y `null` en **0** sin quejarse, que es el patrón exacto que este sprint
 * persigue —el guardián `finanzas-invariantes.test.ts` lo prohíbe por regex en
 * todo archivo que mencione plata—. Acá el texto se valida ANTES de convertir.
 */
const conteo = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((v) => (typeof v === "number" ? v : Number(v)));

const accrualRow = z.object({
  category: z.enum(ACCRUAL_CATEGORIES),
  currency: currencyCodeSchema,
  /**
   * Cuántas asignaciones hay en la cubeta. Se pide para poder restar el
   * desconocido y saber CUÁNTAS sí tienen costo: sin ese conteo, `known_minor`
   * = 0 se lee igual cuando todo salió gratis y cuando no se costeó ni una.
   */
  movimientos: conteo,
  known_minor: moneyMinorNullable,
  unknown_count: conteo,
});

const lateRow = z.object({
  occurred_period: dateString,
  currency: currencyCodeSchema,
  cuantos: conteo,
  known_minor: moneyMinorNullable,
  unknown_count: conteo,
});

/**
 * Un cargo de compra, para saber si su gasto no capitalizable llegó a los
 * libros. NO trae el monto a propósito: acá no se suma plata, se comprueba si
 * EXISTE la asignación que la reconoce.
 */
const chargeRow = z.object({
  id: uuid,
  purchase_id: uuid,
  policy: z.enum(["DIRECT_LINE", "PRO_RATA_VALUE", "PRO_RATA_WEIGHT", "EXPENSE_ONLY"]),
});

const chargeAllocationRow = z.object({ purchase_charge_id: uuid.nullable() });

const cashRow = z.object({
  purchase_id: uuid,
  label: z.string(),
  purchased_on: dateString,
  currency: currencyCodeSchema,
  declared_total_minor: moneyMinorNullable,
  total_status: moneyStatus,
  capitalized_known_minor: moneyMinorNullable,
  capitalized_unknown_count: conteo,
  expensed_only_known_minor: moneyMinorNullable,
  expensed_only_unknown_count: conteo,
});

const pantryRow = z.object({
  currency: currencyCodeSchema,
  known_value_minor: moneyMinorNullable,
  unknown_lots: conteo,
  total_lots: conteo,
  value_status: moneyStatus,
});

const budgetRow = z.object({
  basis: z.enum(["CASH", "ECONOMIC_CONSUMPTION"]),
  amount_minor: moneyMinor,
  valid_from: dateString,
  currency: currencyCodeSchema,
});

const faltanteRow = z.object({
  origen: z.string(),
  motivo: z.string().nullable(),
  cuantos: conteo,
});

export type OrigenFaltante = "LOTE" | "ASIGNACION" | "CARGO";

export interface PanelFinanzas {
  readonly currency: CurrencyCode;
  readonly periodo: { readonly startsOn: string; readonly endsOn: string };
  readonly pronostico: FinanceForecastResult;
  /** Lo que NO se pudo costear, por motivo. Se muestra: no se omite. */
  readonly faltantes: readonly {
    origen: OrigenFaltante | string;
    motivo: string;
    cuantos: number;
  }[];
  readonly permisos: PermisosFinancieros;
}

/**
 * Un `known_minor` NULL de una vista agregada NO es cero: es «no había ninguna
 * fila conocida». Se traduce a `Money` cero sólo cuando el conteo de
 * desconocidos también es cero; si no, el desconocido manda.
 */
function subtotal(minor: bigint | null, currency: CurrencyCode): Money {
  return minor === null ? money(currency, 0n) : money(currency, minor);
}

function montoDe(
  minor: bigint | null,
  desconocidos: number,
  currency: CurrencyCode,
): MoneyOrUnknown {
  if (desconocidos > 0) return unknown("LOT_VALUE_UNKNOWN");
  return known(subtotal(minor, currency));
}

/**
 * El gasto que NO queda en la despensa, sabiendo si algún cargo se quedó fuera
 * de los libros.
 *
 * `sinReconocer` cuenta los cargos EXPENSE_ONLY de esa compra sin asignación.
 * Con uno solo, el monto es DESCONOCIDO: la suma de las asignaciones que sí
 * existen es un subtotal, y presentarlo como total —«$0» cuando no hay
 * ninguna— es la mentira exacta que este sprint persigue.
 */
function gastoQueNoQueda(
  minor: bigint | null,
  desconocidos: number,
  sinReconocer: number | undefined,
  currency: CurrencyCode,
): MoneyOrUnknown {
  if (sinReconocer !== undefined && sinReconocer > 0) return unknown("POLICY_NOT_APPLICABLE");
  return montoDe(minor, desconocidos, currency);
}

/** Dos monedas en la misma cifra no es un dato incompleto: es un dato falso. */
function exigirMoneda(fila: CurrencyCode, currency: CurrencyCode, que: string): void {
  if (fila !== currency) {
    throw new MoneyError(
      "MONEDA_DISTINTA",
      `el panel está en ${currency} y ${que} viene en ${fila}: no se suman escalas distintas`,
    );
  }
}

/** Primer día del mes de `hoy`, y el último. Sin reloj: `hoy` viene del hogar. */
function mesDe(hoy: string): { startsOn: string; endsOn: string } {
  const [anio, mes] = hoy.split("-");
  if (anio === undefined || mes === undefined) {
    throw new Error(`la fecha del hogar "${hoy}" no tiene forma AAAA-MM-DD`);
  }
  const inicio = `${anio}-${mes}-01`;
  const siguiente = new Date(Date.UTC(Number(anio), Number(mes), 1));
  siguiente.setUTCDate(0); // último día del mes de `hoy`
  const fin = siguiente.toISOString().slice(0, 10);
  return { startsOn: inicio, endsOn: fin };
}

export async function cargarPanelFinanzas(
  db: Db,
  householdId: string,
  hoy: string,
): Promise<ResultadoFinanzas<PanelFinanzas>> {
  const permisos = await cargarPermisos(db, householdId);
  // El corte explícito. Sin esto, todo lo de abajo devolvería vacío y la
  // pantalla mostraría un mes de $0 que nunca existió.
  if (!permisos.FINANCE_VIEW) return { estado: "SIN_PERMISO" };

  const periodo = mesDe(hoy);

  const [accrualsRes, cashRes, pantryRes, budgetsRes, faltantesRes, tardiosRes, sinCostearRes] =
    await Promise.all([
    db
      .from("finance_period_accruals")
      .select("category, currency, movimientos, known_minor, unknown_count")
      .eq("household_id", householdId)
      .eq("period_starts_on", periodo.startsOn)
      // Sin orden explícito, las filas del mes salían en el orden que le
      // conviniera al planner: las mismas cifras cambiaban de lugar entre dos
      // cargas de la misma pantalla. Una pantalla de plata que se reordena sola
      // se lee como si hubiera cambiado algo.
      .order("category"),
    db
      .from("purchase_cash_summary")
      .select(
        `purchase_id, label, purchased_on, currency, declared_total_minor, total_status,
         capitalized_known_minor, capitalized_unknown_count,
         expensed_only_known_minor, expensed_only_unknown_count`,
      )
      .eq("household_id", householdId)
      .gte("purchased_on", periodo.startsOn)
      .lte("purchased_on", periodo.endsOn),
    db
      .from("pantry_value")
      .select("currency, known_value_minor, unknown_lots, total_lots, value_status")
      .eq("household_id", householdId)
      .maybeSingle(),
    db
      .from("household_food_budgets")
      .select("basis, amount_minor, valid_from, currency")
      .eq("household_id", householdId)
      .eq("period_type", "MONTH")
      .is("category", null)
      .lte("valid_from", periodo.startsOn)
      .or(`valid_to.is.null,valid_to.gte.${periodo.startsOn}`),
    db
      .from("unknown_value_inventory")
      .select("origen, motivo, cuantos")
      .eq("household_id", householdId),
    /**
     * [H56] LOS RECONOCIMIENTOS TARDÍOS SE MIDEN, NO SE DECLARAN EN CERO.
     *
     * Acá iba escrito a mano `lateRecognitions: { count: 0, amount:
     * known(money(currency, 0n)) }`. Un cero AFIRMADO sobre algo que nadie
     * midió es la peor forma del defecto que este sprint persigue: la vista
     * existía, estaba otorgada a `authenticated`, y la alarma que la habría
     * delatado estaba cableada a cero en el mismo objeto.
     */
    db
      .from("late_recognition_report")
      .select("occurred_period, currency, cuantos, known_minor, unknown_count")
      .eq("household_id", householdId)
      .eq("recognized_period", periodo.startsOn)
      .order("occurred_period"),
    /**
     * LAS SALIDAS SIN COSTEAR, contadas por la base.
     *
     * `count: "exact"` y no `data.length`: PostgREST puede truncar una lista
     * larga y un conteo truncado se vería como «hay menos problemas de los que
     * hay». El conteo viene del servidor o no viene, y si no viene se revienta.
     */
    db
      .from("finance_integrity_report")
      .select("subject_id", { count: "exact", head: true })
      .eq("household_id", householdId)
      .eq("tipo", "SALIDA_SIN_COSTEAR"),
  ]);

  for (const [contexto, res] of [
    ["las asignaciones del período", accrualsRes],
    ["las compras del período", cashRes],
    ["el valor de la despensa", pantryRes],
    ["el presupuesto del hogar", budgetsRes],
    ["lo que falta por costear", faltantesRes],
    ["los reconocimientos tardíos", tardiosRes],
    ["las salidas sin costear", sinCostearRes],
  ] as const) {
    if (res.error) throw new DataAccessError(`finanzas: ${contexto}`, res.error);
  }

  const despensa = pantryRes.data === null ? null : pantryRow.parse(pantryRes.data);
  const filasAccruals = z.array(accrualRow).parse(accrualsRes.data);
  const filasCaja = z.array(cashRow).parse(cashRes.data);
  const filasPresupuesto = z.array(budgetRow).parse(budgetsRes.data);
  const filasFaltantes = z.array(faltanteRow).parse(faltantesRes.data);
  const filasTardias = z.array(lateRow).parse(tardiosRes.data);

  // Un conteo que no llegó NO es cero: es «no lo pudimos medir», y una alarma
  // que no se pudo medir no puede reportarse apagada.
  const salidasSinCostear = sinCostearRes.count;
  if (salidasSinCostear === null) {
    throw new Error(
      "finanzas: la base no devolvió el conteo de salidas sin costear; " +
        "sin ese número la alarma SHORTFALLS_NOT_COSTED estaría apagada sin saberlo",
    );
  }

  // La moneda sale del dato, no de una constante: si el hogar todavía no tiene
  // ni un lote ni una compra, no hay nada que mostrar y CLP es el default del
  // esquema (`households.currency`), no una suposición de esta pantalla.
  const currency: CurrencyCode =
    despensa?.currency ?? filasCaja[0]?.currency ?? filasAccruals[0]?.currency ?? "CLP";

  // Una fila en otra moneda NO se suma como si fuera de esta: el panel muestra
  // UN número, y mezclar escalas produce uno que no significa nada. Revienta.
  for (const f of filasAccruals) exigirMoneda(f.currency, currency, "una asignación del período");
  for (const f of filasCaja) exigirMoneda(f.currency, currency, "una compra del período");
  for (const f of filasTardias) exigirMoneda(f.currency, currency, "un reconocimiento tardío");
  for (const f of filasPresupuesto) exigirMoneda(f.currency, currency, "el presupuesto del hogar");

  /**
   * [H12] LOS CARGOS QUE NUNCA LLEGARON A LOS LIBROS.
   *
   * `purchase_cash_summary` arma el gasto no capitalizado sumando ASIGNACIONES.
   * Una compra manual crea sus cargos EXPENSE_ONLY (despacho, propina, el
   * redondeo de la conciliación) y hoy nadie los asigna, así que la vista
   * devuelve `known_minor = 0` con `unknown_count = 0` y la fila «Gasto que no
   * queda en la despensa» rendía un CERO CONOCIDO: plata que salió del bolsillo,
   * no entró a la despensa y no aparece en ninguna parte.
   *
   * Acá se pregunta por los cargos de verdad. Si existe uno sin su asignación,
   * el monto es DESCONOCIDO —no cero— y el faltante se declara en pantalla.
   */
  const cargosSinReconocer = await cargosNoCapitalizadosSinAsignacion(
    db,
    householdId,
    filasCaja.map((f) => f.purchase_id),
  );
  let cargosHuerfanos = 0;
  for (const cuantos of cargosSinReconocer.values()) cargosHuerfanos += cuantos;

  const accruals: AccrualBucket[] = filasAccruals.map((f) => {
    const conocidas = f.movimientos - f.unknown_count;
    if (conocidas < 0) {
      throw new Error(
        `finanzas: la cubeta ${f.category} dice tener ${f.unknown_count} asignaciones sin costear ` +
          `de un total de ${f.movimientos}`,
      );
    }
    return {
      category: f.category as AccrualCategory,
      known: subtotal(f.known_minor, currency),
      knownCount: conocidas,
      unknownCount: f.unknown_count,
      unknownReasons: f.unknown_count > 0 ? (["LOT_VALUE_UNKNOWN"] as const) : [],
      /**
       * POR CONTEO, y no por cantidad: `cost_allocations` guarda `quantity`
       * pero NO su unidad, y la vista entrega una sola cantidad total sin
       * partirla en costeada y sin costear. La versión anterior copiaba esa
       * cantidad en los dos campos —`knownQuantityMilli === totalQuantityMilli`—
       * y hacía que la cobertura saliera KNOWN aunque no hubiera ni una
       * asignación costeada, con `unit: "G"` fijo para gramos, mililitros y
       * unidades por igual ([H19] de vuelta por la puerta de atrás).
       */
      coverage: { kind: "POR_CONTEO" },
    };
  });

  const cashSpend: CashSpendEntry[] = filasCaja.map((f) => ({
    purchaseId: f.purchase_id,
    label: f.label,
    purchasedOn: f.purchased_on,
    total:
      f.total_status === "KNOWN" && f.declared_total_minor !== null
        ? known(money(currency, f.declared_total_minor))
        : unknown("NOT_YET_RECOGNIZED"),
    capitalized: montoDe(f.capitalized_known_minor, f.capitalized_unknown_count, currency),
    expensedOnly: gastoQueNoQueda(
      f.expensed_only_known_minor,
      f.expensed_only_unknown_count,
      cargosSinReconocer.get(f.purchase_id),
      currency,
    ),
  }));

  const budgets: HouseholdBudget[] = filasPresupuesto.map((f) => ({
    basis: f.basis,
    amount: money(currency, f.amount_minor),
    validFrom: f.valid_from,
  }));

  const saldo: MoneyOrUnknown =
    despensa === null
      ? known(money(currency, 0n))
      : despensa.value_status === "KNOWN"
        ? known(subtotal(despensa.known_value_minor, currency))
        : unknown("LOT_VALUE_UNKNOWN");

  const pronostico = forecast({
    currency,
    today: hoy,
    period: { type: "MONTH", startsOn: periodo.startsOn, endsOn: periodo.endsOn },
    budgets,
    accruals,
    cashSpend,
    // El plan del período todavía no alimenta esta pantalla: la capa de costeo
    // estimado se conecta cuando la lista de compras traiga sus estimaciones.
    // Va VACÍO y no inventado — una proyección de $0 sería peor que ninguna.
    plannedLines: [],
    plannedConsumptionCost: unknown("NO_PRICE_RECORDED"),
    // El saldo de APERTURA exige un histórico que este sprint todavía no
    // guarda; se declara desconocido en vez de asumir cero, que haría que el
    // cuadre «apertura + capitalizado − salidas == cierre» diera siempre falso.
    openingPantryValue: unknown("NOT_YET_RECOGNIZED"),
    closingPantryValue: saldo,
    /**
     * MEDIDO, fila por fila, contra `public.late_recognition_report`.
     *
     * Con cero filas el monto es un cero DE VERDAD —«no hubo ninguno», medido—
     * y no un cero afirmado sobre algo que nadie consultó. La diferencia no es
     * retórica: antes este objeto decía `count: 0` con la vista sin abrir.
     */
    lateRecognitions: {
      count: filasTardias.reduce((acc, f) => acc + f.cuantos, 0),
      amount: sumStrict(
        filasTardias.map((f) => montoDe(f.known_minor, f.unknown_count, currency)),
        currency,
      ),
      occurredPeriods: [...new Set(filasTardias.map((f) => f.occurred_period))].sort(),
    },
    thresholds: UMBRALES_POR_DEFECTO,
    atRiskBps: 8500n,
    uncostedOutflows: salidasSinCostear,
    staleAfterDays: 90,
  });

  const faltantes = filasFaltantes.map((f) => ({
    origen: f.origen,
    motivo: f.motivo === null ? "SIN_MOTIVO_DECLARADO" : f.motivo,
    cuantos: f.cuantos,
  }));
  if (cargosHuerfanos > 0) {
    faltantes.push({
      origen: "CARGO",
      motivo: "POLICY_NOT_APPLICABLE",
      cuantos: cargosHuerfanos,
    });
  }

  return {
    estado: "OK",
    datos: { currency, periodo, pronostico, faltantes, permisos },
  };
}

/**
 * Los cargos EXPENSE_ONLY del período que NO tienen su asignación de costo,
 * agrupados por compra.
 *
 * Se pregunta por los CARGOS y no por los montos: acá no se suma plata, se
 * comprueba si la plata que ya salió del bolsillo llegó a los libros. Un cargo
 * sin asignación es dinero que la vista de caja no puede ver, y por eso el
 * subtotal que devuelve deja de ser un total.
 */
async function cargosNoCapitalizadosSinAsignacion(
  db: Db,
  householdId: string,
  purchaseIds: readonly string[],
): Promise<Map<string, number>> {
  const sinReconocer = new Map<string, number>();
  if (purchaseIds.length === 0) return sinReconocer;

  const cargosRes = await db
    .from("purchase_charges")
    .select("id, purchase_id, policy")
    .eq("household_id", householdId)
    .in("purchase_id", [...purchaseIds]);
  if (cargosRes.error) {
    throw new DataAccessError("finanzas: los cargos de las compras del período", cargosRes.error);
  }
  const cargos = z
    .array(chargeRow)
    .parse(cargosRes.data)
    .filter((c) => c.policy === "EXPENSE_ONLY");
  if (cargos.length === 0) return sinReconocer;

  const asignadosRes = await db
    .from("cost_allocations")
    .select("purchase_charge_id")
    .eq("household_id", householdId)
    .eq("category", "NON_CAPITALIZED_EXPENSE")
    .in(
      "purchase_charge_id",
      cargos.map((c) => c.id),
    );
  if (asignadosRes.error) {
    throw new DataAccessError(
      "finanzas: las asignaciones del gasto no capitalizado",
      asignadosRes.error,
    );
  }
  const reconocidos = new Set(
    z
      .array(chargeAllocationRow)
      .parse(asignadosRes.data)
      .map((a) => a.purchase_charge_id),
  );

  for (const c of cargos) {
    if (reconocidos.has(c.id)) continue;
    const previos = sinReconocer.get(c.purchase_id);
    sinReconocer.set(c.purchase_id, previos === undefined ? 1 : previos + 1);
  }
  return sinReconocer;
}
