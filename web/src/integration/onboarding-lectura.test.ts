import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cargarHechosEsenciales, cargarHechosOnboarding } from "@/app/onboarding/queries";
import { esencialesListos } from "@/app/onboarding/pasos";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * La portada se prueba ENTERA (`src/app/page.tsx`), no por lectura del archivo:
 * un grep se satisface con la cadena escrita en un comentario. Se le cambia el
 * cliente de Supabase por el de acá y se atrapa su `redirect`, que en Next es
 * una excepción.
 */
const puente = vi.hoisted(() => ({ cliente: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => puente.cliente,
}));

class Redirigio extends Error {
  constructor(readonly destino: string) {
    super(`redirect(${destino})`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redirigio(destino);
  },
}));

/** Corre la portada y devuelve a dónde mandó a la persona. */
async function portadaLlevaA(
  cliente: SupabaseClient,
  parametros: Record<string, string> = {},
): Promise<string> {
  const { default: Home } = await import("@/app/page");
  puente.cliente = cliente;
  try {
    await Home({ searchParams: Promise.resolve(parametros) });
  } catch (e) {
    if (e instanceof Redirigio) return e.destino;
    throw e;
  }
  throw new Error("la portada terminó sin redirigir a ninguna parte");
}

/**
 * LA LECTURA del onboarding, contra PostgreSQL de verdad y con RLS encendida.
 *
 * Por qué existe este archivo: los tests de `pasos.ts` alimentan a mano los
 * hechos YA interpretados, así que validan la interpretación y no la lectura.
 * Se comprobó por mutación que era media red: borrando el `soyAdmin ?` de
 * `queries.ts` —o sea, convirtiendo "no puedo ver las invitaciones" en "no hay
 * ninguna"— los doce tests seguían verdes. El tercer estado, `NO_SE_SABE`, que
 * es la razón de ser del módulo, se podía borrar sin que nada se pusiera rojo.
 *
 * Acá las decisiones se ejercen donde ocurren:
 *  - la RLS `invitations_admin` de verdad le esconde la tabla a un integrante
 *    común, y el resultado tiene que ser "no sabemos", nunca cero;
 *  - una fila de seguimiento en `OFF` de verdad cuenta como respuesta;
 *  - la portada de verdad no le pregunta a las tablas que no deciden nada.
 */

const USUARIO_ADMIN = "11111111-1111-4111-8111-111111111111";
const USUARIO_COMUN = "22222222-2222-4222-8222-222222222222";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let paulaId: string;

// ---------------------------------------------------------------------------
// Un cliente que habla como PostgREST y contesta desde PGlite.
//
// No es un doble de la capa de datos: `queries.ts` corre entera y sin cambios,
// con sus schemas de Zod, sus embeds y sus `maybeSingle`. Lo único emulado es
// el transporte — y el guion permite representar las dos cosas que en un
// Supabase real no se pueden provocar a mano: una tabla que la RLS esconde por
// completo y una consulta que falla con un SQLSTATE dado.
// ---------------------------------------------------------------------------

interface Guion {
  /** Tablas que contestan vacío, como cuando la RLS no deja ver ni una fila. */
  invisibles?: readonly string[];
  /** Tablas que fallan, con el SQLSTATE que devolvería PostgREST. */
  rotas?: Readonly<Record<string, string>>;
  /** Se anota cada tabla consultada, en orden: es lo que la pantalla PIDE. */
  tocadas: string[];
}

/** Relaciones que el `select` puede embeber, con su llave foránea. */
const EMBEDS: Readonly<Record<string, { fk: string; destino: string; pk: string }>> = {
  "member_role_assignments.household_roles": {
    fk: "role_id",
    destino: "household_roles",
    pk: "id",
  },
};

interface Resultado {
  data: unknown;
  error: { code: string; message: string; details: string | null; hint: string | null } | null;
}

/** Lo que PostgREST entrega es JSON: una fecha viaja como texto, no como Date. */
function aJson(valor: unknown): unknown {
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === "bigint") return valor.toString();
  return valor;
}

/** Parte un `select` de PostgREST en columnas y embeds, respetando paréntesis. */
function partirSelect(select: string): { columnas: string[]; embeds: string[] } {
  const piezas: string[] = [];
  let nivel = 0;
  let actual = "";
  for (const ch of select) {
    if (ch === "(") nivel++;
    if (ch === ")") nivel--;
    if (ch === "," && nivel === 0) {
      piezas.push(actual);
      actual = "";
      continue;
    }
    actual += ch;
  }
  if (actual.trim()) piezas.push(actual);
  const columnas: string[] = [];
  const embeds: string[] = [];
  for (const pieza of piezas.map((p) => p.trim())) {
    if (pieza.includes("(")) embeds.push(pieza);
    else columnas.push(pieza);
  }
  return { columnas, embeds };
}

class Consulta implements PromiseLike<Resultado> {
  private readonly condiciones: string[] = [];
  private readonly params: unknown[] = [];
  private orden: string | null = null;
  private tope: number | null = null;
  private unaSola = false;

  constructor(
    private readonly harness: Harness,
    private readonly guion: Guion,
    private readonly tabla: string,
    private readonly select: string,
  ) {}

  private marcador(valor: unknown): string {
    this.params.push(valor);
    return `$${this.params.length}`;
  }

  eq(columna: string, valor: unknown): this {
    this.condiciones.push(`t.${columna} = ${this.marcador(valor)}`);
    return this;
  }

  neq(columna: string, valor: unknown): this {
    this.condiciones.push(`t.${columna} <> ${this.marcador(valor)}`);
    return this;
  }

  in(columna: string, valores: readonly unknown[]): this {
    if (valores.length === 0) {
      this.condiciones.push("false");
      return this;
    }
    this.condiciones.push(`t.${columna} in (${valores.map((v) => this.marcador(v)).join(", ")})`);
    return this;
  }

  order(columna: string, opciones?: { ascending?: boolean }): this {
    this.orden = `${columna} ${opciones?.ascending === false ? "desc" : "asc"}`;
    return this;
  }

  limit(n: number): this {
    this.tope = n;
    return this;
  }

  maybeSingle(): this {
    this.unaSola = true;
    return this;
  }

  private sql(): string {
    const { columnas, embeds } = partirSelect(this.select);
    const expresiones = columnas.map((c) => `t.${c}`);
    for (const embed of embeds) {
      const nombre = embed.slice(0, embed.indexOf("(")).trim();
      const relacion = EMBEDS[`${this.tabla}.${nombre}`];
      if (!relacion) {
        throw new Error(
          `El cliente de prueba no sabe embeber "${nombre}" en "${this.tabla}". ` +
            "Declárala en EMBEDS: un embed nuevo sin declarar no puede pasar en silencio.",
        );
      }
      const cols = embed
        .slice(embed.indexOf("(") + 1, embed.lastIndexOf(")"))
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      const objeto = cols.map((c) => `'${c}', e.${c}`).join(", ");
      expresiones.push(
        `(select jsonb_build_object(${objeto}) from public.${relacion.destino} e ` +
          `where e.${relacion.pk} = t.${relacion.fk}) as ${nombre}`,
      );
    }
    return [
      `select ${expresiones.join(", ")} from public.${this.tabla} t`,
      this.condiciones.length > 0 ? `where ${this.condiciones.join(" and ")}` : "",
      this.orden ? `order by t.${this.orden}` : "",
      this.tope !== null ? `limit ${this.tope}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async ejecutar(): Promise<Resultado> {
    this.guion.tocadas.push(this.tabla);

    const roto = this.guion.rotas?.[this.tabla];
    if (roto !== undefined) {
      return {
        data: null,
        error: {
          code: roto,
          message: `la tabla ${this.tabla} no contestó (guion de prueba)`,
          details: null,
          hint: null,
        },
      };
    }
    if (this.guion.invisibles?.includes(this.tabla)) {
      // Exactamente lo que hace la RLS: cero filas y CERO error.
      return { data: this.unaSola ? null : [], error: null };
    }

    try {
      const filas = await this.harness.filas<Record<string, unknown>>(this.sql(), this.params);
      const serializadas = filas.map((f) =>
        Object.fromEntries(Object.entries(f).map(([k, v]) => [k, aJson(v)])),
      );
      if (!this.unaSola) return { data: serializadas, error: null };
      if (serializadas.length > 1) {
        return {
          data: null,
          error: {
            code: "PGRST116",
            message: "se esperaba una fila y vinieron varias",
            details: null,
            hint: null,
          },
        };
      }
      return { data: serializadas[0] ?? null, error: null };
    } catch (e) {
      const codigo =
        typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "P0000";
      return {
        data: null,
        error: { code: codigo, message: String(e), details: null, hint: null },
      };
    }
  }

  then<A = Resultado, B = never>(
    alCumplir?: ((valor: Resultado) => A | PromiseLike<A>) | null,
    alFallar?: ((razon: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.ejecutar().then(alCumplir, alFallar);
  }
}

function clienteFalso(userId: string, guion: Guion): SupabaseClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    from: (tabla: string) => ({
      select: (columnas: string) => new Consulta(h, guion, tabla, columnas),
    }),
  } as unknown as SupabaseClient;
}

/**
 * Deja la sesión de PGlite hablando como ese usuario durante todo el bloque.
 *
 * Se hace una vez y no por consulta a propósito: `cargarHechosOnboarding` lanza
 * dos lecturas en paralelo sobre la misma conexión, y un `reset role` en medio
 * dejaría a la otra corriendo como superusuario — o sea, sin RLS, que es
 * justamente lo que este archivo prueba.
 */
async function comoUsuario<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await h.db.exec("set role authenticated;");
  await h.db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  try {
    return await fn();
  } finally {
    await h.db.exec("reset role;");
  }
}

const guion = (extra: Omit<Guion, "tocadas"> = {}): Guion => ({ ...extra, tocadas: [] });

beforeAll(async () => {
  h = await levantarBase({ conSeeds: false });
  hogar = await crearHogar(h, USUARIO_ADMIN, "Los Vásquez", "Francisco");

  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USUARIO_COMUN,
      "paula@test.dev",
    ]);
    const paula = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name)
       values ($1, $2, 'Paula') returning id`,
      [hogar.householdId, USUARIO_COMUN],
    );
    paulaId = paula!.id;

    // Rol MEMBER: integrante de verdad, sin administración. Es la persona a la
    // que la RLS le esconde las invitaciones.
    await h.db.query(
      `insert into public.member_role_assignments (member_id, role_id)
       select $1, id from public.household_roles
       where household_id = $2 and code = 'MEMBER'`,
      [paulaId, hogar.householdId],
    );

    // Paula SÍ respondió, y respondió que no lleva seguimiento. Francisco no ha
    // dicho nada: no tiene fila.
    await h.db.query(
      "insert into public.member_tracking_settings (member_id, mode) values ($1, 'OFF')",
      [paulaId],
    );

    await h.db.query(
      `insert into public.invitations (household_id, token_hash, expires_at, created_by)
       values ($1, 'hash-de-prueba', now() + interval '7 days', $2)`,
      [hogar.householdId, hogar.memberId],
    );
  });
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

describe("qué lee el onboarding y qué significa cada silencio", () => {
  it("quien administra el hogar sí ve las invitaciones", async () => {
    const hechos = await comoUsuario(USUARIO_ADMIN, () =>
      cargarHechosOnboarding(clienteFalso(USUARIO_ADMIN, guion())),
    );

    expect(hechos.hogarId).toBe(hogar.householdId);
    expect(hechos.nombreHogar).toBe("Los Vásquez");
    expect(hechos.invitaciones).toEqual({
      conocido: true,
      valor: { vigentes: 1, aceptadas: 0 },
    });
  });

  it("a un integrante común la RLS le esconde las invitaciones: eso NO es cero", async () => {
    const hechos = await comoUsuario(USUARIO_COMUN, () =>
      cargarHechosOnboarding(clienteFalso(USUARIO_COMUN, guion())),
    );

    // El hogar TIENE una invitación vigente. Si acá dijéramos "cero", le
    // estaríamos afirmando a Paula que nadie invitó a nadie.
    expect(hechos.invitaciones.conocido).toBe(false);
    if (hechos.invitaciones.conocido) throw new Error("inalcanzable");
    expect(hechos.invitaciones.porque).toContain("administra el hogar");
  });

  it("una fila de seguimiento en OFF cuenta como declarada; no tener fila no", async () => {
    const hechos = await comoUsuario(USUARIO_ADMIN, () =>
      cargarHechosEsenciales(clienteFalso(USUARIO_ADMIN, guion())),
    );

    // Paula guardó 'OFF' —una respuesta— y Francisco no guardó nada.
    expect([...hechos.seguimientoDeclarado]).toEqual([paulaId]);
    expect(hechos.integrantes.map((m) => m.nombre).sort()).toEqual(["Francisco", "Paula"]);
    expect(esencialesListos(hechos)).toBe(false);
  });

  it("si la ficha del hogar no vuelve, no se inventa un nombre", async () => {
    const hechos = await comoUsuario(USUARIO_ADMIN, () =>
      cargarHechosOnboarding(clienteFalso(USUARIO_ADMIN, guion({ invisibles: ["households"] }))),
    );

    expect(hechos.hogarId).toBe(hogar.householdId);
    expect(hechos.nombreHogar).toBeNull();
  });
});

describe("la portada decide con lo mínimo", () => {
  const ADORNOS = [
    "households",
    "member_role_assignments",
    "invitations",
    "weekly_plans",
    "weekly_plan_days",
    "meal_assignments",
  ];

  it("no le pregunta a ninguna tabla que no participe de la decisión", async () => {
    const g = guion();
    await comoUsuario(USUARIO_ADMIN, () => cargarHechosEsenciales(clienteFalso(USUARIO_ADMIN, g)));

    expect(g.tocadas).toEqual(["household_members", "household_members", "member_tracking_settings"]);
    for (const tabla of ADORNOS) expect(g.tocadas).not.toContain(tabla);
  });

  it("sigue decidiendo aunque TODAS las tablas de adorno estén caídas", async () => {
    // Es el hallazgo que puso esto acá: la portada se caía si fallaba cualquiera
    // de unas diez consultas, y la mitad no participaba de la decisión.
    const rotas = Object.fromEntries(ADORNOS.map((t) => [t, "42501"]));
    const hechos = await comoUsuario(USUARIO_ADMIN, () =>
      cargarHechosEsenciales(clienteFalso(USUARIO_ADMIN, guion({ rotas }))),
    );

    expect(hechos.hogarId).toBe(hogar.householdId);
    expect(esencialesListos(hechos)).toBe(false);
  });

  it("pero si falla lo ESENCIAL revienta con nombre y apellido, no decide a ciegas", async () => {
    // ERROR != VACÍO: sin saber quién declaró su perfil no hay forma honesta de
    // elegir entre /family y /onboarding.
    await expect(
      comoUsuario(USUARIO_ADMIN, () =>
        cargarHechosEsenciales(
          clienteFalso(USUARIO_ADMIN, guion({ rotas: { member_tracking_settings: "42501" } })),
        ),
      ),
    ).rejects.toBeInstanceOf(DataAccessError);
  });
});

describe("la pantalla de pasos tampoco se cae por un adorno", () => {
  it("un adorno ilegible se declara CON su motivo, no como cero", async () => {
    const hechos = await comoUsuario(USUARIO_ADMIN, () =>
      cargarHechosOnboarding(
        clienteFalso(
          USUARIO_ADMIN,
          guion({ rotas: { invitations: "42501", weekly_plans: "42P01" } }),
        ),
      ),
    );

    expect(hechos.invitaciones.conocido).toBe(false);
    if (hechos.invitaciones.conocido) throw new Error("inalcanzable");
    expect(hechos.invitaciones.porque).toContain("42501");

    expect(hechos.comidasEstaSemana.conocido).toBe(false);
    if (hechos.comidasEstaSemana.conocido) throw new Error("inalcanzable");
    expect(hechos.comidasEstaSemana.porque).toContain("42P01");
  });

  it("la semana en curso vacía sí es un cero de verdad", async () => {
    const hechos = await comoUsuario(USUARIO_ADMIN, () =>
      cargarHechosOnboarding(clienteFalso(USUARIO_ADMIN, guion())),
    );

    expect(hechos.comidasEstaSemana).toEqual({ conocido: true, valor: 0 });
  });
});

/**
 * La portada `/` es el punto de entrada de TODA la aplicación: si se cae, no hay
 * aplicación. Estos tres casos son los que la dejaron así.
 */
describe("la portada, corrida de verdad", () => {
  const ADORNOS_CAIDOS = {
    households: "42501",
    member_role_assignments: "42501",
    invitations: "42501",
    weekly_plans: "42P01",
    weekly_plan_days: "42P01",
    meal_assignments: "42P01",
  };

  it("con perfiles por declarar deja en los primeros pasos, y sin pedir un solo adorno", async () => {
    const g = guion({ rotas: ADORNOS_CAIDOS });
    const destino = await comoUsuario(USUARIO_ADMIN, () =>
      portadaLlevaA(clienteFalso(USUARIO_ADMIN, g)),
    );

    expect(destino).toBe("/onboarding");
    // Que no se caiga con los adornos rotos no basta: la portada NO TIENE QUE
    // PEDIRLOS. Pedir lo que la decisión descarta es superficie de falla en la
    // puerta de entrada, y ese fue el hallazgo exacto.
    for (const tabla of Object.keys(ADORNOS_CAIDOS)) expect(g.tocadas).not.toContain(tabla);
  });

  it("`/?pasos` vuelve a los primeros pasos sin pagar una sola consulta", async () => {
    // Es la puerta de vuelta: cuando lo esencial ya está, la portada deja en el
    // hogar y esta pantalla dejaba de existir para siempre.
    const g = guion();
    const destino = await comoUsuario(USUARIO_ADMIN, () =>
      portadaLlevaA(clienteFalso(USUARIO_ADMIN, g), { pasos: "1" }),
    );
    expect(destino).toBe("/onboarding");
    expect(g.tocadas).toEqual([]);
  });

  it("con lo esencial declarado deja en el hogar, aunque los adornos estén caídos", async () => {
    await h.comoAdmin(async () => {
      await h.db.query(
        "insert into public.member_tracking_settings (member_id, mode) values ($1, 'FULL')",
        [hogar.memberId],
      );
    });

    const destino = await comoUsuario(USUARIO_ADMIN, () =>
      portadaLlevaA(clienteFalso(USUARIO_ADMIN, guion({ rotas: ADORNOS_CAIDOS }))),
    );
    expect(destino).toBe("/family");
  });
});
