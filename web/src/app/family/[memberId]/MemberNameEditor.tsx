"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameMember } from "../nutrition-actions";
import { Button, ButtonOutline, ErrorNote, Icon } from "@/components/ui";

/**
 * El nombre del hogar ("Casa Vásquez") y el de una persona ("Francisco") son
 * cosas distintas y viven en tablas distintas. Esto permite corregir el segundo
 * sin tocar el primero.
 */
export function MemberNameEditor({
  memberId,
  displayName,
}: {
  memberId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(displayName);
  const [error, setError] = useState<string | null>(null);

  if (!editando) {
    return (
      <ButtonOutline onClick={() => setEditando(true)}>
        <Icon name="edit" className="text-[18px]" />
        Cambiar nombre
      </ButtonOutline>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-sm">
        <input
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          maxLength={80}
          aria-label="Nombre del integrante"
          className="min-h-[48px] min-w-0 flex-1 rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md font-semibold text-on-surface"
        />
        <Button
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const r = await renameMember(memberId, valor);
              if (!r.ok) {
                setError(r.error ?? "No se pudo guardar.");
                return;
              }
              setEditando(false);
              router.refresh();
            });
          }}
        >
          Guardar
        </Button>
        <ButtonOutline
          onClick={() => {
            setValor(displayName);
            setEditando(false);
          }}
        >
          Cancelar
        </ButtonOutline>
      </div>
      {error && (
        <div className="mt-sm">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}
