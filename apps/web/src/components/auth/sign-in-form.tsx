"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Loader2 } from "lucide-react";

import { Button, Field, Input } from "@/components/ui";
import { signInSchema } from "@/lib/validation/auth";

import { AuthNotice } from "./auth-notice";

export function SignInForm({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const parsed = signInSchema.safeParse({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        next[String(issue.path[0])] ??= issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    if (!enabled) {
      setFormError("La autenticación se habilita al configurar Supabase en este entorno.");
      return;
    }

    setLoading(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const { error } = await createClient().auth.signInWithPassword(parsed.data);
      if (error) {
        setFormError("No pudimos iniciar sesión. Revisa tu correo y contraseña.");
        return;
      }
      router.push("/trabajos");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {!enabled && <AuthNotice />}

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

      {formError && (
        <p className="rounded-[var(--radius-control)] bg-danger-50 px-4 py-3 text-sm text-danger-700" role="alert">
          {formError}
        </p>
      )}

      <Button type="submit" size="lg" fullWidth disabled={loading}>
        {loading ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : null}
        Entrar
      </Button>

      <p className="text-center text-sm text-ink-600">
        ¿No tienes cuenta?{" "}
        <Link href="/crear-cuenta" className="font-medium text-brand-700 hover:underline">
          Créala gratis
        </Link>
      </p>
    </form>
  );
}
