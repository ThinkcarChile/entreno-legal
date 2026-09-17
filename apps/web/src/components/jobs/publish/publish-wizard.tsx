"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

import { Button, ButtonLink, Card, CardContent } from "@/components/ui";
import { JobUrgency } from "@/lib/domain/enums";
import { timezoneFor } from "@/lib/geo/chile";
import { getPricingEngine, type PriceSuggestion } from "@/lib/pricing";
import { zonedInputToUtc } from "@/lib/utils/datetime";
import { publishJobSchema, publishSteps } from "@/lib/validation/job";

import { StepCategory } from "./step-category";
import { StepDescription } from "./step-description";
import { StepLocation } from "./step-location";
import { StepObjective } from "./step-objective";
import { StepPrice } from "./step-price";
import { StepReview } from "./step-review";
import { StepSchedule } from "./step-schedule";
import { Stepper } from "./stepper";
import { useJobDraft } from "./use-job-draft";

import type { JobCategory } from "@/lib/domain/types";

/**
 * Asistente de publicación.
 *
 * Mobile-first y por pasos. El borrador se guarda en el navegador para que nadie
 * pierda lo escrito al cerrar la pestaña. La validación usa los mismos esquemas
 * que validará el servidor cuando exista el backend.
 */
export function PublishWizard({ categories }: { categories: readonly JobCategory[] }) {
  const [step, setStep] = useState(0);
  const { draft, update: patchDraft, clearStored } = useJobDraft();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const update = useCallback(
    (patch: Parameters<typeof patchDraft>[0]) => {
      patchDraft(patch);
      setErrors({});
    },
    [patchDraft],
  );

  const suggestion = useMemo<PriceSuggestion | null>(() => {
    const category = categories.find((c) => c.id === draft.categoryId);
    if (!category || !draft.regionCode || !draft.date || !draft.time || !draft.durationMinutes) {
      return null;
    }

    const timezone = timezoneFor(draft.regionCode, draft.communeCode);
    return getPricingEngine().suggest({
      categoryGroup: category.group,
      categoryId: category.id,
      categoryBase: {
        min: category.baseHourlyMin.amount,
        max: category.baseHourlyMax.amount,
      },
      regionCode: draft.regionCode,
      communeCode: draft.communeCode,
      startsAt: zonedInputToUtc(draft.date, draft.time, timezone).toISOString(),
      durationMinutes: draft.durationMinutes,
      urgency: draft.urgency ?? JobUrgency.NORMAL,
      timezone,
    });
  }, [categories, draft]);

  const validateStep = useCallback((): boolean => {
    const schema = publishSteps[step]?.schema;
    if (!schema) return true;

    const result = schema.safeParse(draft);
    if (result.success) {
      setErrors({});
      return true;
    }

    const next: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "form");
      next[key] ??= issue.message;
    }
    setErrors(next);
    return false;
  }, [draft, step]);

  const goNext = useCallback(() => {
    if (!validateStep()) return;

    const next = Math.min(step + 1, publishSteps.length - 1);
    // Al entrar al paso de precio se precarga la tarifa recomendada, que el
    // cliente puede cambiar libremente.
    if (publishSteps[next]?.id === "precio" && suggestion && !draft.hourlyRate) {
      patchDraft({ hourlyRate: suggestion.recommendedHourly.amount });
    }

    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [draft.hourlyRate, patchDraft, step, suggestion, validateStep]);

  const goBack = useCallback(() => {
    setErrors({});
    setStep((current) => Math.max(current - 1, 0));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const submit = useCallback(async () => {
    const result = publishJobSchema.safeParse(draft);
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    // La publicación real se conecta en la siguiente etapa: acción de servidor,
    // inserción con RLS y registro en audit_logs.
    await new Promise((resolve) => setTimeout(resolve, 600));
    setSubmitting(false);
    setSubmitted(true);
    clearStored();
  }, [clearStored, draft]);

  if (submitted) return <SubmittedPanel />;

  const isLastStep = step === publishSteps.length - 1;
  const stepProps = { draft, errors, update };

  return (
    <div>
      <Stepper steps={publishSteps} current={step} />

      <Card className="mt-6">
        <CardContent className="sm:p-8">
          <h2 className="text-xl font-semibold tracking-tight text-ink-900">
            {publishSteps[step]?.title}
          </h2>

          <div className="mt-6">
            {step === 0 && <StepCategory {...stepProps} categories={categories} />}
            {step === 1 && <StepLocation {...stepProps} />}
            {step === 2 && <StepSchedule {...stepProps} />}
            {step === 3 && <StepDescription {...stepProps} />}
            {step === 4 && <StepObjective {...stepProps} categories={categories} />}
            {step === 5 && <StepPrice {...stepProps} suggestion={suggestion} />}
            {step === 6 && <StepReview {...stepProps} categories={categories} />}
          </div>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 z-10 mt-6 flex gap-3 bg-canvas/95 py-4 backdrop-blur-sm lg:static lg:bg-transparent lg:py-0">
        {step > 0 && (
          <Button variant="outline" size="lg" onClick={goBack} className="shrink-0">
            <ArrowLeft size={17} aria-hidden="true" />
            <span className="hidden sm:inline">Atrás</span>
          </Button>
        )}

        {isLastStep ? (
          <Button size="lg" fullWidth onClick={submit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                Publicando…
              </>
            ) : (
              "Publicar trabajo"
            )}
          </Button>
        ) : (
          <Button size="lg" fullWidth onClick={goNext}>
            Continuar
            <ArrowRight size={17} aria-hidden="true" />
          </Button>
        )}
      </div>

      <p className="mt-4 text-center text-sm text-ink-500">
        ¿Dudas sobre qué se puede pedir?{" "}
        <Link href="/reglas" className="font-medium text-brand-700 hover:underline">
          Revisa las reglas de uso
        </Link>
      </p>
    </div>
  );
}

function SubmittedPanel() {
  return (
    <Card>
      <CardContent className="py-12 text-center sm:p-12">
        <CheckCircle2 size={44} className="mx-auto text-success-600" aria-hidden="true" />
        <h2 className="mt-5 text-xl font-semibold tracking-tight text-ink-900">
          Tu trabajo quedó listo para publicarse
        </h2>
        <p className="mx-auto mt-3 max-w-md text-ink-600">
          En esta versión la publicación todavía no se guarda: falta conectar la base de datos y
          la sesión de usuario. El formulario, la validación y el precio sugerido ya funcionan tal
          como lo harán en producción.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <ButtonLink href="/trabajos">Ver trabajos publicados</ButtonLink>
          <ButtonLink href="/publicar" variant="outline">
            Publicar otro
          </ButtonLink>
        </div>
      </CardContent>
    </Card>
  );
}
