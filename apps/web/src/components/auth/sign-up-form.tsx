"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CheckCircle2 } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input } from "@/components/ui";
import { signUpAction } from "@/lib/actions/auth";
import { cn } from "@/lib/utils/cn";
import { signUpSchema } from "@/lib/validation/auth";

const intents = [
  { id: "CLIENT", title: "Necesito ayuda", description: "Quiero delegar filas o trámites." },
  { id: "WORKER", title: "Quiero ganar dinero", description: "Quiero hacer filas y encargos." },
] as const;

export function SignUpForm({ defaultIntent = "CLIENT" }: { defaultIntent?: "CLIENT" | "WORKER" }) {
  const router = useRouter();
  const [intent, setIntent] = useState<"CLIENT" | "WORKER">(defaultIntent);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values = {
      firstName: String(form.get("firstName") ?? "").trim(),
      lastName: String(form.get("lastName") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
      confirmPassword: String(form.get("confirmPassword") ?? ""),
      intent,
      acceptsTerms: form.get("acceptsTerms") === "on",
    };

    const parsed = signUpSchema.safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await signUpAction(values);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      if (result.data.needsEmailConfirmation) {
        setNeedsConfirmation(true);
        return;
      }
      // Con sesión inmediata, el siguiente paso es completar el perfil.
      router.push("/bienvenida");
      router.refresh();
    });
  }

  if (needsConfirmation) {
    return (
      <div className="text-center">
        <CheckCircle2 size={40} className="mx-auto text-success-600" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-semibold text-ink-900">Revisa tu correo</h2>
        <p className="mt-2 text-ink-600">
          Te enviamos un enlace para confirmar tu cuenta. Al abrirlo continúas con tu perfil.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <fieldset>
        <legend className="text-sm font-medium text-ink-800">¿Cómo quieres empezar?</legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {intents.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={intent === option.id}
              onClick={() => setIntent(option.id)}
              className={cn(
                "rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors",
                intent === option.id
                  ? "border-brand-600 bg-brand-50/60 ring-1 ring-brand-600"
                  : "border-ink-200 bg-white hover:border-brand-200",
              )}
            >
              <span className="block text-sm font-medium text-ink-900">{option.title}</span>
              <span className="mt-0.5 block text-xs text-ink-500">{option.description}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Puedes usar los dos modos con la misma cuenta cuando quieras.
        </p>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Nombre" htmlFor="firstName" error={errors.firstName} required>
          <Input id="firstName" name="firstName" autoComplete="given-name" aria-invalid={Boolean(errors.firstName)} />
        </Field>
        <Field
          label="Apellido"
          htmlFor="lastName"
          error={errors.lastName}
          hint="Públicamente solo se muestra la inicial."
          required
        >
          <Input id="lastName" name="lastName" autoComplete="family-name" aria-invalid={Boolean(errors.lastName)} />
        </Field>
      </div>

      <Field label="Correo electrónico" htmlFor="email" error={errors.email} required>
        <Input id="email" name="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Contraseña" htmlFor="password" error={errors.password} hint="Mínimo 8 caracteres." required>
          <Input id="password" name="password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.password)} />
        </Field>
        <Field label="Repite la contraseña" htmlFor="confirmPassword" error={errors.confirmPassword} required>
          <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.confirmPassword)} />
        </Field>
      </div>

      <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-700">
        <input
          type="checkbox"
          name="acceptsTerms"
          className="mt-0.5 h-4.5 w-4.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
        />
        <span>
          Acepto los{" "}
          <Link href="/terminos" className="font-medium text-brand-700 hover:underline">
            términos y condiciones
          </Link>{" "}
          y la{" "}
          <Link href="/privacidad" className="font-medium text-brand-700 hover:underline">
            política de privacidad
          </Link>
          .
        </span>
      </label>
      {errors.acceptsTerms && (
        <p className="text-sm text-danger-600" role="alert">
          {errors.acceptsTerms}
        </p>
      )}

      {formError && <Alert tone="danger">{formError}</Alert>}

      <Button type="submit" size="lg" fullWidth disabled={pending}>
        {pending ? "Creando tu cuenta…" : "Crear cuenta"}
      </Button>

      <p className="text-center text-sm text-ink-600">
        ¿Ya tienes cuenta?{" "}
        <Link href="/entrar" className="font-medium text-brand-700 hover:underline">
          Entra aquí
        </Link>
      </p>
    </form>
  );
}
