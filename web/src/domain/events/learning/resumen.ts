/**
 * `event-summary/1.0.0` — el resumen del asado (§56), como LECTURA.
 *
 * Puro y sin base: recibe los hechos ya persistidos y los cruza. No calcula
 * nada que no esté declarado y no cierra el balance donde falta un número.
 *
 * DOS COSAS QUE ESTE ARCHIVO SE NIEGA A HACER:
 *
 *   1. RESTAR ENTRE BASES DISTINTAS. El peso que entró es CRUDO y lo que salió
 *      a la mesa es COCIDO. "5.000 g comprados menos 3.550 g servidos = 1.450 g
 *      de merma" es un número que no existe: la diferencia es, sobre todo, agua
 *      que se evaporó. El crudo se MUESTRA al lado, rotulado, y no se resta de
 *      nada (§12).
 *
 *   2. CERRAR EL BALANCE RELLENANDO. Si de un corte nadie declaró ni sobra ni
 *      merma, lo consumido es UNKNOWN: pudo comerse entero o pudo botarse
 *      entero, y el sistema no elige. Lo que sí se puede afirmar sin que nadie
 *      declare nada es cuánto de lo servido NO salió de un lote registrado, que
 *      es una resta entre dos números de la MISMA base.
 */

export interface LineaBalanceInput {
  ref: string;
  label: string;
  unit: "G" | "ML" | "UNIT";
  /** Lo que salió a la mesa, del libro mayor. null = no se registró servido. */
  servedG: number | null;
  /** Cuánto de eso el libro mayor pudo respaldar con lotes. */
  deductedG: number | null;
  /** Peso CRUDO que entró. Se muestra, no se resta: es otra base. */
  rawInputG: number | null;
  edibleLeftoverG: number | null;
  plateWasteG: number | null;
  trimWasteG: number | null;
  boneDiscardG: number | null;
  spoiledG: number | null;
}

export interface LineaBalance extends LineaBalanceInput {
  /**
   * Servido menos los destinos declarados. `null` cuando no se declaró NINGÚN
   * destino: sin eso, "cuánto se comieron" no se sabe.
   */
  consumedG: number | null;
  /**
   * Servido que no salió de un lote registrado. No es un error del sistema —la
   * carne pudo comprarse y nunca anotarse— pero tampoco es cero.
   */
  sinRespaldoG: number | null;
  /** true = se puede decir cuánto se comió de este corte. */
  cierra: boolean;
}

/**
 * La asistencia del evento, por PERSONA y no por evento.
 *
 * Tres estados, porque son tres hechos distintos:
 *
 *  · NINGUNA — nadie pasó lista. El caso normal: el anfitrión estaba asando.
 *    NO trae ningún campo que pueda leerse como "asistieron 0".
 *  · PARCIAL — pasaron lista A MEDIAS. El defecto que cierra: con tres marcados
 *    de doce confirmados, el resumen decía "3 asistieron, 0 no llegaron, de 12
 *    confirmadas" y lo mostraba como hecho; los nueve que nadie miró quedaban
 *    convertidos en ausentes. Acá salen aparte, en `sinMarcar`.
 *  · COMPLETA — todos los esperados tienen marca. Recién acá el conteo es un
 *    hecho y no un piso.
 *
 * `extras` va SIEMPRE aparte de `asistieron`: quien llegó sin estar en la lista
 * (§43) es un asistente real, pero no es "uno de los confirmados que llegó", y
 * sumarlos inflaba la tasa de realización por encima de 1.
 */
export type AsistenciaResumen =
  | { cobertura: "NINGUNA"; esperados: number }
  | {
      cobertura: "PARCIAL";
      asistieron: number;
      noLlegaron: number;
      sinMarcar: number;
      esperados: number;
      extras: number;
    }
  | {
      cobertura: "COMPLETA";
      asistieron: number;
      noLlegaron: number;
      esperados: number;
      extras: number;
    };

export interface ResumenEventoInput {
  asistencia: {
    /** Confirmados que TODAVÍA no tienen marca. No son ausentes: nadie los miró. */
    confirmadosSinMarcar: number;
    /** Con marca ATTENDED, sin contar a los que llegaron sin estar en la lista. */
    asistieron: number;
    noLlegaron: number;
    /** Llegaron sin estar invitados (§43). Cuentan como comensales, no como confirmados. */
    extras: number;
  };
  lineas: readonly LineaBalanceInput[];
  /** Lo comprado para este evento, si la lista lo dice. null = no se sabe. */
  compradoG: number | null;
  /** Sobras que efectivamente volvieron al inventario como lote. */
  sobraEnLotesG: number | null;
}

export interface ResumenEvento {
  version: string;
  asistencia: AsistenciaResumen;
  lineas: readonly LineaBalance[];
  totales: {
    servidoG: number | null;
    compradoG: number | null;
    sobraEnLotesG: number | null;
    consumidoG: number | null;
    sinRespaldoG: number | null;
  };
  /** Cortes de los que NO se puede decir cuánto se comió. Se muestran. */
  lineasSinCerrar: readonly string[];
}

export const EVENT_SUMMARY_VERSION = "event-summary/1.0.0";

/** Suma que devuelve null si TODOS los sumandos son null: UNKNOWN no es cero. */
function sumaConocida(valores: readonly (number | null)[]): number | null {
  let hay = false;
  let total = 0;
  for (const v of valores) {
    if (v === null) continue;
    hay = true;
    total += v;
  }
  return hay ? total : null;
}

function redondear(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function resumirEvento(input: ResumenEventoInput): ResumenEvento {
  const marcas = input.asistencia.asistieron + input.asistencia.noLlegaron;
  const esperados =
    input.asistencia.confirmadosSinMarcar + input.asistencia.asistieron + input.asistencia.noLlegaron;
  const asistencia: AsistenciaResumen =
    marcas === 0
      ? // Cero marcas = nadie pasó lista. NO es "no llegó nadie": el anfitrión
        // estaba asando. La pantalla cae a los confirmados, rotulados como
        // estimación.
        { cobertura: "NINGUNA", esperados }
      : input.asistencia.confirmadosSinMarcar > 0
        ? {
            // Lista a medias: lo marcado es verdad y lo no marcado es
            // desconocido. Ninguna de las dos cosas se convierte en la otra.
            cobertura: "PARCIAL",
            asistieron: input.asistencia.asistieron,
            noLlegaron: input.asistencia.noLlegaron,
            sinMarcar: input.asistencia.confirmadosSinMarcar,
            esperados,
            extras: input.asistencia.extras,
          }
        : {
            cobertura: "COMPLETA",
            asistieron: input.asistencia.asistieron,
            noLlegaron: input.asistencia.noLlegaron,
            esperados,
            extras: input.asistencia.extras,
          };

  const lineas: LineaBalance[] = input.lineas.map((l) => {
    const sinRespaldoG =
      l.servedG === null || l.deductedG === null
        ? null
        : redondear(Math.max(l.servedG - l.deductedG, 0));

    if (l.servedG === null) {
      return { ...l, consumedG: null, sinRespaldoG, cierra: false };
    }

    const destinos = sumaConocida([l.edibleLeftoverG, l.plateWasteG, l.spoiledG]);
    if (destinos === null) {
      return { ...l, consumedG: null, sinRespaldoG, cierra: false };
    }

    return {
      ...l,
      consumedG: redondear(Math.max(l.servedG - destinos, 0)),
      sinRespaldoG,
      cierra: true,
    };
  });

  return {
    version: EVENT_SUMMARY_VERSION,
    asistencia,
    lineas,
    totales: {
      servidoG: sumaConocida(lineas.map((l) => l.servedG)),
      compradoG: input.compradoG,
      sobraEnLotesG: input.sobraEnLotesG,
      consumidoG: sumaConocida(lineas.map((l) => l.consumedG)),
      sinRespaldoG: sumaConocida(lineas.map((l) => l.sinRespaldoG)),
    },
    lineasSinCerrar: lineas.filter((l) => !l.cierra).map((l) => l.label),
  };
}
