"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ArrowRight, MapPin, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import {
  markOnTheWayAction,
  registerCheckInAction,
  requestCompletionAction,
  startWorkAction,
} from "@/lib/actions/assignment";
import type { WorkerStep } from "@/lib/domain/permissions";

/**
 * El único paso que le toca al trabajador ahora.
 *
 * La matriz de permisos decide cuál es; aquí solo se ejecuta. No se pinta más
 * de un botón a la vez a propósito: en el momento del trabajo, de pie en una
 * fila y con una mano ocupada, una pantalla con cuatro acciones posibles es una
 * pantalla en la que se pulsa la equivocada.
 */
export function WorkerSteps({
  assignmentId,
  step,
  lastCheckInReason,
}: {
  assignmentId: string;
  step: WorkerStep;
  /** Por qué el check-in anterior no se dio por bueno, si lo hubo. */
  lastCheckInReason?: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [askingLocation, setAskingLocation] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "No pudimos completar la acción.");
        return;
      }
      router.refresh();
    });
  }

  /**
   * Check-in con consentimiento explícito.
   *
   * La ubicación se pide solo aquí y solo tras el botón: nunca al cargar la
   * página. Si el navegador la niega o no llega a tiempo, el check-in se
   * registra igual como declarado y queda en revisión. No se inventa una
   * llegada verificada.
   */
  function checkIn() {
    setError(null);
    setNote(null);

    if (!("geolocation" in navigator)) {
      run(() =>
        registerCheckInAction(assignmentId, { consent: true, source: "manual" }).then((r) => {
          if (r.ok) setNote(describe(r.data));
          return r;
        }),
      );
      return;
    }

    setAskingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setAskingLocation(false);
        run(() =>
          registerCheckInAction(assignmentId, {
            consent: true,
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM: position.coords.accuracy,
            source: "device",
          }).then((r) => {
            if (r.ok) setNote(describe(r.data));
            return r;
          }),
        );
      },
      () => {
        setAskingLocation(false);
        run(() =>
          registerCheckInAction(assignmentId, { consent: true, source: "manual" }).then((r) => {
            if (r.ok) setNote(describe(r.data));
            return r;
          }),
        );
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
    );
  }

  function act() {
    switch (step.id) {
      case "on_the_way":
        return run(() => markOnTheWayAction(assignmentId));
      case "check_in":
        return checkIn();
      case "start":
        return run(() => startWorkAction(assignmentId));
      case "completion":
        return run(() => requestCompletionAction(assignmentId));
    }
  }

  const busy = pending || askingLocation;

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      {note && <Alert tone="info">{note}</Alert>}
      {lastCheckInReason && !note && (
        <Alert tone="warning" title="Tu llegada quedó en revisión">
          {lastCheckInReason} Puedes reintentar el check-in o adjuntar una foto del lugar.
        </Alert>
      )}

      {step.id === "check_in" && (
        <p className="flex gap-2 rounded-[var(--radius-control)] bg-ink-50 p-3 text-xs text-ink-600">
          <ShieldCheck size={15} className="mt-px shrink-0 text-ink-400" aria-hidden="true" />
          Usaremos tu ubicación únicamente para comprobar tu llegada a este trabajo. No se comparte
          con el cliente ni queda en tu perfil.
        </p>
      )}

      <Button size="lg" fullWidth onClick={act} disabled={busy}>
        {busy ? (askingLocation ? "Ubicando…" : "Registrando…") : step.label}
        {step.id === "check_in" ? (
          <MapPin size={16} aria-hidden="true" />
        ) : (
          <ArrowRight size={16} aria-hidden="true" />
        )}
      </Button>
      <p className="text-xs text-ink-500">{step.description}</p>
    </div>
  );
}

function describe(outcome: {
  result: string;
  distanceM: number | null;
  canStart: boolean;
}): string {
  if (outcome.canStart) {
    return outcome.distanceM != null
      ? `Llegada verificada a ${outcome.distanceM} m del lugar. Ya puedes comenzar.`
      : "Llegada verificada. Ya puedes comenzar.";
  }
  switch (outcome.result) {
    case "OUT_OF_RANGE":
      return "La ubicación quedó lejos del lugar del trabajo. Queda en revisión: puedes reintentar o adjuntar una foto.";
    case "LOW_ACCURACY":
      return "Tu teléfono no pudo ubicarse con precisión suficiente. Queda en revisión: reintenta con mejor señal.";
    default:
      return "Registramos tu llegada sin ubicación. Queda en revisión antes de que puedas comenzar.";
  }
}
