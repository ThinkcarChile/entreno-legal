import "server-only";

/**
 * Evidencia del trabajo y de las disputas: validación y rutas.
 *
 * El archivo se sube **desde el servidor**, no desde el navegador. La diferencia
 * importa: aquí se puede mirar el contenido real del archivo antes de guardarlo,
 * y no solo lo que el navegador dice que es. Un `.exe` renombrado a `.jpg`
 * declara `image/jpeg` en el formulario; sus primeros bytes, no.
 *
 * Reglas, todas comprobadas antes de escribir nada:
 *   · el tipo declarado tiene que estar en la lista;
 *   · los primeros bytes tienen que corresponder a ese tipo;
 *   · el tamaño tiene que estar dentro del máximo;
 *   · el nombre lo genera la aplicación (UUID + extensión derivada del tipo),
 *     nunca el que traía el archivo;
 *   · la primera carpeta de la ruta es el identificador de quien sube, que es
 *     lo que exige la política de Storage.
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
