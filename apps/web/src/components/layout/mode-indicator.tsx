import { FlaskConical, Database } from "lucide-react";

import { env } from "@/lib/env";
import { isDemoMode } from "@/lib/data";

/**
 * Indicador de origen de datos.
 *
 * Solo en desarrollo. En producción no se pinta nunca: ni el aviso de
 * demostración ni el de conexión. Existe para que en la máquina de quien
 * desarrolla sea imposible confundir un recorrido con datos de ejemplo con uno
 * hecho contra Supabase real, que es justo la confusión que invalidaría una
 * prueba de aceptación.
 */
export function ModeIndicator() {
  if (env.NODE_ENV === "production") return null;

  const demo = isDemoMode();

  return (
    <div
      className={
        demo
          ? "bg-warning-600 text-white"
          : "bg-success-700 text-white"
      }
    >
      <div className="container-page flex items-center gap-2 py-1.5 text-xs font-medium">
        {demo ? (
          <>
            <FlaskConical size={13} aria-hidden="true" />
            Modo demo · datos de ejemplo, nada se guarda
          </>
        ) : (
          <>
            <Database size={13} aria-hidden="true" />
            Supabase conectado · {new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "https://local").hostname}
          </>
        )}
      </div>
    </div>
  );
}
