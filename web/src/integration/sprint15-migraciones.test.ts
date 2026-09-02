import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";
import {
  generarConfirmationToken,
  hashConfirmationToken,
} from "@/domain/assistant/proposal";

/**
 * Sprint 15 — las migraciones del asistente (0050..0058).
 *
 * ---------------------------------------------------------------------------
 * LO QUE ESTE ARCHIVO ESTÁ PROBANDO DE VERDAD
 * ---------------------------------------------------------------------------
 *
 * EL CHAT NO ES EL BOTÓN. Un asistente que ejecuta porque alguien se lo pidió
 * en lenguaje natural ejecuta lo que le pida cualquier texto que alcance a
 * leer: una boleta escaneada, el nombre de un alimento, la nota de bodega
 * pegada adentro de una receta.
 *
 * La defensa no es una frase en el prompt —la prosa se puede convencer— sino
 * un camino de código que no existe. El asistente PROPONE (escribe una fila) y
 * una persona CONFIRMA (toca un control que el modelo no puede emitir). Cada
 * test de acá abajo mira una pieza de ese camino y se cae si alguien la saca.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ LAS MIGRACIONES SE APLICAN ACÁ ADENTRO
 * ---------------------------------------------------------------------------
 *
 * `harness.ts` NO es de esta tarea (lo comparten cuatro frentes en paralelo) y
 * su cadena llega hasta la 0038. Así que este archivo aplica la 0039 —dueña de
 * `can_edit_plan`/`can_cook`, que la 0050 usa y NO redefine— y después la banda
 * 0050..0058, igual que hace `permisos-plan.test.ts` con la 0039.
 *
 * La comprobación de "¿ya está?" mira el SCHEMA y no el archivo: el día que el
 * arnés las incorpore, esto no hace nada y los tests siguen midiendo lo mismo.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const MIGRACIONES = path.join(RAIZ, "supabase/migrations");

const BANDA = [
  "0039_permisos_plan_y_cocina.sql",
  "0050_asistente_ambito.sql",
  "0051_asistente_consentimiento.sql",
  "0052_asistente_sellos.sql",
  "0053_asistente_propuestas.sql",
  "0054_asistente_conversaciones.sql",
  "0055_asistente_auditoria.sql",
  "0056_asistente_inbox.sql",
  "0057_asistente_presupuesto.sql",
  "0058_idempotencia_acciones.sql",
];

const USER_ANA = "00000000-0000-0000-0000-000000001501"; // administra el hogar
const USER_BETO = "00000000-0000-0000-0000-000000001502"; // integrante con cuenta
const USER_CARLA = "00000000-0000-0000-0000-000000001503"; // otro hogar

let h: Harness;
let hogar: { householdId: string; memberId: string };
let otroHogar: { householdId: string; memberId: string };
let miembroBeto: string;

interface Intento {
  ok: boolean;
  mensaje: string | null;
}

async function intentar(sql: string, params: unknown[] = []): Promise<Intento> {
  try {
    await h.db.query(sql, params);
    return { ok: true, mensaje: null };
  } catch (e) {
    return { ok: false, mensaje: (e as Error).message };
  }
}

/** Agrega un integrante CON cuenta por el camino legítimo: invitación + aceptación. */
async function invitar(userId: string, nombre: string, roleCode: string): Promise<string> {
  const token = `s15-token-${nombre.toLowerCase()}`;
  await h.comoAdmin(() =>
    h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `${nombre.toLowerCase()}@sprint15.dev`,
    ]),
  );
  await h.como(USER_ANA, () =>
    h.db.query(
      `insert into public.invitations (household_id, token_hash, role_code, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [hogar.householdId, token, roleCode],
    ),
  );
  await h.como(userId, () =>
    h.db.query("select public.accept_invitation($1, $2)", [token, nombre]),
  );
  return h.comoAdmin(
    async () =>
      (await h.fila<{ id: string }>(
        "select id from public.household_members where household_id = $1 and user_id = $2",
        [hogar.householdId, userId],
      ))!.id,
  );
}

const BASIS = JSON.stringify({
  capturedAt: "2026-09-01T20:00:00Z",
  engineVersions: { stock: "stock/1.0.0" },
  rows: [],
});

const RESUMEN = JSON.stringify({ titulo: "Usar 2,0 kg de pollo", lineas: [], irreversible: [] });

/**
 * Emite un token igual que lo hace la pantalla: el SECRETO nace en el servidor
 * de aplicación y a la base solo llega su hash, calculado por la función del
 * dominio. Lo que se le pasa después a `take_assistant_proposal` es ese mismo
 * hash.
 *
 * Que este helper importe `hashConfirmationToken` DE PRODUCCIÓN es el punto: es
 * la prueba de que las dos mitades de la compuerta hablan el mismo idioma. Si
 * alguien le cambia la receta al dominio (o se la devuelve a la base, que
 * hasheaba con md5 por su cuenta), estos tests se caen enteros.
 */
async function emitirToken(
  id: string,
  memberId: string,
  usuario: string = USER_ANA,
): Promise<string> {
  const secreto = generarConfirmationToken();
  const hash = hashConfirmationToken(secreto, id, memberId);
  const vence = await h.comoAdmin(
    async () =>
      (await h.fila<{ expires_at: string }>(
        "select expires_at from public.assistant_proposals where id = $1",
        [id],
      ))!.expires_at,
  );
  await h.como(usuario, () =>
    h.db.query("select public.register_proposal_token($1, $2, $3)", [id, hash, vence]),
  );
  return hash;
}

/** Crea una propuesta y devuelve su id. Por omisión, sin capacidades exigidas. */
async function proponer(
  opciones: {
    dedupe?: string;
    requires?: unknown;
    ttl?: number;
    accion?: string;
    efecto?: string;
    origen?: "USUARIO" | "MOTOR";
  } = {},
): Promise<string> {
  const fila = await h.fila<{ create_assistant_proposal: string }>(
    `select public.create_assistant_proposal(
       $1, 'traza-' || gen_random_uuid()::text, $2, '{"lotId":"x"}'::jsonb,
       'ALTO', $9, $3::public.assistant_intent_origin, $4::jsonb, $5,
       $6::jsonb, $7::jsonb, $8)`,
    [
      hogar.householdId,
      opciones.accion ?? "qrUseLot",
      opciones.origen ?? "USUARIO",
      JSON.stringify(opciones.requires ?? []),
      opciones.dedupe ?? `USE_LOT:${Math.random()}`,
      BASIS,
      RESUMEN,
      opciones.ttl ?? 15,
      opciones.efecto ?? "WRITES_LEDGER",
    ],
  );
  return fila!.create_assistant_proposal;
}

/** Deja VIVO el consentimiento clinico de un integrante. Idempotente. */
async function consentirClinico(userId: string, memberId: string): Promise<void> {
  await h.como(userId, () =>
    h.db.query(
      "select public.set_assistant_consent($1, 'ASSISTANT_CLINICAL', $2, 'proveedor', 'v1', true)",
      [hogar.householdId, memberId],
    ),
  );
}

async function revocarClinico(userId: string, memberId: string): Promise<void> {
  await h.como(userId, () =>
    h.db.query(
      "select public.set_assistant_consent($1, 'ASSISTANT_CLINICAL', $2, 'proveedor', 'v1', false)",
      [hogar.householdId, memberId],
    ),
  );
}

/** Los sellos de un basis, por el mismo camino que usa la frontera. */
async function sellos(
  userId: string,
  filas: readonly { table: string; id: string }[],
): Promise<Record<string, string>> {
  const fila = await h.como(userId, () =>
    h.fila<{ r: Record<string, string> }>(
      "select public.assistant_row_stamps($1::jsonb) as r",
      [JSON.stringify(filas)],
    ),
  );
  return fila!.r;
}

/** Una restriccion clinica de verdad, con el mismo molde en todos los tests. */
async function restriccionDe(memberId: string): Promise<string> {
  return h.comoAdmin(
    async () =>
      (await h.fila<{ id: string }>(
        `insert into public.member_clinical_restrictions
           (member_id, type, target, severity, source)
         values ($1, 'NUTRIENT_MAX', 'sodium_mg', 'HARD', 'CLINICIAN_ENTERED')
         returning id`,
        [memberId],
      ))!.id,
  );
}

beforeAll(async () => {
  h = await levantarBase();

  // Idempotente contra el schema, no contra el disco: si el arnés ya las trae,
  // esto no hace nada. Una migración aplicada dos veces reventaría en el
  // `create type`, y ese rojo no diría nada útil.
  const ya = await h.comoAdmin(() =>
    h.fila("select 1 where to_regclass('public.assistant_proposals') is not null"),
  );
  if (!ya) {
    await h.comoAdmin(async () => {
      for (const archivo of BANDA) {
        await h.db.exec(readFileSync(path.join(MIGRACIONES, archivo), "utf8"));
      }
    });
  }

  hogar = await crearHogar(h, USER_ANA, "Hogar Asistente", "Ana");
  otroHogar = await crearHogar(h, USER_CARLA, "Hogar Vecino", "Carla");
  miembroBeto = await invitar(USER_BETO, "Beto", "MEMBER");
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------

describe("0050 — el ámbito: qué ids puede nombrar el asistente", () => {
  it("una tabla fuera de la lista blanca REVIENTA, no devuelve null", async () => {
    // Un `null` diría "esta fila no es de ningún hogar", que es una respuesta.
    // Lo cierto es que no hubo pregunta válida. ERROR != VACÍO.
    const r = await h.como(USER_ANA, () =>
      intentar("select app.row_scope('auth.users', $1)", [hogar.memberId]),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("lista blanca");
  });

  it("resuelve el hogar real de la fila, incluso si es de otra casa", async () => {
    const propio = await h.como(USER_ANA, () =>
      h.fila<{ row_scope: string }>("select app.row_scope('household_members', $1)", [
        hogar.memberId,
      ]),
    );
    expect(propio!.row_scope).toBe(hogar.householdId);

    // La fila ajena NO se convierte en propia por preguntarlo desde acá: el
    // ámbito dice la verdad y es `row_reachable` quien niega.
    const ajeno = await h.como(USER_ANA, () =>
      h.fila<{ row_scope: string }>("select app.row_scope('household_members', $1)", [
        otroHogar.memberId,
      ]),
    );
    expect(ajeno!.row_scope).toBe(otroHogar.householdId);

    const alcanzable = await h.como(USER_ANA, () =>
      h.fila<{ row_reachable: boolean }>("select app.row_reachable('household_members', $1, $2)", [
        otroHogar.memberId,
        hogar.householdId,
      ]),
    );
    expect(alcanzable!.row_reachable).toBe(false);
  });

  it("un id CLÍNICO del propio hogar pasa el ámbito y NO pasa row_reachable sin grant", async () => {
    const restriccion = await restriccionDe(miembroBeto);

    // Ana administra la casa y el ámbito la deja pasar: la fila ES de su hogar.
    const ambito = await h.como(USER_ANA, () =>
      h.fila<{ row_scope: string }>("select app.row_scope('member_clinical_restrictions', $1)", [
        restriccion,
      ]),
    );
    expect(ambito!.row_scope).toBe(hogar.householdId);

    // Y sin embargo no la alcanza: ámbito y capacidad se resuelven JUNTOS, para
    // que un olvido en `requires()` no abra la puerta entera.
    const alcanzaAna = await h.como(USER_ANA, () =>
      h.fila<{ row_reachable: boolean }>(
        "select app.row_reachable('member_clinical_restrictions', $1, $2)",
        [restriccion, hogar.householdId],
      ),
    );
    expect(alcanzaAna!.row_reachable).toBe(false);

    // Y NI SIQUIERA el dueño mientras no haya consentido: son DOS llaves y no
    // una. La primera es de quien lee ("¿te dejaron ver esto?"); la segunda es
    // del dueño de los datos ("¿dijiste que sí a que el asistente los use?").
    // Que el hogar haya aceptado el asistente no autoriza a nadie a mandar los
    // exámenes de Beto.
    const sinConsentir = await h.como(USER_BETO, () =>
      h.fila<{ row_reachable: boolean }>(
        "select app.row_reachable('member_clinical_restrictions', $1, $2)",
        [restriccion, hogar.householdId],
      ),
    );
    expect(sinConsentir!.row_reachable).toBe(false);

    // Con las dos llaves, sí.
    await consentirClinico(USER_BETO, miembroBeto);
    const alcanzaBeto = await h.como(USER_BETO, () =>
      h.fila<{ row_reachable: boolean }>(
        "select app.row_reachable('member_clinical_restrictions', $1, $2)",
        [restriccion, hogar.householdId],
      ),
    );
    expect(alcanzaBeto!.row_reachable).toBe(true);

    // Y revocar apaga la puerta en el mismo paso: un consentimiento que no se
    // puede revocar no es un consentimiento, es un aviso.
    await revocarClinico(USER_BETO, miembroBeto);
    const trasRevocar = await h.como(USER_BETO, () =>
      h.fila<{ row_reachable: boolean }>(
        "select app.row_reachable('member_clinical_restrictions', $1, $2)",
        [restriccion, hogar.householdId],
      ),
    );
    expect(trasRevocar!.row_reachable).toBe(false);
  });

  it("las capacidades clínicas las apaga el consentimiento, y dicen POR QUÉ", async () => {
    /**
     * `assistant_capabilities` es lo único que el asistente le pregunta a la
     * base antes de tocar la ficha de alguien. Si contestara el permiso pelado,
     * contestaría otra pregunta: "¿te dejaron leer?" y no "¿puedes USAR esto en
     * este turno?". El consentimiento del dueño va adentro de la respuesta, y
     * `ai_consent` viaja al lado para que "no tienes acceso" y "esta persona no
     * ha consentido" no se vean iguales en pantalla.
     */
    const lista = `{${miembroBeto}}`;
    const capacidades = async (userId: string) =>
      (await h.como(userId, () =>
        h.fila<{ assistant_capabilities: { medical: Record<string, unknown> } }>(
          "select public.assistant_capabilities($1, $2::uuid[])",
          [hogar.householdId, lista],
        ),
      ))!.assistant_capabilities.medical[miembroBeto];

    expect(await capacidades(USER_BETO)).toEqual({
      read_labs: false,
      restrictions: false,
      confirm_labs: false,
      ai_consent: false,
    });

    await consentirClinico(USER_BETO, miembroBeto);
    expect(await capacidades(USER_BETO)).toEqual({
      read_labs: true,
      restrictions: true,
      confirm_labs: true,
      ai_consent: true,
    });

    // Ana administra la casa y Beto ya consintió: el consentimiento de Beto NO
    // le presta a Ana un permiso que nadie le dio.
    expect(await capacidades(USER_ANA)).toEqual({
      read_labs: false,
      restrictions: false,
      confirm_labs: false,
      ai_consent: true,
    });

    await revocarClinico(USER_BETO, miembroBeto);
  });

  it("mirar los objetivos de otro sigue siendo de todos; editárselos, no", async () => {
    /**
     * Las cinco tablas de perfil de la 0005 nacieron con UNA política
     * `for all using (can_access_member)`, y `can_access_member` es "está en tu
     * hogar". Mientras eso lo hacía una pantalla era un permiso flojo; con un
     * asistente que puede proponer `setTrackingMode` sobre otro integrante, es
     * una escritura ajena a un toque de distancia.
     */
    const metaDeAna = await h.comoAdmin(
      async () =>
        (await h.fila<{ id: string }>(
          `insert into public.nutrition_goals (member_id, goal_type, preferred, unit)
           values ($1, 'PROTEIN_G', 120, 'g') returning id`,
          [hogar.memberId],
        ))!.id,
    );

    // Beto la VE: la familia planifica junta y el optimizador necesita los
    // objetivos de todos.
    const vista = await h.como(USER_BETO, () =>
      h.filas("select id from public.nutrition_goals where id = $1", [metaDeAna]),
    );
    expect(vista).toHaveLength(1);

    // Y no la toca.
    const escritura = await h.como(USER_BETO, () =>
      intentar("update public.nutrition_goals set preferred = 40 where id = $1", [metaDeAna]),
    );
    const despues = await h.comoAdmin(() =>
      h.fila<{ preferred: string }>("select preferred from public.nutrition_goals where id = $1", [
        metaDeAna,
      ]),
    );
    expect(Number(despues!.preferred)).toBe(120);
    expect(escritura.ok && Number(despues!.preferred) === 40).toBe(false);
  });

  it("quien administra tampoco le edita el perfil a un adulto con cuenta propia", async () => {
    const metaDeBeto = await h.comoAdmin(
      async () =>
        (await h.fila<{ id: string }>(
          `insert into public.nutrition_goals (member_id, goal_type, preferred, unit)
           values ($1, 'ENERGY_KCAL', 2000, 'kcal') returning id`,
          [miembroBeto],
        ))!.id,
    );

    await h.como(USER_ANA, () =>
      intentar("update public.nutrition_goals set preferred = 900 where id = $1", [metaDeBeto]),
    );
    const despues = await h.comoAdmin(() =>
      h.fila<{ preferred: string }>("select preferred from public.nutrition_goals where id = $1", [
        metaDeBeto,
      ]),
    );
    expect(Number(despues!.preferred)).toBe(2000);
  });

  it("la ficha SIN cuenta —la guagua, el abuelo— sí la mantiene quien administra", async () => {
    // No es una concesión: es el caso real de quien no entra a la app. En
    // cuanto la ficha tiene user_id hay alguien que puede hablar por sí mismo.
    const abuelo = await h.comoAdmin(
      async () =>
        (await h.fila<{ id: string }>(
          `insert into public.household_members (household_id, display_name)
           values ($1, 'Abuelo') returning id`,
          [hogar.householdId],
        ))!.id,
    );

    const r = await h.como(USER_ANA, () =>
      intentar(
        `insert into public.nutrition_goals (member_id, goal_type, preferred, unit)
         values ($1, 'PROTEIN_G', 80, 'g')`,
        [abuelo],
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("la política vieja quedó BORRADA, no acompañada", async () => {
    // Las políticas de Postgres se suman con OR: dejar viva la permisiva y
    // agregar una estricta al lado no aprieta nada, y queda con cara de
    // arreglado. Este test mira el catálogo, no el comportamiento, porque el
    // comportamiento con las dos vivas es idéntico al de antes.
    const viejas = await h.comoAdmin(() =>
      h.filas<{ policyname: string }>(
        `select policyname from pg_policies
          where schemaname = 'public'
            and policyname in ('goals_all','tracking_all','patterns_all',
                               'preferences_all','daily_plans_all')`,
      ),
    );
    expect(viejas).toEqual([]);
  });

  it("quien no es del hogar recibe {member:false} y NADA más", async () => {
    const r = await h.como(USER_CARLA, () =>
      h.fila<{ assistant_capabilities: Record<string, unknown> }>(
        "select public.assistant_capabilities($1)",
        [hogar.householdId],
      ),
    );
    expect(r!.assistant_capabilities).toEqual({ member: false });
  });

  it("una capacidad que no se entiende NIEGA", async () => {
    const r = await h.como(USER_ANA, () =>
      h.fila<{ capabilities_ok: boolean }>("select app.capabilities_ok($1, $2::jsonb)", [
        hogar.householdId,
        '[{"k":"SUPERPODER"}]',
      ]),
    );
    // Ignorar la capacidad desconocida haría que un error de tipeo en `requires`
    // abriera una tarjeta clínica a todo el hogar.
    expect(r!.capabilities_ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("0051/0052 — consentimiento vivo y fotos que envejecen", () => {
  it("el consentimiento del hogar lo da quien administra, y se revoca", async () => {
    const noAdmin = await h.como(USER_BETO, () =>
      intentar(
        "select public.set_assistant_consent($1, 'ASSISTANT_HOUSEHOLD', null, 'p', 'v1', true)",
        [hogar.householdId],
      ),
    );
    expect(noAdmin.ok).toBe(false);

    await h.como(USER_ANA, () =>
      h.db.query(
        "select public.set_assistant_consent($1, 'ASSISTANT_HOUSEHOLD', null, 'p', 'v1', true)",
        [hogar.householdId],
      ),
    );
    const vivo = await h.como(USER_ANA, () =>
      h.fila<{ assistant_consent_ok: boolean }>(
        "select app.assistant_consent_ok($1, 'ASSISTANT_HOUSEHOLD')",
        [hogar.householdId],
      ),
    );
    expect(vivo!.assistant_consent_ok).toBe(true);

    await h.como(USER_ANA, () =>
      h.db.query(
        "select public.set_assistant_consent($1, 'ASSISTANT_HOUSEHOLD', null, 'p', 'v1', false)",
        [hogar.householdId],
      ),
    );
    const muerto = await h.como(USER_ANA, () =>
      h.fila<{ assistant_consent_ok: boolean }>(
        "select app.assistant_consent_ok($1, 'ASSISTANT_HOUSEHOLD')",
        [hogar.householdId],
      ),
    );
    expect(muerto!.assistant_consent_ok).toBe(false);

    // Revocar CIERRA la fila, no la borra: quién dijo que sí y cuándo es parte
    // del expediente, y quién lo revocó también.
    const historia = await h.como(USER_ANA, () =>
      h.filas<{ revoked_by: string | null }>(
        `select revoked_by from public.household_ai_consents
          where household_id = $1 and scope = 'ASSISTANT_HOUSEHOLD'`,
        [hogar.householdId],
      ),
    );
    expect(historia).toHaveLength(1);
    expect(historia[0]!.revoked_by).toBe(hogar.memberId);
  });

  it("el consentimiento clínico no lo puede dar quien administra la casa", async () => {
    // Que alguien administre el hogar no lo hace dueño de los exámenes de otro.
    const ana = await h.como(USER_ANA, () =>
      intentar(
        "select public.set_assistant_consent($1, 'ASSISTANT_CLINICAL', $2, 'p', 'v1', true)",
        [hogar.householdId, miembroBeto],
      ),
    );
    expect(ana.ok).toBe(false);

    const beto = await h.como(USER_BETO, () =>
      intentar(
        "select public.set_assistant_consent($1, 'ASSISTANT_CLINICAL', $2, 'p', 'v1', true)",
        [hogar.householdId, miembroBeto],
      ),
    );
    expect(beto.ok).toBe(true);
  });

  it("el consentimiento clínico no lo delega quien sólo tiene el grant de lectura", async () => {
    /**
     * `medical_access(p_member,'READ_LABS')` incluye a los GRANTEES: con esa
     * pregunta, quien recibió "puedes leer mis exámenes" quedaba habilitado
     * para autorizar que esos exámenes salieran a un proveedor externo. Leer y
     * delegar son decisiones de distinta naturaleza, y la segunda el titular
     * nunca la entregó.
     */
    const grant = await h.como(
      USER_BETO,
      async () =>
        (await h.fila<{ grant_medical_access: string }>(
          "select public.grant_medical_access($1, $2, 'READ_LABS')",
          [miembroBeto, hogar.memberId],
        ))!.grant_medical_access,
    );

    const puedeLeer = await h.como(USER_ANA, () =>
      h.fila<{ medical_access: boolean }>("select app.medical_access($1, 'READ_LABS')", [
        miembroBeto,
      ]),
    );
    expect(puedeLeer!.medical_access).toBe(true);

    const consiente = await h.como(USER_ANA, () =>
      intentar(
        "select public.set_assistant_consent($1, 'ASSISTANT_CLINICAL', $2, 'p', 'v1', true)",
        [hogar.householdId, miembroBeto],
      ),
    );
    expect(consiente.ok).toBe(false);
    expect(consiente.mensaje).toContain("no autorizado");

    await h.como(USER_BETO, () =>
      h.db.query("select public.revoke_medical_access($1)", [grant]),
    );
  });

  it("el sello de una fila que ya no está dice AUSENTE, no null", async () => {
    const lote = await h.como(USER_ANA, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Sello', 100, 'G')",
        [hogar.householdId],
      ))!.add_manual_lot,
    );

    const antes = await h.como(USER_ANA, () =>
      h.fila<{ row_stamp: string }>("select app.row_stamp('inventory_lots', $1)", [lote]),
    );
    expect(antes!.row_stamp).not.toBe("AUSENTE");

    // La foto envejece: otro integrante ocupó parte del lote.
    await h.como(USER_ANA, () => h.db.query("select public.use_lot($1, 40)", [lote]));
    const despues = await h.como(USER_ANA, () =>
      h.fila<{ row_stamp: string }>("select app.row_stamp('inventory_lots', $1)", [lote]),
    );
    expect(despues!.row_stamp).not.toBe(antes!.row_stamp);

    // Y la fila que no existe tiene una respuesta con todas sus letras: "no
    // pude calcularlo" y "no cambió" no pueden verse iguales.
    const fantasma = await h.como(USER_ANA, () =>
      h.fila<{ row_stamp: string }>("select app.row_stamp('inventory_lots', $1)", [
        "00000000-0000-0000-0000-0000000000ff",
      ]),
    );
    expect(fantasma!.row_stamp).toBe("AUSENTE");
  });

  it("el sello de una fila clínica exige lo mismo que el ámbito, no sólo el hogar", async () => {
    /**
     * El sello es el md5 de la fila ENTERA. No dice el contenido, pero confirma
     * que ese id clínico existe en esta casa y delata CADA cambio con su hora,
     * que es justo la metadata que la 0050 declara fuera del alcance de quien
     * no tiene el permiso. Con `is_household_member` alcanzaba para llevárselo:
     * la fila clínica de Beto SÍ es del hogar de Ana.
     */
    const restriccion = await restriccionDe(miembroBeto);
    const fila = [{ table: "member_clinical_restrictions", id: restriccion }];

    const ana = await sellos(USER_ANA, fila);
    expect(ana[restriccion]).toBe("AUSENTE");

    await consentirClinico(USER_BETO, miembroBeto);
    const beto = await sellos(USER_BETO, fila);
    expect(beto[restriccion]).not.toBe("AUSENTE");

    // Y para quien SÍ la alcanza el sello sigue haciendo su trabajo: cambia
    // cuando la fila cambia. Un AUSENTE para todos también pasaría el test de
    // arriba y no serviría para nada.
    await h.comoAdmin(() =>
      h.db.query(
        "update public.member_clinical_restrictions set severity = 'CAUTION' where id = $1",
        [restriccion],
      ),
    );
    const betoDespues = await sellos(USER_BETO, fila);
    expect(betoDespues[restriccion]).not.toBe("AUSENTE");
    expect(betoDespues[restriccion]).not.toBe(beto[restriccion]);

    // Revocado el consentimiento, la puerta se cierra por el mismo lado.
    await revocarClinico(USER_BETO, miembroBeto);
    const trasRevocar = await sellos(USER_BETO, fila);
    expect(trasRevocar[restriccion]).toBe("AUSENTE");
  });

  it("el sello no es un oráculo: la fila ajena y el uuid inventado contestan lo MISMO", async () => {
    /**
     * Una fila de otra casa que contesta "no autorizado" mientras un uuid
     * inventado contesta AUSENTE es un oráculo de existencia: la diferencia
     * sola confirma que la fila ajena existe, y se prueba id por id sin ruido.
     * No existe, es de otra casa y es clínica sin permiso tienen que verse
     * iguales desde afuera.
     */
    const inventado = "00000000-0000-0000-0000-0000000000fe";
    const ajena = otroHogar.memberId;

    const deAjena = await sellos(USER_ANA, [{ table: "household_members", id: ajena }]);
    const deInventado = await sellos(USER_ANA, [{ table: "household_members", id: inventado }]);
    expect(deAjena[ajena]).toBe("AUSENTE");
    expect(deAjena[ajena]).toBe(deInventado[inventado]);

    // Y una fila ajena en la lista no puede cortar la llamada entera: si la
    // cortara, el error mismo sería la respuesta que no se quiso dar.
    const lote = await h.como(
      USER_ANA,
      async () =>
        (await h.fila<{ add_manual_lot: string }>(
          "select public.add_manual_lot($1, 'Oráculo', 100, 'G')",
          [hogar.householdId],
        ))!.add_manual_lot,
    );
    const mezcla = await sellos(USER_ANA, [
      { table: "inventory_lots", id: lote },
      { table: "household_members", id: ajena },
    ]);
    expect(mezcla[lote]).not.toBe("AUSENTE");
    expect(mezcla[ajena]).toBe("AUSENTE");
  });

  it("la firma de entrada del motor de stock cambia cuando cambia la despensa", async () => {
    const antes = await h.como(USER_ANA, () =>
      h.fila<{ assistant_engine_stamps: Record<string, string> }>(
        "select public.assistant_engine_stamps($1)",
        [hogar.householdId],
      ),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.add_manual_lot($1, 'Porotos', 900, 'G')", [hogar.householdId]),
    );
    const despues = await h.como(USER_ANA, () =>
      h.fila<{ assistant_engine_stamps: Record<string, string> }>(
        "select public.assistant_engine_stamps($1)",
        [hogar.householdId],
      ),
    );
    expect(despues!.assistant_engine_stamps.stock).not.toBe(
      antes!.assistant_engine_stamps.stock,
    );
    // Y arrastra a los motores que leen la despensa.
    expect(despues!.assistant_engine_stamps.prep).not.toBe(antes!.assistant_engine_stamps.prep);
  });

  it("las firmas no se le dan a quien no es del hogar", async () => {
    const r = await h.como(USER_CARLA, () =>
      intentar("select public.assistant_engine_stamps($1)", [hogar.householdId]),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("no autorizado");
  });
});

// ---------------------------------------------------------------------------

describe("0053 — la compuerta: el asistente PROPONE, una persona CONFIRMA", () => {
  it("sin token, la propuesta NO se toma", async () => {
    const id = await h.como(USER_ANA, () => proponer());
    const r = await h.como(USER_ANA, () =>
      h.fila<{ take_assistant_proposal: { tomada: boolean; motivo: string } }>(
        "select public.take_assistant_proposal($1, $2)",
        [id, "token-inventado"],
      ),
    );
    expect(r!.take_assistant_proposal.tomada).toBe(false);
    expect(r!.take_assistant_proposal.motivo).toBe("SIN_CONFIRMACION");

    const estado = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.assistant_proposals where id = $1", [id]),
    );
    expect(estado!.status).toBe("OFFERED");
  });

  it("con token se toma UNA vez; el mismo token no sirve dos veces", async () => {
    const id = await h.como(USER_ANA, () => proponer());
    const token = await emitirToken(id, hogar.memberId);

    const primera = await h.como(USER_ANA, () =>
      h.fila<{ take_assistant_proposal: { tomada: boolean } }>(
        "select public.take_assistant_proposal($1, $2)",
        [id, token],
      ),
    );
    expect(primera!.take_assistant_proposal.tomada).toBe(true);

    // El segundo POST del mismo proposalId —una pestaña duplicada, un reintento
    // automático, un fetch salido de un turno envenenado— llega tarde.
    const segunda = await h.como(USER_ANA, () =>
      h.fila<{ take_assistant_proposal: { tomada: boolean; motivo: string } }>(
        "select public.take_assistant_proposal($1, $2)",
        [id, token],
      ),
    );
    expect(segunda!.take_assistant_proposal.tomada).toBe(false);
    expect(segunda!.take_assistant_proposal.motivo).toBe("EN_VUELO");
  });

  it("EXECUTED sólo se llega desde ACCEPTED: nadie ejecuta lo que nadie confirmó", async () => {
    const id = await h.como(USER_ANA, () => proponer());
    const r = await h.como(USER_ANA, () =>
      intentar("select public.settle_assistant_proposal($1, 'EXECUTED')", [id]),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("EXECUTED");

    const estado = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.assistant_proposals where id = $1", [id]),
    );
    expect(estado!.status).toBe("OFFERED");
  });

  it("una propuesta vencida no se toma, y queda EXPIRED", async () => {
    /**
     * La propuesta vieja se FABRICA con un INSERT directo y no envejeciendo una
     * recién creada, porque envejecerla es imposible: el trigger de
     * inmutabilidad no deja tocar `expires_at`, y eso está bien —mover el
     * vencimiento después de mostrar la tarjeta es cambiarle el trato a la
     * persona. Que este test haya tenido que rodearlo ES la prueba de que el
     * candado sirve.
     */
    const id = await h.comoAdmin(
      async () =>
        (await h.fila<{ id: string }>(
          `insert into public.assistant_proposals
             (household_id, created_by, trace_id, accion, args, risk, effect, origen,
              requires, dedupe_key, basis, resumen, created_at, expires_at)
           values ($1, $2, 'traza-vieja', 'qrUseLot', '{}'::jsonb, 'ALTO', 'WRITES_LEDGER',
                   'USUARIO', '[]'::jsonb, 'VENCIDA:1', $3::jsonb, $4::jsonb,
                   now() - interval '2 hours', now() - interval '1 hour')
           returning id`,
          [hogar.householdId, hogar.memberId, BASIS, RESUMEN],
        ))!.id,
    );
    const token = await emitirToken(id, hogar.memberId);

    const r = await h.como(USER_ANA, () =>
      h.fila<{ take_assistant_proposal: { tomada: boolean; motivo: string } }>(
        "select public.take_assistant_proposal($1, $2)",
        [id, token],
      ),
    );
    expect(r!.take_assistant_proposal.tomada).toBe(false);
    expect(r!.take_assistant_proposal.motivo).toBe("VENCIDA");

    const estado = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.assistant_proposals where id = $1", [id]),
    );
    expect(estado!.status).toBe("EXPIRED");
  });

  it("el vencimiento de una propuesta mostrada no se puede correr", async () => {
    const id = await h.como(USER_ANA, () => proponer({ dedupe: "TTL:intocable" }));
    const r = await h.comoAdmin(() =>
      intentar(
        "update public.assistant_proposals set expires_at = now() + interval '9 days' where id = $1",
        [id],
      ),
    );
    // Correr el vencimiento después de mostrar la tarjeta es cambiarle el trato
    // a quien la está mirando.
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("no se reescribe");
  });

  it("proponer dos veces lo mismo deja UNA sola viva; la anterior queda SUPERSEDED", async () => {
    const dedupe = "USE_LOT:mismo-pollo";
    const primera = await h.como(USER_ANA, () => proponer({ dedupe }));
    const segunda = await h.como(USER_ANA, () => proponer({ dedupe }));

    const filas = await h.comoAdmin(() =>
      h.filas<{ id: string; status: string }>(
        "select id, status from public.assistant_proposals where dedupe_key = $1 order by created_at",
        [dedupe],
      ),
    );
    expect(filas.map((f) => f.status)).toEqual(["SUPERSEDED", "OFFERED"]);
    expect(filas[0]!.id).toBe(primera);
    expect(filas[1]!.id).toBe(segunda);
  });

  it("una propuesta rechazada NO se borra: queda rechazada con quién y cuándo", async () => {
    const id = await h.como(USER_ANA, () => proponer());
    await h.como(USER_ANA, () =>
      h.db.query("select public.settle_assistant_proposal($1, 'REJECTED')", [id]),
    );

    const fila = await h.comoAdmin(() =>
      h.fila<{ status: string; decided_by: string | null; decided_at: string | null }>(
        "select status, decided_by, decided_at from public.assistant_proposals where id = $1",
        [id],
      ),
    );
    expect(fila!.status).toBe("REJECTED");
    expect(fila!.decided_by).toBe(hogar.memberId);
    expect(fila!.decided_at).not.toBeNull();

    // Y no se puede hacer desaparecer: la historia del asistente no se edita.
    const borrado = await h.comoAdmin(() =>
      intentar("delete from public.assistant_proposals where id = $1", [id]),
    );
    expect(borrado.ok).toBe(false);
    expect(borrado.mensaje).toContain("30 días");
  });

  it("lo que se propuso no se reescribe después", async () => {
    const id = await h.como(USER_ANA, () => proponer());
    const r = await h.comoAdmin(() =>
      intentar(
        `update public.assistant_proposals set args = '{"lotId":"otro"}'::jsonb where id = $1`,
        [id],
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("no se reescribe");
  });

  it("una propuesta clínica NO la ve quien no tiene el grant, aunque administre la casa", async () => {
    const id = await h.como(USER_BETO, () =>
      proponer({
        requires: [
          { k: "MEDICAL", owner: miembroBeto, permission: "VIEW_CLINICAL_RESTRICTIONS" },
        ],
        dedupe: "CLINICO:beto",
      }),
    );

    const veAna = await h.como(USER_ANA, () =>
      h.fila("select id from public.assistant_proposals where id = $1", [id]),
    );
    expect(veAna).toBeNull();

    const veBeto = await h.como(USER_BETO, () =>
      h.fila("select id from public.assistant_proposals where id = $1", [id]),
    );
    expect(veBeto).not.toBeNull();
  });

  it("una propuesta clínica sin integrante nombrado no se escribe, ni por el RPC ni a mano", async () => {
    /**
     * La política de lectura es `capabilities_ok(household_id, requires)` y la
     * lista VACÍA significa "cualquiera de esta casa". Sin este piso, un
     * `requires()` olvidado en una herramienta clínica dejaba "Sodio · máx 1500
     * mg" legible por todo el hogar en /inbox y aceptable por cualquier
     * integrante: la audiencia de lo clínico la decidía el TypeScript.
     */
    const sinAudiencia = await h.como(USER_BETO, () =>
      intentar(
        `select public.create_assistant_proposal(
           $1, 'traza-clinica', 'setRestriction', '{"x":1}'::jsonb,
           'ALTO', 'WRITES_CLINICAL', 'USUARIO', '[]'::jsonb, 'CLINICO:sin-audiencia',
           $2::jsonb, $3::jsonb, 10)`,
        [hogar.householdId, BASIS, RESUMEN],
      ),
    );
    expect(sinAudiencia.ok).toBe(false);
    expect(sinAudiencia.mensaje).toContain("MEDICAL");

    // Con el integrante nombrado sí, y la tarjeta nace con su audiencia puesta.
    const id = await h.como(USER_BETO, () =>
      proponer({
        efecto: "WRITES_CLINICAL",
        requires: [
          { k: "MEDICAL", owner: miembroBeto, permission: "VIEW_CLINICAL_RESTRICTIONS" },
        ],
        dedupe: "CLINICO:con-audiencia",
      }),
    );
    const veAna = await h.como(USER_ANA, () =>
      h.fila("select id from public.assistant_proposals where id = $1", [id]),
    );
    expect(veAna).toBeNull();

    // Y el piso es la TABLA, no el RPC: los RPC son SECURITY DEFINER y el día
    // que alguien escriba el sexto se va a olvidar.
    const aMano = await h.comoAdmin(() =>
      intentar(
        `insert into public.assistant_proposals
           (household_id, created_by, trace_id, accion, args, risk, effect, origen,
            requires, dedupe_key, basis, resumen, expires_at)
         values ($1, $2, 'traza-a-mano', 'setRestriction', '{}'::jsonb, 'ALTO',
                 'WRITES_CLINICAL', 'USUARIO', '[]'::jsonb, 'CLINICO:a-mano',
                 $3::jsonb, $4::jsonb, now() + interval '10 minutes')`,
        [hogar.householdId, miembroBeto, BASIS, RESUMEN],
      ),
    );
    expect(aMano.ok).toBe(false);
    expect(aMano.mensaje).toContain("clinico_nombra_su_audiencia");

    // Un `owner` de otra casa no es una audiencia: sería una tarjeta invisible
    // hasta para quien la propuso, que se ve igual que un permiso faltante.
    const ajeno = await h.como(USER_BETO, () =>
      intentar(
        `select public.create_assistant_proposal(
           $1, 'traza-ajena', 'setRestriction', '{"x":1}'::jsonb,
           'ALTO', 'WRITES_CLINICAL', 'USUARIO', $2::jsonb, 'CLINICO:ajeno',
           $3::jsonb, $4::jsonb, 10)`,
        [
          hogar.householdId,
          JSON.stringify([
            { k: "MEDICAL", owner: otroHogar.memberId, permission: "READ_LABS" },
          ]),
          BASIS,
          RESUMEN,
        ],
      ),
    );
    expect(ajeno.ok).toBe(false);
    expect(ajeno.mensaje).toContain("no es de esta casa");
  });

  it("un efecto que la base no conoce no entra", async () => {
    // `effect` era texto libre de 1 a 40 caracteres: 'WRITES_CLINIC' mal
    // escrito dejaba de ser clínico para todos los efectos, incluida la regla
    // de audiencia de acá arriba.
    const r = await h.comoAdmin(() =>
      intentar(
        `insert into public.assistant_proposals
           (household_id, created_by, trace_id, accion, args, risk, effect, origen,
            requires, dedupe_key, basis, resumen, expires_at)
         values ($1, $2, 'traza-efecto', 'setRestriction', '{}'::jsonb, 'ALTO',
                 'WRITES_CLINIC', 'USUARIO', '[]'::jsonb, 'EFECTO:raro',
                 $3::jsonb, $4::jsonb, now() + interval '10 minutes')`,
        [hogar.householdId, miembroBeto, BASIS, RESUMEN],
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("effect");
  });

  it("otro hogar no ve ni una fila", async () => {
    await h.como(USER_ANA, () => proponer({ dedupe: "VISIBILIDAD" }));
    const filas = await h.como(USER_CARLA, () =>
      h.filas("select id from public.assistant_proposals"),
    );
    expect(filas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("0054 — la conversación es de una persona, no del hogar", () => {
  it("ni quien administra lee el hilo de otro", async () => {
    const conv = await h.como(USER_BETO, async () =>
      (await h.fila<{ id: string }>(
        `insert into public.assistant_conversations (household_id, member_id, titulo)
         values ($1, $2, 'mis exámenes') returning id`,
        [hogar.householdId, miembroBeto],
      ))!.id,
    );
    await h.como(USER_BETO, () =>
      h.db.query(
        `insert into public.assistant_turns (conversation_id, rol, texto, trace_id)
         values ($1, 'USUARIO', '¿cómo salió mi creatinina?', 'tz-1')`,
        [conv],
      ),
    );

    const ana = await h.como(USER_ANA, () =>
      h.filas("select id from public.assistant_conversations where id = $1", [conv]),
    );
    expect(ana).toEqual([]);

    const turnosAna = await h.como(USER_ANA, () =>
      h.filas("select id from public.assistant_turns where conversation_id = $1", [conv]),
    );
    expect(turnosAna).toEqual([]);

    const beto = await h.como(USER_BETO, () =>
      h.filas("select id from public.assistant_turns where conversation_id = $1", [conv]),
    );
    expect(beto).toHaveLength(1);
  });

  it("un turno escrito no se edita", async () => {
    const conv = await h.como(USER_ANA, async () =>
      (await h.fila<{ id: string }>(
        `insert into public.assistant_conversations (household_id, member_id)
         values ($1, $2) returning id`,
        [hogar.householdId, hogar.memberId],
      ))!.id,
    );
    await h.como(USER_ANA, () =>
      h.db.query(
        `insert into public.assistant_turns (conversation_id, rol, texto, trace_id)
         values ($1, 'USUARIO', 'hola', 'tz-2')`,
        [conv],
      ),
    );
    const r = await h.como(USER_ANA, () =>
      intentar("update public.assistant_turns set texto = 'otra cosa' where conversation_id = $1", [
        conv,
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("no se edita");
  });
});

// ---------------------------------------------------------------------------

describe("0055 — la auditoría contesta qué, cuándo, quién y con qué datos", () => {
  it("lo clínico NO deja ámbito en el libro que lee quien administra", async () => {
    await h.como(USER_BETO, () =>
      h.db.query("select public.log_assistant_call($1, $2, $3, $4, $5::jsonb, $6, $7)", [
        hogar.householdId,
        "salud.resumen_integrante",
        "READ",
        "traza-clinica",
        JSON.stringify({ member_id: miembroBeto }),
        "OK",
        miembroBeto,
      ]),
    );

    const enAudit = await h.comoAdmin(() =>
      h.fila<{ metadata: Record<string, unknown> }>(
        "select metadata from public.audit_events where metadata->>'trace_id' = 'traza-clinica'",
      ),
    );
    // Que hubo actividad se sabe. Sobre quién, no: la FRECUENCIA de una consulta
    // médica también es dato sensible, y es lo que un grant revocado tiene que
    // dejar de contar.
    expect(enAudit!.metadata.tool).toBe("SALUD");
    expect(enAudit!.metadata.scope).toBeUndefined();

    const anaVe = await h.como(USER_ANA, () =>
      h.filas("select id from public.assistant_medical_audit where trace_id = 'traza-clinica'"),
    );
    expect(anaVe).toEqual([]);

    const betoVe = await h.como(USER_BETO, () =>
      h.filas("select id from public.assistant_medical_audit where trace_id = 'traza-clinica'"),
    );
    expect(betoVe).toHaveLength(1);
  });

  it("lo NO clínico sí guarda el ámbito, y sólo uuids", async () => {
    await h.como(USER_ANA, () =>
      h.db.query("select public.log_assistant_call($1, $2, $3, $4, $5::jsonb)", [
        hogar.householdId,
        "despensa.listar",
        "READ",
        "traza-despensa",
        JSON.stringify({ household_id: hogar.householdId, pregunta: "queda arroz?" }),
      ]),
    );
    const fila = await h.comoAdmin(() =>
      h.fila<{ metadata: { scope: Record<string, string>; tool: string } }>(
        "select metadata from public.audit_events where metadata->>'trace_id' = 'traza-despensa'",
      ),
    );
    expect(fila!.metadata.tool).toBe("despensa.listar");
    expect(fila!.metadata.scope).toEqual({ household_id: hogar.householdId });
  });

  it("el recibo de la ejecución dice quién confirmó", async () => {
    const id = await h.como(USER_ANA, () => proponer({ dedupe: "RECIBO" }));
    const token = await emitirToken(id, hogar.memberId);
    await h.como(USER_ANA, () =>
      h.db.query("select public.take_assistant_proposal($1, $2)", [id, token]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.settle_assistant_proposal($1, 'EXECUTED', $2::jsonb)", [
        id,
        JSON.stringify({ lot_id: null }),
      ]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.log_assistant_execution($1, 'OK')", [id]),
    );

    const fila = await h.comoAdmin(() =>
      h.fila<{ metadata: Record<string, unknown> }>(
        `select metadata from public.audit_events
         where action = 'ASSISTANT_PROPOSAL_EXECUTED' and subject_id = $1`,
        [id],
      ),
    );
    expect(fila!.metadata.confirmado_por).toBe(hogar.memberId);
    expect(fila!.metadata.confirmado_el).not.toBeNull();
    expect(fila!.metadata.accion).toBe("qrUseLot");
  });
});

// ---------------------------------------------------------------------------

describe("0056 — el inbox: lo produce el motor y lo ordena la severidad", () => {
  async function avisar(
    kind: string,
    dedupe: string,
    extra: { owner?: string; requires?: unknown; expira?: string | null } = {},
  ): Promise<string> {
    const fila = await h.fila<{ upsert_inbox_item: string }>(
      `select public.upsert_inbox_item(
         $1, $2::public.inbox_kind, $3, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
         null, $4, null, null, null, $5, $6::jsonb, $7::timestamptz)`,
      [
        hogar.householdId,
        kind,
        `aviso ${kind}`,
        dedupe,
        extra.owner ?? null,
        JSON.stringify(extra.requires ?? []),
        extra.expira ?? null,
      ],
    );
    return fila!.upsert_inbox_item;
  }

  it("la severidad la impone el TIPO: no es un argumento que alguien pueda inflar", async () => {
    await h.como(USER_ANA, () => avisar("SUGERENCIA", "SUG:1"));
    const fila = await h.como(USER_ANA, () =>
      h.fila<{ severidad: number }>(
        "select severidad from public.assistant_inbox_items where dedupe_key = 'SUG:1'",
      ),
    );
    expect(fila!.severidad).toBe(9);

    // Y tampoco se puede corregir después: el check la ancla al tipo.
    const r = await h.comoAdmin(() =>
      intentar("update public.assistant_inbox_items set severidad = 1 where dedupe_key = 'SUG:1'"),
    );
    expect(r.ok).toBe(false);
  });

  it("dos avisos del mismo lote son uno: se actualiza, no se acumula", async () => {
    await h.como(USER_ANA, () => avisar("VENCE_HOY", "VENCE:leche"));
    await h.como(USER_ANA, () => avisar("VENCE_HOY", "VENCE:leche"));
    const filas = await h.como(USER_ANA, () =>
      h.filas("select id from public.assistant_inbox_items where dedupe_key = 'VENCE:leche'"),
    );
    expect(filas).toHaveLength(1);
  });

  it("un aviso clínico sin dueño no se puede escribir", async () => {
    const r = await h.como(USER_ANA, () =>
      intentar(
        `select public.upsert_inbox_item(
           $1, 'CLINICO_BLOQUEANTE', 'x', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
           null, 'CLIN:huerfano', null, null, null, null,
           '[{"k":"MEDICAL","permission":"VIEW_CLINICAL_RESTRICTIONS"}]'::jsonb, null)`,
        [hogar.householdId],
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("dueño");
  });

  it("el aviso clínico no lo ve quien no tiene el grant, y el badge tampoco lo cuenta", async () => {
    await h.como(USER_BETO, () =>
      avisar("CLINICO_BLOQUEANTE", "CLIN:beto", {
        owner: miembroBeto,
        requires: [{ k: "MEDICAL", owner: miembroBeto, permission: "VIEW_CLINICAL_RESTRICTIONS" }],
      }),
    );

    const ana = await h.como(USER_ANA, () =>
      h.filas("select id from public.assistant_inbox_items where dedupe_key = 'CLIN:beto'"),
    );
    expect(ana).toEqual([]);

    const badgeAna = await h.como(USER_ANA, () =>
      h.fila<{ inbox_badge: number }>("select public.inbox_badge($1)", [hogar.householdId]),
    );
    const badgeBeto = await h.como(USER_BETO, () =>
      h.fila<{ inbox_badge: number }>("select public.inbox_badge($1)", [hogar.householdId]),
    );
    expect(badgeBeto!.inbox_badge).toBe(badgeAna!.inbox_badge + 1);
  });

  it("leer la bandeja NO escribe: el vencido se filtra por predicado", async () => {
    await h.como(USER_ANA, () =>
      avisar("REPOSICION", "REPO:aceite", { expira: "2020-01-01T00:00:00Z" }),
    );

    const abiertos = await h.como(USER_ANA, () =>
      h.filas<{ dedupe_key: string }>("select dedupe_key from public.inbox_abiertos($1)", [
        hogar.householdId,
      ]),
    );
    expect(abiertos.map((f) => f.dedupe_key)).not.toContain("REPO:aceite");

    // Y la fila sigue ABIERTA: leer no cambió el estado de nada. Si la lectura
    // escribiera, una falla de escritura rompería una lectura que sólo
    // necesitaba un filtro.
    const fila = await h.comoAdmin(() =>
      h.fila<{ estado: string }>(
        "select estado from public.assistant_inbox_items where dedupe_key = 'REPO:aceite'",
      ),
    );
    expect(fila!.estado).toBe("ABIERTO");

    // La caducidad persistida existe, pero fuera del camino de render.
    const n = await h.como(USER_ANA, () =>
      h.fila<{ expire_inbox_items: number }>("select public.expire_inbox_items($1)", [
        hogar.householdId,
      ]),
    );
    expect(n!.expire_inbox_items).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

describe("0057 — el presupuesto se toma y se paga en la misma transacción", () => {
  async function reservar(capa: number, trace: string, tokens = 100, tools = 1) {
    return h.fila<{ assistant_budget_check: Record<string, unknown> }>(
      "select public.assistant_budget_check($1, $2, $3::smallint, $4, $5)",
      [hogar.householdId, trace, capa, tokens, tools],
    );
  }

  it("la capa 2 sin consentimiento no habla con nadie", async () => {
    const r = await h.como(USER_ANA, () => reservar(2, "sin-consent-1"));
    expect(r!.assistant_budget_check.permitido).toBe(false);
    expect(r!.assistant_budget_check.motivo).toBe("SIN_CONSENTIMIENTO");
  });

  it("la capa 0 no gasta tokens pero SÍ gasta llamadas", async () => {
    await h.como(USER_ANA, () =>
      h.db.query(
        "update public.assistant_budget_policies set tools_minuto_actor = 2 where household_id = $1",
        [hogar.householdId],
      ),
    );

    const a = await h.como(USER_ANA, () => reservar(0, "capa0-a"));
    const b = await h.como(USER_ANA, () => reservar(0, "capa0-b"));
    const c = await h.como(USER_ANA, () => reservar(0, "capa0-c"));

    expect(a!.assistant_budget_check.permitido).toBe(true);
    expect(b!.assistant_budget_check.permitido).toBe(true);
    // "No consume presupuesto" es verdad en tokens y mentira en base de datos:
    // el camino rápido corre diez consultas por pulsación.
    expect(c!.assistant_budget_check.permitido).toBe(false);
    expect(c!.assistant_budget_check.motivo).toBe("DEMASIADO_SEGUIDO");

    const tokens = await h.comoAdmin(() =>
      h.fila<{ suma: number }>(
        "select coalesce(sum(estimado), 0)::int as suma from public.assistant_usage where capa = 0",
      ),
    );
    expect(tokens!.suma).toBe(0);

    await h.como(USER_ANA, () =>
      h.db.query(
        "update public.assistant_budget_policies set tools_minuto_actor = 30 where household_id = $1",
        [hogar.householdId],
      ),
    );
  });

  it("la reserva se descuenta aunque el turno nunca liquide", async () => {
    await h.como(USER_ANA, () =>
      h.db.query("select public.set_assistant_consent($1, 'ASSISTANT_HOUSEHOLD', null, $2, $3, true)", [
        hogar.householdId,
        "proveedor-falso",
        "v1",
      ]),
    );
    await h.como(USER_ANA, () =>
      h.db.query(
        `update public.assistant_budget_policies
            set tokens_dia_hogar = 1000, tope_actor_pct = 100
          where household_id = $1`,
        [hogar.householdId],
      ),
    );

    const primera = await h.como(USER_ANA, () => reservar(2, "abandonada", 900));
    expect(primera!.assistant_budget_check.permitido).toBe(true);

    // Nadie liquidó: el usuario cerró la pestaña a los 19 segundos. El
    // proveedor ya facturó, así que el saldo tiene que estar tomado igual.
    const segunda = await h.como(USER_ANA, () => reservar(2, "siguiente", 900));
    expect(segunda!.assistant_budget_check.permitido).toBe(false);
    expect(segunda!.assistant_budget_check.motivo).toBe("CUOTA_HOGAR");
  });

  it("un solo integrante no puede quemarle el día a toda la casa", async () => {
    await h.como(USER_ANA, () =>
      h.db.query(
        `update public.assistant_budget_policies
            set tokens_dia_hogar = 10000, tope_actor_pct = 60
          where household_id = $1`,
        [hogar.householdId],
      ),
    );
    // Ana ya gastó 900 en el test anterior; el piso deja 6000 en total.
    const r = await h.como(USER_ANA, () => reservar(2, "acaparadora", 6000));
    expect(r!.assistant_budget_check.permitido).toBe(false);
    // El motivo importa tanto como el corte: "ya usaste tu parte" no es lo
    // mismo que "la casa usó su cuota", y culpar al que no fue es la forma más
    // rápida de que una familia deje de confiar en la pantalla.
    expect(r!.assistant_budget_check.motivo).toBe("CUOTA_ACTOR_DEL_HOGAR");
  });

  it("liquidar ajusta a lo real y es idempotente", async () => {
    await h.como(USER_ANA, () =>
      h.db.query(
        "update public.assistant_budget_policies set tokens_dia_hogar = 200000 where household_id = $1",
        [hogar.householdId],
      ),
    );
    await h.como(USER_ANA, () => reservar(2, "liquidable", 500));
    await h.como(USER_ANA, () =>
      h.db.query("select public.assistant_usage_settle($1, $2, $3, $4)", ["liquidable", 120, 80, 2]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.assistant_usage_settle($1, $2, $3, $4)", ["liquidable", 999, 999, 9]),
    );

    const fila = await h.comoAdmin(() =>
      h.fila<{ tokens_in: number; tokens_out: number }>(
        "select tokens_in, tokens_out from public.assistant_usage where trace_id = 'liquidable'",
      ),
    );
    expect(fila!.tokens_in).toBe(120);
    expect(fila!.tokens_out).toBe(80);
  });

  it("el cortafuegos abre con 5 fallas, y un timeout pesa doble", async () => {
    const otro = await crearHogar(h, "00000000-0000-0000-0000-000000001504", "Hogar Breaker", "Dora");
    const reportar = (resultado: string) =>
      h.como("00000000-0000-0000-0000-000000001504", () =>
        h.fila<{ assistant_breaker_report: { abierto: boolean; fallas: number } }>(
          "select public.assistant_breaker_report($1, $2)",
          [otro.householdId, resultado],
        ),
      );

    await reportar("TIMEOUT"); // pesa 2
    await reportar("TIMEOUT"); // pesa 2 → 4
    const tercera = await reportar("FALLA"); // → 5
    expect(tercera!.assistant_breaker_report.abierto).toBe(true);

    const bloqueada = await h.como("00000000-0000-0000-0000-000000001504", () =>
      h.fila<{ assistant_budget_check: Record<string, unknown> }>(
        "select public.assistant_budget_check($1, 'breaker-1', 2::smallint, 10, 1)",
        [otro.householdId],
      ),
    );
    expect(bloqueada!.assistant_budget_check.motivo).toBe("PROVEEDOR_CAIDO");

    // La capa 0 sigue viva: que el proveedor esté caído no apaga el camino
    // determinista, que es justo el que sirve cuando el otro no está.
    const capa0 = await h.como("00000000-0000-0000-0000-000000001504", () =>
      h.fila<{ assistant_budget_check: Record<string, unknown> }>(
        "select public.assistant_budget_check($1, 'breaker-0', 0::smallint, 0, 1)",
        [otro.householdId],
      ),
    );
    expect(capa0!.assistant_budget_check.permitido).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("0058 — el doble clic no inventa comida ni la descuenta dos veces", () => {
  it("claim_dedupe distingue la primera vez de la segunda", async () => {
    const primera = await h.como(USER_ANA, () =>
      h.fila<{ tomada: boolean }>("select * from app.claim_dedupe($1, 'K1', 'prueba')", [
        hogar.householdId,
      ]),
    );
    const segunda = await h.como(USER_ANA, () =>
      h.fila<{ tomada: boolean }>("select * from app.claim_dedupe($1, 'K1', 'prueba')", [
        hogar.householdId,
      ]),
    );
    expect(primera!.tomada).toBe(true);
    expect(segunda!.tomada).toBe(false);
  });

  it("una acción sin clave revienta con nombre y apellido", async () => {
    const r = await h.como(USER_ANA, () =>
      intentar("select * from app.claim_dedupe($1, '   ', 'prueba')", [hogar.householdId]),
    );
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain("clave de idempotencia");
  });

  it("use_lot con la misma clave descuenta UNA sola vez", async () => {
    const lote = await h.como(USER_ANA, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Pollo', 1000, 'G')",
        [hogar.householdId],
      ))!.add_manual_lot,
    );

    await h.como(USER_ANA, () =>
      h.db.query("select public.use_lot($1, 300, null, $2)", [lote, "USE:pollo:1"]),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.use_lot($1, 300, null, $2)", [lote, "USE:pollo:1"]),
    );

    const fila = await h.comoAdmin(() =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [lote]),
    );
    // 1000 - 300 = 700. Si el dedupe no existiera serían 400, y esos 300 g de
    // diferencia son comida que el sistema cree tener y no tiene.
    expect(Number(fila!.quantity)).toBe(700);
  });

  it("use_lot SIN clave sigue funcionando exactamente como antes", async () => {
    const lote = await h.como(USER_ANA, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Arroz', 500, 'G')",
        [hogar.householdId],
      ))!.add_manual_lot,
    );
    await h.como(USER_ANA, () => h.db.query("select public.use_lot($1, 200)", [lote]));
    await h.como(USER_ANA, () => h.db.query("select public.use_lot($1, 200)", [lote]));

    const fila = await h.comoAdmin(() =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [lote]),
    );
    expect(Number(fila!.quantity)).toBe(100);
  });

  it("el libro mayor sigue siendo el dueño de la cantidad", async () => {
    const lote = await h.como(USER_ANA, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Lentejas', 400, 'G')",
        [hogar.householdId],
      ))!.add_manual_lot,
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.use_lot($1, 150, null, $2)", [lote, "USE:lentejas"]),
    );

    // Un movimiento por cada descuento, ni uno más: si el envoltorio hubiera
    // reescrito el cuerpo en vez de delegar, acá habría dos.
    const movs = await h.comoAdmin(() =>
      h.filas<{ delta: string }>(
        "select delta from public.inventory_movements where lot_id = $1 and delta < 0",
        [lote],
      ),
    );
    expect(movs).toHaveLength(1);
    expect(Number(movs[0]!.delta)).toBe(-150);
  });

  it("member_lab_schedules deja de aceptar la misma agenda dos veces", async () => {
    const biomarcador = await h.comoAdmin(() =>
      h.fila<{ id: string }>("select id from public.biomarker_definitions limit 1"),
    );
    if (!biomarcador) return; // sin catálogo de biomarcadores no hay nada que probar

    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.member_lab_schedules (member_id, biomarker_id, source)
         values ($1, $2, 'USER')`,
        [hogar.memberId, biomarcador.id],
      ),
    );
    const r = await h.comoAdmin(() =>
      intentar(
        `insert into public.member_lab_schedules (member_id, biomarker_id, source)
         values ($1, $2, 'USER')`,
        [hogar.memberId, biomarcador.id],
      ),
    );
    expect(r.ok).toBe(false);
  });
});
