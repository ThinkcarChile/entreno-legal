import { describe, expect, it } from "vitest";

import { platform } from "@/config/platform";

import { defaultPublicTerms, formatCommissionPercent, parsePublicTerms } from "./public-terms";

describe("parsePublicTerms", () => {
  it("toma la comisión y la ventana de la fila de platform_settings", () => {
    expect(parsePublicTerms({ commission_bps: 1200, dispute_window_hours: 24 })).toEqual({
      commissionBps: 1200,
      disputeWindowHours: 24,
    });
  });

  it("acepta los extremos de los check de la tabla", () => {
    expect(parsePublicTerms({ commission_bps: 0, dispute_window_hours: 1 })).not.toBeNull();
    expect(parsePublicTerms({ commission_bps: 5000, dispute_window_hours: 720 })).not.toBeNull();
  });

  it.each([
    ["sin fila", null],
    ["fila vacía", {}],
    ["comisión negativa", { commission_bps: -1, dispute_window_hours: 12 }],
    ["comisión sobre el tope", { commission_bps: 5001, dispute_window_hours: 12 }],
    ["comisión con decimales", { commission_bps: 1400.5, dispute_window_hours: 12 }],
    ["comisión como texto", { commission_bps: "1400", dispute_window_hours: 12 }],
    ["ventana en cero", { commission_bps: 1400, dispute_window_hours: 0 }],
    ["ventana sobre el tope", { commission_bps: 1400, dispute_window_hours: 721 }],
    ["ventana nula", { commission_bps: 1400, dispute_window_hours: null }],
  ])("no publica %s", (_label, row) => {
    expect(parsePublicTerms(row)).toBeNull();
  });
});

describe("defaultPublicTerms", () => {
  it("es el respaldo de config/platform (variables de entorno)", () => {
    expect(defaultPublicTerms()).toEqual({
      commissionBps: platform.commissionBps,
      disputeWindowHours: platform.disputeWindowHours,
    });
  });
});

describe("formatCommissionPercent", () => {
  it("escribe el porcentaje con coma decimal y sin ceros de más", () => {
    expect(formatCommissionPercent(1400)).toBe("14");
    expect(formatCommissionPercent(1250)).toBe("12,5");
    expect(formatCommissionPercent(1225)).toBe("12,25");
    expect(formatCommissionPercent(0)).toBe("0");
  });
});
