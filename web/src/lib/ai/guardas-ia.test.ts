import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasAiEnv, modoProveedor } from "./provider";
import { TEXTO_SISTEMA } from "./prompt";

/**
 * LAS GUARDAS DE LA SUPERFICIE DE IA.
 *
 * Molde: `domain/assistant/superficie.test.ts`. Son contratos sobre el CÓDIGO
 * FUENTE, no sobre un caso: si mañana alguien importa el adaptador real desde un
 * test, lee `process.env` al cargar un módulo o mete el proveedor en el árbol de
 * la página, esto revienta aunque todos los casos sigan pasando.
 *
 * Las tres reglas que defienden:
 *
 *  1. En pruebas el proveedor es FALSO y nadie sale a la red. Un test de
 *     inyección que pasó porque el modelo de verdad se portó bien esa vez no
 *     prueba ninguna defensa.
 *  2. El adaptador real se carga PEREZOSO. La ruta del asistente tiene que
 *     renderizar y contestar los caminos rápidos con las credenciales sin
 *     definir: si el adaptador explotara al importarse, la caída se llevaría
 *     puesto justo el camino que existe para sobrevivirla.
 *  3. `prompt.ts` es PURO. Por eso el router puede importarlo sin arrastrar
 *     entorno ni red, y por eso el saneado se puede probar sin levantar nada.
 */

const AQUI = path.resolve(__dirname);
const SRC = path.resolve(__dirname, "..", "..");
const WEB = path.resolve(SRC, "..");
const REMOTO = "provider-remoto";

interface Archivo {
  readonly rel: string;
  readonly texto: string;
  readonly esPrueba: boolean;
}

function fuentes(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...fuentes(ruta));
    else if (/\.tsx?$/.test(nombre)) out.push(ruta);
  }
  return out;
}

/** Sin comentarios: una guarda habla de lo que el código HACE, no de lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((linea) => {
      const corte = linea.indexOf("//");
      return corte === -1 ? linea : linea.slice(0, corte);
    })
    .join("\n");
}

/**
 * Este archivo se excluye de su propio barrido. Una guarda tiene que NOMBRAR lo
 * que prohíbe —"provider-remoto", "createClient(", "service_role"— y si se
 * revisara a sí misma se acusaría por escribir la regla.
 */
const ESTE_ARCHIVO = path.relative(SRC, path.join(AQUI, "guardas-ia.test.ts"));

function leerTodo(): readonly Archivo[] {
  return fuentes(SRC)
    .map((ruta) => ({
      rel: path.relative(SRC, ruta),
      texto: sinComentarios(readFileSync(ruta, "utf8")),
      esPrueba: /\.test\.tsx?$/.test(ruta),
    }))
    .filter((a) => a.rel !== ESTE_ARCHIVO);
}

const TODOS = leerTodo();

/** `import … from "…x"` o `require("…x")`: estático. `await import("…x")` no. */
function importaEstatico(texto: string, modulo: string): boolean {
  const escapado = modulo.replace(/[/\-.]/g, "\\$&");
  return new RegExp(`(from\\s*["'][^"']*${escapado}["']|require\\(\\s*["'][^"']*${escapado}["'])`).test(
    texto,
  );
}

describe("el barrido de verdad barre: una guarda vacía es una guarda que no existe", () => {
  /**
   * TODAS las guardas de este archivo tienen la misma forma: juntar los archivos
   * y comprobar que la lista de ofensas está vacía. Con `TODOS` vacío —una ruta
   * que cambió, un `readdirSync` que ya no encuentra nada— las nueve pasan
   * verdes sin haber mirado una sola línea, y el día que alguien importe el
   * adaptador real la suite no se entera. La única defensa contra eso es fijar el
   * piso: no cuántos archivos hay, sino que los archivos que las guardas EXISTEN
   * para vigilar estén adentro del barrido.
   */
  it("el barrido incluye los archivos que estas guardas vigilan", () => {
    const rel = new Set(TODOS.map((a) => a.rel));
    for (const esperado of [
      path.join("lib", "ai", "prompt.ts"),
      path.join("lib", "ai", "provider.ts"),
      path.join("lib", "ai", "provider-remoto.ts"),
      path.join("lib", "ai", "inyeccion.test.ts"),
      path.join("domain", "assistant", "router.ts"),
    ]) {
      expect(rel.has(esperado), esperado).toBe(true);
    }
    // Y hay pruebas adentro: si `esPrueba` dejara de marcar a nadie, las tres
    // guardas que hablan de archivos de prueba también pasarían de vacías.
    expect(TODOS.filter((a) => a.esPrueba).length).toBeGreaterThan(20);
  });

  it("el barrido sí acusa cuando hay algo que acusar", () => {
    // La guarda probada contra sí misma: con el texto prohibido adentro, la
    // misma expresión que usan las de abajo tiene que encontrarlo.
    const plantado: Archivo = {
      rel: path.join("lib", "ai", "archivo-inventado.test.ts"),
      texto: `import { adaptador } from "./${REMOTO}";`,
      esPrueba: true,
    };
    const ofensas = [...TODOS, plantado]
      .filter((a) => a.esPrueba && a.texto.includes(REMOTO))
      .map((a) => a.rel);
    expect(ofensas).toEqual([plantado.rel]);
    expect(importaEstatico(plantado.texto, REMOTO)).toBe(true);
  });
});

describe("en pruebas el proveedor es falso y nadie sale a la red", () => {
  it("ASSISTANT_PROVIDER es 'fake' mientras corre la suite", () => {
    expect(process.env.ASSISTANT_PROVIDER).toBe("fake");
    expect(modoProveedor()).toBe("fake");
  });

  it("la configuración de vitest lo deja escrito, no confiado al default", () => {
    const config = readFileSync(path.join(WEB, "vitest.config.ts"), "utf8");
    expect(config).toContain('env: { ASSISTANT_PROVIDER: "fake" }');
  });

  it("`fake` es el default: olvidar la variable no manda un test a la red", () => {
    const antes = process.env.ASSISTANT_PROVIDER;
    delete process.env.ASSISTANT_PROVIDER;
    try {
      expect(modoProveedor()).toBe("fake");
    } finally {
      process.env.ASSISTANT_PROVIDER = antes;
    }
  });

  it("ningún archivo de prueba nombra siquiera el adaptador real", () => {
    const ofensas = TODOS.filter((a) => a.esPrueba && a.texto.includes(REMOTO)).map((a) => a.rel);
    expect(ofensas).toEqual([]);
  });

  it("ningún archivo de prueba llama a fetch", () => {
    const ofensas = TODOS.filter((a) => a.esPrueba && /\bfetch\s*\(/.test(a.texto)).map((a) => a.rel);
    expect(ofensas).toEqual([]);
  });
});

describe("el adaptador real se carga perezoso y nadie lo importa", () => {
  it("no existe un import estático de provider-remoto en todo el repo", () => {
    const ofensas = TODOS.filter((a) => importaEstatico(a.texto, REMOTO)).map((a) => a.rel);
    expect(ofensas).toEqual([]);
  });

  it("la única puerta es el `await import()` de provider.ts", () => {
    const provider = TODOS.find((a) => a.rel === path.join("lib", "ai", "provider.ts"));
    expect(provider).toBeDefined();
    expect(provider?.texto).toContain('await import("./provider-remoto")');
  });

  it("el dominio y las pantallas no importan el puerto del proveedor", () => {
    // Se lo inyecta la sesión. Importarlo desde el dominio es meter el entorno
    // del proveedor en el árbol de módulos del camino determinista.
    const ofensas: string[] = [];
    for (const a of TODOS) {
      if (a.esPrueba) continue;
      const bajoDominio = a.rel.startsWith(path.join("domain", "assistant"));
      const bajoApp = a.rel.startsWith("app");
      if (!bajoDominio && !bajoApp) continue;
      if (importaEstatico(a.texto, "lib/ai/provider")) ofensas.push(a.rel);
    }
    expect(ofensas).toEqual([]);
  });

  it("nadie de lib/ai lee el entorno al importarse", () => {
    // `hasSupabaseEnv()` ya sentó el precedente: la variable se lee adentro de
    // la función, en cada llamada, para que la falta de configuración sea una
    // respuesta y no una pantalla en blanco.
    const ofensas: string[] = [];
    for (const a of TODOS) {
      if (!a.rel.startsWith(path.join("lib", "ai"))) continue;
      for (const linea of a.texto.split("\n")) {
        if (/^(const|let|var|export)\b.*process\.env/.test(linea)) ofensas.push(`${a.rel}: ${linea.trim()}`);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("sin entorno, preguntar por el entorno responde `false` en vez de reventar", () => {
    const url = process.env.ASSISTANT_API_URL;
    const key = process.env.ASSISTANT_API_KEY;
    delete process.env.ASSISTANT_API_URL;
    delete process.env.ASSISTANT_API_KEY;
    try {
      expect(hasAiEnv()).toBe(false);
    } finally {
      if (url !== undefined) process.env.ASSISTANT_API_URL = url;
      if (key !== undefined) process.env.ASSISTANT_API_KEY = key;
    }
  });
});

describe("el ensamblador de prompt es puro", () => {
  it("prompt.ts no lee entorno, no hace red y no conoce al proveedor", () => {
    const prompt = TODOS.find((a) => a.rel === path.join("lib", "ai", "prompt.ts"));
    expect(prompt).toBeDefined();
    const texto = prompt === undefined ? "" : prompt.texto;
    expect(texto).not.toContain("process.env");
    expect(texto).not.toMatch(/\bfetch\s*\(/);
    expect(importaEstatico(texto, "provider")).toBe(false);
  });

  it("el bloque SISTEMA no trae delimitadores: el conteo de `<` tiene que ser nuestro", () => {
    // Si las reglas del sistema tuvieran un `<`, el golden que cuenta ángulos
    // dejaría de distinguir nuestra estructura del texto del atacante.
    expect(TEXTO_SISTEMA).not.toContain("<");
    expect(TEXTO_SISTEMA).not.toContain(">");
  });

  it("las marcas de texto saneado solo se fabrican en el saneador", () => {
    const PERMITIDOS = new Set([
      path.join("lib", "ai", "prompt.ts"),
      path.join("domain", "assistant", "tool.ts"),
    ]);
    const ofensas: string[] = [];
    for (const a of TODOS) {
      if (PERMITIDOS.has(a.rel)) continue;
      for (const m of a.texto.matchAll(/as\s+(unknown\s+as\s+)?(UntrustedText|TextoSaneado|EtiquetaSegura)/g)) {
        ofensas.push(`${a.rel}: "${m[0]}"`);
      }
    }
    expect(ofensas).toEqual([]);
  });
});

describe("el router no llama al reloj ni al proveedor", () => {
  it("nada bajo domain/assistant usa `new Date()` salvo run-tool.ts", () => {
    // Un día de desfase corre vencimientos FEFO, `safeUseBy`, cobertura de stock
    // y fechas de pedido sin ningún error visible. El "hoy" es una afirmación
    // del hogar, no del datacenter donde corre el servidor.
    const PERMITIDO = path.join("domain", "assistant", "run-tool.ts");
    const ofensas: string[] = [];
    for (const a of TODOS) {
      if (!a.rel.startsWith(path.join("domain", "assistant"))) continue;
      if (a.rel === PERMITIDO || a.esPrueba) continue;
      if (/new Date\(\s*\)/.test(a.texto)) ofensas.push(a.rel);
    }
    expect(ofensas).toEqual([]);
  });

  it("los archivos de la superficie de IA no crean clientes de base", () => {
    const ofensas: string[] = [];
    for (const a of TODOS) {
      if (!a.rel.startsWith(path.join("lib", "ai"))) continue;
      if (/createClient\s*\(/.test(a.texto)) ofensas.push(`${a.rel}: createClient(`);
      if (/@\/lib\/supabase/.test(a.texto)) ofensas.push(`${a.rel}: importa supabase`);
      if (/service_role/.test(a.texto)) ofensas.push(`${a.rel}: service_role`);
    }
    expect(ofensas).toEqual([]);
  });

  it("no se rellenan huecos con 0 ni con lista vacía en la superficie de IA", () => {
    const ofensas: string[] = [];
    for (const a of TODOS) {
      const enIa = a.rel.startsWith(path.join("lib", "ai"));
      const enRouter = a.rel === path.join("domain", "assistant", "router.ts");
      if (!enIa && !enRouter) continue;
      for (const m of a.texto.matchAll(/(\?\?|\|\|)\s*(0(?![.\d])|\[\s*\])/g)) {
        ofensas.push(`${a.rel}: "${m[0]}"`);
      }
    }
    expect(ofensas).toEqual([]);
  });
});
