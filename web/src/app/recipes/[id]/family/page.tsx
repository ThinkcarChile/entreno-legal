import { uuidParam } from "@/lib/route-params";
import Link from "next/link";
import { SubstitutionButton } from "./SubstitutionButton";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import {
  Card,
  Chip,
  EmptyState,
  Icon,
  LinkButton,
  Notice,
  Section,
  type Tono,
} from "@/components/ui";
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

/**
 * El color acompaña al texto del chip, nunca lo reemplaza: el rótulo de arriba
 * ya dice qué pasa, así que nadie tiene que distinguir verde de rojo.
 */
const FIT_TONE: Record<string, Tono> = {
  COMPATIBLE: "neutro",
  COMPATIBLE_WITH_PORTION_CHANGE: "primario",
  COMPATIBLE_WITH_COOKING_CHANGE: "primario",
  COMPATIBLE_WITH_ONE_SUBSTITUTION: "atencion",
  TARGET_CONFLICT: "atencion",
  NOT_COMPATIBLE: "peligro",
};

export default async function FamilyServingsPage({ params, searchParams }: Props) {
  const { id: idCrudo } = await params;
  const id = uuidParam(idCrudo);
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
    <AppShell
      active="recipes"
      title="Porciones para mi familia"
      subtitle={`${recipe.name} · versión ${recipe.versionNumber} · receta base para ${recipe.baseServings}`}
    >
      <div className="mt-md">
        <Link
          href={`/recipes/${id}`}
          className="inline-flex items-center gap-xs font-body-sm text-body-sm font-semibold text-primary"
        >
          <Icon name="arrow_back" className="text-[18px]" />
          {recipe.name}
        </Link>
      </div>

      {/* Selector de comida: en 320 px envuelve a dos filas antes de desbordar. */}
      <nav className="mt-md mb-lg flex flex-wrap gap-sm">
        {(["BREAKFAST", "LUNCH", "TEA", "DINNER"] as MealType[]).map((m) => (
          <LinkButton
            key={m}
            href={`/recipes/${id}/family?meal=${m}${v ? `&v=${v}` : ""}`}
            variant={m === mealType ? "filled" : "outline"}
          >
            {MEAL_TYPE_LABELS[m]}
          </LinkButton>
        ))}
      </nav>

      {!proyeccion ? (
        <EmptyState icon="group_add">Primero crea o únete a un hogar con integrantes.</EmptyState>
      ) : (
        <>
          <Section>
            <ul className="grid grid-cols-1 gap-md md:grid-cols-2">
              {proyeccion.servings.map((serving) => {
                const profile = profiles.find((p) => p.memberId === serving.memberId)!;
                return (
                  <li key={serving.memberId}>
                    <Card as="article" className="flex h-full flex-col p-md">
                      <div className="mb-md flex items-start justify-between gap-sm">
                        <div className="flex min-w-0 items-center gap-sm">
                          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-fixed font-headline-sm text-headline-sm text-on-primary-fixed">
                            {serving.memberName.slice(0, 1)}
                          </span>
                          <div className="min-w-0">
                            <h3 className="truncate font-headline-sm text-headline-sm text-on-surface">
                              {serving.memberName}
                            </h3>
                            <p className="font-label-md text-label-md text-on-surface-variant">
                              {TRACKING_LABELS[profile.trackingMode]}
                            </p>
                          </div>
                        </div>
                        <div className="shrink-0">
                          <Chip tono={FIT_TONE[serving.fit]}>{FIT_LABELS[serving.fit]}</Chip>
                        </div>
                      </div>

                      {serving.fit === "NOT_COMPATIBLE" ? (
                        <p className="font-body-sm text-body-sm text-on-error-container">
                          Esta receta no es compatible. Necesita un reemplazo antes de servirse.
                        </p>
                      ) : (
                        <>
                          <ul className="mb-md">
                            {serving.components
                              .filter((c) => c.proposedQuantity > 0)
                              .map((c) => (
                                <li
                                  key={c.id}
                                  className="flex items-baseline justify-between gap-md border-b border-outline-variant/40 py-sm last:border-0"
                                >
                                  <span className="min-w-0 font-body-sm text-body-sm text-on-surface-variant">
                                    {c.label}
                                    {c.cookingMethod && (
                                      <span className="ml-2 font-label-md text-label-md text-outline">
                                        {COOKING_METHOD_LABELS[c.cookingMethod]}
                                      </span>
                                    )}
                                  </span>
                                  <span className="shrink-0 font-body-md text-body-md font-semibold tabular-nums text-on-surface">
                                    {g(c.proposedQuantity)} {c.unit === "G" ? "g" : "ml"}
                                    {c.changed && (
                                      <span className="ml-1.5 font-label-md text-label-md font-normal text-outline">
                                        (base {g(c.baseQuantity)})
                                      </span>
                                    )}
                                  </span>
                                </li>
                              ))}
                          </ul>

                          {/* Una persona sin seguimiento no ve "te quedan 0 kcal" (§10) */}
                          {countsCalories(profile) || profile.trackingMode === "BASIC" ? (
                            <div className="mb-md flex flex-wrap gap-x-md gap-y-1 rounded-2xl bg-surface-container-low px-md py-sm">
                              {(["energy_kcal", "protein_g", "carbohydrates_g", "fat_g"] as const).map(
                                (key) => {
                                  const state = serving.nutrition.completeness[key];
                                  const val = roundForDisplay(
                                    serving.nutrition.values[key],
                                    key === "energy_kcal" ? 0 : 1,
                                  );
                                  return (
                                    <span
                                      key={key}
                                      className="font-body-sm text-body-sm text-on-surface-variant"
                                    >
                                      {NUTRIENT_LABELS[key].label}:{" "}
                                      {state === "UNKNOWN" || val === null ? (
                                        <span className="text-outline">sin datos</span>
                                      ) : (
                                        <strong className="tabular-nums text-on-surface">
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
                            <p className="mb-md font-body-sm text-body-sm text-on-surface-variant">
                              Sin seguimiento: recibe su porción sin conteo de calorías.
                            </p>
                          )}
                        </>
                      )}

                      {serving.suggestions.length > 0 && (
                        <div className="mb-md">
                          <Notice icon="swap_horiz">
                            {serving.suggestions.map((s) => (
                              <div
                                key={s.componentId}
                                className="flex flex-wrap items-center justify-between gap-sm"
                              >
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
                          </Notice>
                        </div>
                      )}

                      {acceptedByMember.get(serving.memberId)?.length ? (
                        <p className="mb-md font-body-sm text-body-sm text-on-surface-variant">
                          {assignment
                            ? "Reemplazo guardado para esta comida."
                            : "Reemplazo aplicado (vista previa)."}{" "}
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
                        <details className="mt-auto font-body-sm text-body-sm">
                          <summary className="cursor-pointer font-semibold text-primary">
                            ¿Por qué?
                          </summary>
                          <ul className="mt-sm space-y-1.5 text-on-surface-variant">
                            {serving.reasons.map((r, i) => (
                              <li key={`${r.code}-${i}`}>{r.text}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </Card>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section
            title="Preparar para la familia"
            hint="No es la receta multiplicada por personas: es la suma exacta de las porciones de cada uno."
          >
            <Card>
              <ul className="divide-y divide-outline-variant/40">
                {proyeccion.totals.map((total) => (
                  <li key={total.componentId} className="px-md py-sm">
                    <div className="flex items-baseline justify-between gap-md">
                      <span className="font-body-md text-body-md font-semibold text-on-surface">
                        {total.label}
                      </span>
                      <span className="shrink-0 font-headline-sm text-headline-sm tabular-nums text-primary">
                        {g(total.total)} {total.unit}
                      </span>
                    </div>
                    {total.byMethod.length > 1 && (
                      <ul className="mt-sm flex flex-wrap gap-xs">
                        {total.byMethod.map((group, i) => (
                          <li key={i}>
                            <Chip>
                              {group.method
                                ? COOKING_METHOD_LABELS[group.method as never]
                                : "Sin método"}
                              {" · "}
                              {group.members.join(", ")}: {g(group.quantity)} {total.unit}
                            </Chip>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </Section>

          {proyeccion.needsAttention.length > 0 && (
            <Notice icon="priority_high">
              Revisa a {proyeccion.needsAttention.map((n) => n.memberName).join(", ")}: esta receta
              no cuadra con su configuración tal como está.
            </Notice>
          )}
        </>
      )}
    </AppShell>
  );
}
