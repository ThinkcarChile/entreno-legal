import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

const U1 = "00000000-0000-0000-0000-0000000000f1";
const U2 = "00000000-0000-0000-0000-0000000000f2";

type Hogar = { householdId: string; memberId: string };
let h: Harness;
let H1: Hogar;
let pollo: string;

async function crearLote(hogar: Hogar, gramos: number, etiqueta: string): Promise<string> {
  return h.comoAdmin(async () => {
    const lote = (await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, unit, quantity, weight_basis, status)
       values ($1,$2,$3,'G',0,'RAW','AVAILABLE') returning id`,
      [hogar.householdId, pollo, etiqueta],
    ))!.id;
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1,$2,'PURCHASE',$3)`,
      [hogar.householdId, lote, gramos],
    );
    return lote;
  });
}

async function servir(user: string, hogar: Hogar, stock: number, g: number, et: string) {
  const loteId = await crearLote(hogar, stock, et);
  return h.como(user, async () => {
    const recordId = (await h.fila<{ serve_off_plan: string }>(
      "select public.serve_off_plan($1,$2,$3,null::public.meal_type,$4)",
      [hogar.memberId, loteId, g, et],
    ))!.serve_off_plan;
    const itemId = (await h.fila<{ id: string }>(
      "select id from public.meal_serving_record_items where record_id = $1",
      [recordId],
    ))!.id;
    return { loteId, recordId, itemId };
  });
}

async function saldo(loteId: string): Promise<number> {
  const l = await h.comoAdmin(() =>
    h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id=$1", [loteId]),
  );
  return Number(l!.quantity);
}

async function merma(hogar: Hogar): Promise<number> {
  const f = await h.comoAdmin(() =>
    h.fila<{ t: string }>(
      "select coalesce(sum(quantity),0)::text as t from public.waste_movements where household_id=$1",
      [hogar.householdId],
    ),
  );
  return Number(f!.t);
}

async function intento(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

beforeAll(async () => {
  h = await levantarBase();
  H1 = await crearHogar(h, U1, "Ataque 1", "Uno");
  // U2 necesita SU PROPIO hogar aunque los ataques D1 y D2 solo usen el usuario:
  // un atacante sin hogar rebotaria por no ser miembro de nada, y el test
  // quedaria verde por la razon equivocada. La ficha del hogar en si no se usa.
  await crearHogar(h, U2, "Ataque 2", "Dos");
  pollo = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("ATAQUE: la declaracion viva vs el hecho fisico", () => {
  it("B1: declarar que se comio TODO y despues devolverlo al refrigerador", async () => {
    const s = await servir(U1, H1, 500, 200, "B1");
    expect(await saldo(s.loteId)).toBe(300);

    const log = (await h.como(U1, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1,$2::jsonb)", [
        s.recordId,
        JSON.stringify([
          {
            serving_record_item_id: s.itemId,
            label: "pollo",
            extent: "EXACT",
            quantity: 200,
            unit: "G",
            weight_basis: "RAW",
            quantity_is_declared: true,
          },
        ]),
      ]),
    ))!.log_intake;

    const err = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.return_serving_to_inventory($1,$2,$3)", [s.itemId, 200, "volvio entero"]),
      ),
    );
    const estado = await h.comoAdmin(() =>
      h.fila(
        `select l.status::text as status, i.served_quantity::text as sq,
                (select sum(quantity)::text from public.intake_log_items where log_id = l.id) as iq
         from public.consumption_logs l
         join public.meal_serving_record_items i on i.id = $2
         where l.id = $1`,
        [log, s.itemId],
      ),
    );
    // La comida que alguien declaro haberse comido NO puede volver al
    // refrigerador. Antes de la guarda esto pasaba en silencio y los 200 g
    // quedaban a la vez en el plato de una persona y adentro del lote.
    expect(err).toMatch(/declarados comidos/);
    expect(estado).toMatchObject({ status: "ACTIVE", sq: "200.000", iq: "200.000" });
    expect(await saldo(s.loteId)).toBe(300);
  });

  it("B2: declarar que se comio TODO y despues declararlo basura", async () => {
    const s = await servir(U1, H1, 500, 200, "B2");
    const antes = await merma(H1);
    await h.como(U1, () =>
      h.fila("select public.log_intake($1,$2::jsonb)", [
        s.recordId,
        JSON.stringify([
          {
            serving_record_item_id: s.itemId,
            label: "pollo",
            extent: "EXACT",
            quantity: 200,
            unit: "G",
            weight_basis: "RAW",
            quantity_is_declared: true,
          },
        ]),
      ]),
    );
    const err = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.discard_serving($1,$2,$3,null::uuid)", [s.itemId, 200, "a la basura"]),
      ),
    );
    // Y tampoco puede irse a la basura: comida Y botada no pueden ser las dos
    // verdad. Sin esto el informe de desperdicio sumaba una merma inexistente.
    expect(err).toMatch(/declarados comidos/);
    expect(await merma(H1)).toBe(antes);
  });

  it("B3: declarar que comio 5000 g de una porcion de 200 g", async () => {
    const s = await servir(U1, H1, 500, 200, "B3");
    const err = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.log_intake($1,$2::jsonb)", [
          s.recordId,
          JSON.stringify([
            {
              serving_record_item_id: s.itemId,
              label: "pollo",
              extent: "EXACT",
              quantity: 5000,
              unit: "G",
              weight_basis: "RAW",
              quantity_is_declared: true,
            },
          ]),
        ]),
      ),
    );
    // Nadie come 5000 g de una porcion de 200. Si repitio, eso es un segundo
    // servido; el numero grande sobre este renglon entraba directo al eje
    // ACTUAL y de ahi a la nutricion real de una persona.
    expect(err).toMatch(/no se puede declarar/);
  });
});

describe("ATAQUE: el vacio leido como cero", () => {
  it("B4: corregir una declaracion a una lista VACIA", async () => {
    const s = await servir(U1, H1, 500, 200, "B4");
    const log = (await h.como(U1, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [s.recordId]),
    ))!.log_intake;
    const r = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.correct_intake_log($1,$2::jsonb,$3,null::uuid)", [
          log,
          "[]",
          "en realidad nada",
        ]),
      ),
    );
    const filas = await h.comoAdmin(() =>
      h.filas(
        `select l.id, l.status::text as status,
                (select count(*) from public.intake_log_items x where x.log_id = l.id)::text as n
         from public.consumption_logs l where l.serving_record_id = $1 order by l.logged_at`,
        [s.recordId],
      ),
    );
    // Corregir a "en realidad no comi nada" SE PERMITE, y esta bien: es una
    // afirmacion, no un vacio. Lo que se comprueba aca es que la historia queda
    // completa —la version vieja sobrevive marcada CORRECTED con su renglon, y
    // la nueva queda ACTIVE sin ninguno— y no que la vieja se borre.
    //
    // OJO con lo que esto DEJA ABIERTO y no es un defecto de esta funcion: los
    // 200 g siguen fuera de la despensa y ahora nadie se los comio. El sistema
    // no inventa que volvieron ni que se botaron. Es un hueco real del mundo,
    // no del modelo, y la pantalla deberia preguntarlo.
    expect(r).toBeNull();
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ status: "CORRECTED", n: "1" });
    expect(filas[1]).toMatchObject({ status: "ACTIVE", n: "0" });
  });

  it("B5: dos actos identicos fuera de plan el mismo dia se colapsan en uno", async () => {
    const items = JSON.stringify([{ label: "una manzana", extent: "ALL" }]);
    const a = (await h.como(U1, () =>
      h.fila<{ log_intake_off_plan: string }>(
        "select public.log_intake_off_plan($1,$2::jsonb,null::date,'SNACK'::public.meal_type,null,null)",
        [H1.memberId, items],
      ),
    ))!.log_intake_off_plan;
    const b = (await h.como(U1, () =>
      h.fila<{ log_intake_off_plan: string }>(
        "select public.log_intake_off_plan($1,$2::jsonb,null::date,'SNACK'::public.meal_type,null,null)",
        [H1.memberId, items],
      ),
    ))!.log_intake_off_plan;
    // ESTE TEST DOCUMENTA UNA PERDIDA, no la aprueba.
    //
    // Sin token de reintento, la clave de idempotencia se arma con el md5 de
    // los renglones, asi que dos actos IDENTICOS del mismo dia y la misma
    // comida se colapsan en uno: dos manzanas a las tres y a las cinco quedan
    // anotadas como una. Es el vacio leido como cero por la puerta de atras.
    //
    // La alternativa —no deduplicar sin token— convierte el doble toque en dos
    // filas que la persona ve y borra. Un duplicado visible es mejor que una
    // comida perdida en silencio, pero es una decision de producto y de UX, no
    // una que corresponda tomar dentro de una migracion.
    //
    // Queda afirmado para que el dia que cambie, el cambio se vea.
    expect(a).toBe(b);
  });
});

describe("ATAQUE: conservacion fisica por combinaciones", () => {
  it("C1: servir 200, botar 100, devolver 100, desbotar 100, devolver 100", async () => {
    const s = await servir(U1, H1, 500, 200, "C1");
    expect(await saldo(s.loteId)).toBe(300);
    await h.como(U1, () =>
      h.fila("select public.discard_serving($1,$2,null,null::uuid)", [s.itemId, 100]),
    );
    await h.como(U1, () =>
      h.fila("select public.return_serving_to_inventory($1,$2,$3)", [s.itemId, 100, "volvio"]),
    );
    console.log("C1 tras devolver:", await saldo(s.loteId));
    const e1 = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.undo_discard_serving($1,$2,null,null::uuid)", [s.itemId, 100]),
      ),
    );
    console.log("C1 undo:", e1, "saldo:", await saldo(s.loteId));
    const e2 = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.return_serving_to_inventory($1,$2,$3)", [s.itemId, 100, "otra vez"]),
      ),
    );
    console.log(
      "C1 segunda devolucion:",
      e2,
      "saldo final:",
      await saldo(s.loteId),
      "merma:",
      await merma(H1),
    );
    const it2 = await h.comoAdmin(() =>
      h.fila(
        "select served_quantity::text sq, deducted_quantity::text dq, discarded_quantity::text disc, reversed_quantity::text rq from public.meal_serving_record_items where id=$1",
        [s.itemId],
      ),
    );
    // CONSERVACION: entraron 500 g, salieron 200 en una porcion y volvieron los
    // 200 en dos tramos, con una vuelta por el basurero y su deshacer en el
    // medio. El lote tiene que quedar exactamente como empezo y la merma en
    // cero: ni un gramo de mas ni de menos por haber pasado por ahi.
    expect(await saldo(s.loteId)).toBe(500);
    expect(await merma(H1)).toBe(0);
    expect(it2).toMatchObject({ sq: "0.000", disc: "0.000", rq: "200.000" });
  });

  it("C2: devolver todo y despues botar", async () => {
    const s = await servir(U1, H1, 500, 200, "C2");
    await h.como(U1, () =>
      h.fila("select public.return_serving_to_inventory($1,$2,$3)", [s.itemId, 200, "volvio todo"]),
    );
    const e = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.discard_serving($1,$2,null,null::uuid)", [s.itemId, 50]),
      ),
    );
    // Lo que volvio al refrigerador ya no esta en el plato para botarlo.
    expect(e).toMatch(/no calza/);
    expect(await saldo(s.loteId)).toBe(500);
    expect(await merma(H1)).toBe(0);
  });

  it("C3: botar todo, desbotar, corregir al alza, devolver de mas", async () => {
    const s = await servir(U1, H1, 500, 200, "C3");
    await h.como(U1, () =>
      h.fila("select public.discard_serving($1,$2,null,null::uuid)", [s.itemId, 200]),
    );
    console.log("C3 merma tras botar:", await merma(H1));
    await h.como(U1, () =>
      h.fila("select public.undo_discard_serving($1,$2,null,null::uuid)", [s.itemId, 200]),
    );
    console.log("C3 merma tras desbotar:", await merma(H1));
    const e = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.correct_serving_item($1,$2,$3,null::uuid)", [s.itemId, 400, "sirvio mas"]),
      ),
    );
    console.log("C3 al alza:", e, "saldo:", await saldo(s.loteId));
    const e2 = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.return_serving_to_inventory($1,$2,$3)", [s.itemId, 400, "todo de vuelta"]),
      ),
    );
    console.log("C3 devolver 400:", e2, "saldo:", await saldo(s.loteId));
    expect(await saldo(s.loteId)).toBeLessThanOrEqual(500);
  });
});

describe("ATAQUE: oraculos de existencia entre hogares", () => {
  it("D1: mensajes de recursos ajenos", async () => {
    const s = await servir(U1, H1, 500, 200, "D1");
    const msgs: Record<string, string | null> = {};
    msgs.discard = await intento(() =>
      h.como(U2, () =>
        h.fila("select public.discard_serving($1,$2,null,null::uuid)", [s.itemId, 999999]),
      ),
    );
    msgs.undo = await intento(() =>
      h.como(U2, () =>
        h.fila("select public.undo_discard_serving($1,$2,null,null::uuid)", [s.itemId, 999999]),
      ),
    );
    msgs.correct = await intento(() =>
      h.como(U2, () =>
        h.fila("select public.correct_serving_item($1,$2,$3,null::uuid)", [s.itemId, 1, "x"]),
      ),
    );
    msgs.ret = await intento(() =>
      h.como(U2, () =>
        h.fila("select public.return_serving_to_inventory($1,$2,$3)", [s.itemId, 999999, "x"]),
      ),
    );
    msgs.logint = await intento(() =>
      h.como(U2, () => h.fila("select public.log_intake($1)", [s.recordId])),
    );
    msgs.assume = await intento(() =>
      h.como(U2, () => h.fila("select public.assume_intake_from_plan($1)", [s.recordId])),
    );
    msgs.voidrec = await intento(() =>
      h.como(U2, () => h.fila("select public.void_serving_record($1,$2,null::uuid)", [s.recordId, "x"])),
    );
    const inex = "00000000-0000-0000-0000-0000000000aa";
    msgs.discardInex = await intento(() =>
      h.como(U2, () => h.fila("select public.discard_serving($1,$2,null,null::uuid)", [inex, 999999])),
    );
    msgs.logintInex = await intento(() =>
      h.como(U2, () => h.fila("select public.log_intake($1)", [inex])),
    );
    // EL ORACULO. Cada uno de estos mensajes se le contesta a un vecino que
    // apunta a recursos de OTRA casa. Si alguno hablara en gramos —"no se puede
    // devolver mas de lo que salio (999999 de 200)"— estaria regalando cuanto se
    // sirvio ahi sin necesidad de adivinar nada.
    //
    // Y el recurso INEXISTENTE tiene que contestar exactamente lo mismo que el
    // ajeno: si difirieran, la diferencia sola confirma que el ajeno existe.
    const respuestas = Object.entries(msgs);
    expect(respuestas.length).toBeGreaterThanOrEqual(7);
    for (const [donde, mensaje] of respuestas) {
      expect(`${donde}: ${mensaje}`).toBe(`${donde}: no autorizado`);
    }
  });

  it("D2: declarar consumo de un integrante de otro hogar", async () => {
    const e = await intento(() =>
      h.como(U2, () =>
        h.fila(
          "select public.log_intake_off_plan($1,$2::jsonb,null::date,null::public.meal_type,null,null)",
          [H1.memberId, JSON.stringify([{ label: "x", extent: "ALL" }])],
        ),
      ),
    );
    console.log("D2:", e);
    expect(e).toBe("no autorizado");
  });
});

describe("ATAQUE: anular el servido con historia colgando", () => {
  it("E1: anular servido tras anular la declaracion", async () => {
    const s = await servir(U1, H1, 500, 200, "E1");
    const log = (await h.como(U1, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [s.recordId]),
    ))!.log_intake;
    const e0 = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.void_serving_record($1,$2,null::uuid)", [s.recordId, "nunca paso"]),
      ),
    );
    console.log("E1 sin anular la declaracion:", e0);
    await h.como(U1, () => h.fila("select public.void_intake_log($1,$2)", [log, "mal anotado"]));
    const e1 = await intento(() =>
      h.como(U1, () =>
        h.fila("select public.void_serving_record($1,$2,null::uuid)", [s.recordId, "nunca paso"]),
      ),
    );
    console.log("E1 tras anular:", e1, "saldo:", await saldo(s.loteId));
    const huerfanos = await h.comoAdmin(() =>
      h.filas(
        "select i.id, i.quantity::text q, i.serving_record_item_id from public.intake_log_items i where i.log_id = $1",
        [log],
      ),
    );
    console.log("E1 renglones declarados que sobreviven:", huerfanos);
    expect(await saldo(s.loteId)).toBe(500);
  });
});
