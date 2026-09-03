/**
 * E2E §27 — HOGAR AJENO: por URL directa, con sesión de OTRO hogar, todo lo de
 * A responde DENEGADO SIN ORÁCULO DE EXISTENCIA.
 *
 * Lo que este archivo afirma del producto:
 *  · Un id real del hogar de A y un id inventado producen, para AJENO, LA MISMA
 *    respuesta (misma ruta final, mismo texto). "Existe pero no es tuyo" ya
 *    filtra que existe (not-found.tsx, 0033, 0053).
 *  · Un id que ni siquiera es uuid es una URL que no existe: 404 honesto, no un
 *    `22P02` disfrazado de error de la app (`lib/route-params.ts`, gate §7).
 *  · Los mismos enlaces, con sesión de A, SÍ abren. Sin este control, la
 *    denegación se probaría sola con ids falsos.
 *
 * Los ids reales salen de filas SINTÉTICAS creadas por `admin()` en el hogar
 * de A. Dos de ellas —la comida planificada y el evento— no se pueden borrar
 * con service_role: las guardas de borrado de la 0039 evalúan
 * `app.can_edit_plan`, que lee `auth.uid()` y con service_role es null. Por eso
 * primero se busca una fila existente y, si no hay, se crea una en una semana
 * lejana (2031) que ningún otro flujo mira; en `afterAll` se intenta borrar y,
 * si la guarda lo impide, se dice.
 */
import type { Page } from "@playwright/test";
import { test, expect, ENV, HAY_STAGING } from "../fixtures/contrato";
import { admin, hogarDe, idDeUsuario } from "../fixtures/admin";

const SELLO = `e2e-ajeno-${Date.now()}`;
const BUCKET_MEDICO = "medical-documents";
/** Lunes de una semana que ningún otro spec planifica. */
const SEMANA_LEJANA = "2031-01-06";
const UUID_INVENTADO = "00000000-0000-4000-8000-000000000000";
const NO_UUID = "no-es-un-uuid";

interface Ficha {
  id: string;
  nombre: string;
  hogar: string;
}

/** Copia deliberada: un spec importa SOLO de `fixtures/`, y `fixtures/` es del lead. */
async function fichaDe(u: "A" | "AJENO"): Promise<Ficha> {
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

async function insertar(tabla: string, fila: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin().from(tabla).insert(fila).select("id").single();
  if (error) throw new Error(`${tabla}: ${error.message}`);
  return data.id as string;
}

async function borrar(tabla: string, id: string): Promise<void> {
  const { error } = await admin().from(tabla).delete().eq("id", id);
  if (error) throw new Error(`borrar ${tabla} ${id}: ${error.message}`);
}

/**
 * Todo lo del hogar de A que se va a intentar abrir como AJENO. `null` en una
 * pieza significa que no se pudo preparar, y el test correspondiente se salta
 * DICIENDO por qué: nunca se afirma denegación sobre un id que no existe.
 */
interface Escena {
  lotId: string;
  qrToken: string;
  labelJobId: string;
  recetaId: string;
  prepPlanId: string;
  boletaId: string;
  examenId: string;
  rutaExamen: string;
  propuestaId: string;
  comida: { id: string; creada: boolean } | null;
  evento: { id: string; titulo: string; creado: boolean } | null;
  motivos: Record<string, string>;
}

const RECETA = "Receta privada E2E (hogar ajeno)";
const EVENTO = "Evento sintético E2E (hogar ajeno)";

async function prepararEscena(A: Ficha): Promise<Escena> {
  const db = admin();
  const motivos: Record<string, string> = {};

  const qrToken = `${SELLO.replace(/[^a-z0-9]/g, "")}${"0".repeat(32)}`.slice(0, 32);
  const lotId = await insertar("inventory_lots", {
    household_id: A.hogar,
    label: "Lote E2E (hogar ajeno)",
    unit: "G",
    created_by: A.id,
    qr_token: qrToken,
  });
  const labelJobId = await insertar("label_print_jobs", {
    household_id: A.hogar,
    lot_id: lotId,
    snapshot: { e2e: SELLO },
    generated_by: A.id,
  });
  const recetaId = await insertar("meal_templates", {
    household_id: A.hogar,
    kind: "MEAL",
    name: RECETA,
    created_by: A.id,
  });
  const prepPlanId = await insertar("batch_prep_plans", {
    household_id: A.hogar,
    plan_date: SEMANA_LEJANA,
    created_by: A.id,
  });
  const sha = `${SELLO.replace(/[^a-z0-9]/g, "")}${"a".repeat(64)}`.slice(0, 64);
  const boletaId = await insertar("purchase_receipts", {
    household_id: A.hogar,
    storage_path: `household/${A.hogar}/${sha}.txt`,
    content_sha256: sha,
    original_mime: "text/plain",
    byte_size: 42,
    uploaded_by: A.id,
  });

  // El examen lleva un archivo REAL en el bucket privado: es lo que se intenta
  // alcanzar sin sesión más abajo.
  const rutaExamen = `member/${A.id}/${SELLO}.txt`;
  const { error: errorSubida } = await db.storage
    .from(BUCKET_MEDICO)
    .upload(rutaExamen, Buffer.from("# examen sintético E2E, sin datos reales\n", "utf8"), {
      contentType: "text/plain",
    });
  if (errorSubida) throw new Error(`subir examen sintético: ${errorSubida.message}`);
  const examenId = await insertar("lab_documents", {
    household_id: A.hogar,
    member_id: A.id,
    uploaded_by: A.id,
    document_date: "2026-08-01",
    source_lab_name: "Laboratorio Sintético E2E (hogar ajeno)",
    storage_path: rutaExamen,
  });

  const propuestaId = await insertar("assistant_proposals", {
    household_id: A.hogar,
    created_by: A.id,
    trace_id: SELLO,
    accion: "setStockTarget",
    args: { ingredientId: UUID_INVENTADO, quantity: 1, unit: "G" },
    risk: "MEDIO",
    effect: "WRITES_PREFS",
    origen: "USUARIO",
    requires: [],
    dedupe_key: SELLO,
    basis: { capturedAt: new Date().toISOString(), engineVersions: {}, rows: [] },
    resumen: {
      titulo: "Propuesta E2E (hogar ajeno)",
      lineas: [],
      reasons: [],
      provenance: [{ motor: "stock", version: "stock@e2e-1" }],
      unknowns: [],
      irreversible: [],
    },
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  });

  // Comida planificada: primero una existente; si no hay, una FREE en 2031.
  let comida: Escena["comida"] = null;
  try {
    const { data, error } = await db
      .from("meal_assignments")
      .select("id, weekly_plan_days!inner(plan_id, weekly_plans!inner(household_id))")
      .eq("weekly_plan_days.weekly_plans.household_id", A.hogar)
      .limit(1);
    if (error) throw new Error(error.message);
    const existente = (data ?? [])[0];
    if (existente !== undefined) {
      comida = { id: existente.id as string, creada: false };
    } else {
      const planId = await insertar("weekly_plans", {
        household_id: A.hogar,
        week_start: SEMANA_LEJANA,
        created_by: A.id,
      });
      const dayId = await insertar("weekly_plan_days", { plan_id: planId, plan_date: SEMANA_LEJANA });
      const id = await insertar("meal_assignments", { day_id: dayId, meal_type: "LUNCH", kind: "FREE" });
      comida = { id, creada: true };
    }
  } catch (e) {
    // No es un catch vacío: el test de "semana" se salta con ESTE motivo.
    motivos.comida = e instanceof Error ? e.message : String(e);
  }

  let evento: Escena["evento"] = null;
  try {
    const { data, error } = await db
      .from("nutrition_events")
      .select("id, title")
      .eq("household_id", A.hogar)
      .limit(1);
    if (error) throw new Error(error.message);
    const existente = (data ?? [])[0];
    if (existente !== undefined) {
      evento = { id: existente.id as string, titulo: existente.title as string, creado: false };
    } else {
      const id = await insertar("nutrition_events", {
        household_id: A.hogar,
        event_date: "2031-01-07",
        title: EVENTO,
      });
      evento = { id, titulo: EVENTO, creado: true };
    }
  } catch (e) {
    motivos.evento = e instanceof Error ? e.message : String(e);
  }

  return {
    lotId,
    qrToken,
    labelJobId,
    recetaId,
    prepPlanId,
    boletaId,
    examenId,
    rutaExamen,
    propuestaId,
    comida,
    evento,
    motivos,
  };
}

async function limpiarEscena(A: Ficha, escena: Escena): Promise<void> {
  const db = admin();
  const { error } = await db
    .from("assistant_proposals")
    .update({ status: "REJECTED", decided_by: A.id, decided_at: new Date().toISOString() })
    .eq("id", escena.propuestaId)
    .eq("status", "OFFERED");
  if (error) throw new Error(`rechazar propuesta: ${error.message}`);

  await borrar("lab_documents", escena.examenId);
  const { error: errorObjeto } = await db.storage.from(BUCKET_MEDICO).remove([escena.rutaExamen]);
  if (errorObjeto) throw new Error(`retirar examen sintético: ${errorObjeto.message}`);
  await borrar("purchase_receipts", escena.boletaId);
  await borrar("batch_prep_plans", escena.prepPlanId);
  await borrar("meal_templates", escena.recetaId);
  // El job de etiquetas cae en cascada con el lote.
  await borrar("inventory_lots", escena.lotId);

  // Lo que está detrás de una guarda de borrado (0039): se intenta, y si la
  // guarda manda, se deja dicho. No se traga.
  const guardadas: string[] = [];
  if (escena.evento?.creado) {
    const { error: e } = await db.from("nutrition_events").delete().eq("id", escena.evento.id);
    if (e) guardadas.push(`nutrition_events ${escena.evento.id}: ${e.message}`);
  }
  if (escena.comida?.creada) {
    const { error: e } = await db.from("weekly_plans").delete().eq("household_id", A.hogar).eq("week_start", SEMANA_LEJANA);
    if (e) guardadas.push(`weekly_plans ${SEMANA_LEJANA}: ${e.message}`);
  }
  if (guardadas.length > 0) {
    console.warn(
      `[hogar-ajeno] quedaron filas sintéticas en el hogar de A porque service_role no pasa las guardas de borrado de la 0039 (app.can_edit_plan lee auth.uid()):\n  ${guardadas.join("\n  ")}`,
    );
  }
}

/** Lo que se compara entre un id real y uno inventado: a dónde terminó y qué se lee. */
interface Respuesta {
  ruta: string;
  texto: string;
}

async function respuestaDe(page: Page, ruta: string): Promise<Respuesta> {
  await page.goto(ruta);
  await page.waitForLoadState("networkidle");
  const texto = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  return { ruta: new URL(page.url()).pathname, texto };
}

const TITULO_404 = "No encontramos esta página";

/**
 * Un vector: la ruta con el id real de A, la misma con un uuid inventado, la
 * misma con algo que no es uuid, y cómo se ve la denegación.
 */
interface Vector {
  nombre: string;
  ruta: (id: string) => string;
  idReal: () => string;
  /** Cómo se reconoce la denegación (además de ser idéntica a la del id inventado). */
  denegado: { rutaFinal?: string; texto: string };
  /** `false` cuando la ruta no valida uuid y el caso "no-uuid" no aplica igual. */
  noUuidEs404?: boolean;
}

let A: Ficha;
let AJENO: Ficha;
let escena: Escena;

test.beforeAll(async () => {
  if (!HAY_STAGING) return;
  [A, AJENO] = await Promise.all([fichaDe("A"), fichaDe("AJENO")]);
  if (A.hogar === AJENO.hogar) throw new Error("AJENO tiene que vivir en OTRO hogar que A.");
  escena = await prepararEscena(A);
});

test.afterAll(async () => {
  if (!HAY_STAGING || !escena) return;
  await limpiarEscena(A, escena);
});

const VECTORES: Vector[] = [
  {
    nombre: "integrante",
    ruta: (id) => `/family/${id}`,
    idReal: () => A.id,
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "semana (comida planificada)",
    ruta: (id) => `/plan/comida/${id}`,
    idReal: () => {
      if (escena.comida === null) throw new Error("sin comida planificada");
      return escena.comida.id;
    },
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "receta privada",
    ruta: (id) => `/recipes/${id}`,
    idReal: () => escena.recetaId,
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "receta privada (edición)",
    ruta: (id) => `/recipes/${id}/edit`,
    idReal: () => escena.recetaId,
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "receta privada (para la familia)",
    ruta: (id) => `/recipes/${id}/family`,
    idReal: () => escena.recetaId,
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "cocina (plan de preparación)",
    ruta: (id) => `/prep/${id}`,
    idReal: () => escena.prepPlanId,
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "evento",
    ruta: (id) => `/eventos/${id}`,
    idReal: () => {
      if (escena.evento === null) throw new Error("sin evento");
      return escena.evento.id;
    },
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "evento (compras del evento)",
    ruta: (id) => `/eventos/${id}/compras`,
    idReal: () => {
      if (escena.evento === null) throw new Error("sin evento");
      return escena.evento.id;
    },
    denegado: { texto: TITULO_404 },
  },
  {
    nombre: "boleta (finanzas)",
    ruta: (id) => `/finanzas/boletas/${id}/review`,
    idReal: () => escena.boletaId,
    denegado: { rutaFinal: "/finanzas/boletas", texto: "Boletas" },
  },
  {
    nombre: "salud (ficha clínica del integrante)",
    ruta: (id) => `/health/member/${id}`,
    idReal: () => A.id,
    denegado: { rutaFinal: "/health", texto: "Salud" },
  },
  {
    nombre: "salud (revisión de un examen)",
    ruta: (id) => `/health/exams/${id}/review`,
    idReal: () => escena.examenId,
    denegado: { rutaFinal: "/health", texto: "Salud" },
  },
  {
    nombre: "propuesta del asistente",
    ruta: (id) => `/asistente/propuesta/${id}`,
    idReal: () => escena.propuestaId,
    denegado: {
      texto: "No encuentro esa propuesta. Puede que ya se haya resuelto o que no te corresponda verla.",
    },
  },
];

test.describe("§27 — como AJENO, por URL directa, lo de A está denegado sin oráculo", () => {
  for (const v of VECTORES) {
    test(`${v.nombre}: id real de A ≡ uuid inventado; y un no-uuid es 404`, async ({ comoAjeno: page }) => {
      let idReal: string;
      try {
        idReal = v.idReal();
      } catch (e) {
        const motivo = v.nombre.startsWith("semana") ? escena.motivos.comida : escena.motivos.evento;
        test.skip(true, `no se pudo preparar la fila sintética de A: ${motivo ?? String(e)}`);
        return;
      }

      const real = await respuestaDe(page, v.ruta(idReal));
      const inventada = await respuestaDe(page, v.ruta(UUID_INVENTADO));

      // La denegación tiene la cara que corresponde…
      if (v.denegado.rutaFinal !== undefined) expect(real.ruta).toBe(v.denegado.rutaFinal);
      expect(real.texto).toContain(v.denegado.texto);
      // …y es INDISTINGUIBLE de la de un id que no existe en ninguna parte.
      expect(inventada).toEqual(real);

      // Un id que ni es uuid es una URL que no existe (gate §7).
      const malformada = await respuestaDe(page, v.ruta(NO_UUID));
      expect(malformada.texto).toContain(TITULO_404);
    });
  }

  test("despensa: el QR de un paquete de A es «no disponible», igual que un token inventado", async ({
    comoAjeno: page,
  }) => {
    const real = await respuestaDe(page, `/q/${escena.qrToken}`);
    const inventada = await respuestaDe(page, `/q/${"f".repeat(32)}`);
    expect(real.texto).toContain("Etiqueta no disponible");
    expect(real.texto).toContain("Este código no corresponde a un paquete de tu hogar.");
    expect(inventada).toEqual(real);
  });

  test("despensa: el PDF de etiquetas de A responde 404 «no autorizado», igual que un job inventado", async ({
    comoAjeno: page,
  }) => {
    const real = await page.request.get(`/api/labels?jobs=${escena.labelJobId}`);
    const inventada = await page.request.get(`/api/labels?jobs=${UUID_INVENTADO}`);
    expect(real.status()).toBe(404);
    expect(await real.json()).toEqual({ error: "no autorizado" });
    expect(inventada.status()).toBe(real.status());
    expect(await inventada.json()).toEqual(await real.json());
  });

  test("archivo del hogar de A: la ruta del bucket privado no se abre sin sesión del hogar, exista o no", async ({
    comoAjeno: page,
  }) => {
    const base = process.env[ENV.supabaseUrl];
    const anon = process.env[ENV.anonKey];
    test.skip(!base || !anon, "Faltan E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY para hablarle al bucket.");
    const cabeceras = { apikey: anon!, Authorization: `Bearer ${anon!}` };
    const objeto = (ruta: string) =>
      page.request.get(`${base}/storage/v1/object/authenticated/${BUCKET_MEDICO}/${ruta}`, {
        headers: cabeceras,
      });

    const real = await objeto(escena.rutaExamen);
    const inventada = await objeto(`member/${A.id}/no-existe-${SELLO}.txt`);
    expect(real.ok()).toBe(false);
    expect(inventada.status()).toBe(real.status());
    // El cuerpo tampoco distingue "no existe" de "no es tuyo".
    expect(await inventada.text()).toBe(await real.text());
  });
});

test.describe("§27 — control: con sesión de A, los mismos enlaces SÍ abren", () => {
  test("los ids son reales: A ve su ficha, su receta, su boleta, su examen y su propuesta", async ({
    comoA: page,
  }) => {
    await page.goto(`/family/${A.id}`);
    await expect(page.getByRole("heading", { name: A.nombre })).toBeVisible();

    await page.goto(`/recipes/${escena.recetaId}`);
    await expect(page.getByRole("heading", { name: RECETA })).toBeVisible();

    await page.goto(`/finanzas/boletas/${escena.boletaId}/review`);
    await expect(page.getByRole("heading", { name: "Revisión de la boleta" })).toBeVisible();

    await page.goto(`/health/exams/${escena.examenId}/review`);
    await expect(page.getByRole("heading", { name: "Revisión del examen" })).toBeVisible();

    await page.goto(`/asistente/propuesta/${escena.propuestaId}`);
    await expect(page.getByRole("heading", { name: "Confirmar", exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toContainText("setStockTarget");

    await page.goto(`/prep/${escena.prepPlanId}`);
    await expect(page.locator("body")).not.toContainText(TITULO_404);
  });

  test("A ve su evento y su comida planificada", async ({ comoA: page }) => {
    test.skip(
      escena.evento === null || escena.comida === null,
      `no se pudo preparar: ${escena.motivos.evento ?? ""} ${escena.motivos.comida ?? ""}`.trim(),
    );
    await page.goto(`/eventos/${escena.evento!.id}`);
    await expect(page.getByRole("heading", { name: escena.evento!.titulo })).toBeVisible();

    await page.goto(`/plan/comida/${escena.comida!.id}`);
    await expect(page.locator("body")).not.toContainText(TITULO_404);
  });
});
