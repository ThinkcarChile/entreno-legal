export * from "./types";
export {
  INGREDIENTES_NUEVOS,
  INGREDIENTES_EXISTENTES,
  RECETAS_EXISTENTES,
  RECETAS_ANIDADAS,
  MEDIDAS_POR_UNIDAD,
  RENDIMIENTOS_CONFIRMADOS,
} from "./catalog";
export { LOTE_A } from "./lote-a";
export { LOTE_B } from "./lote-b";
export { LOTE_C } from "./lote-c";
export { LOTE_D } from "./lote-d";
export { LOTE_E } from "./lote-e";
export { LOTE_F } from "./lote-f";
export { LOTE_G } from "./lote-g";
export { LOTE_H } from "./lote-h";
export { LOTE_I } from "./lote-i";
export { generarSeedSQL, cantidadNormalizada } from "./seed";

import { INGREDIENTES_EXISTENTES, INGREDIENTES_NUEVOS } from "./catalog";
import { LOTE_A } from "./lote-a";
import { LOTE_B } from "./lote-b";
import { LOTE_C } from "./lote-c";
import { LOTE_D } from "./lote-d";
import { LOTE_E } from "./lote-e";
import { LOTE_F } from "./lote-f";
import { LOTE_G } from "./lote-g";
import { LOTE_H } from "./lote-h";
import { LOTE_I } from "./lote-i";
import type { LibraryRecipe } from "./types";

/** Toda la biblioteca chilena publicada hasta ahora. Los lotes B, C… se suman acá. */
export const BIBLIOTECA: LibraryRecipe[] = [...LOTE_A, ...LOTE_B, ...LOTE_C, ...LOTE_D, ...LOTE_E, ...LOTE_F, ...LOTE_G, ...LOTE_H, ...LOTE_I];

/** Nombres canónicos que la biblioteca puede referenciar sin inventar identidades. */
export const IDENTIDADES_VALIDAS: ReadonlySet<string> = new Set([
  ...INGREDIENTES_EXISTENTES,
  ...INGREDIENTES_NUEVOS.map((i) => i.canonicalName),
]);
