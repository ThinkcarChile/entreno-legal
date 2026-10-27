import { FlaskConical } from "lucide-react";

import { isDemoMode } from "@/lib/data";
import { currentDeploymentStage } from "@/lib/env";

/**
 * Aviso de versión de prueba.
 *
 * Un despliegue de producción que todavía no cobra de verdad —Webpay de
 * integración, o el productivo apagado— se ve igual que el definitivo. Esta
 * banda es lo que impide que alguien crea que pagó o que le van a pagar.
 * Desaparece sola el día que `deploymentStage` dice `live`.
 */
export function TrialBanner() {
  if (currentDeploymentStage !== "trial") return null;
  // El modo demostración tiene su propio aviso; dos bandas restan atención.
  if (isDemoMode()) return null;

  return (
    <div className="border-b border-warning-200 bg-warning-100 text-warning-800">
      <div className="container-page flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-small">
        <span className="inline-flex items-center gap-1.5 font-bold">
          <FlaskConical size={14} aria-hidden="true" />
          Versión de prueba
        </span>
        <span>Todavía no se cobra ni se transfiere dinero real: los pagos son de prueba.</span>
      </div>
    </div>
  );
}
