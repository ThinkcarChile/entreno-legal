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
import { publishJobSchema, publishStages, publishSteps } from "@/lib/validation/job";

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
 * Cuatro pantallas —qué, dónde y cuándo, cómo, cuánto— y no siete: publicar
 * una fila no es rellenar una declaración de impuestos, y cada «Continuar» de
 * más es gente que abandona a medias.
 *
 * La validación no se relajó al agrupar: cada pantalla comprueba todos los
 * esquemas de los bloques que contiene, y son los mismos que validará el
 * servidor. Lo que cambió es cuántas veces hay que pulsar, no qué se exige.
 *
 * El borrador se guarda en el navegador para que nadie pierda lo escrito al
 * cerrar la pestaña.
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
    // Una pantalla puede agrupar varios bloques: se comprueban todos y se
    // muestran juntos los errores, no el primero que aparezca.
    const schemas = (publishStages[step]?.steps ?? [])
      .map((id) => publishSteps.find((s) => s.id === id)?.schema)
      .filter((schema) => schema != null);

    const next: Record<string, string> = {};
    for (const schema of schemas) {
      const result = schema.safeParse(draft);
      if (result.success) continue;
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= issue.message;
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }, [draft, step]);

  const goNext = useCallback(() => {
    if (!validateStep()) return;

    const next = Math.min(step + 1, publishStages.length - 1);
    // Al entrar a la pantalla de precio se precarga la tarifa recomendada, que
    // el cliente puede cambiar libremente, también fuera del rango sugerido.
    if (publishStages[next]?.id === "precio" && suggestion && !draft.hourlyRate) {
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

  const isLastStage = step === publishStages.length - 1;
  const stepProps = { draft, errors, update };

  return (
    <div>
      <Stepper steps={publishStages} current={step} />

      <Card className="mt-6">
        <CardContent className="sm:p-8">
          <h2 className="text-h3 text-ink-950">{publishStages[step]?.title}</h2>

          <div className="mt-6 space-y-8">
            {step === 0 && <StepCategory {...stepProps} categories={categories} />}

            {step === 1 && (
              <>
                <StepLocation {...stepProps} />
                <Divider label="¿Cuándo?" />
                <StepSchedule {...stepProps} />
              </>
            )}

            {step === 2 && (
              <>
                <StepDescription {...stepProps} />
                <Divider label="Objetivo" />
                <StepObjective {...stepProps} categories={categories} />
              </>
            )}

            {step === 3 && (
              <>
                <StepPrice {...stepProps} suggestion={suggestion} />
                <Divider label="Revisión" />
                <StepReview {...stepProps} categories={categories} />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {formError && (
        <Alert tone="danger" className="mt-4">
          {formError}
        </Alert>
      )}

      {!canPublish && isLastStage && (
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

        {isLastStage ? (
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

      <p className="mt-4 text-center text-small text-ink-500">
        ¿Dudas sobre qué se puede pedir?{" "}
        <Link href="/reglas" className="font-medium text-brand-700 hover:underline">
          Revisa las reglas de uso
        </Link>
      </p>
    </div>
  );
}

/** Separador con título entre dos bloques de una misma pantalla. */
function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <h3 className="text-label text-ink-500 uppercase">{label}</h3>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}

function SubmittedPanel({ jobId, demoMode }: { jobId: string | null; demoMode: boolean }) {
  return (
    <Card>
      <CardContent className="py-12 text-center sm:p-12">
        <CheckCircle2 size={44} className="mx-auto text-success-600" aria-hidden="true" />
        <h2 className="mt-5 text-h3 text-ink-950">
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
