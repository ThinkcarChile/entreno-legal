import {
  describeMonto,
  formatAtLeast,
  formatAtLeastCounted,
  type FaltantesContados,
  type MontoEstado,
} from "@/lib/money-format";
import type { KnownSubtotal, MissingValue } from "@/domain/finance/money";

/**
 * Sprint 14 — EL ÚNICO COMPONENTE QUE PINTA PLATA.
 *
 * Sin él no hay forma de mostrar un monto sin mentir, porque las tres maneras
 * de mentir se ven idénticas cuando cada pantalla arma su propio `<span>`:
 *
 *   - «$0 desperdiciado» cuando NO HAY PRECIOS (desconocido != cero).
 *   - «$0 gastado» cuando LA CONSULTA FALLÓ (error != vacío).
 *   - «$0 gastado» cuando EL INTEGRANTE NO TIENE PERMISO y la RLS le devolvió
 *     cero filas ([H17]). Este último no lo atrapa ningún test de error: la
 *     consulta anduvo perfecto, simplemente no había nada que ver.
 *
 * Por eso el componente NO acepta un `Money` pelado ni un `bigint`: recibe un
 * `MontoEstado`, que obliga al que llama a haber decidido en cuál de las cuatro
 * situaciones está.
 *
 * Vive fuera de `ui.tsx` a propósito: `ui.tsx` es el kit visual compartido, y
 * este componente es una REGLA de negocio con forma de componente.
 */

const CLASES = {
  CONOCIDO: "text-on-surface",
  DESCONOCIDO: "text-on-surface-variant",
  ERROR: "text-error",
  SIN_PERMISO: "text-on-surface-variant",
} as const;

export function Monto({
  valor,
  className = "",
  tamano = "cuerpo",
}: {
  valor: MontoEstado;
  className?: string;
  tamano?: "cuerpo" | "titular";
}) {
  const vista = describeMonto(valor);
  const tipografia =
    tamano === "titular"
      ? "font-headline-sm text-headline-sm"
      : "font-body-md text-body-md";
  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span className={`${tipografia} ${CLASES[vista.rama]}`}>{vista.texto}</span>
      {/* El detalle NO es opcional cuando existe: el motivo es la mitad útil del
          dato. Un guion solo obliga a la persona a adivinar qué arreglar. */}
      {vista.detalle !== null && (
        <span className="font-body-sm text-body-sm text-on-surface-variant">{vista.detalle}</span>
      )}
    </span>
  );
}

/**
 * El número grande de una proyección incompleta.
 *
 * Exige `missing` como prop OBLIGATORIA: quien quiera mostrar «al menos
 * $121.900» tiene en la mano —y por lo tanto muestra— los tres productos que
 * faltan. La palabra «al menos» va en la misma tipografía del número, como pide
 * el §7.4, y no en una nota al pie que nadie lee.
 */
export function MontoAlMenos({
  subtotal,
  missing,
  className = "",
}: {
  subtotal: KnownSubtotal;
  missing: readonly MissingValue[];
  className?: string;
}) {
  const vista = formatAtLeast(subtotal, missing);
  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span className="font-headline-sm text-headline-sm text-on-surface">
        {vista.prefijo} {vista.texto}
      </span>
      <span className="font-body-sm text-body-sm text-on-surface-variant">{vista.detalle}</span>
    </span>
  );
}

/**
 * El mismo «al menos», cuando lo que falta se sabe CONTADO y no nombrado.
 *
 * Las cifras del período salen de vistas agregadas: ahí lo que existe es «3
 * asignaciones sin costear, y por este motivo». Inventarles nombre para poder
 * usar `<MontoAlMenos>` sería fabricar identidad; pintarlas con `formatMoney`
 * sería mostrar un subtotal como si fuera el total —«−$0» sobre una categoría
 * entera sin costear—. Esta es la tercera salida, y también cobra peaje: el
 * conteo tiene que calzar con lo que el subtotal declara.
 */
export function MontoAlMenosContado({
  subtotal,
  faltan,
  tamano = "cuerpo",
  className = "",
}: {
  subtotal: KnownSubtotal;
  faltan: FaltantesContados;
  tamano?: "cuerpo" | "titular";
  className?: string;
}) {
  const vista = formatAtLeastCounted(subtotal, faltan);
  const tipografia =
    tamano === "titular" ? "font-headline-sm text-headline-sm" : "font-body-md text-body-md";
  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span className={`${tipografia} text-on-surface`}>
        {vista.prefijo} {vista.texto}
      </span>
      <span className="font-body-sm text-body-sm text-on-surface-variant">{vista.detalle}</span>
    </span>
  );
}
