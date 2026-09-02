import { describe, expect, it } from "vitest";
import {
  CURRENCY_UNITS,
  MONEY_MAX_MINOR,
  MoneyError,
  UNKNOWN_REASONS,
  UNKNOWN_REASON_PRECEDENCE,
  add,
  apportion,
  apportionOrThrow,
  atLeastAmount,
  closePartial,
  compare,
  free,
  isComplete,
  isFree,
  known,
  money,
  mulDiv,
  parseMinor,
  subtract,
  sumPartial,
  sumStrict,
  unknown,
  zero,
  type MoneyEntry,
  type MoneyOrUnknown,
} from "./money";

/**
 * Cada test de acá está escrito para FALLAR si el arreglo se revierte, no para
 * pasear por la API: los números vienen de los cuatro defectos que la revisión
 * adversarial encontró en el diseño del Sprint 14 ([H13], [H15], [H19], [H20])
 * y de las dos reglas duras del sprint —desconocido ≠ cero, el dinero no pasa
 * por coma flotante—.
 */

const CLP = "CLP" as const;
const USD = "USD" as const;

const suma = (montos: readonly { minor: bigint }[]): bigint =>
  montos.reduce((acc, m) => acc + m.minor, 0n);

describe("la escala: entero en unidad menor, jamás un float", () => {
  it("el peso chileno no tiene unidad menor fraccionaria", () => {
    expect(CURRENCY_UNITS.CLP.minorExponent).toBe(0);
    expect(CURRENCY_UNITS.USD.minorExponent).toBe(2);
  });

  it("suma y resta son exactas donde el float ya se habría equivocado", () => {
    // 0,1 + 0,2 en centavos: 10 + 20 = 30, sin 0.30000000000000004 a la vista.
    expect(add(money(USD, 10n), money(USD, 20n)).minor).toBe(30n);
    expect(subtract(money(CLP, 25000n), money(CLP, 10000n)).minor).toBe(15000n);
  });

  it("sumar monedas distintas revienta: es un bug, no un dato", () => {
    expect(() => add(money(CLP, 100n), money(USD, 100n))).toThrow(MoneyError);
    expect(() => compare(money(CLP, 1n), money(USD, 1n))).toThrow(/CLP con USD/);
  });

  it("[H19] el rango se vigila con enteros, y desbordarlo revienta", () => {
    expect(() => money(CLP, MONEY_MAX_MINOR + 1n)).toThrow(/rango/);
    expect(money(CLP, MONEY_MAX_MINOR).minor).toBe(MONEY_MAX_MINOR);
  });
});

describe("mulDiv redondea a la par (half-even) y no siempre para arriba", () => {
  it("las mitades exactas caen al par: 2,5 → 2 y 3,5 → 4", () => {
    expect(mulDiv(money(CLP, 5n), 1n, 2n).minor).toBe(2n);
    expect(mulDiv(money(CLP, 7n), 1n, 2n).minor).toBe(4n);
    // Un half-up daría 3 y 4: el sesgo se acumularía siempre hacia arriba.
  });

  it("es simétrico bajo el cero", () => {
    expect(mulDiv(money(CLP, -5n), 1n, 2n).minor).toBe(-2n);
    expect(mulDiv(money(CLP, -7n), 1n, 2n).minor).toBe(-4n);
  });

  it("los tercios no se redondean para arriba por costumbre", () => {
    expect(mulDiv(money(CLP, 10n), 1n, 3n).minor).toBe(3n);
    expect(mulDiv(money(CLP, 10n), 2n, 3n).minor).toBe(7n);
  });

  it("dividir por cero revienta", () => {
    expect(() => mulDiv(money(CLP, 10n), 1n, 0n)).toThrow(/cero/);
  });
});

describe("[H13] apportion conserva: la suma de los hijos ES el valor del padre", () => {
  it("$17.000 en tres partes iguales dan exactamente $17.000", () => {
    const partes = apportionOrThrow(money(CLP, 17000n), [1n, 1n, 1n]);
    expect(partes.map((p) => p.minor)).toEqual([5667n, 5667n, 5666n]);
    expect(suma(partes)).toBe(17000n);
    // Truncar cada hijo por separado (5666 × 3) daría 16.998: los $2 que nadie
    // puede explicar y que este sprint existe para no perder.
  });

  it("conserva con pesos desparejos y con totales grandes", () => {
    const casos: Array<{ total: bigint; pesos: bigint[] }> = [
      { total: 25000n, pesos: [2000n, 3000n] },
      { total: 1n, pesos: [1n, 1n, 1n] },
      { total: 999999n, pesos: [7n, 11n, 13n, 17n] },
      { total: 100n, pesos: [1n] },
      { total: 0n, pesos: [5n, 5n] },
    ];
    for (const caso of casos) {
      const partes = apportionOrThrow(money(CLP, caso.total), caso.pesos);
      expect(partes).toHaveLength(caso.pesos.length);
      expect(suma(partes)).toBe(caso.total);
    }
  });

  it("es determinista: el desempate va por índice ascendente, siempre igual", () => {
    const a = apportionOrThrow(money(CLP, 100n), [1n, 1n, 1n]).map((p) => p.minor);
    const b = apportionOrThrow(money(CLP, 100n), [1n, 1n, 1n]).map((p) => p.minor);
    expect(a).toEqual([34n, 33n, 33n]);
    expect(b).toEqual(a);
  });
});

describe("[H15] apportion con los casos que de verdad llegan del supermercado", () => {
  it("un total NEGATIVO (descuento de orden) reparte y cuadra", () => {
    const partes = apportionOrThrow(money(CLP, -100n), [1n, 1n, 1n]);
    expect(partes.map((p) => p.minor)).toEqual([-34n, -33n, -33n]);
    expect(suma(partes)).toBe(-100n);
    // La versión ingenua —truncar hacia cero y "sumar de a 1 al de mayor
    // resto"— daba −99 y reventaba la postcondición: con eso NO se podía
    // confirmar ninguna boleta con descuento de orden.
  });

  it("negativo es exactamente el espejo del positivo", () => {
    const pesos = [7n, 11n, 13n];
    const arriba = apportionOrThrow(money(CLP, 1234n), pesos).map((p) => p.minor);
    const abajo = apportionOrThrow(money(CLP, -1234n), pesos).map((p) => p.minor);
    expect(abajo).toEqual(arriba.map((m) => -m));
  });

  it("una línea de promo en $0 recibe EXACTAMENTE $0", () => {
    const partes = apportionOrThrow(money(CLP, 5n), [1n, 0n, 1n]);
    expect(partes.map((p) => p.minor)).toEqual([3n, 0n, 2n]);
    expect(suma(partes)).toBe(5n);
  });

  it("todos los pesos en cero: se BLOQUEA, no se divide por cero", () => {
    const resultado = apportion(money(CLP, 2500n), [0n, 0n]);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("debía bloquearse");
    expect(resultado.reason).toBe("PESOS_SUMAN_CERO");
    expect(resultado.unknownReason).toBe("POLICY_NOT_APPLICABLE");
  });

  it("un peso negativo (descuento mayor que la línea) se BLOQUEA", () => {
    const resultado = apportion(money(CLP, 1000n), [500n, -100n]);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("debía bloquearse");
    expect(resultado.reason).toBe("PESO_NEGATIVO");
  });

  it("sin partes se bloquea, y el bloqueo NO es una excepción", () => {
    const resultado = apportion(money(CLP, 1000n), []);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("debía bloquearse");
    expect(resultado.reason).toBe("SIN_PARTES");
    // Reventar acá botaría la confirmación completa de una boleta que el
    // supermercado imprimió así. El que llama decide.
  });

  it("un solo peso se lleva todo", () => {
    expect(apportionOrThrow(money(CLP, 7n), [3n]).map((p) => p.minor)).toEqual([7n]);
  });
});

describe("desconocido no es cero, y cero no es desconocido", () => {
  it("«me lo regalaron» es un cero CONOCIDO", () => {
    const regalo = free(CLP);
    expect(regalo.known).toBe(true);
    expect(isFree(regalo)).toBe(true);
    if (!regalo.known) throw new Error("el regalo se conoce");
    expect(regalo.amount.minor).toBe(0n);
  });

  it("«no sé cuánto costó» NO es cero y no se puede confundir con uno", () => {
    const sinPrecio: MoneyOrUnknown = unknown("NO_PRICE_RECORDED");
    expect(sinPrecio.known).toBe(false);
    expect(isFree(sinPrecio)).toBe(false);
    // El desconocido viaja SIEMPRE con su motivo: no hay rama sin explicación.
    if (sinPrecio.known) throw new Error("no debía conocerse");
    expect(UNKNOWN_REASONS).toContain(sinPrecio.reason);
  });

  it("la precedencia de motivos cubre el tipo entero", () => {
    expect([...UNKNOWN_REASON_PRECEDENCE].sort()).toEqual([...UNKNOWN_REASONS].sort());
  });
});

describe("sumStrict: un solo desconocido envenena la suma", () => {
  it("nueve precios y un hueco NO dan el total de los nueve", () => {
    const xs: MoneyOrUnknown[] = [
      known(money(CLP, 12000n)),
      known(money(CLP, 3000n)),
      unknown("LOT_VALUE_UNKNOWN"),
    ];
    const total = sumStrict(xs, CLP);
    expect(total.known).toBe(false);
    if (total.known) throw new Error("no podía conocerse");
    expect(total.reason).toBe("LOT_VALUE_UNKNOWN");
  });

  it("todo conocido suma exacto", () => {
    const total = sumStrict([known(money(CLP, 12000n)), known(money(CLP, 3000n))], CLP);
    expect(total.known).toBe(true);
    if (!total.known) throw new Error("debía conocerse");
    expect(total.amount.minor).toBe(15000n);
  });

  it("el motivo NO depende del orden en que la base devolvió las filas", () => {
    const a = sumStrict([unknown("POLICY_NOT_APPLICABLE"), unknown("NO_PRICE_RECORDED")], CLP);
    const b = sumStrict([unknown("NO_PRICE_RECORDED"), unknown("POLICY_NOT_APPLICABLE")], CLP);
    expect(a).toEqual(b);
    if (a.known) throw new Error("no podía conocerse");
    expect(a.reason).toBe("NO_PRICE_RECORDED");
  });

  it("la lista vacía es cero conocido: la suma de nada es cero", () => {
    const total = sumStrict([], CLP);
    expect(total.known).toBe(true);
    if (!total.known) throw new Error("debía conocerse");
    expect(total.amount).toEqual(zero(CLP));
  });
});

describe("sumPartial: el subtotal no se puede pintar como total", () => {
  const entradas: MoneyEntry[] = [
    { id: "l1", label: "Pollo entero", value: known(money(CLP, 12000n)) },
    { id: "l2", label: "Arroz 1 kg", value: known(money(CLP, 1900n)) },
    { id: "l3", label: "Palta kilo", value: unknown("NO_PRICE_RECORDED") },
  ];

  it("se lleva la identidad de lo que falta, no solo el conteo", () => {
    const { subtotal, missing } = sumPartial(entradas, CLP);
    expect(subtotal.minorAtLeast).toBe(13900n);
    expect(subtotal.knownCount).toBe(2);
    expect(missing).toEqual([{ id: "l3", label: "Palta kilo", reason: "NO_PRICE_RECORDED" }]);
    // "3 productos sin precio" sin nombrarlos es inarreglable.
  });

  it("el subtotal NO es un Money: para sacar el monto hay que traer los faltantes", () => {
    const { subtotal, missing } = sumPartial(entradas, CLP);
    expect(isComplete(subtotal)).toBe(false);
    expect(atLeastAmount(subtotal, missing).minor).toBe(13900n);
    // Mostrar el número grande sin la lista de faltantes revienta: es la
    // diferencia entre "$13.900" y "al menos $13.900, falta la palta".
    expect(() => atLeastAmount(subtotal, [])).toThrow(/faltantes/);
  });

  it("«todo conocido y da $0» no se confunde con «no había nada»", () => {
    const regalado = sumPartial([{ id: "r", label: "Zapallo del vecino", value: free(CLP) }], CLP);
    const vacio = sumPartial([], CLP);
    expect(regalado.subtotal.minorAtLeast).toBe(0n);
    expect(vacio.subtotal.minorAtLeast).toBe(0n);
    expect(regalado.subtotal.knownCount).toBe(1);
    expect(vacio.subtotal.knownCount).toBe(0);
    expect(regalado.subtotal).not.toEqual(vacio.subtotal);
  });

  it("cerrar una suma parcial incompleta da DESCONOCIDO, no el pedazo conocido", () => {
    const cerrada = closePartial(sumPartial(entradas, CLP));
    expect(cerrada.known).toBe(false);
    if (cerrada.known) throw new Error("no podía conocerse");
    expect(cerrada.reason).toBe("NO_PRICE_RECORDED");
  });

  it("una entrada en otra moneda revienta con el nombre de la entrada", () => {
    expect(() =>
      sumPartial([{ id: "x", label: "Aceite importado", value: known(money(USD, 500n)) }], CLP),
    ).toThrow(/Aceite importado/);
  });
});

describe("[H20] el borde: texto crudo a bigint sin inventar plata", () => {
  it("la celda vacía NO es cero pesos", () => {
    // BigInt("") devuelve 0n y BigInt(" ") también: sin esta guarda, un hueco
    // de PostgREST entra al panel como un monto de cero.
    for (const basura of ["", " ", "\t"]) {
      const r = parseMinor(basura);
      expect(r.ok).toBe(false);
    }
  });

  it("un decimal se RECHAZA, no se trunca", () => {
    const texto = parseMinor("12.5");
    expect(texto.ok).toBe(false);
    const numero = parseMinor(1234.5);
    expect(numero.ok).toBe(false);
    if (numero.ok) throw new Error("no debía aceptarse");
    expect(numero.problema).toMatch(/no es entero/);
    // Math.trunc acá bajaría 1234,5 a 1234 y perdería plata en silencio.
  });

  it("la notación científica y los tipos raros se rechazan", () => {
    expect(parseMinor("1e3").ok).toBe(false);
    expect(parseMinor(null).ok).toBe(false);
    expect(parseMinor(undefined).ok).toBe(false);
    expect(parseMinor({}).ok).toBe(false);
    expect(parseMinor(2 ** 53).ok).toBe(false);
  });

  it("un entero de verdad pasa, en cualquiera de las tres formas", () => {
    expect(parseMinor("25000")).toEqual({ ok: true, minor: 25000n });
    expect(parseMinor("-1700")).toEqual({ ok: true, minor: -1700n });
    expect(parseMinor("0")).toEqual({ ok: true, minor: 0n });
    expect(parseMinor(4500)).toEqual({ ok: true, minor: 4500n });
    expect(parseMinor(17003n)).toEqual({ ok: true, minor: 17003n });
  });
});
