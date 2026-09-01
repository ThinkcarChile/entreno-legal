import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN: el ORDEN de la cadena y el ESTADO de producción tienen un dueño cada
 * uno, y la guía de instalación manda a esos dos y a nadie más.
 *
 * Esto existe porque `docs/setup-supabase.md` llegó a decir «en orden numérico»
 * y a entregar dos bucles copiables (`for f in supabase/migrations/*.sql` y un
 * `Get-ChildItem | Sort-Object Name`). Ese NO es el orden de aplicación de este
 * repo: la 0036 va DESPUÉS de la 0037, porque cuando se escribió, las 0033-0035
 * y la 0037 ya estaban puestas en producción. Contra el Supabase de hoy no se
 * nota; contra una base recién creada o restaurada —el día del desastre, con el
 * runbook en la mano— el documento dictaba con autoridad una secuencia que
 * ninguna prueba ejercita.
 *
 * Y `scripts/aplicar-migracion.mjs --pendientes` llegó a deducir por su cuenta
 * qué tenía puesto producción, leyendo los .sql y adivinando un testigo por
 * migración, mientras al lado se construía el libro `supabase/estado-produccion.json`
 * con testigos probados uno por uno en PGlite. Los dos mecanismos ya discrepaban
 * en 0004, 0010, 0019, 0028, 0031 y 0034. Dos dueños del mismo dato es
 * exactamente cómo el repo y producción se separaron sin que nada lo notara.
 *
 * Por eso este archivo NO prueba la deducción: prueba que no exista. Lo que
 * afirma es que el aplicador sigue siendo un brazo (aplica el archivo que le
 * nombran, no pregunta ni ordena) y que el documento sigue mandando al arnés y
 * al libro.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const GUIA = path.join(RAIZ, "docs", "setup-supabase.md");
const APLICADOR = path.join(RAIZ, "scripts", "aplicar-migracion.mjs");
const DUENO_DEL_ORDEN = path.join(RAIZ, "scripts", "poner-al-dia.mjs");
const DUENO_DEL_ESTADO = path.join(RAIZ, "scripts", "verificar-estado-produccion.mjs");
const ARNES = path.join(__dirname, "harness.ts");

const leer = (archivo: string): string => readFileSync(archivo, "utf8");

/**
 * Comentarios fuera antes de buscar.
 *
 * Un guardián que se conforma con lo escrito en un comentario no guarda nada: el
 * encabezado del aplicador CUENTA lo que hacía antes («llegó a imprimir "Para
 * aplicarlas, en este orden"», «readdirSync().sort()»), y esa memoria tiene que
 * poder quedarse escrita sin que este test la confunda con código vivo.
 */
function sinComentarios(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Los bloques cercados de un .md: lo único del documento que alguien copia y pega. */
function bloquesDeCodigo(md: string): string[] {
  return [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/** El orden real, leído con la MISMA expresión que usa scripts/poner-al-dia.mjs. */
function ordenDelArnes(): string[] {
  const bloque = leer(ARNES).match(/const MIGRACIONES\s*=\s*\[([\s\S]*?)\];/);
  const cuerpo = bloque?.[1];
  if (cuerpo === undefined) {
    throw new Error(
      "No pude leer la lista MIGRACIONES del arnés con la misma expresión que usa " +
        "scripts/poner-al-dia.mjs. Si la lista cambió de forma, ese script se queda sin " +
        "orden y hay que actualizarlo a él también.",
    );
  }
  return [...cuerpo.matchAll(/"supabase\/migrations\/([^"]+)"/g)].map((m) => m[1] ?? "");
}

const numeroDe = (archivo: string): string => archivo.slice(0, 4);

/** Pares consecutivos donde el número BAJA: la prueba viva de que el orden no es el alfabético. */
function inversiones(orden: string[]): Array<{ antes: string; despues: string }> {
  const pares: Array<{ antes: string; despues: string }> = [];
  for (let i = 1; i < orden.length; i += 1) {
    const previa = orden[i - 1];
    const actual = orden[i];
    if (previa === undefined || actual === undefined) continue;
    if (numeroDe(actual) < numeroDe(previa)) {
      pares.push({ antes: numeroDe(previa), despues: numeroDe(actual) });
    }
  }
  return pares;
}

describe("el orden de la cadena tiene un solo dueño", () => {
  it("el arnés declara un orden que NO es el alfabético", () => {
    const orden = ordenDelArnes();
    expect(orden.length).toBeGreaterThan(30);

    // Si algún día esto se vuelve alfabético, el test cae y hay que revisar la
    // guía y los dos scripts: media docena de comentarios advierten de esta
    // inversión y quedarían mintiendo.
    expect(inversiones(orden).length).toBeGreaterThan(0);
    expect(orden).not.toEqual([...orden].sort());
  });

  it("la guía no entrega ningún comando que ordene las migraciones por nombre", () => {
    // El documento SÍ nombra estas formas, para decir que no sirven. Lo que no
    // puede haber es una copiable: el bloque cercado es lo que la gente pega.
    const porNombre = /migrations[/\\]\*\.sql|Sort-Object|Get-ChildItem|readdir|\bls\s+supabase/i;
    const copiables = bloquesDeCodigo(leer(GUIA));

    const infractores = copiables.filter((b) => porNombre.test(b));
    expect(infractores, "hay un comando copiable que aplica la cadena en orden alfabético").toEqual(
      [],
    );
  });

  it("la guía manda al dueño del orden y explica la inversión que hoy tiene la cadena", () => {
    const guia = leer(GUIA);
    expect(guia).toContain("web/src/integration/harness.ts");
    expect(guia).toContain("MIGRACIONES");
    expect(guia).toContain("scripts/poner-al-dia.mjs");
    expect(existsSync(DUENO_DEL_ORDEN)).toBe(true);

    const parrafos = guia.split(/\r?\n\s*\r?\n/);
    for (const { antes, despues } of inversiones(ordenDelArnes())) {
      const explicado = parrafos.some(
        (p) => p.includes(antes) && p.includes(despues) && /despu[eé]s/i.test(p),
      );
      expect(explicado, `la guía no dice que la ${despues} va DESPUÉS de la ${antes}`).toBe(true);
    }
  });

  it("el aplicador no dicta orden: no lee el directorio ni ordena nada", () => {
    const codigo = sinComentarios(leer(APLICADOR));
    for (const prohibido of ["readdirSync", ".sort(", "en este orden"]) {
      expect(codigo, `el aplicador volvió a ordenar la cadena (${prohibido})`).not.toContain(
        prohibido,
      );
    }
  });
});

describe("el estado de producción tiene un solo dueño", () => {
  it("el aplicador no deduce testigos: no le pregunta nada al catálogo de la base", () => {
    const codigo = sinComentarios(leer(APLICADOR));
    // Así se pregunta «¿qué objetos tiene esta base?». Este script no lo hace:
    // aplica el archivo que le nombran y punto. La única consulta que arma es la
    // de --check (current_database + version), que no mira el esquema.
    const preguntaPorElEsquema =
      /pg_temp|pg_catalog|information_schema|pg_class|pg_proc|to_regclass|coalesce/i;
    expect(preguntaPorElEsquema.test(codigo)).toBe(false);
  });

  it("--pendientes delega en el dueño, y el dueño existe", () => {
    const codigo = sinComentarios(leer(APLICADOR));
    expect(codigo).toContain("verificar-estado-produccion.mjs");
    expect(codigo).toContain("spawnSync");
    expect(existsSync(DUENO_DEL_ESTADO)).toBe(true);
  });

  it("la guía no le enseña a nadie a preguntar el estado con --pendientes", () => {
    const copiables = bloquesDeCodigo(leer(GUIA));
    expect(copiables.filter((b) => b.includes("--pendientes"))).toEqual([]);
    expect(leer(GUIA)).toContain("verificar-estado-produccion.mjs");
  });
});

describe("el aplicador termina sin reventar", () => {
  it("no llama a process.exit()", () => {
    // process.exit() con el socket de fetch abierto revienta libuv en Windows
    // («!(handle->flags & UV_HANDLE_CLOSING)»): el proceso muere con 127 y se
    // pierde el código que el script quería devolver. Quien lo llama desde
    // afuera —poner-al-dia.mjs -- no puede distinguir «falló la migración» de
    // «reventó el proceso», y terminó juzgando por el texto impreso.
    expect(sinComentarios(leer(APLICADOR))).not.toContain("process.exit(");
  });

  it("sin argumentos explica el uso, sale con 1 y no deja una aserción de libuv", () => {
    const r = spawnSync(process.execPath, [APLICADOR], { encoding: "utf8", cwd: RAIZ });
    const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(salida).toContain("Uso: node scripts/aplicar-migracion.mjs");
    expect(salida).not.toContain("Assertion failed");
    expect(r.status).toBe(1);
  });
});
