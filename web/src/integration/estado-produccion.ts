import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

/**
 * QUÉ TIENE PUESTO PRODUCCIÓN. Lector del libro `supabase/estado-produccion.json`.
 *
 * El problema real que lo puso acá: `gate-schema-parity.test.ts` declaraba por
 * escrito que garantizaba "schema de test == schema de producción" y levantaba
 * la base con la cadena COMPLETA del repo, 0036 y 0038 incluidas — dos
 * migraciones que producción no tiene. Con eso le dio el visto bueno a una
 * consulta contra `meal_serving_record_items` que revienta contra la base real.
 * El gate no era capaz de ver lo único que decía vigilar, porque en el repo no
 * existía ningún dato que dijera hasta dónde está aplicada la cadena.
 *
 * Este módulo NO adivina: lee la declaración y la somete a cinco pruebas antes
 * de dejar que alguien la use —forma, numeración, completitud, checksums y
 * vigencia—. Si cualquiera falla, revienta. ERROR != VACÍO: un libro incompleto,
 * vencido o desalineado con los archivos no es "sin novedad", es no saber — y no
 * saber nunca puede salir verde.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const DIR_MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const LIBRO = path.join(RAIZ, "supabase", "estado-produccion.json");

/** Cómo se supo el estado que declara el libro. */
export const METODOS = ["MANIFIESTO", "TESTIGOS_EN_VIVO"] as const;

export type MetodoDelLibro = (typeof METODOS)[number];

/**
 * CUÁNTOS DÍAS VALE UNA VERIFICACIÓN, SEGÚN CÓMO SE SUPO.
 *
 * Acá `metodo` deja de ser un campo que Zod valida y nadie lee, y pasa a decidir
 * algo: el techo de vigencia que el libro puede reclamar para sí mismo.
 *
 * TESTIGOS_EN_VIVO — cada `estado` salió de correr SU testigo contra el Supabase
 * real (`scripts/verificar-estado-produccion.mjs`). Eso es evidencia, y aguanta
 * el trimestre que tarda en volverse recuerdo.
 *
 * MANIFIESTO — los `estado` los tecleó alguien leyendo el registro de aplicación
 * del repo. Puede ser cierto, pero nada lo contrastó jamás contra la base, que
 * es EXACTAMENTE el agujero por el que entró el defecto original: el gate creía
 * saber qué tenía producción porque alguien lo había escrito. Un dicho no vale
 * lo mismo que una comprobación, así que caduca mucho antes y empuja a correr
 * el script.
 */
export const VIGENCIA_MAXIMA_EN_DIAS: Readonly<Record<MetodoDelLibro, number>> = {
  TESTIGOS_EN_VIVO: 90,
  MANIFIESTO: 14,
};

const NUMERO_DE_MIGRACION = /^(\d{4})_/;

/**
 * El prefijo de cuatro dígitos de una migración, o `null` si el nombre no lo
 * trae (y entonces no se sabe de qué migración habla: se declara, no se supone).
 *
 * POR QUÉ EL NÚMERO Y NO EL NOMBRE COMPLETO. `resolverMigracion()` en
 * `harness.ts` ya documenta la convención de este repo: "el sufijo descriptivo
 * lo elige quien las escribe, pero el NÚMERO es el contrato". El libro tiene que
 * indexar con la misma regla. Indexando por nombre completo, que otro agente
 * renombre `0040_adaptive_reviews.sql` a `0040_revisiones_adaptativas.sql` deja
 * el gate rojo gritando "NO SE PUEDE SABER QUÉ TIENE PRODUCCIÓN" cuando de
 * producción no cambió nada — un rojo que enseña a ignorar los rojos.
 */
export function numeroDeMigracion(nombre: string): string | null {
  return NUMERO_DE_MIGRACION.exec(path.basename(nombre))?.[1] ?? null;
}

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "la fecha va en formato AAAA-MM-DD");

const EntradaSchema = z.object({
  estado: z.enum(["APLICADA", "PENDIENTE"]),
  /**
   * Checksum de lo que se aplicó (o de lo que se revisó para aplicar).
   *
   * En una APLICADA es obligatorio: si el archivo cambió después de aplicarse,
   * el repo y producción dejaron de ser lo mismo y nadie se enteró. En una
   * PENDIENTE se admite `null` — una migración que todavía se está escribiendo
   * no tiene por qué tener checksum, y su ausencia no cambia en nada lo que
   * producción tiene puesto.
   */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** Expresión SQL booleana: falsa antes de aplicar la migración, verdadera después. */
  testigo: z.string().min(1),
  /** Qué mira el testigo y por qué ESE y no otro. */
  prueba: z.string().min(1),
  /**
   * La migración no tiene NINGÚN efecto observable replayándola en local, y por
   * eso su testigo no puede probarse con el "falso antes / verdadero después".
   *
   * Existe un solo caso legítimo y lo trajo la 0028: repara un daño que nunca
   * estuvo en el repo. Los acentos de 0026/0027 siempre fueron correctos acá;
   * lo que llegó roto al remoto lo rompió el canal de entrega (`clip` de
   * Windows). Replayar 0026 en PGlite ya deja el texto sano, así que el testigo
   * nace verdadero y no distingue nada — en producción SÍ distingue, que es
   * donde el daño ocurrió.
   *
   * No es un permiso para saltarse la prueba: la marca cambia la prueba por
   * otra igual de exigente —el testigo tiene que dar VERDADERO en los dos
   * momentos— así que el día que la migración empiece a tener efecto local, la
   * marca queda al descubierto.
   */
  solo_en_produccion: z.boolean().optional().default(false),
});

/**
 * Se exporta porque el ESCRITOR del libro (`scripts/verificar-estado-produccion.mjs`)
 * replica este mismo contrato en JS puro (`validarFormaDelLibro`) — no puede
 * importar TS con `node` pelado — y la paridad entre los dos no la sostiene un
 * comentario: `estado-produccion.test.ts` los EJECUTA a ambos sobre la misma
 * batería de libros malformados y exige el mismo veredicto en cada caso.
 */
export const LibroSchema = z.object({
  proyecto: z.string().min(1),
  verificado_el: FECHA,
  caduca_el: FECHA,
  metodo: z.enum(METODOS),
  migraciones: z.record(EntradaSchema),
});

export type EntradaMigracion = z.infer<typeof EntradaSchema> & {
  /** Nombre del archivo TAL COMO ESTÁ EN EL DISCO hoy, no la clave del libro. */
  archivo: string;
  /** Prefijo de cuatro dígitos: lo único estable entre el libro y el disco. */
  numero: string;
  /** La clave con que el libro lo indexa, por si el sufijo quedó viejo. */
  clave: string;
};

export interface LibroProduccion {
  proyecto: string;
  verificadoEl: string;
  caducaEl: string;
  metodo: MetodoDelLibro;
  /** Entradas en el orden alfabético de los archivos de `supabase/migrations`. */
  entradas: EntradaMigracion[];
  /** Nombres de archivo (los del disco) de lo que producción SÍ tiene puesto. */
  aplicadas: Set<string>;
  /** Nombres de archivo (los del disco) de lo que producción todavía no tiene. */
  pendientes: Set<string>;
  /** Índice por número, que es el contrato. Ver `numeroDeMigracion`. */
  porNumero: Map<string, EntradaMigracion>;
}

/** Falla del libro mismo: no sabemos qué tiene producción. Nunca es un "vacío". */
export class EstadoDeProduccionDesconocido extends Error {
  constructor(motivo: string, comoSeArregla: string) {
    super(
      `NO SE PUEDE SABER QUÉ TIENE PRODUCCIÓN.\n\n${motivo}\n\n` +
        `Cómo se arregla:\n${comoSeArregla}\n\n` +
        `Mientras no se sepa, ningún test puede afirmar que el código anda contra ` +
        `la base real. Un verde acá significaría exactamente nada.`,
    );
    this.name = "EstadoDeProduccionDesconocido";
  }
}

const CORRER_EL_SCRIPT = "  node scripts/verificar-estado-produccion.mjs --escribir";

function hoyISO(): string {
  // Fecha local, no UTC: quien corre los tests vive en Chile y el vencimiento
  // se piensa en días de calendario, no en instantes.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * El sha256 de una migración por su NOMBRE de archivo, para quien no quiere
 * saber dónde vive el directorio. Misma normalización a LF que el resto.
 */
export function sha256DeMigracion(archivo: string): string {
  return sha256De(path.join(DIR_MIGRACIONES, archivo));
}

function sha256De(ruta: string): string {
  // SE HASHEA EL CONTENIDO NORMALIZADO A LF, NO LOS BYTES DEL DISCO.
  //
  // Git normaliza los finales de linea al confirmar (el repo es LF), pero en
  // Windows un archivo recien escrito por un script puede quedar en CRLF en el
  // working copy. El 2026-09-02 se sellaron 8 migraciones sobre esos bytes: en
  // esta maquina el sha calzaba y en CI (checkout LF) no, y el guardian decia
  // NO SE PUEDE SABER QUE TIENE PRODUCCION sobre una base que si se sabia.
  // El checksum protege el CONTENIDO, y el final de linea no es contenido.
  //
  // Sin regex ni secuencias de escape a proposito: este archivo se edita por
  // scripts en Windows, donde las barras invertidas no sobreviven el viaje.
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const texto = readFileSync(ruta, "utf8").split(CR + LF).join(LF);
  return createHash("sha256").update(Buffer.from(texto, "utf8")).digest("hex");
}


/** Días de calendario entre dos fechas AAAA-MM-DD. */
function diasEntre(desde: string, hasta: string): number {
  const aUTC = (f: string) => Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10));
  return Math.round((aUTC(hasta) - aUTC(desde)) / 86_400_000);
}

/**
 * Las tres formas en que la vigencia del libro puede no significar nada.
 * Devuelve el motivo, o `null` si el libro todavía vale.
 *
 * Vive suelta y pura para poder probarla con fechas y métodos inventados: la
 * regla que depende de `metodo` no se puede ejercitar contra el archivo real
 * sin escribirle encima a algo que otros agentes están usando.
 */
export function motivoDeVigenciaInvalida(
  libro: { metodo: MetodoDelLibro; verificadoEl: string; caducaEl: string },
  hoy: string,
): string | null {
  if (libro.caducaEl < libro.verificadoEl) {
    return (
      `El libro caduca (${libro.caducaEl}) antes de la fecha en que se verificó ` +
      `(${libro.verificadoEl}).`
    );
  }
  const techo = VIGENCIA_MAXIMA_EN_DIAS[libro.metodo];
  const reclamados = diasEntre(libro.verificadoEl, libro.caducaEl);
  if (reclamados > techo) {
    return (
      `El libro se declara vigente ${reclamados} días (${libro.verificadoEl} → ` +
      `${libro.caducaEl}), pero su método es ${libro.metodo} y ese método aguanta ` +
      `${techo}. ${
        libro.metodo === "MANIFIESTO"
          ? "Un MANIFIESTO es lo que alguien escribió leyendo el registro del repo: " +
            "nada lo contrastó nunca contra la base, así que no puede reclamar la " +
            "vigencia de una verificación en vivo."
          : "Alguien le estiró la vigencia a mano."
      }`
    );
  }
  if (hoy > libro.caducaEl) {
    return (
      `El estado de producción se verificó el ${libro.verificadoEl} y venció el ` +
      `${libro.caducaEl}. Hoy es ${hoy}: lo que el libro dice ya no es una ` +
      `comprobación, es una suposición.`
    );
  }
  return null;
}

/** Los `.sql` que hay hoy en `supabase/migrations`, ordenados por nombre. */
export function archivosDeMigracion(): string[] {
  return readdirSync(DIR_MIGRACIONES)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

let cache: LibroProduccion | null = null;

/**
 * Lee y AUDITA el libro. Cada `throw` de acá es un rojo que dice qué falta.
 *
 * Se cachea porque varios archivos de test lo piden y la auditoría lee 38
 * archivos; la caché es por proceso y los tests no escriben migraciones, así
 * que no hay forma de leer un libro viejo dentro de una misma corrida.
 */
export function cargarLibroDeProduccion(): LibroProduccion {
  if (cache) return cache;

  let crudo: unknown;
  try {
    crudo = JSON.parse(readFileSync(LIBRO, "utf8")) as unknown;
  } catch (e) {
    throw new EstadoDeProduccionDesconocido(
      `No se pudo leer supabase/estado-produccion.json: ${e instanceof Error ? e.message : String(e)}`,
      `  Recupéralo del repo, o reconstrúyelo contra la base:\n${CORRER_EL_SCRIPT}`,
    );
  }

  const parseado = LibroSchema.safeParse(crudo);
  if (!parseado.success) {
    throw new EstadoDeProduccionDesconocido(
      `supabase/estado-produccion.json no tiene la forma esperada:\n` +
        parseado.error.issues.map((i) => `  · ${i.path.join(".")}: ${i.message}`).join("\n"),
      `  Corrige el archivo, o reconstrúyelo contra la base:\n${CORRER_EL_SCRIPT}`,
    );
  }
  const libro = parseado.data;

  // -------------------------------------------------------------------------
  // (1) COMPLETITUD. Es la prueba que impide que esto dependa de que alguien se
  //     acuerde: una migración nueva en el disco sin entrada en el libro deja el
  //     gate rojo desde el minuto uno. No hay forma de "olvidarse de actualizar"
  //     y seguir en verde, porque el olvido es justamente lo que se detecta.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // (0) EL NÚMERO ES EL CONTRATO. Antes de comparar nada, se indexan las dos
  //     puntas —libro y disco— por el prefijo de cuatro dígitos, igual que
  //     `resolverMigracion()` en harness.ts. Ver `numeroDeMigracion`.
  // -------------------------------------------------------------------------
  const sinNumero = Object.keys(libro.migraciones).filter((c) => numeroDeMigracion(c) === null);
  if (sinNumero.length > 0) {
    throw new EstadoDeProduccionDesconocido(
      `El libro indexa por el número de la migración, y estas claves no empiezan ` +
        `con cuatro dígitos y un guión bajo:\n` +
        sinNumero.map((c) => `  · ${c}`).join("\n"),
      `  Renombra la clave a NNNN_lo_que_sea.sql en supabase/estado-produccion.json.`,
    );
  }

  const declaradasPorNumero = new Map<string, { clave: string; numero: string }>();
  const numerosRepetidos: string[] = [];
  for (const clave of Object.keys(libro.migraciones)) {
    const numero = numeroDeMigracion(clave)!;
    const previa = declaradasPorNumero.get(numero);
    if (previa) {
      numerosRepetidos.push(`${numero}: ${previa.clave} y ${clave}`);
      continue;
    }
    declaradasPorNumero.set(numero, { clave, numero });
  }

  const enDisco = archivosDeMigracion();
  const enDiscoPorNumero = new Map<string, string>();
  for (const archivo of enDisco) {
    const numero = numeroDeMigracion(archivo);
    if (numero === null) {
      throw new EstadoDeProduccionDesconocido(
        `supabase/migrations/${archivo} no empieza con el número de cuatro dígitos ` +
          `que el harness usa para resolver migraciones.`,
        `  Renómbrala a NNNN_lo_que_sea.sql.`,
      );
    }
    const previa = enDiscoPorNumero.get(numero);
    if (previa) {
      numerosRepetidos.push(`${numero}: ${previa} y ${archivo} (los dos en el disco)`);
      continue;
    }
    enDiscoPorNumero.set(numero, archivo);
  }
  if (numerosRepetidos.length > 0) {
    throw new EstadoDeProduccionDesconocido(
      `Hay número(s) de migración repetido(s), así que no se sabe cuál de las dos ` +
        `declara el estado de cuál:\n` +
        numerosRepetidos.map((n) => `  · ${n}`).join("\n"),
      `  Renumera la que sobra: el número es el contrato y tiene que ser único.`,
    );
  }

  const sinDeclarar = enDisco.filter((f) => !declaradasPorNumero.has(numeroDeMigracion(f)!));
  if (sinDeclarar.length > 0) {
    throw new EstadoDeProduccionDesconocido(
      `Hay ${sinDeclarar.length} migración(es) en supabase/migrations sin entrada en el ` +
        `libro, así que nadie sabe si producción las tiene:\n` +
        sinDeclarar.map((f) => `  · ${f}`).join("\n"),
      // OJO con lo que este remedio promete. Acá decía "o deja que la escriba
      // el script", y el script NO la escribe: no hay forma de deducir del
      // archivo qué testigo distingue esa migración, así que se detiene con el
      // mismo reclamo. Mandar al remedio equivocado es cómo un rojo correcto
      // termina enseñando a ignorar los rojos.
      `  Agrégale su entrada A MANO en supabase/estado-produccion.json: estado,\n` +
        `  sha256, testigo y prueba. El script no la inventa —el testigo hay que\n` +
        `  pensarlo— y se detiene igual que acá hasta que exista. Recién con la\n` +
        `  entrada puesta:\n${CORRER_EL_SCRIPT}`,
    );
  }
  const fantasmas = [...declaradasPorNumero.values()]
    .filter(({ numero }) => !enDiscoPorNumero.has(numero))
    .map(({ clave }) => clave);
  if (fantasmas.length > 0) {
    throw new EstadoDeProduccionDesconocido(
      `El libro declara migración(es) que ya no existen en el disco:\n` +
        fantasmas.map((f) => `  · ${f}`).join("\n") +
        `\nSi producción las tiene aplicadas y el archivo se borró, el repo perdió ` +
        `la definición de algo que está corriendo.`,
      `  Recupera el archivo del historial, o —si de verdad nunca se aplicó—\n` +
        `  saca su entrada del libro a mano y di por qué en el commit.`,
    );
  }

  // -------------------------------------------------------------------------
  // (2) CHECKSUMS. Las migraciones están CONGELADAS: lo que se aplicó no se
  //     edita. Si el archivo de una APLICADA cambió, producción tiene una cosa y
  //     el repo otra, y todo lo que sigue —incluida la base de paridad que se
  //     arma replayando estos archivos— estaría comparando contra una ficción.
  // -------------------------------------------------------------------------
  const desalineadas: string[] = [];
  for (const archivo of enDisco) {
    const entrada = libro.migraciones[declaradasPorNumero.get(numeroDeMigracion(archivo)!)!.clave]!;
    if (entrada.sha256 === null) {
      if (entrada.estado === "APLICADA") {
        desalineadas.push(`${archivo}: declarada APLICADA sin checksum`);
      }
      continue;
    }
    const real = sha256De(path.join(DIR_MIGRACIONES, archivo));
    if (real !== entrada.sha256) {
      // SE DICE CUAL DE LAS DOS COSAS PASO, PORQUE NO SE ARREGLAN IGUAL.
      //
      // Que cambie una APLICADA es lo grave: produccion tiene puesto un archivo
      // que ya no existe, y el repo dejo de describir la base. Se arregla con una
      // migracion NUEVA, jamas editando la vieja.
      //
      // Que cambie una PENDIENTE es trabajo normal: todavia no esta en ninguna
      // base, y corregirla ANTES de aplicarla es justo lo que uno quiere que
      // pase. Solo hay que volver a sellarla.
      //
      // Antes las dos caian en el mismo mensaje, que hablaba de que produccion y
      // el repo dejaron de ser lo mismo y mandaba a escribir una migracion nueva.
      // Sobre una pendiente eso es falso y el consejo es malo: agregaria una
      // migracion para arreglar algo que todavia se puede arreglar en su sitio.
      desalineadas.push(
        `${archivo} [${entrada.estado}]: el libro dice ${entrada.sha256.slice(0, 12)}… ` +
          `y el archivo vale ${real.slice(0, 12)}…`,
      );
    }
  }
  if (desalineadas.length > 0) {
    const hayAplicadas = desalineadas.some((d) => d.includes("[APLICADA]"));
    throw new EstadoDeProduccionDesconocido(
      `El contenido de estas migraciones ya no es el que dice el libro:\n` +
        desalineadas.map((d) => `  · ${d}`).join("\n") +
        (hayAplicadas
          ? `\nUna APLICADA que cambió es lo grave: producción tiene puesto un archivo que ya no existe, y el repo dejó de describir la base.`
          : `\nTodas son PENDIENTES: todavía no están en ninguna base, así que corregirlas es normal. Sólo hay que volver a sellarlas.`),
      `  Si el cambio era correcto, va en una migración NUEVA y el archivo viejo\n` +
        `  se deja como estaba. Si el archivo viejo es el bueno, revierte la edición.\n` +
        `  Recién ahí vuelve a correr:\n${CORRER_EL_SCRIPT}`,
    );
  }

  // -------------------------------------------------------------------------
  // (3) VENCIMIENTO. Lo que se verificó hace medio año no es conocimiento, es un
  //     recuerdo — y en el medio alguien pudo aplicar, revertir o restaurar un
  //     respaldo sin avisarle al repo. Sí, esto pone el gate rojo un día en que
  //     nadie tocó código: es a propósito, y se apaga corriendo un comando.
  //
  //     CUÁNTO dura depende de `metodo`: un MANIFIESTO escrito a mano no puede
  //     reclamar la misma vigencia que una verificación con testigos en vivo.
  //     Ver VIGENCIA_MAXIMA_EN_DIAS.
  // -------------------------------------------------------------------------
  const motivo = motivoDeVigenciaInvalida(
    { metodo: libro.metodo, verificadoEl: libro.verificado_el, caducaEl: libro.caduca_el },
    hoyISO(),
  );
  if (motivo !== null) {
    throw new EstadoDeProduccionDesconocido(
      motivo,
      `  Vuelve a preguntarle a la base (toma menos de un minuto):\n${CORRER_EL_SCRIPT}`,
    );
  }

  const entradas: EntradaMigracion[] = enDisco.map((archivo) => {
    const { clave, numero } = declaradasPorNumero.get(numeroDeMigracion(archivo)!)!;
    // `archivo` es el nombre del DISCO y `clave` el del libro: pueden diferir en
    // el sufijo sin que nada esté mal, y lo que se lee después son archivos.
    return { archivo, numero, clave, ...libro.migraciones[clave]! };
  });

  cache = {
    proyecto: libro.proyecto,
    verificadoEl: libro.verificado_el,
    caducaEl: libro.caduca_el,
    metodo: libro.metodo,
    entradas,
    aplicadas: new Set(entradas.filter((e) => e.estado === "APLICADA").map((e) => e.archivo)),
    pendientes: new Set(entradas.filter((e) => e.estado === "PENDIENTE").map((e) => e.archivo)),
    porNumero: new Map(entradas.map((e) => [e.numero, e])),
  };
  return cache;
}

/**
 * Filtra una cadena de migraciones (rutas relativas, en orden de aplicación) y
 * deja SOLO las que producción tiene puestas, conservando el orden.
 *
 * Revienta si la cadena menciona una migración que el libro no conoce: si no se
 * sabe si producción la tiene, tampoco se sabe si dejarla dentro o fuera, y
 * elegir cualquiera de las dos sería inventar.
 */
export function soloLoQueProduccionTiene(cadena: readonly string[]): string[] {
  const libro = cargarLibroDeProduccion();
  // Por NÚMERO, no por nombre: `MIGRACIONES` puede traer un sufijo viejo que
  // `resolverMigracion()` resuelve igual, y ahí el libro tiene que resolver
  // igual también o el gate se pone rojo por un renombre.
  const desconocidas = cadena.filter((r) => {
    const numero = numeroDeMigracion(r);
    return numero === null || !libro.porNumero.has(numero);
  });
  if (desconocidas.length > 0) {
    throw new EstadoDeProduccionDesconocido(
      `La cadena de migraciones de los tests incluye archivos que el libro no ` +
        `declara:\n${desconocidas.map((d) => `  · ${d}`).join("\n")}`,
      `  Agrega su entrada en supabase/estado-produccion.json.`,
    );
  }
  return cadena.filter((r) => libro.porNumero.get(numeroDeMigracion(r)!)!.estado === "APLICADA");
}

/** Envuelve la expresión del testigo en una consulta que devuelve un booleano. */
export function consultaDelTestigo(expresion: string): string {
  return `select (${expresion}) as presente`;
}

/** El testigo corrió y la base no contestó ni que sí ni que no. */
export class TestigoSinRespuesta extends Error {
  constructor(archivo: string, expresion: string, devolvio: string) {
    super(
      `El testigo de ${archivo} no contestó: devolvió ${devolvio}, que no es ni ` +
        `verdadero ni falso.\n\n  ${expresion}\n\n` +
        `UNKNOWN NO ES CERO Y TAMPOCO ES "NO APLICADA". Un testigo que da NULL ` +
        `(un left join sin fila, un select sobre cero filas, un and con NULL) no ` +
        `está diciendo que la migración falte: está diciendo que no sabe. ` +
        `Tomarlo por "falta" es la clase de comodidad que reintroduce un falso ` +
        `verde por la otra puerta.\n\n` +
        `Cómo se arregla: escribe el testigo para que SIEMPRE dé booleano ` +
        `(envuélvelo en exists(...), en ... is not null, o en coalesce EXPLÍCITO ` +
        `si de verdad el NULL significa ausencia y puedes justificarlo en 'prueba').`,
    );
    this.name = "TestigoSinRespuesta";
  }
}

/**
 * Lee la fila que devolvió `consultaDelTestigo` exigiendo un booleano de verdad.
 *
 * El problema real que lo puso acá: tanto el script como los tests venían
 * haciendo `fila?.presente === true`, que aplasta tres cosas distintas —falso,
 * NULL y "no vino ninguna fila"— en un mismo `false`. Las tres se leían después
 * como "producción no tiene esta migración", y dos de las tres son un
 * desconocido disfrazado de dato.
 */
export function respuestaDelTestigo(
  fila: { presente?: unknown } | null | undefined,
  archivo: string,
  expresion: string,
): boolean {
  if (fila === null || fila === undefined) {
    throw new TestigoSinRespuesta(archivo, expresion, "ninguna fila");
  }
  const valor = fila.presente;
  if (typeof valor === "boolean") return valor;
  throw new TestigoSinRespuesta(archivo, expresion, valor === null ? "NULL" : String(valor));
}

/**
 * SQLSTATE que significan "el objeto por el que pregunta el testigo todavía no
 * existe" — o sea, la migración NO está aplicada.
 *
 * Esto NO es tragarse errores: es la lista CERRADA de los códigos que Postgres
 * usa para "no existe", y cualquier otro error se propaga tal cual. Un testigo
 * que pregunta por una columna de una tabla que aún no se creó tiene que
 * responder "no está", no tumbar la corrida.
 *
 * Se exporta indexado POR NOMBRE DE CONDICIÓN, y no como un puñado de códigos
 * con el nombre en un comentario al lado, porque el mismo juego lo atrapa el
 * bloque `exception` de `scripts/verificar-estado-produccion.mjs` —que sólo
 * entiende nombres, no códigos— y las dos listas tienen que ser la misma. El
 * comentario que decía cuántos eran llegó a decir "cuatro" con cinco en la
 * lista: un comentario no puede ser el que sostenga una correspondencia entre
 * dos archivos. Ahora la sostiene `estado-produccion.test.ts`, que lee el `.mjs`
 * y compara nombre por nombre contra estas claves.
 */
export const AUSENCIA_DEL_OBJETO: Readonly<Record<string, string>> = {
  undefined_table: "42P01",
  undefined_function: "42883",
  undefined_column: "42703",
  undefined_object: "42704",
  invalid_schema_name: "3F000",
};

const AUSENCIA = new Set(Object.values(AUSENCIA_DEL_OBJETO));

export function esAusenciaDelObjeto(error: unknown): boolean {
  const codigo = (error as { code?: unknown } | null)?.code;
  return typeof codigo === "string" && AUSENCIA.has(codigo);
}

/**
 * Qué migración pendiente crea el objeto que falta.
 *
 * Es para el mensaje de error del gate: decir "falta meal_serving_record_items"
 * obliga a ir a buscar; decir "la crea la 0036, que producción no tiene" deja
 * el diagnóstico cerrado en la misma línea.
 */
export function migracionPendienteQueCrea(objeto: string): string | null {
  const libro = cargarLibroDeProduccion();
  const patron = new RegExp(
    String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(?:table|view|function|type)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?${objeto}"?\b`,
    "i",
  );
  for (const archivo of [...libro.pendientes].sort()) {
    const fuente = readFileSync(path.join(DIR_MIGRACIONES, archivo), "utf8");
    if (patron.test(fuente)) return archivo;
  }
  return null;
}
