import { describe, expect, it } from "vitest";
import {
  DEFAULT_BBQ_QUANTITY_POLICY,
  estimateBbqQuantity,
} from "@/domain/events/bbq/quantity";
import type {
  BbqCutDefinitionInput,
  BbqParticipantInput,
  BbqQuantityInput,
  BbqQuantityResult,
} from "@/domain/events/bbq/types";
import { salidaEstimacionSchema } from "./contrato-estimacion";
import { anosCumplidos, grupoEdadDeMiembro } from "./edades";

/**
 * El contrato de la revisión congelada es una frontera: lo que llega en un
 * `jsonb` se valida, no se castea. Estos tests son los que se rompen cuando la
 * salida guardada deja de calzar con lo que la pantalla sabe leer — que es
 * exactamente lo que tienen que hacer, antes de que alguien vea kilos que ya no
 * significan lo mismo.
 */

/** Una salida del motor completa y coherente, para deformarla en cada prueba. */
function salida(): BbqQuantityResult {
  return salidaEstimacionSchema.parse({
    engineVersion: "bbq-quantity/1.0.0",
    policyVersion: "bbq-quantity-policy/1.0.0",
    policySource: "convención parrillera chilena",
    inputSignature: "a1b2c3d4",
    headcount: {
      participants: 13,
      counted: 12,
      adults: 10,
      children: 3,
      unknownAge: 0,
      householdMembers: 4,
      guests: 9,
      byAttendance: {
        INVITED: 2,
        CONFIRMED: 10,
        MAYBE: 1,
        DECLINED: 0,
        ATTENDED: 0,
        NO_SHOW: 0,
      },
      effective: { min: 10, base: 11.5, max: 13 },
    },
    demand: {
      participants: { min: 3000, base: 3700, max: 4600 },
      desiredLeftoverGrams: 500,
      safetyBuffer: { min: 300, base: 370, max: 460 },
      total: { min: 3800, base: 4570, max: 5560 },
    },
    totalServableDemand: { min: 3800, base: 4570, max: 5560 },
    byCut: [
      {
        itemId: "33333333-3333-4333-8333-333333333333",
        cutRef: "lomo-vetado",
        displayName: "Lomo vetado",
        category: "VACUNO",
        servable: { min: 1900, base: 2285, max: 2780 },
        cooked: { known: true, value: { min: 2000, base: 2400, max: 2900 } },
        rawEdible: { known: true, value: { min: 2600, base: 3100, max: 3700 } },
        rawPurchase: { known: true, value: { min: 2700, base: 3200, max: 3800 } },
        inventoryToUse: { known: true, grams: 0, frozenGrams: 0, lotIds: [] },
        purchaseRequired: { known: true, value: { min: 2700, base: 3200, max: 3800 } },
        batches: { known: true, kind: "EXACT", batches: 2 },
        chain: [
          {
            stage: "EDIBLE_RAW_TO_COOKED",
            factor: 0.75,
            source: "INGREDIENT_YIELD",
            observations: 0,
            conflict: false,
          },
        ],
        flags: [],
      },
    ],
    uncoveredServableDemand: null,
    expectedLeftovers: {
      range: { min: 200, base: 600, max: 1100 },
      basis: "BEFORE_COMMERCIAL_ROUNDING",
    },
    knownPurchaseSubtotal: { min: 2700, base: 3200, max: 3800 },
    totalPurchaseRequired: { known: true, value: { min: 2700, base: 3200, max: 3800 } },
    // Razones entre 0 y 1, que es como las emite el motor: 9 de 12 activos con
    // apetito declarado es 0,75 — no "9".
    coverage: {
      appetiteKnown: 0.75,
      ageKnown: 1,
      dietaryInfoKnown: 0.75,
      attendanceConfirmed: 0.83,
      cutsWithFullChain: 1,
    },
    confidence: "MEDIUM",
    reasons: [{ code: "DIETARY_INFO_MISSING", params: { count: 4 }, text: "4 sin información." }],
    reviewRequired: [],
  });
}

/** El primer corte, con el vacío declarado. */
function primerCorte(s: BbqQuantityResult) {
  const linea = s.byCut[0];
  if (linea === undefined) throw new Error("la salida de prueba tiene que traer un corte");
  return linea;
}

describe("los rangos de la revisión", () => {
  it("una salida completa pasa", () => {
    expect(salida().engineVersion).toBe("bbq-quantity/1.0.0");
  });

  it("rechaza un rango desordenado en vez de reordenarlo en silencio", () => {
    const rota = { ...salida(), totalServableDemand: { min: 5000, base: 2000, max: 3000 } };
    expect(salidaEstimacionSchema.safeParse(rota).success).toBe(false);
  });

  it("rechaza cantidades negativas", () => {
    const rota = { ...salida(), totalServableDemand: { min: -1, base: 2, max: 3 } };
    expect(salidaEstimacionSchema.safeParse(rota).success).toBe(false);
  });

  it("una demanda total que llega como número seco se rechaza", () => {
    // Un escalar en vez de un rango es la falsa precisión que este sprint
    // prohíbe: no entra ni siquiera guardado.
    const rota = { ...salida(), totalServableDemand: 3700 };
    expect(salidaEstimacionSchema.safeParse(rota).success).toBe(false);
  });
});

describe("los desconocidos se guardan CON su motivo", () => {
  it("un corte sin cadena de rendimientos conserva el código que lo explica", () => {
    const base = salida();
    const conDesconocido = {
      ...base,
      byCut: [
        {
          ...primerCorte(base),
          rawPurchase: { known: false, reason: "YIELD_UNKNOWN" },
          purchaseRequired: { known: false, reason: "YIELD_UNKNOWN" },
        },
      ],
      totalPurchaseRequired: { known: false, reason: "PURCHASE_UNKNOWN_TOTAL" },
    };
    const linea = primerCorte(salidaEstimacionSchema.parse(conDesconocido));
    expect(linea.purchaseRequired.known).toBe(false);
    if (!linea.purchaseRequired.known) {
      expect(linea.purchaseRequired.reason).toBe("YIELD_UNKNOWN");
    }
  });

  it("un desconocido sin motivo no se puede guardar", () => {
    const sinMotivo = { ...salida(), totalPurchaseRequired: { known: false } };
    expect(salidaEstimacionSchema.safeParse(sinMotivo).success).toBe(false);
  });

  it("un motivo que no es un código del motor tampoco pasa", () => {
    const inventado = { ...salida(), totalPurchaseRequired: { known: false, reason: "PORQUE_SI" } };
    expect(salidaEstimacionSchema.safeParse(inventado).success).toBe(false);
  });
});

describe("las tandas", () => {
  it("pueden ser desconocidas, pero nunca cero tandas", () => {
    const base = salida();
    const sinCapacidad = {
      ...base,
      byCut: [
        { ...primerCorte(base), batches: { known: false, reason: "EQUIPMENT_CAPACITY_UNKNOWN" } },
      ],
    };
    expect(salidaEstimacionSchema.safeParse(sinCapacidad).success).toBe(true);

    const cero = {
      ...base,
      byCut: [{ ...primerCorte(base), batches: { known: true, kind: "EXACT", batches: 0 } }],
    };
    expect(salidaEstimacionSchema.safeParse(cero).success).toBe(false);
  });
});

describe("la revisión no se puede guardar sin decir quién la calculó", () => {
  it("sin versión del motor no pasa: una estimación sin autor no se puede explicar", () => {
    expect(salidaEstimacionSchema.safeParse({ ...salida(), engineVersion: "" }).success).toBe(false);
  });

  it("sin firma tampoco: es lo que decide si hay revisión nueva", () => {
    expect(salidaEstimacionSchema.safeParse({ ...salida(), inputSignature: "" }).success).toBe(
      false,
    );
  });
});

// ===========================================================================
// EL CONTRATO CONTRA EL MOTOR DE VERDAD
// ===========================================================================

/**
 * El asado del sprint, con los huecos que un asado real tiene: gente que no
 * declaró apetito, gente que dijo "tal vez", gente de la que no sabemos si come
 * de todo. Es EXACTAMENTE el caso que la calculadora existe para resolver.
 */
const ASIENTO: BbqCutDefinitionInput = {
  cutRef: "asiento",
  boneIn: false,
  rawPurchaseToEdibleRaw: 0.95,
  cookedToServable: 0.98,
  edibleRawToCooked: null,
  source: "seed curado 0041",
  confidence: "MEDIUM",
};

/**
 * Los cuatro campos que estos casos mueven, escritos uno por uno en vez de un
 * `Partial<BbqParticipantInput>`: un Partial permite que un campo obligatorio
 * llegue como `undefined`, y "no lo dije" no puede entrar donde el motor
 * distingue `null` (no sabemos) de `[]` (declaró que no tiene).
 */
interface Retoques {
  ageGroup?: BbqParticipantInput["ageGroup"];
  appetite?: BbqParticipantInput["appetite"];
  attendance?: BbqParticipantInput["attendance"];
  dietaryFlags?: BbqParticipantInput["dietaryFlags"];
}

function invitado(i: number, over: Retoques = {}): BbqParticipantInput {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    kind: "GUEST",
    ageGroup: over.ageGroup ?? "ADULT",
    appetite: over.appetite ?? "NORMAL",
    attendance: over.attendance ?? "CONFIRMED",
    dietaryFlags: over.dietaryFlags === undefined ? [] : over.dietaryFlags,
    // Son invitados: no tienen ficha en la casa, así que no hay bloqueos
    // registrados que consultar. `null` es ese hecho, no un "no tiene nada".
    recordedBlocks: null,
    approxWeightKg: null,
  };
}

function asadoConHuecos(): BbqQuantityInput {
  return {
    eventDate: "2026-09-05",
    participants: [
      ...Array.from({ length: 8 }, (_, i) => invitado(i)),
      // Tres sin apetito declarado: el motor emite appetiteKnown = 8/11 = 0,73.
      ...Array.from({ length: 3 }, (_, i) => invitado(10 + i, { appetite: "UNKNOWN" })),
      // Tres "tal vez": attendanceConfirmed deja de ser 1.
      ...Array.from({ length: 3 }, (_, i) => invitado(20 + i, { attendance: "MAYBE" })),
      // Cuatro sin información dietaria: `null` NO es "no tiene restricciones".
      ...Array.from({ length: 4 }, (_, i) => invitado(30 + i, { dietaryFlags: null })),
      // Y uno del que no sabemos la edad.
      invitado(40, { ageGroup: "UNKNOWN" }),
    ],
    menu: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "MEAT",
        category: "VACUNO",
        cutRef: "asiento",
        displayName: "Asiento",
        distributionPct: null,
        cookingMethod: "PARRILLA",
        equipmentId: "parrilla",
      },
    ],
    sidesLevel: "MEDIUM",
    mealContext: "FIRST_MAJOR_MEAL",
    durationHours: 3,
    desiredLeftover: { kind: "NONE" },
    safetyBufferPct: 10,
    cutDefinitions: [ASIENTO],
    ingredientYields: [
      { cutRef: "asiento", cookingMethod: "PARRILLA", factor: 0.72, source: "0009" },
    ],
    observedYields: [],
    inventory: [],
    equipment: [{ id: "parrilla", kind: "GRILL", maxBatch: 2500, maxBatchUnit: "G" }],
    acceptedPlanRawEdibleG: null,
    policy: DEFAULT_BBQ_QUANTITY_POLICY,
  };
}

describe("el contrato congelado acepta lo que el motor DE VERDAD produce", () => {
  /**
   * Este es el test que faltaba y por el que 156 tests verdes convivían con un
   * botón "calcular" que no guardaba nada: el fixture de arriba lo escribimos
   * nosotros, así que sólo probaba que el esquema se acepta a sí mismo. Acá la
   * salida la fabrica `estimateBbqQuantity` y recién después pasa por el
   * esquema. Si el motor y el contrato divergen —como divergieron en `coverage`,
   * razones fraccionarias contra `.int()`— esto se cae.
   */
  it("una estimación con datos parciales entra al esquema tal cual sale del motor", () => {
    const real = estimateBbqQuantity(asadoConHuecos());
    const parseo = salidaEstimacionSchema.safeParse(real);

    const detalle = parseo.success
      ? ""
      : parseo.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
    expect(parseo.success, `el motor produce algo que la revisión no puede guardar → ${detalle}`).toBe(
      true,
    );
  });

  it("el asado completo, sin ningún hueco, también entra", () => {
    // El otro extremo: si el esquema sólo tolerara el caso perfecto sería la
    // misma trampa al revés.
    const real = estimateBbqQuantity({
      ...asadoConHuecos(),
      participants: Array.from({ length: 11 }, (_, i) => invitado(i)),
    });
    expect(salidaEstimacionSchema.safeParse(real).success).toBe(true);
  });

  it("y una que el motor no pudo cerrar —corte sin rendimiento— también", () => {
    // La salida con desconocidos declarados es una salida legítima y se guarda:
    // no poder estimar es un hecho que hay que conservar, no un error.
    const real = estimateBbqQuantity({
      ...asadoConHuecos(),
      cutDefinitions: [],
      ingredientYields: [],
    });
    expect(real.totalPurchaseRequired.known).toBe(false);
    expect(salidaEstimacionSchema.safeParse(real).success).toBe(true);
  });

  it("el ida y vuelta por el jsonb no cambia un solo número", () => {
    // La revisión viaja serializada: lo que se guarda y lo que se vuelve a leer
    // tienen que ser el mismo objeto, o la pantalla muestra otra cosa que la
    // que se calculó.
    const real = estimateBbqQuantity(asadoConHuecos());
    const ida = salidaEstimacionSchema.parse(JSON.parse(JSON.stringify(real)));
    expect(ida).toEqual(real);
  });
});

describe("la cobertura de datos llega a la pantalla", () => {
  it("es una RAZÓN entre 0 y 1, no un conteo de personas", () => {
    const real = estimateBbqQuantity(asadoConHuecos());
    // 19 participantes, 19 activos (nadie DECLINED): 4 sin información dietaria.
    expect(real.headcount.counted).toBe(19);
    expect(real.coverage.dietaryInfoKnown).toBeCloseTo((19 - 4) / 19, 2);
    // La prueba de que es razón y no conteo: con 19 personas un conteo daría 15.
    expect(real.coverage.dietaryInfoKnown).toBeLessThanOrEqual(1);
    // Y de acá sale el "hay N sin información" de la pantalla.
    expect(Math.round((1 - real.coverage.dietaryInfoKnown) * real.headcount.counted)).toBe(4);
  });

  it("las cinco coberturas viven en la misma escala que los umbrales de confianza", () => {
    const real = estimateBbqQuantity(asadoConHuecos());
    for (const [nombre, valor] of Object.entries(real.coverage)) {
      expect(valor, `${nombre} fuera de escala`).toBeGreaterThanOrEqual(0);
      expect(valor, `${nombre} fuera de escala`).toBeLessThanOrEqual(1);
    }
    // Los umbrales de la política son fracciones: 0,8 y 0,5. Contra un conteo no
    // significarían nada.
    expect(DEFAULT_BBQ_QUANTITY_POLICY.confidence.minDietaryCoverageHigh).toBeLessThanOrEqual(1);
    expect(DEFAULT_BBQ_QUANTITY_POLICY.confidence.minDietaryCoverageMedium).toBeLessThanOrEqual(1);
  });

  it("un conteo en vez de una razón se rechaza al guardar", () => {
    // La forma vieja del fixture (9 personas con apetito declarado) ya no entra:
    // si el motor volviera a emitir conteos, la revisión no se guardaría en
    // silencio con la semántica equivocada.
    const conConteo = { ...salida(), coverage: { ...salida().coverage, dietaryInfoKnown: 9 } };
    expect(salidaEstimacionSchema.safeParse(conConteo).success).toBe(false);
  });
});

describe("el grupo de edad de un integrante del hogar", () => {
  it("sin fecha de nacimiento queda UNKNOWN, jamás adulto", () => {
    expect(grupoEdadDeMiembro(null, "2026-09-05")).toBe("UNKNOWN");
  });

  it("usa la fecha DEL EVENTO: quien cumple entre hoy y el asado ya los cumplió", () => {
    // Cumple 18 el 2026-09-04; el asado es el 05.
    expect(grupoEdadDeMiembro("2008-09-04", "2026-09-03")).toBe("TEEN");
    expect(grupoEdadDeMiembro("2008-09-04", "2026-09-05")).toBe("ADULT");
  });

  it("EL DÍA DEL CUMPLEAÑOS ya cuenta: los años se cumplen ese día, no al siguiente", () => {
    // Acá vive el off-by-one. Probar la víspera y el día después deja el día
    // mismo sin mirar, que es justo donde `h.dia < n.dia` se puede convertir en
    // `h.dia <= n.dia` sin que nada se queje: un chico que cumple 18 el sábado
    // del asado quedaría TEEN y comería 0,9 de porción.
    expect(anosCumplidos("2008-09-04", "2026-09-04")).toBe(18);
    expect(grupoEdadDeMiembro("2008-09-04", "2026-09-04")).toBe("ADULT");
    // La víspera todavía no: 17 años cumplidos.
    expect(anosCumplidos("2008-09-04", "2026-09-03")).toBe(17);

    // Los otros tres cortes, el día exacto en que se cruzan.
    expect(grupoEdadDeMiembro("2021-09-04", "2026-09-04")).toBe("CHILD"); // cumple 5
    expect(grupoEdadDeMiembro("2013-09-04", "2026-09-04")).toBe("TEEN"); // cumple 13
    expect(grupoEdadDeMiembro("1961-09-04", "2026-09-04")).toBe("OLDER_ADULT"); // cumple 65
    // Y la víspera de cada uno sigue en el tramo anterior.
    expect(grupoEdadDeMiembro("2021-09-04", "2026-09-03")).toBe("CHILD_SMALL");
    expect(grupoEdadDeMiembro("2013-09-04", "2026-09-03")).toBe("CHILD");
    expect(grupoEdadDeMiembro("1961-09-04", "2026-09-03")).toBe("ADULT");
  });

  it("el cambio de mes no se adelanta: el 1 de octubre no cumple quien nace el 4", () => {
    // El otro lado del mismo `if`: la comparación de mes tiene que mandar sobre
    // la de día, o alguien nacido el 4 de octubre cumpliría el 1.
    expect(anosCumplidos("2008-10-04", "2026-10-01")).toBe(17);
    expect(anosCumplidos("2008-10-04", "2026-11-01")).toBe(18);
  });

  it("una fecha de nacimiento FUTURA queda UNKNOWN, no niño chico", () => {
    // Un dedazo en el año (2036 por 2016) daría años negativos. Negativo no es
    // "recién nacido": es un dato que no se puede usar, y el motor tiene que
    // enterarse de que no lo sabe.
    expect(anosCumplidos("2036-01-01", "2026-09-05")).toBe(-10);
    expect(grupoEdadDeMiembro("2036-01-01", "2026-09-05")).toBe("UNKNOWN");
    // Y el borde exacto: nace mañana.
    expect(grupoEdadDeMiembro("2026-09-06", "2026-09-05")).toBe("UNKNOWN");
    // Nace hoy: cero años, que sí es un dato.
    expect(grupoEdadDeMiembro("2026-09-05", "2026-09-05")).toBe("CHILD_SMALL");
  });

  it("clasifica los tramos infantiles por separado", () => {
    expect(grupoEdadDeMiembro("2023-01-01", "2026-09-05")).toBe("CHILD_SMALL");
    expect(grupoEdadDeMiembro("2018-01-01", "2026-09-05")).toBe("CHILD");
    expect(grupoEdadDeMiembro("2011-01-01", "2026-09-05")).toBe("TEEN");
    expect(grupoEdadDeMiembro("1950-01-01", "2026-09-05")).toBe("OLDER_ADULT");
  });

  it("una fecha inválida no se convierte en adulto", () => {
    expect(grupoEdadDeMiembro("no-es-fecha", "2026-09-05")).toBe("UNKNOWN");
  });
});
