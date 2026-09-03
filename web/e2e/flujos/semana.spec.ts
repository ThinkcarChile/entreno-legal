/**
 * E2E §16 — PLANIFICACIÓN SEMANAL: la familia elige SIETE platos, uno por
 * día, los confirma y la compra de esa semana sale de esas siete comidas.
 *
 * La semana que se planifica es la SIGUIENTE a la de hoy (lunes a domingo),
 * para que ningún día sea pasado ni "hoy": así las porciones confirmadas son
 * demanda futura de verdad y el tablero no cambia según la hora a la que corra
 * la suite. La operativa real es la compra semanal de 7 días: acá no hay
 * ningún "10" escondido.
 *
 * Lo que este archivo afirma del producto:
 *  · La semana son 7 tarjetas, de lunes a domingo, con las 4 comidas base cada
 *    una; "Sin planificar" es el estado honesto de lo vacío.
 *  · Planificar y confirmar persisten (§29): tras recargar, cada día sigue con
 *    su plato y su confirmación, y la base tiene exactamente 7 comidas.
 *  · §31: la lista de compras sale SOLO de lo confirmado y cada línea explica
 *    de qué comidas de la semana viene ("¿Por qué necesito esto?").
 *  · §18: un evento MARCA para revisión la comida confirmada de ese día; no la
 *    reescribe. Borrar el evento también marca ("Se canceló…"): la historia
 *    confirmada nunca se toca sola.
 *  · §2: sacar a una persona de una comida rehace sus porciones (vuelve a
 *    planificada) y, al reconfirmar, guarda solo las de quienes comen.
 *
 * Serial a propósito: la lista se genera desde las comidas confirmadas y el
 * evento se agrega sobre una comida ya confirmada.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, recargar, hoySantiago, HAY_STAGING } from "../fixtures/contrato";
import { admin, hogarDe, idDeUsuario, vaciarCocina } from "../fixtures/admin";
/*
 * El calendario del HOGAR (lunes como inicio, "Lunes 7" como título) es una
 * regla de la app. Se importa su definición en vez de copiarla: un spec con su
 * propio calendario probaría su copia contra la app y un desfase de un día se
 * vería como un rojo falso. `calendar.ts` es puro: no toca red ni base.
 */
import {
  addDays,
  dayOfMonth,
  weekLabel,
  weekStart,
  weekdayName,
} from "../../src/domain/nutrition/calendar";

test.describe.configure({ mode: "serial" });

/**
 * Siete platos distintos del seed global (lote A), todos aptos para almuerzo.
 * Tres usan "Pollo, trutro entero (con piel)": la línea de compra de ese
 * alimento tiene que explicar TRES comidas.
 */
const PLATOS = [
  "Cazuela de pollo",
  "Pollo arvejado",
  "Pollo al jugo con arroz",
  "Pollo al horno con papas",
  "Cazuela de vacuno",
  "Carne mechada",
  "Bistec con puré",
] as const;

const TRUTRO = "Pollo, trutro entero (con piel)";
const TITULO_EVENTO = "Asado sintético E2E";

/** Texto literal dentro de un regex (los nombres traen paréntesis y puntos). */
function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex "empieza con". */
function inicio(texto: string): RegExp {
  return new RegExp("^" + escapar(texto));
}

/** "7 de septiembre": la parte de `formatDate` que no depende del ICU de turno. */
function diaYMes(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const mes = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("es-CL", {
    timeZone: "UTC",
    month: "long",
  });
  return `${dayOfMonth(fecha)} de ${mes}`;
}

/** El `<section>` más cercano que contiene un título: estructura, no clase. */
function seccionDe(titulo: Locator): Locator {
  return titulo.locator("xpath=ancestor::section[1]");
}

/** La tarjeta de un día del tablero, ubicada por su título "Lunes 7". */
function tarjetaDia(page: Page, fecha: string): Locator {
  const titulo = `${weekdayName(fecha)} ${dayOfMonth(fecha)}`;
  return seccionDe(page.getByRole("heading", { name: titulo, exact: true, level: 2 }));
}

/**
 * Planifica el ALMUERZO de un día. Las cuatro comidas base van en orden fijo
 * (Desayuno, Almuerzo, Once, Cena), así que el segundo "Planificar" del día es
 * el almuerzo; el combobox que se abre lleva la etiqueta que lo confirma. La
 * señal de término no es el mensaje (puede quedar el de la acción anterior)
 * sino el botón de confirmar, que solo existe cuando hay una receta asignada.
 */
async function planificarAlmuerzo(dia: Locator, receta: string): Promise<void> {
  await dia.getByRole("button", { name: "Planificar", exact: true }).nth(1).click();
  await dia.getByLabel("Planificar Almuerzo").selectOption({ label: receta });
  await expect(dia.getByRole("button", { name: "Confirmar y guardar porciones" })).toBeVisible();
  await expect(dia.getByText(receta)).toBeVisible();
}

/** Confirma la única comida con receta del día y devuelve cuántas porciones guardó. */
async function confirmarComida(page: Page, dia: Locator): Promise<number> {
  await dia.getByRole("button", { name: "Confirmar y guardar porciones" }).click();
  await expect(dia.getByRole("link", { name: "Ver lo guardado" })).toBeVisible();
  const mensaje = page.getByText(/Comida confirmada con \d+ porciones guardadas/);
  await expect(mensaje).toBeVisible();
  const porciones = Number(/con (\d+) porciones/.exec((await mensaje.textContent()) ?? "")?.[1]);
  expect(Number.isInteger(porciones)).toBe(true);
  // El chip lleva un icono delante del número, así que no hay borde de palabra:
  // se exige que el número no venga precedido de otro dígito.
  await expect(dia.getByText(new RegExp(`(?<!\\d)${porciones} porciones`))).toBeVisible();
  return porciones;
}

interface Integrante {
  id: string;
  nombre: string;
}

let hogar = "";
let lunes = "";
let dias: string[] = [];
let integrantes: Integrante[] = [];
let yo: Integrante | null = null;
let otro: Integrante | null = null;

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar
  await vaciarCocina("A");
  hogar = await hogarDe("A");
  lunes = addDays(weekStart(hoySantiago()), 7);
  dias = Array.from({ length: 7 }, (_, i) => addDays(lunes, i));

  const uidA = await idDeUsuario("A");
  const { data, error } = await admin()
    .from("household_members")
    .select("id, display_name, user_id")
    .eq("household_id", hogar)
    .eq("is_active", true)
    .order("display_name");
  if (error) throw new Error(`integrantes del hogar: ${error.message}`);
  integrantes = (data ?? []).map((f) => ({ id: f.id as string, nombre: f.display_name as string }));
  yo = integrantes.find((m) => (data ?? []).some((f) => f.id === m.id && f.user_id === uidA)) ?? null;
  otro = integrantes.find((m) => m.id !== yo?.id) ?? null;
});

test.describe("§16.a — la semana son siete días, de lunes a domingo", () => {
  test("siete tarjetas con sus cuatro comidas base, todas sin planificar", async ({ comoA }) => {
    const page = comoA;
    await page.goto(`/plan?semana=${lunes}`);
    await expect(page.getByRole("heading", { name: "Semana", level: 2 })).toBeVisible();
    await expect(page.getByText(weekLabel(lunes))).toBeVisible();
    await expect(page.getByText("0 comidas planificadas")).toBeVisible();

    for (const fecha of dias) {
      await expect(tarjetaDia(page, fecha)).toBeVisible();
    }
    // Ningún día es hoy: la semana es la siguiente, por construcción.
    expect(dias).not.toContain(hoySantiago());
    // 7 días × 4 comidas base = 28 huecos honestos.
    await expect(page.getByText("Sin planificar", { exact: true })).toHaveCount(28);
  });
});

test.describe("§16.b — elegir siete platos, uno por día", () => {
  test("cada día queda con su plato y la elección sobrevive a la recarga", async ({ comoA }) => {
    test.slow(); // siete acciones de servidor encadenadas
    const page = comoA;
    await page.goto(`/plan?semana=${lunes}`);

    for (let i = 0; i < 7; i += 1) {
      await planificarAlmuerzo(tarjetaDia(page, dias[i]!), PLATOS[i]!);
    }
    await expect(page.getByText("7 comidas planificadas")).toBeVisible();

    // §29: lo que se ve tiene que estar guardado.
    await recargar(page);
    await expect(page.getByText("7 comidas planificadas")).toBeVisible();
    for (let i = 0; i < 7; i += 1) {
      const dia = tarjetaDia(page, dias[i]!);
      await expect(dia.getByText(PLATOS[i]!)).toBeVisible();
      await expect(dia.getByRole("button", { name: "Confirmar y guardar porciones" })).toBeVisible();
    }

    // Y en la base hay exactamente siete comidas, todas planificadas.
    const { data: plan, error: errorPlan } = await admin()
      .from("weekly_plans")
      .select("id")
      .eq("household_id", hogar)
      .eq("week_start", lunes)
      .maybeSingle();
    if (errorPlan) throw new Error(`plan de la semana: ${errorPlan.message}`);
    expect(plan).not.toBeNull();
    const { data: diasPlan, error: errorDias } = await admin()
      .from("weekly_plan_days")
      .select("id")
      .eq("plan_id", plan!.id as string);
    if (errorDias) throw new Error(`días del plan: ${errorDias.message}`);
    expect(diasPlan?.length).toBe(7);
    const { data: comidas, error: errorComidas } = await admin()
      .from("meal_assignments")
      .select("id, status, kind")
      .in("day_id", (diasPlan ?? []).map((d) => d.id as string));
    if (errorComidas) throw new Error(`comidas de la semana: ${errorComidas.message}`);
    expect(comidas?.length).toBe(7);
    expect((comidas ?? []).every((c) => c.status === "PLANNED" && c.kind === "RECIPE")).toBe(true);
  });
});

test.describe("§16.c — confirmar guarda las porciones de cada comida", () => {
  test("las siete comidas quedan confirmadas con porciones guardadas", async ({ comoA }) => {
    test.slow(); // siete confirmaciones: cada una corre el optimizador y el motor clínico
    const page = comoA;
    await page.goto(`/plan?semana=${lunes}`);

    for (let i = 0; i < 7; i += 1) {
      const porciones = await confirmarComida(page, tarjetaDia(page, dias[i]!));
      // Come toda la familia: una porción por integrante activo.
      expect(porciones).toBe(integrantes.length);
    }
    await expect(page.getByText("7 confirmadas")).toBeVisible();

    await recargar(page);
    await expect(page.getByText("7 confirmadas")).toBeVisible();
    for (const fecha of dias) {
      const dia = tarjetaDia(page, fecha);
      await expect(dia.getByRole("link", { name: "Ver lo guardado" })).toBeVisible();
      await expect(dia.getByRole("button", { name: "Servir lo planificado" })).toBeVisible();
      await expect(dia.getByRole("button", { name: "Confirmar y guardar porciones" })).toHaveCount(0);
    }
  });

  test("lo guardado se puede leer: quién comió y con qué versión se calculó", async ({ comoA }) => {
    const page = comoA;
    await page.goto(`/plan?semana=${lunes}`);
    await tarjetaDia(page, dias[0]!).getByRole("link", { name: "Ver lo guardado" }).click();
    await expect(page).toHaveURL(/\/plan\/comida\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: PLATOS[0], level: 2 })).toBeVisible();
    await expect(page.getByText("Comieron: toda la familia.")).toBeVisible();
    await expect(page.getByText("Estas porciones quedaron guardadas tal como se calcularon")).toBeVisible();

    const sirvio = seccionDe(page.getByRole("heading", { name: "Se sirvió", exact: true }));
    for (const m of integrantes) {
      await expect(sirvio.getByRole("heading", { name: m.nombre, exact: true, level: 3 })).toBeVisible();
    }
    // Cada porción dice con qué versión de receta, perfil y optimizador se calculó.
    await expect(sirvio.getByText(/Calculado con .+ · perfil .+ · receta .+/).first()).toBeVisible();
    await expect(seccionDe(page.getByRole("heading", { name: "Se preparó", exact: true }))).toBeVisible();
  });
});

test.describe("§16.d — la compra de esa semana sale de las siete comidas", () => {
  test("generar la lista desde lo confirmado; cada línea explica sus comidas", async ({ comoA }) => {
    test.slow();
    const page = comoA;
    await page.goto(`/shopping?semana=${lunes}`);
    await expect(page.getByRole("heading", { name: "Compra de la semana", level: 2 })).toBeVisible();
    await expect(page.getByText(weekLabel(lunes))).toBeVisible();

    // Nada pendiente de confirmar: la lista puede ser completa.
    await expect(page.getByText(/Faltan? \d+ comidas? por confirmar/)).toHaveCount(0);
    await expect(page.getByText("Hay comidas confirmadas esta semana")).toBeVisible();

    await page.getByRole("button", { name: "Generar lista de compras" }).click();
    const mensaje = page.getByText(/Lista generada con \d+ productos/);
    await expect(mensaje).toBeVisible();
    const productos = Number(/con (\d+) productos/.exec((await mensaje.textContent()) ?? "")?.[1]);
    expect(productos).toBeGreaterThan(0);

    // §29: la lista es una revisión guardada, no estado de React.
    await recargar(page);
    await expect(page.getByText("Progreso de compra")).toBeVisible();
    await expect(page.getByText(`0 / ${productos}`)).toBeVisible();
    await expect(page.getByText("revisión 1")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^Marcar .+ como comprado$/ })).toHaveCount(productos);

    // El trutro lo piden tres platos distintos: una sola línea, tres comidas.
    const filaTrutro = page.getByRole("button", { name: inicio(TRUTRO) });
    await expect(filaTrutro).toBeVisible();
    await filaTrutro.click();
    await expect(filaTrutro).toHaveAttribute("aria-expanded", "true");
    const detalle = filaTrutro.locator("xpath=ancestor::li[1]");
    await expect(detalle.getByText("¿Por qué necesito esto?")).toBeVisible();
    await expect(detalle.getByText(/^Necesario:/).first()).toBeVisible();
    await expect(detalle.getByText(/^Comprar:/).first()).toBeVisible();
    const comidas = detalle.getByText(/· Almuerzo ·/);
    await expect(comidas.first()).toBeVisible();
    expect(await comidas.count()).toBe(3);
    // Y esas comidas son de ESTA semana: cada renglón nombra un día de ella.
    const fechasDeLaSemana = dias.map((d) => diaYMes(d).toLowerCase());
    for (const texto of await comidas.allTextContents()) {
      expect(fechasDeLaSemana.some((f) => texto.toLowerCase().includes(f))).toBe(true);
    }
  });
});

test.describe("§16.e — un evento marca para revisión la comida de ese día, no la reescribe", () => {
  test("agregar un asado el sábado deja el almuerzo confirmado 'por revisar' y persiste", async ({
    comoA,
  }) => {
    test.skip(!otro, "el hogar sintético necesita al menos dos integrantes activos");
    const page = comoA;
    const sabado = dias[5]!;
    await page.goto(`/plan?semana=${lunes}`);

    await page.getByRole("button", { name: "Agregar un evento a la semana" }).click();
    const formulario = seccionDe(page.getByRole("heading", { name: "Evento de la semana" }));
    await formulario.getByLabel("Título del evento").fill(TITULO_EVENTO);
    await formulario.getByLabel("Día del evento").selectOption(sabado);
    await formulario.getByLabel("Tipo de evento").selectOption({ label: "Asado" });
    await formulario.getByLabel("Comida afectada").selectOption({ label: "Almuerzo" });
    await formulario.getByLabel("Estrategia del día").selectOption({ label: "Con margen" });
    // Se declara a quién afecta: así el evento no queda "sin decir".
    await formulario.getByRole("checkbox", { name: otro!.nombre }).check();
    await formulario.getByRole("button", { name: "Guardar evento" }).click();
    await expect(page.getByText("Evento agregado.")).toBeVisible();

    const dia = tarjetaDia(page, sabado);
    await expect(dia.getByText(TITULO_EVENTO)).toBeVisible();
    await expect(dia.getByText(/Asado · Con margen/)).toBeVisible();
    await expect(dia.getByText("Todavía no dice a quién de la casa afecta")).toHaveCount(0);
    // §18: la comida confirmada de ese día queda marcada; sus porciones no se tocan.
    await expect(dia.getByText("Se agregó un evento ese día")).toBeVisible();
    await expect(dia.getByText("Las porciones guardadas quedaron como estaban")).toBeVisible();
    await expect(dia.getByRole("link", { name: "Ver lo guardado" })).toBeVisible();
    // Los otros días no cambian.
    await expect(tarjetaDia(page, dias[4]!).getByText(/un evento/)).toHaveCount(0);

    await recargar(page);
    await expect(tarjetaDia(page, sabado).getByText(TITULO_EVENTO)).toBeVisible();
    await expect(tarjetaDia(page, sabado).getByText("Se agregó un evento ese día")).toBeVisible();

    // Lo guardado sigue diciendo lo mismo, con el aviso de que algo cambió alrededor.
    await tarjetaDia(page, sabado).getByRole("link", { name: "Ver lo guardado" }).click();
    await expect(page.getByText(/Se agregó un evento ese día/)).toBeVisible();
    await expect(page.getByText("Lo guardado acá no se tocó")).toBeVisible();
  });

  test("quitar el evento también marca ('Se canceló…'): nada se recalcula solo", async ({
    comoA,
  }) => {
    test.skip(!otro, "el hogar sintético necesita al menos dos integrantes activos");
    const page = comoA;
    const sabado = dias[5]!;
    await page.goto(`/plan?semana=${lunes}`);
    const dia = tarjetaDia(page, sabado);
    await dia.getByRole("button", { name: "Quitar", exact: true }).click();
    await expect(page.getByText("Evento borrado.")).toBeVisible();

    await recargar(page);
    await expect(tarjetaDia(page, sabado).getByText(TITULO_EVENTO)).toHaveCount(0);
    await expect(tarjetaDia(page, sabado).getByText("Se canceló un evento de ese día")).toBeVisible();
    await expect(tarjetaDia(page, sabado).getByRole("link", { name: "Ver lo guardado" })).toBeVisible();
  });
});

test.describe("§16.f — quién come: sacar a una persona rehace sus porciones", () => {
  test("sin una persona, la comida vuelve a planificada y se reconfirma solo para el resto", async ({
    comoA,
  }) => {
    test.skip(!otro || !yo, "el hogar sintético necesita al menos dos integrantes activos");
    const page = comoA;
    const jueves = dias[3]!;
    await page.goto(`/plan?semana=${lunes}`);
    const dia = tarjetaDia(page, jueves);

    await dia.getByRole("button", { name: /^Comen: todos/ }).click();
    await dia.getByRole("checkbox", { name: otro!.nombre }).uncheck();
    await dia.getByRole("button", { name: "Guardar quién come" }).click();
    await expect(page.getByText("Listo, quedó anotado quién come.")).toBeVisible();

    // Las porciones guardadas ya no corresponden: la comida vuelve a planificada.
    await expect(dia.getByRole("button", { name: "Confirmar y guardar porciones" })).toBeVisible();
    await expect(dia.getByRole("link", { name: "Ver lo guardado" })).toHaveCount(0);
    const comen = dia.getByRole("button", { name: /^Comen:/ });
    await expect(comen).toHaveText(new RegExp(escapar(yo!.nombre)));
    await expect(comen).not.toHaveText(new RegExp(escapar(otro!.nombre)));

    await recargar(page);
    const diaRecargado = tarjetaDia(page, jueves);
    await expect(diaRecargado.getByRole("button", { name: /^Comen:/ })).not.toHaveText(
      new RegExp(escapar(otro!.nombre)),
    );

    // Reconfirmar guarda una porción por cada persona que SÍ come.
    const porciones = await confirmarComida(page, diaRecargado);
    expect(porciones).toBe(integrantes.length - 1);

    await diaRecargado.getByRole("link", { name: "Ver lo guardado" }).click();
    await expect(page.getByText(/^Comieron: /)).toHaveText(new RegExp(escapar(yo!.nombre)));
    await expect(page.getByText(/^Comieron: /)).not.toHaveText(new RegExp(escapar(otro!.nombre)));
    const sirvio = seccionDe(page.getByRole("heading", { name: "Se sirvió", exact: true }));
    await expect(sirvio.getByRole("heading", { name: yo!.nombre, exact: true, level: 3 })).toBeVisible();
    await expect(sirvio.getByRole("heading", { name: otro!.nombre, exact: true, level: 3 })).toHaveCount(0);
  });
});
