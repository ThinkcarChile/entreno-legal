"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PrepPreference } from "@/domain/prep/types";
import { saveEquipment, saveEquipmentConfig, savePrepPreference } from "../actions";
import type { EquipmentView } from "../queries";

const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-sm";

export function EquipmentBoard({
  equipment,
  preferences,
  ingredientes,
}: {
  equipment: EquipmentView[];
  preferences: PrepPreference[];
  ingredientes: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [nuevoNombre, setNuevoNombre] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cCap, setCCap] = useState("CUT_SHRED");
  const [cTam, setCTam] = useState("");
  const [cTanda, setCTanda] = useState("");

  const [pIng, setPIng] = useState("");
  const [pTipo, setPTipo] = useState("SHRED");
  const [pTam, setPTam] = useState("");
  const [pCapId, setPCapId] = useState("");
  const [pManual, setPManual] = useState("");

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

  const todasConfigs = equipment.flatMap((e) => e.configs);

  return (
    <div className="space-y-5">
      {message && (
        <p className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm text-white shadow-lg">
          {message}
        </p>
      )}
      {error && (
        <p className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-red-600 px-4 py-2.5 text-sm text-white shadow-lg" role="alert">
          {error}
        </p>
      )}

      {/* ---- Equipos ---- */}
      <section className="space-y-2">
        {equipment.map((e) => (
          <div key={e.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">
                {e.name}
                {!e.isActive && <span className="ml-2 text-xs text-[var(--ink)]/40">(inactivo)</span>}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => saveEquipment({ id: e.id, name: e.name, notes: e.notes, isActive: !e.isActive }))}
                  className="rounded-full border border-[var(--ink)]/20 px-4 py-2.5 text-xs disabled:opacity-50"
                >
                  {e.isActive ? "Desactivar" : "Activar"}
                </button>
                <button
                  type="button"
                  onClick={() => setAbierto(abierto === e.id ? null : e.id)}
                  className="rounded-full border border-[var(--accent)] px-4 py-2.5 text-xs font-medium text-[var(--accent)]"
                >
                  {abierto === e.id ? "Cerrar" : "Agregar configuración"}
                </button>
              </div>
            </div>

            {e.configs.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {e.configs.map((c) => (
                  <li key={c.id} className="rounded-full bg-[var(--paper)] px-2.5 py-1 text-[10px] text-[var(--ink)]/70">
                    {c.capability}
                    {(c.params as { size_mm?: number }).size_mm != null && <> {(c.params as { size_mm?: number }).size_mm} mm</>}
                    {c.maxBatchQuantity != null && <> · máx {c.maxBatchQuantity} g/tanda</>}
                  </li>
                ))}
              </ul>
            )}

            {abierto === e.id && (
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-[var(--ink)]/10 p-3">
                <label className="text-xs text-[var(--ink)]/60">
                  Capacidad (código libre)
                  <input value={cCap} onChange={(ev) => setCCap(ev.target.value)} placeholder="CUT_SHRED" className={`${field} mt-1`} />
                </label>
                <label className="text-xs text-[var(--ink)]/60">
                  Tamaño mm (opcional)
                  <input type="number" min="0" step="any" value={cTam} onChange={(ev) => setCTam(ev.target.value)} className={`${field} mt-1`} />
                </label>
                <label className="text-xs text-[var(--ink)]/60">
                  Máx. por tanda en g (opcional)
                  <input type="number" min="0" step="any" value={cTanda} onChange={(ev) => setCTanda(ev.target.value)} className={`${field} mt-1`} />
                </label>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if ([cTam, cTanda].some((x) => x.trim() !== "" && !Number.isFinite(Number(x)))) {
                      setError("Revisa los números.");
                      return;
                    }
                    run(
                      () =>
                        saveEquipmentConfig({
                          equipmentId: e.id,
                          capability: cCap,
                          sizeMm: cTam.trim() === "" ? null : Number(cTam),
                          maxBatchQuantity: cTanda.trim() === "" ? null : Number(cTanda),
                        }),
                      () => {
                        setCTam("");
                        setCTanda("");
                      },
                    );
                  }}
                  className="self-end rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  Guardar
                </button>
              </div>
            )}
          </div>
        ))}

        <div className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-4">
          <p className="mb-2 text-sm font-semibold">Nuevo equipo</p>
          <div className="flex gap-2">
            <input value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} placeholder="Cortadora de verduras" className={field} />
            <button
              type="button"
              disabled={pending || nuevoNombre.trim() === ""}
              onClick={() =>
                run(
                  () => saveEquipment({ name: nuevoNombre, notes: null, isActive: true }),
                  () => setNuevoNombre(""),
                )
              }
              className="shrink-0 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Agregar
            </button>
          </div>
        </div>
      </section>

      {/* ---- Preferencias por alimento ---- */}
      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <p className="text-sm font-semibold">Cómo preparar cada alimento</p>
        <p className="mb-2 text-xs text-[var(--ink)]/60">
          El motor SOLO sugiere cortes que tú declares acá — jamás inventa.
        </p>
        {preferences.length > 0 && (
          <ul className="mb-3 space-y-1">
            {preferences.map((p) => (
              <li key={p.ingredientId + p.taskType} className="rounded-xl bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink)]/70">
                <strong className="text-[var(--ink)]">
                  {ingredientes.find((i) => i.id === p.ingredientId)?.name ?? "(alimento)"}
                </strong>{" "}
                — {p.taskType}
                {(p.params as { size_mm?: number }).size_mm != null && <> {(p.params as { size_mm?: number }).size_mm} mm</>}
                {p.manualAlternative && <> · manual: {p.manualAlternative}</>}
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-[var(--ink)]/60">
            Alimento
            <select value={pIng} onChange={(e) => setPIng(e.target.value)} className={`${field} mt-1`}>
              <option value="">Elige…</option>
              {ingredientes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--ink)]/60">
            Preparación
            <select value={pTipo} onChange={(e) => setPTipo(e.target.value)} className={`${field} mt-1`}>
              {["WASH", "PEEL", "TRIM", "CUT", "SHRED", "SLICE", "DICE"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--ink)]/60">
            Tamaño mm (opcional)
            <input type="number" min="0" step="any" value={pTam} onChange={(e) => setPTam(e.target.value)} className={`${field} mt-1`} />
          </label>
          <label className="text-xs text-[var(--ink)]/60">
            Con el equipo (opcional)
            <select value={pCapId} onChange={(e) => setPCapId(e.target.value)} className={`${field} mt-1`}>
              <option value="">A mano</option>
              {todasConfigs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.equipmentName}: {c.capability}
                  {(c.params as { size_mm?: number }).size_mm != null ? ` ${(c.params as { size_mm?: number }).size_mm} mm` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs text-[var(--ink)]/60">
            Alternativa manual (§12 — siempre existe)
            <input value={pManual} onChange={(e) => setPManual(e.target.value)} placeholder="rallador manual" className={`${field} mt-1`} />
          </label>
        </div>
        <button
          type="button"
          disabled={pending || pIng === ""}
          onClick={() => {
            if (pTam.trim() !== "" && !Number.isFinite(Number(pTam))) {
              setError("Revisa el tamaño.");
              return;
            }
            run(
              () =>
                savePrepPreference({
                  ingredientId: pIng,
                  taskType: pTipo,
                  sizeMm: pTam.trim() === "" ? null : Number(pTam),
                  capabilityId: pCapId || null,
                  manualAlternative: pManual || null,
                }),
              () => {
                setPIng("");
                setPTam("");
                setPCapId("");
                setPManual("");
              },
            );
          }}
          className="mt-2 w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Guardar preferencia
        </button>
      </section>
    </div>
  );
}
