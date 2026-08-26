"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelPlan, generatePrepPlan } from "./actions";
import type { PrepPlanView } from "./queries";
import {
  Button,
  ButtonOutline,
  Card,
  CardLink,
  Chip,
  EmptyState,
  Flotante,
  Icon,
  LinkButton,
  Notice,
  Section,
  type Tono,
} from "@/components/ui";

/**
 * Portada de preparación: el botón que genera la sugerencia, los planes vivos
 * con su resumen en bloques y los anteriores. Nada de lo que se ve acá tocó
 * todavía la despensa (§17).
 */

const ESTADO: Record<string, string> = {
  DRAFT: "borrador",
  READY: "listo para partir",
  IN_PROGRESS: "en curso",
  COMPLETED: "completado",
  CANCELLED: "cancelado",
};

/** El color acompaña al texto del estado, nunca comunica solo (§94). */
const ESTADO_TONO: Record<string, Tono> = {
  DRAFT: "neutro",
  READY: "primario",
  IN_PROGRESS: "info",
  COMPLETED: "primario",
  CANCELLED: "neutro",
};


/** Casilla del resumen del plan: un número grande con su etiqueta. */
function Dato({
  icon,
  color,
  valor,
  etiqueta,
}: {
  icon: string;
  color: string;
  valor: string;
  etiqueta: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl bg-surface-container-low p-sm text-center">
      <Icon name={icon} className={`text-[20px] ${color}`} />
      <span className="font-headline-sm text-headline-sm text-on-surface">{valor}</span>
      <span className="font-label-md text-label-md uppercase text-on-surface-variant">
        {etiqueta}
      </span>
    </div>
  );
}

/** Nota informativa dentro de una tarjeta de plan (dato, no alerta). */
function Nota({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl bg-surface-container px-md py-sm font-body-sm text-body-sm text-on-surface-variant">
      {children}
    </p>
  );
}

export function PrepHome({ plans }: { plans: PrepPlanView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(
    action: () => Promise<{ ok: boolean; error?: string; message?: string; planId?: string }>,
  ) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "No se pudo completar.");
        return;
      }
      if (r.message) setMessage(r.message);
      if (r.planId) router.push(`/prep/${r.planId}`);
      else router.refresh();
    });
  }

  const vivos = plans.filter((p) => ["READY", "IN_PROGRESS", "DRAFT"].includes(p.status));
  const pasados = plans.filter((p) => ["COMPLETED", "CANCELLED"].includes(p.status)).slice(0, 6);

  return (
    <div>
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      <Button full disabled={pending} onClick={() => run(generatePrepPlan)}>
        <Icon name="auto_awesome" className="text-[18px]" />
        {pending ? "Calculando…" : "Preparar compra / stock"}
      </Button>
      <p className="mt-sm mb-lg text-center font-body-sm text-body-sm text-on-surface-variant">
        Genera la sugerencia. Nada cambia en la despensa hasta que confirmes cada paso.
      </p>

      {vivos.length === 0 && pasados.length === 0 && (
        <EmptyState icon="skillet">
          Sin planes todavía. Cuando recibas una compra o tengas stock sin preparar y comidas
          confirmadas, genera el plan acá.
        </EmptyState>
      )}

      {vivos.length > 0 && (
        <div className="space-y-md">
          {vivos.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              onCancel={() => run(() => cancelPlan(p.id))}
              pending={pending}
            />
          ))}
        </div>
      )}

      {pasados.length > 0 && (
        <Section title="Anteriores" className="mt-lg">
          <ul className="space-y-sm">
            {pasados.map((p) => (
              <li key={p.id}>
                <CardLink href={`/prep/${p.id}`} className="flex items-center gap-md p-md">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant">
                    <Icon name="history" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-body-md text-body-md text-on-surface">
                      Plan del {p.plan_date}
                    </span>
                    <span className="mt-0.5 block font-body-sm text-body-sm text-on-surface-variant">
                      {ESTADO[p.status]} ·{" "}
                      {p.batch_prep_tasks.filter((t) => t.status === "DONE").length}/
                      {p.batch_prep_tasks.length} tareas
                    </span>
                  </span>
                  <Icon name="chevron_right" className="shrink-0 text-outline" />
                </CardLink>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  onCancel,
  pending,
}: {
  plan: PrepPlanView;
  onCancel: () => void;
  pending: boolean;
}) {
  const hechas = plan.batch_prep_tasks.filter((t) => t.status === "DONE").length;
  const summary = plan.summary as {
    estimatedMinutes?: number;
    packages?: number;
    labels?: number;
    foods?: number;
    warnings?: string[];
    leave_whole?: { label: string; quantity: number; unit: string; reason: string }[];
    thaw_suggestions?: { label: string; plan: { kind: string; note?: string; reason?: string } }[];
    unresolved?: { label: string; quantity: number; unit: string; reason: string }[];
  };
  const bloques = [
    ...new Set(plan.batch_prep_tasks.map((t) => t.block_label).filter(Boolean)),
  ] as string[];

  const avisos =
    (summary.warnings ?? []).length +
    (summary.leave_whole ?? []).length +
    (summary.unresolved ?? []).length +
    (summary.thaw_suggestions ?? []).length;

  return (
    <Card as="section" className="p-md">
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div className="min-w-0">
          <h3 className="font-headline-sm text-headline-sm text-on-surface">
            Plan del {plan.plan_date}
          </h3>
          <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
            {hechas}/{plan.batch_prep_tasks.length} completadas
          </p>
        </div>
        <Chip tono={ESTADO_TONO[plan.status] ?? "neutro"}>{ESTADO[plan.status]}</Chip>
      </div>

      <div className="mt-md grid grid-cols-3 gap-sm">
        <Dato
          icon="timer"
          color="text-tertiary"
          valor={`${summary.estimatedMinutes ?? "?"} min`}
          etiqueta="Tiempo"
        />
        <Dato
          icon="checklist"
          color="text-primary"
          valor={String(plan.batch_prep_tasks.length)}
          etiqueta="Tareas"
        />
        <Dato
          icon="nutrition"
          color="text-secondary"
          valor={String(summary.foods ?? 0)}
          etiqueta="Alimentos"
        />
      </div>

      <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
        {summary.packages ?? 0} paquetes · {summary.labels ?? 0} etiquetas
      </p>

      {bloques.length > 0 && (
        <div className="mt-sm flex flex-wrap gap-xs">
          {bloques.map((b) => {
            const del = plan.batch_prep_tasks.filter((t) => t.block_label === b);
            const listas = del.filter((t) => t.status !== "PENDING").length;
            return (
              <Chip key={b}>
                {b} {listas}/{del.length}
              </Chip>
            );
          })}
        </div>
      )}

      {avisos > 0 && (
        <div className="mt-md space-y-sm">
          {(summary.warnings ?? []).map((w) => (
            <Notice key={w} icon="warning">
              {w}
            </Notice>
          ))}
          {(summary.unresolved ?? []).map((u, i) => (
            <Notice key={`u-${i}`} icon="help">
              Sin planificar:{" "}
              <strong className="font-semibold">
                {u.quantity} {u.unit.toLowerCase()} de {u.label}
              </strong>{" "}
              — {u.reason}
            </Notice>
          ))}
          {(summary.leave_whole ?? []).map((l) => (
            <Nota key={l.label + l.quantity}>
              Dejar sin preparar:{" "}
              <strong className="font-semibold text-on-surface">
                {l.quantity} {l.unit.toLowerCase()} de {l.label}
              </strong>{" "}
              — {l.reason}
            </Nota>
          ))}
          {(summary.thaw_suggestions ?? []).map((t, i) => (
            <Nota key={`t-${i}`}>
              Descongelar: <strong className="font-semibold text-on-surface">{t.label}</strong> —{" "}
              {t.plan.kind === "SCHEDULED"
                ? t.plan.note
                : `revisar descongelado (${t.plan.reason ?? "sin regla"})`}
            </Nota>
          ))}
        </div>
      )}

      <div className="mt-md flex flex-wrap items-center gap-sm">
        <LinkButton href={`/prep/${plan.id}`}>
          <Icon name="play_arrow" filled className="text-[18px]" />
          Modo cocina
        </LinkButton>
        <ButtonOutline disabled={pending} onClick={onCancel}>
          Cancelar plan
        </ButtonOutline>
      </div>
    </Card>
  );
}
