import { describe, expect, it } from "vitest";

import { uploadErrorMessage } from "./upload-errors";

describe("uploadErrorMessage", () => {
  it("traduce lo que Storage contesta en inglés, sin detalles internos", () => {
    expect(uploadErrorMessage({ statusCode: "413", message: "The object exceeded the maximum allowed size" })).toBe(
      "El archivo supera los 8 MB.",
    );
    expect(uploadErrorMessage({ message: "mime type image/gif is not supported" })).toBe(
      "Solo aceptamos imágenes JPG, PNG, WebP o un PDF.",
    );
    expect(uploadErrorMessage({ statusCode: "403", message: "new row violates row-level security policy" })).toMatch(
      /ya no admita archivos/,
    );
    expect(uploadErrorMessage(new TypeError("Failed to fetch"))).toMatch(/Revisa tu conexión/);
  });

  it("lo desconocido queda en un mensaje general", () => {
    expect(uploadErrorMessage({ message: "ERROR 42P01 relation storage.objects" })).toBe(
      "No pudimos subir el archivo. Inténtalo de nuevo.",
    );
    expect(uploadErrorMessage(null)).toBe("No pudimos subir el archivo. Inténtalo de nuevo.");
  });
});
