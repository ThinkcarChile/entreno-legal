import { describe, expect, it } from "vitest";
import {
  INVITATION_TTL_DAYS,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  isInvitationUsable,
} from "./invitations";

describe("invitations", () => {
  it("el token es aleatorio y su hash es determinista", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(hashInvitationToken(a)).toBe(hashInvitationToken(a));
    expect(hashInvitationToken(a)).not.toBe(hashInvitationToken(b));
    expect(hashInvitationToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expira a los 7 días", () => {
    const now = new Date("2026-08-24T12:00:00Z");
    const expiry = invitationExpiry(now);
    const days = (expiry.getTime() - now.getTime()) / 86_400_000;
    expect(days).toBe(INVITATION_TTL_DAYS);
  });

  it("usable solo si no está aceptada, ni revocada, ni vencida", () => {
    const now = new Date("2026-08-24T12:00:00Z");
    const future = "2026-08-25T12:00:00Z";
    const past = "2026-08-23T12:00:00Z";
    expect(isInvitationUsable({ expires_at: future, accepted_at: null, revoked_at: null }, now)).toBe(true);
    expect(isInvitationUsable({ expires_at: past, accepted_at: null, revoked_at: null }, now)).toBe(false);
    expect(isInvitationUsable({ expires_at: future, accepted_at: past, revoked_at: null }, now)).toBe(false);
    expect(isInvitationUsable({ expires_at: future, accepted_at: null, revoked_at: past }, now)).toBe(false);
  });
});
