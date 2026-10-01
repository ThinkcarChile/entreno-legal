import { describe, expect, it } from "vitest";

import { publishedListNotice } from "./published-list-notice";
import { returnTargetFor } from "./return-target";

import type { ReturnOutcome } from "./return-handler";

/**
 * Cada `?pago=` con el que `/pagos/retorno` y `returnTargetFor` mandan a la
 * lista de trabajos publicados tiene que pintar un aviso. Antes la página no
 * leía `?pago=` y el cliente, en el caso incierto, no veía «No vuelvas a pagar».
 */
describe("avisos de la lista de trabajos publicados", () => {
  it("los casos inciertos piden no volver a pagar", () => {
    for (const pago of ["verificando", "desconocido", "error"]) {
      expect(publishedListNotice(pago)?.body).toMatch(/No vuelvas a pagar/);
    }
  });

  it("verificando es informativo; desconocido y error, advertencias", () => {
    expect(publishedListNotice("verificando")?.tone).toBe("info");
    expect(publishedListNotice("desconocido")?.tone).toBe("warning");
    expect(publishedListNotice("error")?.tone).toBe("danger");
  });

  it("sin aviso, o con uno que no es de esta página, no pinta nada", () => {
    expect(publishedListNotice(undefined)).toBeNull();
    expect(publishedListNotice("extension-ok")).toBeNull();
    expect(publishedListNotice("cualquiera")).toBeNull();
  });

  it("todo destino de returnTargetFor que cae en la lista tiene su aviso", () => {
    const payment = {
      id: "p",
      job_id: "j",
      assignment_id: null,
      purpose: "JOB",
      status: "PAID",
      client_id: "c",
    };
    const outcomes = [
      { kind: "FORBIDDEN" },
      { kind: "UNKNOWN" },
      { kind: "ALREADY", payment },
    ] as unknown as ReturnOutcome[];

    for (const outcome of outcomes) {
      const target = returnTargetFor(outcome);
      const url = new URL(target, "https://x.cl");
      expect(url.pathname).toBe("/mis-trabajos/publicados");
      expect(publishedListNotice(url.searchParams.get("pago") ?? undefined)).not.toBeNull();
    }
  });
});
