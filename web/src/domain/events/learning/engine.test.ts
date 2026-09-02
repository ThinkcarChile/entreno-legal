import { describe, expect, it } from "vitest";
import { learnFromBbqEvents, partirSobra } from "./engine";
import {
  DEFAULT_BBQ_LEARNING_POLICY,
  type BbqLearningEventInput,
  type GuestObservationFact,
} from "./types";

/**
 * Los dos defectos ALTOS que este motor vino a cerrar, escritos como tests que
 * FALLAN si el arreglo se revierte:
 *
 *   · UNKNOWN leído como cero: un asado sin sobra declarada NO puede entrar a
 *     leftover_rate como 0, y un asado donde nadie pasó lista NO puede entrar
 *     como 0% de asistencia.
 *   · Aprender de lo que nadie declaró: sin observaciones por invitado no hay
 *     tendencia por invitado, aunque haya diez asados con todo lo demás.
 */

function evento(over: Partial<BbqLearningEventInput> = {}): BbqLearningEventInput {
  return {
    eventId: "e1",
    eventDate: "2026-09-12",
    title: "Asado",
    attendance: { confirmed: 10, marks: 10, attended: 10, noShow: 0, extras: 0 },
    servedG: 8000,
    recommendedPurchaseG: 9000,
    purchasedG: 9000,
    leftover: { known: true, edibleG: 800, source: "LOT" },
    guestObservations: [],
    ...over,
  };
}

function tres(over: Partial<BbqLearningEventInput> = {}): BbqLearningEventInput[] {
  return ["2026-07-11", "2026-08-08", "2026-09-12"].map((fecha, i) =>
    evento({ eventId: `e${i + 1}`, eventDate: fecha, ...over }),
  );
}

describe("[ALTO] la sobra no declarada NO es sobra cero", () => {
  it("un asado sin registro de sobra queda fuera de la tasa, no entra como 0", () => {
    const conDatos = tres();
    const sinDato = evento({
      eventId: "e4",
      eventDate: "2026-06-06",
      leftover: { known: false },
    });

    const soloConDatos = learnFromBbqEvents(conDatos);
    const conElMudo = learnFromBbqEvents([...conDatos, sinDato]);

    expect(soloConDatos.leftoverRate.known).toBe(true);
    expect(conElMudo.leftoverRate.known).toBe(true);
    if (!soloConDatos.leftoverRate.known || !conElMudo.leftoverRate.known) return;

    // Si el evento mudo entrara como sobra 0, la tasa BAJARÍA (más servido, la
    // misma sobra). Tiene que quedar idéntica.
    expect(conElMudo.leftoverRate.value).toBe(soloConDatos.leftoverRate.value);
    expect(conElMudo.leftoverRate.eventsWithData).toBe(3);
    expect(conElMudo.reasons.map((r) => r.code)).toContain("EVENT_WITHOUT_LEFTOVER_FACT");
  });

  it("con dos asados con datos no hay tasa, y dice cuántos faltan", () => {
    const r = learnFromBbqEvents([
      evento({ eventId: "a" }),
      evento({ eventId: "b" }),
      evento({ eventId: "c", leftover: { known: false } }),
    ]);
    expect(r.leftoverRate.known).toBe(false);
    if (r.leftoverRate.known) return;
    expect(r.leftoverRate.eventsWithData).toBe(2);
    expect(r.leftoverRate.eventsRequired).toBe(DEFAULT_BBQ_LEARNING_POLICY.minEventsPerMetric);
  });

  it("un asado sin registro de servido tampoco entra", () => {
    const r = learnFromBbqEvents([
      ...tres(),
      evento({ eventId: "mudo", servedG: null, leftover: { known: true, edibleG: 0, source: "DECLARED" } }),
    ]);
    expect(r.leftoverRate.known).toBe(true);
    if (!r.leftoverRate.known) return;
    expect(r.leftoverRate.eventsWithData).toBe(3);
    expect(r.reasons.map((r2) => r2.code)).toContain("EVENT_WITHOUT_SERVING_RECORD");
  });
});

describe("[ALTO] nadie pasó lista no es nadie llegó", () => {
  it("los asados sin marcas quedan fuera de la realización de asistencia", () => {
    const conMarcas = tres();
    const sinMarcas = evento({
      eventId: "sinlista",
      eventDate: "2026-05-05",
      attendance: { confirmed: 12, marks: 0, attended: 0, noShow: 0, extras: 0 },
    });

    const solo = learnFromBbqEvents(conMarcas);
    const conMudo = learnFromBbqEvents([...conMarcas, sinMarcas]);

    expect(solo.attendanceRealization.known).toBe(true);
    expect(conMudo.attendanceRealization.known).toBe(true);
    if (!solo.attendanceRealization.known || !conMudo.attendanceRealization.known) return;

    // Con el mudo adentro como "0 de 12", la realización caería de 1,0 a 0,71.
    expect(conMudo.attendanceRealization.value).toBe(solo.attendanceRealization.value);
    expect(conMudo.attendanceRealization.value).toBe(1);
    expect(conMudo.reasons.map((r) => r.code)).toContain("EVENT_WITHOUT_ATTENDANCE_MARKS");
  });

  it("una sola marca NO_SHOW ya es haber pasado lista, y mide sobre lo mirado", () => {
    const r = learnFromBbqEvents(
      tres({ attendance: { confirmed: 10, marks: 1, attended: 0, noShow: 1, extras: 0 } }),
    );
    expect(r.attendanceRealization.known).toBe(true);
    if (!r.attendanceRealization.known) return;
    // De la única persona que alguien miró, llegó cero. Es un dato pobre —y la
    // cobertura lo dice— pero es un dato que alguien anotó.
    expect(r.attendanceRealization.value).toBe(0);
    expect(r.reasons.map((x) => x.code)).toContain("ATTENDANCE_PARTIAL_COVERAGE");
  });

  it("[ALTO] los confirmados que NADIE marcó no cuentan como ausentes", () => {
    // Tres asados con doce confirmados donde el anfitrión alcanzó a marcar a
    // nueve, y los nueve llegaron. La verdad medible es 9 de 9.
    //
    // Con el denominador viejo (los confirmados) esto daba 0,75 — "de cada 10
    // confirmadas llegaron 7,5"— inventando tres ausencias por asado que nadie
    // observó, y empujando al hogar a comprar de menos.
    const r = learnFromBbqEvents(
      tres({ attendance: { confirmed: 12, marks: 9, attended: 9, noShow: 0, extras: 0 } }),
    );
    expect(r.attendanceRealization.known).toBe(true);
    if (!r.attendanceRealization.known) return;
    expect(r.attendanceRealization.value).toBe(1);
    expect(r.attendanceRealization.value).not.toBe(0.75);
    // Y la cobertura NO se esconde: se declara cuánto se alcanzó a mirar.
    const cobertura = r.reasons.find((x) => x.code === "ATTENDANCE_PARTIAL_COVERAGE");
    expect(cobertura).toBeDefined();
    expect(cobertura?.params).toEqual({ marcados: 27, confirmados: 36 });
  });

  it("los que llegaron sin invitación se cuentan aparte, no dentro de la tasa", () => {
    const r = learnFromBbqEvents(
      tres({ attendance: { confirmed: 10, marks: 10, attended: 10, noShow: 0, extras: 2 } }),
    );
    expect(r.attendanceRealization.known).toBe(true);
    if (!r.attendanceRealization.known) return;
    // Llegaron los diez que confirmaron: 1,0. Los dos extras son otro hecho
    // —comieron igual— y meterlos adentro daba una tasa de 1,2, que se lee como
    // "llegan más de los que confirman" cuando lo que pasó es otra cosa.
    expect(r.attendanceRealization.value).toBe(1);
    const extras = r.reasons.find((x) => x.code === "ATTENDANCE_EXTRAS");
    expect(extras?.params).toEqual({ extras: 6 });
  });
});

describe("[ALTO] sin hecho por invitado no hay aprendizaje por invitado", () => {
  const juan = (extent: GuestObservationFact["extent"]): GuestObservationFact => ({
    guestRef: "g-juan",
    displayName: "Juan",
    extent,
    currentAppetite: "UNKNOWN",
  });

  it("diez asados sin una sola observación no producen ninguna tendencia", () => {
    const muchos = Array.from({ length: 10 }, (_, i) =>
      evento({ eventId: `e${i}`, eventDate: `2026-0${(i % 9) + 1}-01` }),
    );
    const r = learnFromBbqEvents(muchos);
    expect(r.guestTrends).toHaveLength(0);
    expect(r.suggestions.filter((s) => s.kind === "GUEST_APPETITE")).toHaveLength(0);
    expect(r.reasons.map((x) => x.code)).toContain("GUEST_TREND_NOT_ENOUGH_OBSERVATIONS");
  });

  it("con dos observaciones todavía no se sugiere nada", () => {
    const r = learnFromBbqEvents([
      evento({ eventId: "a", guestObservations: [juan("ATE_A_LOT")] }),
      evento({ eventId: "b", eventDate: "2026-08-08", guestObservations: [juan("ATE_A_LOT")] }),
    ]);
    expect(r.guestTrends).toHaveLength(1);
    expect(r.guestTrends[0]!.suggestedAppetite).toBeNull();
    expect(r.guestTrends[0]!.reason).toBe("GUEST_TREND_NOT_ENOUGH_OBSERVATIONS");
  });

  it("con tres observaciones que coinciden se SUGIERE, y no se aplica", () => {
    const r = learnFromBbqEvents([
      evento({ eventId: "a", eventDate: "2026-07-11", guestObservations: [juan("ATE_A_LOT")] }),
      evento({ eventId: "b", eventDate: "2026-08-08", guestObservations: [juan("ATE_A_LOT")] }),
      evento({ eventId: "c", eventDate: "2026-09-12", guestObservations: [juan("ATE_A_LOT")] }),
    ]);
    const tendencia = r.guestTrends[0]!;
    expect(tendencia.observations).toBe(3);
    expect(tendencia.suggestedAppetite).toBe("HIGH");
    const sug = r.suggestions.find((s) => s.kind === "GUEST_APPETITE");
    expect(sug?.guestRef).toBe("g-juan");
    expect(sug?.autoApplied).toBe(false);
    expect(sug?.text).toContain("¿Marcamos apetito alto");
  });

  it("si comió distinto cada vez, no hay tendencia que sugerir", () => {
    const r = learnFromBbqEvents([
      evento({ eventId: "a", eventDate: "2026-07-11", guestObservations: [juan("ATE_A_LOT")] }),
      evento({ eventId: "b", eventDate: "2026-08-08", guestObservations: [juan("ATE_LITTLE")] }),
      evento({ eventId: "c", eventDate: "2026-09-12", guestObservations: [juan("ATE_NORMAL")] }),
    ]);
    expect(r.guestTrends[0]!.reason).toBe("GUEST_TREND_NO_AGREEMENT");
    expect(r.suggestions.filter((s) => s.kind === "GUEST_APPETITE")).toHaveLength(0);
  });

  it("no sugiere lo que la ficha ya dice", () => {
    const conApetito = (extent: GuestObservationFact["extent"]): GuestObservationFact => ({
      ...juan(extent),
      currentAppetite: "HIGH",
    });
    const r = learnFromBbqEvents([
      evento({ eventId: "a", eventDate: "2026-07-11", guestObservations: [conApetito("ATE_A_LOT")] }),
      evento({ eventId: "b", eventDate: "2026-08-08", guestObservations: [conApetito("ATE_A_LOT")] }),
      evento({ eventId: "c", eventDate: "2026-09-12", guestObservations: [conApetito("ATE_A_LOT")] }),
    ]);
    expect(r.guestTrends[0]!.reason).toBe("GUEST_APPETITE_ALREADY_SET");
    expect(r.suggestions.filter((s) => s.kind === "GUEST_APPETITE")).toHaveLength(0);
  });
});

describe("la sobra del envase no es sobra del apetito", () => {
  it("separa el excedente del redondeo comercial de la sobre-estimación", () => {
    // Recomendado 8.400, comprado 10.000 (cajas de 5 kg), sobró 1.800:
    // 1.600 los puso el envase y sólo 200 la estimación.
    const s = partirSobra(
      evento({
        recommendedPurchaseG: 8400,
        purchasedG: 10000,
        leftover: { known: true, edibleG: 1800, source: "LOT" },
      }),
    );
    expect(s.known).toBe(true);
    if (!s.known) return;
    expect(s.roundingG).toBe(1600);
    expect(s.overEstimateG).toBe(200);
  });

  it("no sugiere comprar menos cuando la sobra la explica el envase", () => {
    const r = learnFromBbqEvents(
      tres({
        servedG: 8000,
        recommendedPurchaseG: 8400,
        purchasedG: 10000,
        leftover: { known: true, edibleG: 1700, source: "LOT" },
      }),
    );
    expect(r.leftoverRate.known).toBe(true);
    expect(r.overEstimateRate.known).toBe(true);
    if (!r.overEstimateRate.known || !r.leftoverRate.known) return;
    // La tasa cruda es 21% y aun así no se sugiere nada: 1.600 de esos 1.700
    // los puso la caja de 5 kg.
    expect(r.leftoverRate.value).toBeGreaterThan(0.2);
    expect(r.overEstimateRate.value).toBeCloseTo(0.0125, 6);
    expect(r.suggestions.filter((s) => s.kind === "BUY_LESS")).toHaveLength(0);
    expect(r.reasons.map((x) => x.code)).toContain("LEFTOVER_SPLIT_ROUNDING");
  });

  it("sugiere comprar menos cuando la sobra NO la explica el envase, y acota el ajuste", () => {
    const r = learnFromBbqEvents(
      tres({
        servedG: 8000,
        recommendedPurchaseG: 9000,
        purchasedG: 9000,
        leftover: { known: true, edibleG: 2400, source: "LOT" },
      }),
    );
    const sug = r.suggestions.find((s) => s.kind === "BUY_LESS");
    expect(sug).toBeDefined();
    // 30% de sobra atribuible, pero el ajuste sugerido está topado en 15%.
    expect(sug?.adjustPct).toBe(DEFAULT_BBQ_LEARNING_POLICY.maxSuggestedAdjustPct);
    expect(sug?.autoApplied).toBe(false);
  });

  it("sin referencia de compra no se atribuye la sobra a nadie", () => {
    const r = learnFromBbqEvents(tres({ recommendedPurchaseG: null, purchasedG: null }));
    expect(r.leftoverRate.known).toBe(true);
    expect(r.overEstimateRate.known).toBe(false);
    if (r.overEstimateRate.known) return;
    expect(r.overEstimateRate.reason).toBe("EVENT_WITHOUT_PURCHASE_REFERENCE");
    expect(r.suggestions.filter((s) => s.kind === "BUY_LESS")).toHaveLength(0);
  });
});

describe("el motor es puro y estable", () => {
  it("la misma entrada en otro orden da la misma salida", () => {
    const base = tres();
    const a = learnFromBbqEvents(base);
    const b = learnFromBbqEvents([...base].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("sin eventos no inventa ninguna métrica", () => {
    const r = learnFromBbqEvents([]);
    expect(r.leftoverRate.known).toBe(false);
    expect(r.attendanceRealization.known).toBe(false);
    expect(r.suggestions).toHaveLength(0);
    expect(r.reasons.map((x) => x.code)).toContain("NO_EVENTS");
  });

  it("declara su versión y la de su política", () => {
    const r = learnFromBbqEvents(tres());
    expect(r.engineVersion).toBe("bbq-learning/1.0.0");
    expect(r.policyVersion).toBe("bbq-learning-policy/1.0.0");
    expect(r.policySource.length).toBeGreaterThan(20);
  });
});
