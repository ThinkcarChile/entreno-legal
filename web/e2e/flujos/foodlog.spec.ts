/**
 * E2E §19 — FOODLOG: SERVED → ACTUAL. Comí todo, comí parcial, repetición,
 * registro tardío. Y la despensa NO se descuenta dos veces.
 *
 * Lo que este archivo afirma del producto (0036 + 0038):
 *  · Servir descontó la despensa; DECLARAR lo comido no la toca. Ninguna de
 *    las cuatro declaraciones de acá escribe un movimiento de inventario.
 *  · «Se comió todo» es un SUPUESTO y se presenta como tal (chip "Supuesto del
 *    plan", `quantity_is_declared = false`). Lo asumido jamás se disfraza de
 *    declarado.
 *  · «La mitad» produce un número ESTIMADO firmado por el motor; lo que no se
 *    marca queda «No sé» sin número: UNKNOWN ≠ ZERO.
 *  · REPETIR no es un número más grande sobre la misma porción: el servidor
 *    rechaza declarar más de lo que salió y manda a servir otra porción.
 *  · Registrar tarde (ayer) es legítimo; declarar el futuro no. Comer afuera
 *    cuenta para la alimentación y no existe para la despensa.
 *
 * HISTORIA QUE NO SE BORRA: igual que cocina.spec.ts, este spec no vacía nada
 * (una comida servida no se puede borrar, 0019:369). Reclama un slot libre y
 * sigue sus propios ids por `admin()`.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, recargar, hoySantiago } from "../fixtures/contrato";
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

/** Mismo redondeo que `redondear3` del motor de extent. */
function redondear3(x: number): number {
  return Math.round((x + Number.EPSILON) * 1000) / 1000;
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
    .select("id, record_id, label, ingredient_id, served_quantity, deducted_quantity, shortfall_quantity, sort_order")
    .in("record_id", recordIds)
    .order("sort_order", { ascending: true });
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

interface DeclaracionViva {
  id: string;
  source: string;
  kind: string;
  affectsInventory: boolean;
}

async function declaracionesVivasDe(recordId: string): Promise<DeclaracionViva[]> {
  const { data, error } = await admin()
    .from("consumption_logs")
    .select("id, source, kind, affects_inventory")
    .eq("serving_record_id", recordId)
    .eq("status", "ACTIVE");
  falla("consumption_logs", error);
  return (data ?? []).map((l) => ({
    id: l.id as string,
    source: l.source as string,
    kind: l.kind as string,
    affectsInventory: l.affects_inventory as boolean,
  }));
}

interface ItemDeclarado {
  servingRecordItemId: string | null;
  extent: string;
  cantidad: number | null;
  declarada: boolean;
}

async function itemsDeclaradosDe(logId: string): Promise<ItemDeclarado[]> {
  const { data, error } = await admin()
    .from("intake_log_items")
    .select("serving_record_item_id, extent, quantity, quantity_is_declared")
    .eq("log_id", logId);
  falla("intake_log_items", error);
  return (data ?? []).map((i) => ({
    servingRecordItemId: (i.serving_record_item_id as string | null) ?? null,
    extent: i.extent as string,
    cantidad: i.quantity === null ? null : n(i.quantity),
    declarada: i.quantity_is_declared as boolean,
  }));
}

/** Sección de /comi por su título ("Salió a la mesa", "Ya anotado"). */
function seccion(page: Page, titulo: string): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: titulo, exact: true }) })
    .last();
}

/** La tarjeta más NUEVA de una persona en una sección de /comi. */
function tarjetaDe(page: Page, titulo: string, nombre: string, etiqueta: string): Locator {
  return seccion(page, titulo)
    .locator("li")
    .filter({ has: page.getByRole("heading", { name: nombre, exact: true }) })
    .filter({ hasText: etiqueta })
    .last();
}

/** La fila de un renglón dentro del marcador («Todo», «La mitad», …). */
function filaMarcador(tarjeta: Locator, label: string): Locator {
  return tarjeta
    .locator("li")
    .filter({ has: tarjeta.page().getByText(label, { exact: true }) })
    .filter({ has: tarjeta.page().getByRole("button", { name: "Todo", exact: true }) })
    .last();
}

const cerca = (a: number, b: number) => Math.abs(a - b) <= 0.001;

// ---------------------------------------------------------------------------

interface EstadoFoodlog {
  hogar: string;
  fichaA: Ficha;
  fichaB: Ficha;
  slot: Slot;
  assignmentId: string;
  registroA: Registro;
  registroB: Registro;
  renglonesA: Renglon[];
  renglonesB: Renglon[];
  /** Movimientos del libro mayor justo DESPUÉS de servir: la vara fija. */
  movimientosTrasServir: number;
  stockTrasServir: Map<string, number>;
}

test.describe("Lo que comimos: SERVED → ACTUAL (§19)", () => {
  let estado: EstadoFoodlog | null = null;

  test("1 · una comida servida con la despensa completa, esperando que alguien diga qué pasó", async ({
    comoA,
  }) => {
    const hogar = await hogarDe("A");
    const [fichaA, fichaB] = await Promise.all([fichaDe("A"), fichaDe("B")]);
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
    const mensaje = await servirDesdeLaSemana(comoA, slot);
    expect(mensaje).not.toContain("Ojo:");

    const registros = await registrosDe(assignmentId);
    const registroA = registros.find((r) => r.memberId === fichaA.id);
    const registroB = registros.find((r) => r.memberId === fichaB.id);
    if (!registroA || !registroB) {
      throw new Error("A y B tienen que comer esta comida: falta un registro de servido.");
    }
    const renglonesA = await renglonesDe([registroA.id]);
    const renglonesB = await renglonesDe([registroB.id]);
    expect(renglonesA.length).toBeGreaterThan(0);
    expect(renglonesB.length).toBeGreaterThan(0);
    // Cobertura completa: todo lo servido se entregó.
    for (const r of [...renglonesA, ...renglonesB]) expect(r.faltante).toBe(0);

    estado = {
      hogar,
      fichaA,
      fichaB,
      slot,
      assignmentId,
      registroA,
      registroB,
      renglonesA,
      renglonesB,
      movimientosTrasServir: await contarMovimientos(hogar),
      stockTrasServir: stockPorIngrediente(await lotesDe(hogar)),
    };
  });

  test("2 · repetición: declarar más de lo que salió se rechaza y manda a servir otra porción", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó una comida servida: NOT_RUN");
      return;
    }
    const primero = e.renglonesA[0]!;

    await comoA.goto("/comi");
    const tarjeta = tarjetaDe(comoA, "Salió a la mesa", e.fichaA.nombre, e.slot.etiqueta);
    await expect(tarjeta).toBeVisible();
    await tarjeta.getByRole("button", { name: "Decir cuánto comió" }).click();

    // «Cantidad exacta» con el doble de lo servido: si repitió, eso es un
    // SEGUNDO servido, no un número más grande sobre este.
    await filaMarcador(tarjeta, primero.label)
      .getByRole("button", { name: "Cantidad exacta" })
      .click();
    await tarjeta
      .getByLabel(`¿Cuánto comió de ${primero.label}?`)
      .fill(String(redondear3(primero.servida * 2)));
    await tarjeta.getByRole("button", { name: "Guardar lo que comió" }).click();

    // El mensaje del servidor se muestra tal cual, con la salida que propone.
    const rechazo = comoA.getByRole("alert").filter({ hasText: "Si repitió, sirve otra porción" });
    await expect(rechazo).toBeVisible();
    await expect(comoA.getByText("Anotado lo que se comió.")).toHaveCount(0);

    // Nada quedó escrito: ni declaración ni movimiento.
    expect(await declaracionesVivasDe(e.registroA.id)).toHaveLength(0);
    expect(await contarMovimientos(e.hogar)).toBe(e.movimientosTrasServir);

    await recargar(comoA);
    await expect(tarjetaDe(comoA, "Salió a la mesa", e.fichaA.nombre, e.slot.etiqueta)).toBeVisible();
  });

  test("3 · comí todo (un toque): queda como SUPUESTO y la despensa no se descuenta otra vez", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó una comida servida: NOT_RUN");
      return;
    }
    await comoA.goto("/comi");
    const pendiente = tarjetaDe(comoA, "Salió a la mesa", e.fichaA.nombre, e.slot.etiqueta);
    await pendiente.getByRole("button", { name: "Se comió todo" }).click();
    await expect(
      comoA.getByText("Anotado como supuesto: se dio por comido lo que salió al plato."),
    ).toBeVisible();

    // §29: recargar y releer.
    await recargar(comoA);
    const anotada = tarjetaDe(comoA, "Ya anotado", e.fichaA.nombre, e.slot.etiqueta);
    await expect(anotada).toBeVisible();
    await expect(anotada.getByText("Supuesto del plan")).toBeVisible();
    await expect(anotada.getByText("Del plan")).toBeVisible();
    for (const r of e.renglonesA) {
      await expect(
        anotada.getByText(`Todo · ${redondear3(r.entregada)} g (estimado)`, { exact: true }),
      ).toBeVisible();
    }

    // Lo asumido se marca en los tres lugares (0038) y sobre lo ENTREGADO.
    const vivas = await declaracionesVivasDe(e.registroA.id);
    expect(vivas).toHaveLength(1);
    expect(vivas[0]!.source).toBe("ASSUMED_FROM_PLAN");
    expect(vivas[0]!.kind).toBe("PLANNED");
    const items = await itemsDeclaradosDe(vivas[0]!.id);
    expect(items).toHaveLength(e.renglonesA.length);
    for (const r of e.renglonesA) {
      const item = items.find((i) => i.servingRecordItemId === r.id);
      expect(item).toBeDefined();
      expect(item!.extent).toBe("ALL");
      expect(item!.declarada).toBe(false);
      expect(item!.cantidad !== null && cerca(item!.cantidad, r.entregada)).toBe(true);
    }

    // LA DESPENSA NO SE DESCUENTA DOS VECES: ni un movimiento nuevo, mismo stock.
    expect(await contarMovimientos(e.hogar)).toBe(e.movimientosTrasServir);
    expect(stockPorIngrediente(await lotesDe(e.hogar))).toEqual(e.stockTrasServir);
  });

  test("4 · comí parcial: «La mitad» estima; lo no marcado queda «No sé» sin número (UNKNOWN ≠ ZERO)", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó una comida servida: NOT_RUN");
      return;
    }
    const primero = e.renglonesB[0]!;
    const resto = e.renglonesB.slice(1);

    await comoA.goto("/comi");
    const pendiente = tarjetaDe(comoA, "Salió a la mesa", e.fichaB.nombre, e.slot.etiqueta);
    await pendiente.getByRole("button", { name: "Decir cuánto comió" }).click();
    await filaMarcador(pendiente, primero.label)
      .getByRole("button", { name: "La mitad", exact: true })
      .click();
    await pendiente
      .getByLabel("¿Algo que anotar? (opcional)")
      .fill("Comió la mitad y dejó el resto (prueba E2E)");
    await pendiente.getByRole("button", { name: "Guardar lo que comió" }).click();
    await expect(comoA.getByText("Anotado lo que se comió.")).toBeVisible();

    await recargar(comoA);
    const anotada = tarjetaDe(comoA, "Ya anotado", e.fichaB.nombre, e.slot.etiqueta);
    await expect(anotada).toBeVisible();
    // A anotó por B: lo dijo una persona, pero no la que comió.
    await expect(anotada.getByText("Lo anotó quien la cuida")).toBeVisible();
    await expect(
      anotada.getByText(`La mitad · ${redondear3(primero.entregada / 2)} g (estimado)`, {
        exact: true,
      }),
    ).toBeVisible();
    for (const r of resto) {
      await expect(
        anotada
          .locator("li")
          .filter({ has: comoA.getByText(r.label, { exact: true }) })
          .getByText("No sé · sin número anotado", { exact: true }),
      ).toBeVisible();
    }
    await expect(anotada.getByText("Comió la mitad y dejó el resto (prueba E2E)")).toBeVisible();

    const vivas = await declaracionesVivasDe(e.registroB.id);
    expect(vivas).toHaveLength(1);
    expect(vivas[0]!.source).toBe("DECLARED_CAREGIVER");
    const items = await itemsDeclaradosDe(vivas[0]!.id);
    const mitad = items.find((i) => i.servingRecordItemId === primero.id);
    expect(mitad).toBeDefined();
    expect(mitad!.extent).toBe("HALF");
    expect(mitad!.declarada).toBe(false);
    expect(mitad!.cantidad !== null && cerca(mitad!.cantidad, primero.entregada / 2)).toBe(true);
    for (const r of resto) {
      const item = items.find((i) => i.servingRecordItemId === r.id);
      expect(item).toBeDefined();
      expect(item!.extent).toBe("UNKNOWN");
      // «No sé» se escribe con NULL, jamás con 0.
      expect(item!.cantidad).toBeNull();
    }

    // Declarar no mueve inventario.
    expect(await contarMovimientos(e.hogar)).toBe(e.movimientosTrasServir);
    expect(stockPorIngrediente(await lotesDe(e.hogar))).toEqual(e.stockTrasServir);
  });

  test("5 · registro tardío: lo de AYER se anota en su día; el futuro no se acepta; comer afuera no toca la despensa", async ({
    comoA,
  }) => {
    const e = estado;
    if (!e) {
      test.skip(true, "el paso 1 no dejó una comida servida: NOT_RUN");
      return;
    }
    const hoy = hoySantiago();
    const ayer = sumarDias(hoy, -1);
    const manana = sumarDias(hoy, 1);
    const marca = `Almuerzo del trabajo (prueba E2E ${Date.now()})`;

    // Pedir mañana cae en hoy: nadie declara lo que todavía no comió.
    await comoA.goto(`/comi?dia=${manana}`);
    await expect(comoA.getByRole("link", { name: "Hoy", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Anotar hoy algo que se comió AYER, fuera de casa.
    await comoA.goto(`/comi?dia=${ayer}`);
    await expect(comoA.getByRole("link", { name: "Ayer", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await comoA.getByRole("button", { name: "Anotar otra comida" }).click();
    await comoA.getByLabel("¿Quién comió?").selectOption({ value: e.fichaA.id });
    await comoA.getByRole("button", { name: "Fuera de casa", exact: true }).click();
    await comoA.getByLabel("¿Qué comida fue? (opcional)").selectOption({ value: "LUNCH" });
    await comoA.getByLabel("¿Qué comió? (1)").fill(marca);
    await comoA.getByRole("button", { name: "Todo", exact: true }).click();
    await comoA.getByRole("button", { name: "Anotar lo que comió", exact: true }).click();
    await expect(
      comoA.getByText("Anotado: comió fuera de casa. La despensa no se toca."),
    ).toBeVisible();

    // §29: sigue en AYER después de recargar, y NO aparece en HOY.
    await recargar(comoA);
    const anotada = seccion(comoA, "Ya anotado").locator("li").filter({ hasText: marca }).last();
    await expect(anotada).toBeVisible();
    await expect(anotada.getByText("Fuera de casa")).toBeVisible();
    await expect(anotada.getByRole("heading", { name: e.fichaA.nombre, exact: true })).toBeVisible();
    await comoA.goto("/comi");
    await expect(comoA.getByText(marca)).toHaveCount(0);

    // En la base: consumido AYER, fuera de casa, sin efecto sobre inventario.
    const { data: logs, error } = await admin()
      .from("consumption_logs")
      .select("id, kind, consumed_on, affects_inventory, status")
      .eq("household_id", e.hogar)
      .eq("member_id", e.fichaA.id)
      .eq("consumed_on", ayer)
      .eq("kind", "AWAY")
      .eq("status", "ACTIVE");
    falla("consumption_logs", error);
    const ids = (logs ?? []).map((l) => l.id as string);
    expect(ids.length).toBeGreaterThan(0);
    const { data: items, error: errorItems } = await admin()
      .from("intake_log_items")
      .select("log_id, label, quantity")
      .in("log_id", ids)
      .eq("label", marca);
    falla("intake_log_items", errorItems);
    expect(items ?? []).toHaveLength(1);
    // De una comida de afuera no se inventan gramos.
    expect(items![0]!.quantity).toBeNull();
    const log = (logs ?? []).find((l) => l.id === items![0]!.log_id);
    expect(log).toBeDefined();
    expect(log!.affects_inventory).toBe(false);
    expect(await contarMovimientos(e.hogar)).toBe(e.movimientosTrasServir);
  });
});
