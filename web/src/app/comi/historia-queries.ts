import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  NUTRIENT_KEYS,
  type AggregatedNutrition,
  type NutrientCompleteness,
  type NutritionCompleteness,
  type NutritionValues,
} from "@/domain/catalog/types";
import { addDays, DEFAULT_TIME_ZONE, effectiveDate } from "@/domain/nutrition/calendar";
import {
  effectFor,
  eventCoversDate,
  EVENT_STRATEGIES,
  type DayEvent,
} from "@/domain/nutrition/events";
import { TRACKING_MODES, type TrackingMode } from "@/domain/nutrition/types";
import type { DayIntake } from "@/domain/nutrition/adaptive/rolling";
import { MEAL_TYPES, type MealType } from "@/domain/recipes/types";
import { columnsOf, dateString, nullableNumeric, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loDijoAlguien, ORIGENES_DECLARACION } from "./extent";

/**
 * EL LECTOR DEL EJE DE CONSUMO REAL: arma los `DayIntake` que come el motor
 * `rolling-balance` (web/src/domain/nutrition/adaptive/rolling.ts).
 *
 * El motor es PURO y recibe los días ya armados. Alguien tiene que armarlos, y
 * ese alguien es este archivo. Todo lo delicado del sprint pasa por acá.
 *
 * LOS TRES EJES SE LEEN POR SEPARADO Y NO SE MEZCLAN NUNCA
 *
 *   · PLANIFICADO — `member_serving_projections`: lo que el plan propuso.
 *   · SERVIDO     — `meal_serving_records` (0036): lo que salió a la mesa y
 *                   descontó despensa.
 *   · DECLARADO   — `consumption_logs` + `intake_log_items` ACTIVE (0038): lo
 *                   que una persona dice que se comió.
 *
 * Ninguno se deriva de otro. Cada uno tiene su propia consulta, su propio
 * `null` y su propia forma de faltar. Derivar el tercero de los dos primeros es
 * exactamente lo que la 0036 y la 0038 existen para impedir.
 *
 * LA DISTINCIÓN QUE JUSTIFICA TODO EL SPRINT
 *
 *   · `actual = null`  → ese día NO tiene ningún registro declarado vivo.
 *   · `actual` con todos los nutrientes en UNKNOWN → SÍ hay registro, pero
 *     nadie congeló nutrición (que es el caso NORMAL de la pantalla /comi: la
 *     0038 guarda `frozen_nutrition = '{}'`, y ese `{}` significa "no se
 *     congeló", jamás "cero calorías").
 *   · el día que ni siquiera aparece en la lista → la persona todavía no
 *     existía. El motor lo cuenta como NOT_IN_HISTORY y no como un hueco.
 *
 * Los tres son distintos y los tres se dicen distinto. Un vacío leído como cero
 * apaga el pronóstico, hunde la cobertura y fabrica un déficit que nadie vivió.
 *
 * Y HAY UNA CUARTA, QUE ES LA QUE JUSTIFICA LA COLUMNA `source`
 *
 *   · un registro que una PERSONA declaró (`DECLARED_SELF`, `DECLARED_CAREGIVER`);
 *   · un registro que NADIE MIRÓ y se dio por hecho del plan
 *     (`ASSUMED_FROM_PLAN`, lo que escribe `assume_intake_from_plan`).
 *
 * Los dos son filas vivas de `consumption_logs` y desde lejos se ven iguales.
 * No lo son: la 0038 lo dice en el comentario de la columna —«lo asumido no es
 * una declaración y el motor adaptativo tiene que poder distinguirlo SIEMPRE»—
 * y esta pantalla existe para sostener esa diferencia. Un ataque encontró que
 * este lector la borraba antes de que llegara al motor: `mealsLogged` contaba
 * igual las dos, una familia que apretaba «Se comió todo» siete días seguidos
 * llegaba con cobertura FULL y confianza HIGH, y ese `mealRatio` es justo el
 * que decide entre "opcional" y "recomendado".
 *
 * Acá lo asumido NO desaparece y tampoco se disfraza: entra como registro
 * (`actual` deja de ser null, porque la fila existe) y no aporta NADA más —
 * ninguna comida a `mealsLogged`, ningún nutriente a la suma, y un "no sé
 * cuánto" por renglón. Es la misma regla que este archivo ya aplica al eje
 * servido cuando lo que salió no fue lo que el plan decía: si nadie lo miró, la
 * respuesta honesta es "no se sabe", y se degrada, nunca se infla.
 *
 * ESTE LECTOR NO TIENE RELOJ. El día civil del hogar (`hoy`) entra por
 * parámetro: lo calcula `diaCivilDelHogar` una sola vez, leyendo la zona del
 * hogar, igual que `app.household_today`. `getHours` y la zona del servidor no
 * aparecen: en Chile cambia la hora y a las 22:30 de Santiago ya es mañana en
 * UTC.
 *
 * Y si una consulta falla, revienta con `DataAccessError`. Una lista vacía
 * devuelta por un error es la falla que este proyecto ya pagó tres veces.
 */

type Db = SupabaseClient;

/** Tolerancia de los espejos numéricos de la 0036 (`numeric(12,3)`). */
const TOLERANCIA = 0.0005;

// ---------------------------------------------------------------------------
// Vectores nutricionales congelados
// ---------------------------------------------------------------------------

/**
 * Un vector tal como quedó congelado en la base: los valores por un lado y la
 * completitud POR NUTRIENTE por el otro.
 *
 * Se acepta también la forma anidada `{ values, completeness }` porque así
 * quedaron escritas algunas filas viejas de `member_serving_projections`
 * (`app/health/assess-service.ts` ya la desenvuelve). Adivinar la forma en dos
 * lugares distintos es cómo nace una traducción que se desincroniza, así que
 * acá se declara explícita en un solo lugar.
 */
export interface VectorCongelado {
  values: NutritionValues;
  completeness: Partial<NutritionCompleteness>;
}

const numeroONulo = z.union([z.number(), z.string(), z.null()]).transform((v) => {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
});

const completitudDeclarada = z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]);
const objetoSuelto = z.record(z.string(), z.unknown());

/**
 * Desenvuelve el par (nutrición, completitud) de una fila.
 *
 * Nada acá inventa: una clave que no viene NO se escribe, y un valor que no es
 * número NO se convierte en cero. Lo que no está, no está.
 */
export function vectorCongelado(nutricion: unknown, completitud: unknown): VectorCongelado {
  const valoresRaiz = objetoSuelto.safeParse(nutricion);
  const completitudRaiz = objetoSuelto.safeParse(completitud);
  const fuenteValores = valoresRaiz.success ? valoresRaiz.data : {};
  const fuenteCompletitud = completitudRaiz.success ? completitudRaiz.data : {};

  // Forma anidada del mundo viejo: `{ values: {...}, completeness: {...} }`.
  const anidadoValores = objetoSuelto.safeParse(fuenteValores.values);
  const anidadoCompletitud = objetoSuelto.safeParse(fuenteValores.completeness);
  const valores = anidadoValores.success ? anidadoValores.data : fuenteValores;
  const completitudes = anidadoCompletitud.success ? anidadoCompletitud.data : fuenteCompletitud;

  const values: NutritionValues = {};
  const completeness: Partial<NutritionCompleteness> = {};
  for (const key of NUTRIENT_KEYS) {
    if (key in valores) {
      const parsed = numeroONulo.safeParse(valores[key]);
      if (parsed.success) values[key] = parsed.data;
    }
    const estado = completitudDeclarada.safeParse(completitudes[key]);
    if (estado.success) completeness[key] = estado.data;
  }
  return { values, completeness };
}

/** Qué salió de sumar, además del número. */
export interface SumaDeVectores {
  agregado: AggregatedNutrition;
  /**
   * Contradicciones encontradas: la fila dice COMPLETE/PARTIAL y no trae
   * número, o trae número y no dice nada. No se lanzan —una fila vieja rota no
   * puede matar la historia entera— pero TAMPOCO se callan: suben a
   * `HistoriaDeConsumo.avisos` y el nutriente queda degradado, nunca inflado.
   */
  avisos: string[];
}

/**
 * Suma vectores congelados respetando la completitud DECLARADA de cada uno.
 *
 * No se usa `sumAbsoluteNutrients` (domain/catalog/nutrition.ts) a propósito:
 * ese deduce la completitud de la ausencia del número, y acá la completitud es
 * un dato de primera clase que la base guarda aparte. Un vector que dice
 * "protein_g: PARTIAL" con número tiene que ensuciar la suma, y deducirla del
 * `null` lo daría por COMPLETE.
 *
 * Es PURA: sin reloj, sin base. La misma entrada produce la misma salida byte a
 * byte.
 */
export function sumarVectoresCongelados(
  vectores: readonly VectorCongelado[],
  contexto: string,
): SumaDeVectores {
  const values: NutritionValues = {};
  const completeness = {} as NutritionCompleteness;
  const avisos: string[] = [];

  for (const key of NUTRIENT_KEYS) {
    let suma = 0;
    let conocidos = 0;
    let hayParcial = false;

    for (const vector of vectores) {
      const estado = vector.completeness[key];
      const bruto = vector.values[key];
      const numero = typeof bruto === "number" ? bruto : null;

      if (estado === "UNKNOWN") continue;

      if (estado === undefined) {
        // Nadie declaró completitud para este nutriente. Sin número tampoco: es
        // el caso NORMAL, el `{}` de la 0038 que significa "no se congeló".
        if (numero === null) continue;
        // Con número y sin declaración, el número se usa —tirarlo sería perder
        // un dato real— pero JAMÁS puede sostener un COMPLETE: nadie afirmó que
        // estuviera completo.
        suma += numero;
        conocidos += 1;
        hayParcial = true;
        avisos.push(`${contexto}: ${key} trae número sin completitud declarada`);
        continue;
      }

      if (numero === null) {
        // Contradicción: dice COMPLETE/PARTIAL y no hay número. Se degrada a
        // desconocido (la dirección segura) y se dice en voz alta.
        avisos.push(`${contexto}: ${key} se declara ${estado} pero no trae número`);
        continue;
      }

      suma += numero;
      conocidos += 1;
      if (estado === "PARTIAL") hayParcial = true;
    }

    let estado: NutrientCompleteness;
    if (conocidos === 0) estado = "UNKNOWN";
    else if (conocidos === vectores.length && !hayParcial) estado = "COMPLETE";
    else estado = "PARTIAL";

    completeness[key] = estado;
    // El motor revienta si un nutriente dice COMPLETE/PARTIAL y no trae valor
    // (`valorConocido`, rolling.ts). Acá el par queda garantizado por
    // construcción, que es más barato que descubrirlo en producción.
    values[key] = estado === "UNKNOWN" ? null : suma;
  }

  return {
    agregado: { values, completeness, contributors: vectores.length },
    avisos,
  };
}

// ---------------------------------------------------------------------------
// Entrada y salida del lector
// ---------------------------------------------------------------------------

export interface VentanaHistoria {
  householdId: string;
  memberId: string;
  /** Último día de la ventana, INCLUSIVE. DATE-only del hogar. */
  hasta: string;
  /** Largo de la ventana en días, contando `hasta`. */
  dias: number;
  /**
   * El día civil del hogar HOY. Entra por parámetro y no se calcula acá: el
   * mismo `hoy` tiene que valer para todas las personas de una misma corrida, o
   * dos integrantes del mismo hogar cerrarían días distintos.
   */
  hoy: string;
}

/**
 * Lo que ese día se DIO POR HECHO en vez de declararlo.
 *
 * Viaja aparte de `DayIntake` porque no es un aporte: es lo que NO se sabe. Es
 * el canal por el que la procedencia llega hasta quien arma la revisión
 * adaptativa, que tiene que poder decir "de este día hay registro, pero nadie
 * lo miró" sin tener que volver a la base a preguntarlo.
 */
export interface DiaAsumido {
  date: string;
  /** Registros con `source = 'ASSUMED_FROM_PLAN'` vivos ese día. */
  logs: number;
  /** Renglones de esos registros: cada uno es un "nadie miró este plato". */
  items: number;
  /** Las comidas del patrón que quedaron cubiertas SOLO por un supuesto. */
  comidas: MealType[];
}

export interface HistoriaDeConsumo {
  /** Primer día de la ventana, inclusive. */
  desde: string;
  hasta: string;
  /**
   * Los días que EXISTEN en la historia de esta persona, ascendente y sin
   * repetir, listos para `rollingBalance`. Los que faltan NO son días sin
   * registro: son días en que la persona todavía no estaba.
   */
  dias: DayIntake[];
  /** Primer día del que esta persona puede llegar a tener registro. */
  primerDiaDeHistoria: string;
  /** Días de la ventana anteriores a que la persona existiera, ascendente. */
  diasFueraDeHistoria: string[];
  /**
   * Los días con registros ASUMIDOS del plan, ascendente. Vacío es vacío de
   * verdad: todo lo que hay está declarado por una persona.
   */
  asumidos: DiaAsumido[];
  /**
   * Lo que se leyó raro y NO se arregló solo. Vacío es vacío de verdad: si un
   * vector se contradice, se dice acá y el nutriente queda degradado.
   */
  avisos: string[];
}

// ---------------------------------------------------------------------------
// Schemas de fila
// ---------------------------------------------------------------------------

const mealType = z.enum(MEAL_TYPES);
const marcaDeTiempo = z.union([z.string(), z.date()]);

const hogarFila = z.object({ id: uuid, timezone: z.string() });

const integranteFila = z.object({
  id: uuid,
  household_id: uuid,
  created_at: marcaDeTiempo,
});

const trackingFila = z.object({ member_id: uuid, mode: z.enum(TRACKING_MODES) });

const patronFila = z.object({ id: uuid, member_id: uuid });

const slotFila = z.object({
  pattern_id: uuid,
  meal_type: mealType,
  availability: z.enum(["ENABLED", "DISABLED", "OPTIONAL"]),
  sort_order: z.number().int(),
});

const eventoFila = z.object({
  id: uuid,
  event_date: dateString,
  end_date: dateString.nullable(),
  event_type: z.string(),
  meal_type: mealType.nullable(),
  strategy: z.enum(EVENT_STRATEGIES),
  title: z.string(),
});

const eventoMiembroFila = z.object({ event_id: uuid, member_id: uuid });

const proyeccionFila = z.object({
  id: uuid,
  serving_date: dateString.nullable(),
  meal_type: mealType,
  status: z.string(),
  nutrition: z.unknown(),
  completeness: z.unknown(),
});

const servidoFila = z.object({
  id: uuid,
  meal_type: mealType.nullable(),
  served_on: dateString,
  kind: z.enum(["FROM_PLAN", "OFF_PLAN"]),
  plan_nutrition: z.unknown(),
  plan_completeness: z.unknown(),
});

const renglonServidoFila = z.object({
  record_id: uuid,
  served_quantity_is_declared: z.boolean(),
  shortfall_quantity: nullableNumeric,
  discarded_quantity: nullableNumeric,
  reversed_quantity: nullableNumeric,
});

const declaracionFila = z.object({
  id: uuid,
  consumed_on: dateString,
  meal_type: mealType.nullable(),
  /**
   * DE DÓNDE VIENE LA AFIRMACIÓN. `columnsOf` deriva el `.select()` de este
   * schema, así que una columna que no se declara acá NO SE LEE: mientras
   * faltaba, `source` nunca salía de la base y la distinción entre "lo dijo
   * alguien" y "lo dimos por hecho" moría en esta línea.
   */
  source: z.enum(ORIGENES_DECLARACION),
});

const renglonDeclaradoFila = z.object({
  log_id: uuid,
  quantity: nullableNumeric,
  frozen_nutrition: z.unknown(),
  nutrition_completeness: z.unknown(),
});

// ---------------------------------------------------------------------------
// El día civil del hogar
// ---------------------------------------------------------------------------

/**
 * Qué día es HOY para este hogar, con su zona horaria.
 *
 * Es el equivalente en TypeScript de `app.household_today(uuid)` — misma
 * pregunta, misma respuesta, mismo respaldo a Santiago cuando la columna viene
 * vacía (0014:245). Se llama UNA vez por corrida y el resultado viaja por
 * parámetro: nada más abajo vuelve a mirar el reloj.
 *
 * `ahora` entra por argumento para que un test pueda pararse en las 23:50 de un
 * 31 de agosto sin esperar a que sea esa hora.
 */
export async function diaCivilDelHogar(
  db: Db,
  householdId: string,
  ahora: Date,
): Promise<{ hoy: string; timeZone: string }> {
  const { data, error } = await db
    .from("households")
    .select(columnsOf(hogarFila))
    .eq("id", householdId);
  if (error) throw new DataAccessError("la zona horaria del hogar", error);

  const hogar = parseRows(hogarFila, data, "la zona horaria del hogar")[0];
  if (hogar === undefined) {
    throw new Error(`No existe el hogar ${householdId}: no hay día civil que calcular.`);
  }
  // La columna es NOT NULL con default, pero una cadena vacía sí cabe y `Intl`
  // la rechazaría con un error que no explica nada.
  const timeZone = hogar.timezone.trim().length > 0 ? hogar.timezone : DEFAULT_TIME_ZONE;
  return { hoy: effectiveDate(ahora, timeZone), timeZone };
}

// ---------------------------------------------------------------------------
// El lector
// ---------------------------------------------------------------------------

/**
 * Arma la historia de consumo de UNA persona para una ventana de días.
 *
 * Consultas planas, ningún embed: PostgREST devuelve el embed como objeto o
 * como arreglo según lo que crea el planificador, y ese "según" ya costó un
 * cast en el Sprint 4. Las relaciones se resuelven acá, con los ids a la vista.
 */
export async function loadHistoriaDeConsumo(
  db: Db,
  ventana: VentanaHistoria,
): Promise<HistoriaDeConsumo> {
  if (!Number.isInteger(ventana.dias) || ventana.dias < 1) {
    throw new RangeError(`La ventana tiene que ser de al menos un día, llegó ${ventana.dias}`);
  }
  if (ventana.hasta > ventana.hoy) {
    // Un día que todavía no ocurre no se lee: no hay nada que leer y el motor
    // tendría que inventar un denominador. La ventana termina hoy o antes.
    throw new RangeError(
      `La ventana no puede terminar en el futuro: hasta=${ventana.hasta}, hoy=${ventana.hoy}`,
    );
  }

  const hasta = ventana.hasta;
  const desde = addDays(hasta, -(ventana.dias - 1));
  const avisos: string[] = [];

  // --- Quién es y desde cuándo existe ---
  const { data: integranteData, error: integranteError } = await db
    .from("household_members")
    .select(columnsOf(integranteFila))
    .eq("id", ventana.memberId);
  if (integranteError) throw new DataAccessError("la persona", integranteError);
  const integrante = parseRows(integranteFila, integranteData, "la persona")[0];
  if (integrante === undefined) {
    throw new Error(`No existe la persona ${ventana.memberId} o este hogar no la puede ver.`);
  }
  if (integrante.household_id !== ventana.householdId) {
    // Una persona puede pertenecer a DOS hogares. Mezclarlos acá haría que el
    // motor adaptativo de una casa juzgara lo que se comió en la otra.
    throw new Error(`La persona ${ventana.memberId} no es de este hogar.`);
  }

  // La zona horaria del hogar, para saber en qué DÍA nació la persona. El
  // instante `0` es un relleno: acá solo interesa la zona, y `hoy` ya viene
  // resuelto en la ventana.
  const { timeZone } = await diaCivilDelHogar(db, ventana.householdId, new Date(0));
  const nacimiento =
    typeof integrante.created_at === "string"
      ? new Date(integrante.created_at)
      : integrante.created_at;
  const primerDiaDeHistoria = effectiveDate(nacimiento, timeZone);

  // --- Cómo se mide a esta persona ---
  const { data: trackingData, error: trackingError } = await db
    .from("member_tracking_settings")
    .select(columnsOf(trackingFila))
    .eq("member_id", ventana.memberId);
  if (trackingError) throw new DataAccessError("el modo de conteo", trackingError);
  const tracking = parseRows(trackingFila, trackingData, "el modo de conteo")[0];
  // Sin fila, el modo es OFF. No es una invención: es el DEFAULT declarado de
  // la columna (0005:96) y significa "a esta persona no se le exige conteo".
  const trackingMode: TrackingMode = tracking === undefined ? "OFF" : tracking.mode;

  // --- Qué comidas espera su patrón ---
  const { data: patronData, error: patronError } = await db
    .from("meal_patterns")
    .select(columnsOf(patronFila))
    .eq("member_id", ventana.memberId);
  if (patronError) throw new DataAccessError("el patrón de comidas", patronError);
  const patron = parseRows(patronFila, patronData, "el patrón de comidas")[0];

  let comidasDelPatron: MealType[] = [];
  if (patron !== undefined) {
    const { data: slotsData, error: slotsError } = await db
      .from("meal_pattern_slots")
      .select(columnsOf(slotFila))
      .eq("pattern_id", patron.id);
    if (slotsError) throw new DataAccessError("las comidas del patrón", slotsError);
    // OPTIONAL no entra al denominador: una comida que la persona declaró
    // opcional y no registró NO es un hueco. Solo ENABLED es "se espera".
    comidasDelPatron = parseRows(slotFila, slotsData, "las comidas del patrón")
      .filter((s) => s.availability === "ENABLED")
      .sort((a, b) => a.sort_order - b.sort_order || (a.meal_type < b.meal_type ? -1 : 1))
      .map((s) => s.meal_type);
  }

  // --- Eventos que tocan la ventana ---
  const eventos = await cargarEventos(db, ventana.householdId, ventana.memberId, desde, hasta);

  // --- EJE PLANIFICADO ---
  const { data: proyData, error: proyError } = await db
    .from("member_serving_projections")
    .select(columnsOf(proyeccionFila))
    .eq("member_id", ventana.memberId)
    .gte("serving_date", desde)
    .lte("serving_date", hasta)
    // ORDEN ESTABLE, Y NO ES CAPRICHO: sin `order by`, Postgres no promete
    // ningún orden, y estas filas entran a `sumarVectoresCongelados`, que
    // acumula con `suma += numero`. La suma en punto flotante NO es asociativa
    // ([1.02, 778.76, 694.94, 475.19, 38.45, 55.05] da 2043.41 en un orden y
    // 2043.4099999999999 en otro), así que dos corridas iguales devolverían
    // JSON distinto. El motor de arriba es determinista POR CONTRATO; un
    // lector que no lo es le rompe esa promesa desde abajo. `id` cierra la
    // clave para que no queden empates.
    .order("serving_date", { ascending: true })
    .order("meal_type", { ascending: true })
    .order("id", { ascending: true });
  if (proyError) throw new DataAccessError("lo planificado", proyError);
  // CANCELLED se cae: un plan cancelado ya no dice nada. SKIPPED se queda — el
  // plan SÍ propuso esa comida, y que después no se comiera es información del
  // eje declarado, no del planificado.
  const proyecciones = parseRows(proyeccionFila, proyData, "lo planificado").filter(
    (p) => p.serving_date !== null && p.status !== "CANCELLED",
  );

  // --- EJE SERVIDO ---
  const { data: servidoData, error: servidoError } = await db
    .from("meal_serving_records")
    .select(columnsOf(servidoFila))
    .eq("household_id", ventana.householdId)
    .eq("member_id", ventana.memberId)
    .eq("status", "ACTIVE")
    .gte("served_on", desde)
    .lte("served_on", hasta)
    .order("served_on", { ascending: true })
    .order("id", { ascending: true });
  if (servidoError) throw new DataAccessError("lo servido", servidoError);
  const servidos = parseRows(servidoFila, servidoData, "lo servido");

  const renglonesServidos = await cargarRenglones(
    db,
    "meal_serving_record_items",
    columnsOf(renglonServidoFila),
    "record_id",
    servidos.map((s) => s.id),
    renglonServidoFila,
    "los renglones de lo servido",
  );

  // --- EJE DECLARADO ---
  const { data: logsData, error: logsError } = await db
    .from("consumption_logs")
    .select(columnsOf(declaracionFila))
    .eq("household_id", ventana.householdId)
    .eq("member_id", ventana.memberId)
    .eq("status", "ACTIVE")
    .gte("consumed_on", desde)
    .lte("consumed_on", hasta)
    .order("consumed_on", { ascending: true })
    .order("id", { ascending: true });
  if (logsError) throw new DataAccessError("lo declarado", logsError);
  const declaraciones = parseRows(declaracionFila, logsData, "lo declarado");

  const renglonesDeclarados = await cargarRenglones(
    db,
    "intake_log_items",
    columnsOf(renglonDeclaradoFila),
    "log_id",
    declaraciones.map((l) => l.id),
    renglonDeclaradoFila,
    "los renglones de lo declarado",
  );

  // --- Armado, día por día ---
  const dias: DayIntake[] = [];
  const diasFueraDeHistoria: string[] = [];
  const asumidos: DiaAsumido[] = [];

  for (let i = 0; i < ventana.dias; i += 1) {
    const fecha = addDays(desde, i);
    if (fecha < primerDiaDeHistoria) {
      diasFueraDeHistoria.push(fecha);
      continue;
    }

    // Qué comidas se ESPERAN ese día. Un evento SKIP_TRACKING sobre una comida
    // puntual la saca del denominador: no medirla es lo que se pidió, no un
    // hueco de registro.
    const esperadas = comidasDelPatron.filter(
      (mt) => effectFor(eventos, ventana.memberId, fecha, mt).kind !== "UNTRACKED",
    );
    const setEsperadas = new Set<MealType>(esperadas);

    // El día completo sin conteo: o el patrón entero quedó sin medir, o hay un
    // evento de día completo — que es lo único que se puede afirmar cuando el
    // patrón no tiene ninguna comida habilitada.
    const eventoDeDiaCompleto = eventos.some(
      (e) => e.strategy === "SKIP_TRACKING" && e.mealType === null && eventCoversDate(e, fecha),
    );
    const skipTracking =
      eventoDeDiaCompleto || (comidasDelPatron.length > 0 && esperadas.length === 0);

    // PLANIFICADO del día.
    const proyDelDia = proyecciones.filter((p) => p.serving_date === fecha);
    let planned: AggregatedNutrition | null = null;
    if (proyDelDia.length > 0) {
      const suma = sumarVectoresCongelados(
        proyDelDia.map((p) => vectorCongelado(p.nutrition, p.completeness)),
        `planificado ${fecha}`,
      );
      planned = suma.agregado;
      avisos.push(...suma.avisos);
    }

    // SERVIDO del día.
    const servidosDelDia = servidos.filter((s) => s.served_on === fecha);
    let served: AggregatedNutrition | null = null;
    if (servidosDelDia.length > 0) {
      const suma = sumarVectoresCongelados(
        servidosDelDia.map((s) =>
          esFielAlPlan(s, renglonesServidos.get(s.id))
            ? vectorCongelado(s.plan_nutrition, s.plan_completeness)
            : // Se sirvió distinto de lo planificado (cantidad declarada a mano,
              // faltante de despensa, algo botado o devuelto). La nutrición
              // congelada es la del PLAN y ya no describe lo que salió al plato:
              // no existe `served_nutrition` en ninguna parte, así que la
              // respuesta honesta es "no se sabe". Escalar el plan por la
              // proporción servida sería inventar un número que nadie calculó.
              { values: {}, completeness: {} },
        ),
        `servido ${fecha}`,
      );
      served = suma.agregado;
      avisos.push(...suma.avisos);
    }

    // DECLARADO del día. Acá vive la distinción que justifica el sprint.
    const logsDelDia = declaraciones.filter((l) => l.consumed_on === fecha);
    let actual: AggregatedNutrition | null = null;
    let unknownQuantityItems = 0;
    let itemsAsumidos = 0;
    if (logsDelDia.length > 0) {
      // El caso "sin renglones" se escribe con todas sus letras y no con un
      // operador de respaldo: acá es un hecho con significado propio (registro
      // sin detalle), y un atajo taparía por igual ese hecho y un error real.
      const renglones = logsDelDia.flatMap((l) => {
        const propios = renglonesDeclarados.get(l.id);
        if (propios === undefined) return [];
        // La procedencia viaja PEGADA al renglón: el vector de un supuesto no
        // se puede sumar como si alguien lo hubiera mirado.
        return propios.map((r) => ({ renglon: r, loDijoUnaPersona: loDijoAlguien(l.source) }));
      });
      // Un registro SIN renglones no es un registro de cero calorías: es un
      // registro sin detalle. Sumar cero vectores deja los diez nutrientes en
      // UNKNOWN con valor null, y `actual` NO es null porque el registro existe.
      const suma = sumarVectoresCongelados(
        renglones.map(({ renglon, loDijoUnaPersona }) =>
          loDijoUnaPersona
            ? vectorCongelado(renglon.frozen_nutrition, renglon.nutrition_completeness)
            : // NADIE MIRÓ ESTE PLATO. Lo que `assume_intake_from_plan` congela
              // describe lo que la despensa entregó, no lo que esta persona se
              // comió: darlo por medido es exactamente aprender de algo que
              // nadie dijo. Se aporta un vector vacío —"no se sabe"—, igual que
              // arriba cuando lo servido dejó de parecerse al plan.
              { values: {}, completeness: {} },
        ),
        `declarado ${fecha}`,
      );
      actual = suma.agregado;
      avisos.push(...suma.avisos);
      // El "no sé cuánto" de la 0038: `quantity is null`. Cuenta también el
      // «Nada» (NONE), porque el diseño se niega —con razón— a escribir un 0
      // ahí: desde este lector no hay número, y un no-número baja la confianza.
      //
      // Y cuenta TODO renglón asumido, aunque traiga número: la 0038 le escribe
      // `deducted_quantity` (0038:1036), o sea un número que nadie observó. Ese
      // era el agujero: `unknownQuantityItems` quedaba en 0, el techo de la
      // ventana subía a HIGH y "lo dimos por hecho" terminaba valiendo lo mismo
      // que "lo miré y te lo digo".
      unknownQuantityItems = renglones.filter(
        ({ renglon, loDijoUnaPersona }) => !loDijoUnaPersona || renglon.quantity === null,
      ).length;
      itemsAsumidos = renglones.filter(({ loDijoUnaPersona }) => !loDijoUnaPersona).length;
    }

    const comidasDeclaradas = new Set<MealType>();
    const comidasAsumidas = new Set<MealType>();
    let unassignedLogs = 0;
    let logsAsumidos = 0;
    for (const log of logsDelDia) {
      if (!loDijoAlguien(log.source)) {
        // UN SUPUESTO NO CUBRE UNA COMIDA. No suma a `mealsLogged` —que es el
        // numerador de la cobertura— ni a `unassignedLogs`: nadie declaró nada,
        // así que la comida sigue faltando por registrar y el motor tiene que
        // verla faltar. Contarla acá es lo que le daba cobertura FULL a una
        // familia que solo apretó un botón.
        logsAsumidos += 1;
        if (log.meal_type !== null && setEsperadas.has(log.meal_type)) {
          comidasAsumidas.add(log.meal_type);
        }
        continue;
      }
      if (log.meal_type !== null && setEsperadas.has(log.meal_type)) {
        comidasDeclaradas.add(log.meal_type);
        continue;
      }
      // Registro real que no cae en ninguna comida esperada: el snack sin
      // comida asignada, o una comida que su patrón no espera. Se informa
      // aparte y NUNCA infla ni deflacta `mealRatio` — que es exactamente el
      // motivo por el que el campo existe: quien registró todo lo que comió no
      // puede recibir un "no sé" por haberlo anotado como snack.
      unassignedLogs += 1;
    }

    if (logsAsumidos > 0) {
      asumidos.push({
        date: fecha,
        logs: logsAsumidos,
        items: itemsAsumidos,
        // Orden fijo: dos corridas iguales tienen que dar el mismo arreglo.
        comidas: [...comidasAsumidas].filter((mt) => !comidasDeclaradas.has(mt)).sort(),
      });
    }

    const comidasServidas = new Set<MealType>();
    for (const s of servidosDelDia) {
      if (s.meal_type !== null && setEsperadas.has(s.meal_type)) comidasServidas.add(s.meal_type);
    }

    dias.push({
      date: fecha,
      planned,
      served,
      actual,
      mealsExpected: esperadas.length,
      mealsServed: comidasServidas.size,
      mealsLogged: comidasDeclaradas.size,
      unassignedLogs,
      unknownQuantityItems,
      trackingMode,
      skipTracking,
      // Un día en curso NO es un día sin registro: la cena todavía no ocurre.
      // El motor lo saca del denominador con este solo booleano.
      isClosed: fecha < ventana.hoy,
    });
  }

  return { desde, hasta, dias, primerDiaDeHistoria, diasFueraDeHistoria, asumidos, avisos };
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/**
 * ¿Lo que salió a la mesa fue EXACTAMENTE lo que el plan decía?
 *
 * Solo entonces `plan_nutrition` describe lo servido. Basta un renglón con
 * cantidad declarada a mano, con faltante de despensa, botado o devuelto para
 * que deje de describirlo; y un registro sin renglones no describe nada.
 */
function esFielAlPlan(
  registro: z.output<typeof servidoFila>,
  renglones: z.output<typeof renglonServidoFila>[] | undefined,
): boolean {
  if (registro.kind !== "FROM_PLAN") return false;
  if (renglones === undefined || renglones.length === 0) return false;
  return renglones.every(
    (r) =>
      !r.served_quantity_is_declared &&
      (r.shortfall_quantity === null || r.shortfall_quantity <= TOLERANCIA) &&
      (r.discarded_quantity === null || r.discarded_quantity <= TOLERANCIA) &&
      (r.reversed_quantity === null || r.reversed_quantity <= TOLERANCIA),
  );
}

/** Los renglones hijos de una lista de padres, agrupados por el id del padre. */
async function cargarRenglones<S extends z.ZodObject<z.ZodRawShape>>(
  db: Db,
  tabla: "meal_serving_record_items" | "intake_log_items",
  columnas: string,
  llave: "record_id" | "log_id",
  padres: readonly string[],
  schema: S,
  contexto: string,
): Promise<Map<string, z.output<S>[]>> {
  const agrupado = new Map<string, z.output<S>[]>();
  if (padres.length === 0) return agrupado;

  // Mismo motivo que arriba: estos renglones son los sumandos. `sort_order` es
  // el orden con el que se escribieron y `id` desempata los que lo repiten.
  const { data, error } = await db
    .from(tabla)
    .select(columnas)
    .in(llave, [...padres])
    .order(llave, { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new DataAccessError(contexto, error);

  for (const fila of parseRows(schema, data, contexto)) {
    const id = String((fila as Record<string, unknown>)[llave]);
    const lista = agrupado.get(id);
    if (lista === undefined) agrupado.set(id, [fila]);
    else lista.push(fila);
  }
  return agrupado;
}

/**
 * Los eventos que TOCAN la ventana, incluidos los que empezaron antes (un viaje
 * de diez días que arrancó la semana pasada).
 *
 * Son dos consultas y no una: un evento de un solo día tiene `end_date` NULL, y
 * en SQL `null >= desde` no es verdadero. Una sola consulta filtrando por
 * `end_date` perdería en silencio TODOS los eventos de un día, que son la
 * mayoría.
 */
async function cargarEventos(
  db: Db,
  householdId: string,
  memberId: string,
  desde: string,
  hasta: string,
): Promise<DayEvent[]> {
  const { data: unDiaData, error: unDiaError } = await db
    .from("nutrition_events")
    .select(columnsOf(eventoFila))
    .eq("household_id", householdId)
    .is("end_date", null)
    .gte("event_date", desde)
    .lte("event_date", hasta)
    .order("id", { ascending: true });
  if (unDiaError) throw new DataAccessError("los eventos de un día", unDiaError);

  const { data: variosData, error: variosError } = await db
    .from("nutrition_events")
    .select(columnsOf(eventoFila))
    .eq("household_id", householdId)
    .gte("end_date", desde)
    .lte("event_date", hasta)
    .order("id", { ascending: true });
  if (variosError) throw new DataAccessError("los eventos de varios días", variosError);

  const filas = [
    ...parseRows(eventoFila, unDiaData, "los eventos de un día"),
    ...parseRows(eventoFila, variosData, "los eventos de varios días"),
  ];
  const porId = new Map(filas.map((e) => [e.id, e]));
  if (porId.size === 0) return [];

  const { data: miembrosData, error: miembrosError } = await db
    .from("nutrition_event_members")
    .select(columnsOf(eventoMiembroFila))
    .in("event_id", [...porId.keys()])
    .order("event_id", { ascending: true })
    .order("member_id", { ascending: true });
  if (miembrosError) throw new DataAccessError("los integrantes de los eventos", miembrosError);

  const porEvento = new Map<string, string[]>();
  for (const fila of parseRows(eventoMiembroFila, miembrosData, "los integrantes de los eventos")) {
    const lista = porEvento.get(fila.event_id);
    if (lista === undefined) porEvento.set(fila.event_id, [fila.member_id]);
    else lista.push(fila.member_id);
  }

  return [...porId.values()]
    .map((e) => {
      // Sin filas = evento de TODA la familia (0007). Acá la lista vacía
      // significa eso y no "no se pudo leer": la consulta ya reventó si falló.
      // Por eso la ausencia se pregunta explícita, sin operador de respaldo:
      // un atajo confundiría las dos cosas en un mismo valor.
      const propios = porEvento.get(e.id);
      return {
        id: e.id,
        date: e.event_date,
        endDate: e.end_date,
        eventType: e.event_type,
        mealType: e.meal_type,
        strategy: e.strategy,
        title: e.title,
        memberIds: propios === undefined ? [] : propios,
      };
    })
    .filter((e) => e.memberIds.length === 0 || e.memberIds.includes(memberId))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
