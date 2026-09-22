"use client";

import { useState, useTransition } from "react";

import { BadgeCheck, Clock, ShieldAlert, ShieldCheck } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Badge, Button } from "@/components/ui";
import { requestVerificationAction } from "@/lib/actions/account";
import { VerificationStatus } from "@/lib/domain/enums";
import { verificationStatusLabels } from "@/lib/domain/labels";

/**
 * Verificación de identidad.
 *
 * Etapa 2: la resuelve una persona del equipo desde el panel. No hay proveedor
 * biométrico ni se simula uno: el estado es real y la decisión también, solo que
 * la toma un humano. Los estados y la pantalla ya son los definitivos.
 */
export function VerificationPanel({ status }: { status: VerificationStatus }) {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  const label = verificationStatusLabels[status];

  function request() {
    setError(null);
    startTransition(async () => {
      const result = await requestVerificationAction("CEDULA");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSent(true);
    });
  }

  const icon =
    status === VerificationStatus.VERIFIED ? (
      <ShieldCheck size={20} className="text-success-600" aria-hidden="true" />
    ) : status === VerificationStatus.PENDING ? (
      <Clock size={20} className="text-warning-600" aria-hidden="true" />
    ) : (
      <ShieldAlert size={20} className="text-ink-400" aria-hidden="true" />
    );

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-start gap-3.5">
        {icon}
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink-950">Verificación de identidad</h2>
          <Badge tone={label.tone} className="mt-2">
            {label.label}
          </Badge>

          {status === VerificationStatus.VERIFIED ? (
            <p className="mt-3 text-small text-ink-600">
              Tu identidad está verificada. Ya puedes enviar ofertas y ser seleccionado para
              trabajos.
            </p>
          ) : status === VerificationStatus.PENDING ? (
            <p className="mt-3 text-small text-ink-600">
              Estamos revisando tu solicitud. Te avisamos apenas esté lista. Mientras tanto puedes
              explorar trabajos y dejar tu perfil listo.
            </p>
          ) : status === VerificationStatus.SUSPENDED ? (
            <p className="mt-3 text-small text-ink-600">
              Tu cuenta está suspendida. Escríbenos para revisar tu caso.
            </p>
          ) : (
            <>
              <p className="mt-3 text-small text-ink-600">
                <strong className="font-medium text-ink-950">
                  Para enviar ofertas y aceptar trabajos deberás verificar tu identidad.
                </strong>{" "}
                Es lo que hace que un cliente confíe en dejarle un encargo a alguien que no
                conoce.
              </p>
              <ul className="mt-3 space-y-1.5 text-small text-ink-600">
                <li className="flex gap-2">
                  <BadgeCheck size={15} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
                  Tus documentos se guardan en privado y nunca aparecen en tu perfil.
                </li>
                <li className="flex gap-2">
                  <BadgeCheck size={15} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
                  En tu perfil solo se ve una insignia de identidad verificada.
                </li>
              </ul>
            </>
          )}

          {status === VerificationStatus.REJECTED && (
            <Alert tone="warning" className="mt-4">
              Revisa que tus datos coincidan con tu documento y vuelve a enviar la solicitud.
            </Alert>
          )}

          {error && (
            <Alert tone="danger" className="mt-4">
              {error}
            </Alert>
          )}
          {sent && (
            <Alert tone="success" className="mt-4">
              Recibimos tu solicitud. Te avisamos cuando la revisemos.
            </Alert>
          )}

          {(status === VerificationStatus.UNVERIFIED ||
            status === VerificationStatus.REJECTED) && (
            <Button className="mt-4" onClick={request} disabled={pending || sent}>
              {pending ? "Enviando…" : "Solicitar verificación"}
            </Button>
          )}

          <p className="mt-4 text-caption text-ink-500">
            La carga de documento y selfie se habilita junto con el proveedor de verificación. Por
            ahora la revisión la hace nuestro equipo.
          </p>
        </div>
      </div>
    </div>
  );
}
