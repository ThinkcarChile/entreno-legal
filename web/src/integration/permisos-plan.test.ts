import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Los permisos `can_edit_plan` y `can_cook` (migración 0039).
 *
 * Nacieron muertos: columnas sembradas en la 0001 que ninguna política ni
 * ningún RPC leyó jamás. Invitar a alguien como COOK, PLANNER, SHOPPER o
 * MEMBER daba exactamente el mismo poder sobre la semana.
 *
 * Este archivo prueba LOS DOS LADOS, porque un permiso sólo está bien
 * conectado si las dos afirmaciones son ciertas al mismo tiempo:
 *
 *   · quien NO lo tiene, no puede; y
 *   · quien SÍ lo tiene —incluida la familia que ya estaba adentro antes de
 *     la migración— sigue pudiendo exactamente lo mismo que ayer.
 *
 * El segundo lado es el que importa de verdad: apretar un permiso sobre una
 * base con gente adentro puede dejar a una familia mirando su propio plan sin
 * poder tocarlo.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const ARCHIVO_0039 = path.join(
  RAIZ,
  "supabase/migrations/0039_permisos_plan_y_cocina.sql",
);

const USER_ADMIN = "00000000-0000-0000-0000-0000000039a1";
const USER_PLANNER = "00000000-0000-0000-0000-0000000039a2";
const USER_COOK = "00000000-0000-0000-0000-0000000039a3";
const USER_SHOPPER = "00000000-0000-0000-0000-0000000039a4";
const USER_MEMBER = "00000000-0000-0000-0000-0000000039a5";
const USER_SIN_ROL = "00000000-0000-0000-0000-0000000039a6";
const USER_SOLO = "00000000-0000-0000-0000-0000000039a7";
const USER_HOGAR_NUEVO = "00000000-0000-0000-0000-0000000039a8";

const SEMANA = weekStart("2026-09-07"); // lunes 2026-09-07
const LUNES = "2026-09-07";
const OTRA_SEMANA = weekStart("2026-09-14");

let h: Harness;
let hogar: { householdId: string; memberId: string };
let miembroSinRol: string;
let versionPollo: string;
let planId: string;
let diaLunes: string;
let almuerzo: string;
let perfilId: string;
let ingredientePollo: string;

interface Intento {
  rechazado: boolean;
  filas: number;
  mensaje: string | null;
}

/**
 * Una escritura bloqueada por RLS no siempre revienta: en INSERT rebota con
 * error, y en UPDATE/DELETE la fila simplemente no existe para quien mira, así
 * que se tocan CERO filas sin ruido. Las dos cosas son "no pudo", y las dos hay
 * que poder distinguirlas de "sí pudo".
 */
async function intentar(sql: string, params: unknown[] = []): Promise<Intento> {
  try {
    const r = await h.db.query(sql, params);
    return { rechazado: false, filas: (r as { affectedRows?: number }).affectedRows ?? 0, mensaje: null };
  } catch (e) {
    return { rechazado: true, filas: 0, mensaje: (e as Error).message };
  }
}

/**
 * true si la escritura NO surtió efecto, sea por error o por cero filas.
 *
 * OJO CON ESTE HELPER: mezcla a propósito "te dijeron que no" con "no pasó
 * nada", y esa mezcla es exactamente el agujero que la sección 3-bis vino a
 * tapar. Sirve para las aserciones donde lo único que importa es que la
 * escritura no ocurrió; NO sirve para probar que el rechazo se nota, y por eso
 * existe el test "un rechazo tiene que hablar", que compara las dos cosas.
 */
function noPudo(intento: Intento): boolean {
  return intento.rechazado || intento.filas === 0;
}

/**
 * Agrega un integrante CON cuenta y CON rol por el camino legítimo: quien
 * administra invita con un `role_code`, la persona acepta.
 */
async function integranteConRol(
  userId: string,
  nombre: string,
  roleCode: string,
): Promise<string> {
  const token = `permisos-token-${nombre.toLowerCase()}`;
  await h.comoAdmin(() =>
    h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `${nombre.toLowerCase()}@permisos.dev`,
    ]),
  );
  await h.como(USER_ADMIN, () =>
    h.db.query(
      `insert into public.invitations (household_id, token_hash, role_code, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [hogar.householdId, token, roleCode],
    ),
  );
  await h.como(userId, () => h.db.query("select public.accept_invitation($1, $2)", [token, nombre]));
  return h.comoAdmin(
    async () =>
      (await h.fila<{ id: string }>(
        "select id from public.household_members where household_id = $1 and user_id = $2",
        [hogar.householdId, userId],
      ))!.id,
  );
}

/** La porción mínima que `confirm_meal_assignment` acepta. */
function porciones(): unknown[] {
  return [
    {
      member_id: hogar.memberId,
      version_id: versionPollo,
      profile_id: perfilId,
      optimizer_version: "portion-optimizer/1.0.0",
      meal_type: "LUNCH",
      serving_date: LUNES,
      fit: "COMPATIBLE_WITH_PORTION_CHANGE",
      adaptation_level: 1,
      score: 90,
      nutrition: { energy_kcal: 500, protein_g: 40 },
      completeness: { energy_kcal: "COMPLETE" },
      reasons: [],
      unmet_constraints: [],
      components: [
        {
          label: "Pechuga de pollo (sin piel)",
          base_quantity: 180,
          proposed_quantity: 180,
          unit: "G",
          weight_basis: "RAW",
          cooking_method: "BOILED",
          added_fat_g: 0,
          sort_order: 1,
        },
      ],
      substitutions: [] as unknown[],
    },
  ];
}

/**
 * La 0039 todavía no está en la lista MIGRACIONES del harness —la escribe otro
 * agente en paralelo y ese archivo no es de esta tarea—, así que se aplica acá
 * si falta. La comprobación mira el schema, no el archivo: cuando el harness la
 * incorpore, esto no hace nada y el test sigue midiendo lo mismo. Un test de
 * permisos que corre contra una base SIN la migración daría verde por el motivo
 * equivocado, y eso es exactamente lo que no puede pasar.
 */
async function asegurar0039(harness: Harness): Promise<void> {
  const ya = await harness.comoAdmin(() =>
    harness.fila(
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'can_edit_plan'`,
    ),
  );
  if (ya) return;
  await harness.comoAdmin(() => harness.db.exec(readFileSync(ARCHIVO_0039, "utf8")));
}

beforeAll(async () => {
  h = await levantarBase();
  await asegurar0039(h);

  hogar = await crearHogar(h, USER_ADMIN, "Hogar Permisos", "Ana");

  await integranteConRol(USER_PLANNER, "Pilar", "PLANNER");
  await integranteConRol(USER_COOK, "Camilo", "COOK");
  await integranteConRol(USER_SHOPPER, "Sofía", "SHOPPER");
  await integranteConRol(USER_MEMBER, "Matías", "MEMBER");

  // Se le quitan TODOS los roles a mano. Ese estado ya no lo produce la app —el
  // trigger de la 2-ter se encarga— pero se fabrica igual acá, porque es la
  // única forma de comprobar que el guardián no lo premia. La versión anterior
  // de la 0039 le daba a esta persona MÁS poder que a un MEMBER.
  miembroSinRol = await integranteConRol(USER_SIN_ROL, "Sin Rol", "MEMBER");
  await h.comoAdmin(() =>
    h.db.query("delete from public.member_role_assignments where member_id = $1", [miembroSinRol]),
  );

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;
  ingredientePollo = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  await h.como(USER_ADMIN, async () => {
    const perfil = await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-permisos', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'permisos')`,
      [hogar.memberId],
    );
    perfilId = perfil!.publish_nutrition_profile;

    planId = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [hogar.householdId, SEMANA],
    ))!.ensure_weekly_plan;

    diaLunes = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planId, LUNES],
    ))!.id;

    almuerzo = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, version_id)
       values ($1, 'LUNCH', 'RECIPE', $2) returning id`,
      [diaLunes, versionPollo],
    ))!.id;
  });
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("escribir la semana pide can_edit_plan", () => {
  it("MEMBER ve el plan completo pero no lo toca", async () => {
    const visto = await h.como(USER_MEMBER, () =>
      h.filas("select id from public.meal_assignments where day_id = $1", [diaLunes]),
    );
    // Mirar el plan de la familia es parte de estar en la familia: si esto
    // fuera 0, el aprieto habría dejado ciega a la mitad del hogar.
    expect(visto.length, "MEMBER dejó de ver la semana de su propio hogar").toBe(1);

    const { creado, editado, borrado } = await h.como(USER_MEMBER, async () => ({
      creado: await intentar(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'DINNER', 'EAT_OUT')`,
        [diaLunes],
      ),
      editado: await intentar("update public.meal_assignments set notes = 'mío' where id = $1", [
        almuerzo,
      ]),
      borrado: await intentar("delete from public.meal_assignments where id = $1", [almuerzo]),
    }));

    expect(noPudo(creado), "MEMBER creó una asignación").toBe(true);
    expect(noPudo(editado), "MEMBER editó una asignación ajena").toBe(true);
    expect(noPudo(borrado), "MEMBER borró una asignación").toBe(true);

    const sigue = await h.comoAdmin(() =>
      h.fila("select id from public.meal_assignments where id = $1", [almuerzo]),
    );
    expect(sigue, "el almuerzo desapareció").not.toBeNull();
  });

  it("SHOPPER administra la compra, no la semana", async () => {
    const intento = await h.como(USER_SHOPPER, () =>
      intentar(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'DINNER', 'EAT_OUT')`,
        [diaLunes],
      ),
    );
    expect(noPudo(intento), "can_manage_shopping se filtró al plan").toBe(true);
  });

  it("PLANNER crea, edita y borra igual que siempre", async () => {
    const id = await h.como(USER_PLANNER, async () => {
      const creada = await h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'DINNER', 'EAT_OUT') returning id`,
        [diaLunes],
      );
      return creada!.id;
    });
    expect(id).toBeTruthy();

    const editado = await h.como(USER_PLANNER, () =>
      intentar("update public.meal_assignments set notes = 'pizza' where id = $1", [id]),
    );
    expect(editado.filas, "PLANNER no pudo editar lo que él mismo creó").toBe(1);

    const borrado = await h.como(USER_PLANNER, () =>
      intentar("delete from public.meal_assignments where id = $1", [id]),
    );
    expect(borrado.filas, "PLANNER no pudo borrar").toBe(1);
  });

  it("los eventos siguen la misma regla que las comidas", async () => {
    const creadoMember = await h.como(USER_MEMBER, () =>
      intentar(
        `insert into public.nutrition_events (household_id, event_date, event_type, title)
         values ($1, $2, 'BARBECUE', 'Asado del MEMBER')`,
        [hogar.householdId, LUNES],
      ),
    );
    expect(noPudo(creadoMember), "MEMBER creó un evento").toBe(true);

    // EN BORRADOR A PROPÓSITO. Lo que esta prueba mide es el PERMISO —quién
    // puede escribir la semana— y desde la 0041 hay una regla de CICLO DE VIDA
    // encima: un evento que salió del borrador no se borra, se cancela. Son dos
    // cosas distintas y conviene no confundirlas: crear el evento en PLANNED
    // hacía fallar el borrado del PLANNER por un motivo que no tiene nada que
    // ver con sus permisos, y el rojo decía "PLANNER no pudo borrar su propio
    // evento", que manda a revisar la RLS justo donde no estaba el problema.
    const evento = await h.como(USER_PLANNER, async () => {
      const fila = await h.fila<{ id: string }>(
        `insert into public.nutrition_events (household_id, event_date, event_type, title, status)
         values ($1, $2, 'BARBECUE', 'Asado del PLANNER', 'DRAFT') returning id`,
        [hogar.householdId, LUNES],
      );
      return fila!.id;
    });
    expect(evento).toBeTruthy();

    const borradoMember = await h.como(USER_MEMBER, () =>
      intentar("delete from public.nutrition_events where id = $1", [evento]),
    );
    expect(noPudo(borradoMember), "MEMBER borró un evento ajeno").toBe(true);

    const borradoPlanner = await h.como(USER_PLANNER, () =>
      intentar("delete from public.nutrition_events where id = $1", [evento]),
    );
    expect(borradoPlanner.filas, "PLANNER no pudo borrar su propio evento en borrador").toBe(1);

    // Y LA OTRA MITAD, para que quede escrito que el permiso no es lo que corta
    // fuera del borrador: al PLANNER —que sí puede editar la semana— la regla de
    // ciclo de vida le niega el borrado igual, y la salida es cancelar.
    const yaPlaneado = await h.como(USER_PLANNER, async () => {
      const fila = await h.fila<{ id: string }>(
        `insert into public.nutrition_events (household_id, event_date, event_type, title)
         values ($1, $2, 'BARBECUE', 'Asado ya planeado') returning id`,
        [hogar.householdId, LUNES],
      );
      return fila!.id;
    });
    const borrarPlaneado = await h.como(USER_PLANNER, () =>
      intentar("delete from public.nutrition_events where id = $1", [yaPlaneado]),
    );
    expect(
      noPudo(borrarPlaneado),
      "un evento fuera del borrador se pudo borrar: su historia se perdió",
    ).toBe(true);
    const cancelado = await h.como(USER_PLANNER, () =>
      intentar("update public.nutrition_events set status = 'CANCELLED' where id = $1", [
        yaPlaneado,
      ]),
    );
    expect(cancelado.filas, "el PLANNER no pudo cancelar su propio evento").toBe(1);
  });

  it("nadie queda sin rol: el estado \"sin ningún rol\" ya no existe", async () => {
    // ESTE TEST REEMPLAZA A UNO QUE AFIRMABA LO CONTRARIO, y vale la pena decir
    // por qué. La primera versión de la 0039 resolvía "sin rol" como permisivo,
    // razonando que nadie había declarado nada y que UNKNOWN != ZERO. El
    // razonamiento era bueno y el resultado era una INVERSIÓN DE PERMISOS:
    // quitarle todos los roles a alguien lo dejaba más poderoso que dejarlo
    // como MEMBER. Un administrador que quisiera restringir a alguien le habría
    // dado todo, en silencio.
    //
    // La respuesta no fue elegir el otro default —"sin rol no puede nada"
    // deja fuera de su propia casa a la ficha que se agregue mañana— sino
    // sacar el implícito del medio: el arrastre (2-bis) le escribe un rol a
    // quien no lo tenía, y el trigger (2-ter) se lo pone a quien llegue después.
    // El estado deja de ser alcanzable, así que ya no hay que darle sentido.
    const ficha = await h.como(USER_ADMIN, () =>
      h.fila<{ id: string }>(
        `insert into public.household_members (household_id, display_name)
         values ($1, 'Recién llegada') returning id`,
        [hogar.householdId],
      ),
    );

    const roles = await h.comoAdmin(() =>
      h.filas<{ code: string }>(
        `select r.code
         from public.member_role_assignments a
         join public.household_roles r on r.id = a.role_id
         where a.member_id = $1`,
        [ficha!.id],
      ),
    );
    expect(roles.map((r) => r.code), "una ficha nueva nació sin ningún rol").toEqual(["MEMBER"]);
  });

  it("el arrastre no le regala permisos a un hogar nuevo", async () => {
    // La contracara del arrastre: en un hogar que ya existía, MEMBER quedó con
    // los dos permisos porque ESO es lo que su gente podía hacer. En un hogar
    // NUEVO, MEMBER estrena la matriz que la 0001 declaró y que hasta ahora no
    // significaba nada. Si esto se rompe, el arrastre dejó de ser un arrastre y
    // pasó a ser una regla.
    const nuevo = await crearHogar(h, USER_HOGAR_NUEVO, "Hogar estrenado", "Nueva");
    const member = await h.comoAdmin(() =>
      h.fila<{ can_edit_plan: boolean; can_cook: boolean }>(
        `select can_edit_plan, can_cook from public.household_roles
         where household_id = $1 and code = 'MEMBER'`,
        [nuevo.householdId],
      ),
    );
    expect(member, "el hogar nuevo no tiene rol MEMBER").not.toBeNull();
    expect(member!.can_edit_plan, "MEMBER de un hogar nuevo estrenó can_edit_plan").toBe(false);
    expect(member!.can_cook, "MEMBER de un hogar nuevo estrenó can_cook").toBe(false);
  });

  it("un rechazo tiene que HABLAR, no dejar la pantalla igual", async () => {
    // ERROR != VACÍO aplicado al permiso. Cuando `using` de una política RLS
    // rechaza una fila, PostgreSQL no se queja: la fila no entra al conjunto.
    // Un DELETE denegado borra CERO filas y vuelve como éxito.
    //
    // Para quien está usando la app eso se ve así: toca "quitar esta comida" y
    // no pasa absolutamente nada. Ni un mensaje. Y la app tampoco puede saber
    // si fue falta de permiso o si la comida ya no estaba.
    //
    // Este test es el único del archivo que NO usa `noPudo`, justamente porque
    // ese helper trata "no pasó nada" y "te dijeron que no" como lo mismo. Acá
    // la diferencia ES lo que se prueba.
    const creada = await h.como(USER_ADMIN, () =>
      h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'DINNER', 'EAT_OUT') returning id`,
        [diaLunes],
      ),
    );

    const borrado = await h.como(USER_MEMBER, () =>
      intentar("delete from public.meal_assignments where id = $1", [creada!.id]),
    );

    expect(
      borrado.rechazado,
      "el borrado sin permiso no falló: devolvió éxito con cero filas, que es " +
        "lo que la persona ve como «no pasó nada»",
    ).toBe(true);
    expect(borrado.mensaje ?? "", "el rechazo no dice qué faltó").toMatch(/permiso para planificar/);

    // Y la comida sigue ahí: el mensaje no es un adorno sobre un borrado que
    // igual ocurrió.
    const sigue = await h.comoAdmin(() =>
      h.fila("select id from public.meal_assignments where id = $1", [creada!.id]),
    );
    expect(sigue, "la comida se borró igual, pese al rechazo").not.toBeNull();
  });

  it("y el que SÍ tiene permiso borra sin que el guardián se meta", async () => {
    // La contracara: un guardián que rechaza todo también "cumple" el test de
    // arriba. Este comprueba que no se pasó de estricto.
    const creada = await h.como(USER_PLANNER, () =>
      h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'BREAKFAST', 'EAT_OUT') returning id`,
        [diaLunes],
      ),
    );
    const borrado = await h.como(USER_PLANNER, () =>
      intentar("delete from public.meal_assignments where id = $1", [creada!.id]),
    );
    expect(borrado.rechazado, `PLANNER fue rechazado: ${borrado.mensaje}`).toBe(false);
    expect(borrado.filas, "PLANNER no borró nada").toBe(1);
  });

  it("la persona sola en su hogar puede con todo", async () => {
    const sola = await crearHogar(h, USER_SOLO, "Hogar de una", "Rosa");
    const creada = await h.como(USER_SOLO, async () => {
      const plan = await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, $2)",
        [sola.householdId, SEMANA],
      );
      const dia = await h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
        [plan!.ensure_weekly_plan, LUNES],
      );
      return h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'LUNCH', 'EAT_OUT') returning id`,
        [dia!.id],
      );
    });
    expect(creada, "quien crea su hogar quedó sin poder planificar").not.toBeNull();
  });

  it("el ADMIN puede aunque le quiten los dos permisos", async () => {
    await h.comoAdmin(() =>
      h.db.query(
        `update public.household_roles set can_edit_plan = false, can_cook = false
         where household_id = $1 and code = 'ADMIN'`,
        [hogar.householdId],
      ),
    );

    const creada = await h.como(USER_ADMIN, () =>
      h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'SNACK', 'EAT_OUT') returning id`,
        [diaLunes],
      ),
    );
    expect(creada, "is_admin dejó de mandar").not.toBeNull();

    await h.como(USER_ADMIN, () =>
      h.db.query("delete from public.meal_assignments where id = $1", [creada!.id]),
    );
    await h.comoAdmin(() =>
      h.db.query(
        `update public.household_roles set can_edit_plan = true, can_cook = true
         where household_id = $1 and code = 'ADMIN'`,
        [hogar.householdId],
      ),
    );
  });

  it("mirar la semana no pide permiso: ensure_weekly_plan sigue abierta", async () => {
    // Está en el camino de LECTURA (`loadWeek`, `loadShoppingContext`): si
    // pidiera can_edit_plan, la pantalla del plan reventaría en la cara de
    // quien sólo quiere mirarla.
    const plan = await h.como(USER_MEMBER, () =>
      h.fila<{ ensure_weekly_plan: string }>("select public.ensure_weekly_plan($1, $2)", [
        hogar.householdId,
        OTRA_SEMANA,
      ]),
    );
    expect(plan!.ensure_weekly_plan, "MEMBER no pudo abrir su semana").toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("mover la despensa pide can_cook", () => {
  it("confirmar acepta plan O cocina, y rebota a quien no tiene ninguno", async () => {
    const shopper = await h.como(USER_SHOPPER, () =>
      intentar("select public.confirm_meal_assignment($1, $2::jsonb)", [
        almuerzo,
        JSON.stringify(porciones()),
      ]),
    );
    expect(shopper.rechazado, "SHOPPER confirmó una comida").toBe(true);
    expect(shopper.mensaje).toMatch(/no autorizado/);

    const member = await h.como(USER_MEMBER, () =>
      intentar("select public.confirm_meal_assignment($1, $2::jsonb)", [
        almuerzo,
        JSON.stringify(porciones()),
      ]),
    );
    expect(member.rechazado, "MEMBER confirmó una comida").toBe(true);

    // Quien planifica confirma, y quien cocina también: exigir los dos
    // permisos dejaría a la cocinera sin poder cerrar lo que va a servir.
    const dePlanner = await h.como(USER_PLANNER, () =>
      h.fila<{ confirm_meal_assignment: number }>(
        "select public.confirm_meal_assignment($1, $2::jsonb)",
        [almuerzo, JSON.stringify(porciones())],
      ),
    );
    expect(Number(dePlanner!.confirm_meal_assignment)).toBe(1);

    const deCook = await h.como(USER_COOK, () =>
      h.fila<{ confirm_meal_assignment: number }>(
        "select public.confirm_meal_assignment($1, $2::jsonb)",
        [almuerzo, JSON.stringify(porciones())],
      ),
    );
    expect(Number(deCook!.confirm_meal_assignment)).toBe(1);
  });

  it("desconfirmar sigue la misma regla que confirmar", async () => {
    const member = await h.como(USER_MEMBER, () =>
      intentar("select public.unconfirm_meal_assignment($1)", [almuerzo]),
    );
    expect(member.rechazado, "MEMBER desconfirmó una comida").toBe(true);

    await h.como(USER_COOK, () =>
      h.db.query("select public.unconfirm_meal_assignment($1)", [almuerzo]),
    );
    const quedan = await h.comoAdmin(() =>
      h.filas("select 1 from public.member_serving_projections where assignment_id = $1", [almuerzo]),
    );
    expect(quedan, "COOK no pudo desconfirmar").toHaveLength(0);

    // Se deja confirmada de nuevo para el test de servir.
    await h.como(USER_COOK, () =>
      h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
        almuerzo,
        JSON.stringify(porciones()),
      ]),
    );
  });

  it("servir es física: PLANNER rebota, COOK sirve", async () => {
    const planner = await h.como(USER_PLANNER, () =>
      intentar("select public.serve_meal_assignment($1, null)", [almuerzo]),
    );
    expect(planner.rechazado, "quien planifica pudo mover la despensa").toBe(true);
    expect(planner.mensaje).toMatch(/no autorizado/);

    const servido = await h.como(USER_COOK, () =>
      h.fila<{ serve_meal_assignment: { servings: number } }>(
        "select public.serve_meal_assignment($1, null)",
        [almuerzo],
      ),
    );
    expect(servido!.serve_meal_assignment.servings, "COOK no pudo servir").toBe(1);
  });

  it("servir fuera del plan pide lo mismo: es el mismo acto", async () => {
    const lote = await h.comoAdmin(async () => {
      const id = (await h.fila<{ id: string }>(
        `insert into public.inventory_lots
           (household_id, ingredient_id, label, unit, quantity, weight_basis, status)
         values ($1, $2, 'Pollo suelto', 'G', 0, 'RAW', 'AVAILABLE') returning id`,
        [hogar.householdId, ingredientePollo],
      ))!.id;
      await h.db.query(
        `insert into public.inventory_movements (household_id, lot_id, reason, delta)
         values ($1, $2, 'PURCHASE', 500)`,
        [hogar.householdId, id],
      );
      return id;
    });

    const planner = await h.como(USER_PLANNER, () =>
      intentar("select public.serve_off_plan($1, $2, 100, 'SNACK', null)", [
        hogar.memberId,
        lote,
      ]),
    );
    expect(planner.rechazado, "quien planifica sacó comida de la despensa").toBe(true);
    expect(planner.mensaje).toMatch(/no autorizado/);

    const cook = await h.como(USER_COOK, () =>
      h.fila<{ serve_off_plan: string }>("select public.serve_off_plan($1, $2, 100, 'SNACK', null)", [
        hogar.memberId,
        lote,
      ]),
    );
    expect(cook!.serve_off_plan, "COOK no pudo servir fuera del plan").toBeTruthy();

    const restante = await h.comoAdmin(() =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [lote]),
    );
    expect(Number(restante!.quantity), "el descuento físico no ocurrió").toBe(400);
  });
});

// ---------------------------------------------------------------------------
/**
 * El lado peligroso: la familia que YA está adentro.
 *
 * En producción hay un hogar con seis integrantes repartidos con la semilla de
 * la 0001, donde MEMBER trae `can_edit_plan = false` y `can_cook = false`.
 * Conectar los permisos sin más deja a esa gente sin su propio plan. La 0039
 * arrastra los roles existentes a permisivo justamente para eso, y acá se mide
 * con la base en el estado exacto de antes de la migración.
 */
describe("la familia que ya estaba adentro no pierde nada", () => {
  const USER_VIEJO_ADMIN = "00000000-0000-0000-0000-0000000039b1";
  const USER_VIEJO_MEMBER = "00000000-0000-0000-0000-0000000039b2";

  let hv: Harness;
  let hogarViejo: { householdId: string; memberId: string };
  let diaViejo: string;

  beforeAll(async () => {
    hv = await levantarBase();
    await asegurar0039(hv);

    hogarViejo = await crearHogar(hv, USER_VIEJO_ADMIN, "Hogar de siempre", "Ricardo");

    // Se rebobina el hogar al estado PREVIO a la 0039: la matriz literal de
    // 0001:166. Escribirlo a mano y no confiar en el orden de las migraciones
    // es lo que hace que este test siga midiendo lo mismo cuando la 0039 entre
    // a la lista del harness.
    await hv.comoAdmin(() =>
      hv.db.query(
        `update public.household_roles
         set can_edit_plan = code in ('ADMIN', 'PLANNER'),
             can_cook      = code in ('ADMIN', 'COOK')
         where household_id = $1`,
        [hogarViejo.householdId],
      ),
    );

    await hv.comoAdmin(() =>
      hv.db.query("insert into auth.users (id, email) values ($1, $2)", [
        USER_VIEJO_MEMBER,
        "sebastian@permisos.dev",
      ]),
    );
    await hv.como(USER_VIEJO_ADMIN, () =>
      hv.db.query(
        `insert into public.invitations (household_id, token_hash, role_code, expires_at)
         values ($1, 'permisos-token-viejo', 'MEMBER', now() + interval '1 day')`,
        [hogarViejo.householdId],
      ),
    );
    await hv.como(USER_VIEJO_MEMBER, () =>
      hv.db.query("select public.accept_invitation('permisos-token-viejo', 'Sebastián')"),
    );

    await hv.como(USER_VIEJO_ADMIN, async () => {
      const plan = await hv.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, $2)",
        [hogarViejo.householdId, SEMANA],
      );
      diaViejo = (await hv.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
        [plan!.ensure_weekly_plan, LUNES],
      ))!.id;
    });
  }, 120_000);

  afterAll(async () => {
    await hv?.cerrar();
  });

  it("sin el arrastre, ese MEMBER quedaría fuera de su propio plan", async () => {
    // Esta es la foto del daño que la migración tiene que evitar. Si algún día
    // este test se pone verde por el otro lado, es que el arrastre desapareció
    // y hay una familia sin plan.
    const intento = await hv.como(USER_VIEJO_MEMBER, async () => {
      try {
        const r = await hv.db.query(
          `insert into public.meal_assignments (day_id, meal_type, kind)
           values ($1, 'LUNCH', 'EAT_OUT')`,
          [diaViejo],
        );
        return { rechazado: false, filas: (r as { affectedRows?: number }).affectedRows ?? 0 };
      } catch {
        return { rechazado: true, filas: 0 };
      }
    });
    expect(intento.rechazado || intento.filas === 0).toBe(true);
  });

  it("aplicar la 0039 sobre esa base le devuelve el plan y la cocina", async () => {
    await hv.comoAdmin(() => hv.db.exec(readFileSync(ARCHIVO_0039, "utf8")));

    const roles = await hv.comoAdmin(() =>
      hv.filas<{ code: string; can_edit_plan: boolean; can_cook: boolean }>(
        `select code, can_edit_plan, can_cook from public.household_roles
         where household_id = $1 order by code`,
        [hogarViejo.householdId],
      ),
    );
    expect(
      roles.every((r) => r.can_edit_plan && r.can_cook),
      "un rol que ya existía perdió permisos que tenía ayer",
    ).toBe(true);

    const creada = await hv.como(USER_VIEJO_MEMBER, () =>
      hv.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind)
         values ($1, 'LUNCH', 'EAT_OUT') returning id`,
        [diaViejo],
      ),
    );
    expect(creada, "la familia de siempre se quedó sin plan").not.toBeNull();
  });
});
