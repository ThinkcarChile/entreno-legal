/**
 * BatchPrepEngine — `batch-prep/1.0.0`.
 *
 * Toma compra recibida + lotes + plan confirmado + equipamiento y responde
 * "¿qué conviene preparar AHORA?" — y también "¿qué conviene NO tocar?" (§2).
 *
 * Reglas duras:
 *  - Determinista, sin reloj propio, sin IA. Generar el plan NO toca el
 *    ledger (§17): esto es una sugerencia estructurada.
 *  - La demanda que guía es la CONFIRMADA (porciones PLANNED futuras); sin
 *    planificación suficiente no se inventan porciones (§8) ni se
 *    sobreprepara (§9): preparar X, dejar Y, con razón.
 *  - Cortes SOLO desde preferencias declaradas por el hogar; el equipamiento
 *    nunca es requisito — la alternativa manual siempre existe (§11-§12).
 *  - Refrigerar/congelar SOLO con regla de seguridad validada; si no,
 *    REVIEW_REQUIRED (§23). El descongelado programado igual (§29).
 *  - FEFO (§52): el lote que vence primero se prepara primero.
 *  - Agrupar para minimizar cambios de herramienta (§13, §56) manteniendo
 *    dependencias (§14).
 */

import { addDays } from "@/domain/nutrition/calendar";
import { planThaw, recommendStorage } from "./safety";
import type {
  DraftTask,
  LeaveWholeNote,
  PrepDemand,
  PrepEngineInput,
  PrepLot,
  PrepPlanDraft,
  PrepPreference,
  SuggestedPackage,
  ThawSuggestion,
} from "./types";

export const BATCH_PREP_VERSION = "batch-prep/1.0.0";

/** Minutos estimados por tipo de tarea: constantes deterministas, no IA. */
const MINUTOS: Record<string, number> = {
  WASH: 3, PEEL: 4, TRIM: 3, CUT: 5, SHRED: 4, SLICE: 4, DICE: 5,
  PORTION: 5, PACK: 2, VACUUM_SEAL: 2, REFRIGERATE: 1, FREEZE: 2,
  THAW_LATER: 1, LEAVE_WHOLE: 0, LABEL: 1, OTHER: 3,
};

/** Orden de bloques (§13): lavar → cortar → porcionar → sellar → guardar → etiquetar. */
const BLOQUE: Record<string, [number, string]> = {
  WASH: [1, "Lavar"], PEEL: [2, "Cortar"], TRIM: [2, "Cortar"], CUT: [2, "Cortar"],
  SHRED: [2, "Cortar"], SLICE: [2, "Cortar"], DICE: [2, "Cortar"],
  PORTION: [3, "Porcionar"], PACK: [3, "Porcionar"], VACUUM_SEAL: [4, "Sellar"],
  REFRIGERATE: [5, "Guardar"], FREEZE: [5, "Guardar"], THAW_LATER: [5, "Guardar"],
  LEAVE_WHOLE: [5, "Guardar"], LABEL: [6, "Etiquetar"], OTHER: [6, "Etiquetar"],
};

const redondear = (n: number) => Math.round(n * 1000) / 1000;

/** FEFO (§52): primero lo que hay que usar primero. */
export function fefoOrder(lots: PrepLot[]): PrepLot[] {
  return [...lots].sort((a, b) => {
    const fa = a.useBy ?? a.expiryDate ?? "9999-12-31";
    const fb = b.useBy ?? b.expiryDate ?? "9999-12-31";
    return fa.localeCompare(fb) || a.createdOn.localeCompare(b.createdOn) || a.id.localeCompare(b.id);
  });
}

interface TaskChain {
  tasks: DraftTask[];
  /** Clave de herramienta del corte, para agrupar (§13). */
  toolKey: string | null;
}

export function planPrep(input: PrepEngineInput): PrepPlanDraft {
  const horizon = input.horizonDays > 0 ? input.horizonDays : 7;
  const hasta = addDays(input.today, horizon);

  const capById = new Map(input.capabilities.map((c) => [c.id, c]));
  const prefsPorIngrediente = new Map<string, PrepPreference[]>();
  for (const p of input.preferences) {
    const arr = prefsPorIngrediente.get(p.ingredientId) ?? [];
    arr.push(p);
    prefsPorIngrediente.set(p.ingredientId, arr);
  }

  // Demanda confirmada dentro del horizonte, por alimento::unidad.
  const demandaPor = new Map<string, PrepDemand[]>();
  for (const d of input.demand) {
    if (d.date < input.today || d.date > hasta) continue;
    const key = `${d.ingredientId}::${d.unit}`;
    const arr = demandaPor.get(key) ?? [];
    arr.push(d);
    demandaPor.set(key, arr);
  }

  // Lotes preparables: disponibles, crudos, no congelados (lo congelado no se
  // porciona sin descongelar — para eso están las sugerencias de descongelado).
  const lotesPor = new Map<string, PrepLot[]>();
  for (const l of input.lots) {
    if (l.quantity <= 0 || l.processingState === "COOKED") continue;
    const key = `${l.ingredientId}::${l.unit}`;
    const arr = lotesPor.get(key) ?? [];
    arr.push(l);
    lotesPor.set(key, arr);
  }

  const chains: TaskChain[] = [];
  const leaveWhole: LeaveWholeNote[] = [];
  const thawSuggestions: ThawSuggestion[] = [];

  const claves = [...new Set([...demandaPor.keys()])].sort();
  for (const clave of claves) {
    const demandas = (demandaPor.get(clave) ?? []).sort(
      (a, b) => a.date.localeCompare(b.date) || a.assignmentId.localeCompare(b.assignmentId),
    );
    if (demandas.length === 0) continue;
    const lotes = fefoOrder((lotesPor.get(clave) ?? []).filter((l) => l.temperatureState !== "FROZEN"));
    const congelados = fefoOrder((lotesPor.get(clave) ?? []).filter((l) => l.temperatureState === "FROZEN"));

    // §29: lo congelado previsto para una comida genera sugerencia de
    // descongelado (con hora SOLO si hay regla).
    for (const lote of congelados) {
      const uso = lote.intendedUseDate ?? demandas[0]?.date ?? null;
      if (uso == null) continue;
      thawSuggestions.push({
        lotId: lote.id,
        label: lote.label,
        intendedUseDate: uso,
        plan: planThaw(
          {
            ingredientId: lote.ingredientId,
            categoryId: lote.categoryId,
            processingState: lote.processingState,
            temperatureState: "FROZEN",
            vacuumSealed: lote.vacuumSealed,
            storedSince: lote.createdOn,
          },
          uso,
          input.safetyRules,
        ),
      });
    }

    const totalDemanda = redondear(demandas.reduce((acc, d) => acc + d.quantity, 0));
    const disponible = redondear(lotes.reduce((acc, l) => acc + l.quantity, 0));
    if (disponible <= 0) continue;

    // Dos flujos con políticas distintas — los dos ejemplos del director:
    //  - CON corte declarado (§2/§9, tomate/zanahoria): cortar degrada la
    //    conservación → preparar SOLO lo demandado; el resto queda ENTERO.
    //  - SIN corte (§8/§42, pollo): porcionar es empaque, no degradación →
    //    el lote abierto se porciona COMPLETO: usos confirmados + reserva.
    const prefsIng = prefsPorIngrediente.get(demandas[0]!.ingredientId) ?? [];
    const tieneCorte = prefsIng.some((p) =>
      ["CUT", "SHRED", "SLICE", "DICE", "PEEL", "TRIM"].includes(p.taskType),
    );

    const aPreparar = tieneCorte ? Math.min(totalDemanda, disponible) : disponible;
    const primero = lotes[0]!;
    if (tieneCorte) {
      const dejar = redondear(disponible - aPreparar);
      if (dejar > 0.001) {
        leaveWhole.push({
          ingredientId: primero.ingredientId,
          label: primero.label,
          quantity: dejar,
          unit: primero.unit,
          reason: `la demanda confirmada de los próximos ${horizon} días es ${totalDemanda} ${primero.unit}: el resto se conserva mejor sin preparar`,
        });
      }
    }
    if (aPreparar <= 0.001) continue;

    // Repartir la preparación entre lotes FEFO. Sin corte, solo se abren los
    // lotes necesarios para cubrir la demanda (el que se abre, entero).
    let porCubrir = tieneCorte ? aPreparar : totalDemanda;
    let demandaRestante = [...demandas];
    for (const lote of lotes) {
      if (porCubrir <= 0.001) break;
      const deEste = tieneCorte
        ? redondear(Math.min(lote.quantity, porCubrir))
        : lote.quantity; // §8: el lote abierto se porciona completo
      porCubrir = redondear(Math.max(0, porCubrir - deEste));

      const prefs = prefsPorIngrediente.get(lote.ingredientId) ?? [];
      const chain: DraftTask[] = [];
      let toolKey: string | null = null;

      // Lavar solo si el hogar lo declaró para este alimento.
      const wash = prefs.find((p) => p.taskType === "WASH");
      if (wash) {
        chain.push({
          taskType: "WASH",
          blockLabel: "Lavar",
          lotId: lote.id,
          ingredientId: lote.ingredientId,
          label: `Lavar ${lote.label}`,
          plannedQuantity: deEste,
          unit: lote.unit,
          dependsOnIndex: null,
          params: { reasons: ["preferencia del hogar"] },
        });
      }

      // Corte declarado por el hogar (§11): capability con params, o manual.
      const corte = prefs.find((p) =>
        ["CUT", "SHRED", "SLICE", "DICE", "PEEL", "TRIM"].includes(p.taskType),
      );
      if (corte) {
        const cap = corte.capabilityId ? capById.get(corte.capabilityId) : undefined;
        const capActiva = cap && cap.isActive && cap.equipmentActive ? cap : undefined;
        const sizeMm = (corte.params as { size_mm?: number }).size_mm;
        const cutLabel = `${corte.taskType}${sizeMm ? ` ${sizeMm} mm` : ""}`;
        // §53: capacidad por tanda del equipo.
        const batches =
          capActiva?.maxBatchQuantity != null && deEste > capActiva.maxBatchQuantity
            ? Math.ceil(deEste / capActiva.maxBatchQuantity)
            : undefined;
        toolKey = capActiva ? `${capActiva.equipmentId}::${capActiva.capability}::${JSON.stringify(capActiva.params)}` : null;
        chain.push({
          taskType: corte.taskType as DraftTask["taskType"],
          blockLabel: "Cortar",
          lotId: lote.id,
          ingredientId: lote.ingredientId,
          label: `${etiquetaCorte(corte.taskType)} ${lote.label}`,
          plannedQuantity: deEste,
          unit: lote.unit,
          dependsOnIndex: null,
          params: {
            capabilityId: capActiva?.id ?? null,
            equipmentName: capActiva?.equipmentName ?? null,
            cutLabel,
            // §12/§86: la alternativa manual SIEMPRE viaja con la tarea.
            manualAlternative:
              corte.manualAlternative ??
              (capActiva ? null : "hacerlo a mano (el equipo configurado no está disponible)"),
            ...(batches ? { batches } : {}),
            reasons: capActiva
              ? [`equipo: ${capActiva.equipmentName} (${cutLabel})`]
              : ["sin equipo activo para este corte: alternativa manual"],
          },
        });
      }

      // §8: porcionar por usos confirmados + reserva del sobrante del lote.
      const paquetes: SuggestedPackage[] = [];
      let restoLote = deEste;
      const sinAsignar: PrepDemand[] = [];
      for (const d of demandaRestante) {
        if (restoLote <= 0.001) {
          sinAsignar.push(d);
          continue;
        }
        const q = redondear(Math.min(d.quantity, restoLote));
        restoLote = redondear(restoLote - q);
        const storage = recommendStorage(
          {
            ingredientId: lote.ingredientId,
            categoryId: lote.categoryId,
            processingState: "PREPPED",
            vacuumSealed: lote.vacuumSealed,
            storedSince: input.today,
          },
          d.date,
          input.safetyRules,
          input.today,
        );
        paquetes.push({
          quantity: q,
          intendedUseDate: d.date,
          intendedAssignmentId: d.assignmentId,
          mealType: d.mealType,
          storage: storage.storage,
          storageSource: storage.source,
          reason: storage.reason,
        });
      }
      demandaRestante = sinAsignar;
      // El resto del lote YA preparado queda como reserva sin asignar (§8).
      if (restoLote > 0.001 && paquetes.length > 0) {
        const storage = recommendStorage(
          {
            ingredientId: lote.ingredientId,
            categoryId: lote.categoryId,
            processingState: "PREPPED",
            vacuumSealed: lote.vacuumSealed,
            storedSince: input.today,
          },
          null,
          input.safetyRules,
          input.today,
        );
        paquetes.push({
          quantity: restoLote,
          intendedUseDate: null,
          intendedAssignmentId: null,
          mealType: null,
          storage: storage.storage,
          storageSource: storage.source,
          reason: `reserva sin asignar — ${storage.reason}`,
        });
      }

      if (paquetes.length > 1) {
        const idxCorte = chain.length; // depende del último paso previo (si hay)
        chain.push({
          taskType: "PORTION",
          blockLabel: "Porcionar",
          lotId: lote.id,
          ingredientId: lote.ingredientId,
          label: `Porcionar ${lote.label} en ${paquetes.length} paquetes`,
          plannedQuantity: deEste,
          unit: lote.unit,
          dependsOnIndex: null,
          params: {
            packages: paquetes,
            reasons: paquetes.map(
              (p) =>
                `${p.quantity} ${lote.unit}${p.intendedUseDate ? ` → ${p.intendedUseDate}` : " → reserva"} (${p.storage === "REVIEW_REQUIRED" ? "revisar guardado" : p.storage === "FREEZE" ? "congelar" : "refrigerar"})`,
            ),
          },
        });
        void idxCorte;
        chain.push({
          taskType: "LABEL",
          blockLabel: "Etiquetar",
          lotId: lote.id,
          ingredientId: lote.ingredientId,
          label: `Etiquetar los paquetes de ${lote.label}`,
          plannedQuantity: null,
          unit: null,
          dependsOnIndex: null,
          params: { reasons: [`${paquetes.length} etiquetas`] },
        });
      } else if (paquetes.length === 1) {
        // Un solo uso: guardar directo según la recomendación (con regla).
        const p = paquetes[0]!;
        if (p.storage === "REFRIGERATE" || p.storage === "FREEZE") {
          chain.push({
            taskType: p.storage === "FREEZE" ? "FREEZE" : "REFRIGERATE",
            blockLabel: "Guardar",
            lotId: lote.id,
            ingredientId: lote.ingredientId,
            label: `${p.storage === "FREEZE" ? "Congelar" : "Refrigerar"} ${lote.label}`,
            plannedQuantity: deEste,
            unit: lote.unit,
            dependsOnIndex: null,
            params: { safety: { verdict: p.storage, source: p.storageSource }, reasons: [p.reason] },
          });
        } else {
          chain.push({
            taskType: "OTHER",
            blockLabel: "Guardar",
            lotId: lote.id,
            ingredientId: lote.ingredientId,
            label: `Decidir guardado de ${lote.label} (sin regla de seguridad)`,
            plannedQuantity: deEste,
            unit: lote.unit,
            dependsOnIndex: null,
            params: { safety: { verdict: "REVIEW_REQUIRED" }, reasons: [p.reason] },
          });
        }
      }

      if (chain.length > 0) chains.push({ tasks: chain, toolKey });
    }
  }

  // ---- Orden final (§13, §56): por bloque, y dentro del bloque de corte por
  // herramienta (mismo equipo/cuchilla juntos = menos cambios). Las cadenas
  // conservan su orden interno (dependencias §14).
  const ordered: { task: DraftTask; chainIdx: number; posInChain: number; toolKey: string | null }[] = [];
  chains.forEach((chain, ci) =>
    chain.tasks.forEach((t, pi) => ordered.push({ task: t, chainIdx: ci, posInChain: pi, toolKey: chain.toolKey })),
  );
  ordered.sort((a, b) => {
    const ba = BLOQUE[a.task.taskType]![0];
    const bb = BLOQUE[b.task.taskType]![0];
    if (ba !== bb) return ba - bb;
    // Dentro del corte: agrupar por herramienta (cambios de cuchilla mínimos).
    const ta = a.toolKey ?? "~manual";
    const tb = b.toolKey ?? "~manual";
    if (ba === 2 && ta !== tb) return ta.localeCompare(tb);
    return a.chainIdx - b.chainIdx || a.posInChain - b.posInChain;
  });

  // Resolver dependencias: cada tarea depende de la ANTERIOR de su cadena.
  const indexOf = new Map<string, number>(); // chainIdx:posInChain → índice 1-based final
  ordered.forEach((o, i) => indexOf.set(`${o.chainIdx}:${o.posInChain}`, i + 1));
  const tasks: DraftTask[] = ordered.map((o) => ({
    ...o.task,
    dependsOnIndex: o.posInChain > 0 ? indexOf.get(`${o.chainIdx}:${o.posInChain - 1}`) ?? null : null,
  }));

  // ---- Complejidad (§55) y resumen: deterministas.
  const cortes = ordered.filter((o) => BLOQUE[o.task.taskType]![0] === 2);
  let cambiosHerramienta = 0;
  for (let i = 1; i < cortes.length; i++) {
    if ((cortes[i]!.toolKey ?? "~") !== (cortes[i - 1]!.toolKey ?? "~")) cambiosHerramienta++;
  }
  const paquetesTotal = tasks
    .filter((t) => t.taskType === "PORTION")
    .reduce((acc, t) => acc + (t.params.packages?.length ?? 0), 0);
  const etiquetas = paquetesTotal;
  const foods = new Set(tasks.map((t) => t.ingredientId).filter(Boolean)).size;
  const cortesDistintos = new Set(cortes.map((o) => o.task.params.cutLabel ?? o.task.taskType)).size;
  const complexity = tasks.length + cambiosHerramienta * 2 + cortesDistintos + paquetesTotal;
  const estimatedMinutes = tasks.reduce((acc, t) => acc + (MINUTOS[t.taskType] ?? 3), 0);

  // §54: capacidad del congelador — solo si se CONOCE; jamás inventada.
  const warnings: string[] = [];
  if (input.freezerCapacityKnown != null) {
    const aCongelar = redondear(
      tasks.reduce((acc, t) => {
        if (t.taskType === "FREEZE") return acc + (t.plannedQuantity ?? 0);
        if (t.taskType === "PORTION") {
          return (
            acc +
            (t.params.packages ?? [])
              .filter((p) => p.storage === "FREEZE")
              .reduce((a, p) => a + p.quantity, 0)
          );
        }
        return acc;
      }, 0),
    );
    if (aCongelar > input.freezerCapacityKnown + 0.001) {
      warnings.push(
        `el plan sugiere congelar ${aCongelar} pero la capacidad conocida del congelador es ${input.freezerCapacityKnown}: revisa qué congelar primero`,
      );
    }
  }

  return {
    tasks,
    leaveWhole,
    thawSuggestions,
    warnings,
    summary: {
      totalTasks: tasks.length,
      foods,
      packages: paquetesTotal,
      labels: etiquetas,
      estimatedMinutes,
    },
    complexity,
    engineVersion: BATCH_PREP_VERSION,
  };
}

function etiquetaCorte(t: string): string {
  return (
    {
      CUT: "Cortar", SHRED: "Rallar", SLICE: "Laminar", DICE: "Cubetear",
      PEEL: "Pelar", TRIM: "Despuntar",
    }[t] ?? "Preparar"
  );
}
