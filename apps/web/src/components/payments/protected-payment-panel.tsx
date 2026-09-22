"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CreditCard, ShieldCheck, Sparkles } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button } from "@/components/ui";
import { startProtectedPaymentAction } from "@/lib/actions/payments";
import { site } from "@/config/site";

/**
 * Pago Protegido.
 *
 * El botón hace lo mismo con los tres proveedores: pedir al servidor que cree
 * la transacción y llevar a la página de transición, que es la que envía el
 * token por POST. Este componente no conoce Transbank, no ve el token y no sabe
 * en qué ambiente está: solo sigue la ruta que le devuelven.
 *
 * Una vez pulsado no se vuelve a habilitar. Es lo que evita el segundo cobro
 * por doble clic o por volver atrás desde Webpay.
 */
export function ProtectedPaymentPanel({
  assignmentId,
  simulationEnabled,
  live,
}: {
  assignmentId: string;
  simulationEnabled: boolean;
  /** `true` solo si detrás hay una pasarela cobrando de verdad. */
  live?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pending, startTransition] = useTransition();

  function pay() {
    setError(null);
    startTransition(async () => {
      const result = await startProtectedPaymentAction(assignmentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // La acción siempre devuelve una ruta interna: o la transición hacia
      // Webpay, o la pantalla del trabajo si ya estaba pagado.
      setLeaving(true);
      router.push(result.data.redirectUrl);
    });
  }

  const busy = pending || leaving;

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {simulationEnabled ? (
        <>
          <Alert tone="warning" title="Entorno de desarrollo">
            No hay pasarela de pago conectada. Este botón recorre el mismo flujo con un
            proveedor simulado y deja el pago confirmado. No se cobra nada.
          </Alert>
          <Button size="lg" fullWidth onClick={pay} loading={busy}>
            <Sparkles size={17} aria-hidden="true" />
            {busy ? "Procesando…" : "Simular pago aprobado"}
          </Button>
        </>
      ) : (
        <>
          {!live && (
            <Alert tone="info" title="Ambiente de integración">
              Estás en el ambiente de pruebas de Webpay. Las tarjetas son de prueba y no se
              cobra dinero real.
            </Alert>
          )}
          <Button size="lg" fullWidth onClick={pay} loading={busy}>
            <CreditCard size={17} aria-hidden="true" />
            {busy ? "Preparando el pago…" : "Pagar con Webpay"}
          </Button>
        </>
      )}

      <p className="flex gap-2 text-caption text-ink-600">
        <ShieldCheck size={14} className="mt-px shrink-0 text-success-600" aria-hidden="true" />
        Con {site.protectedPaymentLabel}, el dinero queda asociado a este trabajo y se libera
        cuando el servicio se complete. Los datos de tu tarjeta los captura Webpay: nosotros no
        los vemos ni los guardamos.
      </p>
    </div>
  );
}
