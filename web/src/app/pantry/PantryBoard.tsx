"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { expiryInfo, fefoOrder, type PantryLot } from "@/domain/inventory/fefo";
import { formatQuantity } from "@/domain/shopping/engine";
import { formatDate } from "@/domain/nutrition/calendar";
import {
  Button,
  ButtonOutline,
  Card,
  Chip,
  Flotante,
  Icon,
  Notice,
  Section,
} from "@/components/ui";
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

const KIND_ICONS: Record<StorageLocation["kind"], string> = {
  PANTRY: "shelves",
  FRIDGE: "kitchen",
  FREEZER: "ac_unit",
  OTHER: "inventory_2",
};

const DISCARD_REASONS = [
  { value: "SPOILED", label: "Se echó a perder" },
  { value: "EXPIRED", label: "Venció" },
  { value: "DAMAGED", label: "Se dañó" },
  { value: "DISCARDED_LEFTOVER", label: "Sobra que no se comió" },
] as const;

/** Campo de formulario del kit: mismo alto de toque en todos lados. */
const FIELD =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";


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
    <div>
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      {desajustes.length > 0 && (
        <Section title="Desajustes de inventario">
          <Card className="space-y-sm p-md">
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Estas comidas consumieron más de lo que la despensa tenía registrado. El consumo
              declarado no se tocó: decide tú qué pasó con la diferencia.
            </p>
            <ul className="space-y-sm">
              {desajustes.map((d) => (
                <li
                  key={d.id}
                  className="rounded-2xl bg-error-container px-md py-sm text-on-error-container"
                >
                  <p className="font-body-sm text-body-sm">
                    <strong className="font-semibold">{d.label}</strong>: faltaron{" "}
                    {formatQuantity(d.quantity, d.unit)}
                    {d.weightBasis === "COOKED" && " (cocido)"}
                    {d.servingDate && <span> · {formatDate(d.servingDate)}</span>}
                  </p>
                  <div className="mt-sm flex flex-wrap gap-sm">
                    <ButtonOutline
                      disabled={pending}
                      onClick={() => run(() => resolveShortfall(d.id, "RESOLVED_ADJUSTMENT"))}
                    >
                      Ya ajusté el inventario
                    </ButtonOutline>
                    <ButtonOutline
                      disabled={pending}
                      onClick={() => run(() => resolveShortfall(d.id, "ACCEPTED_UNTRACED"))}
                    >
                      Dejar como consumo no trazado
                    </ButtonOutline>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}

      {porVencer.length > 0 && (
        <Section className="mb-lg">
          <Notice icon="schedule">
            <p className="font-semibold">Para usar pronto</p>
            <ul className="mt-sm space-y-1">
              {porVencer.slice(0, 5).map((l) => {
                const info = expiryInfo(l, today);
                return (
                  <li key={l.id} className="flex justify-between gap-sm">
                    <span className="min-w-0 truncate">
                      {l.label} · {formatQuantity(l.quantity, l.unit)}
                    </span>
                    <span className="shrink-0 font-semibold">
                      {info.state === "EXPIRED" && "vencido"}
                      {info.state === "USE_TODAY" && "usar hoy"}
                      {info.state === "SOON" &&
                        `en ${info.days} ${info.days === 1 ? "día" : "días"}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Notice>
        </Section>
      )}

      {pantry.locations.length === 0 && (
        <div className="mb-lg">
          <Button full disabled={pending} onClick={() => run(() => ensureLocations())}>
            <Icon name="add_home" className="text-[18px]" />
            Crear despensa, refrigerador y congelador
          </Button>
        </div>
      )}

      {pantry.locations.map((loc) => {
        const lots = porUbicacion.get(loc.id) ?? [];
        return (
          <Ubicacion
            key={loc.id}
            icon={KIND_ICONS[loc.kind]}
            titulo={loc.name}
            detalle={loc.name !== KIND_LABELS[loc.kind] ? KIND_LABELS[loc.kind] : null}
            cantidad={lots.length}
          >
            {lots.length === 0 ? (
              <p className="px-md pb-md font-body-sm text-body-sm text-outline">Vacío.</p>
            ) : (
              <ul className="space-y-sm px-md pb-md">
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
          </Ubicacion>
        );
      })}

      {porUbicacion.has(null) && (
        <Ubicacion
          icon="help"
          titulo="Sin ubicación"
          detalle={null}
          cantidad={porUbicacion.get(null)!.length}
        >
          <ul className="space-y-sm px-md pb-md">
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
        </Ubicacion>
      )}

      <Card className="mt-lg p-md">
        {!altaAbierta ? (
          <button
            type="button"
            onClick={() => setAltaAbierta(true)}
            className="flex w-full items-center justify-center gap-sm rounded-2xl border border-dashed border-outline px-lg py-md font-body-md text-body-md font-semibold text-primary transition-transform active:scale-[0.99]"
          >
            <Icon name="add" className="text-[20px]" />
            Agregar algo a la despensa
          </button>
        ) : (
          <AltaManual
            locations={pantry.locations}
            ingredientes={ingredientes}
            pending={pending}
            onSave={run}
            onCancel={() => setAltaAbierta(false)}
          />
        )}
      </Card>
    </div>
  );
}

/** Tarjeta de una ubicación de guardado, con su cabecera y sus lotes. */
function Ubicacion({
  icon,
  titulo,
  detalle,
  cantidad,
  children,
}: {
  icon: string;
  titulo: string;
  detalle: string | null;
  cantidad: number;
  children: React.ReactNode;
}) {
  return (
    <Card as="section" className="mb-md overflow-hidden">
      <div className="flex items-center gap-sm p-md">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container text-primary">
          <Icon name={icon} filled />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-headline-sm text-headline-sm text-on-surface">{titulo}</h3>
          {detalle && (
            <p className="font-body-sm text-body-sm text-on-surface-variant">{detalle}</p>
          )}
        </div>
        <Chip>
          {cantidad} {cantidad === 1 ? "lote" : "lotes"}
        </Chip>
      </div>
      {children}
    </Card>
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
    <li className="rounded-2xl bg-surface-container-low">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={abierto}
        className="w-full px-md py-sm text-left"
      >
        <span className="flex items-center justify-between gap-sm">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate font-body-md text-body-md text-on-surface">
              {lot.label}
            </span>
            {lot.processingState === "COOKED" && (
              <Chip icon="local_fire_department">cocinado</Chip>
            )}
            {lot.temperatureState === "FROZEN" && (
              <Chip tono="info" icon="ac_unit">
                congelado
              </Chip>
            )}
          </span>
          <span className="shrink-0 font-body-md text-body-md font-semibold text-on-surface">
            {formatQuantity(lot.quantity, lot.unit)}
          </span>
        </span>
        <span className="mt-0.5 block font-body-sm text-body-sm text-on-surface-variant">
          {info.state === "NO_DATE" && "sin fecha de vencimiento"}
          {info.state === "EXPIRED" && <span className="text-error">vencido</span>}
          {info.state === "USE_TODAY" && (
            <span className="text-on-secondary-fixed-variant">usar hoy</span>
          )}
          {info.state === "SOON" && (
            <span className="text-on-secondary-fixed-variant">
              vence en {info.days} {info.days === 1 ? "día" : "días"}
            </span>
          )}
          {info.state === "OK" && `vence el ${formatDate((lot.useBy ?? lot.expiryDate)!)}`}
        </span>
      </button>

      {abierto && (
        <div className="space-y-sm border-t border-outline-variant/40 px-md py-md">
          {!ajustando ? (
            <div className="flex flex-wrap items-center gap-sm">
              <ButtonOutline
                disabled={pending}
                onClick={() => {
                  setCantidad(String(lot.quantity));
                  setAjustando(true);
                }}
              >
                <Icon name="scale" className="text-[18px]" />
                Ajustar cantidad
              </ButtonOutline>
              <select
                disabled={pending}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) run(() => moveLot(lot.id, e.target.value));
                }}
                className="rounded-full border border-outline bg-surface-container-lowest px-md py-sm font-body-sm text-body-sm text-on-surface-variant disabled:opacity-40"
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
                className="rounded-full border border-error-container bg-surface-container-lowest px-md py-sm font-body-sm text-body-sm text-error disabled:opacity-40"
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
                  className="inline-flex items-center gap-sm rounded-full bg-error px-lg py-sm font-body-md text-body-sm font-semibold text-on-error transition-transform active:scale-95 disabled:opacity-40"
                >
                  <Icon name="delete" className="text-[18px]" />
                  Confirmar descarte
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-sm">
              <input
                type="number"
                min="0"
                step="any"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                className="w-28 rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface"
                aria-label="Cantidad real que queda"
              />
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                {lot.unit === "G" ? "g" : lot.unit === "ML" ? "ml" : "unidades"}
              </span>
              <Button
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
              >
                Guardar
              </Button>
              <ButtonOutline onClick={() => setAjustando(false)}>Cancelar</ButtonOutline>
              {cantidad.trim() === "0" && (
                <p className="w-full font-body-sm text-body-sm text-on-secondary-fixed-variant">
                  El lote quedará en 0 y saldrá de la despensa.
                </p>
              )}
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
  onSave,
  onCancel,
}: {
  locations: StorageLocation[];
  ingredientes: { id: string; name: string }[];
  pending: boolean;
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
    <div className="space-y-sm">
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Algo que llegó sin pasar por la lista: una compra de feria, un regalo, una sobra.
      </p>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Tomates de la feria"
        className={FIELD}
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
        className={FIELD}
        aria-label="Vincular a un alimento del catálogo"
      >
        <option value="">Sin vincular al catálogo (no contará para la lista de compras)</option>
        {ingredientes.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <div className="flex gap-sm">
        <input
          type="number"
          min="0"
          step="any"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          placeholder="Cantidad"
          className={FIELD}
        />
        <select value={unidad} onChange={(e) => setUnidad(e.target.value as "G")} className={FIELD}>
          <option value="G">gramos</option>
          <option value="ML">ml</option>
          <option value="UNIT">unidades</option>
        </select>
      </div>
      <div className="flex gap-sm">
        <select value={ubicacion} onChange={(e) => setUbicacion(e.target.value)} className={FIELD}>
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
          className={FIELD}
          aria-label="Fecha de vencimiento (opcional)"
        />
      </div>
      <div className="flex gap-sm">
        <ButtonOutline className="flex-1" onClick={onCancel}>
          Cancelar
        </ButtonOutline>
        <Button
          className="flex-1"
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
        >
          Agregar
        </Button>
      </div>
    </div>
  );
}
