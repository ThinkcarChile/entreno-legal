"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { registrarError } from "@/lib/observabilidad";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { extractReceiptFromText } from "@/domain/finance/receipt-extraction";
import { parseMinor } from "@/domain/finance/money";
import { loadReceipt } from "./queries";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  id?: string;
  duplicated?: boolean;
}

/**
 * El resultado de PREGUNTAR por los bloqueos, como unión discriminada.
 *
 * No es `ActionResult & { blocks?: string[] }` a propósito: con `blocks`
 * opcional la pantalla tenía que escribir `r.blocks ?? []`, que es la forma
 * exacta de convertir «no se pudo preguntar» en «no hay ningún bloqueo» —
 * justo la puerta que habilita el botón cuando el servidor no contestó. Acá,
 * si `ok` es true la lista existe, y si es false no hay lista que leer: el
 * compilador no deja intentarlo.
 */
export type BlocksResult =
  | { ok: true; blocks: string[] }
  | { ok: false; error: string };

const BUCKET = "purchase-receipts";

/**
 * MIME → extensión desde una TABLA FIJA, jamás desde `archivo.name.split(".")`:
 * el nombre lo escribe quien sube y termina siendo parte de una ruta.
 */
const TIPOS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
};
const TAMANO_MAX = 8 * 1024 * 1024;

async function client() {
  return createSupabaseServer();
}

/** El monto que la persona escribió, o el motivo por el que no es un monto. */
function minorDeTexto(bruto: string): { ok: true; minor: string } | { ok: false; problema: string } {
  const limpio = bruto.trim().replace(/\./g, "");
  if (limpio === "") return { ok: false, problema: "falta el monto" };
  const leido = parseMinor(limpio);
  if (!leido.ok) return { ok: false, problema: leido.problema };
  return { ok: true, minor: leido.minor.toString() };
}

// ---------------------------------------------------------------------------
// Subida
// ---------------------------------------------------------------------------

/**
 * Sube la boleta. Calcada de `uploadExam` (health/actions.ts) con la dedup que
 * el clínico no necesitaba:
 *
 * [H51] el sha256 se calcula sobre el BUFFER, antes de subir, y se pregunta por
 * él. Si la boleta ya existe no se sube ningún objeto y se devuelve la que hay:
 * «creo que no se subió» es el escenario más frecuente de duplicación real, y la
 * respuesta correcta no es un error, es la boleta que ya está.
 *
 * El objeto se nombra con el hash, así que incluso una carrera entre dos
 * personas escribe el mismo archivo en el mismo lugar en vez de dejar dos.
 */
export async function uploadReceipt(formData: FormData): Promise<ActionResult> {
  const supabase = await client();
  const archivo = formData.get("file");
  const intentBruto = String(formData.get("intent") ?? "NEW_PURCHASE");
  const intent = z.enum(["NEW_PURCHASE", "ATTACH_TO_EXISTING"]).safeParse(intentBruto);
  if (!intent.success) return { ok: false, error: "Destino de la boleta inválido." };

  if (!(archivo instanceof File) || archivo.size === 0) {
    return { ok: false, error: "Falta la foto o el archivo de la boleta." };
  }
  const extension = TIPOS[archivo.type];
  if (extension === undefined) {
    return { ok: false, error: "Formato no soportado: JPG, PNG, WEBP, PDF o texto." };
  }
  if (archivo.size > TAMANO_MAX) {
    return { ok: false, error: "El archivo supera los 8 MB." };
  }

  const { householdId } = await loadHouseholdMembers(supabase);
  if (householdId === null) {
    return { ok: false, error: "Todavía no perteneces a ningún hogar: crea uno o acepta tu invitación." };
  }
  const buffer = Buffer.from(await archivo.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  const sonda = await supabase.rpc("find_purchase_receipt_by_hash", {
    p_household: householdId,
    p_sha256: sha256,
  });
  if (sonda.error) {
    return { ok: false, error: `No se pudo revisar si esta boleta ya estaba: ${sonda.error.message}` };
  }
  const yaEsta = sonda.data as {
    found: boolean;
    receiptId?: string;
    archived?: boolean;
    purchaseId?: string | null;
  } | null;
  if (yaEsta !== null && yaEsta.found && yaEsta.receiptId !== undefined) {
    // Una boleta ARCHIVADA que ya generó su compra sigue siendo la respuesta
    // correcta a "creo que no se subió": la compra existe. Archivar para
    // ordenar la bandeja no borró nada, y volver a subir la foto NO puede
    // crear una segunda compra con su segundo juego de lotes.
    const archivadaConCompra =
      yaEsta.archived === true &&
      yaEsta.purchaseId !== null &&
      yaEsta.purchaseId !== undefined;
    return {
      ok: true,
      id: yaEsta.receiptId,
      duplicated: true,
      message: archivadaConCompra
        ? "Esta boleta ya estaba subida y ya generó su compra; está archivada. No se sube de nuevo: lo comprado ya está en la despensa."
        : "Esta misma boleta ya estaba subida: te llevamos a la que ya existe.",
    };
  }

  // La ruta lleva el hogar: la política del bucket exige FINANCE_UPLOAD_RECEIPTS
  // sobre ESE hogar, así que una ruta ajena no se puede colar.
  const ruta = `household/${householdId}/${sha256}.${extension}`;
  const subida = await supabase.storage.from(BUCKET).upload(ruta, buffer, {
    contentType: archivo.type,
    upsert: true,
  });
  if (subida.error) {
    return { ok: false, error: `No se pudo guardar el archivo: ${subida.error.message}` };
  }

  const { data, error } = await supabase.rpc("upload_purchase_receipt", {
    p_household: householdId,
    p_storage_path: ruta,
    p_mime: archivo.type,
    p_bytes: archivo.size,
    p_sha256: sha256,
    p_intent: intent.data,
  });
  if (error) {
    // El documento no quedó registrado: el archivo huérfano se retira. El
    // resultado del remove() NO se descarta — si el borrado falla queda una
    // boleta en el bucket sin ninguna fila que la referencie y nadie se entera.
    const retiro = await supabase.storage.from(BUCKET).remove([ruta]);
    // Sin `?? []`: «el borrado falló» y «el borrado no retiró nada» son dos
    // hechos distintos y los dos dejan el archivo huérfano. Se nombran los dos.
    const retirados = retiro.data;
    const quedoHuerfano =
      retiro.error !== null || retirados === null || retirados.length === 0;
    if (quedoHuerfano) {
      // §50: al log van el DÓNDE y el CÓDIGO, jamás los mensajes. Un
      // `error.message` de PostgREST puede venir redactado por PostgreSQL con la
      // fila adentro (`Key (…)=(…)`), y una boleta trae el detalle de una
      // compra. `registrarError` lo filtraría igual; no se le pasa, y así la
      // línea dice sola qué sale.
      registrarError("finanzas.boleta.archivo_huerfano", {
        bucket: BUCKET,
        ruta,
        householdId,
        codigoRegistro: error.code,
        borrado: retiro.error !== null ? "FALLO" : "NO_RETIRO_NADA",
      });
      return {
        ok: false,
        error:
          `No se pudo registrar la boleta (${error.message}) y tampoco se pudo retirar el ` +
          "archivo que ya se había subido. Quedó guardado sin quedar asociado a ninguna " +
          "compra: avísale a quien administra el hogar. No vuelvas a subirlo hasta entonces.",
      };
    }
    return { ok: false, error: `No se pudo registrar la boleta: ${error.message}` };
  }

  const r = data as { receiptId: string; duplicated: boolean };
  revalidatePath("/finanzas/boletas");
  return {
    ok: true,
    id: r.receiptId,
    duplicated: r.duplicated,
    message: r.duplicated ? "Esta boleta ya estaba subida." : "Boleta subida.",
  };
}

/**
 * [H49/H62] El consentimiento de IA exige FINANCE_CONFIRM_RECEIPTS. Lo decide la
 * base, no esta función: acá solo se transporta y se muestra el error tal cual.
 */
export async function setReceiptConsent(
  receiptId: string,
  granted: boolean,
  purpose: "EXTRAER_LINEAS" | "EXTRAER_TOTAL_Y_FOLIO" | "AMBOS",
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("set_receipt_ai_consent", {
    p_receipt: receiptId,
    p_granted: granted,
    p_purpose: granted ? purpose : null,
  });
  if (error) return { ok: false, error: `No se pudo guardar el consentimiento: ${error.message}` };
  revalidatePath(`/finanzas/boletas/${receiptId}/review`);
  return {
    ok: true,
    message: granted
      ? "Consentimiento registrado: la lectura automática queda disponible."
      : "Sin consentimiento: la boleta se revisa a mano.",
  };
}

export async function revokeReceiptConsent(
  receiptId: string,
  reason: string,
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("revoke_receipt_ai_consent", {
    p_receipt: receiptId,
    p_reason: reason,
  });
  if (error) return { ok: false, error: `No se pudo revocar: ${error.message}` };
  revalidatePath(`/finanzas/boletas/${receiptId}/review`);
  return { ok: true, message: "Consentimiento revocado: no se manda nada más." };
}

/** URL firmada de corta vida. Jamás una URL pública permanente. */
export async function getReceiptSignedUrl(
  receiptId: string,
): Promise<ActionResult & { url?: string }> {
  const supabase = await client();
  const boleta = await loadReceipt(supabase, receiptId); // la RLS decide
  if (boleta === null) return { ok: false, error: "Esta boleta no existe o no la puedes ver." };
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(boleta.storage_path, 300);
  if (error || data === null) {
    return { ok: false, error: "No se pudo generar el enlace temporal de la boleta." };
  }
  return { ok: true, url: data.signedUrl };
}

// ---------------------------------------------------------------------------
// Extracción — capa sustituible; el servidor re-verifica el consentimiento
// ---------------------------------------------------------------------------

export async function runReceiptExtraction(receiptId: string): Promise<ActionResult> {
  const supabase = await client();
  const boleta = await loadReceipt(supabase, receiptId);
  if (boleta === null) return { ok: false, error: "Boleta no encontrada." };
  if (boleta.ai_consent_status !== "GRANTED") {
    return {
      ok: false,
      error: "Sin consentimiento para lectura automática: consiente primero o revísala a mano.",
    };
  }

  const bajada = await supabase.storage.from(BUCKET).download(boleta.storage_path);
  if (bajada.error || bajada.data === null) {
    return { ok: false, error: "No se pudo leer el archivo de la boleta." };
  }
  const mime = bajada.data.type === "" ? boleta.original_mime : bajada.data.type;
  const resultado = mime.startsWith("text/")
    ? extractReceiptFromText(await bajada.data.text(), mime)
    : // Foto o PDF sin extractor real: FAILED honesto, jamás un OCR improvisado.
      extractReceiptFromText("", mime);

  if (!resultado.ok) {
    const { error } = await supabase.rpc("submit_receipt_extraction", {
      p_receipt: receiptId,
      p_processor_version: resultado.processorVersion,
      p_header: {},
      p_candidates: [],
    });
    if (error) return { ok: false, error: `La lectura falló: ${error.message}` };
    revalidatePath(`/finanzas/boletas/${receiptId}/review`);
    return { ok: false, error: resultado.error };
  }

  const { data, error } = await supabase.rpc("submit_receipt_extraction", {
    p_receipt: receiptId,
    p_processor_version: resultado.processorVersion,
    p_header: resultado.header,
    p_candidates: resultado.candidates,
  });
  if (error) return { ok: false, error: `No se pudo registrar la lectura: ${error.message}` };
  const r = data as { candidates: number; doubtful: number };
  revalidatePath(`/finanzas/boletas/${receiptId}/review`);
  return {
    ok: true,
    message:
      `${r.candidates} línea(s) leídas, ${r.doubtful} por revisar. ` +
      "Nada entra a la despensa ni al gasto hasta que confirmes.",
  };
}

// ---------------------------------------------------------------------------
// Revisión
// ---------------------------------------------------------------------------

export interface ReceiptDecision {
  candidateId: string;
  action: "CONFIRM" | "EDIT" | "DISCARD";
  acknowledged?: boolean;
  /** Los montos viajan como TEXTO: nunca pasan por un `number` de JavaScript. */
  lineTotalMinor?: string | null;
  discountMinor?: string | null;
  unitPriceMinor?: string | null;
  quantity?: string | null;
  unit?: string | null;
  matchedIngredientId?: string | null;
  matchedProductId?: string | null;
}

export interface ReceiptCharge {
  kind: string;
  label: string;
  amountMinor: string;
  policy: "PRO_RATA_VALUE" | "PRO_RATA_WEIGHT" | "EXPENSE_ONLY";
}

/**
 * Traduce una decisión de pantalla al payload del RPC.
 *
 * La distinción que importa: una clave AUSENTE significa «no lo toqué» y una
 * clave con `null` significa «lo declaro DESCONOCIDO». Colapsar las dos es
 * exactamente cómo un desconocido termina valiendo cero.
 */
function payloadDe(d: ReceiptDecision): Record<string, unknown> {
  const salida: Record<string, unknown> = {
    candidate_id: d.candidateId,
    action: d.action,
  };
  if (d.acknowledged === true) salida.acknowledged = true;
  if (d.lineTotalMinor !== undefined) salida.line_total_minor = d.lineTotalMinor;
  if (d.discountMinor !== undefined) salida.discount_minor = d.discountMinor;
  if (d.unitPriceMinor !== undefined) salida.unit_price_minor = d.unitPriceMinor;
  if (d.quantity !== undefined) salida.quantity = d.quantity;
  if (d.unit !== undefined) salida.unit = d.unit;
  if (d.matchedIngredientId !== undefined) salida.matched_ingredient_id = d.matchedIngredientId;
  if (d.matchedProductId !== undefined) salida.matched_product_id = d.matchedProductId;
  return salida;
}

function cargosDe(cargos: readonly ReceiptCharge[]): Record<string, unknown>[] {
  return cargos.map((c) => ({
    kind: c.kind,
    label: c.label,
    amount_minor: c.amountMinor,
    policy: c.policy,
  }));
}

/**
 * Los bloqueos, leídos de la MISMA función que usa el servidor al confirmar.
 * La pantalla no tiene su propia lista: tenerla es el defecto [H50].
 */
export async function receiptBlocks(
  receiptId: string,
  decisions: readonly ReceiptDecision[] | null,
  confirmedTotal: string | null,
  charges: readonly ReceiptCharge[],
  door: "NEW_PURCHASE" | "ATTACH_TO_EXISTING" = "NEW_PURCHASE",
): Promise<BlocksResult> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("receipt_confirm_blocks", {
    p_receipt: receiptId,
    p_decisions: decisions === null ? null : decisions.map(payloadDe),
    p_confirmed_total_minor: confirmedTotal,
    p_charges: cargosDe(charges),
    p_door: door,
  });
  if (error) return { ok: false, error: `No se pudo revisar la boleta: ${error.message}` };
  return { ok: true, blocks: data as string[] };
}

export async function confirmReceipt(
  receiptId: string,
  decisions: readonly ReceiptDecision[],
  confirmedTotalTexto: string | null,
  charges: readonly ReceiptCharge[],
  purchasedOn: string | null,
): Promise<ActionResult> {
  const supabase = await client();

  let total: string | null = null;
  if (confirmedTotalTexto !== null && confirmedTotalTexto.trim() !== "") {
    const leido = minorDeTexto(confirmedTotalTexto);
    if (!leido.ok) {
      return { ok: false, error: `El total de la boleta no es un monto: ${leido.problema}` };
    }
    total = leido.minor;
  }

  const { data, error } = await supabase.rpc("confirm_receipt_extraction", {
    p_receipt: receiptId,
    p_decisions: decisions.map(payloadDe),
    p_confirmed_total_minor: total,
    p_charges: cargosDe(charges),
    p_purchased_on: purchasedOn,
  });
  if (error) return { ok: false, error: error.message };

  const r = data as {
    confirmed: number;
    discarded: number;
    lots: number;
    priceObservations: number;
    purchaseId: string | null;
  };
  revalidatePath(`/finanzas/boletas/${receiptId}/review`);
  revalidatePath("/finanzas/boletas");
  revalidatePath("/pantry");
  if (r.purchaseId === null) {
    return {
      ok: true,
      message: `${r.discarded} línea(s) descartadas: esta boleta no generó ninguna compra.`,
    };
  }
  return {
    ok: true,
    id: r.purchaseId,
    message:
      `${r.confirmed} línea(s) confirmadas · ${r.discarded} descartadas · ` +
      `${r.lots} lote(s) entraron a la despensa con su valor · ` +
      `${r.priceObservations} precio(s) quedaron anotados en la historia del hogar.`,
  };
}

// ---------------------------------------------------------------------------
// Adjuntar: la boleta que llegó DESPUÉS de la mercadería
// ---------------------------------------------------------------------------

export interface ReceiptLink {
  candidateId: string;
  /** `null` = esta línea no corresponde a nada guardado y se descarta. */
  lotId: string | null;
  acknowledged?: boolean;
}

function enlaceDe(l: ReceiptLink): Record<string, unknown> {
  const salida: Record<string, unknown> = { candidate_id: l.candidateId };
  if (l.lotId === null) {
    salida.action = "DISCARD";
  } else {
    salida.lot_id = l.lotId;
  }
  if (l.acknowledged === true) salida.acknowledged = true;
  return salida;
}

/**
 * Los bloqueos de la puerta de ADJUNTAR, leídos de la MISMA función del
 * servidor. No hay una segunda lista: tener dos fue el defecto que dejaba
 * capitalizar una línea que el propio servidor había marcado dudosa.
 */
export async function attachBlocks(
  receiptId: string,
  links: readonly ReceiptLink[] | null,
  confirmedTotalTexto: string | null,
): Promise<BlocksResult> {
  const supabase = await client();
  let total: string | null = null;
  if (confirmedTotalTexto !== null && confirmedTotalTexto.trim() !== "") {
    const leido = minorDeTexto(confirmedTotalTexto);
    if (!leido.ok) {
      return { ok: false, error: `El total de la boleta no es un monto: ${leido.problema}` };
    }
    total = leido.minor;
  }
  const { data, error } = await supabase.rpc("receipt_confirm_blocks", {
    p_receipt: receiptId,
    p_decisions: links === null ? null : links.map(enlaceDe),
    p_confirmed_total_minor: total,
    p_charges: [],
    p_door: "ATTACH_TO_EXISTING",
  });
  if (error) return { ok: false, error: `No se pudo revisar la boleta: ${error.message}` };
  return { ok: true, blocks: data as string[] };
}

/**
 * Ponerle precio a lo que YA está guardado.
 *
 * No crea lotes, no mueve cantidades y no vuelve a meter la mercadería: sólo
 * deposita el valor que faltaba. Es el destino «ya llegó» que la app venía
 * ofreciendo en la subida y en la lista sin tener dónde terminarlo.
 */
export async function attachReceipt(
  receiptId: string,
  links: readonly ReceiptLink[],
  confirmedTotalTexto: string | null,
): Promise<ActionResult> {
  const supabase = await client();

  let total: string | null = null;
  if (confirmedTotalTexto !== null && confirmedTotalTexto.trim() !== "") {
    const leido = minorDeTexto(confirmedTotalTexto);
    if (!leido.ok) {
      return { ok: false, error: `El total de la boleta no es un monto: ${leido.problema}` };
    }
    total = leido.minor;
  }

  const { data, error } = await supabase.rpc("attach_receipt_to_purchase", {
    p_receipt: receiptId,
    p_links: links.map(enlaceDe),
    p_confirmed_total_minor: total,
  });
  if (error) return { ok: false, error: error.message };

  const r = data as {
    purchaseId: string;
    lines: number;
    discarded: number;
    priceObservations: number;
  };
  revalidatePath(`/finanzas/boletas/${receiptId}/review`);
  revalidatePath("/finanzas/boletas");
  revalidatePath("/pantry");
  return {
    ok: true,
    id: r.purchaseId,
    message:
      `${r.lines} lote(s) que ya estaban guardados quedaron con su precio · ` +
      `${r.discarded} línea(s) descartadas · ` +
      `${r.priceObservations} precio(s) anotados. No entró nada nuevo a la despensa.`,
  };
}

/** [H35 capa 3] «Son dos compras distintas»: se declara, con su porqué. */
export async function acknowledgeDuplicate(
  receiptId: string,
  reason: string,
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("acknowledge_receipt_duplicate", {
    p_receipt: receiptId,
    p_reason: reason,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/finanzas/boletas/${receiptId}/review`);
  return { ok: true, message: "Anotado: son dos compras distintas." };
}

/**
 * Archivar. El servidor decide si el archivo se borra o se conserva ([H52]):
 * acá solo se obedece. Una boleta confirmada respalda una compra viva.
 */
export async function archiveReceipt(receiptId: string): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("archive_purchase_receipt", {
    p_receipt: receiptId,
  });
  if (error) return { ok: false, error: `No se pudo archivar: ${error.message}` };

  const r = data as { fileDeleted: boolean; storagePath: string | null; retained: boolean };
  if (r.fileDeleted && r.storagePath !== null) {
    const retiro = await supabase.storage.from(BUCKET).remove([r.storagePath]);
    if (retiro.error) {
      registrarError("finanzas.boleta.objeto_no_borrado", {
        receiptId,
        ruta: r.storagePath,
        // El mensaje del almacenamiento no entra al log (§50): lo que hace
        // falta para limpiarlo a mano es la ruta, y esa sí está.
        borrado: "FALLO",
      });
      return {
        ok: false,
        error:
          "La boleta se archivó pero el archivo no se pudo borrar del almacenamiento. " +
          "Avísale a quien administra el hogar.",
      };
    }
  }
  revalidatePath("/finanzas/boletas");
  return {
    ok: true,
    message: r.retained
      ? "Boleta archivada. El archivo se conserva: respalda una compra confirmada."
      : "Boleta archivada y su archivo borrado.",
  };
}
