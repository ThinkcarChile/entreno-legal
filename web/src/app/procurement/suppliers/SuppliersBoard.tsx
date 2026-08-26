"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IsoWeekday } from "@/domain/procurement/types";
import { savePurchasePolicy, saveSupplier, saveSupplierProduct } from "../actions";
import type { ProcurementConfig } from "../queries";
import {
  Button,
  ButtonOutline,
  Card,
  Chip,
  EmptyState,
  Flotante,
  Icon,
  Section,
} from "@/components/ui";

/**
 * Configuración de abastecimiento: proveedores, sus presentaciones y la
 * política de compra por alimento. Sin frecuencias universales.
 */

const DIAS: { n: IsoWeekday; t: string }[] = [
  { n: 1, t: "L" },
  { n: 2, t: "M" },
  { n: 3, t: "X" },
  { n: 4, t: "J" },
  { n: 5, t: "V" },
  { n: 6, t: "S" },
  { n: 7, t: "D" },
];

/** Campo de formulario del kit: mismo alto de toque en todas las pantallas. */
const FIELD =
  "min-h-[48px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

/** Etiqueta de campo del kit. */
function Etiqueta({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
      {children}
    </span>
  );
}


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
    <div>
      <Etiqueta>{label}</Etiqueta>
      <div className="flex flex-wrap gap-xs">
        {DIAS.map((d) => {
          const on = value.includes(d.n);
          return (
            <button
              key={d.n}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== d.n) : [...value, d.n].sort())}
              className={`h-9 w-9 rounded-full font-body-sm text-body-sm font-semibold transition-transform active:scale-90 ${
                on
                  ? "bg-primary text-on-primary"
                  : "border border-outline-variant text-on-surface-variant"
              }`}
            >
              {d.t}
            </button>
          );
        })}
      </div>
      <p className="mt-xs font-label-md text-label-md text-outline">Sin marcar = cualquier día.</p>
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
    <div>
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      {/* ---- Proveedores y sus presentaciones ---- */}
      <Section title="Proveedores">
        {config.suppliers.length === 0 && (
          <div className="mb-sm">
            <EmptyState icon="storefront">
              Todavía no hay proveedores. Agrega el primero acá abajo.
            </EmptyState>
          </div>
        )}

        <div className="space-y-sm">
          {config.suppliers.map((s) => {
            const presentaciones = config.supplierProducts.filter((p) => p.supplierId === s.id);
            const abiertoAca = abierto === s.id;
            return (
              <Card key={s.id} as="section" className="p-md">
                <div className="flex items-start gap-sm">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-surface-container-high text-primary">
                    <Icon name="storefront" className="text-[28px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-headline-sm text-headline-sm text-on-surface">
                      {s.name}
                    </h3>
                    {s.contact && (
                      <p className="truncate font-body-sm text-body-sm text-on-surface-variant">
                        {s.contact}
                      </p>
                    )}
                    <div className="mt-xs">
                      <Chip
                        tono={s.isActive ? "primario" : "neutro"}
                        icon={s.isActive ? "check_circle" : "pause_circle"}
                      >
                        {s.isActive ? "activo" : "inactivo"}
                      </Chip>
                    </div>
                  </div>
                </div>

                <div className="mt-md flex flex-wrap gap-sm">
                  <ButtonOutline
                    disabled={pending}
                    onClick={() =>
                      run(() => saveSupplier({ id: s.id, name: s.name, contact: s.contact, isActive: !s.isActive }))
                    }
                  >
                    <Icon name={s.isActive ? "pause" : "play_arrow"} className="text-[18px]" />
                    {s.isActive ? "Desactivar" : "Activar"}
                  </ButtonOutline>
                  <ButtonOutline onClick={() => setAbierto(abiertoAca ? null : s.id)}>
                    <Icon name={abiertoAca ? "close" : "add"} className="text-[18px]" />
                    {abiertoAca ? "Cerrar" : "Agregar presentación"}
                  </ButtonOutline>
                </div>

                {presentaciones.length > 0 && (
                  <ul className="mt-sm space-y-xs">
                    {presentaciones.map((p) => (
                      <li
                        key={p.id}
                        className="rounded-xl bg-surface-container-low px-md py-sm font-body-sm text-body-sm text-on-surface-variant"
                      >
                        <strong className="font-semibold text-on-surface">
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
                  <div className="mt-md space-y-sm rounded-2xl border border-outline-variant p-md">
                    <div className="grid grid-cols-1 gap-sm sm:grid-cols-2">
                      <label className="block min-w-0 sm:col-span-2">
                        <Etiqueta>Alimento</Etiqueta>
                        <select value={pIngrediente} onChange={(e) => setPIngrediente(e.target.value)} className={FIELD}>
                          <option value="">Elige…</option>
                          {ingredientes.map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block min-w-0">
                        <Etiqueta>Presentación</Etiqueta>
                        <input
                          value={pPresentacion}
                          onChange={(e) => setPPresentacion(e.target.value)}
                          placeholder="caja 5 kg"
                          className={FIELD}
                        />
                      </label>
                      <label className="block min-w-0">
                        <Etiqueta>Cantidad por presentación</Etiqueta>
                        <div className="flex gap-sm">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={pCantidad}
                            onChange={(e) => setPCantidad(e.target.value)}
                            className={FIELD}
                          />
                          <select
                            value={pUnidad}
                            onChange={(e) => setPUnidad(e.target.value as "G" | "ML" | "UNIT")}
                            className={`${FIELD} w-28`}
                            aria-label="Unidad"
                          >
                            <option value="G">g</option>
                            <option value="ML">ml</option>
                            <option value="UNIT">unid.</option>
                          </select>
                        </div>
                      </label>
                      <label className="block min-w-0">
                        <Etiqueta>Base de la cantidad</Etiqueta>
                        <select
                          value={pBase}
                          onChange={(e) => setPBase(e.target.value as "RAW" | "DRAINED")}
                          className={FIELD}
                        >
                          <option value="RAW">Tal como se compra (crudo)</option>
                          <option value="DRAINED">Peso escurrido (conservas)</option>
                        </select>
                      </label>
                      <label className="block min-w-0">
                        <Etiqueta>Pedido mínimo (opcional)</Etiqueta>
                        <input type="number" min="0" step="any" value={pMinimo} onChange={(e) => setPMinimo(e.target.value)} className={FIELD} />
                      </label>
                      <label className="block min-w-0">
                        <Etiqueta>Múltiplo de compra (opcional)</Etiqueta>
                        <input type="number" min="0" step="any" value={pMultiplo} onChange={(e) => setPMultiplo(e.target.value)} className={FIELD} />
                      </label>
                      <label className="block min-w-0">
                        <Etiqueta>Días de espera (lead time)</Etiqueta>
                        <input type="number" min="0" max="60" value={pEspera} onChange={(e) => setPEspera(e.target.value)} className={FIELD} />
                      </label>
                    </div>
                    <DiasPicker value={pDias} onChange={setPDias} label="Días en que entrega" />
                    <Button
                      full
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
                    >
                      <Icon name="save" className="text-[18px]" />
                      Guardar presentación
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}

          {/* Alta de proveedor */}
          <Card className="border border-dashed border-outline p-md">
            <p className="mb-sm font-headline-sm text-headline-sm text-on-surface">Nuevo proveedor</p>
            <div className="grid grid-cols-1 gap-sm sm:grid-cols-2">
              <label className="block min-w-0">
                <Etiqueta>Nombre</Etiqueta>
                <input
                  value={nuevoNombre}
                  onChange={(e) => setNuevoNombre(e.target.value)}
                  placeholder="Verdulería de la esquina"
                  className={FIELD}
                />
              </label>
              <label className="block min-w-0">
                <Etiqueta>Contacto (opcional)</Etiqueta>
                <input
                  value={nuevoContacto}
                  onChange={(e) => setNuevoContacto(e.target.value)}
                  placeholder="Teléfono o correo"
                  className={FIELD}
                />
              </label>
            </div>
            <div className="mt-sm">
              <Button
                full
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
              >
                <Icon name="add" className="text-[18px]" />
                Agregar proveedor
              </Button>
            </div>
          </Card>
        </div>
      </Section>

      {/* ---- Política de compra por alimento ---- */}
      <Section
        title="Política de compra por alimento"
        hint="Sin frecuencias universales: cada alimento puede tener su proveedor preferido y sus días."
      >
        <Card className="p-md">
          {config.policies.length > 0 && (
            <ul className="mb-md space-y-xs">
              {config.policies.map((p) => (
                <li
                  key={p.ingredientId}
                  className="rounded-xl bg-surface-container-low px-md py-sm font-body-sm text-body-sm text-on-surface-variant"
                >
                  <strong className="font-semibold text-on-surface">
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

          <div className="space-y-sm">
            <div className="grid grid-cols-1 gap-sm sm:grid-cols-2">
              <label className="block min-w-0">
                <Etiqueta>Alimento</Etiqueta>
                <select value={polIngrediente} onChange={(e) => setPolIngrediente(e.target.value)} className={FIELD}>
                  <option value="">Elige…</option>
                  {ingredientes.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0">
                <Etiqueta>Proveedor preferido</Etiqueta>
                <select value={polProveedor} onChange={(e) => setPolProveedor(e.target.value)} className={FIELD}>
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
            <DiasPicker
              value={polRecepcion}
              onChange={setPolRecepcion}
              label="Días en que el hogar puede RECIBIR"
            />
            <Button
              full
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
            >
              <Icon name="save" className="text-[18px]" />
              Guardar política
            </Button>
          </div>
        </Card>
      </Section>
    </div>
  );
}
