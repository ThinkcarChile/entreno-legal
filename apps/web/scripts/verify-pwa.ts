/**
 * Verificación de la aplicación web progresiva y del sistema de diseño.
 *
 *   npm run verify:pwa
 *
 * No necesita Supabase ni servidor: son comprobaciones estáticas sobre lo que
 * de verdad se publica —el manifiesto, los iconos, el service worker, los
 * metadatos del layout y los tokens de diseño—.
 *
 * Existe porque los fallos de una PWA son silenciosos: un icono que no está,
 * un `start_url` fuera del alcance o un service worker que guarda una respuesta
 * autenticada no rompen ninguna pantalla. Simplemente hacen que la aplicación
 * no se instale, o que alguien vea los datos de otra persona.
 *
 * Sale con código distinto de cero si alguna comprobación falla.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");
const has = (relative: string): boolean => existsSync(resolve(root, relative));

/* ------------------------------------------------------- arnés de pruebas */

interface Result {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
let counter = 0;

function check(name: string, fn: () => string): void {
  counter += 1;
  const id = `P${String(counter).padStart(2, "0")}`;
  try {
    const detail = fn();
    results.push({ id, name, ok: true, detail });
    console.log(`  ${id} OK   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, name, ok: false, detail });
    console.log(`  ${id} FALLO ${name} — ${detail}`);
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

/* ---------------------------------------------------------------- manifiesto */

section("Manifiesto e instalabilidad");

const manifest = read("src/app/manifest.ts");

check("el manifiesto declara nombre, nombre corto y descripción", () => {
  expect(/\bname:/.test(manifest), "falta name");
  expect(/short_name:/.test(manifest), "falta short_name");
  expect(/description:/.test(manifest), "falta description");
  return "name, short_name, description";
});

check("se abre como aplicación y no como pestaña", () => {
  expect(/display:\s*"standalone"/.test(manifest), "display no es standalone");
  return "display: standalone";
});

check("start_url y scope son coherentes", () => {
  const start = manifest.match(/start_url:\s*"([^"]+)"/)?.[1];
  const scope = manifest.match(/scope:\s*"([^"]+)"/)?.[1];
  expect(Boolean(start), "falta start_url");
  expect(Boolean(scope), "falta scope");
  expect(start!.startsWith(scope!), `start_url ${start} está fuera de scope ${scope}`);
  return `${start} dentro de ${scope}`;
});

check("la orientación no está forzada", () => {
  const orientation = manifest.match(/orientation:\s*"([^"]+)"/)?.[1];
  expect(orientation === "any", `orientation es ${orientation}; se usa de pie, en cualquier giro`);
  return "any";
});

check("hay color de tema y de fondo, y salen de los tokens de marca", () => {
  expect(/theme_color:\s*brand\./.test(manifest), "theme_color no viene de config/brand");
  expect(/background_color:\s*brand\./.test(manifest), "background_color no viene de config/brand");
  return "theme_color y background_color desde config/brand";
});

check("el idioma declarado es el de Chile", () => {
  expect(/lang:\s*"es-CL"/.test(manifest), "falta lang: es-CL");
  return "es-CL";
});

/* --------------------------------------------------------------------- iconos */

section("Iconos");

const REQUIRED_ICONS = [
  "public/icons/icon-192.svg",
  "public/icons/icon-512.svg",
  "public/icons/icon-maskable.svg",
  "src/app/icon.svg",
  "src/app/apple-icon.svg",
] as const;

check("todos los iconos referenciados existen en disco", () => {
  const missing = REQUIRED_ICONS.filter((path) => !has(path));
  expect(missing.length === 0, `faltan: ${missing.join(", ")}`);
  return `${REQUIRED_ICONS.length} archivos`;
});

check("cada icono del manifiesto apunta a un archivo real", () => {
  const sources = [...manifest.matchAll(/src:\s*"(\/icons\/[^"]+)"/g)].map((m) => m[1]);
  expect(sources.length >= 3, `solo ${sources.length} iconos declarados`);
  const missing = sources.filter((src) => !has(`public${src}`));
  expect(missing.length === 0, `declarados pero inexistentes: ${missing.join(", ")}`);
  return sources.join(", ");
});

check("hay un icono maskable de 512", () => {
  expect(/purpose:\s*"maskable"/.test(manifest), "ningún icono con purpose maskable");
  const maskable = read("public/icons/icon-maskable.svg");
  expect(/width="512"/.test(maskable) && /height="512"/.test(maskable), "no se dibuja a 512 px");
  return "icon-maskable.svg 512×512";
});

check("el icono maskable respeta la zona segura de Android", () => {
  const maskable = read("public/icons/icon-maskable.svg");
  const viewBox = maskable.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  expect(Boolean(viewBox), "el maskable no declara viewBox");
  const [, boxW, boxH] = viewBox!;

  // Android recorta hasta un 20 % por lado. Hacen falta dos cosas: fondo a
  // sangre —si no, recorta sobre transparencia y queda un icono mordido— y el
  // símbolo encogido dentro del círculo seguro del centro.
  const bleed = new RegExp(`<rect[^>]*width="${boxW}"[^>]*height="${boxH}"`).test(maskable);
  expect(bleed, "sin fondo a sangre: Android recortaría sobre transparencia");

  const scale = Number(maskable.match(/scale\((0?\.\d+)\)/)?.[1] ?? "1");
  expect(scale <= 0.7, `el símbolo ocupa el ${Math.round(scale * 100)} % del lienzo; el recorte se lo come`);
  return `fondo a sangre y símbolo al ${Math.round(scale * 100)} %`;
});

/* ------------------------------------------------------------ service worker */

section("Service worker");

const sw = read("public/sw.js");

check("existe y se registra desde el layout", () => {
  const registrar = read("src/components/layout/service-worker.tsx");
  expect(/navigator\.serviceWorker\.register\(\s*["']\/sw\.js["']/.test(registrar), "no registra /sw.js");
  const layout = read("src/app/layout.tsx");
  expect(/ServiceWorkerSetup/.test(layout), "el layout no monta el registrador");
  return "registrado en el layout raíz";
});

check("solo intercepta GET", () => {
  expect(/request\.method\s*!==\s*"GET"/.test(sw), "no descarta los métodos que escriben");
  return "los POST pasan de largo";
});

check("no toca nada de otro origen", () => {
  expect(/url\.origin\s*!==\s*self\.location\.origin/.test(sw), "no filtra por origen");
  return "Supabase y terceros van siempre a la red";
});

check("solo cachea archivos estáticos sin datos de nadie", () => {
  const allow = sw.match(/function isStaticAsset[\s\S]*?\n}/)?.[0] ?? "";
  expect(allow.length > 0, "no hay una función que decida qué es estático");
  expect(/_next\/static/.test(allow), "no incluye /_next/static");
  const forbidden = ["/api/", "rest/v1", "storage/v1", "auth/v1"];
  const leaked = forbidden.filter((needle) => allow.includes(needle));
  expect(leaked.length === 0, `la lista de cacheables incluye ${leaked.join(", ")}`);
  return "solo /_next/static, /icons y el manifiesto";
});

check("la navegación va a la red y solo cae en la página sin conexión", () => {
  expect(/request\.mode\s*===\s*"navigate"/.test(sw), "no distingue las navegaciones");
  const nav = sw.slice(sw.indexOf('request.mode === "navigate"'));
  expect(/fetch\(request\)\.catch/.test(nav), "no es red primero");
  expect(/OFFLINE_URL/.test(nav), "no hay página de cortesía");
  return "red primero, /sin-conexion de reserva";
});

check("no guarda HTML autenticado en la caché compartida", () => {
  // La única entrada HTML precacheada debe ser la página sin conexión, que no
  // lleva datos de nadie.
  const precache = sw.match(/const PRECACHE\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
  expect(precache.length > 0, "no se encuentra la lista PRECACHE");
  const entries = [...precache.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const html = entries.filter((e) => !e.startsWith("/icons/") && e !== "/manifest.webmanifest");
  expect(
    html.every((e) => e.includes("sin-conexion") || e.includes("OFFLINE")),
    `precachea HTML que no es la página sin conexión: ${html.join(", ")}`,
  );
  return entries.join(", ");
});

check("la página sin conexión existe y no pide datos", () => {
  expect(has("src/app/sin-conexion/page.tsx"), "falta /sin-conexion");
  const page = read("src/app/sin-conexion/page.tsx");
  expect(!/getData\(|getViewer\(|createClient/.test(page), "la página sin conexión consulta datos");
  return "estática y sin sesión";
});

/* ------------------------------------------------------------- layout y viewport */

section("Viewport y metadatos");

const layout = read("src/app/layout.tsx");

check("el viewport cubre la pantalla completa del teléfono", () => {
  expect(/viewportFit:\s*"cover"/.test(layout), "falta viewportFit: cover");
  expect(/width:\s*"device-width"/.test(layout), "falta width: device-width");
  expect(/initialScale:\s*1/.test(layout), "falta initialScale: 1");
  return "device-width, escala 1, cover";
});

check("no se bloquea el zoom", () => {
  expect(!/userScalable:\s*false/.test(layout), "userScalable: false impide ampliar el texto");
  expect(!/maximumScale:\s*1/.test(layout), "maximumScale: 1 impide ampliar el texto");
  return "el usuario puede ampliar";
});

check("hay color de tema y barra de estado para iOS", () => {
  expect(/themeColor:/.test(layout), "falta themeColor");
  expect(/appleWebApp:/.test(layout), "falta appleWebApp");
  return "themeColor + appleWebApp";
});

check("el documento declara el idioma", () => {
  expect(/<html lang="es-CL"/.test(layout), "falta lang en <html>");
  return "es-CL";
});

/* -------------------------------------------------------- áreas seguras y barra */

section("Barra inferior y áreas seguras");

const tabBar = read("src/components/layout/mobile-tab-bar.tsx");

check("la barra inferior respeta el área segura", () => {
  expect(/safe-area-inset-bottom/.test(tabBar), "no usa env(safe-area-inset-bottom)");
  return "env(safe-area-inset-bottom)";
});

check("la barra desaparece en escritorio", () => {
  expect(/lg:hidden/.test(tabBar), "la barra no se oculta en lg");
  return "oculta desde lg";
});

check("los cinco destinos son los del encargo", () => {
  for (const label of ["Inicio", "Explorar", "Mensajes", "Perfil"]) {
    expect(tabBar.includes(`"${label}"`), `falta el destino ${label}`);
  }
  expect(/href="\/publicar"/.test(tabBar), "falta el acceso a publicar");
  return "Inicio, Explorar, Publicar, Mensajes/Mis trabajos, Perfil";
});

check("el layout reserva el alto de la barra en toda la columna", () => {
  for (const file of ["src/app/(app)/layout.tsx", "src/app/(marketing)/layout.tsx"]) {
    const source = read(file);
    const line = source.split("\n").find((l) => l.includes("pb-tabbar"));
    expect(Boolean(line), `${file} no reserva el alto de la barra`);
    expect(
      /min-h-dvh/.test(line!),
      `${file} reserva el alto solo en el contenido: el pie queda bajo la barra`,
    );
  }
  return "el pie queda por encima de la barra";
});

/* ------------------------------------------------------------ tokens de diseño */

section("Sistema de diseño");

const css = read("src/app/globals.css");

check("la paleta de marca está en los tokens", () => {
  for (const [name, value] of [
    ["--color-ink-950", "#152238"],
    ["--color-brand-500", "#e8476b"],
    ["--color-canvas", "#fff9f4"],
    ["--color-success-500", "#20b486"],
  ] as const) {
    expect(css.includes(`${name}: ${value}`), `${name} no vale ${value}`);
  }
  return "azul profundo, coral, crema y verde";
});

check("hay tokens de cada familia", () => {
  const families = [
    ["color", /--color-[a-z]/],
    ["tipografía", /--text-[a-z]/],
    ["radio", /--radius-[a-z]/],
    ["sombra", /--shadow-[a-z]/],
    ["espaciado", /--spacing-[a-z]/],
    ["animación", /--animate-[a-z]/],
    ["capa", /--z-index-[a-z]/],
  ] as const;
  const missing = families.filter(([, pattern]) => !pattern.test(css)).map(([name]) => name);
  expect(missing.length === 0, `sin tokens de ${missing.join(", ")}`);
  return families.map(([name]) => name).join(", ");
});

check("ningún componente escribe un color hexadecimal a mano", () => {
  const offenders: string[] = [];
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(resolve(root, dir))) {
      const relative = `${dir}/${entry}`;
      const full = resolve(root, relative);
      if (statSync(full).isDirectory()) out.push(...walk(relative));
      else if (/\.tsx$/.test(entry)) out.push(relative);
    }
    return out;
  };
  for (const file of walk("src")) {
    const source = read(file);
    // Los SVG de marca y el archivo de tokens sí pueden nombrar el color.
    if (file.includes("/config/brand")) continue;
    const hits = [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
    if (hits.length > 0) offenders.push(`${file}: ${[...new Set(hits)].join(" ")}`);
  }
  expect(offenders.length === 0, offenders.join(" · "));
  return "todo el color sale de los tokens";
});

check("los contrastes documentados se cumplen", () => {
  // Se recalculan aquí: un comentario que dice 4,98:1 y una paleta que ya no lo
  // cumple es peor que no tener el comentario.
  const hex = (token: string): string => {
    const value = css.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
    if (!value) throw new Error(`no se encuentra ${token}`);
    return value;
  };
  const luminance = (color: string): number => {
    const channel = (value: number): number => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = channel(parseInt(color.slice(1, 3), 16));
    const g = channel(parseInt(color.slice(3, 5), 16));
    const b = channel(parseInt(color.slice(5, 7), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string): number => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };

  const white = "#ffffff";
  const canvas = hex("--color-canvas");
  const pairs: readonly [string, string, string, number][] = [
    ["texto blanco sobre brand-600", white, hex("--color-brand-600"), 4.5],
    ["brand-700 sobre blanco", hex("--color-brand-700"), white, 4.5],
    ["ink-600 sobre blanco", hex("--color-ink-600"), white, 4.5],
    ["ink-500 sobre blanco", hex("--color-ink-500"), white, 4.5],
    ["ink-500 sobre crema", hex("--color-ink-500"), canvas, 4.5],
    ["ink-600 sobre crema", hex("--color-ink-600"), canvas, 4.5],
    ["success-700 sobre blanco", hex("--color-success-700"), white, 4.5],
    ["danger-700 con texto blanco", white, hex("--color-danger-700"), 4.5],
    ["ink-300 sobre ink-950", hex("--color-ink-300"), hex("--color-ink-950"), 4.5],
    ["ink-400 sobre ink-950", hex("--color-ink-400"), hex("--color-ink-950"), 4.5],
  ];

  const failures = pairs
    .map(([name, fg, bg, minimum]) => [name, ratio(fg, bg), minimum] as const)
    .filter(([, value, minimum]) => value < minimum)
    .map(([name, value, minimum]) => `${name}: ${value.toFixed(2)}:1 < ${minimum}:1`);
  expect(failures.length === 0, failures.join(" · "));
  return `${pairs.length} pares por encima de 4,5:1`;
});

check("el movimiento se puede desactivar", () => {
  expect(/prefers-reduced-motion/.test(css), "no se respeta prefers-reduced-motion");
  return "prefers-reduced-motion atendido";
});

/* ------------------------------------------------------------------- informe */

const failed = results.filter((r) => !r.ok);
console.log("\n══════════════════════════════════════════════════════════");
console.log(`  ${results.length - failed.length} de ${results.length} comprobaciones pasaron`);
if (failed.length > 0) {
  console.log("\n  Fallaron:");
  for (const r of failed) console.log(`   · ${r.id} ${r.name}: ${r.detail}`);
}
console.log("══════════════════════════════════════════════════════════\n");
process.exit(failed.length > 0 ? 1 : 0);
