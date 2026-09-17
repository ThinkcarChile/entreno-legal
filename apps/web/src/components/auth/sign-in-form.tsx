"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input } from "@/components/ui";
import { signInAction } from "@/lib/actions/auth";
import { signInSchema } from "@/lib/validation/auth";

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const next = params.get("next") ?? "/trabajos";

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values = {
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
    };

    const parsed = signInSchema.safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await signInAction(values);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      router.push(next);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {params.get("registro") === "ok" && (
        <Alert tone="success" title="Cuenta creada">
          Confirma tu correo si te lo pedimos y entra con tus datos.
        </Alert>
      )}

      <Field label="Correo electrónico" htmlFor="email" error={errors.email} required>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          aria-invalid={Boolean(errors.email)}
          placeholder="tu@correo.cl"
        />
      </Field>

      <Field label="Contraseña" htmlFor="password" error={errors.password} required>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={Boolean(errors.password)}
        />
      </Field>

      {formError && <Alert tone="danger">{formError}</Alert>}

      <Button type="submit" size="lg" fullWidth disabled={pending}>
        {pending ? "Entrando…" : "Entrar"}
      </Button>

      <div className="space-y-2 text-center text-sm text-ink-600">
        <p>
          <Link href="/recuperar-clave" className="font-medium text-brand-700 hover:underline">
            Olvidé mi contraseña
          </Link>
        </p>
        <p>
          ¿No tienes cuenta?{" "}
          <Link href="/crear-cuenta" className="font-medium text-brand-700 hover:underline">
            Créala gratis
          </Link>
        </p>
      </div>
    </form>
  );
}
