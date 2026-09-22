"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Star } from "lucide-react";

import { Button, Field, Textarea } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { submitReviewAction } from "@/lib/actions/assignment";
import { cn } from "@/lib/utils/cn";

/**
 * Reseña del trabajo terminado.
 *
 * Solo aparece cuando el trabajo está aprobado y quien mira todavía no reseñó:
 * la matriz de permisos lo decide y la base lo vuelve a comprobar. Las cuatro
 * dimensiones son las mismas que usa la reputación, para que la nota que se ve
 * en un perfil venga siempre del mismo sitio.
 */

const DIMENSIONS = [
  { key: "overall", label: "En general" },
  { key: "punctuality", label: "Puntualidad" },
  { key: "communication", label: "Comunicación" },
  { key: "compliance", label: "Cumplimiento" },
] as const;

type Scores = Record<(typeof DIMENSIONS)[number]["key"], number>;

export function ReviewForm({
  assignmentId,
  counterpartName,
}: {
  assignmentId: string;
  counterpartName: string;
}) {
  const router = useRouter();
  const [scores, setScores] = useState<Scores>({
    overall: 5,
    punctuality: 5,
    communication: 5,
    compliance: 5,
  });
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await submitReviewAction(assignmentId, { ...scores, comment });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="text-sm text-ink-600">
        ¿Cómo fue trabajar con {counterpartName}? Tu reseña se publica solo porque el trabajo se
        completó de verdad.
      </p>

      <div className="space-y-2.5">
        {DIMENSIONS.map((dimension) => (
          <div key={dimension.key} className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink-700">{dimension.label}</span>
            <div className="flex gap-0.5" role="group" aria-label={dimension.label}>
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`${value} de 5 en ${dimension.label}`}
                  aria-pressed={scores[dimension.key] === value}
                  onClick={() => setScores((s) => ({ ...s, [dimension.key]: value }))}
                  className="rounded p-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
                >
                  <Star
                    size={22}
                    className={cn(
                      value <= scores[dimension.key]
                        ? "fill-warning-500 text-warning-500"
                        : "fill-ink-200 text-ink-200",
                    )}
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Field label="Comentario" htmlFor="review-comment" hint="Opcional. Se muestra en el perfil.">
        <Textarea
          id="review-comment"
          rows={3}
          maxLength={1000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </Field>

      <Button fullWidth onClick={submit} disabled={pending}>
        {pending ? "Enviando…" : "Enviar evaluación"}
      </Button>
    </div>
  );
}
