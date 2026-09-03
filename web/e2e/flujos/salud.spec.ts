/**
 * E2E §21 — SALUD: subir → extracción de candidatos → revisión humana →
 * confirmación → observación → reglas clínicas → impacto visible.
 *
 * Todo con un examen SINTÉTICO generado acá mismo: valores inventados, un
 * laboratorio que no existe y una "persona de prueba" ficticia. Jamás un
 * documento real.
 *
 * Lo que este archivo afirma del producto (ADR 0012):
 *  · AI NEVER OVERRIDES CLINICAL RULES: lo extraído es una PROPUESTA que no
 *    afecta nada hasta que una persona confirma fila por fila.
 *  · UNKNOWN NEVER MEANS NORMAL: una fila sin biomarcador ni unidad se marca
 *    "revisar", la unidad queda "desconocida" y "Confirmar todo" se niega.
 *  · La extracción de v1 es un parser determinista de texto (no un modelo):
 *    con PDF/imagen el resultado es FAILED honesto, no un OCR improvisado.
 *  · Sin consentimiento nada se extrae; el documento igual se guarda.
 *  · Confirmar un examen dispara una REVISIÓN DE IMPACTO que una persona
 *    resuelve; nada se aplica solo.
 *  · Las reglas clínicas hablan de NUESTROS DATOS (confianza, vigencia), nunca
 *    de la salud de nadie, y no inventan frecuencias ("cada 3 meses").
 *
 * Serial a propósito: cada paso depende del anterior (el documento que se
 * revisa es el que se subió). Si uno cae, los siguientes no tienen sentido.
 */
import type { Page } from "@playwright/test";
import { test, expect, recargar, HAY_STAGING } from "../fixtures/contrato";
import { admin, hogarDe, idDeUsuario } from "../fixtures/admin";

test.describe.configure({ mode: "serial" });

/**
 * Guardián propio de NOT_RUN, además del de contrato.ts.
 *
 * Defecto medido sin staging: `test.beforeEach` vive en el TOPE de contrato.ts
 * y se registra al IMPORTAR el módulo. Con `workers: 1` el worker carga varios
 * archivos y el módulo queda en caché, así que el hook solo se engancha al
 * primer archivo; en los siguientes el fixture `comoA` corre ANTES de
 * cualquier salto y revienta con "Faltan E2E_USER_A_EMAIL" — un FAILED que no
 * es un defecto de la app. Registrado acá, el hook pertenece a ESTE archivo.
 */
test.beforeEach(() => {
  test.skip(!HAY_STAGING, "Sin E2E_BASE_URL: no hay staging. Estado: NOT_RUN.");
});

const BUCKET = "medical-documents";
const FECHA_MUESTRA = "2026-08-01";
const LABORATORIO = "Laboratorio Sintético E2E (salud)";

/**
 * El examen sintético, en el formato que lee `extractFromText`
 * (`Etiqueta: valor unidad (rango) [fecha]`). Tres filas a propósito:
 *  · dos reconocibles y completas → candidatos con confianza 90 % ("lista");
 *  · una con un marcador que NO existe en el catálogo y SIN unidad → candidato
 *    dudoso ("revisar: biomarcador, unidad"), que es lo que obliga a la
 *    revisión humana y deja el documento en NEEDS_REVIEW.
 * Las líneas con `#` y las que no son resultados se ignoran.
 */
const CONTENIDO_EXAMEN = [
  "# EXAMEN SINTÉTICO PARA PRUEBAS AUTOMÁTICAS — valores inventados, no corresponde a ninguna persona real",
  "Paciente: PERSONA DE PRUEBA (ficticia)",
  `Creatinina: 1.2 mg/dL (0.7-1.3) [${FECHA_MUESTRA}]`,
  `Potasio: 4.4 mmol/L (3.5-5.1) [${FECHA_MUESTRA}]`,
  "Marcador Inventado ZZ: 7 (1-9)",
  "",
].join("\n");

/** Un PDF mínimo y válido, sin texto: sirve solo para probar el FAILED honesto. */
const PDF_SINTETICO = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n" +
    "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1",
);

interface Ficha {
  id: string;
  nombre: string;
  hogar: string;
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
  if (error) throw new Error(`ficha de ${u}: ${error.message}`);
  if (!data) throw new Error(`El usuario ${u} no tiene ficha activa en su hogar de staging.`);
  return { id: data.id as string, nombre: data.display_name as string, hogar };
}

/**
 * Deja el módulo de salud de un integrante SINTÉTICO vacío: impactos,
 * observaciones, documentos (los candidatos caen en cascada, 0026) y los
 * archivos del bucket privado bajo `member/{id}/`.
 *
 * Se borra en vez de archivar porque un E2E que corre cuatro veces (cuatro
 * anchos) acumularía documentos y "Exámenes recientes" solo muestra ocho: las
 * aserciones dejarían de ver el suyo. La historia clínica es evidencia EN LA
 * BASE DE LA FAMILIA; este es el hogar sintético de staging y la llave es la
 * de `admin.ts`, que se niega a apuntar a producción. La auditoría
 * (`audit_events`) y los eventos de nutrición se dejan: son historia.
 */
async function limpiarSalud(memberId: string): Promise<void> {
  const db = admin();
  const borrar = async (tabla: string) => {
    const { error } = await db.from(tabla).delete().eq("member_id", memberId);
    if (error) throw new Error(`${tabla}: ${error.message}`);
  };
  await borrar("clinical_impact_reviews");
  await borrar("lab_observations");
  await borrar("lab_documents");

  const carpeta = `member/${memberId}`;
  const { data: objetos, error } = await db.storage.from(BUCKET).list(carpeta);
  if (error) throw new Error(`storage list ${carpeta}: ${error.message}`);
  const rutas = (objetos ?? []).map((o) => `${carpeta}/${o.name}`);
  if (rutas.length > 0) {
    const { error: errorBorrado } = await db.storage.from(BUCKET).remove(rutas);
    if (errorBorrado) throw new Error(`storage remove: ${errorBorrado.message}`);
  }
}

/**
 * Sube un examen POR LA INTERFAZ (§53) y devuelve el id del documento que la
 * app puso en la URL de revisión. Todo por rol y etiqueta visible.
 */
async function subirExamen(
  page: Page,
  opciones: {
    nombre: string;
    archivo: { name: string; mimeType: string; buffer: Buffer };
    laboratorio: string;
    consentir: boolean;
  },
): Promise<string> {
  await page.goto("/health/exams/upload");
  await expect(page.getByRole("heading", { name: "Subir examen", exact: true })).toBeVisible();
  await page.getByLabel("¿De quién es el examen?").selectOption({ label: opciones.nombre });
  await page.getByLabel("Fecha del examen").fill(FECHA_MUESTRA);
  await page.getByLabel(/^Laboratorio/).fill(opciones.laboratorio);
  await page.getByLabel(/^Archivo/).setInputFiles(opciones.archivo);
  if (opciones.consentir) await page.getByLabel(/Consiento/).check();
  await page.getByRole("button", { name: "Subir examen", exact: true }).click();

  // Subir + consentir + extraer son tres acciones de servidor encadenadas: se
  // les da más que los 10 s por defecto antes de declarar que no llegó.
  await expect(page).toHaveURL(/\/health\/exams\/[0-9a-f-]{36}\/review/, { timeout: 30_000 });
  const m = page.url().match(/\/health\/exams\/([0-9a-f-]{36})\/review/);
  if (!m?.[1]) throw new Error(`La app no llevó a la revisión de un documento: ${page.url()}`);
  return m[1];
}

/** La tarjeta de UNA fila extraída, ubicada por su etiqueta cruda (el `<p>` del encabezado). */
function filaExtraida(page: Page, etiqueta: string) {
  // No se filtra por `hasText`: cada tarjeta trae un <select> con TODO el
  // catálogo de biomarcadores, así que "Creatinina" aparece en todas.
  return page
    .getByRole("article")
    .filter({ has: page.locator("p", { hasText: new RegExp(`^${etiqueta}$`) }) });
}

let A: Ficha;
let documentoId: string;

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar
  A = await fichaDe("A");
  await limpiarSalud(A.id);
});

test.afterAll(async () => {
  if (!HAY_STAGING || !A) return;
  await limpiarSalud(A.id);
});

test.describe("§21.a — subir un examen sintético con consentimiento: la extracción PROPONE", () => {
  test("el documento queda por revisar, con sus candidatos y su confianza honesta", async ({
    comoA: page,
  }) => {
    documentoId = await subirExamen(page, {
      nombre: A.nombre,
      archivo: {
        name: "examen-sintetico.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(CONTENIDO_EXAMEN, "utf8"),
      },
      laboratorio: LABORATORIO,
      consentir: true,
    });

    // Regla 4 del contrato: lo que cuenta es lo persistido, no el estado de React.
    await recargar(page);
    const main = page.getByRole("main");
    await expect(page.getByRole("heading", { name: "Revisión del examen" })).toBeVisible();
    await expect(main).toContainText(LABORATORIO);

    // Una fila dudosa deja el documento entero en NEEDS_REVIEW ("por revisar").
    await expect(page.getByText("por revisar", { exact: true })).toBeVisible();
    // La app dice con qué se extrajo: v1 es un parser de texto, no un modelo.
    await expect(main).toContainText("Extractor: demo-parser/1.0.0");
    // Contrato §10: es una propuesta, no afecta decisiones hasta confirmar.
    await expect(main).toContainText("no afecta reglas, comidas ni compras");

    const creatinina = filaExtraida(page, "Creatinina");
    await expect(creatinina).toContainText("confianza 90%");
    await expect(creatinina).toContainText("lista");
    await expect(creatinina.getByLabel("Valor")).toHaveValue("1.2");
    await expect(creatinina.getByLabel("Unidad")).toHaveValue("mg/dL");
    await expect(creatinina).toContainText("0.7-1.3");

    const potasio = filaExtraida(page, "Potasio");
    await expect(potasio).toContainText("confianza 90%");
    await expect(potasio.getByLabel("Unidad")).toHaveValue("mmol/L");

    // UNKNOWN NEVER MEANS NORMAL: sin biomarcador ni unidad, la fila lo dice y
    // la unidad queda "desconocida" — nunca se rellena con la del catálogo.
    const inventado = filaExtraida(page, "Marcador Inventado ZZ");
    await expect(inventado).toContainText("confianza 30%");
    await expect(inventado).toContainText("revisar: biomarcador, unidad");
    await expect(inventado.getByLabel("Unidad")).toHaveValue("");
    await expect(inventado.getByLabel("Unidad")).toHaveAttribute("placeholder", "desconocida");
    await expect(inventado.getByLabel("Biomarcador")).toHaveValue("");

    // Mientras haya una fila sin forma válida, "Confirmar todo" se niega y lo dice.
    await expect(
      page.getByRole("button", { name: /Faltan datos en alguna fila para confirmar todo/ }),
    ).toBeDisabled();
  });

  test("el tablero de Salud lo lista en 'Datos por revisar', no como dato confirmado", async ({
    comoA: page,
  }) => {
    await page.goto("/health");
    const main = page.getByRole("main");
    await expect(page.getByRole("heading", { name: "Datos por revisar" })).toBeVisible();
    await expect(main).toContainText(
      "Lo extraído por IA no afecta ninguna decisión hasta que una persona lo confirme.",
    );
    const enRevision = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Datos por revisar" }),
    });
    await expect(enRevision).toContainText(LABORATORIO);
    await expect(enRevision).toContainText("revisar");
    // Todavía no hay impacto: nada se confirmó.
    await expect(main).not.toContainText("revisión de impacto pendiente");
  });
});

test.describe("§21.b — revisión humana: descartar lo dudoso, confirmar lo válido", () => {
  test("solo lo confirmado se vuelve observación; el documento queda CONFIRMADO", async ({
    comoA: page,
  }) => {
    await page.goto(`/health/exams/${documentoId}/review`);
    const inventado = filaExtraida(page, "Marcador Inventado ZZ");
    await inventado.getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(inventado).toContainText("descartada");
    await expect(inventado.getByRole("button", { name: "Recuperar" })).toBeVisible();

    // Con la dudosa descartada, las dos restantes tienen forma válida.
    const confirmarTodo = page.getByRole("button", { name: "Confirmar todo", exact: true });
    await expect(confirmarTodo).toBeEnabled();
    await confirmarTodo.click();
    await expect(
      page.getByText("No quedan filas pendientes de revisión en este examen."),
    ).toBeVisible();

    await recargar(page);
    await expect(page.getByText("confirmado", { exact: true })).toBeVisible();
    const confirmadas = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Confirmadas de este examen" }),
    });
    await expect(confirmadas).toContainText("1.2");
    await expect(confirmadas).toContainText("mg/dL");
    await expect(confirmadas).toContainText("4.4");
    await expect(confirmadas).toContainText("mmol/L");
    // El rango que se guarda es el IMPRESO por el laboratorio, no uno "general".
    await expect(confirmadas).toContainText("0.7-1.3");
    // Lo descartado no existe como observación.
    await expect(confirmadas).not.toContainText("Marcador Inventado ZZ");
    await expect(
      page.getByText("No quedan filas pendientes de revisión en este examen."),
    ).toBeVisible();
  });
});

test.describe("§21.c — la observación confirmada vive en la ficha y en el historial", () => {
  test("la ficha muestra el valor con su unidad y NO inventa una frecuencia", async ({
    comoA: page,
  }) => {
    await page.goto("/health");
    // La tarjeta de la persona lleva a su ficha (ruta estable, no un id generado).
    await page.locator(`a[href="/health/member/${A.id}"]`).click();
    await expect(page.getByRole("heading", { name: A.nombre, exact: true })).toBeVisible();

    const tarjeta = page.locator(`a[href="/health/member/${A.id}/biomarker/creatinine"]`);
    await expect(tarjeta).toContainText("Creatinina");
    await expect(tarjeta).toContainText("1.2 mg/dL");
    // Regla §14: la app JAMÁS inventa "cada 3 meses". Sin frecuencia
    // configurada, la vigencia lo dice tal cual.
    await expect(tarjeta).toContainText("sin frecuencia configurada");
    await expect(page.locator(`a[href="/health/member/${A.id}/biomarker/potassium"]`)).toContainText(
      "4.4 mmol/L",
    );
    await expect(page.getByRole("main")).toContainText("La app no inventa");

    // El examen aparece en la ficha como confirmado.
    const examenes = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Exámenes", exact: true }),
    });
    await expect(examenes).toContainText(LABORATORIO);
    await expect(examenes).toContainText("confirmado");
  });

  test("el historial del biomarcador es descriptivo: fecha, valor, unidad, rango impreso", async ({
    comoA: page,
  }) => {
    await page.goto(`/health/member/${A.id}`);
    await page.locator(`a[href="/health/member/${A.id}/biomarker/creatinine"]`).click();
    await expect(page.getByRole("heading", { name: "Creatinina", exact: true })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main).toContainText("Serie en mg/dL");
    await expect(main).toContainText(`${FECHA_MUESTRA} · 1.2 mg/dL`);
    await expect(main).toContainText("0.7-1.3");
    await expect(main).toContainText("confirmado");
    // Con una sola medición no hay tendencia, y se dice así — sin colores ni juicio.
    await expect(main).toContainText("muy pocas mediciones para hablar de tendencia");
    await expect(main).toContainText("describe números, no órganos");
  });
});

test.describe("§21.d — reglas clínicas e impacto: nada se aplica solo, una persona decide", () => {
  test("confirmar el examen dejó una revisión de impacto pendiente y bajó la confianza de los datos", async ({
    comoA: page,
  }) => {
    await page.goto("/health");
    const main = page.getByRole("main");
    await expect(main).toContainText("1 revisión de impacto pendiente");
    await expect(main).toContainText("nada se aplica solo");
    await page.getByRole("link", { name: /Nuevo examen confirmado/ }).click();
    await expect(page).toHaveURL(new RegExp(`/health/member/${A.id}$`));

    // NutritionDataConfidence (§17) habla de NUESTROS datos: con un impacto
    // sin resolver la confianza es "media" y la razón lo nombra.
    await expect(main).toContainText("Confianza de los datos");
    await expect(main).toContainText("confianza media");
    await expect(main).toContainText("1 revisión(es) de impacto clínico sin resolver.");
    await expect(main).toContainText("Impactos pendientes");
    await expect(main).toContainText("Nada se aplicó: revisa y decide.");
  });

  test("resolver el impacto es un acto humano; después la confianza vuelve a 'alta'", async ({
    comoA: page,
  }) => {
    await page.goto(`/health/member/${A.id}`);
    await page.getByRole("button", { name: "Marcar revisado" }).click();
    const main = page.getByRole("main");
    await expect(main).not.toContainText("Impactos pendientes");

    await recargar(page);
    await expect(main).not.toContainText("Impactos pendientes");
    await expect(main).toContainText("confianza alta");
    await expect(main).toContainText("Los datos requeridos están confirmados y vigentes.");

    await page.goto("/health");
    await expect(page.getByRole("main")).not.toContainText("revisión de impacto pendiente");
  });

  test.fixme(
    "el impacto llega al plan y a las compras (no existe en v1: sin UI para restricciones con fuente ni para aplicar el delta de compras)",
    async () => {
      // `createRestriction`/`setRestrictionStatus` solo los llama el asistente
      // (domain/assistant/tool.ts), no una pantalla; `apply_clinical_shopping_delta`
      // (0030) no tiene ningún llamador en web/. Sin restricción confirmada no hay
      // porción REVIEW_REQUIRED ni ajuste CLINICAL_ADJUSTMENT que mirar en /plan
      // o /shopping. Cuando exista la UI, este caso debe: crear una restricción
      // con fuente, confirmar una comida y ver "requiere revisión" en la semana
      // y el ajuste neutro en la lista de compras.
    },
  );
});

test.describe("§21.e — documento que el extractor no puede leer: FAILED honesto", () => {
  test("un PDF sintético con consentimiento queda 'no se pudo leer', sin OCR improvisado", async ({
    comoA: page,
  }) => {
    const idPdf = await subirExamen(page, {
      nombre: A.nombre,
      archivo: { name: "examen-sintetico.pdf", mimeType: "application/pdf", buffer: PDF_SINTETICO },
      laboratorio: `${LABORATORIO} PDF`,
      consentir: true,
    });
    // La app no esconde la diferencia: lleva a revisión diciendo que falló.
    await expect(page).toHaveURL(new RegExp(`/health/exams/${idPdf}/review\\?extraccion=fallida`));
    await expect(page.getByRole("main")).toContainText(
      "La extracción automática no pudo leer este documento.",
    );

    await recargar(page);
    await expect(page.getByText("no se pudo leer", { exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(
      page.getByText("No quedan filas pendientes de revisión en este examen."),
    ).toBeVisible();
  });

  test.fixme(
    "registrar los valores a mano cuando la extracción falló (no existe en v1: la pantalla lo promete pero no hay formulario ni acción)",
    async () => {
      // review/page.tsx dice "Puedes registrar los valores a mano", pero
      // `confirm_lab_extraction` solo trabaja sobre candidatos y no hay ninguna
      // acción que cree una observación sin candidato. Un documento FAILED (o
      // subido sin consentimiento) es un callejón sin salida.
    },
  );
});

test.describe("§21.f — sin consentimiento nada se extrae", () => {
  test("el examen se guarda igual, queda 'subido' y sin candidatos", async ({ comoA: page }) => {
    const idSinConsentimiento = await subirExamen(page, {
      nombre: A.nombre,
      archivo: {
        name: "examen-sintetico-sin-consentimiento.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(CONTENIDO_EXAMEN, "utf8"),
      },
      laboratorio: `${LABORATORIO} sin consentimiento`,
      consentir: false,
    });
    await expect(page).toHaveURL(new RegExp(`/health/exams/${idSinConsentimiento}/review$`));

    await recargar(page);
    await expect(page.getByText("subido", { exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);

    // No entra a "Datos por revisar": no hay nada extraído que revisar.
    await page.goto("/health");
    const enRevision = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Datos por revisar" }),
    });
    await expect(enRevision).toHaveCount(0);
    const recientes = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Exámenes recientes" }),
    });
    await expect(recientes).toContainText(`${LABORATORIO} sin consentimiento`);
    await expect(recientes).toContainText("subido");
  });
});
