import { ManualVerificationProvider } from "./manual-provider";

import type { IdentityVerificationProvider } from "./provider";

export * from "./provider";
export { ManualVerificationProvider } from "./manual-provider";

let provider: IdentityVerificationProvider | null = null;

export function getVerificationProvider(): IdentityVerificationProvider {
  provider ??= new ManualVerificationProvider();
  return provider;
}

export function setVerificationProvider(next: IdentityVerificationProvider | null): void {
  provider = next;
}
