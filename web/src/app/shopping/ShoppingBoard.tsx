"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDate } from "@/domain/nutrition/calendar";
import {
  formatQuantity,
  groupForCategory,
  SHOPPING_GROUPS,
  type DemandDelta,
} from "@/domain/shopping/engine";
import { MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import type { ShoppingItem, ShoppingListData } from "./queries";
import {
  addManualItem,
  completeList,
  editPlannedQuantity,
  previewDeltas,
  regenerateList,
  removeManualItem,
  reopenList,
  setItemStatus,
} from "./actions";

/**
 * El checklist de la compra. Cada línea sabe explicar de dónde salió (§16, §17)
 * y nada se actualiza en silencio: si la planificación cambió, primero se
 * muestran los deltas y la persona decide (§34).
 */

const STATUS_LABELS: Record<ShoppingItem["status"], string> = {
  PENDING: "Pendiente",
  PURCHASED: "Comprado",
  SKIPPED: "No lo llevo",
  HAVE_ENOUGH: "Ya lo tengo",
};

export function ShoppingBoard({
  weekStart,
  lista,
  unconfirmed,
  desactualizada,
  demandaDisponible,
}: {
  weekStart: string;
  lista: ShoppingListData | null;
  unconfirmed: { date: string; mealType: MealType; recipeName: string | null }[];
  desactualizada: boolean;
  demandaDisponible: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<DemandDelta[] | null>(null);
  const [manualAbierto, setManualAbierto] = useState(false);

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
      setDeltas(null);
      router.refresh();
    });
  }

  const items = lista?.items ?? [];
  const resueltos = items.filter((i) => i.status !== "PENDING").length;
  const completada = lista?.status === "COMPLETED";

  // Secciones por categoría del catálogo (§18). Manuales sin categoría → Otros.
  const porGrupo = new Map<string, ShoppingItem[]>();
  for (const item of items) {
    const grupo = groupForCategory(item.categoryCode);
    porGrupo.set(grupo, [...(porGrupo.get(grupo) ?? []), item]);
  }

  const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";

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

      {unconfirmed.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p>
            <strong>
              {unconfirmed.length === 1
                ? "Falta 1 comida por confirmar"
                : `Faltan ${unconfirmed.length} comidas por confirmar`}
            </strong>
            . La lista incluye solo lo confirmado; confirma el resto para completar la compra.
          </p>
          <ul className="mt-1 list-inside list-disc">
            {unconfirmed.slice(0, 4).map((u, i) => (
              <li key={i}>
                {formatDate(u.date)} · {MEAL_TYPE_LABELS[u.mealType]}
                {u.recipeName && <> · {u.recipeName}</>}
              </li>
            ))}
            {unconfirmed.length > 4 && <li>y {unconfirmed.length - 4} más…</li>}
          </ul>
          <Link href={`/plan?semana=${weekStart}`} className="mt-1 inline-block underline">
            Ir a la semana
          </Link>
        </div>
      )}

      {desactualizada && !completada && (
        <div className="rounded-2xl border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-3 text-sm">
          <p className="font-medium">Tu planificación cambió.</p>
          {deltas === null ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await previewDeltas(weekStart);
                  if (!r.ok) {
                    setError(r.error ?? "No se pudieron calcular los cambios.");
                    return;
                  }
                  setDeltas(r.deltas ?? []);
                })
              }
              className="mt-2 rounded-full border border-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent)]"
            >
              Revisar cambios
            </button>
          ) : (
            <div className="mt-2 space-y-2">
              {deltas.length === 0 ? (
                <p className="text-xs text-[var(--ink)]/60">
                  Las cantidades finales no cambian.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {deltas.map((d) => (
                    <li key={d.key} className="flex justify-between gap-2">
                      <span>{d.label}</span>
                      <span
                        className={
                          d.kind === "REMOVED" || d.kind === "QUANTITY_DECREASED"
                            ? "text-[var(--ink)]/60"
                            : "font-medium text-[var(--accent)]"
                        }
                      >
                        {d.kind === "ADDED" && `+${formatQuantity(d.after ?? 0, d.unit)} (nuevo)`}
                        {d.kind === "REMOVED" && `−${formatQuantity(d.before ?? 0, d.unit)} (sale)`}
                        {(d.kind === "QUANTITY_INCREASED" || d.kind === "QUANTITY_DECREASED") &&
                          `${d.difference > 0 ? "+" : "−"}${formatQuantity(Math.abs(d.difference), d.unit)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => regenerateList(weekStart))}
                  className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
                >
                  Actualizar lista
                </button>
                <button
                  type="button"
                  onClick={() => setDeltas(null)}
                  className="flex-1 rounded-full border border-[var(--ink)]/20 px-4 py-2 text-xs"
                >
                  Mantener lista actual
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {(!lista || lista.currentRevision === 0) && (
        <div className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-6 text-center">
          {demandaDisponible ? (
            <>
              <p className="mb-3 text-sm text-[var(--ink)]/70">
                Hay comidas confirmadas esta semana. Genera la lista para saber exactamente qué
                comprar.
              </p>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => regenerateList(weekStart))}
                className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Generar lista de compras
              </button>
            </>
          ) : (
            <p className="text-sm text-[var(--ink)]/60">
              Todavía no hay comidas confirmadas esta semana. Confirma porciones en la pestaña
              Semana y la lista se arma sola desde ahí.
            </p>
          )}
        </div>
      )}

      {lista && lista.currentRevision > 0 && (
        <>
          <div className="flex items-center justify-between rounded-2xl border border-[var(--ink)]/10 bg-white px-4 py-3">
            <p className="text-sm">
              <strong>
                {resueltos} / {items.length}
              </strong>{" "}
              productos
              {completada && (
                <span className="ml-2 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] text-[var(--accent)]">
                  compra finalizada
                </span>
              )}
            </p>
            <span className="text-[10px] text-[var(--ink)]/40">revisión {lista.currentRevision}</span>
          </div>

          {SHOPPING_GROUPS.filter((g) => porGrupo.has(g.code)).map((grupo) => (
            <section key={grupo.code} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-3">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink)]/50">
                {grupo.name}
              </h2>
              <ul className="space-y-1">
                {porGrupo.get(grupo.code)!.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    abierto={abierto === item.id}
                    onToggle={() => setAbierto(abierto === item.id ? null : item.id)}
                    pending={pending || completada}
                    run={run}
                  />
                ))}
              </ul>
            </section>
          ))}

          {!completada && (
            <section className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-4">
              {!manualAbierto ? (
                <button
                  type="button"
                  onClick={() => setManualAbierto(true)}
                  className="w-full rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)]"
                >
                  + Agregar producto
                </button>
              ) : (
                <ManualForm
                  listId={lista.id}
                  pending={pending}
                  field={field}
                  onSave={run}
                  onCancel={() => setManualAbierto(false)}
                />
              )}
            </section>
          )}

          {completada ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => reopenList(lista.id))}
              className="w-full rounded-full border border-[var(--ink)]/20 px-4 py-2.5 text-sm"
            >
              Reabrir compra
            </button>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => completeList(lista.id))}
              className="w-full rounded-full bg-[var(--ink)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Finalizar compra
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ItemRow({
  item,
  abierto,
  onToggle,
  pending,
  run,
}: {
  item: ShoppingItem;
  abierto: boolean;
  onToggle: () => void;
  pending: boolean;
  run: (a: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [cantidad, setCantidad] = useState("");

  const necesario = item.requiredQuantity;
  const comprar = item.plannedQuantity ?? item.requiredQuantity;
  const resuelto = item.status !== "PENDING";

  return (
    <li className="rounded-xl border border-[var(--ink)]/10">
      <div className="flex items-center gap-3 px-3 py-2">
        <input
          type="checkbox"
          className="size-5 shrink-0 accent-[var(--accent)]"
          checked={item.status === "PURCHASED"}
          disabled={pending}
          onChange={(e) =>
            run(() => setItemStatus(item.id, e.target.checked ? "PURCHASED" : "PENDING"))
          }
          aria-label={`Marcar ${item.label} como comprado`}
        />
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
          <p className={`truncate text-sm ${resuelto ? "text-[var(--ink)]/40 line-through" : ""}`}>
            {item.label}
            {item.source === "MANUAL" && (
              <span className="ml-1.5 rounded-full bg-[var(--ink)]/10 px-1.5 py-0.5 text-[9px] no-underline">
                manual
              </span>
            )}
          </p>
          <p className="text-xs text-[var(--ink)]/50">
            {comprar !== null ? formatQuantity(comprar, item.unit) : "sin cantidad"}
            {item.plannedQuantity !== null &&
              item.requiredQuantity !== null &&
              item.plannedQuantity !== item.requiredQuantity && (
                <span className="ml-1 text-[var(--ink)]/40">
                  (calculado: {formatQuantity(item.requiredQuantity, item.unit)})
                </span>
              )}
            {item.unresolved && (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-900">
                falta rendimiento
              </span>
            )}
            {item.status !== "PENDING" && item.status !== "PURCHASED" && (
              <span className="ml-1.5 text-[var(--ink)]/40">· {STATUS_LABELS[item.status]}</span>
            )}
          </p>
        </button>
      </div>

      {abierto && (
        <div className="space-y-2 border-t border-[var(--ink)]/10 px-3 py-3 text-xs">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <p>
              <span className="text-[var(--ink)]/50">Necesario:</span>{" "}
              {necesario !== null ? formatQuantity(necesario, item.unit) : "—"}
            </p>
            <p>
              <span className="text-[var(--ink)]/50">Comprar:</span>{" "}
              {comprar !== null ? formatQuantity(comprar, item.unit) : "—"}
            </p>
            {item.cookedQuantity !== null && (
              <p>
                <span className="text-[var(--ink)]/50">Cocido que se sirve:</span>{" "}
                {formatQuantity(item.cookedQuantity, item.unit)}
                {item.yieldFactor && (
                  <span className="text-[var(--ink)]/40"> (rendimiento ×{item.yieldFactor})</span>
                )}
              </p>
            )}
          </div>

          {item.unresolvedReason && (
            <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-amber-900">{item.unresolvedReason}</p>
          )}

          {item.provenance.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-[var(--ink)]/60">¿Por qué necesito esto?</p>
              <ul className="space-y-0.5">
                {item.provenance.map((p, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="capitalize">
                      {formatDate(p.date)} · {MEAL_TYPE_LABELS[p.mealType] ?? p.mealType}
                      <span className="text-[var(--ink)]/40"> · {p.members.join(", ")}</span>
                    </span>
                    <span className="shrink-0 font-medium">{formatQuantity(p.quantity, item.unit)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!editando ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setCantidad(comprar !== null ? String(comprar) : "");
                  setEditando(true);
                }}
                className="rounded-full border border-[var(--ink)]/20 px-3 py-1.5 disabled:opacity-50"
              >
                Editar cantidad
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => setItemStatus(item.id, "HAVE_ENOUGH"))}
                className="rounded-full border border-[var(--ink)]/20 px-3 py-1.5 disabled:opacity-50"
              >
                Ya lo tengo
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => setItemStatus(item.id, "SKIPPED"))}
                className="rounded-full border border-[var(--ink)]/20 px-3 py-1.5 disabled:opacity-50"
              >
                No lo llevo
              </button>
              {item.status !== "PENDING" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => setItemStatus(item.id, "PENDING"))}
                  className="rounded-full border border-[var(--ink)]/20 px-3 py-1.5 disabled:opacity-50"
                >
                  Volver a pendiente
                </button>
              )}
              {item.source === "MANUAL" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => removeManualItem(item.id))}
                  className="rounded-full border border-red-200 px-3 py-1.5 text-red-700 disabled:opacity-50"
                >
                  Quitar
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 pt-1">
              <input
                type="number"
                min="0"
                step="any"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                placeholder="vacío = calculada"
                className="w-28 rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-1.5"
                aria-label="Cantidad a comprar (vacío vuelve a la calculada)"
              />
              <span className="text-[var(--ink)]/50">
                {item.unit === "G" ? "g" : item.unit === "ML" ? "ml" : "unidades"}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  // Vacío = volver a la cantidad calculada. Un "" convertido a
                  // Number daría 0, y comprar 0 por accidente es otra cosa.
                  const texto = cantidad.trim();
                  const n = texto === "" ? null : Number(texto);
                  if (n !== null && !Number.isFinite(n)) return;
                  run(() => editPlannedQuantity(item.id, n));
                  setEditando(false);
                }}
                className="rounded-full bg-[var(--accent)] px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Guardar
              </button>
              <button type="button" onClick={() => setEditando(false)} className="underline">
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ManualForm({
  listId,
  pending,
  field,
  onSave,
  onCancel,
}: {
  listId: string;
  pending: boolean;
  field: string;
  onSave: (a: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [unidad, setUnidad] = useState<"UNIT" | "G" | "ML">("UNIT");

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--ink)]/60">
        Algo que no sale de las recetas: detergente, papel, bolsas. Va aparte de lo calculado.
      </p>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Detergente"
        className={field}
      />
      <div className="flex gap-2">
        <input
          type="number"
          min="0"
          step="any"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad (opcional)"
          className={field}
        />
        <select
          value={unidad}
          onChange={(e) => setUnidad(e.target.value as "UNIT")}
          className={field}
        >
          <option value="UNIT">unidades</option>
          <option value="G">gramos</option>
          <option value="ML">ml</option>
        </select>
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
              const n = cantidad.trim() === "" ? null : Number(cantidad);
              const r = await addManualItem(listId, label, n, unidad);
              if (r.ok) {
                setLabel("");
                setCantidad("");
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
