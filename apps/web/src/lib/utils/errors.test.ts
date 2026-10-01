import { describe, expect, it } from "vitest";

import { toAppError } from "./errors";

/**
 * Los límites por usuario (migración 20260601001200) responden con SQLSTATE
 * PT429 —HTTP 429 en PostgREST— y un mensaje que dice cuándo volver. Ese
 * mensaje tiene que llegar tal cual a la pantalla: si `toAppError` lo tomara por
 * texto técnico, la persona vería «No pudimos completar la acción» y no sabría
 * que basta con esperar.
 */
describe("toAppError con los límites de la base", () => {
  const casos = [
    "Alcanzaste el máximo de 30 trabajos publicados en 24 horas. Podrás publicar otro en 3 h 20 min.",
    "Alcanzaste el máximo de 30 ofertas en una hora. Podrás enviar otra en 12 minutos.",
    "Estás enviando mensajes muy seguido. Podrás escribir de nuevo en 40 segundos.",
  ];

  for (const message of casos) {
    it(`muestra «${message.slice(0, 40)}…»`, () => {
      expect(toAppError({ code: "PT429", message }).message).toBe(message);
    });
  }

  it("un 429 sin mensaje propio sigue diciendo que hay que esperar", () => {
    expect(toAppError({ status: 429, message: "too_many_requests" }).message).toMatch(/Espera/);
  });
});

describe("toAppError con la evidencia contrastada contra Storage", () => {
  it("muestra los motivos de rechazo del archivo", () => {
    for (const message of [
      "No encontramos el archivo subido. Vuelve a adjuntarlo.",
      "El tipo del archivo no coincide con el que se subió",
      "El tamaño del archivo no coincide con el que se subió",
      "El código de entrega se valida con el trabajo en curso. Primero comienza el trabajo.",
    ]) {
      expect(toAppError({ code: "23514", message }).message).toBe(message);
    }
  });
});
