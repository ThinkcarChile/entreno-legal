import { DEFAULT_BBQ_QUANTITY_POLICY, estimateBbqQuantity } from "@/domain/events/bbq/quantity";
import type {
  BbqCutDefinitionInput,
  BbqEquipmentInput,
  BbqIngredientYieldInput,
  BbqInventoryLotInput,
  BbqMenuItemInput,
  BbqObservedYieldInput,
  BbqParticipantInput,
  BbqQuantityPolicy,
  BbqQuantityResult,
} from "@/domain/events/bbq/types";
import type { ContextoPlan } from "./contrato-estimacion";

/**
 * EL ÚNICO ENCHUFE ENTRE LA PANTALLA Y EL MOTOR `bbq-quantity/1.0.0`.
 *
 * La superficie no calcula kilos: arma la entrada desde la base, se la pasa al
 * motor puro y congela el resultado en una revisión. Que el enchufe sea UNO y
 * esté acá es a propósito — si la pantalla pudiera estimar por su cuenta,
 * aunque fuera "solo para previsualizar", existirían dos números de carne en el
 * sistema y tarde o temprano el que se ve y el que se compró dejarían de ser el
 * mismo.
 */

/**
 * Lo que el motor necesita saber del mundo físico y que NO sale del evento:
 * rendimientos de los cortes, lo que el hogar ya observó, lo que hay en la
 * despensa y de qué tamaño es la parrilla.
 *
 * El inventario es el dato delicado: tiene que venir ya neteado de reservas
 * (disponible = en mano − reservado para otra comida). Un lote apartado para el
 * almuerzo del martes no está disponible para el asado del sábado, y contarlo
 * dos veces hace comprar de menos.
 */
export interface InsumosFisicos {
  cutDefinitions: BbqCutDefinitionInput[];
  ingredientYields: BbqIngredientYieldInput[];
  observedYields: BbqObservedYieldInput[];
  inventory: BbqInventoryLotInput[];
  equipment: BbqEquipmentInput[];
}

export type ResultadoMotor =
  | {
      ok: true;
      salida: BbqQuantityResult;
      /** La política EXACTA con la que se calculó, para congelarla (§94). */
      politica: BbqQuantityPolicy;
    }
  | { ok: false; motivo: string };

/**
 * Estima y devuelve el resultado del motor tal cual.
 *
 * No se traduce ni se recorta acá: lo que se congela en la revisión es la
 * salida completa del motor, con sus razones y sus desconocidos. Recortarla
 * para "lo que la pantalla muestra hoy" haría que la revisión de ayer no se
 * pueda explicar con la pantalla de mañana.
 */
export function estimarAsado(entrada: {
  contexto: ContextoPlan;
  participantes: BbqParticipantInput[];
  menu: BbqMenuItemInput[];
  insumos: InsumosFisicos;
}): ResultadoMotor {
  const { contexto, participantes, menu, insumos } = entrada;

  // "Quiero que sobre una cantidad que yo digo" sin la cantidad escrita no se
  // puede calcular: poner cero convertiría una decisión a medias en "no quiero
  // que sobre nada", que es lo contrario de lo que la persona eligió.
  if (contexto.desiredLeftover.kind === "CUSTOM" && contexto.desiredLeftover.customG === null) {
    return {
      ok: false,
      motivo:
        "Elegiste que sobre una cantidad tuya pero no escribiste cuánta. Dinos cuántos gramos " +
        "quieres que sobren y volvemos a calcular.",
    };
  }

  // El motor no tiene un caso "no declarado" para el sobrante: mientras la
  // persona no elija, se le pasa NONE. La diferencia NO se pierde: el contexto
  // congelado guarda el `null`, así que la revisión sigue distinguiendo "dijo
  // que no quiere sobras" de "todavía no lo ha pensado".
  const desiredLeftover =
    contexto.desiredLeftover.kind === "CUSTOM"
      ? { kind: "CUSTOM" as const, grams: contexto.desiredLeftover.customG as number }
      : {
          kind: (contexto.desiredLeftover.kind === null
            ? "NONE"
            : contexto.desiredLeftover.kind) as "NONE" | "SMALL_BUFFER" | "ONE_EXTRA_MEAL",
        };

  const salida = estimateBbqQuantity({
    eventDate: contexto.eventDate,
    participants: participantes,
    menu,
    sidesLevel: contexto.sidesLevel,
    mealContext: contexto.mealContext,
    durationHours: contexto.durationHours,
    desiredLeftover,
    safetyBufferPct: contexto.safetyBufferPct,
    cutDefinitions: insumos.cutDefinitions,
    ingredientYields: insumos.ingredientYields,
    observedYields: insumos.observedYields,
    inventory: insumos.inventory,
    equipment: insumos.equipment,
    // Las tandas sobre el plan ACEPTADO son de la pantalla de compras: mientras
    // no haya un plan comprometido, el motor las devuelve como rango y eso es
    // lo correcto (cuántas tandas dependen de cuánto se compre).
    acceptedPlanRawEdibleG: null,
    policy: DEFAULT_BBQ_QUANTITY_POLICY,
  });

  return { ok: true, salida, politica: DEFAULT_BBQ_QUANTITY_POLICY };
}
