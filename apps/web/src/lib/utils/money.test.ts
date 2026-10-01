import { describe, expect, it } from "vitest";

import { money, proratePerHour } from "./money";

/**
 * El total de una oferta lo calcula la base (`app_private.offer_total`,
 * migración …001130) como `round(tarifa × minutos / 60)`, y es lo que se cobra.
 * El formulario de la oferta muestra la misma cuenta con `proratePerHour`: si
 * las dos redondearan distinto, la persona vería un total y se guardaría otro.
 * Los casos son los de `supabase/tests/14_public_data.sql` (U02, U04, U08).
 */
describe("proratePerHour, igual que el total que calcula la base", () => {
  it("tarifa por hora por duración", () => {
    expect(proratePerHour(money(9000), 120).amount).toBe(18000);
    expect(proratePerHour(money(9000), 180).amount).toBe(27000);
    expect(proratePerHour(money(10000), 180).amount).toBe(30000);
  });

  it("medio peso se redondea hacia arriba, como round() de PostgreSQL", () => {
    // 3.001 × 30 / 60 = 1.500,5
    expect(proratePerHour(money(3001), 30).amount).toBe(1501);
    // 8.333 × 45 / 60 = 6.249,75
    expect(proratePerHour(money(8333), 45).amount).toBe(6250);
  });
});
