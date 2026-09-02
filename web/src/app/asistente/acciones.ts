"use server";

import type { RespuestaTurno } from "./turnos";

/**
 * El único camino por el que un turno sale de la pantalla.
 *
 * Es una server action y no un `fetch` al proveedor desde el navegador, por lo
 * obvio (la llave) y por lo que no lo es: acá adentro es donde viven el ámbito
 * del actor, el presupuesto y la auditoría. Un turno que se arma en el cliente
 * no tiene ninguna de las tres.
 *
 * QUÉ HACE HOY: nada, y lo dice. El router de capas, el ensamblador de prompt y
 * el puerto del proveedor son otra pieza de este mismo sprint; mientras no
 * estén, esta función devuelve `SIN_CONFIGURAR`, que es la verdad —no hay
 * proveedor conectado de punta a punta— y la pantalla la muestra con su nombre
 * y con los atajos que sí funcionan.
 *
 * Cuando el router aterrice, reemplaza el cuerpo de ESTA función y nada más: la
 * pantalla ya sabe pintar los seis modos de caída.
 *
 * Lo que esta función NO puede hacer nunca, aunque el router exista:
 *  · Ejecutar una acción. Devuelve texto y, a lo más, el id de una propuesta
 *    persistida. Confirmar es de la tarjeta, con su token de un solo uso.
 *  · Importar el cliente del proveedor a nivel de módulo. Si `lib/ai` leyera
 *    `process.env` al importarse, la ruta entera reventaría con el proveedor
 *    mal configurado y se llevaría puestos los atajos deterministas, que son
 *    justo los que tienen que seguir en pie.
 */
export async function enviarTurno(texto: string): Promise<RespuestaTurno> {
  // El texto se recibe y no se usa: no hay a quién mandárselo todavía. Se
  // acepta el parámetro para que la firma sea la definitiva y el día que exista
  // el router no cambie la pantalla.
  void texto;
  return { ok: false, causa: "SIN_CONFIGURAR" };
}
