"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input, Select } from "@/components/ui";
import { completeOnboardingAction } from "@/lib/actions/account";
import { getCommunes, regions } from "@/lib/geo/chile";
import { cn } from "@/lib/utils/cn";

const modes = [
  {
    id: "CLIENT" as const,
    title: "Necesito ayuda",
    description: "Voy a publicar filas, trámites o encargos.",
  },
  {
    id: "WORKER" as const,
    title: "Quiero ganar dinero",
    description: "Voy a hacer filas y gestiones para otras personas.",
  },
  {
    id: "BOTH" as const,
    title: "Ambas",
    description: "A veces contrato y a veces trabajo.",
  },
];

/**
 * Onboarding.
 *
 * Elegir un modo no cierra ninguna puerta: se cambia después desde la cuenta,
 * sin crear otra cuenta ni perder historial.
 */
export function OnboardingForm({
  defaultFirstName,
  defaultLastName,
}: {
  defaultFirstName: string;
  defaultLastName: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"CLIENT" | "WORKER" | "BOTH">("CLIENT");
  const [regionCode, setRegionCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const communes = useMemo(() => (regionCode ? getCommunes(regionCode) : []), [regionCode]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values = {
      firstName: String(form.get("firstName") ?? "").trim(),
      lastName: String(form.get("lastName") ?? "").trim(),
      phone: String(form.get("phone") ?? "").trim(),
      regionCode: String(form.get("regionCode") ?? ""),
      communeCode: String(form.get("communeCode") ?? ""),
      avatarUrl: null,
      wantsClient: mode === "CLIENT" || mode === "BOTH",
      wantsWorker: mode === "WORKER" || mode === "BOTH",
    };

    startTransition(async () => {
      const result = await completeOnboardingAction(values);
      if (!result.ok) {
        setFormError(result.error);
        if (result.field) setErrors({ [result.field]: result.error });
        return;
      }
      const next = params.get("next");
      router.push(values.wantsWorker ? "/cuenta/trabajador" : (next ?? "/trabajos"));
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Nombre" htmlFor="firstName" error={errors.firstName} required>
          <Input id="firstName" name="firstName" defaultValue={defaultFirstName} autoComplete="given-name" />
        </Field>
        <Field
          label="Apellido"
          htmlFor="lastName"
          error={errors.lastName}
          hint="Públicamente solo se muestra la inicial."
          required
        >
          <Input id="lastName" name="lastName" defaultValue={defaultLastName} autoComplete="family-name" />
        </Field>
      </div>

      <Field
        label="Teléfono"
        htmlFor="phone"
        error={errors.phone}
        hint="Queda guardado en privado. No aparece en tu perfil público."
        required
      >
        <Input id="phone" name="phone" type="tel" inputMode="tel" placeholder="+56 9 1234 5678" />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Región" htmlFor="regionCode" error={errors.regionCode} required>
          <Select
            id="regionCode"
            name="regionCode"
            value={regionCode}
            onChange={(event) => setRegionCode(event.target.value)}
          >
            <option value="">Selecciona tu región</option>
            {regions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Comuna" htmlFor="communeCode" error={errors.communeCode} required>
          <Select id="communeCode" name="communeCode" disabled={communes.length === 0}>
            <option value="">
              {communes.length === 0 ? "Elige primero una región" : "Selecciona tu comuna"}
            </option>
            {communes.map((commune) => (
              <option key={commune.code} value={commune.code}>
                {commune.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset>
        <legend className="text-small font-medium text-ink-800">
          ¿Cómo quieres usar HagoTuFila?
        </legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {modes.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={mode === option.id}
              onClick={() => setMode(option.id)}
              className={cn(
                "rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors",
                mode === option.id
                  ? "border-brand-600 bg-brand-50/60 ring-1 ring-brand-600"
                  : "border-line bg-surface hover:border-brand-200",
              )}
            >
              <span className="block text-small font-medium text-ink-950">{option.title}</span>
              <span className="mt-0.5 block text-caption text-ink-500">{option.description}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-caption text-ink-500">
          Puedes cambiarlo cuando quieras desde tu cuenta. No necesitas otra cuenta para el otro
          modo.
        </p>
      </fieldset>

      {formError && <Alert tone="danger">{formError}</Alert>}

      <Button type="submit" size="lg" fullWidth disabled={pending}>
        {pending ? "Guardando…" : "Continuar"}
      </Button>
    </form>
  );
}
