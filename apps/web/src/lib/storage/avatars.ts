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

/**
 * Nombre de archivo admitido dentro de la carpeta del usuario. Es la misma regla
 * que aplica la base (`app_private.is_own_avatar_path`, migración …001120): lo
 * que no la cumpla, la base lo rechaza igual.
 */
const AVATAR_FILE = /^[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$/;
const USER_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Comprueba que una ruta pertenezca a quien dice. Se valida en el servidor. */
export function isOwnAvatarPath(path: string, userId: string): boolean {
  const segments = path.split("/");
  return segments.length === 2 && segments[0] === userId && AVATAR_FILE.test(segments[1]);
}

/**
 * URL pública de una foto de perfil.
 *
 * `profiles.avatar_url` guarda la RUTA dentro del bucket, no una URL: así nadie
 * puede poner en su perfil una imagen servida desde otro dominio. La dirección
 * la pone la aplicación, con la de su propio proyecto. Un valor con otra forma
 * —por ejemplo, una URL completa anterior a la migración— no se muestra.
 */
export function avatarPublicUrl(
  path: string | null | undefined,
  supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string | null {
  if (!path || !supabaseUrl) return null;
  const segments = path.split("/");
  if (segments.length !== 2) return null;
  const [folder, file] = segments;
  if (!USER_FOLDER.test(folder) || !AVATAR_FILE.test(file)) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${AVATAR_BUCKET}/${folder}/${file}`;
}
