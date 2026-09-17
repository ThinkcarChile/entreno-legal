"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input } from "@/components/ui";
import { requestPasswordResetAction } from "@/lib/actions/auth";

export function ResetPasswordForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!email.includes("@")) {
      setError("Ingresa un correo válido.");
      return;
    }
    setError(null);

    startTransition(async () => {
      const result = await requestPasswordResetAction(email);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSent(true);
    });
  }

  if (sent) {
    return (
      <Alert tone="success" title="Revisa tu correo">
        Si existe una cuenta con ese correo, te enviamos un enlace para crear una contraseña
        nueva.
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" noValidate className="space-y-5">
      {/* POST, no GET: ver el comentario en `sign-in-form.tsx`. */}
      <Field label="Correo electrónico" htmlFor="email" required>
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" />
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" size="lg" fullWidth disabled={pending}>
        {pending ? "Enviando…" : "Enviar enlace"}
      </Button>

      <p className="text-center text-sm text-ink-600">
        <Link href="/entrar" className="font-medium text-brand-700 hover:underline">
          Volver a entrar
        </Link>
      </p>
    </form>
  );
}
