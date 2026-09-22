import { describe, expect, it } from "vitest";

import { classifyReturn, failureReasonFor, mayCommit, tokenForStatus } from "./return-flow";

/**
 * Los cuatro flujos oficiales de retorno de Webpay Plus.
 *
 * Esta es la prueba que más importa de todo el bloque: equivocarse aquí es la
 * diferencia entre «el cliente canceló» y «al cliente se le cobró».
 */
describe("clasificación del retorno", () => {
  it("flujo normal: solo token_ws", () => {
    const flow = classifyReturn({ token_ws: "tok-normal" });
    expect(flow).toEqual({ kind: "NORMAL", token: "tok-normal" });
    expect(mayCommit(flow)).toBe(true);
  });

  it("tiempo agotado: sesión y orden, sin token", () => {
    const flow = classifyReturn({
      TBK_ID_SESION: "S-1",
      TBK_ORDEN_COMPRA: "HTF-1",
    });
    expect(flow.kind).toBe("TIMEOUT");
    expect(mayCommit(flow)).toBe(false);
    // Sin token no hay nada que consultar ni que confirmar.
    expect(tokenForStatus(flow)).toBeNull();
    expect(failureReasonFor(flow)).toBe("form_timeout");
  });

  it("acepta la variante TBK_ID_SESSION que usa la documentación en el detalle", () => {
    const flow = classifyReturn({
      TBK_ID_SESSION: "S-1",
      TBK_ORDEN_COMPRA: "HTF-1",
    });
    expect(flow).toMatchObject({ kind: "TIMEOUT", sessionId: "S-1" });
  });

  it("pago abortado: TBK_TOKEN, nunca commit", () => {
    const flow = classifyReturn({
      TBK_TOKEN: "tok-abort",
      TBK_ID_SESION: "S-1",
      TBK_ORDEN_COMPRA: "HTF-1",
    });
    expect(flow.kind).toBe("ABORTED");
    expect(mayCommit(flow)).toBe(false);
    expect(tokenForStatus(flow)).toBe("tok-abort");
    expect(failureReasonFor(flow)).toBe("aborted_by_user");
  });

  it("error y «volver al sitio»: los cuatro parámetros, y NO se confirma", () => {
    const flow = classifyReturn({
      token_ws: "tok-ws",
      TBK_TOKEN: "tok-abort",
      TBK_ID_SESION: "S-1",
      TBK_ORDEN_COMPRA: "HTF-1",
    });
    expect(flow.kind).toBe("CONFLICTED");
    // La trampa del bloque: hay un token_ws que invita a confirmar. No.
    expect(mayCommit(flow)).toBe(false);
    expect(tokenForStatus(flow)).toBe("tok-abort");
    expect(failureReasonFor(flow)).toBe("return_conflict");
  });

  it("un TBK_TOKEN vacío no convierte un flujo normal en abortado", () => {
    const flow = classifyReturn({ token_ws: "tok", TBK_TOKEN: "", TBK_ID_SESION: "  " });
    expect(flow).toEqual({ kind: "NORMAL", token: "tok" });
  });

  it("sin parámetros no se inventa nada", () => {
    expect(classifyReturn({}).kind).toBe("UNKNOWN");
    expect(mayCommit(classifyReturn({}))).toBe(false);
  });

  it("solo el flujo normal autoriza a confirmar, en cualquier combinación", () => {
    const combinations = [
      { token_ws: "t" },
      { TBK_TOKEN: "t" },
      { TBK_ID_SESION: "s" },
      { TBK_ORDEN_COMPRA: "o" },
      { token_ws: "t", TBK_TOKEN: "t2" },
      { token_ws: "t", TBK_ID_SESION: "s" },
      { token_ws: "t", TBK_ORDEN_COMPRA: "o" },
      { TBK_TOKEN: "t", TBK_ID_SESION: "s", TBK_ORDEN_COMPRA: "o" },
      { token_ws: "t", TBK_TOKEN: "t2", TBK_ID_SESION: "s", TBK_ORDEN_COMPRA: "o" },
      {},
    ];
    const committable = combinations.filter((c) => mayCommit(classifyReturn(c)));
    // token_ws solo, token_ws + sesión y token_ws + orden: ninguno lleva
    // TBK_TOKEN, así que los tres son flujo normal.
    expect(committable).toHaveLength(3);
    for (const c of committable) {
      expect(c).not.toHaveProperty("TBK_TOKEN");
    }
  });
});
