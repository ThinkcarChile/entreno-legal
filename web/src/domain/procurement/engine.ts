/**
 * PurchaseScheduleEngine — `purchase-schedule/1.0.0`.
 *
 * Determinista y versionado: mismos insumos → mismo resultado, byte a byte.
 * Sin IA en el número, sin reloj propio (el "hoy" viene del día del hogar),
 * sin conversiones inventadas (una presentación en otra unidad o en otra
 * BASE FÍSICA no sirve: el atún escurrido no se pide como pollo crudo).
 *
 * Reglas duras:
 *  - En camino NUNCA es stock físico (§15): se muestra aparte y NETEA la
 *    necesidad, jamás se suma a "en casa". El neteo respeta la base física
 *    Y avisa si la orden que netea viene atrasada — cubrir un quiebre con
 *    mercadería fantasma sería falsificar la despensa.
 *  - La lista de compras semanal también netea: la misma necesidad no se pide
 *    al proveedor Y se compra en el supermercado.
 *  - required ≠ suggested (§17): la necesidad se conserva; el mínimo/múltiplo/
 *    envase solo mueven lo SUGERIDO, con cada paso explicado. El invariante
 *    sugerido = envases × tamaño se mantiene o se declara roto con aviso.
 *  - Capacidad: se respeta cuando se CONOCE; ausente = sin tope (§16).
 *  - v1 de proveedores (§18): preferido de la política o el de mejor prioridad;
 *    los demás se listan como alternativa. Sin optimización combinatoria.
 */

import type {
  ExistingOrderItem,
  IsoWeekday,
  ProcurementNeed,
  ProvenanceStep,
  PurchasePolicy,
  PurchaseScheduleInput,
  PurchaseScheduleResult,
  PurchaseSuggestion,
  SupplierProduct,
} from "./types";
import { INCOMING_STATUSES } from "./types";
import { addDays } from "@/domain/nutrition/calendar";

export const PURCHASE_SCHEDULE_VERSION = "purchase-schedule/1.0.0";

/** Cuántos días DESPUÉS del lead time buscamos una fecha de entrega válida. */
const MAX_SCHEDULING_WINDOW = 35;
const EPS = 1e-9;

const DIA_NOMBRE: Record<IsoWeekday, string> = {
  1: "lunes",
  2: "martes",
  3: "miércoles",
  4: "jueves",
  5: "viernes",
  6: "sábado",
  7: "domingo",
};

/** Día ISO (1=lunes…7=domingo) de una fecha YYYY-MM-DD, sin zona local. */
export function isoWeekday(date: string): IsoWeekday {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=domingo
  return (js === 0 ? 7 : js) as IsoWeekday;
}

export { addDays };

function redondear(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** ¿q es múltiplo (con tolerancia flotante) de m? */
function esMultiplo(q: number, m: number): boolean {
  const resto = q % m;
  return resto < 1e-6 || m - resto < 1e-6;
}

/**
 * Elige la presentación de proveedor para un alimento+base (§18, v1):
 * 1) la del proveedor PREFERIDO de la política, si existe activa, en la unidad
 *    y en la base física de la necesidad;
 * 2) si no, la activa de mejor prioridad (menor número; empate → nombre).
 * Otra unidad U otra base física NO participan: sin conversiones inventadas.
 */
export function chooseSupplierProduct(
  products: SupplierProduct[],
  need: ProcurementNeed,
  policy: PurchasePolicy | null,
): {
  chosen: SupplierProduct | null;
  alternatives: SupplierProduct[];
  wrongUnit: SupplierProduct[];
  wrongBasis: SupplierProduct[];
} {
  const delIngrediente = products.filter(
    (p) => p.ingredientId === need.ingredientId && p.isActive && p.supplierActive,
  );
  const usables = delIngrediente
    .filter((p) => p.unit === need.unit && p.weightBasis === need.weightBasis)
    .sort((a, b) => a.priority - b.priority || a.supplierName.localeCompare(b.supplierName));
  const wrongUnit = delIngrediente.filter((p) => p.unit !== need.unit);
  const wrongBasis = delIngrediente.filter(
    (p) => p.unit === need.unit && p.weightBasis !== need.weightBasis,
  );

  if (usables.length === 0) return { chosen: null, alternatives: [], wrongUnit, wrongBasis };

  const preferida = policy?.preferredSupplierId
    ? usables.find((p) => p.supplierId === policy.preferredSupplierId) ?? null
    : null;
  const chosen = preferida ?? usables[0]!;
  return { chosen, alternatives: usables.filter((p) => p.id !== chosen.id), wrongUnit, wrongBasis };
}

/**
 * Fechas de pedido/entrega (§12). Busca la entrega válida MÁS TEMPRANA desde
 * hoy: debe caer en un día de entrega del proveedor Y de recepción del hogar,
 * y el pedido (entrega − lead time) debe caer hoy o después, en un día de
 * pedido permitido — si el día exacto no está permitido, el pedido se adelanta
 * al último día permitido posible (pedir antes nunca atrasa una entrega).
 */
export function scheduleDates(
  today: string,
  product: SupplierProduct,
  policy: PurchasePolicy | null,
): { orderDate: string; deliveryDate: string } | { error: string } {
  const entregaOk = (d: string) => {
    const wd = isoWeekday(d);
    if (product.deliveryDays && !product.deliveryDays.includes(wd)) return false;
    if (policy?.receiveDays && !policy.receiveDays.includes(wd)) return false;
    return true;
  };
  const pedidoOk = (d: string) => !policy?.orderDays || policy.orderDays.includes(isoWeekday(d));

  // La ventana se cuenta DESPUÉS del lead time: un proveedor con 40 días de
  // espera no debe caer al error por una ventana fija más corta que su espera.
  for (let i = product.leadTimeDays; i <= product.leadTimeDays + MAX_SCHEDULING_WINDOW; i++) {
    const delivery = addDays(today, i);
    if (!entregaOk(delivery)) continue;

    // Último día posible para pedir y alcanzar esta entrega.
    const limite = addDays(delivery, -product.leadTimeDays);
    // Pedir el día más tardío permitido dentro de [hoy, límite]: menos
    // anticipación = pronóstico más fresco al momento de pedir.
    for (let j = 0; ; j++) {
      const candidato = addDays(limite, -j);
      if (candidato < today) break;
      if (pedidoOk(candidato)) return { orderDate: candidato, deliveryDate: delivery };
    }
  }
  return {
    error:
      "no hay combinación válida de día de pedido y día de entrega en las próximas 5 semanas: revisa el calendario del proveedor o la política",
  };
}

/**
 * Cantidad sugerida (§17): parte de la necesidad neta y aplica, en orden y
 * cada paso con su explicación: envase → pedido mínimo → múltiplo → capacidad.
 *
 * Invariante: sugerido = envases × tamaño del envase. Si el múltiplo del
 * proveedor no calza con envases enteros, se busca la menor cantidad que
 * cumpla AMBOS; si no existe (dentro de un límite razonable), se declara con
 * aviso en vez de entregar un par cantidad/envases contradictorio.
 */
export function suggestQuantity(
  required: number,
  product: SupplierProduct,
  capacityRoom: number | null,
): { quantity: number; packageCount: number | null; steps: ProvenanceStep[]; warnings: string[] } {
  const steps: ProvenanceStep[] = [];
  const warnings: string[] = [];
  const pkg = product.packageQuantity;
  const moq = product.minimumOrderQuantity;
  const multiple = product.purchaseMultiple;

  // ¿count envases cumplen mínimo y múltiplo?
  const cumple = (count: number) => {
    const q = count * pkg;
    if (moq != null && q < moq - EPS) return false;
    if (multiple != null && !esMultiplo(q, multiple)) return false;
    return true;
  };

  // Buscar el MENOR número de envases ≥ base que cumpla todo (acotado).
  const base = Math.max(1, Math.ceil(required / pkg - EPS));
  let count: number | null = null;
  for (let c = base; c <= base + 1000; c++) {
    if (cumple(c)) {
      count = c;
      break;
    }
  }

  if (count === null) {
    // El múltiplo no calza con envases enteros en ningún punto razonable:
    // se respeta el múltiplo (es lo que el proveedor acepta) y se declara.
    let qty = Math.max(required, moq ?? 0);
    if (multiple != null) qty = Math.ceil(qty / multiple - EPS) * multiple;
    warnings.push(
      `el múltiplo de compra (${multiple}) no calza con envases enteros de ${pkg}: confirma con el proveedor cómo se despacha`,
    );
    return { quantity: redondear(qty), packageCount: null, steps, warnings };
  }

  let qty = count * pkg;
  // Qué restricción empujó cada subida, en orden, con sus números:
  if (redondear(base * pkg) !== redondear(required)) {
    steps.push({
      step: "envase",
      detail: `se vende por "${product.presentation}" (${pkg}): ${base} × ${pkg} = ${redondear(base * pkg)}`,
    });
  }
  const trasMinimo = moq != null ? Math.max(base, Math.ceil(moq / pkg - EPS)) : base;
  if (trasMinimo > base) {
    steps.push({
      step: "pedido mínimo",
      detail: `el proveedor exige mínimo ${moq}: sube a ${redondear(trasMinimo * pkg)}`,
    });
  }
  if (count > trasMinimo) {
    steps.push({
      step: "múltiplo",
      detail: `se pide en múltiplos de ${multiple}: sube a ${redondear(qty)}`,
    });
  }

  // Capacidad: SOLO si se conoce (§16). Recorte hacia abajo en envases enteros
  // que SIGAN cumpliendo el múltiplo del proveedor.
  if (capacityRoom != null && qty > capacityRoom + EPS) {
    let recorte: number | null = null;
    for (let c = Math.floor((capacityRoom + EPS) / pkg); c >= 1; c--) {
      const q = c * pkg;
      if (multiple != null && !esMultiplo(q, multiple)) continue;
      if (moq != null && q < moq - EPS) break; // más abajo tampoco cumplirá el mínimo
      recorte = c;
      break;
    }
    if (recorte != null) {
      qty = recorte * pkg;
      count = recorte;
      steps.push({
        step: "capacidad",
        detail: `espacio disponible ${redondear(capacityRoom)}: se recorta a ${redondear(qty)}`,
      });
      warnings.push("la cantidad se recortó por capacidad de almacenamiento: quedará bajo el objetivo");
    } else {
      warnings.push(
        `el pedido mínimo del proveedor (${redondear(qty)}) no cabe en el espacio disponible (${redondear(capacityRoom)}): revisa la capacidad o busca otra presentación`,
      );
    }
  }

  return { quantity: redondear(qty), packageCount: count, steps, warnings };
}

function claveDe(ingredientId: string, unit: string, weightBasis: string): string {
  return `${ingredientId}::${unit}::${weightBasis}`;
}

export function planPurchases(input: PurchaseScheduleInput): PurchaseScheduleResult {
  const policies = new Map(input.policies.map((p) => [p.ingredientId, p]));
  const today = input.today;

  // En camino por alimento::unidad::BASE — SOLO órdenes vivas (§14). SUGGESTED
  // no cuenta (nadie la aceptó) y RECEIVED/STORED ya son lotes en casa.
  const incomingBy = new Map<string, { total: number; items: ExistingOrderItem[] }>();
  for (const item of input.existingItems) {
    if (!INCOMING_STATUSES.includes(item.orderStatus)) continue;
    const key = claveDe(item.ingredientId, item.unit, item.weightBasis);
    const prev = incomingBy.get(key) ?? { total: 0, items: [] };
    prev.total += item.quantity;
    prev.items.push(item);
    incomingBy.set(key, prev);
  }

  // Pendiente en la lista de compras semanal, con la misma identidad.
  const listaBy = new Map<string, number>();
  for (const item of input.pendingListItems) {
    const key = claveDe(item.ingredientId, item.unit, item.weightBasis);
    listaBy.set(key, (listaBy.get(key) ?? 0) + item.quantity);
  }

  const suggestions: PurchaseSuggestion[] = [];
  const coveredByIncoming: PurchaseScheduleResult["coveredByIncoming"] = [];
  const unresolved: PurchaseScheduleResult["unresolved"] = [];

  for (const need of input.needs) {
    const rec = need.reorder;
    // §6 [U-8]: UNRESOLVED no es NO_ACTION — se declara, no se omite.
    if (rec.status === "UNRESOLVED") {
      unresolved.push({
        ingredientId: need.ingredientId,
        label: need.label,
        unit: need.unit,
        weightBasis: need.weightBasis,
        reason: "demanda confirmada en una base sin factor de conversión anotado",
      });
      continue;
    }
    if (rec.status === "NO_ACTION" || rec.recommendedQuantity == null || rec.recommendedQuantity <= 0) {
      continue;
    }

    const clave = claveDe(need.ingredientId, need.unit, need.weightBasis);
    const provenance: ProvenanceStep[] = [
      {
        step: "necesidad",
        detail: `Stock Intelligence recomienda ${redondear(rec.recommendedQuantity)} ${need.unit} (base ${need.weightBasis}, ${rec.status}, horizonte ${rec.horizonDays} días, ${rec.engineVersion})`,
      },
    ];
    const warnings: string[] = [];

    // Netear contra lo que ya viene en camino (§14): jamás doble compra.
    const incoming = incomingBy.get(clave);
    const enCamino = redondear(incoming?.total ?? 0);
    let required = rec.recommendedQuantity;
    if (enCamino > 0) {
      required = Math.max(0, required - enCamino);
      provenance.push({
        step: "en camino",
        detail: `ya vienen ${enCamino} ${need.unit} en ${incoming!.items.length} orden(es) viva(s): la necesidad neta baja a ${redondear(required)}`,
      });
      // Netear con mercadería atrasada sería cubrir un quiebre con fantasmas:
      // se sigue neteando (no pedimos doble solos) pero se AVISA fuerte.
      for (const it of incoming!.items) {
        if (it.expectedDeliveryDate != null && it.expectedDeliveryDate < today) {
          warnings.push(
            `una orden en camino está ATRASADA (llegaba el ${it.expectedDeliveryDate}): confírmala o cancélala — está descontando esta necesidad`,
          );
        } else if (it.orderStatus === "PLANNED" && it.orderDate != null && it.orderDate < today) {
          warnings.push(
            `una orden quedó PLANIFICADA y su fecha de pedido (${it.orderDate}) ya pasó: pídela o cancélala — está descontando esta necesidad`,
          );
        }
      }
    }

    // Netear contra la lista de compras semanal: la línea pendiente ES una
    // compra decidida, aunque sea en el supermercado y no con un proveedor.
    const enLista = redondear(listaBy.get(clave) ?? 0);
    if (enLista > 0 && required > 0) {
      const antes = required;
      required = Math.max(0, required - enLista);
      provenance.push({
        step: "lista de compras",
        detail: `la lista semanal ya pide ${enLista} ${need.unit} pendientes: la necesidad neta baja de ${redondear(antes)} a ${redondear(required)}`,
      });
    }
    required = redondear(required);

    if (required <= 0) {
      coveredByIncoming.push({
        ingredientId: need.ingredientId,
        label: need.label,
        unit: need.unit,
        weightBasis: need.weightBasis,
        incoming: enCamino,
        pendingInList: enLista,
        warnings,
      });
      continue;
    }

    if (rec.confidence === "LOW") {
      warnings.push("la recomendación tiene confianza BAJA: revisa la cantidad antes de aprobar");
    }

    const policy = policies.get(need.ingredientId) ?? null;
    const { chosen, alternatives, wrongUnit, wrongBasis } = chooseSupplierProduct(
      input.supplierProducts,
      need,
      policy,
    );

    if (policy?.preferredSupplierId && chosen && chosen.supplierId !== policy.preferredSupplierId) {
      warnings.push("el proveedor preferido no tiene presentación disponible: se sugiere una alternativa");
    }
    if (!chosen && wrongUnit.length > 0) {
      warnings.push(
        `hay presentaciones pero en otra unidad (${wrongUnit.map((p) => p.unit).join(", ")} vs ${need.unit}): no se convierte a ciegas`,
      );
    }
    if (!chosen && wrongBasis.length > 0) {
      warnings.push(
        `hay presentaciones pero en otra base física (${wrongBasis.map((p) => p.weightBasis).join(", ")} vs ${need.weightBasis}): no se convierte a ciegas`,
      );
    }

    // Sin proveedor: la necesidad se informa igual (bloque "Necesita acción"),
    // sin fechas ni redondeos que no se pueden calcular.
    if (!chosen) {
      suggestions.push({
        ingredientId: need.ingredientId,
        label: need.label,
        unit: need.unit,
        weightBasis: need.weightBasis,
        requiredQuantity: required,
        suggestedOrderQuantity: required,
        packageCount: null,
        supplierProductId: null,
        supplierId: null,
        supplierName: null,
        presentation: null,
        alternativeSuppliers: [],
        orderDate: null,
        expectedDeliveryDate: null,
        onHand: redondear(need.onHand),
        incoming: enCamino,
        pendingInList: enLista,
        coverageAfterDays: coberturaDespues(need, enCamino, required, 0),
        confidence: rec.confidence,
        provenance,
        warnings: [...warnings, "sin proveedor configurado para este alimento"],
        needsAction: true,
        engineVersion: PURCHASE_SCHEDULE_VERSION,
      });
      continue;
    }

    provenance.push({
      step: "proveedor",
      detail:
        policy?.preferredSupplierId === chosen.supplierId
          ? `${chosen.supplierName} (preferido por la política del hogar)`
          : `${chosen.supplierName} (prioridad ${chosen.priority}${alternatives.length ? `; alternativas: ${alternatives.map((a) => a.supplierName).join(", ")}` : ""})`,
    });

    // Capacidad conocida → espacio = tope − en casa − en camino (lo que viene
    // también ocupará lugar). Desconocida → sin tope, jamás inventada (§16).
    const capacidad = input.capacity[clave];
    const room = capacidad != null ? Math.max(0, redondear(capacidad - need.onHand - enCamino)) : null;
    if (room != null) {
      provenance.push({
        step: "capacidad",
        detail: `tope conocido ${capacidad}: en casa ${redondear(need.onHand)} + en camino ${enCamino} → espacio ${room}`,
      });
    }

    const cantidad = suggestQuantity(required, chosen, room);
    provenance.push(...cantidad.steps);
    warnings.push(...cantidad.warnings);
    const sinEnvases = cantidad.packageCount == null;

    const fechas = scheduleDates(today, chosen, policy);
    let orderDate: string | null = null;
    let deliveryDate: string | null = null;
    let diasHastaEntrega = 0;
    if ("error" in fechas) {
      warnings.push(fechas.error);
    } else {
      orderDate = fechas.orderDate;
      deliveryDate = fechas.deliveryDate;
      diasHastaEntrega = diasEntre(today, deliveryDate);
      provenance.push({
        step: "fechas",
        detail: `pedir el ${DIA_NOMBRE[isoWeekday(orderDate)]} ${orderDate} para recepción el ${DIA_NOMBRE[isoWeekday(deliveryDate)]} ${deliveryDate} (lead time ${chosen.leadTimeDays} día(s)${chosen.deliveryDays ? `, entrega solo ${chosen.deliveryDays.map((d) => DIA_NOMBRE[d]).join("/")}` : ""})`,
      });

      // ¿Llega DESPUÉS de que se acabe? Avisar, no esconder (§12).
      if (need.coverageDays != null && need.dailyRate != null && need.dailyRate > 0) {
        if (diasHastaEntrega > need.coverageDays) {
          warnings.push(
            `al ritmo actual el stock se acaba en ~${Math.floor(need.coverageDays)} día(s) y la entrega llega en ${diasHastaEntrega}: puede haber quiebre antes de recibir`,
          );
        }
      }
    }

    suggestions.push({
      ingredientId: need.ingredientId,
      label: need.label,
      unit: need.unit,
      weightBasis: need.weightBasis,
      requiredQuantity: required,
      suggestedOrderQuantity: cantidad.quantity,
      packageCount: cantidad.packageCount,
      supplierProductId: chosen.id,
      supplierId: chosen.supplierId,
      supplierName: chosen.supplierName,
      presentation: chosen.presentation,
      alternativeSuppliers: alternatives.map((a) => a.supplierName),
      orderDate,
      expectedDeliveryDate: deliveryDate,
      onHand: redondear(need.onHand),
      incoming: enCamino,
      pendingInList: enLista,
      coverageAfterDays: coberturaDespues(need, enCamino, cantidad.quantity, diasHastaEntrega),
      confidence: rec.confidence,
      provenance,
      warnings,
      needsAction: orderDate == null || sinEnvases,
      engineVersion: PURCHASE_SCHEDULE_VERSION,
    });
  }

  // Orden estable: urgencia (menor cobertura) primero, luego etiqueta.
  suggestions.sort((a, b) => {
    const ca = a.needsAction ? -1 : coberturaOrden(a);
    const cb = b.needsAction ? -1 : coberturaOrden(b);
    return ca - cb || a.label.localeCompare(b.label);
  });

  return { suggestions, coveredByIncoming,
    unresolved, engineVersion: PURCHASE_SCHEDULE_VERSION };
}

function coberturaOrden(s: PurchaseSuggestion): number {
  return s.coverageAfterDays ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Cobertura estimada DESPUÉS de recibir: lo libre (con su faltante confirmado
 * incluido — un negativo resta, no se esconde) + en camino + sugerido, MENOS
 * el consumo esperado entre hoy y la entrega, dividido por la tasa. Solo con
 * tasa conocida — sin tasa no se inventa un número.
 */
function coberturaDespues(
  need: ProcurementNeed,
  incoming: number,
  suggested: number,
  daysToDelivery: number,
): number | null {
  if (need.dailyRate == null || need.dailyRate <= 0) return null;
  const total = need.available + incoming + suggested - need.dailyRate * daysToDelivery;
  return Math.round((Math.max(0, total) / need.dailyRate) * 10) / 10;
}

function diasEntre(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}
