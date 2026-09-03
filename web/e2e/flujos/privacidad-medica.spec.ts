/**
 * E2E §22 — PRIVACIDAD MÉDICA dentro del MISMO hogar.
 *
 * A y B viven en el mismo hogar sintético. B sube un examen; A intenta leerlo
 * por TODAS las puertas que la app tiene: la lista de /health, la URL directa
 * de la ficha, de la revisión y del historial, y la descarga del archivo por
 * URL firmada. Después B otorga un permiso, A lee según el alcance de ese
 * permiso, B lo revoca y A vuelve a quedar afuera.
 *
 * Lo que este archivo afirma del producto (ADR 0012 §2, 0026, 0034):
 *  · Los roles del hogar NO dan acceso médico: ni el ADMIN ve la ficha de una
 *    persona con cuenta. Solo self, grant vivo, o tutor de alguien SIN cuenta.
 *  · SIN ORÁCULO: para quien no tiene permiso, "no existe" y "no es tuyo" se
 *    responden IGUAL. Se compara la respuesta completa (ruta final, alertas,
 *    si aparece el nombre del examen) y se exige que sea idéntica.
 *  · ERROR != VACÍO: la denegación se prueba contra un documento que SÍ existe
 *    y que su dueña sí puede abrir y bajar en el mismo test.
 *  · El archivo y su ficha tienen UNA puerta (READ_LABS): si la fila no se ve,
 *    el archivo tampoco se firma ni se baja (0034).
 *  · El alcance del permiso es el que se otorgó: READ_LABS deja mirar; no deja
 *    confirmar, ni subir por la otra persona, ni declarar condiciones, ni ver
 *    quién más tiene acceso.
 *  · Revocar termina el acceso AHORA, en todas las puertas a la vez.
 *
 * LO QUE NO EXISTE EN v1 (queda como `test.fixme`, no se simula):
 *  · No hay pantalla para otorgar ni revocar un permiso médico. `grantAccess`
 *    y `revokeAccess` (app/health/actions.ts) solo los llama la herramienta
 *    del asistente. Acá el permiso se otorga y se revoca con los RPC reales
 *    (`grant_medical_access` / `revoke_medical_access`) usando la SESIÓN DE B
 *    —llave anónima + su contraseña—, que es exactamente lo que haría la
 *    tarjeta del asistente. No es service_role: esa llave vive solo en admin.ts.
 *  · No hay botón de descarga: `getExamSignedUrl` no tiene ningún llamador.
 *    La descarga se prueba con la misma sesión de A contra el bucket, porque
 *    la política de storage es la garantía que el contrato pide verificar y
 *    ninguna pantalla la ejercita.
 *
 * Serial a propósito: el documento de B se sube en el primer caso y los demás
 * dependen de él.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test, expect, recargar, credenciales, ENV, HAY_STAGING } from "../fixtures/contrato";
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
/**
 * Marca que va DENTRO del archivo: al bajarlo por URL firmada se verifica que
 * lo que llegó es este examen y no una página de error con estado 200.
 */
const MARCA = "EXAMEN SINTÉTICO PARA PRUEBAS AUTOMÁTICAS (privacidad)";
/**
 * Nombre de laboratorio único por corrida: la aserción "A no ve el examen de
 * B" busca ESTE texto, y un nombre fijo podría coincidir con basura de una
 * corrida anterior que quedó a medias.
 */
const LAB_B = `Laboratorio Sintético E2E privacidad ${randomUUID().slice(0, 8)}`;

/**
 * Examen sintético de B, en el formato que lee `extractFromText`. Una fila
 * reconocible (Creatinina) y una dudosa sin unidad, para que el documento
 * quede NEEDS_REVIEW con filas PENDIENTES: así se puede probar que A, con
 * permiso de LECTURA, ve la revisión pero NO puede confirmar.
 */
const CONTENIDO_EXAMEN_B = [
  `# ${MARCA} — valores inventados, no corresponde a ninguna persona real`,
  "Paciente: PERSONA DE PRUEBA B (ficticia)",
  `Creatinina: 0.9 mg/dL (0.7-1.3) [${FECHA_MUESTRA}]`,
  "Marcador Inventado QQ: 3 (1-5)",
  "",
].join("\n");

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
 * Deja el módulo de salud de un integrante SINTÉTICO vacío (impactos,
 * observaciones, documentos y archivos del bucket) y sin permisos vivos ni
 * revocados entre B y A. Se borra en vez de archivar porque cuatro anchos de
 * pantalla corren este archivo cuatro veces y "Exámenes recientes" muestra
 * ocho: acumular haría que las aserciones dejen de ver su propio documento.
 * Es el hogar sintético de staging con la llave de admin.ts, que se niega a
 * apuntar a producción. La auditoría (`audit_events`) se deja: es historia.
 */
async function limpiarSalud(dueno: Ficha, receptor: Ficha): Promise<void> {
  const db = admin();
  const borrarPorMiembro = async (tabla: string) => {
    const { error } = await db.from(tabla).delete().eq("member_id", dueno.id);
    if (error) throw new Error(`${tabla}: ${error.message}`);
  };
  await borrarPorMiembro("clinical_impact_reviews");
  await borrarPorMiembro("lab_observations");
  await borrarPorMiembro("lab_documents");

  const { error: errorGrants } = await db
    .from("medical_data_grants")
    .delete()
    .eq("owner_member_id", dueno.id)
    .eq("grantee_member_id", receptor.id);
  if (errorGrants) throw new Error(`medical_data_grants: ${errorGrants.message}`);

  const carpeta = `member/${dueno.id}`;
  const { data: objetos, error } = await db.storage.from(BUCKET).list(carpeta);
  if (error) throw new Error(`storage list ${carpeta}: ${error.message}`);
  const rutas = (objetos ?? []).map((o) => `${carpeta}/${o.name}`);
  if (rutas.length > 0) {
    const { error: errorBorrado } = await db.storage.from(BUCKET).remove(rutas);
    if (errorBorrado) throw new Error(`storage remove: ${errorBorrado.message}`);
  }
}

/**
 * Sesión de supabase-js con la llave ANÓNIMA y la contraseña del usuario
 * sintético, desde el proceso de Playwright. Es la misma sesión que tiene el
 * navegador (la llave anónima viaja a todo cliente por diseño), con la RLS y
 * las políticas del bucket vigentes; NO es service_role. Se usa solo para lo
 * que ninguna pantalla expone hoy: otorgar/revocar el permiso y pedir la URL
 * firmada. Ver el encabezado del archivo.
 */
async function sesionDirecta(u: "A" | "B"): Promise<SupabaseClient> {
  const url = process.env[ENV.supabaseUrl];
  const anon = process.env[ENV.anonKey];
  if (!url || !anon) throw new Error("Faltan E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY.");
  const cliente = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await cliente.auth.signInWithPassword(credenciales(u));
  if (error) throw new Error(`No se pudo abrir sesión directa como ${u}: ${error.message}`);
  return cliente;
}

/**
 * Intenta FIRMAR y BAJAR una ruta del bucket médico con una sesión. Devuelve
 * la respuesta como texto comparable: la prueba de "sin oráculo" exige que la
 * ruta de un examen ajeno y una ruta inventada den EXACTAMENTE lo mismo.
 */
async function intentarDescarga(
  db: SupabaseClient,
  ruta: string,
): Promise<{ firma: string; bajada: string; url: string | null }> {
  const firma = await db.storage.from(BUCKET).createSignedUrl(ruta, 60);
  const bajada = await db.storage.from(BUCKET).download(ruta);
  return {
    firma: firma.error ? `ERROR: ${firma.error.message}` : "OK",
    bajada: bajada.error ? `ERROR: ${bajada.error.message}` : "OK",
    url: firma.data?.signedUrl ?? null,
  };
}

/** Un nombre visible como regex EXACTA: los nombres sintéticos pueden traer paréntesis o puntos. */
function exacto(texto: string): RegExp {
  return new RegExp(`^${texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/**
 * Lo que una persona VE al ir a una URL del módulo de salud: ruta final,
 * cuántas alertas hay y si aparece el nombre del examen de B. Se compara
 * entero entre "documento ajeno" y "documento inexistente". Se lee `body` y
 * no `main` para que una respuesta inesperada sin `<main>` (un 404) falle con
 * la comparación y no colgándose a la espera del elemento.
 */
async function respuestaDe(
  page: Page,
  destino: string,
): Promise<{ ruta: string; alertas: number; nombraElExamen: boolean; nombraAB: boolean }> {
  await page.goto(destino);
  await page.waitForLoadState("networkidle");
  const texto = (await page.locator("body").textContent()) ?? "";
  return {
    ruta: new URL(page.url()).pathname,
    alertas: await page.getByRole("alert").count(),
    nombraElExamen: texto.includes(LAB_B),
    nombraAB: texto.includes(B.nombre),
  };
}

/**
 * Sube un examen POR LA INTERFAZ (§53) y devuelve el id del documento que la
 * app puso en la URL de revisión. Todo por rol y etiqueta visible.
 */
async function subirExamen(page: Page, nombre: string): Promise<string> {
  await page.goto("/health/exams/upload");
  await expect(page.getByRole("heading", { name: "Subir examen", exact: true })).toBeVisible();
  await page.getByLabel("¿De quién es el examen?").selectOption({ label: nombre });
  await page.getByLabel("Fecha del examen").fill(FECHA_MUESTRA);
  await page.getByLabel(/^Laboratorio/).fill(LAB_B);
  await page.getByLabel(/^Archivo/).setInputFiles({
    name: "examen-sintetico-b.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(CONTENIDO_EXAMEN_B, "utf8"),
  });
  await page.getByLabel(/Consiento/).check();
  await page.getByRole("button", { name: "Subir examen", exact: true }).click();

  // Subir + consentir + extraer son tres acciones de servidor encadenadas: se
  // les da más que los 10 s por defecto antes de declarar que no llegó.
  await expect(page).toHaveURL(/\/health\/exams\/[0-9a-f-]{36}\/review/, { timeout: 30_000 });
  const m = page.url().match(/\/health\/exams\/([0-9a-f-]{36})\/review/);
  if (!m?.[1]) throw new Error(`La app no llevó a la revisión de un documento: ${page.url()}`);
  return m[1];
}

/** ¿Este integrante tiene un rol con `is_admin` en su hogar? */
async function esAdmin(memberId: string): Promise<boolean> {
  const { data, error } = await admin()
    .from("member_role_assignments")
    .select("household_roles ( is_admin )")
    .eq("member_id", memberId);
  if (error) throw new Error(`roles de ${memberId}: ${error.message}`);
  const filas: { household_roles: { is_admin: boolean } | { is_admin: boolean }[] | null }[] =
    data ?? [];
  return filas.some((f) => {
    const rol = f.household_roles;
    return Array.isArray(rol) ? rol.some((r) => r.is_admin) : rol?.is_admin === true;
  });
}

let A: Ficha;
let B: Ficha;
let documentoB: string;
let rutaArchivoB: string;
let grantId: string;
/** Un uuid con forma válida que no pertenece a nadie: el "no existe" del oráculo. */
const INEXISTENTE = randomUUID();

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar
  [A, B] = await Promise.all([fichaDe("A"), fichaDe("B")]);
  if (A.hogar !== B.hogar) {
    throw new Error("Staging mal configurado: A y B deben compartir hogar para probar §22.");
  }
  if (A.nombre === B.nombre) {
    throw new Error(
      "Staging mal configurado: A y B tienen el mismo nombre visible y las aserciones no podrían distinguirlos.",
    );
  }
  await limpiarSalud(B, A);
});

test.afterAll(async () => {
  if (!HAY_STAGING || !A || !B) return;
  await limpiarSalud(B, A);
});

test.describe("§22.a — preparación: B sube su examen sintético y lo ve", () => {
  test("B ve su propio examen en revisión; queda registrado con su archivo", async ({
    comoB: page,
  }) => {
    documentoB = await subirExamen(page, B.nombre);
    await recargar(page);
    await expect(page.getByRole("heading", { name: "Revisión del examen" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(LAB_B);
    // Una fila dudosa deja el documento con pendientes: es lo que §22.d usa.
    await expect(page.getByText("por revisar", { exact: true })).toBeVisible();

    const { data, error } = await admin()
      .from("lab_documents")
      .select("storage_path")
      .eq("id", documentoB)
      .single();
    if (error) throw new Error(`storage_path del documento de B: ${error.message}`);
    if (typeof data.storage_path !== "string" || !data.storage_path.startsWith(`member/${B.id}/`)) {
      throw new Error(`El documento de B no quedó bajo member/${B.id}/: ${String(data.storage_path)}`);
    }
    rutaArchivoB = data.storage_path;
  });
});

test.describe("§22.b — sin permiso: A no ve nada de B, por ninguna puerta", () => {
  test("la lista: /health de A no nombra a B ni a su examen", async ({ comoA: page }) => {
    await page.goto("/health");
    await expect(page.getByRole("heading", { name: "Salud", exact: true })).toBeVisible();

    const personas = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Personas", exact: true }),
    });
    await expect(personas.getByText(A.nombre, { exact: true })).toBeVisible();
    await expect(personas.getByText(B.nombre, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("main")).not.toContainText(LAB_B);

    // El producto lo dice en la misma pantalla: los roles no abren datos médicos.
    await expect(page.getByRole("main")).toContainText("dan acceso a datos médicos");
  });

  test("URL directa: el examen de B y un examen inexistente se responden IGUAL (sin oráculo)", async ({
    comoA: page,
  }) => {
    const ajeno = await respuestaDe(page, `/health/exams/${documentoB}/review`);
    const inexistente = await respuestaDe(page, `/health/exams/${INEXISTENTE}/review`);
    expect(ajeno.ruta).toBe("/health");
    expect(ajeno.nombraElExamen).toBe(false);
    expect(ajeno).toEqual(inexistente);
  });

  test("URL directa: la ficha de B y el historial de B se responden igual que una ficha inexistente", async ({
    comoA: page,
  }) => {
    const fichaAjena = await respuestaDe(page, `/health/member/${B.id}`);
    const fichaInexistente = await respuestaDe(page, `/health/member/${INEXISTENTE}`);
    expect(fichaAjena.ruta).toBe("/health");
    expect(fichaAjena.nombraAB).toBe(false);
    expect(fichaAjena).toEqual(fichaInexistente);

    const historialAjeno = await respuestaDe(page, `/health/member/${B.id}/biomarker/creatinine`);
    const historialInexistente = await respuestaDe(
      page,
      `/health/member/${INEXISTENTE}/biomarker/creatinine`,
    );
    expect(historialAjeno.ruta).toBe("/health");
    expect(historialAjeno).toEqual(historialInexistente);
  });

  test("descarga: A no firma ni baja el archivo de B, y la respuesta es la misma que para un archivo inventado", async () => {
    const comoA = await sesionDirecta("A");
    const real = await intentarDescarga(comoA, rutaArchivoB);
    const inventadoDeB = await intentarDescarga(comoA, `member/${B.id}/${randomUUID()}.txt`);
    const inventadoDeNadie = await intentarDescarga(comoA, `member/${INEXISTENTE}/${randomUUID()}.txt`);

    expect(real.firma).toMatch(/^ERROR: /);
    expect(real.bajada).toMatch(/^ERROR: /);
    expect(real.url).toBeNull();
    expect({ firma: real.firma, bajada: real.bajada }).toEqual({
      firma: inventadoDeB.firma,
      bajada: inventadoDeB.bajada,
    });
    expect({ firma: real.firma, bajada: real.bajada }).toEqual({
      firma: inventadoDeNadie.firma,
      bajada: inventadoDeNadie.bajada,
    });

    // ERROR != VACÍO: el archivo existe y su dueña sí lo firma y lo baja.
    const comoB = await sesionDirecta("B");
    const propio = await intentarDescarga(comoB, rutaArchivoB);
    expect(propio).toEqual({ firma: "OK", bajada: "OK", url: expect.any(String) });
    const respuesta = await fetch(propio.url!);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.text()).toContain(MARCA);
  });

  test("otro hogar: AJENO tampoco llega al examen ni a la ficha de B", async ({
    comoAjeno: page,
  }) => {
    const examen = await respuestaDe(page, `/health/exams/${documentoB}/review`);
    expect(examen.ruta).toBe("/health");
    expect(examen.nombraElExamen).toBe(false);
    const ficha = await respuestaDe(page, `/health/member/${B.id}`);
    expect(ficha.ruta).toBe("/health");
    expect(ficha.nombraAB).toBe(false);
  });
});

test.describe("§22.c — el rol ADMIN del hogar no reemplaza el permiso médico", () => {
  test("quien administra el hogar no ve la ficha de una persona CON cuenta", async ({
    comoA,
    comoB,
  }) => {
    const [adminA, adminB] = await Promise.all([esAdmin(A.id), esAdmin(B.id)]);
    test.skip(
      !adminA && !adminB,
      "En staging ni A ni B administran el hogar: no se puede afirmar nada sobre ADMIN. NOT_RUN.",
    );
    // Si los dos administran, se prueba con A: basta uno para la afirmación.
    const page = adminA ? comoA : comoB;
    const quienAdministra = adminA ? A : B;
    const otro = adminA ? B : A;

    await page.goto("/health");
    const personas = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Personas", exact: true }),
    });
    await expect(personas.getByText(quienAdministra.nombre, { exact: true })).toBeVisible();
    await expect(personas.getByText(otro.nombre, { exact: true })).toHaveCount(0);

    const ficha = await respuestaDe(page, `/health/member/${otro.id}`);
    expect(ficha.ruta).toBe("/health");
    const inexistente = await respuestaDe(page, `/health/member/${INEXISTENTE}`);
    expect(ficha).toEqual(inexistente);

    if (adminA) {
      // El documento que existe es el de B: si A administra, tampoco lo abre.
      const examen = await respuestaDe(page, `/health/exams/${documentoB}/review`);
      expect(examen.ruta).toBe("/health");
      expect(examen.nombraElExamen).toBe(false);
    }
  });
});

test.describe("§22.d — con permiso READ_LABS otorgado por B: A lee según el alcance", () => {
  test.fixme(
    "B otorga el permiso desde la interfaz (no existe en v1: la ficha muestra 'Quién puede ver estos datos' pero no hay botón para conceder)",
    async () => {
      // grantAccess (app/health/actions.ts) solo lo llama la herramienta del
      // asistente (domain/assistant/tool.ts). Cuando exista la UI, este caso
      // debe: como B, abrir /health/member/{B}, elegir a A y el permiso
      // READ_LABS, conceder, recargar y ver a A listado en "Quién puede ver
      // estos datos".
    },
  );

  test("B concede READ_LABS (RPC real con su sesión) y A pasa a ver la ficha, el examen y el historial", async ({
    comoA: page,
  }) => {
    const comoB = await sesionDirecta("B");
    const { data, error } = await comoB.rpc("grant_medical_access", {
      p_owner_member: B.id,
      p_grantee_member: A.id,
      p_permission: "READ_LABS",
    });
    if (error) throw new Error(`grant_medical_access como B: ${error.message}`);
    if (typeof data !== "string") throw new Error(`grant_medical_access no devolvió un id: ${String(data)}`);
    grantId = data;

    await page.goto("/health");
    const personas = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Personas", exact: true }),
    });
    const tarjetaB = personas.locator(`a[href="/health/member/${B.id}"]`);
    await expect(tarjetaB).toContainText(B.nombre);
    await expect(tarjetaB).toContainText("acceso concedido");
    const recientes = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Exámenes recientes" }),
    });
    await expect(recientes).toContainText(LAB_B);

    await tarjetaB.click();
    await expect(page).toHaveURL(new RegExp(`/health/member/${B.id}$`));
    await expect(page.getByRole("heading", { name: B.nombre, exact: true })).toBeVisible();
    const examenes = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Exámenes", exact: true }),
    });
    await expect(examenes).toContainText(LAB_B);
    await expect(examenes).toContainText("por revisar");
    // Alcance: quien mira por permiso no administra la ficha ajena.
    await expect(page.getByRole("heading", { name: "Quién puede ver estos datos" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Declarar una condición" })).toHaveCount(0);

    await page.goto(`/health/exams/${documentoB}/review`);
    await expect(page.getByRole("heading", { name: "Revisión del examen" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(LAB_B);
    await expect(
      page.getByRole("article").filter({ has: page.locator("p", { hasText: /^Creatinina$/ }) }),
    ).toBeVisible();

    await page.goto(`/health/member/${B.id}/biomarker/creatinine`);
    await expect(page.getByRole("heading", { name: "Creatinina", exact: true })).toBeVisible();
  });

  test("el alcance es LEER: A no confirma las filas de B ni puede subir exámenes por B", async ({
    comoA: page,
  }) => {
    await page.goto(`/health/exams/${documentoB}/review`);
    const creatinina = page
      .getByRole("article")
      .filter({ has: page.locator("p", { hasText: /^Creatinina$/ }) });
    await creatinina.getByRole("button", { name: "Confirmar", exact: true }).click();
    // CONFIRM_LABS no está en el permiso: el servidor rebota y la app lo dice.
    await expect(page.getByRole("alert")).toContainText("no autorizado");

    // Regla 4: lo que cuenta es lo persistido. La fila sigue pendiente.
    await recargar(page);
    await expect(page.getByText("por revisar", { exact: true })).toBeVisible();
    await expect(creatinina).toBeVisible();
    await expect(page.getByRole("heading", { name: "Confirmadas de este examen" })).toHaveCount(0);

    await page.goto("/health/exams/upload");
    const selector = page.getByLabel("¿De quién es el examen?");
    await expect(selector.locator("option", { hasText: exacto(A.nombre) })).toHaveCount(1);
    await expect(selector.locator("option", { hasText: exacto(B.nombre) })).toHaveCount(0);
  });

  test("descarga con permiso: A firma y baja el archivo de B, y lo que baja es el examen", async () => {
    const comoA = await sesionDirecta("A");
    const conPermiso = await intentarDescarga(comoA, rutaArchivoB);
    expect(conPermiso).toEqual({ firma: "OK", bajada: "OK", url: expect.any(String) });
    const respuesta = await fetch(conPermiso.url!);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.text()).toContain(MARCA);
  });
});

test.describe("§22.e — revocar: A vuelve a DENEGADO en todas las puertas a la vez", () => {
  test.fixme(
    "B revoca el permiso desde la interfaz (no existe en v1: la lista 'Quién puede ver estos datos' no tiene botón de revocar)",
    async () => {
      // revokeAccess (app/health/actions.ts) solo lo llama la herramienta del
      // asistente. Cuando exista la UI, este caso debe: como B, abrir su ficha,
      // revocar el permiso de A, recargar y ver "Nadie más: solo tú".
    },
  );

  test("revocado por B (RPC real con su sesión): la lista, la URL directa y la descarga niegan igual que antes", async ({
    comoA: page,
  }) => {
    const comoB = await sesionDirecta("B");
    const { error } = await comoB.rpc("revoke_medical_access", { p_grant: grantId });
    if (error) throw new Error(`revoke_medical_access como B: ${error.message}`);

    await page.goto("/health");
    const personas = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Personas", exact: true }),
    });
    await expect(personas.getByText(A.nombre, { exact: true })).toBeVisible();
    await expect(personas.getByText(B.nombre, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("main")).not.toContainText(LAB_B);

    const examen = await respuestaDe(page, `/health/exams/${documentoB}/review`);
    const examenInexistente = await respuestaDe(page, `/health/exams/${INEXISTENTE}/review`);
    expect(examen.ruta).toBe("/health");
    expect(examen.nombraElExamen).toBe(false);
    expect(examen).toEqual(examenInexistente);

    const ficha = await respuestaDe(page, `/health/member/${B.id}`);
    expect(ficha.ruta).toBe("/health");
    expect(ficha.nombraAB).toBe(false);

    const comoA = await sesionDirecta("A");
    const real = await intentarDescarga(comoA, rutaArchivoB);
    const inventado = await intentarDescarga(comoA, `member/${B.id}/${randomUUID()}.txt`);
    expect(real.firma).toMatch(/^ERROR: /);
    expect(real.bajada).toMatch(/^ERROR: /);
    expect({ firma: real.firma, bajada: real.bajada }).toEqual({
      firma: inventado.firma,
      bajada: inventado.bajada,
    });

    // Y el archivo sigue existiendo: lo que terminó fue el permiso, no el dato.
    const propio = await intentarDescarga(comoB, rutaArchivoB);
    expect(propio.firma).toBe("OK");
    expect(propio.bajada).toBe("OK");
  });
});
