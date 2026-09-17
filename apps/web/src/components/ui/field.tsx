import * as React from "react";

import { cn } from "@/lib/utils/cn";

const controlBase =
  "w-full rounded-[var(--radius-control)] border border-ink-200 bg-white px-3.5 text-[0.9375rem] " +
  "text-ink-900 placeholder:text-ink-400 transition-colors " +
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
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(controlBase, "h-11 pr-9", className)} {...props} />;
}

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-800">
        {label}
        {required && <span className="ml-0.5 text-danger-600">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-danger-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}
