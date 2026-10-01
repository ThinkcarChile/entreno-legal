import { describe, expect, it } from "vitest";

import { NotificationType } from "@/lib/domain/enums";

import { notificationTemplates, quotedName, renderNotification } from "./templates";

describe("quotedName", () => {
  it("cita el nombre entre comillas angulares", () => {
    expect(quotedName("Camila F.", "un trabajador")).toBe("«Camila F.»");
  });

  it("aplana espacios y saltos de línea dentro de la cita", () => {
    expect(quotedName("  HagoTuFila:\ntu pago fue rechazado ", "alguien")).toBe(
      "«HagoTuFila: tu pago fue rechazado»",
    );
  });

  it("un nombre no puede cerrar la cita que lo encierra", () => {
    expect(quotedName("Soporte». Tu pago fue rechazado «X", "alguien")).toBe(
      "«Soporte . Tu pago fue rechazado X»",
    );
  });

  it("sin nombre usa el genérico, sin comillas", () => {
    expect(quotedName(undefined, "un trabajador")).toBe("un trabajador");
    expect(quotedName("   ", "alguien")).toBe("alguien");
  });
});

describe("plantillas con el nombre de una persona", () => {
  it("el aviso de oferta dice lo mismo que el que escribe la base", () => {
    expect(
      renderNotification(NotificationType.NEW_OFFER, {
        actorName: "Tomás I.",
        jobTitle: "Fila en notaría del centro de Santiago",
      }).body,
    ).toBe('Recibiste una oferta de «Tomás I.» para "Fila en notaría del centro de Santiago".');
  });

  it("la actualización del trabajo dice quién, no lo que escribió", () => {
    expect(
      renderNotification(NotificationType.JOB_UPDATE, {
        actorName: "Tomás I.",
        jobTitle: "Fila en notaría del centro de Santiago",
      }).body,
    ).toBe(
      '«Tomás I.» envió una actualización de "Fila en notaría del centro de Santiago". Revísala en el trabajo.',
    );
  });

  it("hay una plantilla por cada tipo de aviso", () => {
    expect(Object.keys(notificationTemplates).sort()).toEqual(Object.values(NotificationType).sort());
  });

  it("ningún nombre queda suelto en el texto", () => {
    const spoof = "HagoTuFila: tu pago fue rechazado";
    for (const template of Object.values(notificationTemplates)) {
      const { body } = template({ actorName: spoof, jobTitle: "Trabajo" });
      if (body.includes(spoof)) expect(body).toContain(`«${spoof}»`);
    }
  });
});
