/**
 * Los valores de marca que necesitan vivir en TypeScript.
 *
 * El sistema de diseño vive en `globals.css`; estos tres colores hacen falta
 * fuera del CSS —el manifiesto, la etiqueta `theme-color`, el icono— y antes
 * estaban copiados a mano en cuatro archivos. Copiados quiere decir que un
 * cambio de marca se olvidaba en alguno.
 *
 * Si cambian aquí, hay que cambiarlos también en `globals.css` y en los SVG de
 * `public/icons/`: un archivo estático no puede leer una variable. Son los
 * únicos dos sitios.
 */
export const brand = {
  /** `--color-brand-600`. El coral que lleva texto encima. */
  primary: "#ce2f59",
  /** `--color-canvas`. El crema del fondo. */
  canvas: "#fff9f4",
  /** `--color-ink-950`. El azul profundo de la marca. */
  ink: "#152238",
  /** `--color-success-500`. El verde del visto de verificación. */
  check: "#20b486",
} as const;
