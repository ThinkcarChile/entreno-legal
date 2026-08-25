import { describe, expect, it } from "vitest";
import { BATCH_PREP_VERSION, fefoOrder, planPrep } from "./engine";
import type {
  EquipmentConfig,
  PrepDemand,
  PrepEngineInput,
  PrepLot,
  PrepPreference,
  SafetyRule,
} from "./types";

const HOY = "2026-08-24"; // lunes

function lote(partial: Partial<PrepLot> = {}): PrepLot {
  return {
    id: "lot-pollo",
    ingredientId: "ing-pollo",
    categoryId: "cat-carnes",
    label: "Pechuga de pollo",
    quantity: 4200,
    unit: "G",
    processingState: "RAW",
    temperatureState: "CHILLED",
    vacuumSealed: false,
    locationKind: "FRIDGE",
    useBy: null,
    expiryDate: null,
    createdOn: HOY,
    intendedUseDate: null,
    ...partial,
  };
}

function demanda(partial: Partial<PrepDemand> = {}): PrepDemand {
  return {
    assignmentId: "a-1",
    date: "2026-08-25",
    mealType: "LUNCH",
    ingredientId: "ing-pollo",
    quantity: 1100,
    unit: "G",
    ...partial,
  };
}

function regla(partial: Partial<SafetyRule> = {}): SafetyRule {
  return {
    id: "r-1",
    isHousehold: false,
    ingredientId: null,
    categoryId: null,
    processingState: null,
    temperatureState: null,
    vacuumSealed: null,
    ruleKind: "STORAGE_DAYS",
    maxDays: null,
    useSoonWithinDays: 1,
    refreezeAllowed: null,
    thawFridgeHours: null,
    source: "USDA (test)",
    ...partial,
  };
}

const REGLAS: SafetyRule[] = [
  // Como el seed real (USDA): crudo Y porcionado-crudo comparten la ventana.
  regla({ id: "r-raw", ingredientId: "ing-pollo", processingState: "RAW", temperatureState: "CHILLED", maxDays: 2 }),
  regla({ id: "r-prepped", ingredientId: "ing-pollo", processingState: "PREPPED", temperatureState: "CHILLED", maxDays: 2 }),
  regla({ id: "r-frozen", temperatureState: "FROZEN", maxDays: null }),
  regla({ id: "r-thaw", ingredientId: "ing-pollo", ruleKind: "THAW", temperatureState: "FROZEN", thawFridgeHours: 24 }),
];

function entrada(partial: Partial<PrepEngineInput> = {}): PrepEngineInput {
  return {
    today: HOY,
    horizonDays: 7,
    lots: [lote()],
    demand: [
      demanda({ assignmentId: "a-mar", date: "2026-08-25", quantity: 1100 }),
      demanda({ assignmentId: "a-vie", date: "2026-08-28", quantity: 1300 }),
      demanda({ assignmentId: "a-dom", date: "2026-08-30", quantity: 900 }),
    ],
    preferences: [],
    capabilities: [],
    safetyRules: REGLAS,
    freezerCapacityKnown: null,
    ...partial,
  };
}

describe("§8/§42 — el ejemplo del director: pollo por días + reserva", () => {
  it("4.200 g con usos 1.100/1.300/900 → paquetes 1.100, 1.300, 900 y 900 de reserva", () => {
    const plan = planPrep(entrada());
    const portion = plan.tasks.find((t) => t.taskType === "PORTION")!;
    expect(portion.params.packages!.map((p) => p.quantity)).toEqual([1100, 1300, 900, 900]);
    expect(portion.params.packages!.map((p) => p.intendedUseDate)).toEqual([
      "2026-08-25",
      "2026-08-28",
      "2026-08-30",
      null, // reserva/no asignado
    ]);
    expect(plan.engineVersion).toBe(BATCH_PREP_VERSION);
  });

  it("§23: martes cabe refrigerado (regla 2 días); viernes y domingo → congelar; la reserva → congelar", () => {
    const plan = planPrep(entrada());
    const paquetes = planPrep(entrada()).tasks.find((t) => t.taskType === "PORTION")!.params.packages!;
    expect(paquetes.map((p) => p.storage)).toEqual(["REFRIGERATE", "FREEZE", "FREEZE", "FREEZE"]);
    expect(paquetes[0]!.storageSource).toContain("USDA");
    void plan;
  });
});

describe("§2/§9 — no sobrepreparar: preparar X, dejar Y, con razón", () => {
  it("tomates: 2 kg comprados, 700 g demandados → preparar 700, dejar 1.300 enteros", () => {
    const plan = planPrep(
      entrada({
        lots: [lote({ id: "lot-tomate", ingredientId: "ing-tomate", label: "Tomate", quantity: 2000 })],
        demand: [demanda({ ingredientId: "ing-tomate", quantity: 700 })],
        // "picar" ES un corte declarado por el hogar: cortar degrada → conservador.
        preferences: [
          { ingredientId: "ing-tomate", taskType: "CUT", params: {}, capabilityId: null, manualAlternative: "cuchillo" },
        ],
        safetyRules: [], // sin reglas para tomate: el guardado dirá revisar
      }),
    );
    expect(plan.leaveWhole).toHaveLength(1);
    expect(plan.leaveWhole[0]).toMatchObject({ quantity: 1300 });
    expect(plan.leaveWhole[0]!.reason).toContain("700");
    const prep = plan.tasks.filter((t) => t.plannedQuantity != null);
    expect(Math.max(...prep.map((t) => t.plannedQuantity!))).toBeLessThanOrEqual(700);
  });

  it("sin demanda confirmada NO se inventan porciones: cero tareas", () => {
    const plan = planPrep(entrada({ demand: [] }));
    expect(plan.tasks).toHaveLength(0);
  });

  it("§83: la demanda cambió a merluza → ninguna tarea de pollo", () => {
    const plan = planPrep(
      entrada({ demand: [demanda({ ingredientId: "ing-merluza", quantity: 500 })] }),
    );
    expect(plan.tasks.filter((t) => t.ingredientId === "ing-pollo")).toHaveLength(0);
  });
});

describe("el estado del paquete es el REAL: porcionar sin cortar sigue crudo", () => {
  it("con SOLO una regla RAW/CHILLED, el paquete del martes se refrigera igual", () => {
    const soloRaw = [
      regla({ id: "r-raw", ingredientId: "ing-pollo", processingState: "RAW", temperatureState: "CHILLED", maxDays: 2 }),
      regla({ id: "r-frozen", temperatureState: "FROZEN", maxDays: null }),
    ];
    const plan = planPrep(entrada({ safetyRules: soloRaw }));
    const paquetes = plan.tasks.find((t) => t.taskType === "PORTION")!.params.packages!;
    // Sin el fix, el motor consultaba PREPPED (sin regla) → REVIEW_REQUIRED falso.
    expect(paquetes[0]!.storage).toBe("REFRIGERATE");
  });
});

describe("§52/§88 — FEFO: usar primero lo que vence primero", () => {
  it("dos lotes compatibles: el de use_by más cercano se prepara primero", () => {
    const viejo = lote({ id: "lot-viejo", quantity: 1000, useBy: "2026-08-26" });
    const nuevo = lote({ id: "lot-nuevo", quantity: 4000, useBy: "2026-09-05" });
    expect(fefoOrder([nuevo, viejo]).map((l) => l.id)).toEqual(["lot-viejo", "lot-nuevo"]);

    const plan = planPrep(
      entrada({ lots: [nuevo, viejo], demand: [demanda({ quantity: 800 })] }),
    );
    const conLote = plan.tasks.filter((t) => t.lotId != null);
    expect(conLote.every((t) => t.lotId === "lot-viejo")).toBe(true);
  });
});

describe("§11/§12/§86 — cortes desde preferencias del hogar, manual siempre posible", () => {
  const cap: EquipmentConfig = {
    id: "cap-shred4",
    equipmentId: "eq-cortadora",
    equipmentName: "Cortadora de verduras",
    equipmentActive: true,
    capability: "CUT_SHRED",
    params: { size_mm: 4 },
    maxBatchQuantity: null,
    maxBatchUnit: null,
    isActive: true,
  };
  const pref: PrepPreference = {
    ingredientId: "ing-zanahoria",
    taskType: "SHRED",
    params: { size_mm: 4 },
    capabilityId: "cap-shred4",
    manualAlternative: "rallador manual",
  };

  function conZanahoria(caps: EquipmentConfig[]): PrepEngineInput {
    return entrada({
      lots: [lote({ id: "lot-zana", ingredientId: "ing-zanahoria", label: "Zanahoria", quantity: 2000 })],
      demand: [demanda({ ingredientId: "ing-zanahoria", quantity: 600 })],
      preferences: [pref],
      capabilities: caps,
      safetyRules: [],
    });
  }

  it("capability activa → la tarea usa el equipo con sus params (4 mm)", () => {
    const plan = planPrep(conZanahoria([cap]));
    const corte = plan.tasks.find((t) => t.taskType === "SHRED")!;
    expect(corte.params.equipmentName).toBe("Cortadora de verduras");
    expect(corte.params.cutLabel).toBe("SHRED 4 mm");
    expect(corte.params.manualAlternative).toBe("rallador manual"); // §12: siempre viaja
    expect(corte.plannedQuantity).toBe(600);
  });

  it("equipo desactivado → alternativa manual, jamás bloqueo (§86)", () => {
    const plan = planPrep(conZanahoria([{ ...cap, isActive: false }]));
    const corte = plan.tasks.find((t) => t.taskType === "SHRED")!;
    expect(corte.params.equipmentName).toBeNull();
    expect(corte.params.manualAlternative).toBe("rallador manual");
  });

  it("la capacidad por tanda en OTRA unidad no se compara (sin conversiones a ciegas)", () => {
    const capUnidades = { ...cap, maxBatchQuantity: 2, maxBatchUnit: "UNIT" as const };
    const plan = planPrep(
      entrada({
        lots: [lote({ id: "lot-zana", ingredientId: "ing-zanahoria", label: "Zanahoria", quantity: 2000 })],
        demand: [demanda({ ingredientId: "ing-zanahoria", quantity: 1500 })],
        preferences: [pref],
        capabilities: [capUnidades],
        safetyRules: [],
      }),
    );
    const corte = plan.tasks.find((t) => t.taskType === "SHRED")!;
    expect(corte.params.batches).toBeUndefined(); // 2 UNIT vs 1.500 G: no se inventa
  });

  it("§53/§87: capacidad por tanda — 1.500 g en equipo de 800 g → 2 tandas, cantidad intacta", () => {
    const capChica = { ...cap, maxBatchQuantity: 800, maxBatchUnit: "G" as const };
    const plan = planPrep(
      entrada({
        lots: [lote({ id: "lot-zana", ingredientId: "ing-zanahoria", label: "Zanahoria", quantity: 2000 })],
        demand: [demanda({ ingredientId: "ing-zanahoria", quantity: 1500 })],
        preferences: [pref],
        capabilities: [capChica],
        safetyRules: [],
      }),
    );
    const corte = plan.tasks.find((t) => t.taskType === "SHRED")!;
    expect(corte.params.batches).toBe(2);
    expect(corte.plannedQuantity).toBe(1500);
  });
});

describe("§13/§56 — agrupar por herramienta, dependencias intactas (§14)", () => {
  it("dos alimentos con la MISMA cuchilla quedan contiguos en el bloque de corte", () => {
    const cap4: EquipmentConfig = {
      id: "cap4", equipmentId: "eq-c", equipmentName: "Cortadora", equipmentActive: true,
      capability: "CUT_SHRED", params: { size_mm: 4 }, maxBatchQuantity: null, maxBatchUnit: null, isActive: true,
    };
    const cap9: EquipmentConfig = { ...cap4, id: "cap9", capability: "CUT_DICE", params: { size_mm: 9 } };
    const plan = planPrep(
      entrada({
        lots: [
          lote({ id: "l-zana", ingredientId: "ing-zanahoria", label: "Zanahoria", quantity: 1000 }),
          lote({ id: "l-beto", ingredientId: "ing-betarraga", label: "Betarraga", quantity: 1000 }),
          lote({ id: "l-papa", ingredientId: "ing-papa", label: "Papa", quantity: 1000 }),
        ],
        demand: [
          demanda({ ingredientId: "ing-zanahoria", quantity: 500, assignmentId: "a-z" }),
          demanda({ ingredientId: "ing-betarraga", quantity: 500, assignmentId: "a-b" }),
          demanda({ ingredientId: "ing-papa", quantity: 500, assignmentId: "a-p" }),
        ],
        preferences: [
          { ingredientId: "ing-zanahoria", taskType: "SHRED", params: { size_mm: 4 }, capabilityId: "cap4", manualAlternative: null },
          { ingredientId: "ing-papa", taskType: "DICE", params: { size_mm: 9 }, capabilityId: "cap9", manualAlternative: null },
          { ingredientId: "ing-betarraga", taskType: "SHRED", params: { size_mm: 4 }, capabilityId: "cap4", manualAlternative: null },
        ],
        capabilities: [cap4, cap9],
        safetyRules: [],
      }),
    );
    const cortes = plan.tasks.filter((t) => ["SHRED", "DICE"].includes(t.taskType));
    expect(cortes).toHaveLength(3);
    // Las dos tareas de la cuchilla 4 mm quedan JUNTAS: entre las tres tareas
    // hay UN solo cambio de cuchilla, jamás 4→9→4 (§13).
    const claves = cortes.map((t) => t.params.cutLabel);
    let cambios = 0;
    for (let i = 1; i < claves.length; i++) if (claves[i] !== claves[i - 1]) cambios++;
    expect(cambios).toBe(1);
  });

  it("cada tarea depende de la anterior de SU cadena aunque el orden global agrupe", () => {
    const plan = planPrep(
      entrada({
        preferences: [
          { ingredientId: "ing-pollo", taskType: "WASH", params: {}, capabilityId: null, manualAlternative: null },
        ],
      }),
    );
    const wash = plan.tasks.findIndex((t) => t.taskType === "WASH");
    const portion = plan.tasks.findIndex((t) => t.taskType === "PORTION");
    const label = plan.tasks.findIndex((t) => t.taskType === "LABEL");
    expect(wash).toBeGreaterThanOrEqual(0);
    // PORTION depende de WASH; LABEL depende de PORTION (§14: no etiquetar antes del paquete).
    expect(plan.tasks[portion]!.dependsOnIndex).toBe(wash + 1);
    expect(plan.tasks[label]!.dependsOnIndex).toBe(portion + 1);
  });
});

describe("§29 — descongelado sugerido para paquetes congelados", () => {
  it("lote congelado con uso previsto + regla THAW → traslado programado", () => {
    const plan = planPrep(
      entrada({
        lots: [lote(), lote({ id: "lot-frozen", temperatureState: "FROZEN", intendedUseDate: "2026-08-28", quantity: 1000 })],
      }),
    );
    expect(plan.thawSuggestions).toHaveLength(1);
    expect(plan.thawSuggestions[0]!.plan).toMatchObject({ kind: "SCHEDULED", moveDate: "2026-08-27" });
  });

  it("sin regla THAW → 'revisar descongelado', sin hora inventada", () => {
    const plan = planPrep(
      entrada({
        safetyRules: REGLAS.filter((r) => r.ruleKind !== "THAW"),
        lots: [lote(), lote({ id: "lot-frozen", temperatureState: "FROZEN", intendedUseDate: "2026-08-28", quantity: 1000 })],
      }),
    );
    expect(plan.thawSuggestions[0]!.plan.kind).toBe("REVIEW");
  });
});

describe("§54/§89 — capacidad del congelador", () => {
  it("desconocida: no bloquea ni avisa nada inventado", () => {
    const plan = planPrep(entrada({ freezerCapacityKnown: null }));
    expect(plan.warnings).toHaveLength(0);
  });

  it("conocida y sobrepasada: aviso explícito (3.100 g a congelar vs 1.000)", () => {
    const plan = planPrep(entrada({ freezerCapacityKnown: 1000 }));
    expect(plan.warnings.join(" ")).toContain("capacidad conocida");
  });
});

describe("determinismo y resumen", () => {
  it("mismos insumos → mismo plan byte a byte", () => {
    expect(JSON.stringify(planPrep(entrada()))).toBe(JSON.stringify(planPrep(entrada())));
  });

  it("el resumen cuenta lo real: tareas, alimentos, paquetes, etiquetas, minutos", () => {
    const plan = planPrep(entrada());
    expect(plan.summary.totalTasks).toBe(plan.tasks.length);
    expect(plan.summary.packages).toBe(4);
    expect(plan.summary.labels).toBe(4);
    expect(plan.summary.estimatedMinutes).toBeGreaterThan(0);
    expect(plan.complexity).toBeGreaterThan(0);
  });
});
