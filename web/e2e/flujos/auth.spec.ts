/**
 * E2E §13 — AUTH: crear cuenta → entrar → la sesión sobrevive la recarga →
 * salir → sesión expirada sin fuga → invitar → aceptar.
 *
 * Cuentas 100 % sintéticas: A y B son las del contrato (mismo hogar) y las que
 * este archivo crea llevan el prefijo `e2e-auth-` y se borran al final (y al
 * principio, por si una corrida anterior murió a medias).
 *
 * Lo que este archivo afirma del producto:
 *  · La puerta es UNA (/login) con "Entrar" y "Crear cuenta". Sin sesión, toda
 *    pantalla del hogar redirige a /login?next=… y no pinta ni un nombre. La
 *    redirección la hace CADA PÁGINA con `auth.getUser()` — middleware.ts solo
 *    refresca cookies —, así que lo que se prueba es la pantalla, no la ruta.
 *  · La sesión vive en cookies `sb-*` de @supabase/ssr que el middleware
 *    refresca en cada request: recargar no la pierde; borrarlas la pierde
 *    entera, y sin sesión no hay dato que mirar.
 *  · Una credencial mala se dice ("Credenciales incorrectas") y no deja entrar.
 *  · La invitación es un link de un solo uso que se muestra UNA vez; en la base
 *    queda solo su hash (family/actions.ts: "el token viaja una sola vez").
 *  · Quien ya es del hogar no entra dos veces con una invitación (índice
 *    household_members_user_uniq, 0001:37): la app lo dice y la invitación
 *    sigue viva para quien sí corresponde, porque el RPC falló entero.
 *  · Aceptar es un acto de la cuenta invitada: exige sesión (redirige a /login
 *    con `next` al link) y deja a la persona en el hogar con el rol invitado.
 *  · La cuenta de un integrante sin cuenta SOLO se vincula aceptando una
 *    invitación (0033); en v1 ninguna pantalla crea esa invitación → fixme.
 *
 * Serial a propósito: el token que B no puede usar es el mismo que C acepta.
 */
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  recargar,
  cerrarSesion,
  credenciales,
  HAY_STAGING,
} from "../fixtures/contrato";
import { admin, hogarDe, idDeUsuario } from "../fixtures/admin";

test.describe.configure({ mode: "serial" });

/**
 * Sello por carga del archivo: los cuatro proyectos (escritorio + tres anchos)
 * corren este spec en serie y cada uno crea sus cuentas. Con el sello, una
 * corrida que murió a medias no choca con la siguiente; el barrido del
 * `beforeAll` se lleva lo que haya quedado igual.
 */
const SELLO = Date.now().toString(36);
const PREFIJO = "e2e-auth-";
const CORREO_CUENTA_NUEVA = `${PREFIJO}nueva-${SELLO}@example.com`;
const CORREO_C = `${PREFIJO}c-${SELLO}@example.com`;
const NOMBRE_C = "Integrante E2E C";
/** ≥ 8 caracteres: lo exigen `signInSchema` y el `minLength` del campo. */
const CLAVE_SINTETICA = `E2e-clave-${SELLO}`;

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

/** El nombre REAL del hogar: la portada lo pinta tal cual, sin genérico (family/page.tsx). */
async function nombreDelHogar(hogarId: string): Promise<string> {
  const { data, error } = await admin()
    .from("households")
    .select("name")
    .eq("id", hogarId)
    .single();
  if (error) throw new Error(`nombre del hogar: ${error.message}`);
  return data.name as string;
}

/** Los códigos de rol de una ficha, ordenados, para afirmar "Integrante y nada más". */
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

async function usuarioPorCorreo(email: string) {
  const { data, error } = await admin().auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

/** Cuenta sintética confirmada por administración: acá el registro no es lo que se prueba. */
async function crearCuenta(email: string): Promise<string> {
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password: CLAVE_SINTETICA,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`crear ${email}: ${error?.message ?? "sin usuario"}`);
  return data.user.id;
}

/**
 * Borra TODO rastro de una cuenta sintética: su ficha en el hogar (si llegó a
 * unirse), las invitaciones que la nombran o que aceptó, y la cuenta.
 *
 * El orden importa: `invitations.accepted_by` referencia auth.users SIN
 * cascade (0001:73), así que borrar la cuenta antes que la invitación falla
 * con una FK. La auditoría (`audit_events`) se deja: es historia del hogar y
 * su `actor_user_id` no es FK.
 */
async function borrarRastro(email: string): Promise<void> {
  const db = admin();
  const usuario = await usuarioPorCorreo(email);
  const exigir = (contexto: string, error: { message: string } | null) => {
    if (error) throw new Error(`${contexto} (${email}): ${error.message}`);
  };
  if (usuario) {
    exigir("ficha", (await db.from("household_members").delete().eq("user_id", usuario.id)).error);
    exigir(
      "invitaciones aceptadas",
      (await db.from("invitations").delete().eq("accepted_by", usuario.id)).error,
    );
  }
  exigir("invitaciones por correo", (await db.from("invitations").delete().eq("email", email)).error);
  if (usuario) {
    const { error } = await db.auth.admin.deleteUser(usuario.id);
    if (error) throw new Error(`borrar cuenta ${email}: ${error.message}`);
  }
}

/** Lo que dejó una corrida anterior que murió a medias. Solo cuentas con el prefijo de este archivo. */
async function barrerRestos(): Promise<void> {
  const { data, error } = await admin().auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  for (const u of data.users) {
    if (u.email?.startsWith(PREFIJO)) await borrarRastro(u.email);
  }
}

/**
 * Llena la puerta y entra SIN navegar antes: quien llega a /login?next=… tiene
 * que quedarse en esa URL para que el `next` viaje en el formulario. Mismos
 * selectores que `iniciarSesion` del contrato, que solo conoce A/B/AJENO y
 * siempre parte de /login limpio.
 */
async function llenarYEntrar(page: Page, cuenta: { email: string; password: string }): Promise<void> {
  await page.getByLabel(/correo/i).fill(cuenta.email);
  await page.getByLabel(/contraseña/i).fill(cuenta.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

let A: Ficha;
let nombreHogarA: string;
let idC: string;

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar
  A = await fichaDe("A");
  nombreHogarA = await nombreDelHogar(A.hogar);
  // A tiene que ser administradora para invitar (política invitations_admin,
  // 0001:294). Si el bootstrap de staging no la dejó así, que se sepa acá y no
  // como un "Solo el administrador puede invitar" a mitad de la suite.
  const rolesA = await rolesDe(A.id);
  if (!rolesA.includes("ADMIN")) {
    throw new Error(`A no es ADMIN en su hogar de staging (roles: ${rolesA.join(", ")}). Corre el bootstrap.`);
  }
  await barrerRestos();
  idC = await crearCuenta(CORREO_C);
});

test.afterAll(async () => {
  if (!HAY_STAGING) return;
  await borrarRastro(CORREO_C);
  await borrarRastro(CORREO_CUENTA_NUEVA);
});

test.describe("§13.a — entrar: la puerta es una y dice la verdad", () => {
  test("una clave equivocada no entra y la app lo dice", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/correo/i).fill(credenciales("A").email);
    await page.getByLabel(/contraseña/i).fill("clave-equivocada-e2e");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();

    await expect(page).toHaveURL(/\/login\?error=/);
    await expect(page.getByRole("alert")).toHaveText("Credenciales incorrectas");
    // Nada del hogar se filtra por rebotar en la puerta.
    await expect(page.getByRole("main")).not.toContainText(nombreHogarA);
  });

  test("entrar por la interfaz deja a A en su hogar, con su nombre y el botón de salir", async ({
    comoA: page,
  }) => {
    await page.goto("/family");
    await expect(page.getByRole("heading", { name: nombreHogarA, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(A.nombre) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
  });

  test("el `next` se respeta: sin sesión /plan manda a /login y al entrar vuelve a /plan", async ({
    page,
  }) => {
    await page.goto("/plan");
    // `redirect("/login?next=/plan")` en plan/page.tsx; el navegador puede
    // mostrar la barra codificada o no, y las dos son la misma URL.
    await expect(page).toHaveURL(/\/login\?next=(\/|%2F)plan$/);
    await llenarYEntrar(page, credenciales("A"));
    await expect(page).toHaveURL(/\/plan$/);
    await expect(page.getByRole("heading", { name: "Semana", exact: true })).toBeVisible();
  });
});

test.describe("§13.b — la sesión sobrevive la recarga", () => {
  test("recargar no pierde la sesión ni el hogar", async ({ comoA: page }) => {
    await page.goto("/family");
    await expect(page.getByRole("heading", { name: nombreHogarA, exact: true })).toBeVisible();

    await recargar(page);
    await expect(page).toHaveURL(/\/family$/);
    await expect(page.getByRole("heading", { name: nombreHogarA, exact: true })).toBeVisible();

    // La portada decide entre /family y /onboarding con los DATOS (page.tsx);
    // lo único que este contrato afirma es que con sesión nunca es /login.
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(/\/(family|onboarding)$/);
  });
});

test.describe("§13.c — salir", () => {
  test("cerrar sesión vuelve a /login y el hogar deja de ser visible", async ({ comoA: page }) => {
    await page.goto("/family");
    await cerrarSesion(page);

    await page.goto("/family");
    await expect(page).toHaveURL(/\/login\?next=(\/|%2F)family$/);
    const main = page.getByRole("main");
    await expect(main).not.toContainText(nombreHogarA);
    await expect(main).not.toContainText(A.nombre);
  });
});

test.describe("§13.d — sesión expirada: sin cookies no hay dato que mirar", () => {
  test("sin las cookies sb-* la próxima pantalla es /login y no se pinta ningún nombre", async ({
    comoA: page,
  }) => {
    await page.goto(`/family/${A.id}`);
    await expect(page.getByRole("heading", { name: A.nombre, exact: true })).toBeVisible();
    await expect(page.getByText("Perfil del integrante")).toBeVisible();

    // Guardia contra un "verde" vacío: si @supabase/ssr cambiara el nombre de
    // sus cookies, borrar por prefijo no borraría nada y la sesión seguiría
    // viva. Se exige que exista al menos una antes de borrarla.
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name.startsWith("sb-")), "no hay cookie sb-* de sesión").toBe(true);
    await page.context().clearCookies({ name: /^sb-/ });

    await page.goto(`/family/${A.id}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=(/|%2F)family(/|%2F)${A.id}$`));
    const main = page.getByRole("main");
    await expect(main).not.toContainText(A.nombre);
    await expect(main).not.toContainText(nombreHogarA);
    await expect(main).not.toContainText("Perfil del integrante");

    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?next=(\/|%2F)onboarding$/);
  });
});

test.describe("§13.e — crear cuenta", () => {
  test("crear cuenta desde /login deja a la cuenta nueva adentro y sin hogar", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/correo/i).fill(CORREO_CUENTA_NUEVA);
    await page.getByLabel(/contraseña/i).fill(CLAVE_SINTETICA);
    await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();
    await expect(page).toHaveURL(/\/(family|login)/);

    const usuario = await usuarioPorCorreo(CORREO_CUENTA_NUEVA);
    expect(usuario, "la cuenta no quedó creada en staging").not.toBeNull();

    if (!usuario!.email_confirmed_at) {
      // Staging exige confirmar el correo: `signUp` no devuelve sesión, así que
      // /family rebota a la puerta. Eso ES correcto — pero el paso siguiente
      // (abrir el link del correo) no se puede automatizar acá; queda en fixme.
      await expect(page).toHaveURL(/\/login\?next=(\/|%2F)family$/);
      test.skip(true, "Staging tiene Confirm Email activado: el paso de confirmación queda en fixme.");
    }

    // Con autoconfirm la cuenta entra al tiro y, como no tiene hogar, Familia
    // le ofrece crearlo. Nada del hogar de otros se ve.
    await expect(page).toHaveURL(/\/family$/);
    await expect(page.getByRole("heading", { name: "Crea tu hogar", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText(nombreHogarA);

    await recargar(page);
    await expect(page.getByRole("heading", { name: "Crea tu hogar", exact: true })).toBeVisible();
  });

  test.fixme(
    "confirmar el correo (Confirm Email) — no se automatiza: staging no expone una bandeja de correo",
    async () => {
      // Cuando staging tenga Confirm Email activado y una bandeja consultable
      // (Inbucket o similar), este caso debe: crear la cuenta, abrir el link
      // del correo, y terminar en /family con "Crea tu hogar".
    },
  );

  test("crear cuenta con un correo que ya existe no mete a nadie en el hogar de otro", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/correo/i).fill(credenciales("A").email);
    await page.getByLabel(/contraseña/i).fill(CLAVE_SINTETICA);
    await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();

    // Con Confirm Email apagado Supabase contesta error ("User already
    // registered", en inglés — ver hallazgos); con Confirm Email prendido
    // contesta un éxito ofuscado SIN sesión y /family rebota. En los dos casos
    // la persona termina en la puerta y jamás dentro del hogar de A.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("main")).not.toContainText(nombreHogarA);
  });

  test.fixme(
    "recuperar / restablecer contraseña (no existe en v1: login/page.tsx no tiene 'Olvidé mi contraseña' ni ruta de reset)",
    async () => {
      // Cuando exista: pedir el link desde /login, abrirlo desde la bandeja de
      // staging, fijar una clave nueva y entrar con ella.
    },
  );
});

test.describe("§13.f — invitación: A invita, B no puede repetirse, C acepta", () => {
  let token: string;

  test("A invita por la interfaz: link de un solo uso, mostrado una vez, solo el hash en la base", async ({
    comoA: page,
  }) => {
    await page.goto("/family");
    await page.getByLabel(/^Correo/).fill(CORREO_C);
    await page.getByLabel("Rol en el hogar").selectOption("MEMBER");
    await page.getByRole("button", { name: "Generar invitación", exact: true }).click();

    await expect(page).toHaveURL(/\/family\?invite=/);
    await expect(page.getByText("Invitación creada")).toBeVisible();
    // 32 bytes en base64url = 43 caracteres de [A-Za-z0-9_-] (domain/family/invitations.ts).
    const ruta = await page.getByText(/^\/invite\/[A-Za-z0-9_-]{20,}$/).textContent();
    if (!ruta) throw new Error("La app no mostró el link de la invitación.");
    token = ruta.slice("/invite/".length);

    // En la base queda el hash (sha256 en hex), nunca el token que viaja.
    const { data: inv, error } = await admin()
      .from("invitations")
      .select("token_hash, role_code, accepted_at, revoked_at, household_id")
      .eq("email", CORREO_C)
      .single();
    if (error) throw new Error(`invitación en la base: ${error.message}`);
    expect(inv.household_id).toBe(A.hogar);
    expect(inv.role_code).toBe("MEMBER");
    expect(inv.accepted_at).toBeNull();
    expect(inv.revoked_at).toBeNull();
    expect(inv.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.token_hash).not.toBe(token);

    // "Se muestra una sola vez": al volver a Familia sin el parámetro, no está.
    await page.goto("/family");
    await expect(page.getByText("Invitación creada")).toHaveCount(0);
    await expect(page.getByText(token)).toHaveCount(0);
  });

  test("B, que ya es del hogar, no puede usarla: la app lo dice y la invitación sigue viva", async ({
    comoB: page,
  }) => {
    await page.goto(`/invite/${token}`);
    await expect(page.getByRole("heading", { name: "Invitación al hogar", exact: true })).toBeVisible();
    await expect(page.getByText("Te invitaron a unirte a un hogar en NutriFamilia.")).toBeVisible();
    await page.getByLabel("Tu nombre").fill("B otra vez");
    await page.getByRole("button", { name: "Unirme al hogar", exact: true }).click();

    await expect(page).toHaveURL(/\/family\?error=/);
    await expect(page.getByRole("alert")).toHaveText("Invitación inválida o expirada");

    // El RPC falló entero: la invitación no se consumió y B sigue siendo UNA
    // ficha, con su nombre de siempre (ni duplicada ni renombrada).
    const B = await fichaDe("B");
    expect(B.hogar).toBe(A.hogar);
    expect(B.nombre).not.toBe("B otra vez");
    const { count, error: errorConteo } = await admin()
      .from("household_members")
      .select("id", { count: "exact", head: true })
      .eq("household_id", A.hogar)
      .eq("user_id", await idDeUsuario("B"));
    if (errorConteo) throw new Error(`fichas de B: ${errorConteo.message}`);
    expect(count).toBe(1);
    const { data: inv, error } = await admin()
      .from("invitations")
      .select("accepted_at")
      .eq("email", CORREO_C)
      .single();
    if (error) throw new Error(`invitación en la base: ${error.message}`);
    expect(inv.accepted_at).toBeNull();
  });

  test("C, cuenta nueva, entra por el link: login con `next`, acepta, y queda en el hogar como Integrante", async ({
    browser,
    comoA,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      // Sin sesión el link manda a la puerta y guarda a dónde volver.
      await page.goto(`/invite/${token}`);
      await expect(page).toHaveURL(/\/login\?next=(\/|%2F)invite(\/|%2F)/);
      await llenarYEntrar(page, { email: CORREO_C, password: CLAVE_SINTETICA });
      await expect(page).toHaveURL(new RegExp(`/invite/${token}$`));
      await expect(page.getByRole("heading", { name: "Invitación al hogar", exact: true })).toBeVisible();

      await page.getByLabel("Tu nombre").fill(NOMBRE_C);
      await page.getByRole("button", { name: "Unirme al hogar", exact: true }).click();
      await expect(page).toHaveURL(/\/family$/);
      await expect(page.getByRole("heading", { name: nombreHogarA, exact: true })).toBeVisible();

      const tarjetaC = page.getByRole("link", { name: new RegExp(NOMBRE_C) });
      await expect(tarjetaC).toBeVisible();
      await expect(tarjetaC).toContainText("Integrante");
      await expect(tarjetaC).not.toContainText("sin cuenta");

      await recargar(page);
      await expect(page.getByRole("link", { name: new RegExp(NOMBRE_C) })).toBeVisible();

      // Lo persistido: ficha vinculada a la cuenta de C, con el sello de
      // vinculación (0033) y SOLO el rol invitado (MEMBER, que además es el
      // rol por defecto de toda ficha nueva, 0039).
      const { data: ficha, error } = await admin()
        .from("household_members")
        .select("id, display_name, is_active, account_linked_at")
        .eq("household_id", A.hogar)
        .eq("user_id", idC)
        .single();
      if (error) throw new Error(`ficha de C: ${error.message}`);
      expect(ficha.display_name).toBe(NOMBRE_C);
      expect(ficha.is_active).toBe(true);
      expect(ficha.account_linked_at).not.toBeNull();
      expect(await rolesDe(ficha.id as string)).toEqual(["MEMBER"]);

      const { data: inv, error: errorInv } = await admin()
        .from("invitations")
        .select("accepted_at, accepted_by")
        .eq("email", CORREO_C)
        .single();
      if (errorInv) throw new Error(`invitación en la base: ${errorInv.message}`);
      expect(inv.accepted_at).not.toBeNull();
      expect(inv.accepted_by).toBe(idC);

      // Un solo uso: el mismo link, ya aceptado, no sirve ni para C.
      await page.goto(`/invite/${token}`);
      await page.getByLabel("Tu nombre").fill(NOMBRE_C);
      await page.getByRole("button", { name: "Unirme al hogar", exact: true }).click();
      await expect(page).toHaveURL(/\/family\?error=/);
      await expect(page.getByRole("alert")).toHaveText("Invitación inválida o expirada");
    } finally {
      await ctx.close();
    }

    // A ve a C en su hogar: la vinculación es del hogar, no de la pestaña de C.
    await comoA.goto("/family");
    await expect(comoA.getByRole("link", { name: new RegExp(NOMBRE_C) })).toBeVisible();
  });
});

test.describe("§13.g — vincular una cuenta a un integrante sin cuenta", () => {
  test.fixme(
    "vincular cuenta a un integrante sin cuenta (no existe en v1: ninguna pantalla crea invitaciones con invited_member_id)",
    async () => {
      // `accept_invitation` (0001:191, 0037) SÍ sabe vincular: si la invitación
      // trae `invited_member_id`, en vez de crear una ficha nueva le pone el
      // `user_id` a la existente. Pero `createInvitation` (family/actions.ts)
      // nunca manda ese campo y no hay UI que lo pida. Cuando exista, este
      // caso debe: A crea un integrante sin cuenta, genera la invitación PARA
      // esa ficha, la cuenta nueva la acepta y la ficha deja de decir
      // "sin cuenta" conservando su nombre y su historia.
    },
  );
});
