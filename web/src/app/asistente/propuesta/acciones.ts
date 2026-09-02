"use server";

import type {
  PeticionConfirmacion,
  ResultadoConfirmacion,
} from "@/components/assistant/ActionCard";

/**
 * CONFIRMAR UNA PROPUESTA.
 *
 * Este es el único endpoint del sprint que puede terminar en una escritura de
 * dominio, y hoy no escribe nada: lo dice y no toca la propuesta.
 *
 * Por qué NO llama a `take_assistant_proposal` mientras no exista el ejecutor:
 * ese RPC hace el compare-and-swap OFFERED -> ACCEPTED y quema el token en la
 * misma transacción. Llamarlo sin nadie que ejecute después dejaría la
 * propuesta en vuelo para siempre, con el token gastado, y la persona vería que
 * "algo pasó" cuando no pasó nada. Quemar la única confirmación viva para no
 * hacer la acción es peor que no ofrecer el botón.
 *
 * LA SECUENCIA, QUE AHORA SÍ SE PUEDE EJECUTAR. La que estaba escrita acá era
 * imposible: empezaba llamando a `take_assistant_proposal` y seguía con
 * `claimProposal`, que exige la propuesta en OFFERED — el paso 1 mataba al paso
 * 2, y encima cada uno comparaba el token con un hash distinto. No eran dos
 * pasos: eran dos compuertas. Ahora hay UNA compuerta y ese RPC es su paso 6.
 *
 * Cuando el ejecutor esté, el cuerpo de esta función es exactamente:
 *   1. `claimProposal({proposalId, acceptedByMemberId, confirmationToken,
 *      segundoGesto}, {store, actor, revalidar, exigirSegundoGesto, ahora})`.
 *      Adentro, y en este orden: hogar y existencia, estado, vigencia,
 *      capacidad del que acepta, SEGUNDO GESTO contra lo que el servidor exige,
 *      y recién ahí `store.tomar(...)` — que sobre Postgres es
 *      `take_assistant_proposal(id, hash)`: compare-and-swap y quema del token
 *      en la misma transacción. Al final, la revalidación.
 *   2. `runActionTool(tool, args, sesion, grant)` — con la llave, y solo con ella.
 *   3. `settle_assistant_proposal` con EXECUTED, FAILED o EXECUTION_UNKNOWN.
 *      Los tres caben en el enum de la 0053 y los tres exigen ACCEPTED: no hay
 *      final de una acción que nadie confirmó.
 *
 * Nada de eso puede vivir en el cliente, y por eso la firma ya es la definitiva
 * — incluido `segundoGesto`, que es la PRUEBA de lo que la persona hizo (a
 * quién tocó, qué escribió) y que el servidor contrasta contra lo que él mismo
 * calcula. Mientras eso se comprobaba solo en `ActionCard`, dar acceso a los
 * exámenes de otra persona era un gesto y no dos: un POST directo acá se
 * saltaba el `if` del navegador entero.
 */
export async function confirmarPropuesta(
  peticion: PeticionConfirmacion,
): Promise<ResultadoConfirmacion> {
  void peticion;
  return {
    estado: "NO_DISPONIBLE",
    motivo:
      "todavía no está conectado el ejecutor de acciones del asistente, así que no toqué tu propuesta",
  };
}
