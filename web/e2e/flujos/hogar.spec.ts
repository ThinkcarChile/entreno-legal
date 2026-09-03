/**
 * E2E §14 — HOGAR: cuenta nueva → primeros pasos → crear hogar → integrantes
 * con y sin cuenta → roles → permisos sobre la semana.
 *
 * Este archivo NO usa el hogar de A y B: crea el suyo con tres cuentas
 * sintéticas (fundadora, planificadora, integrante) y lo borra ENTERO al final.
 * La razón es la 0039: en un hogar que ya existía, a cada rol se le escribió el
 * arrastre de lo que ya podía hacer, así que sobre el hogar de A/B "Integrante
 * no edita la semana" no se distinguiría de nada. Solo un hogar NUEVO estrena
 * la matriz que `create_household` siembra (MEMBER mira, PLANNER planifica), y
 * eso es exactamente lo que `permisos-plan.test.ts` afirma sobre PGlite y este
 * archivo afirma por la interfaz, contra staging.
 *
 * Lo que este archivo afirma del producto:
 *  · Una cuenta sin hogar entra por Primeros pasos (/) y crea su hogar en
 *    Familia; quien lo crea queda como Administrador familiar.
 *  · Un integrante puede existir SIN cuenta (chip "sin cuenta") y toda ficha
 *    nueva nace con el rol Integrante (0039, member_gets_default_role).
 *  · El rol se elige al invitar y se SUMA al de Integrante, no lo reemplaza.
 *  · Invitar es de administradores: la base lo rechaza y la app lo dice.
 *  · La semana la ve toda la familia; la escribe quien tiene `can_edit_plan`.
 *    El rechazo HABLA (ErrorNote) y no deja rastro tras recargar.
 *  · No se asume ningún tamaño de familia: el hogar tiene exactamente los
 *    integrantes que este archivo mete, y las aserciones cuentan ESOS.
 *
 * Serial a propósito: cada caso construye sobre el hogar que dejó el anterior.
 */
import type { Browser, Page } from "@playwright/test";
import { test, expect, recargar, HAY_STAGING } from "../fixtures/contrato";
import { admin } from "../fixtures/admin";

test.describe.configure({ mode: "serial" });

/** Sello por carga del archivo: ver auth.spec.ts. */
const SELLO = Date.now().toString(36);
const PREFIJO_CORREO = "e2e-hogar-";
const PREFIJO_HOGAR = "Hogar E2E ";
const NOMBRE_HOGAR = `${PREFIJO_HOGAR}${SELLO}`;
/** ≥ 8 caracteres: lo exigen `signInSchema` y el `minLength` del campo. */
const CLAVE_SINTETICA = `E2e-clave-${SELLO}`;

interface Cuenta {
  email: string;
  password: string;
  nombre: string;
}

const cuenta = (clave: string, nombre: string): Cuenta => ({
  email: `${PREFIJO_CORREO}${clave}-${SELLO}@example.com`,
  password: CLAVE_SINTETICA,
  nombre,
});

/** Las tres personas del hogar sintético. Ningún nombre real. */
const FUNDADORA = cuenta("admin", "Admin E2E");
const PLANIFICADORA = cuenta("planner", "Pilar E2E");
const INTEGRANTE = cuenta("member", "Matías E2E");
/** Un correo que NADIE debe poder invitar: lo intenta quien no es admin. */
const CORREO_NADIE = `${PREFIJO_CORREO}nadie-${SELLO}@example.com`;

/** Los cuatro que carga "Familia de demostración" (0024), todos sin cuenta. */
const FAMILIA_DEMO = ["Paula", "Sebastián", "Constanza", "Ricardo"] as const;
const PAULA_RENOMBRADA = "Paula E2E";

const TITULO_EVENTO_INTEGRANTE = "Asado E2E del integrante";
const TITULO_EVENTO_PLANIFICADORA = "Asado E2E de la planificadora";

async function usuarioPorCorreo(email: string) {
  const { data, error } = await admin().auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

/** Las cuentas se crean confirmadas: registrarse por la interfaz es de §13, no de acá. */
async function crearCuenta(c: Cuenta): Promise<string> {
  const { data, error } = await admin().auth.admin.createUser({
    email: c.email,
    password: c.password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`crear ${c.email}: ${error?.message ?? "sin usuario"}`);
  return data.user.id;
}

/**
 * Borra los hogares sintéticos de este archivo, por prefijo de nombre. Con
 * service_role la cascada se lleva integrantes, roles, invitaciones, semanas,
 * comidas y eventos: los guardianes de borrado dejan pasar lo que viene de una
 * cascada (0059, `pg_trigger_depth() > 1`) porque el padre ya se autorizó.
 *
 * Se borra el hogar y no sus filas una por una A PROPÓSITO: un DELETE directo
 * sobre `nutrition_events` o `weekly_plans` (profundidad 1) pasa por
 * `app.exigir_can_edit_plan`, que pregunta por `auth.uid()`, y con
 * service_role eso es NULL → rechazado. La cascada es la única puerta.
 */
async function borrarHogaresSinteticos(): Promise<void> {
  const { error } = await admin().from("households").delete().like("name", `${PREFIJO_HOGAR}%`);
  if (error) throw new Error(`borrar hogares E2E: ${error.message}`);
}

/**
 * Borra las cuentas con el prefijo de este archivo. Va DESPUÉS de los hogares:
 * `invitations.accepted_by` referencia auth.users sin cascade (0001:73) y una
 * invitación viva bloquearía el borrado de la cuenta que la aceptó.
 */
async function borrarCuentasSinteticas(): Promise<void> {
  const db = admin();
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  for (const u of data.users) {
    if (!u.email?.startsWith(PREFIJO_CORREO)) continue;
    // Por si un hogar ajeno a este archivo guardó algo de esta cuenta.
    const { error: errorInv } = await db.from("invitations").delete().eq("accepted_by", u.id);
    if (errorInv) throw new Error(`invitaciones de ${u.email}: ${errorInv.message}`);
    const { error: errorBorrado } = await db.auth.admin.deleteUser(u.id);
    if (errorBorrado) throw new Error(`borrar cuenta ${u.email}: ${errorBorrado.message}`);
  }
}

/** El id del hogar sintético, por su nombre (único por sello). */
async function idDelHogar(): Promise<string> {
  const { data, error } = await admin()
    .from("households")
    .select("id")
    .eq("name", NOMBRE_HOGAR)
    .single();
  if (error) throw new Error(`hogar ${NOMBRE_HOGAR}: ${error.message}`);
  return data.id as string;
}

interface FichaEnBase {
  id: string;
  display_name: string;
  user_id: string | null;
  is_active: boolean;
  account_linked_at: string | null;
}

async function fichasDelHogar(): Promise<FichaEnBase[]> {
  const { data, error } = await admin()
    .from("household_members")
    .select("id, display_name, user_id, is_active, account_linked_at")
    .eq("household_id", await idDelHogar())
    .order("created_at");
  if (error) throw new Error(`fichas del hogar: ${error.message}`);
  return (data ?? []) as FichaEnBase[];
}

/** Los códigos de rol de una ficha, ordenados. */
async function rolesDe(memberId: string): Promise<string[]> {
  const { data, error } = await admin()
    .from("member_role_assignments")
    .select("household_roles ( code )")
    .eq("member_id", memberId);
  if (error) throw new Error(`roles de ${memberId}: ${error.message}`);
  const codigos: string[] = [];
  for (const fila of (data ?? []) as { household_roles: { code: string } | { code: string }[] | null }[]) {
    const rol = Array.isArray(fila.household_roles) ? fila.household_roles[0] : fila.household_roles;
    if (rol) codigos.push(rol.code);
  }
  return codigos.sort();
}

/**
 * Llena la puerta SIN navegar antes: quien llega a /login?next=… se queda en
 * esa URL para que el `next` viaje en el formulario. Mismos selectores que
 * `iniciarSesion` del contrato, que solo conoce A/B/AJENO.
 */
async function llenarYEntrar(page: Page, c: Cuenta): Promise<void> {
  await page.getByLabel(/correo/i).fill(c.email);
  await page.getByLabel(/contraseña/i).fill(c.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** Un contexto propio con la sesión de una cuenta sintética, iniciada por la interfaz. */
async function sesionDe(browser: Browser, c: Cuenta): Promise<{ page: Page; cerrar: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await llenarYEntrar(page, c);
  await expect(page).not.toHaveURL(/\/login/);
  return { page, cerrar: () => ctx.close() };
}

/** La tarjeta de un integrante en Familia: un link cuyo nombre accesible lleva nombre y chips. */
function tarjeta(page: Page, nombre: string) {
  return page.getByRole("link", { name: new RegExp(nombre) });
}

/**
 * Genera una invitación por la interfaz de Familia y devuelve el token que la
 * app mostró una sola vez en el link.
 */
async function invitar(page: Page, correo: string, rol: "MEMBER" | "PLANNER"): Promise<string> {
  await page.goto("/family");
  await page.getByLabel(/^Correo/).fill(correo);
  await page.getByLabel("Rol en el hogar").selectOption(rol);
  await page.getByRole("button", { name: "Generar invitación", exact: true }).click();
  await expect(page).toHaveURL(/\/family\?invite=/);
  await expect(page.getByText("Invitación creada")).toBeVisible();
  const ruta = await page.getByText(/^\/invite\/[A-Za-z0-9_-]{20,}$/).textContent();
  if (!ruta) throw new Error("La app no mostró el link de la invitación.");
  return ruta.slice("/invite/".length);
}

/** Entra por el link de invitación con una cuenta que aún no tiene hogar y acepta. */
async function aceptarInvitacion(browser: Browser, c: Cuenta, token: string): Promise<void> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`/invite/${token}`);
    await expect(page).toHaveURL(/\/login\?next=(\/|%2F)invite(\/|%2F)/);
    await llenarYEntrar(page, c);
    await expect(page.getByRole("heading", { name: "Invitación al hogar", exact: true })).toBeVisible();
    await page.getByLabel("Tu nombre").fill(c.nombre);
    await page.getByRole("button", { name: "Unirme al hogar", exact: true }).click();
    await expect(page).toHaveURL(/\/family$/);
    await expect(page.getByRole("heading", { name: NOMBRE_HOGAR, exact: true })).toBeVisible();
    await recargar(page);
    await expect(tarjeta(page, c.nombre)).toBeVisible();
  } finally {
    await ctx.close();
  }
}

/**
 * Intenta planificar el desayuno del primer día de la semana como "Comemos
 * afuera": es la escritura más simple del tablero (no necesita recetas, que un
 * hogar nuevo no tiene) y pasa por la política `assignments_insert` (0039).
 */
async function intentarPlanificarDesayuno(page: Page): Promise<void> {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Semana", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Planificar", exact: true }).first().click();
  await page.getByLabel("Planificar Desayuno").selectOption("kind:EAT_OUT");
}

/** Intenta agregar un evento a la semana: pasa por `events_insert` (0039). */
async function intentarAgregarEvento(page: Page, titulo: string): Promise<void> {
  await page.goto("/plan");
  await page.getByRole("button", { name: "Agregar un evento a la semana" }).click();
  await page.getByLabel("Título del evento").fill(titulo);
  await page.getByRole("button", { name: "Guardar evento", exact: true }).click();
}

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar
  await borrarHogaresSinteticos();
  await borrarCuentasSinteticas();
  await crearCuenta(FUNDADORA);
  await crearCuenta(PLANIFICADORA);
  await crearCuenta(INTEGRANTE);
});

test.afterAll(async () => {
  if (!HAY_STAGING) return;
  await borrarHogaresSinteticos();
  await borrarCuentasSinteticas();
});

test.describe("§14.a — una cuenta sin hogar entra por los primeros pasos", () => {
  test("Inicio la deja en Primeros pasos con 'Crea tu hogar' pendiente; Semana y Familia la mandan a crearlo", async ({
    browser,
  }) => {
    const { page, cerrar } = await sesionDe(browser, FUNDADORA);
    try {
      await page.goto("/");
      await expect(page).toHaveURL(/\/onboarding$/);
      await expect(page.getByRole("heading", { name: "Primeros pasos", exact: true })).toBeVisible();
      const pasoHogar = page
        .getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name: "1. Crea tu hogar" }) });
      await expect(pasoHogar).toContainText("pendiente");

      await page.goto("/plan");
      await expect(
        page.getByText("Primero crea o únete a un hogar en la pestaña Familia."),
      ).toBeVisible();

      await page.goto("/family");
      await expect(page.getByRole("heading", { name: "Crea tu hogar", exact: true })).toBeVisible();
      await expect(page.getByLabel("Nombre del hogar")).toBeVisible();
      await expect(page.getByLabel("Tu nombre")).toBeVisible();
    } finally {
      await cerrar();
    }
  });
});

test.describe("§14.b — crear el hogar", () => {
  test("quien crea el hogar queda como Administrador familiar, con la matriz de roles sembrada", async ({
    browser,
  }) => {
    const { page, cerrar } = await sesionDe(browser, FUNDADORA);
    try {
      await page.goto("/family");
      await page.getByLabel("Nombre del hogar").fill(NOMBRE_HOGAR);
      await page.getByLabel("Tu nombre").fill(FUNDADORA.nombre);
      await page.getByRole("button", { name: "Crear hogar", exact: true }).click();

      await expect(page).toHaveURL(/\/family$/);
      await expect(page.getByRole("heading", { name: NOMBRE_HOGAR, exact: true })).toBeVisible();
      await expect(tarjeta(page, FUNDADORA.nombre)).toContainText("Administrador familiar");
      await expect(tarjeta(page, FUNDADORA.nombre)).not.toContainText("sin cuenta");

      await recargar(page);
      await expect(page.getByRole("heading", { name: NOMBRE_HOGAR, exact: true })).toBeVisible();
      await expect(tarjeta(page, FUNDADORA.nombre)).toContainText("Administrador familiar");

      // El paso 1 de los primeros pasos se da por hecho mirando los DATOS.
      await page.goto("/onboarding");
      const pasoHogar = page
        .getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name: "1. Crea tu hogar" }) });
      await expect(pasoHogar).toContainText("listo");
    } finally {
      await cerrar();
    }

    // Lo persistido: la ficha de la fundadora vinculada a su cuenta (sello
    // 0033) y los cinco roles que `create_household` siembra (0001:161), con
    // la matriz que la 0039 recién hizo significar: MEMBER no edita la semana,
    // PLANNER sí, ADMIN puede todo.
    const fichas = await fichasDelHogar();
    expect(fichas.map((f) => f.display_name)).toEqual([FUNDADORA.nombre]);
    const fundadora = fichas[0]!;
    expect(fundadora.user_id).not.toBeNull();
    expect(fundadora.account_linked_at).not.toBeNull();
    expect(await rolesDe(fundadora.id)).toEqual(["ADMIN"]);

    const { data: roles, error } = await admin()
      .from("household_roles")
      .select("code, is_admin, can_edit_plan, can_manage_members")
      .eq("household_id", await idDelHogar())
      .order("code");
    if (error) throw new Error(`roles del hogar: ${error.message}`);
    const porCodigo = new Map(
      (roles ?? []).map((r) => [
        r.code as string,
        r as { is_admin: boolean; can_edit_plan: boolean; can_manage_members: boolean },
      ]),
    );
    expect([...porCodigo.keys()]).toEqual(["ADMIN", "COOK", "MEMBER", "PLANNER", "SHOPPER"]);
    expect(porCodigo.get("ADMIN")!.is_admin).toBe(true);
    expect(porCodigo.get("MEMBER")!.can_edit_plan).toBe(false);
    expect(porCodigo.get("PLANNER")!.can_edit_plan).toBe(true);
    expect(porCodigo.get("PLANNER")!.is_admin).toBe(false);
  });
});

test.describe("§14.c — integrantes SIN cuenta", () => {
  test("la familia de demostración entra marcada 'sin cuenta' y con el rol Integrante", async ({
    browser,
  }) => {
    const { page, cerrar } = await sesionDe(browser, FUNDADORA);
    try {
      await page.goto("/family");
      await page.getByRole("button", { name: "Cargar familia de demostración" }).click();
      await expect(
        page.getByText("Familia de demostración cargada. Todo es editable."),
      ).toBeVisible();

      await recargar(page);
      for (const nombre of FAMILIA_DEMO) {
        await expect(tarjeta(page, nombre)).toContainText("sin cuenta");
        await expect(tarjeta(page, nombre)).toContainText("Integrante");
      }
      await expect(tarjeta(page, FUNDADORA.nombre)).not.toContainText("sin cuenta");
    } finally {
      await cerrar();
    }

    const fichas = await fichasDelHogar();
    const sinCuenta = fichas.filter((f) => f.user_id === null);
    expect(sinCuenta.map((f) => f.display_name).sort()).toEqual([...FAMILIA_DEMO].sort());
    for (const f of sinCuenta) {
      expect(f.account_linked_at, `${f.display_name} nunca tuvo cuenta`).toBeNull();
      expect(await rolesDe(f.id), `${f.display_name} nace como MEMBER`).toEqual(["MEMBER"]);
    }
  });

  test("el nombre de un integrante sin cuenta se corrige desde su ficha y persiste", async ({
    browser,
  }) => {
    const { page, cerrar } = await sesionDe(browser, FUNDADORA);
    try {
      await page.goto("/family");
      await tarjeta(page, "Paula").click();
      await expect(page).toHaveURL(/\/family\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { name: "Paula", exact: true })).toBeVisible();
      await expect(page.getByText("Perfil del integrante")).toBeVisible();

      await page.getByRole("button", { name: "Cambiar nombre" }).click();
      await page.getByLabel("Nombre del integrante").fill(PAULA_RENOMBRADA);
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect(page.getByRole("heading", { name: PAULA_RENOMBRADA, exact: true })).toBeVisible();

      await recargar(page);
      await expect(page.getByRole("heading", { name: PAULA_RENOMBRADA, exact: true })).toBeVisible();

      // El nombre de la persona y el del hogar viven en tablas distintas:
      // corregir uno no toca el otro (MemberNameEditor).
      await page.goto("/family");
      await expect(page.getByRole("heading", { name: NOMBRE_HOGAR, exact: true })).toBeVisible();
      await expect(tarjeta(page, PAULA_RENOMBRADA)).toContainText("sin cuenta");
    } finally {
      await cerrar();
    }
  });

  test.fixme(
    "agregar un integrante sin cuenta con nombre propio (no existe en v1: la única vía es 'Cargar familia de demostración')",
    async () => {
      // family/page.tsx no tiene un formulario "Agregar integrante": las fichas
      // sin cuenta solo nacen por `seed_demo_family_profiles` (0024). Cuando
      // exista, este caso debe: escribir un nombre, guardar, y ver la tarjeta
      // con "sin cuenta" e "Integrante" tras recargar.
    },
  );
});

test.describe("§14.d — integrantes CON cuenta: invitar con rol y aceptar", () => {
  test("Planificadora e Integrante aceptan sus invitaciones y quedan con el rol invitado (sumado a Integrante)", async ({
    browser,
  }) => {
    const { page, cerrar } = await sesionDe(browser, FUNDADORA);
    let tokenPlanner: string;
    let tokenMember: string;
    try {
      tokenPlanner = await invitar(page, PLANIFICADORA.email, "PLANNER");
      tokenMember = await invitar(page, INTEGRANTE.email, "MEMBER");
    } finally {
      await cerrar();
    }

    await aceptarInvitacion(browser, PLANIFICADORA, tokenPlanner);
    await aceptarInvitacion(browser, INTEGRANTE, tokenMember);

    const admina = await sesionDe(browser, FUNDADORA);
    try {
      const page = admina.page;
      await page.goto("/family");
      await expect(tarjeta(page, PLANIFICADORA.nombre)).toContainText("Planificador");
      await expect(tarjeta(page, PLANIFICADORA.nombre)).toContainText("Integrante");
      await expect(tarjeta(page, PLANIFICADORA.nombre)).not.toContainText("sin cuenta");
      await expect(tarjeta(page, INTEGRANTE.nombre)).toContainText("Integrante");
      await expect(tarjeta(page, INTEGRANTE.nombre)).not.toContainText("Planificador");
      await expect(tarjeta(page, INTEGRANTE.nombre)).not.toContainText("sin cuenta");

      // El hogar tiene EXACTAMENTE lo que este archivo metió: 1 fundadora +
      // 4 de la demostración + 2 invitadas. Ningún "5" supuesto.
      const lista = page.getByRole("list").filter({ has: tarjeta(page, FUNDADORA.nombre) });
      await expect(lista.getByRole("listitem")).toHaveCount(1 + FAMILIA_DEMO.length + 2);
    } finally {
      await admina.cerrar();
    }

    const fichas = await fichasDelHogar();
    const pilar = fichas.find((f) => f.display_name === PLANIFICADORA.nombre);
    const matias = fichas.find((f) => f.display_name === INTEGRANTE.nombre);
    if (!pilar || !matias) throw new Error("Las fichas invitadas no quedaron en la base.");
    expect(pilar.user_id).toBe((await usuarioPorCorreo(PLANIFICADORA.email))!.id);
    expect(matias.user_id).toBe((await usuarioPorCorreo(INTEGRANTE.email))!.id);
    expect(pilar.account_linked_at).not.toBeNull();
    expect(await rolesDe(pilar.id)).toEqual(["MEMBER", "PLANNER"]);
    expect(await rolesDe(matias.id)).toEqual(["MEMBER"]);
  });

  test("invitar es de administradores: la Planificadora lo intenta y la app lo dice", async ({
    browser,
  }) => {
    const { page, cerrar } = await sesionDe(browser, PLANIFICADORA);
    try {
      await page.goto("/family");
      await page.getByLabel(/^Correo/).fill(CORREO_NADIE);
      await page.getByRole("button", { name: "Generar invitación", exact: true }).click();
      await expect(page).toHaveURL(/\/family\?error=/);
      await expect(page.getByRole("alert")).toHaveText("Solo el administrador puede invitar");
      await expect(page.getByText("Invitación creada")).toHaveCount(0);
    } finally {
      await cerrar();
    }

    const { count, error } = await admin()
      .from("invitations")
      .select("id", { count: "exact", head: true })
      .eq("email", CORREO_NADIE);
    if (error) throw new Error(`invitaciones de ${CORREO_NADIE}: ${error.message}`);
    expect(count).toBe(0);
  });

  test.fixme(
    "cambiar el rol de un integrante que ya está en el hogar (no existe en v1: el rol se fija solo al invitar)",
    async () => {
      // Ni family/page.tsx ni family/[memberId]/page.tsx tienen un control de
      // rol. Cuando exista, este caso debe: dar Planificador a Matías, recargar,
      // ver el chip, y comprobar que ahora sí escribe la semana.
    },
  );

  test.fixme(
    "quitar o desactivar a un integrante (no existe en v1: ninguna pantalla escribe is_active ni borra fichas)",
    async () => {
      // `members_delete` (0001:271) y `is_active` existen en la base, pero no
      // hay botón. Cuando exista, este caso debe: desactivar a Ricardo,
      // recargar, y ver que no aparece en Familia ni en la lista de comensales.
    },
  );
});

test.describe("§14.e — permisos sobre la semana: Integrante mira, Planificadora escribe", () => {
  test("el Integrante ve la semana pero cada intento de escribirla se rechaza HABLANDO y sin dejar rastro", async ({
    browser,
  }) => {
    const { page, cerrar } = await sesionDe(browser, INTEGRANTE);
    try {
      // Mirar sí: la semana carga (el esqueleto lo crea `ensure_weekly_plan`,
      // que sigue abierta a cualquier integrante, 0039) y está vacía.
      await intentarPlanificarDesayuno(page);
      await expect(page.getByRole("alert")).toHaveText("No se pudo planificar esa comida.");
      await recargar(page);
      const main = page.getByRole("main");
      await expect(main).toContainText("0 comidas planificadas");
      await expect(main).not.toContainText("Comemos afuera");

      await intentarAgregarEvento(page, TITULO_EVENTO_INTEGRANTE);
      await expect(page.getByRole("alert")).toHaveText("No se pudo guardar el evento.");
      await recargar(page);
      await expect(page.getByRole("main")).not.toContainText(TITULO_EVENTO_INTEGRANTE);
    } finally {
      await cerrar();
    }

    // Lo persistido: nada. Ni comida ni evento del Integrante.
    const hogar = await idDelHogar();
    const { count, error } = await admin()
      .from("nutrition_events")
      .select("id", { count: "exact", head: true })
      .eq("household_id", hogar);
    if (error) throw new Error(`eventos del hogar: ${error.message}`);
    expect(count).toBe(0);
  });

  test("la Planificadora escribe la semana y lo escrito sobrevive la recarga; el Integrante lo ve", async ({
    browser,
  }) => {
    const planificadora = await sesionDe(browser, PLANIFICADORA);
    try {
      const page = planificadora.page;
      await intentarPlanificarDesayuno(page);
      await expect(page.getByText("Comida planificada.")).toBeVisible();
      await recargar(page);
      const main = page.getByRole("main");
      await expect(main).toContainText("Comemos afuera");
      await expect(main).toContainText(/1 comidas? planificadas/);

      await intentarAgregarEvento(page, TITULO_EVENTO_PLANIFICADORA);
      await expect(page.getByText("Evento agregado.")).toBeVisible();
      await recargar(page);
      await expect(page.getByRole("main")).toContainText(TITULO_EVENTO_PLANIFICADORA);
    } finally {
      await planificadora.cerrar();
    }

    // Ver el plan de la familia es parte de estar en la familia (0039 §3).
    const integrante = await sesionDe(browser, INTEGRANTE);
    try {
      await integrante.page.goto("/plan");
      const main = integrante.page.getByRole("main");
      await expect(main).toContainText("Comemos afuera");
      await expect(main).toContainText(TITULO_EVENTO_PLANIFICADORA);
      await expect(main).not.toContainText(TITULO_EVENTO_INTEGRANTE);
    } finally {
      await integrante.cerrar();
    }

    const hogar = await idDelHogar();
    const { data: eventos, error } = await admin()
      .from("nutrition_events")
      .select("title")
      .eq("household_id", hogar);
    if (error) throw new Error(`eventos del hogar: ${error.message}`);
    expect((eventos ?? []).map((e) => e.title as string)).toEqual([TITULO_EVENTO_PLANIFICADORA]);
  });
});

test.describe("§14.f — vincular una cuenta a un integrante sin cuenta", () => {
  test.fixme(
    "vincular cuenta a un integrante sin cuenta (no existe en v1: ninguna pantalla crea invitaciones con invited_member_id)",
    async () => {
      // La base sí sabe (accept_invitation con invited_member_id, 0001/0037) y
      // el producto lo exige ("un integrante puede existir sin cuenta propia y
      // vinculársela después", 0037). Cuando exista la pantalla, este caso
      // debe: invitar PARA la ficha de Paula E2E, aceptar con una cuenta nueva,
      // y ver que la tarjeta deja de decir "sin cuenta" conservando el nombre.
    },
  );
});
