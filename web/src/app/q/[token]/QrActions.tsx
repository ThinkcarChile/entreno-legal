"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { qrDiscardLot, qrMoveLot, qrUpdateWeight, qrUseLot, reprintLabel } from "@/app/prep/actions";

interface LotView {
  lot_id: string;
  label: string;
  quantity: number;
  unit: "G" | "ML" | "UNIT";
  status: string;
  processing_state: string;
  temperature_state: string;
  package_code: string | null;
  intended_use_date: string | null;
  use_by: string | null;
}

/** Acciones del QR (§36): botones grandes para cocina, cada una vía RPC del ledger. */
export function QrActions({
  lot,
  locations,
  vinculoRoto = false,
}: {
  lot: LotView;
  locations: { id: string; name: string; kind: "PANTRY" | "FRIDGE" | "FREEZER" | "OTHER" }[];
  /** §84: la comida prevista cambió o desapareció — el paquete sigue existiendo. */
  vinculoRoto?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modo, setModo] = useState<"NONE" | "PARTIAL" | "WEIGHT" | "MOVE">("NONE");
  const [cantidad, setCantidad] = useState("");

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "No se pudo completar.");
        return;
      }
      setMessage(r.message ?? "Listo.");
      setModo("NONE");
      setCantidad("");
      router.refresh();
    });
  }

  const unidad = lot.unit === "G" ? "g" : lot.unit === "ML" ? "ml" : "unid.";
  const cerrado = lot.status !== "AVAILABLE";
  const btn = "w-full rounded-2xl px-5 py-4 text-base font-semibold disabled:opacity-50";

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 px-5 py-8">
      <header className="text-center">
        <p className="text-xs text-[var(--ink)]/50">{lot.package_code ?? "paquete"}</p>
        <h1 className="text-2xl font-bold">{lot.label}</h1>
        <p className="text-lg">
          {lot.quantity} {unidad} ·{" "}
          {lot.temperature_state === "FROZEN" ? "congelado" : lot.temperature_state === "CHILLED" ? "refrigerado" : "ambiente"}
        </p>
        {lot.intended_use_date && !vinculoRoto && (
          <p className="text-sm text-[var(--ink)]/60">Para el {lot.intended_use_date}</p>
        )}
        {vinculoRoto && (
          <p className="mt-1 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Este paquete ya no está asignado a una comida (el plan cambió). Sigue disponible
            como stock: úsalo cuando quieras o vuelve a asignarlo.
          </p>
        )}
        {lot.use_by && <p className="text-sm font-medium text-amber-800">Usar antes de {lot.use_by}</p>}
        {cerrado && <p className="mt-1 text-sm text-red-700">Este lote ya está {lot.status.toLowerCase()}.</p>}
      </header>

      {message && <p className="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-center text-sm text-white">{message}</p>}
      {error && (
        <p className="rounded-xl bg-red-600 px-4 py-2.5 text-center text-sm text-white" role="alert">
          {error}
        </p>
      )}

      {!cerrado && modo === "NONE" && (
        <div className="space-y-2">
          <button type="button" disabled={pending} onClick={() => run(() => qrUseLot(lot.lot_id, null))} className={`${btn} bg-[var(--accent)] text-white`}>
            Lo usé completo
          </button>
          <button type="button" disabled={pending} onClick={() => setModo("PARTIAL")} className={`${btn} border border-[var(--accent)] text-[var(--accent)]`}>
            Usé una parte
          </button>
          <button type="button" disabled={pending} onClick={() => setModo("MOVE")} className={`${btn} border border-[var(--ink)]/20`}>
            Mover / descongelar
          </button>
          <button type="button" disabled={pending} onClick={() => setModo("WEIGHT")} className={`${btn} border border-[var(--ink)]/20`}>
            Corregir peso
          </button>
          <button type="button" disabled={pending} onClick={() => run(() => reprintLabel(lot.lot_id))} className={`${btn} border border-[var(--ink)]/20`}>
            Reimprimir etiqueta
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => qrDiscardLot(lot.lot_id, lot.processing_state === "COOKED" ? "DISCARDED_LEFTOVER" : "SPOILED"))}
            className={`${btn} border border-red-200 text-red-700`}
          >
            Se echó a perder
          </button>
        </div>
      )}

      {(modo === "PARTIAL" || modo === "WEIGHT") && (
        <div className="space-y-2">
          <label className="block text-sm text-[var(--ink)]/60">
            {modo === "PARTIAL" ? `¿Cuánto usaste? (${unidad})` : `Peso real ahora (${unidad})`}
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--ink)]/20 bg-white px-4 py-3 text-xl"
              autoFocus
            />
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const n = Number(cantidad);
              if (!Number.isFinite(n)) {
                setError("Revisa el número.");
                return;
              }
              run(() => (modo === "PARTIAL" ? qrUseLot(lot.lot_id, n) : qrUpdateWeight(lot.lot_id, n)));
            }}
            className={`${btn} bg-[var(--accent)] text-white`}
          >
            Confirmar
          </button>
          <button type="button" onClick={() => setModo("NONE")} className={`${btn} border border-[var(--ink)]/20`}>
            Volver
          </button>
        </div>
      )}

      {modo === "MOVE" && (
        <div className="space-y-2">
          {locations.map((l) => (
            <button
              key={l.id}
              type="button"
              disabled={pending}
              onClick={() => run(() => qrMoveLot(lot.lot_id, l.id))}
              className={`${btn} border border-[var(--ink)]/20 text-left`}
            >
              {l.name}
              {l.kind === "FREEZER" && " ❄"}
            </button>
          ))}
          <button type="button" onClick={() => setModo("NONE")} className={`${btn} border border-[var(--ink)]/20`}>
            Volver
          </button>
        </div>
      )}

      <Link href="/pantry" className="mt-auto text-center text-sm text-[var(--accent)] underline">
        Ver despensa completa
      </Link>
    </main>
  );
}
