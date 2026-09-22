import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Controles de formulario.
 *
 * Una sola base compartida para que el borde, el foco y el estado de error se
 * vean igual en los tres. El texto es de 16 px en móvil a propósito: por debajo
 * de eso, iOS hace zoom al enfocar el campo y la pantalla salta.
 *
 * El texto de marcador de posición usa `ink-500` y no `ink-400`: el primero
 * llega a 4,78:1 sobre blanco y el segundo no llega a AA.
 */
const controlBase =
  "w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 " +
  "text-body text-ink-950 placeholder:text-ink-500 transition-colors " +
  "focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100 " +
  "disabled:bg-ink-50 disabled:text-ink-400 " +
  "aria-[invalid=true]:border-danger-500 aria-[invalid=true]:ring-danger-100";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlBase, "h-11", className)} {...props} />;
}

export function Textarea({
  className,
  rows = 4,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={cn(controlBase, "py-2.5", className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select className={cn(controlBase, "h-11 appearance-none pr-9", className)} {...props}>
        {children}
      </select>
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-500"
      />
    </span>
  );
}

/**
 * Etiqueta, control y mensaje.
 *
 * El error y la ayuda son excluyentes: si hay error, es lo único que hace falta
 * leer. El error lleva `role="alert"` para que un lector de pantalla lo anuncie
 * sin tener que volver al campo.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-small font-medium text-ink-800">
        {label}
        {required && (
          <span className="text-danger-600" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-caption text-danger-700">
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}
