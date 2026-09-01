import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  construirDeclaracionLibre,
  construirDeclaracionServida,
  MERMA_QUE_IMPIDE_ASUMIR,
  puedeDarsePorComida,
  topeComible,
  textoCantidad,
  VERSION_MOTOR_EXTENT,
  type EntradaServida,
  type Extent,
  type RenglonServido,
} from "./extent";

/**
 * El motor que traduce "casi todo" a un número, y las guardas estructurales de
 * la pantalla /comi. Un motor sin test no está hecho.
 */

const SERVIDO: RenglonServido = {
  servingRecordItemId: "11111111-1111-4111-8111-111111111111",
  label: "Arroz",
  ingredientId: "22222222-2222-4222-8222-222222222222",
  productId: null,
  servido: 200,
  entregado: 200,
  botado: 0,
  unidad: "G",
  baseFisica: "COOKED",
  sortOrder: 1,
};

function entrada(extent: Extent, over: Partial<RenglonServido> = {}, exacta: number | null = null): EntradaServida {
  return { servido: { ...SERVIDO, ...over }, extent, cantidadExacta: exacta };
}

function items(entradas: EntradaServida[]) {
  const r = construirDeclaracionServida(entradas);
  if (!r.ok) throw new Error(`esperaba éxito, hubo problemas: ${r.problemas.join(" / ")}`);
  return r.items;
}

describe("intake-extent/1.0.0 — un 'no sé' jamás se vuelve un número", () => {
  it("UNKNOWN no lleva cantidad ni unidad: el hueco queda dicho", () => {
    const [item] = items([entrada("UNKNOWN")]);
    expect(item!.extent).toBe("UNKNOWN");
    expect(item!.quantity).toBeUndefined();
    expect(item!.unit).toBeUndefined();
    expect(item!.extent_engine_version).toBeUndefined();
  });

  it("NONE tampoco lleva un cero: 'nada' no es 'cero gramos calculados'", () => {
    const [item] = items([entrada("NONE")]);
    expect(item!.extent).toBe("NONE");
    // Es LA regla de la 0038: si acá apareciera un 0, el motor leería una
    // medición donde solo hubo una afirmación.
    expect(item!.quantity).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('"quantity"');
  });

  it("las fracciones salen del tope comible y se firman con la versión del motor", () => {
    const [todo] = items([entrada("ALL")]);
    const [casi] = items([entrada("MOST")]);
    const [mitad] = items([entrada("HALF")]);
    const [poco] = items([entrada("LITTLE")]);

    expect(todo!.quantity).toBe(200);
    expect(casi!.quantity).toBe(150);
    expect(mitad!.quantity).toBe(100);
    expect(poco!.quantity).toBe(50);

    for (const item of [todo, casi, mitad, poco]) {
      expect(item!.quantity_is_declared).toBe(false);
      expect(item!.extent_engine_version).toBe(VERSION_MOTOR_EXTENT);
      expect(item!.unit).toBe("G");
      expect(item!.weight_basis).toBe("COOKED");
    }
  });
});

describe("el tope: nadie come lo que la despensa no entregó ni lo que se botó", () => {
  it("con faltante, el tope es lo entregado y no lo que el plan mandaba", () => {
    expect(topeComible({ ...SERVIDO, servido: 200, entregado: 120 })).toBe(120);
    const [item] = items([entrada("ALL", { servido: 200, entregado: 120 })]);
    expect(item!.quantity).toBe(120);
  });

  it("lo botado baja el tope: esos gramos alguien los vio y los tiró", () => {
    expect(topeComible({ ...SERVIDO, botado: 50 })).toBe(150);
    const [item] = items([entrada("ALL", { botado: 50 })]);
    // 150 es también el techo exacto de `app.intake_item_guard`: un número más
    // grande lo rebotaría el servidor y la persona vería un error que no causó.
    expect(item!.quantity).toBe(150);
  });

  it("si no quedó nada que comer, el extent se conserva y el número NO se inventa en cero", () => {
    const [item] = items([entrada("ALL", { entregado: 0 })]);
    expect(item!.extent).toBe("ALL");
    expect(item!.quantity).toBeUndefined();
  });

  it("el tope nunca es negativo", () => {
    expect(topeComible({ ...SERVIDO, servido: 100, botado: 180 })).toBe(0);
  });
});

describe("la cantidad exacta es de la persona, no del motor", () => {
  it("EXACT con número queda declarado y sin motor detrás", () => {
    const [item] = items([entrada("EXACT", {}, 137.5)]);
    expect(item!.quantity).toBe(137.5);
    expect(item!.quantity_is_declared).toBe(true);
    expect(item!.extent_engine_version).toBeUndefined();
  });

  it("EXACT sin número NO se degrada en silencio: se dice cuál renglón falta", () => {
    const r = construirDeclaracionServida([entrada("EXACT", { label: "Pollo" })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problemas.join(" ")).toContain("Pollo");
  });

  it("un número que no es número se rechaza", () => {
    const r = construirDeclaracionServida([entrada("EXACT", {}, Number.NaN)]);
    expect(r.ok).toBe(false);
  });
});

describe("determinismo", () => {
  it("dos corridas producen el mismo JSON byte a byte", () => {
    const entradas = [
      entrada("MOST"),
      entrada("HALF", { servingRecordItemId: "33333333-3333-4333-8333-333333333333", sortOrder: 2 }),
      entrada("EXACT", { servingRecordItemId: "44444444-4444-4444-8444-444444444444", sortOrder: 3 }, 12.3456),
    ];
    const a = JSON.stringify(construirDeclaracionServida(entradas));
    const b = JSON.stringify(construirDeclaracionServida(entradas));
    expect(a).toBe(b);
  });

  it("el orden de los renglones lo manda sort_order, no el orden en que llegaron", () => {
    const resultado = items([
      entrada("ALL", { servingRecordItemId: "55555555-5555-4555-8555-555555555555", label: "Postre", sortOrder: 9 }),
      entrada("ALL", { label: "Arroz", sortOrder: 1 }),
    ]);
    expect(resultado.map((i) => i.label)).toEqual(["Arroz", "Postre"]);
    expect(resultado.map((i) => i.sort_order)).toEqual([1, 2]);
  });
});

describe("comida que no salió de esta despensa", () => {
  it("acepta nombre y extent, y nada más", () => {
    const r = construirDeclaracionLibre([{ label: "  Torta de cumpleaños ", extent: "HALF" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([{ label: "Torta de cumpleaños", extent: "HALF", sort_order: 1 }]);
  });

  it("no deja anotar gramos de algo que nadie midió", () => {
    const r = construirDeclaracionLibre([{ label: "Completo", extent: "EXACT" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problemas.join(" ")).toContain("Completo");
  });

  it("exige decir QUÉ se comió, igual que el RPC", () => {
    const r = construirDeclaracionLibre([{ label: "   ", extent: "ALL" }]);
    expect(r.ok).toBe(false);
  });
});

describe("cómo se lee un renglón ya declarado", () => {
  it("sin número se dice sin número, jamás con un cero", () => {
    const texto = textoCantidad({ extent: "UNKNOWN", quantity: null, unit: null, quantityIsDeclared: false });
    expect(texto).toBe("sin número anotado");
    expect(texto).not.toContain("0");
  });

  it("'nada' se lee como nada", () => {
    expect(textoCantidad({ extent: "NONE", quantity: null, unit: null, quantityIsDeclared: false })).toBe(
      "no comió",
    );
  });

  it("el número siempre viaja con su procedencia", () => {
    expect(textoCantidad({ extent: "EXACT", quantity: 150, unit: "G", quantityIsDeclared: true })).toContain(
      "lo dijo una persona",
    );
    expect(textoCantidad({ extent: "HALF", quantity: 100, unit: "G", quantityIsDeclared: false })).toContain(
      "estimado",
    );
  });
});

// ---------------------------------------------------------------------------
// Guardas estructurales de la pantalla
// ---------------------------------------------------------------------------

const DIR = __dirname;

function fuentes(): { rel: string; texto: string }[] {
  const out: { rel: string; texto: string }[] = [];
  for (const nombre of readdirSync(DIR)) {
    const ruta = path.join(DIR, nombre);
    if (statSync(ruta).isDirectory()) continue;
    if (!/\.tsx?$/.test(nombre) || /\.test\./.test(nombre)) continue;
    out.push({ rel: nombre, texto: readFileSync(ruta, "utf8") });
  }
  return out;
}

describe("guardas de /comi", () => {
  it("el motor no tiene reloj propio: la fecha entra por input", () => {
    const texto = readFileSync(path.join(DIR, "extent.ts"), "utf8");
    expect(/new Date\(\)|Date\.now\(\)|Math\.random\(\)/.test(texto)).toBe(false);
  });

  it("ningún archivo de la pantalla convierte un desconocido en cero o en vacío", () => {
    const ofensas: string[] = [];
    for (const { rel, texto } of fuentes()) {
      for (const m of texto.matchAll(/\?\?\s*(?:0(?![.\d])|\[\])|\|\|\s*(?:0(?![.\d])|\[\])/g)) {
        const linea = texto.slice(0, m.index).split("\n").length;
        ofensas.push(`${rel}:${linea} → ${m[0]}`);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("la pantalla de lo que se comió NO toca nada clínico (§44/§45)", () => {
    const ofensas: string[] = [];
    for (const { rel, texto } of fuentes()) {
      if (
        /@\/domain\/clinical|@\/app\/health|lab_observations|lab_documents|member_clinical_restrictions|biomarker|glucose|glicemia|diagn[oó]stico/i.test(
          texto,
        )
      ) {
        ofensas.push(rel);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("no hay lenguaje de premio ni de castigo: se anota lo que pasó, no se califica", () => {
    // Anotar lo que se comió no puede volverse un juego con puntaje: el día que
    // la pantalla felicite o rete, la familia empieza a anotar lo que queda
    // bien en vez de lo que pasó, y el eje ACTUAL deja de ser real.
    const prohibidas =
      /\bracha\b|\bstreak\b|\bquemar\b|\bcompensar\b|te pasaste|\bayuno\b|penalizaci|\bpuntaje\b|\bscore\b|meta cumplida/i;
    const ofensas = fuentes()
      .filter((f) => prohibidas.test(f.texto))
      .map((f) => f.rel);
    expect(ofensas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Los DOS caminos de la pantalla contestan lo mismo
// ---------------------------------------------------------------------------

/**
 * El hallazgo que cierra este bloque: dentro de la MISMA pantalla, el camino
 * manual y el de un toque contestaban distinto al mismo hecho.
 *
 *   · manual → `renglonDesdeServido` con `tope <= 0` deja la cantidad en NULL,
 *     porque un 0 es la afirmación "midieron y dio cero";
 *   · un toque → `assume_intake_from_plan` escribe `quantity = deducted` sin
 *     mirar el faltante, o sea un CERO DURO para ese mismo renglón.
 *
 * Y el único freno del botón miraba la merma, no el faltante: se ofrecía justo
 * en el caso que su propio motor se niega a numerar.
 */
describe("puedeDarsePorComida: un solo dueño de «se comió todo»", () => {
  const con = (cambios: Partial<RenglonServido>): RenglonServido => ({ ...SERVIDO, ...cambios });

  it("una porción entera y sin merma sí se puede dar por comida", () => {
    expect(puedeDarsePorComida([con({})])).toEqual({ puede: true });
  });

  it("la despensa que no entregó nada BLOQUEA el botón de un toque", () => {
    // `deducted = 0` con `served > 0` se alcanza con solo tener el ingrediente
    // sin lote: `deducted + shortfall = served` (invariante de la 0036).
    const r = con({ servido: 200, entregado: 0 });
    const respuesta = puedeDarsePorComida([r]);
    expect(respuesta.puede).toBe(false);
    if (respuesta.puede) throw new Error("inalcanzable");
    expect(respuesta.motivo).toBe("DESPENSA_NO_ENTREGO");
    expect(respuesta.renglones).toEqual(["Arroz"]);
  });

  it("un solo renglón sin entregar bloquea la porción entera", () => {
    // El supuesto escribe un renglón POR RENGLÓN: basta uno en cero para que
    // la porción traiga un número que nadie midió.
    const respuesta = puedeDarsePorComida([
      con({}),
      con({ servingRecordItemId: "33333333-3333-4333-8333-333333333333", label: "Pollo", entregado: 0 }),
    ]);
    expect(respuesta.puede).toBe(false);
    if (respuesta.puede) throw new Error("inalcanzable");
    expect(respuesta.renglones).toEqual(["Pollo"]);
  });

  it("LOS DOS CAMINOS DICEN LO MISMO: si se puede asumir, el camino manual sí produce número", () => {
    // Ésta es la afirmación de coherencia, y es la que se rompe si se revierte
    // el arreglo: cuando el botón se ofrece, marcar «Todo» a mano tiene que dar
    // un número en TODOS los renglones. Si alguno sale sin número, los dos
    // caminos están contestando distinto a la misma pregunta.
    const casos: RenglonServido[][] = [
      [con({})],
      [con({ servido: 200, entregado: 150 })],
      [con({ botado: MERMA_QUE_IMPIDE_ASUMIR })],
      [con({}), con({ servingRecordItemId: "33333333-3333-4333-8333-333333333333", label: "Pollo" })],
      [con({ servido: 200, entregado: 0 })],
      [con({ servido: 200, entregado: 200, botado: 200 })],
      [con({ botado: 0.5 })],
      [],
    ];

    for (const renglones of casos) {
      const asumible = puedeDarsePorComida(renglones);
      if (!asumible.puede) continue;
      const declaracion = construirDeclaracionServida(
        renglones.map((servido) => ({ servido, extent: "ALL" as Extent, cantidadExacta: null })),
      );
      expect(declaracion.ok).toBe(true);
      if (!declaracion.ok) throw new Error("inalcanzable");
      for (const item of declaracion.items) {
        expect(
          item.quantity,
          `«${item.label}» se puede dar por comido pero el camino manual no le pone número`,
        ).not.toBeUndefined();
      }
    }
  });

  it("el umbral de merma es EL MISMO que el del servidor, no uno más estricto", () => {
    // 0038:1005 rechaza con `discarded_quantity > 0.001`. La pantalla escondía
    // el botón con `botado > 0`: con la merma mínima representable en
    // numeric(12,3) escondía un botón que el servidor sí habría aceptado.
    expect(MERMA_QUE_IMPIDE_ASUMIR).toBe(0.001);
    expect(puedeDarsePorComida([con({ botado: 0.001 })]).puede).toBe(true);
    const rechazado = puedeDarsePorComida([con({ botado: 0.002 })]);
    expect(rechazado.puede).toBe(false);
    if (rechazado.puede) throw new Error("inalcanzable");
    expect(rechazado.motivo).toBe("MERMA_DECLARADA");
  });

  it("una porción sin renglones no se da por comida: no hay nada que asumir", () => {
    const respuesta = puedeDarsePorComida([]);
    expect(respuesta.puede).toBe(false);
    if (respuesta.puede) throw new Error("inalcanzable");
    expect(respuesta.motivo).toBe("SIN_RENGLONES");
  });

  it("el texto del bloqueo dice qué hacer y no muestra un cero", () => {
    const respuesta = puedeDarsePorComida([con({ servido: 200, entregado: 0 })]);
    if (respuesta.puede) throw new Error("inalcanzable");
    expect(respuesta.texto).toContain("dinos cuánto comió");
    expect(respuesta.texto).not.toMatch(/(^|[^\d])0([^\d]|$)/);
  });
});

// ---------------------------------------------------------------------------
// Guardas del LECTOR: determinismo y un solo dueño del día civil
// ---------------------------------------------------------------------------

describe("guardas del lector de la historia", () => {
  const lector = () => readFileSync(path.join(DIR, "historia-queries.ts"), "utf8");

  it("TODA consulta de LISTA del lector ordena sus filas", () => {
    // Postgres no promete orden sin `order by`, y estas filas son los sumandos
    // de una suma en punto flotante, que no es asociativa: sin orden, dos
    // corridas iguales devuelven JSON distinto y el motor de arriba es
    // determinista POR CONTRATO. Es el mismo defecto que ya se cerró en otra
    // tabla; acá queda vigilado para que no vuelva.
    //
    // Las únicas exentas son las que la base garantiza de UNA FILA por llave
    // única (`households.id`, `household_members.id`,
    // `member_tracking_settings.member_id` que es PK, `meal_patterns.member_id`
    // que es UNIQUE) y `meal_pattern_slots`, que el lector ordena en memoria
    // por (sort_order, meal_type) apenas la recibe.
    const UNA_FILA_POR_LLAVE = [
      "households",
      "household_members",
      "member_tracking_settings",
      "meal_patterns",
      "meal_pattern_slots",
    ];
    // Los comentarios se sacan antes de mirar: un punto y coma dentro de una
    // explicación cortaba la consulta en dos y el guard se volvía ciego.
    const texto = lector().replace(/^\s*\/\/.*$/gm, "");
    const sinOrden: string[] = [];
    for (const m of texto.matchAll(/\.from\("([a-z_]+)"\)[\s\S]*?;/g)) {
      const tabla = m[1]!;
      if (UNA_FILA_POR_LLAVE.includes(tabla)) continue;
      if (!m[0].includes(".order(")) sinOrden.push(tabla);
    }
    expect(sinOrden).toEqual([]);
    // Y la consulta genérica de renglones hijos (`cargarRenglones`) también,
    // que es la que trae los sumandos de verdad.
    expect(/\.from\(tabla\)[\s\S]*?\.order\(/.test(texto)).toBe(true);
  });

  it("la zona horaria tiene UN dueño: nadie la escribe a mano en la pantalla", () => {
    // `hogar?.timezone ?? "America/Santiago"` no era un respaldo: el
    // `.maybeSingle()` devuelve null también cuando la RLS no dejó ver la fila,
    // así que un "no se pudo leer" se convertía en un dato. El respaldo vive en
    // `DEFAULT_TIME_ZONE` y la pregunta la contesta `diaCivilDelHogar`.
    const ofensas = fuentes()
      .filter((f) => /"America\/[A-Za-z_]+"|'America\/[A-Za-z_]+'/.test(f.texto))
      .map((f) => f.rel);
    expect(ofensas).toEqual([]);
  });

  it("la server action pregunta ANTES de asumir, con el mismo dueño de la regla", () => {
    // Esconder el botón no basta: una pestaña vieja puede llamar igual a la
    // acción, y el RPC de la 0038 —ya aplicada, congelada— escribe el cero sin
    // preguntar. La última pared dentro de la aplicación es la server action.
    const texto = readFileSync(path.join(DIR, "actions.ts"), "utf8");
    const cuerpo = texto
      .slice(texto.indexOf("export async function darPorComido"))
      .replace(/^\s*\/\/.*$/gm, "");
    const guarda = cuerpo.indexOf("puedeDarsePorComida");
    const llamada = cuerpo.indexOf('.rpc("assume_intake_from_plan"');
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(llamada);
  });

  it("el lector SÍ lee la procedencia del registro", () => {
    // `columnsOf` deriva el `.select()` del schema de fila: una columna que no
    // se declara ahí no se lee nunca. Mientras faltó `source`, un supuesto del
    // plan y una declaración humana llegaban al motor como el mismo hecho.
    expect(lector()).toContain("source: z.enum(ORIGENES_DECLARACION)");
  });
});
