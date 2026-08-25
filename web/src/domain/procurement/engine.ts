/**
 * PurchaseScheduleEngine — `purchase-schedule/1.0.0`.
 *
 * Determinista y versionado: mismos insumos → mismo resultado, byte a byte.
 * Sin IA en el número, sin reloj propio (el "hoy" viene del día del hogar),
 * sin conversiones inventadas (una presentación en otra unidad NO sirve).
 *
 * Reglas duras:
 *  - En camino NUNCA es stock físico (§15): se muestra aparte y NETEA la
 *    necesidad, jamás se suma a "en casa".
 *  - required ≠ suggested (§17): la necesidad se conserva; el mínimo/múltiplo/
 *    envase solo mueven lo SUGERIDO, con cada paso explicado.
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

/** Cuántos días hacia adelante buscamos una fecha de entrega válida. */
const MAX_SCHEDULING_WINDOW = 35;

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

/**
 * Elige la presentación de proveedor para un alimento (§18, v1):
 * 1) la del proveedor PREFERIDO de la política, si existe activa y en la unidad;
 * 2) si no, la activa de mejor prioridad (menor número; empate → nombre).
 * Una presentación en OTRA unidad no participa: no inventamos conversiones.
 */
export function chooseSupplierProduct(
  products: SupplierProduct[],
  need: ProcurementNeed,
  policy: PurchasePolicy | null,
): { chosen: SupplierProduct | null; alternatives: SupplierProduct[]; wrongUnit: SupplierProduct[] } {
  const delIngrediente = products.filter((p) => p.ingredientId === need.ingredientId);
  const usables = delIngrediente
    .filter((p) => p.isActive && p.supplierActive && p.unit === need.unit)
    .sort((a, b) => a.priority - b.priority || a.supplierName.localeCompare(b.supplierName));
  const wrongUnit = delIngrediente.filter(
    (p) => p.isActive && p.supplierActive && p.unit !== need.unit,
  );

  if (usables.length === 0) return { chosen: null, alternatives: [], wrongUnit };

  const preferida = policy?.preferredSupplierId
    ? usables.find((p) => p.supplierId === policy.preferredSupplierId) ?? null
    : null;
  const chosen = preferida ?? usables[0]!;
  return { chosen, alternatives: usables.filter((p) => p.id !== chosen.id), wrongUnit };
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
 */
export function suggestQuantity(
  required: number,
  product: SupplierProduct,
  capacityRoom: number | null,
): { quantity: number; packageCount: number | null; steps: ProvenanceStep[]; warnings: string[] } {
  const steps: ProvenanceStep[] = [];
  const warnings: string[] = [];
  let qty = required;

  // Envase: solo se venden presentaciones completas.
  let count = Math.max(1, Math.ceil(qty / product.packageQuantity - 1e-9));
  qty = count * product.packageQuantity;
  if (redondear(qty) !== redondear(required)) {
    steps.push({
      step: "envase",
      detail: `se vende por "${product.presentation}" (${product.packageQuantity}): ${count} × ${product.packageQuantity} = ${redondear(qty)}`,
    });
  }

  // Pedido mínimo del proveedor.
  if (product.minimumOrderQuantity != null && qty < product.minimumOrderQuantity - 1e-9) {
    count = Math.ceil(product.minimumOrderQuantity / product.packageQuantity - 1e-9);
    qty = count * product.packageQuantity;
    steps.push({
      step: "pedido mínimo",
      detail: `el proveedor exige mínimo ${product.minimumOrderQuantity}: sube a ${redondear(qty)}`,
    });
  }

  // Múltiplo de compra (cajas de a N, etc.).
  if (product.purchaseMultiple != null) {
    const multiplos = Math.ceil(qty / product.purchaseMultiple - 1e-9);
    const ajustada = multiplos * product.purchaseMultiple;
    if (redondear(ajustada) !== redondear(qty)) {
      qty = ajustada;
      count = Math.ceil(qty / product.packageQuantity - 1e-9);
      steps.push({
        step: "múltiplo",
        detail: `se pide en múltiplos de ${product.purchaseMultiple}: sube a ${redondear(qty)}`,
      });
    }
  }

  // Capacidad: SOLO si se conoce (§16). Recortar hacia abajo en envases enteros.
  if (capacityRoom != null && qty > capacityRoom + 1e-9) {
    const caben = Math.floor((capacityRoom + 1e-9) / product.packageQuantity);
    const recortada = caben * product.packageQuantity;
    const minimo = product.minimumOrderQuantity ?? product.packageQuantity;
    if (recortada >= minimo - 1e-9 && recortada > 0) {
      qty = recortada;
      count = caben;
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

export function planPurchases(input: PurchaseScheduleInput): PurchaseScheduleResult {
  const policies = new Map(input.policies.map((p) => [p.ingredientId, p]));

  // En camino por alimento::unidad — SOLO órdenes vivas (§14). SUGGESTED no
  // cuenta (nadie la aceptó) y RECEIVED/STORED ya son lotes en casa.
  const incomingBy = new Map<string, { total: number; items: ExistingOrderItem[] }>();
  for (const item of input.existingItems) {
    if (!INCOMING_STATUSES.includes(item.orderStatus)) continue;
    const key = `${item.ingredientId}::${item.unit}`;
    const prev = incomingBy.get(key) ?? { total: 0, items: [] };
    prev.total += item.quantity;
    prev.items.push(item);
    incomingBy.set(key, prev);
  }

  const suggestions: PurchaseSuggestion[] = [];
  const coveredByIncoming: PurchaseScheduleResult["coveredByIncoming"] = [];

  for (const need of input.needs) {
    const rec = need.reorder;
    if (rec.status === "NO_ACTION" || rec.recommendedQuantity == null || rec.recommendedQuantity <= 0) {
      continue;
    }

    const provenance: ProvenanceStep[] = [
      {
        step: "necesidad",
        detail: `Stock Intelligence recomienda ${redondear(rec.recommendedQuantity)} ${need.unit} (${rec.status}, horizonte ${rec.horizonDays} días, ${rec.engineVersion})`,
      },
    ];
    const warnings: string[] = [];

    // Netear contra lo que ya viene en camino (§14): jamás doble compra.
    const incoming = incomingBy.get(`${need.ingredientId}::${need.unit}`);
    const enCamino = redondear(incoming?.total ?? 0);
    let required = rec.recommendedQuantity;
    if (enCamino > 0) {
      required = Math.max(0, required - enCamino);
      provenance.push({
        step: "en camino",
        detail: `ya vienen ${enCamino} ${need.unit} en ${incoming!.items.length} orden(es) viva(s): la necesidad neta baja a ${redondear(required)}`,
      });
    }
    required = redondear(required);
    if (required <= 0) {
      coveredByIncoming.push({
        ingredientId: need.ingredientId,
        label: need.label,
        incoming: enCamino,
        unit: need.unit,
      });
      continue;
    }

    if (rec.confidence === "LOW") {
      warnings.push("la recomendación tiene confianza BAJA: revisa la cantidad antes de aprobar");
    }

    const policy = policies.get(need.ingredientId) ?? null;
    const { chosen, alternatives, wrongUnit } = chooseSupplierProduct(
      input.supplierProducts,
      need,
      policy,
    );

    if (
      policy?.preferredSupplierId &&
      chosen &&
      chosen.supplierId !== policy.preferredSupplierId
    ) {
      warnings.push("el proveedor preferido no tiene presentación disponible: se sugiere una alternativa");
    }
    if (!chosen && wrongUnit.length > 0) {
      warnings.push(
        `hay presentaciones pero en otra unidad (${wrongUnit.map((p) => p.unit).join(", ")} vs ${need.unit}): no se convierte a ciegas`,
      );
    }

    // Sin proveedor: la necesidad se informa igual (bloque "Necesita acción"),
    // sin fechas ni redondeos que no se pueden calcular.
    if (!chosen) {
      suggestions.push({
        ingredientId: need.ingredientId,
        label: need.label,
        unit: need.unit,
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
        coverageAfterDays: coberturaDespues(need, enCamino, required),
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
    const capacidad = input.capacity[`${need.ingredientId}::${need.unit}`];
    const room =
      capacidad != null ? Math.max(0, redondear(capacidad - need.onHand - enCamino)) : null;
    if (room != null) {
      provenance.push({
        step: "capacidad",
        detail: `tope conocido ${capacidad}: en casa ${redondear(need.onHand)} + en camino ${enCamino} → espacio ${room}`,
      });
    }

    const cantidad = suggestQuantity(required, chosen, room);
    provenance.push(...cantidad.steps);
    warnings.push(...cantidad.warnings);

    const fechas = scheduleDates(input.today, chosen, policy);
    let orderDate: string | null = null;
    let deliveryDate: string | null = null;
    if ("error" in fechas) {
      warnings.push(fechas.error);
    } else {
      orderDate = fechas.orderDate;
      deliveryDate = fechas.deliveryDate;
      provenance.push({
        step: "fechas",
        detail: `pedir el ${DIA_NOMBRE[isoWeekday(orderDate)]} ${orderDate} para recepción el ${DIA_NOMBRE[isoWeekday(deliveryDate)]} ${deliveryDate} (lead time ${chosen.leadTimeDays} día(s)${chosen.deliveryDays ? `, entrega solo ${chosen.deliveryDays.map((d) => DIA_NOMBRE[d]).join("/")}` : ""})`,
      });

      // ¿Llega DESPUÉS de que se acabe? Avisar, no esconder (§12).
      if (need.coverageDays != null && need.dailyRate != null && need.dailyRate > 0) {
        const diasHasta = diasEntre(input.today, deliveryDate);
        if (diasHasta > need.coverageDays) {
          warnings.push(
            `al ritmo actual el stock se acaba en ~${Math.floor(need.coverageDays)} día(s) y la entrega llega en ${diasHasta}: puede haber quiebre antes de recibir`,
          );
        }
      }
    }

    suggestions.push({
      ingredientId: need.ingredientId,
      label: need.label,
      unit: need.unit,
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
      coverageAfterDays: coberturaDespues(need, enCamino, cantidad.quantity),
      confidence: rec.confidence,
      provenance,
      warnings,
      needsAction: orderDate == null,
      engineVersion: PURCHASE_SCHEDULE_VERSION,
    });
  }

  // Orden estable: urgencia (menor cobertura) primero, luego etiqueta.
  suggestions.sort((a, b) => {
    const ca = a.needsAction ? -1 : coberturaOrden(a);
    const cb = b.needsAction ? -1 : coberturaOrden(b);
    return ca - cb || a.label.localeCompare(b.label);
  });

  return { suggestions, coveredByIncoming, engineVersion: PURCHASE_SCHEDULE_VERSION };
}

function coberturaOrden(s: PurchaseSuggestion): number {
  return s.coverageAfterDays ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Cobertura estimada después de recibir: (libre + en camino + sugerido) / tasa.
 * Solo con tasa conocida — sin tasa no se inventa un número.
 */
function coberturaDespues(need: ProcurementNeed, incoming: number, suggested: number): number | null {
  if (need.dailyRate == null || need.dailyRate <= 0) return null;
  const total = Math.max(0, need.available) + incoming + suggested;
  return Math.round((total / need.dailyRate) * 10) / 10;
}

function diasEntre(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}
