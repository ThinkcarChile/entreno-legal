"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button, ButtonLink, Card, CardContent } from "@/components/ui";
import { publishJobAction } from "@/lib/actions/jobs";
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
export function PublishWizard({
  categories,
  canPublish,
  demoMode,
}: {
  categories: readonly JobCategory[];
  /** Hay sesión con el onboarding terminado. */
  canPublish: boolean;
  demoMode: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [publishedJobId, setPublishedJobId] = useState<string | null>(null);
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
    setFormError(null);

    const result = publishJobSchema.safeParse(draft);
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= issue.message;
      }
      setErrors(next);
      // El paso de revisión no muestra los campos: conviene decir dónde está el problema.
      setFormError(
        "Falta completar algo. Revisa los pasos anteriores: " +
          Object.values(next).slice(0, 2).join(" · "),
      );
      return;
    }

    if (!canPublish) {
      // Se guarda el borrador y se vuelve aquí después de entrar.
      router.push("/entrar?next=/publicar");
      return;
    }

    setSubmitting(true);
    const response = await publishJobAction(result.data);
    setSubmitting(false);

    if (!response.ok) {
      setFormError(response.error);
      return;
    }

    setPublishedJobId(response.data.jobId);
    setSubmitted(true);
    clearStored();
    router.refresh();
  }, [canPublish, clearStored, draft, router]);

  if (submitted) return <SubmittedPanel jobId={publishedJobId} demoMode={demoMode} />;

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

      {formError && (
        <Alert tone="danger" className="mt-4">
          {formError}
        </Alert>
      )}

      {!canPublish && step === publishSteps.length - 1 && (
        <Alert tone="info" className="mt-4" title="Falta entrar a tu cuenta">
          Guardamos tu borrador. Al entrar vuelves aquí y publicas en un clic.
        </Alert>
      )}

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

function SubmittedPanel({ jobId, demoMode }: { jobId: string | null; demoMode: boolean }) {
  return (
    <Card>
      <CardContent className="py-12 text-center sm:p-12">
        <CheckCircle2 size={44} className="mx-auto text-success-600" aria-hidden="true" />
        <h2 className="mt-5 text-xl font-semibold tracking-tight text-ink-900">
          {demoMode ? "Tu trabajo quedó listo para publicarse" : "Tu trabajo está publicado"}
        </h2>
        <p className="mx-auto mt-3 max-w-md text-ink-600">
          {demoMode
            ? "En modo demostración no se guarda nada. Configura Supabase para publicar de verdad."
            : "Ya es visible para los trabajadores verificados de la zona. Te avisamos cuando llegue la primera oferta."}
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          {jobId ? (
            <ButtonLink href={`/mis-trabajos/publicados/${jobId}`}>Ver mi trabajo</ButtonLink>
          ) : (
            <ButtonLink href="/trabajos">Ver trabajos publicados</ButtonLink>
          )}
          <ButtonLink href="/publicar" variant="outline">
            Publicar otro
          </ButtonLink>
        </div>
      </CardContent>
    </Card>
  );
}
