"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProcurementStatus, PurchaseScheduleResult, PurchaseSuggestion } from "@/domain/procurement/types";
import { advanceOrder, approveSuggestion, receiveOrder } from "./actions";
import type { OrderView } from "./queries";
import { effectiveDate } from "@/domain/nutrition/calendar";
import {
  Button,
  ButtonOutline,
  Card,
  Chip,
  EmptyState,
  Flotante,
  Icon,
  Notice,
  Section,
  type Tono,
} from "@/components/ui";

/**
 * Tablero de abastecimiento (§19): próximos pedidos · necesita acción ·
 * en camino · recibidos. El motor propone; aprobar, pedir y recibir siempre
 * lo toca una persona.
 */

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

/** El color acompaña al texto del chip, nunca lo reemplaza (accesibilidad §94). */
const ESTADO_TONO: Record<ProcurementStatus, Tono> = {
  SUGGESTED: "neutro",
  PLANNED: "neutro",
  ORDERED: "info",
  READY: "primario",
  DELIVERING: "info",
  RECEIVED: "primario",
  STORED: "primario",
  CANCELLED: "peligro",
};

const CONFIDENCE_LABELS = { LOW: "baja", MEDIUM: "media", HIGH: "alta" } as const;

function unidad(u: "G" | "ML" | "UNIT"): string {
  return u === "G" ? "g" : u === "ML" ? "ml" : "unidades";
}

function cantidad(n: number, u: "G" | "ML" | "UNIT"): string {
  const texto = Number.isInteger(n) ? n.toLocaleString("es-CL") : n.toLocaleString("es-CL", { maximumFractionDigits: 1 });
  return `${texto} ${unidad(u)}`;
}


/** Advertencia del motor: se mira, no bloquea. */
function Advertencia({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-xs flex items-start gap-xs font-body-sm text-body-sm text-on-secondary-fixed-variant">
      <Icon name="warning" className="mt-0.5 shrink-0 text-[16px]" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Etiqueta de logística: una fecha con su icono, en píldora. */
function Logistica({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 font-label-md text-label-md text-on-surface">
      <Icon name={icon} className="text-[16px] text-on-surface-variant" />
      {children}
    </span>
  );
}

export function ProcurementBoard({
  plan,
  orders,
  today,
  timeZone,
}: {
  plan: PurchaseScheduleResult;
  orders: OrderView[];
  today: string;
  timeZone: string;
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
    `${s.ingredientId}:${s.weightBasis}:${s.orderDate ?? ""}:${s.suggestedOrderQuantity}:${s.supplierProductId ?? ""}`;
  const baseTexto = (b: string) => (b === "DRAINED" ? " (escurrido)" : "");

  return (
    <div>
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      {/* ---- Próximos pedidos ---- */}
      <Section title="Próximos pedidos sugeridos">
        {proximos.length === 0 ? (
          <EmptyState icon="shopping_cart_checkout">
            Nada que pedir por ahora. Cuando el stock no alcance, la sugerencia aparece acá con
            fechas y proveedor.
          </EmptyState>
        ) : (
          <ul className="space-y-md">
            {proximos.map((s) => {
              const clave = claveSug(s);
              const aprobada = aprobadas.has(clave);
              return (
                <Card as="li" key={clave} className="p-md">
                  <div className="flex flex-wrap items-start justify-between gap-sm">
                    <p className="min-w-0 font-body-lg text-body-lg font-semibold text-on-surface">
                      {s.label}
                      {baseTexto(s.weightBasis)}
                    </p>
                    {s.supplierName && <Chip icon="storefront">{s.supplierName}</Chip>}
                  </div>

                  {/* Cuánto pide el motor y por qué esa cifra */}
                  <div className="mt-sm rounded-lg bg-surface-container p-md">
                    <div className="flex items-start justify-between gap-sm">
                      <div className="min-w-0">
                        <p className="font-label-md text-label-md uppercase text-on-surface-variant">
                          Necesitas
                        </p>
                        <p className="font-headline-sm text-headline-sm text-on-surface">
                          {cantidad(s.requiredQuantity, s.unit)}
                        </p>
                      </div>
                      <Icon name="arrow_forward" className="mt-md shrink-0 text-outline" />
                      <div className="min-w-0 text-right">
                        <p className="font-label-md text-label-md uppercase text-primary">
                          Sugerido
                        </p>
                        <p className="font-headline-sm text-headline-sm text-primary">
                          {cantidad(s.suggestedOrderQuantity, s.unit)}
                        </p>
                      </div>
                    </div>
                    {s.packageCount != null && s.presentation && (
                      <div className="mt-sm flex items-center gap-sm border-t border-outline-variant/30 pt-sm">
                        <Icon name="info" className="shrink-0 text-[18px] text-outline" />
                        <p className="font-body-sm text-body-sm text-on-surface-variant">
                          {s.packageCount} × {s.presentation}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="mt-sm flex flex-wrap gap-sm">
                    <Logistica icon="shopping_cart_checkout">pedir el {s.orderDate}</Logistica>
                    <Logistica icon="local_shipping">llega el {s.expectedDeliveryDate}</Logistica>
                  </div>

                  <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
                    en casa {cantidad(s.onHand, s.unit)}
                    {s.incoming > 0 && <> · en camino {cantidad(s.incoming, s.unit)}</>}
                    {s.pendingInList > 0 && <> · en la lista {cantidad(s.pendingInList, s.unit)}</>}
                    {s.coverageAfterDays != null && <> · cobertura al recibir ~{s.coverageAfterDays} días</>}
                    {s.confidence && <> · confianza {CONFIDENCE_LABELS[s.confidence]}</>}
                  </p>

                  {s.warnings.map((w) => (
                    <Advertencia key={w}>{w}</Advertencia>
                  ))}

                  <div className="mt-md flex flex-wrap gap-sm">
                    <Button
                      className="flex-1"
                      disabled={pending || aprobada}
                      onClick={() =>
                        run(
                          () => approveSuggestion(s),
                          () => setAprobadas((prev) => new Set([...prev, clave])),
                        )
                      }
                    >
                      <Icon name={aprobada ? "check_circle" : "check"} filled={aprobada} className="text-[18px]" />
                      {aprobada ? "Planificada" : "Aprobar pedido"}
                    </Button>
                    <ButtonOutline
                      onClick={() => setAbierta(abierta === clave ? null : clave)}
                    >
                      <Icon name="help" className="text-[18px]" />
                      ¿Por qué?
                    </ButtonOutline>
                  </div>

                  {abierta === clave && (
                    <ol className="mt-sm space-y-1 rounded-xl bg-surface-container-low p-md font-body-sm text-body-sm text-on-surface-variant">
                      {s.provenance.map((p, i) => (
                        <li key={i}>
                          <strong className="font-semibold text-on-surface">{p.step}:</strong>{" "}
                          {p.detail}
                        </li>
                      ))}
                      <li className="pt-1 font-label-md text-label-md text-outline">
                        {s.engineVersion}
                      </li>
                    </ol>
                  )}
                </Card>
              );
            })}
          </ul>
        )}
      </Section>

      {/* ---- Necesita acción ---- */}
      {plan.unresolved.length > 0 && (
        <Section>
          <Notice icon="warning">
            <p className="font-semibold">
              {plan.unresolved.length}{" "}
              {plan.unresolved.length === 1
                ? "necesidad no se pudo evaluar"
                : "necesidades no se pudieron evaluar"}
            </p>
            <ul className="mt-xs space-y-0.5">
              {plan.unresolved.map((u) => (
                <li key={`${u.ingredientId}:${u.unit}:${u.weightBasis}`}>
                  {u.label}: {u.reason}.
                </li>
              ))}
            </ul>
          </Notice>
        </Section>
      )}

      {(necesitanAccion.length > 0 || plan.coveredByIncoming.length > 0) && (
        <Section title="Necesita acción">
          <ul className="space-y-sm">
            {necesitanAccion.map((s) => (
              <li
                key={`${s.ingredientId}:${s.unit}:${s.weightBasis}`}
                className="rounded-2xl bg-secondary-fixed px-md py-sm text-on-secondary-fixed-variant"
              >
                <p className="font-body-md text-body-md font-semibold">
                  {s.label}
                  {baseTexto(s.weightBasis)}
                </p>
                <p className="font-body-sm text-body-sm">
                  necesitas {cantidad(s.requiredQuantity, s.unit)} · en casa {cantidad(s.onHand, s.unit)}
                  {s.incoming > 0 && <> · en camino {cantidad(s.incoming, s.unit)}</>}
                </p>
                {s.warnings.map((w) => (
                  <p key={w} className="mt-xs flex items-start gap-xs font-body-sm text-body-sm">
                    <Icon name="warning" className="mt-0.5 shrink-0 text-[16px]" />
                    <span className="min-w-0">{w}</span>
                  </p>
                ))}
              </li>
            ))}
            {plan.coveredByIncoming.map((c) => (
              <Card as="li" key={`${c.ingredientId}:${c.unit}:${c.weightBasis}`} className="p-md">
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  <strong className="font-semibold text-on-surface">
                    {c.label}
                    {baseTexto(c.weightBasis)}
                  </strong>
                  : la necesidad ya viene cubierta
                  {c.incoming > 0 && <> con {cantidad(c.incoming, c.unit)} en camino</>}
                  {c.pendingInList > 0 && (
                    <>
                      {c.incoming > 0 ? " y" : " con"} {cantidad(c.pendingInList, c.unit)} pendientes
                      en la lista
                    </>
                  )}{" "}
                  — no se sugiere de nuevo.
                </p>
                {c.warnings.map((w) => (
                  <Advertencia key={w}>{w}</Advertencia>
                ))}
              </Card>
            ))}
          </ul>
        </Section>
      )}

      {/* ---- En camino ---- */}
      <Section title="En camino">
        {enCamino.length === 0 ? (
          <EmptyState icon="local_shipping">Sin órdenes vivas.</EmptyState>
        ) : (
          <ul className="space-y-sm">
            {enCamino.map((o) => (
              <Card as="li" key={o.id} className="p-md">
                <div className="flex flex-wrap items-start justify-between gap-sm">
                  <p className="min-w-0 font-body-md text-body-md font-semibold text-on-surface">
                    {o.items.map((i) => `${cantidad(i.suggestedQuantity, i.unit)} de ${i.label}`).join(" · ")}
                  </p>
                  <Chip tono={ESTADO_TONO[o.status]}>{ESTADO_TEXTO[o.status]}</Chip>
                </div>
                <p className="mt-xs font-body-sm text-body-sm text-on-surface-variant">
                  {o.supplierName && <>{o.supplierName}</>}
                  {o.orderDate && (
                    <>
                      {o.supplierName && " · "}
                      pedir el {o.orderDate}
                      {o.status === "PLANNED" && o.orderDate < today && (
                        <span className="text-on-secondary-fixed-variant">
                          {" "}
                          (la fecha de pedido ya pasó)
                        </span>
                      )}
                    </>
                  )}
                  {o.expectedDeliveryDate && (
                    <>
                      {" · "}
                      llega el {o.expectedDeliveryDate}
                      {o.expectedDeliveryDate < today && o.status !== "PLANNED" && (
                        <span className="text-on-secondary-fixed-variant"> (atrasada)</span>
                      )}
                    </>
                  )}
                </p>
                <div className="mt-md flex flex-wrap items-center gap-sm">
                  {o.status === "PLANNED" && (
                    <Button disabled={pending} onClick={() => run(() => advanceOrder(o.id, "ORDERED"))}>
                      <Icon name="shopping_cart_checkout" className="text-[18px]" />
                      Ya lo pedí
                    </Button>
                  )}
                  {["ORDERED", "READY", "DELIVERING"].includes(o.status) && (
                    <Button disabled={pending} onClick={() => run(() => receiveOrder(o.id))}>
                      <Icon name="inventory_2" className="text-[18px]" />
                      Llegó: recibir
                    </Button>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => advanceOrder(o.id, "CANCELLED"))}
                    className="inline-flex items-center gap-xs rounded-full px-md py-sm font-body-sm text-body-sm font-semibold text-error transition-transform active:scale-95 disabled:opacity-40"
                  >
                    <Icon name="cancel" className="text-[18px]" />
                    Cancelar
                  </button>
                </div>
              </Card>
            ))}
          </ul>
        )}
      </Section>

      {/* ---- Recibidos recientemente ---- */}
      {recibidas.length > 0 && (
        <Section title="Recibidos recientemente">
          <ul className="space-y-sm">
            {recibidas.map((o) => (
              <Card as="li" key={o.id} className="flex items-start gap-sm px-md py-sm">
                <Icon name="check_circle" className="mt-0.5 shrink-0 text-[18px] text-primary" />
                <p className="min-w-0 font-body-sm text-body-sm text-on-surface-variant">
                  {o.items.map((i) => `${cantidad(i.suggestedQuantity, i.unit)} de ${i.label}`).join(" · ")}
                  {o.supplierName && <> — {o.supplierName}</>}
                  {o.receivedAt && <> · {effectiveDate(new Date(o.receivedAt), timeZone)}</>}
                </p>
              </Card>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
