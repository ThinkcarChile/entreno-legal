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
import { Button, Card, EmptyState, ErrorNote, Icon, Section } from "@/components/ui";
import type { PreferenceContext } from "../nutrition-queries";
import {
  removeCookingPreference,
  setCookingPreference,
  setIngredientPreference,
} from "../nutrition-actions";

/** Campo de formulario del kit: mismo alto de toque en todas las pantallas. */
const FIELD =
  "min-h-[48px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

/**
 * Chip que se ELIGE. No es el `Chip` del kit —ese solo informa—: este se toca,
 * así que lleva área de toque completa y `aria-pressed`.
 */
function OpcionChip({
  activa,
  disabled,
  onClick,
  children,
}: {
  activa: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={activa}
      onClick={onClick}
      className={`min-h-[44px] rounded-full px-md py-sm font-body-sm text-body-sm font-semibold transition-transform active:scale-95 disabled:opacity-40 ${
        activa
          ? "bg-primary text-on-primary"
          : "border border-outline-variant text-on-surface-variant"
      }`}
    >
      {children}
    </button>
  );
}

/** Confirmación de guardado. Lo que FALLA se muestra con `ErrorNote`. */
function AvisoOk({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-sm rounded-2xl bg-primary-fixed px-md py-sm font-body-sm text-body-sm text-on-primary-fixed">
      <Icon name="check_circle" className="mt-0.5 shrink-0 text-[18px]" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

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

  return (
    <div>
      <Section
        title="Preferencias de alimentos"
        hint="«No me gusta» anota y explica, no prohíbe. Una alergia sí bloquea el plato entero."
      >
        {context.foodPreferences.length === 0 ? (
          <div className="mb-sm">
            <EmptyState icon="restaurant">Todavía no hay preferencias.</EmptyState>
          </div>
        ) : (
          <ul className="mb-sm flex flex-wrap gap-sm">
            {context.foodPreferences.map((pref) => (
              <li
                key={pref.ingredientId}
                className={`inline-flex max-w-full items-center gap-xs rounded-full py-xs pl-md ${
                  pref.editable
                    ? "border border-outline-variant bg-surface-container pr-xs text-on-surface"
                    : "bg-error-container pr-md text-on-error-container"
                }`}
              >
                <span className="min-w-0 truncate font-body-sm text-body-sm">{pref.label}</span>
                <span className="shrink-0 font-label-md text-label-md opacity-80">
                  {PREFERENCE_LABELS[pref.preferenceType as PreferenceType] ?? pref.preferenceType}
                </span>
                {pref.editable ? (
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Quitar ${pref.label}`}
                    onClick={() =>
                      run(() =>
                        setIngredientPreference(memberId, memberName, pref.ingredientId, "REMOVE"),
                      )
                    }
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-transform active:scale-90 disabled:opacity-40"
                  >
                    <Icon name="close" className="text-[18px]" />
                  </button>
                ) : (
                  <span className="shrink-0 font-label-md text-label-md">restricción médica</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <Card className="space-y-sm p-md">
          <label className="block">
            <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
              Alimento
            </span>
            <select
              value={nuevoAlimento}
              onChange={(e) => setNuevoAlimento(e.target.value)}
              className={FIELD}
            >
              <option value="">Elegir alimento…</option>
              {context.ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-sm">
            {USER_SETTABLE_PREFERENCES.map((tipo) => (
              <OpcionChip
                key={tipo}
                activa={nuevoTipo === tipo}
                onClick={() => setNuevoTipo(tipo)}
              >
                {PREFERENCE_LABELS[tipo as PreferenceType]}
              </OpcionChip>
            ))}
          </div>

          <Button
            full
            disabled={pending || !nuevoAlimento}
            onClick={() =>
              run(async () => {
                const r = await setIngredientPreference(
                  memberId,
                  memberName,
                  nuevoAlimento,
                  nuevoTipo,
                );
                if (r.ok) setNuevoAlimento("");
                return r;
              })
            }
          >
            <Icon name="add" className="text-[18px]" />
            Agregar preferencia
          </Button>
        </Card>
      </Section>

      <Section
        title="Preferencias de preparación"
        hint="Gana lo más específico: una regla para un alimento pisa a la de su categoría, y esa pisa a la general."
      >
        {context.cookingPreferences.length === 0 ? (
          <div className="mb-sm">
            <EmptyState icon="skillet">Sin reglas de preparación.</EmptyState>
          </div>
        ) : (
          <ul className="mb-sm space-y-sm">
            {context.cookingPreferences.map((pref) => (
              <Card key={pref.id} as="li" className="flex items-center gap-sm py-xs pl-md pr-xs">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-body-md text-body-md text-on-surface">
                    {pref.label}
                  </span>
                  <span className="block font-label-md text-label-md text-on-surface-variant">
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
                  aria-label={`Quitar regla de ${pref.label}`}
                  onClick={() => run(() => removeCookingPreference(memberId, memberName, pref.id))}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-transform active:scale-90 disabled:opacity-40"
                >
                  <Icon name="close" className="text-[18px]" />
                </button>
              </Card>
            ))}
          </ul>
        )}

        <Card className="space-y-sm p-md">
          <div>
            <p className="mb-xs font-label-md text-label-md text-on-surface-variant">
              A qué se aplica
            </p>
            <div className="flex flex-wrap gap-sm">
              {(
                [
                  ["GLOBAL", "En general"],
                  ["CATEGORY", "Una categoría"],
                  ["INGREDIENT", "Un alimento"],
                ] as const
              ).map(([valor, texto]) => (
                <OpcionChip
                  key={valor}
                  activa={alcance === valor}
                  onClick={() => {
                    setAlcance(valor);
                    setObjetivo("");
                  }}
                >
                  {texto}
                </OpcionChip>
              ))}
            </div>
          </div>

          {alcance !== "GLOBAL" && (
            <label className="block">
              <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
                {alcance === "CATEGORY" ? "Categoría" : "Alimento"}
              </span>
              <select
                value={objetivo}
                onChange={(e) => setObjetivo(e.target.value)}
                className={FIELD}
              >
                <option value="">
                  {alcance === "CATEGORY" ? "Elegir categoría…" : "Elegir alimento…"}
                </option>
                {(alcance === "CATEGORY" ? context.categories : context.ingredients).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="grid grid-cols-1 gap-sm sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
                Método
              </span>
              <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className={FIELD}>
                {COOKING_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {COOKING_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
                Postura
              </span>
              <select
                value={postura}
                onChange={(e) => setPostura(e.target.value as typeof postura)}
                className={FIELD}
              >
                <option value="PREFERRED">Preferido</option>
                <option value="ACCEPTED">Lo acepta</option>
                <option value="AVOID">Evitar</option>
              </select>
            </label>
          </div>

          <Button
            full
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
          >
            <Icon name="add" className="text-[18px]" />
            Agregar regla de preparación
          </Button>
        </Card>
      </Section>

      {message && <AvisoOk>{message}</AvisoOk>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
