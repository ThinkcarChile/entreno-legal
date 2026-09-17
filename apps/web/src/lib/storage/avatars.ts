/**
 * Carga de la fotografía de perfil.
 *
 * Dos reglas que no son negociables:
 *
 *  1. El nombre del archivo NUNCA lo decide quien sube. Se genera uno nuevo.
 *     Un nombre elegido por el usuario permite sobrescribir el archivo de otro
 *     (`../otro/avatar.jpg`) o servir contenido con una extensión engañosa.
 *  2. La ruta empieza por el identificador del usuario. Es lo que exige la
 *     política de Storage: `(storage.foldername(name))[1] = auth.uid()`.
 *     Aunque alguien manipulara la ruta en el navegador, Storage la rechaza.
 */

export const AVATAR_BUCKET = "avatars";

/** Tipos aceptados. La extensión se deriva del tipo, no del nombre original. */
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

export interface AvatarValidationError {
  message: string;
}

export function validateAvatar(file: { type: string; size: number }): AvatarValidationError | null {
  if (!ALLOWED[file.type]) {
    return { message: "La foto debe ser JPG, PNG o WebP." };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { message: "La foto no puede pesar más de 4 MB." };
  }
  return null;
}

/**
 * Ruta de destino: `<userId>/<uuid>.<ext>`.
 *
 * Se incluye un identificador aleatorio en vez de un nombre fijo para que al
 * reemplazar la foto no quede servida la anterior desde la caché del CDN.
 */
export function buildAvatarPath(userId: string, contentType: string): string {
  const extension = ALLOWED[contentType] ?? "jpg";
  return `${userId}/${crypto.randomUUID()}.${extension}`;
}

/** Comprueba que una ruta pertenezca a quien dice. Se valida en el servidor. */
export function isOwnAvatarPath(path: string, userId: string): boolean {
  const segments = path.split("/");
  return segments.length === 2 && segments[0] === userId && segments[1].length > 0;
}
