/**
 * E2E §15 — RECETARIO: buscar, abrir una receta real de la biblioteca, leer su
 * versión publicada, sus ingredientes con base física, su completitud
 * nutricional honesta y el cálculo "para N personas".
 *
 * Las tres recetas son del seed global (`supabase/seed/dev_recipes_biblioteca.sql`,
 * generado desde `web/src/domain/recipes/library/lote-a.ts`) y se buscan por su
 * nombre EXACTO. No se crea ni se copia ninguna: el recetario de la familia no
 * queda con residuos.
 *
 * Lo que este archivo afirma del producto:
 *  · UNKNOWN ≠ ZERO (ADR 0002 §5): un nutriente que ningún ingrediente informa
 *    se muestra como "Sin datos", jamás como 0; uno que solo algunos informan se
 *    muestra con "≥" y "Cálculo incompleto". "Pollo arvejado" se eligió con
 *    evidencia: ninguno de sus diez ingredientes declara fósforo en el seed, y
 *    varios no declaran fibra ni potasio.
 *  · Historia congelada (ADR 0002 §3): la versión publicada lee su ficha
 *    congelada y la pantalla lo dice ("congelada en esta versión"); la fuente
 *    DEV_SEED se muestra como "Datos de desarrollo (no oficiales)", nunca como
 *    verificada.
 *  · K-21: sobre una versión publicada no hay "Editar"; una receta de la
 *    biblioteca no se edita, se copia.
 *  · §8 porciones: "Calcular para N" escala en el cliente y NO toca la receta
 *    persistida: la sección Ingredientes sigue en la base y al recargar (§29)
 *    el cálculo vuelve a las porciones base.
 *  · ERROR ≠ VACÍO: una búsqueda sin coincidencias dice "No hay recetas que
 *    coincidan", con su conteo en cero, no una pantalla en blanco.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, recargar, HAY_STAGING } from "../fixtures/contrato";
import { admin, hogarDe } from "../fixtures/admin";

/** Nombres exactos del seed. Si staging no los tiene, el hook lo dice. */
const RECETAS = {
  /** Fósforo desconocido en TODOS sus ingredientes; fibra/potasio parciales. */
  guiso: "Pollo arvejado",
  /** Base 2 personas y dos alternativas culinarias: el flujo de porciones. */
  desayuno: "Avena con leche y plátano",
  /** Publicada, de la biblioteca: la vista de porciones para la familia. */
  bistec: "Bistec con puré",
} as const;

/** Regex "empieza con", con el texto escapado (los nombres traen paréntesis). */
function inicio(texto: string): RegExp {
  return new RegExp("^" + texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/**
 * El `<section>` más cercano que contiene un título. Se sube por estructura
 * (`ancestor::section`), no por clase CSS: el kit envuelve cada panel en un
 * `<section>` cuyo `h3` es el título visible.
 */
function seccionDe(titulo: Locator): Locator {
  return titulo.locator("xpath=ancestor::section[1]");
}

/** El `<dd>` que sigue a la etiqueta de un nutriente dentro de un panel. */
function valorDe(panel: Locator, nutriente: string): Locator {
  return panel
    .getByText(nutriente, { exact: true })
    .locator("xpath=following-sibling::dd[1]");
}

/** Busca por nombre desde la pantalla de recetas y abre la coincidencia exacta. */
async function abrirReceta(page: Page, nombre: string): Promise<void> {
  await page.goto("/recipes");
  await page.getByLabel("Buscar receta por nombre").fill(nombre);
  await page.getByLabel("Buscar receta por nombre").press("Enter");
  await expect(page).toHaveURL(/\/recipes\?q=/);
  await page.getByRole("link", { name: inicio(nombre) }).first().click();
  await expect(page.getByRole("heading", { name: nombre, exact: true, level: 2 })).toBeVisible();
}

let integrantes: string[] = [];

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar

  // Las tres recetas tienen que existir en la biblioteca GLOBAL de staging. Si
  // faltan, staging está sin el seed del recetario y el error debe decirlo —
  // no disfrazarse de "la búsqueda no encontró nada".
  const { data, error } = await admin()
    .from("meal_templates")
    .select("name")
    .is("household_id", null)
    .eq("is_active", true)
    .in("name", Object.values(RECETAS));
  if (error) throw new Error(`recetas del seed: ${error.message}`);
  const presentes = new Set((data ?? []).map((r) => r.name as string));
  const faltan = Object.values(RECETAS).filter((n) => !presentes.has(n));
  if (faltan.length > 0) {
    throw new Error(
      `Staging no tiene la biblioteca sembrada (faltan: ${faltan.join(", ")}). ` +
        "Aplica supabase/seed/dev_recipes_biblioteca.sql antes de correr los E2E.",
    );
  }

  const hogar = await hogarDe("A");
  const { data: filas, error: errorFilas } = await admin()
    .from("household_members")
    .select("display_name")
    .eq("household_id", hogar)
    .eq("is_active", true)
    .order("display_name");
  if (errorFilas) throw new Error(`integrantes del hogar: ${errorFilas.message}`);
  integrantes = (filas ?? []).map((f) => f.display_name as string);
});

test.describe("§15.a — buscar en el recetario", () => {
  test("buscar por nombre lista la receta de la biblioteca con su versión", async ({ comoA }) => {
    const page = comoA;
    await page.goto("/recipes");
    await expect(page.getByRole("heading", { name: "Recetas", level: 2 })).toBeVisible();

    await page.getByLabel("Buscar receta por nombre").fill(RECETAS.guiso);
    await page.getByLabel("Buscar receta por nombre").press("Enter");
    await expect(page).toHaveURL(/\/recipes\?q=/);

    // El conteo dice cuántas coinciden y la pista repite lo buscado.
    await expect(page.getByRole("heading", { name: /^\d+ recetas?$/ })).toBeVisible();
    await expect(page.getByText(/Coinciden con/)).toBeVisible();

    const tarjeta = page.getByRole("link", { name: inicio(RECETAS.guiso) }).first();
    await expect(tarjeta).toBeVisible();
    // Es de la biblioteca y se lista con su versión vigente.
    await expect(tarjeta).toHaveText(/Biblioteca/);
    await expect(tarjeta).toHaveText(/v\d+/);

    // El filtro "Biblioteca" existe y mantiene la búsqueda.
    await page.getByRole("link", { name: "Biblioteca", exact: true }).click();
    await expect(page).toHaveURL(/scope=global/);
    await expect(page.getByRole("link", { name: inicio(RECETAS.guiso) }).first()).toBeVisible();
  });

  test("una búsqueda sin coincidencias dice que no hay, con conteo cero (ERROR ≠ VACÍO)", async ({
    comoA,
  }) => {
    const page = comoA;
    await page.goto("/recipes?q=zzz-receta-que-no-existe-e2e");
    await expect(page.getByRole("heading", { name: "0 recetas", exact: true })).toBeVisible();
    await expect(page.getByText("No hay recetas que coincidan")).toBeVisible();
  });
});

test.describe("§15.b — abrir una receta publicada de la biblioteca", () => {
  test("versión publicada, ingredientes con base física y procedencia congelada", async ({
    comoA,
  }) => {
    const page = comoA;
    await abrirReceta(page, RECETAS.guiso);

    // Versión y estado, tal como el seed la publicó.
    await expect(page.getByText("Versión 1")).toBeVisible();
    await expect(page.getByText("Publicada", { exact: true })).toBeVisible();
    await expect(page.getByText("Almuerzo, Cena")).toBeVisible();
    await expect(page.getByText("Receta de la biblioteca. No se edita")).toBeVisible();

    // K-21 en la interfaz: nada de editar ni publicar sobre lo publicado ajeno.
    await expect(page.getByRole("button", { name: "Editar borrador" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publicar", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Crear versión nueva" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copiar a mis recetas" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver porciones para mi familia" })).toBeVisible();

    // Ingredientes: cantidad, base física y método, tal como están en lote-a.ts.
    const ingredientes = seccionDe(page.getByRole("heading", { name: "Ingredientes", exact: true }));
    await expect(ingredientes.getByText("Receta para 4 personas")).toBeVisible();
    await expect(ingredientes.getByText("Pollo, trutro entero (con piel)")).toBeVisible();
    await expect(ingredientes.getByText("800 g", { exact: true })).toBeVisible();
    await expect(ingredientes.getByText("Crudo · Guisado").first()).toBeVisible();
    await expect(ingredientes.getByText("Arroz blanco")).toBeVisible();
    await expect(ingredientes.getByText("240 g", { exact: true })).toBeVisible();
    await expect(ingredientes.getByText("Crudo · Hervido")).toBeVisible();
    // El aceite se mide como se vende (ml), no se convierte a "crudo".
    await expect(ingredientes.getByText("Aceite vegetal")).toBeVisible();
    await expect(ingredientes.getByText("20 ml", { exact: true })).toBeVisible();
    await expect(ingredientes.getByText("Como se vende").first()).toBeVisible();
    // Un opcional se declara opcional.
    await expect(ingredientes.getByText(/^Ajo$/)).toBeVisible();
    await expect(ingredientes.getByText("Crudo · opcional").first()).toBeVisible();

    // Alternativa culinaria ≠ equivalencia nutricional: se dice al lado.
    await expect(
      ingredientes.getByText(/En vez de esto también sirve: .*Pechuga de pollo \(sin piel\) \(buen reemplazo\)/),
    ).toBeVisible();
    await expect(
      ingredientes.getByText("Reemplazo de cocina, no equivalencia nutricional").first(),
    ).toBeVisible();

    // Preparación: el primer paso del seed, con su duración.
    const preparacion = seccionDe(page.getByRole("heading", { name: "Preparación", exact: true }));
    await expect(
      preparacion.getByText("Dorar las presas de pollo en el aceite hasta que tomen color parejo."),
    ).toBeVisible();

    // Procedencia: la ficha viene congelada en la versión y es DEV_SEED, que la
    // pantalla llama por su nombre — no "verificada".
    const fuentes = seccionDe(page.getByRole("heading", { name: "De dónde salen los datos" }));
    await expect(fuentes.getByText("congelada en esta versión").first()).toBeVisible();
    await expect(fuentes.getByText("Datos de desarrollo (no oficiales)").first()).toBeVisible();
    await expect(fuentes.getByText("Etiqueta verificada")).toHaveCount(0);

    // El rendimiento total después de cocinar no está en el seed: se declara
    // desconocido, no se asume que el peso se mantiene.
    await expect(page.getByText(/Rendimiento después de cocinar: ?desconocido/)).toBeVisible();
  });
});

test.describe("§15.c — completitud nutricional: desconocido se muestra desconocido", () => {
  test("fósforo sin datos, potasio parcial con ≥, energía completa sin ≥", async ({ comoA }) => {
    const page = comoA;
    await abrirReceta(page, RECETAS.guiso);

    // Ningún ingrediente quedó fuera del cálculo por datos inconsistentes.
    await expect(page.getByText("Hay ingredientes que no se pudieron calcular")).toHaveCount(0);

    const total = seccionDe(page.getByRole("heading", { name: "Total para 4 personas" }));
    await expect(total).toBeVisible();

    // UNKNOWN: ninguno de los diez ingredientes del seed declara fósforo.
    await expect(valorDe(total, "Fósforo")).toHaveText("Sin datos");
    await expect(valorDe(total, "Fósforo")).not.toHaveText(/0/);

    // PARTIAL: el trutro y el aceite no declaran fibra; el ajo no declara sodio.
    // El número va precedido de "≥" y el panel lo rotula "Cálculo incompleto".
    await expect(valorDe(total, "Fibra")).toHaveText(/^≥ ?\d/);
    await expect(valorDe(total, "Potasio")).toHaveText(/^≥ ?\d/);
    await expect(total.getByText("Cálculo incompleto").first()).toBeVisible();
    await expect(total.getByText(/Algún ingrediente no informa/)).toBeVisible();
    await expect(total.getByText(/no es el total del plato/)).toBeVisible();

    // COMPLETE: todos declaran energía, proteína, carbohidratos y grasas —
    // sin "≥" y sin "Sin datos".
    for (const nutriente of ["Energía", "Proteína", "Carbohidratos", "Grasas"]) {
      await expect(valorDe(total, nutriente)).toHaveText(/^\d[\d.,]* (kcal|g)$/);
    }

    // El panel por porción también existe y respeta la misma regla.
    const porcion = seccionDe(page.getByRole("heading", { name: "Por porción", exact: true }));
    await expect(porcion).toBeVisible();
    await expect(valorDe(porcion, "Energía")).toHaveText(/^\d[\d.,]* kcal$/);
  });
});

test.describe("§15.d — calcular para N personas no toca la receta", () => {
  test("escalar a 4 duplica las cantidades y al recargar vuelve a la base", async ({ comoA }) => {
    const page = comoA;
    await abrirReceta(page, RECETAS.desayuno);

    // Dos alternativas del seed, con su compatibilidad en palabras.
    await expect(
      page.getByText(/En vez de esto también sirve: .*Manzana \(buen reemplazo\), .*Arándanos \(buen reemplazo\)/),
    ).toBeVisible();

    const personas = page.getByLabel("Calcular para");
    await expect(personas).toHaveValue("2");
    await expect(page.getByRole("heading", { name: "Total para 2 personas" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Volver a 2$/ })).toHaveCount(0);

    await personas.fill("4");
    await expect(page.getByRole("heading", { name: "Total para 4 personas" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Volver a 2$/ })).toBeVisible();

    // La leche pasa de 400 a 800 ml y se muestra la base; la avena de 80 a 160 g.
    const calculo = seccionDe(page.getByRole("heading", { name: "Total para 4 personas" })).locator(
      "xpath=preceding-sibling::*",
    );
    await expect(calculo.getByText(/800 ml.*\(base 400\)/)).toBeVisible();
    await expect(calculo.getByText(/160 g.*\(base 80\)/)).toBeVisible();

    // La receta persistida no cambió: la sección Ingredientes sigue en 400 ml.
    const ingredientes = seccionDe(page.getByRole("heading", { name: "Ingredientes", exact: true }));
    await expect(ingredientes.getByText("Receta para 2 personas")).toBeVisible();
    await expect(ingredientes.getByText("400 ml", { exact: true })).toBeVisible();

    // Cero personas no calcula nada: pide el dato en vez de inventar.
    await personas.fill("0");
    await expect(page.getByText("Indica cuántas personas van a comer.")).toBeVisible();

    // §29: el cálculo vive en el cliente. Al recargar vuelve a la base.
    await recargar(page);
    await expect(page.getByLabel("Calcular para")).toHaveValue("2");
    await expect(page.getByRole("heading", { name: "Total para 2 personas" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Volver a 2$/ })).toHaveCount(0);
  });
});

test.describe("§15.e — porciones para mi familia desde una receta publicada", () => {
  test("cada integrante recibe su porción y el total es la suma exacta", async ({ comoA }) => {
    const page = comoA;
    await abrirReceta(page, RECETAS.bistec);
    await page.getByRole("link", { name: "Ver porciones para mi familia" }).click();
    await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+\/family\?v=/);
    await expect(page.getByRole("heading", { name: "Porciones para mi familia" })).toBeVisible();
    await expect(page.getByText(`${RECETAS.bistec} · versión 1 · receta base para 4`)).toBeVisible();

    // Una tarjeta por integrante activo del hogar sintético.
    expect(integrantes.length).toBeGreaterThan(0);
    for (const nombre of integrantes) {
      await expect(page.getByRole("heading", { name: nombre, exact: true, level: 3 })).toBeVisible();
    }

    // El total de la casa no es "receta × personas": lo dice la propia pantalla.
    const preparar = seccionDe(page.getByRole("heading", { name: "Preparar para la familia" }));
    await expect(preparar.getByText("No es la receta multiplicada por personas")).toBeVisible();
    await expect(preparar.getByText("Vacuno asiento (bistec)")).toBeVisible();

    // Cambiar la comida del día recalcula para esa comida.
    await page.getByRole("link", { name: "Cena", exact: true }).click();
    await expect(page).toHaveURL(/meal=DINNER/);
    await expect(page.getByRole("heading", { name: "Porciones para mi familia" })).toBeVisible();
  });
});
