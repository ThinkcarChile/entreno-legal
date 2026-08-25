import Link from "next/link";
import { SubstitutionButton } from "./SubstitutionButton";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { roundForDisplay } from "@/domain/catalog/nutrition";
import { NUTRIENT_LABELS } from "@/domain/catalog/types";
import { countsCalories } from "@/domain/nutrition/profile";
import { TRACKING_LABELS } from "@/domain/nutrition/types";
import { projectFamilyServings } from "@/domain/portions/family";
import type { PortionComponent } from "@/domain/portions/optimizer";
import { COOKING_METHOD_LABELS, MEAL_TYPES, MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import { effectiveDate } from "@/domain/nutrition/calendar";
import type { TargetSet } from "@/domain/nutrition/types";
import type { AcceptedSubstitution, AvailableAlternative } from "@/domain/portions/optimizer";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadDailyOverride, loadHouseholdProfiles } from "@/app/family/nutrition-queries";
import { loadAlternativesWithFacts, loadRecipeDetail } from "../../queries";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ meal?: string; v?: string; sub?: string | string[]; assignment?: string }>;
}

const FIT_LABELS: Record<string, string> = {
  COMPATIBLE: "Porción estándar",
  COMPATIBLE_WITH_PORTION_CHANGE: "Porción ajustada",
  COMPATIBLE_WITH_COOKING_CHANGE: "Preparación distinta",
  COMPATIBLE_WITH_ONE_SUBSTITUTION: "Con un reemplazo",
  TARGET_CONFLICT: "No se pudo cuadrar",
  NOT_COMPATIBLE: "No puede comerlo",
};

const FIT_TONE: Record<string, string> = {
  COMPATIBLE: "bg-[var(--ink)]/5 text-[var(--ink)]/70",
  COMPATIBLE_WITH_PORTION_CHANGE: "bg-[var(--accent)]/10 text-[var(--accent)]",
  COMPATIBLE_WITH_COOKING_CHANGE: "bg-[var(--accent)]/10 text-[var(--accent)]",
  COMPATIBLE_WITH_ONE_SUBSTITUTION: "bg-amber-100 text-amber-800",
  TARGET_CONFLICT: "bg-amber-100 text-amber-800",
  NOT_COMPATIBLE: "bg-red-100 text-red-800",
};

export default async function FamilyServingsPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { meal, v, sub, assignment } = await searchParams;
  const mealType: MealType = MEAL_TYPES.includes(meal as MealType) ? (meal as MealType) : "LUNCH";

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/recipes/${id}/family`);

  const recipe = await loadRecipeDetail(supabase, id, v);
  if (!recipe) notFound();

  const profiles = await loadHouseholdProfiles(supabase);

  const components: PortionComponent[] = recipe.components.map((c) => ({
    id: c.id,
    slotId: c.slotId,
    label: c.label,
    slotType: c.slotType,
    quantity: c.quantity,
    unit: c.unit,
    weightBasis: c.weightBasis,
    nutrition: c.nutrition,
    cookingMethod: c.cookingMethod,
    adjustability: c.adjustability,
    role: c.role,
    minQuantity: c.minQuantity,
    maxQuantity: c.maxQuantity,
    ingredientId: c.target.kind === "INGREDIENT" ? c.target.ingredientId : null,
    productId: c.target.kind === "PRODUCT" ? c.target.productId : null,
    categoryId: c.categoryId,
    isOptional: c.isOptional,
  }));

  // --- Alternativas culinarias con su nutrición, para poder sustituir (§26) ---
  const alternatives: AvailableAlternative[] = await loadAlternativesWithFacts(
    supabase,
    recipe.alternatives,
  );

  // --- Reemplazos aceptados ---
  // Con una comida concreta, la decisión vive en la BASE (gate [A-1]): así la
  // ve quien confirme, sobrevive a la recarga y no depende de la URL. Sin
  // comida (mirando la receta suelta) sigue siendo una vista previa por URL.
  const subParams = Array.isArray(sub) ? sub : sub ? [sub] : [];
  const acceptedByMember = new Map<string, AcceptedSubstitution[]>();

  if (assignment) {
    const { data: elegidas, error: elegidasError } = await supabase
      .from("meal_substitution_choices")
      .select("member_id, component_id, to_ingredient_id")
      .eq("assignment_id", assignment);
    if (elegidasError) throw new DataAccessError("reemplazos aceptados", elegidasError);
    for (const e of elegidas ?? []) {
      const alternativa = alternatives.find((a) => a.ingredientId === e.to_ingredient_id);
      if (!alternativa) continue;
      const lista = acceptedByMember.get(e.member_id as string) ?? [];
      lista.push({
        componentId: e.component_id as string,
        ingredientId: e.to_ingredient_id as string,
        label: alternativa.label,
        nutrition: alternativa.nutrition,
      });
      acceptedByMember.set(e.member_id as string, lista);
    }
  }

  for (const raw of subParams) {
    const [memberId, componentId, ingredientId] = raw.split("~");
    if (!memberId || !componentId || !ingredientId) continue;
    const alternativa = alternatives.find((a) => a.ingredientId === ingredientId);
    if (!alternativa) continue;
    const lista = acceptedByMember.get(memberId) ?? [];
    lista.push({
      componentId,
      ingredientId,
      label: alternativa.label,
      nutrition: alternativa.nutrition,
    });
    acceptedByMember.set(memberId, lista);
  }

  // --- Excepción del día, en la zona horaria del hogar (§15) ---
  const { data: household, error: householdError } = await supabase
    .from("households")
    .select("timezone")
    .limit(1)
    .maybeSingle();
  if (householdError) throw new DataAccessError("zona horaria del hogar", householdError);
  const hoy = effectiveDate(new Date(), household?.timezone ?? "America/Santiago");

  const overrides = new Map<string, TargetSet | null>();
  for (const profile of profiles) {
    const plan = await loadDailyOverride(supabase, profile.memberId, hoy, mealType);
    overrides.set(profile.memberId, (plan?.targets as TargetSet) ?? null);
  }

  const proyeccion =
    profiles.length > 0
      ? projectFamilyServings({
          versionId: recipe.versionId,
          components,
          alternatives,
          baseServings: recipe.baseServings,
          mealType,
          members: profiles.map((profile) => ({
            profile,
            override: overrides.get(profile.memberId) ?? null,
            substitutions: acceptedByMember.get(profile.memberId) ?? [],
          })),
        })
      : null;

  const g = (n: number) => `${Math.round(n).toLocaleString("es-CL")}`;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="recipes" />
      <Link href={`/recipes/${id}`} className="text-sm text-[var(--accent)]">
        ← {recipe.name}
      </Link>

      <header className="mb-4 mt-2">
        <h1 className="text-2xl font-semibold">Porciones para mi familia</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          {recipe.name} · versión {recipe.versionNumber} · receta base para {recipe.baseServings}
        </p>
      </header>

      <nav className="mb-5 flex flex-wrap gap-2">
        {(["BREAKFAST", "LUNCH", "TEA", "DINNER"] as MealType[]).map((m) => (
          <Link
            key={m}
            href={`/recipes/${id}/family?meal=${m}${v ? `&v=${v}` : ""}`}
            className={`rounded-full px-3 py-2 text-xs font-medium ${
              m === mealType
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
            }`}
          >
            {MEAL_TYPE_LABELS[m]}
          </Link>
        ))}
      </nav>

      {!proyeccion ? (
        <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 p-6 text-center text-sm text-[var(--ink)]/60">
          Primero crea o únete a un hogar con integrantes.
        </p>
      ) : (
        <>
          <section className="mb-6 space-y-3">
            {proyeccion.servings.map((serving) => {
              const profile = profiles.find((p) => p.memberId === serving.memberId)!;
              return (
                <article
                  key={serving.memberId}
                  className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4"
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-medium">{serving.memberName}</h2>
                      <p className="text-[11px] text-[var(--ink)]/50">
                        {TRACKING_LABELS[profile.trackingMode]}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${FIT_TONE[serving.fit]}`}
                    >
                      {FIT_LABELS[serving.fit]}
                    </span>
                  </div>

                  {serving.fit === "NOT_COMPATIBLE" ? (
                    <p className="text-sm text-red-700">
                      Esta receta no es compatible. Necesita un reemplazo antes de servirse.
                    </p>
                  ) : (
                    <>
                      <ul className="mb-3 space-y-1 text-sm">
                        {serving.components
                          .filter((c) => c.proposedQuantity > 0)
                          .map((c) => (
                            <li key={c.id} className="flex justify-between gap-3">
                              <span>
                                {c.label}
                                {c.cookingMethod && (
                                  <span className="ml-2 text-[11px] text-[var(--ink)]/50">
                                    {COOKING_METHOD_LABELS[c.cookingMethod]}
                                  </span>
                                )}
                              </span>
                              <span className="shrink-0 tabular-nums">
                                {g(c.proposedQuantity)} {c.unit === "G" ? "g" : "ml"}
                                {c.changed && (
                                  <span className="ml-1.5 text-[11px] text-[var(--ink)]/40">
                                    (base {g(c.baseQuantity)})
                                  </span>
                                )}
                              </span>
                            </li>
                          ))}
                      </ul>

                      {/* Una persona sin seguimiento no ve "te quedan 0 kcal" (§10) */}
                      {countsCalories(profile) || profile.trackingMode === "BASIC" ? (
                        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-[var(--paper)] px-3 py-2 text-xs">
                          {(["energy_kcal", "protein_g", "carbohydrates_g", "fat_g"] as const).map(
                            (key) => {
                              const state = serving.nutrition.completeness[key];
                              const val = roundForDisplay(
                                serving.nutrition.values[key],
                                key === "energy_kcal" ? 0 : 1,
                              );
                              return (
                                <span key={key} className="text-[var(--ink)]/70">
                                  {NUTRIENT_LABELS[key].label}:{" "}
                                  {state === "UNKNOWN" || val === null ? (
                                    <span className="text-[var(--ink)]/40">sin datos</span>
                                  ) : (
                                    <strong className="tabular-nums">
                                      {state === "PARTIAL" && "≥ "}
                                      {val.toLocaleString("es-CL")} {NUTRIENT_LABELS[key].unit}
                                    </strong>
                                  )}
                                </span>
                              );
                            },
                          )}
                        </div>
                      ) : (
                        <p className="mb-3 text-xs text-[var(--ink)]/50">
                          Sin seguimiento: recibe su porción sin conteo de calorías.
                        </p>
                      )}
                    </>
                  )}

                  {serving.suggestions.length > 0 && (
                    <div className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {serving.suggestions.map((s) => (
                        <div key={s.componentId} className="flex items-center justify-between gap-2">
                          <span>
                            Sugerencia: cambiar <strong>{s.componentLabel}</strong> por{" "}
                            <strong>{s.alternativeLabel}</strong>.
                          </span>
                          <SubstitutionButton
                            modo="APLICAR"
                            assignmentId={assignment ?? null}
                            memberId={serving.memberId}
                            componentId={s.componentId}
                            ingredientId={s.ingredientId}
                            previewHref={`/recipes/${id}/family?meal=${mealType}${v ? `&v=${v}` : ""}${subParams
                              .map((x) => `&sub=${encodeURIComponent(x)}`)
                              .join("")}&sub=${encodeURIComponent(
                              `${serving.memberId}~${s.componentId}~${s.ingredientId}`,
                            )}`}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {acceptedByMember.get(serving.memberId)?.length ? (
                    <p className="mb-3 text-[11px] text-[var(--ink)]/60">
                      {assignment ? "Reemplazo guardado para esta comida." : "Reemplazo aplicado (vista previa)."}{" "}
                      <SubstitutionButton
                        modo="DESHACER"
                        assignmentId={assignment ?? null}
                        memberId={serving.memberId}
                        componentId={acceptedByMember.get(serving.memberId)![0]!.componentId}
                        ingredientId={acceptedByMember.get(serving.memberId)![0]!.ingredientId}
                        previewHref={`/recipes/${id}/family?meal=${mealType}${v ? `&v=${v}` : ""}`}
                      />
                    </p>
                  ) : null}

                  {serving.reasons.length > 0 && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-[var(--accent)]">¿Por qué?</summary>
                      <ul className="mt-2 space-y-1.5 text-xs text-[var(--ink)]/70">
                        {serving.reasons.map((r, i) => (
                          <li key={`${r.code}-${i}`}>{r.text}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              );
            })}
          </section>

          <section className="mb-5">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
              Preparar para la familia
            </h2>
            <p className="mb-2 text-xs text-[var(--ink)]/50">
              No es la receta multiplicada por personas: es la suma exacta de las porciones de cada
              uno.
            </p>
            <ul className="divide-y divide-[var(--ink)]/5 rounded-2xl border border-[var(--ink)]/10 bg-white">
              {proyeccion.totals.map((total) => (
                <li key={total.componentId} className="px-4 py-3">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{total.label}</span>
                    <span className="tabular-nums">
                      {g(total.total)} {total.unit}
                    </span>
                  </div>
                  {total.byMethod.length > 1 && (
                    <ul className="mt-1.5 space-y-0.5 text-[11px] text-[var(--ink)]/60">
                      {total.byMethod.map((group, i) => (
                        <li key={i} className="flex justify-between">
                          <span>
                            {group.method ? COOKING_METHOD_LABELS[group.method as never] : "Sin método"}
                            {" · "}
                            {group.members.join(", ")}
                          </span>
                          <span className="tabular-nums">
                            {g(group.quantity)} {total.unit}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {proyeccion.needsAttention.length > 0 && (
            <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Revisa a{" "}
              {proyeccion.needsAttention.map((n) => n.memberName).join(", ")}: esta receta no cuadra
              con su configuración tal como está.
            </p>
          )}
        </>
      )}
    </main>
  );
}
