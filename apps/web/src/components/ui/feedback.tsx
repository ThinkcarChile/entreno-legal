"use client";

import * as React from "react";

import { AlertCircle, CheckCircle2, Info, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/** Aviso en línea. Nunca muestra el error crudo del servidor. */
export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const styles = {
    info: "border-brand-100 bg-brand-50/70 text-brand-900",
    success: "border-success-100 bg-success-50 text-success-800",
    warning: "border-warning-100 bg-warning-50 text-warning-800",
    danger: "border-danger-100 bg-danger-50 text-danger-800",
  } as const;

  const Icon = tone === "success" ? CheckCircle2 : tone === "info" ? Info : AlertCircle;

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex gap-2.5 rounded-[var(--radius-control)] border px-4 py-3 text-small",
        styles[tone],
        className,
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** Botón que se deshabilita y explica que está trabajando. */
export function PendingButton({
  pending,
  children,
  idleLabel,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  pending: boolean;
  idleLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <button {...props} disabled={pending || props.disabled}>
      {pending && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
      {pending ? "Guardando…" : (children ?? idleLabel)}
    </button>
  );
}
