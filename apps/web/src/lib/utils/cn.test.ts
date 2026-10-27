import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("no confunde los tamaños de texto del proyecto con colores", () => {
    expect(cn("text-white", "text-small")).toBe("text-white text-small");
    expect(cn("text-brand-950", "text-body")).toBe("text-brand-950 text-body");
  });

  it("sigue resolviendo los conflictos reales", () => {
    expect(cn("text-small", "text-caption")).toBe("text-caption");
    expect(cn("text-white", "text-ink-950")).toBe("text-ink-950");
  });
});
