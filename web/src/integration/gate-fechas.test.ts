import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveDate } from "@/domain/nutrition/calendar";

/**
 * GATE FINAL §4 — DATE-only = fecha CIVIL del hogar, jamás el día UTC.
 *
 * El caso real: `saveMealGoals` cerraba el objetivo viejo con
 * `new Date().toISOString().slice(0, 10)` — el día UTC. A las 23:30 de un
 * domingo en Santiago, UTC ya va en lunes 03:30: la meta quedaba cerrada "el
 * lunes" y la nueva empezaba "el lunes", con el domingo real en un limbo.
 * Ahora ambas fechas salen de `effectiveDate(now, tz_del_hogar)`.
 */

describe("§4 — el borde de medianoche de Santiago", () => {
  // Chile en agosto = UTC-4 (invierno). 23:30 dom 30-ago = 03:30 UTC lun 31.
  it("23:30 del domingo en Santiago ES domingo, aunque UTC ya vaya en lunes", () => {
    const instante = new Date("2026-08-31T03:30:00Z");
    expect(instante.toISOString().slice(0, 10)).toBe("2026-08-31"); // el día UTC MIENTE
    expect(effectiveDate(instante, "America/Santiago")).toBe("2026-08-30"); // el civil no
  });

  it("00:30 del lunes en Santiago ES lunes", () => {
    const instante = new Date("2026-08-31T04:30:00Z");
    expect(effectiveDate(instante, "America/Santiago")).toBe("2026-08-31");
  });

  it("el cambio de hora chileno (06-sep-2026, salto 24:00→01:00) no rompe el día", () => {
    // La noche del 5 al 6 de septiembre Chile adelanta el reloj (UTC-4→UTC-3).
    // 03:59 UTC del 6-sep = 23:59 del sábado 5 (todavía UTC-4).
    expect(effectiveDate(new Date("2026-09-06T03:59:00Z"), "America/Santiago")).toBe("2026-09-05");
    // 04:01 UTC = 01:01 del domingo 6 (ya UTC-3; la hora 00:xx no existió).
    expect(effectiveDate(new Date("2026-09-06T04:01:00Z"), "America/Santiago")).toBe("2026-09-06");
  });
});

describe("§4 — contrato: el día UTC no decide vigencias en ninguna acción", () => {
  it("ninguna server action usa toISOString().slice(0, 10) para fechas de negocio", () => {
    const APP = path.resolve(__dirname, "../app");
    const archivos: string[] = [];
    const caminar = (raiz: string) => {
      for (const nombre of readdirSync(raiz)) {
        const ruta = path.join(raiz, nombre);
        if (statSync(ruta).isDirectory()) caminar(ruta);
        else if (/actions\.ts$/.test(nombre)) archivos.push(ruta);
      }
    };
    caminar(APP);

    const ofensas: string[] = [];
    for (const archivo of archivos) {
      const fuente = readFileSync(archivo, "utf8");
      for (const m of fuente.matchAll(/toISOString\(\)\.(slice\(0,\s*10\)|split\("T"\))/g)) {
        const linea = fuente.slice(0, m.index).split("\n").length;
        ofensas.push(`${path.relative(APP, archivo)}:${linea}`);
      }
    }
    expect(ofensas).toEqual([]);
  });
});
