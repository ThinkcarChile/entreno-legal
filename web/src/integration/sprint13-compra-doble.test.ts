import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * EL TEST DE PUNTA A PUNTA QUE LE FALTABA AL SPRINT 13.
 *
 * La pregunta es una sola y se contesta con plata: el sábado del asado, ¿la
 * familia compra el almuerzo Y la carne, o sólo la carne?
 *
 * El Sprint 13 cerró esa pregunta EN LA BASE —la columna
 * `member_serving_projections.covered_by_event_id`, la vista
 * `public.open_serving_demand` y `app.apply_event_meal_coverage`, todo escrito y
 * todo probado— y la dejó ABIERTA EN LA APP: ninguna consulta de la aplicación
 * leía la marca, y ninguna ruta de la aplicación escribía `nutrition_events
 * .meal_type`, que es la llave sin la cual el relevo ni siquiera se intenta.
 *
 * Los tests del sprint no lo vieron porque preguntaban por la marca en la
 * VISTA, que es la puerta que nadie usaba. Este archivo pregunta por las tres
 * puertas que sí decide la plata, en orden:
 *
 *   1. ¿El evento que crea la APLICACIÓN trae `meal_type`? Sin eso la cobertura
 *      corta en `EVENT_MEAL_TYPE_UNKNOWN` y no releva nada.
 *   2. ¿La base marca el relevo? (lo único que el sprint sí probaba)
 *   3. ¿Lo LEEN los dos generadores de demanda futura de la aplicación —la
 *      lista de compras de /shopping y el análisis de stock—, que son los que
 *      terminan en un carro de supermercado?
 *
 * Una invariante cerrada en la base y no leída por la app NO está cerrada.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const PENDIENTES = [
  "supabase/migrations/0039_permisos_plan_y_cocina.sql",
  "supabase/migrations/0040_adaptive_reviews.sql",
  "supabase/migrations/0041_eventos_avanzados.sql",
];

const USER_ANA = "00000000-0000-0000-0000-0000000413d1";
const USER_BETO = "00000000-0000-0000-0000-0000000413d2";

// Sábado 2026-09-12, dentro de la semana del lunes 2026-09-07.
const SEMANA = weekStart("2026-09-07");
const SABADO = "2026-09-12";
/** El contrafáctico vive en su propio día: un evento que salió del borrador ya
 *  no se puede borrar (su historia queda), así que compartir fecha con el caso
 *  bueno dejaría dos asados el mismo sábado y el test se estaría probando a sí
 *  mismo mal. */
const DOMINGO = "2026-09-13";
/** El "hoy" del hogar. No hay reloj acá: el día civil entra por parámetro. */
const HOY = "2026-09-07";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let miembroBeto: string;
let perfilAna: string;
let perfilBeto: string;
let versionPollo: string;
let planId: string;

/** Aplica una migración sólo si todavía no está: el arnés podría adelantarse. */
async function asegurar(testigoSql: string, archivo: string): Promise<void> {
  const ya = await h.comoAdmin(() => h.fila(testigoSql));
  if (ya) return;
  await h.comoAdmin(() => h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8")));
}

async function publicarPerfil(memberId: string, firma: string): Promise<string> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', $2, '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'sprint13-compra-doble')`,
      [memberId, firma],
    ),
  );
  return r!.publish_nutrition_profile;
}

/**
 * El plan normal de la familia para el sábado: un almuerzo CONFIRMADO con una
 * porción planificada y sus gramos por persona. Es exactamente lo que la lista
 * de compras de la semana convierte en renglones del súper.
 */
async function almuerzoConfirmado(fecha: string): Promise<{ assignmentId: string }> {
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
    for (const p of [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: miembroBeto, perfilId: perfilBeto },
    ]) {
      const proy = await h.fila<{ id: string }>(
        `insert into public.member_serving_projections
           (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
            fit, adaptation_level, assignment_id, status)
         values ($1, $2, $3, 'test/1.0.0', 'LUNCH', $4, 'COMPATIBLE', 0, $5, 'PLANNED')
         returning id`,
        [p.memberId, versionPollo, p.perfilId, fecha, a!.id],
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

/**
 * EL EVENTO TAL COMO LO CREA LA APLICACIÓN.
 *
 * Las columnas son las que escribe `crearEvento` en
 * `web/src/app/eventos/actions.ts`. `mealType` entra por parámetro para que el
 * test pueda mostrar las dos realidades: con `null` (lo que la app escribía) el
 * relevo no ocurre, y ese es el defecto.
 */
async function eventoComoLaApp(mealType: string | null, fecha: string): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.nutrition_events
         (household_id, title, event_type, event_date, meal_type, status)
       values ($1, 'Asado', 'BARBECUE', $2::date, $3::public.meal_type, 'DRAFT')
       returning id`,
      [hogar.householdId, fecha, mealType],
    ),
  );
  return r!.id;
}

async function invitar(eventId: string, memberId: string): Promise<void> {
  await h.comoAdmin(() =>
    h.db.query(
      `insert into public.event_participants
         (event_id, participant_type, member_id, attendance_status)
       values ($1, 'HOUSEHOLD_MEMBER', $2, 'CONFIRMED')`,
      [eventId, memberId],
    ),
  );
}

/**
 * El camino real del armador: DRAFT → PLANNED → CONFIRMED. El guard de la 0041
 * no admite saltarse PLANNED, y saltárselo acá probaría un camino que la
 * aplicación no puede recorrer.
 */
async function confirmar(eventId: string): Promise<void> {
  await h.comoAdmin(async () => {
    for (const estado of ["PLANNED", "CONFIRMED"]) {
      await h.db.query(
        "update public.nutrition_events set status = $2::public.event_status where id = $1",
        [eventId, estado],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// LOS DOS LECTORES DE DEMANDA FUTURA DE LA APLICACIÓN, transcritos
// ---------------------------------------------------------------------------
//
// No se consulta la vista `open_serving_demand`: preguntarle a la puerta que la
// migración abrió es preguntarle al arreglo por sí mismo, y eso es justo lo que
// dejó pasar el bloqueante. Se consulta lo que consultan las dos pantallas que
// terminan en un carro de supermercado. Cada helper dice de qué archivo salió,
// y el caso [3] comprueba aparte que esos archivos sigan filtrando el relevo:
// una transcripción que se quede vieja mentiría en verde, y esa comprobación es
// la que no la deja.

/**
 * `loadShoppingListData` — web/src/app/shopping/queries.ts: las porciones de
 * las comidas CONFIRMADAS de la semana, que es de donde salen los renglones.
 */
async function loQuePideLaListaDeCompras(fecha: string): Promise<string[]> {
  const filas = await h.comoAdmin(() =>
    h.filas<{ member_id: string }>(
      `select p.member_id
         from public.member_serving_projections p
         join public.meal_assignments a on a.id = p.assignment_id
         join public.weekly_plan_days d on d.id = a.day_id
        where d.plan_id = $1
          and d.plan_date = $2::date
          and a.status in ('CONFIRMED', 'SERVED')
          and p.status <> 'CANCELLED'
          and p.covered_by_event_id is null
        order by p.member_id`,
      [planId, fecha],
    ),
  );
  return filas.map((f) => f.member_id);
}

/**
 * `futureDemand` — web/src/app/stock/queries.ts: la demanda planificada de acá
 * en adelante, la que el análisis de stock netea contra la despensa.
 */
async function loQueVeElAnalisisDeStock(fecha: string): Promise<string[]> {
  const filas = await h.comoAdmin(() =>
    h.filas<{ member_id: string }>(
      `select p.member_id
         from public.member_serving_projections p
        where p.status = 'PLANNED'
          and p.assignment_id is not null
          and p.member_id = any($1::uuid[])
          and p.serving_date >= $2::date
          and p.serving_date = $3::date
          and p.covered_by_event_id is null
        order by p.member_id`,
      [[hogar.memberId, miembroBeto], HOY, fecha],
    ),
  );
  return filas.map((f) => f.member_id);
}

/** Los dos integrantes, en el mismo orden que devuelven las consultas. */
function losDos(): string[] {
  return [hogar.memberId, miembroBeto].sort((a, b) => a.localeCompare(b));
}

/** El texto de un archivo de producción, para preguntarle si lee la marca. */
function fuente(relativa: string): string {
  return readFileSync(path.join(RAIZ, relativa), "utf8");
}

beforeAll(async () => {
  h = await levantarBase();

  await asegurar(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'can_edit_plan'`,
    PENDIENTES[0]!,
  );
  await asegurar(
    "select 1 where to_regclass('public.adaptive_nutrition_reviews') is not null",
    PENDIENTES[1]!,
  );
  await asegurar(
    "select 1 where to_regclass('public.event_participants') is not null",
    PENDIENTES[2]!,
  );

  hogar = await crearHogar(h, USER_ANA, "Hogar del sábado", "Ana");

  miembroBeto = await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_BETO,
      "beto13d@test.dev",
    ]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, 'Beto', '1990-01-01') returning id`,
      [hogar.householdId, USER_BETO],
    );
    return m!.id;
  });

  versionPollo = (await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `select v.id from public.meal_template_versions v
       join public.meal_templates t on t.id = v.template_id
       where v.status = 'PUBLISHED' limit 1`,
    ),
  ))!.id;

  perfilAna = await publicarPerfil(hogar.memberId, "firma-ana-13d");
  perfilBeto = await publicarPerfil(miembroBeto, "firma-beto-13d");

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
// [1] La llave: el evento que crea la APP tiene que traer meal_type
// ===========================================================================

describe("[1] el evento nacido en la aplicación trae la llave del relevo", () => {
  it("la ruta que crea el evento escribe meal_type", () => {
    // Una afirmación sobre el CÓDIGO y no sobre la base, a propósito: el
    // defecto no era que la base estuviera mal, era que la aplicación nunca
    // llenaba la columna de la que depende toda la cadena de abajo. Contra la
    // base sola ese hueco es invisible —el test escribe el meal_type que la app
    // no escribía— y así fue como pasó.
    const actions = fuente("web/src/app/eventos/actions.ts");
    expect(
      actions.includes("meal_type"),
      "web/src/app/eventos/actions.ts no escribe nutrition_events.meal_type: " +
        "sin esa llave app.apply_event_meal_coverage corta en EVENT_MEAL_TYPE_UNKNOWN " +
        "y el asado no releva ninguna comida, así que la familia compra las dos cosas",
    ).toBe(true);
  });

  it("un evento SIN meal_type no releva nada: la comida de ese día se compra igual", async () => {
    // El contrafáctico, en su propio día, para que se vea POR QUÉ importa lo de
    // arriba. Es literalmente lo que pasaba antes: el armador creaba el evento
    // sin meal_type, `app.apply_event_meal_coverage` cortaba en
    // EVENT_MEAL_TYPE_UNKNOWN, y la comida de ese día seguía en la lista.
    await almuerzoConfirmado(DOMINGO);
    const evento = await eventoComoLaApp(null, DOMINGO);
    await invitar(evento, hogar.memberId);
    await invitar(evento, miembroBeto);
    await confirmar(evento);

    const marcas = await h.comoAdmin(() =>
      h.filas<{ covered_by_event_id: string | null }>(
        `select covered_by_event_id from public.member_serving_projections
          where serving_date = $1`,
        [DOMINGO],
      ),
    );
    expect(marcas).toHaveLength(2);
    expect(marcas.every((m) => m.covered_by_event_id === null)).toBe(true);

    // Y la consecuencia, dicha en la moneda del problema: las dos comidas
    // siguen pedidas mientras la carne del evento también se pide.
    expect(await loQuePideLaListaDeCompras(DOMINGO)).toEqual(losDos());
    expect(await loQueVeElAnalisisDeStock(DOMINGO)).toEqual(losDos());

    // El motivo queda escrito y NOMBRADO, no se pierde en un cero: sin esto la
    // pantalla no tiene cómo decir "este asado no reemplazó ninguna comida, y
    // el motivo es que no sabemos qué comida del día cubre".
    const auditoria = await h.comoAdmin(() =>
      h.fila<{ metadata: { reason?: string; servings?: number } }>(
        `select metadata from public.audit_events
          where action = 'EVENT_MEAL_COVERAGE_APPLIED' and subject_id = $1
          order by created_at desc limit 1`,
        [evento],
      ),
    );
    expect(auditoria, "el no-relevo no dejó rastro: nadie puede explicar por qué se compra doble")
      .not.toBeNull();
    expect(auditoria!.metadata.reason).toBe("EVENT_MEAL_TYPE_UNKNOWN");
  });
});

// ===========================================================================
// [2] EL CASO: sábado con asado y con el plan normal encima
// ===========================================================================

describe("[2] el sábado del asado la lista NO pide las dos cosas", () => {
  it("la carne reemplaza el almuerzo en las DOS pantallas donde se gasta la plata", async () => {
    await almuerzoConfirmado(SABADO);

    // El punto de partida: dos almuerzos por comprar, uno por persona.
    expect(await loQuePideLaListaDeCompras(SABADO)).toEqual(losDos());
    expect(await loQueVeElAnalisisDeStock(SABADO)).toEqual(losDos());

    // La familia arma el asado para ese mismo sábado, al mediodía, con los dos.
    const evento = await eventoComoLaApp("LUNCH", SABADO);
    await invitar(evento, hogar.memberId);
    await invitar(evento, miembroBeto);
    await confirmar(evento);

    // (a) La base marca el relevo. Esto es lo único que el sprint probaba.
    const marcas = await h.comoAdmin(() =>
      h.filas<{ member_id: string; covered_by_event_id: string | null }>(
        `select member_id, covered_by_event_id
           from public.member_serving_projections
          where serving_date = $1 order by member_id`,
        [SABADO],
      ),
    );
    expect(
      marcas.every((m) => m.covered_by_event_id === evento),
      "la base no marcó el relevo: app.apply_event_meal_coverage no corrió o no encontró la comida",
    ).toBe(true);

    // (b) Y ACÁ ESTÁ LA PLATA: los dos lectores de la aplicación tienen que
    // dejar de pedir esos almuerzos. Si esto falla, el sábado se compra el
    // almuerzo Y la carne — que es el bloqueante que este sprint existía para
    // cerrar, con una capa de SQL encima que da la sensación de estar resuelto.
    expect(
      await loQuePideLaListaDeCompras(SABADO),
      "la lista de compras sigue pidiendo el almuerzo del sábado además de la carne del asado",
    ).toEqual([]);
    expect(
      await loQueVeElAnalisisDeStock(SABADO),
      "el análisis de stock sigue contando el almuerzo del sábado como demanda por cubrir",
    ).toEqual([]);
  });

  it("y cancelar el asado devuelve los dos almuerzos a la lista", async () => {
    // El relevo tiene que ser reversible por la misma puerta: si al cancelar la
    // comida no vuelve, nadie compra ese almuerzo y el sábado a las dos de la
    // tarde no hay nada que hacer. Ése es el error que no se puede deshacer.
    const evento = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `select id from public.nutrition_events
          where household_id = $1 and event_date = $2::date and status = 'CONFIRMED'`,
        [hogar.householdId, SABADO],
      ),
    );
    expect(evento, "no quedó el asado confirmado del sábado que este caso viene a cancelar").not
      .toBeNull();
    await h.comoAdmin(() =>
      h.db.query(
        "update public.nutrition_events set status = 'CANCELLED'::public.event_status where id = $1",
        [evento!.id],
      ),
    );

    expect(await loQuePideLaListaDeCompras(SABADO)).toEqual(losDos());
    expect(await loQueVeElAnalisisDeStock(SABADO)).toEqual(losDos());
  });
});

// ===========================================================================
// [3] Que los lectores de verdad filtren, y no sólo esta transcripción
// ===========================================================================

describe("[3] los dos lectores de demanda futura leen la marca de relevo", () => {
  /**
   * El caso [2] transcribe las consultas de producción. Una transcripción se
   * queda vieja sola, y una que se quede vieja pasaría en verde afirmando algo
   * que la aplicación ya no hace — que es la forma exacta del bloqueante.
   * Estos dos casos son el ancla: preguntan si los archivos que de verdad
   * arman la lista y el análisis siguen mirando `covered_by_event_id`.
   */
  it("la lista de compras filtra el relevo", () => {
    const src = fuente("web/src/app/shopping/queries.ts");
    expect(
      src.includes("covered_by_event_id") || src.includes("open_serving_demand"),
      "web/src/app/shopping/queries.ts no filtra covered_by_event_id: la lista de la semana " +
        "sigue pidiendo la comida que el asado ya cubre",
    ).toBe(true);
  });

  it("el análisis de stock filtra el relevo", () => {
    const src = fuente("web/src/app/stock/queries.ts");
    expect(
      src.includes("covered_by_event_id") || src.includes("open_serving_demand"),
      "web/src/app/stock/queries.ts (futureDemand) no filtra covered_by_event_id: la demanda " +
        "relevada por el evento se sigue contando contra la despensa",
    ).toBe(true);
  });
});
