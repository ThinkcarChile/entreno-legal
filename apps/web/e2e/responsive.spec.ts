import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * Revisión responsive, de consola y de accesibilidad básica.
 *
 * Es la prueba que sustituye a «lo miré en el móvil y se veía bien». Recorre
 * las páginas públicas en los siete anchos que importan y comprueba cosas que
 * un ojo humano no verifica de forma fiable: que nada desborde a lo ancho, que
 * no haya errores en consola, que ninguna petición se caiga, que el contenido
 * no quede debajo de la barra inferior y que los controles tengan nombre.
 *
 * No necesita Supabase: son páginas públicas. Por eso corre siempre.
 */

/** Los anchos del encargo: desde el móvil más estrecho que se sigue vendiendo. */
const VIEWPORTS = [
  { width: 320, height: 640, label: "320 · móvil estrecho" },
  { width: 375, height: 667, label: "375 · iPhone SE" },
  { width: 390, height: 844, label: "390 · iPhone moderno" },
  { width: 430, height: 932, label: "430 · iPhone grande" },
  { width: 768, height: 1024, label: "768 · tablet vertical" },
  { width: 1024, height: 768, label: "1024 · tablet horizontal" },
  { width: 1440, height: 900, label: "1440 · escritorio" },
] as const;

const ROUTES = [
  { path: "/", name: "portada" },
  { path: "/trabajos", name: "explorar" },
  { path: "/publicar", name: "publicar" },
  { path: "/entrar", name: "entrar" },
  { path: "/crear-cuenta", name: "crear-cuenta" },
  { path: "/como-funciona", name: "como-funciona" },
  { path: "/pago-protegido", name: "pago-protegido" },
  { path: "/precios", name: "precios" },
  { path: "/ayuda", name: "ayuda" },
  { path: "/trabajar", name: "trabajar" },
] as const;

/**
 * Ruido conocido del servidor de desarrollo.
 *
 * La lista es corta y explícita a propósito: si crece, deja de ser una prueba.
 */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /Failed to load resource.*favicon/i,
];

interface Recorder {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

function record(page: Page): Recorder {
  const recorder: Recorder = { consoleErrors: [], pageErrors: [], failedRequests: [] };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    // Solo los errores cuentan como fallo; los avisos de hidratación de React
    // llegan como `error`, así que quedan dentro.
    if (message.type() === "error") recorder.consoleErrors.push(text);
  });

  page.on("pageerror", (error) => recorder.pageErrors.push(error.message));

  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "desconocido";
    // Las cancelaciones al navegar no son fallos del servidor.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return;
    recorder.failedRequests.push(`${request.url()} — ${failure}`);
  });

  page.on("response", (response) => {
    if (response.status() >= 500) {
      recorder.failedRequests.push(`${response.url()} — HTTP ${response.status()}`);
    }
  });

  return recorder;
}

/** Ancho real del documento frente al de la ventana, y quién se sale. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const viewport = window.innerWidth;
    // Una holgura de 1 px absorbe el redondeo de los navegadores.
    if (docWidth <= viewport + 1) return { docWidth, viewport, culprits: [] as string[] };

    const culprits: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= viewport + 1 && box.left >= -1) continue;
      const style = window.getComputedStyle(element);
      // Lo que está oculto o recortado a propósito no desborda nada.
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (style.position === "fixed" && style.pointerEvents === "none") continue;
      culprits.push(
        `<${element.tagName.toLowerCase()} class="${element.className}"> ` +
          `izq ${Math.round(box.left)} der ${Math.round(box.right)}`,
      );
      if (culprits.length >= 5) break;
    }
    return { docWidth, viewport, culprits };
  });
}

test.describe("diseño responsive", () => {
  for (const route of ROUTES) {
    test(`${route.name} se ve entera en los siete anchos`, async ({ page }) => {
      const recorder = record(page);
      await page.goto(route.path, { waitUntil: "networkidle" });

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        // Un fotograma para que el layout se asiente antes de medir.
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
        );

        const result = await overflow(page);
        expect(
          result.culprits,
          `${route.path} a ${viewport.label}: el documento mide ${result.docWidth}px ` +
            `en una ventana de ${result.viewport}px`,
        ).toEqual([]);
      }

      expect(recorder.pageErrors, `${route.path}: errores de JavaScript`).toEqual([]);
      expect(recorder.consoleErrors, `${route.path}: errores de consola`).toEqual([]);
      expect(recorder.failedRequests, `${route.path}: peticiones caídas`).toEqual([]);
    });
  }
});

test.describe("accesibilidad básica", () => {
  for (const route of ROUTES) {
    test(`${route.name} tiene estructura y nombres accesibles`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(route.path, { waitUntil: "networkidle" });

      // Idioma declarado: sin esto, un lector de pantalla lee español con
      // fonética inglesa y no se entiende nada.
      await expect(page.locator("html")).toHaveAttribute("lang", /^es/);

      const audit = await page.evaluate(() => {
        const problems: string[] = [];

        const h1 = document.querySelectorAll("h1");
        if (h1.length !== 1) problems.push(`hay ${h1.length} <h1>, debe haber exactamente uno`);

        if (!document.querySelector("main")) problems.push("falta el <main>");

        for (const img of Array.from(document.images)) {
          if (img.getAttribute("alt") === null) {
            problems.push(`imagen sin alt: ${img.currentSrc || img.src}`);
          }
        }

        function accessibleName(element: Element): string {
          const label =
            element.getAttribute("aria-label") ??
            (element.getAttribute("aria-labelledby")
              ? (document.getElementById(element.getAttribute("aria-labelledby") ?? "")
                  ?.textContent ?? "")
              : "");
          const own = (element.textContent ?? "").trim();
          const title = element.getAttribute("title") ?? "";
          const alt = element.querySelector("img[alt]")?.getAttribute("alt") ?? "";
          return `${label} ${own} ${title} ${alt}`.trim();
        }

        for (const element of Array.from(document.querySelectorAll("a[href], button"))) {
          if ((element as HTMLElement).offsetParent === null) continue;
          if (element.getAttribute("aria-hidden") === "true") continue;
          if (!accessibleName(element)) {
            problems.push(`control sin nombre: <${element.tagName.toLowerCase()}>`);
          }
        }

        for (const element of Array.from(
          document.querySelectorAll<HTMLElement>("input, select, textarea"),
        )) {
          if (element.offsetParent === null) continue;
          if ((element as HTMLInputElement).type === "hidden") continue;
          const id = element.id;
          const labelled =
            element.getAttribute("aria-label") ??
            element.getAttribute("aria-labelledby") ??
            (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null) ??
            element.closest("label");
          if (!labelled) {
            problems.push(`campo sin etiqueta: <${element.tagName.toLowerCase()}> #${id || "?"}`);
          }
        }

        // Un `tabindex` positivo rompe el orden natural del teclado.
        for (const element of Array.from(document.querySelectorAll("[tabindex]"))) {
          const value = Number(element.getAttribute("tabindex"));
          if (value > 0) problems.push(`tabindex positivo (${value})`);
        }

        return problems;
      });

      expect(audit, `${route.path}: problemas de accesibilidad`).toEqual([]);
    });
  }
});

test.describe("barra inferior de móvil", () => {
  test("no tapa el final de la página ni aparece en escritorio", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });

    const bar = page.getByRole("navigation", { name: "Navegación principal" });
    await expect(bar).toBeVisible();

    // El último enlace del pie tiene que quedar por encima de la barra.
    //
    // `behavior: "instant"` porque la hoja de estilos pide desplazamiento
    // suave: con el valor por defecto se mide a mitad de la animación y la
    // prueba falla o pasa según lo rápido que vaya la máquina.
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    );

    const overlap = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Navegación principal"]');
      const footer = document.querySelector("footer");
      if (!nav || !footer) return "falta la barra o el pie";
      const navBox = nav.getBoundingClientRect();
      const last = footer.querySelectorAll("a, p");
      const lastBox = last[last.length - 1]?.getBoundingClientRect();
      if (!lastBox) return "el pie no tiene contenido";
      return lastBox.bottom <= navBox.top + 1
        ? null
        : `el pie llega a ${Math.round(lastBox.bottom)} y la barra empieza en ${Math.round(navBox.top)}`;
    });
    expect(overlap).toBeNull();

    // En escritorio la navegación vive en la cabecera y la barra desaparece.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(bar).toBeHidden();
  });

  test("el menú de móvil se abre, se cierra con Escape y devuelve el foco", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });

    const trigger = page.getByRole("button", { name: "Abrir el menú" });
    await trigger.click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe("capturas", () => {
  test("escritorio y móvil de las pantallas públicas", async ({ page }, testInfo) => {
    for (const route of ROUTES) {
      for (const size of [
        { width: 390, height: 844, tag: "movil" },
        { width: 1440, height: 900, tag: "escritorio" },
      ]) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(route.path, { waitUntil: "networkidle" });
        const shot = await page.screenshot({ fullPage: true });
        await testInfo.attach(`${route.name}-${size.tag}`, {
          body: shot,
          contentType: "image/png",
        });
      }
    }
  });
});
