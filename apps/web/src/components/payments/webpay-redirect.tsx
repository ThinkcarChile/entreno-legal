"use client";

import { useEffect, useRef, useState } from "react";

import { CreditCard, Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui";

/**
 * Página de transición hacia Webpay.
 *
 * Webpay exige que el token viaje en un formulario **POST** a la URL que
 * devolvió al crear la transacción: no se puede redirigir con un `GET` ni
 * poner el token en la barra de direcciones.
 *
 * El envío es automático pero no instantáneo. Ese medio segundo existe para
 * que la persona vea a dónde va antes de salir del sitio —es lo que evita que
 * un formulario de pago aparezca «de la nada»— y para que haya un botón manual
 * si el envío automático no ocurre.
 *
 * El token no se registra, no va a analítica y no sale hacia ningún tercero:
 * vive en un campo oculto y muere al enviarse.
 */
export function WebpayRedirect({
  action,
  token,
  amountLabel,
  jobTitle,
}: {
  action: string;
  token: string;
  amountLabel: string;
  jobTitle: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSending(true);
      formRef.current?.submit();
    }, 600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="container-page flex min-h-[60vh] max-w-lg flex-col justify-center py-12">
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6 text-center sm:p-8">
        <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-700">
          <CreditCard size={22} aria-hidden="true" />
        </span>

        <h1 className="mt-5 text-h2 text-ink-950">Preparando tu pago</h1>
        <p className="mt-3 text-body text-ink-600">
          Te llevamos a Webpay para que ingreses los datos de tu tarjeta. Nosotros no los vemos
          en ningún momento.
        </p>

        <dl className="mt-6 space-y-2 rounded-[var(--radius-control)] bg-canvas p-4 text-left">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-small text-ink-600">Trabajo</dt>
            <dd className="min-w-0 truncate text-small font-medium text-ink-950">{jobTitle}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-small text-ink-600">Total</dt>
            <dd className="text-h3 text-ink-950 tabular-nums">{amountLabel}</dd>
          </div>
        </dl>

        <p
          className="mt-6 flex items-center justify-center gap-2 text-small text-ink-600"
          role="status"
        >
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Serás redirigido a Webpay…
        </p>

        {/*
          Sin `target`: el formulario de Webpay no debe abrirse en un iframe
          —la propia documentación lo desaconseja— ni en una pestaña nueva, que
          rompe el retorno.
        */}
        <form ref={formRef} method="post" action={action} className="mt-4">
          <input type="hidden" name="token_ws" value={token} />
          <Button type="submit" size="lg" fullWidth loading={sending}>
            Ir a Webpay ahora
          </Button>
        </form>

        <p className="mt-5 flex items-start gap-2 text-caption text-ink-600">
          <ShieldCheck size={15} className="mt-px shrink-0 text-success-600" aria-hidden="true" />
          Si no avanzas, vuelve a la página del trabajo e inténtalo otra vez. No se cobra nada
          hasta que completes el formulario.
        </p>
      </div>
    </div>
  );
}
