import { RuleBasedPricingEngine } from "./rule-based-engine";

import type { PricingEngine } from "./types";

export * from "./types";
export { RuleBasedPricingEngine } from "./rule-based-engine";

let engine: PricingEngine | null = null;

/** Punto único de resolución. Sustituir aquí para cambiar de algoritmo. */
export function getPricingEngine(): PricingEngine {
  engine ??= new RuleBasedPricingEngine();
  return engine;
}

/** Solo para pruebas. */
export function setPricingEngine(next: PricingEngine | null): void {
  engine = next;
}
