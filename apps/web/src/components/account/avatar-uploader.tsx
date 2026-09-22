"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Camera } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Avatar, Button } from "@/components/ui";
import { setAvatarAction } from "@/lib/actions/account";
import {
  AVATAR_BUCKET,
  buildAvatarPath,
  validateAvatar,
} from "@/lib/storage/avatars";
import { createClient } from "@/lib/supabase/client";

/**
 * Fotografía de perfil.
 *
 * El archivo sube directo del navegador a Storage con la sesión del usuario: no
 * pasa por el servidor de la aplicación, así que una foto grande no ocupa una
 * función de servidor. Las políticas del bucket son las que autorizan.
 */
export function AvatarUploader({
  userId,
  displayName,
  currentUrl,
}: {
  userId: string;
  displayName: string;
  currentUrl: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentUrl);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);

    const invalid = validateAvatar(file);
    if (invalid) {
      setError(invalid.message);
      event.target.value = "";
      return;
    }

    // El nombre lo genera la aplicación, nunca el archivo original.
    const path = buildAvatarPath(userId, file.type);

    startTransition(async () => {
      try {
        const supabase = createClient();
        const { error: uploadError } = await supabase.storage
          .from(AVATAR_BUCKET)
          .upload(path, file, { contentType: file.type, upsert: false });

        if (uploadError) {
          setError("No pudimos subir la foto. Intenta con otra imagen.");
          return;
        }

        const result = await setAvatarAction(path);
        if (!result.ok) {
          setError(result.error);
          return;
        }

        setPreview(result.data.url);
        router.refresh();
      } catch {
        setError("No pudimos subir la foto. Revisa tu conexión.");
      } finally {
        if (inputRef.current) inputRef.current.value = "";
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Avatar src={preview} name={displayName} size="lg" />
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            <Camera size={15} aria-hidden="true" />
            {pending ? "Subiendo…" : preview ? "Cambiar foto" : "Subir foto"}
          </Button>
          <p className="mt-1.5 text-caption text-ink-500">JPG, PNG o WebP, hasta 4 MB.</p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-label="Fotografía de perfil"
        onChange={onChange}
      />

      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
