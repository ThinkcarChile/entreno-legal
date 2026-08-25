"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IsoWeekday } from "@/domain/procurement/types";
import { savePurchasePolicy, saveSupplier, saveSupplierProduct } from "../actions";
import type { ProcurementConfig } from "../queries";

const DIAS: { n: IsoWeekday; t: string }[] = [
  { n: 1, t: "L" },
  { n: 2, t: "M" },
  { n: 3, t: "X" },
  { n: 4, t: "J" },
  { n: 5, t: "V" },
  { n: 6, t: "S" },
  { n: 7, t: "D" },
];

const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-sm";

function DiasPicker({
  value,
  onChange,
  label,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  label: string;
}) {
  return (
    <div className="text-xs text-[var(--ink)]/60">
      {label}
      <div className="mt-1 flex gap-1">
        {DIAS.map((d) => {
          const on = value.includes(d.n);
          return (
            <button
              key={d.n}
              type="button"
              onClick={() => onChange(on ? value.filter((x) => x !== d.n) : [...value, d.n].sort())}
              className={`size-8 rounded-full text-xs font-medium ${
                on ? "bg-[var(--accent)] text-white" : "border border-[var(--ink)]/20 text-[var(--ink)]/60"
              }`}
            >
              {d.t}
            </button>
          );
        })}
      </div>
      <p className="mt-0.5 text-[10px] text-[var(--ink)]/40">Sin marcar = cualquier día.</p>
    </div>
  );
}

export function SuppliersBoard({
  config,
  ingredientes,
}: {
  config: ProcurementConfig;
  ingredientes: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Alta de proveedor
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoContacto, setNuevoContacto] = useState("");

  // Alta de presentación (por proveedor abierto)
  const [abierto, setAbierto] = useState<string | null>(null);
  const [pIngrediente, setPIngrediente] = useState("");
  const [pPresentacion, setPPresentacion] = useState("");
  const [pCantidad, setPCantidad] = useState("");
  const [pUnidad, setPUnidad] = useState<"G" | "ML" | "UNIT">("G");
  const [pBase, setPBase] = useState<"RAW" | "DRAINED">("RAW");
  const [pMinimo, setPMinimo] = useState("");
  const [pMultiplo, setPMultiplo] = useState("");
  const [pEspera, setPEspera] = useState("0");
  const [pDias, setPDias] = useState<number[]>([]);

  // Política por alimento
  const [polIngrediente, setPolIngrediente] = useState("");
  const [polProveedor, setPolProveedor] = useState("");
  const [polPedido, setPolPedido] = useState<number[]>([]);
  const [polRecepcion, setPolRecepcion] = useState<number[]>([]);

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

  const num = (s: string) => (s.trim() === "" ? null : Number(s.trim()));
  const numerosInvalidos = (...campos: string[]) =>
    campos.some((c) => c.trim() !== "" && !Number.isFinite(Number(c)));

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

      {/* ---- Proveedores y sus presentaciones ---- */}
      <section className="space-y-2">
        {config.suppliers.map((s) => {
          const presentaciones = config.supplierProducts.filter((p) => p.supplierId === s.id);
          const abiertoAca = abierto === s.id;
          return (
            <div key={s.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {s.name}
                    {!s.isActive && <span className="ml-2 text-xs text-[var(--ink)]/40">(inactivo)</span>}
                  </p>
                  {s.contact && <p className="text-xs text-[var(--ink)]/60">{s.contact}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(() => saveSupplier({ id: s.id, name: s.name, contact: s.contact, isActive: !s.isActive }))
                    }
                    className="rounded-full border border-[var(--ink)]/20 px-4 py-2.5 text-xs disabled:opacity-50"
                  >
                    {s.isActive ? "Desactivar" : "Activar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAbierto(abiertoAca ? null : s.id)}
                    className="rounded-full border border-[var(--accent)] px-4 py-2.5 text-xs font-medium text-[var(--accent)]"
                  >
                    {abiertoAca ? "Cerrar" : "Agregar presentación"}
                  </button>
                </div>
              </div>

              {presentaciones.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {presentaciones.map((p) => (
                    <li key={p.id} className="rounded-xl bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink)]/70">
                      <strong className="text-[var(--ink)]">
                        {ingredientes.find((i) => i.id === p.ingredientId)?.name ?? "(alimento)"}
                      </strong>{" "}
                      — {p.presentation} ({p.packageQuantity} {p.unit === "G" ? "g" : p.unit === "ML" ? "ml" : "u"}
                      {p.weightBasis === "DRAINED" ? " escurridos" : ""})
                      {p.minimumOrderQuantity != null && <> · mínimo {p.minimumOrderQuantity}</>}
                      {p.purchaseMultiple != null && <> · múltiplos de {p.purchaseMultiple}</>}
                      {p.leadTimeDays > 0 && <> · espera {p.leadTimeDays} día(s)</>}
                      {p.deliveryDays && (
                        <> · entrega {p.deliveryDays.map((d) => DIAS.find((x) => x.n === d)?.t).join("/")}</>
                      )}
                      {!p.isActive && <> · (inactiva)</>}
                    </li>
                  ))}
                </ul>
              )}

              {abiertoAca && (
                <div className="mt-3 space-y-2 rounded-xl border border-[var(--ink)]/10 p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="col-span-2 text-xs text-[var(--ink)]/60">
                      Alimento
                      <select value={pIngrediente} onChange={(e) => setPIngrediente(e.target.value)} className={`${field} mt-1`}>
                        <option value="">Elige…</option>
                        {ingredientes.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-[var(--ink)]/60">
                      Presentación
                      <input
                        value={pPresentacion}
                        onChange={(e) => setPPresentacion(e.target.value)}
                        placeholder="caja 5 kg"
                        className={`${field} mt-1`}
                      />
                    </label>
                    <label className="text-xs text-[var(--ink)]/60">
                      Cantidad por presentación
                      <div className="mt-1 flex gap-1">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={pCantidad}
                          onChange={(e) => setPCantidad(e.target.value)}
                          className={field}
                        />
                        <select
                          value={pUnidad}
                          onChange={(e) => setPUnidad(e.target.value as "G" | "ML" | "UNIT")}
                          className={`${field} w-24`}
                        >
                          <option value="G">g</option>
                          <option value="ML">ml</option>
                          <option value="UNIT">unid.</option>
                        </select>
                      </div>
                    </label>
                    <label className="text-xs text-[var(--ink)]/60">
                      Base de la cantidad
                      <select
                        value={pBase}
                        onChange={(e) => setPBase(e.target.value as "RAW" | "DRAINED")}
                        className={`${field} mt-1`}
                      >
                        <option value="RAW">Tal como se compra (crudo)</option>
                        <option value="DRAINED">Peso escurrido (conservas)</option>
                      </select>
                    </label>
                    <label className="text-xs text-[var(--ink)]/60">
                      Pedido mínimo (opcional)
                      <input type="number" min="0" step="any" value={pMinimo} onChange={(e) => setPMinimo(e.target.value)} className={`${field} mt-1`} />
                    </label>
                    <label className="text-xs text-[var(--ink)]/60">
                      Múltiplo de compra (opcional)
                      <input type="number" min="0" step="any" value={pMultiplo} onChange={(e) => setPMultiplo(e.target.value)} className={`${field} mt-1`} />
                    </label>
                    <label className="text-xs text-[var(--ink)]/60">
                      Días de espera (lead time)
                      <input type="number" min="0" max="60" value={pEspera} onChange={(e) => setPEspera(e.target.value)} className={`${field} mt-1`} />
                    </label>
                  </div>
                  <DiasPicker value={pDias} onChange={setPDias} label="Días en que entrega" />
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (!pIngrediente) {
                        setError("Elige el alimento.");
                        return;
                      }
                      if (numerosInvalidos(pCantidad, pMinimo, pMultiplo, pEspera) || num(pCantidad) === null) {
                        setError("Revisa los números: hay un valor que no se entiende.");
                        return;
                      }
                      run(
                        () =>
                          saveSupplierProduct({
                            supplierId: s.id,
                            ingredientId: pIngrediente,
                            presentation: pPresentacion.trim() || `${pCantidad} ${pUnidad}`,
                            packageQuantity: Number(pCantidad),
                            unit: pUnidad,
                            weightBasis: pBase,
                            price: null,
                            minimumOrderQuantity: num(pMinimo),
                            purchaseMultiple: num(pMultiplo),
                            leadTimeDays: Number(pEspera || 0),
                            deliveryDays: pDias.length > 0 ? pDias : null,
                            priority: 100,
                            isActive: true,
                          }),
                        () => {
                          setPIngrediente("");
                          setPPresentacion("");
                          setPCantidad("");
                          setPMinimo("");
                          setPMultiplo("");
                          setPEspera("0");
                          setPBase("RAW");
                          setPDias([]);
                        },
                      );
                    }}
                    className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Guardar presentación
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* Alta de proveedor */}
        <div className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-4">
          <p className="mb-2 text-sm font-semibold">Nuevo proveedor</p>
          <div className="grid grid-cols-2 gap-2">
            <input value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} placeholder="Nombre" className={field} />
            <input value={nuevoContacto} onChange={(e) => setNuevoContacto(e.target.value)} placeholder="Contacto (opcional)" className={field} />
          </div>
          <button
            type="button"
            disabled={pending || nuevoNombre.trim() === ""}
            onClick={() =>
              run(
                () => saveSupplier({ name: nuevoNombre, contact: nuevoContacto || null, isActive: true }),
                () => {
                  setNuevoNombre("");
                  setNuevoContacto("");
                },
              )
            }
            className="mt-2 w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Agregar proveedor
          </button>
        </div>
      </section>

      {/* ---- Política de compra por alimento ---- */}
      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <p className="text-sm font-semibold">Política de compra por alimento</p>
        <p className="mb-2 text-xs text-[var(--ink)]/60">
          Sin frecuencias universales: cada alimento puede tener su proveedor preferido y sus días.
        </p>
        {config.policies.length > 0 && (
          <ul className="mb-3 space-y-1">
            {config.policies.map((p) => (
              <li key={p.ingredientId} className="rounded-xl bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink)]/70">
                <strong className="text-[var(--ink)]">
                  {ingredientes.find((i) => i.id === p.ingredientId)?.name ?? "(alimento)"}
                </strong>
                {p.preferredSupplierId && (
                  <> · prefiere {config.suppliers.find((s) => s.id === p.preferredSupplierId)?.name ?? "?"}</>
                )}
                {p.orderDays && <> · pide {p.orderDays.map((d) => DIAS.find((x) => x.n === d)?.t).join("/")}</>}
                {p.receiveDays && <> · recibe {p.receiveDays.map((d) => DIAS.find((x) => x.n === d)?.t).join("/")}</>}
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-[var(--ink)]/60">
              Alimento
              <select value={polIngrediente} onChange={(e) => setPolIngrediente(e.target.value)} className={`${field} mt-1`}>
                <option value="">Elige…</option>
                {ingredientes.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[var(--ink)]/60">
              Proveedor preferido
              <select value={polProveedor} onChange={(e) => setPolProveedor(e.target.value)} className={`${field} mt-1`}>
                <option value="">Sin preferencia</option>
                {config.suppliers
                  .filter((s) => s.isActive)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <DiasPicker value={polPedido} onChange={setPolPedido} label="Días en que el hogar PIDE" />
          <DiasPicker value={polRecepcion} onChange={setPolRecepcion} label="Días en que el hogar puede RECIBIR" />
          <button
            type="button"
            disabled={pending || polIngrediente === ""}
            onClick={() =>
              run(
                () =>
                  savePurchasePolicy({
                    ingredientId: polIngrediente,
                    preferredSupplierId: polProveedor || null,
                    orderDays: polPedido.length > 0 ? polPedido : null,
                    receiveDays: polRecepcion.length > 0 ? polRecepcion : null,
                  }),
                () => {
                  setPolIngrediente("");
                  setPolProveedor("");
                  setPolPedido([]);
                  setPolRecepcion([]);
                },
              )
            }
            className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Guardar política
          </button>
        </div>
      </section>
    </div>
  );
}
