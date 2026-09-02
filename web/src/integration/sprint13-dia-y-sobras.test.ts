import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 13 — etapas 6 y 7: el día del asado y lo que queda después.
 *
 * Cada bloque de acá prueba una cosa que se ROMPE si se revierte el arreglo:
 *
 *   · servir en el evento descuenta por el MISMO libro mayor, con conversión
 *     cocido→crudo cuando hay factor y con faltante declarado cuando no lo hay
 *     (jamás 1:1 inventado);
 *   · el candado de movimientos acepta el renglón del evento como dueño, y
 *     nada más: sin renglón no hay descuento, y una sobra no puede volver al
 *     lote crudo del que salió;
 *   · la sobra guardada no puede pasar lo que esa fuente sirvió (conservación);
 *   · la carne cruda que nunca se cocinó no es merma: sigue en su lote (§91);
 *   · el consumo de un invitado NO es intake de ningún integrante: no aparece
 *     ni una fila en consumption_logs;
 *   · quien sólo cocina puede correr el día entero del evento;
 *   · pasada la ventana de corrección, el asado es historia y no acepta más
 *     hechos.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: mismo motivo que
 * sprint13-eventos.test.ts — `harness.ts` lo comparten varios agentes y su
 * lista todavía no llega a la 0041.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const PENDIENTES = [
  "supabase/migrations/0039_permisos_plan_y_cocina.sql",
  "supabase/migrations/0040_adaptive_reviews.sql",
  "supabase/migrations/0041_eventos_avanzados.sql",
];

const USER_ANA = "00000000-0000-0000-0000-0000000613a1";
const USER_COCINERO = "00000000-0000-0000-0000-0000000613a2";
const USER_VECINO = "00000000-0000-0000-0000-0000000613b1";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let vecino: { householdId: string; memberId: string };

interface Intento {
  rechazado: boolean;
  mensaje: string | null;
}

async function intentar(fn: () => Promise<unknown>): Promise<Intento> {
  try {
    await fn();
    return { rechazado: false, mensaje: null };
  } catch (e) {
    return { rechazado: true, mensaje: (e as Error).message };
  }
}

async function asegurar(testigoSql: string, archivo: string): Promise<void> {
  const ya = await h.comoAdmin(() => h.fila(testigoSql));
  if (ya) return;
  await h.comoAdmin(() => h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8")));
}

/** Un alimento del hogar, para poder tener lotes con identidad de catálogo. */
async function alimento(nombre: string): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.ingredients
         (household_id, canonical_name, display_name, category_id, is_active)
       values ($1, $2, $3, (select id from public.ingredient_categories order by code limit 1), true)
       returning id`,
      [hogar.householdId, nombre.toLowerCase(), nombre],
    ),
  );
  return r!.id;
}

/**
 * Una carne NUEVA para cada test, con su rendimiento declarado.
 *
 * No es manía de aislamiento: FEFO elige por vencimiento y antigüedad entre
 * TODOS los lotes de ese alimento, así que dos tests compartiendo "lomo vetado"
 * se roban los lotes entre ellos y el que falla no es el que está mal.
 */
let secuenciaCarne = 0;
async function carne(factor: number | null): Promise<string> {
  secuenciaCarne += 1;
  const id = await alimento(`Corte de prueba ${secuenciaCarne}`);
  if (factor !== null) {
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.ingredient_yields (ingredient_id, cooking_method, yield_factor, source)
         values ($1, null, $2, 'test: rendimiento declarado')`,
        [id, factor],
      ),
    );
  }
  return id;
}

/** Un lote disponible, con la base física que se pida. */
async function lote(opciones: {
  ingredientId: string;
  gramos: number;
  basis?: string;
  label?: string;
}): Promise<string> {
  return h.comoAdmin(async () => {
    const l = await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, quantity, unit, weight_basis, status)
       values ($1, $2, $3, 0, 'G', $4::public.weight_basis, 'AVAILABLE') returning id`,
      [hogar.householdId, opciones.ingredientId, opciones.label ?? "lote", opciones.basis ?? "RAW"],
    );
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1, $2, 'PURCHASE', $3)`,
      [hogar.householdId, l!.id, opciones.gramos],
    );
    return l!.id;
  });
}

async function cantidadDelLote(lotId: string): Promise<number> {
  const r = await h.comoAdmin(() =>
    h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
      lotId,
    ]),
  );
  return Number(r!.quantity);
}

/** Un evento en curso, listo para servir. */
async function eventoEnCurso(titulo: string): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.nutrition_events
         (household_id, event_date, event_type, meal_type, title, status)
       values ($1, current_date, 'BARBECUE', 'LUNCH', $2, 'CONFIRMED') returning id`,
      [hogar.householdId, titulo],
    ),
  );
  await h.comoAdmin(() =>
    h.db.query(
      "update public.nutrition_events set status = 'IN_PROGRESS' where id = $1",
      [r!.id],
    ),
  );
  return r!.id;
}

interface Servido {
  item_id: string;
  record_id: string;
  served: number;
  deducted: number;
  shortfall: number;
  repetido: boolean;
}

async function servir(
  usuario: string,
  args: {
    eventoId: string;
    label: string;
    gramos: number;
    ingredientId?: string | null;
    basis?: string;
    tanda?: number | null;
    clave?: string | null;
  },
): Promise<Servido> {
  const r = await h.como(usuario, () =>
    h.fila<{ serve_event_item: Servido }>(
      `select public.serve_event_item($1, $2, $3, 'G', $4::public.weight_basis, null, $5, null, $6, $7)`,
      [
        args.eventoId,
        args.label,
        args.gramos,
        args.basis ?? "COOKED",
        args.ingredientId ?? null,
        args.tanda ?? null,
        args.clave ?? null,
      ],
    ),
  );
  return r!.serve_event_item;
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
  await asegurar("select 1 where to_regclass('public.event_participants') is not null", PENDIENTES[2]!);

  hogar = await crearHogar(h, USER_ANA, "Hogar Parrilla", "Ana");
  vecino = await crearHogar(h, USER_VECINO, "Hogar Vecino", "Vicente");

  // Alguien que SÓLO cocina: es quien está en la parrilla el sábado.
  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_COCINERO,
      "cocinero13@test.dev",
    ]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, 'Coco', '1990-01-01') returning id`,
      [hogar.householdId, USER_COCINERO],
    );
    await h.db.query(
      `insert into public.member_role_assignments (member_id, role_id)
       select $1, id from public.household_roles
       where household_id = $2 and code = 'COOK' on conflict do nothing`,
      [m!.id, hogar.householdId],
    );
    await h.db.query(
      `delete from public.member_role_assignments a
       using public.household_roles r
       where a.role_id = r.id and a.member_id = $1 and r.code = 'MEMBER'`,
      [m!.id],
    );
    return m!.id;
  });
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

// ===========================================================================
// Servir: el libro mayor de siempre, con un dueño de renglón más
// ===========================================================================

describe("servir en el evento pasa por el libro mayor", () => {
  it("descuenta del lote crudo convirtiendo cocido→crudo con el factor validado", async () => {
    // 3.000 g crudos con rendimiento 0,71 rinden 2.130 g cocidos. Servir 1.420 g
    // cocidos tiene que sacar 2.000 g crudos, no 1.420.
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno crudo" });
    const evento = await eventoEnCurso("Asado del sábado");

    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo vetado a la parrilla",
      gramos: 1420,
      ingredientId: vacuno,
    });

    expect(r.shortfall).toBe(0);
    expect(Number(r.deducted)).toBeCloseTo(1420, 3);
    expect(await cantidadDelLote(l)).toBeCloseTo(1000, 2);

    // El movimiento cuelga del renglón del EVENTO, no de una porción personal.
    const mov = await h.comoAdmin(() =>
      h.fila<{
        reason: string;
        delta: string;
        covers_quantity: string;
        serving_record_item_id: string | null;
      }>(
        `select reason, delta, covers_quantity, serving_record_item_id
         from public.inventory_movements where event_serving_item_id = $1`,
        [r.item_id],
      ),
    );
    expect(mov!.reason).toBe("CONSUMED");
    expect(mov!.serving_record_item_id).toBeNull();
    // delta en la lengua del LOTE (crudo), cobertura en la del RENGLÓN (cocido).
    expect(Number(mov!.delta)).toBeCloseTo(-2000, 2);
    expect(Number(mov!.covers_quantity)).toBeCloseTo(-1420, 2);
  });

  it("sin factor de rendimiento NO inventa 1:1: declara el faltante", async () => {
    // El pollo no tiene fila en ingredient_yields. Hay 5 kg crudos en la
    // despensa y se sirven 2 kg cocidos: el sistema NO puede saber cuántos
    // gramos crudos son, así que no toca el lote y lo dice.
    // Sin fila en ingredient_yields: nadie declaró cuánto rinde este corte.
    const pollo = await carne(null);
    const l = await lote({ ingredientId: pollo, gramos: 5000, label: "pollo crudo" });
    const evento = await eventoEnCurso("Asado sin rendimiento");

    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Pollo asado",
      gramos: 2000,
      ingredientId: pollo,
    });

    expect(Number(r.shortfall)).toBeCloseTo(2000, 3);
    expect(Number(r.deducted)).toBe(0);
    expect(await cantidadDelLote(l)).toBeCloseTo(5000, 2);
  });

  it("el mismo botón apretado dos veces sirve una vez", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 2000, label: "vacuno idempotencia" });
    const evento = await eventoEnCurso("Asado con doble clic");

    const uno = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
      clave: "tanda-1",
    });
    const dos = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
      clave: "tanda-1",
    });

    expect(dos.item_id).toBe(uno.item_id);
    expect(dos.repetido).toBe(true);
    expect(await cantidadDelLote(l)).toBeCloseTo(1000, 2);
  });

  it("servir la primera fuente empieza el evento confirmado", async () => {
    const evento = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.nutrition_events
           (household_id, event_date, event_type, meal_type, title, status)
         values ($1, current_date, 'BARBECUE', 'LUNCH', 'Asado que nadie inició', 'CONFIRMED')
         returning id`,
        [hogar.householdId],
      ),
    );
    await servir(USER_ANA, { eventoId: evento!.id, label: "Choripán", gramos: 300 });

    const e = await h.comoAdmin(() =>
      h.fila<{ status: string }>("select status from public.nutrition_events where id = $1", [
        evento!.id,
      ]),
    );
    expect(e!.status).toBe("IN_PROGRESS");
  });

  it("un evento en borrador no acepta comida servida", async () => {
    const evento = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.nutrition_events
           (household_id, event_date, event_type, title, status)
         values ($1, current_date, 'BARBECUE', 'Borrador', 'DRAFT') returning id`,
        [hogar.householdId],
      ),
    );
    const i = await intentar(() =>
      servir(USER_ANA, { eventoId: evento!.id, label: "Lomo", gramos: 100 }),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/confirm/i);
  });
});

// ===========================================================================
// El candado: sin renglón no hay descuento; y lo asado no vuelve al lote crudo
// ===========================================================================

describe("el candado de movimientos con el renglón del evento", () => {
  it("un CONSUMED sin ningún renglón detrás sigue rebotando", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 500, label: "vacuno suelto" });
    const i = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements (household_id, lot_id, reason, delta)
           values ($1, $2, 'CONSUMED', -100)`,
          [hogar.householdId, l],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/primero se sirve/);
  });

  it("no se puede descontar dos veces la misma fuente", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno tope" });
    const evento = await eventoEnCurso("Asado con tope");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
    });

    const i = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, event_serving_item_id, covers_quantity)
           values ($1, $2, 'CONSUMED', -710, $3, -710)`,
          [hogar.householdId, l, r.item_id],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/dos veces la misma comida/);
  });

  it("una sobra suelta, sin renglón que la acote, no entra a la despensa", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 100, label: "vacuno libre" });
    const i = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements (household_id, lot_id, reason, delta)
           values ($1, $2, 'LEFTOVER_RETURN', 5000)`,
          [hogar.householdId, l],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/colgada del renglón/);
  });

  it("lo que salió a la parrilla no se devuelve al lote del que salió", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno reversión" });
    const evento = await eventoEnCurso("Asado sin reversión");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
    });

    // Intento 1: la sobra apuntando al MISMO lote crudo.
    const mismoLote = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, event_serving_item_id, covers_quantity)
           values ($1, $2, 'LEFTOVER_RETURN', 200, $3, -200)`,
          [hogar.householdId, l, r.item_id],
        ),
      ),
    );
    expect(mismoLote.rechazado).toBe(true);
    expect(mismoLote.mensaje).toMatch(/lote nuevo/);

    // Intento 2: una reversión clásica del descuento del evento.
    const mov = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.inventory_movements where event_serving_item_id = $1 limit 1",
        [r.item_id],
      ),
    );
    const reversion = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, event_serving_item_id, covers_quantity,
              reverses_movement_id)
           values ($1, $2, 'ADJUSTMENT', 200, $3, 200, $4)`,
          [hogar.householdId, l, r.item_id, mov!.id],
        ),
      ),
    );
    expect(reversion.rechazado).toBe(true);
  });
});

// ===========================================================================
// La rama personal del candado, DESPUÉS de que la 0041 lo reescribió
// ===========================================================================
//
// `app.movement_owner_guard` se reemplaza entera en la 0041 para que acepte el
// renglón del evento. Los tests del Sprint 12 no ven esa versión —su cadena
// llega hasta la 0040—, así que si al copiar la rama personal se cayera una
// pared, nadie se enteraría hasta producción. Estos dos casos corren con la
// 0041 puesta y son exactamente los que la 0036 defiende.

describe("la porción de UNA persona sigue igual de protegida", () => {
  it("un segundo descuento sobre el mismo renglón personal sigue rebotando", async () => {
    const carneSuelta = await carne(null);
    const l = await lote({ ingredientId: carneSuelta, gramos: 900, label: "para el sandwich" });

    const record = await h.como(USER_ANA, () =>
      h.fila<{ serve_off_plan: string }>("select public.serve_off_plan($1, $2, 300)", [
        hogar.memberId,
        l,
      ]),
    );
    const item = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.meal_serving_record_items where record_id = $1",
        [record!.serve_off_plan],
      ),
    );
    expect(await cantidadDelLote(l)).toBeCloseTo(600, 2);

    const i = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
           values ($1, $2, 'CONSUMED', -300, $3, -300)`,
          [hogar.householdId, l, item!.id],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/dos veces la misma comida/);
  });

  it("un ajuste sin movimiento que deshacer sigue rebotando", async () => {
    const carneSuelta = await carne(null);
    const l = await lote({ ingredientId: carneSuelta, gramos: 500, label: "para el ajuste" });
    const record = await h.como(USER_ANA, () =>
      h.fila<{ serve_off_plan: string }>("select public.serve_off_plan($1, $2, 200)", [
        hogar.memberId,
        l,
      ]),
    );
    const item = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.meal_serving_record_items where record_id = $1",
        [record!.serve_off_plan],
      ),
    );

    const i = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
           values ($1, $2, 'ADJUSTMENT', 200, $3, 200)`,
          [hogar.householdId, l, item!.id],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/reversión de un descuento/);
  });
});

// ===========================================================================
// Sobras: conservación de masa
// ===========================================================================

describe("la sobra vuelve como lote cocido y no fabrica comida", () => {
  it("crea un lote COOKED colgado del renglón, sin fecha inventada", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno sobra" });
    const evento = await eventoEnCurso("Asado con sobra");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1420,
      ingredientId: vacuno,
    });

    const guardado = await h.como(USER_ANA, () =>
      h.fila<{ save_event_leftover: { lot_id: string; safety_pendiente: boolean } }>(
        "select public.save_event_leftover($1, 800, null, null, null, null)",
        [r.item_id],
      ),
    );
    const lotId = guardado!.save_event_leftover.lot_id;
    expect(guardado!.save_event_leftover.safety_pendiente).toBe(true);

    const nuevo = await h.comoAdmin(() =>
      h.fila<{
        quantity: string;
        weight_basis: string;
        processing_state: string;
        use_by: string | null;
        source_event_serving_item_id: string;
        temperature_state: string;
      }>(
        `select quantity, weight_basis, processing_state, use_by,
                source_event_serving_item_id, temperature_state
         from public.inventory_lots where id = $1`,
        [lotId],
      ),
    );
    expect(Number(nuevo!.quantity)).toBeCloseTo(800, 2);
    expect(nuevo!.weight_basis).toBe("COOKED");
    expect(nuevo!.processing_state).toBe("COOKED");
    // Nadie inventó una fecha de consumo: eso lo decide el motor con regla.
    expect(nuevo!.use_by).toBeNull();
    expect(nuevo!.source_event_serving_item_id).toBe(r.item_id);
    expect(nuevo!.temperature_state).toBe("CHILLED");

    // El lote crudo NO recuperó nada: los 2.000 g crudos siguen descontados.
    expect(await cantidadDelLote(l)).toBeCloseTo(1000, 2);
  });

  it("no puede volver más comida de la que esa fuente sirvió", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno conservación" });
    const evento = await eventoEnCurso("Asado que no fabrica carne");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1000,
      ingredientId: vacuno,
    });

    await h.como(USER_ANA, () =>
      h.db.query("select public.save_event_leftover($1, 600, null, null, null, 'a')", [r.item_id]),
    );
    const i = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.save_event_leftover($1, 600, null, null, null, 'b')", [r.item_id]),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/no puede volver más comida de la que salió/);
  });

  it("guardar la misma sobra dos veces guarda una", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno sobra idem" });
    const evento = await eventoEnCurso("Asado sobra repetida");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1000,
      ingredientId: vacuno,
    });

    const uno = await h.como(USER_ANA, () =>
      h.fila<{ save_event_leftover: { lot_id: string } }>(
        "select public.save_event_leftover($1, 300, null, null, null, 'misma')",
        [r.item_id],
      ),
    );
    const dos = await h.como(USER_ANA, () =>
      h.fila<{ save_event_leftover: { lot_id: string; repetido: boolean } }>(
        "select public.save_event_leftover($1, 300, null, null, null, 'misma')",
        [r.item_id],
      ),
    );
    expect(dos!.save_event_leftover.lot_id).toBe(uno!.save_event_leftover.lot_id);
    expect(dos!.save_event_leftover.repetido).toBe(true);
  });

  it("[§91] la carne cruda que no se cocinó sigue siendo inventario, no merma", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 4000, label: "vacuno sin cocinar" });
    const evento = await eventoEnCurso("Asado que sobró crudo");
    await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
    });

    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set status = 'COMPLETED' where id = $1", [evento]),
    );

    // Cerrar el evento no botó nada: sólo salió lo que se sirvió.
    expect(await cantidadDelLote(l)).toBeCloseTo(3000, 2);
    const mermas = await h.comoAdmin(() =>
      h.filas(
        `select id from public.inventory_movements
         where lot_id = $1 and reason in ('DISCARDED_LEFTOVER','SPOILED','EXPIRED','DAMAGED')`,
        [l],
      ),
    );
    expect(mermas).toHaveLength(0);
  });
});

// ===========================================================================
// El consumo de un invitado no es intake de nadie
// ===========================================================================

describe("el consumo del evento no se le atribuye a ninguna persona del hogar", () => {
  it("el balance de masa es del hogar y no toca consumption_logs", async () => {
    const evento = await eventoEnCurso("Asado con balance");
    const antes = await h.comoAdmin(() =>
      h.filas("select id from public.consumption_logs where household_id = $1", [
        hogar.householdId,
      ]),
    );

    await h.como(USER_ANA, () =>
      h.db.query(
        `select public.record_event_consumption(
           $1, 'Lomo vetado', null, null, null, 'G',
           5000, 3550, 2900, 3200, 350, 100, null, null, null, 'LOW', '[]'::jsonb)`,
        [evento],
      ),
    );

    const despues = await h.comoAdmin(() =>
      h.filas("select id from public.consumption_logs where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(despues).toHaveLength(antes.length);

    const fila = await h.comoAdmin(() =>
      h.fila<{
        served_quantity: string;
        edible_leftover_quantity: string;
        trim_waste_quantity: string | null;
        bone_discard_quantity: string | null;
      }>(
        `select served_quantity, edible_leftover_quantity, trim_waste_quantity,
                bone_discard_quantity
         from public.event_consumption_estimates where event_id = $1`,
        [evento],
      ),
    );
    expect(Number(fila!.served_quantity)).toBeCloseTo(3550, 2);
    // Lo que nadie midió queda en NULL. UNKNOWN no se rellena con cero.
    expect(fila!.trim_waste_quantity).toBeNull();
    expect(fila!.bone_discard_quantity).toBeNull();
  });

  it("un balance que no conserva la masa rebota", async () => {
    const evento = await eventoEnCurso("Asado imposible");
    const i = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query(
          `select public.record_event_consumption(
             $1, 'Pollo', null, null, null, 'G',
             null, 1000, null, null, 800, 400, null, null, null, 'LOW', '[]'::jsonb)`,
          [evento],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/la masa no se conserva/);
  });

  it("la observación de un invitado es ordinal, del invitado, y no crea ficha de persona", async () => {
    const evento = await eventoEnCurso("Asado con invitados");
    const invitado = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `insert into public.guest_profiles (household_id, name, appetite)
         values ($1, 'Primo Juan', 'UNKNOWN') returning id`,
        [hogar.householdId],
      ),
    );
    const participante = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `insert into public.event_participants
           (event_id, participant_type, guest_id, attendance_status)
         values ($1, 'GUEST', $2, 'ATTENDED') returning id`,
        [evento, invitado!.id],
      ),
    );

    const miembrosAntes = await h.comoAdmin(() =>
      h.filas("select id from public.household_members where household_id = $1", [
        hogar.householdId,
      ]),
    );

    await h.como(USER_ANA, () =>
      h.db.query(
        "select public.record_event_guest_observation($1, 'ATE_A_LOT'::public.guest_intake_extent, null, 'se sirvió tres veces')",
        [participante!.id],
      ),
    );

    const obs = await h.comoAdmin(() =>
      h.fila<{ intake_extent: string; estimated_serving_g: string | null }>(
        `select intake_extent, estimated_serving_g
         from public.event_participant_observations where participant_id = $1`,
        [participante!.id],
      ),
    );
    expect(obs!.intake_extent).toBe("ATE_A_LOT");
    // Nadie pesó el plato del primo Juan: el dato es ordinal y los gramos, UNKNOWN.
    expect(obs!.estimated_serving_g).toBeNull();

    const miembrosDespues = await h.comoAdmin(() =>
      h.filas("select id from public.household_members where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(miembrosDespues).toHaveLength(miembrosAntes.length);
  });

  it("corregir una observación agrega fila, no la reescribe", async () => {
    const evento = await eventoEnCurso("Asado con corrección");
    const invitado = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `insert into public.guest_profiles (household_id, name)
         values ($1, 'Tía María') returning id`,
        [hogar.householdId],
      ),
    );
    const p = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `insert into public.event_participants
           (event_id, participant_type, guest_id, attendance_status)
         values ($1, 'GUEST', $2, 'ATTENDED') returning id`,
        [evento, invitado!.id],
      ),
    );
    await h.como(USER_ANA, () =>
      h.db.query(
        "select public.record_event_guest_observation($1, 'ATE_LITTLE'::public.guest_intake_extent)",
        [p!.id],
      ),
    );
    await h.como(USER_ANA, () =>
      h.db.query(
        "select public.record_event_guest_observation($1, 'ATE_NORMAL'::public.guest_intake_extent)",
        [p!.id],
      ),
    );

    const filas = await h.comoAdmin(() =>
      h.filas<{ intake_extent: string; supersedes_id: string | null }>(
        `select intake_extent, supersedes_id from public.event_participant_observations
         where participant_id = $1 order by created_at, id`,
        [p!.id],
      ),
    );
    expect(filas).toHaveLength(2);
    expect(filas[1]!.supersedes_id).not.toBeNull();

    const i = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          "update public.event_participant_observations set intake_extent = 'ATE_A_LOT' where participant_id = $1",
          [p!.id],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
  });
});

// ===========================================================================
// Permisos y ventana
// ===========================================================================

describe("quién puede anotar los hechos del día, y hasta cuándo", () => {
  it("quien sólo cocina puede servir y guardar la sobra", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno del cocinero" });
    const evento = await eventoEnCurso("Asado del cocinero");

    const r = await servir(USER_COCINERO, {
      eventoId: evento,
      label: "Lomo",
      gramos: 500,
      ingredientId: vacuno,
    });
    expect(r.item_id).toBeTruthy();

    const guardado = await h.como(USER_COCINERO, () =>
      h.fila<{ save_event_leftover: { lot_id: string } }>(
        "select public.save_event_leftover($1, 100, null, null, null, null)",
        [r.item_id],
      ),
    );
    expect(guardado!.save_event_leftover.lot_id).toBeTruthy();

    // Pero el PLAN sigue siendo del que planifica.
    const i = await intentar(() =>
      h.como(USER_COCINERO, () =>
        h.db.query(
          `insert into public.event_menu_items (event_id, kind, display_name)
           values ($1, 'MEAT', 'Entraña')`,
          [evento],
        ),
      ),
    );
    expect(i.rechazado).toBe(true);
  });

  it("el hogar de al lado no sirve en un asado ajeno", async () => {
    const evento = await eventoEnCurso("Asado privado");
    const i = await intentar(() =>
      servir(USER_VECINO, { eventoId: evento, label: "Lomo", gramos: 100 }),
    );
    expect(i.rechazado).toBe(true);
    expect(vecino.householdId).not.toBe(hogar.householdId);
  });

  it("el vecino no lee lo servido ni las observaciones de un asado ajeno", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 1000, label: "vacuno privado" });
    const evento = await eventoEnCurso("Asado con datos privados");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 300,
      ingredientId: vacuno,
    });
    const invitado = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        "insert into public.guest_profiles (household_id, name) values ($1, 'Vecina') returning id",
        [hogar.householdId],
      ),
    );
    const p = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        `insert into public.event_participants (event_id, participant_type, guest_id, attendance_status)
         values ($1, 'GUEST', $2, 'ATTENDED') returning id`,
        [evento, invitado!.id],
      ),
    );
    await h.como(USER_ANA, () =>
      h.db.query(
        "select public.record_event_guest_observation($1, 'ATE_A_LOT'::public.guest_intake_extent)",
        [p!.id],
      ),
    );

    // El de al lado ve CERO filas: no es que no existan, es que no son suyas.
    const servidoAjeno = await h.como(USER_VECINO, () =>
      h.filas("select id from public.event_serving_items where id = $1", [r.item_id]),
    );
    const observacionAjena = await h.como(USER_VECINO, () =>
      h.filas("select id from public.event_participant_observations where participant_id = $1", [
        p!.id,
      ]),
    );
    expect(servidoAjeno).toHaveLength(0);
    expect(observacionAjena).toHaveLength(0);

    // Y que sí existen se comprueba mirándolas como quien puede.
    const propias = await h.como(USER_ANA, () =>
      h.filas("select id from public.event_participant_observations where participant_id = $1", [
        p!.id,
      ]),
    );
    expect(propias).toHaveLength(1);
  });

  it("pasada la ventana de corrección, el asado ya no acepta hechos nuevos", async () => {
    const evento = await eventoEnCurso("Asado del mes pasado");
    await servir(USER_ANA, { eventoId: evento, label: "Lomo", gramos: 100 });

    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set status = 'COMPLETED' where id = $1", [evento]),
    );
    // Se envejece el cierre a mano: la ventana son 72 horas y el test no espera
    // tres días. `completed_at` está congelado por el guard de historia, así
    // que se mueve por debajo, como admin.
    await h.comoAdmin(async () => {
      // `completed_at` está CONGELADO por el guard de historia —y tiene que
      // estarlo, o la ventana se estiraría sola—. Para envejecer el cierre sin
      // esperar tres días reales, el test apaga el guard, mueve la fecha y lo
      // vuelve a encender: la pared se prueba dos líneas más abajo.
      await h.db.exec(
        "alter table public.nutrition_events disable trigger nutrition_events_history_guard",
      );
      await h.db.query(
        `update public.nutrition_events set completed_at = now() - interval '10 days'
         where id = $1`,
        [evento],
      );
      await h.db.exec(
        "alter table public.nutrition_events enable trigger nutrition_events_history_guard",
      );
    });

    const i = await intentar(() =>
      servir(USER_ANA, { eventoId: evento, label: "Otra tanda", gramos: 100 }),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/es reescribir/);
  });

  it("dentro de la ventana, corregir después del cierre sí se puede", async () => {
    const evento = await eventoEnCurso("Asado recién cerrado");
    await servir(USER_ANA, { eventoId: evento, label: "Lomo", gramos: 100 });
    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set status = 'COMPLETED' where id = $1", [evento]),
    );

    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Longaniza que nadie anotó",
      gramos: 400,
    });
    expect(r.item_id).toBeTruthy();
  });

  it("un evento cancelado no recibe comida servida", async () => {
    const evento = await eventoEnCurso("Asado cancelado");
    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set status = 'CANCELLED' where id = $1", [evento]),
    );
    const i = await intentar(() => servir(USER_ANA, { eventoId: evento, label: "Lomo", gramos: 100 }));
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/cancelado/);
  });
});

// ===========================================================================
// LA IDEMPOTENCIA NO SE ADIVINA DEL CONTENIDO
// ===========================================================================
//
// Cada test de este bloque falla si se restaura el hash de contenido que la
// primera versión usaba cuando el cliente no mandaba clave
// (`md5(menu|label|cantidad|unidad|base|tanda|día)`): con esa regla, la segunda
// fuente idéntica que sale DE VERDAD a la mesa no descuenta nada y el segundo
// táper idéntico nunca entra al inventario, y las dos veces la pantalla dice
// que se guardó.

describe("dos actos parecidos son dos actos", () => {
  it("dos fuentes iguales servidas sin clave son DOS renglones y DOS descuentos", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno dos fuentes" });
    const evento = await eventoEnCurso("Asado con dos fuentes iguales");

    const uno = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
    });
    const dos = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
    });

    expect(dos.item_id).not.toBe(uno.item_id);
    expect(dos.repetido).toBe(false);
    // 710 cocidos con factor 0,71 = 1.000 crudos, dos veces.
    expect(await cantidadDelLote(l)).toBeCloseTo(1000, 2);
  });

  it("dos táperes iguales guardados sin clave son DOS sobras", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 4000, label: "vacuno dos táperes" });
    const evento = await eventoEnCurso("Asado con dos táperes");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1000,
      ingredientId: vacuno,
    });

    const uno = await h.como(USER_ANA, () =>
      h.fila<{ save_event_leftover: { lot_id: string; repetido: boolean } }>(
        "select public.save_event_leftover($1, 400, null, null, null, null)",
        [r.item_id],
      ),
    );
    const dos = await h.como(USER_ANA, () =>
      h.fila<{ save_event_leftover: { lot_id: string; repetido: boolean } }>(
        "select public.save_event_leftover($1, 400, null, null, null, null)",
        [r.item_id],
      ),
    );

    expect(dos!.save_event_leftover.lot_id).not.toBe(uno!.save_event_leftover.lot_id);
    expect(dos!.save_event_leftover.repetido).toBe(false);

    const volvio = await h.comoAdmin(() =>
      h.fila<{ total: string }>(
        `select coalesce(sum(-covers_quantity), 0)::text as total
         from public.inventory_movements
         where event_serving_item_id = $1 and reason = 'LEFTOVER_RETURN'`,
        [r.item_id],
      ),
    );
    expect(Number(volvio!.total)).toBeCloseTo(800, 2);
  });

  it("la clave del evento no cruza a otro asado", async () => {
    const evento1 = await eventoEnCurso("Asado uno");
    const evento2 = await eventoEnCurso("Asado dos");
    const uno = await servir(USER_ANA, {
      eventoId: evento1,
      label: "Longaniza",
      gramos: 300,
      clave: "intento-compartido",
    });
    const dos = await servir(USER_ANA, {
      eventoId: evento2,
      label: "Longaniza",
      gramos: 300,
      clave: "intento-compartido",
    });
    expect(dos.item_id).not.toBe(uno.item_id);
  });
});

// ===========================================================================
// LA MERMA DEL ASADO EXISTE (§55)
// ===========================================================================

describe("botar lo que salió a la mesa", () => {
  it("anota la merma sin volver a descontar, y gasta el saldo de esa fuente", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno merma" });
    const evento = await eventoEnCurso("Asado con merma");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1000,
      ingredientId: vacuno,
    });
    const despuesDeServir = await cantidadDelLote(l);

    await h.como(USER_ANA, () =>
      h.db.query("select public.discard_event_serving($1, 300, 'se quemó', null)", [r.item_id]),
    );

    // El lote NO se toca: esos gramos ya salieron al servirse.
    expect(await cantidadDelLote(l)).toBeCloseTo(despuesDeServir, 3);

    const renglon = await h.comoAdmin(() =>
      h.fila<{ discarded_quantity: string }>(
        "select discarded_quantity from public.event_serving_items where id = $1",
        [r.item_id],
      ),
    );
    expect(Number(renglon!.discarded_quantity)).toBeCloseTo(300, 3);

    // Y la merma pesa en la lengua del LOTE, para el informe de desperdicio.
    const mov = await h.comoAdmin(() =>
      h.fila<{ delta: string; waste_lot_quantity: string }>(
        `select delta, waste_lot_quantity from public.inventory_movements
         where event_serving_item_id = $1 and reason = 'DISCARDED_LEFTOVER'`,
        [r.item_id],
      ),
    );
    expect(Number(mov!.delta)).toBe(0);
    expect(Number(mov!.waste_lot_quantity)).toBeLessThan(0);

    // 300 botados + 800 guardados pasarían los 1.000 servidos.
    const i = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.save_event_leftover($1, 800, null, null, null, 'a')", [r.item_id]),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/no puede volver más comida de la que salió/);
  });

  it("sin lote detrás no se inventa una merma pesada", async () => {
    const evento = await eventoEnCurso("Asado sin lote");
    const r = await servir(USER_ANA, { eventoId: evento, label: "Longaniza suelta", gramos: 500 });
    const i = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.discard_event_serving($1, 100, null, null)", [r.item_id]),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/no salió de ningún lote registrado/);
  });

  it("la misma merma con la misma clave se anota una vez", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno merma idem" });
    const evento = await eventoEnCurso("Asado merma repetida");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1000,
      ingredientId: vacuno,
    });

    await h.como(USER_ANA, () =>
      h.db.query("select public.discard_event_serving($1, 200, null, 'misma')", [r.item_id]),
    );
    const dos = await h.como(USER_ANA, () =>
      h.fila<{ discard_event_serving: { repetido: boolean } }>(
        "select public.discard_event_serving($1, 200, null, 'misma')",
        [r.item_id],
      ),
    );
    expect(dos!.discard_event_serving.repetido).toBe(true);

    const renglon = await h.comoAdmin(() =>
      h.fila<{ discarded_quantity: string }>(
        "select discarded_quantity from public.event_serving_items where id = $1",
        [r.item_id],
      ),
    );
    expect(Number(renglon!.discarded_quantity)).toBeCloseTo(200, 3);
  });
});

// ===========================================================================
// EL RENGLÓN MAL ANOTADO SE PUEDE DESHACER
// ===========================================================================

describe("anular un servido del evento", () => {
  it("devuelve al lote los gramos que le sacó, y el renglón deja de estar vivo", async () => {
    const vacuno = await carne(0.71);
    const l = await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno anulado" });
    const evento = await eventoEnCurso("Asado con dedo gordo");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1420,
      ingredientId: vacuno,
    });
    expect(await cantidadDelLote(l)).toBeCloseTo(1000, 2);

    const salida = await h.como(USER_ANA, () =>
      h.fila<{ void_event_serving_item: { devuelto_al_lote: string } }>(
        "select public.void_event_serving_item($1, $2)",
        [r.item_id, "tecleé 1420 en vez de 142"],
      ),
    );
    expect(Number(salida!.void_event_serving_item.devuelto_al_lote)).toBeCloseTo(2000, 2);
    expect(await cantidadDelLote(l)).toBeCloseTo(3000, 2);

    const vivo = await h.comoAdmin(() =>
      h.fila<{ status: string; void_reason: string }>(
        "select status, void_reason from public.event_serving_items where id = $1",
        [r.item_id],
      ),
    );
    expect(vivo!.status).toBe("VOIDED");
    expect(vivo!.void_reason).toMatch(/tecleé/);

    // El ajuste que devolvió los gramos dice POR QUÉ.
    const ajuste = await h.comoAdmin(() =>
      h.fila<{ notes: string }>(
        `select notes from public.inventory_movements
         where lot_id = $1 and reason = 'ADJUSTMENT' order by created_at desc limit 1`,
        [l],
      ),
    );
    expect(ajuste!.notes).toMatch(/anulación de un servido del evento/);
  });

  it("después de anular se puede servir de nuevo con la misma clave de intento", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno reintento tras anular" });
    const evento = await eventoEnCurso("Asado que se vuelve a servir");
    const uno = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
      clave: "intento-uno",
    });
    await h.como(USER_ANA, () =>
      h.db.query("select public.void_event_serving_item($1, 'me equivoqué')", [uno.item_id]),
    );

    const dos = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 710,
      ingredientId: vacuno,
      clave: "intento-uno",
    });
    expect(dos.item_id).not.toBe(uno.item_id);
    expect(dos.repetido).toBe(false);
  });

  it("no se anula una fuente que ya devolvió sobra al refrigerador", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno con sobra guardada" });
    const evento = await eventoEnCurso("Asado con sobra ya guardada");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 1000,
      ingredientId: vacuno,
    });
    await h.como(USER_ANA, () =>
      h.db.query("select public.save_event_leftover($1, 300, null, null, null, 'x')", [r.item_id]),
    );

    const i = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.void_event_serving_item($1, 'me equivoqué')", [r.item_id]),
      ),
    );
    expect(i.rechazado).toBe(true);
    expect(i.mensaje).toMatch(/sin de dónde salió/);
  });

  it("anular sin motivo no se puede, y lo anulado no revive", async () => {
    const evento = await eventoEnCurso("Asado sin motivo");
    const r = await servir(USER_ANA, { eventoId: evento, label: "Longaniza", gramos: 200 });

    const sinMotivo = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.void_event_serving_item($1, '   ')", [r.item_id]),
      ),
    );
    expect(sinMotivo.rechazado).toBe(true);
    expect(sinMotivo.mensaje).toMatch(/exige decir por qué/);

    await h.como(USER_ANA, () =>
      h.db.query("select public.void_event_serving_item($1, 'no salió')", [r.item_id]),
    );
    const revivir = await intentar(() =>
      h.comoAdmin(() =>
        h.db.query(
          "update public.event_serving_items set status = 'ACTIVE', void_reason = null where id = $1",
          [r.item_id],
        ),
      ),
    );
    expect(revivir.rechazado).toBe(true);
    expect(revivir.mensaje).toMatch(/no vuelve a estar vigente/);
  });

  it("un renglón anulado no recibe sobras ni mermas", async () => {
    const vacuno = await carne(0.71);
    await lote({ ingredientId: vacuno, gramos: 3000, label: "vacuno anulado cerrado" });
    const evento = await eventoEnCurso("Asado anulado cerrado");
    const r = await servir(USER_ANA, {
      eventoId: evento,
      label: "Lomo",
      gramos: 700,
      ingredientId: vacuno,
    });
    await h.como(USER_ANA, () =>
      h.db.query("select public.void_event_serving_item($1, 'no fue así')", [r.item_id]),
    );

    const sobra = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.save_event_leftover($1, 100, null, null, null, null)", [
          r.item_id,
        ]),
      ),
    );
    expect(sobra.rechazado).toBe(true);
    expect(sobra.mensaje).toMatch(/está anulado/);

    const merma = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.discard_event_serving($1, 100, null, null)", [r.item_id]),
      ),
    );
    expect(merma.rechazado).toBe(true);
    expect(merma.mensaje).toMatch(/está anulado/);
  });
});

// ===========================================================================
// LA RESERVA DE LOTES POR EVENTO NO EXISTE, Y ESO ESTÁ DECLARADO
// ===========================================================================

describe("no hay reserva de lotes por evento", () => {
  it("la columna que la prometía no existe: nadie la escribía", async () => {
    const columna = await h.comoAdmin(() =>
      h.fila(
        `select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'inventory_lots'
           and column_name = 'intended_event_id'`,
      ),
    );
    // Si vuelve a aparecer, tiene que venir CON su escritor y con el lector de
    // la demanda futura, no sola: media reserva es una reserva que la persona
    // cree tener.
    expect(columna).toBeNull();
  });

  it("la procedencia de la sobra sí existe, y es otra pregunta", async () => {
    const columna = await h.comoAdmin(() =>
      h.fila(
        `select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'inventory_lots'
           and column_name = 'source_event_serving_item_id'`,
      ),
    );
    expect(columna).not.toBeNull();
  });
});
