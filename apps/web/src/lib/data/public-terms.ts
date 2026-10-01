import { platform } from "@/config/platform";

/**
 * Lo que las páginas públicas prometen en números: la comisión y el plazo para
 * reportar un problema.
 *
 * En modo Supabase la fuente de verdad es `platform_settings`, que es lo que
 * usa la base al cobrar, al calcular el payout y al cerrar la ventana de
 * disputa. Antes las páginas públicas leían las variables de entorno: bastaba
 * cambiar la comisión en la base para que `/precios` prometiera una cosa y el
 * cobro hiciera otra.
 *
 * Aquí solo está la parte pura —validar la fila y el respaldo—, para poder
 * probarla sin Next ni Supabase. La lectura vive en `public-terms-reader.ts`.
 */
export interface PublicPlatformTerms {
  /** Comisión en puntos base: 1400 = 14 %. */
  commissionBps: number;
  /** Horas desde el término del trabajo para reportar un problema. */
  disputeWindowHours: number;
}

/**
 * Respaldo: los valores por defecto de `config/platform.ts` (variables de
 * entorno). Es lo que se muestra en modo demostración y, en modo Supabase,
 * solo si la base no responde.
 */
export function defaultPublicTerms(): PublicPlatformTerms {
  return {
    commissionBps: platform.commissionBps,
    disputeWindowHours: platform.disputeWindowHours,
  };
}

/**
 * Valida la fila de `platform_settings`. Los rangos son los mismos `check` de
 * la tabla: un valor fuera de ellos significa que no es la fila que creemos, y
 * no se publica.
 */
export function parsePublicTerms(row: unknown): PublicPlatformTerms | null {
  if (typeof row !== "object" || row === null) return null;
  const { commission_bps: commission, dispute_window_hours: window } = row as Record<
    string,
    unknown
  >;

  if (typeof commission !== "number" || !Number.isInteger(commission)) return null;
  if (commission < 0 || commission > 5000) return null;
  if (typeof window !== "number" || !Number.isInteger(window)) return null;
  if (window < 1 || window > 720) return null;

  return { commissionBps: commission, disputeWindowHours: window };
}

/** «14», «12,5»: la comisión como se escribe en un texto en español de Chile. */
export function formatCommissionPercent(commissionBps: number): string {
  return (commissionBps / 100).toLocaleString("es-CL", { maximumFractionDigits: 2 });
}
