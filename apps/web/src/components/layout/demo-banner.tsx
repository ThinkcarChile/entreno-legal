import Link from "next/link";

import { FlaskConical } from "lucide-react";

import { env } from "@/lib/env";
import { isDemoMode } from "@/lib/data";

/**
 * Aviso de modo demostración.
 *
 * Los dos modos no se mezclan nunca, y cuando el que manda es el de
 * demostración conviene que se vea: así nadie cree que guardó algo real.
 */
export function DemoBanner() {
  if (!isDemoMode()) return null;
  // En desarrollo el aviso lo da `ModeIndicator`, que además distingue si hay
  // Supabase conectado. Dos bandas diciendo lo mismo solo restan atención.
  if (env.NODE_ENV !== "production") return null;

  return (
    <div className="bg-ink-900 text-white">
      <div className="container-page flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <FlaskConical size={14} aria-hidden="true" />
          Modo demostración
        </span>
        <span className="text-ink-300">
          Los datos son de ejemplo y nada se guarda. Configura Supabase para usar la aplicación
          completa.
        </span>
        <Link
          href="/como-funciona"
          className="ml-auto shrink-0 underline underline-offset-2 hover:text-brand-200"
        >
          Cómo funciona
        </Link>
      </div>
    </div>
  );
}
