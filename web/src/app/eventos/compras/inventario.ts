import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { columnsOf, nullableNumeric, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { analyzeStock, lotUsable } from "@/domain/stock/engine";
import { loadStockInput } from "@/app/stock/queries";
import type { StockLot } from "@/domain/stock/types";
import type {
  BbqCutDefinitionInput,
  BbqEquipmentInput,
  BbqEquipmentKind,
  BbqIngredientYieldInput,
  BbqInventoryLotInput,
  BbqObservedYieldInput,
  WeightStage,
} from "@/domain/events/bbq/types";
import { ETAPA_DE_BASE_FISICA, tramoDeObservacion } from "./bases";

/**
 * LO QUE EL MUNDO FÍSICO LE DICE AL MOTOR DEL ASADO.
 *
 * Cinco lecturas: la ficha culinaria de cada corte, los rendimientos de
 * cocción, lo que el hogar ya observó, LO QUE HAY EN LA DESPENSA y el tamaño de
 * la parrilla. La delicada es la tercera, y por dos razones:
 *
 *  1. DISPONIBLE NO ES LO QUE HAY. Disponible es lo que hay MENOS lo que ya
 *     está comprometido con las comidas confirmadas de la semana (§29). Ese
 *     cálculo tiene un solo dueño en este proyecto —`analyzeStock`— y acá se
 *     REUSA, no se rehace. Un segundo cálculo de "disponible" es un segundo
 *     número de kilos, y tarde o temprano el que se ve y el que se compró
 *     dejan de ser el mismo.
 *
 *  2. CADA LOTE DECLARA SU ETAPA FÍSICA. Un costillar congelado pesa CON hueso
 *     (etapa de compra); la sobra cocida de otro asado pesa ya cocida. Restar
 *     los dos de frentón contra la demanda de crudo comestible sobreestima la
 *     cobertura y hace comprar de menos, que es el error caro: faltar carne el
 *     sábado a las dos de la tarde. Cada lote viaja con su etapa, y el que
 *     tiene una base que no se puede mapear (escurrido, "como se vende") viaja
 *     con `stage: null` para que el motor lo declare UNKNOWN en vez de netearlo
 *     1:1. El §13 vale para los dos lados de la resta.
 */

type Db = SupabaseClient;

export interface InsumosFisicosCargados {
  cutDefinitions: BbqCutDefinitionInput[];
  ingredientYields: BbqIngredientYieldInput[];
  observedYields: BbqObservedYieldInput[];
  inventory: BbqInventoryLotInput[];
  equipment: BbqEquipmentInput[];
}

const loteColumnas = z.object({
  id: uuid,
  temperature_state: z.enum(["AMBIENT", "CHILLED", "FROZEN"]).nullable(),
});

const cutColumnas = z.object({
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  display_name: z.string(),
  bone_in: z.boolean().nullable(),
  trim_loss_fraction: nullableNumeric,
  servable_fraction: nullableNumeric,
  source: z.string(),
  confidence: z.string(),
});

const rendimientoColumnas = z.object({
  ingredient_id: uuid,
  cooking_method: z.string().nullable(),
  yield_factor: numeric,
  household_id: uuid.nullable(),
});

const observadoColumnas = z.object({
  ingredient_id: uuid,
  cooking_method: z.string().nullable(),
  input_quantity: numeric,
  output_quantity: numeric,
  unit: z.enum(["G", "ML", "UNIT"]),
  basis_in: z.enum(["RAW_PURCHASE", "EDIBLE_RAW", "COOKED", "SERVABLE"]).nullable(),
  basis_out: z.enum(["RAW_PURCHASE", "EDIBLE_RAW", "COOKED", "SERVABLE"]).nullable(),
});

const equipoColumnas = z.object({
  id: uuid,
  capability: z.string(),
  max_batch_quantity: nullableNumeric,
  max_batch_unit: z.enum(["G", "ML", "UNIT"]).nullable(),
});

/**
 * Capacidades del equipamiento del hogar → los cuatro tipos que el motor sabe
 * contar en tandas. `capability` es texto LIBRE (0015 lo hizo así a propósito:
 * jamás una enum cerrada de máquinas), así que acá sólo se reconocen los
 * nombres que se pueden reconocer. Lo que no calza NO se convierte en parrilla:
 * contar las tandas de un asado en la capacidad de una freidora de aire da un
 * número que suena preciso y es inventado.
 */
const EQUIPO_CONOCIDO: { patron: RegExp; tipo: BbqEquipmentKind }[] = [
  { patron: /parrilla|grill|barbec|asador/i, tipo: "GRILL" },
  { patron: /plancha|griddle/i, tipo: "GRIDDLE" },
  { patron: /air.?fryer|freidora/i, tipo: "AIR_FRYER" },
  { patron: /horno|oven/i, tipo: "OVEN" },
];

export function tipoDeEquipo(capability: string): BbqEquipmentKind | null {
  for (const { patron, tipo } of EQUIPO_CONOCIDO) {
    if (patron.test(capability)) return tipo;
  }
  return null;
}

/**
 * Reparte los gramos DISPONIBLES del bucket entre sus lotes, empezando por el
 * final de la cola FEFO.
 *
 * Por qué por el final: los gramos que faltan hasta completar lo que hay en
 * mano están comprometidos con las comidas confirmadas de la semana, y el
 * descuento físico es FEFO —se va primero lo que vence antes—. Así que lo que
 * queda libre para el asado es la cola, no la cabeza. Repartir al revés le
 * asignaría al evento justo los lotes que otra comida ya tiene tomados y el
 * mismo gramo se contaría dos veces.
 *
 * Efecto de borde buscado: como los lotes que vencen más tarde suelen ser los
 * congelados, esta regla tiende a SOBRE-declarar cuánto hay que descongelar. De
 * los dos errores posibles, ese es el barato: una tarea de descongelado de más
 * se ignora, un ladrillo de carne el sábado al mediodía no.
 */
export function repartirDisponible(
  lotes: readonly StockLot[],
  disponible: number,
): { lote: StockLot; gramos: number }[] {
  const ordenados = [...lotes].sort((a, b) => {
    const va = a.useBy ?? a.expiryDate;
    const vb = b.useBy ?? b.expiryDate;
    // Sin fecha de vencimiento no se puede ordenar por FEFO: esos lotes van al
    // final (son los que menos apuran) y desempatan por id para que dos
    // corridas con los mismos datos repartan igual.
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return va.localeCompare(vb);
    }
    return a.id.localeCompare(b.id);
  });

  const reparto: { lote: StockLot; gramos: number }[] = [];
  let porRepartir = disponible;
  for (let i = ordenados.length - 1; i >= 0 && porRepartir > 0; i -= 1) {
    const lote = ordenados[i]!;
    const gramos = Math.min(lote.quantity, porRepartir);
    if (gramos > 0) {
      reparto.push({ lote, gramos: Math.round(gramos * 1000) / 1000 });
      porRepartir -= gramos;
    }
  }
  // De vuelta al orden FEFO para que la salida sea estable y legible.
  reparto.reverse();
  return reparto;
}

export async function cargarInsumosDelEvento(
  db: Db,
  householdId: string,
  fechaDelEvento: string,
  cortes: readonly string[],
): Promise<InsumosFisicosCargados> {
  const identidades = [...new Set(cortes)];

  const { data: hogar, error: errorHogar } = await db
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .maybeSingle();
  if (errorHogar) throw new DataAccessError("zona horaria del hogar", errorHogar);
  const zona = z.object({ timezone: z.string() }).safeParse(hogar);
  const timeZone = zona.success ? zona.data.timezone : "America/Santiago";
  const hoy = effectiveDate(new Date(), timeZone);

  const [fichas, rendimientos, observados, equipos] = await Promise.all([
    identidades.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("cut_definitions")
          .select(columnsOf(cutColumnas))
          .or(
            `ingredient_id.in.(${identidades.join(",")}),product_id.in.(${identidades.join(",")})`,
          ),
    identidades.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("ingredient_yields")
          .select(columnsOf(rendimientoColumnas))
          .in("ingredient_id", identidades)
          // Mismo filtro que stock/queries.ts: la RLS devuelve los globales +
          // TODOS los hogares del usuario, y sin esto un factor curado por el
          // hogar A ganaría en los cálculos del hogar B.
          .or(`household_id.is.null,household_id.eq.${householdId}`),
    identidades.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("household_observed_yields")
          .select(columnsOf(observadoColumnas))
          .eq("household_id", householdId)
          .in("ingredient_id", identidades),
    db
      .from("household_equipment_configs")
      .select(
        `id, capability, max_batch_quantity, max_batch_unit,
         household_equipment!inner ( household_id, is_active )`,
      )
      .eq("household_equipment.household_id", householdId)
      .eq("household_equipment.is_active", true)
      .eq("is_active", true),
  ]);

  for (const [contexto, res] of [
    ["fichas de corte", fichas],
    ["rendimientos de cocción", rendimientos],
    ["rendimientos observados del hogar", observados],
    ["equipamiento del hogar", equipos],
  ] as const) {
    if (res.error) throw new DataAccessError(`insumos del evento: ${contexto}`, res.error);
  }

  const cutDefinitions: BbqCutDefinitionInput[] = parseRows(
    cutColumnas,
    fichas.data,
    "insumos del evento: fichas de corte",
  ).flatMap((f) => {
    const cutRef = f.ingredient_id ?? f.product_id;
    if (cutRef === null) return [];
    return [
      {
        cutRef,
        boneIn: f.bone_in,
        // La ficha guarda lo que SE PIERDE (hueso y grasa que se descartan) y
        // el motor pide lo que QUEDA. La resta va acá, con nombre, y no en un
        // `1 - x` suelto adentro del pipeline.
        rawPurchaseToEdibleRaw:
          f.trim_loss_fraction === null ? null : 1 - f.trim_loss_fraction,
        cookedToServable: f.servable_fraction,
        // La 0041 NO tiene columna de rendimiento de cocción a propósito: ese
        // tramo tiene un solo dueño, `ingredient_yields`. Se manda null y no
        // "lo que hubiera" porque no hay nada que mandar.
        edibleRawToCooked: null,
        source: f.source,
        confidence:
          f.confidence === "HIGH" || f.confidence === "MEDIUM" || f.confidence === "LOW"
            ? f.confidence
            : null,
      },
    ];
  });

  // EL ORDEN DE ESTE ARREGLO ES SEMÁNTICO, no cosmético: el motor resuelve el
  // tramo de cocción con un `find`, o sea con el PRIMERO que calce. El factor
  // curado por el hogar tiene que ir antes que el global, igual que en
  // `YieldEntry.isHousehold` del Stock Intelligence: el hogar sabe cómo cocina.
  const ingredientYields: BbqIngredientYieldInput[] = parseRows(
    rendimientoColumnas,
    rendimientos.data,
    "insumos del evento: rendimientos",
  )
    .sort((a, b) => Number(b.household_id !== null) - Number(a.household_id !== null))
    .map((r) => ({
      cutRef: r.ingredient_id,
      cookingMethod: r.cooking_method,
      factor: r.yield_factor,
      source: r.household_id === null ? "ingredient_yields (referencia)" : "curado por el hogar",
    }));

  /* Las observaciones se AGRUPAN antes de entrar. La 0015 guarda una fila por
   * observación ("3.000 g → 2.320 g"), y el motor pide un factor con su cuenta
   * de repeticiones porque el §51 prohíbe aprender demasiado de un solo evento.
   * El factor del grupo se calcula sobre los TOTALES (suma de salidas / suma de
   * entradas) y no como promedio de factores: así una observación de 3 kg pesa
   * lo que tiene que pesar frente a una de 300 g. */
  const grupos = new Map<
    string,
    { cutRef: string; stage: WeightStage | null; salida: WeightStage | null; metodo: string | null; entrada: number; producido: number; n: number }
  >();
  for (const o of parseRows(
    observadoColumnas,
    observados.data,
    "insumos del evento: rendimientos observados",
  )) {
    // El motor trabaja en gramos. Una observación en unidades o en mililitros
    // no se convierte: se deja fuera, que es lo que significa no saber.
    if (o.unit !== "G") continue;
    const clave = `${o.ingredient_id}::${o.cooking_method ?? ""}::${o.basis_in ?? ""}::${o.basis_out ?? ""}`;
    const previo = grupos.get(clave) ?? {
      cutRef: o.ingredient_id,
      stage: o.basis_in,
      salida: o.basis_out,
      metodo: o.cooking_method,
      entrada: 0,
      producido: 0,
      n: 0,
    };
    previo.entrada += o.input_quantity;
    previo.producido += o.output_quantity;
    previo.n += 1;
    grupos.set(clave, previo);
  }

  const observedYields: BbqObservedYieldInput[] = [...grupos.values()]
    .filter((g) => g.entrada > 0)
    .map((g) => ({
      cutRef: g.cutRef,
      // Un par de etapas que no son contiguas (o que la 0015 nunca preguntó)
      // devuelve null: la observación queda fuera del estimador y sigue siendo
      // historia. Mezclar "de compra a cocido" con el factor de hueso de la
      // ficha descuenta la misma merma dos veces.
      stage: tramoDeObservacion(g.stage, g.salida),
      cookingMethod: g.metodo,
      factor: g.producido / g.entrada,
      observations: g.n,
    }));

  const equipment: BbqEquipmentInput[] = parseRows(
    equipoColumnas.passthrough(),
    equipos.data,
    "insumos del evento: equipamiento",
  ).flatMap((e) => {
    const tipo = tipoDeEquipo(e.capability);
    if (tipo === null) return [];
    return [
      {
        id: e.id,
        kind: tipo,
        maxBatch: e.max_batch_quantity,
        maxBatchUnit: e.max_batch_unit,
      },
    ];
  });

  const inventory = await cargarInventarioNeteado(
    db,
    householdId,
    hoy,
    timeZone,
    fechaDelEvento,
    identidades,
  );

  return { cutDefinitions, ingredientYields, observedYields, inventory, equipment };
}

/** Lo que hay en la despensa PARA ESTE EVENTO, lote por lote y con su etapa. */
export async function cargarInventarioNeteado(
  db: Db,
  householdId: string,
  hoy: string,
  timeZone: string,
  fechaDelEvento: string,
  cortes: readonly string[],
): Promise<BbqInventoryLotInput[]> {
  if (cortes.length === 0) return [];

  const entrada = await loadStockInput(db, householdId, hoy, timeZone);
  const buckets = analyzeStock(entrada);

  const lotesEnJuego = buckets
    .filter((b) => cortes.includes(b.ingredientId) && b.unit === "G" && b.available > 0)
    .flatMap((b) => b.lots.map((l) => l.id));
  if (lotesEnJuego.length === 0) return [];

  // El dato que `loadStockInput` no trae y que acá decide cosas: si el lote
  // está congelado (hay que descongelarlo antes del sábado).
  //
  // NO HAY RESERVA POR EVENTO, Y ESO SE NOTA ACÁ. Esta función tenía una
  // segunda pregunta —"¿está apartado para OTRO evento?"— apoyada en
  // `inventory_lots.intended_event_id`. Esa columna no tenía ni un escritor en
  // todo el proyecto, así que la rama entera era código muerto que además hacía
  // creer que el §29 se cumplía "en las dos direcciones". La columna se sacó de
  // la 0041 y la pregunta con ella.
  //
  // Consecuencia real y sin adornos: DOS EVENTOS DEL MISMO FIN DE SEMANA NETEAN
  // LOS MISMOS KILOS, y los dos van a comprar de menos. Es un hueco conocido y
  // escrito, que es distinto de un hueco tapado con una columna que no hace nada.
  const { data: extra, error } = await db
    .from("inventory_lots")
    .select("id, temperature_state")
    .in("id", lotesEnJuego);
  if (error) throw new DataAccessError("estado físico de los lotes", error);
  const filas = parseRows(loteColumnas, extra, "estado físico de los lotes");
  const porLote = new Map(filas.map((f) => [f.id, f]));

  const salida: BbqInventoryLotInput[] = [];
  for (const bucket of buckets) {
    if (!cortes.includes(bucket.ingredientId)) continue;
    // El motor cuenta en gramos. Un bucket en unidades o en mililitros no se
    // convierte a gramos sin inventar un peso por unidad.
    if (bucket.unit !== "G") continue;
    // `available` negativo es un FALTANTE ya confirmado de otra comida, no
    // stock del asado: se lee como cero disponible, jamás como deuda que el
    // evento tenga que pagar comprando de más.
    if (bucket.available <= 0) continue;

    const usables = bucket.lots.filter((l) => {
      // Un lote que vence el viernes no sirve para el asado del sábado, aunque
      // hoy esté perfecto. La usabilidad se evalúa EN LA FECHA DEL EVENTO.
      if (!lotUsable(l, fechaDelEvento)) return false;
      // Sin la fila de estado físico no se sabe si está congelado, y un lote
      // del que no se sabe nada no entra al motor como si estuviera listo.
      return porLote.get(l.id) !== undefined;
    });

    const tope = usables.reduce((acc, l) => acc + l.quantity, 0);
    const disponible = Math.min(bucket.available, tope);
    if (disponible <= 0) continue;

    for (const { lote, gramos } of repartirDisponible(usables, disponible)) {
      salida.push({
        lotId: lote.id,
        cutRef: bucket.ingredientId,
        availableG: gramos,
        // LA ETAPA DEL LOTE, no la del bucket: `analyzeStock` agrupa
        // EDIBLE_PORTION y AS_PACKAGED dentro del bucket "RAW", y ahí se
        // perdería justo la diferencia que decide si esos gramos se pueden
        // restar o no.
        stage: ETAPA_DE_BASE_FISICA[lote.weightBasis],
        frozen: porLote.get(lote.id)?.temperature_state === "FROZEN",
      });
    }
  }
  return salida;
}
