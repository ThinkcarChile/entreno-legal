/**
 * E2E §30 — RED ROTA en una escritura importante: servir lo planificado.
 * Timeout, 500, sin conexión, y la respuesta que se pierde DESPUÉS de que el
 * servidor escribió. La interfaz jamás muestra un éxito falso; al reintentar,
 * el efecto físico es uno solo.
 *
 * Lo que este archivo afirma del producto:
 *  · Un fallo de red se ve como fallo (aviso o pantalla de error), nunca como
 *    "Servido:". Mientras la acción está en vuelo, el botón está deshabilitado.
 *  · Si la petición no llegó, el reintento sirve UNA vez: registros = porciones,
 *    un MEAL_SERVED.
 *  · Si la petición SÍ llegó y la respuesta se perdió, el servidor ya sirvió:
 *    al recargar la interfaz muestra la verdad (ya no hay botón de servir) y
 *    el efecto sigue siendo uno. El reintento desde una pestaña vieja lo cubre
 *    concurrencia.spec.ts ("No quedaban porciones por servir").
 *
 * Cómo se rompe la red: `page.route` intercepta SOLO el POST de la acción de
 * servidor (cabecera `next-action`); las navegaciones siguen normales.
 * `context.setOffline(true)` corta todo.
 *
 * HISTORIA QUE NO SE BORRA: igual que cocina.spec.ts, no se vacía nada. Cada
 * caso reclama su slot libre y confirma su propia comida (sin sembrar lotes:
 * servir sin stock también es un efecto físico —registros + faltantes— y es
 * lo que se cuenta).
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, recargar, hoySantiago } from "../fixtures/contrato";
import { admin, hogarDe } from "../fixtures/admin";

test.describe.configure({ timeout: 150_000 });

// ---------------------------------------------------------------------------
// Utilería de cocina (copia deliberada; ver cocina.spec.ts).
// ---------------------------------------------------------------------------

type ComidaBase = "BREAKFAST" | "LUNCH" | "TEA" | "DINNER";

const ETIQUETA_COMIDA: Record<ComidaBase, string> = {
  BREAKFAST: "Desayuno",
  LUNCH: "Almuerzo",
  TEA: "Once",
  DINNER: "Cena",
};
const ORDEN_SLOTS: ComidaBase[] = ["LUNCH", "DINNER", "BREAKFAST", "TEA"];

interface Slot {
  fecha: string;
  mealType: ComidaBase;
  etiqueta: string;
}
interface Receta {
  versionId: string;
  nombre: string;
}
interface Proyeccion {
  id: string;
  memberId: string;
  status: string;
}
interface Registro {
  id: string;
  memberId: string;
  status: string;
}

function lista<T>(v: T[] | T | null | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

function lunesDe(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const diaSemana = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return sumarDias(fecha, -(diaSemana === 0 ? 6 : diaSemana - 1));
}

function tituloDelDia(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const nombre = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("es-CL", {
    timeZone: "UTC",
    weekday: "long",
  });
  return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${d}`;
}

async function reservarSlotLibre(hogar: string): Promise<Slot> {
  const hoy = hoySantiago();
  const db = admin();
  for (let semana = 0; semana < 12; semana++) {
    const inicio = lunesDe(sumarDias(hoy, 7 * semana));
    const { data: plan, error } = await db
      .from("weekly_plans")
      .select("id")
      .eq("household_id", hogar)
      .eq("week_start", inicio)
      .limit(1)
      .maybeSingle();
    falla("weekly_plans", error);

    const ocupados = new Set<string>();
    if (plan) {
      const { data: dias, error: errorDias } = await db
        .from("weekly_plan_days")
        .select("id, plan_date")
        .eq("plan_id", plan.id as string);
      falla("weekly_plan_days", errorDias);
      const fechaDeDia = new Map((dias ?? []).map((d) => [d.id as string, d.plan_date as string]));
      if (fechaDeDia.size > 0) {
        const { data: asignaciones, error: errorAsig } = await db
          .from("meal_assignments")
          .select("day_id, meal_type")
          .in("day_id", [...fechaDeDia.keys()]);
        falla("meal_assignments", errorAsig);
        for (const a of asignaciones ?? []) {
          ocupados.add(`${fechaDeDia.get(a.day_id as string)}:${a.meal_type as string}`);
        }
      }
    }

    for (let d = 0; d < 7; d++) {
      const fecha = sumarDias(inicio, d);
      if (fecha < hoy) continue;
      for (const mealType of ORDEN_SLOTS) {
        if (!ocupados.has(`${fecha}:${mealType}`)) {
          return { fecha, mealType, etiqueta: ETIQUETA_COMIDA[mealType] };
        }
      }
    }
  }
  throw new Error(
    "No queda ningún slot libre en 12 semanas: el hogar sintético necesita un hogar nuevo " +
      "(la historia servida no se puede borrar, y vaciarCocina lo intenta en cascada).",
  );
}

interface FilaVersion {
  id: string;
  status: string;
  meal_types: string[] | null;
}
interface FilaPlantilla {
  id: string;
  name: string;
  current_version_id: string | null;
  meal_template_versions: FilaVersion[] | FilaVersion | null;
}

/** Cualquier receta publicada que se pueda planificar en esa comida. */
async function recetaPublicada(mealType: ComidaBase): Promise<Receta | null> {
  const { data, error } = await admin()
    .from("meal_templates")
    .select(
      `id, name, current_version_id,
       meal_template_versions!meal_template_versions_template_id_fkey ( id, status, meal_types )`,
    )
    .eq("is_active", true)
    .not("current_version_id", "is", null)
    .order("name");
  falla("recetas publicadas", error);
  for (const t of (data ?? []) as unknown as FilaPlantilla[]) {
    const version = lista(t.meal_template_versions).find((v) => v.id === t.current_version_id);
    if (!version || version.status !== "PUBLISHED") continue;
    const tipos = version.meal_types ?? [];
    if (tipos.length > 0 && !tipos.includes(mealType)) continue;
    return { versionId: version.id, nombre: t.name };
  }
  return null;
}

function tarjetaDelDia(page: Page, fecha: string): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: tituloDelDia(fecha), exact: true }) })
    .last();
}

function filaComida(tarjeta: Locator, etiqueta: string): Locator {
  return tarjeta
    .locator(":scope > div > div")
    .filter({ has: tarjeta.page().getByText(etiqueta, { exact: true }) });
}

async function asignacionDe(hogar: string, slot: Slot): Promise<{ id: string; status: string }> {
  const db = admin();
  const { data: plan, error: errorPlan } = await db
    .from("weekly_plans")
    .select("id")
    .eq("household_id", hogar)
    .eq("week_start", lunesDe(slot.fecha))
    .limit(1)
    .maybeSingle();
  falla("weekly_plans", errorPlan);
  if (!plan) throw new Error(`No existe la semana ${lunesDe(slot.fecha)} del hogar sintético.`);
  const { data: dia, error: errorDia } = await db
    .from("weekly_plan_days")
    .select("id")
    .eq("plan_id", plan.id as string)
    .eq("plan_date", slot.fecha)
    .limit(1)
    .maybeSingle();
  falla("weekly_plan_days", errorDia);
  if (!dia) throw new Error(`No existe el día ${slot.fecha} en la semana del hogar sintético.`);
  const { data: asignacion, error } = await db
    .from("meal_assignments")
    .select("id, status")
    .eq("day_id", dia.id as string)
    .eq("meal_type", slot.mealType)
    .limit(1)
    .maybeSingle();
  falla("meal_assignments", error);
  if (!asignacion) throw new Error(`No hay comida ${slot.mealType} el ${slot.fecha}.`);
  return { id: asignacion.id as string, status: asignacion.status as string };
}

async function planificarYConfirmar(
  page: Page,
  hogar: string,
  slot: Slot,
  receta: Receta,
): Promise<string> {
  await page.goto(`/plan?semana=${slot.fecha}`);
  const fila = filaComida(tarjetaDelDia(page, slot.fecha), slot.etiqueta);
  await expect(fila.getByText("Sin planificar", { exact: true })).toBeVisible();

  await fila.getByRole("button", { name: "Planificar", exact: true }).click();
  await fila
    .getByRole("combobox", { name: `Planificar ${slot.etiqueta}` })
    .selectOption({ value: receta.versionId });
  await expect(page.getByText("Comida planificada.")).toBeVisible();

  await recargar(page);
  await expect(fila.getByText(receta.nombre)).toBeVisible();

  await fila.getByRole("button", { name: "Confirmar y guardar porciones" }).click();
  await expect(page.getByText(/Comida confirmada con \d+ porciones guardadas\./)).toBeVisible({
    timeout: 30_000,
  });

  await recargar(page);
  await expect(fila.getByRole("button", { name: "Servir lo planificado" })).toBeVisible();

  const asignacion = await asignacionDe(hogar, slot);
  expect(asignacion.status).toBe("CONFIRMED");
  return asignacion.id;
}

async function proyeccionesDe(assignmentId: string): Promise<Proyeccion[]> {
  const { data, error } = await admin()
    .from("member_serving_projections")
    .select("id, member_id, status")
    .eq("assignment_id", assignmentId);
  falla("member_serving_projections", error);
  return (data ?? []).map((p) => ({
    id: p.id as string,
    memberId: p.member_id as string,
    status: p.status as string,
  }));
}

async function registrosDe(assignmentId: string): Promise<Registro[]> {
  const { data, error } = await admin()
    .from("meal_serving_records")
    .select("id, member_id, status")
    .eq("assignment_id", assignmentId);
  falla("meal_serving_records", error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    memberId: r.member_id as string,
    status: r.status as string,
  }));
}

async function eventosServido(assignmentId: string): Promise<number> {
  const { count, error } = await admin()
    .from("audit_events")
    .select("id", { count: "exact", head: true })
    .eq("action", "MEAL_SERVED")
    .eq("subject_id", assignmentId);
  falla("audit_events", error);
  return count ?? 0;
}

// ---------------------------------------------------------------------------

interface ComidaLista {
  hogar: string;
  slot: Slot;
  assignmentId: string;
  proyecciones: Proyeccion[];
}

/** Una comida confirmada y lista para servir, o `null` si staging no tiene recetas. */
async function comidaConfirmada(page: Page): Promise<ComidaLista | null> {
  const hogar = await hogarDe("A");
  const slot = await reservarSlotLibre(hogar);
  const receta = await recetaPublicada(slot.mealType);
  if (!receta) return null;
  const assignmentId = await planificarYConfirmar(page, hogar, slot, receta);
  const proyecciones = await proyeccionesDe(assignmentId);
  expect(proyecciones.length).toBeGreaterThan(0);
  expect(await registrosDe(assignmentId)).toHaveLength(0);
  return { hogar, slot, assignmentId, proyecciones };
}

type Modo = "500" | "timeout" | "perdida";

/** ¿Es el POST de una acción de servidor de Next? Solo eso se intercepta. */
function esAccionDeServidor(route: import("@playwright/test").Route): boolean {
  const req = route.request();
  return req.method() === "POST" && req.headers()["next-action"] !== undefined;
}

/**
 * Rompe la red para la próxima acción de servidor:
 *  · "500": el servidor "responde" 500 sin haber procesado nada;
 *  · "timeout": la petición se cuelga tres segundos y muere sin respuesta;
 *  · "perdida": la petición SÍ llega y el servidor la procesa; lo que se
 *    pierde es la respuesta de vuelta.
 */
async function romperLaRed(page: Page, modo: Modo): Promise<void> {
  await page.route("**/*", async (route) => {
    if (!esAccionDeServidor(route)) return route.continue();
    if (modo === "500") return route.fulfill({ status: 500, contentType: "text/plain", body: "" });
    if (modo === "timeout") {
      await new Promise((r) => setTimeout(r, 3_000));
      return route.abort("timedout");
    }
    await route.fetch();
    return route.fulfill({ status: 502, contentType: "text/plain", body: "" });
  });
}

async function repararLaRed(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" });
}

function botonServir(page: Page, slot: Slot): Locator {
  return filaComida(tarjetaDelDia(page, slot.fecha), slot.etiqueta).getByRole("button", {
    name: "Servir lo planificado",
  });
}

/** Lo que la persona ve cuando algo falló: un aviso o la pantalla de error. */
function fallo(page: Page): Locator {
  return page
    .getByRole("alert")
    .or(page.getByRole("heading", { name: "Algo falló de nuestro lado", exact: true }))
    .first();
}

const exito = (page: Page) => page.getByText(/Servido: \d+ porci/);

async function afirmarUnSoloServido(c: ComidaLista): Promise<void> {
  const registros = await registrosDe(c.assignmentId);
  expect(registros).toHaveLength(c.proyecciones.length);
  expect(new Set(registros.map((r) => r.memberId)).size).toBe(registros.length);
  expect((await proyeccionesDe(c.assignmentId)).every((p) => p.status === "SERVED")).toBe(true);
  expect((await asignacionDe(c.hogar, c.slot)).status).toBe("SERVED");
  expect(await eventosServido(c.assignmentId)).toBe(1);
}

test.describe("Servir con la red rota (§30)", () => {
  test("500 del servidor: sin éxito falso; el reintento sirve una sola vez", async ({ comoA }) => {
    const c = await comidaConfirmada(comoA);
    if (!c) {
      test.skip(true, "staging no tiene recetas publicadas: NOT_RUN");
      return;
    }

    await romperLaRed(comoA, "500");
    await botonServir(comoA, c.slot).click();
    await expect(fallo(comoA)).toBeVisible({ timeout: 30_000 });
    await expect(exito(comoA)).toHaveCount(0);
    // Nada llegó al servidor: cero efecto.
    expect(await registrosDe(c.assignmentId)).toHaveLength(0);
    expect((await asignacionDe(c.hogar, c.slot)).status).toBe("CONFIRMED");

    await repararLaRed(comoA);
    await recargar(comoA);
    await botonServir(comoA, c.slot).click();
    await expect(exito(comoA)).toBeVisible({ timeout: 30_000 });
    await afirmarUnSoloServido(c);
  });

  test("timeout: el botón espera deshabilitado, la caída se ve como fallo, y el reintento sirve una sola vez", async ({
    comoA,
  }) => {
    const c = await comidaConfirmada(comoA);
    if (!c) {
      test.skip(true, "staging no tiene recetas publicadas: NOT_RUN");
      return;
    }

    await romperLaRed(comoA, "timeout");
    const boton = botonServir(comoA, c.slot);
    await boton.click();
    // Mientras la acción está en vuelo no se puede apretar de nuevo.
    await expect(boton).toBeDisabled();
    await expect(exito(comoA)).toHaveCount(0);
    await expect(fallo(comoA)).toBeVisible({ timeout: 30_000 });
    await expect(exito(comoA)).toHaveCount(0);
    expect(await registrosDe(c.assignmentId)).toHaveLength(0);

    await repararLaRed(comoA);
    await recargar(comoA);
    await botonServir(comoA, c.slot).click();
    await expect(exito(comoA)).toBeVisible({ timeout: 30_000 });
    await afirmarUnSoloServido(c);
  });

  test("sin conexión: la escritura no se pierde en silencio; al volver la red, un solo servido", async ({
    comoA,
  }) => {
    const c = await comidaConfirmada(comoA);
    if (!c) {
      test.skip(true, "staging no tiene recetas publicadas: NOT_RUN");
      return;
    }
    await comoA.goto(`/plan?semana=${c.slot.fecha}`);
    const boton = botonServir(comoA, c.slot);
    await expect(boton).toBeVisible();

    await comoA.context().setOffline(true);
    try {
      await boton.click();
      await expect(fallo(comoA)).toBeVisible({ timeout: 30_000 });
      await expect(exito(comoA)).toHaveCount(0);
      expect(await registrosDe(c.assignmentId)).toHaveLength(0);
    } finally {
      await comoA.context().setOffline(false);
    }

    await recargar(comoA);
    await botonServir(comoA, c.slot).click();
    await expect(exito(comoA)).toBeVisible({ timeout: 30_000 });
    await afirmarUnSoloServido(c);
  });

  test("respuesta perdida tras escribir: sin éxito falso, y al recargar la interfaz muestra la verdad (un solo servido)", async ({
    comoA,
  }) => {
    const c = await comidaConfirmada(comoA);
    if (!c) {
      test.skip(true, "staging no tiene recetas publicadas: NOT_RUN");
      return;
    }

    await romperLaRed(comoA, "perdida");
    await botonServir(comoA, c.slot).click();
    await expect(fallo(comoA)).toBeVisible({ timeout: 30_000 });
    await expect(exito(comoA)).toHaveCount(0);
    // El servidor SÍ sirvió: la persona no lo vio, pero pasó.
    await afirmarUnSoloServido(c);

    await repararLaRed(comoA);
    await recargar(comoA);
    // La verdad después de recargar: ya no hay nada que servir, toca anotar.
    await expect(botonServir(comoA, c.slot)).toHaveCount(0);
    await expect(
      filaComida(tarjetaDelDia(comoA, c.slot.fecha), c.slot.etiqueta).getByRole("link", {
        name: "Anotar lo que se comió",
      }),
    ).toBeVisible();
    await afirmarUnSoloServido(c);
  });
});
