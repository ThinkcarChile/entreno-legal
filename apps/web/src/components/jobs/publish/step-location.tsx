"use client";

import { MapPin } from "lucide-react";

import { Field, Input, Select, Textarea } from "@/components/ui";
import { getCommunes, regions } from "@/lib/geo/chile";

import type { StepProps } from "./types";

export function StepLocation({ draft, errors, update }: StepProps) {
  const communes = draft.regionCode ? getCommunes(draft.regionCode) : [];

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Región" htmlFor="regionCode" error={errors.regionCode} required>
          <Select
            id="regionCode"
            value={draft.regionCode ?? ""}
            aria-invalid={Boolean(errors.regionCode)}
            onChange={(event) =>
              update({ regionCode: event.target.value, communeCode: undefined })
            }
          >
            <option value="">Selecciona una región</option>
            {regions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Comuna" htmlFor="communeCode" error={errors.communeCode} required>
          <Select
            id="communeCode"
            value={draft.communeCode ?? ""}
            disabled={communes.length === 0}
            aria-invalid={Boolean(errors.communeCode)}
            onChange={(event) => update({ communeCode: event.target.value })}
          >
            <option value="">
              {communes.length === 0 ? "Elige primero una región" : "Selecciona una comuna"}
            </option>
            {communes.map((commune) => (
              <option key={commune.code} value={commune.code}>
                {commune.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Dirección"
        htmlFor="addressLine"
        error={errors.addressLine}
        hint="Calle y número, o el nombre del lugar y su dirección."
        required
      >
        <Input
          id="addressLine"
          value={draft.addressLine ?? ""}
          aria-invalid={Boolean(errors.addressLine)}
          placeholder="Av. Andrés Bello 2447"
          onChange={(event) => update({ addressLine: event.target.value })}
        />
      </Field>

      <Field
        label="Nombre del lugar"
        htmlFor="placeName"
        hint="Opcional. Ayuda a que el trabajador encuentre el punto exacto."
      >
        <Input
          id="placeName"
          value={draft.placeName ?? ""}
          placeholder="Costanera Center"
          onChange={(event) => update({ placeName: event.target.value })}
        />
      </Field>

      <Field
        label="Referencias de acceso"
        htmlFor="addressNotes"
        hint="Opcional. Entrada, piso, punto de encuentro."
      >
        <Textarea
          id="addressNotes"
          rows={3}
          value={draft.addressNotes ?? ""}
          placeholder="La fila se forma frente a la entrada norte, por Av. Andrés Bello."
          onChange={(event) => update({ addressNotes: event.target.value })}
        />
      </Field>

      <div className="flex gap-3 rounded-[var(--radius-control)] border border-dashed border-ink-200 bg-ink-50/60 p-4 text-sm text-ink-600">
        <MapPin size={18} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
        <p>
          El punto exacto en el mapa se agrega en la siguiente etapa del producto. Por ahora la
          dirección y la comuna bastan para publicar y recibir ofertas.
        </p>
      </div>
    </div>
  );
}
