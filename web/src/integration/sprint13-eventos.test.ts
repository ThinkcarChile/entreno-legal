import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventIncludes } from "@/domain/nutrition/events";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";
import { textoDelRelevo } from "@/app/demanda-abierta";

/**
 * Sprint 13 — la migración 0041 contra un PostgreSQL de verdad.
 *
 * No prueba "que las tablas existan". Prueba las cinco cosas que la revisión
 * adversarial encontró rotas EN EL DISEÑO, cada una escrita para fallar si el
 * arreglo se revierte:
 *
 *   [H20] El sábado del asado, el plan normal seguía comprando su almuerzo.
 *   [H23] El evento cancelado dejaba su demanda colgando en la lista.
 *   [H24] El evento de ayer se podía editar y reescribía la historia.
 *   [H10] Dos rosters para el mismo hecho: el que dijo que no iba igual
 *         recibía día RELAXED.
 *   [H26] Un evento de tres días sólo marcaba el primero.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: `harness.ts` lo comparten varios
 * agentes trabajando en el mismo árbol y su lista `MIGRACIONES` todavía llega
 * hasta la 0038. Copiar la aplicación acá es feo; la alternativa —entregar una
 * migración sin correr— no es una alternativa. Mismo patrón que
 * permisos-plan.test.ts (0039) y sprint12-adaptive.test.ts (0040).
 */

const RAIZ = path.resolve(__dirname, "../../..");
const PENDIENTES = [
  "supabase/migrations/0039_permisos_plan_y_cocina.sql",
  "supabase/migrations/0040_adaptive_reviews.sql",
  "supabase/migrations/0041_eventos_avanzados.sql",
];

const USER_ANA = "00000000-0000-0000-0000-0000000041a1";
const USER_BETO = "00000000-0000-0000-0000-0000000041a2";
const USER_MIRON = "00000000-0000-0000-0000-0000000041a3";
const USER_VECINO = "00000000-0000-0000-0000-0000000041b1";

// Sábado 2026-09-12, dentro de la semana del lunes 2026-09-07.
const SEMANA = weekStart("2026-09-07");
const SABADO = "2026-09-12";
const DOMINGO = "2026-09-13";
const VIERNES = "2026-09-11";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let miembroBeto: string;
let miembroMiron: string;
let vecino: { householdId: string; memberId: string };
let versionPollo: string;
let perfilAna: string;
let perfilBeto: string;
let planId: string;

interface Intento {
  rechazado: boolean;
  /** `null` cuando el driver no informó filas — que NO es lo mismo que cero. */
  filas: number | null;
  mensaje: string | null;
}

/** Una escritura bloqueada por RLS revienta en INSERT y toca cero filas en UPDATE/DELETE. */
async function intentar(sql: string, params: unknown[] = []): Promise<Intento> {
  try {
    const r = await h.db.query(sql, params);
    const tocadas = (r as { affectedRows?: number }).affectedRows;
    return {
      rechazado: false,
      // Nada de `?? 0`: cero filas significa "la RLS lo dejó fuera" y es un
      // dato; "el driver no lo dijo" es otra cosa y no puede disfrazarse de
      // aquél, o el test daría por bloqueada una escritura que sí ocurrió.
      filas: typeof tocadas === "number" ? tocadas : null,
      mensaje: null,
    };
  } catch (e) {
    return { rechazado: true, filas: 0, mensaje: (e as Error).message };
  }
}

const noPudo = (i: Intento): boolean => i.rechazado || i.filas === 0;

/** Aplica una migración sólo si todavía no está: el arnés podría adelantarse. */
async function asegurar(testigoSql: string, archivo: string): Promise<void> {
  const ya = await h.comoAdmin(() => h.fila(testigoSql));
  if (ya) return;
  await h.comoAdmin(() => h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8")));
}

/** Agrega una ficha de familia con cuenta y le da el rol pedido. */
async function integrante(userId: string, nombre: string, rol: string): Promise<string> {
  return h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `${nombre.toLowerCase()}41@test.dev`,
    ]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, $3, '1990-01-01') returning id`,
      [hogar.householdId, userId, nombre],
    );
    await h.db.query(
      `insert into public.member_role_assignments (member_id, role_id)
       select $1, id from public.household_roles
       where household_id = $2 and code = $3
       on conflict do nothing`,
      [m!.id, hogar.householdId, rol],
    );
    // El trigger de la 2-ter (0039) le pone MEMBER a toda ficha nueva. Para que
    // "sin permiso" signifique algo hay que sacárselo a mano.
    if (rol !== "MEMBER") {
      await h.db.query(
        `delete from public.member_role_assignments a
         using public.household_roles r
         where a.role_id = r.id and a.member_id = $1 and r.code = 'MEMBER'`,
        [m!.id],
      );
    }
    return m!.id;
  });
}

async function publicarPerfil(memberId: string, firma: string): Promise<string> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', $2, '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'sprint13')`,
      [memberId, firma],
    ),
  );
  return r!.publish_nutrition_profile;
}

/** Un almuerzo confirmado con una porción planificada por persona. */
async function almuerzoConfirmado(
  fecha: string,
  personas: Array<{ memberId: string; perfilId: string }>,
): Promise<{ assignmentId: string; proyecciones: Record<string, string> }> {
  return h.comoAdmin(async () => {
    const dia = await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planId, fecha],
    );
    const a = await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status, confirmed_at)
       values ($1, 'LUNCH', 'RECIPE', $2, 'CONFIRMED', now()) returning id`,
      [dia!.id, versionPollo],
    );
    const proyecciones: Record<string, string> = {};
    for (const p of personas) {
      const proy = await h.fila<{ id: string }>(
        `insert into public.member_serving_projections
           (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
            fit, adaptation_level, assignment_id, status)
         values ($1, $2, $3, 'test/1.0.0', 'LUNCH', $4, 'COMPATIBLE', 0, $5, 'PLANNED')
         returning id`,
        [p.memberId, versionPollo, p.perfilId, fecha, a!.id],
      );
      proyecciones[p.memberId] = proy!.id;
      await h.db.query(
        `insert into public.member_serving_components
           (projection_id, label, base_quantity, proposed_quantity, unit, weight_basis)
         values ($1, 'pollo', 150, 150, 'G', 'RAW')`,
        [proy!.id],
      );
    }
    return { assignmentId: a!.id, proyecciones };
  });
}

/** Un evento nuevo, en el estado que se pida. */
async function crearEvento(opciones: {
  fecha: string;
  hasta?: string;
  mealType?: string | null;
  titulo?: string;
  estado?: string;
}): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.nutrition_events
         (household_id, event_date, end_date, event_type, meal_type, title, status)
       values ($1, $2::date, $3::date, 'BARBECUE', $4::public.meal_type, $5,
               $6::public.event_status)
       returning id`,
      [
        hogar.householdId,
        opciones.fecha,
        opciones.hasta ?? null,
        opciones.mealType === undefined ? "LUNCH" : opciones.mealType,
        opciones.titulo ?? "Asado familiar",
        opciones.estado ?? "PLANNED",
      ],
    ),
  );
  return r!.id;
}

async function agregarMiembro(
  eventId: string,
  memberId: string,
  asistencia = "CONFIRMED",
): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.event_participants
         (event_id, participant_type, member_id, attendance_status)
       values ($1, 'HOUSEHOLD_MEMBER', $2, $3::public.event_attendance_status) returning id`,
      [eventId, memberId, asistencia],
    ),
  );
  return r!.id;
}

async function estado(eventId: string, nuevo: string): Promise<void> {
  await h.comoAdmin(() =>
    h.db.query("update public.nutrition_events set status = $2::public.event_status where id = $1", [
      eventId,
      nuevo,
    ]),
  );
}

/**
 * La demanda que TODAVÍA hay que comprar, leída por la puerta que la 0041
 * declara. Es la misma pregunta que se hace `futureDemand`
 * (web/src/app/stock/queries.ts:190) antes de armar la lista.
 */
async function demandaAbierta(fecha: string): Promise<string[]> {
  const filas = await h.comoAdmin(() =>
    h.filas<{ member_id: string }>(
      `select d.member_id
       from public.open_serving_demand d
       join public.member_serving_components c on c.projection_id = d.projection_id
       where d.serving_date = $1
       order by d.member_id`,
      [fecha],
    ),
  );
  return filas.map((f) => f.member_id);
}

beforeAll(async () => {
  h = await levantarBase();

  await asegurar(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'can_edit_plan'`,
    PENDIENTES[0]!,
  );
  await asegurar("select 1 where to_regclass('public.adaptive_nutrition_reviews') is not null", PENDIENTES[1]!);
  await asegurar("select 1 where to_regclass('public.event_participants') is not null", PENDIENTES[2]!);

  hogar = await crearHogar(h, USER_ANA, "Hogar Asado", "Ana");
  vecino = await crearHogar(h, USER_VECINO, "Hogar Vecino", "Vicente");

  miembroBeto = await integrante(USER_BETO, "Beto", "PLANNER");
  miembroMiron = await integrante(USER_MIRON, "Miron", "MEMBER");

  versionPollo = (await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `select v.id from public.meal_template_versions v
       join public.meal_templates t on t.id = v.template_id
       where v.status = 'PUBLISHED' limit 1`,
    ),
  ))!.id;

  perfilAna = await publicarPerfil(hogar.memberId, "firma-ana-13");
  perfilBeto = await publicarPerfil(miembroBeto, "firma-beto-13");

  planId = (await h.como(USER_ANA, () =>
    h.fila<{ ensure_weekly_plan: string }>("select public.ensure_weekly_plan($1, $2)", [
      hogar.householdId,
      SEMANA,
    ]),
  ))!.ensure_weekly_plan;
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

// ===========================================================================
// H20 — BLOQUEANTE: el evento RELEVA la comida, y sólo a quien va
// ===========================================================================

describe("[H20] el asado del sábado releva el almuerzo del sábado", () => {
  it("releva la porción de quien va y deja intacta la de quien no", async () => {
    const { assignmentId, proyecciones } = await almuerzoConfirmado(SABADO, [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: miembroBeto, perfilId: perfilBeto },
    ]);

    const antes = await demandaAbierta(SABADO);
    expect(antes.sort(), "el punto de partida son DOS almuerzos por comprar").toEqual(
      [hogar.memberId, miembroBeto].sort(),
    );

    const evento = await crearEvento({ fecha: SABADO });
    await agregarMiembro(evento, hogar.memberId, "CONFIRMED");
    await agregarMiembro(evento, miembroBeto, "DECLINED");

    await estado(evento, "CONFIRMED");

    // ESTE es el defecto que costaba plata: sin el relevo, acá seguirían las
    // dos porciones Y ADEMÁS la demanda del asado. Se compraba el doble.
    const despues = await demandaAbierta(SABADO);
    expect(
      despues,
      "el asado no relevó el almuerzo: la lista pide las dos cosas y la familia compra doble",
    ).toEqual([miembroBeto]);

    // Y el relevo es por persona, no por slot: Beto dijo que no iba y su
    // almuerzo sigue en pie.
    const marcas = await h.comoAdmin(() =>
      h.filas<{ member_id: string; covered_by_event_id: string | null }>(
        "select member_id, covered_by_event_id from public.member_serving_projections where assignment_id = $1",
        [assignmentId],
      ),
    );
    expect(marcas.find((m) => m.member_id === hogar.memberId)!.covered_by_event_id).toBe(evento);
    expect(marcas.find((m) => m.member_id === miembroBeto)!.covered_by_event_id).toBeNull();

    // El slot queda amarrado al evento para poder decirlo en pantalla.
    const slot = await h.comoAdmin(() =>
      h.fila<{ event_id: string | null }>(
        "select event_id from public.meal_assignments where id = $1",
        [assignmentId],
      ),
    );
    expect(slot!.event_id, "el slot no quedó amarrado al evento (§96 linaje)").toBe(evento);

    expect(proyecciones[hogar.memberId]).toBeTruthy();
  });

  it("cancelar el asado devuelve la comida al plan", async () => {
    await almuerzoConfirmado(DOMINGO, [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: miembroBeto, perfilId: perfilBeto },
    ]);
    const evento = await crearEvento({ fecha: DOMINGO, titulo: "Asado que se cae" });
    await agregarMiembro(evento, hogar.memberId);
    await agregarMiembro(evento, miembroBeto);
    await estado(evento, "CONFIRMED");

    expect(await demandaAbierta(DOMINGO)).toEqual([]);

    await estado(evento, "CANCELLED");

    const vueltas = await demandaAbierta(DOMINGO);
    expect(
      vueltas.sort(),
      "se canceló el asado y nadie devolvió el almuerzo al plan: ese día no se come",
    ).toEqual([hogar.memberId, miembroBeto].sort());

    // Y la comida queda MARCADA para revisión, no restaurada en silencio.
    const marcada = await h.comoAdmin(() =>
      h.fila<{ needs_review: boolean }>(
        `select a.needs_review from public.meal_assignments a
         join public.weekly_plan_days d on d.id = a.day_id
         where d.plan_id = $1 and d.plan_date = $2`,
        [planId, DOMINGO],
      ),
    );
    expect(marcada!.needs_review).toBe(true);
  });

  it("bajarse antes del asado devuelve el almuerzo; devolver el evento al borrador también", async () => {
    const semana = weekStart("2026-10-12");
    const fecha = "2026-10-17";
    await h.como(USER_ANA, () =>
      h.db.query("select public.ensure_weekly_plan($1, $2)", [hogar.householdId, semana]),
    );
    const plan = (await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.weekly_plans where household_id = $1 and week_start = $2",
        [hogar.householdId, semana],
      ),
    ))!.id;

    await h.comoAdmin(async () => {
      const dia = await h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
        [plan, fecha],
      );
      const a = await h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status, confirmed_at)
         values ($1, 'LUNCH', 'RECIPE', $2, 'CONFIRMED', now()) returning id`,
        [dia!.id, versionPollo],
      );
      for (const persona of [
        { m: hogar.memberId, p: perfilAna },
        { m: miembroBeto, p: perfilBeto },
      ]) {
        const proy = await h.fila<{ id: string }>(
          `insert into public.member_serving_projections
             (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
              fit, adaptation_level, assignment_id, status)
           values ($1, $2, $3, 'test/1.0.0', 'LUNCH', $4, 'COMPATIBLE', 0, $5, 'PLANNED')
           returning id`,
          [persona.m, versionPollo, persona.p, fecha, a!.id],
        );
        await h.db.query(
          `insert into public.member_serving_components
             (projection_id, label, base_quantity, proposed_quantity, unit, weight_basis)
           values ($1, 'pollo', 150, 150, 'G', 'RAW')`,
          [proy!.id],
        );
      }
    });

    const evento = await crearEvento({ fecha, titulo: "Asado del que alguien se baja" });
    const participanteBeto = await agregarMiembro(evento, miembroBeto);
    await agregarMiembro(evento, hogar.memberId);
    await estado(evento, "CONFIRMED");
    expect(await demandaAbierta(fecha)).toEqual([]);

    // Beto avisa que no va. Falta para el asado: su almuerzo vuelve a hacer falta.
    await h.comoAdmin(() =>
      h.db.query(
        "update public.event_participants set attendance_status = 'DECLINED' where id = $1",
        [participanteBeto],
      ),
    );
    expect(
      await demandaAbierta(fecha),
      "alguien se bajó del asado y su almuerzo quedó relevado igual: ese día no come",
    ).toEqual([miembroBeto]);

    // Y devolver el evento al borrador deshace el relevo entero.
    await estado(evento, "PLANNED");
    await estado(evento, "DRAFT");
    expect(
      (await demandaAbierta(fecha)).sort(),
      "el asado volvió al borrador y la comida siguió relevada",
    ).toEqual([hogar.memberId, miembroBeto].sort());
  });

  it("un evento sin comida declarada NO releva nada: UNKNOWN no es 'todas'", async () => {
    await almuerzoConfirmado(VIERNES, [{ memberId: hogar.memberId, perfilId: perfilAna }]);
    const evento = await crearEvento({
      fecha: VIERNES,
      mealType: null,
      titulo: "Junta sin hora",
    });
    await agregarMiembro(evento, hogar.memberId);
    await estado(evento, "CONFIRMED");

    expect(
      await demandaAbierta(VIERNES),
      "un evento sin meal_type relevó comidas: leer UNKNOWN como 'todas' deja a la familia sin almuerzo",
    ).toEqual([hogar.memberId]);

    const razon = await h.comoAdmin(() =>
      h.fila<{ metadata: { reason: string } }>(
        `select metadata from public.audit_events
         where subject_id = $1 and action = 'EVENT_MEAL_COVERAGE_APPLIED'`,
        [evento],
      ),
    );
    expect(razon!.metadata.reason).toBe("EVENT_MEAL_TYPE_UNKNOWN");
  });

  it("un evento sin lista de participantes tampoco releva a nadie", async () => {
    const otraSemana = weekStart("2026-09-21");
    const fecha = "2026-09-26";
    await h.como(USER_ANA, () =>
      h.db.query("select public.ensure_weekly_plan($1, $2)", [hogar.householdId, otraSemana]),
    );
    const planOtro = (await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.weekly_plans where household_id = $1 and week_start = $2",
        [hogar.householdId, otraSemana],
      ),
    ))!.id;

    await h.comoAdmin(async () => {
      const dia = await h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
        [planOtro, fecha],
      );
      const a = await h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status, confirmed_at)
         values ($1, 'LUNCH', 'RECIPE', $2, 'CONFIRMED', now()) returning id`,
        [dia!.id, versionPollo],
      );
      const proy = await h.fila<{ id: string }>(
        `insert into public.member_serving_projections
           (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
            fit, adaptation_level, assignment_id, status)
         values ($1, $2, $3, 'test/1.0.0', 'LUNCH', $4, 'COMPATIBLE', 0, $5, 'PLANNED') returning id`,
        [hogar.memberId, versionPollo, perfilAna, fecha, a!.id],
      );
      await h.db.query(
        `insert into public.member_serving_components
           (projection_id, label, base_quantity, proposed_quantity, unit, weight_basis)
         values ($1, 'pollo', 150, 150, 'G', 'RAW')`,
        [proy!.id],
      );
    });

    const evento = await crearEvento({ fecha, titulo: "Asado sin invitados cargados" });
    await estado(evento, "CONFIRMED");

    expect(
      await demandaAbierta(fecha),
      "un evento sin roster relevó comidas: no saber quién va no autoriza a dejar a nadie sin almuerzo",
    ).toEqual([hogar.memberId]);
  });
});

// ===========================================================================
// H23 — cancelar retira la demanda que quedó en compras
// ===========================================================================

describe("[H23] el evento cancelado no sigue pidiendo carne", () => {
  it("retira lo PENDING del evento y deja lo comprado y lo del plan en paz", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado con compra" });
    await agregarMiembro(evento, hogar.memberId);

    const { listaSemanal, listaDelta, itemEvento, itemComprado, itemPlan } = await h.comoAdmin(
      async () => {
        const semanal = await h.fila<{ id: string }>(
          `insert into public.shopping_lists (household_id, plan_id) values ($1, $2) returning id`,
          [hogar.householdId, planId],
        );
        const delta = await h.fila<{ id: string }>(
          `insert into public.shopping_lists (household_id, plan_id, event_id, status)
           values ($1, $2, $3, 'ACTIVE') returning id`,
          [hogar.householdId, planId, evento],
        );
        const nuevoItem = async (
          listId: string,
          label: string,
          eventId: string | null,
          status: string,
        ) =>
          (await h.fila<{ id: string }>(
            `insert into public.shopping_list_items (list_id, label, unit, event_id, status, purchased_at)
             values ($1, $2, 'G', $3, $4::public.shopping_item_status,
                     case when $4 = 'PURCHASED' then now() else null end)
             returning id`,
            [listId, label, eventId, status],
          ))!.id;

        return {
          listaSemanal: semanal!.id,
          listaDelta: delta!.id,
          itemEvento: await nuevoItem(semanal!.id, "Lomo vetado", evento, "PENDING"),
          itemComprado: await nuevoItem(semanal!.id, "Carbón", evento, "PURCHASED"),
          itemPlan: await nuevoItem(semanal!.id, "Arroz", null, "PENDING"),
        };
      },
    );

    await estado(evento, "CANCELLED");

    const items = await h.comoAdmin(() =>
      h.filas<{ id: string; status: string; status_reason: string | null }>(
        "select id, status, status_reason from public.shopping_list_items where list_id = $1",
        [listaSemanal],
      ),
    );
    const porId = (id: string) => items.find((i) => i.id === id)!;

    expect(
      porId(itemEvento).status,
      "el asado se canceló y la lista sigue pidiendo su carne: nadie retiró la demanda",
    ).toBe("SKIPPED");
    expect(porId(itemEvento).status_reason).toBe("Evento cancelado");

    // Lo ya comprado NO se toca: está en la casa (§83), y la lista histórica
    // no se reescribe (demo M).
    expect(porId(itemComprado).status).toBe("PURCHASED");
    // Y lo que pidió el plan semanal no tiene nada que ver con el asado.
    expect(porId(itemPlan).status).toBe("PENDING");

    const delta = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.shopping_lists where id = $1", [
        listaDelta,
      ]),
    );
    expect(delta!.status, "la lista delta del evento quedó abierta con el evento muerto").toBe(
      "CANCELLED",
    );
  });
});

// ===========================================================================
// H24 — la historia de un evento cerrado no se reescribe
// ===========================================================================

describe("[H24] el asado de ayer es historia", () => {
  it("no se le cambia la fecha, ni el menú, ni se le agregan comensales", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado terminado" });
    await agregarMiembro(evento, hogar.memberId);
    const menu = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.event_menu_items (event_id, kind, category, display_name)
         values ($1, 'MEAT', 'VACUNO', 'Lomo vetado') returning id`,
        [evento],
      ),
    );
    await estado(evento, "CONFIRMED");
    await estado(evento, "COMPLETED");

    const fecha = await h.comoAdmin(() =>
      intentar("update public.nutrition_events set event_date = '2026-09-05' where id = $1", [
        evento,
      ]),
    );
    expect(fecha.rechazado, "se le cambió la fecha a un asado que ya ocurrió").toBe(true);
    expect(fecha.mensaje).toMatch(/historia/i);

    const menuEditado = await h.comoAdmin(() =>
      intentar("update public.event_menu_items set display_name = 'Otra cosa' where id = $1", [
        menu!.id,
      ]),
    );
    expect(menuEditado.rechazado, "se reescribió el menú de un asado cerrado").toBe(true);

    const comensal = await h.comoAdmin(() =>
      intentar(
        `insert into public.event_participants (event_id, participant_type, member_id)
         values ($1, 'HOUSEHOLD_MEMBER', $2)`,
        [evento, miembroBeto],
      ),
    );
    expect(
      comensal.rechazado,
      "se le agregó un comensal a un asado que ya pasó: eso mueve el denominador del aprendizaje",
    ).toBe(true);

    const borrado = await h.comoAdmin(() =>
      intentar("delete from public.nutrition_events where id = $1", [evento]),
    );
    expect(borrado.rechazado, "se borró un evento completado").toBe(true);
  });

  it("corregir la asistencia real sí se puede, pero sólo en la ventana y con auditoría", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado recién cerrado" });
    const participante = await agregarMiembro(evento, hogar.memberId, "CONFIRMED");
    await estado(evento, "CONFIRMED");
    await estado(evento, "COMPLETED");

    const correccion = await h.comoAdmin(() =>
      intentar(
        "update public.event_participants set attendance_status = 'NO_SHOW' where id = $1",
        [participante],
      ),
    );
    expect(
      correccion.rechazado,
      `dentro de la ventana la corrección tiene que pasar: ${correccion.mensaje}`,
    ).toBe(false);

    const auditoria = await h.comoAdmin(() =>
      h.fila<{ metadata: { de: string; a: string } }>(
        `select metadata from public.audit_events
         where subject_id = $1 and action = 'EVENT_ATTENDANCE_CORRECTED'`,
        [evento],
      ),
    );
    expect(auditoria, "la corrección tardía no dejó rastro").not.toBeNull();
    expect(auditoria!.metadata.a).toBe("NO_SHOW");
  });

  it("pasada la ventana, la asistencia queda como quedó", async () => {
    const evento = await crearEvento({ fecha: "2026-09-08", titulo: "Asado viejo" });
    const participante = await agregarMiembro(evento, hogar.memberId, "CONFIRMED");
    await estado(evento, "CONFIRMED");
    // El cierre se estampa en el mismo UPDATE que completa: después queda
    // congelado, así que la ventana no se puede estirar sola.
    await h.comoAdmin(() =>
      h.db.query(
        `update public.nutrition_events
         set status = 'COMPLETED', completed_at = now() - interval '100 hours'
         where id = $1`,
        [evento],
      ),
    );

    const tarde = await h.comoAdmin(() =>
      intentar(
        "update public.event_participants set attendance_status = 'NO_SHOW' where id = $1",
        [participante],
      ),
    );
    expect(tarde.rechazado, "se corrigió la asistencia cuatro días después del asado").toBe(true);
    expect(tarde.mensaje).toMatch(/72/);

    const estirar = await h.comoAdmin(() =>
      intentar("update public.nutrition_events set completed_at = now() where id = $1", [evento]),
    );
    expect(
      estirar.rechazado,
      "se pudo correr la marca de cierre: la ventana de corrección se estira sola para siempre",
    ).toBe(true);
  });
});

// ===========================================================================
// H10 — un solo dueño del roster
// ===========================================================================

describe("[H10] quién viene se dice en un solo lugar", () => {
  it("el que marcó DECLINED no recibe relajo de macros", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado con ausente" });
    await agregarMiembro(evento, hogar.memberId, "CONFIRMED");
    await agregarMiembro(evento, miembroBeto, "DECLINED");

    const memberIds = (
      await h.comoAdmin(() =>
        h.filas<{ member_id: string }>(
          "select member_id from public.nutrition_event_members where event_id = $1",
          [evento],
        ),
      )
    ).map((f) => f.member_id);

    // El ÁMBITO se lee de la base, no se supone. Un evento con roster declarado
    // y otro legacy tienen la misma lista y significan cosas distintas: fijar el
    // valor a mano acá probaría la función, no el sistema.
    const ambito = await h.comoAdmin(() =>
      h.fila<{ member_scope: string }>(
        "select member_scope from public.nutrition_events where id = $1",
        [evento],
      ),
    );
    expect(
      ambito!.member_scope,
      "el evento con participantes cargados no quedó con el roster declarado",
    ).toBe("DECLARED_ROSTER");

    // Se lee con la MISMA función que usa el motor de estrategia de eventos.
    const día = {
      memberIds,
      memberScope: ambito!.member_scope,
    } as { memberIds: string[]; memberScope: string };
    expect(
      eventIncludes(día as never, hogar.memberId),
      "quien confirmó no quedó incluido en el efecto del evento",
    ).toBe(true);
    expect(
      eventIncludes(día as never, miembroBeto),
      "el que dijo que NO iba igual recibió día RELAXED: dos rosters diciendo cosas distintas",
    ).toBe(false);
  });

  it("cambiar la asistencia mueve el efecto nutricional con ella", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado que cambia" });
    const p = await agregarMiembro(evento, miembroBeto, "DECLINED");

    const antes = await h.comoAdmin(() =>
      h.filas("select member_id from public.nutrition_event_members where event_id = $1", [evento]),
    );
    expect(antes.length).toBe(0);

    await h.comoAdmin(() =>
      h.db.query(
        "update public.event_participants set attendance_status = 'CONFIRMED' where id = $1",
        [p],
      ),
    );

    const despues = await h.comoAdmin(() =>
      h.filas<{ member_id: string }>(
        "select member_id from public.nutrition_event_members where event_id = $1",
        [evento],
      ),
    );
    expect(despues.map((f) => f.member_id)).toEqual([miembroBeto]);
  });

  it("con roster cargado, nadie escribe el efecto nutricional a mano", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado con dueño único" });
    await agregarMiembro(evento, hogar.memberId, "CONFIRMED");

    const aMano = await h.comoAdmin(() =>
      intentar(
        "insert into public.nutrition_event_members (event_id, member_id) values ($1, $2)",
        [evento, miembroBeto],
      ),
    );
    expect(
      aMano.rechazado,
      "se pudo escribir el segundo roster a mano: vuelven a poder decir cosas distintas",
    ).toBe(true);
    expect(aMano.mensaje).toMatch(/participantes/i);
  });

  it("un evento sin roster conserva la semántica de siempre", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Evento legacy" });
    const aMano = await h.comoAdmin(() =>
      intentar(
        "insert into public.nutrition_event_members (event_id, member_id) values ($1, $2)",
        [evento, hogar.memberId],
      ),
    );
    expect(
      aMano.rechazado,
      `el camino viejo dejó de funcionar para los eventos que ya existían: ${aMano.mensaje}`,
    ).toBe(false);
  });
});

// ===========================================================================
// H26 — un evento de tres días marca los tres días
// ===========================================================================

describe("[H26] el viaje de tres días no deja dos días a la deriva", () => {
  it("marca para revisión todo el rango, no sólo el primer día", async () => {
    const semana = weekStart("2026-10-05");
    await h.como(USER_ANA, () =>
      h.db.query("select public.ensure_weekly_plan($1, $2)", [hogar.householdId, semana]),
    );
    const plan = (await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.weekly_plans where household_id = $1 and week_start = $2",
        [hogar.householdId, semana],
      ),
    ))!.id;

    const fechas = ["2026-10-05", "2026-10-06", "2026-10-07"];
    await h.comoAdmin(async () => {
      for (const f of fechas) {
        const dia = await h.fila<{ id: string }>(
          "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
          [plan, f],
        );
        await h.db.query(
          `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status, confirmed_at)
           values ($1, 'DINNER', 'RECIPE', $2, 'CONFIRMED', now())`,
          [dia!.id, versionPollo],
        );
      }
    });

    const evento = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.nutrition_events
           (household_id, event_date, end_date, event_type, meal_type, title)
         values ($1, '2026-10-05', '2026-10-07', 'TRAVEL', 'DINNER', 'Viaje de tres días')
         returning id`,
        [hogar.householdId],
      ),
    );

    const marcadas = await h.comoAdmin(() =>
      h.filas<{ plan_date: string }>(
        `select d.plan_date::text as plan_date
         from public.meal_assignments a
         join public.weekly_plan_days d on d.id = a.day_id
         where d.plan_id = $1 and a.needs_review
         order by d.plan_date`,
        [plan],
      ),
    );
    expect(
      marcadas.map((m) => m.plan_date),
      "los días 2 y 3 del viaje quedaron confirmados sin bandera: el plan se desalinea en silencio",
    ).toEqual(fechas);

    expect(evento!.id).toBeTruthy();
  });
});

// ===========================================================================
// Cimiento: lo que la Etapa 1 tiene que garantizar
// ===========================================================================

describe("el estado del evento y su historia", () => {
  it("las transiciones imposibles rebotan y los terminales son terminales", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado de transiciones" });

    const salto = await h.comoAdmin(() =>
      intentar("update public.nutrition_events set status = 'IN_PROGRESS' where id = $1", [evento]),
    );
    expect(salto.rechazado, "un evento PLANNED saltó directo a IN_PROGRESS").toBe(true);

    await estado(evento, "CONFIRMED");
    await estado(evento, "IN_PROGRESS");
    await estado(evento, "COMPLETED");

    const revivir = await h.comoAdmin(() =>
      intentar("update public.nutrition_events set status = 'PLANNED' where id = $1", [evento]),
    );
    expect(revivir.rechazado, "un evento COMPLETED volvió a planificarse").toBe(true);
  });

  it("borrar de verdad sólo se puede en borrador", async () => {
    const borrador = await crearEvento({ fecha: SABADO, estado: "DRAFT", titulo: "Borrador" });
    const publicado = await crearEvento({ fecha: SABADO, titulo: "Ya planificado" });

    const unoSi = await h.comoAdmin(() =>
      intentar("delete from public.nutrition_events where id = $1", [borrador]),
    );
    expect(unoSi.rechazado, `no se pudo borrar un borrador: ${unoSi.mensaje}`).toBe(false);

    const otroNo = await h.comoAdmin(() =>
      intentar("delete from public.nutrition_events where id = $1", [publicado]),
    );
    expect(otroNo.rechazado, "se borró un evento que ya estaba en el calendario").toBe(true);

    // Y cancelar conserva la fila entera.
    await estado(publicado, "CANCELLED");
    const sigue = await h.comoAdmin(() =>
      h.fila("select id from public.nutrition_events where id = $1", [publicado]),
    );
    expect(sigue, "cancelar borró el evento en vez de conservarlo").not.toBeNull();
  });
});

describe("participantes e invitados", () => {
  it("un participante es de la casa o es invitado, nunca las dos ni ninguna", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado XOR" });
    const invitado = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Primo Juan') returning id",
        [hogar.householdId],
      ),
    );

    const ambos = await h.comoAdmin(() =>
      intentar(
        `insert into public.event_participants (event_id, participant_type, member_id, guest_id)
         values ($1, 'HOUSEHOLD_MEMBER', $2, $3)`,
        [evento, hogar.memberId, invitado!.id],
      ),
    );
    expect(ambos.rechazado, "un participante quedó siendo miembro e invitado a la vez").toBe(true);

    const ninguno = await h.comoAdmin(() =>
      intentar(
        "insert into public.event_participants (event_id, participant_type) values ($1, 'GUEST')",
        [evento],
      ),
    );
    expect(ninguno.rechazado, "un participante quedó sin identidad").toBe(true);

    const duplicado = await h.comoAdmin(async () => {
      await h.db.query(
        `insert into public.event_participants (event_id, participant_type, guest_id)
         values ($1, 'GUEST', $2)`,
        [evento, invitado!.id],
      );
      return intentar(
        `insert into public.event_participants (event_id, participant_type, guest_id)
         values ($1, 'GUEST', $2)`,
        [evento, invitado!.id],
      );
    });
    expect(
      duplicado.rechazado,
      "dos planners agregando al mismo invitado produjeron dos comensales",
    ).toBe(true);
  });

  it("sin información dietaria NO es sin restricciones", async () => {
    const ids = await h.comoAdmin(async () => {
      const sinDato = await h.fila<{ id: string }>(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Sin preguntar') returning id",
        [hogar.householdId],
      );
      const declaroNada = await h.fila<{ id: string }>(
        `insert into public.guest_profiles (household_id, name, dietary_flags)
         values ($1, 'Dijo que come de todo', '{}'::public.guest_dietary_flag[]) returning id`,
        [hogar.householdId],
      );
      return { sinDato: sinDato!.id, declaroNada: declaroNada!.id };
    });

    const filas = await h.comoAdmin(() =>
      h.filas<{ id: string; dietary_flags: unknown }>(
        "select id, dietary_flags from public.guest_profiles where id = any($1::uuid[])",
        [[ids.sinDato, ids.declaroNada]],
      ),
    );

    const sin = filas.find((f) => f.id === ids.sinDato)!;
    const nada = filas.find((f) => f.id === ids.declaroNada)!;
    expect(
      sin.dietary_flags,
      "nadie preguntó y la base guardó una lista vacía: eso se lee para siempre como 'no tiene nada'",
    ).toBeNull();
    // La lista vacía llega como el literal de arreglo de Postgres, no como null:
    // los dos hechos siguen siendo distinguibles después del viaje de ida y vuelta.
    expect(nada.dietary_flags, "la declaración explícita se perdió").not.toBeNull();
    // Y llega VACÍA, no con contenido inventado. Se normaliza porque el driver
    // devuelve el arreglo de un enum a veces como literal de Postgres ('{}') y
    // a veces ya parseado ([]) según cómo caiga el OID del tipo; lo que este
    // test cuida es el HECHO —lista declarada y sin elementos—, no la forma en
    // que el driver del día lo escriba.
    const vacia = Array.isArray(nada.dietary_flags)
      ? nada.dietary_flags.length === 0
      : String(nada.dietary_flags) === "{}";
    expect(vacia, `la lista declarada llegó con contenido: ${String(nada.dietary_flags)}`).toBe(
      true,
    );

    // Y el apetito y la edad nacen en UNKNOWN, no en NORMAL/ADULT.
    const nuevo = await h.comoAdmin(() =>
      h.fila<{ appetite: string; age_group: string }>(
        `insert into public.guest_profiles (household_id) values ($1)
         returning appetite, age_group`,
        [hogar.householdId],
      ),
    );
    expect(nuevo!.appetite).toBe("UNKNOWN");
    expect(nuevo!.age_group).toBe("UNKNOWN");
  });

  it("un invitado con historia se archiva, no se borra", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado con historia" });
    const invitado = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Tía María') returning id",
        [hogar.householdId],
      ),
    );
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.event_participants (event_id, participant_type, guest_id)
         values ($1, 'GUEST', $2)`,
        [evento, invitado!.id],
      ),
    );

    const borrar = await h.comoAdmin(() =>
      intentar("delete from public.guest_profiles where id = $1", [invitado!.id]),
    );
    expect(borrar.rechazado, "borrar al invitado se llevó su historia por cascada").toBe(true);
  });
});

describe("RLS: nadie mira el asado del vecino", () => {
  it("el hogar de al lado no ve ni escribe invitados ajenos", async () => {
    const invitado = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Amigo Pedro') returning id",
        [hogar.householdId],
      ),
    );

    const visto = await h.como(USER_VECINO, () =>
      h.filas("select id from public.guest_profiles where id = $1", [invitado!.id]),
    );
    expect(visto.length, "el vecino ve la lista de invitados de otra casa").toBe(0);

    const escrito = await h.como(USER_VECINO, () =>
      intentar(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Colado')",
        [hogar.householdId],
      ),
    );
    expect(escrito.rechazado, "el vecino cargó un invitado en el hogar ajeno").toBe(true);

    const editado = await h.como(USER_VECINO, () =>
      intentar("update public.guest_profiles set name = 'Robado' where id = $1", [invitado!.id]),
    );
    expect(noPudo(editado), "el vecino editó un invitado ajeno").toBe(true);

    expect(vecino.memberId).toBeTruthy();
  });

  it("mirar el evento es de todos; armarlo pide permiso para planificar", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado de permisos" });
    await agregarMiembro(evento, hogar.memberId);

    const mirado = await h.como(USER_MIRON, () =>
      h.filas("select id from public.event_participants where event_id = $1", [evento]),
    );
    expect(mirado.length, "un integrante dejó de ver quién viene al asado de su casa").toBe(1);

    const escrito = await h.como(USER_MIRON, () =>
      intentar(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Cuñado')",
        [hogar.householdId],
      ),
    );
    expect(escrito.rechazado, "quien no puede planificar cargó un invitado").toBe(true);

    const planner = await h.como(USER_BETO, () =>
      intentar(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Vecina Rosa')",
        [hogar.householdId],
      ),
    );
    expect(planner.rechazado, `un PLANNER no pudo cargar un invitado: ${planner.mensaje}`).toBe(
      false,
    );

    // Y el rechazo del DELETE es RUIDOSO, no cero filas en silencio (0039 §3-bis).
    const borrado = await h.como(USER_MIRON, () =>
      intentar("delete from public.event_participants where event_id = $1", [evento]),
    );
    expect(borrado.rechazado, "el borrado sin permiso volvió como éxito silencioso").toBe(true);
    expect(borrado.mensaje).toMatch(/permiso/i);

    expect(miembroMiron).toBeTruthy();
  });
});

describe("estimaciones congeladas y asistencia real", () => {
  it("la misma firma devuelve la MISMA revisión, y otra firma crea una nueva", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado que se calcula" });

    const guardar = (firma: string) =>
      h.como(USER_ANA, () =>
        h.fila<{ save_event_estimate_revision: string }>(
          `select public.save_event_estimate_revision(
             $1, $2, 'bbq-quantity/1.0.0', 'bbq-policy/1.0.0',
             '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
          [evento, firma],
        ),
      );

    const una = (await guardar("firma-a"))!.save_event_estimate_revision;
    const otraVez = (await guardar("firma-a"))!.save_event_estimate_revision;
    expect(
      otraVez,
      "apretar dos veces calcular sin cambiar nada creó dos revisiones: después nadie sabe cuál se compró",
    ).toBe(una);

    const distinta = (await guardar("firma-b"))!.save_event_estimate_revision;
    expect(distinta).not.toBe(una);

    const numeros = await h.comoAdmin(() =>
      h.filas<{ revision_number: number }>(
        "select revision_number from public.event_plan_revisions where event_id = $1 order by revision_number",
        [evento],
      ),
    );
    expect(numeros.map((n) => Number(n.revision_number))).toEqual([1, 2]);

    // El árbitro de la idempotencia es el índice único, no el `select` de
    // arriba: con dos planners apretando a la vez, los dos leen "no existe".
    const aMano = await h.comoAdmin(() =>
      intentar(
        `insert into public.event_plan_revisions
           (event_id, revision_number, input_signature, engine_version, policy_version,
            plan_context, participants_snapshot, menu, policy, yield_inputs, estimate_output)
         values ($1, 99, 'firma-a', 'x', 'y', '{}', '[]', '[]', '{}', '{}', '{}')`,
        [evento],
      ),
    );
    expect(
      aMano.rechazado,
      "entraron dos revisiones con la misma firma: la idempotencia no la sostiene nada",
    ).toBe(true);

    // Y la revisión vieja no se puede tocar: es historia congelada (§95).
    const tocar = await h.comoAdmin(() =>
      intentar("update public.event_plan_revisions set override_grams = 9000 where id = $1", [una]),
    );
    expect(tocar.rechazado, "se pudo editar una revisión ya congelada").toBe(true);
  });

  it("marcar asistencia lo puede hacer quien cocina, aunque no planifique", async () => {
    const evento = await crearEvento({ fecha: SABADO, titulo: "Asado del cocinero" });
    const participante = await agregarMiembro(evento, hogar.memberId, "CONFIRMED");

    // A Mirón, que sólo es MEMBER, la base le dice que no.
    const sinPermiso = await h.como(USER_MIRON, () =>
      intentar("select public.record_event_attendance($1, 'ATTENDED')", [participante]),
    );
    expect(sinPermiso.rechazado, "cualquiera pudo marcar la asistencia del asado").toBe(true);

    const cocinero = await integrante(
      "00000000-0000-0000-0000-0000000041a4",
      "Cocinero",
      "COOK",
    );
    expect(cocinero).toBeTruthy();

    const marcado = await h.como("00000000-0000-0000-0000-0000000041a4", () =>
      intentar("select public.record_event_attendance($1, 'ATTENDED')", [participante]),
    );
    expect(
      marcado.rechazado,
      `quien está en la parrilla no pudo pasar lista: ${marcado.mensaje}`,
    ).toBe(false);

    const fila = await h.comoAdmin(() =>
      h.fila<{ attendance_status: string }>(
        "select attendance_status from public.event_participants where id = $1",
        [participante],
      ),
    );
    expect(fila!.attendance_status).toBe("ATTENDED");
  });
});

describe("los cortes no inventan rendimientos", () => {
  it("la tabla nace vacía y no acepta un factor sin fuente", async () => {
    const cuantos = await h.comoAdmin(() =>
      h.fila<{ n: number }>("select count(*)::int as n from public.cut_definitions"),
    );
    expect(
      Number(cuantos!.n),
      "se sembraron factores de rendimiento sin fuente citable: eso es falsa precisión (§13)",
    ).toBe(0);

    const sinFuente = await h.comoAdmin(() =>
      intentar(
        `insert into public.cut_definitions (display_name, bone_in, source)
         values ('Costillar', true, '')`,
      ),
    );
    expect(sinFuente.rechazado, "entró un corte sin identidad ni fuente").toBe(true);

    // Y no existe columna de rendimiento de cocción: ese factor tiene dueño
    // desde la 0009 y dos dueños descuentan la merma dos veces.
    const columnas = await h.comoAdmin(() =>
      h.filas<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'cut_definitions'`,
      ),
    );
    expect(columnas.map((c) => c.column_name)).not.toContain("typical_cooking_yield");
  });
});

// ===========================================================================
// H20 — LA MITAD QUE FALTABA: EL RELEVO, HASTA DONDE LA PERSONA LO VE
//
// El sprint pasado el relevo quedó CERRADO EN LA BASE Y ABIERTO EN LA APP: la
// columna, la vista y el trigger existían, y ninguna consulta de la aplicación
// los miraba. El test que decía cerrarlo consultaba la vista a mano y su
// comentario afirmaba ser «la misma pregunta que se hace futureDemand»: no lo
// era, y por eso pasaba con los lectores rotos.
//
// Los de acá abajo están escritos para NO poder pasar así:
//
//  · el de comportamiento corre las DOS consultas —la de antes y la de ahora—
//    sobre los mismos datos y exige que den distinto. Sin filtro se ven dos
//    almuerzos por comprar; con el filtro, ninguno.
//  · el estático LEE LOS ARCHIVOS DE LA APP y exige que cada consulta de
//    demanda futura descuente `covered_by_event_id`. Si alguien le saca el
//    filtro a stock/queries.ts, este test se pone rojo aunque el SQL de la
//    migración siga perfecto.
// ===========================================================================

const CARGADORES_DE_DEMANDA = [
  "web/src/app/stock/queries.ts",
  "web/src/app/shopping/queries.ts",
  "web/src/app/prep/queries.ts",
];

function fuenteDe(rutaRelativa: string): string {
  return readFileSync(path.join(RAIZ, rutaRelativa), "utf8");
}

/**
 * Las consultas a `member_serving_projections` de un archivo, cada una con el
 * texto que la rodea. Alcanza para distinguir «demanda futura» de «historia de
 * consumo» y para ver si el filtro del relevo está puesto.
 */
function consultasDeProyecciones(fuenteConComentarios: string): { cuerpo: string }[] {
  // Los comentarios se sacan ANTES de medir. Un comentario en español está
  // lleno de comas, y una coma dentro de un comentario cortaba la cadena justo
  // antes del filtro: el guardián acusaba a un archivo que sí filtra. Un
  // guardián que se equivoca en un sentido se equivoca en el otro.
  const fuente = sinComentarios(fuenteConComentarios);
  const marca = '.from("member_serving_projections")';
  const salida: { cuerpo: string }[] = [];
  let desde = 0;
  for (;;) {
    const i = fuente.indexOf(marca, desde);
    if (i === -1) return salida;
    salida.push({ cuerpo: fuente.slice(i, finDeLaCadena(fuente, i + marca.length)) });
    desde = i + marca.length;
  }
}

const SALTO = String.fromCharCode(10);

/** Quita los comentarios de línea y de bloque, respetando comillas y templates. */
function sinComentarios(fuente: string): string {
  let salida = "";
  let enString: string | null = null;
  for (let i = 0; i < fuente.length; i++) {
    const ch = fuente[i]!;
    if (enString !== null) {
      salida += ch;
      if (ch === enString && fuente[i - 1] !== "\\") enString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      enString = ch;
      salida += ch;
      continue;
    }
    if (ch === "/" && fuente[i + 1] === "/") {
      const fin = fuente.indexOf(SALTO, i);
      i = fin === -1 ? fuente.length : fin;
      salida += SALTO;
      continue;
    }
    if (ch === "/" && fuente[i + 1] === "*") {
      const cierre = fuente.indexOf("*/", i + 2);
      i = cierre === -1 ? fuente.length : cierre + 1;
      salida += " ";
      continue;
    }
    salida += ch;
  }
  return salida;
}

/**
 * Dónde termina la cadena `.from(...).select(...)...`: en la primera `;` o `,`
 * que esté al mismo nivel de paréntesis que el `.from`. Se cuenta el nivel en
 * vez de tomar N caracteres a ojo porque la cadena de /shopping mide 905 y la
 * de /prep 380: cualquier ventana fija deja una fuera o mete la de al lado, y
 * las dos formas de equivocarse dejan el guardián mintiendo.
 */
function finDeLaCadena(fuente: string, desde: number): number {
  let nivel = 0;
  let enString: string | null = null;
  for (let i = desde; i < fuente.length; i++) {
    const ch = fuente[i]!;
    if (enString !== null) {
      if (ch === enString && fuente[i - 1] !== "\\") enString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") enString = ch;
    else if (ch === "(" || ch === "[" || ch === "{") nivel++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (nivel === 0) return i;
      nivel--;
    } else if ((ch === ";" || ch === ",") && nivel === 0) return i;
  }
  return fuente.length;
}

/** Proyecta lo que TODAVÍA no se comió, o sea la que hay que filtrar. */
function esDemandaFutura(cuerpo: string): boolean {
  return cuerpo.includes('.eq("status", "PLANNED")') || cuerpo.includes('.in("assignment_id"');
}

/** Una comida confirmada en cualquier semana, creando el plan si hace falta. */
async function comidaConfirmadaEn(
  semana: string,
  fecha: string,
  mealType: string,
  personas: Array<{ memberId: string; perfilId: string }>,
): Promise<{ assignmentId: string }> {
  await h.como(USER_ANA, () =>
    h.db.query("select public.ensure_weekly_plan($1, $2)", [hogar.householdId, semana]),
  );
  return h.comoAdmin(async () => {
    const dia = await h.fila<{ id: string }>(
      `select d.id from public.weekly_plan_days d
       join public.weekly_plans w on w.id = d.plan_id
       where w.household_id = $1 and d.plan_date = $2`,
      [hogar.householdId, fecha],
    );
    const a = await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status, confirmed_at)
       values ($1, $2::public.meal_type, 'RECIPE', $3, 'CONFIRMED', now()) returning id`,
      [dia!.id, mealType, versionPollo],
    );
    for (const p of personas) {
      const proy = await h.fila<{ id: string }>(
        `insert into public.member_serving_projections
           (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
            fit, adaptation_level, assignment_id, status)
         values ($1, $2, $3, 'test/1.0.0', $4::public.meal_type, $5, 'COMPATIBLE', 0, $6, 'PLANNED')
         returning id`,
        [p.memberId, versionPollo, p.perfilId, mealType, fecha, a!.id],
      );
      await h.db.query(
        `insert into public.member_serving_components
           (projection_id, label, base_quantity, proposed_quantity, unit, weight_basis)
         values ($1, 'pollo', 150, 150, 'G', 'RAW')`,
        [proy!.id],
      );
    }
    return { assignmentId: a!.id };
  });
}

/** Qué evento releva la porción de esta persona en esta comida. `null` = ninguno. */
async function relevado(assignmentId: string, memberId: string): Promise<string | null> {
  const fila = await h.comoAdmin(() =>
    h.fila<{ covered_by_event_id: string | null }>(
      `select covered_by_event_id from public.member_serving_projections
       where assignment_id = $1 and member_id = $2`,
      [assignmentId, memberId],
    ),
  );
  if (fila === null) throw new Error("la porción no existe: el escenario no probó lo que dice");
  return fila.covered_by_event_id;
}

describe("[H20 · la app] el relevo llega hasta la lista de compras", () => {
  const SEMANA_APP = weekStart("2026-11-09");
  const SABADO_APP = "2026-11-14";

  it("la consulta de demanda futura de la app deja fuera lo que el evento releva", async () => {
    const { assignmentId } = await comidaConfirmadaEn(SEMANA_APP, SABADO_APP, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: miembroBeto, perfilId: perfilBeto },
    ]);

    const evento = await crearEvento({ fecha: SABADO_APP, titulo: "Asado que sí releva" });
    await agregarMiembro(evento, hogar.memberId);
    await agregarMiembro(evento, miembroBeto);
    await estado(evento, "CONFIRMED");

    // LA CONSULTA VIEJA, la que el sprint pasado dejó en producción: status
    // PLANNED + assignment_id no nulo + fecha de acá en adelante, sin mirar el
    // relevo. Se corre A PROPÓSITO, para que el test MUESTRE la diferencia en
    // vez de afirmarla.
    const sinFiltro = await h.comoAdmin(() =>
      h.filas<{ member_id: string }>(
        `select p.member_id from public.member_serving_projections p
         where p.status = 'PLANNED' and p.assignment_id is not null
           and p.serving_date >= $1 and p.assignment_id = $2
         order by p.member_id`,
        [SABADO_APP, assignmentId],
      ),
    );
    expect(
      sinFiltro.length,
      "el escenario no reproduce el defecto: sin filtro tienen que verse las dos porciones",
    ).toBe(2);

    // LA CONSULTA DE AHORA: la misma más `covered_by_event_id is null`, que es
    // exactamente lo que `soloDemandaAbierta` le agrega al cargador.
    const conFiltro = await h.comoAdmin(() =>
      h.filas<{ member_id: string }>(
        `select p.member_id from public.member_serving_projections p
         where p.status = 'PLANNED' and p.assignment_id is not null
           and p.serving_date >= $1 and p.assignment_id = $2
           and p.covered_by_event_id is null
         order by p.member_id`,
        [SABADO_APP, assignmentId],
      ),
    );
    expect(
      conFiltro,
      "el filtro del relevo no cambió nada: la lista sigue pidiendo el almuerzo del día del asado",
    ).toEqual([]);
  });

  it("ningún cargador de demanda futura de la app se olvida del filtro", () => {
    const olvidos: string[] = [];
    let revisadas = 0;
    for (const archivo of CARGADORES_DE_DEMANDA) {
      const fuente = fuenteDe(archivo);
      for (const consulta of consultasDeProyecciones(fuente)) {
        if (!esDemandaFutura(consulta.cuerpo)) continue;
        revisadas++;
        if (!consulta.cuerpo.includes('.is("covered_by_event_id", null)')) olvidos.push(archivo);
      }
    }
    // Un extractor mudo dejaría el test en verde sin haber mirado nada.
    expect(
      revisadas,
      "el guardián no encontró consultas de demanda futura: está mirando el archivo equivocado",
    ).toBeGreaterThanOrEqual(3);
    expect(
      olvidos,
      "un cargador arma demanda futura sin descontar lo que el evento releva: ese día se compra dos veces",
    ).toEqual([]);
  });

  it("la pantalla lo puede DECIR: la vista trae el evento y a quién releva", async () => {
    const filas = await h.comoAdmin(() =>
      h.filas<{ event_title: string; meal_type: string; member_id: string }>(
        `select event_title, meal_type, member_id
         from public.event_covered_demand where serving_date = $1`,
        [SABADO_APP],
      ),
    );
    expect(
      filas.length,
      "sin esta vista la lista encoge sin explicación, y una lista que encoge sin explicación se compra igual",
    ).toBe(2);
    expect(filas[0]!.event_title).toBe("Asado que sí releva");
    expect(filas[0]!.meal_type).toBe("LUNCH");

    // Y el texto sale en chileno, con el día, la comida, la gente y el evento.
    const texto = textoDelRelevo({
      eventoId: "da-lo-mismo",
      titulo: filas[0]!.event_title,
      fecha: SABADO_APP,
      comida: "LUNCH",
      comidaCruda: "LUNCH",
      personas: ["Ana", "Beto"],
    });
    expect(texto).toContain("Sábado");
    expect(texto).toContain("no se compra almuerzo");
    expect(texto).toContain("Asado que sí releva");
  });

  it("la lista de compras de la pantalla recibe y dibuja los relevos", () => {
    const pagina = fuenteDe("web/src/app/shopping/page.tsx");
    const tablero = fuenteDe("web/src/app/shopping/ShoppingBoard.tsx");
    expect(pagina, "la página de compras no carga los relevos").toContain("cargarRelevosDeEventos(");
    expect(pagina, "los relevos no llegan al tablero").toContain("relevos={relevos}");
    expect(
      tablero,
      "el tablero recibe los relevos y no los dibuja: el relevo vuelve a ser invisible",
    ).toContain("textoDelRelevo(r)");
  });
});

// ===========================================================================
// H20 — LA LLAVE: `nutrition_events.meal_type` la escribe la aplicación
// ===========================================================================

describe("[H20 · la llave] la app declara qué comida reemplaza el evento", () => {
  it("crear y editar el evento escriben qué comidas reemplaza", () => {
    // ACTUALIZADO POR LA 0061, Y VALE LA PENA DECIR QUÉ CAMBIÓ.
    //
    // Este guardián nació para impedir que la llave del relevo se quedara sin
    // escritor: hasta el sprint 13 ninguna ruta de la app escribía `meal_type`,
    // todo evento nacía en NULL y la compra salía doble. Eso sigue siendo lo
    // que se protege; cambió DÓNDE vive la llave.
    //
    // Desde la 0061 el dueño es `public.event_covered_meals` —un evento puede
    // reemplazar el almuerzo Y la cena— y `nutrition_events.meal_type` quedó
    // como espejo de la primera. `guardarConfiguracion` DEJÓ de escribirla a
    // propósito: dos caminos de la app escribiendo el mismo hecho terminaban
    // con el que sólo sabe de una comida borrando la otra en silencio.
    //
    // Así que la afirmación se muda con la llave, en vez de borrarse: lo que no
    // puede pasar es que ninguna ruta declare qué reemplaza el evento.
    const acciones = fuenteDe("web/src/app/eventos/actions.ts");
    expect(
      acciones,
      "crearEvento no escribe meal_type: todo evento nace en NULL y el relevo no se intenta nunca",
    ).toContain("meal_type: validado.data.comida");
    expect(
      acciones,
      "ninguna acción escribe event_covered_meals: las comidas que reemplaza el evento quedan sin escritor",
    ).toContain('.from("event_covered_meals")');
    expect(
      acciones,
      "guardarConfiguracion volvió a escribir meal_type: son dos dueños del mismo hecho y el que sabe de una comida borra la otra",
    ).not.toContain("fila.meal_type = campos.comida");

    const tablero = fuenteDe("web/src/app/eventos/[id]/TableroEvento.tsx");
    expect(
      tablero,
      "la pantalla del evento no pregunta qué comidas reemplaza: la llave del relevo queda sin escritor",
    ).toContain("agregarComidaCubierta({ eventoId: evento.id, comida: valor })");
    expect(
      tablero,
      "la pantalla no deja SACAR una comida cubierta: declarar de más no se podría deshacer y esa comida no se compraría nunca",
    ).toContain("quitarComidaCubierta({ eventoId: evento.id, comida: valor })");

    // Y se pregunta ya al crearlo, que es donde la persona está pensando en el
    // día. El armador puede dejarla sin responder —no se rellena con "almuerzo"
    // por si acaso—, pero la pregunta tiene que estar.
    const formulario = fuenteDe("web/src/app/eventos/nuevo/FormularioNuevoEvento.tsx");
    expect(
      formulario,
      "el paso 1 no manda la comida: el evento nace en NULL y hay que acordarse de volver",
    ).toContain("tipo, fecha, comida }");
  });

  it("declarar la comida DESPUÉS de confirmar releva igual, y sacarla la devuelve", async () => {
    const semana = weekStart("2026-12-07");
    const fecha = "2026-12-12";
    const { assignmentId } = await comidaConfirmadaEn(semana, fecha, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);

    // Nace SIN comida declarada, que es exactamente como los creaba la app.
    const evento = await crearEvento({
      fecha,
      mealType: null,
      titulo: "Asado al que le faltaba la comida",
    });
    await agregarMiembro(evento, hogar.memberId);
    await estado(evento, "CONFIRMED");
    expect(await relevado(assignmentId, hogar.memberId)).toBeNull();

    // La persona responde la pregunta en el tablero: `guardarConfiguracion`
    // hace este UPDATE sobre un evento YA confirmado.
    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set meal_type = 'LUNCH' where id = $1", [evento]),
    );
    expect(
      await relevado(assignmentId, hogar.memberId),
      "declarar la comida sobre un evento confirmado no relevó nada: la respuesta no sirvió de nada",
    ).toBe(evento);

    // Y si se retracta, la comida vuelve a la lista: sacar la llave no puede
    // dejar el relevo puesto sin nada que lo sostenga.
    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set meal_type = null where id = $1", [evento]),
    );
    expect(
      await relevado(assignmentId, hogar.memberId),
      "se borró la comida del evento y el almuerzo quedó relevado igual: ese día no se come",
    ).toBeNull();
  });
});

// ===========================================================================
// H20 — RECONFIRMAR LA COMIDA NO BORRA EL RELEVO
// ===========================================================================

describe("[H20 · reconfirmar] el relevo sobrevive a rehacer las porciones", () => {
  it("confirm_meal_assignment rehace las porciones y el relevo sigue puesto", async () => {
    const semana = weekStart("2026-11-09");
    const fecha = "2026-11-15";
    const { assignmentId } = await comidaConfirmadaEn(semana, fecha, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);

    const evento = await crearEvento({ fecha, titulo: "Asado que se reconfirma" });
    await agregarMiembro(evento, hogar.memberId);
    await estado(evento, "CONFIRMED");
    expect(await relevado(assignmentId, hogar.memberId)).toBe(evento);

    // El propio evento empuja a esto: `events_flag_meals` marca la comida con
    // needs_review «Cambió un evento de ese día», así que reconfirmar es el
    // paso siguiente natural. Antes, ese paso borraba el relevo EN SILENCIO y
    // la demanda doble volvía sola.
    await h.como(USER_ANA, () =>
      h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        assignmentId,
        JSON.stringify([
          {
            member_id: hogar.memberId,
            version_id: versionPollo,
            profile_id: perfilAna,
            optimizer_version: "test/1.0.0",
            meal_type: "LUNCH",
            serving_date: fecha,
            fit: "COMPATIBLE",
            adaptation_level: 0,
            score: 90,
            nutrition: {},
            completeness: {},
            reasons: [],
            unmet_constraints: [],
            components: [
              {
                label: "pollo",
                base_quantity: 150,
                proposed_quantity: 150,
                unit: "G",
                weight_basis: "RAW",
                cooking_method: "BAKED",
                sort_order: 1,
              },
            ],
            substitutions: [],
          },
        ]),
      ]),
    );

    expect(
      await relevado(assignmentId, hogar.memberId),
      "reconfirmar la comida borró el relevo en silencio: la demanda doble vuelve sola y sin aviso",
    ).toBe(evento);
  });

  it("pero una porción nueva NO hereda el relevo de quien se bajó del evento", async () => {
    const semana = weekStart("2026-11-09");
    const fecha = "2026-11-13";
    const { assignmentId } = await comidaConfirmadaEn(semana, fecha, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);

    const evento = await crearEvento({ fecha, titulo: "Asado con uno que se baja" });
    await agregarMiembro(evento, hogar.memberId);
    await agregarMiembro(evento, miembroBeto, "DECLINED");
    await estado(evento, "CONFIRMED");

    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.member_serving_projections
           (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
            fit, adaptation_level, assignment_id, status)
         values ($1, $2, $3, 'test/1.0.0', 'LUNCH', $4, 'COMPATIBLE', 0, $5, 'PLANNED')`,
        [miembroBeto, versionPollo, perfilBeto, fecha, assignmentId],
      ),
    );

    expect(
      await relevado(assignmentId, miembroBeto),
      "una porción nueva heredó el relevo de alguien que dijo que NO iba: ese día se queda sin comer",
    ).toBeNull();
  });
});

// ===========================================================================
// H20 — MOVER EL EVENTO MUEVE EL RELEVO
// ===========================================================================

describe("[H20 · mover] correr la fecha o la comida arrastra el relevo", () => {
  it("un evento CONFIRMED que se corre de sábado a domingo suelta el sábado y toma el domingo", async () => {
    const semana = weekStart("2026-11-16");
    const sabado = "2026-11-21";
    const domingo = "2026-11-22";
    const viejo = await comidaConfirmadaEn(semana, sabado, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);
    const nuevo = await comidaConfirmadaEn(semana, domingo, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);

    const evento = await crearEvento({ fecha: sabado, titulo: "Asado que se corre un día" });
    await agregarMiembro(evento, hogar.memberId);
    await estado(evento, "CONFIRMED");
    expect(await relevado(viejo.assignmentId, hogar.memberId)).toBe(evento);
    expect(await relevado(nuevo.assignmentId, hogar.memberId)).toBeNull();

    // Esto es lo que hace `guardarConfiguracion` desde el armador: escribe la
    // fecha sin mirar el estado. El history guard sólo congela los terminales.
    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set event_date = $2::date where id = $1", [
        evento,
        domingo,
      ]),
    );

    expect(
      await relevado(viejo.assignmentId, hogar.memberId),
      "el evento se movió y el día VIEJO quedó relevado sin evento: nadie compra ese almuerzo",
    ).toBeNull();
    expect(
      await relevado(nuevo.assignmentId, hogar.memberId),
      "el evento se movió y el día NUEVO quedó sin relevar: ese día se compra dos veces",
    ).toBe(evento);

    const registro = await h.comoAdmin(() =>
      h.fila<{ metadata: { cobertura: { reason: string } } }>(
        `select metadata from public.audit_events
         where subject_id = $1 and action = 'EVENT_MEAL_COVERAGE_MOVED'`,
        [evento],
      ),
    );
    expect(registro!.metadata.cobertura.reason).toBe("OK");
  });

  it("cambiar de almuerzo a cena mueve el relevo a la cena", async () => {
    const semana = weekStart("2026-11-23");
    const fecha = "2026-11-28";
    const almuerzo = await comidaConfirmadaEn(semana, fecha, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);
    const cena = await comidaConfirmadaEn(semana, fecha, "DINNER", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);

    const evento = await crearEvento({ fecha, titulo: "Asado que se pasa a la noche" });
    await agregarMiembro(evento, hogar.memberId);
    await estado(evento, "CONFIRMED");
    expect(await relevado(almuerzo.assignmentId, hogar.memberId)).toBe(evento);

    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set meal_type = 'DINNER' where id = $1", [evento]),
    );

    expect(
      await relevado(almuerzo.assignmentId, hogar.memberId),
      "el asado se pasó a la noche y el almuerzo siguió relevado: ese almuerzo no lo compra nadie",
    ).toBeNull();
    expect(
      await relevado(cena.assignmentId, hogar.memberId),
      "el asado se pasó a la noche y la cena siguió pidiendo su comida: se compra dos veces",
    ).toBe(evento);
  });

  it("mover un evento que todavía NO está confirmado no toca el plan", async () => {
    const semana = weekStart("2026-11-30");
    const fecha = "2026-12-05";
    const { assignmentId } = await comidaConfirmadaEn(semana, fecha, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);
    const evento = await crearEvento({ fecha, titulo: "Asado todavía en planificación" });
    await agregarMiembro(evento, hogar.memberId);

    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set event_date = $2::date where id = $1", [
        evento,
        "2026-12-06",
      ]),
    );

    // Un evento sin confirmar todavía puede no ocurrir: su comida sigue en la
    // lista, que es lo correcto.
    expect(await relevado(assignmentId, hogar.memberId)).toBeNull();
    const movido = await h.comoAdmin(() =>
      h.filas(
        `select 1 from public.audit_events
         where subject_id = $1 and action = 'EVENT_MEAL_COVERAGE_MOVED'`,
        [evento],
      ),
    );
    expect(movido).toHaveLength(0);
  });
});
