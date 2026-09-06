/**
 * LA POLÍTICA DE HOGARES DE LA BETA FAMILIAR: SE ENTRA POR INVITACIÓN.
 *
 * Supabase deja crear cuentas a cualquiera que llegue al login, y eso no se
 * cambia desde el código. Lo que sí decide el código es qué puede hacer una
 * cuenta sin hogar: hasta ahora, crearse uno. Con la app en un dominio público
 * eso significa que cualquier desconocido que encuentre la URL termina con un
 * hogar propio dentro de la base de la familia — no ve los datos de nadie (la
 * RLS sigue en pie), pero deja basura en producción y convierte "Crear hogar"
 * en la puerta de entrada de quien no fue invitado.
 *
 * Por eso la creación de hogares está CERRADA por omisión. Una cuenta sin hogar
 * ve un estado controlado —"necesitas una invitación"— y nada más. La familia
 * ya tiene su hogar; los que faltan entran con un enlace de invitación.
 *
 * `HOGAR_CREACION_ABIERTA=1` la abre, para desarrollo local o para el día que
 * haga falta un hogar nuevo. Es una variable de entorno y no un flag en la base
 * a propósito: no hay migración que aplicar ni deshacer, y queda declarada en
 * `.env.example` junto con lo demás.
 *
 * Un solo dueño: la página que muestra el formulario y la acción que lo
 * procesa preguntan ACÁ. Si la página lo escondiera y la acción siguiera
 * abierta, una server action es un POST alcanzable sin pasar por la página.
 */
export function creacionDeHogarAbierta(): boolean {
  return process.env.HOGAR_CREACION_ABIERTA?.trim() === "1";
}
