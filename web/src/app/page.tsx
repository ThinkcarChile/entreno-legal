import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { esencialesListos } from "./onboarding/pasos";
import { cargarHechosEsenciales } from "./onboarding/queries";

export const dynamic = "force-dynamic";

/**
 * La portada no dibuja nada: decide a dónde entra la persona.
 *
 * Antes mandaba siempre a /family, y quien llegaba de cero aterrizaba en un
 * formulario de crear hogar sin ninguna guía: no había forma de saber que
 * después venían integrantes, perfiles, invitaciones y plan. Ahora mientras
 * falte algo esencial la portada deja en /onboarding, y cuando ya está, en el
 * hogar como siempre.
 *
 * Esa decisión se toma con los DATOS, no con una bandera de "ya vio el
 * onboarding": una bandera se escribe una vez y después miente. Acá, si la
 * persona agrega a alguien nuevo y no declara su perfil, Inicio vuelve solo a
 * los primeros pasos — que es exactamente lo que uno querría que pasara.
 *
 * DECIDE CON LO MÍNIMO, y esa es la parte que hay que cuidar. Esta pantalla es
 * el punto de entrada de TODA la aplicación: si se cae, no hay aplicación. La
 * primera versión pedía las diez consultas del onboarding completo —roles,
 * invitaciones, plan de la semana, días, comidas— y cualquiera de ellas la
 * tumbaba, cuando ninguna participa de la decisión: `esencialesListos` mira
 * solo el hogar y los perfiles. Ahora se pide exactamente eso. No es tragarse
 * errores: si falla lo esencial, revienta con nombre y apellido, porque sin
 * saberlo no hay forma honesta de elegir destino.
 *
 * De paso queda arreglado el detalle que arrastraba el redirect viejo: el
 * destino "Inicio" del menú (`active: "home"` en AppShell) nunca se veía
 * encendido, porque la persona tocaba Inicio y aterrizaba en Familia, que se
 * pinta a sí misma como Familia. Ahora sí se enciende mientras hay pasos
 * pendientes, y esa es también la manera de VOLVER al onboarding: cuando algo
 * esencial se abre de nuevo, Inicio trae de vuelta solo.
 *
 * La maqueta "home cocinero" (tarjeta de la comida de hoy, accesos rápidos,
 * resumen nutricional) sigue siendo una pantalla nueva sin construir: necesita
 * consultas que hoy no existen.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Sin sesión no hay dato que mirar. Se entra por el onboarding para que quien
  // recién se registra caiga en la guía y no en un formulario suelto.
  if (!user) redirect("/login?next=/onboarding");

  // Puerta de vuelta explícita: `/?pasos` lleva a los primeros pasos aunque ya
  // esté todo listo, sin pagar ni una consulta. Existe porque el camino
  // automático (Inicio te trae de vuelta cuando algo esencial se abre) no cubre
  // a quien solo quiere mirar cómo va lo que NO es esencial.
  if ("pasos" in (await searchParams)) redirect("/onboarding");

  const hechos = await cargarHechosEsenciales(supabase);
  redirect(esencialesListos(hechos) ? "/family" : "/onboarding");
}
