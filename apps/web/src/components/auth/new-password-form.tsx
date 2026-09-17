"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input } from "@/components/ui";
import { updatePasswordAction } from "@/lib/actions/auth";

export function NewPasswordForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirmPassword") ?? "");

    if (password.length < 8) {
      setError("La contraseña necesita al menos 8 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setError(null);

    startTransition(async () => {
      const result = await updatePasswordAction(password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/cuenta");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} method="post" noValidate className="space-y-5">
      {/* POST, no GET: ver el comentario en `sign-in-form.tsx`. */}
      <Field label="Nueva contraseña" htmlFor="password" hint="Mínimo 8 caracteres." required>
        <Input id="password" name="password" type="password" autoComplete="new-password" />
      </Field>
      <Field label="Repite la contraseña" htmlFor="confirmPassword" required>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
        />
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" size="lg" fullWidth disabled={pending}>
        {pending ? "Guardando…" : "Guardar contraseña"}
      </Button>
    </form>
  );
}
