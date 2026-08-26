"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonOutline, ErrorNote, Icon } from "@/components/ui";
import { resolveImpact } from "../../actions";

/** Resolver impactos (§35/§36): revisar, aplicar a futuros o descartar — decide una persona. */
export function MemberHealthActions({
  impactos,
}: {
  impactos: { id: string; trigger: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function resolver(id: string, resolucion: "REVIEWED" | "DISMISSED") {
    setError(null);
    startTransition(async () => {
      const r = await resolveImpact(id, resolucion);
      if (!r.ok) {
        setError(r.error ?? "No se pudo resolver.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-sm space-y-sm">
      {impactos.map((i) => (
        <div key={i.id} className="flex flex-wrap items-center gap-sm">
          <span className="min-w-0 flex-1 font-body-sm text-body-sm font-semibold">
            {i.trigger === "LAB_RESULTS_CONFIRMED" ? "Nuevo examen confirmado" : "Cambio clínico"}
          </span>
          <Button disabled={pending} onClick={() => resolver(i.id, "REVIEWED")}>
            <Icon name="task_alt" className="text-[18px]" />
            Marcar revisado
          </Button>
          <ButtonOutline disabled={pending} onClick={() => resolver(i.id, "DISMISSED")}>
            Descartar
          </ButtonOutline>
        </div>
      ))}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
