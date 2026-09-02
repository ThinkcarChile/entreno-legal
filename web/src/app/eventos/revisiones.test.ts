import { describe, expect, it } from "vitest";
import type { BbqParticipantInput, BbqRecordedBlocks } from "@/domain/events/bbq/types";
import {
  AsistenciaDesconocida,
  buscarCampoProhibido,
  ClaseDeItemDesconocida,
  congelarMenu,
  congelarParticipantes,
  normalizarEntrada,
} from "./revisiones";
import { entradaEstimacionSchema, type EntradaEstimacion } from "./contrato-estimacion";
import { estimarAsado, type InsumosFisicos } from "./motor";
import type { ItemMenu, Participante } from "./queries";

/**
 * Los invitados de estos tests no tienen ficha en la casa, así que no hay
 * bloqueos registrados que mirar. Se pasa el mapa VACÍO y con nombre en vez de
 * dejar que la función lo asuma: asumirlo sería que un integrante sin consultar
 * quedara marcado como "se miró y no tiene nada".
 */
const SIN_BLOQUEOS = new Map<string, BbqRecordedBlocks>();

function congelar(participantes: Participante[]): BbqParticipantInput[] {
  return congelarParticipantes(participantes, SIN_BLOQUEOS);
}

/** Primer elemento con el vacío declarado: `[0]` a secas puede ser `undefined`. */
function primero<T>(xs: readonly T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("la lista venía vacía y el test necesita un elemento");
  return x;
}

/** Un participante como lo devuelve la capa de lectura, CON datos personales. */
function participante(sobrescribir: Partial<Participante> = {}): Participante {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tipo: "GUEST",
    memberId: null,
    guestId: "22222222-2222-4222-8222-222222222222",
    nombre: "Tía María",
    grupoEdad: "ADULT",
    apetitoEfectivo: "HIGH",
    apetitoAjustado: false,
    asistencia: "CONFIRMED",
    asistenciaCruda: "CONFIRMED",
    esExtra: false,
    banderasDietarias: ["NO_PORK"],
    ...sobrescribir,
  };
}

function item(sobrescribir: Partial<ItemMenu> = {}): ItemMenu {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tipo: "MEAT",
    tipoCrudo: "MEAT",
    categoria: "VACUNO",
    ingredientId: null,
    productId: null,
    nombre: "Lomo vetado",
    porcentaje: null,
    notas: null,
    ...sobrescribir,
  };
}

function entrada(sobrescribir: Partial<EntradaEstimacion> = {}): EntradaEstimacion {
  return entradaEstimacionSchema.parse({
    eventDate: "2026-09-05",
    durationHours: 5,
    mealContext: "FIRST_MAJOR_MEAL",
    sidesLevel: "MEDIUM",
    desiredLeftover: { kind: "SMALL_BUFFER", customG: null },
    safetyBufferPct: 10,
    participants: congelar([participante()]),
    menu: congelarMenu([item()]),
    yieldInputs: {},
    policy: {},
    ...sobrescribir,
  });
}

/**
 * Sin rendimientos, sin despensa y sin parrilla declarada.
 *
 * Es un escenario legítimo y el motor lo resuelve diciendo lo que no sabe: acá
 * se usa para probar la FIRMA, que es lo que decide si hay revisión nueva.
 */
const SIN_INSUMOS: InsumosFisicos = {
  cutDefinitions: [],
  ingredientYields: [],
  observedYields: [],
  inventory: [],
  equipment: [],
};

function firmaDe(e: EntradaEstimacion): string {
  const ordenada = normalizarEntrada(e);
  const r = estimarAsado({
    contexto: {
      eventDate: ordenada.eventDate,
      durationHours: ordenada.durationHours,
      mealContext: ordenada.mealContext,
      sidesLevel: ordenada.sidesLevel,
      desiredLeftover: ordenada.desiredLeftover,
      safetyBufferPct: ordenada.safetyBufferPct,
    },
    participantes: ordenada.participants,
    menu: ordenada.menu,
    insumos: SIN_INSUMOS,
  });
  if (!r.ok) throw new Error(`el motor no pudo estimar: ${r.motivo}`);
  return r.salida.inputSignature;
}

describe("el snapshot congelado no guarda datos personales del invitado", () => {
  it("deja fuera nombre, sexo, peso, estatura y nota de alergia", () => {
    const congelados = congelar([participante()]);
    expect(buscarCampoProhibido(congelados)).toBeNull();
    expect(JSON.stringify(congelados)).not.toContain("María");
  });

  it("conserva lo que el cálculo SÍ necesita", () => {
    const p = primero(congelar([participante()]));
    expect(p.ageGroup).toBe("ADULT");
    expect(p.appetite).toBe("HIGH");
    expect(p.attendance).toBe("CONFIRMED");
    expect(p.dietaryFlags).toEqual(["NO_PORK"]);
    // La antropometría no viaja aunque exista en la ficha: la cantidad de carne
    // no se calcula con peso ni estatura.
    expect(p.approxWeightKg).toBeNull();
  });

  it("distingue 'no sabemos' de 'declaró que no tiene'", () => {
    const sinInfo = primero(congelar([participante({ banderasDietarias: null })]));
    const declarado = primero(congelar([participante({ banderasDietarias: [] })]));
    expect(sinInfo.dietaryFlags).toBeNull();
    expect(declarado.dietaryFlags).toEqual([]);
    // Si esto se rompiera, un invitado del que nadie preguntó nada se leería
    // como uno que dijo que no tiene restricciones.
    expect(sinInfo.dietaryFlags).not.toEqual(declarado.dietaryFlags);
  });

  it("una entrada completa tampoco arrastra campos prohibidos", () => {
    expect(buscarCampoProhibido(entrada())).toBeNull();
  });

  it("una asistencia que la app no conoce se niega a congelar en vez de adivinar", () => {
    expect(() =>
      congelar([participante({ asistencia: null, asistenciaCruda: "RSVP_PENDING" })]),
    ).toThrow(AsistenciaDesconocida);
  });
});

describe("el menú congelado", () => {
  it("la llave del rendimiento sale del catálogo; escrito a mano queda sin llave", () => {
    const conIngrediente = primero(
      congelarMenu([item({ ingredientId: "aaaaaaaa-1111-4111-8111-111111111111" })]),
    );
    expect(conIngrediente.cutRef).toBe("aaaaaaaa-1111-4111-8111-111111111111");
    // Sin ingrediente ni producto no hay con qué buscar el rendimiento, y eso
    // se declara con un null — no se inventa una llave desde el nombre.
    expect(primero(congelarMenu([item()])).cutRef).toBeNull();
  });

  it("sin porcentaje queda en null (AUTO), nunca en cero", () => {
    expect(primero(congelarMenu([item({ porcentaje: null })])).distributionPct).toBeNull();
  });
});

describe("una clase de item que la app no conoce", () => {
  it("se niega a congelar en vez de tratarla como acompañamiento", () => {
    // Si fuera una carne y la diéramos por acompañamiento, saldría del reparto
    // y de la compra sin que nadie se entere.
    expect(() => congelarMenu([item({ tipo: null, tipoCrudo: "SEAFOOD_PLATTER" })])).toThrow(
      ClaseDeItemDesconocida,
    );
  });
});

describe("la firma: misma entrada, misma revisión", () => {
  it("dos veces la misma entrada dan la misma firma", () => {
    expect(firmaDe(entrada())).toBe(firmaDe(entrada()));
  });

  it("el ORDEN de participantes y menú no cambia la firma", () => {
    const a = participante({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const b = participante({ id: "bbbbbbbb-1111-4111-8111-111111111111" });
    const uno = entrada({ participants: congelar([a, b]) });
    const otro = entrada({ participants: congelar([b, a]) });
    // Sin normalizar, dos consultas idénticas que PostgREST devolvió en
    // distinto orden crearían dos revisiones para el mismo plan.
    expect(firmaDe(uno)).toBe(firmaDe(otro));
  });

  it("un invitado más cambia la firma", () => {
    const conUnoMas = entrada({
      participants: congelar([
        participante(),
        participante({ id: "44444444-4444-4444-8444-444444444444" }),
      ]),
    });
    expect(firmaDe(conUnoMas)).not.toBe(firmaDe(entrada()));
  });

  it("cambiar el margen de seguridad cambia la firma", () => {
    expect(firmaDe(entrada({ safetyBufferPct: 5 }))).not.toBe(
      firmaDe(entrada({ safetyBufferPct: 10 })),
    );
  });

  it("cambiar el nivel de acompañamientos cambia la firma", () => {
    expect(firmaDe(entrada({ sidesLevel: "ABUNDANT" }))).not.toBe(
      firmaDe(entrada({ sidesLevel: "MEDIUM" })),
    );
  });

  it("cambiar el reparto por corte cambia la firma", () => {
    const cincuenta = entrada({ menu: congelarMenu([item({ porcentaje: 50 })]) });
    const auto = entrada({ menu: congelarMenu([item({ porcentaje: null })]) });
    expect(firmaDe(cincuenta)).not.toBe(firmaDe(auto));
  });
});

describe("normalizarEntrada", () => {
  it("ordena por id sin perder ni duplicar nada", () => {
    const a = participante({ id: "cccccccc-1111-4111-8111-111111111111" });
    const b = participante({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const normalizada = normalizarEntrada(entrada({ participants: congelar([a, b]) }));
    expect(normalizada.participants.map((p: BbqParticipantInput) => p.id)).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111",
      "cccccccc-1111-4111-8111-111111111111",
    ]);
  });
});

describe("buscarCampoProhibido", () => {
  it("encuentra un nombre escondido en cualquier nivel", () => {
    expect(buscarCampoProhibido({ participants: [{ ageGroup: "ADULT", name: "Juan" }] })).toBe(
      "participants[0].name",
    );
  });

  it("no se confunde con un objeto limpio", () => {
    expect(buscarCampoProhibido({ participants: [{ ageGroup: "ADULT" }] })).toBeNull();
  });
});

describe("el motor se niega a inventar el sobrante a medias", () => {
  it("CUSTOM sin gramos no se calcula como cero", () => {
    const e = normalizarEntrada(entrada({ desiredLeftover: { kind: "CUSTOM", customG: null } }));
    const r = estimarAsado({
      contexto: {
        eventDate: e.eventDate,
        durationHours: e.durationHours,
        mealContext: e.mealContext,
        sidesLevel: e.sidesLevel,
        desiredLeftover: e.desiredLeftover,
        safetyBufferPct: e.safetyBufferPct,
      },
      participantes: e.participants,
      menu: e.menu,
      insumos: SIN_INSUMOS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("no escribiste cuánta");
  });
});
