import type { AssistantProvider, PeticionProveedor, RespuestaProveedor } from "./provider";
import { ProveedorError } from "./provider";

/**
 * EL ADAPTADOR REAL. Es el ÚNICO archivo del repo que habla con la red del
 * proveedor, y está solo en su módulo por eso: así "prohibido importar el
 * proveedor real desde código de prueba" es una regla verificable sobre una
 * ruta, y no una intención.
 *
 * Nadie lo importa estático. La única puerta es `cargarProveedorRemoto()`, que
 * hace `await import()` recién adentro de la rama de capa 2/3 y solo cuando el
 * entorno está completo. Con las variables sin definir, este archivo ni se
 * carga: la ruta del asistente renderiza y los caminos rápidos responden igual.
 */

/** Se lee acá adentro, en cada llamada. Ver el encabezado de `provider.ts`. */
function entorno(): { url: string; key: string; modelo: string } {
  const url = process.env.ASSISTANT_API_URL;
  const key = process.env.ASSISTANT_API_KEY;
  if (!url || !key) {
    throw new ProveedorError(
      "RECHAZO",
      "El asistente no está configurado: falta ASSISTANT_API_URL o ASSISTANT_API_KEY.",
    );
  }
  const modelo = process.env.ASSISTANT_MODEL;
  return { url, key, modelo: !modelo ? "asistente-familia" : modelo };
}

/**
 * Una llamada, un JSON, sin interpretar.
 *
 * Lo que este archivo NO hace, a propósito:
 *  · no valida la forma de la salida (eso es del runtime, con Zod estricto);
 *  · no arma el prompt (eso es de `prompt.ts`, que es puro y testeable);
 *  · no reintenta (el reintento cuesta presupuesto y ronda: la decisión es del
 *    turno, que es el único que sabe cuánto tiempo queda).
 */
async function llamar(
  modo: "seleccionar" | "planear",
  p: PeticionProveedor,
): Promise<RespuestaProveedor> {
  const { url, key, modelo } = entorno();
  const inicio = Date.now();

  let respuesta: Response;
  try {
    respuesta = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        modelo,
        modo,
        max_tokens: p.maxTokensSalida,
        prompt: p.prompt.texto,
      }),
      signal: p.signal,
    });
  } catch (e) {
    // Abortar es del turno, no del proveedor: se distingue para que el breaker
    // no cuente como caída del proveedor un corte que decidimos nosotros.
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProveedorError("TIEMPO", "se acabó el plazo del turno");
    }
    throw new ProveedorError("RED", "no se pudo hablar con el proveedor");
  }

  if (!respuesta.ok) {
    throw new ProveedorError(
      respuesta.status >= 500 ? "RED" : "RECHAZO",
      `el proveedor respondió ${respuesta.status}`,
    );
  }

  const crudo = await respuesta.text();
  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch {
    // Un `catch` que no traga: basura es una falla declarada, no una respuesta
    // vacía. Repetida, el breaker la cuenta igual que una caída.
    throw new ProveedorError("BASURA", "el proveedor no respondió JSON");
  }

  const uso = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const entrada = typeof uso.tokens_in === "number" ? uso.tokens_in : p.prompt.tokensEntradaEstimados;
  const salida = typeof uso.tokens_out === "number" ? uso.tokens_out : Math.ceil(crudo.length / 4);

  return { json, tokensEntrada: entrada, tokensSalida: salida, ms: Date.now() - inicio };
}

export function crearProveedorRemoto(): AssistantProvider {
  return {
    nombre: "remoto",
    seleccionar: (p) => llamar("seleccionar", p),
    planear: (p) => llamar("planear", p),
  };
}
