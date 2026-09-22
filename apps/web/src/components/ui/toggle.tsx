"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Casilla, opción única e interruptor.
 *
 * Los tres envuelven el control nativo en vez de dibujarlo con `div`: así
 * funcionan el teclado, el lector de pantalla, el autocompletado y el envío del
 * formulario sin escribir una línea para ello. Lo que se pinta encima es
 * decoración; lo que responde es el `input`.
 *
 * El área táctil mínima es de 44 px, que es lo que se puede pulsar de pie en
 * una fila con una sola mano.
 */

const box =
  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600";

export function Checkbox({
  label,
  hint,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; hint?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 py-2", className)}>
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <input type="checkbox" className="peer sr-only" {...props} />
        <span
          aria-hidden="true"
          className={cn(
            "h-5 w-5 rounded-[0.375rem] border border-line-strong bg-surface transition-colors",
            "peer-checked:border-brand-600 peer-checked:bg-brand-600",
            "peer-disabled:opacity-50",
            box,
          )}
        />
        <Check
          size={13}
          strokeWidth={3}
          aria-hidden="true"
          className="pointer-events-none absolute text-white opacity-0 peer-checked:opacity-100"
        />
      </span>
      <span className="min-w-0">
        <span className="block text-small text-ink-800">{label}</span>
        {hint && <span className="block text-caption text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Radio({
  label,
  hint,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; hint?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 py-2", className)}>
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <input type="radio" className="peer sr-only" {...props} />
        <span
          aria-hidden="true"
          className={cn(
            "h-5 w-5 rounded-full border border-line-strong bg-surface transition-colors",
            "peer-checked:border-[6px] peer-checked:border-brand-600",
            "peer-disabled:opacity-50",
            box,
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-small text-ink-800">{label}</span>
        {hint && <span className="block text-caption text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Switch({
  label,
  hint,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; hint?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start justify-between gap-4 py-2", className)}>
      <span className="min-w-0">
        <span className="block text-small font-medium text-ink-800">{label}</span>
        {hint && <span className="block text-caption text-ink-500">{hint}</span>}
      </span>
      <span className="relative inline-flex h-6 w-11 shrink-0 items-center">
        <input type="checkbox" role="switch" className="peer sr-only" {...props} />
        <span
          aria-hidden="true"
          className={cn(
            "h-6 w-11 rounded-full bg-ink-300 transition-colors peer-checked:bg-success-600 peer-disabled:opacity-50",
            box,
          )}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-surface shadow-sm transition-transform peer-checked:translate-x-5"
        />
      </span>
    </label>
  );
}
