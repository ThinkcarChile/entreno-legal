import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SPRINT 14 — GUARDA ESTRUCTURAL DEL DINERO. Corre en CI, no en la cabeza de
 * nadie.
 *
 * EL ALCANCE VA POR SÍMBOLO, NO POR CARPETA. La primera versión del diseño
 * vigilaba `domain/finance/**` y `app/finanzas/**`, y con eso dejaba afuera
 * justo el código viejo que este sprint reapunta a los montos nuevos
 * (`domain/stock/engine.ts`, `app/pantry/...`, `app/stock/queries.ts`). Acá
 * entra a la lista cualquier archivo que TOQUE plata: que importe del dominio
 * financiero, que nombre una tabla de dinero, o que mencione una columna
 * `*_minor`. Un guardián que reconoce la forma del último bug no sirve para el
 * siguiente.
 *
 * Y vigila las MIGRACIONES, que era el otro hueco: del lado SQL viven los
 * `coalesce(x_minor, 0)` y los `sum(x_minor)` que convierten el desconocido en
 * plata sin que ningún regex de TypeScript los vea.
 */

const SRC = path.resolve(__dirname, "..");
const MIGRACIONES = path.resolve(__dirname, "../../../supabase/migrations");

function archivos(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivos(ruta));
    // Los tests quedan fuera: ahí SÍ se escriben a mano los valores prohibidos
    // para demostrar que la guarda los ataja.
    else if (/\.tsx?$/.test(nombre) && !/\.test\./.test(nombre)) out.push(ruta);
  }
  return out;
}

/** Un archivo "toca plata" si importa el dominio financiero o nombra dinero. */
const TOCA_PLATA =
  /@\/domain\/finance|from "\.\/money"|_minor\b|lot_valuations|cost_allocations|price_observations|purchase_items|purchase_receipts|purchase_charges|household_food_budgets|MoneyOrUnknown|KnownSubtotal/;

function archivosConPlata(): Array<{ rel: string; fuente: string }> {
  const out: Array<{ rel: string; fuente: string }> = [];
  for (const ruta of archivos(SRC)) {
    const fuente = readFileSync(ruta, "utf8");
    if (TOCA_PLATA.test(fuente)) out.push({ rel: path.relative(SRC, ruta), fuente });
  }
  return out;
}

function ofensas(patron: RegExp, descarte?: RegExp): string[] {
  const encontradas: string[] = [];
  for (const { rel, fuente } of archivosConPlata()) {
    for (const m of fuente.matchAll(patron)) {
      const antes = fuente.slice(0, m.index);
      const linea = antes.split("\n").length;
      const texto = fuente.split("\n")[linea - 1] ?? "";
      // Los comentarios explican POR QUÉ está prohibido y nombran el patrón:
      // castigar eso obligaría a no poder escribir la regla al lado del código.
      if (/^\s*(\*|\/\/|--)/.test(texto)) continue;
      if (descarte !== undefined && descarte.test(texto)) continue;
      encontradas.push(`${rel}:${linea} · ${texto.trim().slice(0, 100)}`);
    }
  }
  return encontradas;
}

describe("el dinero no se convierte en cero por descuido (alcance por símbolo)", () => {
  it("hay archivos bajo vigilancia: la guarda no puede estar mirando el vacío", () => {
    const vigilados = archivosConPlata().map((a) => a.rel);
    expect(vigilados).toContain(path.join("domain", "finance", "money.ts"));
    expect(vigilados.length).toBeGreaterThan(1);
  });

  it("ningún archivo de plata usa ?? 0, || 0 ni || []", () => {
    expect(ofensas(/\?\?\s*0(?![.\d])|\|\|\s*0(?![.\d])|\|\|\s*\[\]/g)).toEqual([]);
  });

  it("ningún archivo de plata usa toFixed, parseFloat o parseInt", () => {
    expect(ofensas(/\btoFixed\s*\(|\bparseFloat\s*\(|\bparseInt\s*\(/g)).toEqual([]);
  });

  it("ningún schema de plata usa z.coerce.number() ni nullableNumeric", () => {
    expect(ofensas(/z\.coerce\.number\s*\(/g)).toEqual([]);
    expect(ofensas(/_minor\s*:\s*nullableNumeric|nullableNumeric[^\n]*_minor/g)).toEqual([]);
  });

  it("ningún catch vacío se traga un error de una pantalla de dinero", () => {
    expect(ofensas(/catch\s*(\([^)]*\))?\s*\{\s*\}/g)).toEqual([]);
  });
});

/**
 * GUARDA DE FUENTE: UN MONTO SE PINTA POR `<Monto>` O NO SE PINTA.
 *
 * El componente y sus cuatro ramas existían, y la pantalla de plata igual
 * escribía `−{formatMoney(b.known)}` a mano sobre un SUBTOTAL: con la categoría
 * entera sin costear salía «−$0», un cero conocido donde la verdad era «no lo
 * sabemos». Tener el componente correcto no sirve si al lado queda abierto el
 * camino corto; esta guarda cierra el camino corto.
 *
 * Los dos archivos autorizados son el formateador (donde las funciones VIVEN) y
 * `<Monto>` (el único componente que decide qué rama se muestra). Cualquier
 * otro archivo que llame a un formateador de plata sale acá con nombre y línea.
 */
const FORMATEADORES_AUTORIZADOS = [
  path.join("lib", "money-format.ts"),
  path.join("components", "Monto.tsx"),
];

/** `formatMoney(`, `formatDelta(`, `formatAtLeast(`, `formatAtLeastCounted(`. */
const LLAMADA_A_FORMATEADOR = /\bformat(?:Money|Delta|AtLeast|AtLeastCounted)\s*\(/g;

describe("la plata se pinta por <Monto>, nunca con el formateador a mano", () => {
  it("los dos archivos autorizados existen (la guarda no apunta al vacío)", () => {
    const todos = archivos(SRC).map((r) => path.relative(SRC, r));
    for (const permitido of FORMATEADORES_AUTORIZADOS) {
      expect(todos, `${permitido} tiene que existir`).toContain(permitido);
    }
  });

  it("la guarda reconoce la llamada que dejó pasar el «−$0» del panel", () => {
    // La línea EXACTA que tenía PanelFinanzas.tsx. Si el regex dejara de
    // atraparla, el resto de este describe sería un verde vacío.
    const linea = "                −{formatMoney(b.known)}";
    expect(new RegExp(LLAMADA_A_FORMATEADOR.source).test(linea)).toBe(true);
  });

  it("ninguna pantalla llama a un formateador de plata por su cuenta", () => {
    const encontradas: string[] = [];
    for (const ruta of archivos(SRC)) {
      const rel = path.relative(SRC, ruta);
      if (FORMATEADORES_AUTORIZADOS.includes(rel)) continue;
      const fuente = readFileSync(ruta, "utf8");
      const lineas = fuente.split("\n");
      for (const m of fuente.matchAll(LLAMADA_A_FORMATEADOR)) {
        const numero = fuente.slice(0, m.index).split("\n").length;
        const texto = lineas[numero - 1] ?? "";
        // Los comentarios NOMBRAN el patrón prohibido para explicar por qué lo
        // está: castigarlos obligaría a no poder escribir la regla al lado.
        if (/^\s*(\*|\/\/)/.test(texto)) continue;
        encontradas.push(`${rel}:${numero} · ${texto.trim().slice(0, 100)}`);
      }
    }
    expect(encontradas).toEqual([]);
  });
});

/** Las migraciones de este sprint en adelante: 0042 y las que vengan. */
function migracionesDeFinanzas(): Array<{ nombre: string; fuente: string }> {
  return readdirSync(MIGRACIONES)
    .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 4)) >= 42)
    .sort()
    .map((f) => ({ nombre: f, fuente: readFileSync(path.join(MIGRACIONES, f), "utf8") }));
}

/**
 * Lo que hace legítimo un `coalesce(x_minor, 0)` o un `sum(x_minor)` es que
 * ALGUIEN, ahí mismo, se haya hecho cargo del desconocido: un `bool_or(... is
 * null)` que apaga el total, un `value_status` que lo declara, un raise cuando
 * el dato falta. Lo que esta guarda persigue es la suma que NO menciona el
 * hueco en ninguna parte: la que devuelve un número que se lee como completo.
 */
const SE_HACE_CARGO =
  /bool_or\s*\(|is\s+null|unknown|app\.sum_money|money_known|value_status|raise/i;

function ofensasSql(patron: RegExp, exigirCargo = true): string[] {
  const encontradas: string[] = [];
  for (const { nombre, fuente } of migracionesDeFinanzas()) {
    const lineas = fuente.split("\n");
    for (let i = 0; i < lineas.length; i += 1) {
      const linea = lineas[i] ?? "";
      // Comentarios de SQL y de bloque: ahí se explica la regla.
      if (/^\s*(--|\*|\/\*)/.test(linea)) continue;
      if (!patron.test(linea)) continue;
      if (exigirCargo) {
        const ventana = lineas.slice(Math.max(0, i - 12), i + 13).join("\n");
        if (SE_HACE_CARGO.test(ventana)) continue;
      }
      encontradas.push(`${nombre}:${i + 1} · ${linea.trim().slice(0, 100)}`);
    }
  }
  return encontradas;
}

describe("del lado SQL el desconocido tampoco se convierte en plata", () => {
  it("hay migraciones de finanzas bajo vigilancia", () => {
    expect(migracionesDeFinanzas().map((m) => m.nombre)).toContain(
      "0042_finance_foundations.sql",
    );
  });

  it("nadie escribe coalesce(x_minor, 0): el hueco no vale cero pesos", () => {
    expect(ofensasSql(/coalesce\s*\(\s*[a-z0-9_."]*_minor\s*,\s*0/i)).toEqual([]);
  });

  it("nadie suma dinero con sum(): sum() ignora los NULL y miente", () => {
    // La única suma legítima es app.sum_money, que devuelve el conteo de
    // desconocidos junto con el subtotal.
    expect(ofensasSql(/(?<!app\.)\bsum\s*\(\s*[a-z0-9_."]*(_minor|acquisition_value)/i)).toEqual([]);
  });

  it("nadie aplana un monto con greatest(..., 0): eso es una fuga muda", () => {
    // Sin exención posible: aplanar un monto contra cero se come la diferencia
    // y nadie se entera. Es exactamente lo que hacía split_lot hasta la 0042.
    expect(
      ofensasSql(/greatest\s*\([^)]*(_minor|acquisition_value)[^)]*,\s*0\s*\)/i, false),
    ).toEqual([]);
  });

  it("ningún check de dinero usa notación exponencial ni casts a float", () => {
    // `1e15` es un literal double precision: la guarda escrita para impedir el
    // float terminaría comparando el bigint EN COMA FLOTANTE.
    expect(ofensasSql(/_minor[^\n]*\b\d+e\d+\b|\b\d+e\d+\b[^\n]*_minor/i, false)).toEqual([]);
    expect(
      ofensasSql(/(_minor|acquisition_value)[^\n]*::\s*(float|double precision|real)\b/i, false),
    ).toEqual([]);
  });
});
