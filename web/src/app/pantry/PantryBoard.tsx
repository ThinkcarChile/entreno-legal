"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { expiryInfo, fefoOrder, type PantryLot } from "@/domain/inventory/fefo";
import { formatQuantity } from "@/domain/shopping/engine";
import { formatDate } from "@/domain/nutrition/calendar";
import type { PantryData, Shortfall, StorageLocation } from "./queries";
import {
  addManualLot,
  adjustLot,
  discardLot,
  ensureLocations,
  moveLot,
  resolveShortfall,
} from "./actions";

/**
 * El tablero de la despensa: lotes por ubicación en orden FEFO, con el
 * vencimiento a la vista. Ajustar, mover y descartar son movimientos del
 * libro mayor — nada se edita a mano.
 */

const KIND_LABELS: Record<StorageLocation["kind"], string> = {
  PANTRY: "Despensa",
  FRIDGE: "Refrigerador",
  FREEZER: "Congelador",
  OTHER: "Otro",
};

const DISCARD_REASONS = [
  { value: "SPOILED", label: "Se echó a perder" },
  { value: "EXPIRED", label: "Venció" },
  { value: "DAMAGED", label: "Se dañó" },
  { value: "DISCARDED_LEFTOVER", label: "Sobra que no se comió" },
] as const;

export function PantryBoard({
  pantry,
  today,
  ingredientes,
  desajustes,
}: {
  pantry: PantryData;
  today: string;
  /** Para vincular el alta manual a un alimento del catálogo. */
  ingredientes: { id: string; name: string }[];
  /** La comida declaró más de lo que la despensa tenía (hotfix Sprint 7). */
  desajustes: Shortfall[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [altaAbierta, setAltaAbierta] = useState(false);

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo completar.");
        return;
      }
      if (result.message) setMessage(result.message);
      setAbierto(null);
      router.refresh();
    });
  }

  const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";

  // Lo que vence primero, arriba de todo: es el aviso que evita botar comida.
  const porVencer = fefoOrder(pantry.lots).filter((l) => {
    const info = expiryInfo(l, today);
    return info.state === "EXPIRED" || info.state === "USE_TODAY" || info.state === "SOON";
  });

  const porUbicacion = new Map<string | null, PantryLot[]>();
  for (const lot of fefoOrder(pantry.lots)) {
    porUbicacion.set(lot.locationId, [...(porUbicacion.get(lot.locationId) ?? []), lot]);
  }

  return (
    <div className="space-y-3">
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

      {desajustes.length > 0 && (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-3">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-900">
            Desajustes de inventario
          </h2>
          <p className="mb-2 text-[11px] text-red-800">
            Estas comidas consumieron más de lo que la despensa tenía registrado. El consumo
            declarado no se tocó: decide tú qué pasó con la diferencia.
          </p>
          <ul className="space-y-2">
            {desajustes.map((d) => (
              <li key={d.id} className="rounded-xl bg-white/70 px-3 py-2 text-xs">
                <p className="mb-1">
                  <strong>{d.label}</strong>: faltaron {formatQuantity(d.quantity, d.unit)}
                  {d.weightBasis === "COOKED" && " (cocido)"}
                  {d.servingDate && (
                    <span className="text-red-800/70"> · {formatDate(d.servingDate)}</span>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => resolveShortfall(d.id, "RESOLVED_ADJUSTMENT"))}
                    className="rounded-full border border-red-300 px-3 py-1 disabled:opacity-50"
                  >
                    Ya ajusté el inventario
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => resolveShortfall(d.id, "ACCEPTED_UNTRACED"))}
                    className="rounded-full border border-red-300 px-3 py-1 disabled:opacity-50"
                  >
                    Dejar como consumo no trazado
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {porVencer.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-900">
            Para usar pronto
          </h2>
          <ul className="space-y-0.5 text-xs text-amber-900">
            {porVencer.slice(0, 5).map((l) => {
              const info = expiryInfo(l, today);
              return (
                <li key={l.id} className="flex justify-between gap-2">
                  <span>
                    {l.label} · {formatQuantity(l.quantity, l.unit)}
                  </span>
                  <span className="shrink-0 font-medium">
                    {info.state === "EXPIRED" && "vencido"}
                    {info.state === "USE_TODAY" && "usar hoy"}
                    {info.state === "SOON" && `en ${info.days} ${info.days === 1 ? "día" : "días"}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {pantry.locations.length === 0 && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => ensureLocations())}
          className="w-full rounded-full bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Crear despensa, refrigerador y congelador
        </button>
      )}

      {pantry.locations.map((loc) => {
        const lots = porUbicacion.get(loc.id) ?? [];
        return (
          <section key={loc.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-3">
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink)]/50">
              {loc.name}
              {loc.name !== KIND_LABELS[loc.kind] && (
                <span className="ml-1 font-normal normal-case">({KIND_LABELS[loc.kind]})</span>
              )}
            </h2>
            {lots.length === 0 ? (
              <p className="px-1 pb-1 text-xs text-[var(--ink)]/40">Vacío.</p>
            ) : (
              <ul className="space-y-1">
                {lots.map((lot) => (
                  <LotRow
                    key={lot.id}
                    lot={lot}
                    today={today}
                    locations={pantry.locations}
                    abierto={abierto === lot.id}
                    onToggle={() => setAbierto(abierto === lot.id ? null : lot.id)}
                    pending={pending}
                    run={run}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {porUbicacion.has(null) && (
        <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-3">
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink)]/50">
            Sin ubicación
          </h2>
          <ul className="space-y-1">
            {porUbicacion.get(null)!.map((lot) => (
              <LotRow
                key={lot.id}
                lot={lot}
                today={today}
                locations={pantry.locations}
                abierto={abierto === lot.id}
                onToggle={() => setAbierto(abierto === lot.id ? null : lot.id)}
                pending={pending}
                run={run}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-4">
        {!altaAbierta ? (
          <button
            type="button"
            onClick={() => setAltaAbierta(true)}
            className="w-full rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)]"
          >
            + Agregar algo a la despensa
          </button>
        ) : (
          <AltaManual
            locations={pantry.locations}
            ingredientes={ingredientes}
            pending={pending}
            field={field}
            onSave={run}
            onCancel={() => setAltaAbierta(false)}
          />
        )}
      </section>
    </div>
  );
}

function LotRow({
  lot,
  today,
  locations,
  abierto,
  onToggle,
  pending,
  run,
}: {
  lot: PantryLot;
  today: string;
  locations: StorageLocation[];
  abierto: boolean;
  onToggle: () => void;
  pending: boolean;
  run: (a: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [ajustando, setAjustando] = useState(false);
  const [cantidad, setCantidad] = useState("");
  const [causaDescarte, setCausaDescarte] = useState("");
  const info = expiryInfo(lot, today);

  return (
    <li className="rounded-xl border border-[var(--ink)]/10">
      <button type="button" onClick={onToggle} className="w-full px-3 py-2 text-left">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm">
            {lot.label}
            {lot.processingState === "COOKED" && (
              <span className="ml-1.5 rounded-full bg-[var(--ink)]/10 px-1.5 py-0.5 text-[9px]">
                cocinado
              </span>
            )}
            {lot.temperatureState === "FROZEN" && (
              <span className="ml-1.5 rounded-full bg-sky-100 px-1.5 py-0.5 text-[9px] text-sky-900">
                congelado
              </span>
            )}
          </p>
          <span className="shrink-0 text-sm font-medium">{formatQuantity(lot.quantity, lot.unit)}</span>
        </div>
        <p className="text-xs text-[var(--ink)]/50">
          {info.state === "NO_DATE" && "sin fecha de vencimiento"}
          {info.state === "EXPIRED" && <span className="text-red-700">vencido</span>}
          {info.state === "USE_TODAY" && <span className="text-amber-800">usar hoy</span>}
          {info.state === "SOON" && (
            <span className="text-amber-800">
              vence en {info.days} {info.days === 1 ? "día" : "días"}
            </span>
          )}
          {info.state === "OK" && `vence el ${formatDate((lot.useBy ?? lot.expiryDate)!)}`}
        </p>
      </button>

      {abierto && (
        <div className="space-y-2 border-t border-[var(--ink)]/10 px-3 py-3 text-xs">
          {!ajustando ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setCantidad(String(lot.quantity));
                  setAjustando(true);
                }}
                className="rounded-full border border-[var(--ink)]/20 px-3 py-1.5 disabled:opacity-50"
              >
                Ajustar cantidad
              </button>
              <select
                disabled={pending}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) run(() => moveLot(lot.id, e.target.value));
                }}
                className="rounded-full border border-[var(--ink)]/20 bg-white px-3 py-1.5 disabled:opacity-50"
                aria-label="Mover a otra ubicación"
              >
                <option value="">Mover a…</option>
                {locations
                  .filter((l) => l.id !== lot.locationId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
              <select
                disabled={pending}
                value={causaDescarte}
                onChange={(e) => setCausaDescarte(e.target.value)}
                className="rounded-full border border-red-200 bg-white px-3 py-1.5 text-red-700 disabled:opacity-50"
                aria-label="Causa del descarte"
              >
                <option value="">Descartar…</option>
                {DISCARD_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              {causaDescarte !== "" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    run(() => discardLot(lot.id, causaDescarte as "SPOILED"));
                    setCausaDescarte("");
                  }}
                  className="rounded-full bg-red-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                >
                  Confirmar descarte
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="any"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                className="w-28 rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-1.5"
                aria-label="Cantidad real que queda"
              />
              <span className="text-[var(--ink)]/50">
                {lot.unit === "G" ? "g" : lot.unit === "ML" ? "ml" : "unidades"}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  // Vacío NO es cero: dejar el campo en blanco no vacía el lote.
                  const texto = cantidad.trim();
                  if (texto === "") return;
                  const n = Number(texto);
                  if (!Number.isFinite(n) || n < 0) return;
                  run(() => adjustLot(lot.id, n));
                  setAjustando(false);
                }}
                className="rounded-full bg-[var(--accent)] px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Guardar
              </button>
              {cantidad.trim() === "0" && (
                <span className="text-amber-800">El lote quedará en 0 y saldrá de la despensa.</span>
              )}
              <button type="button" onClick={() => setAjustando(false)} className="underline">
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function AltaManual({
  locations,
  ingredientes,
  pending,
  field,
  onSave,
  onCancel,
}: {
  locations: StorageLocation[];
  ingredientes: { id: string; name: string }[];
  pending: boolean;
  field: string;
  onSave: (a: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [unidad, setUnidad] = useState<"G" | "ML" | "UNIT">("G");
  const [ubicacion, setUbicacion] = useState("");
  const [vence, setVence] = useState("");
  const [ingrediente, setIngrediente] = useState("");

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--ink)]/60">
        Algo que llegó sin pasar por la lista: una compra de feria, un regalo, una sobra.
      </p>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Tomates de la feria"
        className={field}
      />
      <select
        value={ingrediente}
        onChange={(e) => {
          setIngrediente(e.target.value);
          // Si aún no hay nombre, el del catálogo sirve de etiqueta.
          if (!label.trim() && e.target.value) {
            const opcion = ingredientes.find((i) => i.id === e.target.value);
            if (opcion) setLabel(opcion.name);
          }
        }}
        className={field}
        aria-label="Vincular a un alimento del catálogo"
      >
        <option value="">Sin vincular al catálogo (no contará para la lista de compras)</option>
        {ingredientes.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <input
          type="number"
          min="0"
          step="any"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad"
          className={field}
        />
        <select
          value={unidad}
          onChange={(e) => setUnidad(e.target.value as "G")}
          className={field}
        >
          <option value="G">gramos</option>
          <option value="ML">ml</option>
          <option value="UNIT">unidades</option>
        </select>
      </div>
      <div className="flex gap-2">
        <select value={ubicacion} onChange={(e) => setUbicacion(e.target.value)} className={field}>
          <option value="">Ubicación…</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={vence}
          onChange={(e) => setVence(e.target.value)}
          className={field}
          aria-label="Fecha de vencimiento (opcional)"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-full border border-[var(--ink)]/20 px-4 py-2 text-sm"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            onSave(async () => {
              const r = await addManualLot({
                label,
                quantity: Number(cantidad),
                unit: unidad,
                ingredientId: ingrediente || null,
                locationId: ubicacion || null,
                expiryDate: vence || null,
              });
              if (r.ok) {
                setLabel("");
                setCantidad("");
                setVence("");
                onCancel();
              }
              return r;
            })
          }
          className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Agregar
        </button>
      </div>
    </div>
  );
}
