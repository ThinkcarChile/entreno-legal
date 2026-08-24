import { describe, expect, it } from "vitest";
import {
  addDays,
  effectiveDate,
  formatDate,
  weekDays,
  weekLabel,
  weekStart,
  weekdayName,
} from "./calendar";

describe("§15 la fecha efectiva es la del hogar, no la de UTC", () => {
  it("22:30 del domingo en Santiago sigue siendo domingo, aunque en UTC ya sea lunes", () => {
    // 2026-08-24 22:30 en Santiago (UTC-4) = 2026-08-25 02:30 UTC
    const instante = new Date("2026-08-25T02:30:00Z");
    expect(effectiveDate(instante, "America/Santiago")).toBe("2026-08-24");
    expect(effectiveDate(instante, "UTC")).toBe("2026-08-25");
  });

  it("00:30 del lunes en Santiago ya es lunes", () => {
    const instante = new Date("2026-08-25T04:30:00Z");
    expect(effectiveDate(instante, "America/Santiago")).toBe("2026-08-25");
  });

  it("funciona igual para un hogar en otra zona", () => {
    const instante = new Date("2026-08-25T02:30:00Z");
    expect(effectiveDate(instante, "Europe/Madrid")).toBe("2026-08-25");
    expect(effectiveDate(instante, "Pacific/Auckland")).toBe("2026-08-25");
  });

  it("sin zona configurada usa la del hogar chileno", () => {
    const instante = new Date("2026-08-25T02:30:00Z");
    expect(effectiveDate(instante)).toBe("2026-08-24");
  });
});

describe("aritmética de fechas sin desfase", () => {
  it("sumar y restar días no se corre por husos horarios", () => {
    expect(addDays("2026-08-24", 1)).toBe("2026-08-25");
    expect(addDays("2026-08-24", -1)).toBe("2026-08-23");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("mostrar una fecha no la corre un día", () => {
    // El clásico: new Date("2026-08-24") es medianoche UTC, que en Chile es el 23.
    expect(formatDate("2026-08-24")).toContain("24");
    expect(formatDate("2026-01-01")).toContain("1");
  });
});

describe("la semana empieza el lunes", () => {
  it("un miércoles pertenece a la semana de su lunes", () => {
    expect(weekStart("2026-09-02")).toBe("2026-08-31"); // miércoles -> lunes
  });

  it("un lunes es su propio inicio de semana", () => {
    expect(weekStart("2026-08-31")).toBe("2026-08-31");
  });

  it("un domingo pertenece a la semana que ya termina, no a la siguiente", () => {
    expect(weekStart("2026-09-06")).toBe("2026-08-31");
  });

  it("la semana tiene siete días de lunes a domingo", () => {
    const dias = weekDays("2026-08-31");
    expect(dias).toHaveLength(7);
    expect(dias[0]).toBe("2026-08-31");
    expect(dias[6]).toBe("2026-09-06");
    expect(weekdayName(dias[0]!)).toBe("Lunes");
    expect(weekdayName(dias[6]!)).toBe("Domingo");
  });

  it("cruza el cambio de mes sin perderse", () => {
    expect(weekLabel("2026-08-31")).toContain("agosto");
    expect(weekLabel("2026-08-31")).toContain("septiembre");
    expect(weekLabel("2026-09-07")).toBe("7 al 13 de septiembre");
  });
});
