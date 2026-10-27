import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `twMerge` con la escala tipográfica del proyecto.
 *
 * Sin esto, `text-small` o `text-body` —tamaños definidos en `globals.css`—
 * se toman por colores y borran el color de texto que venía antes: un botón
 * `primary` de tamaño `sm` perdía su `text-white` y heredaba el color del
 * contexto, texto oscuro sobre fondo oscuro.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "h1", "h2", "h3", "body", "small", "caption", "label"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
