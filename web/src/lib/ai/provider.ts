import type { PromptEnsamblado } from "./prompt";
import { estimarTokens } from "./prompt";

/**
 * EL PUERTO DEL PROVEEDOR.
 *
 * Sin esto no hay forma de probar nada sin salir a la red, y todos los números
 * del sprint (5 llamadas, 2 rondas, 20 s, cuota diaria) son adivinanzas: no hay
 * dónde medir el costo de un turno hasta que llegue la boleta. El repo prueba
 * contra un Postgres de verdad justamente porque no confía en objetos escritos a
 * mano; para la IA la desconfianza tiene que ir al revés — el proveedor es lo
 * único que se simula, y todo lo demás (herramientas, prompt, compuerta) es el
 * de producción.
 *
 * DOS DECISIONES QUE PARECEN CHICAS Y NO LO SON
 *
 * 1. `RespuestaProveedor.json` es `unknown`. El proveedor NO valida ni tipa su
 *    propia salida: valida el runtime, con Zod estricto. Si el puerto devolviera
 *    un tipo, el proveedor falso sería más confiable que el real y los tests
 *    probarían un mundo que no existe — justo el mundo donde el modelo nunca
 *    devuelve basura.
 * 2. Este módulo NO construye ningún cliente ni lee `process.env` al importarse.
 *    La ruta del asistente tiene que renderizar y responder los caminos rápidos
 *    con el proveedor mal configurado o sin credenciales: si el adaptador
 *    explotara en el árbol de módulos, el camino determinista —que existe
 *    justamente para sobrevivir esa caída— se caería con él. El adaptador real
 *    vive en `provider-remoto.ts` y se carga con `await import()` perezoso,
 *    recién adentro de la rama de capa 2/3.
 */

// ---------------------------------------------------------------------------
// El puerto
// ---------------------------------------------------------------------------

export interface PeticionProveedor {
  readonly prompt: PromptEnsamblado;
  readonly maxTokensSalida: number;
  /**
   * Derivado del tiempo que le queda al TURNO, no un timeout fijo de la llamada.
   * Con timeout propio, dos rondas de 20 s son 40 s de proveedor y el turno se
   * come el límite de la plataforma: el usuario ve un error genérico en vez de
   * la respuesta parcial honesta.
   */
  readonly signal: AbortSignal;
}

export interface RespuestaProveedor {
  /** Sin validar a propósito. Ver el encabezado. */
  readonly json: unknown;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
  readonly ms: number;
}

/**
 * Dos métodos, no uno: `seleccionar` es la capa 2 (elige UNA herramienta y sus
 * argumentos) y `planear` es la capa 3 (encadena lecturas). Son llamadas de
 * costo y de riesgo distintos, y tenerlas separadas permite apagar la 3 sola
 * —que es lo que hay que hacer cuando el turno trae texto de terceros.
 */
export interface AssistantProvider {
  readonly nombre: string;
  seleccionar(p: PeticionProveedor): Promise<RespuestaProveedor>;
  planear(p: PeticionProveedor): Promise<RespuestaProveedor>;
}

export type ClaseDeFalla =
  | "RED" // no respondió, DNS, 5xx
  | "TIEMPO" // se agotó el plazo del turno
  | "RECHAZO" // el proveedor dijo que no (cuota, credencial, contenido)
  | "BASURA"; // respondió algo que no es JSON

/**
 * Falla del proveedor. `retryable` no es un adorno: el breaker cuenta distinto
 * un timeout (peso doble, porque es la falla que más le cuesta al usuario) que
 * un rechazo por credencial, que no se arregla reintentando.
 */
export class ProveedorError extends Error {
  readonly clase: ClaseDeFalla;
  readonly retryable: boolean;

  constructor(clase: ClaseDeFalla, detalle: string) {
    super(detalle);
    this.name = "ProveedorError";
    this.clase = clase;
    this.retryable = clase === "RED" || clase === "TIEMPO";
  }
}

// ---------------------------------------------------------------------------
// Telemetría de costo
// ---------------------------------------------------------------------------

/**
 * Una fila por turno. SIN texto, SIN payload, SIN valores: la auditoría del
 * asistente la lee todo admin del hogar, así que acá solo van números y códigos.
 *
 * Existe para calibrar las cuotas con datos en vez de con intuición: hoy "5
 * llamadas, 2 rondas, 20 s" son un número que alguien eligió.
 */
export interface CostoTurno {
  readonly traceId: string;
  readonly capa: 0 | 1 | 2 | 3 | 9;
  readonly llamadasProveedor: number;
  readonly llamadasHerramienta: number;
  readonly consultasDb: number;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
  readonly ms: number;
  readonly motivoDeCorte: string | null;
}

// ---------------------------------------------------------------------------
// Entorno
// ---------------------------------------------------------------------------

/**
 * Espejo de `hasSupabaseEnv()`. Se lee ADENTRO de la función, nunca al importar:
 * un módulo que lee el entorno al cargarse convierte una variable faltante en
 * una pantalla en blanco.
 */
export function hasAiEnv(): boolean {
  return Boolean(process.env.ASSISTANT_API_URL && process.env.ASSISTANT_API_KEY);
}

export type ModoProveedor = "fake" | "remoto";

/**
 * `fake` es el default. Al revés —remoto por omisión— un test que se olvide de
 * la variable sale a la red y nadie se entera hasta que la suite falla en una
 * máquina sin credenciales, o peor, hasta que la boleta llega.
 */
export function modoProveedor(): ModoProveedor {
  return process.env.ASSISTANT_PROVIDER === "remoto" ? "remoto" : "fake";
}

/**
 * El único camino para conseguir un proveedor de verdad. Perezoso a propósito:
 * el `import()` recién ocurre acá adentro, así que nada del adaptador remoto
 * aparece en el árbol de módulos de la página ni del router.
 *
 * Devuelve `null` —no lanza— cuando no hay entorno: "el asistente no está
 * disponible" es una respuesta honesta que las capas 0 y 1 saben sobrevivir.
 */
export async function cargarProveedorRemoto(): Promise<AssistantProvider | null> {
  if (modoProveedor() !== "remoto") return null;
  if (!hasAiEnv()) return null;
  const modulo = await import("./provider-remoto");
  return modulo.crearProveedorRemoto();
}

// ---------------------------------------------------------------------------
// El proveedor falso
// ---------------------------------------------------------------------------

/**
 * Los modos son el catálogo de cómo falla un modelo de verdad. La mitad de los
 * defectos que encontraron los lentes adversariales se prueban solo con esto:
 *
 *  OK                 responde el guion.
 *  ERROR              se cayó la red.
 *  CUELGA             no responde nunca; termina cuando el turno lo aborta.
 *  BASURA             responde algo que no es JSON.
 *  ESQUEMA_INVALIDO   responde JSON bien formado con un campo de más.
 *  BUCLE              pide siempre lo mismo (o casi: ver `guion`).
 *  PARCIAL            responde bonito ignorando que una herramienta falló.
 *  PROHIBIDO          revienta si alguien lo llama.
 */
export type ModoFalso =
  | "OK"
  | "ERROR"
  | "CUELGA"
  | "BASURA"
  | "ESQUEMA_INVALIDO"
  | "BUCLE"
  | "PARCIAL"
  | "PROHIBIDO";

export interface LlamadaFalsa {
  readonly metodo: "seleccionar" | "planear";
  /**
   * El prompt EXACTO que cruzó. Los tests de inyección se paran acá: lo que hay
   * que mirar no es lo que el modelo contestó, sino qué le llegó.
   */
  readonly prompt: string;
  readonly tokensEntrada: number;
}

export interface ProveedorFalso extends AssistantProvider {
  readonly llamadas: readonly LlamadaFalsa[];
  /** Último prompt que cruzó, para asertar sin índices. */
  ultimoPrompt(): string;
}

export interface OpcionesFalsas {
  readonly modo?: ModoFalso;
  /**
   * Respuestas en orden. Cuando se acaban se repite la última: un guion corto no
   * puede hacer que el turno "termine" por accidente y tape un bucle.
   */
  readonly guion?: readonly unknown[];
  readonly tokensSalida?: number;
}

class ProveedorFalsoImpl implements ProveedorFalso {
  readonly nombre = "falso";
  readonly llamadas: LlamadaFalsa[] = [];
  private readonly modo: ModoFalso;
  private readonly guion: readonly unknown[];
  private readonly tokensSalida: number;
  private cursor = 0;

  constructor(opciones: OpcionesFalsas) {
    this.modo = opciones.modo === undefined ? "OK" : opciones.modo;
    this.guion = opciones.guion === undefined ? [] : opciones.guion;
    this.tokensSalida = opciones.tokensSalida === undefined ? 40 : opciones.tokensSalida;
  }

  ultimoPrompt(): string {
    const ultima = this.llamadas[this.llamadas.length - 1];
    if (ultima === undefined) throw new Error("nadie llamó al proveedor todavía");
    return ultima.prompt;
  }

  seleccionar(p: PeticionProveedor): Promise<RespuestaProveedor> {
    return this.responder("seleccionar", p);
  }

  planear(p: PeticionProveedor): Promise<RespuestaProveedor> {
    return this.responder("planear", p);
  }

  private siguienteDelGuion(): unknown {
    if (this.guion.length === 0) return { intent: "SIN_GUION" };
    const i = Math.min(this.cursor, this.guion.length - 1);
    this.cursor += 1;
    return this.guion[i];
  }

  private async responder(
    metodo: "seleccionar" | "planear",
    p: PeticionProveedor,
  ): Promise<RespuestaProveedor> {
    if (this.modo === "PROHIBIDO") {
      throw new Error(
        `El camino barato llamó al proveedor (${metodo}). Si esta pregunta necesita modelo, ` +
          "el router está mal; si no, el test está probando otra cosa.",
      );
    }

    this.llamadas.push({
      metodo,
      prompt: p.prompt.texto,
      tokensEntrada: p.prompt.tokensEntradaEstimados,
    });

    if (p.signal.aborted) throw new ProveedorError("TIEMPO", "el turno ya estaba abortado");

    if (this.modo === "ERROR") throw new ProveedorError("RED", "el proveedor no respondió");

    if (this.modo === "CUELGA") {
      await new Promise<never>((_, rechazar) => {
        p.signal.addEventListener(
          "abort",
          () => rechazar(new ProveedorError("TIEMPO", "se acabó el plazo del turno")),
          { once: true },
        );
      });
    }

    const json =
      this.modo === "BASURA"
        ? "Claro! Aca va la respuesta: {intent: stock, tool: 'stock.de_alimento'"
        : this.modo === "ESQUEMA_INVALIDO"
          ? { ...(this.siguienteDelGuion() as object), campoQueNadiePidio: "sorpresa" }
          : this.modo === "BUCLE"
            ? this.guion[0]
            : this.siguienteDelGuion();

    const salida = typeof json === "string" ? json : JSON.stringify(json);
    return {
      json,
      tokensEntrada: p.prompt.tokensEntradaEstimados,
      tokensSalida: estimarTokens(salida) + this.tokensSalida,
      ms: 1,
    };
  }
}

export function crearProveedorFalso(opciones: OpcionesFalsas = {}): ProveedorFalso {
  return new ProveedorFalsoImpl(opciones);
}

/**
 * Atajo para los golden de capas 0 y 1: cualquier llamada al proveedor es un
 * fallo del test, porque el punto de esas capas es que el camino barato sea de
 * verdad barato. Un test que "pasa igual" con el modelo prendido no prueba nada.
 */
export function proveedorProhibido(): ProveedorFalso {
  return crearProveedorFalso({ modo: "PROHIBIDO" });
}
