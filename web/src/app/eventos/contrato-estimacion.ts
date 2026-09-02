import { z } from "zod";
import {
  BBQ_REASON_CODES,
  YIELD_STAGES,
  type BbqMenuItemInput,
  type BbqParticipantInput,
  type BbqQuantityResult,
} from "@/domain/events/bbq/types";
import { ASISTENCIAS, CATEGORIAS_MENU, CONTEXTOS_COMIDA, GRUPOS_EDAD } from "./vocabulario";

/**
 * EL CONTRATO DE LA REVISIÓN CONGELADA (`event_plan_revisions`).
 *
 * Una revisión guarda dos cosas: la ENTRADA con la que se calculó y la SALIDA
 * que produjo el motor `bbq-quantity/1.0.0`. Las dos viajan como `jsonb`, así
 * que las dos se VALIDAN al leerlas — no se castean. Es la lección del Sprint 4:
 * un `as` compila siempre y la pantalla termina mostrando otra cosa.
 *
 * La pantalla NO llama al motor para dibujar: lee la revisión congelada. Así
 * cambiar la política mañana no reescribe lo que un asado de hace un mes dijo
 * (§95), y no existe la posibilidad de que el número que se ve y el que se
 * compró sean distintos.
 *
 * LOS TIPOS SON LOS DEL MOTOR, no una copia. `salidaEstimacionSchema` está
 * declarado como `z.ZodType<BbqQuantityResult>`: si el motor cambia la forma de
 * su salida, este archivo deja de compilar. Una copia paralela habría compilado
 * igual y la pantalla habría leído campos que ya no existen.
 */

// ---------------------------------------------------------------------------
// Piezas comunes
// ---------------------------------------------------------------------------

/**
 * Toda estimación es un RANGO. No existe el número seco: "8,427 kg" finge una
 * precisión que ningún dato de este sistema respalda (§27). El ancho es
 * información —dice cuánto se sabe—, así que la pantalla muestra los tres
 * números y no solo el centro.
 */
const rangoSchema = z
  .object({
    min: z.number().finite().nonnegative(),
    base: z.number().finite().nonnegative(),
    max: z.number().finite().nonnegative(),
  })
  .refine((r) => r.min <= r.base && r.base <= r.max, {
    message: "el rango tiene que venir ordenado min ≤ base ≤ max",
  });

const codigoRazon = z.enum(BBQ_REASON_CODES);

/**
 * O hay número, o está escrito POR QUÉ no lo hay.
 *
 * Es una unión discriminada y no un `number | null` para que sea imposible
 * ponerle un valor por omisión encima: quien la consume tiene que ramificar. Es
 * el caso del §13 —corte sin factor de rendimiento— donde pasar de crudo a
 * servible uno a uno inventaría comida que no existe.
 */
const rangoODesconocidoSchema = z.discriminatedUnion("known", [
  z.object({ known: z.literal(true), value: rangoSchema }),
  z.object({ known: z.literal(false), reason: codigoRazon }),
]);

/**
 * Una RAZÓN de cobertura: la fracción de gente (o de cortes) sobre la que sí
 * hay dato. Va entre 0 y 1, no en conteos.
 *
 * El motor la emite así —`redondear2(apetitosConocidos / activos)`— y por eso
 * acá tiene que entrar así: en un asado de once personas con tres apetitos sin
 * declarar el valor es 0,73. Este esquema pedía `.int()`, así que rechazaba
 * exactamente la estimación que este sprint existe para calcular. Y la escala
 * importa: `confidence` compara estas cinco contra umbrales de 0,8 y 0,5
 * (`policy.confidence`), umbrales que sobre un conteo no significarían nada.
 */
const razonDeCobertura = z.number().finite().min(0).max(1);

const razonSchema = z.object({
  code: codigoRazon,
  params: z.record(z.union([z.string(), z.number()])),
  text: z.string().min(1),
});

const revisionRequeridaSchema = z.object({
  code: codigoRazon,
  scope: z.enum(["EVENT", "CUT", "PARTICIPANTS"]),
  ref: z.string().nullable(),
  text: z.string().min(1),
});

// ---------------------------------------------------------------------------
// ENTRADA congelada
// ---------------------------------------------------------------------------

/**
 * El participante tal como queda FOSILIZADO en la revisión: exactamente lo que
 * el motor recibió, y nada más.
 *
 * Sin nombre, sin sexo, sin peso, sin estatura, sin la nota de alergia. Un
 * invitado es un tercero que no firmó nada: una revisión que copiara su nombre
 * lo conservaría para siempre, en cada asado en que estuvo, aunque mañana se
 * borre su ficha. Y el cálculo no los necesita — el "¿por qué esta cantidad?"
 * muestra CONTEOS, no una lista de personas.
 *
 * `dietaryFlags: null` es "no sabemos" y `[]` es "declaró que no tiene
 * restricciones": dos hechos distintos que el motor cuenta distinto.
 */
export const participanteCongeladoSchema: z.ZodType<BbqParticipantInput, z.ZodTypeDef, unknown> =
  z.object({
    id: z.string().uuid(),
    kind: z.enum(["HOUSEHOLD_MEMBER", "GUEST"]),
    ageGroup: z.enum(GRUPOS_EDAD),
    appetite: z.enum(["LOW", "NORMAL", "HIGH", "VERY_HIGH", "UNKNOWN"]),
    attendance: z.enum(ASISTENCIAS),
    dietaryFlags: z
      .array(
        z.enum([
          "ALLERGY_REPORTED",
          "VEGETARIAN",
          "VEGAN",
          "NO_PORK",
          "NO_BEEF",
          "NO_FISH",
          "OTHER_DIETARY_NOTE",
        ]),
      )
      .nullable(),
    /**
     * Lo que la casa ya sabe que esta persona NO puede comer, como ids de items
     * del menú. Sin el motivo: acá no viaja ni el ingrediente ni el diagnóstico,
     * así que ni la revisión congelada ni la pantalla pueden contarlo.
     * `null` = es un invitado y no tiene ficha en la casa.
     */
    recordedBlocks: z
      .object({
        blockedItemIds: z.array(z.string().uuid()),
        allergyItemIds: z.array(z.string().uuid()),
      })
      .nullable(),
    /** Siempre `null`: esta superficie no lee antropometría de nadie (§16/§78). */
    approxWeightKg: z.number().nullable(),
  });

export const itemMenuCongeladoSchema: z.ZodType<BbqMenuItemInput, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  kind: z.enum(["MEAT", "SIDE", "BEVERAGE", "NON_FOOD"]),
  category: z.enum(CATEGORIAS_MENU).nullable(),
  cutRef: z.string().nullable(),
  displayName: z.string().min(1),
  /** `null` en todos = modo AUTO: el motor reparte. Con valor, suman 100. */
  distributionPct: z.number().min(0).max(100).nullable(),
  cookingMethod: z.string().nullable(),
  equipmentId: z.string().nullable(),
});

/**
 * El contexto del plan: lo que la persona respondió en el armador.
 *
 * Va en su propia columna (`plan_context`) porque tiene un dueño distinto de
 * los participantes y del menú, y cuando algo no cuadra hay que poder mirar
 * UNA de las tres.
 */
export const contextoPlanSchema = z.object({
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** `null` = no declarada. Nunca 0: un evento de cero horas no existe. */
  durationHours: z.number().positive().nullable(),
  mealContext: z.enum(CONTEXTOS_COMIDA).nullable(),
  sidesLevel: z.enum(["NONE", "LIGHT", "MEDIUM", "ABUNDANT"]).nullable(),
  /**
   * `kind: null` = la persona todavía no dijo si quiere que sobre. No es NONE:
   * "no quiero que sobre" es una decisión y "no lo he pensado" no lo es.
   */
  desiredLeftover: z.object({
    kind: z.enum(["NONE", "SMALL_BUFFER", "ONE_EXTRA_MEAL", "CUSTOM"]).nullable(),
    /** Solo con CUSTOM. */
    customG: z.number().nonnegative().nullable(),
  }),
  /**
   * El margen de incertidumbre va SEPARADO del sobrante deseado (§26): son dos
   * decisiones distintas —"por si acaso" y "quiero comer esto el domingo"— y
   * mezcladas nadie puede bajar una sin bajar la otra.
   */
  safetyBufferPct: z.number().min(0).max(100).nullable(),
});
export type ContextoPlan = z.infer<typeof contextoPlanSchema>;

/**
 * La entrada completa, tal como quedó repartida en las cinco columnas.
 *
 * `policy` y `yieldInputs` se guardan enteros pero la pantalla no los
 * interpreta: existen para poder REPRODUCIR el cálculo, no para dibujarlo. Por
 * eso viajan como objetos sin forma declarada acá — el dueño de su forma es el
 * motor, y copiarla acá crearía una segunda verdad que se desincroniza sola.
 */
export const entradaEstimacionSchema = contextoPlanSchema.extend({
  participants: z.array(participanteCongeladoSchema),
  menu: z.array(itemMenuCongeladoSchema),
  policy: z.record(z.unknown()),
  yieldInputs: z.record(z.unknown()),
});
export type EntradaEstimacion = z.infer<typeof entradaEstimacionSchema>;

// ---------------------------------------------------------------------------
// SALIDA congelada: la del motor, sin traducir
// ---------------------------------------------------------------------------

const asistenciaContada = z.object({
  INVITED: z.number().int().nonnegative(),
  CONFIRMED: z.number().int().nonnegative(),
  MAYBE: z.number().int().nonnegative(),
  DECLINED: z.number().int().nonnegative(),
  ATTENDED: z.number().int().nonnegative(),
  NO_SHOW: z.number().int().nonnegative(),
});

const tramoCadenaSchema = z.object({
  stage: z.enum(YIELD_STAGES),
  factor: z.number().nullable(),
  source: z.enum(["CUT_DEFINITION", "INGREDIENT_YIELD", "HOUSEHOLD_OBSERVED"]).nullable(),
  observations: z.number().int().nonnegative(),
  conflict: z.boolean(),
});

/**
 * Las tandas: exactas, un rango, o el motivo por el que no se saben.
 *
 * Va como `union` y no como `discriminatedUnion` porque los dos casos conocidos
 * comparten el mismo valor de `known` —Zod exige un discriminante único— y el
 * segundo nivel discrimina por `kind`. Anidar dos uniones discriminadas leería
 * peor de lo que resuelve.
 */
const tandasSchema = z.union([
  z.object({
    known: z.literal(true),
    kind: z.literal("EXACT"),
    batches: z.number().int().positive(),
  }),
  z.object({
    known: z.literal(true),
    kind: z.literal("RANGE"),
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  }),
  z.object({ known: z.literal(false), reason: codigoRazon }),
]);

/**
 * Lo que sale de la despensa.
 *
 * Cuando el lote no se puede mapear a una etapa física conocida, el motor
 * devuelve `known: false` CON el valor nominal aparte: hay tres kilos ahí, pero
 * nadie puede afirmar cuántos de esos tres kilos llegan al plato. La pantalla
 * muestra las dos cosas y no resta.
 */
const inventarioSchema = z.discriminatedUnion("known", [
  z.object({
    known: z.literal(true),
    grams: z.number().nonnegative(),
    frozenGrams: z.number().nonnegative(),
    lotIds: z.array(z.string()),
  }),
  z.object({
    known: z.literal(false),
    reason: codigoRazon,
    faceValueGrams: z.number().nonnegative(),
    lotIds: z.array(z.string()),
  }),
]);

const corteSchema = z.object({
  itemId: z.string(),
  cutRef: z.string().nullable(),
  displayName: z.string(),
  category: z.enum(CATEGORIAS_MENU).nullable(),
  servable: rangoSchema,
  cooked: rangoODesconocidoSchema,
  rawEdible: rangoODesconocidoSchema,
  rawPurchase: rangoODesconocidoSchema,
  inventoryToUse: inventarioSchema,
  purchaseRequired: rangoODesconocidoSchema,
  batches: tandasSchema,
  chain: z.array(tramoCadenaSchema),
  flags: z.array(codigoRazon),
});

/**
 * La salida del motor, validada al leerla del `jsonb`.
 *
 * El tipo lo pone el motor. Si mañana `BbqQuantityResult` gana un campo o
 * cambia uno, este archivo deja de compilar — que es exactamente lo que tiene
 * que pasar antes de que la pantalla dibuje kilos que ya no significan lo mismo.
 */
export const salidaEstimacionSchema: z.ZodType<BbqQuantityResult, z.ZodTypeDef, unknown> = z.object({
  engineVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  policySource: z.string(),
  inputSignature: z.string().min(1),
  headcount: z.object({
    participants: z.number().int().nonnegative(),
    counted: z.number().int().nonnegative(),
    adults: z.number().int().nonnegative(),
    children: z.number().int().nonnegative(),
    unknownAge: z.number().int().nonnegative(),
    householdMembers: z.number().int().nonnegative(),
    guests: z.number().int().nonnegative(),
    byAttendance: asistenciaContada,
    effective: rangoSchema,
  }),
  demand: z.object({
    participants: rangoSchema,
    desiredLeftoverGrams: z.number().nonnegative(),
    safetyBuffer: rangoSchema,
    total: rangoSchema,
  }),
  totalServableDemand: rangoSchema,
  byCut: z.array(corteSchema),
  uncoveredServableDemand: rangoSchema.nullable(),
  expectedLeftovers: z.object({
    range: rangoSchema,
    basis: z.literal("BEFORE_COMMERCIAL_ROUNDING"),
  }),
  knownPurchaseSubtotal: rangoSchema,
  totalPurchaseRequired: rangoODesconocidoSchema,
  coverage: z.object({
    appetiteKnown: razonDeCobertura,
    ageKnown: razonDeCobertura,
    dietaryInfoKnown: razonDeCobertura,
    attendanceConfirmed: razonDeCobertura,
    cutsWithFullChain: razonDeCobertura,
  }),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  reasons: z.array(razonSchema),
  reviewRequired: z.array(revisionRequeridaSchema),
});

/** La revisión completa, como la devuelve la base. */
export interface Revision {
  id: string;
  eventId: string;
  numero: number;
  inputSignature: string;
  createdAt: string;
  entrada: EntradaEstimacion;
  salida: BbqQuantityResult;
  /** Lo que la persona decidió comprar de verdad, si cambió la recomendación. */
  overrideG: number | null;
  overrideNota: string | null;
}
