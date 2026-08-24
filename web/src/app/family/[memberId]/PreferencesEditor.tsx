"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { COOKING_METHODS, COOKING_METHOD_LABELS } from "@/domain/recipes/types";
import {
  PREFERENCE_LABELS,
  USER_SETTABLE_PREFERENCES,
  type PreferenceType,
  type UserSettablePreference,
} from "@/domain/nutrition/types";
import type { PreferenceContext } from "../nutrition-queries";
import {
  removeCookingPreference,
  setCookingPreference,
  setIngredientPreference,
} from "../nutrition-actions";

/**
 * QA §27. Dos cosas distintas en una pantalla: qué alimentos le gustan y cómo
 * prefiere que se preparen.
 *
 * Una restricción médica se muestra pero no se toca: la crea el pipeline
 * clínico y la base la protege además de esta interfaz.
 */
export function PreferencesEditor({
  memberId,
  memberName,
  context,
}: {
  memberId: string;
  memberName: string;
  context: PreferenceContext;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [nuevoAlimento, setNuevoAlimento] = useState("");
  const [nuevoTipo, setNuevoTipo] = useState<UserSettablePreference>("DISLIKE");

  const [alcance, setAlcance] = useState<"GLOBAL" | "CATEGORY" | "INGREDIENT">("GLOBAL");
  const [objetivo, setObjetivo] = useState("");
  const [metodo, setMetodo] = useState<string>("AIR_FRYER");
  const [postura, setPostura] = useState<"PREFERRED" | "ACCEPTED" | "AVOID">("PREFERRED");

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo guardar.");
        return;
      }
      setMessage(result.message ?? "Guardado.");
      router.refresh();
    });
  }

  const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";
  const chip = "rounded-full px-3 py-2 text-xs font-medium";

  return (
    <>
      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Preferencias de alimentos
        </h2>
        <p className="mb-3 text-xs text-[var(--ink)]/60">
          &quot;No me gusta&quot; anota y explica, no prohíbe. Una alergia sí bloquea el plato entero.
        </p>

        {context.foodPreferences.length === 0 ? (
          <p className="mb-3 text-sm text-[var(--ink)]/60">Todavía no hay preferencias.</p>
        ) : (
          <ul className="mb-4 space-y-1.5">
            {context.foodPreferences.map((pref) => (
              <li
                key={pref.ingredientId}
                className="flex items-center justify-between gap-3 rounded-xl bg-[var(--paper)] px-3 py-2 text-sm"
              >
                <span>
                  {pref.label}
                  <span className="ml-2 text-[11px] text-[var(--ink)]/60">
                    {PREFERENCE_LABELS[pref.preferenceType as PreferenceType] ?? pref.preferenceType}
                  </span>
                </span>
                {pref.editable ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(() => setIngredientPreference(memberId, memberName, pref.ingredientId, "REMOVE"))
                    }
                    className="text-xs text-[var(--ink)]/50 underline"
                  >
                    Quitar
                  </button>
                ) : (
                  <span className="text-[11px] text-[var(--ink)]/40">restricción médica</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2">
          <select
            value={nuevoAlimento}
            onChange={(e) => setNuevoAlimento(e.target.value)}
            className={field}
          >
            <option value="">Elegir alimento…</option>
            {context.ingredients.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            {USER_SETTABLE_PREFERENCES.map((tipo) => (
              <button
                key={tipo}
                type="button"
                onClick={() => setNuevoTipo(tipo)}
                className={`${chip} ${
                  nuevoTipo === tipo
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
                }`}
              >
                {PREFERENCE_LABELS[tipo as PreferenceType]}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={pending || !nuevoAlimento}
            onClick={() =>
              run(async () => {
                const r = await setIngredientPreference(memberId, memberName, nuevoAlimento, nuevoTipo);
                if (r.ok) setNuevoAlimento("");
                return r;
              })
            }
            className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Agregar preferencia
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Preferencias de preparación
        </h2>
        <p className="mb-3 text-xs text-[var(--ink)]/60">
          Gana lo más específico: una regla para un alimento pisa a la de su categoría, y esa pisa a
          la general.
        </p>

        {context.cookingPreferences.length === 0 ? (
          <p className="mb-3 text-sm text-[var(--ink)]/60">Sin reglas de preparación.</p>
        ) : (
          <ul className="mb-4 space-y-1.5">
            {context.cookingPreferences.map((pref) => (
              <li
                key={pref.id}
                className="flex items-center justify-between gap-3 rounded-xl bg-[var(--paper)] px-3 py-2 text-sm"
              >
                <span>
                  {pref.label}
                  <span className="ml-2 text-[11px] text-[var(--ink)]/60">
                    {COOKING_METHOD_LABELS[pref.cookingMethod as never] ?? pref.cookingMethod} ·{" "}
                    {pref.stance === "PREFERRED"
                      ? "preferido"
                      : pref.stance === "AVOID"
                        ? "evitar"
                        : "acepta"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => removeCookingPreference(memberId, memberName, pref.id))}
                  className="text-xs text-[var(--ink)]/50 underline"
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2">
          <div className="flex gap-2">
            {(
              [
                ["GLOBAL", "En general"],
                ["CATEGORY", "Una categoría"],
                ["INGREDIENT", "Un alimento"],
              ] as const
            ).map(([valor, texto]) => (
              <button
                key={valor}
                type="button"
                onClick={() => {
                  setAlcance(valor);
                  setObjetivo("");
                }}
                className={`${chip} ${
                  alcance === valor
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
                }`}
              >
                {texto}
              </button>
            ))}
          </div>

          {alcance !== "GLOBAL" && (
            <select value={objetivo} onChange={(e) => setObjetivo(e.target.value)} className={field}>
              <option value="">{alcance === "CATEGORY" ? "Elegir categoría…" : "Elegir alimento…"}</option>
              {(alcance === "CATEGORY" ? context.categories : context.ingredients).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}

          <div className="flex gap-2">
            <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className={field}>
              {COOKING_METHODS.map((m) => (
                <option key={m} value={m}>
                  {COOKING_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
            <select
              value={postura}
              onChange={(e) => setPostura(e.target.value as typeof postura)}
              className={field}
            >
              <option value="PREFERRED">Preferido</option>
              <option value="ACCEPTED">Lo acepta</option>
              <option value="AVOID">Evitar</option>
            </select>
          </div>

          <button
            type="button"
            disabled={pending || (alcance !== "GLOBAL" && !objetivo)}
            onClick={() =>
              run(async () => {
                const r = await setCookingPreference(memberId, memberName, {
                  ingredientId: alcance === "INGREDIENT" ? objetivo : null,
                  categoryId: alcance === "CATEGORY" ? objetivo : null,
                  cookingMethod: metodo,
                  stance: postura,
                });
                if (r.ok) setObjetivo("");
                return r;
              })
            }
            className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Agregar regla de preparación
          </button>
        </div>
      </section>

      {message && (
        <p className="rounded-xl bg-[var(--accent)]/10 px-3 py-2 text-sm text-[var(--accent)]">{message}</p>
      )}
      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
