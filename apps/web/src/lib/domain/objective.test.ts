import { describe, expect, it } from "vitest";

import { JobObjectiveType } from "./enums";
import { objectiveSummary } from "./objective";

const base = { targetPosition: null, description: null };

describe("objectiveSummary", () => {
  it("un trabajo «lo más adelante posible» sin descripción no se presenta como «mantener el lugar»", () => {
    expect(objectiveSummary({ ...base, type: JobObjectiveType.AS_FRONT_AS_POSSIBLE })).toBe(
      "Quedar lo más adelante posible en la fila.",
    );
  });

  it("dentro de los primeros N dice el número", () => {
    expect(objectiveSummary({ ...base, type: JobObjectiveType.WITHIN_FIRST_N, targetPosition: 20 })).toBe(
      "Quedar dentro de los primeros 20 de la fila.",
    );
  });

  it("en una fila manda el tipo, aunque haya descripción", () => {
    expect(
      objectiveSummary({ ...base, type: JobObjectiveType.HOLD_PLACE, description: "otra cosa" }),
    ).toBe("Mantener el lugar en la fila hasta que llegue el cliente.");
  });

  it("una gestión y un objetivo personalizado usan su descripción", () => {
    expect(objectiveSummary({ ...base, type: JobObjectiveType.COMPLETE_ERRAND, description: "Retirar el carnet" })).toBe(
      "Retirar el carnet",
    );
    expect(objectiveSummary({ ...base, type: JobObjectiveType.CUSTOM })).toBe("Objetivo personalizado.");
  });
});
