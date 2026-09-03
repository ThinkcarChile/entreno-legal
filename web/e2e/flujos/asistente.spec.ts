/**
 * E2E §25 — ASISTENTE: el chat PROPONE, una persona CONFIRMA, el modelo no
 * escribe.
 *
 * LO QUE EXISTE EN v1 Y LO QUE NO. Leído en el código, no supuesto:
 *
 *  · `app/asistente/acciones.ts:enviarTurno` devuelve SIEMPRE `SIN_CONFIGURAR`
 *    y `app/asistente/page.tsx` fija `estado = { k: "SIN_CONFIGURAR" }`. El
 *    composer no llega a ningún proveedor — ni siquiera al falso de
 *    `lib/ai/provider.ts` (que sí existe y sí tiene tests unitarios). El camino
 *    "petición → tool call → propuesta" NO existe de punta a punta en la app.
 *  · `app/asistente/propuesta/acciones.ts:confirmarPropuesta` devuelve SIEMPRE
 *    `NO_DISPONIBLE`: el ejecutor de acciones no está conectado. El camino
 *    "confirmación → acción → EXECUTED" tampoco existe.
 *
 * Lo que SÍ existe, y este archivo afirma del producto:
 *
 *  · La tarjeta de confirmación se arma desde la propuesta PERSISTIDA
 *    (`assistant_proposals`, 0053), nunca desde texto del chat. El verbo, el
 *    efecto y la línea de irreversibilidad salen del mapa congelado de
 *    `presentacion.ts`, y el nombre crudo de la acción se muestra.
 *  · El token de un solo uso lo emite el SERVIDOR al renderizar la tarjeta,
 *    para el actor que la mira (`register_proposal_token`). No hay token sin
 *    tarjeta mirada.
 *  · Una acción de riesgo alto exige el segundo gesto ANTES de mandar nada:
 *    sin la cantidad escrita tal cual, ni viaje al servidor.
 *  · Ninguna de estas pantallas escribe en el dominio: el lote queda idéntico
 *    antes, durante y después de "confirmar", y la propuesta sigue OFFERED.
 *
 * Los casos que no existen van como `test.fixme` con el motivo. No se simulan.
 *
 * Serial a propósito: los pasos comparten la propuesta y el lote sintéticos.
 */
import type { Page } from "@playwright/test";
import { test, expect, recargar, HAY_STAGING } from "../fixtures/contrato";
import { admin, hogarDe, idDeUsuario } from "../fixtures/admin";

test.describe.configure({ mode: "serial" });

/** Un sello por corrida: cuatro anchos corren este archivo y no pueden pisarse. */
const SELLO = `e2e-asistente-${Date.now()}`;
const ETIQUETA_LOTE = "Pollo trutro E2E (sintético)";
/** Gramos. Entran por un movimiento PURCHASE: el trigger de la 0011 es el dueño de `quantity`. */
const CANTIDAD_LOTE = 800;
const PROCEDENCIA = "stock@e2e-1";

interface Ficha {
  id: string;
  nombre: string;
  hogar: string;
}

/**
 * La ficha (household_members) del usuario sintético. Vive acá y no en un
 * módulo compartido porque el contrato dice que un spec importa SOLO de
 * `fixtures/`, y `fixtures/` es del lead.
 */
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
 * Un lote sintético con su cantidad puesta POR UN MOVIMIENTO, no a mano: en
 * este proyecto `inventory_lots.quantity` la mantiene el trigger de la 0011 y
 * escribirla directo sería fabricar stock sin historia.
 */
async function crearLote(ficha: Ficha): Promise<string> {
  const db = admin();
  const { data, error } = await db
    .from("inventory_lots")
    .insert({
      household_id: ficha.hogar,
      label: ETIQUETA_LOTE,
      unit: "G",
      created_by: ficha.id,
    })
    .select("id")
    .single();
  if (error) throw new Error(`inventory_lots: ${error.message}`);
  const lotId = data.id as string;
  const { error: errorMovimiento } = await db.from("inventory_movements").insert({
    household_id: ficha.hogar,
    lot_id: lotId,
    reason: "PURCHASE",
    delta: CANTIDAD_LOTE,
    actor_member_id: ficha.id,
    notes: SELLO,
  });
  if (errorMovimiento) throw new Error(`inventory_movements: ${errorMovimiento.message}`);
  return lotId;
}

/**
 * Una propuesta `discardLot` persistida como la escribiría el runtime del
 * asistente. Va por INSERT directo (service_role) y no por
 * `create_assistant_proposal`, porque ese RPC exige `auth.uid()` y acá no hay
 * sesión: lo que se prueba es la tarjeta y la compuerta, no el RPC de creación.
 */
async function proponerBotarLote(ficha: Ficha, lotId: string, clave: string): Promise<string> {
  const ahora = Date.now();
  const { data, error } = await admin()
    .from("assistant_proposals")
    .insert({
      household_id: ficha.hogar,
      created_by: ficha.id,
      trace_id: `${SELLO}:${clave}`.slice(0, 80),
      accion: "discardLot",
      args: { lotId },
      risk: "ALTO",
      effect: "WRITES_LEDGER",
      origen: "USUARIO",
      requires: [],
      dedupe_key: `${SELLO}:${clave}`,
      basis: {
        capturedAt: new Date(ahora).toISOString(),
        engineVersions: { stock: PROCEDENCIA },
        rows: [],
      },
      resumen: {
        titulo: ETIQUETA_LOTE,
        lineas: [{ etiqueta: "queda en el lote", valor: `${CANTIDAD_LOTE} G` }],
        reasons: [],
        provenance: [{ motor: "stock", version: PROCEDENCIA }],
        unknowns: [],
        irreversible: [],
      },
      expires_at: new Date(ahora + 30 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`assistant_proposals: ${error.message}`);
  return data.id as string;
}

/**
 * Una propuesta viva NO se borra (trigger `propuesta_inmutable`, 0053): se
 * rechaza, con quién y cuándo. Por eso la limpieza es un UPDATE y no un DELETE,
 * y por eso cada corrida usa su propio `dedupe_key`.
 */
async function rechazarPropuestasE2E(ficha: Ficha): Promise<void> {
  const { error } = await admin()
    .from("assistant_proposals")
    .update({ status: "REJECTED", decided_by: ficha.id, decided_at: new Date().toISOString() })
    .eq("household_id", ficha.hogar)
    .eq("status", "OFFERED")
    .like("trace_id", "e2e-asistente-%");
  if (error) throw new Error(`rechazar propuestas E2E: ${error.message}`);
}

async function estadoDePropuesta(id: string): Promise<string> {
  const { data, error } = await admin()
    .from("assistant_proposals")
    .select("status")
    .eq("id", id)
    .single();
  if (error) throw new Error(`propuesta ${id}: ${error.message}`);
  return data.status as string;
}

/** PostgREST devuelve numeric como TEXTO; se convierte acá y en ningún otro lado. */
async function leerLote(lotId: string): Promise<{ cantidad: number; estado: string }> {
  const { data, error } = await admin()
    .from("inventory_lots")
    .select("quantity, status")
    .eq("id", lotId)
    .single();
  if (error) throw new Error(`lote ${lotId}: ${error.message}`);
  return { cantidad: Number(data.quantity), estado: data.status as string };
}

async function contarMovimientos(lotId: string): Promise<number> {
  const { count, error } = await admin()
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("lot_id", lotId);
  if (error) throw new Error(`movimientos de ${lotId}: ${error.message}`);
  if (count === null) throw new Error("PostgREST no devolvió el conteo de movimientos.");
  return count;
}

async function contarFilasDelHogar(tabla: string, hogar: string): Promise<number> {
  const { count, error } = await admin()
    .from(tabla)
    .select("id", { count: "exact", head: true })
    .eq("household_id", hogar);
  if (error) throw new Error(`${tabla}: ${error.message}`);
  if (count === null) throw new Error(`PostgREST no devolvió el conteo de ${tabla}.`);
  return count;
}

async function tokensDe(proposalId: string): Promise<{ member_id: string; used_at: string | null }[]> {
  const { data, error } = await admin()
    .from("assistant_proposal_tokens")
    .select("member_id, used_at")
    .eq("proposal_id", proposalId);
  if (error) throw new Error(`tokens de ${proposalId}: ${error.message}`);
  return (data ?? []) as { member_id: string; used_at: string | null }[];
}

/** La tarjeta de confirmación es el único `article` de /asistente/propuesta/[id]. */
function tarjeta(page: Page) {
  return page.getByRole("article");
}

let A: Ficha;
let B: Ficha;
let lotId: string;
let proposalId: string;

test.beforeAll(async () => {
  if (!HAY_STAGING) return; // sin staging los tests se saltan; el hook no debe fallar
  [A, B] = await Promise.all([fichaDe("A"), fichaDe("B")]);
  if (A.hogar !== B.hogar) throw new Error("A y B tienen que compartir hogar en staging.");
  await rechazarPropuestasE2E(A);
  lotId = await crearLote(A);
  proposalId = await proponerBotarLote(A, lotId, "botar");
});

test.afterAll(async () => {
  if (!HAY_STAGING || !A) return;
  await rechazarPropuestasE2E(A);
  if (lotId) {
    // Borrar el lote arrastra sus movimientos (cascada, permitida por el
    // append-only de la 0011 cuando la profundidad del trigger es > 1).
    const { error } = await admin().from("inventory_lots").delete().eq("id", lotId);
    if (error) throw new Error(`limpiar lote: ${error.message}`);
  }
});

test.describe("§25.a — el chat de v1 no está conectado a ningún proveedor, y lo dice con su nombre", () => {
  test("preguntar no llega a ninguna parte: caída nombrada, atajos que funcionan, cero filas nuevas", async ({
    comoA: page,
  }) => {
    const propuestasAntes = await contarFilasDelHogar("assistant_proposals", A.hogar);
    const conversacionesAntes = await contarFilasDelHogar("assistant_conversations", A.hogar);

    await page.goto("/asistente");
    await expect(page.getByRole("heading", { name: "Asistente", exact: true })).toBeVisible();
    await expect(page.getByText("Te propongo; tú confirmas")).toBeVisible();

    // Lo determinista va ARRIBA y no depende del proveedor: la pantalla sirve
    // para algo aunque la IA no exista.
    await expect(page.getByRole("link", { name: "¿Qué tengo pendiente?" })).toBeVisible();
    await expect(page.getByRole("link", { name: "¿Qué cocino hoy?" })).toBeVisible();
    await expect(
      page.getByText("Estas no pasan por la IA: las calculan los motores de la casa."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pendientes de la casa" })).toBeVisible();

    // La caída viene NOMBRADA antes de escribir, con su atajo. Nunca "algo salió mal".
    const caida = page.getByText("El asistente no está configurado en esta instalación.");
    await expect(caida).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Ver los pendientes" }).first()).toBeVisible();

    await page.getByLabel("Pregúntame algo de la casa").fill("¿Cuánto pollo queda?");
    await page.getByRole("button", { name: "Preguntar" }).click();

    // El turno de la persona se ve, y la respuesta es OTRA caída con nombre —
    // no silencio, que se leería como "no hay nada que decir".
    await expect(page.getByText("¿Cuánto pollo queda?", { exact: true })).toBeVisible();
    await expect(caida).toHaveCount(2);

    // Nada se persistió: ni propuesta ni conversación. El texto no tiene a
    // dónde ir, y no se guarda "por si acaso".
    expect(await contarFilasDelHogar("assistant_proposals", A.hogar)).toBe(propuestasAntes);
    expect(await contarFilasDelHogar("assistant_conversations", A.hogar)).toBe(conversacionesAntes);
  });

  test.fixme(
    "petición de lectura → tool call → respuesta con procedencia y unknowns (no existe en v1: enviarTurno devuelve SIN_CONFIGURAR y nunca llama al router ni al proveedor falso)",
    async () => {},
  );

  test.fixme(
    "petición de escritura → propuesta persistida con enlace 'Ver la propuesta y confirmar' (no existe en v1: el chat no crea propuestas; la tarjeta solo se alcanza con una propuesta ya guardada)",
    async () => {},
  );
});

test.describe("§25.b — la tarjeta de confirmación es el único gesto que autoriza", () => {
  test("A ve la propuesta persistida: verbo real, acción cruda, riesgo, números del motor, irreversible y su nombre", async ({
    comoA: page,
  }) => {
    await page.goto(`/asistente/propuesta/${proposalId}`);
    await expect(page.getByRole("heading", { name: "Confirmar", exact: true })).toBeVisible();
    await expect(page.getByText("Lo decides tú, no el chat")).toBeVisible();

    const card = tarjeta(page);
    // 1. QUÉ: el verbo sale del mapa congelado, no de la fila; y el nombre
    //    crudo de la acción se muestra para que se pueda buscar y reclamar.
    await expect(card.getByRole("heading", { name: "Botar un lote" })).toBeVisible();
    await expect(card).toContainText("discardLot");
    await expect(card).toContainText("Riesgo alto");
    await expect(card).toContainText("mueve inventario");
    // 3. SOBRE QUÉ: el nombre del lote se lee como DATO de la casa, entre comillas.
    await expect(card.locator('[data-origen="hogar"]').first()).toContainText(ETIQUETA_LOTE);
    // 2. CON QUÉ NÚMEROS: tal como los devolvió el motor, sin "≈" porque está medido.
    await expect(card).toContainText(`${CANTIDAD_LOTE} G`);
    // 4. QUÉ NO SE DESHACE: la línea de POLITICA, no la de la fila.
    await expect(card).toContainText(
      "Es merma: la comida se da por perdida y no vuelve al inventario.",
    );
    // 5. QUIÉN CONFIRMA: el nombre que queda en la auditoría.
    await expect(card).toContainText(`Queda a tu nombre: ${A.nombre}`);
    // Procedencia: sin ella la cifra no se puede auditar.
    await card.getByText("¿Por qué?").click();
    await expect(card).toContainText(`Calculado con ${PROCEDENCIA}`);

    // El segundo gesto de riesgo alto está pedido, y el botón lleva el verbo.
    await expect(card.getByLabel(/escribe la cantidad de arriba/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Botar un lote" })).toBeVisible();
    await expect(
      page.getByText("El asistente no ejecuta nada por su cuenta: esta tarjeta es el gesto que autoriza"),
    ).toBeVisible();

    // El token nació en el servidor, para ESTE actor, al mirar la tarjeta. Y
    // sigue vivo: mirar no es confirmar.
    const tokens = await tokensDe(proposalId);
    expect(tokens.filter((t) => t.member_id === A.id && t.used_at === null)).toHaveLength(1);
  });

  test("sin el segundo gesto correcto no viaja nada: la propuesta sigue OFFERED y el lote no se mueve", async ({
    comoA: page,
  }) => {
    await page.goto(`/asistente/propuesta/${proposalId}`);
    const card = tarjeta(page);
    const boton = card.getByRole("button", { name: "Botar un lote" });

    // Vacío: se pide la cantidad.
    await boton.click();
    await expect(card.getByText("Escribe la cantidad de la tarjeta para confirmar.")).toBeVisible();

    // Un número que no es el de la tarjeta: se niega, sin tolerancia. Teclear
    // 80 donde dice 800 no puede terminar botando 80 ni 800.
    await card.getByLabel(/escribe la cantidad de arriba/).fill("80");
    await boton.click();
    await expect(
      card.getByText("Ese número no es el de la tarjeta. Escríbelo tal cual para confirmar."),
    ).toBeVisible();

    // Nada cambió en la base: ni la propuesta, ni el lote, ni el token.
    expect(await estadoDePropuesta(proposalId)).toBe("OFFERED");
    expect(await leerLote(lotId)).toEqual({ cantidad: CANTIDAD_LOTE, estado: "AVAILABLE" });
    expect(await contarMovimientos(lotId)).toBe(1);
    const tokens = await tokensDe(proposalId);
    expect(tokens.every((t) => t.used_at === null)).toBe(true);
  });

  test("con el gesto correcto, v1 responde que el ejecutor no existe y NO escribe nada", async ({
    comoA: page,
  }) => {
    await page.goto(`/asistente/propuesta/${proposalId}`);
    const card = tarjeta(page);
    await card.getByLabel(/escribe la cantidad de arriba/).fill(String(CANTIDAD_LOTE));
    await card.getByRole("button", { name: "Botar un lote" }).click();

    // El recibo dice la verdad de v1: no hay ejecutor, y por eso no se tocó
    // nada. Es NO_DISPONIBLE, no SIN_CERTEZA: se sabe que no se escribió.
    await expect(card.getByText(/No pude ejecutarlo/)).toBeVisible();
    await expect(card.getByText(/No se escribió nada\./)).toBeVisible();
    // El botón desaparece con el recibo: un recibo no se vuelve a confirmar.
    await expect(card.getByRole("button", { name: "Botar un lote" })).toHaveCount(0);

    // Regla 4 del contrato: lo que cuenta es lo persistido. Al recargar, la
    // tarjeta vuelve a ser confirmable porque NADA cambió en la base.
    await recargar(page);
    await expect(tarjeta(page).getByRole("button", { name: "Botar un lote" })).toBeVisible();

    expect(await estadoDePropuesta(proposalId)).toBe("OFFERED");
    expect(await leerLote(lotId)).toEqual({ cantidad: CANTIDAD_LOTE, estado: "AVAILABLE" });
    expect(await contarMovimientos(lotId)).toBe(1);
  });

  test.fixme(
    "confirmación → claimProposal (compuerta) → runActionTool → EXECUTED con recibo real (no existe en v1: confirmarPropuesta devuelve NO_DISPONIBLE sin llamar a take_assistant_proposal)",
    async () => {},
  );

  test("B, del mismo hogar, ve la tarjeta a SU nombre y sabe quién la propuso", async ({
    comoB: page,
  }) => {
    await page.goto(`/asistente/propuesta/${proposalId}`);
    const card = tarjeta(page);
    await expect(card.getByRole("heading", { name: "Botar un lote" })).toBeVisible();
    // Quien confirma queda en la auditoría con SU nombre, y la tarjeta dice
    // que la propuso otra persona: nadie confirma creyendo que es suya.
    await expect(card).toContainText(`Queda a tu nombre: ${B.nombre}`);
    await expect(card).toContainText(`lo propuso ${A.nombre}`);

    // Un token distinto, para B: el de A no le sirve a nadie más.
    const tokens = await tokensDe(proposalId);
    expect(tokens.filter((t) => t.member_id === B.id && t.used_at === null)).toHaveLength(1);
    expect(await estadoDePropuesta(proposalId)).toBe("OFFERED");
  });
});
