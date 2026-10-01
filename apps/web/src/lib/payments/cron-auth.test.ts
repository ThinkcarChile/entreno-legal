import { describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "./cron-auth";

const SECRET = "s".repeat(40);

describe("isAuthorizedCronRequest", () => {
  it("acepta el secreto exacto con el esquema Bearer", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rechaza sin cabecera, con otro esquema o con otro secreto", () => {
    expect(isAuthorizedCronRequest(null, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest("", SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${"x".repeat(40)}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET} `, SECRET)).toBe(false);
  });

  it("sin secreto configurado, o con uno corto, no autoriza nunca", () => {
    expect(isAuthorizedCronRequest("Bearer ", undefined)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer corto", "corto")).toBe(false);
  });
});
