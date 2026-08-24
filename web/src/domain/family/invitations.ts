import { createHash, randomBytes } from "node:crypto";

export const INVITATION_TTL_DAYS = 7;

/** Token de un solo uso, compartible por link. Solo su hash se almacena. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface InvitationState {
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export function isInvitationUsable(inv: InvitationState, now: Date = new Date()): boolean {
  if (inv.accepted_at !== null || inv.revoked_at !== null) return false;
  return new Date(inv.expires_at).getTime() > now.getTime();
}
