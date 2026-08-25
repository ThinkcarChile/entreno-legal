/**
 * FoodStorageSafetyEngine — `storage-safety/1.0.0`.
 *
 * Determinista y versionado. La ÚNICA fuente son reglas validadas con fuente
 * explícita (`storage_safety_rules`). Sin regla que calce → SAFETY_REVIEW_REQUIRED:
 * UNKNOWN jamás es SAFE (§21), el vacío no alarga nada por sí solo (§22), y
 * recongelar no se aprueba ni se prohíbe universalmente (§25) — depende de
 * una regla que describa CÓMO se descongeló.
 */

import { addDays } from "@/domain/nutrition/calendar";
import type {
  LotFacts,
  RefreezeVerdict,
  SafetyRule,
  SafetyVerdict,
  ThawPlan,
} from "./types";

export const STORAGE_SAFETY_VERSION = "storage-safety/1.0.0";

/**
 * ¿La regla aplica a estos hechos? Cada condición NO nula debe calzar EXACTO.
 * El ámbito del alimento: regla de ingrediente exige ese ingrediente; de
 * categoría, esa categoría; sin ámbito, aplica a cualquiera.
 */
function matches(rule: SafetyRule, facts: LotFacts): boolean {
  if (rule.ingredientId != null && rule.ingredientId !== facts.ingredientId) return false;
  if (rule.categoryId != null && rule.categoryId !== facts.categoryId) return false;
  if (rule.processingState != null && rule.processingState !== facts.processingState) return false;
  if (rule.temperatureState != null && rule.temperatureState !== facts.temperatureState) return false;
  if (rule.vacuumSealed != null && rule.vacuumSealed !== facts.vacuumSealed) return false;
  return true;
}

/**
 * Especificidad: hogar > global; ingrediente > categoría > genérica; y cada
 * condición extra especificada suma. Empate → la MÁS restrictiva (menos días;
 * maxDays null = sin fecha = la menos restrictiva), luego id (determinismo).
 */
function specificity(rule: SafetyRule): number {
  return (
    (rule.isHousehold ? 32 : 0) +
    (rule.ingredientId != null ? 16 : 0) +
    (rule.categoryId != null ? 8 : 0) +
    (rule.processingState != null ? 4 : 0) +
    (rule.temperatureState != null ? 2 : 0) +
    (rule.vacuumSealed != null ? 1 : 0)
  );
}

function pickBest(candidates: SafetyRule[]): SafetyRule | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const s = specificity(b) - specificity(a);
    if (s !== 0) return s;
    const da = a.maxDays ?? Number.MAX_SAFE_INTEGER;
    const db = b.maxDays ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  })[0]!;
}

/** ¿Cuánto dura ESTE lote en ESTE estado? Solo con regla; si no, revisar. */
export function assessStorage(
  facts: LotFacts,
  rules: SafetyRule[],
  today: string,
): SafetyVerdict {
  const rule = pickBest(rules.filter((r) => r.ruleKind === "STORAGE_DAYS" && matches(r, facts)));
  if (!rule) {
    return {
      verdict: "SAFETY_REVIEW_REQUIRED",
      reason: `sin regla validada para ${facts.processingState}/${facts.temperatureState}${facts.vacuumSealed ? " sellado al vacío" : ""}: revisa antes de decidir`,
    };
  }
  if (rule.maxDays == null) {
    // Regla EXPLÍCITA de "seguro sin fecha" (p. ej. congelado a -18°C).
    return { verdict: "SAFE", safeUseBy: null, source: rule.source, ruleId: rule.id };
  }
  const safeUseBy = addDays(facts.storedSince, rule.maxDays);
  if (today > safeUseBy) {
    return { verdict: "DO_NOT_RECOMMEND", safeUseBy, source: rule.source, ruleId: rule.id };
  }
  if (today >= addDays(safeUseBy, -rule.useSoonWithinDays)) {
    return { verdict: "USE_SOON", safeUseBy, source: rule.source, ruleId: rule.id };
  }
  return { verdict: "SAFE", safeUseBy, source: rule.source, ruleId: rule.id };
}

/**
 * ¿Guardar prep para una fecha prevista: refrigerar o congelar? (§23)
 * Refrigerar solo si la regla CHILLED cubre hasta la fecha; si no, congelar
 * solo si hay regla FROZEN que lo respalde. Sin reglas → REVIEW_REQUIRED.
 */
export function recommendStorage(
  facts: Omit<LotFacts, "temperatureState">,
  intendedUseDate: string | null,
  rules: SafetyRule[],
  today: string,
): { storage: "REFRIGERATE" | "FREEZE" | "REVIEW_REQUIRED"; source: string | null; reason: string } {
  const chilled = assessStorage({ ...facts, temperatureState: "CHILLED" }, rules, today);
  const frozen = assessStorage({ ...facts, temperatureState: "FROZEN" }, rules, today);

  // Sin uso previsto (reserva): congelar con respaldo gana sobre una ventana
  // refrigerada CORTA — la reserva no tiene fecha y la ventana sí.
  if (
    intendedUseDate == null &&
    (frozen.verdict === "SAFE" || frozen.verdict === "USE_SOON") &&
    !("safeUseBy" in chilled && chilled.safeUseBy == null)
  ) {
    return {
      storage: "FREEZE",
      source: frozen.source,
      reason: `sin uso previsto cercano: congelar (${frozen.source})`,
    };
  }

  if (chilled.verdict !== "SAFETY_REVIEW_REQUIRED") {
    const cubre =
      "safeUseBy" in chilled &&
      (chilled.safeUseBy == null || intendedUseDate == null || intendedUseDate <= chilled.safeUseBy);
    if (cubre && chilled.verdict !== "DO_NOT_RECOMMEND") {
      return {
        storage: "REFRIGERATE",
        source: chilled.source,
        reason: intendedUseDate
          ? `se usa el ${intendedUseDate}, dentro de la ventana refrigerada (${chilled.source})`
          : `dentro de la ventana refrigerada (${chilled.source})`,
      };
    }
  }
  if (frozen.verdict === "SAFE" || frozen.verdict === "USE_SOON") {
    return {
      storage: "FREEZE",
      source: frozen.source,
      reason: intendedUseDate
        ? `el uso (${intendedUseDate}) queda fuera de la ventana refrigerada: congelar (${frozen.source})`
        : `sin uso previsto cercano: congelar (${frozen.source})`,
    };
  }
  return {
    storage: "REVIEW_REQUIRED",
    source: null,
    reason: "sin regla validada que respalde refrigerar ni congelar: decide tú (no inventamos seguridad)",
  };
}

/**
 * Recongelar (§24-§25): jamás una regla global inventada. Solo si sabemos que
 * se descongeló de una forma cubierta por una regla (v1: en refrigerador).
 */
export function assessRefreeze(
  facts: LotFacts,
  thawedInFridge: boolean | null,
  rules: SafetyRule[],
): RefreezeVerdict {
  if (thawedInFridge !== true) {
    return {
      verdict: "SAFETY_REVIEW_REQUIRED",
      reason: "no sabemos cómo se descongeló: sin ese dato no se recomienda recongelar",
    };
  }
  const rule = pickBest(rules.filter((r) => r.ruleKind === "REFREEZE" && matches(r, facts)));
  if (!rule || rule.refreezeAllowed == null) {
    return {
      verdict: "SAFETY_REVIEW_REQUIRED",
      reason: "sin regla validada de recongelado para este caso",
    };
  }
  return rule.refreezeAllowed
    ? { verdict: "ALLOWED", source: rule.source, ruleId: rule.id }
    : { verdict: "DO_NOT_RECOMMEND", source: rule.source, ruleId: rule.id };
}

/**
 * Descongelado programado (§29): la fecha del traslado SOLO nace de una regla
 * THAW; sin regla, "revisar descongelado" — jamás una hora inventada.
 */
export function planThaw(
  facts: LotFacts,
  intendedUseDate: string,
  rules: SafetyRule[],
): ThawPlan {
  const rule = pickBest(rules.filter((r) => r.ruleKind === "THAW" && matches(r, facts)));
  if (!rule || rule.thawFridgeHours == null) {
    return { kind: "REVIEW", reason: "sin regla validada de descongelado: revísalo tú" };
  }
  const dias = Math.max(1, Math.ceil(rule.thawFridgeHours / 24));
  const moveDate = addDays(intendedUseDate, -dias);
  return {
    kind: "SCHEDULED",
    moveDate,
    note: `pasar del congelador al refrigerador el ${moveDate} (≈${rule.thawFridgeHours} h antes)`,
    source: rule.source,
  };
}
