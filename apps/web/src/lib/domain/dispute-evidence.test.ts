import { describe, expect, it } from "vitest";

import {
  disputeEvidenceAuthor,
  disputeEvidenceCountLabel,
  disputeFileKind,
} from "./dispute-evidence";

describe("disputeFileKind", () => {
  it("sin ruta no hay archivo", () => {
    expect(disputeFileKind(null)).toBeNull();
    expect(disputeFileKind("")).toBeNull();
  });

  it("un PDF se distingue de una imagen por la extensión que pone la aplicación", () => {
    expect(disputeFileKind("u/d/0f.pdf")).toBe("pdf");
    expect(disputeFileKind("u/d/0f.PDF")).toBe("pdf");
    expect(disputeFileKind("u/d/0f.jpg")).toBe("image");
    expect(disputeFileKind("u/d/0f.webp")).toBe("image");
  });
});

describe("disputeEvidenceAuthor", () => {
  it("papel y nombre cuando se puede leer el perfil", () => {
    expect(disputeEvidenceAuthor({ authorRole: "CLIENT", authorName: "Paula C." })).toBe(
      "Cliente · Paula C.",
    );
  });

  it("solo el papel cuando el perfil no se puede leer", () => {
    expect(disputeEvidenceAuthor({ authorRole: "ADMIN", authorName: null })).toBe(
      "Administración",
    );
    expect(disputeEvidenceAuthor({ authorRole: null, authorName: null })).toBe("Participante");
  });
});

describe("disputeEvidenceCountLabel", () => {
  it("no confunde «no se pudo contar» con cero", () => {
    expect(disputeEvidenceCountLabel(null)).toBe("No se pudieron contar las pruebas");
    expect(disputeEvidenceCountLabel(0)).toBe("Sin pruebas aportadas");
    expect(disputeEvidenceCountLabel(1)).toBe("1 prueba aportada");
    expect(disputeEvidenceCountLabel(4)).toBe("4 pruebas aportadas");
  });
});
