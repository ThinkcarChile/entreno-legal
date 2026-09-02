import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventIncludes, type DayEvent } from "@/domain/nutrition/events";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 13, ronda de arreglos — "quién viene, qué come y qué se le puede
 * servir", contra un PostgreSQL de verdad.
 *
 * Dos defectos que la revisión adversarial encontró vivos en el borde, los dos
 * escritos acá para fallar si el arreglo se revierte:
 *
 *   [1] EL ROSTER VACÍO SIGNIFICABA "TODA LA FAMILIA". Un asado con puros
 *       invitados —o donde todos los del hogar marcaron DECLINED— dejaba
 *       `nutrition_event_members` en cero filas, y cero filas se leía como "a
 *       toda la familia". Los cuatro de la casa amanecían con el día RELAXED
 *       sin que nadie lo pidiera, incluidos los que dijeron que no iban.
 *
 *   [2] LAS RESTRICCIONES REGISTRADAS NO LLEGABAN AL MOTOR. Las banderas
 *       culinarias sólo existen en la ficha del invitado, así que todo
 *       integrante del hogar entraba al estimador como "sin restricciones" —y
 *       al papá con la alergia guardada en la app se le repartía su porción del
 *       corte que no puede comer.
 *
 * La otra mitad de [2] es de privacidad: el motivo (una alergia, una indicación
 * clínica) NO puede salir de la base. Por eso `public.event_menu_blocks`
 * devuelve pares (participante, item) y un booleano, y nada más: lo que no
 * cruza la frontera no se puede dibujar en una pantalla que se mira entre
 * invitados.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: igual que sprint13-eventos.test.ts —
 * `harness.ts` es de otro dueño y su lista `MIGRACIONES` llega hasta la 0038.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const PENDIENTES = [
  "supabase/migrations/0039_permisos_plan_y_cocina.sql",
  "supabase/migrations/0040_adaptive_reviews.sql",
  "supabase/migrations/0041_eventos_avanzados.sql",
];

const USER_ANA = "00000000-0000-0000-0000-0000000041c1";
const USER_BETO = "00000000-0000-0000-0000-0000000041c2";
const USER_VECINO = "00000000-0000-0000-0000-0000000041c3";

const SABADO = "2026-09-12";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let miembroBeto: string;
let vecino: { householdId: string; memberId: string };
let ingredienteCerdo: string;
let ingredienteVacuno: string;

async function asegurar(testigoSql: string, archivo: string): Promise<void> {
  const ya = await h.comoAdmin(() => h.fila(testigoSql));
  if (ya) return;
  await h.comoAdmin(() => h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8")));
}

/** Crea un evento como lo hace el armador de /eventos: sin decir quién de la casa va. */
async function eventoDelArmador(titulo: string): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.nutrition_events
         (household_id, event_date, event_type, title, status, member_scope)
       values ($1, $2::date, 'BARBECUE', $3, 'DRAFT', 'UNDECLARED')
       returning id`,
      [hogar.householdId, SABADO, titulo],
    ),
  );
  return r!.id;
}

/** El evento tal como lo lee la aplicación (web/src/app/plan/queries.ts). */
async function comoLoLeeLaApp(eventId: string): Promise<DayEvent> {
  const fila = await h.comoAdmin(() =>
    h.fila<{
      id: string;
      event_date: string;
      end_date: string | null;
      event_type: string;
      strategy: string;
      title: string;
      member_scope: string;
    }>(
      `select id, event_date::text as event_date, end_date::text as end_date,
              event_type::text as event_type, strategy::text as strategy, title,
              member_scope::text as member_scope
       from public.nutrition_events where id = $1`,
      [eventId],
    ),
  );
  const miembros = await h.comoAdmin(() =>
    h.filas<{ member_id: string }>(
      "select member_id from public.nutrition_event_members where event_id = $1 order by member_id",
      [eventId],
    ),
  );
  return {
    id: fila!.id,
    date: fila!.event_date,
    endDate: fila!.end_date,
    eventType: fila!.event_type,
    mealType: null,
    strategy: fila!.strategy as DayEvent["strategy"],
    title: fila!.title,
    memberScope: fila!.member_scope as DayEvent["memberScope"],
    memberIds: miembros.map((m) => m.member_id),
  };
}

async function agregarMiembro(
  eventId: string,
  memberId: string,
  asistencia: string,
): Promise<void> {
  await h.comoAdmin(() =>
    h.db.query(
      `insert into public.event_participants
         (event_id, participant_type, member_id, attendance_status)
       values ($1, 'HOUSEHOLD_MEMBER', $2, $3::public.event_attendance_status)`,
      [eventId, memberId, asistencia],
    ),
  );
}

async function agregarItem(eventId: string, ingrediente: string, nombre: string): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.event_menu_items (event_id, kind, category, ingredient_id, display_name)
       values ($1, 'MEAT', 'CERDO', $2, $3) returning id`,
      [eventId, ingrediente, nombre],
    ),
  );
  return r!.id;
}

interface Bloqueo {
  participant_id: string;
  menu_item_id: string;
  from_allergy: boolean;
}

async function bloqueos(userId: string, eventId: string): Promise<Bloqueo[]> {
  return h.como(userId, () =>
    h.filas<Bloqueo>("select * from public.event_menu_blocks($1) order by menu_item_id", [eventId]),
  );
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

  hogar = await crearHogar(h, USER_ANA, "Hogar Roster", "Ana");
  vecino = await crearHogar(h, USER_VECINO, "Hogar Vecino", "Vicente");

  miembroBeto = (await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_BETO,
      "beto41c@test.dev",
    ]);
    return h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, 'Beto', '1988-04-04') returning id`,
      [hogar.householdId, USER_BETO],
    );
  }))!.id;

  const ingredientes = await h.comoAdmin(() =>
    h.filas<{ id: string }>(
      "select id from public.ingredients where household_id is null order by canonical_name limit 2",
    ),
  );
  ingredienteCerdo = ingredientes[0]!.id;
  ingredienteVacuno = ingredientes[1]!.id;
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

// ===========================================================================
// [1] El vacío deja de significar "toda la familia"
// ===========================================================================

describe("[ALTO] el roster vacío ya no relaja los objetivos de toda la casa", () => {
  it("un evento de siempre conserva su significado: sin filas, afecta a todos", async () => {
    // Ningún escritor viejo declara `member_scope`, así que el valor por
    // omisión tiene que ser exactamente la semántica de la 0007.
    const id = (await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.nutrition_events (household_id, event_date, event_type, title)
         values ($1, $2::date, 'BIRTHDAY', 'Cumpleaños de siempre') returning id`,
        [hogar.householdId, SABADO],
      ),
    ))!.id;

    const evento = await comoLoLeeLaApp(id);
    expect(evento.memberScope).toBe("LEGACY_EMPTY_MEANS_ALL");
    expect(eventIncludes(evento, hogar.memberId)).toBe(true);
    expect(eventIncludes(evento, miembroBeto)).toBe(true);
  });

  it("un asado con puros invitados NO le cambia el día a nadie de la casa", async () => {
    const id = await eventoDelArmador("Asado de los amigos");
    const invitado = (await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Tía María') returning id",
        [hogar.householdId],
      ),
    ))!.id;
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.event_participants (event_id, participant_type, guest_id, attendance_status)
         values ($1, 'GUEST', $2, 'CONFIRMED')`,
        [id, invitado],
      ),
    );

    const evento = await comoLoLeeLaApp(id);
    // Que la lista tenga gente no responde la pregunta "¿quién de la casa come
    // acá?". Sigue sin declararse, y sin declarar no se relaja nada.
    expect(evento.memberScope).toBe("UNDECLARED");
    expect(evento.memberIds).toEqual([]);
    expect(eventIncludes(evento, hogar.memberId)).toBe(false);
    expect(eventIncludes(evento, miembroBeto)).toBe(false);
  });

  it("agregar a un integrante declara el roster; sacarlo NO devuelve el 'todos'", async () => {
    const id = await eventoDelArmador("Asado con la Ana");
    await agregarMiembro(id, hogar.memberId, "CONFIRMED");

    const conAna = await comoLoLeeLaApp(id);
    expect(conAna.memberScope).toBe("DECLARED_ROSTER");
    expect(conAna.memberIds).toEqual([hogar.memberId]);
    expect(eventIncludes(conAna, hogar.memberId)).toBe(true);
    expect(eventIncludes(conAna, miembroBeto)).toBe(false);

    // Como Ana y no como admin: sacar comensales pasa por el guard ruidoso de
    // la 0039 (`app.exigir_can_edit_evento`), que exige permiso de planificar.
    await h.como(USER_ANA, () =>
      h.db.query("delete from public.event_participants where event_id = $1", [id]),
    );
    const sinNadie = await comoLoLeeLaApp(id);
    expect(sinNadie.memberScope).toBe("DECLARED_ROSTER");
    expect(sinNadie.memberIds).toEqual([]);
    // Éste es el corazón del defecto: acá la app leía "toda la familia".
    expect(eventIncludes(sinNadie, hogar.memberId)).toBe(false);
  });

  it("[MUTACIÓN] con TODOS los del hogar en DECLINED no queda nadie relajado", async () => {
    const id = await eventoDelArmador("Asado donde no va nadie de la casa");
    await agregarMiembro(id, hogar.memberId, "DECLINED");
    await agregarMiembro(id, miembroBeto, "DECLINED");

    const evento = await comoLoLeeLaApp(id);
    expect(evento.memberScope).toBe("DECLARED_ROSTER");
    expect(evento.memberIds, "la proyección tiene que quedar vacía").toEqual([]);
    expect(
      eventIncludes(evento, hogar.memberId),
      "el que dijo que NO iba estaba recibiendo día RELAXED igual",
    ).toBe(false);
    expect(eventIncludes(evento, miembroBeto)).toBe(false);
  });
});

// ===========================================================================
// [2] Lo que la casa sabe llega al motor — y el motivo no sale de la base
// ===========================================================================

describe("[ALTO] las restricciones registradas del hogar llegan al cálculo", () => {
  it("la alergia guardada en la ficha familiar bloquea ese plato, y se marca como alergia", async () => {
    const id = await eventoDelArmador("Asado con chorizo");
    await agregarMiembro(id, miembroBeto, "CONFIRMED");
    const item = await agregarItem(id, ingredienteCerdo, "Chorizo");

    const sinNada = await bloqueos(USER_ANA, id);
    expect(sinNada, "sin nada anotado no hay bloqueos: eso también es un hecho").toEqual([]);

    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.member_preferences (member_id, preference_type, target_kind, target_id)
         values ($1, 'ALLERGY', 'INGREDIENT', $2)`,
        [miembroBeto, ingredienteCerdo],
      ),
    );

    const conAlergia = await bloqueos(USER_ANA, id);
    expect(conAlergia).toHaveLength(1);
    expect(conAlergia[0]!.menu_item_id).toBe(item);
    expect(conAlergia[0]!.from_allergy).toBe(true);

    // Y lo que NO viaja: ni el ingrediente, ni el tipo de preferencia, ni una
    // nota. Sólo el par y el booleano.
    expect(Object.keys(conAlergia[0]!).sort()).toEqual([
      "from_allergy",
      "menu_item_id",
      "participant_id",
    ]);
  });

  it("un gusto NO bloquea: DISLIKE y AVOID son blandos y no cambian la compra", async () => {
    const id = await eventoDelArmador("Asado con lo que no le gusta a la Ana");
    await agregarMiembro(id, hogar.memberId, "CONFIRMED");
    await agregarItem(id, ingredienteVacuno, "Asiento");
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.member_preferences (member_id, preference_type, target_kind, target_id)
         values ($1, 'DISLIKE', 'INGREDIENT', $2)`,
        [hogar.memberId, ingredienteVacuno],
      ),
    );

    expect(await bloqueos(USER_ANA, id)).toEqual([]);
  });

  it("la restricción clínica CONFIRMADA bloquea aunque quien mira no tenga permiso médico", async () => {
    // El punto entero: la restricción vive detrás de `app.medical_access` y la
    // anfitriona puede no tener ese permiso. Si la consulta pasara por su RLS,
    // el resultado sería "no hay restricciones" — UNKNOWN leído como "puede
    // comer todo", que en un asado es el error que no se puede cometer.
    const id = await eventoDelArmador("Asado con indicación médica");
    await agregarMiembro(id, miembroBeto, "CONFIRMED");
    const item = await agregarItem(id, ingredienteVacuno, "Asiento");

    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.member_clinical_restrictions
           (member_id, type, target, severity, source, verification_status, valid_from)
         values ($1, 'INGREDIENT_EXCLUDE', $2::text, 'HARD', 'CLINICIAN_ENTERED',
                 'CONFIRMED', '2020-01-01')`,
        [miembroBeto, ingredienteVacuno],
      ),
    );

    // Ana NO puede leer la restricción...
    const loQueAnaVe = await h.como(USER_ANA, () =>
      h.filas("select id from public.member_clinical_restrictions where member_id = $1", [
        miembroBeto,
      ]),
    );
    expect(loQueAnaVe, "la restricción clínica sigue detrás del permiso médico").toEqual([]);

    // ...y aun así el plato queda bloqueado para el cálculo, SIN decirle por qué.
    const b = await bloqueos(USER_ANA, id);
    expect(b).toHaveLength(1);
    expect(b[0]!.menu_item_id).toBe(item);
    expect(b[0]!.from_allergy, "una indicación clínica no se anuncia como alergia").toBe(false);
  });

  it("una restricción clínica SIN confirmar no bloquea nada", async () => {
    const id = await eventoDelArmador("Asado con una sospecha, no una indicación");
    await agregarMiembro(id, hogar.memberId, "CONFIRMED");
    await agregarItem(id, ingredienteCerdo, "Longaniza");
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.member_clinical_restrictions
           (member_id, type, target, severity, source, verification_status, valid_from)
         values ($1, 'INGREDIENT_EXCLUDE', $2::text, 'HARD', 'USER_CONFIRMED_LIMIT',
                 'UNVERIFIED', '2020-01-01')`,
        [hogar.memberId, ingredienteCerdo],
      ),
    );

    expect(await bloqueos(USER_ANA, id)).toEqual([]);
  });

  it("el vecino no puede preguntar por el evento de otra casa", async () => {
    const id = await eventoDelArmador("Asado ajeno");
    await expect(bloqueos(USER_VECINO, id)).rejects.toThrow(/no es de tu hogar/);
    expect(vecino.householdId).not.toBe(hogar.householdId);
  });
});
