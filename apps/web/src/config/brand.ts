/**
 * Los valores de marca que necesitan vivir en TypeScript.
 *
 * El sistema de diseño vive en `globals.css`; estos colores hacen falta fuera
 * del CSS —el manifiesto, la etiqueta `theme-color`, el icono— y antes
 * estaban copiados a mano en cuatro archivos. Copiados quiere decir que un
 * cambio de marca se olvidaba en alguno.
 *
 * Si cambian aquí, hay que cambiarlos también en `globals.css` y en los SVG de
 * `public/icons/` y `src/app/icon.svg`: un archivo estático no puede leer una
 * variable. Son los únicos sitios.
 */
export const brand = {
  /** `--color-brand-950`. El verde petróleo de la acción principal. */
  primary: "#12393a",
  /** `--color-accent-300`. El lima del símbolo y la acción destacada. */
  accent: "#d9f27e",
  /** `--color-canvas`. El marfil del fondo. */
  canvas: "#f7f8f4",
  /** `--color-ink-950`. El texto primario. */
  ink: "#142f33",
} as const;
