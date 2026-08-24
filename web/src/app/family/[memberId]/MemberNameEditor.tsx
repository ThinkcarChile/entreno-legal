"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameMember } from "../nutrition-actions";

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
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{displayName}</h1>
        <button
          type="button"
          onClick={() => setEditando(true)}
          className="text-xs text-[var(--accent)] underline"
        >
          Cambiar nombre
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          maxLength={80}
          className="flex-1 rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-lg font-semibold"
        />
        <button
          type="button"
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
          className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Guardar
        </button>
        <button
          type="button"
          onClick={() => {
            setValor(displayName);
            setEditando(false);
          }}
          className="rounded-full border border-[var(--ink)]/20 px-4 py-2 text-sm"
        >
          Cancelar
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}
