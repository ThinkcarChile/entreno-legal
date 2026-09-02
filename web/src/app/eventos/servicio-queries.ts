import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { columnsOf, dateString, nullableNumeric, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import type { LineaBalanceInput, ResumenEvento } from "@/domain/events/learning/resumen";
import { resumirEvento } from "@/domain/events/learning/resumen";
import type { Participante } from "./queries";

/**
 * Las lecturas de los HECHOS del evento: lo servido, lo que volvió y lo que se
 * estimó consumido.
 *
 * Están en su propio archivo y no en `queries.ts` por una razón que se nota
 * cuando algo falla: las lecturas del PLAN contestan "qué vamos a hacer" y
 * éstas "qué pasó". Cuando el resumen del asado dice algo raro, hay un solo
 * archivo que mirar.
 *
 * Igual que en el resto de la app: un error de consulta NUNCA se convierte en
 * "no hay nada". Se lanza `DataAccessError` y la pantalla muestra el error —
 * porque "no se sirvió nada" y "no pude leer lo servido" llevan a decisiones
 * opuestas con la carne en la parrilla.
 */

type Db = SupabaseClient;

// ---------------------------------------------------------------------------
// Lo servido
// ---------------------------------------------------------------------------

const renglonColumnas = z.object({
  id: uuid,
  record_id: uuid,
  menu_item_id: uuid.nullable(),
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  label: z.string(),
  served_quantity: z.coerce.number(),
  served_unit: z.string(),
  served_weight_basis: z.string(),
  deducted_quantity: z.coerce.number(),
  discarded_quantity: z.coerce.number(),
  status: z.string(),
});

const SELECT_RENGLON = columnsOf(renglonColumnas);

export interface RenglonServido {
  id: string;
  registroId: string;
  itemMenuId: string | null;
  label: string;
  /** Lo que salió a la mesa. */
  cantidad: number;
  unidad: string;
  /** Base física declarada. Cocido y crudo NO se restan entre sí. */
  base: string;
  /** Cuánto de eso el libro mayor respaldó con lotes. */
  descontado: number;
  /** Merma declarada sobre este renglón. */
  botado: number;
  tanda: number | null;
  /** Sobras que ya volvieron al inventario desde este renglón. */
  guardado: number;
}

const registroColumnas = z.object({
  id: uuid,
  event_id: uuid,
  served_on: dateString,
  batch_number: z.number().int().nullable(),
  status: z.string(),
});

/**
 * Lo servido VIGENTE en el evento, renglón por renglón, con lo que ya volvió.
 *
 * DOS COSAS QUE ACÁ SE HACEN A PROPÓSITO:
 *
 *  1. Sólo los renglones ACTIVE. Un servido anulado (`void_event_serving_item`)
 *     ya devolvió sus gramos al lote con un ajuste de despensa; seguir
 *     mostrándolo sería contar dos veces la misma carne.
 *
 *  2. "CUÁNTO SOBRÓ" SE LEE DEL LIBRO MAYOR, NO DEL SALDO DE LOS LOTES. La
 *     versión anterior sumaba `inventory_lots.quantity` de los lotes de sobra:
 *     si el martes te comías la sobra, el asado del sábado pasaba a declarar
 *     que no sobró nada. Eso es historia cambiada por un hecho posterior y
 *     ajeno. Los movimientos `LEFTOVER_RETURN` son inmutables y contestan la
 *     pregunta correcta —cuánto VOLVIÓ— en vez de "cuánto queda hoy".
 *
 * Tres consultas y no un join anidado: pedirlas embebidas obliga a PostgREST a
 * adivinar la relación. Acá se piden explícitas y se cruzan en memoria.
 */
export async function cargarServido(db: Db, eventoId: string): Promise<RenglonServido[]> {
  const { data: registros, error: errorRegistros } = await db
    .from("event_serving_records")
    .select(columnsOf(registroColumnas))
    .eq("event_id", eventoId)
    .eq("status", "ACTIVE");
  if (errorRegistros) throw new DataAccessError("registros de servido del evento", errorRegistros);

  const filasRegistro = parseRows(registroColumnas, registros, "registros de servido del evento");
  if (filasRegistro.length === 0) return [];

  const porRegistro = new Map(filasRegistro.map((r) => [r.id, r]));

  const { data, error } = await db
    .from("event_serving_items")
    .select(SELECT_RENGLON)
    .eq("status", "ACTIVE")
    .in(
      "record_id",
      filasRegistro.map((r) => r.id),
    );
  if (error) throw new DataAccessError("renglones servidos del evento", error);

  const renglones = parseRows(renglonColumnas, data, "renglones servidos del evento");
  if (renglones.length === 0) return [];

  const { data: movimientos, error: errorMovimientos } = await db
    .from("inventory_movements")
    .select("event_serving_item_id, covers_quantity")
    .eq("reason", "LEFTOVER_RETURN")
    .in(
      "event_serving_item_id",
      renglones.map((r) => r.id),
    );
  if (errorMovimientos)
    throw new DataAccessError("sobras guardadas del evento", errorMovimientos);

  const movimientoSchema = z.object({
    event_serving_item_id: uuid,
    // Negativa por construcción: la sobra GASTA del renglón que la sirvió.
    covers_quantity: z.coerce.number(),
  });
  const guardadoPorRenglon = new Map<string, number>();
  for (const m of parseRows(movimientoSchema, movimientos, "sobras guardadas del evento")) {
    const previo = guardadoPorRenglon.get(m.event_serving_item_id);
    guardadoPorRenglon.set(
      m.event_serving_item_id,
      (previo === undefined ? 0 : previo) - m.covers_quantity,
    );
  }

  return renglones
    .map((r) => {
      const registro = porRegistro.get(r.record_id);
      const guardado = guardadoPorRenglon.get(r.id);
      return {
        id: r.id,
        registroId: r.record_id,
        itemMenuId: r.menu_item_id,
        label: r.label,
        cantidad: r.served_quantity,
        unidad: r.served_unit,
        base: r.served_weight_basis,
        descontado: r.deducted_quantity,
        botado: r.discarded_quantity,
        tanda: registro === undefined ? null : registro.batch_number,
        // Sin movimiento de sobra el valor es 0 de verdad: el libro mayor se
        // leyó y no tiene ninguno. Esto NO es el `?? 0` que tapa un desconocido
        // — es el resultado de una lectura exitosa.
        guardado: guardado === undefined ? 0 : guardado,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// El balance de masa declarado
// ---------------------------------------------------------------------------

const balanceColumnas = z.object({
  id: uuid,
  menu_item_id: uuid.nullable(),
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  label: z.string(),
  unit: z.string(),
  raw_input_quantity: nullableNumeric,
  served_quantity: nullableNumeric,
  consumed_min_quantity: nullableNumeric,
  consumed_max_quantity: nullableNumeric,
  edible_leftover_quantity: nullableNumeric,
  plate_waste_quantity: nullableNumeric,
  trim_waste_quantity: nullableNumeric,
  bone_discard_quantity: nullableNumeric,
  spoiled_quantity: nullableNumeric,
  confidence: z.string(),
  created_at: z.string(),
});

export interface BalanceDeclarado {
  id: string;
  itemMenuId: string | null;
  label: string;
  unidad: string;
  crudoQueEntro: number | null;
  servido: number | null;
  sobraComestible: number | null;
  mermaDePlato: number | null;
  mermaDeLimpieza: number | null;
  hueso: number | null;
  echadoAPerder: number | null;
  confianza: string;
}

/**
 * El balance declarado, quedándose con la ÚLTIMA fila por corte.
 *
 * La tabla es append-only: corregir es agregar una fila nueva que supera a la
 * anterior (mismo patrón que las declaraciones de consumo del Sprint 12). Quien
 * lee toma la última y las anteriores quedan como historia auditable.
 */
export async function cargarBalance(db: Db, eventoId: string): Promise<BalanceDeclarado[]> {
  const { data, error } = await db
    .from("event_consumption_estimates")
    .select(columnsOf(balanceColumnas))
    .eq("event_id", eventoId)
    .order("created_at", { ascending: true });
  if (error) throw new DataAccessError("balance del evento", error);

  const filas = parseRows(balanceColumnas, data, "balance del evento");
  const ultimaPorCorte = new Map<string, BalanceDeclarado>();
  for (const f of filas) {
    const clave = f.menu_item_id ?? `label:${f.label}`;
    ultimaPorCorte.set(clave, {
      id: f.id,
      itemMenuId: f.menu_item_id,
      label: f.label,
      unidad: f.unit,
      crudoQueEntro: f.raw_input_quantity,
      servido: f.served_quantity,
      sobraComestible: f.edible_leftover_quantity,
      mermaDePlato: f.plate_waste_quantity,
      mermaDeLimpieza: f.trim_waste_quantity,
      hueso: f.bone_discard_quantity,
      echadoAPerder: f.spoiled_quantity,
      confianza: f.confidence,
    });
  }
  return [...ultimaPorCorte.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Observaciones por comensal (el único hecho del §52)
// ---------------------------------------------------------------------------

const observacionColumnas = z.object({
  id: uuid,
  participant_id: uuid,
  intake_extent: z.string(),
  estimated_serving_g: nullableNumeric,
  note: z.string().nullable(),
  created_at: z.string(),
});

export type ExtensionComida = "ATE_LITTLE" | "ATE_NORMAL" | "ATE_A_LOT";

export interface ObservacionComensal {
  participanteId: string;
  extension: ExtensionComida | null;
  extensionCruda: string;
  gramosDeclarados: number | null;
  nota: string | null;
}

const EXTENSIONES: readonly ExtensionComida[] = ["ATE_LITTLE", "ATE_NORMAL", "ATE_A_LOT"];

/** La observación VIGENTE de cada comensal: la última escrita. */
export async function cargarObservaciones(
  db: Db,
  eventoId: string,
): Promise<Map<string, ObservacionComensal>> {
  const { data, error } = await db
    .from("event_participant_observations")
    .select(columnsOf(observacionColumnas))
    .eq("event_id", eventoId)
    .order("created_at", { ascending: true });
  if (error) throw new DataAccessError("observaciones del evento", error);

  const vigentes = new Map<string, ObservacionComensal>();
  for (const f of parseRows(observacionColumnas, data, "observaciones del evento")) {
    const conocida = EXTENSIONES.find((e) => e === f.intake_extent);
    vigentes.set(f.participant_id, {
      participanteId: f.participant_id,
      // Un valor que esta versión no conoce se devuelve como null CON el texto
      // crudo al lado, jamás como el primero de la lista.
      extension: conocida === undefined ? null : conocida,
      extensionCruda: f.intake_extent,
      gramosDeclarados: f.estimated_serving_g,
      nota: f.note,
    });
  }
  return vigentes;
}

// ---------------------------------------------------------------------------
// El resumen (§56)
// ---------------------------------------------------------------------------

/**
 * Arma la entrada del motor de resumen cruzando los tres hechos.
 *
 * PRECEDENCIA DE "LO SERVIDO": manda el libro mayor. El balance declarado puede
 * traer su propio `served_quantity` —sirve para el corte que nunca pasó por un
 * renglón— pero cuando hay renglones, el número físico gana. Dos fuentes para
 * el mismo hecho necesitan un orden escrito, o la pantalla muestra una y el
 * aprendizaje lee la otra.
 */
export function armarResumen(
  servido: readonly RenglonServido[],
  balance: readonly BalanceDeclarado[],
  participantes: readonly Participante[],
  extras: { compradoG: number | null },
): ResumenEvento {
  const servidoPorClave = new Map<string, { cantidad: number; descontado: number; label: string }>();
  for (const r of servido) {
    const clave = r.itemMenuId ?? `label:${r.label}`;
    const previo = servidoPorClave.get(clave);
    servidoPorClave.set(clave, {
      label: r.label,
      cantidad: (previo === undefined ? 0 : previo.cantidad) + r.cantidad,
      descontado: (previo === undefined ? 0 : previo.descontado) + r.descontado,
    });
  }

  const claves = new Set<string>([
    ...servidoPorClave.keys(),
    ...balance.map((b) => b.itemMenuId ?? `label:${b.label}`),
  ]);

  const lineas: LineaBalanceInput[] = [...claves]
    .map((clave) => {
      const fisico = servidoPorClave.get(clave);
      const declarado = balance.find((b) => (b.itemMenuId ?? `label:${b.label}`) === clave);
      return {
        ref: clave,
        label: fisico?.label ?? declarado?.label ?? "Sin nombre",
        unit: "G" as const,
        servedG: fisico !== undefined ? fisico.cantidad : (declarado?.servido ?? null),
        deductedG: fisico !== undefined ? fisico.descontado : null,
        rawInputG: declarado?.crudoQueEntro ?? null,
        edibleLeftoverG: declarado?.sobraComestible ?? null,
        plateWasteG: declarado?.mermaDePlato ?? null,
        trimWasteG: declarado?.mermaDeLimpieza ?? null,
        boneDiscardG: declarado?.hueso ?? null,
        spoiledG: declarado?.echadoAPerder ?? null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // Lo que VOLVIÓ al refrigerador, leído de los movimientos LEFTOVER_RETURN
  // (ver `cargarServido`). No es "cuánto queda hoy de esa sobra": si alguien se
  // la comió el martes, el asado del sábado igual sobró lo que sobró.
  const sobraQueVolvio = servido.reduce((acc, r) => acc + r.guardado, 0);

  return resumirEvento({
    asistencia: {
      // Persona por persona: quien confirmó y no tiene marca NO es un ausente,
      // es alguien que nadie miró. Antes se contaba una sola marca en todo el
      // evento como "ya pasaron lista" y los demás caían del lado equivocado.
      confirmadosSinMarcar: participantes.filter((p) => p.asistencia === "CONFIRMED").length,
      asistieron: participantes.filter((p) => p.asistencia === "ATTENDED" && !p.esExtra).length,
      noLlegaron: participantes.filter((p) => p.asistencia === "NO_SHOW").length,
      extras: participantes.filter((p) => p.asistencia === "ATTENDED" && p.esExtra).length,
    },
    lineas,
    compradoG: extras.compradoG,
    // Cero movimientos de sobra con renglones servidos SÍ significa cero: el
    // libro mayor se leyó y no volvió nada. Sin renglones no se sabe, y se dice.
    sobraEnLotesG: servido.length === 0 ? null : sobraQueVolvio,
  });
}
