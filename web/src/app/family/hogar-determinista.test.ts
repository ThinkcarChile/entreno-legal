import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN: ninguna consulta que ELIJA un hogar para el usuario puede depender
 * del orden físico de las filas.
 *
 * Defecto F-1. `household_members` filtrado por `user_id` devuelve varias filas
 * para quien cocina en dos casas. Un `LIMIT 1` sin `ORDER BY` deja que el
 * planificador de PostgreSQL decida cuál entrega, y esa decisión cambia con el
 * plan, con el orden físico de las filas y con el último VACUUM: la misma
 * persona veía una casa hoy y la otra mañana, con el stock, el plan y las
 * porciones de la familia equivocada.
 *
 * La propiedad se vigila en dos redes, y LAS DOS miran la cadena de llamadas
 * COMPLETA de cada consulta (parseada contando paréntesis y saltando cadenas
 * de texto), nunca una ventana de texto alrededor del `.from(`:
 *
 *  Red 1 — un solo dueño: resolver "¿cuál es MI hogar?" (household_members por
 *  `user_id` SIN anclar a un hogar conocido) solo puede hacerlo
 *  `current-household.ts`. La regla del desempate no se copia.
 *
 *  Red 2 — nada de monedas al aire: toda lectura de UNA fila de `households` o
 *  `household_members` tiene que ser determinista por construcción: con
 *  `.order(...)`, anclada por clave primaria, o anclada por el índice único
 *  (household_id, user_id) de la migración 0001.
 *
 * Historia que obligó a parsear de verdad: la versión anterior recortaba la
 * "cadena" hasta el primer `;` después del `.from(`. Dentro de un
 * `Promise.all([...])` ese `;` cierra la sentencia ENTERA, así que la ventana
 * se tragaba a las consultas hermanas: una hermana con `.order(` hacía pasar
 * un `households ... limit(1)` pelado (el F-1 original), y una hermana con
 * `.eq("id", x)` le PRESTABA el ancla a la consulta de al lado. Las tres
 * formas que encontró el crítico viven abajo como fixtures permanentes.
 *
 * Límite declarado: el parser sigue UNA cadena fluida. Una consulta armada en
 * dos sentencias (`let q = db.from(...); q = q.eq(...)`) no se puede analizar
 * así; hoy no existe esa forma en el árbol y si aparece hay que traerla a la
 * cadena fluida o al dueño.
 */

/* ------------------------------------------------------------------------- *
 * Parser de cadenas fluidas
 * ------------------------------------------------------------------------- */

/** Salta espacio en blanco y comentarios (de línea y de bloque) desde `i`. */
function saltarBlanco(texto: string, i: number): number {
  for (;;) {
    while (i < texto.length && /\s/.test(texto.charAt(i))) i += 1;
    if (texto.startsWith("//", i)) {
      const fin = texto.indexOf("\n", i);
      i = fin === -1 ? texto.length : fin + 1;
    } else if (texto.startsWith("/*", i)) {
      const fin = texto.indexOf("*/", i + 2);
      i = fin === -1 ? texto.length : fin + 2;
    } else {
      return i;
    }
  }
}

/**
 * Salta un literal de cadena que empieza en la comilla `texto[i]`; devuelve el
 * índice siguiente al cierre. Respeta `\` como escape. Un template con un
 * backtick DENTRO de un `${...}` lo descuadraría; los argumentos de Supabase
 * en este repo son cadenas planas y ese caso no existe.
 */
function saltarCadenaLiteral(texto: string, i: number): number {
  const comilla = texto[i];
  i += 1;
  while (i < texto.length) {
    if (texto[i] === "\\") i += 2;
    else if (texto[i] === comilla) return i + 1;
    else i += 1;
  }
  return i;
}

/**
 * Desde el índice inmediatamente DESPUÉS de un `(`, devuelve el índice
 * inmediatamente después del `)` que lo cierra. Cuenta paréntesis y salta
 * literales de cadena y comentarios, así ni un `select("count(*)")` ni un
 * `await` de otra consulta entera metido de argumento descuadran la cuenta.
 */
function saltarArgumentos(texto: string, i: number): number {
  let nivel = 1;
  while (i < texto.length && nivel > 0) {
    const c = texto[i];
    if (c === '"' || c === "'" || c === "`") {
      i = saltarCadenaLiteral(texto, i);
    } else if (texto.startsWith("//", i) || texto.startsWith("/*", i)) {
      i = saltarBlanco(texto, i);
    } else {
      if (c === "(") nivel += 1;
      else if (c === ")") nivel -= 1;
      i += 1;
    }
  }
  return i;
}

/**
 * Extrae UNA cadena fluida completa a partir del `.from(` que empieza en
 * `desde`: consume sus argumentos balanceados y sigue mientras venga
 * `.metodo(...)`. Se detiene donde la cadena termina de verdad — la coma de un
 * `Promise.all`, un `]`, un `;` — así que las consultas hermanas quedan FUERA
 * y no pueden prestar ni su `.order(` ni su `.eq("id", ...)`.
 */
function extraerCadena(texto: string, desde: number): string {
  let i = texto.indexOf("(", desde);
  if (i === -1) return texto.slice(desde);
  i = saltarArgumentos(texto, i + 1);
  for (;;) {
    const j = saltarBlanco(texto, i);
    const m = /^\.\s*[A-Za-z_$][\w$]*\s*\(/.exec(texto.slice(j, j + 80));
    if (!m) break;
    i = saltarArgumentos(texto, j + m[0].length);
  }
  return texto.slice(desde, i);
}

interface CadenaDeHogar {
  tabla: "households" | "household_members";
  cadena: string;
  linea: number;
}

const INICIO = /\.from\(\s*"(households|household_members)"\s*\)/g;

/** Todas las cadenas fluidas del texto que parten de una tabla de hogares. */
function cadenasDeHogar(texto: string): CadenaDeHogar[] {
  const out: CadenaDeHogar[] = [];
  for (const m of texto.matchAll(INICIO)) {
    out.push({
      tabla: m[1] as CadenaDeHogar["tabla"],
      cadena: extraerCadena(texto, m.index),
      linea: texto.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/**
 * Valor del primer `.eq("<columna>", …)` de la cadena, o `null` si no existe.
 * El valor se extrae contando paréntesis (puede traer un `await` con
 * paréntesis adentro), no con un `[^)]*`.
 */
function valorDeEq(cadena: string, columna: string): string | null {
  const inicio = new RegExp(String.raw`\.eq\(\s*"${columna}"\s*,`).exec(cadena);
  if (!inicio) return null;
  const desde = inicio.index + inicio[0].length;
  const fin = saltarArgumentos(cadena, desde);
  // El último carácter consumido fue el `)` que cierra el `.eq(`; no es valor.
  return cadena.slice(desde, fin - 1).trim();
}

/* ------------------------------------------------------------------------- *
 * Las dos redes, como funciones puras sobre una cadena
 * ------------------------------------------------------------------------- */

/**
 * Un ancla que puede quedar en nada NO ancla. `.eq("id", x ?? "")` contra una
 * columna `uuid` no devuelve "ningún hogar": revienta con 22P02 (sintaxis de
 * entrada inválida para uuid), y si alguien tapa ese error queda tan perdido
 * como con el `limit(1)` suelto que vinimos a matar. Si el id puede faltar,
 * eso es un DESCONOCIDO: se declara y no se consulta, nunca se rellena con "".
 */
const RELLENO = /\?\?|\|\|/;
const CADENA_VACIA = /^(""|''|``)$/;

function motivoAnclaMala(valor: string): string | null {
  if (RELLENO.test(valor) || CADENA_VACIA.test(valor)) {
    return (
      `se ancla con \`${valor}\`, que puede quedar en nada. Anclar a cadena ` +
      `vacía no es anclar: contra una columna uuid es un 22P02 seguro. Si el ` +
      `id puede faltar, decláralo y no consultes.`
    );
  }
  return null;
}

/**
 * Red 1: la cadena resuelve "¿cuál es MI hogar?" a partir del usuario.
 * Con `.eq("household_id", …)` en la MISMA cadena no hay nada que desempatar:
 * el índice único (household_id, user_id) de la 0001 garantiza a lo más una
 * fila, y esa consulta responde otra pregunta ("¿tengo ficha EN ESTE hogar?"),
 * que es legítima fuera del dueño.
 */
function eligeHogarDesdeElUsuario(c: CadenaDeHogar): boolean {
  return (
    c.tabla === "household_members" &&
    valorDeEq(c.cadena, "user_id") !== null &&
    valorDeEq(c.cadena, "household_id") === null
  );
}

const UNA_FILA = /\.maybeSingle\(\)|\.single\(\)|\.limit\(\s*1\s*\)/;
const ORDENADA = /\.order\(/;

/**
 * Red 2: devuelve el motivo por el que la cadena es una moneda al aire, o
 * `null` si es determinista. Una lectura de una sola fila es determinista si
 * trae `.order(...)`, si está anclada por clave primaria (`.eq("id", …)` con
 * un valor de verdad) o si está anclada por el índice único
 * (household_id, user_id) de `household_members`.
 */
function motivoSinAnclar(c: CadenaDeHogar): string | null {
  if (!UNA_FILA.test(c.cadena) || ORDENADA.test(c.cadena)) return null;

  const porId = valorDeEq(c.cadena, "id");
  if (porId !== null) return motivoAnclaMala(porId);

  if (c.tabla === "household_members") {
    const hogar = valorDeEq(c.cadena, "household_id");
    const usuario = valorDeEq(c.cadena, "user_id");
    if (hogar !== null && usuario !== null) {
      return motivoAnclaMala(hogar) ?? motivoAnclaMala(usuario);
    }
  }

  return (
    `lee una sola fila de "${c.tabla}" sin .order(...) ni ancla por clave ` +
    `única: el hogar que salga depende del planificador`
  );
}

/* ------------------------------------------------------------------------- *
 * El analizador está bajo prueba: las mutaciones del crítico son fixtures
 * ------------------------------------------------------------------------- */

function infraccionesRed2(texto: string): string[] {
  const out: string[] = [];
  for (const c of cadenasDeHogar(texto)) {
    const motivo = motivoSinAnclar(c);
    if (motivo !== null) out.push(`línea ${c.linea} → ${motivo}`);
  }
  return out;
}

describe("el analizador ve la cadena completa, no una ventana de texto", () => {
  it("una hermana con .order() en el Promise.all NO tapa al households pelado", () => {
    // Mutación A del crítico: la primera línea es el F-1 original.
    const texto = `
      const [hogar, recetas] = await Promise.all([
        db.from("households").select("id, timezone").limit(1).maybeSingle(),
        db.from("recipes").select("id").order("created_at"),
      ]);
    `;
    const inf = infraccionesRed2(texto);
    expect(inf).toHaveLength(1);
    expect(inf[0]).toContain('una sola fila de "households"');
  });

  it("una hermana anclada NO le presta su .eq(\"id\", ...) a la de al lado", () => {
    // Mutación B del crítico: el ancla está en la consulta de ABAJO.
    const texto = `
      const [hogar, plan] = await Promise.all([
        db.from("households").select("timezone").limit(1).maybeSingle(),
        db.from("meal_plans").select("id").eq("id", planId).maybeSingle(),
      ]);
    `;
    expect(infraccionesRed2(texto)).toHaveLength(1);
  });

  it('el ancla `?? ""` se caza aunque haya una hermana ordenada', () => {
    // Mutación C del crítico: el relleno escondido en un Promise.all.
    const texto = `
      const [hogar, recetas] = await Promise.all([
        db.from("households").select("timezone").eq("id", x ?? "").maybeSingle(),
        db.from("recipes").select("id").order("created_at"),
      ]);
    `;
    const inf = infraccionesRed2(texto);
    expect(inf).toHaveLength(1);
    expect(inf[0]).toContain('`x ?? ""`');
  });

  it("una cadena bien anclada por clave primaria pasa, con o sin hermanas", () => {
    const texto = `
      const [hogar, plan] = await Promise.all([
        db.from("households").select("timezone").eq("id", hogarId).maybeSingle(),
        db.from("meal_plans").select("id").order("created_at"),
      ]);
    `;
    expect(infraccionesRed2(texto)).toEqual([]);
  });

  it("el índice único (household_id, user_id) ancla aunque no haya .order()", () => {
    // La forma de app/health/actions.ts sin su .order: sigue siendo a lo más
    // una fila por la 0001, así que no depende del planificador.
    const texto = `
      const { data } = await db
        .from("household_members")
        .select("id")
        .eq("household_id", objetivo.household_id)
        .eq("user_id", user.id)
        .eq("is_active", true)
        .maybeSingle();
    `;
    expect(infraccionesRed2(texto)).toEqual([]);
    expect(cadenasDeHogar(texto).some(eligeHogarDesdeElUsuario)).toBe(false);
  });

  it("household_members por user_id sin hogar conocido ES elegir hogar", () => {
    const texto = `
      const { data } = await db
        .from("household_members")
        .select("household_id")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
    `;
    // Determinista (red 2 calla) pero copia la regla del dueño (red 1 acusa).
    expect(infraccionesRed2(texto)).toEqual([]);
    expect(cadenasDeHogar(texto).some(eligeHogarDesdeElUsuario)).toBe(true);
  });

  it("el parser no se descuadra con paréntesis dentro de los argumentos", () => {
    const texto = `
      db.from("household_members").select("id")
        .eq("id", (await idDe(user)).id).maybeSingle();
    `;
    expect(infraccionesRed2(texto)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- *
 * El barrido sobre el árbol real
 * ------------------------------------------------------------------------- */

/**
 * TODO `web/src`, no solo `web/src/app`: la copia que reintroduzca el defecto
 * puede nacer en `src/lib`, `src/domain` o `src/components` igual que en una
 * pantalla. Es el alcance que ya usan `gate-schema-parity.test.ts` y
 * `salud-privacidad.test.ts`.
 */
const SRC = path.resolve(__dirname, "../..");

/** Único módulo autorizado a resolver "¿cuál es MI hogar?", relativo a `src`. */
const DUENO = "app/family/current-household.ts";

function archivosDeSrc(): string[] {
  return globSync("**/*.{ts,tsx}", { cwd: SRC })
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
}

describe("elección de hogar determinista", () => {
  it("solo current-household elige el hogar a partir del usuario", () => {
    const infractores: string[] = [];
    for (const rel of archivosDeSrc()) {
      if (rel === DUENO) continue;
      const texto = readFileSync(path.join(SRC, rel), "utf8");
      for (const c of cadenasDeHogar(texto)) {
        if (eligeHogarDesdeElUsuario(c)) infractores.push(`${rel}:${c.linea}`);
      }
    }

    expect(
      infractores,
      "Estas consultas vuelven a elegir el hogar a partir del usuario. Si la " +
        "pregunta es «¿cuál es MI hogar?», usa loadCurrentMembership() de " +
        "app/family/current-household: la regla del desempate (defecto F-1) " +
        "tiene un solo dueño. Si el hogar YA se conoce, ancla la consulta con " +
        '.eq("household_id", …) en la MISMA cadena: con el índice único de la ' +
        "0001 eso devuelve a lo más una fila y no copia el desempate.",
    ).toEqual([]);
  });

  it("ninguna lectura de una sola fila de hogares queda sin anclar", () => {
    const infractores: string[] = [];
    for (const rel of archivosDeSrc()) {
      const texto = readFileSync(path.join(SRC, rel), "utf8");
      for (const inf of infraccionesRed2(texto)) {
        infractores.push(`${rel}, ${inf}`);
      }
    }
    expect(infractores).toEqual([]);
  });
});
