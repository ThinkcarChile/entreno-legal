import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { columnsOf, nullableNumeric, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import type { ProcedenciaEvento } from "./lineas";

/**
 * LO QUE LA LISTA DE COMPRAS YA DICE SOBRE ESTE EVENTO.
 *
 * Una sola regla manda acá: el estado de cada línea se lee tal cual está
 * escrito y no se resume en "listo / no listo". PENDING, PURCHASED, SKIPPED y
 * HAVE_ENOUGH significan cosas distintas y una de ellas —PURCHASED— es
 * irreversible en el mundo real: esa carne está en el refrigerador. Cuando el
 * evento se cancela, la 0041 retira las PENDING y deja las PURCHASED intactas;
 * la pantalla tiene que poder contar las dos cosas por separado o el hogar se
 * queda con ocho kilos de carne y sin nadie que se lo diga (§83).
 */

type Db = SupabaseClient;

export type EstadoLinea = "PENDING" | "PURCHASED" | "SKIPPED" | "HAVE_ENOUGH";
export type EstadoLista = "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";

/**
 * La procedencia guardada. El `catch` NO traga el error: una procedencia con
 * otra forma se muestra como "sin detalle" en vez de reventar la pantalla del
 * evento, porque la línea de compra y su cantidad —que es lo que importa— se
 * leen bien igual.
 */
const procedenciaEvento = z.object({
  kind: z.literal("EVENT"),
  eventId: z.string(),
  title: z.string(),
  date: z.string(),
  itemId: z.string(),
  cut: z.string(),
  quantity: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});

const lineaColumnas = z.object({
  id: uuid,
  list_id: uuid,
  line_key: z.string().nullable(),
  label: z.string(),
  unit: z.enum(["G", "ML", "UNIT"]),
  required_quantity: nullableNumeric,
  planned_quantity: nullableNumeric,
  purchase_basis: z.string(),
  unresolved: z.boolean(),
  unresolved_reason: z.string().nullable(),
  status: z.enum(["PENDING", "PURCHASED", "SKIPPED", "HAVE_ENOUGH"]),
  status_reason: z.string().nullable(),
  provenance: z.unknown(),
});

export interface LineaGuardada {
  id: string;
  listaId: string;
  lineKey: string | null;
  label: string;
  unidad: "G" | "ML" | "UNIT";
  /** Lo que el cálculo pidió. */
  requerido: number | null;
  /** Lo que la persona decidió comprar, si lo editó (§79). */
  planificado: number | null;
  baseDeCompra: string;
  sinCantidad: boolean;
  motivo: string | null;
  estado: EstadoLinea;
  motivoEstado: string | null;
  procedencia: ProcedenciaEvento[];
}

export interface ComprasDelEvento {
  lineas: LineaGuardada[];
  /** La lista semanal donde entró la demanda (la del súper de esa semana). */
  semanal: { id: string; estado: EstadoLista } | null;
  /** La lista aparte "falta adquirir", si hubo que abrirla (§82). */
  delta: { id: string; estado: EstadoLista } | null;
}

export async function cargarComprasDelEvento(
  db: Db,
  eventoId: string,
): Promise<ComprasDelEvento> {
  const { data, error } = await db
    .from("shopping_list_items")
    .select(`${columnsOf(lineaColumnas)}, shopping_lists!inner ( id, status, event_id )`)
    .eq("event_id", eventoId);
  if (error) throw new DataAccessError("compras del evento", error);

  const cabecera = z
    .union([
      z.object({ id: uuid, status: z.string(), event_id: uuid.nullable() }),
      z.array(z.object({ id: uuid, status: z.string(), event_id: uuid.nullable() })),
      z.null(),
    ])
    .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

  const filas = parseRows(
    lineaColumnas.extend({ shopping_lists: cabecera }),
    data,
    "compras del evento",
  );

  let semanal: ComprasDelEvento["semanal"] = null;
  let delta: ComprasDelEvento["delta"] = null;
  for (const f of filas) {
    const lista = f.shopping_lists;
    if (lista === null) continue;
    const estado = comoEstadoDeLista(lista.status);
    if (estado === null) continue;
    if (lista.event_id === null) semanal = { id: lista.id, estado };
    else delta = { id: lista.id, estado };
  }

  return {
    lineas: filas.map((f) => ({
      id: f.id,
      listaId: f.list_id,
      lineKey: f.line_key,
      label: f.label,
      unidad: f.unit,
      requerido: f.required_quantity,
      planificado: f.planned_quantity,
      baseDeCompra: f.purchase_basis,
      sinCantidad: f.unresolved,
      motivo: f.unresolved_reason,
      estado: f.status,
      motivoEstado: f.status_reason,
      procedencia: leerProcedencia(f.provenance),
    })),
    semanal,
    delta,
  };
}

function comoEstadoDeLista(crudo: string): EstadoLista | null {
  return crudo === "DRAFT" || crudo === "ACTIVE" || crudo === "COMPLETED" || crudo === "CANCELLED"
    ? crudo
    : null;
}

function leerProcedencia(valor: unknown): ProcedenciaEvento[] {
  const leido = z.array(procedenciaEvento).safeParse(valor);
  // Una procedencia que esta versión no sabe leer se muestra vacía, no
  // inventada. No se usa `?? []` sobre el valor crudo: eso confundiría "no hay
  // procedencia" con "hay una que no entiendo".
  return leido.success ? leido.data : [];
}

/**
 * Cuántos gramos de compra quedaron comprometidos POR CORTE del menú.
 *
 * Hace falta para el sobrante real: el redondeo comercial ocurre por línea de
 * compra (una caja de 5 kg), pero la conversión a peso servible es por corte
 * (cada uno tiene su hueso y su merma). Cuando una línea junta dos cortes, lo
 * comprometido se reparte entre ellos EN LA MISMA PROPORCIÓN en que el motor
 * los pidió: es el único reparto que no inventa una preferencia que nadie
 * declaró.
 *
 * Las líneas retiradas (SKIPPED) o marcadas "ya lo tengo" no comprometen nada.
 */
export function comprometidoPorCorte(lineas: readonly LineaGuardada[]): Record<string, number> {
  const salida: Record<string, number> = {};
  for (const linea of lineas) {
    if (linea.estado === "SKIPPED" || linea.estado === "HAVE_ENOUGH") continue;
    if (linea.unidad !== "G") continue;
    const total = linea.planificado ?? linea.requerido;
    if (total === null) continue;

    const conCantidad = linea.procedencia.filter(
      (p): p is ProcedenciaEvento & { quantity: number } => p.quantity !== null && p.quantity > 0,
    );
    const suma = conCantidad.reduce((acc, p) => acc + p.quantity, 0);
    if (suma <= 0) continue;
    for (const p of conCantidad) {
      salida[p.itemId] = (salida[p.itemId] ?? 0) + (total * p.quantity) / suma;
    }
  }
  return salida;
}

/* -------------------------------------------------------------------------- */
/* Lo que hay en la despensa y NO se pudo netear                               */
/* -------------------------------------------------------------------------- */

const loteSueltoColumnas = z.object({
  id: uuid,
  label: z.string(),
  quantity: numeric,
  unit: z.enum(["G", "ML", "UNIT"]),
  weight_basis: z.string(),
});

export interface LoteNoNeteable {
  id: string;
  label: string;
  cantidad: number;
  unidad: "ML" | "UNIT";
}

/**
 * Lotes de los cortes del evento que existen, están disponibles y aun así NO
 * entraron al descuento porque están contados en unidades o mililitros.
 *
 * El motor trabaja en gramos y no hay peso por unidad declarado para
 * convertirlos ("6 longanizas" no son 900 g sin que alguien lo diga). Dejarlos
 * fuera en silencio haría comprar de más sin que nadie entienda por qué; se
 * muestran acá para que la persona decida.
 */
export async function cargarLotesNoNeteables(
  db: Db,
  householdId: string,
  cortes: readonly string[],
): Promise<LoteNoNeteable[]> {
  if (cortes.length === 0) return [];
  const { data, error } = await db
    .from("inventory_lots")
    .select(columnsOf(loteSueltoColumnas))
    .eq("household_id", householdId)
    .eq("status", "AVAILABLE")
    .gt("quantity", 0)
    .neq("unit", "G")
    .in("ingredient_id", [...cortes]);
  if (error) throw new DataAccessError("lotes no comparables del evento", error);

  return parseRows(loteSueltoColumnas, data, "lotes no comparables del evento").map((l) => ({
    id: l.id,
    label: l.label,
    cantidad: l.quantity,
    unidad: l.unit === "ML" ? "ML" : "UNIT",
  }));
}
