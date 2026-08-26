export * from "./types";
export {
  INGREDIENTES_NUEVOS,
  INGREDIENTES_EXISTENTES,
  RECETAS_EXISTENTES,
  RECETAS_ANIDADAS,
  MEDIDAS_POR_UNIDAD,
} from "./catalog";
export { LOTE_A } from "./lote-a";
export { LOTE_B } from "./lote-b";
export { LOTE_C } from "./lote-c";
export { LOTE_D } from "./lote-d";
export { LOTE_E } from "./lote-e";
export { LOTE_F } from "./lote-f";
export { LOTE_G } from "./lote-g";
export { generarSeedSQL, cantidadNormalizada } from "./seed";

import { INGREDIENTES_EXISTENTES, INGREDIENTES_NUEVOS } from "./catalog";
import { LOTE_A } from "./lote-a";
import { LOTE_B } from "./lote-b";
import { LOTE_C } from "./lote-c";
import { LOTE_D } from "./lote-d";
import { LOTE_E } from "./lote-e";
import { LOTE_F } from "./lote-f";
import { LOTE_G } from "./lote-g";
import type { LibraryRecipe } from "./types";

/** Toda la biblioteca chilena publicada hasta ahora. Los lotes B, C… se suman acá. */
export const BIBLIOTECA: LibraryRecipe[] = [...LOTE_A, ...LOTE_B, ...LOTE_C, ...LOTE_D, ...LOTE_E, ...LOTE_F, ...LOTE_G];

/** Nombres canónicos que la biblioteca puede referenciar sin inventar identidades. */
export const IDENTIDADES_VALIDAS: ReadonlySet<string> = new Set([
  ...INGREDIENTES_EXISTENTES,
  ...INGREDIENTES_NUEVOS.map((i) => i.canonicalName),
]);
