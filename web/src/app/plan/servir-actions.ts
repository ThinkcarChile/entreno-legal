"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { numeric, uuid } from "@/lib/supabase/rows";

/**
 * SERVIR ES SERVIR, Y NADA MÁS.
 *
 * Hasta la 0036, el botón de la semana llamaba a `consume_planned_meal`, que
 * descontaba la despensa Y escribía un consumo que nadie había declarado. La
 * 0036 le sacó esa segunda mitad —servir y comer son dos hechos distintos— y
 * `consume_planned_meal` quedó siendo un envoltorio de `serve_meal_assignment`
 * con un nombre que ya no dice la verdad.
 *
 * Esta acción llama al RPC que de verdad manda, y su mensaje dice exactamente
 * lo que pasó: la comida salió a la mesa, la despensa se descontó, y lo que se
 * comió todavía no lo dijo nadie. Ese segundo paso vive en /comi.
 */

export interface ResultadoServir {
  ok: boolean;
  error?: string;
  message?: string;
}

const resultadoRpc = z.object({
  servings: z.number().int(),
  shortfalls: z.array(
    z.object({ label: z.string(), quantity: numeric, unit: z.string() }),
  ),
  records: z.array(z.object({ record_id: uuid, member_id: uuid })),
});

const UNIDADES: Record<string, string> = { G: "g", ML: "ml", UNIT: "u" };

export async function servirLoPlanificado(assignmentId: string): Promise<ResultadoServir> {
  const id = uuid.safeParse(assignmentId);
  if (!id.success) return { ok: false, error: "Esa comida no existe." };

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/plan");

  const { data, error } = await supabase.rpc("serve_meal_assignment", {
    p_assignment_id: id.data,
  });
  // El mensaje del servidor se muestra tal cual: los de la 0036 dicen qué pasó
  // y qué hacer, y taparlos con un "no se pudo" deja a la persona sin salida.
  if (error) return { ok: false, error: error.message };

  const parsed = resultadoRpc.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: "Servir la comida devolvió una forma inesperada." };
  }
  const { servings, shortfalls } = parsed.data;

  revalidatePath("/plan");
  revalidatePath("/pantry");
  revalidatePath("/comi");

  if (servings === 0) {
    return { ok: true, message: "No quedaban porciones por servir en esta comida." };
  }

  const base = `Servido: ${servings} ${servings === 1 ? "porción salió" : "porciones salieron"} a la mesa y la despensa quedó descontada.`;
  const paso = " Falta decir qué se comió: eso se anota en «Lo que comimos».";
  if (shortfalls.length === 0) return { ok: true, message: base + paso };

  const detalle = shortfalls
    .map((s) => `${s.label} (${s.quantity} ${UNIDADES[s.unit] ?? s.unit})`)
    .join(", ");
  return {
    ok: true,
    message: `${base} Ojo: la despensa no tenía todo — faltó ${detalle}. El desajuste quedó anotado en Despensa.${paso}`,
  };
}
