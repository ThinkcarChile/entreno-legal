/**
 * E2E §17 — SHOPPING → INVENTORY: plan → confirmar comidas → lista de compras
 * → comprar → recibir → lotes en la despensa → reservas y stock libre.
 *
 * Todo sobre la semana SIGUIENTE a la de hoy: así las comidas confirmadas son
 * demanda futura y la despensa tiene algo que reservar. La cocina se vacía al
 * empezar (`vaciarCocina`) y cada paso se verifica DESPUÉS de recargar (§29):
 * lo que solo vive en React no cuenta como comprado ni como recibido.
 *
 * Lo que este archivo afirma del producto:
 *  · §31: la lista oficial sale SOLO de las porciones confirmadas. Una comida
 *    planificada sin confirmar se informa ("Falta 1 comida por confirmar") y
 *    sus ingredientes NO entran a la lista.
 *  · §36: la compra se finaliza antes de recibirse; una lista cerrada no se
 *    edita.
 *  · K-22 / §28 (double receive): recibir la misma compra dos veces —en serie o
 *    desde dos pestañas a la vez— crea los lotes UNA sola vez. Solo lo marcado
 *    COMPRADO se vuelve lote; "Ya lo tengo" no inventa inventario.
 *  · Stock Intelligence (ADR 0009, no doble conteo): lo recibido aparece como
 *    "En casa", la demanda confirmada como "reservado", y el "libre" es la
 *    diferencia. La lista de compras muestra "en casa" al lado de la línea como
 *    dato, sin tocar la cantidad calculada.
 *
 * Serial a propósito: cada paso es la entrada del siguiente.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, recargar, hoySantiago, HAY_STAGING } from "../fixtures/contrato";
import { admin, hogarDe, vaciarCocina } from "../fixtures/admin";
/*
 * El calendario del hogar es una regla de la app; se importa su definición
 * (módulo puro, sin red ni base) para no probar una copia contra la original.
 */
import { addDays, dayOfMonth, weekStart, weekdayName } from "../../src/domain/nutrition/calendar";

test.describe.configure({ mode: "serial" });

/** Dos almuerzos confirmados y uno que se deja SIN confirmar a propósito. */
const CONFIRMADOS = ["Pollo al jugo con arroz", "Bistec con puré"] as const;
const SIN_CONFIRMAR = "Pollo arvejado";
/** Alimentos con identidad única en cada receta, por su nombre del catálogo. */
const PECHUGA = "Pechuga de pollo (sin piel)"; // solo en "Pollo al jugo con arroz"
const ASIENTO = "Vacuno asiento (bistec)"; // solo en "Bistec con puré"
const TRUTRO = "Pollo, trutro entero (con piel)"; // solo en "Pollo arvejado" (sin confirmar)

/** Texto literal dentro de un regex. */
function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inicio(texto: string): RegExp {
  return new RegExp("^" + escapar(texto));
}

/** El `<section>` más cercano que contiene un título: estructura, no clase. */
function seccionDe(titulo: Locator): Locator {
  return titulo.locator("xpath=ancestor::section[1]");
}

/** La tarjeta de un día del tablero de la semana, por su título "Lunes 7". */
function tarjetaDia(page: Page, fecha: string): Locator {
  const titulo = `${weekdayName(fecha)} ${dayOfMonth(fecha)}`;
  return seccionDe(page.getByRole("heading", { name: titulo, exact: true, level: 2 }));
}

/** Planifica el almuerzo (segunda comida base) de un día con una receta. */
async function planificarAlmuerzo(dia: Locator, receta: string): Promise<void> {
  await dia.getByRole("button", { name: "Planificar", exact: true }).nth(1).click();
  await dia.getByLabel("Planificar Almuerzo").selectOption({ label: receta });
  await expect(dia.getByRole("button", { name: "Confirmar y guardar porciones" })).toBeVisible();
  await expect(dia.getByText(receta)).toBeVisible();
}

async function confirmarComida(page: Page, dia: Locator): Promise<void> {
  await dia.getByRole("button", { name: "Confirmar y guardar porciones" }).click();
  await expect(dia.getByRole("link", { name: "Ver lo guardado" })).toBeVisible();
  await expect(page.getByText(/Comida confirmada con \d+ porciones guardadas/)).toBeVisible();
}

/** Lotes disponibles del hogar, desde la base. Sin conteo no hay número. */
async function lotesEnCasa(): Promise<number> {
  const { count, error } = await admin()
    .from("inventory_lots")
    .select("id", { count: "exact", head: true })
    .eq("household_id", hogar)
    .eq("status", "AVAILABLE")
    .gt("quantity", 0);
  if (error) throw new Error(`lotes del hogar: ${error.message}`);
  // UNKNOWN ≠ ZERO: un conteo ausente no es "cero lotes".
  if (count === null) throw new Error("la consulta de lotes no trajo su conteo");
  return count;
}

/** Cuántas líneas COMPRADAS con identidad y cantidad tiene la lista: eso se recibe. */
async function lineasRecibibles(): Promise<number> {
  const { data, error } = await admin()
    .from("shopping_list_items")
    .select("ingredient_id, product_id, planned_quantity, required_quantity, shopping_lists!inner ( household_id )")
    .eq("status", "PURCHASED")
    .eq("shopping_lists.household_id", hogar);
  if (error) throw new Error(`líneas compradas: ${error.message}`);
  return (data ?? []).filter((i) => {
    // PostgREST devuelve numeric como TEXTO: se convierte antes de comparar.
    const cantidad = Number(i.planned_quantity ?? i.required_quantity ?? 0);
    return (i.ingredient_id || i.product_id) && cantidad > 0;
  }).length;
}

/** El número de lotes que dice el mensaje de recepción ("Nada nuevo" = 0). */
function lotesDelMensaje(texto: string): number {
  if (/Nada nuevo que recibir/.test(texto)) return 0;
  const n = /(\d+) lotes? recibidos?/.exec(texto)?.[1];
  if (!n) throw new Error(`mensaje de recepción inesperado: "${texto}"`);
  return Number(n);
}

let hogar = "";
let lunes = "";
let dias: string[] = [];
let productos = 0;
let recibidos = 0;

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar
  await vaciarCocina("A");
  hogar = await hogarDe("A");
  lunes = addDays(weekStart(hoySantiago()), 7);
  dias = Array.from({ length: 7 }, (_, i) => addDays(lunes, i));
});

test.describe("§17.a — plan y confirmación", () => {
  test("dos almuerzos confirmados y uno planificado sin confirmar", async ({ comoA }) => {
    test.slow();
    const page = comoA;
    await page.goto(`/plan?semana=${lunes}`);
    await expect(page.getByText("0 comidas planificadas")).toBeVisible();

    await planificarAlmuerzo(tarjetaDia(page, dias[0]!), CONFIRMADOS[0]);
    await planificarAlmuerzo(tarjetaDia(page, dias[1]!), CONFIRMADOS[1]);
    await planificarAlmuerzo(tarjetaDia(page, dias[2]!), SIN_CONFIRMAR);
    await confirmarComida(page, tarjetaDia(page, dias[0]!));
    await confirmarComida(page, tarjetaDia(page, dias[1]!));

    await recargar(page);
    await expect(page.getByText("3 comidas planificadas")).toBeVisible();
    await expect(page.getByText("2 confirmadas")).toBeVisible();
    await expect(tarjetaDia(page, dias[2]!).getByRole("button", { name: "Confirmar y guardar porciones" })).toBeVisible();
  });
});

test.describe("§17.b — la lista sale SOLO de lo confirmado", () => {
  test("lo pendiente se informa y sus ingredientes no entran a la lista", async ({ comoA }) => {
    const page = comoA;
    await page.goto(`/shopping?semana=${lunes}`);

    const pendiente = page.getByText("Falta 1 comida por confirmar");
    await expect(pendiente).toBeVisible();
    await expect(page.getByText(`Almuerzo · ${SIN_CONFIRMAR}`)).toBeVisible();
    await expect(page.getByText("La lista incluye solo lo confirmado")).toBeVisible();

    await page.getByRole("button", { name: "Generar lista de compras" }).click();
    const mensaje = page.getByText(/Lista generada con \d+ productos/);
    await expect(mensaje).toBeVisible();
    productos = Number(/con (\d+) productos/.exec((await mensaje.textContent()) ?? "")?.[1]);
    expect(productos).toBeGreaterThan(0);

    await recargar(page);
    await expect(page.getByText(`0 / ${productos}`)).toBeVisible();
    await expect(page.getByText("revisión 1")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^Marcar .+ como comprado$/ })).toHaveCount(productos);
    // Lo confirmado está; lo del almuerzo sin confirmar, no.
    await expect(page.getByRole("checkbox", { name: `Marcar ${PECHUGA} como comprado` })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: `Marcar ${ASIENTO} como comprado` })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: `Marcar ${TRUTRO} como comprado` })).toHaveCount(0);
    // Ninguna línea con la cantidad en cero disfrazada de calculada.
    await expect(page.getByText(/^0 (g|ml|unidades)$/)).toHaveCount(0);
  });
});

test.describe("§17.c — comprar y finalizar", () => {
  test("todo comprado menos una línea 'ya lo tengo'; la compra cerrada no se edita", async ({
    comoA,
  }) => {
    test.slow();
    const page = comoA;
    await page.goto(`/shopping?semana=${lunes}`);

    const casillas = page.getByRole("checkbox", { name: /^Marcar .+ como comprado$/ });
    await expect(casillas).toHaveCount(productos);
    // Todas menos la última se compran. Cada marca es una acción de servidor.
    for (let i = 0; i < productos - 1; i += 1) {
      const casilla = casillas.nth(i);
      await casilla.check();
      await expect(casilla).toBeChecked();
      await expect(casilla).toBeEnabled();
    }
    // La última no se compra: ya está en casa. Eso NO crea un lote al recibir.
    const ultima = casillas.nth(productos - 1);
    const nombreUltima = (await ultima.getAttribute("aria-label")) ?? "";
    const etiquetaUltima = /^Marcar (.+) como comprado$/.exec(nombreUltima)?.[1] ?? "";
    expect(etiquetaUltima).not.toBe("");
    const filaUltima = page.getByRole("button", { name: inicio(etiquetaUltima) });
    await filaUltima.click();
    await expect(filaUltima).toHaveAttribute("aria-expanded", "true");
    await filaUltima.locator("xpath=ancestor::li[1]").getByRole("button", { name: "Ya lo tengo" }).click();
    await expect(page.getByText(`${productos} / ${productos}`)).toBeVisible();

    await recargar(page);
    await expect(page.getByText(`${productos} / ${productos}`)).toBeVisible();
    for (let i = 0; i < productos - 1; i += 1) {
      await expect(casillas.nth(i)).toBeChecked();
    }
    await expect(casillas.nth(productos - 1)).not.toBeChecked();
    await expect(page.getByText("· Ya lo tengo")).toBeVisible();

    await page.getByRole("button", { name: "Finalizar compra" }).click();
    await expect(page.getByText("Compra finalizada.")).toBeVisible();

    await recargar(page);
    await expect(page.getByText("compra finalizada")).toBeVisible();
    await expect(page.getByRole("button", { name: "Recibir compra en la despensa" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Finalizar compra" })).toHaveCount(0);
    // §36: cerrada = sin edición. Las casillas quedan deshabilitadas.
    await expect(casillas.first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Agregar producto" })).toHaveCount(0);

    // La base coincide con lo que se ve: productos − 1 líneas compradas.
    expect(await lineasRecibibles()).toBe(productos - 1);
  });
});

test.describe("§17.d — recibir: lotes en la despensa (§28: dos pestañas a la vez)", () => {
  test("dos recepciones simultáneas crean los lotes UNA vez; la despensa los muestra", async ({
    comoA,
  }) => {
    test.slow();
    const page = comoA;
    const esperados = await lineasRecibibles();
    expect(esperados).toBeGreaterThan(0);
    expect(await lotesEnCasa()).toBe(0);

    // La misma persona, dos pestañas, el mismo botón al mismo tiempo (§28).
    const otraPestana = await page.context().newPage();
    await page.goto(`/shopping?semana=${lunes}`);
    await otraPestana.goto(`/shopping?semana=${lunes}`);
    const boton = (p: Page) => p.getByRole("button", { name: "Recibir compra en la despensa" });
    await expect(boton(page)).toBeVisible();
    await expect(boton(otraPestana)).toBeVisible();
    await Promise.all([boton(page).click(), boton(otraPestana).click()]);

    const respuesta = (p: Page) => p.getByText(/lotes? recibidos?|Nada nuevo que recibir/);
    await expect(respuesta(page)).toBeVisible();
    await expect(respuesta(otraPestana)).toBeVisible();
    const suma =
      lotesDelMensaje((await respuesta(page).textContent()) ?? "") +
      lotesDelMensaje((await respuesta(otraPestana).textContent()) ?? "");
    await otraPestana.close();

    // Entre las dos pestañas se recibió exactamente lo comprado, ni una vez más.
    expect(suma).toBe(esperados);
    expect(await lotesEnCasa()).toBe(esperados);
    recibidos = esperados;

    // La despensa lo muestra, lote por lote, con su nombre del catálogo.
    await page.goto("/pantry");
    await expect(page.getByRole("heading", { name: "Despensa", level: 2 })).toBeVisible();
    await expect(page.getByText(`${recibidos} ${recibidos === 1 ? "lote" : "lotes"} en casa`)).toBeVisible();
    await expect(page.getByRole("button", { name: inicio(PECHUGA) })).toBeVisible();
    await expect(page.getByRole("button", { name: inicio(ASIENTO) })).toBeVisible();
    await expect(page.getByRole("button", { name: inicio(TRUTRO) })).toHaveCount(0);

    await recargar(page);
    await expect(page.getByText(`${recibidos} ${recibidos === 1 ? "lote" : "lotes"} en casa`)).toBeVisible();

    // Y la lista de compras ahora sabe que eso está en casa, como dato al lado.
    await page.goto(`/shopping?semana=${lunes}`);
    const filaPechuga = page.getByRole("button", { name: inicio(PECHUGA) });
    await expect(filaPechuga).toBeVisible();
    await expect(filaPechuga).toHaveText(/en casa: /);
  });
});

test.describe("§17.e — reservas y stock libre desde el libro mayor", () => {
  test("lo recibido está en casa, la comida confirmada lo reserva y el libre es la resta", async ({
    comoA,
  }) => {
    const page = comoA;
    await page.goto("/pantry");

    // Stock Intelligence habla por alimento: en casa / reservado / libre.
    const ficha = page.getByRole("link", { name: inicio(PECHUGA) });
    await expect(ficha).toBeVisible();
    await expect(ficha).toHaveText(/En casa \d[\d.,]* (g|kg) · reservado \d[\d.,]* (g|kg) · libre /);
    await expect(page.getByText("Reservas, cobertura y recomendaciones se calculan en vivo")).toBeVisible();

    await ficha.click();
    await expect(page).toHaveURL(/\/pantry\/item\/[0-9a-f-]+/);
    await expect(page.getByRole("heading", { name: PECHUGA, level: 2 })).toBeVisible();
    await expect(page.getByText(/^En casa .+ · reservado .+ · (libre|faltan) /)).toBeVisible();
    await expect(page.getByText("Cobertura", { exact: true })).toBeVisible();
    const lotes = seccionDe(page.getByRole("heading", { name: "Lotes", exact: true }));
    await expect(lotes.getByText(PECHUGA)).toBeVisible();
    // Sin objetivo declarado, la pantalla lo dice en vez de inventar uno.
    await expect(page.getByText("Sin objetivo declarado")).toBeVisible();

    await recargar(page);
    await expect(page.getByText(/^En casa .+ · reservado .+ · (libre|faltan) /)).toBeVisible();
  });
});

test.describe("§17.f — recibir de nuevo no duplica (K-22)", () => {
  test("una segunda recepción dice 'nada nuevo' y la despensa queda igual", async ({ comoA }) => {
    const page = comoA;
    const antes = await lotesEnCasa();
    expect(antes).toBe(recibidos);

    await page.goto(`/shopping?semana=${lunes}`);
    await page.getByRole("button", { name: "Recibir compra en la despensa" }).click();
    await expect(page.getByText("Nada nuevo que recibir: esta compra ya estaba en la despensa.")).toBeVisible();

    expect(await lotesEnCasa()).toBe(antes);
    await page.goto("/pantry");
    await expect(page.getByText(`${antes} ${antes === 1 ? "lote" : "lotes"} en casa`)).toBeVisible();
    await expect(page.getByRole("button", { name: inicio(PECHUGA) })).toHaveCount(1);
  });
});
