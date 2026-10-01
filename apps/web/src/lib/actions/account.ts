"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireSession } from "./guards";
import { AVATAR_BUCKET, isOwnAvatarPath } from "@/lib/storage/avatars";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";
import { lastNameSchema, personNameSchema } from "@/lib/validation/profile";

/**
 * Cuenta: onboarding, modos, perfil de trabajador y verificación.
 *
 * Las escrituras sensibles pasan por funciones de la base (SECURITY DEFINER):
 * el usuario no tiene privilegio de columna sobre `roles`, `verification_status`
 * ni sobre su propia reputación, y así debe seguir siendo.
 */

const onboardingSchema = z.object({
  // La misma regla que la base aplica al nombre público (validation/profile.ts).
  firstName: personNameSchema.refine((v) => v.length >= 2, "Ingresa tu nombre"),
  lastName: lastNameSchema,
  phone: z
    .string()
    .min(8, "Ingresa un teléfono de contacto")
    .max(20)
    .regex(/^[+0-9\s-]+$/, "El teléfono solo puede tener números"),
  regionCode: z.string().min(1, "Selecciona tu región"),
  communeCode: z.string().min(1, "Selecciona tu comuna"),
  // Pese al nombre, es la RUTA de la foto dentro del bucket `avatars`, no una
  // URL: es lo que guarda la base desde la migración …001120. Se comprueba
  // más abajo, con la sesión, que sea de la propia carpeta.
  avatarUrl: z.string().max(200).nullable().optional(),
  wantsClient: z.boolean(),
  wantsWorker: z.boolean(),
});

export async function completeOnboardingAction(input: unknown): Promise<ActionResult<void>> {
  const parsed = onboardingSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: String(issue.path[0] ?? "") };
  }
  if (!parsed.data.wantsClient && !parsed.data.wantsWorker) {
    return { ok: false, error: "Elige al menos una forma de usar HagoTuFila.", field: "modes" };
  }

  try {
    const { supabase, userId } = await requireSession();
    if (parsed.data.avatarUrl && !isOwnAvatarPath(parsed.data.avatarUrl, userId)) {
      return { ok: false, error: "Esa ruta de archivo no es válida.", field: "avatarUrl" };
    }

    const { error } = await supabase.rpc("complete_onboarding", {
      p_first_name: parsed.data.firstName,
      p_last_name: parsed.data.lastName,
      p_phone: parsed.data.phone,
      p_region_code: parsed.data.regionCode,
      p_commune_code: parsed.data.communeCode,
      p_avatar_url: parsed.data.avatarUrl ?? null,
      p_wants_client: parsed.data.wantsClient,
      p_wants_worker: parsed.data.wantsWorker,
    });

    if (error) return actionError(error, "No pudimos guardar tu perfil.");

    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos guardar tu perfil.");
  }
}

export async function setAccountModesAction(
  wantsClient: boolean,
  wantsWorker: boolean,
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("set_account_modes", {
      p_client: wantsClient,
      p_worker: wantsWorker,
    });

    if (error) return actionError(error, "No pudimos cambiar el modo de tu cuenta.");

    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos cambiar el modo de tu cuenta.");
  }
}

const workerProfileSchema = z.object({
  headline: z.string().min(10, "Describe en una línea lo que haces").max(160),
  bio: z.string().max(1000).optional().or(z.literal("")),
  baseHourlyRate: z
    .number()
    .int("El monto debe ser un número entero en pesos")
    .min(3000, "La tarifa parece demasiado baja")
    .max(500_000, "La tarifa parece demasiado alta"),
  availabilityNote: z.string().min(5, "Cuenta cuándo estás disponible").max(300),
  acceptsOvernight: z.boolean(),
  isAcceptingJobs: z.boolean(),
  areas: z
    .array(
      z.object({
        regionCode: z.string().min(1),
        communeCode: z.string().nullable().optional(),
        radiusKm: z.number().int().min(1).max(200).nullable().optional(),
      }),
    )
    .min(1, "Indica al menos una zona donde trabajas"),
});

export async function saveWorkerProfileAction(input: unknown): Promise<ActionResult<void>> {
  const parsed = workerProfileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: String(issue.path[0] ?? "") };
  }

  try {
    const { supabase, userId } = await requireSession();

    // Solo columnas que el usuario tiene permitido escribir. `verification_status`,
    // `level` y la reputación no están en esa lista, por diseño.
    const { error: profileError } = await supabase
      .from("worker_profiles")
      .update({
        headline: parsed.data.headline,
        base_hourly_rate: parsed.data.baseHourlyRate,
        availability_note: parsed.data.availabilityNote,
        accepts_overnight: parsed.data.acceptsOvernight,
        is_accepting_jobs: parsed.data.isAcceptingJobs,
      })
      .eq("user_id", userId);

    if (profileError) {
      return actionError(profileError, "No pudimos guardar tu perfil de trabajador.");
    }

    if (parsed.data.bio) {
      await supabase.from("profiles").update({ bio: parsed.data.bio }).eq("id", userId);
    }

    const { error: areasError } = await supabase.rpc("set_worker_service_areas", {
      p_areas: parsed.data.areas,
    });
    if (areasError) return actionError(areasError, "No pudimos guardar tus zonas de trabajo.");

    revalidatePath("/cuenta/trabajador");
    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos guardar tu perfil de trabajador.");
  }
}

export async function requestVerificationAction(
  documentType?: string,
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("request_worker_verification", {
      p_document_type: documentType ?? "CEDULA",
      p_document_path: null,
      p_selfie_path: null,
    });

    if (error) return actionError(error, "No pudimos enviar tu solicitud de verificación.");

    revalidatePath("/cuenta/trabajador");
    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos enviar tu solicitud de verificación.");
  }
}


/**
 * Registra la foto de perfil recién subida y retira la anterior.
 *
 * La subida la hace el navegador contra Storage, con la sesión del propio
 * usuario y sujeta a las políticas del bucket. Aquí solo se guarda la RUTA, y
 * antes se comprueba que sea suya: si no, alguien podría apuntar su perfil al
 * archivo de otra persona. La base lo vuelve a exigir (`profiles_avatar_own_path`),
 * y la URL pública la arma la aplicación al mostrarla (`avatarPublicUrl`).
 *
 * La foto anterior se borra recién después de guardar la nueva, con la sesión
 * del usuario (política `avatars_own_delete`, solo su carpeta). Antes no había
 * política de borrado y cada cambio dejaba la vieja pública para siempre. Si
 * el borrado falla, el cambio de foto no se deshace: lo que importa es que el
 * perfil muestre la nueva.
 */
export async function setAvatarAction(storagePath: string): Promise<ActionResult<{ url: string }>> {
  try {
    const { supabase, userId } = await requireSession();

    if (!isOwnAvatarPath(storagePath, userId)) {
      return { ok: false, error: "Esa ruta de archivo no es válida." };
    }

    const { data: current } = await supabase
      .from("profiles")
      .select("avatar_url")
      .eq("id", userId)
      .maybeSingle<{ avatar_url: string | null }>();
    // `avatar_url` guarda la ruta (migración …001120). Solo se retira una ruta
    // propia: nunca se traduce en el borrado de algo de otra persona.
    const previous = current?.avatar_url ?? null;
    const previousPath = previous && isOwnAvatarPath(previous, userId) ? previous : null;

    const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(storagePath);
    const publicUrl = data.publicUrl;

    const { error } = await supabase
      .from("profiles")
      .update({ avatar_url: storagePath })
      .eq("id", userId);

    if (error) return actionError(error, "No pudimos guardar tu fotografía.");

    if (previousPath && previousPath !== storagePath) {
      await supabase.storage.from(AVATAR_BUCKET).remove([previousPath]);
    }

    revalidatePath("/", "layout");
    revalidatePath("/cuenta");
    return actionOk({ url: publicUrl });
  } catch (error) {
    return actionError(error, "No pudimos guardar tu fotografía.");
  }
}
