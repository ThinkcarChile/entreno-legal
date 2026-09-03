/**
 * E2E §18-§20 + §29 — COCINA: elegir la comida → confirmar porciones →
 * preparar (sugerencia) → modo cocina → servir → servido confirmado →
 * recargar y releer. Y el FALTANTE: servir con la despensa corta.
 *
 * Lo que este archivo afirma del producto:
 *  · Confirmar congela las porciones (0023): lo guardado sobrevive la recarga
 *    y "Ver lo guardado" LEE, no recalcula.
 *  · Generar el plan de preparación es una SUGERENCIA (§17): la despensa no
 *    se mueve hasta que una persona confirma cada paso en el modo cocina (§16).
 *  · SERVIR ES SERVIR (0036): saca la comida a la mesa y descuenta FEFO. NO
 *    declara consumo; eso vive en «Lo que comimos». Idempotencia DE ESTADO:
 *    cada porción sale una sola vez.
 *  · `deducted + shortfall = served` en cada renglón (invariante 0036); el
 *    inventario JAMÁS queda negativo; el faltante es dato de primera clase
 *    (0012) y se ve en Despensa hasta que alguien lo resuelve.
 *  · UNKNOWN ≠ ZERO: lo que la despensa no entregó no se da por comido, y el
 *    número queda en blanco, nunca en 0.
 *
 * HISTORIA QUE NO SE BORRA. `vaciarCocina` borra `weekly_plans` en cascada, y
 * `meal_assignments_protect_served` (0019:369) rechaza borrar una comida que
 * ya se sirvió; `inventory_movements` es append-only también ante DELETE
 * (0011:290). Por eso este spec NO vacía nada: reclama un slot LIBRE de la
 * semana (hoy primero), sigue SUS ids por `admin()` y deja el hogar como lo
 * encontró más la historia que produjo — que es lo que la doctrina exige.
 *
 * Serial a propósito: cada paso depende del anterior (la comida que se sirve
 * es la que se confirmó). Si uno cae, los siguientes no tienen sentido.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, recargar, hoySantiago } from "../fixtures/contrato";
import { admin, hogarDe, idDeUsuario } from "../fixtures/admin";

test.describe.configure({ mode: "serial", timeout: 180_000 });

// ---------------------------------------------------------------------------
// Utilería de cocina. Está DUPLICADA en los cuatro specs de este frente
// (cocina, foodlog, concurrencia, red) a propósito: el contrato manda que un
// spec importe solo de ../fixtures y los fixtures son del lead. Si se mueve a
// fixtures/cocina.ts, borrar las cuatro copias EN EL MISMO cambio.
// ---------------------------------------------------------------------------

type ComidaBase = "BREAKFAST" | "LUNCH" | "TEA" | "DINNER";

/** Mismo texto que `MEAL_TYPE_LABELS` del tablero de la semana. */
const ETIQUETA_COMIDA: Record<ComidaBase, string> = {
  BREAKFAST: "Desayuno",
  LUNCH: "Almuerzo",
  TEA: "Once",
  DINNER: "Cena",
};

/** Orden en que se reclama un slot libre: primero la comida grande del día. */
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

/** PostgREST devuelve un embed a-muchos como arreglo y a-uno como objeto. */
function lista<T>(v: T[] | T | null | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** PostgREST devuelve `numeric` como TEXTO. Se convierte acá, nunca se castea. */
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

/** Mismo lunes que `weekStart` del calendario de la app. */
function lunesDe(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const diaSemana = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return sumarDias(fecha, -(diaSemana === 0 ? 6 : diaSemana - 1));
}

/** Mismo texto que el encabezado de cada día del tablero: "Martes 3". */
function tituloDelDia(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const nombre = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("es-CL", {
    timeZone: "UTC",
    weekday: "long",
  });
  return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${d}`;
}

/** La ficha (household_members) del usuario sintético en su hogar de staging. */
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

/**
 * Un (día, comida) sin asignación, desde hoy hacia adelante y hasta 12 semanas.
 * Servir no exige que el día del plan sea hoy (el RPC toma `household_today`
 * para `served_on`), así que cualquier slot libre sirve para el flujo entero.
 */
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

/** Nombres visibles de alimentos, solo los que la despensa lista (activos y del hogar o globales). */
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

/**
 * Una receta publicada que se pueda cubrir SOLO con altas manuales de la
 * despensa: el alta manual nace RAW en gramos (0043:820), así que la receta
 * tiene que pedir únicamente alimentos crudos en gramos, sin productos
 * comerciales ni recetas anidadas. La de menos ingredientes primero.
 */
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

/** La tarjeta de un día del tablero, ubicada por su encabezado ("Martes 3"). */
function tarjetaDelDia(page: Page, fecha: string): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: tituloDelDia(fecha), exact: true }) })
    .last();
}

/**
 * La fila de una comida dentro de la tarjeta del día. `:scope > div > div` es
 * estructura, no clase: la tarjeta tiene un solo hijo <div> (el contenedor de
 * filas) y cada fila es un <div> directo de ese contenedor.
 */
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

/**
 * Elegir la receta y confirmar porciones POR LA INTERFAZ (§18). Devuelve el id
 * de la comida. Recarga entre medio: lo que solo vive en React no cuenta (§29).
 */
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

/** Lo que la comida confirmada va a pedirle a la despensa, por alimento (gramos). */
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

/** Alta manual en la despensa POR LA INTERFAZ: crudo, en gramos, sin vencimiento. */
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

/** Siembra un poco más de lo que pide cada alimento: cobertura completa. */
async function sembrarCobertura(page: Page, demanda: Map<string, Demanda>): Promise<void> {
  for (const [id, d] of demanda) {
    await sembrarLote(page, { id, nombre: d.label }, Math.ceil(d.total) + 5);
  }
}

/** Servir desde la semana y devolver el mensaje completo que vio la persona. */
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

/** Suma de lo disponible por alimento, en la unidad del lote. */
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

async function faltantesAbiertosDe(assignmentId: string): Promise<{ label: string; cantidad: number }[]> {
  const { data, error } = await admin()
    .from("consumption_shortfalls")
    .select("label, quantity")
    .eq("assignment_id", assignmentId)
    .eq("status", "OPEN");
  falla("consumption_shortfalls", error);
  return (data ?? []).map((s) => ({ label: s.label as string, cantidad: n(s.quantity) }));
}

async function tareasDelPlan(planId: string): Promise<{ id: string; status: string }[]> {
  const { data, error } = await admin()
    .from("batch_prep_tasks")
    .select("id, status")
    .eq("plan_id", planId);
  falla("batch_prep_tasks", error);
  return (data ?? []).map((t) => ({ id: t.id as string, status: t.status as string }));
}

/** La tarjeta más NUEVA de una persona en la sección "Salió a la mesa" de /comi. */
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

// ---------------------------------------------------------------------------

interface EstadoCocina {
  hogar: string;
  fichaA: Ficha;
  slot: Slot;
  receta: Receta;
  assignmentId: string;
  proyecciones: Proyeccion[];
  demanda: Map<string, Demanda>;
}

test.describe("Cocina: elegir, confirmar, preparar, servir (§18-§20, §29)", () => {
  let estado: EstadoCocina | null = null;

  test("1 · elegir la comida y confirmar: lo guardado sobrevive la recarga", async ({ comoA }) => {
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

    // Confirmar congeló una porción por comensal, y todas siguen PLANNED:
    // confirmar no sirve ni descuenta nada.
    const proyecciones = await proyeccionesDe(assignmentId);
    expect(proyecciones.length).toBeGreaterThan(0);
    expect(proyecciones.every((p) => p.status === "PLANNED")).toBe(true);
    const demanda = await demandaPorIngrediente(assignmentId);
    expect(demanda.size).toBeGreaterThan(0);

    // "Ver lo guardado" lee lo congelado: la persona y lo que se preparó.
    const fila = filaComida(tarjetaDelDia(comoA, slot.fecha), slot.etiqueta);
    await expect(fila.getByText(/\d+ porciones/)).toBeVisible();
    await fila.getByRole("link", { name: "Ver lo guardado" }).click();
    await expect(comoA).toHaveURL(new RegExp(`/plan/comida/${assignmentId}$`));
    await expect(comoA.getByRole("heading", { name: "Se sirvió", exact: true })).toBeVisible();
    await expect(comoA.getByRole("heading", { name: "Se preparó", exact: true })).toBeVisible();
    await expect(comoA.getByRole("heading", { name: fichaA.nombre, exact: true })).toBeVisible();

    estado = { hogar, fichaA, slot, receta, assignmentId, proyecciones, demanda };
  });

  test("2 · la despensa recibe por la interfaz lo que la comida necesita", async ({ comoA }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó comida confirmada: NOT_RUN");
      return;
    }
    await sembrarCobertura(comoA, e.demanda);

    await recargar(comoA);
    const stock = stockPorIngrediente(await lotesDe(e.hogar));
    for (const [id, d] of e.demanda) {
      expect(stock.get(id) ?? 0).toBeGreaterThanOrEqual(d.total);
    }
  });

  test("3 · preparar: generar el plan es una sugerencia que no toca la despensa (§17); el modo cocina confirma paso a paso (§16)", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó comida confirmada: NOT_RUN");
      return;
    }
    const movimientosAntes = await contarMovimientos(e.hogar);
    const stockAntes = stockPorIngrediente(await lotesDe(e.hogar));

    await comoA.goto("/prep");
    await comoA.getByRole("button", { name: "Preparar compra / stock" }).click();

    // O la app lleva al modo cocina del plan nuevo, o dice con todas sus
    // letras que no hay nada que preparar (no se inventan porciones).
    const nadaQuePreparar = comoA.getByRole("alert").filter({ hasText: "Nada que preparar" });
    await expect(async () => {
      const enModoCocina = /\/prep\/[0-9a-f-]{36}$/.test(comoA.url());
      expect(enModoCocina || (await nadaQuePreparar.isVisible())).toBe(true);
    }).toPass({ timeout: 30_000 });

    // §17: pase lo que pase, la sugerencia NO movió la despensa.
    expect(await contarMovimientos(e.hogar)).toBe(movimientosAntes);
    expect(stockPorIngrediente(await lotesDe(e.hogar))).toEqual(stockAntes);

    const planId = comoA.url().match(/\/prep\/([0-9a-f-]{36})$/)?.[1];
    if (!planId) {
      test.skip(
        true,
        "el motor no propuso tareas para esta receta y este stock (o el slot cae fuera de los 7 días): modo cocina NOT_RUN",
      );
      return;
    }

    // Modo cocina: un paso por vez y LISTO gigante. Se confirma cada tarea
    // hasta "Plan terminado"; las dependencias ya quedaron listas porque se
    // avanza en orden.
    const tareas = await tareasDelPlan(planId);
    expect(tareas.length).toBeGreaterThan(0);
    const terminado = comoA.getByRole("heading", { name: "Plan terminado", exact: true });
    for (let i = 0; i < tareas.length; i++) {
      if (await terminado.isVisible()) break;
      await expect(comoA.getByText(/^Paso \d+ de \d+$/)).toBeVisible();
      await comoA.getByRole("button", { name: "LISTO", exact: true }).click();
      await expect(
        comoA.getByText("Listo: registrado en la despensa.").or(terminado).first(),
      ).toBeVisible({ timeout: 30_000 });
    }
    await expect(terminado).toBeVisible();

    // §29: recargar y releer. Lo hecho quedó hecho.
    await recargar(comoA);
    await expect(terminado).toBeVisible();
    const hechas = await tareasDelPlan(planId);
    expect(hechas.every((t) => t.status === "DONE" || t.status === "SKIPPED")).toBe(true);
    expect(hechas.filter((t) => t.status === "DONE").length).toBeGreaterThan(0);
  });

  test("4 · servir: la comida sale a la mesa UNA vez, la despensa se descuenta, y todo sobrevive la recarga (§29)", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó comida confirmada: NOT_RUN");
      return;
    }
    const stockAntes = stockPorIngrediente(await lotesDe(e.hogar));
    expect(await registrosDe(e.assignmentId)).toHaveLength(0);

    const mensaje = await servirDesdeLaSemana(comoA, e.slot);
    // El mensaje dice exactamente lo que pasó y lo que falta hacer (0036).
    expect(mensaje).toMatch(/Servido: \d+ porci(ón salió|ones salieron) a la mesa y la despensa quedó descontada\./);
    expect(mensaje).toContain("«Lo que comimos»");
    expect(mensaje).not.toContain("Ojo:");

    // §29: recargar y releer. El botón de servir ya no está; ahora toca anotar.
    await recargar(comoA);
    const fila = filaComida(tarjetaDelDia(comoA, e.slot.fecha), e.slot.etiqueta);
    await expect(fila.getByRole("button", { name: "Servir lo planificado" })).toHaveCount(0);
    await expect(fila.getByRole("link", { name: "Anotar lo que se comió" })).toBeVisible();

    // Lo físico, leído por admin(): una porción por comensal, ni una más.
    const proyecciones = await proyeccionesDe(e.assignmentId);
    expect(proyecciones.every((p) => p.status === "SERVED")).toBe(true);
    const registros = await registrosDe(e.assignmentId);
    expect(registros).toHaveLength(proyecciones.length);
    expect(registros.every((r) => r.status === "ACTIVE")).toBe(true);
    expect((await asignacionDe(e.hogar, e.slot)).status).toBe("SERVED");
    expect(await eventosServido(e.assignmentId)).toBe(1);

    // Invariante 0036 en cada renglón, y sin faltante porque había de todo.
    const renglones = await renglonesDe(registros.map((r) => r.id));
    expect(renglones.length).toBeGreaterThan(0);
    for (const r of renglones) {
      expect(cerca(r.entregada + r.faltante, r.servida)).toBe(true);
      expect(r.faltante).toBe(0);
    }

    // La despensa bajó EXACTAMENTE lo entregado, por alimento, y nada negativo.
    const lotes = await lotesDe(e.hogar);
    expect(lotes.every((l) => l.cantidad >= 0)).toBe(true);
    const stockDespues = stockPorIngrediente(lotes);
    const entregadoPorAlimento = new Map<string, number>();
    for (const r of renglones) {
      if (r.ingredientId === null) continue;
      entregadoPorAlimento.set(
        r.ingredientId,
        (entregadoPorAlimento.get(r.ingredientId) ?? 0) + r.entregada,
      );
    }
    for (const [id, entregado] of entregadoPorAlimento) {
      const antes = stockAntes.get(id) ?? 0;
      const despues = stockDespues.get(id) ?? 0;
      expect(cerca(antes - despues, entregado)).toBe(true);
    }
  });

  test("5 · servir no declara consumo: en «Lo que comimos» la porción espera en 'Salió a la mesa'", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó comida confirmada: NOT_RUN");
      return;
    }
    const registros = await registrosDe(e.assignmentId);
    const registroA = registros.find((r) => r.memberId === e.fichaA.id);
    if (!registroA) throw new Error("A no tiene registro de servido: ¿no come esta comida?");
    const renglonesA = await renglonesDe([registroA.id]);

    await comoA.goto("/comi");
    const tarjeta = porcionPendiente(comoA, e.fichaA.nombre, e.slot.etiqueta);
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta.getByText("del plan")).toBeVisible();
    for (const r of renglonesA) {
      await expect(tarjeta.getByText(`salieron ${r.entregada} g`, { exact: true })).toBeVisible();
    }
    // Con la despensa entregando todo, el camino de un toque se ofrece y se
    // presenta como lo que es: un supuesto.
    await expect(tarjeta.getByRole("button", { name: "Se comió todo" })).toBeVisible();
    await expect(tarjeta.getByText("queda anotado como supuesto")).toBeVisible();

    // Y en la base no hay ninguna declaración colgada de estos servidos.
    for (const r of registros) {
      expect(await declaracionesVivasDe(r.id)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------

interface EstadoFaltante {
  hogar: string;
  fichaA: Ficha;
  slot: Slot;
  assignmentId: string;
  corto: { id: string; label: string; sembrado: number; necesario: number };
  demanda: Map<string, Demanda>;
}

test.describe("Faltante: servir más de lo que la despensa tiene trazado (§20)", () => {
  let estado: EstadoFaltante | null = null;

  test("1 · confirmar una comida con la despensa corta: un alimento a medias, el resto sin nada", async ({
    comoA,
  }) => {
    const hogar = await hogarDe("A");
    const fichaA = await fichaDe("A");
    const slot = await reservarSlotLibre(hogar);
    // Dos alimentos como mínimo: uno entrega a medias y el otro no entrega
    // nada, para ver las dos caras del faltante en una sola comida.
    const receta = await recetaSembrable(hogar, slot.mealType, 2);
    if (!receta) {
      test.skip(
        true,
        "staging no tiene una receta publicada con 2+ alimentos crudos en gramos: NOT_RUN",
      );
      return;
    }
    const assignmentId = await planificarYConfirmar(comoA, hogar, slot, receta);
    const demanda = await demandaPorIngrediente(assignmentId);
    expect(demanda.size).toBeGreaterThanOrEqual(2);

    // El alimento "corto" es el que más pide la comida; se siembra la mitad.
    const [id, d] = [...demanda.entries()].sort((a, b) => b[1].total - a[1].total)[0]!;
    const sembrado = Math.max(1, Math.floor(d.total / 2));
    expect(sembrado).toBeLessThan(d.total);
    await sembrarLote(comoA, { id, nombre: d.label }, sembrado);

    estado = {
      hogar,
      fichaA,
      slot,
      assignmentId,
      corto: { id, label: d.label, sembrado, necesario: d.total },
      demanda,
    };
  });

  test("2 · servir conserva lo servido, deja el inventario en cero (nunca negativo) y muestra el faltante", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó comida confirmada: NOT_RUN");
      return;
    }
    const mensaje = await servirDesdeLaSemana(comoA, e.slot);
    // El mensaje no esconde el faltante: lo nombra y dice dónde quedó anotado.
    expect(mensaje).toContain("Ojo: la despensa no tenía todo — faltó");
    expect(mensaje).toContain(`${e.corto.label} (`);
    expect(mensaje).toContain("El desajuste quedó anotado en Despensa.");

    const registros = await registrosDe(e.assignmentId);
    const proyecciones = await proyeccionesDe(e.assignmentId);
    expect(registros).toHaveLength(proyecciones.length);
    const renglones = await renglonesDe(registros.map((r) => r.id));

    // Invariante 0036: lo servido NO se recorta; la diferencia es faltante.
    let entregadoCorto = 0;
    let faltanteCorto = 0;
    for (const r of renglones) {
      expect(cerca(r.entregada + r.faltante, r.servida)).toBe(true);
      if (r.ingredientId === e.corto.id) {
        entregadoCorto += r.entregada;
        faltanteCorto += r.faltante;
      } else {
        // Sin lote no hay de dónde sacar: entregado 0, faltante = servido.
        expect(r.entregada).toBe(0);
        expect(cerca(r.faltante, r.servida)).toBe(true);
      }
    }
    expect(cerca(entregadoCorto, e.corto.sembrado)).toBe(true);
    expect(faltanteCorto).toBeGreaterThan(0);
    expect(cerca(entregadoCorto + faltanteCorto, e.corto.necesario)).toBe(true);

    // Inventario NO negativo: el lote corto quedó en 0 y ningún lote bajo cero.
    const lotes = await lotesDe(e.hogar);
    expect(lotes.every((l) => l.cantidad >= 0)).toBe(true);
    expect(stockPorIngrediente(lotes).get(e.corto.id) ?? 0).toBe(0);

    // El faltante es dato de primera clase: una fila abierta por renglón corto.
    const faltantes = await faltantesAbiertosDe(e.assignmentId);
    expect(faltantes.length).toBe(renglones.filter((r) => r.faltante > 0).length);
    expect(
      cerca(
        faltantes.filter((f) => f.label === e.corto.label).reduce((s, f) => s + f.cantidad, 0),
        faltanteCorto,
      ),
    ).toBe(true);

    // Y se ve en Despensa, también después de recargar.
    await comoA.goto("/pantry");
    await expect(comoA.getByRole("heading", { name: "Desajustes de inventario", exact: true })).toBeVisible();
    await expect(comoA.getByText(`${e.corto.label}: faltaron`).first()).toBeVisible();
    await recargar(comoA);
    await expect(comoA.getByText(`${e.corto.label}: faltaron`).first()).toBeVisible();
  });

  test("3 · en «Lo que comimos» lo que la despensa no entregó no se da por comido (UNKNOWN ≠ ZERO)", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó comida confirmada: NOT_RUN");
      return;
    }
    const registros = await registrosDe(e.assignmentId);
    const registroA = registros.find((r) => r.memberId === e.fichaA.id);
    if (!registroA) throw new Error("A no tiene registro de servido: ¿no come esta comida?");
    const renglonesA = await renglonesDe([registroA.id]);
    const sinEntregar = renglonesA.find((r) => r.entregada === 0);
    if (!sinEntregar) throw new Error("La receta elegida no dejó ningún renglón sin entregar.");

    await comoA.goto("/comi");
    const tarjeta = porcionPendiente(comoA, e.fichaA.nombre, e.slot.etiqueta);
    await expect(tarjeta).toBeVisible();
    for (const r of renglonesA) {
      await expect(tarjeta.getByText(`salieron ${r.entregada} g`, { exact: true })).toBeVisible();
    }
    // El camino de un toque NO se ofrece: darlo por comido anotaría un cero
    // que nadie midió. La tarjeta lo dice con todas sus letras.
    await expect(tarjeta.getByRole("button", { name: "Se comió todo" })).toHaveCount(0);
    await expect(tarjeta.getByText("la despensa no lo entregó")).toBeVisible();
    await expect(tarjeta.getByText(sinEntregar.label).first()).toBeVisible();

    // La persona puede decir "todo" igual: se conserva lo que DIJO, y el
    // número queda en blanco — nunca 0.
    await tarjeta.getByRole("button", { name: "Decir cuánto comió" }).click();
    const filaRenglon = tarjeta
      .locator("li")
      .filter({ has: comoA.getByText(sinEntregar.label, { exact: true }) })
      .filter({ has: comoA.getByRole("button", { name: "Todo", exact: true }) })
      .last();
    await filaRenglon.getByRole("button", { name: "Todo", exact: true }).click();
    await tarjeta.getByRole("button", { name: "Guardar lo que comió" }).click();
    await expect(comoA.getByText("Anotado lo que se comió.")).toBeVisible();

    await recargar(comoA);
    await expect(comoA.getByText("Todo · sin número anotado", { exact: true }).first()).toBeVisible();

    const vivas = await declaracionesVivasDe(registroA.id);
    expect(vivas).toHaveLength(1);
    const { data: items, error } = await admin()
      .from("intake_log_items")
      .select("serving_record_item_id, extent, quantity")
      .eq("log_id", vivas[0]!.id);
    falla("intake_log_items", error);
    const item = (items ?? []).find((i) => i.serving_record_item_id === sinEntregar.id);
    expect(item).toBeDefined();
    expect(item!.extent).toBe("ALL");
    expect(item!.quantity).toBeNull();
  });
});
