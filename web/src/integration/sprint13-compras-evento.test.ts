import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 13 — la demanda del evento DENTRO de la lista de compras de siempre.
 *
 * Cuatro cosas que sólo se pueden probar contra un PostgreSQL de verdad, porque
 * las tres primeras las decide un índice o un trigger y no el código de la app:
 *
 *  [A] La lista aparte del evento comparte `plan_id` con la semanal. La consulta
 *      que /shopping usa para leer "la lista de la semana" tiene que traer UNA
 *      fila, no dos: sin el filtro `event_id is null`, `maybeSingle` revienta la
 *      pantalla de compras el día que alguien abra una lista delta.
 *  [B] Dos personas apretando "mandar a la compra" no crean dos demandas, y
 *      QUIÉN lo impide depende de la línea: con alimento catalogado manda
 *      `shopping_items_suggestion_uniq` (0021) y la line_key ni siquiera hace
 *      falta; sin alimento —las líneas `prod:` e `item:` de `identidadDe`, con
 *      `ingredient_id` en NULL— esa clave se apaga sola y el único guardia es
 *      `shopping_items_line_uniq` (0009). Los dos caminos se prueban por
 *      separado y cada uno nombra al índice que lo rechaza; decir "el índice
 *      único es el árbitro" sin nombrarlo dejaba el segundo camino sin cubrir.
 *  [C] Cancelar el evento saca su demanda de la vista del ProcurementEngine.
 *      La prueba NO es que la fila cambie de estado —eso ya lo mira otro test—
 *      sino que la consulta que el motor de abastecimiento usa para netear deje
 *      de verla: mientras la viera, seguiría pidiéndole 9 kg de vacuno al
 *      proveedor para un asado muerto.
 *  [D] Lo YA COMPRADO sobrevive a la cancelación. Esa carne está en la casa.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: igual que sprint13-eventos.test.ts, la
 * lista `MIGRACIONES` del arnés la comparten varios agentes en el mismo árbol y
 * todavía no llega a la 0041.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const PENDIENTES = [
  "supabase/migrations/0039_permisos_plan_y_cocina.sql",
  "supabase/migrations/0040_adaptive_reviews.sql",
  "supabase/migrations/0041_eventos_avanzados.sql",
];

const USER = "00000000-0000-0000-0000-0000000413c1";
const SEMANA = weekStart("2026-09-07");
const SABADO = "2026-09-12";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let planId: string;
let ingrediente: string;
let otroIngrediente: string;

/** Estados de orden vivos: lo que el ProcurementEngine considera "en camino". */
async function asegurar(testigoSql: string, archivo: string): Promise<void> {
  const ya = await h.comoAdmin(() => h.fila(testigoSql));
  if (ya) return;
  await h.comoAdmin(() => h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8")));
}

beforeAll(async () => {
  h = await levantarBase();
  await asegurar(
    "select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'can_edit_plan'",
    PENDIENTES[0]!,
  );
  // El testigo de la 0040 nombraba `intake_snapshots`, una tabla que no crea
  // NINGUNA migración del repo: la comprobación daba siempre "todavía no está"
  // y la 0040 se aplicaba encima de sí misma. Mientras el arnés se quedaba en la
  // 0038 eso no se notaba; el día que la lista del arnés llegó a la 0041, los
  // siete casos de este archivo se saltaron enteros con `type
  // "adaptive_rolling_window" already exists`. Un testigo que nunca encuentra
  // nada no es un testigo. Ahora nombra la tabla estrella de la 0040.
  await asegurar(
    "select 1 where to_regclass('public.adaptive_nutrition_reviews') is not null",
    PENDIENTES[1]!,
  );
  await asegurar(
    "select 1 where to_regclass('public.event_participants') is not null",
    PENDIENTES[2]!,
  );

  hogar = await crearHogar(h, USER, "Hogar del asado", "Fran");

  planId = await h.como(USER, async () => {
    const r = await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2::date)",
      [hogar.householdId, SEMANA],
    );
    return r!.ensure_weekly_plan;
  });

  const ings = await h.comoAdmin(() =>
    h.filas<{ id: string }>("select id from public.ingredients order by id limit 2"),
  );
  ingrediente = ings[0]!.id;
  otroIngrediente = ings[1]!.id;
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

// Cada caso arma sus propias listas: la semanal es única por plan, así que si
// una quedara viva el caso siguiente moriría con un error de índice único que
// no tiene nada que ver con lo que estaba probando.
afterEach(async () => {
  await h.comoAdmin(() =>
    h.db.query("delete from public.shopping_lists where plan_id = $1", [planId]),
  );
});

/** La lista semanal del plan (la del súper). */
async function crearSemanal(): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      "insert into public.shopping_lists (household_id, plan_id) values ($1, $2) returning id",
      [hogar.householdId, planId],
    ),
  );
  return r!.id;
}

async function crearEvento(estado = "CONFIRMED"): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.nutrition_events
         (household_id, event_date, event_type, meal_type, title, status)
       values ($1, $2::date, 'BARBECUE', 'LUNCH', 'Asado del sábado', $3::public.event_status)
       returning id`,
      [hogar.householdId, SABADO, estado],
    ),
  );
  return r!.id;
}

async function lineaDeEvento(
  listaId: string,
  eventoId: string,
  clave: string,
  cantidad: number,
  estado = "PENDING",
  ing: string = ingrediente,
): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.shopping_list_items
         (list_id, source, event_id, line_key, ingredient_id, label, unit,
          required_quantity, purchase_basis, status, purchased_at)
       values ($1, 'EVENT', $2, $3, $4, 'Sobrecostilla', 'G', $5, 'RAW',
               $6::public.shopping_item_status,
               case when $6 = 'PURCHASED' then now() else null end)
       returning id`,
      [listaId, eventoId, clave, ing, cantidad, estado],
    ),
  );
  return r!.id;
}

/**
 * Una línea de evento SIN alimento catalogado: `ingredient_id` y `product_id`
 * en NULL, que es lo que `identidadDe` produce cuando el corte sólo tiene
 * identidad de item (`item:{id}`). En este camino la clave de sugerencia de la
 * 0021 no aplica —su predicado exige `ingredient_id is not null`— y el único
 * guardia que queda es `shopping_items_line_uniq`.
 */
async function lineaSinAlimento(
  listaId: string,
  eventoId: string,
  clave: string,
  cantidad: number,
): Promise<string> {
  const r = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      `insert into public.shopping_list_items
         (list_id, source, event_id, line_key, ingredient_id, product_id, label, unit,
          required_quantity, purchase_basis, status)
       values ($1, 'EVENT', $2, $3, null, null, 'Corte sin catálogo', 'G', $4, 'RAW', 'PENDING')
       returning id`,
      [listaId, eventoId, clave, cantidad],
    ),
  );
  return r!.id;
}

/**
 * Una escritura que puede rebotar. Se guarda el MENSAJE, no sólo el booleano:
 * "rebotó" sin decir quién la rebotó es exactamente lo que dejaba pasar un test
 * que afirmaba de un índice el trabajo de otro.
 */
async function intentarLinea(
  escribir: () => Promise<string>,
): Promise<{ rechazada: boolean; mensaje: string }> {
  try {
    await escribir();
    return { rechazada: false, mensaje: "" };
  } catch (e) {
    return { rechazada: true, mensaje: (e as Error).message };
  }
}

/**
 * La misma consulta que `loadPendingListItems` (web/src/app/procurement/
 * queries.ts): lo que el ProcurementEngine netea antes de pedirle al proveedor.
 * Lee TODAS las líneas pendientes sin mirar procedencia — por eso una línea de
 * un evento muerto que se quede en PENDING lo sigue afectando.
 */
async function loQueVeElProveedor(): Promise<{ label: string; cantidad: number }[]> {
  // `numeric` llega como texto por el protocolo; se convierte acá y no con un
  // `?? 0` más abajo, que taparía un null de verdad.
  const filas = await h.como(USER, () =>
    h.filas<{ label: string; cantidad: string | null }>(
      `select i.label, coalesce(i.planned_quantity, i.required_quantity) as cantidad
         from public.shopping_list_items i
         join public.shopping_lists l on l.id = i.list_id
        where i.status = 'PENDING'
          and l.household_id = $1
          and l.status in ('DRAFT', 'ACTIVE')`,
      [hogar.householdId],
    ),
  );
  return filas.map((f) => ({
    label: f.label,
    cantidad: f.cantidad === null ? Number.NaN : Number(f.cantidad),
  }));
}

describe("[A] la lista aparte del evento no rompe la lectura de la semanal", () => {
  it("con las dos listas abiertas, la de la semana sigue siendo UNA", async () => {
    const semanal = await crearSemanal();
    const evento = await crearEvento();
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.shopping_lists (household_id, plan_id, event_id, status)
         values ($1, $2, $3, 'ACTIVE')`,
        [hogar.householdId, planId, evento],
      ),
    );

    // Sin el filtro habría DOS: es exactamente el caso que hacía reventar
    // `maybeSingle` en loadShoppingList.
    const todas = await h.como(USER, () =>
      h.filas("select id from public.shopping_lists where plan_id = $1", [planId]),
    );
    expect(todas).toHaveLength(2);

    const deLaSemana = await h.como(USER, () =>
      h.filas<{ id: string }>(
        "select id from public.shopping_lists where plan_id = $1 and event_id is null",
        [planId],
      ),
    );
    expect(deLaSemana).toHaveLength(1);
    expect(deLaSemana[0]!.id).toBe(semanal);

  });
});

describe("[B] dos clics en «mandar a la compra» no compran el doble", () => {
  it("en una línea con alimento el árbitro es la clave de sugerencia, NO line_key", async () => {
    // Este caso decía probar `(list_id, line_key)` y no lo probaba: quien
    // rechaza acá es `shopping_items_suggestion_uniq` (0021), que mira
    // list_id + ingredient_id + unit + purchase_basis. Se comprobaba cambiando
    // la line_key del segundo insert: seguía rechazando y el test seguía verde,
    // o sea afirmaba de un índice lo que hacía otro. Acá se nombra al que actúa.
    const lista = await crearSemanal();
    const evento = await crearEvento();
    const clave = `event:${evento}::ing:${ingrediente}::G::RAW`;
    await lineaDeEvento(lista, evento, clave, 9000);

    const mismaClave = await intentarLinea(() => lineaDeEvento(lista, evento, clave, 9000));
    expect(mismaClave.rechazada).toBe(true);

    // Y la prueba de quién manda: con OTRA line_key —el índice que el caso
    // decía probar ya no puede aplicar— la escritura igual se rechaza.
    const otraClave = await intentarLinea(() =>
      lineaDeEvento(lista, evento, `${clave}::OTRA`, 9000),
    );
    expect(otraClave.rechazada).toBe(true);
    expect(otraClave.mensaje).toContain("shopping_items_suggestion_uniq");

    const filas = await h.como(USER, () =>
      h.filas("select id from public.shopping_list_items where event_id = $1", [evento]),
    );
    expect(filas).toHaveLength(1);
  });

  it("en una línea SIN alimento (identidad `item:`) el único guardia es line_key", async () => {
    // El camino que no tocaba ningún test y donde vive el riesgo real:
    // `identidadDe` emite `prod:` e `item:` cuando el corte no tiene alimento
    // catalogado, y ahí `ingredient_id` va NULL. La clave de sugerencia se
    // apaga sola (su predicado exige `ingredient_id is not null`), así que el
    // doble clic lo tiene que atajar `shopping_items_line_uniq` o nada.
    const lista = await crearSemanal();
    const evento = await crearEvento();
    const clave = `event:${evento}::item:corte-sin-catalogo::G::RAW`;

    await lineaSinAlimento(lista, evento, clave, 9000);
    const repetida = await intentarLinea(() => lineaSinAlimento(lista, evento, clave, 9000));

    expect(repetida.rechazada).toBe(true);
    expect(repetida.mensaje).toContain("shopping_items_line_uniq");

    const filas = await h.como(USER, () =>
      h.filas("select id from public.shopping_list_items where event_id = $1", [evento]),
    );
    expect(filas).toHaveLength(1);
  });

  it("y sin alimento, dos claves distintas SÍ entran: es el estado real, escrito", async () => {
    // No es un descuido del test: es lo que la base permite hoy. Dos cortes sin
    // alimento catalogado son dos líneas distintas y nadie las funde. Queda
    // afirmado para que el día que se agregue un guardia por producto este
    // caso se caiga y alguien lo lea, en vez de descubrirse comprando doble.
    const lista = await crearSemanal();
    const evento = await crearEvento();

    await lineaSinAlimento(lista, evento, `event:${evento}::item:uno::G::RAW`, 9000);
    await lineaSinAlimento(lista, evento, `event:${evento}::item:dos::G::RAW`, 9000);

    const filas = await h.como(USER, () =>
      h.filas("select id from public.shopping_list_items where event_id = $1", [evento]),
    );
    expect(filas).toHaveLength(2);
  });
});

describe("[C] el evento cancelado deja de pedirle carne al proveedor", () => {
  it("la línea del asado muerto desaparece de lo que el proveedor netea", async () => {
    const lista = await crearSemanal();
    const evento = await crearEvento();
    await lineaDeEvento(lista, evento, `event:${evento}::ing:${ingrediente}::G::RAW`, 9000);

    const antes = await loQueVeElProveedor();
    expect(antes.map((f) => f.cantidad)).toContain(9000);

    await h.comoAdmin(() =>
      h.db.query(
        "update public.nutrition_events set status = 'CANCELLED' where id = $1",
        [evento],
      ),
    );

    const despues = await loQueVeElProveedor();
    // Si el retiro se revirtiera, esta línea seguiría acá y el hogar
    // seguiría comprando 9 kg de vacuno para un asado que no se hace.
    expect(despues.map((f) => f.cantidad)).not.toContain(9000);

    const fila = await h.como(USER, () =>
      h.fila<{ status: string; status_reason: string | null }>(
        "select status, status_reason from public.shopping_list_items where event_id = $1",
        [evento],
      ),
    );
    // Retirada, NO borrada: la lista es historia y una línea que desaparece sin
    // rastro es peor que una línea de más.
    expect(fila!.status).toBe("SKIPPED");
    expect(fila!.status_reason).toBe("Evento cancelado");

  });
});

describe("[D] lo que ya se compró sobrevive a la cancelación", () => {
  it("la línea comprada queda intacta y la pendiente se retira", async () => {
    const lista = await crearSemanal();
    const evento = await crearEvento();
    const comprada = await lineaDeEvento(
      lista,
      evento,
      `event:${evento}::ing:${ingrediente}::G::RAW`,
      8000,
      "PURCHASED",
    );
    const pendiente = await lineaDeEvento(
      lista,
      evento,
      `event:${evento}::ing:otro::G::RAW`,
      2000,
      "PENDING",
      otroIngrediente,
    );

    await h.comoAdmin(() =>
      h.db.query("update public.nutrition_events set status = 'CANCELLED' where id = $1", [evento]),
    );

    const filas = await h.como(USER, () =>
      h.filas<{ id: string; status: string; required_quantity: string }>(
        "select id, status, required_quantity from public.shopping_list_items where event_id = $1 order by required_quantity desc",
        [evento],
      ),
    );
    expect(filas).toHaveLength(2);
    const laComprada = filas.find((f) => f.id === comprada)!;
    const laPendiente = filas.find((f) => f.id === pendiente)!;
    expect(laComprada.status).toBe("PURCHASED");
    expect(Number(laComprada.required_quantity)).toBe(8000);
    expect(laPendiente.status).toBe("SKIPPED");
  });
});

describe("[E] la lista sólo admite UNA línea por alimento fuera del plan", () => {
  it("una segunda línea del mismo alimento la rechaza shopping_items_suggestion_uniq", async () => {
    // Este índice viene de la 0013/0021 y su predicado es "source not in
    // (FOOD_PLAN, MANUAL)", así que las líneas de evento también caen adentro.
    // Que exista NO es un accidente que la app pueda ignorar: si la despensa ya
    // sugirió ese mismo corte, la línea del asado no cabe, y taparlo dejaría la
    // carne fuera de la compra sin que nadie se entere. Por eso la acción del
    // evento avisa en vez de seguir de largo.
    const lista = await crearSemanal();
    const eventoA = await crearEvento();
    const eventoB = await crearEvento();
    await lineaDeEvento(lista, eventoA, `event:${eventoA}::ing:${ingrediente}::G::RAW`, 9000);

    let rechazada = false;
    try {
      await lineaDeEvento(lista, eventoB, `event:${eventoB}::ing:${ingrediente}::G::RAW`, 4000);
    } catch {
      rechazada = true;
    }
    expect(rechazada).toBe(true);

    // Con OTRO alimento sí entra: el choque es por alimento, no por evento.
    await lineaDeEvento(
      lista,
      eventoB,
      `event:${eventoB}::ing:${otroIngrediente}::G::RAW`,
      4000,
      "PENDING",
      otroIngrediente,
    );
    const filas = await h.como(USER, () =>
      h.filas("select id from public.shopping_list_items where list_id = $1", [lista]),
    );
    expect(filas).toHaveLength(2);
  });
});
