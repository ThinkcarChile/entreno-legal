"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProcurementStatus, PurchaseScheduleResult, PurchaseSuggestion } from "@/domain/procurement/types";
import { advanceOrder, approveSuggestion, receiveOrder } from "./actions";
import type { OrderView } from "./queries";

const ESTADO_TEXTO: Record<ProcurementStatus, string> = {
  SUGGESTED: "sugerida",
  PLANNED: "planificada",
  ORDERED: "pedida",
  READY: "lista para retiro",
  DELIVERING: "en reparto",
  RECEIVED: "recibida",
  STORED: "guardada",
  CANCELLED: "cancelada",
};

const CONFIDENCE_LABELS = { LOW: "baja", MEDIUM: "media", HIGH: "alta" } as const;

function unidad(u: "G" | "ML" | "UNIT"): string {
  return u === "G" ? "g" : u === "ML" ? "ml" : "unidades";
}

function cantidad(n: number, u: "G" | "ML" | "UNIT"): string {
  const texto = Number.isInteger(n) ? n.toLocaleString("es-CL") : n.toLocaleString("es-CL", { maximumFractionDigits: 1 });
  return `${texto} ${unidad(u)}`;
}

export function ProcurementBoard({
  plan,
  orders,
  today,
}: {
  plan: PurchaseScheduleResult;
  orders: OrderView[];
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aprobadas, setAprobadas] = useState<Set<string>>(new Set());
  const [abierta, setAbierta] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>, done?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "No se pudo completar.");
        return;
      }
      if (r.message) setMessage(r.message);
      done?.();
      router.refresh();
    });
  }

  const necesitanAccion = plan.suggestions.filter((s) => s.needsAction);
  const proximos = plan.suggestions.filter((s) => !s.needsAction);
  const enCamino = orders.filter((o) => ["PLANNED", "ORDERED", "READY", "DELIVERING"].includes(o.status));
  const recibidas = orders.filter((o) => ["RECEIVED", "STORED"].includes(o.status)).slice(0, 8);

  const claveSug = (s: PurchaseSuggestion) =>
    `${s.ingredientId}:${s.orderDate ?? ""}:${s.suggestedOrderQuantity}:${s.supplierProductId ?? ""}`;

  return (
    <div className="space-y-5">
      {message && (
        <p className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm text-white shadow-lg">
          {message}
        </p>
      )}
      {error && (
        <p
          className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-red-600 px-4 py-2.5 text-sm text-white shadow-lg"
          role="alert"
        >
          {error}
        </p>
      )}

      {/* ---- Próximos pedidos ---- */}
      <section>
        <h2 className="mb-2 text-sm font-semibold">Próximos pedidos sugeridos</h2>
        {proximos.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-5 text-center text-sm text-[var(--ink)]/60">
            Nada que pedir por ahora. Cuando el stock no alcance, la sugerencia aparece acá con
            fechas y proveedor.
          </p>
        ) : (
          <ul className="space-y-2">
            {proximos.map((s) => {
              const clave = claveSug(s);
              const aprobada = aprobadas.has(clave);
              return (
                <li key={clave} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{s.label}</p>
                      <p className="text-xs text-[var(--ink)]/60">
                        necesitas {cantidad(s.requiredQuantity, s.unit)} · sugerido{" "}
                        <strong className="text-[var(--ink)]">{cantidad(s.suggestedOrderQuantity, s.unit)}</strong>
                        {s.packageCount != null && s.presentation && (
                          <> ({s.packageCount} × {s.presentation})</>
                        )}
                      </p>
                      <p className="text-xs text-[var(--ink)]/60">
                        {s.supplierName && <>a {s.supplierName} · </>}
                        pedir el {s.orderDate} · llega el {s.expectedDeliveryDate}
                      </p>
                      <p className="text-xs text-[var(--ink)]/60">
                        en casa {cantidad(s.onHand, s.unit)}
                        {s.incoming > 0 && <> · en camino {cantidad(s.incoming, s.unit)}</>}
                        {s.coverageAfterDays != null && <> · cobertura al recibir ~{s.coverageAfterDays} días</>}
                        {s.confidence && <> · confianza {CONFIDENCE_LABELS[s.confidence]}</>}
                      </p>
                      {s.warnings.map((w) => (
                        <p key={w} className="mt-1 text-xs text-amber-700">
                          ⚠ {w}
                        </p>
                      ))}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <button
                        type="button"
                        disabled={pending || aprobada}
                        onClick={() =>
                          run(
                            () => approveSuggestion(s),
                            () => setAprobadas((prev) => new Set([...prev, clave])),
                          )
                        }
                        className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {aprobada ? "Planificada ✓" : "Aprobar pedido"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAbierta(abierta === clave ? null : clave)}
                        className="text-xs text-[var(--accent)] underline"
                      >
                        ¿Por qué?
                      </button>
                    </div>
                  </div>
                  {abierta === clave && (
                    <ol className="mt-2 space-y-1 rounded-xl bg-[var(--paper)] p-3 text-xs text-[var(--ink)]/70">
                      {s.provenance.map((p, i) => (
                        <li key={i}>
                          <strong>{p.step}:</strong> {p.detail}
                        </li>
                      ))}
                      <li className="pt-1 text-[10px] text-[var(--ink)]/40">{s.engineVersion}</li>
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- Necesita acción ---- */}
      {(necesitanAccion.length > 0 || plan.coveredByIncoming.length > 0) && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Necesita acción</h2>
          <ul className="space-y-2">
            {necesitanAccion.map((s) => (
              <li key={s.ingredientId + s.unit} className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
                <p className="font-medium">{s.label}</p>
                <p className="text-xs text-[var(--ink)]/70">
                  necesitas {cantidad(s.requiredQuantity, s.unit)} · en casa {cantidad(s.onHand, s.unit)}
                  {s.incoming > 0 && <> · en camino {cantidad(s.incoming, s.unit)}</>}
                </p>
                {s.warnings.map((w) => (
                  <p key={w} className="mt-1 text-xs text-amber-800">
                    ⚠ {w}
                  </p>
                ))}
              </li>
            ))}
            {plan.coveredByIncoming.map((c) => (
              <li
                key={c.ingredientId + c.unit}
                className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-xs text-[var(--ink)]/60"
              >
                <strong className="text-[var(--ink)]">{c.label}</strong>: la necesidad ya viene cubierta
                con {cantidad(c.incoming, c.unit)} en camino — no se sugiere de nuevo.
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- En camino ---- */}
      <section>
        <h2 className="mb-2 text-sm font-semibold">En camino</h2>
        {enCamino.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-4 text-center text-xs text-[var(--ink)]/60">
            Sin órdenes vivas.
          </p>
        ) : (
          <ul className="space-y-2">
            {enCamino.map((o) => (
              <li key={o.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {o.items.map((i) => `${cantidad(i.suggestedQuantity, i.unit)} de ${i.label}`).join(" · ")}
                    </p>
                    <p className="text-xs text-[var(--ink)]/60">
                      {o.supplierName && <>{o.supplierName} · </>}
                      <span className="rounded-full bg-[var(--paper)] px-2 py-0.5">{ESTADO_TEXTO[o.status]}</span>
                      {o.orderDate && <> · pedir el {o.orderDate}</>}
                      {o.expectedDeliveryDate && (
                        <>
                          {" "}
                          · llega el {o.expectedDeliveryDate}
                          {o.expectedDeliveryDate < today && o.status !== "PLANNED" && (
                            <span className="text-amber-700"> (atrasada)</span>
                          )}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {o.status === "PLANNED" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => advanceOrder(o.id, "ORDERED"))}
                        className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Ya lo pedí
                      </button>
                    )}
                    {["ORDERED", "READY", "DELIVERING"].includes(o.status) && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => receiveOrder(o.id))}
                        className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Llegó: recibir
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => advanceOrder(o.id, "CANCELLED"))}
                      className="text-xs text-red-700 underline disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Recibidos recientemente ---- */}
      {recibidas.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Recibidos recientemente</h2>
          <ul className="space-y-1.5">
            {recibidas.map((o) => (
              <li
                key={o.id}
                className="rounded-xl border border-[var(--ink)]/10 bg-white px-4 py-2.5 text-xs text-[var(--ink)]/70"
              >
                {o.items.map((i) => `${cantidad(i.suggestedQuantity, i.unit)} de ${i.label}`).join(" · ")}
                {o.supplierName && <> — {o.supplierName}</>}
                {o.receivedAt && <> · {o.receivedAt.slice(0, 10)}</>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
