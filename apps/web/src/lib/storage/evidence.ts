/**
 * Evidencia del trabajo y de las disputas: validación y rutas.
 *
 * El archivo sube **directo del navegador a Storage**, con la sesión de quien
 * lo aporta, y no pasa por el servidor de la aplicación: una foto de 8 MB no
 * cabe en el cuerpo de una función de servidor (Vercel corta en 4,5 MB). Lo que
 * sí pasa por el servidor, en tres momentos:
 *
 *   1. antes de subir, `prepare…UploadAction` valida tipo y tamaño declarados
 *      y genera la ruta (UUID + extensión derivada del tipo): el nombre nunca
 *      es el que traía el archivo;
 *   2. la subida la autoriza la política del bucket (`storage_upload_allowed`):
 *      carpeta propia, un trabajo o una disputa en los que se participa y que
 *      siguen vivos, tope de archivos y el límite de tamaño y tipo del bucket;
 *   3. antes de registrar, el servidor descarga el archivo subido con la misma
 *      sesión y mira **los primeros bytes** (`inspectUploadedEvidence`). Un
 *      `.exe` renombrado a `.jpg` declara `image/jpeg`; sus primeros bytes, no.
 *      Si no cuadra, el archivo se retira y no se registra nada.
 *
 * La base vuelve a exigir, al registrar, que el objeto exista en su ruta y que
 * el tamaño y el tipo que guardó Storage coincidan con los declarados.
 *
 * SVG queda fuera a propósito: es un documento que puede llevar script, y se
 * sirve desde el mismo origen. Un formato de imagen que ejecuta código no es un
 * formato de imagen para esto.
 */

export const EVIDENCE_BUCKET = "evidence";
export const DISPUTE_BUCKET = "dispute-files";

/** Tipos admitidos y su extensión. La extensión sale de aquí, no del nombre. */
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** Máximo por archivo. El de la base manda; este es el corte temprano. */
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** Firmas reales de cada formato, en los primeros bytes. */
const SIGNATURES: { type: string; bytes: readonly number[]; offset?: number }[] = [
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  // WebP es un contenedor RIFF: "RIFF" .... "WEBP".
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

export interface EvidenceValidation {
  ok: boolean;
  message?: string;
}

function matches(head: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

/**
 * Comprueba tipo declarado, tamaño y contenido real.
 *
 * `head` son los primeros bytes del archivo. Si no se pasan, solo se validan
 * tipo y tamaño y se dice en el comentario del llamador por qué basta.
 */
export function validateEvidence(
  file: { type: string; size: number },
  head?: Uint8Array,
): EvidenceValidation {
  if (!ALLOWED[file.type]) {
    return { ok: false, message: "Solo aceptamos imágenes JPG, PNG, WebP o un PDF." };
  }
  if (file.size <= 0) {
    return { ok: false, message: "El archivo llegó vacío." };
  }
  if (file.size > MAX_EVIDENCE_BYTES) {
    return { ok: false, message: "El archivo supera los 8 MB." };
  }

  if (head) {
    const signature = SIGNATURES.find((s) => s.type === file.type);
    if (!signature || !matches(head, signature.bytes, signature.offset)) {
      return { ok: false, message: "El archivo no es del tipo que dice ser." };
    }
    // WebP: además de RIFF, los bytes 8..11 tienen que decir WEBP.
    if (file.type === "image/webp" && !matches(head, [0x57, 0x45, 0x42, 0x50], 8)) {
      return { ok: false, message: "El archivo no es una imagen WebP válida." };
    }
  }

  return { ok: true };
}

/**
 * Ruta del archivo: `<usuario>/<asignación>/<uuid>.<ext>`.
 *
 * La primera carpeta es el identificador del usuario porque es lo que la
 * política de Storage comprueba. El UUID evita adivinar rutas y evita que la
 * caché sirva un archivo viejo.
 */
export function buildEvidencePath(userId: string, scopeId: string, contentType: string): string {
  const extension = ALLOWED[contentType] ?? "bin";
  return `${userId}/${scopeId}/${crypto.randomUUID()}.${extension}`;
}

/** ¿Esta ruta pertenece a esta persona y no se sale de su carpeta? */
export function isOwnEvidencePath(path: string, userId: string): boolean {
  if (path.includes("..") || path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.length === 3 && segments[0] === userId && segments.every((s) => s.length > 0);
}

/** Nombre que genera `buildEvidencePath`: un UUID y la extensión de un tipo admitido. */
const GENERATED_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

/**
 * ¿Es una ruta que generó la aplicación para esta persona y este ámbito
 * (asignación o disputa)? La ruta llega del navegador al registrar: se acepta
 * solo con la forma exacta que produce `buildEvidencePath`.
 */
export function isGeneratedEvidencePath(path: string, userId: string, scopeId: string): boolean {
  if (!isOwnEvidencePath(path, userId)) return false;
  const [, scope, file] = path.split("/");
  return scope === scopeId && GENERATED_FILE.test(file);
}

export type UploadedEvidence =
  | { ok: true; type: string; size: number }
  | { ok: false; message: string };

/**
 * Comprueba un archivo ya subido: existe, su contenido real es del tipo con que
 * Storage lo guardó, ese tipo corresponde a la extensión de la ruta, y está
 * dentro del tamaño. Devuelve el tipo y el tamaño medidos, que son los que se
 * registran: nunca los que declaró el navegador.
 *
 * `download` es la descarga del bucket con la sesión de quien subió (la política
 * de lectura de su carpeta lo permite). Se recibe como función para poder
 * probarla sin Storage.
 */
export async function inspectUploadedEvidence(
  download: (path: string) => Promise<{ data: Blob | null; error: unknown }>,
  path: string,
): Promise<UploadedEvidence> {
  const { data, error } = await download(path);
  if (error || !data) {
    return { ok: false, message: "No encontramos el archivo subido. Vuelve a adjuntarlo." };
  }

  const type = data.type.split(";")[0].trim().toLowerCase();
  const head = new Uint8Array(await data.slice(0, 16).arrayBuffer());
  const check = validateEvidence({ type, size: data.size }, head);
  if (!check.ok) return { ok: false, message: check.message! };

  const extension = path.slice(path.lastIndexOf(".") + 1);
  if (ALLOWED[type] !== extension) {
    return { ok: false, message: "El archivo no es del tipo que dice ser." };
  }
  return { ok: true, type, size: data.size };
}
