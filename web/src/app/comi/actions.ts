"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { MEAL_TYPES } from "@/domain/recipes/types";
import { columnsOf, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  construirDeclaracionLibre,
  construirDeclaracionServida,
  EXTENTS,
  puedeDarsePorComida,
  VERSION_MOTOR_EXTENT,
  type EntradaServida,
  type ItemDeclarado,
  type RenglonServido,
} from "./extent";

/**
 * Las escrituras de "Lo que comimos". Todas pasan por los RPC de la 0038 —
 * `consumption_logs` e `intake_log_items` tienen revocado el INSERT para
 * `authenticated`, así que no hay otra puerta ni la queremos.
 *
 * REGLA DE ESTE ARCHIVO: EL ERROR DEL SERVIDOR SE MUESTRA TAL CUAL.
 *
 * Los mensajes de la 0038 están escritos para que una persona los entienda y
 * dicen qué hacer ("corrígela con correct_intake_log", "usa log_intake y di
 * cuánto"). Taparlos con un "algo salió mal" convierte una instrucción en un
 * muro. Se muestran completos; lo único que agregamos es el sujeto de la
 * acción cuando el mensaje solo no dice de qué hablaba.
 */

export interface ResultadoAccion {
  ok: boolean;
  error?: string;
  message?: string;
}

async function cliente() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/comi");
  return supabase;
}

function refrescar() {
  revalidatePath("/comi");
}

const marcaSchema = z.object({
  servingRecordItemId: uuid,
  extent: z.enum(EXTENTS),
  /** Solo con EXACT. `null` = la persona no escribió ningún número. */
  cantidadExacta: z.number().finite().nonnegative().nullable(),
});

const renglonLibreSchema = z.object({
  label: z.string().min(1).max(200),
  extent: z.enum(EXTENTS),
});

const contenidoSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("SERVIDO"),
    servingRecordId: uuid,
    marcas: z.array(marcaSchema),
  }),
  z.object({
    tipo: z.literal("LIBRE"),
    renglones: z.array(renglonLibreSchema).min(1),
  }),
]);

const renglonServidoColumnas = z.object({
  id: uuid,
  label: z.string(),
  ingredient_id: uuid.nullable(),
  product_id: uuid.nullable(),
  served_quantity: numeric,
  served_unit: z.enum(["G", "ML", "UNIT"]),
  served_weight_basis: z.enum(["RAW", "COOKED", "DRAINED", "EDIBLE_PORTION", "AS_PACKAGED"]),
  deducted_quantity: numeric,
  discarded_quantity: numeric,
  sort_order: z.number().int(),
});

/**
 * Los renglones servidos se releen de la BASE, nunca se aceptan del cliente.
 *
 * El cliente manda únicamente QUÉ marcó la persona en cada renglón; la
 * etiqueta, la unidad, la base física y cuánto salió del refrigerador son
 * hechos de la 0036 y su único dueño es la base. Si vinieran del formulario,
 * un cliente cualquiera podría declarar "300 g" sobre una porción de 200
 * cambiando un campo escondido, y el número entraría al eje ACTUAL.
 */
async function renglonesDelServido(
  db: SupabaseClient,
  servingRecordId: string,
): Promise<RenglonServido[]> {
  const { data, error } = await db
    .from("meal_serving_record_items")
    .select(columnsOf(renglonServidoColumnas))
    .eq("record_id", servingRecordId)
    .order("sort_order", { ascending: true });
  if (error) throw new DataAccessError("los renglones de lo servido", error);

  return parseRows(renglonServidoColumnas, data, "los renglones de lo servido").map((i) => ({
    servingRecordItemId: i.id,
    label: i.label,
    ingredientId: i.ingredient_id,
    productId: i.product_id,
    servido: i.served_quantity,
    entregado: i.deducted_quantity,
    botado: i.discarded_quantity,
    unidad: i.served_unit,
    baseFisica: i.served_weight_basis,
    sortOrder: i.sort_order,
  }));
}

type Contenido = z.infer<typeof contenidoSchema>;

/**
 * Arma los renglones que van al RPC. Devuelve el problema en texto cuando la
 * declaración no se sostiene sola (marcaron "cantidad exacta" y no escribieron
 * el número, por ejemplo): eso se le dice a la persona, no se arregla solo.
 */
async function armarItems(
  db: SupabaseClient,
  contenido: Contenido,
): Promise<{ ok: true; items: ItemDeclarado[] } | { ok: false; error: string }> {
  if (contenido.tipo === "LIBRE") {
    const r = construirDeclaracionLibre(contenido.renglones);
    return r.ok ? { ok: true, items: r.items } : { ok: false, error: r.problemas.join(" ") };
  }

  const servidos = await renglonesDelServido(db, contenido.servingRecordId);
  if (servidos.length === 0) {
    return {
      ok: false,
      error: "Esa porción no tiene renglones: no hay de qué declarar consumo.",
    };
  }

  const marcas = new Map(contenido.marcas.map((m) => [m.servingRecordItemId, m]));
  const entradas: EntradaServida[] = servidos.map((servido) => {
    const marca = marcas.get(servido.servingRecordItemId);
    // Un renglón que nadie marcó NO se da por comido ni por no comido: queda
    // en UNKNOWN, que es el hueco declarado de la 0038.
    if (marca === undefined) return { servido, extent: "UNKNOWN", cantidadExacta: null };
    return { servido, extent: marca.extent, cantidadExacta: marca.cantidadExacta };
  });

  const r = construirDeclaracionServida(entradas);
  return r.ok ? { ok: true, items: r.items } : { ok: false, error: r.problemas.join(" ") };
}

/**
 * EL CAMINO DE UN TOQUE: "comieron lo que salió al plato".
 *
 * Queda etiquetado como SUPUESTO (`ASSUMED_FROM_PLAN`) porque eso es lo que
 * es: nadie miró el plato renglón por renglón. El motor tiene que poder
 * distinguirlo de una declaración de verdad, y por eso este botón no miente
 * llamándose "lo declaré".
 */
export async function darPorComido(servingRecordId: string): Promise<ResultadoAccion> {
  const id = uuid.safeParse(servingRecordId);
  if (!id.success) return { ok: false, error: "Esa porción no existe." };

  const db = await cliente();

  // LA MISMA PREGUNTA QUE HACE LA PANTALLA, Y CON EL MISMO DUEÑO.
  //
  // Esconder el botón no basta: una pestaña vieja puede llamar igual a esta
  // acción, y del otro lado `assume_intake_from_plan` escribe
  // `quantity = deducted_quantity` sin mirar el faltante (0038:1036). Con la
  // despensa sin entregar nada eso es un CERO DURO en el eje de lo real —
  // "midieron y dio cero"— justo donde el camino manual se niega a poner
  // número. La 0038 ya está aplicada y no se toca, así que la última pared
  // dentro de la aplicación es ésta, y usa el MISMO `puedeDarsePorComida` que
  // decide si el botón se muestra: un solo dueño de la regla, dos lugares que
  // la consultan.
  const asumible = puedeDarsePorComida(await renglonesDelServido(db, id.data));
  if (!asumible.puede) return { ok: false, error: asumible.texto };

  const { error } = await db.rpc("assume_intake_from_plan", {
    p_serving_record_id: id.data,
    // La versión viaja desde el motor de esta pantalla: el número que se
    // guarda y la versión que lo produjo tienen un solo dueño.
    p_engine_version: VERSION_MOTOR_EXTENT,
  });
  if (error) return { ok: false, error: error.message };

  refrescar();
  return { ok: true, message: "Anotado como supuesto: se dio por comido lo que salió al plato." };
}

const declaracionServidaSchema = z.object({
  servingRecordId: uuid,
  marcas: z.array(marcaSchema),
  notas: z.string().max(500).nullable(),
});

/** El camino real: comió una parte, o comió a medias, y alguien lo dice. */
export async function declararLoServido(
  entrada: z.infer<typeof declaracionServidaSchema>,
): Promise<ResultadoAccion> {
  const parsed = declaracionServidaSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "La declaración llegó incompleta." };

  const db = await cliente();
  const items = await armarItems(db, {
    tipo: "SERVIDO",
    servingRecordId: parsed.data.servingRecordId,
    marcas: parsed.data.marcas,
  });
  if (!items.ok) return { ok: false, error: items.error };

  const { error } = await db.rpc("log_intake", {
    p_serving_record_id: parsed.data.servingRecordId,
    p_items: items.items,
    p_notes: parsed.data.notas,
  });
  if (error) return { ok: false, error: error.message };

  refrescar();
  return { ok: true, message: "Anotado lo que se comió." };
}

const declaracionLibreSchema = z.object({
  memberId: uuid,
  /** CASA = no salió de la despensa registrada. AFUERA = comió fuera de casa. */
  donde: z.enum(["CASA", "AFUERA"]),
  mealType: z.enum(MEAL_TYPES).nullable(),
  dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  renglones: z.array(renglonLibreSchema).min(1),
  notas: z.string().max(500).nullable(),
});

/**
 * Comió otra cosa. Son DOS hechos distintos y la 0038 los separa a propósito:
 * lo de la casa que no salió de la despensa (la torta del cumpleaños) y lo de
 * afuera (el almuerzo del trabajo). Ninguno de los dos toca inventario, pero
 * solo el primero podría, algún día, tener algo que reponer.
 */
export async function declararOtraComida(
  entrada: z.infer<typeof declaracionLibreSchema>,
): Promise<ResultadoAccion> {
  const parsed = declaracionLibreSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "Faltan datos para anotar esa comida." };

  const db = await cliente();
  const items = await armarItems(db, { tipo: "LIBRE", renglones: parsed.data.renglones });
  if (!items.ok) return { ok: false, error: items.error };

  const rpc = parsed.data.donde === "AFUERA" ? "log_intake_away" : "log_intake_off_plan";
  const { error } = await db.rpc(rpc, {
    p_member_id: parsed.data.memberId,
    p_items: items.items,
    p_consumed_on: parsed.data.dia,
    p_meal_type: parsed.data.mealType,
    p_notes: parsed.data.notas,
  });
  if (error) return { ok: false, error: error.message };

  refrescar();
  return {
    ok: true,
    message:
      parsed.data.donde === "AFUERA"
        ? "Anotado: comió fuera de casa. La despensa no se toca."
        : "Anotado: comió algo que no salió de la despensa.",
  };
}

const correccionSchema = z.object({
  logId: uuid,
  motivo: z.string().min(1).max(500),
  /** Fijo mientras el formulario está abierto: reintentar no duplica. */
  correccionId: uuid,
  contenido: contenidoSchema,
});

/**
 * Corregir es la operación que más se va a usar: la gente se equivoca al
 * anotar. No reescribe nada — la versión anterior queda CORRECTED y a la
 * vista, y la nueva la supera apuntándola.
 */
export async function corregirDeclaracion(
  entrada: z.infer<typeof correccionSchema>,
): Promise<ResultadoAccion> {
  const parsed = correccionSchema.safeParse(entrada);
  if (!parsed.success) {
    return { ok: false, error: "Para corregir hace falta decir qué se comió y por qué." };
  }

  const db = await cliente();
  const items = await armarItems(db, parsed.data.contenido);
  if (!items.ok) return { ok: false, error: items.error };

  const { error } = await db.rpc("correct_intake_log", {
    p_log_id: parsed.data.logId,
    p_items: items.items,
    p_reason: parsed.data.motivo,
    p_correction_id: parsed.data.correccionId,
  });
  if (error) return { ok: false, error: error.message };

  refrescar();
  return { ok: true, message: "Corregido. Lo anterior queda en la historia, no se borró." };
}

const anulacionSchema = z.object({ logId: uuid, motivo: z.string().min(1).max(500) });

/**
 * Anular es decir "esto no debió anotarse" (se anotó en la persona
 * equivocada, se anotó dos veces). NO es decir que no comió: eso se dice
 * marcando «Nada», que es otra cosa.
 */
export async function anularDeclaracion(
  entrada: z.infer<typeof anulacionSchema>,
): Promise<ResultadoAccion> {
  const parsed = anulacionSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "Anular exige decir por qué." };

  const db = await cliente();
  const { error } = await db.rpc("void_intake_log", {
    p_log_id: parsed.data.logId,
    p_reason: parsed.data.motivo,
  });
  if (error) return { ok: false, error: error.message };

  refrescar();
  return { ok: true, message: "Anotación anulada. Queda en la historia con su motivo." };
}
