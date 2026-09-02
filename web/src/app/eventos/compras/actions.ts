"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { numeric, parseRows, uuid } from "@/lib/supabase/rows";
import { weekStart } from "@/domain/nutrition/calendar";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { cargarEvento, cargarMenu, cargarRevisionVigente } from "../queries";
import { planDeCompraDelEvento, type LineaCompraEvento } from "./lineas";
import { BASE_DE_COMPRA_DEL_EVENTO } from "./bases";

/**
 * LA DEMANDA DEL ASADO ENTRA A LA COMPRA POR LA MISMA PUERTA QUE TODO LO DEMÁS.
 *
 * No hay lista paralela (§31): se escribe en `shopping_list_items` de la lista
 * de la semana del evento, con `source = 'EVENT'` y `event_id`, exactamente
 * como `addReorderToShoppingList` escribe las sugerencias de la despensa. De
 * ahí en adelante todo lo que ya existe sigue funcionando sin tocar una línea:
 *
 *  - el ProcurementEngine lee TODAS las líneas pendientes sin mirar procedencia
 *    (`loadPendingListItems`), así que la carne del asado no se pide dos veces,
 *    una al súper y otra al proveedor (§32);
 *  - el redondeo a presentación comercial lo hace ese mismo motor (§28), acá
 *    no se redondea nada;
 *  - la recepción crea los lotes por los RPC de siempre: un evento no abre una
 *    segunda puerta al inventario.
 *
 * TRES COSAS QUE ESTA ACCIÓN NO HACE, y cada una tiene su razón:
 *
 *  1. No pisa `planned_quantity`. Esa columna es lo que la persona decidió
 *     comprar ("quiero un kilo más", §79). Recalcular actualiza la NECESIDAD
 *     (`required_quantity`) y deja la decisión donde está.
 *  2. No toca una línea ya comprada. La compra ocurrió; reescribirla borraría
 *     el registro de lo que entró a la casa (§35, demo M).
 *  3. No borra nada. Un corte que salió del menú deja su línea marcada como
 *     retirada, con el motivo escrito: la lista es historia.
 */

export interface ResultadoCompras {
  ok: boolean;
  error?: string;
  message?: string;
  /** Avisos que NO son errores pero que la persona tiene que leer. */
  avisos?: string[];
}

type Db = SupabaseClient;

async function cliente(): Promise<Db> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/eventos");
  return supabase;
}

/**
 * El error del servidor, entero. Mismo criterio que el resto de la superficie
 * de eventos: "algo salió mal" deja a la persona parada frente a un muro.
 */
function textoDelError(error: {
  message: string;
  details?: string | null;
  hint?: string | null;
}): string {
  return [error.message, error.details, error.hint]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" — ");
}

const peticion = z.object({ eventoId: z.string().uuid() });

export async function enviarComprasDelEvento(entrada: unknown): Promise<ResultadoCompras> {
  const validado = peticion.safeParse(entrada);
  if (!validado.success) return { ok: false, error: "Falta el evento." };
  const eventoId = validado.data.eventoId;

  const db = await cliente();
  const { householdId } = await loadHouseholdMembers(db);
  if (!householdId) return { ok: false, error: "Primero crea o únete a un hogar." };

  const evento = await cargarEvento(db, eventoId);
  if (evento === null) return { ok: false, error: "Ese evento no existe o no es de tu hogar." };
  if (evento.estado === "CANCELLED") {
    return {
      ok: false,
      error:
        "Este evento está cancelado: no manda nada a la compra. Lo que ya se compró para él sigue " +
        "en tu despensa y lo puedes reasignar desde la ficha del evento.",
    };
  }
  if (evento.estado === "COMPLETED") {
    return {
      ok: false,
      error: "Este evento ya terminó: su compra es historia y no se vuelve a escribir.",
    };
  }
  // MANDAR LA CARNE A LA LISTA EXIGE QUE EL EVENTO YA HAYA RELEVADO EL PLAN.
  //
  // Acá antes sólo se rechazaba CANCELLED y COMPLETED, así que un evento en
  // DRAFT o PLANNED escribía sus kilos en la lista de compras. Pero el relevo
  // del plan —la comida de la semana que el asado reemplaza— ocurre recién al
  // pasar a CONFIRMED. En esa ventana, que es el orden natural del armador
  // (armo el asado, calculo las cantidades, "mandar a la compra", confirmo
  // después o nunca), la lista pedía la carne del asado Y el almuerzo del plan
  // de ese mismo día. Comprar dos veces es exactamente lo que este módulo
  // existe para impedir.
  //
  // El costo de negarse es chico y reversible: confirmar el evento es un botón.
  // El de dejar pasar es plata gastada y comida que nadie come.
  if (evento.estado !== "CONFIRMED" && evento.estado !== "IN_PROGRESS") {
    return {
      ok: false,
      error:
        "Confirma el evento antes de mandarlo a la compra. Mientras no esté confirmado, la comida " +
        "de tu plan de ese día sigue en la lista: se compraría dos veces.",
    };
  }

  const revision = await cargarRevisionVigente(db, eventoId);
  if (revision === null) {
    return {
      ok: false,
      error:
        "Todavía no hay una estimación calculada para este evento. Calcúlala primero: sin ella no " +
        "hay cantidad que pedir, y mandar a comprar «lo que sea» es peor que no mandar nada.",
    };
  }

  const menu = await cargarMenu(db, eventoId);
  const plan = planDeCompraDelEvento({
    eventoId,
    titulo: evento.titulo,
    fecha: evento.fecha,
    salida: revision.salida,
    identidades: menu.map((m) => ({
      itemId: m.id,
      ingredientId: m.ingredientId,
      productId: m.productId,
    })),
  });

  if (plan.lineas.length === 0) {
    return {
      ok: false,
      error: "La estimación de este evento no tiene ninguna carne que comprar.",
      avisos: plan.avisos,
    };
  }

  const lista = await listaDestino(db, householdId, eventoId, evento.fecha);
  if (!lista.ok) return { ok: false, error: lista.error };

  const avisos = [...plan.avisos, ...lista.avisos];

  // Lo que YA VIENE EN CAMINO en órdenes vivas al proveedor cubre parte de esta
  // demanda: pedirla de nuevo la compraría dos veces (§32, neteo en las dos
  // direcciones). Sólo descuenta lo que llega A TIEMPO — una entrega sin fecha
  // comprometida NO se descuenta, porque "no sé cuándo llega" jamás puede
  // leerse como "llega antes del sábado".
  const enCamino = await loQueViene(db, householdId, plan.lineas, evento.fecha, avisos);

  const existentes = await lineasYaEscritas(db, lista.listaId, eventoId);

  let escritas = 0;
  let yaCompradas = 0;
  let cubiertas = 0;
  let noCabieron = 0;
  const clavesDelPlan = new Set<string>();

  for (const linea of plan.lineas) {
    clavesDelPlan.add(linea.lineKey);
    const previa = existentes.get(linea.lineKey) ?? null;

    if (previa !== null && previa.status === "PURCHASED") {
      yaCompradas += 1;
      continue;
    }

    const yaViene = linea.ingredientId === null ? 0 : (enCamino.get(linea.ingredientId) ?? 0);
    const cantidad =
      linea.cantidad === null
        ? null
        : Math.round(Math.max(0, linea.cantidad - yaViene) * 1000) / 1000;

    if (cantidad !== null && cantidad === 0 && yaViene > 0) {
      cubiertas += 1;
      if (previa !== null && previa.status === "PENDING") {
        await retirar(db, previa.id, "Ya viene en camino en un pedido al proveedor.");
      }
      continue;
    }

    const fila = {
      label: linea.label,
      unit: linea.unit,
      required_quantity: cantidad,
      purchase_basis: linea.purchaseBasis,
      unresolved: linea.sinCantidad,
      unresolved_reason: linea.motivo,
      provenance: linea.procedencia,
      updated_at: new Date().toISOString(),
    };

    if (previa !== null) {
      const { error } = await db
        .from("shopping_list_items")
        .update(fila)
        .eq("id", previa.id)
        // Se re-cuantifica sólo lo pendiente: una línea marcada "ya lo tengo" o
        // retirada es una decisión de alguien, y pisarla en silencio la borra.
        .eq("status", "PENDING");
      if (error) return { ok: false, error: textoDelError(error) };
      escritas += 1;
      continue;
    }

    const { error } = await db.from("shopping_list_items").insert({
      list_id: lista.listaId,
      source: "EVENT",
      event_id: eventoId,
      line_key: linea.lineKey,
      ingredient_id: linea.ingredientId,
      product_id: linea.productId,
      ...fila,
    });
    if (error !== null && error.code === "23505") {
      // Dos choques posibles, y NO significan lo mismo:
      //
      //  (a) La misma clave de línea: dos personas apretaron el botón a la vez.
      //      El índice único (list_id, line_key) ya decidió cuál fila existe;
      //      se actualiza esa y no se crea una segunda demanda del asado (§92).
      //
      //  (b) `shopping_items_suggestion_uniq` (0013/0021): la lista sólo admite
      //      UNA línea que no sea del plan ni manual por alimento::unidad::base,
      //      y ahí caen también las del evento. Si ya hay una sugerencia de la
      //      despensa —o de OTRO evento— para el mismo corte, esta no cabe.
      //      Eso NO se puede tapar: la carne del asado quedaría fuera de la
      //      compra sin que nadie se entere.
      const enConflicto = await filaEnConflicto(db, lista.listaId, linea);
      if (enConflicto === null) {
        return { ok: false, error: textoDelError(error) };
      }
      if (enConflicto.eventId === eventoId) {
        const { error: errorSegundo } = await db
          .from("shopping_list_items")
          .update(fila)
          .eq("id", enConflicto.id)
          .eq("status", "PENDING");
        if (errorSegundo) return { ok: false, error: textoDelError(errorSegundo) };
        escritas += 1;
        continue;
      }
      noCabieron += 1;
      avisos.push(
        `${linea.label}: la lista de esa semana ya tiene una línea de este alimento ` +
          `(${ETIQUETA_ORIGEN[enConflicto.source] ?? enConflicto.source}) y sólo cabe una. ` +
          `El asado necesita ${Math.round((cantidad ?? 0) / 10) / 100} kg: revisa esa línea y ` +
          "súbele la cantidad, o vas a comprar corto.",
      );
      continue;
    } else if (error !== null) {
      return { ok: false, error: textoDelError(error) };
    }
    escritas += 1;
  }

  // Un corte que salió del menú deja de pedirse, pero su línea NO se borra: se
  // retira con el motivo escrito. Si ya se compró, no se toca — esa carne está
  // en el refrigerador y el hogar tiene que saberlo.
  let retiradas = 0;
  for (const [clave, previa] of existentes) {
    if (clavesDelPlan.has(clave)) continue;
    if (previa.status !== "PENDING") continue;
    await retirar(db, previa.id, "Salió del menú de este evento.");
    retiradas += 1;
  }

  revalidatePath("/shopping");
  revalidatePath("/eventos");
  revalidatePath(`/eventos/${eventoId}`);
  revalidatePath(`/eventos/${eventoId}/compras`);

  const partes = [`${escritas} ${escritas === 1 ? "línea" : "líneas"} en la compra`];
  if (yaCompradas > 0) {
    partes.push(
      `${yaCompradas} ya ${yaCompradas === 1 ? "estaba comprada y no se tocó" : "estaban compradas y no se tocaron"}`,
    );
  }
  if (cubiertas > 0) partes.push(`${cubiertas} ya viene(n) en camino del proveedor`);
  if (noCabieron > 0) {
    partes.push(`${noCabieron} NO se pudo(pudieron) agregar (lee los avisos)`);
  }
  if (retiradas > 0) partes.push(`${retiradas} retirada(s) porque salieron del menú`);

  return { ok: true, message: `${partes.join("; ")}.`, avisos };
}

/* -------------------------------------------------------------------------- */
/* La lista donde entra la demanda                                             */
/* -------------------------------------------------------------------------- */

type Destino =
  | { ok: true; listaId: string; esDelta: boolean; avisos: string[] }
  | { ok: false; error: string };

/**
 * La demanda va a la lista de la semana DEL EVENTO, no a la de hoy: la carne
 * del asado del sábado hay que traerla en esa compra. Si esa lista ya se cerró
 * —el hogar ya fue al súper— no se reabre: se abre la lista aparte del evento
 * ("falta adquirir", §82), que es exactamente el caso del §82 y de la demo M.
 * Reabrir la lista cerrada reescribiría una compra que ya ocurrió.
 */
async function listaDestino(
  db: Db,
  householdId: string,
  eventoId: string,
  fechaDelEvento: string,
): Promise<Destino> {
  const semana = weekStart(fechaDelEvento);
  const { data: planId, error: errorPlan } = await db.rpc("ensure_weekly_plan", {
    p_household_id: householdId,
    p_week_start: semana,
  });
  if (errorPlan) return { ok: false, error: textoDelError(errorPlan) };
  const plan = z.string().uuid().safeParse(planId);
  if (!plan.success) {
    return { ok: false, error: "No se pudo preparar la semana de compras del evento." };
  }

  const semanal = await leerListaSemanal(db, plan.data);
  if (!semanal.ok) return semanal;

  if (semanal.lista !== null && semanal.lista.status !== "COMPLETED") {
    if (semanal.lista.status === "CANCELLED") {
      return {
        ok: false,
        error:
          "La lista de compras de esa semana está cancelada. Vuelve a activarla en Compras antes " +
          "de mandarle la carne del evento.",
      };
    }
    return { ok: true, listaId: semanal.lista.id, esDelta: false, avisos: [] };
  }

  if (semanal.lista === null) {
    const { error } = await db
      .from("shopping_lists")
      .insert({ household_id: householdId, plan_id: plan.data, status: "ACTIVE" });
    if (error !== null && error.code !== "23505") {
      return { ok: false, error: textoDelError(error) };
    }
    const relectura = await leerListaSemanal(db, plan.data);
    if (!relectura.ok) return relectura;
    if (relectura.lista === null) {
      return { ok: false, error: "No se pudo preparar la lista de compras de esa semana." };
    }
    return { ok: true, listaId: relectura.lista.id, esDelta: false, avisos: [] };
  }

  // La semanal está COMPLETED: lista aparte del evento.
  const existente = await leerListaDelEvento(db, eventoId);
  if (!existente.ok) return existente;
  const aviso =
    "La compra de esa semana ya estaba cerrada, así que esto quedó en una lista aparte del " +
    "evento. La lista de la semana no se reescribe.";

  if (existente.lista !== null) {
    if (existente.lista.status === "CANCELLED") {
      return {
        ok: false,
        error:
          "La lista aparte de este evento está cancelada (pasa cuando el evento se canceló). " +
          "Si el asado se hace igual, vuelve a activarla en Compras.",
      };
    }
    if (existente.lista.status === "COMPLETED") {
      return {
        ok: false,
        error:
          "La lista aparte de este evento ya se finalizó. Reábrela en Compras si todavía falta " +
          "comprar algo: no se le agregan líneas a una compra cerrada.",
      };
    }
    return { ok: true, listaId: existente.lista.id, esDelta: true, avisos: [aviso] };
  }

  const { error } = await db
    .from("shopping_lists")
    .insert({ household_id: householdId, plan_id: plan.data, event_id: eventoId, status: "ACTIVE" });
  if (error !== null && error.code !== "23505") {
    return { ok: false, error: textoDelError(error) };
  }
  const relectura = await leerListaDelEvento(db, eventoId);
  if (!relectura.ok) return relectura;
  if (relectura.lista === null) {
    return { ok: false, error: "No se pudo abrir la lista aparte de este evento." };
  }
  return { ok: true, listaId: relectura.lista.id, esDelta: true, avisos: [aviso] };
}

interface Cabecera {
  id: string;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
}

type Lectura = { ok: true; lista: Cabecera | null } | { ok: false; error: string };

/**
 * La lista de la SEMANA. El `is("event_id", null)` no es cosmético: desde la
 * 0041 una lista aparte de evento vive con el mismo `plan_id`, así que sin ese
 * filtro esta consulta devolvería dos filas y `maybeSingle` reventaría el día
 * que alguien abra una lista delta.
 */
async function leerListaSemanal(db: Db, planId: string): Promise<Lectura> {
  const { data, error } = await db
    .from("shopping_lists")
    .select("id, status")
    .eq("plan_id", planId)
    .is("event_id", null)
    .maybeSingle();
  return interpretarLista(data, error);
}

async function leerListaDelEvento(db: Db, eventoId: string): Promise<Lectura> {
  const { data, error } = await db
    .from("shopping_lists")
    .select("id, status")
    .eq("event_id", eventoId)
    .maybeSingle();
  return interpretarLista(data, error);
}

function interpretarLista(
  data: unknown,
  error: { message: string; details?: string | null; hint?: string | null } | null,
): Lectura {
  if (error) return { ok: false, error: textoDelError(error) };
  if (data === null || data === undefined) return { ok: true, lista: null };
  const fila = z
    .object({ id: uuid, status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]) })
    .safeParse(data);
  if (!fila.success) {
    // Un estado de lista que esta versión no conoce NO se trata como activa:
    // escribir en una lista cuyo estado no entendemos puede estar reescribiendo
    // una compra cerrada.
    return { ok: false, error: "La lista de compras tiene un estado que esta versión no conoce." };
  }
  return { ok: true, lista: fila.data };
}

/* -------------------------------------------------------------------------- */
/* Lecturas de apoyo                                                           */
/* -------------------------------------------------------------------------- */

interface LineaPrevia {
  id: string;
  status: "PENDING" | "PURCHASED" | "SKIPPED" | "HAVE_ENOUGH";
}

async function lineasYaEscritas(
  db: Db,
  listaId: string,
  eventoId: string,
): Promise<Map<string, LineaPrevia>> {
  const { data, error } = await db
    .from("shopping_list_items")
    .select("id, line_key, status")
    .eq("list_id", listaId)
    .eq("event_id", eventoId);
  if (error) throw new DataAccessError("líneas del evento en la lista", error);

  const filas = parseRows(
    z.object({
      id: uuid,
      line_key: z.string().nullable(),
      status: z.enum(["PENDING", "PURCHASED", "SKIPPED", "HAVE_ENOUGH"]),
    }),
    data,
    "líneas del evento en la lista",
  );
  const mapa = new Map<string, LineaPrevia>();
  for (const f of filas) {
    if (f.line_key === null) continue;
    mapa.set(f.line_key, { id: f.id, status: f.status });
  }
  return mapa;
}

const ETIQUETA_ORIGEN: Record<string, string> = {
  FOOD_PLAN: "del plan de la semana",
  MANUAL: "agregada a mano",
  STOCK_INTELLIGENCE: "sugerida por la despensa",
  EVENT: "de otro evento",
};

/**
 * La fila que impidió escribir. Se busca por las DOS claves que pueden chocar,
 * en orden: primero la del propio evento (misma clave de línea) y después la de
 * la sugerencia por alimento. Si no aparece ninguna, el error no era ninguno de
 * los dos casos conocidos y sube tal cual — jamás se traga un choque que no se
 * entiende.
 */
async function filaEnConflicto(
  db: Db,
  listaId: string,
  linea: LineaCompraEvento,
): Promise<{ id: string; eventId: string | null; source: string } | null> {
  const columnas = "id, event_id, source";
  const porClave = await db
    .from("shopping_list_items")
    .select(columnas)
    .eq("list_id", listaId)
    .eq("line_key", linea.lineKey)
    .maybeSingle();
  if (porClave.error) throw new DataAccessError("línea en conflicto del evento", porClave.error);
  const leida = interpretarConflicto(porClave.data);
  if (leida !== null) return leida;

  if (linea.ingredientId === null) return null;
  const porAlimento = await db
    .from("shopping_list_items")
    .select(columnas)
    .eq("list_id", listaId)
    .eq("ingredient_id", linea.ingredientId)
    .eq("unit", linea.unit)
    .eq("purchase_basis", linea.purchaseBasis)
    .not("source", "in", "(FOOD_PLAN,MANUAL)")
    .maybeSingle();
  if (porAlimento.error) {
    throw new DataAccessError("línea en conflicto del evento", porAlimento.error);
  }
  return interpretarConflicto(porAlimento.data);
}

function interpretarConflicto(
  data: unknown,
): { id: string; eventId: string | null; source: string } | null {
  const fila = z
    .object({ id: uuid, event_id: uuid.nullable(), source: z.string() })
    .safeParse(data);
  if (!fila.success) return null;
  return { id: fila.data.id, eventId: fila.data.event_id, source: fila.data.source };
}

async function retirar(db: Db, itemId: string, motivo: string): Promise<void> {
  const { error } = await db
    .from("shopping_list_items")
    .update({ status: "SKIPPED", status_reason: motivo, updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("status", "PENDING");
  if (error) throw new DataAccessError("retiro de una línea del evento", error);
}

/**
 * Gramos que ya vienen del proveedor y llegan a tiempo, por alimento.
 *
 * Una orden sin fecha de entrega comprometida NO descuenta: se avisa y se
 * compra igual. Si llega antes, sobra carne; si se descuenta y no llega, falta
 * — y de los dos errores sólo el primero se arregla en la mesa.
 */
async function loQueViene(
  db: Db,
  householdId: string,
  lineas: readonly LineaCompraEvento[],
  fechaDelEvento: string,
  avisos: string[],
): Promise<Map<string, number>> {
  const ids = lineas
    .map((l) => l.ingredientId)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return new Map();

  const { data, error } = await db
    .from("procurement_order_items")
    .select(
      `ingredient_id, label, suggested_quantity, unit, weight_basis,
       procurement_orders!inner ( household_id, status, expected_delivery_date )`,
    )
    .in("ingredient_id", ids)
    .eq("unit", "G")
    .eq("weight_basis", BASE_DE_COMPRA_DEL_EVENTO)
    .eq("procurement_orders.household_id", householdId)
    .in("procurement_orders.status", ["PLANNED", "ORDERED", "READY", "DELIVERING"]);
  if (error) throw new DataAccessError("pedidos en camino del evento", error);

  const cabecera = z
    .union([
      z.object({ expected_delivery_date: z.string().nullable() }),
      z.array(z.object({ expected_delivery_date: z.string().nullable() })),
      z.null(),
    ])
    .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

  const filas = parseRows(
    z.object({
      ingredient_id: uuid,
      label: z.string(),
      suggested_quantity: numeric,
      procurement_orders: cabecera,
    }),
    data,
    "pedidos en camino del evento",
  );

  const mapa = new Map<string, number>();
  const sinFecha: string[] = [];
  for (const f of filas) {
    const llegada = f.procurement_orders?.expected_delivery_date ?? null;
    if (llegada === null) {
      sinFecha.push(f.label);
      continue;
    }
    if (llegada > fechaDelEvento) continue;
    mapa.set(f.ingredient_id, (mapa.get(f.ingredient_id) ?? 0) + f.suggested_quantity);
  }

  if (sinFecha.length > 0) {
    avisos.push(
      `Hay pedidos al proveedor sin fecha de entrega comprometida (${[...new Set(sinFecha)].join(", ")}): ` +
        "no se descontaron de la compra del evento, porque no saber cuándo llegan no es lo mismo " +
        "que saber que llegan a tiempo.",
    );
  }
  return mapa;
}
