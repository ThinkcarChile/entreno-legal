import { describe, expect, it } from "vitest";

import {
  authLinkErrorPath,
  authLinkMessage,
  classifyAuthLinkError,
  CONFIRM_LINK_TYPES,
  confirmLinkCopy,
  parseConfirmLink,
} from "./email-link";

// Forma real de un `{{ .TokenHash }}`: sha224 en hexadecimal.
const HASH = "a3f1c0de9b8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a49382";

const params = (query: string) => new URLSearchParams(query);

describe("parseConfirmLink", () => {
  it("acepta un enlace de confirmación de cuenta y lo lleva a completar el perfil", () => {
    expect(parseConfirmLink(params(`token_hash=${HASH}&type=email`))).toEqual({
      ok: true,
      tokenHash: HASH,
      type: "email",
      next: "/bienvenida",
    });
    expect(parseConfirmLink(params(`token_hash=${HASH}&type=signup`))).toMatchObject({
      ok: true,
      type: "signup",
      next: "/bienvenida",
    });
  });

  it("la recuperación termina siempre en /nueva-clave, diga lo que diga next", () => {
    expect(parseConfirmLink(params(`token_hash=${HASH}&type=recovery`))).toMatchObject({
      ok: true,
      type: "recovery",
      next: "/nueva-clave",
    });
    expect(
      parseConfirmLink(params(`token_hash=${HASH}&type=recovery&next=/mis-trabajos`)),
    ).toMatchObject({ ok: true, next: "/nueva-clave" });
  });

  it("el cambio de correo vuelve a la cuenta", () => {
    expect(parseConfirmLink(params(`token_hash=${HASH}&type=email_change`))).toMatchObject({
      ok: true,
      next: "/cuenta",
    });
  });

  it("respeta un next interno y descarta uno externo", () => {
    expect(
      parseConfirmLink(params(`token_hash=${HASH}&type=email&next=/publicar?desde=correo`)),
    ).toMatchObject({ ok: true, next: "/publicar?desde=correo" });
    expect(
      parseConfirmLink(params(`token_hash=${HASH}&type=email&next=https://evil.example`)),
    ).toMatchObject({ ok: true, next: "/bienvenida" });
    expect(
      parseConfirmLink(params(`token_hash=${HASH}&type=email&next=//evil.example`)),
    ).toMatchObject({ ok: true, next: "/bienvenida" });
  });

  it("acepta el prefijo pkce_ de Supabase", () => {
    expect(parseConfirmLink(params(`token_hash=pkce_${HASH}&type=recovery`))).toMatchObject({
      ok: true,
      tokenHash: `pkce_${HASH}`,
    });
  });

  it.each([
    ["sin token_hash", "type=recovery", "recovery"],
    ["token_hash vacío", "token_hash=&type=recovery", "recovery"],
    ["token_hash demasiado corto", "token_hash=abc123&type=email", "email"],
    ["token_hash con caracteres ajenos", `token_hash=${HASH}%3Cscript%3E&type=email`, "email"],
    ["token_hash con espacios en medio", `token_hash=${HASH.slice(0, 20)}%20${HASH.slice(20)}&type=email`, "email"],
    ["token_hash desmesurado", `token_hash=${"a".repeat(300)}&type=email`, "email"],
  ])("rechaza %s, conservando el tipo para saber adónde volver", (_label, query, type) => {
    expect(parseConfirmLink(params(query))).toEqual({ ok: false, type });
  });

  it.each([
    ["sin tipo", `token_hash=${HASH}`],
    ["tipo desconocido", `token_hash=${HASH}&type=admin`],
    ["invitación, que la aplicación no usa", `token_hash=${HASH}&type=invite`],
    // La aplicación no entra con enlaces mágicos: aceptarlos solo servía para
    // mandarle a otra persona uno pedido para la cuenta propia.
    ["enlace mágico, que la aplicación no usa", `token_hash=${HASH}&type=magiclink`],
    ["tipo de SMS", `token_hash=${HASH}&type=sms`],
    ["propiedad heredada del objeto", `token_hash=${HASH}&type=constructor`],
    ["mayúsculas", `token_hash=${HASH}&type=RECOVERY`],
  ])("rechaza %s", (_label, query) => {
    expect(parseConfirmLink(params(query))).toEqual({ ok: false, type: null });
  });

  it("solo declara tipos que verifyOtp conoce", () => {
    const deSupabase = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];
    for (const type of CONFIRM_LINK_TYPES) expect(deSupabase).toContain(type);
  });
});

describe("confirmLinkCopy", () => {
  it("cada tipo dice qué pasa al continuar y qué hacer con un enlace ajeno", () => {
    for (const type of CONFIRM_LINK_TYPES) {
      const copy = confirmLinkCopy(type);
      expect(copy.title).toBeTruthy();
      expect(copy.button).toBeTruthy();
      expect(copy.body).toMatch(/no continúes/);
    }
    expect(confirmLinkCopy("recovery").title).toMatch(/contraseña/);
    expect(confirmLinkCopy("email_change").title).toMatch(/correo/);
  });
});

describe("classifyAuthLinkError", () => {
  it("distingue vencido, otro navegador e inválido", () => {
    expect(classifyAuthLinkError("otp_expired")).toBe("enlace-vencido");
    expect(classifyAuthLinkError("flow_state_expired")).toBe("enlace-vencido");
    expect(classifyAuthLinkError("pkce_code_verifier_not_found")).toBe("otro-navegador");
    expect(classifyAuthLinkError("bad_code_verifier")).toBe("otro-navegador");
    expect(classifyAuthLinkError("flow_state_not_found")).toBe("otro-navegador");
    expect(classifyAuthLinkError("validation_failed")).toBe("enlace-invalido");
  });

  it("sin código, el error genérico", () => {
    expect(classifyAuthLinkError(undefined)).toBe("auth");
    expect(classifyAuthLinkError(null)).toBe("auth");
    expect(classifyAuthLinkError("")).toBe("auth");
  });
});

describe("authLinkErrorPath", () => {
  it("la recuperación vuelve a pedir otro enlace; lo demás, a entrar", () => {
    expect(authLinkErrorPath("recovery", "enlace-vencido")).toBe("/recuperar-clave?error=enlace-vencido");
    expect(authLinkErrorPath("email", "enlace-vencido")).toBe("/entrar?error=enlace-vencido");
    expect(authLinkErrorPath(null, "enlace-invalido")).toBe("/entrar?error=enlace-invalido");
  });
});

describe("authLinkMessage", () => {
  it("cada motivo tiene un aviso en las dos pantallas", () => {
    for (const code of ["enlace-vencido", "enlace-invalido", "otro-navegador", "auth"]) {
      expect(authLinkMessage(code, "entrar")?.title).toBeTruthy();
      expect(authLinkMessage(code, "recuperar")?.body).toBeTruthy();
    }
  });

  it("un valor desconocido de la URL no se muestra", () => {
    expect(authLinkMessage(null, "entrar")).toBeNull();
    expect(authLinkMessage("<b>hola</b>", "entrar")).toBeNull();
    expect(authLinkMessage("toString", "recuperar")).toBeNull();
    expect(authLinkMessage("__proto__", "recuperar")).toBeNull();
  });
});
