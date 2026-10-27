import { brand } from "@/config/brand";
import { site } from "@/config/site";
import { cn } from "@/lib/utils/cn";

/**
 * Isotipo y marca denominativa.
 *
 * El símbolo es una flecha ascendente dentro de una silueta suave, ladeada,
 * que recuerda al número de turno que uno saca al llegar a una fila: con una
 * esquina más aguda, como el corte de un ticket. La palabra va en minúsculas y
 * cierra con un punto verde, «hagotufila.», como quien da algo por resuelto.
 *
 * Está dibujado en código y no como imagen para que se vea nítido en cualquier
 * tamaño, incluido el favicon.
 *
 * Es una identidad **conceptual**: sirve para construir el producto, no está
 * registrada y el logotipo final debe redibujarse en vector antes de su uso
 * comercial.
 */
export function Logo({
  className,
  compact,
  tone = "brand",
}: {
  className?: string;
  /** Solo el símbolo, sin el nombre. */
  compact?: boolean;
  /** `invert` para fondos oscuros. */
  tone?: "brand" | "invert";
}) {
  const inverted = tone === "invert";

  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className="h-9 w-9 shrink-0" />
      {!compact && (
        <span
          aria-hidden="true"
          className={cn(
            "text-[1.375rem] leading-none font-[850] tracking-[-0.065em]",
            inverted ? "text-white" : "text-ink-950",
          )}
        >
          hagotufila<span className={inverted ? "text-accent-300" : "text-brand-700"}>.</span>
        </span>
      )}
      <span className="sr-only">{site.name}</span>
    </span>
  );
}

/** El símbolo solo, para el favicon y los iconos de la aplicación instalada. */
export function LogoMark({ className }: { className?: string }) {
  // Los colores del símbolo salen de `config/brand`, que es el único sitio
  // donde un valor de marca se escribe a mano fuera de `globals.css`.
  return (
    <svg viewBox="0 0 32 32" role="img" aria-hidden="true" className={className}>
      {/* Ticket: esquinas redondas y una más aguda abajo a la izquierda. */}
      <path
        transform="rotate(-7 16 16)"
        d="M12 3h8a9 9 0 0 1 9 9v8a9 9 0 0 1-9 9H6a3 3 0 0 1-3-3V12a9 9 0 0 1 9-9Z"
        fill={brand.accent}
      />
      {/* Flecha ascendente, derecha aunque el ticket esté ladeado. */}
      <path
        d="M11.2 20.8 20.4 11.6M13.4 11.6h7v7"
        stroke={brand.primary}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
