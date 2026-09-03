import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * CIERRE v1 · EVENTOS — la 0061, probada por lo que cuesta cuando falla.
 *
 * Dos defectos, dos costos:
 *
 *   [E1] Ningún evento se podía borrar. `status` nacía en 'PLANNED' y el guard
 *        de la 0041 sólo deja el DELETE físico en 'DRAFT'. El evento creado por
 *        error hace diez segundos quedaba pegado para siempre, y el rollback de
 *        `saveEvent` —que borra el evento cuando no pudo guardar a quiénes
 *        afecta— también rebotaba, dejando en pantalla un "bórralo a mano" que
 *        a mano tampoco se podía.
 *
 *   [E2] El asado de nueve horas relevaba UNA comida. `meal_type` es una sola,
 *        así que esa noche la familia compraba y cocinaba una cena que nadie
 *        iba a comer.
 *
 * LA MIGRACIÓN SE APLICA ACÁ ADENTRO y no desde el arnés: mientras se escribe,
 * la 0061 no está enganchada a `MIGRACIONES`. Es el mismo camino que usa
 * `ensayo-despliegue.test.ts` — leer el archivo y `exec`.
 *
 * Y se aplica SÓLO SI FALTA. El día que el arnés la enganche, aplicarla otra
 * vez moriría con "la relación event_covered_meals ya existe" y este archivo
 * entero se saltaría con un rojo que no habla de eventos. Se pregunta primero.
 *
 * CADA AFIRMACIÓN DE ESTE ARCHIVO SE COMPROBÓ POR MUTACIÓN: se rompió a mano lo
 * que protege, se vio el rojo con su mensaje, y se restauró. Está anotado caso
 * por caso.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const MIGRACION = "supabase/migrations/0061_eventos_borrador_y_comidas_cubiertas.sql";

const USER_ANA = "00000000-0000-0000-0000-0000c1e50001";
const USER_BETO = "00000000-0000-0000-0000-0000c1e50002";
const USER_VECINA = "00000000-0000-0000-0000-0000c1e50003";

const SEMANA = weekStart("2027-03-01");
const LUNES = "2027-03-01";
const MARTES = "2027-03-02";
const MIERCOLES = "2027-03-03";
const JUEVES = "2027-03-04";
const VIERNES = "2027-03-05";
const SABADO = "2027-03-06";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let beto: string;
let perfilAna: string;
let perfilBeto: string;
let versionPollo: string;
let planId: string;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

interface Intento {
  rechazado: boolean;
  mensaje: string;
}

async function intentar(sql: string, params: unknown[] = []): Promise<Intento> {
  try {
    await h.db.query(sql, params);
    return { rechazado: false, mensaje: "" };
  } catch (e) {
    return { rechazado: true, mensaje: e instanceof Error ? e.message : String(e) };
  }
}

async function publicarPerfil(memberId: string, firma: string): Promise<string> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', $2, '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'cierre-eventos')`,
      [memberId, firma],
    ),
  );
  return r!.publish_nutrition_profile;
}

/** Un slot CONFIRMADO con una porción por persona: lo que /shopping compra. */
async function comidaDelPlan(
  fecha: string,
  comida: string,
  quienes: { memberId: string; perfilId: string }[],
): Promise<string> {
  return h.comoAdmin(async () => {
    const dia = await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planId, fecha],
    );
    const a = await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, version_id, status, confirmed_at)
       values ($1, $2::public.meal_type, 'RECIPE', $3, 'CONFIRMED', now()) returning id`,
      [dia!.id, comida, versionPollo],
    );
    for (const p of quienes) {
      await h.db.query(
        `insert into public.member_serving_projections
           (member_id, version_id, profile_id, optimizer_version, meal_type, serving_date,
            fit, adaptation_level, assignment_id, status)
         values ($1, $2, $3, 'test/1.0.0', $4::public.meal_type, $5::date, 'COMPATIBLE', 0, $6, 'PLANNED')`,
        [p.memberId, versionPollo, p.perfilId, comida, fecha, a!.id],
      );
    }
    return a!.id;
  });
}

/** Crea el evento SIN mandar status: lo que hace `saveEvent` de /plan. */
async function eventoSinEstado(fecha: string, titulo: string, comida?: string): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.nutrition_events (household_id, event_date, event_type, title, meal_type)
       values ($1, $2::date, 'BARBECUE', $3, $4::public.meal_type) returning id`,
      [hogar.householdId, fecha, titulo, comida ?? null],
    ),
  );
  return r!.id;
}

async function invitar(eventId: string, memberId: string): Promise<void> {
  await h.comoAdmin(() =>
    h.db.query(
      `insert into public.event_participants (event_id, participant_type, member_id, attendance_status)
       values ($1, 'HOUSEHOLD_MEMBER', $2, 'CONFIRMED')`,
      [eventId, memberId],
    ),
  );
}

async function estado(eventId: string, valor: string): Promise<void> {
  await h.comoAdmin(() =>
    h.db.query("update public.nutrition_events set status = $2::public.event_status where id = $1", [
      eventId,
      valor,
    ]),
  );
}

/** DRAFT -> PLANNED -> CONFIRMED, el único camino que el guard admite. */
async function confirmar(eventId: string): Promise<void> {
  await estado(eventId, "PLANNED");
  await estado(eventId, "CONFIRMED");
}

async function cubrir(eventId: string, comidas: string[]): Promise<void> {
  await h.comoAdmin(async () => {
    for (const c of comidas) {
      await h.db.query(
        `insert into public.event_covered_meals (event_id, meal_type)
         values ($1, $2::public.meal_type) on conflict do nothing`,
        [eventId, c],
      );
    }
  });
}

async function comidasCubiertas(eventId: string): Promise<string[]> {
  const filas = await h.comoAdmin(() =>
    h.filas<{ meal_type: string }>(
      "select meal_type from public.event_covered_meals where event_id = $1 order by meal_type",
      [eventId],
    ),
  );
  return filas.map((f) => f.meal_type);
}

/** `loadShoppingListData` — web/src/app/shopping/queries.ts, transcrito. */
async function loQuePideLaLista(fecha: string, comida: string): Promise<string[]> {
  const filas = await h.comoAdmin(() =>
    h.filas<{ member_id: string }>(
      `select p.member_id
         from public.member_serving_projections p
         join public.meal_assignments a on a.id = p.assignment_id
         join public.weekly_plan_days d on d.id = a.day_id
        where d.plan_id = $1
          and d.plan_date = $2::date
          and a.meal_type = $3::public.meal_type
          and a.status in ('CONFIRMED', 'SERVED')
          and p.status <> 'CANCELLED'
          and p.covered_by_event_id is null
        order by p.member_id`,
      [planId, fecha, comida],
    ),
  );
  return filas.map((f) => f.member_id);
}

/** `public.open_serving_demand` — la puerta única de la demanda abierta. */
async function demandaAbierta(fecha: string, comida: string): Promise<string[]> {
  const filas = await h.comoAdmin(() =>
    h.filas<{ member_id: string }>(
      `select o.member_id
         from public.open_serving_demand o
         join public.meal_assignments a on a.id = o.assignment_id
        where o.serving_date = $1::date and a.meal_type = $2::public.meal_type
        order by o.member_id`,
      [fecha, comida],
    ),
  );
  return filas.map((f) => f.member_id);
}

function losDos(): string[] {
  return [hogar.memberId, beto].sort((a, b) => a.localeCompare(b));
}

/** Aplica la 0061 si el arnés todavía no la trae. Ver la cabecera. */
async function asegurar0061(): Promise<void> {
  const ya = await h.fila<{ existe: boolean }>(
    "select to_regclass('public.event_covered_meals') is not null as existe",
  );
  if (ya!.existe) return;
  await h.db.exec(readFileSync(path.join(RAIZ, MIGRACION), "utf8"));
}

beforeAll(async () => {
  h = await levantarBase();
  await asegurar0061();

  hogar = await crearHogar(h, USER_ANA, "Hogar del cierre", "Ana");
  // El hogar de al lado existe SÓLO para el caso [J]: sin un segundo hogar de
  // verdad, "la vecina no ve nada" pasaría por no tener con qué mirar.
  await crearHogar(h, USER_VECINA, "Hogar de al lado", "Vecina");

  beto = await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_BETO,
      "beto-cierre@test.dev",
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

  perfilAna = await publicarPerfil(hogar.memberId, "firma-ana-cierre");
  perfilBeto = await publicarPerfil(beto, "firma-beto-cierre");

  planId = (await h.como(USER_ANA, () =>
    h.fila<{ ensure_weekly_plan: string }>("select public.ensure_weekly_plan($1, $2)", [
      hogar.householdId,
      SEMANA,
    ]),
  ))!.ensure_weekly_plan;
}, 240_000);

afterAll(async () => {
  await h?.cerrar();
});

// ===========================================================================
// [A] EL EVENTO NACE EN BORRADOR
// ===========================================================================

describe("[A] crear un evento lo deja en borrador", () => {
  it("sin mandar status, el evento nace DRAFT y no PLANNED", async () => {
    // MUTACIÓN: quitar el `alter column status set default 'DRAFT'` de la
    // sección 1 de la 0061 → recibido 'PLANNED', y con él vuelven a fallar [B]
    // y todo el ciclo de vida.
    const id = await eventoSinEstado(LUNES, "Asado recién creado");
    const fila = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.nutrition_events where id = $1", [id]),
    );
    expect(fila!.status, "el evento nació fuera del borrador y ya no se puede borrar").toBe("DRAFT");
  });

  it("el ciclo DRAFT → PLANNED → CONFIRMED existe y los saltos rebotan", async () => {
    // MUTACIÓN: sacar 'PLANNED' de la rama DRAFT de
    // `app.event_status_transition_guard` (0041:1022) → "un evento DRAFT no
    // puede pasar a PLANNED" y este test se pone rojo en la primera línea.
    const id = await eventoSinEstado(LUNES, "Asado del ciclo");

    const salto = await h.comoAdmin(() =>
      intentar("update public.nutrition_events set status = 'CONFIRMED' where id = $1", [id]),
    );
    expect(salto.rechazado, "un borrador saltó directo a CONFIRMED sin planificarse").toBe(true);

    await estado(id, "PLANNED");
    await estado(id, "CONFIRMED");

    const ahora = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.nutrition_events where id = $1", [id]),
    );
    expect(ahora!.status).toBe("CONFIRMED");
  });
});

// ===========================================================================
// [B] y [C] BORRAR EL BORRADOR
// ===========================================================================

describe("[B] un borrador sin efectos se borra de verdad", () => {
  it("el evento creado por error se puede sacar, con invitados y comidas y todo", async () => {
    // MUTACIÓN: devolver el default a 'PLANNED' → "este evento ya salió del
    // borrador: se cancela, no se borra", que es exactamente el muro contra el
    // que choca hoy la familia.
    // SEGUNDA MUTACIÓN: quitar el escape de cascada
    // (`pg_trigger_depth() > 1`) de `app.event_covered_meals_guard` → el
    // borrado muere con "no se pudo determinar el evento de esta comida
    // cubierta", porque la fila hija se borra después que el padre.
    const id = await eventoSinEstado(MARTES, "Asado que no va", "LUNCH");
    await invitar(id, hogar.memberId);
    await cubrir(id, ["DINNER"]);

    const efectos = await h.comoAdmin(() =>
      h.fila<{ efectos: string[] }>("select app.event_effects_found($1) as efectos", [id]),
    );
    expect(efectos!.efectos, "un borrador recién armado ya figuraba con efectos").toEqual([]);

    const borrado = await h.como(USER_ANA, () =>
      intentar("delete from public.nutrition_events where id = $1", [id]),
    );
    expect(borrado.rechazado, `no se pudo borrar un borrador limpio: ${borrado.mensaje}`).toBe(
      false,
    );

    const queda = await h.comoAdmin(() =>
      h.fila("select id from public.nutrition_events where id = $1", [id]),
    );
    expect(queda).toBeNull();

    // Y sus comidas cubiertas se fueron con él, sin dejar filas huérfanas.
    expect(await comidasCubiertas(id)).toEqual([]);
  });
});

describe("[C] un borrador CON efectos no se borra: se dice cuál", () => {
  it("con una línea de compra encima, el borrado rebota nombrando el efecto", async () => {
    // MUTACIÓN: borrar la rama `v_efectos` del DELETE en
    // `app.event_history_guard` → el borrado pasa y se lleva por FK cascade la
    // línea de la lista de compras, en silencio. El test se pone rojo acá.
    const id = await eventoSinEstado(MIERCOLES, "Asado que ya pidió carne", "LUNCH");
    await invitar(id, hogar.memberId);

    const lista = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, status, event_id)
         values ($1, $3, 'ACTIVE', $2) returning id`,
        [hogar.householdId, id, planId],
      ),
    );
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.shopping_list_items
           (list_id, label, required_quantity, unit, status, source, event_id)
         values ($1, 'Vacuno', 9000, 'G', 'PENDING', 'EVENT', $2)`,
        [lista!.id, id],
      ),
    );

    const efectos = await h.comoAdmin(() =>
      h.fila<{ efectos: string[] }>("select app.event_effects_found($1) as efectos", [id]),
    );
    expect(efectos!.efectos).toContain("tiene líneas en la lista de compras");
    expect(efectos!.efectos).toContain("tiene su propia lista de compras");

    const borrado = await h.como(USER_ANA, () =>
      intentar("delete from public.nutrition_events where id = $1", [id]),
    );
    expect(borrado.rechazado, "se borró un borrador que ya había pedido carne").toBe(true);
    expect(
      borrado.mensaje,
      "el error no dice QUÉ efecto trabó el borrado: sin sujeto no se puede decidir qué hacer",
    ).toMatch(/líneas en la lista de compras/);

    // Y la línea sigue ahí: el rebote no puede haber borrado nada a medias.
    const sigue = await h.comoAdmin(() =>
      h.filas("select 1 from public.shopping_list_items where event_id = $1", [id]),
    );
    expect(sigue).toHaveLength(1);
  });

  it("una porción YA SERVIDA relevada por el evento también lo traba", async () => {
    // MUTACIÓN: quitar el renglón 8 de `app.event_effects_found` → el borrado
    // pasa, `covered_by_event_id` queda en NULL por el `on delete set null`, y
    // una porción servida termina diciendo que nadie la relevó.
    const id = await eventoSinEstado(JUEVES, "Asado con historia", "LUNCH");
    await invitar(id, hogar.memberId);
    const assignment = await comidaDelPlan(JUEVES, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);
    await confirmar(id);
    await h.comoAdmin(() =>
      h.db.query(
        `update public.member_serving_projections set status = 'SERVED'
          where assignment_id = $1 and covered_by_event_id = $2`,
        [assignment, id],
      ),
    );
    await estado(id, "PLANNED");
    await estado(id, "DRAFT");

    const efectos = await h.comoAdmin(() =>
      h.fila<{ efectos: string[] }>("select app.event_effects_found($1) as efectos", [id]),
    );
    expect(efectos!.efectos).toContain("relevó comidas que ya se sirvieron");

    const borrado = await h.como(USER_ANA, () =>
      intentar("delete from public.nutrition_events where id = $1", [id]),
    );
    expect(borrado.rechazado, "se borró un evento cuyo relevo ya era historia").toBe(true);
  });
});

// ===========================================================================
// [D] y [E] FUERA DEL BORRADOR NO HAY BORRADO DESTRUCTIVO
// ===========================================================================

describe("[D] un evento PLANNED no se borra", () => {
  it("la única salida es cancelarlo, y el mensaje lo dice", async () => {
    // MUTACIÓN: cambiar `old.status <> 'DRAFT'` por `old.status = 'ZZZ'` en el
    // guard → el evento planificado se borra y su historia se va con él.
    const id = await eventoSinEstado(VIERNES, "Asado ya planificado");
    await estado(id, "PLANNED");

    const borrado = await h.como(USER_ANA, () =>
      intentar("delete from public.nutrition_events where id = $1", [id]),
    );
    expect(borrado.rechazado, "se borró un evento fuera del borrador").toBe(true);
    expect(borrado.mensaje).toMatch(/se cancela, no se borra/);

    const cancelado = await h.como(USER_ANA, () =>
      intentar("update public.nutrition_events set status = 'CANCELLED' where id = $1", [id]),
    );
    expect(cancelado.rechazado, `no se pudo cancelar: ${cancelado.mensaje}`).toBe(false);
  });
});

describe("[E] cancelar conserva la historia entera", () => {
  it("la fila queda, lo servido queda relevado y lo pendiente se retira", async () => {
    // MUTACIÓN: hacer que `event_status_effects` borre en vez de marcar SKIPPED
    // → la línea desaparece sin rastro y el conteo de abajo se cae.
    const id = await eventoSinEstado(SABADO, "Asado que se cae", "LUNCH");
    await invitar(id, hogar.memberId);
    const assignment = await comidaDelPlan(SABADO, "LUNCH", [
      { memberId: hogar.memberId, perfilId: perfilAna },
    ]);
    await confirmar(id);

    const lista = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, status, event_id)
         values ($1, $3, 'ACTIVE', $2) returning id`,
        [hogar.householdId, id, planId],
      ),
    );
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.shopping_list_items
           (list_id, label, required_quantity, unit, status, source, event_id)
         values ($1, 'Vacuno del asado', 9000, 'G', 'PENDING', 'EVENT', $2)`,
        [lista!.id, id],
      ),
    );

    // Una porción ya servida bajo el paraguas del evento: eso es historia.
    await h.comoAdmin(() =>
      h.db.query(
        `update public.member_serving_projections set status = 'SERVED'
          where assignment_id = $1 and covered_by_event_id = $2`,
        [assignment, id],
      ),
    );

    await estado(id, "CANCELLED");

    const sigue = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.nutrition_events where id = $1", [id]),
    );
    expect(sigue!.status, "cancelar borró el evento en vez de conservarlo").toBe("CANCELLED");

    const servida = await h.comoAdmin(() =>
      h.fila<{ covered_by_event_id: string | null }>(
        `select covered_by_event_id from public.member_serving_projections
          where assignment_id = $1 and status = 'SERVED'`,
        [assignment],
      ),
    );
    expect(
      servida!.covered_by_event_id,
      "cancelar soltó una porción YA SERVIDA: se reescribió lo que la familia ya comió",
    ).toBe(id);

    const linea = await h.comoAdmin(() =>
      h.fila<{ status: string; status_reason: string | null }>(
        "select status, status_reason from public.shopping_list_items where event_id = $1",
        [id],
      ),
    );
    expect(linea, "la línea de compra desapareció en vez de retirarse").not.toBeNull();
    expect(linea!.status).toBe("SKIPPED");
  });
});

// ===========================================================================
// [F] [G] [H] LAS COMIDAS CUBIERTAS
// ===========================================================================

describe("[F] el asado que cubre sólo el almuerzo", () => {
  it("releva el almuerzo y deja la cena entera en la lista", async () => {
    // MUTACIÓN: cambiar el `exists (... event_covered_meals ...)` de
    // `app.apply_event_meal_coverage` por `true` → la cena también queda
    // relevada sin que nadie lo haya dicho, y esa noche no se come.
    const fecha = "2027-03-08";
    const semana = weekStart(fecha);
    planId = (await h.como(USER_ANA, () =>
      h.fila<{ ensure_weekly_plan: string }>("select public.ensure_weekly_plan($1, $2)", [
        hogar.householdId,
        semana,
      ]),
    ))!.ensure_weekly_plan;

    const quienes = [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: beto, perfilId: perfilBeto },
    ];
    await comidaDelPlan(fecha, "LUNCH", quienes);
    await comidaDelPlan(fecha, "DINNER", quienes);

    const id = await eventoSinEstado(fecha, "Asado de mediodía", "LUNCH");
    await invitar(id, hogar.memberId);
    await invitar(id, beto);
    await confirmar(id);

    expect(await comidasCubiertas(id), "el espejo meal_type no declaró la comida").toEqual([
      "LUNCH",
    ]);
    expect(await loQuePideLaLista(fecha, "LUNCH")).toEqual([]);
    expect(
      await loQuePideLaLista(fecha, "DINNER"),
      "la cena se dio por cubierta sin que nadie lo dijera",
    ).toEqual(losDos());
  });
});

describe("[G] el asado de nueve horas cubre el almuerzo Y la cena", () => {
  it("declarar DINNER releva la cena, y sacarlo la devuelve", async () => {
    // ESTE ES EL CASO QUE LA 0041 DEJÓ ABIERTO. El caso [F] de
    // sprint13-compra-doble-ataque.test.ts lo documentó y lo dejó anotado como
    // pregunta de producto. La respuesta no es la duración: es declararlo.
    //
    // MUTACIÓN 1: dejar `apply_event_meal_coverage` comparando contra
    //   `v_evento.meal_type` → la cena nunca se releva y la primera aserción
    //   se cae.
    // MUTACIÓN 2: sacar el recálculo incondicional de
    //   `app.sync_event_meal_mirror` (el `release`+`apply` de abajo) → agregar
    //   DINNER no cambia el espejo (sigue siendo LUNCH), ningún otro trigger se
    //   entera y la cena se sigue comprando. Es el defecto exacto que esa
    //   función existe para cerrar.
    const fecha = "2027-03-09";
    const quienes = [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: beto, perfilId: perfilBeto },
    ];
    await comidaDelPlan(fecha, "LUNCH", quienes);
    await comidaDelPlan(fecha, "DINNER", quienes);

    const id = await eventoSinEstado(fecha, "Asado de nueve horas", "LUNCH");
    await invitar(id, hogar.memberId);
    await invitar(id, beto);
    await confirmar(id);
    await h.comoAdmin(() =>
      h.db.query(
        "update public.nutrition_events set serving_time = '13:00', duration_hours = 9 where id = $1",
        [id],
      ),
    );

    // La duración SOLA no releva nada: la cena sigue abierta.
    expect(
      await loQuePideLaLista(fecha, "DINNER"),
      "nueve horas de duración relevaron la cena por su cuenta: eso es adivinar",
    ).toEqual(losDos());

    // La familia lo declara.
    await cubrir(id, ["DINNER"]);
    expect(await comidasCubiertas(id)).toEqual(["LUNCH", "DINNER"]);

    expect(
      await loQuePideLaLista(fecha, "DINNER"),
      "se declaró que el asado da de cenar y la cena se sigue comprando",
    ).toEqual([]);
    expect(await loQuePideLaLista(fecha, "LUNCH")).toEqual([]);

    // El espejo se queda en la PRIMERA del día, no en la última declarada.
    const espejo = await h.comoAdmin(() =>
      h.fila<{ meal_type: string }>("select meal_type from public.nutrition_events where id = $1", [
        id,
      ]),
    );
    expect(espejo!.meal_type).toBe("LUNCH");

    // Y se retracta: la cena vuelve a la lista.
    await h.comoAdmin(() =>
      h.db.query(
        "delete from public.event_covered_meals where event_id = $1 and meal_type = 'DINNER'",
        [id],
      ),
    );
    expect(
      await loQuePideLaLista(fecha, "DINNER"),
      "se sacó la cena de las comidas cubiertas y quedó relevada igual: esa noche no se come",
    ).toEqual(losDos());
  });
});

describe("[H] la demanda abierta sabe de la cena cubierta", () => {
  it("open_serving_demand deja de contar la cena que el evento releva", async () => {
    // MUTACIÓN: dejar `app.event_covering_slot` comparando `e.meal_type =
    // p_comida` → la cena escrita DESPUÉS del asado no hereda el relevo y
    // vuelve a la demanda abierta. Es el mismo defecto de dirección que la
    // sección 20 de la 0041 cerró para una comida, entrando por la segunda.
    const fecha = "2027-03-10";
    const quienes = [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: beto, perfilId: perfilBeto },
    ];

    const id = await eventoSinEstado(fecha, "Asado que se planea antes que el plan", "LUNCH");
    await invitar(id, hogar.memberId);
    await invitar(id, beto);
    await cubrir(id, ["DINNER"]);
    await confirmar(id);

    // El plan se escribe DESPUÉS del asado: el orden real de una familia.
    await comidaDelPlan(fecha, "LUNCH", quienes);
    await comidaDelPlan(fecha, "DINNER", quienes);

    expect(await demandaAbierta(fecha, "LUNCH")).toEqual([]);
    expect(
      await demandaAbierta(fecha, "DINNER"),
      "la cena escrita después del asado no heredó el relevo y se compra igual",
    ).toEqual([]);
  });
});

// ===========================================================================
// [I] PARTICIPANTES PARCIALES
// ===========================================================================

describe("[I] el asado al que van dos de tres", () => {
  it("releva las dos comidas SÓLO de quien va; el que se queda sigue comiendo", async () => {
    // MUTACIÓN: sacar el `exists (... event_participants ...)` del segundo CTE
    // de `apply_event_meal_coverage` → a Beto le relevan el almuerzo y la cena
    // sin haber ido, y ese día no tiene qué comer.
    const fecha = "2027-03-11";
    const quienes = [
      { memberId: hogar.memberId, perfilId: perfilAna },
      { memberId: beto, perfilId: perfilBeto },
    ];
    await comidaDelPlan(fecha, "LUNCH", quienes);
    await comidaDelPlan(fecha, "DINNER", quienes);

    const id = await eventoSinEstado(fecha, "Asado al que Beto no va", "LUNCH");
    await invitar(id, hogar.memberId);
    await cubrir(id, ["DINNER"]);
    await confirmar(id);

    expect(await loQuePideLaLista(fecha, "LUNCH")).toEqual([beto]);
    expect(
      await loQuePideLaLista(fecha, "DINNER"),
      "se relevó la cena de alguien que no fue al asado",
    ).toEqual([beto]);

    // Beto se suma a última hora: recién ahí deja de demandar.
    await invitar(id, beto);
    expect(await loQuePideLaLista(fecha, "LUNCH")).toEqual([]);
    expect(await loQuePideLaLista(fecha, "DINNER")).toEqual([]);
  });
});

// ===========================================================================
// [J] EL ASADO DEL VECINO
// ===========================================================================

describe("[J] las comidas cubiertas son del hogar dueño del evento", () => {
  it("la vecina no las lee ni las escribe", async () => {
    // MUTACIÓN: quitar `enable row level security` de la tabla → la vecina lee
    // qué come la familia de al lado.
    const id = await eventoSinEstado("2027-03-12", "Asado privado", "LUNCH");

    const leidas = await h.como(USER_VECINA, () =>
      h.filas("select 1 from public.event_covered_meals where event_id = $1", [id]),
    );
    expect(leidas, "la vecina vio las comidas cubiertas del asado de al lado").toHaveLength(0);

    const escrita = await h.como(USER_VECINA, () =>
      intentar(
        `insert into public.event_covered_meals (event_id, meal_type) values ($1, 'DINNER')`,
        [id],
      ),
    );
    expect(escrita.rechazado, "la vecina declaró una comida cubierta en un evento ajeno").toBe(true);

    const borrada = await h.como(USER_VECINA, () =>
      intentar("delete from public.event_covered_meals where event_id = $1", [id]),
    );
    // El DELETE de la vecina no puede haber sacado nada: o rebota, o no alcanza
    // ninguna fila. Las dos cosas son correctas; lo que no puede pasar es que
    // la comida cubierta desaparezca.
    expect(borrada.rechazado || (await comidasCubiertas(id)).length === 1).toBe(true);
    expect(await comidasCubiertas(id)).toEqual(["LUNCH"]);
  });
});

// ===========================================================================
// [K] DOBLE SUBMIT
// ===========================================================================

describe("[K] tocar dos veces la misma casilla", () => {
  it("deja UNA comida cubierta y el relevo no se duplica", async () => {
    // MUTACIÓN: quitar la PK compuesta de `event_covered_meals` → el doble clic
    // deja dos filas, `app.event_first_covered_meal` sigue contestando bien pero
    // el conteo de comidas cubiertas miente en pantalla.
    const fecha = "2027-03-12";
    const quienes = [{ memberId: hogar.memberId, perfilId: perfilAna }];
    const assignment = await comidaDelPlan(fecha, "DINNER", quienes);

    const id = await eventoSinEstado(fecha, "Asado del doble clic", "LUNCH");
    await invitar(id, hogar.memberId);
    await confirmar(id);

    await cubrir(id, ["DINNER"]);
    await cubrir(id, ["DINNER"]);

    expect(await comidasCubiertas(id)).toEqual(["LUNCH", "DINNER"]);

    const relevadas = await h.comoAdmin(() =>
      h.filas("select 1 from public.member_serving_projections where assignment_id = $1 and covered_by_event_id = $2", [
        assignment,
        id,
      ]),
    );
    expect(relevadas, "el doble clic duplicó el relevo").toHaveLength(1);

    // Y el insert crudo sin `on conflict` rebota: la idempotencia no depende de
    // que el escritor se acuerde de pedirla.
    const repetido = await h.comoAdmin(() =>
      intentar(
        "insert into public.event_covered_meals (event_id, meal_type) values ($1, 'DINNER')",
        [id],
      ),
    );
    expect(repetido.rechazado, "se pudo escribir dos veces la misma comida cubierta").toBe(true);
  });
});

// ===========================================================================
// EL EVENTO CERRADO: sus comidas cubiertas son historia
// ===========================================================================

describe("un evento cerrado no cambia de comidas cubiertas", () => {
  it("agregar una comida a un evento COMPLETED rebota", async () => {
    // MUTACIÓN: quitar la rama de estados terminales de
    // `app.event_covered_meals_guard` → se le puede agregar la cena a un asado
    // que ya pasó, y el aprendizaje empieza a leer un asado que nunca existió.
    const id = await eventoSinEstado("2027-03-13", "Asado del sábado pasado", "LUNCH");
    await estado(id, "PLANNED");
    await estado(id, "CONFIRMED");
    await estado(id, "COMPLETED");

    const intento = await h.comoAdmin(() =>
      intentar(
        "insert into public.event_covered_meals (event_id, meal_type) values ($1, 'DINNER')",
        [id],
      ),
    );
    expect(intento.rechazado, "se le agregó una comida cubierta a un evento cerrado").toBe(true);
    expect(intento.mensaje).toMatch(/ya está cerrado/);
  });
});

// ===========================================================================
// LA 0061 SOBRE DATOS QUE YA EXISTEN
// ===========================================================================
//
// Todo lo de arriba corre sobre una base donde la 0061 ya estaba puesta antes
// del primer evento, y eso NO es lo que va a pasar el día del despliegue.
// Producción tiene una familia adentro y un evento suyo, escrito con el default
// viejo. Este bloque levanta su propia base para poder mirar el ANTES y el
// DESPUÉS: se escriben eventos con la 0060, se aplica la 0061 encima y se
// comprueba lo que la migración prometió — que el backfill traduce lo que había
// y que NO reescribe el estado de nadie.

describe("la 0061 aplicada encima de eventos que ya existían", () => {
  const USER_VIEJO = "00000000-0000-0000-0000-0000c1e50004";
  let vieja: Harness;
  let hogarViejo: { householdId: string; memberId: string };
  let conComida: string;
  let sinComida: string;

  beforeAll(async () => {
    // LA BASE DEL "ANTES" ES LA DE PRODUCCIÓN, NO LA CADENA COMPLETA.
    //
    // Mientras la 0061 no estuvo enganchada al arnés, `levantarBase()` daba una
    // base sin ella y este ensayo la aplicaba a mano. Al engancharla, la cadena
    // completa YA la trae: los eventos "de antes" nacían en DRAFT y el ensayo
    // pasaba a comparar el estado nuevo contra sí mismo — verde sin probar nada,
    // que es peor que rojo. Lo dice su propia aserción: "el ensayo no arrancó
    // desde el estado viejo: no prueba nada".
    //
    // `soloProduccion` levanta exactamente lo que la base real tiene puesto hoy
    // (0001→0060, con la 0061 todavía PENDIENTE en el libro), que es la
    // definición correcta de "antes" y se mueve sola el día que se aplique.
    vieja = await levantarBase({ conSeeds: false, soloProduccion: true });
    hogarViejo = await crearHogar(vieja, USER_VIEJO, "Hogar de antes", "Antes");

    // Los dos casos que hay en la base real: uno con la comida declarada y uno
    // sin ella. El segundo importa tanto como el primero — NULL era "no se sabe
    // qué comida cubre" y tiene que seguir siendo el conjunto vacío, no "todas".
    conComida = (await vieja.comoAdmin(() =>
      vieja.fila<{ id: string }>(
        `insert into public.nutrition_events (household_id, event_date, event_type, title, meal_type)
         values ($1, '2026-08-01', 'BARBECUE', 'El asado de antes', 'LUNCH') returning id`,
        [hogarViejo.householdId],
      ),
    ))!.id;
    sinComida = (await vieja.comoAdmin(() =>
      vieja.fila<{ id: string }>(
        `insert into public.nutrition_events (household_id, event_date, event_type, title)
         values ($1, '2026-08-02', 'TRAVEL', 'Viaje sin comida declarada') returning id`,
        [hogarViejo.householdId],
      ),
    ))!.id;

    // Nacieron PLANNED, que es el default de la 0041 y lo que producción tiene.
    const antes = await vieja.comoAdmin(() =>
      vieja.filas<{ status: string }>("select status from public.nutrition_events"),
    );
    expect(
      antes.map((f) => f.status),
      "el ensayo no arrancó desde el estado viejo: no prueba nada",
    ).toEqual(["PLANNED", "PLANNED"]);

    await vieja.db.exec(readFileSync(path.join(RAIZ, MIGRACION), "utf8"));
  }, 240_000);

  afterAll(async () => {
    await vieja?.cerrar();
  });

  it("no reescribe el estado de los eventos que ya estaban", async () => {
    // MUTACIÓN: agregarle a la 0061 un `update nutrition_events set status =
    // 'DRAFT' where status = 'PLANNED'` → los dos quedan en DRAFT y este test
    // se cae. Sería arreglar un default reescribiendo historia: nadie puso esos
    // eventos en borrador y decir ahora que lo estuvieron es inventarlo.
    const filas = await vieja.comoAdmin(() =>
      vieja.filas<{ status: string }>(
        "select status from public.nutrition_events order by event_date",
      ),
    );
    expect(filas.map((f) => f.status)).toEqual(["PLANNED", "PLANNED"]);
  });

  it("traduce meal_type a comidas cubiertas, y el NULL sigue siendo vacío", async () => {
    // MUTACIÓN 1: quitar el insert de backfill → el asado real deja de cubrir
    // el almuerzo de un día para otro y ese día se compra dos veces.
    // MUTACIÓN 2: cambiar el `where e.meal_type is not null` por `true` → el
    // viaje sin comida declarada revienta (meal_type NULL no entra en la
    // columna not null) o, peor, entraría cubriendo algo que nadie declaró.
    const con = await vieja.comoAdmin(() =>
      vieja.filas<{ meal_type: string }>(
        "select meal_type from public.event_covered_meals where event_id = $1",
        [conComida],
      ),
    );
    expect(con.map((c) => c.meal_type)).toEqual(["LUNCH"]);

    const sin = await vieja.comoAdmin(() =>
      vieja.filas("select 1 from public.event_covered_meals where event_id = $1", [sinComida]),
    );
    expect(sin, "un evento sin comida declarada quedó cubriendo algo que nadie dijo").toHaveLength(
      0,
    );
  });

  it("el evento viejo sigue sin poder borrarse; el nuevo nace en borrador", async () => {
    // LAS DOS MITADES DEL CIERRE, JUNTAS. El evento de la familia sigue siendo
    // PLANNED y su salida sigue siendo cancelar —cambiar el default no le da
    // permiso retroactivo a nadie— y el que se cree de acá en adelante nace en
    // borrador y se puede sacar.
    let mensaje = "";
    await vieja.como(USER_VIEJO, async () => {
      try {
        await vieja.db.query("delete from public.nutrition_events where id = $1", [conComida]);
      } catch (e) {
        mensaje = e instanceof Error ? e.message : String(e);
      }
    });
    expect(mensaje, "se borró el evento histórico de la familia").toMatch(
      /se cancela, no se borra/,
    );

    const nuevo = await vieja.comoAdmin(() =>
      vieja.fila<{ status: string }>(
        `insert into public.nutrition_events (household_id, event_date, event_type, title)
         values ($1, '2027-01-01', 'BARBECUE', 'El primero de después') returning status`,
        [hogarViejo.householdId],
      ),
    );
    expect(nuevo!.status).toBe("DRAFT");
  });
});
