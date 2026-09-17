"use client";

import { ImagePlus } from "lucide-react";

import { Field, Input, Textarea } from "@/components/ui";

import type { StepProps } from "./types";

export function StepDescription({ draft, errors, update }: StepProps) {
  return (
    <div className="space-y-5">
      <Field
        label="Título"
        htmlFor="title"
        error={errors.title}
        hint="Sé concreto. Un buen título recibe más ofertas."
        required
      >
        <Input
          id="title"
          value={draft.title ?? ""}
          maxLength={120}
          aria-invalid={Boolean(errors.title)}
          placeholder="Fila para entradas de concierto en Costanera Center"
          onChange={(event) => update({ title: event.target.value })}
        />
      </Field>

      <Field
        label="Descripción"
        htmlFor="description"
        error={errors.description}
        hint="Explica qué necesitas, cómo se coordina la entrega y qué esperas de la persona."
        required
      >
        <Textarea
          id="description"
          rows={6}
          maxLength={2000}
          value={draft.description ?? ""}
          aria-invalid={Boolean(errors.description)}
          placeholder="Necesito que alguien haga la fila el sábado desde las 05:00…"
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>

      <Field
        label="Instrucciones"
        htmlFor="instructions"
        hint="Opcional. Detalles operativos: accesos, qué llevar, cómo avisar."
      >
        <Textarea
          id="instructions"
          rows={4}
          maxLength={2000}
          value={draft.instructions ?? ""}
          placeholder="Avísame apenas llegues y mándame una foto de cuánta gente hay delante."
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </Field>

      <div className="rounded-[var(--radius-control)] border border-dashed border-ink-200 bg-ink-50/60 p-5 text-center">
        <ImagePlus size={22} className="mx-auto text-ink-400" aria-hidden="true" />
        <p className="mt-2 text-sm font-medium text-ink-700">Fotografías</p>
        <p className="mt-1 text-sm text-ink-500">
          La carga de imágenes se habilita junto con Supabase Storage. Podrás adjuntar hasta seis
          fotos del lugar o del encargo.
        </p>
      </div>
    </div>
  );
}
