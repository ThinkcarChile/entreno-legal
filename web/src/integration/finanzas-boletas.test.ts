import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 14 — la frontera de extracción de boletas (0045), contra un Postgres
 * de verdad.
 *
 * LO QUE ESTE ARCHIVO EXISTE PARA DEMOSTRAR, y que cada test rompe si el arreglo
 * se revierte:
 *
 *   · el OCR no toca NADA hasta que un humano confirma — ni un lote, ni un
 *     movimiento, ni una compra, ni una asignación de costo;
 *   · subir dos veces la misma boleta no duplica compras ni lotes;
 *   · un dígito mal leído (1.990 contra 17.990, 1 kg contra 10 kg) NO se
 *     confirma solo: la aritmética de la línea lo detiene;
 *   · confirmar es TODO O NADA y una boleta genera UNA compra en toda su vida.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: `harness.ts` lo comparten varios
 * agentes del mismo sprint y su lista `MIGRACIONES` llega a la 0038. Mismo
 * patrón que `finanzas-compras.test.ts` y `sprint13-eventos.test.ts`.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const ANDAMIO = path.join(__dirname, "andamio-finanzas.sql");
const USER_ANA = "00000000-0000-0000-0000-0000000045a1";
const USER_BETO = "00000000-0000-0000-0000-0000000045a2";

// sha256 de fantasía: lo que importa es que sean 64 hex distintos entre sí.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const HASH_0 = "0".repeat(64);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

let h: Harness;
let hogar: { householdId: string; memberId: string };
let betoMemberId: string;
let pollo: string;
let arroz: string;

interface Intento {
  rechazado: boolean;
  mensaje: string | null;
}

async function intentar<T>(fn: () => Promise<T>): Promise<Intento> {
  try {
    await fn();
    return { rechazado: false, mensaje: null };
  } catch (e) {
    return { rechazado: true, mensaje: (e as Error).message };
  }
}

/** Sube una boleta como Ana y devuelve su id. */
async function subir(hash: string, intent = "NEW_PURCHASE"): Promise<string> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{ upload_purchase_receipt: { receiptId: string; duplicated: boolean } }>(
      `select public.upload_purchase_receipt($1, $2, 'text/plain', 4096, $3, $4::public.receipt_intent)`,
      [
        hogar.householdId,
        `household/${hogar.householdId}/${hash}.txt`,
        hash,
        intent,
      ],
    ),
  );
  return r!.upload_purchase_receipt.receiptId;
}

async function consentir(receipt: string): Promise<void> {
  await h.como(USER_ANA, () =>
    h.db.query("select public.set_receipt_ai_consent($1, true, 'AMBOS')", [receipt]),
  );
}

interface LineaBoleta {
  raw_line_text: string;
  quantity?: number;
  unit?: string;
  unit_price_minor?: number;
  unit_price_basis?: string;
  line_total_minor?: number | null;
  discount_minor?: number;
  barcode?: string;
  matched_ingredient_id?: string;
  match_method?: string;
  match_score?: number;
  field_confidences?: Record<string, number>;
}

async function extraer(
  receipt: string,
  lineas: LineaBoleta[],
  header: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{ submit_receipt_extraction: Record<string, unknown> }>(
      "select public.submit_receipt_extraction($1, 'receipt-parser/1.0.0', $2::jsonb, $3::jsonb)",
      [receipt, JSON.stringify(header), JSON.stringify(lineas)],
    ),
  );
  return r!.submit_receipt_extraction;
}

async function candidatos(
  receipt: string,
): Promise<Array<{ id: string; line_ordinal: number; doubt_reasons: string[]; status: string; match_method: string }>> {
  return h.comoAdmin(() =>
    h.filas(
      `select id, line_ordinal, doubt_reasons, status, match_method
       from public.receipt_extraction_candidates
       where receipt_id = $1 order by extraction_pass desc, line_ordinal asc`,
      [receipt],
    ),
  );
}

async function contar(tabla: string, donde = "true", params: unknown[] = []): Promise<number> {
  const r = await h.comoAdmin(() =>
    h.fila<{ n: string }>(`select count(*)::text as n from public.${tabla} where ${donde}`, params),
  );
  return Number(r!.n);
}

/** Una línea limpia: pollo pesado que cuadra al peso. */
function polloOk(): LineaBoleta {
  return {
    raw_line_text: "POLLO ENTERO",
    quantity: 1000,
    unit: "G",
    unit_price_minor: 4990,
    unit_price_basis: "PER_KG",
    line_total_minor: 4990,
    matched_ingredient_id: pollo,
    match_method: "EXACT_NAME",
    match_score: 0.99,
    field_confidences: { quantity: 1, unit_price: 1, line_total: 1 },
  };
}

function arrozOk(): LineaBoleta {
  return {
    raw_line_text: "ARROZ GRANO LARGO 1KG",
    quantity: 1,
    unit: "UNIT",
    unit_price_minor: 1990,
    unit_price_basis: "PER_UNIT",
    line_total_minor: 1990,
    matched_ingredient_id: arroz,
    match_method: "EXACT_NAME",
    match_score: 0.99,
    field_confidences: { quantity: 1, unit_price: 1, line_total: 1 },
  };
}

beforeAll(async () => {
  h = await levantarBase();

  await h.comoAdmin(async () => {
    const testigos: Array<[string, string]> = [
      ["supabase/migrations/0042_finance_foundations.sql", "to_regclass('public.currency_units')"],
      ["supabase/migrations/0043_purchases_core.sql", "to_regclass('public.purchase_item_lots')"],
      ["supabase/migrations/0044_cost_allocations.sql", "to_regclass('public.cost_allocations')"],
      ["supabase/migrations/0045_receipts_pipeline.sql", "to_regclass('public.purchase_receipts')"],
      // La 0046 no es decorado acá: confirmar una boleta EMITE sus observaciones
      // de precio, y el cuerpo de ese productor vive en la 0046. Sin ella,
      // confirmar falla diciéndolo — que es exactamente lo que se quiere.
      ["supabase/migrations/0046_price_observations.sql", "to_regclass('public.price_observations')"],
    ];
    for (const [archivo, testigo] of testigos) {
      const ya = await h.fila<{ t: string | null }>(`select ${testigo} as t`);
      if (ya!.t !== null) continue;
      if (archivo.includes("0043")) {
        const helper = await h.fila<{ t: boolean }>(
          `select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'app' and p.proname = 'finance_access') as t`,
        );
        if (!helper!.t) await h.db.exec(readFileSync(ANDAMIO, "utf8"));
      }
      await h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8"));
    }
  });

  hogar = await crearHogar(h, USER_ANA, "Hogar Boletas", "Ana");

  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_BETO,
      "beto45@test.dev",
    ]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, 'Beto', '2009-01-01') returning id`,
      [hogar.householdId, USER_BETO],
    );
    betoMemberId = m!.id;
    // Beto es el adolescente del ejemplo del diseño: puede sacarle la foto a la
    // boleta y nada más.
    await h.db.query(
      `insert into public.household_finance_grants (household_id, member_id, permission, granted_by)
       values ($1, $2, 'FINANCE_UPLOAD_RECEIPTS', $3)`,
      [hogar.householdId, betoMemberId, hogar.memberId],
    );

    const ingredientes = await h.filas<{ id: string }>(
      "select id from public.ingredients order by display_name limit 2",
    );
    pollo = ingredientes[0]!.id;
    arroz = ingredientes[1]!.id;
  });

  await h.como(USER_ANA, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);
  });
});

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------

describe("el OCR no toca nada hasta que un humano confirma", () => {
  it("extraer deja candidatos y CERO stock, CERO compras y CERO plata", async () => {
    const boleta = await subir(HASH_A);
    await consentir(boleta);

    const movsAntes = await contar("inventory_movements");
    const comprasAntes = await contar("purchases");
    const asignacionesAntes = await contar("cost_allocations");

    const r = await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Supermercado Los Aromos",
      receipt_date: "2026-08-20",
      receipt_number: "A-1",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });

    expect(r.candidates).toBe(2);
    expect(await contar("receipt_extraction_candidates", "receipt_id = $1", [boleta])).toBe(2);
    // Lo único que se movió fue la tabla de candidatos.
    expect(await contar("inventory_movements")).toBe(movsAntes);
    expect(await contar("purchases")).toBe(comprasAntes);
    expect(await contar("cost_allocations")).toBe(asignacionesAntes);
    expect(await contar("inventory_lots")).toBe(0);
  });

  it("sin consentimiento la extracción rebota: la frontera es del servidor", async () => {
    const boleta = await subir(HASH_B);
    const intento = await intentar(() => extraer(boleta, [polloOk()]));
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("consentimiento");
    expect(await contar("receipt_extraction_candidates", "receipt_id = $1", [boleta])).toBe(0);
  });

  it("[H49] el que solo puede SUBIR no puede autorizar el envío a un modelo externo", async () => {
    const boleta = await subir(HASH_C);
    // Beto sí puede subir…
    const subida = await intentar(() =>
      h.como(USER_BETO, () =>
        h.db.query(
          `select public.upload_purchase_receipt($1, $2, 'text/plain', 100, $3, 'NEW_PURCHASE')`,
          [hogar.householdId, `household/${hogar.householdId}/${HASH_D}.txt`, HASH_D],
        ),
      ),
    );
    expect(subida.rechazado).toBe(false);

    // …y NO puede mandar el RUT, la dirección y el patrón de consumo del hogar
    // a un modelo externo: eso es dato de terceros que no consintieron.
    const consentimiento = await intentar(() =>
      h.como(USER_BETO, () =>
        h.db.query("select public.set_receipt_ai_consent($1, true, 'AMBOS')", [boleta]),
      ),
    );
    expect(consentimiento.rechazado).toBe(true);
    expect(consentimiento.mensaje).toContain("no autorizado");
  });
});

describe("subir dos veces la misma boleta no duplica nada", () => {
  it("[H35] el mismo archivo devuelve la boleta que ya existe, sin crear otra fila", async () => {
    const antes = await contar("purchase_receipts", "content_sha256 = $1", [HASH_E]);
    const primera = await subir(HASH_E);
    const segunda = await h.como(USER_ANA, () =>
      h.fila<{ upload_purchase_receipt: { receiptId: string; duplicated: boolean } }>(
        `select public.upload_purchase_receipt($1, $2, 'text/plain', 4096, $3, 'NEW_PURCHASE')`,
        [hogar.householdId, `household/${hogar.householdId}/${HASH_E}.txt`, HASH_E],
      ),
    );

    expect(segunda!.upload_purchase_receipt.receiptId).toBe(primera);
    expect(segunda!.upload_purchase_receipt.duplicated).toBe(true);
    expect(await contar("purchase_receipts", "content_sha256 = $1", [HASH_E])).toBe(antes + 1);
  });

  it("una boleta sin sha256 no entra: sin él la re-subida crea dos compras", async () => {
    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query(
          `select public.upload_purchase_receipt($1, 'household/x/y.txt', 'text/plain', 10, 'no-es-un-hash', 'NEW_PURCHASE')`,
          [hogar.householdId],
        ),
      ),
    );
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("sha256");
  });
});

describe("un dígito mal leído no se confirma solo", () => {
  it("[H38] «10 kg» donde decía «1 kg» deja la línea dudosa por aritmética", async () => {
    const boleta = await subir(HASH_F);
    await consentir(boleta);
    await extraer(
      boleta,
      [
        {
          ...polloOk(),
          quantity: 10000, // 10 kg leídos donde el papel decía 1 kg
          line_total_minor: 4990,
        },
      ],
      { merchant_name: "Los Aromos", receipt_date: "2026-08-21", declared_total_minor: 4990, total_source: "PRINTED" },
    );

    const filas = await candidatos(boleta);
    expect(filas[0]!.doubt_reasons).toContain("ARITMETICA_NO_CUADRA");

    // Y el documento entero queda por revisar, no "extraído y listo".
    const doc = await h.comoAdmin(() =>
      h.fila<{ processing_status: string }>(
        "select processing_status from public.purchase_receipts where id = $1",
        [boleta],
      ),
    );
    expect(doc!.processing_status).toBe("NEEDS_REVIEW");
  });

  it("[H44] un código de barras con un dígito cambiado NO matchea con confianza máxima", async () => {
    const boleta = await subir(HASH_0);
    await consentir(boleta);
    await extraer(boleta, [
      { ...arrozOk(), barcode: "7801234567895", match_method: "BARCODE", match_score: 1 },
    ]);

    const filas = await candidatos(boleta);
    // La vía de match se degradó en el servidor, no solo en el cliente.
    expect(filas[0]!.match_method).toBe("FUZZY_NAME");
    expect(filas[0]!.doubt_reasons).toContain("BARRAS_INVALIDO");
  });

  it("[H40] baja confianza en el MONTO ensucia la línea aunque el producto matchee perfecto", async () => {
    const boleta = await subir(HASH_1);
    await consentir(boleta);
    await extraer(boleta, [
      {
        ...arrozOk(),
        // Boleta térmica borrosa: la descripción se lee bien y el monto no.
        field_confidences: { quantity: 1, unit_price: 1, line_total: 0.4 },
      },
    ]);
    const filas = await candidatos(boleta);
    expect(filas[0]!.doubt_reasons).toContain("LECTURA_DUDOSA:line_total");
  });

  it("[H45] una línea dudosa NO se puede confirmar en bloque, y no deja ni un movimiento", async () => {
    const boleta = await subir(HASH_2);
    await consentir(boleta);
    await extraer(
      boleta,
      [{ ...polloOk(), quantity: 10000 }],
      { merchant_name: "Los Aromos", receipt_date: "2026-08-22", declared_total_minor: 4990, total_source: "PRINTED" },
    );
    const filas = await candidatos(boleta);
    const movsAntes = await contar("inventory_movements");

    const sinMirar = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query(
          "select public.confirm_receipt_extraction($1, $2::jsonb, 4990)",
          [boleta, JSON.stringify([{ candidate_id: filas[0]!.id, action: "CONFIRM" }])],
        ),
      ),
    );
    expect(sinMirar.rechazado).toBe(true);
    expect(sinMirar.mensaje).toContain("LINEA_SIN_MIRAR");
    expect(await contar("inventory_movements")).toBe(movsAntes);
  });
});

describe("confirmar: la boleta se vuelve compra, lotes y plata — una sola vez", () => {
  let boleta: string;
  let compra: string;

  it("crea la compra, sus líneas y sus lotes con el valor adentro", async () => {
    boleta = await subir(HASH_3);
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Supermercado Los Aromos",
      receipt_date: "2026-08-15",
      receipt_number: "B-77",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });

    const filas = await candidatos(boleta);
    expect(filas.every((f) => f.doubt_reasons.length === 0)).toBe(true);

    const r = await h.como(USER_ANA, () =>
      h.fila<{ confirm_receipt_extraction: { confirmed: number; purchaseId: string; lots: number } }>(
        "select public.confirm_receipt_extraction($1, $2::jsonb, 6980)",
        [
          boleta,
          JSON.stringify(filas.map((f) => ({ candidate_id: f.id, action: "CONFIRM" }))),
        ],
      ),
    );
    compra = r!.confirm_receipt_extraction.purchaseId;
    expect(r!.confirm_receipt_extraction.confirmed).toBe(2);
    expect(r!.confirm_receipt_extraction.lots).toBe(2);

    const lotes = await h.comoAdmin(() =>
      h.filas<{ value_minor: string; value_status: string }>(
        `select l.value_minor, l.value_status
         from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1 order by l.value_minor`,
        [compra],
      ),
    );
    expect(lotes.map((l) => Number(l.value_minor))).toEqual([1990, 4990]);
    expect(lotes.every((l) => l.value_status === "KNOWN")).toBe(true);
  });

  it("[H48] la compra queda con la fecha IMPRESA, no con la de subida", async () => {
    const c = await h.comoAdmin(() =>
      h.fila<{ purchased_on: string; purchased_on_source: string; total_confirmed_by: string | null }>(
        "select purchased_on::text, purchased_on_source, total_confirmed_by from public.purchases where id = $1",
        [compra],
      ),
    );
    expect(c!.purchased_on).toBe("2026-08-15");
    expect(c!.purchased_on_source).toBe("PRINTED");
    // [H42] Y el total lleva la firma de quien lo tecleó mirando el papel.
    expect(c!.total_confirmed_by).not.toBeNull();
  });

  it("[H36] confirmarla de nuevo NO crea una segunda compra ni un solo lote más", async () => {
    const lotesAntes = await contar("inventory_lots");
    const comprasAntes = await contar("purchases");

    const filas = await candidatos(boleta);
    const otraVez = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, 6980)", [
          boleta,
          JSON.stringify(filas.map((f) => ({ candidate_id: f.id, action: "CONFIRM" }))),
        ]),
      ),
    );
    expect(otraVez.rechazado).toBe(true);
    expect(otraVez.mensaje).toContain("YA_GENERO_COMPRA");
    expect(await contar("inventory_lots")).toBe(lotesAntes);
    expect(await contar("purchases")).toBe(comprasAntes);
  });

  it("[H68] los montos NO viajan en audit_events; viajan en finance_audit_log", async () => {
    const traza = await h.comoAdmin(() =>
      h.fila<{ metadata: Record<string, unknown> }>(
        `select metadata from public.audit_events
         where subject_id = $1 and action = 'RECEIPT_EXTRACTION_CONFIRMED'`,
        [boleta],
      ),
    );
    const claves = Object.keys(traza!.metadata);
    expect(claves).toContain("lots_created");
    expect(claves.some((k) => k.includes("minor") || k.includes("value") || k.includes("amount"))).toBe(
      false,
    );

    const dinero = await h.comoAdmin(() =>
      h.fila<{ amount_minor: string; amount_status: string }>(
        `select amount_minor, amount_status from public.finance_audit_log
         where subject_id = $1 and action = 'RECEIPT_CONFIRMED'`,
        [boleta],
      ),
    );
    expect(Number(dinero!.amount_minor)).toBe(6980);
    expect(dinero!.amount_status).toBe("KNOWN");
  });

  it("[H52] archivar una boleta confirmada CONSERVA el archivo", async () => {
    const r = await h.como(USER_ANA, () =>
      h.fila<{ archive_purchase_receipt: { fileDeleted: boolean; storagePath: string | null } }>(
        "select public.archive_purchase_receipt($1)",
        [boleta],
      ),
    );
    // Borrar el respaldo de una compra viva es destruir la evidencia del hecho
    // contable en el mismo sprint que declara historia inmutable.
    expect(r!.archive_purchase_receipt.fileDeleted).toBe(false);
    expect(r!.archive_purchase_receipt.storagePath).toBeNull();
  });
});

describe("las guardas que no dependen de la disciplina del cliente", () => {
  it("[H36] un payload que no cubre todas las líneas pendientes falla entero", async () => {
    const boleta = await subir("4".repeat(64));
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Los Aromos",
      receipt_date: "2026-08-16",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });
    const filas = await candidatos(boleta);
    const movsAntes = await contar("inventory_movements");

    const parcial = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, 6980)", [
          boleta,
          JSON.stringify([{ candidate_id: filas[0]!.id, action: "CONFIRM" }]),
        ]),
      ),
    );
    expect(parcial.rechazado).toBe(true);
    expect(parcial.mensaje).toContain("FALTAN_DECISIONES");
    expect(await contar("inventory_movements")).toBe(movsAntes);
  });

  it("[H46] un candidato de OTRA boleta no se cuela en una transacción autorizada", async () => {
    const propia = await subir("5".repeat(64));
    const ajena = await subir("6".repeat(64));
    await consentir(propia);
    await consentir(ajena);
    await extraer(propia, [polloOk()]);
    await extraer(ajena, [arrozOk()]);

    const deLaAjena = await candidatos(ajena);
    const deLaPropia = await candidatos(propia);
    const movsAntes = await contar("inventory_movements");

    const intruso = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, 4990)", [
          propia,
          JSON.stringify([
            { candidate_id: deLaPropia[0]!.id, action: "CONFIRM" },
            { candidate_id: deLaAjena[0]!.id, action: "CONFIRM" },
          ]),
        ]),
      ),
    );
    expect(intruso.rechazado).toBe(true);
    expect(intruso.mensaje).toContain("CANDIDATO_AJENO");
    expect(await contar("inventory_movements")).toBe(movsAntes);
  });

  it("descartar TODAS las líneas deja cero movimientos y ninguna compra", async () => {
    const boleta = await subir("7".repeat(64));
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()]);
    const filas = await candidatos(boleta);
    const movsAntes = await contar("inventory_movements");
    const comprasAntes = await contar("purchases");

    const r = await h.como(USER_ANA, () =>
      h.fila<{ confirm_receipt_extraction: { discarded: number; purchaseId: string | null } }>(
        "select public.confirm_receipt_extraction($1, $2::jsonb, null)",
        [boleta, JSON.stringify(filas.map((f) => ({ candidate_id: f.id, action: "DISCARD" })))],
      ),
    );
    expect(r!.confirm_receipt_extraction.discarded).toBe(2);
    expect(r!.confirm_receipt_extraction.purchaseId).toBeNull();
    expect(await contar("inventory_movements")).toBe(movsAntes);
    expect(await contar("purchases")).toBe(comprasAntes);
  });

  it("[H41] si nadie teclea el total, ni una línea limpia se confirma en bloque", async () => {
    const boleta = await subir("8".repeat(64));
    await consentir(boleta);
    await extraer(boleta, [polloOk()], { merchant_name: "Los Aromos", receipt_date: "2026-08-17" });
    const filas = await candidatos(boleta);
    expect(filas[0]!.doubt_reasons).toEqual([]);

    const sinTotal = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, null)", [
          boleta,
          JSON.stringify([{ candidate_id: filas[0]!.id, action: "CONFIRM" }]),
        ]),
      ),
    );
    expect(sinTotal.rechazado).toBe(true);
    expect(sinTotal.mensaje).toContain("LINEA_SIN_MIRAR");

    // Con la línea mirada una por una, sí: el humano se hizo cargo.
    const conAck = await h.como(USER_ANA, () =>
      h.fila<{ confirm_receipt_extraction: { purchaseId: string } }>(
        "select public.confirm_receipt_extraction($1, $2::jsonb, null)",
        [
          boleta,
          JSON.stringify([{ candidate_id: filas[0]!.id, action: "CONFIRM", acknowledged: true }]),
        ],
      ),
    );
    expect(conAck!.confirm_receipt_extraction.purchaseId).not.toBeNull();
  });

  it("[H35 capa 3] la boleta hermana bloquea la confirmación hasta que alguien la declare", async () => {
    const cabecera = {
      merchant_name: "Feria del Barrio",
      receipt_date: "2026-08-18",
      declared_total_minor: 4990,
      total_source: "PRINTED",
    };
    const primera = await subir("9".repeat(64));
    await consentir(primera);
    await extraer(primera, [polloOk()], cabecera);

    const gemela = await subir("ab".repeat(32));
    await consentir(gemela);
    const r = await extraer(gemela, [polloOk()], cabecera);
    expect(r.duplicateOf).toBe(primera);

    const filas = await candidatos(gemela);
    const bloqueada = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, 4990)", [
          gemela,
          JSON.stringify([{ candidate_id: filas[0]!.id, action: "CONFIRM" }]),
        ]),
      ),
    );
    expect(bloqueada.rechazado).toBe(true);
    expect(bloqueada.mensaje).toContain("POSIBLE_DUPLICADO");

    // Dos vueltas al mismo súper el mismo día PASA: se declara, con su porqué.
    await h.como(USER_ANA, () =>
      h.db.query("select public.acknowledge_receipt_duplicate($1, $2)", [
        gemela,
        "volvimos en la tarde por lo que faltaba",
      ]),
    );
    const despues = await h.como(USER_ANA, () =>
      h.fila<{ confirm_receipt_extraction: { purchaseId: string } }>(
        "select public.confirm_receipt_extraction($1, $2::jsonb, 4990)",
        [gemela, JSON.stringify([{ candidate_id: filas[0]!.id, action: "CONFIRM" }])],
      ),
    );
    expect(despues!.confirm_receipt_extraction.purchaseId).not.toBeNull();
  });

  it("[H37] una boleta marcada para ADJUNTAR no puede crear una compra nueva", async () => {
    const boleta = await subir("cd".repeat(32), "ATTACH_TO_EXISTING");
    await consentir(boleta);
    await extraer(boleta, [polloOk()], {
      merchant_name: "Los Aromos",
      receipt_date: "2026-08-19",
      declared_total_minor: 4990,
      total_source: "PRINTED",
    });
    const filas = await candidatos(boleta);
    const movsAntes = await contar("inventory_movements");

    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, 4990)", [
          boleta,
          JSON.stringify([{ candidate_id: filas[0]!.id, action: "CONFIRM" }]),
        ]),
      ),
    );
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("DESTINO_EQUIVOCADO");
    expect(await contar("inventory_movements")).toBe(movsAntes);
  });

  it("[H43] re-extraer con decisiones humanas abre una PASADA nueva, no renumera", async () => {
    const boleta = await subir("ef".repeat(32));
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()]);
    let filas = await candidatos(boleta);

    // La persona descarta una línea y se va a hacer otra cosa.
    await h.comoAdmin(() =>
      h.db.query(
        "update public.receipt_extraction_candidates set status = 'DISCARDED' where id = $1",
        [filas[1]!.id],
      ),
    );

    // Segundo pase del extractor, con OTRO número de líneas y otro orden.
    const r = await extraer(boleta, [arrozOk(), polloOk(), { ...arrozOk(), raw_line_text: "PAN" }]);
    expect(r.pass).toBe(2);
    // La decisión vieja se migró por TEXTO, no por posición.
    expect(r.migrated).toBe(1);

    filas = await candidatos(boleta);
    const pase2 = filas.filter((f) => f.status !== "PENDING" || true);
    expect(pase2.length).toBeGreaterThan(3); // la pasada 1 se conserva como historia
    const migrada = await h.comoAdmin(() =>
      h.fila<{ status: string }>(
        `select status from public.receipt_extraction_candidates
         where receipt_id = $1 and extraction_pass = 2 and raw_line_text = 'ARROZ GRANO LARGO 1KG'`,
        [boleta],
      ),
    );
    expect(migrada!.status).toBe("DISCARDED");
  });
});

describe("la boleta que llega DESPUÉS de la mercadería", () => {
  it("[H37] adjuntar solo pone el precio que faltaba: ni un lote ni un movimiento nuevos", async () => {
    // El sábado entró la mercadería por la lista de compras: el lote existe y su
    // valor es DESCONOCIDO a propósito (una estimación no se capitaliza).
    const lote = await h.comoAdmin(() =>
      h.fila<{ app_receive_lot_from_purchase: string }>(
        `select app.receive_lot_from_purchase($1, $2, null, 'POLLO ENTERO', 1000, 'G', 'RAW',
                null, 'RECEIVE:boleta-tarde', null, null, null, null, $3) as app_receive_lot_from_purchase`,
        [hogar.householdId, pollo, hogar.memberId],
      ),
    );
    const loteId = lote!.app_receive_lot_from_purchase;
    const antes = await h.comoAdmin(() =>
      h.fila<{ value_status: string; quantity: string }>(
        "select value_status, quantity from public.inventory_lots where id = $1",
        [loteId],
      ),
    );
    expect(antes!.value_status).toBe("UNKNOWN");

    // El domingo aparece la boleta.
    const boleta = await subir("12".repeat(32), "ATTACH_TO_EXISTING");
    await consentir(boleta);
    await extraer(boleta, [polloOk()], {
      merchant_name: "Los Aromos",
      receipt_date: "2026-08-23",
      declared_total_minor: 4990,
      total_source: "PRINTED",
    });
    const filas = await candidatos(boleta);
    const lotesAntes = await contar("inventory_lots");
    const movsAntes = await contar("inventory_movements");

    await h.como(USER_ANA, () =>
      h.db.query("select public.attach_receipt_to_purchase($1, $2::jsonb, 4990)", [
        boleta,
        JSON.stringify([{ candidate_id: filas[0]!.id, lot_id: loteId }]),
      ]),
    );

    // NO se creó ningún lote ni ningún movimiento: solo llegó el valor.
    expect(await contar("inventory_lots")).toBe(lotesAntes);
    expect(await contar("inventory_movements")).toBe(movsAntes);
    const despues = await h.comoAdmin(() =>
      h.fila<{ value_status: string; value_minor: string; quantity: string }>(
        "select value_status, value_minor, quantity from public.inventory_lots where id = $1",
        [loteId],
      ),
    );
    expect(despues!.value_status).toBe("KNOWN");
    expect(Number(despues!.value_minor)).toBe(4990);
    // Y la cantidad no se tocó: para eso está adjust_lot.
    expect(despues!.quantity).toBe(antes!.quantity);
  });

  it("un lote que YA tiene valor no se revaloriza con una boleta nueva", async () => {
    const lote = await h.comoAdmin(() =>
      h.fila<{ app_receive_lot_from_purchase: string }>(
        `select app.receive_lot_from_purchase($1, $2, null, 'ARROZ', 1000, 'G', 'RAW',
                null, 'RECEIVE:ya-valorizado', 3000, null, null, null, $3) as app_receive_lot_from_purchase`,
        [hogar.householdId, arroz, hogar.memberId],
      ),
    );
    const boleta = await subir("34".repeat(32), "ATTACH_TO_EXISTING");
    await consentir(boleta);
    await extraer(boleta, [arrozOk()], { merchant_name: "Los Aromos", receipt_date: "2026-08-24" });
    const filas = await candidatos(boleta);

    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.attach_receipt_to_purchase($1, $2::jsonb, 1990)", [
          boleta,
          JSON.stringify([
            { candidate_id: filas[0]!.id, lot_id: lote!.app_receive_lot_from_purchase },
          ]),
        ]),
      ),
    );
    // La despensa vale lo que costó: no se revaloriza a precio de mercado.
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("no se revaloriza");
  });
});

describe("la pantalla y el servidor leen LA MISMA lista de bloqueos", () => {
  it("[H50] receipt_confirm_blocks devuelve lo mismo que hace fallar a confirm", async () => {
    const boleta = await subir("56".repeat(32));
    await consentir(boleta);
    await extraer(boleta, [{ ...polloOk(), quantity: 10000 }, arrozOk()], {
      merchant_name: "Los Aromos",
      receipt_date: "2026-08-25",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });
    const filas = await candidatos(boleta);

    // La pantalla pregunta ANTES de habilitar el botón.
    const previo = await h.como(USER_ANA, () =>
      h.fila<{ receipt_confirm_blocks: string[] }>(
        "select public.receipt_confirm_blocks($1, $2::jsonb, 6980, '[]'::jsonb)",
        [
          boleta,
          JSON.stringify(filas.map((f) => ({ candidate_id: f.id, action: "CONFIRM" }))),
        ],
      ),
    );
    expect(previo!.receipt_confirm_blocks.some((b) => b.startsWith("LINEA_SIN_MIRAR"))).toBe(true);

    // Y el servidor rechaza exactamente por eso, no por otra cosa.
    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, 6980)", [
          boleta,
          JSON.stringify(filas.map((f) => ({ candidate_id: f.id, action: "CONFIRM" }))),
        ]),
      ),
    );
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("LINEA_SIN_MIRAR");

    // Con la línea abierta y revisada, la lista queda vacía y confirma.
    const decisiones = filas.map((f) => ({
      candidate_id: f.id,
      action: "CONFIRM",
      acknowledged: true,
    }));
    const limpio = await h.como(USER_ANA, () =>
      h.fila<{ receipt_confirm_blocks: string[] }>(
        "select public.receipt_confirm_blocks($1, $2::jsonb, 6980, '[]'::jsonb)",
        [boleta, JSON.stringify(decisiones)],
      ),
    );
    expect(limpio!.receipt_confirm_blocks).toEqual([]);
  });

  it("un cargo de despacho entra al cuadre en vez de inventar un descuadre", async () => {
    const boleta = await subir("78".repeat(32));
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Los Aromos",
      receipt_date: "2026-08-26",
      declared_total_minor: 9980,
      total_source: "PRINTED",
    });
    const filas = await candidatos(boleta);
    const decisiones = filas.map((f) => ({ candidate_id: f.id, action: "CONFIRM" }));

    // 4.990 + 1.990 = 6.980 contra un total de 9.980: sin el despacho, descuadra.
    const sinDespacho = await h.como(USER_ANA, () =>
      h.fila<{ receipt_confirm_blocks: string[] }>(
        "select public.receipt_confirm_blocks($1, $2::jsonb, 9980, '[]'::jsonb)",
        [boleta, JSON.stringify(decisiones)],
      ),
    );
    expect(sinDespacho!.receipt_confirm_blocks.some((b) => b.startsWith("DESCUADRE"))).toBe(true);

    const cargos = [
      { kind: "DELIVERY", label: "Despacho", amount_minor: 3000, policy: "EXPENSE_ONLY" },
    ];
    const conDespacho = await h.como(USER_ANA, () =>
      h.fila<{ receipt_confirm_blocks: string[] }>(
        "select public.receipt_confirm_blocks($1, $2::jsonb, 9980, $3::jsonb)",
        [boleta, JSON.stringify(decisiones), JSON.stringify(cargos)],
      ),
    );
    expect(conDespacho!.receipt_confirm_blocks).toEqual([]);

    const r = await h.como(USER_ANA, () =>
      h.fila<{ confirm_receipt_extraction: { purchaseId: string; expenseAllocations: number } }>(
        "select public.confirm_receipt_extraction($1, $2::jsonb, 9980, $3::jsonb)",
        [boleta, JSON.stringify(decisiones), JSON.stringify(cargos)],
      ),
    );
    // El despacho NO capitaliza: sale del bolsillo y no entra a la despensa.
    expect(r!.confirm_receipt_extraction.expenseAllocations).toBe(1);
    const lotes = await h.comoAdmin(() =>
      h.filas<{ value_minor: string }>(
        `select l.value_minor from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1 order by l.value_minor`,
        [r!.confirm_receipt_extraction.purchaseId],
      ),
    );
    // Cargarle el despacho al pollo dejaría el kilo de pollo caro para siempre.
    expect(lotes.map((l) => Number(l.value_minor))).toEqual([1990, 4990]);
  });
});

describe("RLS: ver la plata de una boleta exige permiso", () => {
  it("quien solo puede SUBIR no ve las boletas del hogar ni sus candidatos", async () => {
    const visibles = await h.como(USER_BETO, () =>
      h.filas("select id from public.purchase_receipts where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(visibles).toHaveLength(0);

    const conPlata = await h.como(USER_BETO, () =>
      h.filas("select id from public.finance_audit_log where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(conPlata).toHaveLength(0);
  });

  it("nadie escribe estas tablas a mano: solo por RPC", async () => {
    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query(
          `insert into public.purchase_receipts (household_id, storage_path, content_sha256, original_mime, byte_size)
           values ($1, 'x', $2, 'text/plain', 10)`,
          [hogar.householdId, "9".repeat(64)],
        ),
      ),
    );
    expect(intento.rechazado).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ronda de ataque: lo que la refutación encontró abierto
// ---------------------------------------------------------------------------

const HASH_4 = "1a".repeat(32);
const HASH_5 = "2b".repeat(32);
const HASH_6 = "3c".repeat(32);
const HASH_7 = "4d".repeat(32);
const HASH_8 = "5e".repeat(32);
const HASH_9 = "6f".repeat(32);
const HASH_AA = "7a".repeat(32);
const HASH_BB = "8b".repeat(32);

/** Sube la MISMA foto otra vez y devuelve lo que contestó el servidor. */
async function subirOtraVez(
  hash: string,
): Promise<{ receiptId: string; duplicated: boolean; status: string }> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{
      upload_purchase_receipt: { receiptId: string; duplicated: boolean; status: string };
    }>(
      `select public.upload_purchase_receipt($1, $2, 'text/plain', 4096, $3, 'NEW_PURCHASE')`,
      [hogar.householdId, `household/${hogar.householdId}/${hash}.txt`, hash],
    ),
  );
  return r!.upload_purchase_receipt;
}

interface FilaBoletaDb {
  processing_status: string;
  purchase_id: string | null;
  duplicate_of: string | null;
  receipt_number: string | null;
}

async function boletaFila(id: string): Promise<FilaBoletaDb> {
  const r = await h.comoAdmin(() =>
    h.fila<FilaBoletaDb>(
      `select processing_status, purchase_id, duplicate_of, receipt_number
       from public.purchase_receipts where id = $1`,
      [id],
    ),
  );
  return r!;
}

describe("[BLOQUEANTE] archivar una boleta confirmada NO reabre la duplicación", () => {
  let archivada: string;

  it("la misma foto vuelve a la boleta que ya existe en vez de crear una segunda compra", async () => {
    archivada = await subir(HASH_4);
    await consentir(archivada);
    await extraer(archivada, [polloOk(), arrozOk()], {
      merchant_name: "Super Los Aromos",
      receipt_date: "2026-08-15",
      receipt_number: "F-1",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });
    const cands = await candidatos(archivada);
    const decisiones = cands.map((c) => ({ candidate_id: c.id, action: "CONFIRM" }));
    const conf = await h.como(USER_ANA, () =>
      h.fila<{ confirm_receipt_extraction: { purchaseId: string; lots: number } }>(
        "select public.confirm_receipt_extraction($1, $2::jsonb, 6980, '[]'::jsonb)",
        [archivada, JSON.stringify(decisiones)],
      ),
    );
    expect(conf!.confirm_receipt_extraction.lots).toBe(2);

    const comprasAntes = await contar("purchases");
    const lotesAntes = await contar("inventory_lots");

    // Su caso de diseño: archivar CONSERVA el archivo de una boleta confirmada.
    const arch = await h.como(USER_ANA, () =>
      h.fila<{ archive_purchase_receipt: { retained: boolean } }>(
        "select public.archive_purchase_receipt($1)",
        [archivada],
      ),
    );
    expect(arch!.archive_purchase_receipt.retained).toBe(true);

    // LA MUTACIÓN QUE NOMBRÓ EL ATACANTE: con el predicado viejo de los índices y
    // de las dos sondas —"processing_status <> 'ARCHIVED'" a secas— esto devolvía
    // duplicated:false y un id NUEVO, y de ahí salían una segunda compra, un
    // segundo juego de líneas y un segundo juego de lotes.
    const sonda = await h.como(USER_ANA, () =>
      h.fila<{ find_purchase_receipt_by_hash: { found: boolean; receiptId?: string } }>(
        "select public.find_purchase_receipt_by_hash($1, $2)",
        [hogar.householdId, HASH_4],
      ),
    );
    expect(sonda!.find_purchase_receipt_by_hash.found).toBe(true);
    expect(sonda!.find_purchase_receipt_by_hash.receiptId).toBe(archivada);

    const otraVez = await subirOtraVez(HASH_4);
    expect(otraVez.duplicated).toBe(true);
    expect(otraVez.receiptId).toBe(archivada);
    expect(otraVez.status).toBe("ARCHIVED");

    expect(await contar("purchases")).toBe(comprasAntes);
    expect(await contar("inventory_lots")).toBe(lotesAntes);
  });

  it("otra foto del mismo papel nombra a la hermana archivada y no se confirma sola", async () => {
    const otraFoto = await subir(HASH_5);
    await consentir(otraFoto);
    // Mismo comercio, misma fecha, MISMO FOLIO: la capa 2. Antes esto reventaba
    // con el error crudo del índice y dejaba la boleta en UPLOADED, sin
    // candidatos, sin hermana y sin ninguna acción posible.
    const r = await extraer(otraFoto, [polloOk(), arrozOk()], {
      merchant_name: "Super Los Aromos",
      receipt_date: "2026-08-15",
      receipt_number: "F-1",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });
    expect(r.candidates).toBe(2);
    expect(r.duplicateOf).toBe(archivada);

    const fila = await boletaFila(otraFoto);
    expect(fila.processing_status).toBe("NEEDS_REVIEW");
    expect(fila.duplicate_of).toBe(archivada);
    // El folio se queda con la boleta que ya lo tenía: el papel tiene un dueño.
    expect(fila.receipt_number).toBeNull();

    const bloqueos = await h.como(USER_ANA, () =>
      h.fila<{ receipt_confirm_blocks: string[] }>("select public.receipt_confirm_blocks($1)", [
        otraFoto,
      ]),
    );
    expect(bloqueos!.receipt_confirm_blocks.some((b) => b.startsWith("POSIBLE_DUPLICADO"))).toBe(
      true,
    );
  });
});

describe("[ALTO] el todo-o-nada compara conjuntos, no cuenta decisiones", () => {
  it("un candidato de una lectura VIEJA no arma la compra con la lectura superada", async () => {
    const boleta = await subir(HASH_6);
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Super Dos Pasadas",
      receipt_date: "2026-08-16",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });
    const pasada1 = await candidatos(boleta);
    const viejo = pasada1[0]!;

    // Alguien decidió una línea: la re-lectura abre una PASADA nueva y conserva
    // la anterior como historia.
    await h.comoAdmin(() =>
      h.db.query(
        `update public.receipt_extraction_candidates
         set status = 'DISCARDED', decided_at = now() where id = $1`,
        [pasada1[1]!.id],
      ),
    );
    const re = await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Super Dos Pasadas",
      receipt_date: "2026-08-16",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });
    expect(re.pass).toBe(2);

    // LA MUTACIÓN: sin "extraction_pass = v_d.extraction_pass" en el select de
    // cada decisión, este payload —una sola línea, y de la lectura superada—
    // pasaba el conteo y confirmaba la boleta entera.
    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb, 4990, '[]'::jsonb)", [
          boleta,
          JSON.stringify([{ candidate_id: viejo.id, action: "CONFIRM" }]),
        ]),
      ),
    );
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("LINEA_DE_OTRA_LECTURA");

    const fila = await boletaFila(boleta);
    expect(fila.processing_status).not.toBe("CONFIRMED");
    expect(fila.purchase_id).toBeNull();
  });

  it("repetir el mismo candidate_id no llena el cupo: la línea que falta se reclama", async () => {
    const boleta = await subir(HASH_7);
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Super Repetido",
      receipt_date: "2026-08-17",
      declared_total_minor: 6980,
      total_source: "PRINTED",
    });
    const cands = await candidatos(boleta);
    const uno = cands[0]!;

    // LA MUTACIÓN: con "v_cubiertos := v_cubiertos + 1" por decisión y sin
    // distinct, este payload cubría "2 de 2" y la segunda línea de la boleta
    // desaparecía para siempre (el documento quedaba CONFIRMED con su compra).
    const payload = [
      { candidate_id: uno.id, action: "CONFIRM", acknowledged: true },
      { candidate_id: uno.id, action: "CONFIRM", acknowledged: true },
    ];
    const bloqueos = await h.como(USER_ANA, () =>
      h.fila<{ receipt_confirm_blocks: string[] }>(
        "select public.receipt_confirm_blocks($1, $2::jsonb)",
        [boleta, JSON.stringify(payload)],
      ),
    );
    expect(bloqueos!.receipt_confirm_blocks.some((b) => b.startsWith("LINEA_REPETIDA"))).toBe(true);
    expect(bloqueos!.receipt_confirm_blocks.some((b) => b.startsWith("FALTAN_DECISIONES"))).toBe(
      true,
    );

    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.confirm_receipt_extraction($1, $2::jsonb)", [
          boleta,
          JSON.stringify(payload),
        ]),
      ),
    );
    expect(intento.rechazado).toBe(true);

    const estados = await candidatos(boleta);
    expect(estados.filter((c) => c.status === "PENDING")).toHaveLength(2);
    const fila = await boletaFila(boleta);
    expect(fila.purchase_id).toBeNull();
  });
});

describe("[ALTO] adjuntar pasa por la MISMA lista de bloqueos que confirmar", () => {
  async function loteSinValor(label: string, cantidad: number): Promise<string> {
    const r = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>("select public.add_manual_lot($1, $2, $3, 'G', $4)", [
        hogar.householdId,
        label,
        cantidad,
        pollo,
      ]),
    );
    return r!.add_manual_lot;
  }

  async function valorDelLote(
    id: string,
  ): Promise<{ value_status: string; value_minor: string | null }> {
    const r = await h.comoAdmin(() =>
      h.fila<{ value_status: string; value_minor: string | null }>(
        "select value_status, value_minor from public.inventory_lots where id = $1",
        [id],
      ),
    );
    return r!;
  }

  it("una línea que el propio servidor marcó dudosa NO se capitaliza sola", async () => {
    const lote = await loteSinValor("Pollo del sábado", 1000);
    expect((await valorDelLote(lote)).value_status).toBe("UNKNOWN");

    const boleta = await subir(HASH_8, "ATTACH_TO_EXISTING");
    await consentir(boleta);
    await extraer(
      boleta,
      [
        {
          raw_line_text: "POLLO ENTERO",
          quantity: 1000,
          unit: "G",
          unit_price_minor: 179900,
          unit_price_basis: "PER_KG",
          line_total_minor: 179900,
          matched_ingredient_id: pollo,
          match_method: "EXACT_NAME",
          match_score: 0.99,
          // El papel decía 17.990 y el lector leyó 179.900: lo declara él mismo.
          field_confidences: { unit_price: 0.3, line_total: 0.3 },
        },
      ],
      { merchant_name: "Super Dudoso", receipt_date: "2026-08-18" },
    );
    const cands = await candidatos(boleta);
    expect(cands[0]!.doubt_reasons.length).toBeGreaterThan(0);

    // LA MUTACIÓN: sin la llamada a app.receipt_confirm_blocks, esto devolvía
    // rechazado:false y dejaba el lote en KNOWN 179900 — $179.900 capitalizados
    // desde una lectura que el mismo servidor declaró dudosa.
    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.attach_receipt_to_purchase($1, $2::jsonb)", [
          boleta,
          JSON.stringify([{ candidate_id: cands[0]!.id, lot_id: lote }]),
        ]),
      ),
    );
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("LINEA_SIN_MIRAR");
    expect((await valorDelLote(lote)).value_status).toBe("UNKNOWN");

    // Abierta, revisada y con el total tecleado: recién ahí entra la plata.
    const ok = await h.como(USER_ANA, () =>
      h.fila<{ attach_receipt_to_purchase: { lines: number; priceObservations: number } }>(
        "select public.attach_receipt_to_purchase($1, $2::jsonb, 179900)",
        [
          boleta,
          JSON.stringify([{ candidate_id: cands[0]!.id, lot_id: lote, acknowledged: true }]),
        ],
      ),
    );
    expect(ok!.attach_receipt_to_purchase.lines).toBe(1);
    const valorado = await valorDelLote(lote);
    expect(valorado.value_status).toBe("KNOWN");
    expect(Number(valorado.value_minor)).toBe(179900);
  });

  it("no da por confirmada la línea que nadie enlazó ni miró", async () => {
    const lote = await loteSinValor("Pollo del domingo", 500);
    const boleta = await subir(HASH_9, "ATTACH_TO_EXISTING");
    await consentir(boleta);
    await extraer(boleta, [polloOk(), arrozOk()], {
      merchant_name: "Super Mitad",
      receipt_date: "2026-08-19",
    });
    const cands = await candidatos(boleta);

    // LA MUTACIÓN: attach cerraba con
    // "update ... set status='CONFIRMED' where receipt_id = $1 and status='PENDING'",
    // así que la segunda línea quedaba CONFIRMED sin que nadie la enlazara.
    const intento = await intentar(() =>
      h.como(USER_ANA, () =>
        h.db.query("select public.attach_receipt_to_purchase($1, $2::jsonb, 6980)", [
          boleta,
          JSON.stringify([{ candidate_id: cands[0]!.id, lot_id: lote, acknowledged: true }]),
        ]),
      ),
    );
    expect(intento.rechazado).toBe(true);
    expect(intento.mensaje).toContain("FALTAN_DECISIONES");

    const estados = await candidatos(boleta);
    expect(estados.filter((c) => c.status === "PENDING")).toHaveLength(2);
    const fila = await boletaFila(boleta);
    expect(fila.purchase_id).toBeNull();
  });

  it("adjuntar asigna el gasto que NO queda en la despensa (incluido el redondeo)", async () => {
    const lote = await loteSinValor("Pollo del lunes", 750);
    const boleta = await subir(HASH_AA, "ATTACH_TO_EXISTING");
    await consentir(boleta);
    await extraer(
      boleta,
      [
        {
          raw_line_text: "POLLO ENTERO",
          quantity: 750,
          unit: "G",
          line_total_minor: 10000,
          matched_ingredient_id: pollo,
          match_method: "EXACT_NAME",
          match_score: 0.99,
          field_confidences: { line_total: 1 },
        },
      ],
      { merchant_name: "Super Redondeo", receipt_date: "2026-08-20" },
    );
    const cands = await candidatos(boleta);

    // El total impreso trae 3 pesos que ninguna línea explica: la conciliación
    // los deja como cargo ROUNDING con política EXPENSE_ONLY.
    const r = await h.como(USER_ANA, () =>
      h.fila<{ attach_receipt_to_purchase: { purchaseId: string; expenseAllocations: number } }>(
        "select public.attach_receipt_to_purchase($1, $2::jsonb, 10003)",
        [boleta, JSON.stringify([{ candidate_id: cands[0]!.id, lot_id: lote }])],
      ),
    );
    // LA MUTACIÓN: sin app.allocate_purchase_expense acá, esos 3 pesos no estaban
    // ni en el valor guardado ni en el consumo, y la fila "gasto que no queda en
    // la despensa" del panel rendía un CERO CONOCIDO.
    expect(r!.attach_receipt_to_purchase.expenseAllocations).toBe(1);

    const asignaciones = await h.comoAdmin(() =>
      h.filas<{ category: string; amount_minor: string }>(
        `select a.category, a.amount_minor
         from public.cost_allocations a
         join public.purchase_charges c on c.id = a.purchase_charge_id
         where c.purchase_id = $1`,
        [r!.attach_receipt_to_purchase.purchaseId],
      ),
    );
    expect(asignaciones).toHaveLength(1);
    expect(asignaciones[0]!.category).toBe("NON_CAPITALIZED_EXPENSE");
    expect(Number(asignaciones[0]!.amount_minor)).toBe(3);
  });
});

describe("[ALTO] confirmar una boleta DEJA la historia de precios del hogar", () => {
  it("dos líneas idénticas dan dos purchase_items y UNA sola observación", async () => {
    const boleta = await subir(HASH_BB);
    await consentir(boleta);
    const linea = (): LineaBoleta => ({
      raw_line_text: "YOGURT NATURAL 150G",
      quantity: 150,
      unit: "G",
      unit_price_minor: 890,
      unit_price_basis: "PER_UNIT",
      line_total_minor: 890,
      matched_ingredient_id: arroz,
      match_method: "EXACT_NAME",
      match_score: 0.99,
      field_confidences: { quantity: 1, unit_price: 1, line_total: 1 },
    });
    await extraer(boleta, [linea(), linea()], {
      merchant_name: "Super Yogurt",
      receipt_date: "2026-08-21",
      declared_total_minor: 1780,
      total_source: "PRINTED",
    });
    const cands = await candidatos(boleta);
    const decisiones = cands.map((c) => ({ candidate_id: c.id, action: "CONFIRM" }));

    // LA MUTACIÓN: el productor no existía. record_price_observation tenía tres
    // llamadores —avistamiento, corrección y catálogo— y ninguno era la boleta,
    // así que este número era 0 y la tabla quedaba vacía para siempre.
    const r = await h.como(USER_ANA, () =>
      h.fila<{ confirm_receipt_extraction: { purchaseId: string; priceObservations: number } }>(
        "select public.confirm_receipt_extraction($1, $2::jsonb, 1780, '[]'::jsonb)",
        [boleta, JSON.stringify(decisiones)],
      ),
    );
    const compra = r!.confirm_receipt_extraction.purchaseId;
    expect(r!.confirm_receipt_extraction.priceObservations).toBe(1);

    expect(await contar("purchase_items", "purchase_id = $1", [compra])).toBe(2);

    const obs = await h.comoAdmin(() =>
      h.filas<{
        source: string;
        price_minor: string;
        observed_on: string;
        observed_on_source: string;
        normalized_per_kg_minor: string | null;
      }>(
        `select source, price_minor, observed_on::text as observed_on, observed_on_source,
                normalized_per_kg_minor
         from public.price_observations where purchase_id = $1`,
        [compra],
      ),
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.source).toBe("RECEIPT");
    expect(Number(obs[0]!.price_minor)).toBe(890);
    // [H48] La fecha es la IMPRESA en el papel, no la de la subida.
    expect(obs[0]!.observed_on).toBe("2026-08-21");
    expect(obs[0]!.observed_on_source).toBe("PRINTED");
  });
});

// ---------------------------------------------------------------------------
// La lección de la ronda: una función sin llamador de producción no está
// construida, está escrita. Estos tests no tocan la base: leen el repo y se
// ponen rojos si el camino se corta ANTES de llegar a donde la persona lo ve.
// ---------------------------------------------------------------------------

const WEB_SRC = path.resolve(__dirname, "..");

/** Sin comentarios: una mención en un comentario no es un llamador. */
function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function fuentes(raiz: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(raiz, { withFileTypes: true })) {
    const completo = path.join(raiz, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === "node_modules" || entrada.name === ".next") continue;
      salida.push(...fuentes(completo));
    } else if (/\.(ts|tsx)$/.test(entrada.name) && !entrada.name.endsWith(".test.ts")) {
      salida.push(completo);
    }
  }
  return salida;
}

describe("cada pieza de este camino tiene llamador de PRODUCCIÓN", () => {
  const sql045 = readFileSync(
    path.join(RAIZ, "supabase/migrations/0045_receipts_pipeline.sql"),
    "utf8",
  );

  it("adjuntar la boleta se puede APRETAR: hay server action y hay pantalla que la llama", () => {
    // La mutación que este test mata: borrar `attachReceipt` de actions.ts o
    // desconectar `AttachTable` de la revisión. Así estaba antes —la app
    // ofrecía «ya llegó» en la subida y lo invitaba en la lista, y el RPC no se
    // llamaba desde ningún lado: quien seguía el consejo de la app quedaba
    // encerrado con la boleta leída y sin ningún botón que apretar.
    const acciones = sinComentarios(
      readFileSync(path.resolve(WEB_SRC, "app/finanzas/boletas/actions.ts"), "utf8"),
    );
    expect(acciones).toContain("attach_receipt_to_purchase");

    const pantallas = fuentes(path.resolve(WEB_SRC, "app/finanzas/boletas")).filter((archivo) => {
      if (archivo.endsWith("actions.ts")) return false;
      return /\battachReceipt\s*\(/.test(sinComentarios(readFileSync(archivo, "utf8")));
    });
    expect(
      pantallas.map((a) => path.relative(WEB_SRC, a)),
      "nadie llama a attachReceipt: el destino «ya llegó» se ofrece y no se puede terminar",
    ).not.toHaveLength(0);
  });

  it("las dos puertas leen la MISMA lista de bloqueos, en la base y en la pantalla", () => {
    // Dos listas de «esto no se puede confirmar» es el defecto [H50]; que la
    // segunda sea más floja es el defecto y su consecuencia.
    const confirmar = sql045.slice(sql045.indexOf("function public.confirm_receipt_extraction"));
    const adjuntar = sql045.slice(sql045.indexOf("function public.attach_receipt_to_purchase"));
    expect(confirmar.slice(0, 12000)).toContain("app.receipt_confirm_blocks(");
    expect(adjuntar.slice(0, 12000)).toContain("app.receipt_confirm_blocks(");

    const acciones = sinComentarios(
      readFileSync(path.resolve(WEB_SRC, "app/finanzas/boletas/actions.ts"), "utf8"),
    );
    // La pantalla NO tiene su propia lista: pregunta por la del servidor, por
    // las dos puertas.
    expect(acciones).toContain('p_door: "ATTACH_TO_EXISTING"');
    expect(acciones).toContain('p_door: door');
  });

  it("confirmar y adjuntar emiten precios y asignan el gasto que no capitaliza", () => {
    // Las dos llamadas que faltaban, contadas: si alguien borra una, este test
    // lo dice por su nombre en vez de dejar un cero silencioso en el panel.
    expect(
      [...sql045.matchAll(/app\.emit_purchase_price_observations\(v_purchase/g)].length,
    ).toBe(2);
    expect([...sql045.matchAll(/app\.allocate_purchase_expense\(v_purchase\)/g)].length).toBe(2);
  });
});
