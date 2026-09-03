/**
 * OBSERVABILIDAD MÍNIMA (§51) — un solo lugar donde el servidor deja rastro.
 *
 * No hay dependencia nueva: un servicio de logs es una decisión de operación
 * que todavía no está tomada, y meter un SDK "por si acaso" es agregarle a la
 * app una salida de datos que nadie audita. Esto escribe una línea de JSON a
 * stderr, que es lo que cualquier hosting recoge (systemd, PM2, Docker,
 * cPanel/Passenger) sin configurar nada.
 *
 * POR QUÉ EXISTE ESTE MÓDULO Y NO UN `console.error` SUELTO
 *
 * La auditoría de §50 encontró tres sitios que imprimían `error.message` de
 * PostgREST al log del servidor. Nuestros mensajes son inofensivos, pero un
 * `error.message` NO siempre es nuestro: una violación de constraint la redacta
 * PostgreSQL y trae la fila adentro —`Key (value_numeric)=(312.5)`—, así que en
 * el módulo de salud eso es un valor de laboratorio impreso en un archivo de
 * texto que va a sobrevivir a la app. El defecto no es imprimir de más: es que
 * NADIE PUEDE VER, leyendo la línea del `console.error`, si lo que va a salir es
 * un id o el colesterol de alguien.
 *
 * La respuesta es un embudo con dos cerrojos, no una regla de estilo:
 *
 *  1. LISTA NEGRA DE CLAVES. `mensaje`, `valor`, `nota`, `diagnostico`,
 *     `contenido`, `token`… no salen nunca, aunque quien llama insista.
 *  2. FORMA SEGURA DEL VALOR. Lo que sí sale tiene que PARECER un identificador
 *     o un estado: un uuid, un código, un número, una fecha, una ruta. Todo lo
 *     demás se reemplaza por su largo. Un mensaje de PostgreSQL no pasa ese
 *     filtro ni cuando viene bajo una clave inocente como `detalle`.
 *
 * IDS Y ESTADOS, NUNCA CONTENIDO. Lo que hace falta para arreglar un problema es
 * saber QUÉ falló, DÓNDE y con QUÉ CÓDIGO; el contenido de la boleta o del
 * examen no ayuda a nadie a arreglar nada y sí puede terminar en el disco de un
 * servidor compartido.
 */

/** Lo único que se acepta como valor: nada de objetos anidados ni arreglos. */
export type ValorDeContexto = string | number | boolean | null | undefined;
export type ContextoError = Readonly<Record<string, ValorDeContexto>>;

/**
 * Claves que no salen NUNCA, se llame como se llame lo que traigan adentro.
 *
 * Se comparan en minúsculas y por SUBCADENA: `errorRegistro`, `error_message` y
 * `mensajeDeLaBase` caen los tres por `mensaje`/`message`/`error`. Preferimos
 * perder un dato útil a publicar uno sensible: quien necesite ese dato para
 * depurar tiene que elegirle un nombre que declare qué es (`codigo`, `estado`)
 * y pasarlo ya recortado.
 */
export const CLAVES_PROHIBIDAS: readonly string[] = [
  // Texto libre escrito por una persona o devuelto por la base.
  "mensaje",
  "message",
  "error",
  "detalle",
  "detail",
  "nota",
  "comentario",
  "descripcion",
  "description",
  "contenido",
  "content",
  "raw",
  "snippet",
  "payload",
  // Datos de salud y de dinero.
  "valor",
  "value",
  "resultado",
  "diagnostico",
  "biomarcador",
  "biomarker",
  "observacion",
  "restriccion",
  "monto",
  "amount",
  "precio",
  "price",
  "total",
  // Quién es la persona.
  "nombre",
  "name",
  "email",
  "correo",
  "telefono",
  "phone",
  "direccion",
  "address",
  // Credenciales y enlaces firmados.
  "token",
  "secret",
  "password",
  "clave",
  "authorization",
  "jwt",
  "key",
  "url",
];

/**
 * Las mismas, pero comparadas COMPLETAS. Son palabras cortas que aparecen
 * adentro de nombres inofensivos, y bloquearlas por subcadena escondía
 * localizadores que sí hacen falta:
 *
 *   `rut`  está dentro de `ruta`      — y la ruta del archivo es lo que se busca.
 *   `lab`  está dentro de `labelJobId`— que es un id.
 *   `line` está dentro de `lineas`    — que es un conteo.
 *   `text` está dentro de `contexto`.
 *
 * El defecto lo encontró el propio test de este módulo: `ruta` salía omitida
 * y el log dejaba de decir DÓNDE quedó el archivo huérfano, que era justo lo
 * único que ese log existe para decir.
 */
export const CLAVES_PROHIBIDAS_EXACTAS: readonly string[] = [
  "rut",
  "lab",
  "line",
  "linea",
  "text",
  "texto",
  "note",
  "body",
  "clinic",
];

/**
 * ¿Este texto PARECE un identificador o un estado?
 *
 * uuid, código en mayúsculas (`FINANCE_UPLOAD_RECEIPTS`), SQLSTATE (`23505`),
 * fecha ISO, nombre de bucket o tabla, ruta de la app o del almacenamiento.
 * Todo eso sirve para encontrar el problema; ninguno es contenido de nadie.
 *
 * Lo que NO pasa: cualquier cosa con espacios, tildes, comillas o paréntesis —
 * es decir, cualquier frase. Un mensaje de PostgreSQL siempre trae espacios.
 */
export function esFormaSegura(valor: string): boolean {
  if (valor.length === 0) return true;
  if (valor.length > 120) return false;
  return /^[A-Za-z0-9_./:@+-]+$/.test(valor);
}

const prohibida = (clave: string): boolean => {
  const k = clave.toLowerCase().replace(/[^a-z]/g, "");
  return (
    CLAVES_PROHIBIDAS.some((p) => k.includes(p)) || CLAVES_PROHIBIDAS_EXACTAS.includes(k)
  );
};

/** Deja el contexto en condiciones de salir. Exportada para poder probarla. */
export function sanear(contexto: ContextoError): Record<string, ValorDeContexto> {
  const limpio: Record<string, ValorDeContexto> = {};
  for (const [clave, valor] of Object.entries(contexto)) {
    if (valor === undefined) continue;
    if (prohibida(clave)) {
      // Se deja la CLAVE y se dice que se omitió. Borrar la entrada entera
      // haría que el log mintiera por omisión: parecería que no había nada.
      limpio[clave] = "[omitido: la clave está en la lista negra]";
      continue;
    }
    if (typeof valor === "string" && !esFormaSegura(valor)) {
      limpio[clave] = `[texto omitido: ${valor.length} caracteres]`;
      continue;
    }
    limpio[clave] = valor;
  }
  return limpio;
}

/**
 * Una línea de JSON a stderr. No lanza NUNCA: un fallo del log no puede tumbar
 * la operación que estaba fallando —eso convertiría un error manejado en una
 * pantalla en blanco—, pero tampoco se traga en silencio si hay dónde avisar.
 *
 * @param evento código estable y con puntos: `finanzas.boleta.archivo_huerfano`.
 *   Es lo que se busca en el log; por eso NO lleva texto variable adentro.
 * @param contexto ids y estados. Ver la lista negra y `esFormaSegura`.
 */
export function registrarError(evento: string, contexto: ContextoError = {}): void {
  const linea = JSON.stringify({
    nivel: "error",
    evento,
    ts: new Date().toISOString(),
    ...sanear(contexto),
  });
  try {
    // `process.stderr` existe en el servidor de Next; en el navegador no, y ahí
    // el destino honesto es la consola de quien está mirando.
    if (typeof process !== "undefined" && process.stderr !== undefined) {
      process.stderr.write(`${linea}\n`);
      return;
    }
  } catch {
    /* cae al console.error de abajo */
  }
  console.error(linea);
}
