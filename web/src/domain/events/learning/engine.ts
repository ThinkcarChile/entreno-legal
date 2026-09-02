/**
 * `bbq-learning/1.0.0` — comparar lo estimado con lo real, sin inventar nada.
 *
 * PURO: sin reloj, sin red, sin base. Las fechas entran por input y la misma
 * entrada produce la misma salida byte a byte.
 *
 * NO ESCRIBE HISTORIA. Lee hechos ya persistidos (servido del libro mayor,
 * sobras, marcas de asistencia, observaciones declaradas) y devuelve
 * SUGERENCIAS que una persona confirma. El default de producto no cambia solo
 * y la historia no se reescribe (§51, §95).
 *
 * LOS DOS DEFECTOS QUE ESTE ARCHIVO EXISTE PARA NO TENER:
 *
 *   1. UNKNOWN LEÍDO COMO CERO. `leftover_rate = sobra / servido` sobre "los N
 *      últimos eventos COMPLETED" mete como 0 todo asado del que nadie guardó
 *      sobras — y "se comió todo" es la conclusión más cara posible: empuja a
 *      comprar más, evento tras evento. Acá cada métrica tiene su propio
 *      universo de eventos: sólo entran los que tienen EL dato de ESA métrica,
 *      y el mínimo de la política se cuenta sobre ese universo, no sobre la
 *      cantidad de asados.
 *
 *   2. APRENDER DE ALGO QUE NADIE DECLARÓ. La tendencia por invitado sale
 *      exclusivamente de observaciones ordinales escritas a mano. No hay —ni en
 *      el tipo, ni en el código— forma de derivarla del total servido dividido
 *      entre los asistentes: eso sería fabricar la distribución individual que
 *      el §48 prohíbe y después aprender del invento.
 */

import type {
  BbqLearningEventInput,
  BbqLearningPolicy,
  BbqLearningReason,
  BbqLearningReasonCode,
  BbqLearningResult,
  GuestIntakeExtent,
  GuestTrend,
  LearningMetric,
  LearningSuggestion,
  LeftoverSplit,
} from "./types";
import {
  BBQ_LEARNING_VERSION,
  DEFAULT_BBQ_LEARNING_POLICY,
} from "./types";

/**
 * Formateo propio en vez de `toLocaleString`: el ICU del entorno puede cambiar
 * el separador decimal, y el texto de una razón es parte de la salida que tiene
 * que ser idéntica en cualquier máquina.
 */
function fmt(value: number): string {
  const total = Math.round(Math.abs(value) * 10);
  const entero = Math.floor(total / 10);
  const decimal = total % 10;
  const miles = String(entero).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cuerpo = decimal > 0 ? `${miles},${decimal}` : miles;
  return value < 0 ? `-${cuerpo}` : cuerpo;
}

function pct(value: number): string {
  return `${fmt(value * 100)}%`;
}

function kg(gramos: number): string {
  return `${fmt(Math.round(gramos / 100) / 10)} kg`;
}

/** Redondeo a 1e-6: dos motores de JavaScript tienen que dar el MISMO número. */
function estable(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function razon(
  code: BbqLearningReasonCode,
  params: Record<string, string | number>,
  text: string,
): BbqLearningReason {
  return { code, params, text };
}

/* ========================================================================== */
/* Métricas                                                                    */
/* ========================================================================== */

/**
 * La sobra de UN evento, partida en redondeo y sobre-estimación.
 *
 * Necesita las dos referencias de compra. Sin ellas se sabe CUÁNTO sobró pero
 * no POR QUÉ, y atribuirlo entero a la estimación sería culpar al apetito de la
 * familia por el tamaño del envase del proveedor.
 */
export function partirSobra(evento: BbqLearningEventInput): LeftoverSplit {
  if (!evento.leftover.known) {
    return { known: false, reason: "EVENT_WITHOUT_LEFTOVER_FACT" };
  }
  if (evento.recommendedPurchaseG === null || evento.purchasedG === null) {
    return { known: false, reason: "EVENT_WITHOUT_PURCHASE_REFERENCE" };
  }
  const excedente = Math.max(evento.purchasedG - evento.recommendedPurchaseG, 0);
  // El redondeo sólo puede explicar sobra que efectivamente sobró: si sobró
  // menos de lo que el envase agregó, el resto se lo comieron y no hay nada que
  // corregir hacia abajo.
  const porRedondeo = Math.min(excedente, evento.leftover.edibleG);
  return {
    known: true,
    roundingG: estable(porRedondeo),
    overEstimateG: estable(evento.leftover.edibleG - porRedondeo),
  };
}

function metricaFaltante(
  reason: BbqLearningReasonCode,
  eventsWithData: number,
  eventsRequired: number,
): LearningMetric {
  return { known: false, reason, eventsWithData, eventsRequired };
}

/* ========================================================================== */
/* Motor                                                                       */
/* ========================================================================== */

export function learnFromBbqEvents(
  eventos: readonly BbqLearningEventInput[],
  policy: BbqLearningPolicy = DEFAULT_BBQ_LEARNING_POLICY,
): BbqLearningResult {
  const reasons: BbqLearningReason[] = [];
  const suggestions: LearningSuggestion[] = [];

  // Orden estable de entrada: la salida no puede depender de cómo vino la lista.
  const ordenados = [...eventos].sort((a, b) => {
    if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? 1 : -1;
    return a.eventId.localeCompare(b.eventId);
  });

  if (ordenados.length === 0) {
    reasons.push(
      razon("NO_EVENTS", {}, "Todavía no hay asados cerrados de los que aprender."),
    );
  }

  /* --- Sobra: sólo eventos con servido Y con hecho de sobra ------------- */

  const conSobra = ordenados.filter((e) => e.servedG !== null && e.leftover.known);
  const sinServido = ordenados.filter((e) => e.servedG === null).length;
  const sinSobra = ordenados.filter((e) => e.servedG !== null && !e.leftover.known).length;

  if (sinServido > 0) {
    reasons.push(
      razon(
        "EVENT_WITHOUT_SERVING_RECORD",
        { cantidad: sinServido },
        `${sinServido} asado(s) sin registro de lo que salió a la mesa: quedan fuera del cálculo de sobra, no entran como cero.`,
      ),
    );
  }
  if (sinSobra > 0) {
    reasons.push(
      razon(
        "EVENT_WITHOUT_LEFTOVER_FACT",
        { cantidad: sinSobra },
        `${sinSobra} asado(s) donde nadie anotó si sobró algo: no se sabe, y no saber no es "no sobró".`,
      ),
    );
  }

  let leftoverRate: LearningMetric;
  if (conSobra.length < policy.minEventsPerMetric) {
    leftoverRate = metricaFaltante(
      "NOT_ENOUGH_EVENTS_WITH_DATA",
      conSobra.length,
      policy.minEventsPerMetric,
    );
  } else {
    let servido = 0;
    let sobra = 0;
    for (const e of conSobra) {
      // `e.servedG !== null` ya está garantizado por el filtro; se vuelve a
      // preguntar porque TypeScript no arrastra el filtro y porque un `!` acá
      // sería exactamente la clase de atajo que este proyecto no usa.
      if (e.servedG === null || !e.leftover.known) continue;
      servido += e.servedG;
      sobra += e.leftover.edibleG;
    }
    if (servido <= 0) {
      // Servido cero en todos los eventos con dato: dividir daría infinito o
      // NaN, y ninguno de los dos es una tasa.
      leftoverRate = metricaFaltante(
        "EVENT_WITHOUT_SERVING_RECORD",
        conSobra.length,
        policy.minEventsPerMetric,
      );
    } else {
      leftoverRate = {
        known: true,
        value: estable(sobra / servido),
        eventsWithData: conSobra.length,
        eventsRequired: policy.minEventsPerMetric,
      };
      reasons.push(
        razon(
          "LEFTOVER_RATE_MEASURED",
          { tasa: leftoverRate.value, eventos: conSobra.length },
          `En ${conSobra.length} asado(s) con datos completos sobró ${pct(leftoverRate.value)} de lo que salió a la mesa.`,
        ),
      );
    }
  }

  /* --- Sobra atribuible: la que el redondeo comercial NO explica -------- */

  const splits = ordenados.map((e) => ({ eventId: e.eventId, ...partirSobra(e) }));
  const conSplit = ordenados.filter(
    (e) => e.servedG !== null && partirSobra(e).known,
  );

  let overEstimateRate: LearningMetric;
  if (conSplit.length < policy.minEventsPerMetric) {
    overEstimateRate = metricaFaltante(
      conSplit.length === 0 && conSobra.length > 0
        ? "EVENT_WITHOUT_PURCHASE_REFERENCE"
        : "NOT_ENOUGH_EVENTS_WITH_DATA",
      conSplit.length,
      policy.minEventsPerMetric,
    );
    if (conSobra.length >= policy.minEventsPerMetric) {
      reasons.push(
        razon(
          "LEFTOVER_SPLIT_UNKNOWN",
          { cantidad: conSobra.length - conSplit.length },
          "Sobró, pero sin saber cuánto se compró de más por el tamaño del envase no se puede decir que la culpa sea de la estimación.",
        ),
      );
    }
  } else {
    let servido = 0;
    let atribuible = 0;
    let porRedondeo = 0;
    for (const e of conSplit) {
      const s = partirSobra(e);
      if (e.servedG === null || !s.known) continue;
      servido += e.servedG;
      atribuible += s.overEstimateG;
      porRedondeo += s.roundingG;
    }
    if (servido <= 0) {
      overEstimateRate = metricaFaltante(
        "EVENT_WITHOUT_SERVING_RECORD",
        conSplit.length,
        policy.minEventsPerMetric,
      );
    } else {
      overEstimateRate = {
        known: true,
        value: estable(atribuible / servido),
        eventsWithData: conSplit.length,
        eventsRequired: policy.minEventsPerMetric,
      };
      if (porRedondeo > 0) {
        reasons.push(
          razon(
            "LEFTOVER_SPLIT_ROUNDING",
            { gramos: porRedondeo },
            `${kg(porRedondeo)} de esa sobra vienen del tamaño de los envases, no de la estimación.`,
          ),
        );
      }
      if (overEstimateRate.value >= policy.minOverEstimateRateToSuggest) {
        const ajuste = estable(
          Math.min(overEstimateRate.value, policy.maxSuggestedAdjustPct),
        );
        suggestions.push({
          kind: "BUY_LESS",
          guestRef: null,
          adjustPct: ajuste,
          appetite: null,
          text:
            `En tus últimos ${conSplit.length} asados sobró ${pct(overEstimateRate.value)} que el tamaño de los envases no explica. ` +
            `Podrías comprar ${pct(ajuste)} menos la próxima vez.`,
          autoApplied: false,
        });
        reasons.push(
          razon(
            "SUGGEST_BUY_LESS",
            { ajuste, tope: policy.maxSuggestedAdjustPct },
            `El ajuste sugerido está acotado a ${pct(policy.maxSuggestedAdjustPct)} y no se aplica solo: lo confirmas tú.`,
          ),
        );
      } else {
        reasons.push(
          razon(
            "SUGGEST_NOTHING_TO_CHANGE",
            { tasa: overEstimateRate.value },
            `La sobra que no explica el envase es ${pct(overEstimateRate.value)}: muy poca para cambiar nada.`,
          ),
        );
      }
    }
  }

  /* --- Asistencia: sólo donde alguien pasó lista ------------------------ */

  const conMarcas = ordenados.filter((e) => e.attendance.marks > 0);
  const sinMarcas = ordenados.length - conMarcas.length;
  if (sinMarcas > 0) {
    reasons.push(
      razon(
        "EVENT_WITHOUT_ATTENDANCE_MARKS",
        { cantidad: sinMarcas },
        `${sinMarcas} asado(s) donde nadie pasó lista: no se cuentan como "no llegó nadie", se quedan fuera.`,
      ),
    );
  }

  let attendanceRealization: LearningMetric;
  if (conMarcas.length < policy.minEventsPerMetric) {
    attendanceRealization = metricaFaltante(
      "NOT_ENOUGH_EVENTS_WITH_DATA",
      conMarcas.length,
      policy.minEventsPerMetric,
    );
  } else {
    // EL DENOMINADOR SON LOS MARCADOS, NO LOS CONFIRMADOS. Si el anfitrión
    // alcanzó a marcar a tres de doce, los otros nueve no llegaron ni faltaron:
    // nadie los miró. Dividir por doce los convierte en ausentes inventados y
    // el aprendizaje empieza a recomendar comprar para menos gente.
    let marcados = 0;
    let llegaron = 0;
    let confirmados = 0;
    let extras = 0;
    for (const e of conMarcas) {
      marcados += e.attendance.attended + e.attendance.noShow;
      llegaron += e.attendance.attended;
      confirmados += e.attendance.confirmed;
      extras += e.attendance.extras;
    }
    if (marcados <= 0) {
      attendanceRealization = metricaFaltante(
        "EVENT_WITHOUT_ATTENDANCE_MARKS",
        conMarcas.length,
        policy.minEventsPerMetric,
      );
    } else {
      attendanceRealization = {
        known: true,
        value: estable(llegaron / marcados),
        eventsWithData: conMarcas.length,
        eventsRequired: policy.minEventsPerMetric,
      };
      reasons.push(
        razon(
          "ATTENDANCE_REALIZATION_MEASURED",
          { tasa: attendanceRealization.value, eventos: conMarcas.length },
          `De cada 10 personas a las que alguien miró, llegaron ${fmt(attendanceRealization.value * 10)}, medido en ${conMarcas.length} asado(s) donde se pasó lista.`,
        ),
      );
      if (marcados < confirmados) {
        reasons.push(
          razon(
            "ATTENDANCE_PARTIAL_COVERAGE",
            { marcados, confirmados },
            `Se pasó lista a ${marcados} de ${confirmados} confirmadas: de las otras no se sabe si llegaron, y no cuentan como ausentes.`,
          ),
        );
      }
      if (extras > 0) {
        reasons.push(
          razon(
            "ATTENDANCE_EXTRAS",
            { extras },
            `${extras} persona(s) llegaron sin estar en la lista. Van aparte: comieron, pero no eran de los confirmados.`,
          ),
        );
      }
    }
  }

  /* --- Tendencia por invitado: SÓLO desde observaciones declaradas ------ */

  interface Acumulado {
    guestRef: string;
    displayName: string | null;
    counts: Record<GuestIntakeExtent, number>;
    currentAppetite: GuestTrend["currentAppetite"];
  }
  const porInvitado = new Map<string, Acumulado>();

  for (const e of ordenados) {
    for (const obs of e.guestObservations) {
      const previo = porInvitado.get(obs.guestRef);
      if (previo === undefined) {
        porInvitado.set(obs.guestRef, {
          guestRef: obs.guestRef,
          displayName: obs.displayName,
          counts: { ATE_LITTLE: 0, ATE_NORMAL: 0, ATE_A_LOT: 0 },
          currentAppetite: obs.currentAppetite,
        });
      }
      const acc = porInvitado.get(obs.guestRef);
      if (acc === undefined) continue;
      acc.counts[obs.extent] += 1;
      // El nombre y el apetito vigentes son los del evento más reciente, que es
      // el primero del orden: sólo se completan si todavía faltan.
      if (acc.displayName === null) acc.displayName = obs.displayName;
    }
  }

  const guestTrends: GuestTrend[] = [];
  for (const acc of [...porInvitado.values()].sort((a, b) =>
    a.guestRef.localeCompare(b.guestRef),
  )) {
    const total = acc.counts.ATE_LITTLE + acc.counts.ATE_NORMAL + acc.counts.ATE_A_LOT;
    const nombre = acc.displayName ?? "Invitado sin nombre";

    if (total < policy.minGuestObservations) {
      guestTrends.push({
        guestRef: acc.guestRef,
        displayName: acc.displayName,
        observations: total,
        counts: acc.counts,
        currentAppetite: acc.currentAppetite,
        suggestedAppetite: null,
        reason: "GUEST_TREND_NOT_ENOUGH_OBSERVATIONS",
        text: `${nombre}: ${total} observación(es) anotadas. Con menos de ${policy.minGuestObservations} no se sugiere nada.`,
      });
      continue;
    }

    const harto = acc.counts.ATE_A_LOT / total;
    const poco = acc.counts.ATE_LITTLE / total;
    let sugerido: GuestTrend["suggestedAppetite"] = null;
    if (harto >= policy.guestAgreementRatio) sugerido = "HIGH";
    else if (poco >= policy.guestAgreementRatio) sugerido = "LOW";

    if (sugerido === null) {
      guestTrends.push({
        guestRef: acc.guestRef,
        displayName: acc.displayName,
        observations: total,
        counts: acc.counts,
        currentAppetite: acc.currentAppetite,
        suggestedAppetite: null,
        reason: "GUEST_TREND_NO_AGREEMENT",
        text: `${nombre}: comió distinto en cada asado. No hay una tendencia que sugerir.`,
      });
      continue;
    }

    if (acc.currentAppetite === sugerido) {
      guestTrends.push({
        guestRef: acc.guestRef,
        displayName: acc.displayName,
        observations: total,
        counts: acc.counts,
        currentAppetite: acc.currentAppetite,
        suggestedAppetite: null,
        reason: "GUEST_APPETITE_ALREADY_SET",
        text: `${nombre}: su ficha ya dice apetito ${sugerido === "HIGH" ? "alto" : "bajo"}.`,
      });
      continue;
    }

    const texto =
      sugerido === "HIGH"
        ? `${nombre}: comió harto en ${acc.counts.ATE_A_LOT} de ${total} asados. ¿Marcamos apetito alto en su ficha?`
        : `${nombre}: comió poco en ${acc.counts.ATE_LITTLE} de ${total} asados. ¿Marcamos apetito bajo en su ficha?`;

    guestTrends.push({
      guestRef: acc.guestRef,
      displayName: acc.displayName,
      observations: total,
      counts: acc.counts,
      currentAppetite: acc.currentAppetite,
      suggestedAppetite: sugerido,
      reason: "GUEST_TREND_MEASURED",
      text: texto,
    });
    suggestions.push({
      kind: "GUEST_APPETITE",
      guestRef: acc.guestRef,
      adjustPct: null,
      appetite: sugerido,
      text: texto,
      autoApplied: false,
    });
  }

  if (porInvitado.size === 0 && ordenados.length > 0) {
    reasons.push(
      razon(
        "GUEST_TREND_NOT_ENOUGH_OBSERVATIONS",
        { cantidad: 0 },
        "Nadie anotó cuánto comió cada invitado, así que no hay tendencias por persona. El total del asado no se reparte entre los asistentes para inventarlas.",
      ),
    );
  }

  return {
    engineVersion: BBQ_LEARNING_VERSION,
    policyVersion: policy.version,
    policySource: policy.source,
    eventsConsidered: ordenados.length,
    leftoverRate,
    overEstimateRate,
    leftoverSplitByEvent: splits,
    attendanceRealization,
    guestTrends,
    suggestions,
    reasons,
  };
}
