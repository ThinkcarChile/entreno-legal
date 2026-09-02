import { describe, expect, it } from "vitest";
import {
  applyEventEffect,
  effectFor,
  eventCoversDate,
  eventHasNoHouseholdMembers,
  eventIncludes,
  eventRosterIsUnknown,
  type DayEvent,
} from "./events";
import type { TargetSet } from "./types";

const almuerzo: TargetSet = {
  ENERGY_KCAL: { minimum: 500, preferred: 700, maximum: 800 },
  PROTEIN_G: { minimum: 30, preferred: 40, maximum: null },
};

function evento(parcial: Partial<DayEvent>): DayEvent {
  return {
    id: "e1",
    date: "2026-09-05",
    endDate: null,
    eventType: "BARBECUE",
    mealType: "LUNCH",
    strategy: "RELAXED",
    title: "Asado en casa",
    // Por omisión, la semántica de siempre: lista vacía = toda la familia. Los
    // tests del borde declaran su propio alcance.
    memberScope: "LEGACY_EMPTY_MEANS_ALL",
    memberIds: [],
    ...parcial,
  };
}

describe("§5 la estrategia de un evento tiene efecto real, no decorativo", () => {
  it("con margen ensancha el techo del almuerzo y deja el piso donde estaba", () => {
    const efecto = effectFor([evento({})], "m1", "2026-09-05", "LUNCH");
    expect(efecto.kind).toBe("RELAXED");

    const nuevos = applyEventEffect(almuerzo, efecto);
    expect(nuevos.ENERGY_KCAL!.maximum).toBe(1000); // 800 × 1,25
    expect(nuevos.ENERGY_KCAL!.minimum).toBe(500); // el piso no se mueve
  });

  it("no le inventa un techo a quien no declaró ninguno", () => {
    const efecto = effectFor([evento({})], "m1", "2026-09-05", "LUNCH");
    const nuevos = applyEventEffect(almuerzo, efecto);
    expect(nuevos.PROTEIN_G!.maximum).toBeNull();
  });

  it("sin conteo deja la comida sin objetivos, no con objetivos en cero", () => {
    const efecto = effectFor([evento({ strategy: "SKIP_TRACKING" })], "m1", "2026-09-05", "LUNCH");
    expect(efecto.kind).toBe("UNTRACKED");
    expect(applyEventEffect(almuerzo, efecto)).toEqual({});
  });

  it("no pasa nada en las comidas que el evento no toca", () => {
    const efecto = effectFor([evento({})], "m1", "2026-09-05", "DINNER");
    expect(efecto.kind).toBe("NONE");
    expect(applyEventEffect(almuerzo, efecto)).toEqual(almuerzo);
  });

  it("un evento planificado tal cual no mueve nada", () => {
    const efecto = effectFor([evento({ strategy: "AS_PLANNED" })], "m1", "2026-09-05", "LUNCH");
    expect(efecto.kind).toBe("NONE");
  });
});

describe("§5 más liviano alrededor aprieta el resto del día, con tope", () => {
  const asado = evento({ strategy: "LIGHTER_AROUND" });

  it("la comida del evento igual va con margen", () => {
    expect(effectFor([asado], "m1", "2026-09-05", "LUNCH").kind).toBe("RELAXED");
  });

  it("las demás comidas del día bajan un 10%, nunca más", () => {
    const efecto = effectFor([asado], "m1", "2026-09-05", "DINNER");
    expect(efecto.kind).toBe("LIGHTER");
    const nuevos = applyEventEffect(almuerzo, efecto);
    expect(nuevos.ENERGY_KCAL!.maximum).toBe(720); // 800 × 0,9
    expect(nuevos.ENERGY_KCAL!.preferred).toBe(630);
  });

  it("apretar jamás baja del mínimo declarado: un asado no se paga con ayuno", () => {
    const ajustado: TargetSet = {
      ENERGY_KCAL: { minimum: 700, preferred: 720, maximum: 750 },
    };
    const efecto = effectFor([asado], "m1", "2026-09-05", "DINNER");
    const nuevos = applyEventEffect(ajustado, efecto);
    expect(nuevos.ENERGY_KCAL!.preferred).toBe(700);
    expect(nuevos.ENERGY_KCAL!.maximum).toBe(700);
    expect(nuevos.ENERGY_KCAL!.minimum).toBe(700);
  });

  it("no toca los días vecinos, solo el del evento", () => {
    expect(effectFor([asado], "m1", "2026-09-06", "DINNER").kind).toBe("NONE");
  });
});

describe("§2/§5 un evento puede ser de una persona sola", () => {
  const cumple = evento({ memberIds: ["m2"], title: "Cumpleaños de la Sofía" });

  it("afecta a quien nombra", () => {
    expect(eventIncludes(cumple, "m2")).toBe(true);
    expect(effectFor([cumple], "m2", "2026-09-05", "LUNCH").kind).toBe("RELAXED");
  });

  it("no afecta al resto de la familia", () => {
    expect(eventIncludes(cumple, "m1")).toBe(false);
    expect(effectFor([cumple], "m1", "2026-09-05", "LUNCH").kind).toBe("NONE");
  });

  it("sin nadie nombrado es de toda la familia", () => {
    expect(eventIncludes(evento({}), "cualquiera")).toBe(true);
  });
});

describe("§6 el rango de un evento se compara como texto, sin pasar por Date", () => {
  const viaje = evento({
    date: "2026-09-04",
    endDate: "2026-09-08",
    eventType: "TRAVEL",
    mealType: null,
    strategy: "SKIP_TRACKING",
    title: "Viaje a Valdivia",
  });

  it("cubre los bordes del rango, inclusive", () => {
    expect(eventCoversDate(viaje, "2026-09-04")).toBe(true);
    expect(eventCoversDate(viaje, "2026-09-08")).toBe(true);
  });

  it("no cubre el día anterior ni el siguiente", () => {
    expect(eventCoversDate(viaje, "2026-09-03")).toBe(false);
    expect(eventCoversDate(viaje, "2026-09-09")).toBe(false);
  });

  it("un evento de día completo aplica a todas las comidas de esos días", () => {
    for (const comida of ["BREAKFAST", "LUNCH", "TEA", "DINNER"] as const) {
      expect(effectFor([viaje], "m1", "2026-09-06", comida).kind).toBe("UNTRACKED");
    }
  });
});

describe("§5 dos eventos el mismo día", () => {
  it("gana el más permisivo: nadie come menos por tener dos motivos de celebración", () => {
    const eventos = [
      evento({ id: "a", strategy: "LIGHTER_AROUND", mealType: "LUNCH" }),
      evento({ id: "b", strategy: "SKIP_TRACKING", mealType: null, title: "Feriado" }),
    ];
    expect(effectFor(eventos, "m1", "2026-09-05", "DINNER").kind).toBe("UNTRACKED");
    expect(effectFor(eventos, "m1", "2026-09-05", "LUNCH").kind).toBe("UNTRACKED");
  });
});

/**
 * EL BORDE QUE ESTA RONDA VINO A CERRAR (Sprint 13, lente "el vacío leído como
 * cero"): la lista de integrantes vacía significaba SIEMPRE "toda la familia".
 *
 * Con el armador de /eventos eso pasó a ser falso de dos maneras: un asado con
 * puros invitados, y un asado donde todos los del hogar marcaron DECLINED. En
 * los dos casos la tabla queda en cero filas y la familia entera amanecía con
 * el día RELAXED sin que nadie lo hubiera pedido.
 *
 * Estos tests se caen si `eventIncludes` vuelve a ser
 * `memberIds.length === 0 || memberIds.includes(memberId)`.
 */
describe("[ALTO] a quién afecta un evento: vacío no es una respuesta por sí solo", () => {
  it("con la semántica de siempre, la lista vacía sí es toda la familia", () => {
    const viejo = evento({ memberScope: "LEGACY_EMPTY_MEANS_ALL", memberIds: [] });
    expect(eventIncludes(viejo, "m1")).toBe(true);
    expect(eventRosterIsUnknown(viejo)).toBe(false);
  });

  it("un roster DECLARADO y vacío no incluye a nadie de la casa", () => {
    // El asado donde los cuatro del hogar dijeron que no van: la lista se
    // declaró y no quedó nadie. Eso NO es lo mismo que no haber declarado.
    const asado = evento({ memberScope: "DECLARED_ROSTER", memberIds: [] });
    expect(eventIncludes(asado, "m1")).toBe(false);
    expect(eventHasNoHouseholdMembers(asado)).toBe(true);
  });

  it("un roster declarado nombra exactamente a quienes van", () => {
    const asado = evento({ memberScope: "DECLARED_ROSTER", memberIds: ["m2"] });
    expect(eventIncludes(asado, "m2")).toBe(true);
    expect(eventIncludes(asado, "m1")).toBe(false);
  });

  it("sin declarar no es ni todos ni nadie: no afecta, y se puede decir por qué", () => {
    const asado = evento({ memberScope: "UNDECLARED", memberIds: [] });
    expect(eventIncludes(asado, "m1")).toBe(false);
    expect(eventRosterIsUnknown(asado)).toBe(true);
    expect(eventHasNoHouseholdMembers(asado)).toBe(false);
  });

  it("mientras no se sepa quién va, el evento NO le relaja los objetivos a nadie", () => {
    const sinDeclarar = evento({
      memberScope: "UNDECLARED",
      strategy: "RELAXED",
      memberIds: [],
    });
    expect(effectFor([sinDeclarar], "m1", "2026-09-05", "LUNCH").kind).toBe("NONE");

    // Y el mismo evento, una vez que alguien dice quién de la casa va, sí aplica.
    const declarado = evento({
      memberScope: "DECLARED_ROSTER",
      strategy: "RELAXED",
      memberIds: ["m1"],
    });
    expect(effectFor([declarado], "m1", "2026-09-05", "LUNCH").kind).toBe("RELAXED");
    expect(effectFor([declarado], "m2", "2026-09-05", "LUNCH").kind).toBe("NONE");
  });
});
