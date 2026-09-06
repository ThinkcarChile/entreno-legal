import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * LO QUE `anon` PUEDE HACER CONTRA LA RLS, Y EL DEFECTO QUE ESO DESTAPÓ.
 *
 * La 0062 le quitó a `anon` el EXECUTE sobre las SECURITY DEFINER y el USAGE
 * sobre el esquema `app`. Eso cerró la puerta que había que cerrar. Pero rompió
 * algo que nadie estaba mirando, y hizo falta arreglar el arnés para verlo:
 *
 * `anon` conserva privilegios de TABLA sobre las 137 tablas de `public` — así
 * viene Supabase, y es correcto: la RLS es la que protege. Doce políticas de
 * `0001_family.sql` se escribieron SIN cláusula `TO`. Una política sin `TO` nace
 * `TO PUBLIC`, y PUBLIC incluye a `anon`. Así que anon SÍ las evalúa, y
 * evaluarlas llama a `app.is_household_member` — que anon ya no puede ejecutar.
 *
 * Resultado medido en producción el 2026-09-04: `/api/health` devolvía
 * **HTTP 503**. La app corriendo contra la base real contestaba
 * `{"ok":false,"version":null,"schema":null}`.
 *
 * LA SONDA YA NO DEPENDE DE ESTO: el mismo día se movió a
 * `ingredient_categories`, cuya única política lleva `to authenticated`, y la
 * vigila `sonda-de-vida.test.ts`. Lo que queda acá es la DEUDA de fondo: las 12
 * políticas sin TO siguen reventando para anon, y cualquier lectura anónima
 * futura sobre esas tablas volvería a dar 503.
 *
 * La 0062 escribió como premisa que "no hay ni una sola `to anon` en las
 * migraciones, así que anon no evalúa ninguna política". Es una inferencia
 * falsa: ausencia de `to anon` NO es ausencia de política aplicable. Ése es el
 * tipo de razonamiento que este archivo existe para que no vuelva a pasar.
 */

let base: Harness;
const SIN_SESION = "select set_config('request.jwt.claim.sub', '', false)";

async function comoAnon<T>(fn: () => Promise<T>): Promise<T> {
  // `como()` no limpia el claim al salir, así que sin este `set_config` un
  // "anon" recién salido de una sesión seguiría cargando su uid — y el test
  // mediría una sesión disfrazada de anónimo.
  await base.db.query(SIN_SESION);
  await base.db.exec("set role anon;");
  try {
    return await fn();
  } finally {
    await base.db.exec("reset role;");
  }
}

beforeAll(async () => {
  base = await levantarBase({ conSeeds: false });
  await crearHogar(base, "00000000-0000-4000-8000-0000000000c1", "Hogar RLS", "Carla");
}, 180_000);

afterAll(async () => {
  await base?.cerrar();
});

describe("anon contra la RLS: el arnés ahora emula lo que Supabase da de verdad", () => {
  it("anon TIENE privilegio de tabla, como en Supabase real", async () => {
    /**
     * LA PREMISA DE TODO ESTE ARCHIVO. Si el arnés vuelve a darle tablas sólo a
     * `authenticated`, los tests de abajo pasan sin probar nada: el `select` de
     * anon moriría en el privilegio de tabla y la política no se evaluaría
     * nunca. Se afirma primero para que ese retroceso se vea acá y no en
     * producción.
     */
    const r = await base.fila<{ n: number }>(
      `select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'anon' and table_schema = 'public' and privilege_type = 'SELECT'`,
    );
    expect(r?.n, "anon perdió el privilegio de tabla: el arnés dejó de emular Supabase").toBeGreaterThan(50);
  });

  it("hay políticas SIN cláusula TO, y por eso anon las evalúa", async () => {
    // El diagnóstico, afirmado sobre el catálogo. `roles = {public}` es cómo
    // PostgreSQL guarda una política escrita sin `TO`.
    const sinTo = await base.filas<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies
        where schemaname = 'public' and 'public' = any(roles) order by 1, 2`,
    );
    expect(sinTo.length, "no quedan políticas sin TO: si se arreglaron, este archivo cambia").toBe(12);
    expect(sinTo.map((p) => p.tablename)).toContain("households");
  });

  it("anon no LEE datos del hogar: la protección sigue en pie", async () => {
    /**
     * LO QUE IMPORTA PARA LA FAMILIA. El defecto de más abajo es de
     * disponibilidad, no de confidencialidad: anon recibe un error en vez de una
     * lista vacía. Lo que NO puede pasar es que reciba filas. Se afirma aparte
     * para que no se confunda un problema con el otro.
     */
    const leidas: string[] = [];
    await comoAnon(async () => {
      for (const t of ["households", "household_members", "consumption_logs", "audit_events"]) {
        try {
          const f = await base.filas<{ n: number }>(`select count(*)::int as n from public.${t}`);
          if ((f[0]?.n ?? 0) > 0) leidas.push(`${t}: ${f[0]?.n} filas`);
        } catch {
          /* rechazado: también es un no */
        }
      }
    });
    expect(leidas, "anon leyó filas del hogar").toEqual([]);
  });

  it.fails("DEUDA REGISTRADA: las 12 políticas sin TO siguen reventando para anon", async () => {
    /**
     * ESTE TEST ESTÁ MARCADO `it.fails` A PROPÓSITO, Y NO ES UN TEST APAGADO.
     *
     * Afirma la propiedad que QUERRÍAMOS —que una lectura anónima sobre el
     * núcleo familiar devuelva vacío y no error— sabiendo que hoy no se cumple.
     * `it.fails` lo deja registrado sin teñir el CI de rojo de forma crónica, y
     * el día que alguien lo arregle (una 0063 con `to authenticated` en las 12
     * políticas de 0001_family.sql), este test se pone ROJO por haber pasado y
     * obliga a venir acá a borrarlo. Un `it.skip` se quedaría mudo para siempre.
     *
     * La sonda de vida ya NO depende de esto: se movió a `ingredient_categories`
     * el 2026-09-04. Esto es deuda de fondo, no un incidente abierto.
     */
    await comoAnon(async () => {
      await base.filas("select count(*) from public.households");
    });
  });

  it("y el motivo exacto por el que falla, nombrado", async () => {
    // Que falle no alcanza: un test que sólo dice "esto revienta" pasa igual
    // cuando revienta por otra razón. Acá se fija el mecanismo.
    let mensaje = "";
    await comoAnon(async () => {
      try {
        await base.filas("select count(*) from public.households");
      } catch (e) {
        mensaje = String((e as Error).message ?? e);
      }
    });
    expect(mensaje).toContain("permission denied");
    expect(mensaje, "el fallo cambió de causa: revisar si sigue siendo el mismo defecto").toContain(
      "is_household_member",
    );
  });
});
