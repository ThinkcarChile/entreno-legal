import { brand } from "@/config/brand";
import { site } from "@/config/site";
import { cn } from "@/lib/utils/cn";

/**
 * Isotipo y marca denominativa.
 *
 * Tres ideas en una figura: el pin de ubicación (dónde), el reloj que lleva
 * dentro (cuánto tiempo) y el visto que lo cierra (cumplido). Está dibujado en
 * código y no como imagen para que herede el color del contexto y se vea nítido
 * en cualquier tamaño, incluido el favicon.
 *
 * Es una identidad **provisional**: sirve para construir el producto, no está
 * registrada y no pretende ser definitiva.
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
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={cn("h-8 w-8 shrink-0", inverted && "text-white")} inverted={inverted} />
      {!compact && (
        <span
          className={cn(
            "text-[1.0625rem] font-semibold tracking-tight",
            inverted ? "text-white" : "text-ink-950",
          )}
        >
          Hago<span className={inverted ? "text-brand-300" : "text-brand-600"}>Tu</span>Fila
        </span>
      )}
      <span className="sr-only">{site.name}</span>
    </span>
  );
}

/** El símbolo solo, para el favicon y los iconos de la aplicación instalada. */
export function LogoMark({
  className,
  inverted = false,
}: {
  className?: string;
  inverted?: boolean;
}) {
  // Los colores del símbolo salen de `config/brand`, que es el único sitio
  // donde un valor de marca se escribe a mano fuera de `globals.css`.
  const body = inverted ? "white" : "currentColor";
  const inner = inverted ? brand.ink : "white";

  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-hidden="true"
      className={cn("text-brand-600", className)}
    >
      {/* Pin: gota con la punta abajo. */}
      <path
        d="M16 2.5c-5.8 0-10.5 4.6-10.5 10.3 0 7.3 8.7 15.4 10 16.6.3.3.7.3 1 0 1.3-1.2 10-9.3 10-16.6C26.5 7.1 21.8 2.5 16 2.5Z"
        fill={body}
      />
      {/* Esfera del reloj. */}
      <circle cx="16" cy="12.6" r="6.6" fill={inner} />
      {/* Manecillas: las doce y las cuatro, como un reloj que avanza. */}
      <path
        d="M16 8.6v4.1l2.9 1.7"
        stroke={body}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Visto de cumplido, apoyado en la punta del pin. */}
      <circle cx="24" cy="23.5" r="6" fill={inner} />
      <circle cx="24" cy="23.5" r="4.6" fill={brand.check} />
      <path
        d="m21.8 23.6 1.6 1.6 2.9-3.1"
        stroke={inner}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
