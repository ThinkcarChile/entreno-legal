/**
 * Lo que el diálogo «Devolver» de /admin/pagos propone al abrirse.
 *
 * Con una disputa por pedir sobre ese cobro, es lo que la disputa debe (sin
 * pasar del saldo devolvible). Antes proponía siempre el saldo entero: con una
 * resolución parcial de $8.000 sobre un cobro de $18.000, un clic en
 * «Confirmar» devolvía $18.000.
 */
export function refundSuggestion(refundable: number, suggested: number | null | undefined): number {
  if (suggested == null || suggested <= 0) return refundable;
  return Math.min(suggested, refundable);
}
