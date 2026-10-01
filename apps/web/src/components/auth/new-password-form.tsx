"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input } from "@/components/ui";
import { updatePasswordAction } from "@/lib/actions/auth";
import { newPasswordSchema, PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";

export function NewPasswordForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const form = new FormData(event.currentTarget);
    const values = {
      password: String(form.get("password") ?? ""),
      confirmPassword: String(form.get("confirmPassword") ?? ""),
    };

    // La misma regla que el registro y que la acción de servidor.
    const parsed = newPasswordSchema.safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await updatePasswordAction(parsed.data.password);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      router.push("/cuenta");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} method="post" noValidate className="space-y-5">
      {/* POST, no GET: ver el comentario en `sign-in-form.tsx`. */}
      <Field
        label="Nueva contraseña"
        htmlFor="password"
        error={errors.password}
        hint={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres.`}
        required
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={Boolean(errors.password)}
        />
      </Field>
      <Field
        label="Repite la contraseña"
        htmlFor="confirmPassword"
        error={errors.confirmPassword}
        required
      >
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          aria-invalid={Boolean(errors.confirmPassword)}
        />
      </Field>

      {formError && <Alert tone="danger">{formError}</Alert>}

      <Button type="submit" size="lg" fullWidth disabled={pending}>
        {pending ? "Guardando…" : "Guardar contraseña"}
      </Button>
    </form>
  );
}
