import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 12 — A1 y A2: la clave de idempotencia del eje ACTUAL_CONSUMED.
 *
 * Las dos fallas son el MISMO mecanismo mal resuelto. `log_intake`,
 * `assume_intake_from_plan`, `app.create_unplanned_intake` y
 * `correct_intake_log` resolvian la idempotencia asi:
 *
 *     select id into v_log from public.consumption_logs where dedupe_key = v_key;
 *     if v_log is not null then return v_log; end if;
 *
 * Sin `household_id` (A1) y sin `status` (A2). Cada test de aca abajo ejecuta
 * ESA consulta literal —el ANTES— para dejar demostrado que encontraba lo que
 * no tenia que encontrar, y despues ejecuta el RPC para demostrar que hoy ya no
 * se comporta asi.
 *
 * Todo el archivo declara comida FUERA DE PLAN a proposito: ese camino no
 * necesita servido, ni receta, ni inventario, asi que lo unico que queda a la
 * vista es la clave. El camino con servido detras se prueba en
 * sprint12-regresiones.test.ts.
 */

const USER_A = "00000000-0000-0000-0000-0000000000f1";
const USER_B = "00000000-0000-0000-0000-0000000000f2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };

const TORTA = JSON.stringify([{ label: "Torta de la vecina", extent: "UNKNOWN" }]);
const PAN = JSON.stringify([{ label: "Pan con palta", extent: "UNKNOWN" }]);

/** `log_intake_off_plan`, que es el camino sin servido detras. */
async function declararFueraDePlan(
  user: string,
  memberId: string,
  items: string,
  comida: string,
  clave: string | null,
): Promise<string> {
  return (await h.como(user, () =>
    h.fila<{ log_intake_off_plan: string }>(
      `select public.log_intake_off_plan($1, $2::jsonb, null, $3::public.meal_type, null, $4)`,
      [memberId, items, comida, clave],
    ),
  ))!.log_intake_off_plan;
}

/** La clave tal como quedo GUARDADA, que ya no es la que mando el cliente. */
async function claveDe(logId: string): Promise<string> {
  return (await h.comoAdmin(() =>
    h.fila<{ dedupe_key: string }>(
      "select dedupe_key from public.consumption_logs where id = $1",
      [logId],
    ),
  ))!.dedupe_key;
}

/**
 * LA RESOLUCION VIEJA, literal: global y ciega al estado.
 *
 * Vive aca para que el ANTES sea ejecutable y no una afirmacion en un
 * comentario. Si manana alguien vuelve a escribirla adentro de un RPC, estos
 * tests siguen mostrando exactamente que encuentra.
 */
async function resolucionVieja(clave: string): Promise<string | null> {
  const fila = await h.comoAdmin(() =>
    h.fila<{ id: string }>("select id from public.consumption_logs where dedupe_key = $1", [clave]),
  );
  return fila?.id ?? null;
}

async function estadoDe(logId: string): Promise<string> {
  return (await h.comoAdmin(() =>
    h.fila<{ status: string }>(
      "select status::text as status from public.consumption_logs where id = $1",
      [logId],
    ),
  ))!.status;
}

beforeAll(async () => {
  // Sin seeds: nada de esto necesita catalogo ni recetas, y levantar la base es
  // lo caro de la suite.
  h = await levantarBase({ conSeeds: false });
  hogarA = await crearHogar(h, USER_A, "Hogar clave A", "Fran");
  hogarB = await crearHogar(h, USER_B, "Hogar clave B", "Vecino");
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("A1 — la clave de reintento no cruza hogares", () => {
  let logA = "";
  let claveGuardadaA = "";

  it("el hogar A declara algo con una clave que eligio su cliente", async () => {
    logA = await declararFueraDePlan(USER_A, hogarA.memberId, TORTA, "TEA", "clave-cruda-1");
    claveGuardadaA = await claveDe(logA);

    // La clave GUARDADA ya no es la cruda: el servidor le antepuso el hogar y
    // el ancla del acto, y del cliente solo sobrevive el sufijo.
    expect(claveGuardadaA).not.toBe("clave-cruda-1");
    expect(claveGuardadaA).toContain(hogarA.householdId);
    expect(claveGuardadaA.endsWith(":clave-cruda-1")).toBe(true);
  });

  it("ANTES: la resolucion vieja, con la clave del hogar A, devolvia el log del hogar A", async () => {
    // Esto es lo que corria dentro del RPC cuando lo llamaba el hogar B: una
    // busqueda global. El vecino recibia este uuid y su declaracion no se
    // escribia nunca.
    expect(await resolucionVieja(claveGuardadaA)).toBe(logA);
  });

  it("DESPUES: el hogar B manda la clave EXACTA del hogar A y su declaracion igual se escribe", async () => {
    const logB = await declararFueraDePlan(
      USER_B,
      hogarB.memberId,
      TORTA,
      "TEA",
      claveGuardadaA, // el ataque: la clave ajena, entera y literal
    );

    expect(logB).not.toBe(logA);

    const fila = await h.comoAdmin(() =>
      h.fila<{ household_id: string; status: string }>(
        `select household_id, status::text as status
         from public.consumption_logs where id = $1`,
        [logB],
      ),
    );
    expect(fila!.household_id).toBe(hogarB.householdId);
    expect(fila!.status).toBe("ACTIVE");

    // Y el eje ACTUAL del vecino NO quedo huerfano: tiene sus renglones.
    const renglones = await h.comoAdmin(() =>
      h.filas("select 1 from public.intake_log_items where log_id = $1", [logB]),
    );
    expect(renglones.length).toBeGreaterThan(0);
  });

  it("y el log del hogar A quedo intacto: nadie lo piso ni lo leyo por la clave", async () => {
    expect(await estadoDe(logA)).toBe("ACTIVE");
    const suyos = await h.comoAdmin(() =>
      h.filas("select 1 from public.consumption_logs where household_id = $1", [
        hogarA.householdId,
      ]),
    );
    expect(suyos).toHaveLength(1);
  });

  it("el hogar B no puede leer nada del hogar A ni con el id en la mano", async () => {
    const ajeno = await h.como(USER_B, () =>
      h.filas("select 1 from public.consumption_logs where id = $1", [logA]),
    );
    expect(ajeno).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("A1 — dentro de la misma casa, la clave tampoco tapa otro acto", () => {
  it("la misma clave cruda en dos comidas distintas escribe DOS declaraciones", async () => {
    // ANTES: la clave guardada era, literal, la que mando el cliente. La
    // segunda llamada encontraba la primera y devolvia "listo" sin escribir
    // nada: la once del mismo dia se perdia en silencio. Un hueco que el motor
    // adaptativo despues lee como un cero.
    const desayuno = await declararFueraDePlan(
      USER_A,
      hogarA.memberId,
      PAN,
      "BREAKFAST",
      "misma-clave",
    );
    const cena = await declararFueraDePlan(USER_A, hogarA.memberId, PAN, "DINNER", "misma-clave");

    expect(cena).not.toBe(desayuno);

    const kDesayuno = await claveDe(desayuno);
    const kCena = await claveDe(cena);
    // Mismo sufijo del cliente, ancla distinta: dos claves distintas.
    expect(kDesayuno).not.toBe(kCena);
    expect(kDesayuno.endsWith(":misma-clave")).toBe(true);
    expect(kCena.endsWith(":misma-clave")).toBe(true);
  });

  it("el discriminador del cliente se valida: ni larguisimo ni con caracteres de control", async () => {
    await expect(
      declararFueraDePlan(USER_A, hogarA.memberId, PAN, "SNACK", "x".repeat(121)),
    ).rejects.toThrow(/120 caracteres/i);
    await expect(
      declararFueraDePlan(USER_A, hogarA.memberId, PAN, "SNACK", "clave\u0001rara"),
    ).rejects.toThrow(/caracteres de control/i);
  });
});

// ---------------------------------------------------------------------------
describe("A2 — re-declarar despues de anular escribe de verdad", () => {
  let primero = "";
  let clave = "";
  let segundo = "";

  it("se declara, se anula, y la fila anulada conserva su clave", async () => {
    primero = await declararFueraDePlan(USER_A, hogarA.memberId, TORTA, "LUNCH", "clave-a2");
    await h.como(USER_A, () =>
      h.db.query("select public.void_intake_log($1, $2)", [primero, "la anote en la persona equivocada"]),
    );
    expect(await estadoDe(primero)).toBe("VOIDED");

    clave = await claveDe(primero);
    expect(clave).toBeTruthy();
  });

  it("ANTES: la resolucion vieja seguia encontrando la fila ANULADA", async () => {
    // Este es el corazon de A2: la funcion creia que ya habia escrito, devolvia
    // el id de una fila muerta y no escribia nada. El eje ACTUAL quedaba
    // huerfano justo en el camino que mas se usa — anular y corregir es lo que
    // hace la gente cuando se equivoca.
    expect(await resolucionVieja(clave)).toBe(primero);
  });

  it("DESPUES: la misma declaracion, con la misma clave, escribe una fila NUEVA", async () => {
    segundo = await declararFueraDePlan(USER_A, hogarA.memberId, TORTA, "LUNCH", "clave-a2");

    expect(segundo).not.toBe(primero);
    expect(await estadoDe(segundo)).toBe("ACTIVE");
    // La historia no se toca: la anulada sigue anulada y a la vista.
    expect(await estadoDe(primero)).toBe("VOIDED");

    // Misma clave, dos filas: el indice unico parcial sobre status='ACTIVE' es
    // el que deja que quepan las dos.
    expect(await claveDe(segundo)).toBe(clave);
    const conEsaClave = await h.comoAdmin(() =>
      h.filas("select 1 from public.consumption_logs where dedupe_key = $1", [clave]),
    );
    expect(conEsaClave).toHaveLength(2);
  });

  it("y la declaracion nueva tiene renglones: el eje ACTUAL no quedo vacio", async () => {
    const renglones = await h.comoAdmin(() =>
      h.filas("select 1 from public.intake_log_items where log_id = $1", [segundo]),
    );
    expect(renglones.length).toBeGreaterThan(0);
  });

  it("el outbox emitio los DOS eventos, no uno solo", async () => {
    // `domain_events.dedupe_key` es unico GLOBAL, asi que si el evento se
    // dedupicara por la clave de reintento —como hacia antes— la declaracion
    // nueva no emitiria nada y el `on conflict do nothing` se la tragaria en
    // silencio. Se dedupica por la FILA.
    const eventos = await h.comoAdmin(() =>
      h.filas(
        `select 1 from public.domain_events
         where event_type = 'INTAKE_LOGGED' and payload->>'log_id' in ($1, $2)`,
        [primero, segundo],
      ),
    );
    expect(eventos).toHaveLength(2);
  });

  it("no hay DOS declaraciones vivas con la misma clave: el indice lo impide", async () => {
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.consumption_logs
             (household_id, member_id, kind, affects_inventory, source, status,
              consumed_on, meal_type, dedupe_key)
           values ($1, $2, 'OFF_PLAN', false, 'DECLARED_SELF', 'ACTIVE',
                   current_date, 'LUNCH', $3)`,
          [hogarA.householdId, hogarA.memberId, clave],
        ),
      ),
    ).rejects.toThrow(/intake_logs_dedupe_active_uniq|duplicate key/i);
  });
});

// ---------------------------------------------------------------------------
describe("el reintento legitimo sigue siendo UNA sola declaracion", () => {
  it("doble clic: dos llamadas identicas, un solo registro", async () => {
    const uno = await declararFueraDePlan(USER_A, hogarA.memberId, PAN, "TEA", "doble-clic");
    const dos = await declararFueraDePlan(USER_A, hogarA.memberId, PAN, "TEA", "doble-clic");
    expect(dos).toBe(uno);

    const clave = await claveDe(uno);
    const filas = await h.comoAdmin(() =>
      h.filas("select 1 from public.consumption_logs where dedupe_key = $1", [clave]),
    );
    expect(filas).toHaveLength(1);
  });

  it("sin clave del cliente tambien: la red se corta y el reintento no duplica", async () => {
    // Sin discriminador, el ancla sola alcanza: misma persona, mismo dia, misma
    // comida y los mismos renglones son el mismo acto.
    const uno = await declararFueraDePlan(USER_A, hogarA.memberId, TORTA, "DESSERT", null);
    const dos = await declararFueraDePlan(USER_A, hogarA.memberId, TORTA, "DESSERT", null);
    expect(dos).toBe(uno);
  });
});

// ---------------------------------------------------------------------------
describe("corregir: la clave de correccion tampoco es del cliente", () => {
  let logA = "";
  let logB = "";
  const CORRECCION = "00000000-0000-0000-0000-00000000c077";

  const NUEVOS = JSON.stringify([
    {
      label: "Torta de la vecina",
      extent: "EXACT",
      quantity: 80,
      quantity_is_declared: true,
      unit: "G",
      weight_basis: "COOKED",
    },
  ]);

  it("el hogar A corrige con un id de correccion elegido por su cliente", async () => {
    logA = await declararFueraDePlan(USER_A, hogarA.memberId, TORTA, "SNACK", "corr-base");
    const nueva = (await h.como(USER_A, () =>
      h.fila<{ correct_intake_log: string }>(
        "select public.correct_intake_log($1, $2::jsonb, $3, $4)",
        [logA, NUEVOS, "en realidad comio menos", CORRECCION],
      ),
    ))!.correct_intake_log;

    expect(await estadoDe(logA)).toBe("CORRECTED");
    expect(await estadoDe(nueva)).toBe("ACTIVE");
    // La clave de la correccion lleva el hogar y el log corregido adentro.
    const k = await claveDe(nueva);
    expect(k).toContain(hogarA.householdId);
    expect(k).toContain(logA);
  });

  it("ANTES: la clave era 'INTAKE-CORR:' + el uuid del cliente, sin hogar adentro", async () => {
    const claveVieja = `INTAKE-CORR:${CORRECCION}`;
    // Esa forma es IDENTICA para cualquier hogar que mande el mismo uuid: no
    // lleva NADA del hogar adentro. Por eso el hogar B, con el mismo
    // p_correction_id, caia sobre la correccion del hogar A — recibia su uuid y
    // su propia correccion no se escribia nunca.
    expect(claveVieja).not.toContain(hogarA.householdId);
    // Y hoy esa clave no existe en ninguna parte: la que se guardo lleva el
    // hogar y el log corregido adentro.
    expect(await resolucionVieja(claveVieja)).toBeNull();
  });

  it("DESPUES: el hogar B usa el MISMO id de correccion y su correccion se escribe igual", async () => {
    logB = await declararFueraDePlan(USER_B, hogarB.memberId, TORTA, "SNACK", "corr-base");
    const nueva = (await h.como(USER_B, () =>
      h.fila<{ correct_intake_log: string }>(
        "select public.correct_intake_log($1, $2::jsonb, $3, $4)",
        [logB, NUEVOS, "en realidad comio menos", CORRECCION],
      ),
    ))!.correct_intake_log;

    expect(await estadoDe(logB)).toBe("CORRECTED");
    expect(await estadoDe(nueva)).toBe("ACTIVE");
    const fila = await h.comoAdmin(() =>
      h.fila<{ household_id: string }>(
        "select household_id from public.consumption_logs where id = $1",
        [nueva],
      ),
    );
    expect(fila!.household_id).toBe(hogarB.householdId);
  });

  it("reintentar la MISMA correccion devuelve la misma, no revienta", async () => {
    // La fila vieja ya quedo en CORRECTED: si la idempotencia se preguntara
    // despues del chequeo de estado, el segundo clic contestaria "ya fue
    // superada" en vez de devolver lo que la persona acaba de hacer.
    const otra = (await h.como(USER_A, () =>
      h.fila<{ correct_intake_log: string }>(
        "select public.correct_intake_log($1, $2::jsonb, $3, $4)",
        [logA, NUEVOS, "en realidad comio menos", CORRECCION],
      ),
    ))!.correct_intake_log;

    const versiones = await h.comoAdmin(() =>
      h.filas("select 1 from public.consumption_logs where supersedes_log_id = $1", [logA]),
    );
    expect(versiones).toHaveLength(1);
    expect(await estadoDe(otra)).toBe("ACTIVE");
  });
});
