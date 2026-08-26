import { uuidParam } from "@/lib/route-params";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, EmptyState, ErrorNote, Icon, Notice, Section } from "@/components/ui";
import { roundForDisplay } from "@/domain/catalog/nutrition";
import { NUTRIENT_LABELS, type NutrientKey } from "@/domain/catalog/types";
import { formatDate } from "@/domain/nutrition/calendar";
import { COOKING_METHOD_LABELS, MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadConfirmedServings } from "../../queries";
import { dateString, parseRow, parseRows } from "@/lib/supabase/rows";
import { z } from "zod";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ assignmentId: string }>;
}

/**
 * Lo que quedó guardado al confirmar una comida.
 *
 * Esta pantalla es la respuesta a "¿por qué se sirvió esto?": cantidades,
 * nutrición, razones, reemplazos aceptados y las versiones exactas de receta,
 * perfil y optimizador con las que se calculó. Nada se recalcula acá — se lee.
 */
export default async function ComidaConfirmadaPage({ params }: Props) {
  const { assignmentId: assignmentIdCrudo } = await params;
  const assignmentId = uuidParam(assignmentIdCrudo);

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/plan/comida/${assignmentId}`);

  const { data: asignacion, error } = await supabase
    .from("meal_assignments")
    .select(
      `id, meal_type, status, confirmed_at, confirm_count, needs_review, review_reason,
       weekly_plan_days ( plan_date ),
       meal_template_versions ( name, version_number )`,
    )
    .eq("id", assignmentId)
    .maybeSingle();
  if (error) throw new DataAccessError("comida confirmada", error);
  if (!asignacion) notFound();

  // Los embeds se validan, no se castean: una fila con otra forma tiene que
  // gritar, no convertirse en una pantalla sin fecha ni nombre de receta.
  const uno = <T extends z.ZodTypeAny>(schema: T) =>
    z
      .union([z.array(schema), schema, z.null()])
      .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

  const cabecera = parseRow(
    z.object({
      weekly_plan_days: uno(z.object({ plan_date: dateString })),
      meal_template_versions: uno(z.object({ name: z.string(), version_number: z.number().int() })),
    }),
    asignacion,
    "cabecera de la comida confirmada",
  );
  const fecha = cabecera.weekly_plan_days?.plan_date ?? null;
  const receta = cabecera.meal_template_versions;

  // §2: quiénes comieron esta comida. Sin filas, comió toda la familia.
  const { data: comensales, error: comensalesError } = await supabase
    .from("meal_assignment_participants")
    .select("household_members ( display_name )")
    .eq("assignment_id", assignmentId);
  if (comensalesError) throw new DataAccessError("comensales de la comida", comensalesError);
  const nombres = parseRows(
    z.object({ household_members: uno(z.object({ display_name: z.string() })) }),
    comensales,
    "comensales de la comida",
  )
    .map((c) => c.household_members?.display_name)
    .filter((n): n is string => Boolean(n));

  const servings = await loadConfirmedServings(supabase, assignmentId);

  const totales = new Map<string, { unidad: string; total: number; porMetodo: Map<string, number> }>();
  for (const s of servings) {
    for (const c of s.components) {
      const cantidad = c.proposed_quantity ?? 0;
      if (cantidad <= 0) continue;
      const entrada = totales.get(c.label) ?? {
        unidad: c.unit === "G" ? "g" : "ml",
        total: 0,
        porMetodo: new Map<string, number>(),
      };
      entrada.total += cantidad;
      const metodo = c.cooking_method ?? "—";
      entrada.porMetodo.set(metodo, (entrada.porMetodo.get(metodo) ?? 0) + cantidad);
      totales.set(c.label, entrada);
    }
  }

  const g = (n: number) => Math.round(n).toLocaleString("es-CL");

  const partes = [
    fecha ? formatDate(fecha) : null,
    MEAL_TYPE_LABELS[asignacion.meal_type as MealType],
    receta?.version_number ? `receta v${receta.version_number}` : null,
  ].filter(Boolean);
  const crudo = partes.join(" · ");
  const subtitulo = crudo.charAt(0).toUpperCase() + crudo.slice(1);

  return (
    <AppShell active="plan" title={receta?.name ?? "Comida confirmada"} subtitle={subtitulo}>
      <div className="mt-md space-y-md">
        <Link
          href="/plan"
          className="inline-flex items-center gap-xs font-body-sm text-body-sm font-semibold text-primary"
        >
          <Icon name="arrow_back" className="text-[18px]" />
          Semana
        </Link>

        <Card className="p-md">
          {asignacion.confirmed_at && (
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Confirmada el{" "}
              {new Date(asignacion.confirmed_at).toLocaleString("es-CL", {
                timeZone: "America/Santiago",
              })}
              . Estas porciones quedaron guardadas tal como se calcularon.
              {Number(asignacion.confirm_count ?? 0) > 1 && (
                <> Se recalculó {asignacion.confirm_count} veces antes de servirse.</>
              )}
            </p>
          )}
          <p className="mt-sm flex items-start gap-sm font-body-sm text-body-sm text-on-surface-variant">
            <Icon name="group" className="mt-0.5 shrink-0 text-[18px] text-primary" />
            <span>Comieron: {nombres.length === 0 ? "toda la familia" : nombres.join(", ")}.</span>
          </p>
        </Card>

        {asignacion.needs_review && (
          <Notice icon="pending_actions">
            {asignacion.review_reason ?? "Algo cambió alrededor de esta comida"}. Lo guardado acá no
            se tocó: sigue siendo lo que se calculó ese día.
          </Notice>
        )}
      </div>

      {servings.length === 0 ? (
        <div className="mt-lg">
          <EmptyState icon="no_meals">
            Esta comida todavía no tiene porciones guardadas.
          </EmptyState>
        </div>
      ) : (
        <>
          <Section title="Se sirvió" className="mt-lg">
            <ul className="space-y-md">
              {servings.map((s) => (
                <li key={s.id}>
                  <Card as="article" className="p-md">
                    <div className="mb-md flex items-start gap-md">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-tertiary-fixed font-headline-sm text-headline-sm text-on-tertiary-fixed">
                        {s.memberName.slice(0, 1)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-headline-sm text-headline-sm text-on-surface">
                          {s.memberName}
                        </h3>
                        <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
                          nivel {s.adaptationLevel} · {s.fit}
                        </p>
                      </div>
                    </div>

                    {s.clinicalStatus === "CLINICALLY_INVALIDATED" && (
                      <div className="mb-sm">
                        <ErrorNote>
                          <Icon name="block" className="mr-1 align-[-4px] text-[18px]" />
                          <strong>NO SERVIR SIN REVISIÓN</strong> — esta porción quedó clínicamente
                          invalidada. El detalle vive en Salud, con quien tiene permiso.
                        </ErrorNote>
                      </div>
                    )}
                    {s.clinicalStatus === "REVIEW_REQUIRED" && (
                      <div className="mb-sm">
                        <Notice icon="stethoscope">
                          Adaptación/revisión requerida para esta persona antes de servir.
                        </Notice>
                      </div>
                    )}
                    {/*
                      SIN EVALUAR ≠ compatible. Antes solo se pintaba algo si el
                      estado era CLINICALLY_INVALIDATED o REVIEW_REQUIRED, así
                      que una porción que JAMÁS pasó por el motor clínico se veía
                      idéntica a una evaluada y limpia. Esa es exactamente la
                      mentira que el Sprint 11 prohíbe: UNKNOWN NUNCA SIGNIFICA
                      NORMAL. Las dos ramas de abajo son las dos caras que
                      faltaban.
                    */}
                    {(s.clinicalStatus === "NOT_ASSESSED" || !s.clinicalAssessed) && (
                      <div className="mb-sm">
                        <Notice icon="help">
                          <strong>SIN EVALUACIÓN CLÍNICA</strong> — esta porción no pasó por el
                          motor clínico, así que no está dicho que sea compatible ni que no lo sea.
                          Si esta persona tiene restricciones médicas, revísalas en Salud antes de
                          servir.
                        </Notice>
                      </div>
                    )}
                    {(s.clinicalStatus === "COMPATIBLE" ||
                      s.clinicalStatus === "COMPATIBLE_WITH_CAUTION") && (
                      <div className="mb-sm">
                        <Chip
                          tono={s.clinicalStatus === "COMPATIBLE" ? "primario" : "atencion"}
                          icon={s.clinicalStatus === "COMPATIBLE" ? "verified" : "info"}
                        >
                          {s.clinicalStatus === "COMPATIBLE"
                            ? "Evaluada: sin conflictos clínicos"
                            : "Evaluada: compatible con precauciones"}
                        </Chip>
                      </div>
                    )}
                    {s.clinicalSource && (
                      <p className="mb-sm font-body-sm text-body-sm text-on-surface-variant">
                        {s.clinicalSource === "RECIPE_BASE_ESTIMATE"
                          ? "Evaluación preliminar basada en la porción base de la receta."
                          : s.clinicalSource === "NONE"
                            ? "Sin nutrición evaluable para esta comida."
                            : "Evaluado con tu porción individual."}
                      </p>
                    )}
                    {s.unverifiableConstraints.length > 0 && (
                      <div className="mb-sm">
                        <Chip tono="atencion" icon="help">
                          {s.unverifiableConstraints.includes("ENERGY_MAX")
                            ? "Tope de calorías SIN verificar (ficha incompleta)"
                            : "Mínimo de proteína SIN verificar (ficha incompleta)"}
                        </Chip>
                      </div>
                    )}

                    <ul className="mb-md grid grid-cols-2 gap-sm sm:grid-cols-3">
                      {s.components
                        .filter((c) => (c.proposed_quantity ?? 0) > 0)
                        .map((c, i) => (
                          <li
                            key={`${c.label}-${i}`}
                            className="flex flex-col items-center gap-xs rounded-xl bg-surface-container px-sm py-md text-center"
                          >
                            <span className="font-label-md text-label-md text-on-surface-variant">
                              {c.label}
                            </span>
                            <span className="font-headline-sm text-headline-sm tabular-nums text-on-surface">
                              {g(c.proposed_quantity ?? 0)} {c.unit === "G" ? "g" : "ml"}
                            </span>
                            {c.cooking_method && (
                              <span className="font-body-sm text-body-sm text-on-surface-variant">
                                {COOKING_METHOD_LABELS[c.cooking_method as never] ??
                                  c.cooking_method}
                              </span>
                            )}
                          </li>
                        ))}
                    </ul>

                    <div className="mb-sm flex flex-wrap gap-x-md gap-y-1 rounded-2xl bg-surface-container-low px-md py-sm">
                      {(["energy_kcal", "protein_g", "carbohydrates_g", "fat_g"] as NutrientKey[]).map(
                        (key) => {
                          const valor = (s.nutrition as Record<string, number | null>)[key];
                          const estado = (s.completeness as Record<string, string>)[key];
                          const redondeado = roundForDisplay(valor, key === "energy_kcal" ? 0 : 1);
                          return (
                            <span
                              key={key}
                              className="font-body-sm text-body-sm text-on-surface-variant"
                            >
                              {NUTRIENT_LABELS[key].label}:{" "}
                              {redondeado === null ? (
                                <span className="text-outline">sin datos</span>
                              ) : (
                                <strong className="tabular-nums text-on-surface">
                                  {estado === "PARTIAL" && "≥ "}
                                  {redondeado.toLocaleString("es-CL")} {NUTRIENT_LABELS[key].unit}
                                </strong>
                              )}
                            </span>
                          );
                        },
                      )}
                    </div>

                    {s.substitutions.length > 0 && (
                      <div className="mb-sm">
                        <Notice icon="swap_horiz">
                          Se aplicó un reemplazo aceptado por la persona.
                        </Notice>
                      </div>
                    )}

                    {s.reasons.length > 0 && (
                      <details className="font-body-sm text-body-sm">
                        <summary className="cursor-pointer font-semibold text-primary">
                          ¿Por qué?
                        </summary>
                        <ul className="mt-sm space-y-1.5 text-on-surface-variant">
                          {s.reasons.map((r, i) => (
                            <li key={`${r.code}-${i}`}>{r.text}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                    <p className="mt-sm font-label-md text-label-md text-outline">
                      Calculado con {s.optimizerVersion} · perfil {s.profileId.slice(0, 8)} · receta{" "}
                      {s.versionId.slice(0, 8)}
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Se preparó">
            <Card>
              <ul className="divide-y divide-outline-variant/40">
                {[...totales.entries()].map(([label, datos]) => (
                  <li key={label} className="px-md py-sm">
                    <div className="flex items-baseline justify-between gap-md">
                      <span className="font-body-md text-body-md font-semibold text-on-surface">
                        {label}
                      </span>
                      <span className="shrink-0 font-headline-sm text-headline-sm tabular-nums text-primary">
                        {g(datos.total)} {datos.unidad}
                      </span>
                    </div>
                    {datos.porMetodo.size > 1 && (
                      <ul className="mt-sm flex flex-wrap gap-xs">
                        {[...datos.porMetodo.entries()].map(([metodo, cantidad]) => (
                          <li key={metodo}>
                            <Chip>
                              {COOKING_METHOD_LABELS[metodo as never] ?? metodo}: {g(cantidad)}{" "}
                              {datos.unidad}
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
        </>
      )}
    </AppShell>
  );
}
