"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { qrDiscardLot, qrMoveLot, qrUpdateWeight, qrUseLot, reprintLabel } from "@/app/prep/actions";
import { Button, ButtonOutline, Chip, ErrorNote, Icon, Notice } from "@/components/ui";

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

/** Campo de formulario del kit, en tamaño cocina: se escribe con el pulgar. */
const FIELD =
  "mt-xs min-h-[56px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-headline-sm text-headline-sm tabular-nums text-on-surface";

/**
 * Descartar es destructivo y el kit no trae ese tono de botón: se arma acá con
 * los mismos tokens (nunca con rojos sueltos de Tailwind).
 */
const ACCION_PELIGRO =
  "inline-flex w-full items-center justify-center gap-sm rounded-full border border-error px-lg py-3 font-body-md text-body-sm font-semibold text-error transition-transform active:scale-95 disabled:opacity-40";

/** Fila-botón de ubicación: el nombre a la izquierda, la seña de frío a la derecha. */
const ACCION_UBICACION =
  "inline-flex w-full items-center justify-between gap-sm rounded-2xl border border-outline-variant px-lg py-3 font-body-md text-body-sm font-semibold text-on-surface transition-transform active:scale-95 disabled:opacity-40";

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

  return (
    <main className="mx-auto flex min-h-dvh max-w-[36rem] flex-col gap-md px-container-margin py-xl">
      <header className="text-center">
        <p className="font-label-md text-label-md text-outline">
          {lot.package_code ?? "paquete"}
        </p>
        <h1 className="mt-xs font-headline-lg-mobile text-headline-lg-mobile text-on-surface">
          {lot.label}
        </h1>
        <p className="mt-xs font-body-lg text-body-lg text-on-surface-variant">
          <span className="tabular-nums">
            {lot.quantity} {unidad}
          </span>{" "}
          ·{" "}
          {lot.temperature_state === "FROZEN"
            ? "congelado"
            : lot.temperature_state === "CHILLED"
              ? "refrigerado"
              : "ambiente"}
        </p>
        {lot.intended_use_date && !vinculoRoto && (
          <p className="mt-xs font-body-sm text-body-sm text-on-surface-variant">
            Para el {lot.intended_use_date}
          </p>
        )}
        {vinculoRoto && (
          <div className="mt-sm text-left">
            <Notice icon="link_off">
              Este paquete ya no está asignado a una comida (el plan cambió). Sigue disponible como
              stock: úsalo cuando quieras o vuelve a asignarlo.
            </Notice>
          </div>
        )}
        {lot.use_by && (
          <div className="mt-sm text-left">
            <Notice icon="schedule">
              <span className="font-semibold">Usar antes de {lot.use_by}</span>
            </Notice>
          </div>
        )}
        {cerrado && (
          <div className="mt-sm flex justify-center">
            <Chip tono="peligro" icon="block">
              Este lote ya está {lot.status.toLowerCase()}
            </Chip>
          </div>
        )}
      </header>

      {message && (
        <p className="flex items-start justify-center gap-sm rounded-2xl bg-primary-fixed px-md py-sm text-center font-body-sm text-body-sm text-on-primary-fixed">
          <Icon name="check_circle" className="mt-0.5 shrink-0 text-[18px]" />
          <span className="min-w-0">{message}</span>
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      {!cerrado && modo === "NONE" && (
        <div className="space-y-sm">
          <Button full disabled={pending} onClick={() => run(() => qrUseLot(lot.lot_id, null))}>
            <Icon name="done_all" className="text-[18px]" />
            Lo usé completo
          </Button>
          <ButtonOutline
            disabled={pending}
            onClick={() => setModo("PARTIAL")}
            className="w-full py-3"
          >
            <Icon name="content_cut" className="text-[18px]" />
            Usé una parte
          </ButtonOutline>
          <ButtonOutline
            disabled={pending}
            onClick={() => setModo("MOVE")}
            className="w-full py-3"
          >
            <Icon name="swap_horiz" className="text-[18px]" />
            Mover / descongelar
          </ButtonOutline>
          <ButtonOutline
            disabled={pending}
            onClick={() => setModo("WEIGHT")}
            className="w-full py-3"
          >
            <Icon name="scale" className="text-[18px]" />
            Corregir peso
          </ButtonOutline>
          <ButtonOutline
            disabled={pending}
            onClick={() => run(() => reprintLabel(lot.lot_id))}
            className="w-full py-3"
          >
            <Icon name="print" className="text-[18px]" />
            Reimprimir etiqueta
          </ButtonOutline>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(() =>
                qrDiscardLot(
                  lot.lot_id,
                  lot.processing_state === "COOKED" ? "DISCARDED_LEFTOVER" : "SPOILED",
                ),
              )
            }
            className={ACCION_PELIGRO}
          >
            <Icon name="delete" className="text-[18px]" />
            Se echó a perder
          </button>
        </div>
      )}

      {(modo === "PARTIAL" || modo === "WEIGHT") && (
        <div className="space-y-sm">
          <label className="block font-body-sm text-body-sm font-semibold text-on-surface-variant">
            {modo === "PARTIAL" ? `¿Cuánto usaste? (${unidad})` : `Peso real ahora (${unidad})`}
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
              className={FIELD}
              autoFocus
            />
          </label>
          <Button
            full
            disabled={pending}
            onClick={() => {
              const n = Number(cantidad);
              if (!Number.isFinite(n)) {
                setError("Revisa el número.");
                return;
              }
              run(() => (modo === "PARTIAL" ? qrUseLot(lot.lot_id, n) : qrUpdateWeight(lot.lot_id, n)));
            }}
          >
            <Icon name="check" className="text-[18px]" />
            Confirmar
          </Button>
          <ButtonOutline onClick={() => setModo("NONE")} className="w-full py-3">
            Volver
          </ButtonOutline>
        </div>
      )}

      {modo === "MOVE" && (
        <div className="space-y-sm">
          {locations.map((l) => (
            <button
              key={l.id}
              type="button"
              disabled={pending}
              onClick={() => run(() => qrMoveLot(lot.lot_id, l.id))}
              className={ACCION_UBICACION}
            >
              <span className="min-w-0 truncate text-left">{l.name}</span>
              {l.kind === "FREEZER" && (
                <Icon name="ac_unit" className="shrink-0 text-[18px] text-tertiary" />
              )}
            </button>
          ))}
          <ButtonOutline onClick={() => setModo("NONE")} className="w-full py-3">
            Volver
          </ButtonOutline>
        </div>
      )}

      <Link
        href="/pantry"
        className="mt-auto inline-flex items-center justify-center gap-sm pt-lg font-body-sm text-body-sm font-semibold text-primary"
      >
        <Icon name="inventory_2" className="text-[18px]" />
        Ver despensa completa
      </Link>
    </main>
  );
}
