import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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
  const { assignmentId } = await params;

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

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="plan" />
      <Link href="/plan" className="text-sm text-[var(--accent)]">
        ← Semana
      </Link>

      <header className="mb-4 mt-2">
        <h1 className="text-2xl font-semibold">{receta?.name ?? "Comida confirmada"}</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          {fecha && <span className="capitalize">{formatDate(fecha)}</span>} ·{" "}
          {MEAL_TYPE_LABELS[asignacion.meal_type as MealType]}
          {receta?.version_number && <> · receta v{receta.version_number}</>}
        </p>
        {asignacion.confirmed_at && (
          <p className="mt-1 text-xs text-[var(--ink)]/50">
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
        <p className="mt-1 text-xs text-[var(--ink)]/50">
          Comieron: {nombres.length === 0 ? "toda la familia" : nombres.join(", ")}.
        </p>
        {asignacion.needs_review && (
          <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {asignacion.review_reason ?? "Algo cambió alrededor de esta comida"}. Lo guardado acá no
            se tocó: sigue siendo lo que se calculó ese día.
          </p>
        )}
      </header>

      {servings.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 p-6 text-center text-sm text-[var(--ink)]/60">
          Esta comida todavía no tiene porciones guardadas.
        </p>
      ) : (
        <>
          <section className="mb-6 space-y-3">
            {servings.map((s) => (
              <article key={s.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <h2 className="font-medium">{s.memberName}</h2>
                  <span className="shrink-0 text-[11px] text-[var(--ink)]/50">
                    nivel {s.adaptationLevel} · {s.fit}
                  </span>
                </div>

                <ul className="mb-3 space-y-1 text-sm">
                  {s.components
                    .filter((c) => (c.proposed_quantity ?? 0) > 0)
                    .map((c, i) => (
                      <li key={`${c.label}-${i}`} className="flex justify-between gap-3">
                        <span>
                          {c.label}
                          {c.cooking_method && (
                            <span className="ml-2 text-[11px] text-[var(--ink)]/50">
                              {COOKING_METHOD_LABELS[c.cooking_method as never] ?? c.cooking_method}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {g(c.proposed_quantity ?? 0)} {c.unit === "G" ? "g" : "ml"}
                        </span>
                      </li>
                    ))}
                </ul>

                <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-[var(--paper)] px-3 py-2 text-xs">
                  {(["energy_kcal", "protein_g", "carbohydrates_g", "fat_g"] as NutrientKey[]).map(
                    (key) => {
                      const valor = (s.nutrition as Record<string, number | null>)[key];
                      const estado = (s.completeness as Record<string, string>)[key];
                      const redondeado = roundForDisplay(valor, key === "energy_kcal" ? 0 : 1);
                      return (
                        <span key={key} className="text-[var(--ink)]/70">
                          {NUTRIENT_LABELS[key].label}:{" "}
                          {redondeado === null ? (
                            <span className="text-[var(--ink)]/40">sin datos</span>
                          ) : (
                            <strong className="tabular-nums">
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
                  <p className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Se aplicó un reemplazo aceptado por la persona.
                  </p>
                )}

                {s.reasons.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-[var(--accent)]">¿Por qué?</summary>
                    <ul className="mt-2 space-y-1.5 text-xs text-[var(--ink)]/70">
                      {s.reasons.map((r, i) => (
                        <li key={`${r.code}-${i}`}>{r.text}</li>
                      ))}
                    </ul>
                  </details>
                )}

                <p className="mt-2 text-[10px] text-[var(--ink)]/35">
                  Calculado con {s.optimizerVersion} · perfil {s.profileId.slice(0, 8)} · receta{" "}
                  {s.versionId.slice(0, 8)}
                </p>
              </article>
            ))}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
              Se preparó
            </h2>
            <ul className="divide-y divide-[var(--ink)]/5 rounded-2xl border border-[var(--ink)]/10 bg-white">
              {[...totales.entries()].map(([label, datos]) => (
                <li key={label} className="px-4 py-3">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{label}</span>
                    <span className="tabular-nums">
                      {g(datos.total)} {datos.unidad}
                    </span>
                  </div>
                  {datos.porMetodo.size > 1 && (
                    <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--ink)]/60">
                      {[...datos.porMetodo.entries()].map(([metodo, cantidad]) => (
                        <li key={metodo} className="flex justify-between">
                          <span>{COOKING_METHOD_LABELS[metodo as never] ?? metodo}</span>
                          <span className="tabular-nums">
                            {g(cantidad)} {datos.unidad}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
