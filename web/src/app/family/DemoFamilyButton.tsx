"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loadDemoFamily } from "./nutrition-actions";
import { ButtonOutline, ErrorNote, Icon } from "@/components/ui";

/**
 * Carga la familia de demostración del Sprint 4 en el hogar actual. Todo lo que
 * crea es configuración editable de cada integrante, no reglas del sistema.
 */
export function DemoFamilyButton({ householdId }: { householdId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="mt-lg rounded-3xl border border-dashed border-outline-variant bg-surface-container-low p-md">
      <h2 className="font-headline-sm text-headline-sm text-on-surface">
        Familia de demostración
      </h2>
      <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
        Agrega a Paula, Sebastián, Constanza y Ricardo con configuraciones distintas (una sin
        seguimiento, otra con ayuno, otro que prefiere frito) para ver cómo cambia la porción de
        cada uno en la misma receta. Todo queda editable.
      </p>
      <div className="mt-md">
        <ButtonOutline
          disabled={pending}
          onClick={() => {
            setError(null);
            setMessage(null);
            startTransition(async () => {
              const result = await loadDemoFamily(householdId);
              if (!result.ok) {
                setError(result.error ?? "No se pudo cargar.");
                return;
              }
              setMessage(result.message ?? "Listo.");
              router.refresh();
            });
          }}
        >
          <Icon
            name={pending ? "progress_activity" : "group_add"}
            className={`text-[18px]${pending ? " animate-spin" : ""}`}
          />
          {pending ? "Cargando…" : "Cargar familia de demostración"}
        </ButtonOutline>
      </div>
      {message && (
        <p className="mt-sm flex items-center gap-sm font-body-sm text-body-sm text-primary">
          <Icon name="check_circle" className="text-[18px]" />
          {message}
        </p>
      )}
      {error && (
        <div className="mt-sm">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </section>
  );
}
