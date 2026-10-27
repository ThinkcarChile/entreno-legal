import { describe, expect, it } from "vitest";

import {
  buildEvidencePath,
  inspectUploadedEvidence,
  isGeneratedEvidencePath,
} from "./evidence";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SCOPE = "33333333-3333-4333-8333-333333333333";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const EXE = [0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0];

function stored(bytes: number[], type: string) {
  return async () => ({ data: new Blob([new Uint8Array(bytes)], { type }), error: null });
}

describe("isGeneratedEvidencePath", () => {
  it("acepta la ruta que genera la aplicación para esa persona y ese ámbito", () => {
    expect(isGeneratedEvidencePath(buildEvidencePath(USER, SCOPE, "image/png"), USER, SCOPE)).toBe(true);
  });

  it("rechaza otra carpeta, otro ámbito, un nombre elegido y salir de la carpeta", () => {
    expect(isGeneratedEvidencePath(buildEvidencePath(OTHER, SCOPE, "image/png"), USER, SCOPE)).toBe(false);
    expect(isGeneratedEvidencePath(buildEvidencePath(USER, OTHER, "image/png"), USER, SCOPE)).toBe(false);
    expect(isGeneratedEvidencePath(`${USER}/${SCOPE}/foto.png`, USER, SCOPE)).toBe(false);
    expect(isGeneratedEvidencePath(`${USER}/${SCOPE}/../x.png`, USER, SCOPE)).toBe(false);
    expect(isGeneratedEvidencePath(`${USER}/${SCOPE}/a/b.png`, USER, SCOPE)).toBe(false);
  });
});

describe("inspectUploadedEvidence: lo que se registra es lo que de verdad se subió", () => {
  it("una imagen real pasa, con el tipo y el tamaño medidos", async () => {
    const path = buildEvidencePath(USER, SCOPE, "image/png");
    const result = await inspectUploadedEvidence(stored(PNG, "image/png"), path);
    expect(result).toEqual({ ok: true, type: "image/png", size: PNG.length });
  });

  it("un ejecutable guardado como image/jpeg no pasa", async () => {
    const path = buildEvidencePath(USER, SCOPE, "image/jpeg");
    const result = await inspectUploadedEvidence(stored(EXE, "image/jpeg"), path);
    expect(result).toEqual({ ok: false, message: "El archivo no es del tipo que dice ser." });
  });

  it("un JPEG real con una ruta .png (tipo y ruta que no cuadran) no pasa", async () => {
    const path = buildEvidencePath(USER, SCOPE, "image/png");
    const result = await inspectUploadedEvidence(stored(JPEG, "image/jpeg"), path);
    expect(result.ok).toBe(false);
  });

  it("un tipo fuera de la lista no pasa aunque los bytes sean de imagen", async () => {
    const path = buildEvidencePath(USER, SCOPE, "image/png");
    const result = await inspectUploadedEvidence(stored(PNG, "image/svg+xml"), path);
    expect(result.ok).toBe(false);
  });

  it("si el archivo no está, se dice", async () => {
    const result = await inspectUploadedEvidence(
      async () => ({ data: null, error: new Error("not found") }),
      buildEvidencePath(USER, SCOPE, "image/png"),
    );
    expect(result).toEqual({ ok: false, message: "No encontramos el archivo subido. Vuelve a adjuntarlo." });
  });
});
