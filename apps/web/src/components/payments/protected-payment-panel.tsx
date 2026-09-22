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
 * El botón hace exactamente lo que hará en producción: crea la transacción en el
 * proveedor y redirige. Hoy el único proveedor es el simulado, y esa redirección
 * vuelve a nuestra propia ruta de retorno. No hay pasarela real conectada, así
 * que el texto no promete una: el día que se integre una, cambia el proveedor y
 * este componente no se toca.
 */
export function ProtectedPaymentPanel({
  assignmentId,
  simulationEnabled,
}: {
  assignmentId: string;
  simulationEnabled: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pay() {
    setError(null);
    startTransition(async () => {
      const result = await startProtectedPaymentAction(assignmentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Salida hacia el proveedor. En simulación vuelve sola a /pagos/retorno.
      if (result.data.redirectUrl.startsWith("http")) {
        window.location.href = result.data.redirectUrl;
      } else {
        router.push(result.data.redirectUrl);
      }
    });
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {simulationEnabled ? (
        <>
          <Alert tone="warning" title="Entorno de desarrollo">
            No hay pasarela de pago conectada. Este botón recorre el mismo flujo con un
            proveedor simulado y deja el pago confirmado. No se cobra nada.
          </Alert>
          <Button size="lg" fullWidth onClick={pay} loading={pending}>
            <Sparkles size={17} aria-hidden="true" />
            {pending ? "Procesando…" : "Simular pago aprobado"}
          </Button>
        </>
      ) : (
        <Button size="lg" fullWidth onClick={pay} loading={pending}>
          <CreditCard size={17} aria-hidden="true" />
          {pending ? "Redirigiendo…" : "Ir a pagar"}
        </Button>
      )}

      <p className="flex gap-2 text-caption text-ink-500">
        <ShieldCheck size={14} className="mt-px shrink-0 text-success-600" aria-hidden="true" />
        Con {site.protectedPaymentLabel}, el dinero queda asociado a este trabajo y se libera
        cuando el servicio se complete. No guardamos los datos de tu tarjeta.
      </p>
    </div>
  );
}
