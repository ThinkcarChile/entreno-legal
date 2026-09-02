import { describe, expect, it } from "vitest";
import {
  BBQ_QUANTITY_VERSION,
  DEFAULT_BBQ_QUANTITY_POLICY,
  estimateBbqQuantity,
  resolveYieldChain,
} from "./quantity";
import { YIELD_STAGE_OWNER } from "./types";
import type {
  BbqCutDefinitionInput,
  BbqDietaryFlag,
  BbqEquipmentInput,
  BbqInventoryLotInput,
  BbqMenuItemInput,
  BbqParticipantInput,
  BbqQuantityInput,
  BbqQuantityResult,
  Range,
  RangeOrUnknown,
} from "./types";

/**
 * El motor no tiene reloj: la fecha entra por acá y jamás cambia sola. Sábado.
 */
const FECHA = "2026-09-05";

/** Cadena completa de un corte sin hueso: limpieza 0,95 · servible 0,98. */
const ASIENTO: BbqCutDefinitionInput = {
  cutRef: "asiento",
  boneIn: false,
  rawPurchaseToEdibleRaw: 0.95,
  cookedToServable: 0.98,
  edibleRawToCooked: null,
  source: "seed curado 0041",
  confidence: "MEDIUM",
};

/** Costillar con hueso: la mitad larga del peso comprado no llega al plato. */
const COSTILLAR: BbqCutDefinitionInput = {
  cutRef: "costillar",
  boneIn: true,
  rawPurchaseToEdibleRaw: 0.65,
  cookedToServable: 0.98,
  edibleRawToCooked: null,
  source: "seed curado 0041",
  confidence: "MEDIUM",
};

const PARRILLA: BbqEquipmentInput = {
  id: "parrilla",
  kind: "GRILL",
  maxBatch: 2500,
  maxBatchUnit: "G",
};

function persona(over: Partial<BbqParticipantInput> & { id: string }): BbqParticipantInput {
  return {
    kind: "GUEST",
    ageGroup: "ADULT",
    appetite: "NORMAL",
    attendance: "CONFIRMED",
    dietaryFlags: [],
    // Por omisión un INVITADO: no tiene ficha en la casa, así que no hay nada
    // registrado que mirar. Los tests de integrante la pasan explícita.
    recordedBlocks: null,
    approxWeightKg: null,
    ...over,
  };
}

function gente(cantidad: number, over: Partial<BbqParticipantInput> = {}): BbqParticipantInput[] {
  return Array.from({ length: cantidad }, (_, i) => persona({ id: `p${i}`, ...over }));
}

function carne(over: Partial<BbqMenuItemInput> & { id: string }): BbqMenuItemInput {
  return {
    kind: "MEAT",
    category: "VACUNO",
    cutRef: "asiento",
    displayName: "Asiento",
    distributionPct: null,
    cookingMethod: "PARRILLA",
    equipmentId: "parrilla",
    ...over,
  };
}

function entrada(over: Partial<BbqQuantityInput> = {}): BbqQuantityInput {
  return {
    eventDate: FECHA,
    participants: gente(11),
    menu: [carne({ id: "m1" })],
    sidesLevel: "MEDIUM",
    mealContext: "FIRST_MAJOR_MEAL",
    durationHours: 3,
    desiredLeftover: { kind: "NONE" },
    safetyBufferPct: 0,
    cutDefinitions: [ASIENTO, COSTILLAR],
    ingredientYields: [
      { cutRef: "asiento", cookingMethod: "PARRILLA", factor: 0.72, source: "0009" },
      { cutRef: "costillar", cookingMethod: "PARRILLA", factor: 0.7, source: "0009" },
    ],
    observedYields: [],
    inventory: [],
    equipment: [PARRILLA],
    acceptedPlanRawEdibleG: null,
    policy: DEFAULT_BBQ_QUANTITY_POLICY,
    ...over,
  };
}

function ancho(r: Range): number {
  return r.max - r.min;
}

function anchoRelativo(r: Range): number {
  return (r.max - r.min) / r.base;
}

function codigos(resultado: BbqQuantityResult): string[] {
  return resultado.reasons.map((r) => r.code);
}

function valor(e: RangeOrUnknown): Range {
  if (!e.known) throw new Error(`se esperaba un valor conocido, llegó ${e.reason}`);
  return e.value;
}

describe("bbq-quantity/1.0.0 — demanda del grupo", () => {
  it("demo A: 10 adultos + 3 niños entrega rango, no número seco", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        participants: [
          ...gente(10).map((p, i) => ({ ...p, id: `a${i}` })),
          ...gente(3, { ageGroup: "CHILD" }).map((p, i) => ({ ...p, id: `n${i}` })),
        ],
        safetyBufferPct: 10,
      }),
    );

    expect(resultado.engineVersion).toBe(BBQ_QUANTITY_VERSION);
    expect(resultado.headcount.adults).toBe(10);
    expect(resultado.headcount.children).toBe(3);
    // 10 adultos + 3 niños al 0,5 = 11,5 porciones adultas × 320 g × 0,9 (sides).
    expect(resultado.demand.participants.base).toBe(Math.round(11.5 * 320 * 0.9));
    // Rango de verdad: los extremos no pueden ser el mismo número que la base.
    expect(resultado.demand.participants.min).toBeLessThan(resultado.demand.participants.base);
    expect(resultado.demand.participants.max).toBeGreaterThan(resultado.demand.participants.base);
    // El margen de seguridad es una LÍNEA APARTE del sobrante pedido (§25-26).
    expect(resultado.demand.desiredLeftoverGrams).toBe(0);
    expect(resultado.demand.safetyBuffer.base).toBe(
      Math.round(resultado.demand.participants.base * 0.1),
    );
    expect(resultado.totalPurchaseRequired.known).toBe(true);
  });

  it("la política infantil es explícita y versionada: cambiarla cambia el número", () => {
    const participants = gente(4, { ageGroup: "CHILD" });
    const conDefault = estimateBbqQuantity(entrada({ participants }));
    const conOtraPolitica = estimateBbqQuantity(
      entrada({
        participants,
        policy: {
          ...DEFAULT_BBQ_QUANTITY_POLICY,
          version: "bbq-quantity-policy/test",
          ageFactor: {
            ...DEFAULT_BBQ_QUANTITY_POLICY.ageFactor,
            CHILD: { min: 0.75, base: 0.75, max: 0.75 },
          },
        },
      }),
    );

    expect(DEFAULT_BBQ_QUANTITY_POLICY.ageFactor.CHILD_SMALL.base).not.toBe(
      DEFAULT_BBQ_QUANTITY_POLICY.ageFactor.CHILD.base,
    );
    expect(conOtraPolitica.demand.participants.base).toBeGreaterThan(
      conDefault.demand.participants.base,
    );
    expect(conOtraPolitica.policyVersion).toBe("bbq-quantity-policy/test");
  });

  it("demo F: 3 apetitos HIGH mueven el número moderadamente y se explica", () => {
    const base = estimateBbqQuantity(entrada({ participants: gente(11) }));
    const conHigh = estimateBbqQuantity(
      entrada({
        participants: [
          ...gente(8).map((p, i) => ({ ...p, id: `n${i}` })),
          ...gente(3, { appetite: "HIGH" }).map((p, i) => ({ ...p, id: `h${i}` })),
        ],
      }),
    );
    const razon = base.demand.participants.base;
    const subida = conHigh.demand.participants.base / razon;
    expect(subida).toBeGreaterThan(1);
    expect(subida).toBeLessThan(1.15);
    expect(codigos(conHigh)).toContain("APPETITE_KNOWN");
  });

  it("demo G: acompañamientos abundantes bajan la carne según la política", () => {
    const medio = estimateBbqQuantity(entrada({ sidesLevel: "MEDIUM" }));
    const abundante = estimateBbqQuantity(entrada({ sidesLevel: "ABUNDANT" }));
    expect(abundante.demand.participants.base).toBe(
      Math.round((medio.demand.participants.base / 0.9) * 0.75),
    );
    expect(codigos(abundante)).toContain("SIDES_APPLIED");
  });

  it("DECLINED no come y MAYBE aporta un rango que incluye que no venga", () => {
    const soloConfirmados = estimateBbqQuantity(entrada({ participants: gente(10) }));
    const conRechazo = estimateBbqQuantity(
      entrada({
        participants: [...gente(10), persona({ id: "x", attendance: "DECLINED" })],
      }),
    );
    expect(conRechazo.demand.participants.base).toBe(soloConfirmados.demand.participants.base);
    expect(conRechazo.headcount.counted).toBe(10);

    const conTalVez = estimateBbqQuantity(
      entrada({
        participants: [...gente(10), persona({ id: "x", attendance: "MAYBE" })],
      }),
    );
    expect(conTalVez.demand.participants.min).toBeLessThan(
      soloConfirmados.demand.participants.base,
    );
    expect(codigos(conTalVez)).toContain("ATTENDANCE_UNCERTAIN");
  });

  it("el peso declarado ajusta como máximo ±10% y jamás calcula IMC", () => {
    const sinDato = estimateBbqQuantity(entrada({ participants: gente(11) }));
    const pesados = estimateBbqQuantity(
      entrada({ participants: gente(11, { approxWeightKg: 200 }) }),
    );
    // El tope es del 10%; la comparación admite 1 g de holgura porque la salida
    // se entrega en gramos enteros (el medio gramo sería falsa precisión).
    expect(pesados.demand.participants.base).toBeGreaterThan(sinDato.demand.participants.base);
    expect(pesados.demand.participants.base).toBeLessThanOrEqual(
      Math.round(sinDato.demand.participants.base * 1.1) + 1,
    );
    expect(codigos(pesados)).toContain("ANTHROPOMETRIC_ADJUST");
  });
});

describe("UNKNOWN nunca pesa lo mismo que un dato conocido", () => {
  it("apetito UNKNOWN ensancha el rango en vez de valer 1,0 con una etiqueta", () => {
    const conocidos = estimateBbqQuantity(entrada({ participants: gente(11) }));
    const desconocidos = estimateBbqQuantity(
      entrada({ participants: gente(11, { appetite: "UNKNOWN" }) }),
    );

    // §77: la referencia sigue siendo la base de producto...
    expect(desconocidos.demand.participants.base).toBe(conocidos.demand.participants.base);
    // ...pero el ancho NO puede ser el mismo. Si los multiplicadores UNKNOWN
    // colapsaran a 1,0 (el defecto), estos dos anchos serían idénticos.
    expect(ancho(desconocidos.demand.participants)).toBeGreaterThan(
      ancho(conocidos.demand.participants),
    );
    expect(codigos(desconocidos)).toContain("APPETITE_UNKNOWN");
    expect(desconocidos.coverage.appetiteKnown).toBe(0);
    expect(conocidos.coverage.appetiteKnown).toBe(1);

    // Y el ensanche no puede ser simbólico. La banda de ignorancia se contrae
    // con el tamaño del grupo, pero la política declara un PISO
    // (`band.minIgnoranceScale`): con once personas, lo que el rango baja tiene
    // que estar entre ese piso y la caída sin contraer ninguna. La referencia
    // de "sin contraer" la da el mismo motor con una sola persona —ahí kIgn
    // vale 1— así que ningún número está copiado a mano acá.
    const unaConocida = estimateBbqQuantity(entrada({ participants: gente(1) }));
    const unaDesconocida = estimateBbqQuantity(
      entrada({ participants: gente(1, { appetite: "UNKNOWN" }) }),
    );
    const caidaPorPersona =
      unaConocida.demand.participants.min - unaDesconocida.demand.participants.min;
    const subidaPorPersona =
      unaDesconocida.demand.participants.max - unaConocida.demand.participants.max;
    const caidaDelGrupo =
      conocidos.demand.participants.min - desconocidos.demand.participants.min;
    const subidaDelGrupo =
      desconocidos.demand.participants.max - conocidos.demand.participants.max;
    const piso = DEFAULT_BBQ_QUANTITY_POLICY.band.minIgnoranceScale;

    expect(caidaDelGrupo).toBeGreaterThanOrEqual(11 * caidaPorPersona * piso - 1);
    expect(caidaDelGrupo).toBeLessThanOrEqual(11 * caidaPorPersona + 1);
    expect(subidaDelGrupo).toBeGreaterThanOrEqual(11 * subidaPorPersona * piso - 1);
    expect(subidaDelGrupo).toBeLessThanOrEqual(11 * subidaPorPersona + 1);
  });

  it("apetito UNKNOWN abre EXACTAMENTE la envolvente LOW..VERY_HIGH que la política declara", () => {
    // El corazón del H1, escrito de manera que no se pueda vaciar la envolvente
    // y seguir pasando. Con UNA persona la banda del grupo no se contrae (kVar
    // y kIgn valen 1), así que el rango de quien no declaró apetito tiene que
    // llegar exactamente hasta donde llega el de quien declaró LOW por abajo y
    // el de quien declaró VERY_HIGH por arriba. El oráculo son otras dos
    // corridas del motor, no constantes copiadas: si mañana LOW deja de ser
    // 0,75 este test sigue diciendo la verdad.
    const sinDeclarar = estimateBbqQuantity(
      entrada({ participants: gente(1, { appetite: "UNKNOWN" }) }),
    );
    const comePoco = estimateBbqQuantity(entrada({ participants: gente(1, { appetite: "LOW" }) }));
    const comeMucho = estimateBbqQuantity(
      entrada({ participants: gente(1, { appetite: "VERY_HIGH" }) }),
    );
    const comeNormal = estimateBbqQuantity(
      entrada({ participants: gente(1, { appetite: "NORMAL" }) }),
    );

    // El piso del desconocido ES el piso del que come poco.
    expect(sinDeclarar.demand.participants.min).toBe(comePoco.demand.participants.min);
    // Y el techo ES el techo del que come mucho.
    expect(sinDeclarar.demand.participants.max).toBe(comeMucho.demand.participants.max);
    // Con la referencia clavada en NORMAL: no sabemos no sube ni baja el centro.
    expect(sinDeclarar.demand.participants.base).toBe(comeNormal.demand.participants.base);

    // Contraprueba de que la envolvente es ancha de verdad y no un empate
    // aritmético: los tres extremos son números distintos.
    expect(comePoco.demand.participants.min).toBeLessThan(comeNormal.demand.participants.min);
    expect(comeMucho.demand.participants.max).toBeGreaterThan(comeNormal.demand.participants.max);
  });

  it("edad UNKNOWN cuenta como adulto en la referencia pero abre el rango hacia abajo", () => {
    const adultos = estimateBbqQuantity(entrada({ participants: gente(11) }));
    const sinEdad = estimateBbqQuantity(entrada({ participants: gente(11, { ageGroup: "UNKNOWN" }) }));

    expect(sinEdad.demand.participants.base).toBe(adultos.demand.participants.base);
    expect(sinEdad.demand.participants.min).toBeLessThan(adultos.demand.participants.min);
    expect(sinEdad.demand.participants.max).toBe(adultos.demand.participants.max);
    expect(codigos(sinEdad)).toContain("AGE_UNKNOWN");
  });

  it("contexto de comida sin declarar ensancha el rango, no lo deja en 1,0", () => {
    const declarado = estimateBbqQuantity(entrada({ mealContext: "FIRST_MAJOR_MEAL" }));
    const sinDeclarar = estimateBbqQuantity(entrada({ mealContext: null }));

    expect(sinDeclarar.demand.participants.base).toBe(declarado.demand.participants.base);
    expect(ancho(sinDeclarar.demand.participants)).toBeGreaterThan(
      ancho(declarado.demand.participants),
    );
    expect(codigos(sinDeclarar)).toContain("MEAL_CONTEXT_UNKNOWN");
  });

  it("acompañamientos sin declarar también ensanchan en vez de asumir el medio", () => {
    const declarado = estimateBbqQuantity(entrada({ sidesLevel: "MEDIUM" }));
    const sinDeclarar = estimateBbqQuantity(entrada({ sidesLevel: null }));
    expect(ancho(sinDeclarar.demand.participants)).toBeGreaterThan(
      ancho(declarado.demand.participants),
    );
    expect(codigos(sinDeclarar)).toContain("SIDES_UNKNOWN");
  });

  it("la banda del grupo se contrae con el headcount, no crece linealmente", () => {
    const chico = estimateBbqQuantity(entrada({ participants: gente(4, { appetite: "UNKNOWN" }) }));
    const grande = estimateBbqQuantity(
      entrada({ participants: gente(40, { appetite: "UNKNOWN" }) }),
    );
    expect(anchoRelativo(grande.demand.participants)).toBeLessThan(
      anchoRelativo(chico.demand.participants),
    );
    expect(codigos(grande)).toContain("GROUP_BAND");
  });

  it("la confianza sale del ancho del rango y de la cobertura, no de una etiqueta suelta", () => {
    const completo = estimateBbqQuantity(entrada({ participants: gente(11) }));
    const aCiegas = estimateBbqQuantity(
      entrada({
        participants: gente(11, { appetite: "UNKNOWN", ageGroup: "UNKNOWN" }),
        mealContext: null,
        sidesLevel: null,
      }),
    );
    // `not.toBe("LOW")` no dice nada: MEDIUM lo satisface. El escalón alto se
    // afirma por su nombre.
    expect(completo.confidence).toBe("HIGH");
    expect(aCiegas.confidence).toBe("LOW");
    expect(anchoRelativo(aCiegas.demand.total)).toBeGreaterThan(
      anchoRelativo(completo.demand.total),
    );
  });

  it("dietary_flags NULL no es 'sin restricciones': cambia razones y confianza", () => {
    const sinInfo = estimateBbqQuantity(entrada({ participants: gente(5, { dietaryFlags: null }) }));
    const declaroNada = estimateBbqQuantity(entrada({ participants: gente(5, { dietaryFlags: [] }) }));

    expect(sinInfo.demand.total.base).toBe(declaroNada.demand.total.base);
    expect(codigos(sinInfo)).toContain("DIETARY_INFO_MISSING");
    expect(codigos(declaroNada)).not.toContain("DIETARY_INFO_MISSING");
    expect(sinInfo.coverage.dietaryInfoKnown).toBe(0);
    expect(declaroNada.coverage.dietaryInfoKnown).toBe(1);
    expect(sinInfo.confidence).not.toBe(declaroNada.confidence);
  });
});

/**
 * EL ESCALÓN ALTO DE LA CONFIANZA, pinchado por su nombre.
 *
 * La confianza es una de las tres salidas centrales del sprint y decide cómo se
 * dibuja el número en la pantalla donde se gasta la plata. Afirmar
 * `not.toBe("LOW")` deja pasar MEDIUM y deja la rama HIGH sin cubrir: se le
 * podía anteponer `false &&` a la condición y los 156 tests seguían verdes.
 * Acá se afirma HIGH, y después se rompe UNA condición a la vez.
 */
describe("confianza HIGH: qué la produce y qué la baja", () => {
  const CONF = DEFAULT_BBQ_QUANTITY_POLICY.confidence;

  it("el escenario del sprint —11 personas, todo declarado, cadena completa— da HIGH", () => {
    const r = estimateBbqQuantity(entrada({ participants: gente(11) }));

    expect(r.confidence).toBe("HIGH");
    // Y las cuatro condiciones que la política exige, medidas en la salida:
    expect(r.reviewRequired).toHaveLength(0);
    expect(anchoRelativo(r.demand.total)).toBeLessThanOrEqual(CONF.highMaxRelativeWidth);
    expect(r.coverage.dietaryInfoKnown).toBeGreaterThanOrEqual(CONF.minDietaryCoverageHigh);
    expect(r.coverage.cutsWithFullChain).toBe(1);
  });

  it("un rango más ancho que el umbral alto baja a MEDIUM, con el número igual", () => {
    // Se rompe SÓLO el ancho: no declarar la duración abre la envolvente hacia
    // arriba y no toca ninguna cobertura.
    const r = estimateBbqQuantity(entrada({ participants: gente(11), durationHours: null }));

    expect(r.coverage.dietaryInfoKnown).toBe(1);
    expect(r.coverage.cutsWithFullChain).toBe(1);
    expect(r.reviewRequired).toHaveLength(0);
    expect(anchoRelativo(r.demand.total)).toBeGreaterThan(CONF.highMaxRelativeWidth);
    expect(anchoRelativo(r.demand.total)).toBeLessThanOrEqual(CONF.mediumMaxRelativeWidth);
    expect(r.confidence).toBe("MEDIUM");
    // La referencia no se movió: la confianza baja, el número no.
    const conDuracion = estimateBbqQuantity(entrada({ participants: gente(11) }));
    expect(r.demand.participants.base).toBe(conDuracion.demand.participants.base);
  });

  it("tres personas sin información dietaria bastan para que deje de ser HIGH", () => {
    // Se rompe SÓLO la cobertura dietaria: 8 de 11 = 0,73, bajo el 0,8 que la
    // política exige para el escalón alto. El ancho del rango no cambia.
    const r = estimateBbqQuantity(
      entrada({
        participants: [
          ...gente(8).map((p, i) => ({ ...p, id: `s${i}` })),
          ...gente(3, { dietaryFlags: null }).map((p, i) => ({ ...p, id: `d${i}` })),
        ],
      }),
    );
    const completo = estimateBbqQuantity(entrada({ participants: gente(11) }));

    expect(r.coverage.dietaryInfoKnown).toBeLessThan(CONF.minDietaryCoverageHigh);
    expect(r.coverage.dietaryInfoKnown).toBeGreaterThanOrEqual(CONF.minDietaryCoverageMedium);
    expect(anchoRelativo(r.demand.total)).toBeCloseTo(anchoRelativo(completo.demand.total), 6);
    expect(r.confidence).toBe("MEDIUM");
  });

  it("un corte sin cadena de rendimientos jamás llega a HIGH", () => {
    // La cobertura de cadena y la revisión pendiente van juntas por
    // construcción: un corte que no se puede convertir a compra pide revisión y
    // la revisión sola ya manda a LOW. Las dos puertas se cierran acá.
    const r = estimateBbqQuantity(
      entrada({ participants: gente(11), cutDefinitions: [], ingredientYields: [] }),
    );

    expect(r.coverage.cutsWithFullChain).toBeLessThan(1);
    expect(r.reviewRequired.length).toBeGreaterThan(0);
    expect(r.confidence).toBe("LOW");
  });

  it("una alergia reportada tumba la confianza a LOW aunque todo lo demás esté perfecto", () => {
    // Una revisión humana pendiente es un veto, no un descuento: no existe
    // "casi HIGH" cuando alguien puede terminar en urgencias (§23).
    const r = estimateBbqQuantity(
      entrada({
        participants: [
          ...gente(10).map((p, i) => ({ ...p, id: `s${i}` })),
          persona({ id: "alergica", dietaryFlags: ["ALLERGY_REPORTED"] }),
        ],
      }),
    );

    expect(anchoRelativo(r.demand.total)).toBeLessThanOrEqual(CONF.highMaxRelativeWidth);
    expect(r.coverage.dietaryInfoKnown).toBe(1);
    expect(r.coverage.cutsWithFullChain).toBe(1);
    expect(r.reviewRequired.map((x) => x.code)).toContain("ALLERGY_REVIEW_REQUIRED");
    expect(r.confidence).toBe("LOW");
  });
});

describe("cadena de rendimientos: un tramo, un dueño", () => {
  const argsBase = {
    cutRef: "asiento",
    cookingMethod: "PARRILLA",
    displayName: "Asiento",
    itemId: "m1",
    cutDefinitions: [ASIENTO],
    ingredientYields: [
      { cutRef: "asiento", cookingMethod: "PARRILLA", factor: 0.72, source: "0009" },
    ],
    observedYields: [],
    policy: DEFAULT_BBQ_QUANTITY_POLICY,
  };

  it("cada tramo declara su fuente y respeta la tabla de dueños", () => {
    const cadena = resolveYieldChain(argsBase);
    for (const tramo of cadena.stages) {
      expect(tramo.factor).not.toBeNull();
      expect(tramo.source).toBe(YIELD_STAGE_OWNER[tramo.stage]);
    }
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBe(0.72);
  });

  it("dos fuentes para el mismo tramo = conflicto declarado, no desempate silencioso", () => {
    const cadena = resolveYieldChain({
      ...argsBase,
      cutDefinitions: [{ ...ASIENTO, edibleRawToCooked: 0.9 }],
    });
    expect(cadena.conflicts.has("EDIBLE_RAW_TO_COOKED")).toBe(true);
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBeUndefined();
    expect(cadena.reviews.map((r) => r.code)).toContain("YIELD_STAGE_CONFLICT");
    // Ni el 0,9 de la ficha ni el 0,72 de la tabla: el tramo queda desconocido.
    const tramo = cadena.stages.find((s) => s.stage === "EDIBLE_RAW_TO_COOKED");
    expect(tramo?.factor).toBeNull();
  });

  it("un factor de cocción en la ficha del corte no se usa aunque sea el único", () => {
    const cadena = resolveYieldChain({
      ...argsBase,
      cutDefinitions: [{ ...ASIENTO, edibleRawToCooked: 0.72 }],
      ingredientYields: [],
    });
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBeUndefined();
    expect(cadena.reasons.map((r) => r.code)).toContain("YIELD_STAGE_NOT_OWNED");
    expect(cadena.reviews.map((r) => r.code)).toContain("YIELD_STAGE_NOT_OWNED");
  });

  it("la fila con método le gana a la genérica, igual que en la 0009", () => {
    const cadena = resolveYieldChain({
      ...argsBase,
      ingredientYields: [
        { cutRef: "asiento", cookingMethod: null, factor: 0.8, source: "0009" },
        { cutRef: "asiento", cookingMethod: "PARRILLA", factor: 0.72, source: "0009" },
      ],
    });
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBe(0.72);
  });
});

describe("rendimientos observados del hogar: sin etapa ni método, no son señal", () => {
  const argsBase = {
    cutRef: "asiento",
    cookingMethod: "PARRILLA",
    displayName: "Asiento",
    itemId: "m1",
    cutDefinitions: [ASIENTO],
    ingredientYields: [
      { cutRef: "asiento", cookingMethod: "PARRILLA", factor: 0.72, source: "0009" },
    ],
    policy: DEFAULT_BBQ_QUANTITY_POLICY,
  };

  it("una observación sin etapa declarada queda fuera del estimador", () => {
    const cadena = resolveYieldChain({
      ...argsBase,
      observedYields: [
        { cutRef: "asiento", stage: null, cookingMethod: "PARRILLA", factor: 0.71, observations: 8 },
      ],
    });
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBe(0.72);
    expect(cadena.reasons.map((r) => r.code)).toContain("OBSERVED_YIELD_IGNORED");
  });

  it("una observación de otro método no contamina la parrilla", () => {
    const cadena = resolveYieldChain({
      ...argsBase,
      observedYields: [
        {
          cutRef: "asiento",
          stage: "EDIBLE_RAW_TO_COOKED",
          cookingMethod: "HORNO",
          factor: 0.5,
          observations: 10,
        },
      ],
    });
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBe(0.72);
    expect(cadena.reasons.map((r) => r.code)).toContain("OBSERVED_YIELD_IGNORED");
  });

  it("una sola parrillada no reemplaza la referencia", () => {
    const cadena = resolveYieldChain({
      ...argsBase,
      observedYields: [
        {
          cutRef: "asiento",
          stage: "EDIBLE_RAW_TO_COOKED",
          cookingMethod: "PARRILLA",
          factor: 0.5,
          observations: 1,
        },
      ],
    });
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBe(0.72);
  });

  it("con etapa, método y suficientes observaciones se mezcla de forma acotada", () => {
    const cadena = resolveYieldChain({
      ...argsBase,
      observedYields: [
        {
          cutRef: "asiento",
          stage: "EDIBLE_RAW_TO_COOKED",
          cookingMethod: "PARRILLA",
          factor: 0.6,
          observations: 6,
        },
      ],
    });
    // Peso máximo 0,5 con 6 observaciones: 0,72×0,5 + 0,60×0,5 = 0,66.
    expect(cadena.factors.EDIBLE_RAW_TO_COOKED).toBeCloseTo(0.66, 6);
    expect(cadena.reasons.map((r) => r.code)).toContain("OBSERVED_YIELD_BLENDED");
    const tramo = cadena.stages.find((s) => s.stage === "EDIBLE_RAW_TO_COOKED");
    expect(tramo?.observations).toBe(6);
  });
});

describe("raw ≠ servable", () => {
  it("compone las tres etapas: comprado > comestible > cocido > servible", () => {
    const resultado = estimateBbqQuantity(entrada());
    const linea = resultado.byCut[0]!;
    const servable = linea.servable.base;
    const cocido = valor(linea.cooked).base;
    const comestible = valor(linea.rawEdible).base;
    const comprado = valor(linea.rawPurchase).base;

    expect(cocido).toBeCloseTo(servable / 0.98, 0);
    expect(comestible).toBeCloseTo(cocido / 0.72, 0);
    expect(comprado).toBeCloseTo(comestible / 0.95, 0);
    expect(comprado).toBeGreaterThan(servable);
  });

  it("demo C: con hueso hay que comprar mucho más de lo que se sirve", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        menu: [
          carne({ id: "m1", cutRef: "costillar", displayName: "Costillar", category: "VACUNO" }),
        ],
      }),
    );
    const linea = resultado.byCut[0]!;
    const comprado = valor(linea.rawPurchase).base;
    // 1 / (0,98 × 0,70 × 0,65) ≈ 2,24 kg comprados por kg servible.
    expect(comprado / linea.servable.base).toBeCloseTo(1 / (0.98 * 0.7 * 0.65), 2);
  });

  it("demo D: sin factor de cocción NO se convierte 1:1, se declara desconocido", () => {
    const resultado = estimateBbqQuantity(entrada({ ingredientYields: [] }));
    const linea = resultado.byCut[0]!;

    expect(linea.cooked.known).toBe(true);
    expect(linea.rawEdible.known).toBe(false);
    expect(linea.rawPurchase.known).toBe(false);
    expect(linea.purchaseRequired.known).toBe(false);
    expect(resultado.reviewRequired.map((r) => r.code)).toContain("YIELD_UNKNOWN");
    expect(resultado.confidence).toBe("LOW");
  });

  it("tampoco asume 1,0 de limpieza en un corte sin hueso", () => {
    const resultado = estimateBbqQuantity(
      entrada({ cutDefinitions: [{ ...ASIENTO, rawPurchaseToEdibleRaw: null }] }),
    );
    const linea = resultado.byCut[0]!;
    expect(linea.rawEdible.known).toBe(true);
    expect(linea.rawPurchase.known).toBe(false);
  });

  it("hay respuestas que el motor NO puede dar, y las dice en vez de inventarlas", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        menu: [carne({ id: "m1", cutRef: "entrana", displayName: "Entraña" })],
        cutDefinitions: [],
        ingredientYields: [],
        observedYields: [],
      }),
    );
    const linea = resultado.byCut[0]!;

    // Lo que SÍ sabe: cuánto hay que poner en el plato.
    expect(linea.servable.base).toBeGreaterThan(0);
    // Lo que NO sabe, y no rellena con nada:
    expect(linea.cooked.known).toBe(false);
    expect(linea.rawPurchase.known).toBe(false);
    expect(resultado.totalPurchaseRequired.known).toBe(false);
    if (!resultado.totalPurchaseRequired.known) {
      expect(resultado.totalPurchaseRequired.reason).toBe("PURCHASE_UNKNOWN_TOTAL");
    }
    expect(resultado.reviewRequired.length).toBeGreaterThan(0);
    expect(resultado.confidence).toBe("LOW");
  });
});

describe("distribución entre cortes", () => {
  it("demo E: cuatro carnes reparten la MISMA demanda total, no la multiplican", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        menu: [
          carne({ id: "vacuno", distributionPct: 50 }),
          carne({ id: "pollo", category: "POLLO", displayName: "Pollo", distributionPct: 25 }),
          carne({ id: "cerdo", category: "CERDO", displayName: "Cerdo", distributionPct: 15 }),
          carne({
            id: "chorizo",
            category: "EMBUTIDOS",
            displayName: "Longaniza",
            distributionPct: 10,
          }),
        ],
      }),
    );
    const suma = resultado.byCut.reduce((acc, c) => acc + c.servable.base, 0);
    expect(suma).toBeCloseTo(resultado.totalServableDemand.base, 0);
    expect(resultado.byCut[0]!.servable.base).toBeCloseTo(
      resultado.totalServableDemand.base * 0.5,
      0,
    );
    expect(codigos(resultado)).toContain("DISTRIBUTION_PCT");
  });

  it("porcentajes que no suman 100 se declaran en vez de arreglarse solos", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        menu: [
          carne({ id: "vacuno", distributionPct: 50 }),
          carne({ id: "pollo", category: "POLLO", displayName: "Pollo", distributionPct: 20 }),
        ],
      }),
    );
    expect(codigos(resultado)).toContain("DISTRIBUTION_PCT_INVALID");
    expect(resultado.reviewRequired.map((r) => r.code)).toContain("DISTRIBUTION_PCT_INVALID");
  });

  it("los vegetarianos reciben su alternativa y no 'compran' vacuno", () => {
    const flags: BbqDietaryFlag[] = ["VEGETARIAN"];
    const menu = [
      carne({ id: "vacuno", distributionPct: 50 }),
      carne({ id: "pollo", category: "POLLO", displayName: "Pollo", distributionPct: 30 }),
      carne({
        id: "veg",
        category: "VEGETARIANO",
        displayName: "Verduras a la parrilla",
        distributionPct: 20,
      }),
    ];
    const resultado = estimateBbqQuantity(
      entrada({
        menu,
        participants: [
          ...gente(9).map((p, i) => ({ ...p, id: `c${i}` })),
          persona({ id: "v1", dietaryFlags: flags }),
          persona({ id: "v2", dietaryFlags: flags }),
        ],
      }),
    );

    const total = resultado.totalServableDemand.base;
    const veg = resultado.byCut.find((c) => c.itemId === "veg")!;
    const vacuno = resultado.byCut.find((c) => c.itemId === "vacuno")!;

    // Sin segmentar, el vegetariano habría quedado con el 20% y el vacuno con
    // el 50% del total — comprando carne "para" quien no la come.
    expect(veg.servable.base).toBeGreaterThan(total * 0.2);
    expect(vacuno.servable.base).toBeLessThan(total * 0.5);
    expect(veg.servable.base).toBeCloseTo(total * (2 / 11 + (9 / 11) * 0.2), 0);
    expect(codigos(resultado)).toContain("DISTRIBUTION_SEGMENTED");
  });

  it("quien no come cerdo tampoco come los embutidos del asado", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        menu: [
          carne({ id: "vacuno", distributionPct: 50 }),
          carne({ id: "cerdo", category: "CERDO", displayName: "Cerdo", distributionPct: 25 }),
          carne({
            id: "chorizo",
            category: "EMBUTIDOS",
            displayName: "Longaniza",
            distributionPct: 25,
          }),
        ],
        participants: [
          ...gente(10).map((p, i) => ({ ...p, id: `c${i}` })),
          persona({ id: "np", dietaryFlags: ["NO_PORK"] }),
        ],
      }),
    );
    const total = resultado.totalServableDemand.base;
    const vacuno = resultado.byCut.find((c) => c.itemId === "vacuno")!;
    expect(vacuno.servable.base).toBeGreaterThan(total * 0.5);
  });

  it("un item sin categoría no se ofrece a quien tiene restricciones", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        menu: [
          carne({ id: "vacuno", distributionPct: 50 }),
          carne({ id: "misterio", category: null, displayName: "Sorpresa", distributionPct: 50 }),
        ],
        participants: [
          ...gente(10).map((p, i) => ({ ...p, id: `c${i}` })),
          persona({ id: "nb", dietaryFlags: ["NO_BEEF"] }),
        ],
      }),
    );
    expect(codigos(resultado)).toContain("MENU_CATEGORY_UNKNOWN");
    expect(resultado.uncoveredServableDemand).not.toBeNull();
    expect(resultado.reviewRequired.map((r) => r.code)).toContain("NO_COMPATIBLE_ITEM");
  });

  it("sin item compatible la demanda queda SIN CUBRIR, no repartida a la fuerza", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        participants: [
          ...gente(10).map((p, i) => ({ ...p, id: `c${i}` })),
          persona({ id: "veg", dietaryFlags: ["VEGETARIAN"] }),
        ],
      }),
    );
    const sinCubrir = resultado.uncoveredServableDemand;
    expect(sinCubrir).not.toBeNull();
    const repartido = resultado.byCut.reduce((acc, c) => acc + c.servable.base, 0);
    expect(repartido + (sinCubrir?.base ?? 0)).toBeCloseTo(resultado.totalServableDemand.base, 0);
    expect(resultado.confidence).toBe("LOW");
  });

  it("una alergia reportada siempre pide revisión humana: no se decide sola", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        participants: [
          ...gente(10).map((p, i) => ({ ...p, id: `c${i}` })),
          persona({ id: "al", dietaryFlags: ["ALLERGY_REPORTED"] }),
        ],
      }),
    );
    expect(resultado.reviewRequired.map((r) => r.code)).toContain("ALLERGY_REVIEW_REQUIRED");
  });
});

describe("inventario: se netea en la misma base física", () => {
  const lote = (over: Partial<BbqInventoryLotInput>): BbqInventoryLotInput => ({
    lotId: "l1",
    cutRef: "asiento",
    availableG: 2000,
    stage: "RAW_PURCHASE",
    frozen: false,
    ...over,
  });

  it("demo B: lo que ya tienes se descuenta antes de cualquier redondeo", () => {
    const sinStock = estimateBbqQuantity(entrada());
    const conStock = estimateBbqQuantity(entrada({ inventory: [lote({})] }));
    const antes = valor(sinStock.byCut[0]!.purchaseRequired).base;
    const despues = valor(conStock.byCut[0]!.purchaseRequired).base;
    expect(antes - despues).toBe(2000);
    expect(codigos(conStock)).toContain("INVENTORY_NETTED");
  });

  it("2 kg cocidos NO cubren lo mismo que 2 kg comprados", () => {
    const crudo = estimateBbqQuantity(entrada({ inventory: [lote({ stage: "RAW_PURCHASE" })] }));
    const cocido = estimateBbqQuantity(entrada({ inventory: [lote({ stage: "COOKED" })] }));
    const compraCrudo = valor(crudo.byCut[0]!.purchaseRequired).base;
    const compraCocido = valor(cocido.byCut[0]!.purchaseRequired).base;
    // 2.000 g cocidos equivalen a 2.000 / 0,72 / 0,95 ≈ 2.924 g comprados.
    expect(compraCocido).toBeLessThan(compraCrudo);
    expect(compraCrudo - compraCocido).toBeCloseTo(2000 / 0.72 / 0.95 - 2000, 0);
  });

  it("un lote congelado se declara para el plan de descongelado", () => {
    const resultado = estimateBbqQuantity(entrada({ inventory: [lote({ frozen: true })] }));
    expect(codigos(resultado)).toContain("INVENTORY_FROZEN");
    const uso = resultado.byCut[0]!.inventoryToUse;
    expect(uso.known).toBe(true);
    if (uso.known) expect(uso.frozenGrams).toBe(2000);
  });

  it("un lote cuya base física no se puede mapear NO se netea 1:1", () => {
    const resultado = estimateBbqQuantity(entrada({ inventory: [lote({ stage: null })] }));
    const linea = resultado.byCut[0]!;
    const sinStock = estimateBbqQuantity(entrada());
    const crudo = valor(sinStock.byCut[0]!.rawPurchase);

    expect(linea.inventoryToUse.known).toBe(false);
    // La compra se muestra entre "cubre todo lo que pesa" y "no cubre nada".
    const compra = valor(linea.purchaseRequired);
    expect(compra.base).toBe(crudo.base);
    expect(compra.min).toBe(Math.max(0, crudo.min - 2000));
    expect(resultado.reviewRequired.map((r) => r.code)).toContain("INVENTORY_YIELD_UNKNOWN");
  });

  it("inventario vacío es cero conocido, no error disfrazado", () => {
    const resultado = estimateBbqQuantity(entrada({ inventory: [] }));
    const uso = resultado.byCut[0]!.inventoryToUse;
    expect(uso.known).toBe(true);
    if (uso.known) expect(uso.grams).toBe(0);
  });
});

describe("tandas y sobrante", () => {
  it("sin plan aceptado las tandas son un rango, no un escalar inventado", () => {
    const resultado = estimateBbqQuantity(entrada({ participants: gente(30) }));
    const tandas = resultado.byCut[0]!.batches;
    expect(tandas.known).toBe(true);
    if (tandas.known && tandas.kind === "RANGE") {
      const crudo = valor(resultado.byCut[0]!.rawEdible);
      expect(tandas.min).toBe(Math.ceil(crudo.min / 2500));
      expect(tandas.max).toBe(Math.ceil(crudo.max / 2500));
      expect(tandas.max).toBeGreaterThanOrEqual(tandas.min);
    } else {
      throw new Error("se esperaba un rango de tandas");
    }
  });

  it("con el plan aceptado las tandas son exactas y sobre el crudo comestible", () => {
    const resultado = estimateBbqQuantity(
      entrada({ acceptedPlanRawEdibleG: { m1: 10000 } }),
    );
    const tandas = resultado.byCut[0]!.batches;
    expect(tandas).toEqual({ known: true, kind: "EXACT", batches: 4 });
  });

  it("una parrilla medida en unidades no se convierte a gramos sola", () => {
    const resultado = estimateBbqQuantity(
      entrada({ equipment: [{ ...PARRILLA, maxBatch: 8, maxBatchUnit: "UNIT" }] }),
    );
    expect(resultado.byCut[0]!.batches).toEqual({
      known: false,
      reason: "EQUIPMENT_UNIT_MISMATCH",
    });
    expect(resultado.reviewRequired.map((r) => r.code)).toContain("EQUIPMENT_UNIT_MISMATCH");
  });

  it("sin capacidad declarada no hay número de tandas", () => {
    const resultado = estimateBbqQuantity(entrada({ equipment: [] }));
    expect(resultado.byCut[0]!.batches).toEqual({
      known: false,
      reason: "EQUIPMENT_CAPACITY_UNKNOWN",
    });
  });

  it("si el crudo es desconocido, las tandas también lo son", () => {
    const resultado = estimateBbqQuantity(entrada({ ingredientYields: [] }));
    expect(resultado.byCut[0]!.batches.known).toBe(false);
  });

  it("el sobrante esperado se rotula ANTES del redondeo comercial", () => {
    const resultado = estimateBbqQuantity(
      entrada({ desiredLeftover: { kind: "CUSTOM", grams: 800 }, safetyBufferPct: 10 }),
    );
    expect(resultado.expectedLeftovers.basis).toBe("BEFORE_COMMERCIAL_ROUNDING");
    expect(codigos(resultado)).toContain("LEFTOVERS_BEFORE_ROUNDING");
    expect(resultado.expectedLeftovers.range.base).toBe(
      resultado.demand.desiredLeftoverGrams + resultado.demand.safetyBuffer.base,
    );
  });

  it("ONE_EXTRA_MEAL está definido en gramos, no es un número mágico", () => {
    const resultado = estimateBbqQuantity(
      entrada({
        desiredLeftover: { kind: "ONE_EXTRA_MEAL" },
        participants: [
          ...gente(4, { kind: "HOUSEHOLD_MEMBER" }).map((p, i) => ({ ...p, id: `h${i}` })),
          ...gente(7).map((p, i) => ({ ...p, id: `g${i}` })),
        ],
      }),
    );
    expect(resultado.demand.desiredLeftoverGrams).toBe(4 * 320);
    const razon = resultado.reasons.find((r) => r.code === "DESIRED_LEFTOVER");
    expect(razon?.text).toContain("4 persona(s) del hogar");
  });

  it("una comida extra sin miembros del hogar presentes se declara imposible de dimensionar", () => {
    const resultado = estimateBbqQuantity(
      entrada({ desiredLeftover: { kind: "ONE_EXTRA_MEAL" }, participants: gente(6) }),
    );
    expect(resultado.demand.desiredLeftoverGrams).toBe(0);
    expect(resultado.reviewRequired.map((r) => r.code)).toContain("EXTRA_MEAL_PEOPLE_UNKNOWN");
  });

  it("sobrante pedido y margen de seguridad son dos líneas distintas", () => {
    const resultado = estimateBbqQuantity(
      entrada({ desiredLeftover: { kind: "SMALL_BUFFER" }, safetyBufferPct: 10 }),
    );
    expect(resultado.demand.desiredLeftoverGrams).toBe(320);
    expect(resultado.demand.safetyBuffer.base).toBeGreaterThan(0);
    expect(resultado.demand.total.base).toBe(
      resultado.demand.participants.base +
        resultado.demand.safetyBuffer.base +
        resultado.demand.desiredLeftoverGrams,
    );
  });
});

describe("idempotencia y rendimiento", () => {
  it("mismos insumos ⇒ mismo resultado y misma firma", () => {
    const input = entrada({ participants: gente(11, { appetite: "UNKNOWN" }) });
    const a = estimateBbqQuantity(input);
    const b = estimateBbqQuantity(input);
    expect(a).toEqual(b);
    expect(a.inputSignature).toBe(b.inputSignature);
  });

  it("cambiar un insumo cambia la firma", () => {
    const a = estimateBbqQuantity(entrada({ participants: gente(11) }));
    const b = estimateBbqQuantity(entrada({ participants: gente(12) }));
    expect(a.inputSignature).not.toBe(b.inputSignature);
  });

  it("50 invitados y 10 cortes: sin N+1 y sin explotar", () => {
    const menu = Array.from({ length: 10 }, (_, i) =>
      carne({ id: `m${i}`, cutRef: i % 2 === 0 ? "asiento" : "costillar", distributionPct: 10 }),
    );
    const participants = gente(50, { appetite: "UNKNOWN", dietaryFlags: null });
    const inicio = Date.now();
    const resultado = estimateBbqQuantity(entrada({ menu, participants }));
    expect(Date.now() - inicio).toBeLessThan(500);
    expect(resultado.byCut).toHaveLength(10);
    expect(resultado.headcount.counted).toBe(50);
  });
});

/**
 * EL DEFECTO QUE ESTOS TESTS CIERRAN: todo integrante del hogar entraba al
 * estimador con `dietaryFlags: null` —las banderas culinarias sólo existen en
 * la ficha de los invitados— y el motor leía null como "puede comer todo el
 * menú". La familia con una alergia registrada EN LA MISMA APP recibía su
 * porción del corte que no puede comer.
 *
 * Se caen si `itemsCompatibles` vuelve a ignorar `recordedBlocks`, o si un
 * integrante con la ficha consultada vuelve a contarse como "sin información".
 */
describe("[ALTO] lo que la casa ya sabe que alguien no puede comer llega al motor", () => {
  const MENU_MIXTO: BbqMenuItemInput[] = [
    carne({ id: "item-vacuno", category: "VACUNO", displayName: "Asiento" }),
    carne({
      id: "item-cerdo",
      category: "CERDO",
      displayName: "Costillar de cerdo",
      cutRef: "costillar",
    }),
  ];

  function corte(r: BbqQuantityResult, itemId: string): BbqQuantityResult["byCut"][number] {
    const encontrado = r.byCut.find((c) => c.itemId === itemId);
    if (encontrado === undefined) throw new Error(`el resultado no trae el corte ${itemId}`);
    return encontrado;
  }

  function conPapa(over: Partial<BbqParticipantInput>): BbqQuantityResult {
    return estimateBbqQuantity(
      entrada({
        menu: MENU_MIXTO,
        participants: [
          ...gente(3),
          persona({
            id: "papa",
            kind: "HOUSEHOLD_MEMBER",
            // Un integrante del hogar NO tiene banderas culinarias: eso es de
            // la ficha del invitado. Lo que la casa sabe de él viene por la
            // otra puerta.
            dietaryFlags: null,
            ...over,
          }),
        ],
      }),
    );
  }

  const SIN_NADA_ANOTADO = { blockedItemIds: [], allergyItemIds: [] };

  it("el corte bloqueado sale de SU porción, y el total del grupo no cambia (§20)", () => {
    const sinBloqueo = conPapa({ recordedBlocks: SIN_NADA_ANOTADO });
    const conBloqueo = conPapa({
      recordedBlocks: { blockedItemIds: ["item-cerdo"], allergyItemIds: ["item-cerdo"] },
    });

    expect(corte(conBloqueo, "item-cerdo").servable.base).toBeLessThan(
      corte(sinBloqueo, "item-cerdo").servable.base,
    );
    expect(corte(conBloqueo, "item-vacuno").servable.base).toBeGreaterThan(
      corte(sinBloqueo, "item-vacuno").servable.base,
    );
    // Lo que él no come no desaparece de la compra: se reparte en lo que sí
    // puede comer. La demanda total del grupo es la misma.
    expect(conBloqueo.totalServableDemand.base).toBe(sinBloqueo.totalServableDemand.base);
  });

  it("una alergia registrada se DICE, en conteo y sin decir de quién", () => {
    const r = conPapa({
      recordedBlocks: { blockedItemIds: ["item-cerdo"], allergyItemIds: ["item-cerdo"] },
    });
    expect(codigos(r)).toContain("RECORDED_RESTRICTIONS_APPLIED");
    expect(codigos(r)).toContain("ALLERGY_ITEM_EXCLUDED");

    const razon = r.reasons.find((x) => x.code === "ALLERGY_ITEM_EXCLUDED");
    // Un conteo y nada más: ni el id de la persona, ni el del plato, ni el
    // motivo. Esta pantalla se mira entre invitados.
    expect(razon?.params).toEqual({ cantidad: 1 });
    expect(JSON.stringify(r.reasons)).not.toContain("papa");
  });

  it("la ficha consultada y vacía NO es 'sin información de restricciones'", () => {
    const consultada = conPapa({ recordedBlocks: SIN_NADA_ANOTADO });
    const nadieMiro = conPapa({ recordedBlocks: null });

    // Los tres invitados de al lado declararon `[]`, así que el único que puede
    // aparecer como desconocido es el integrante.
    expect(codigos(consultada)).not.toContain("DIETARY_INFO_MISSING");
    expect(codigos(nadieMiro)).toContain("DIETARY_INFO_MISSING");
    expect(consultada.coverage.dietaryInfoKnown).toBeGreaterThan(
      nadieMiro.coverage.dietaryInfoKnown,
    );
  });

  it("un bloqueo por ITEM no necesita que el menú tenga la categoría puesta", () => {
    // El caso feo: item sin categoría. Las banderas por categoría no pueden
    // decidir nada, pero la ficha bloquea por id igual.
    const menuSinCategoria: BbqMenuItemInput[] = [
      carne({ id: "item-vacuno", category: "VACUNO", displayName: "Asiento" }),
      carne({ id: "item-raro", category: null, displayName: "Preparación de la abuela" }),
    ];
    const r = estimateBbqQuantity(
      entrada({
        menu: menuSinCategoria,
        participants: [
          ...gente(3),
          persona({
            id: "papa",
            kind: "HOUSEHOLD_MEMBER",
            dietaryFlags: null,
            recordedBlocks: { blockedItemIds: ["item-raro"], allergyItemIds: [] },
          }),
        ],
      }),
    );
    const sinBloqueo = estimateBbqQuantity(
      entrada({
        menu: menuSinCategoria,
        participants: [
          ...gente(3),
          persona({
            id: "papa",
            kind: "HOUSEHOLD_MEMBER",
            dietaryFlags: null,
            recordedBlocks: SIN_NADA_ANOTADO,
          }),
        ],
      }),
    );
    expect(corte(r, "item-raro").servable.base).toBeLessThan(
      corte(sinBloqueo, "item-raro").servable.base,
    );
  });
});
