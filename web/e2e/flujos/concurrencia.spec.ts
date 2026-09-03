/**
 * E2E §28 — CONCURRENCIA: dos pestañas del MISMO usuario disparan la misma
 * escritura a la vez. Doble servir, doble consumir, doble recibir. Un solo
 * efecto físico, leído por admin() después de la carrera.
 *
 * Lo que este archivo afirma del producto:
 *  · Servir es idempotente DE ESTADO (0036): gana la porción quien mueve la
 *    fila PLANNED → SERVED; el segundo obtiene 0 y NO descuenta. Un solo
 *    registro por comensal, un solo MEAL_SERVED, un solo descuento.
 *  · Dar por comido es idempotente por clave (0038: `INTAKE-ASSUMED` +
 *    servido): dos toques a la vez dejan UNA declaración viva, y declarar no
 *    mueve el inventario.
 *  · Recibir la compra es idempotente por línea (K-22: `RECEIVE:<item>`): dos
 *    recepciones a la vez dejan UN lote por línea comprada.
 *
 * Las boletas las cubre otro agente (E); acá no se tocan.
 *
 * HISTORIA QUE NO SE BORRA: igual que cocina.spec.ts, no se vacía nada. Cada
 * describe reclama un slot libre y sigue sus ids por `admin()`.
 */
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { test, expect, recargar, hoySantiago, iniciarSesion } from "../fixtures/contrato";
import { admin, hogarDe, idDeUsuario } from "../fixtures/admin";

test.describe.configure({ mode: "serial", timeout: 180_000 });

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
interface Ingrediente {
  id: string;
  nombre: string;
}
interface Receta {
  versionId: string;
  nombre: string;
  ingredientes: Ingrediente[];
}
interface Ficha {
  id: string;
  nombre: string;
  hogar: string;
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
interface Renglon {
  id: string;
  recordId: string;
  label: string;
  ingredientId: string | null;
  servida: number;
  entregada: number;
  faltante: number;
}
interface Lote {
  id: string;
  ingredientId: string | null;
  cantidad: number;
  status: string;
}
interface Demanda {
  label: string;
  total: number;
}

function lista<T>(v: T[] | T | null | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function n(v: unknown): number {
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`número inválido desde PostgREST: ${String(v)}`);
  return x;
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

async function fichaDe(u: "A" | "B"): Promise<Ficha> {
  const [uid, hogar] = await Promise.all([idDeUsuario(u), hogarDe(u)]);
  const { data, error } = await admin()
    .from("household_members")
    .select("id, display_name")
    .eq("household_id", hogar)
    .eq("user_id", uid)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  falla(`ficha de ${u}`, error);
  if (!data) throw new Error(`El usuario ${u} no tiene ficha activa en su hogar de staging.`);
  return { id: data.id as string, nombre: data.display_name as string, hogar };
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

interface FilaComponente {
  ingredient_id: string | null;
  product_id: string | null;
  nested_version_id: string | null;
  unit: string;
  weight_basis: string;
}
interface FilaSlot {
  meal_slot_components: FilaComponente[] | FilaComponente | null;
}
interface FilaVersion {
  id: string;
  status: string;
  meal_types: string[] | null;
  meal_slots: FilaSlot[] | FilaSlot | null;
}
interface FilaPlantilla {
  id: string;
  name: string;
  current_version_id: string | null;
  meal_template_versions: FilaVersion[] | FilaVersion | null;
}

async function alimentosVisibles(hogar: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await admin()
    .from("ingredients")
    .select("id, display_name, is_active, household_id")
    .in("id", ids);
  falla("ingredients", error);
  const visibles = new Map<string, string>();
  for (const a of data ?? []) {
    const propio = a.household_id === null || a.household_id === hogar;
    if (a.is_active === true && propio) visibles.set(a.id as string, a.display_name as string);
  }
  return visibles;
}

async function recetaSembrable(
  hogar: string,
  mealType: ComidaBase,
  minIngredientes: number,
): Promise<Receta | null> {
  const { data, error } = await admin()
    .from("meal_templates")
    .select(
      `id, name, current_version_id,
       meal_template_versions!meal_template_versions_template_id_fkey ( id, status, meal_types,
         meal_slots ( meal_slot_components ( ingredient_id, product_id, nested_version_id, unit, weight_basis ) ) )`,
    )
    .eq("is_active", true)
    .not("current_version_id", "is", null);
  falla("recetas publicadas", error);

  const candidatas: { versionId: string; nombre: string; ingredientes: string[] }[] = [];
  for (const t of (data ?? []) as unknown as FilaPlantilla[]) {
    const version = lista(t.meal_template_versions).find((v) => v.id === t.current_version_id);
    if (!version || version.status !== "PUBLISHED") continue;
    const tipos = version.meal_types ?? [];
    if (tipos.length > 0 && !tipos.includes(mealType)) continue;
    const componentes = lista(version.meal_slots).flatMap((s) => lista(s.meal_slot_components));
    if (componentes.length === 0) continue;
    const sembrable = componentes.every(
      (c) =>
        c.ingredient_id !== null &&
        c.product_id === null &&
        c.nested_version_id === null &&
        c.unit === "G" &&
        c.weight_basis === "RAW",
    );
    if (!sembrable) continue;
    const ids = [...new Set(componentes.map((c) => c.ingredient_id as string))];
    if (ids.length < minIngredientes) continue;
    candidatas.push({ versionId: version.id, nombre: t.name, ingredientes: ids });
  }
  candidatas.sort(
    (a, b) => a.ingredientes.length - b.ingredientes.length || a.nombre.localeCompare(b.nombre),
  );

  const finalistas = candidatas.slice(0, 25);
  const visibles = await alimentosVisibles(hogar, [
    ...new Set(finalistas.flatMap((c) => c.ingredientes)),
  ]);
  for (const c of finalistas) {
    if (!c.ingredientes.every((id) => visibles.has(id))) continue;
    return {
      versionId: c.versionId,
      nombre: c.nombre,
      ingredientes: c.ingredientes.map((id) => ({ id, nombre: visibles.get(id)! })),
    };
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

async function planDe(hogar: string, slot: Slot): Promise<string> {
  const { data: plan, error } = await admin()
    .from("weekly_plans")
    .select("id")
    .eq("household_id", hogar)
    .eq("week_start", lunesDe(slot.fecha))
    .limit(1)
    .maybeSingle();
  falla("weekly_plans", error);
  if (!plan) throw new Error(`No existe la semana ${lunesDe(slot.fecha)} del hogar sintético.`);
  return plan.id as string;
}

async function asignacionDe(hogar: string, slot: Slot): Promise<{ id: string; status: string }> {
  const db = admin();
  const planId = await planDe(hogar, slot);
  const { data: dia, error: errorDia } = await db
    .from("weekly_plan_days")
    .select("id")
    .eq("plan_id", planId)
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

interface FilaComponenteServido {
  label: string;
  ingredient_id: string | null;
  proposed_quantity: unknown;
  unit: string;
}
interface FilaProyeccion {
  member_serving_components: FilaComponenteServido[] | FilaComponenteServido | null;
}

async function demandaPorIngrediente(assignmentId: string): Promise<Map<string, Demanda>> {
  const { data, error } = await admin()
    .from("member_serving_projections")
    .select("member_serving_components ( label, ingredient_id, proposed_quantity, unit )")
    .eq("assignment_id", assignmentId);
  falla("member_serving_components", error);
  const demanda = new Map<string, Demanda>();
  for (const p of (data ?? []) as unknown as FilaProyeccion[]) {
    for (const c of lista(p.member_serving_components)) {
      if (c.ingredient_id === null || c.unit !== "G") continue;
      const cantidad = n(c.proposed_quantity);
      if (cantidad <= 0) continue;
      const previa = demanda.get(c.ingredient_id) ?? { label: c.label, total: 0 };
      demanda.set(c.ingredient_id, { label: previa.label, total: previa.total + cantidad });
    }
  }
  return demanda;
}

async function sembrarLote(page: Page, ingrediente: Ingrediente, gramos: number): Promise<void> {
  await page.goto("/pantry");
  const crear = page.getByRole("button", { name: "Crear despensa, refrigerador y congelador" });
  if (await crear.isVisible()) {
    await crear.click();
    await expect(crear).toBeHidden();
  }
  await page.getByRole("button", { name: "Agregar algo a la despensa" }).click();
  const etiqueta = `${ingrediente.nombre} (E2E)`;
  await page.getByPlaceholder("Tomates de la feria").fill(etiqueta);
  await page
    .getByLabel("Vincular a un alimento del catálogo")
    .selectOption({ value: ingrediente.id });
  await page.getByPlaceholder("Cantidad").fill(String(gramos));
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(page.getByText(`${etiqueta} agregado a la despensa.`)).toBeVisible();
}

async function sembrarCobertura(page: Page, demanda: Map<string, Demanda>): Promise<void> {
  for (const [id, d] of demanda) {
    await sembrarLote(page, { id, nombre: d.label }, Math.ceil(d.total) + 5);
  }
}

async function servirDesdeLaSemana(page: Page, slot: Slot): Promise<string> {
  await page.goto(`/plan?semana=${slot.fecha}`);
  const fila = filaComida(tarjetaDelDia(page, slot.fecha), slot.etiqueta);
  await fila.getByRole("button", { name: "Servir lo planificado" }).click();
  const mensaje = page.getByText(/Servido: \d+ porci/);
  await expect(mensaje).toBeVisible({ timeout: 30_000 });
  return (await mensaje.textContent()) ?? "";
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

async function renglonesDe(recordIds: string[]): Promise<Renglon[]> {
  if (recordIds.length === 0) return [];
  const { data, error } = await admin()
    .from("meal_serving_record_items")
    .select("id, record_id, label, ingredient_id, served_quantity, deducted_quantity, shortfall_quantity")
    .in("record_id", recordIds);
  falla("meal_serving_record_items", error);
  return (data ?? []).map((i) => ({
    id: i.id as string,
    recordId: i.record_id as string,
    label: i.label as string,
    ingredientId: (i.ingredient_id as string | null) ?? null,
    servida: n(i.served_quantity),
    entregada: n(i.deducted_quantity),
    faltante: n(i.shortfall_quantity),
  }));
}

async function lotesDe(hogar: string): Promise<Lote[]> {
  const { data, error } = await admin()
    .from("inventory_lots")
    .select("id, ingredient_id, quantity, status")
    .eq("household_id", hogar);
  falla("inventory_lots", error);
  return (data ?? []).map((l) => ({
    id: l.id as string,
    ingredientId: (l.ingredient_id as string | null) ?? null,
    cantidad: n(l.quantity),
    status: l.status as string,
  }));
}

function stockPorIngrediente(lotes: Lote[]): Map<string, number> {
  const suma = new Map<string, number>();
  for (const l of lotes) {
    if (l.ingredientId === null || l.status !== "AVAILABLE") continue;
    suma.set(l.ingredientId, (suma.get(l.ingredientId) ?? 0) + l.cantidad);
  }
  return suma;
}

async function contarMovimientos(hogar: string): Promise<number> {
  const { count, error } = await admin()
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("household_id", hogar);
  falla("inventory_movements", error);
  return count ?? 0;
}

/** Descuentos del libro mayor colgados de estos renglones servidos. */
async function descuentosDe(itemIds: string[]): Promise<{ itemId: string; delta: number }[]> {
  if (itemIds.length === 0) return [];
  const { data, error } = await admin()
    .from("inventory_movements")
    .select("serving_record_item_id, delta, reason")
    .in("serving_record_item_id", itemIds)
    .eq("reason", "CONSUMED");
  falla("inventory_movements", error);
  return (data ?? []).map((m) => ({
    itemId: m.serving_record_item_id as string,
    delta: n(m.delta),
  }));
}

async function declaracionesVivasDe(recordId: string): Promise<{ id: string; source: string }[]> {
  const { data, error } = await admin()
    .from("consumption_logs")
    .select("id, source")
    .eq("serving_record_id", recordId)
    .eq("status", "ACTIVE");
  falla("consumption_logs", error);
  return (data ?? []).map((l) => ({ id: l.id as string, source: l.source as string }));
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

function porcionPendiente(page: Page, nombre: string, etiqueta: string): Locator {
  const seccion = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Salió a la mesa", exact: true }) })
    .last();
  return seccion
    .locator("li")
    .filter({ has: page.getByRole("heading", { name: nombre, exact: true }) })
    .filter({ hasText: etiqueta })
    .last();
}

const cerca = (a: number, b: number) => Math.abs(a - b) <= 0.001;

/**
 * Dos pestañas del MISMO usuario A, en contextos separados: cada una con su
 * propia sesión, sin compartir estado de React. Se cierran siempre.
 */
async function dosPestanasDeA(
  browser: import("@playwright/test").Browser,
): Promise<{ paginas: [Page, Page]; cerrar: () => Promise<void> }> {
  const contextos: BrowserContext[] = await Promise.all([browser.newContext(), browser.newContext()]);
  const paginas = (await Promise.all(contextos.map((c) => c.newPage()))) as [Page, Page];
  await Promise.all(paginas.map((p) => iniciarSesion(p, "A")));
  return {
    paginas,
    cerrar: async () => {
      await Promise.all(contextos.map((c) => c.close()));
    },
  };
}

// ---------------------------------------------------------------------------

test.describe("Doble confirmar servir: dos pestañas, una sola salida a la mesa", () => {
  let estado: {
    hogar: string;
    slot: Slot;
    assignmentId: string;
    proyecciones: Proyeccion[];
    stockAntes: Map<string, number>;
  } | null = null;

  test("1 · una comida confirmada con la despensa completa", async ({ comoA }) => {
    const hogar = await hogarDe("A");
    const slot = await reservarSlotLibre(hogar);
    const receta = await recetaSembrable(hogar, slot.mealType, 1);
    if (!receta) {
      test.skip(
        true,
        "staging no tiene una receta publicada hecha solo de alimentos crudos en gramos: NOT_RUN",
      );
      return;
    }
    const assignmentId = await planificarYConfirmar(comoA, hogar, slot, receta);
    await sembrarCobertura(comoA, await demandaPorIngrediente(assignmentId));
    const proyecciones = await proyeccionesDe(assignmentId);
    expect(proyecciones.length).toBeGreaterThan(0);
    estado = {
      hogar,
      slot,
      assignmentId,
      proyecciones,
      stockAntes: stockPorIngrediente(await lotesDe(hogar)),
    };
  });

  test("2 · las dos pestañas aprietan «Servir lo planificado» a la vez: una sirve, la otra recibe cero", async ({
    browser,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó comida confirmada: NOT_RUN");
      return;
    }
    const { paginas, cerrar } = await dosPestanasDeA(browser);
    try {
      await Promise.all(paginas.map((p) => p.goto(`/plan?semana=${e.slot.fecha}`)));
      const botones = paginas.map((p) =>
        filaComida(tarjetaDelDia(p, e.slot.fecha), e.slot.etiqueta).getByRole("button", {
          name: "Servir lo planificado",
        }),
      );
      await Promise.all(botones.map((b) => expect(b).toBeVisible()));

      await Promise.all(botones.map((b) => b.click()));

      // Cada pestaña recibe SU verdad: una sirvió, la otra llegó segunda.
      const mensajes = await Promise.all(
        paginas.map(async (p) => {
          const m = p.getByText(/(Servido: \d+ porci|No quedaban porciones por servir en esta comida\.)/);
          await expect(m).toBeVisible({ timeout: 30_000 });
          return (await m.textContent()) ?? "";
        }),
      );
      expect(mensajes.filter((m) => m.includes("Servido:"))).toHaveLength(1);
      expect(mensajes.filter((m) => m.includes("No quedaban porciones"))).toHaveLength(1);
    } finally {
      await cerrar();
    }

    // UN solo efecto físico.
    const proyecciones = await proyeccionesDe(e.assignmentId);
    expect(proyecciones).toHaveLength(e.proyecciones.length);
    expect(proyecciones.every((p) => p.status === "SERVED")).toBe(true);
    const registros = await registrosDe(e.assignmentId);
    expect(registros).toHaveLength(e.proyecciones.length);
    expect(new Set(registros.map((r) => r.memberId)).size).toBe(registros.length);
    expect(await eventosServido(e.assignmentId)).toBe(1);

    // Un descuento por renglón, ni uno más, y el stock bajó exactamente eso.
    const renglones = await renglonesDe(registros.map((r) => r.id));
    const descuentos = await descuentosDe(renglones.map((r) => r.id));
    for (const r of renglones) {
      const suyos = descuentos.filter((d) => d.itemId === r.id);
      expect(cerca(-suyos.reduce((s, d) => s + d.delta, 0), r.entregada)).toBe(true);
      expect(cerca(r.entregada + r.faltante, r.servida)).toBe(true);
    }
    const stockDespues = stockPorIngrediente(await lotesDe(e.hogar));
    const entregadoPorAlimento = new Map<string, number>();
    for (const r of renglones) {
      if (r.ingredientId === null) continue;
      entregadoPorAlimento.set(
        r.ingredientId,
        (entregadoPorAlimento.get(r.ingredientId) ?? 0) + r.entregada,
      );
    }
    for (const [id, entregado] of entregadoPorAlimento) {
      expect(cerca((e.stockAntes.get(id) ?? 0) - (stockDespues.get(id) ?? 0), entregado)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

test.describe("Doble consumir: dos pestañas dan por comida la misma porción", () => {
  let estado: {
    hogar: string;
    fichaA: Ficha;
    slot: Slot;
    registroA: Registro;
    movimientosTrasServir: number;
    stockTrasServir: Map<string, number>;
  } | null = null;

  test("1 · una comida servida con la despensa completa", async ({ comoA }) => {
    const hogar = await hogarDe("A");
    const fichaA = await fichaDe("A");
    const slot = await reservarSlotLibre(hogar);
    const receta = await recetaSembrable(hogar, slot.mealType, 1);
    if (!receta) {
      test.skip(
        true,
        "staging no tiene una receta publicada hecha solo de alimentos crudos en gramos: NOT_RUN",
      );
      return;
    }
    const assignmentId = await planificarYConfirmar(comoA, hogar, slot, receta);
    await sembrarCobertura(comoA, await demandaPorIngrediente(assignmentId));
    await servirDesdeLaSemana(comoA, slot);
    const registroA = (await registrosDe(assignmentId)).find((r) => r.memberId === fichaA.id);
    if (!registroA) throw new Error("A no tiene registro de servido: ¿no come esta comida?");
    estado = {
      hogar,
      fichaA,
      slot,
      registroA,
      movimientosTrasServir: await contarMovimientos(hogar),
      stockTrasServir: stockPorIngrediente(await lotesDe(hogar)),
    };
  });

  test("2 · las dos pestañas aprietan «Se comió todo» a la vez: una sola declaración viva y cero movimientos", async ({
    browser,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó una comida servida: NOT_RUN");
      return;
    }
    const { paginas, cerrar } = await dosPestanasDeA(browser);
    try {
      await Promise.all(paginas.map((p) => p.goto("/comi")));
      const botones = paginas.map((p) =>
        porcionPendiente(p, e.fichaA.nombre, e.slot.etiqueta).getByRole("button", {
          name: "Se comió todo",
        }),
      );
      await Promise.all(botones.map((b) => expect(b).toBeVisible()));

      await Promise.all(botones.map((b) => b.click()));

      // Cada pestaña termina con una respuesta honesta: el supuesto quedó
      // anotado (la clave de reintento devuelve la misma declaración) o el
      // servidor explicó por qué no. Nunca un silencio.
      await Promise.all(
        paginas.map((p) =>
          expect(
            p
              .getByText("Anotado como supuesto: se dio por comido lo que salió al plato.")
              .or(p.getByRole("alert"))
              .first(),
          ).toBeVisible({ timeout: 30_000 }),
        ),
      );
    } finally {
      await cerrar();
    }

    const vivas = await declaracionesVivasDe(e.registroA.id);
    expect(vivas).toHaveLength(1);
    expect(vivas[0]!.source).toBe("ASSUMED_FROM_PLAN");

    // Declarar no descuenta: mismo libro mayor, mismo stock que tras servir.
    expect(await contarMovimientos(e.hogar)).toBe(e.movimientosTrasServir);
    expect(stockPorIngrediente(await lotesDe(e.hogar))).toEqual(e.stockTrasServir);
  });
});

// ---------------------------------------------------------------------------

test.describe("Doble recibir: dos pestañas reciben la misma compra en la despensa", () => {
  let estado: {
    hogar: string;
    slot: Slot;
    listaId: string;
    compradas: string[];
  } | null = null;

  test("1 · una compra generada desde la comida confirmada, comprada y finalizada", async ({
    comoA,
  }) => {
    const hogar = await hogarDe("A");
    const slot = await reservarSlotLibre(hogar);
    const receta = await recetaSembrable(hogar, slot.mealType, 1);
    if (!receta) {
      test.skip(
        true,
        "staging no tiene una receta publicada hecha solo de alimentos crudos en gramos: NOT_RUN",
      );
      return;
    }
    await planificarYConfirmar(comoA, hogar, slot, receta);

    await comoA.goto(`/shopping?semana=${slot.fecha}`);
    await comoA.getByRole("button", { name: "Generar lista de compras" }).click();
    const casillas = comoA.getByRole("checkbox", { name: /^Marcar .+ como comprado$/ });
    await expect(async () => {
      expect((await casillas.count()) > 0 || (await comoA.getByRole("alert").isVisible())).toBe(true);
    }).toPass({ timeout: 30_000 });
    const total = await casillas.count();
    if (total === 0) {
      test.skip(
        true,
        "la lista no tiene líneas que marcar como compradas (la despensa ya cubre la demanda): NOT_RUN",
      );
      return;
    }
    for (let i = 0; i < total; i++) {
      const casilla = casillas.nth(i);
      await casilla.check();
      await expect(casilla).toBeChecked();
      await comoA.waitForLoadState("networkidle");
    }

    await comoA.getByRole("button", { name: "Finalizar compra" }).click();
    await expect(comoA.getByText("Compra finalizada.")).toBeVisible();
    await recargar(comoA);
    await expect(comoA.getByRole("button", { name: "Recibir compra en la despensa" })).toBeVisible();

    const { data: listaFila, error } = await admin()
      .from("shopping_lists")
      .select("id, status")
      .eq("plan_id", await planDe(hogar, slot))
      .limit(1)
      .maybeSingle();
    falla("shopping_lists", error);
    if (!listaFila) throw new Error("No existe la lista de compras de esa semana.");
    expect(listaFila.status).toBe("COMPLETED");
    const { data: items, error: errorItems } = await admin()
      .from("shopping_list_items")
      .select("id")
      .eq("list_id", listaFila.id as string)
      .eq("status", "PURCHASED");
    falla("shopping_list_items", errorItems);
    const compradas = (items ?? []).map((i) => i.id as string);
    expect(compradas.length).toBeGreaterThan(0);

    estado = { hogar, slot, listaId: listaFila.id as string, compradas };
  });

  test("2 · las dos pestañas aprietan «Recibir compra en la despensa» a la vez: un lote por línea", async ({
    browser,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó una compra finalizada: NOT_RUN");
      return;
    }
    const { paginas, cerrar } = await dosPestanasDeA(browser);
    try {
      await Promise.all(paginas.map((p) => p.goto(`/shopping?semana=${e.slot.fecha}`)));
      const botones = paginas.map((p) =>
        p.getByRole("button", { name: "Recibir compra en la despensa" }),
      );
      await Promise.all(botones.map((b) => expect(b).toBeVisible()));

      await Promise.all(botones.map((b) => b.click()));

      await Promise.all(
        paginas.map((p) =>
          expect(
            p.getByText(/(\d+ lotes? recibidos? en la despensa\.|Nada nuevo que recibir)/).first(),
          ).toBeVisible({ timeout: 30_000 }),
        ),
      );
    } finally {
      await cerrar();
    }

    // Un lote por línea comprada y una recepción por línea: K-22.
    const { data: lotes, error } = await admin()
      .from("inventory_lots")
      .select("id, shopping_item_id")
      .in("shopping_item_id", e.compradas);
    falla("inventory_lots", error);
    for (const itemId of e.compradas) {
      expect((lotes ?? []).filter((l) => l.shopping_item_id === itemId)).toHaveLength(1);
    }
    const { count, error: errorMov } = await admin()
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .in(
        "idempotency_key",
        e.compradas.map((id) => `RECEIVE:${id}`),
      );
    falla("inventory_movements", errorMov);
    expect(count).toBe(e.compradas.length);
  });
});
