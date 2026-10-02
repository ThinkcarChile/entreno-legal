import { describe, expect, it } from "vitest";

import { refundSuggestion } from "./refund-suggestion";

describe("refundSuggestion", () => {
  it("con una disputa por pedir, propone lo que debe la disputa", () => {
    expect(refundSuggestion(18000, 8000)).toBe(8000);
  });
  it("nunca más que el saldo devolvible", () => {
    expect(refundSuggestion(5000, 8000)).toBe(5000);
  });
  it("sin disputa, el saldo", () => {
    expect(refundSuggestion(18000, null)).toBe(18000);
    expect(refundSuggestion(18000, 0)).toBe(18000);
  });
});
