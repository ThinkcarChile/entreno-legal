import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { soloLoQueProduccionTiene } from "./estado-produccion";

/**
 * PostgreSQL de verdad (compilado a WASM) para las pruebas de integración.
 *
 * Los tres bugs más graves del Sprint 4 vivían en la costura entre la base y la
 * capa de datos: filas con una forma, código esperando otra. Esa costura no se
 * prueba con objetos escritos a mano — hay que traer las filas de un Postgres
 * real, con sus tipos, sus `numeric` que llegan como texto y sus embeds.
 */

const ROOT = path.resolve(__dirname, "../../..");

/**
 * LA CADENA COMPLETA del repo, en orden de aplicación.
 *
 * Ojo con lo que esta lista significa y lo que NO: es lo que el repo sabe
 * construir, no lo que producción tiene puesto. Las dos cosas se separaron el
 * día en que el gate de paridad dio por bueno un `.from()` contra una tabla de
 * la 0036 — una migración que está acá y que producción no tiene. Quién tiene
 * qué lo declara `supabase/estado-produccion.json`, y de ahí sale
 * `MIGRACIONES_DE_PRODUCCION`.
 */
export const MIGRACIONES = [
  "supabase/migrations/0001_family.sql",
  "supabase/migrations/0002_catalog.sql",
  "supabase/migrations/0003_recipes.sql",
  "supabase/migrations/0004_publish_consistency_guard.sql",
  "supabase/migrations/0005_profiles_and_portions.sql",
  "supabase/migrations/0006_component_roles.sql",
  "supabase/migrations/0007_weekly_planning.sql",
  "supabase/migrations/0008_participants_and_serving_lifecycle.sql",
  "supabase/migrations/0009_shopping.sql",
  "supabase/migrations/0010_hardening_sprint6.sql",
  "supabase/migrations/0011_inventory.sql",
  "supabase/migrations/0012_consumption_shortfall.sql",
  "supabase/migrations/0013_stock_intelligence.sql",
  "supabase/migrations/0014_procurement.sql",
  "supabase/migrations/0015_batch_prep.sql",
  "supabase/migrations/0016_freezing_rules.sql",
  "supabase/migrations/0017_random_without_pgcrypto.sql",
  "supabase/migrations/0018_substitution_choices.sql",
  "supabase/migrations/0019_gate_fixes_ledger.sql",
  "supabase/migrations/0020_gate_scope_and_basis.sql",
  "supabase/migrations/0021_gate_netting_basis.sql",
  "supabase/migrations/0022_consume_product_identity.sql",
  "supabase/migrations/0023_confirm_consume_serialization.sql",
  "supabase/migrations/0024_demo_family_function.sql",
  "supabase/migrations/0025_unknown_never_normal.sql",
  "supabase/migrations/0026_health_documents.sql",
  "supabase/migrations/0027_clinical_rules.sql",
  "supabase/migrations/0028_fix_encoding.sql",
  "supabase/migrations/0029_nutrition_source.sql",
  "supabase/migrations/0030_clinical_shopping_impact.sql",
  "supabase/migrations/0031_yield_factor_bounds.sql",
  "supabase/migrations/0032_pressure_cooker_capability.sql",
  // -------------------------------------------------------------------------
  // Auditoría post-Sprint 11.5: las tres fallas que ya corrían en producción.
  // Cada una tiene su regresión; sin migración aplicada, esas regresiones
  // fallan, que es exactamente lo que tienen que hacer.
  // -------------------------------------------------------------------------
  // DEFECTO 1 — congela las columnas de identidad de household_members:
  // saltarse de hogar con un PATCH, revivirse un is_active dado de baja, y
  // desvincular la cuenta ajena (user_id = null) para heredarle la ficha
  // médica por la rama "tutor de dependiente" de app.medical_access.
  // Regresión: gate-security.test.ts, describe "DEFECTO 1".
  "supabase/migrations/0033_cerrar_salto_entre_hogares.sql",
  // DEFECTO 2 — el bucket médico era de ESCRITURA PURA: la 0026 sólo dejó
  // política de INSERT sobre storage.objects, así que nadie podía volver a ver
  // ni borrar el examen recién subido. Acá entran el SELECT y el DELETE,
  // anclados en app.medical_access sobre el integrante de la ruta (jamás una
  // política plana por bucket_id). En PGlite el bloque de storage se salta
  // solo: por eso este defecto vivió meses con los tests en verde.
  "supabase/migrations/0034_storage_medico_lectura_y_borrado.sql",
  // DEFECTO 3 — falso-seguro clínico: una porción confirmada nacía con
  // clinical_status en NULL y se veía idéntica a una evaluada y limpia.
  // UNKNOWN NUNCA SIGNIFICA NORMAL. Regresión: salud-falso-seguro.test.ts.
  //
  // Va con 0035 y no 0034 porque los números 0033 y 0034 ya quedaron tomados
  // en esta misma ronda (y 0033 además choca con 0033_foodlog_plan_vs_reality,
  // que es trabajo del Sprint 12 y NO pertenece a esta cadena todavía).
  "supabase/migrations/0035_porcion_sin_evaluar.sql",
  // 0037: la invitacion era la ventana abierta del salto entre hogares que la
  // 0033 cerro por la puerta. accept_invitation es SECURITY DEFINER, asi que
  // el trigger y el revoke de la 0033 no la alcanzaban.
  "supabase/migrations/0037_invitacion_no_cruza_hogares.sql",
  // Sprint 12 - FoodLog: PLAN != REALITY. Conserva su numero 0036 aunque en el
  // orden real vaya DESPUES de la 0037 (0033-0035 y 0037 ya estan en produccion).
  "supabase/migrations/0036_foodlog_plan_vs_reality.sql",
  // Sprint 12 - FoodLog parte 2: el eje ACTUAL_CONSUMED. La 0036 le sacó a
  // consume_planned_meal el poder de escribir consumo, así que NO PUEDE APLICARSE
  // SOLA: sin esta, el eje queda sin escritor y sus lectores leen el vacío como
  // cero. Las dos van juntas o no va ninguna.
  "supabase/migrations/0038_foodlog_intake.sql",
];

/**
 * La MISMA cadena recortada a lo que el Supabase de verdad tiene aplicado hoy.
 *
 * Se calcula tarde (no al importar el módulo) a propósito: leer y auditar el
 * libro cuesta 38 lecturas de archivo, y los treinta y tantos archivos de
 * integración que solo quieren la base completa no tienen por qué pagarlas.
 * Quien la llama y no puede saber el estado de producción recibe una excepción
 * con nombre y apellido, jamás una lista a medias.
 */
export function migracionesDeProduccion(): string[] {
  return soloLoQueProduccionTiene(MIGRACIONES);
}

// Fixtures de DEMO: datos, jamás schema. Todo objeto que la app referencia
// vive en MIGRACIONES (gate final §3; lo vigila gate-schema-parity.test.ts).
const SEEDS = [
  "supabase/seed/dev_catalog_seed.sql",
  "supabase/seed/dev_recipes_seed.sql",
  // Biblioteca chilena completa, Sprint 11.5. Va DESPUÉS de dev_recipes_seed
  // porque referencia por nombre las ensaladas que aquel publica.
  "supabase/seed/dev_recipes_biblioteca.sql",
];

/**
 * Resuelve una migración a un archivo real.
 *
 * El nombre exacto manda. Si no está, se busca por el prefijo numérico: las
 * migraciones nuevas las escriben otros agentes en paralelo y el sufijo
 * descriptivo lo elige quien las escribe, pero el NÚMERO es el contrato.
 *
 * Si no aparece ninguna, revienta con nombre y apellido. ERROR != VACÍO: una
 * migración de seguridad que no se aplica no puede dar un verde silencioso —
 * eso es exactamente cómo los tres defectos de la auditoría llegaron a
 * producción con 748 tests en verde.
 */
function resolverMigracion(relativo: string): string {
  const absoluto = path.join(ROOT, relativo);
  const carpeta = path.dirname(absoluto);
  const base = path.basename(relativo);
  try {
    return readFileSync(absoluto, "utf8");
  } catch {
    const numero = base.slice(0, 4);
    const candidatos = readdirSync(carpeta).filter(
      (f) => f.startsWith(`${numero}_`) && f.endsWith(".sql"),
    );
    if (candidatos.length === 1) return readFileSync(path.join(carpeta, candidatos[0]!), "utf8");
    if (candidatos.length > 1) {
      throw new Error(
        `Hay ${candidatos.length} migraciones con el prefijo ${numero}: ${candidatos.join(", ")}. ` +
          `Deja una sola o nómbrala exacto en MIGRACIONES (esperaba "${base}").`,
      );
    }
    throw new Error(
      `Falta la migración ${base}: no existe ni ninguna otra con el prefijo ${numero}. ` +
        `Los tests NO se saltan una migración; escríbela antes de correrlos.`,
    );
  }
}

/** Lo que Supabase ya trae de fábrica y las migraciones dan por hecho. */
const ENTORNO_SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
`;

export interface Harness {
  db: PGlite;
  /** Ejecuta como el usuario autenticado indicado, con RLS activa. */
  como<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  /** Ejecuta como postgres (sin RLS), para preparar datos. */
  comoAdmin<T>(fn: () => Promise<T>): Promise<T>;
  filas<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  fila<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  cerrar(): Promise<void>;
}

/**
 * CACHÉ DEL ARRANQUE. Cada archivo de integración levantaba su propio Postgres
 * replayando 38 migraciones y tres seeds. Con cien recetas costaba unos segundos
 * y nadie lo notaba; con doscientas ochenta y dos el `beforeAll` de prep.test.ts
 * cruzó los diez segundos de tope y el archivo entero —treinta y tres tests— se
 * saltó con un "1 failed" que en el resumen parecía un test roto y no una suite
 * completa sin correr.
 *
 * Se guarda el directorio de datos ya construido y los archivos siguientes lo
 * cargan tal cual. La clave es el HASH del contenido de todo lo que se aplica:
 * si cambia una migración, un seed o el orden, la clave cambia y se reconstruye.
 * No hay forma de que un test corra contra un schema viejo sin darse cuenta —
 * que es el único riesgo que una caché así podría introducir.
 */
const CACHE_DIR = path.join(ROOT, "web", "node_modules", ".cache", "pglite-harness");

function claveDeCache(migraciones: readonly string[], conSeeds: boolean): string {
  const partes = [
    // v2: la clave dejó de ser sólo (migraciones + seeds) porque ahora hay DOS
    // cadenas distintas —la completa y la de producción— y una caché que no las
    // distinga serviría el schema equivocado sin decir ni una palabra.
    "v2",
    ENTORNO_SUPABASE,
    ...migraciones.map((m) => `${m}\n${resolverMigracion(m)}`),
    ...(conSeeds ? SEEDS.map((s) => `${s}\n${readFileSync(path.join(ROOT, s), "utf8")}`) : []),
  ];
  return createHash("sha256").update(partes.join(" ")).digest("hex").slice(0, 32);
}

/** Construye la base desde cero: migraciones en orden y, si toca, los seeds. */
async function construir(migraciones: readonly string[], conSeeds: boolean): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  await db.exec("create extension if not exists pg_trgm; create extension if not exists pgcrypto;");
  await db.exec(ENTORNO_SUPABASE);
  for (const archivo of migraciones) await db.exec(resolverMigracion(archivo));
  if (conSeeds) {
    for (const archivo of SEEDS) await db.exec(readFileSync(path.join(ROOT, archivo), "utf8"));
  }
  return db;
}

/**
 * Aplica la cadena migración por migración, avisando ANTES y DESPUÉS de cada
 * una. Sin caché: el punto es justamente ver los estados intermedios.
 *
 * Existe para una sola cosa: probar que los testigos de
 * `supabase/estado-produccion.json` DISCRIMINAN. Un testigo que ya era
 * verdadero antes de su migración daría por aplicada en producción una
 * migración que no lo está, y volveríamos al mismo falso verde por otra puerta.
 */
export async function recorrerCadena(
  migraciones: readonly string[],
  paso: (db: PGlite, archivo: string, momento: "antes" | "despues") => Promise<void>,
): Promise<void> {
  const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  try {
    await db.exec(
      "create extension if not exists pg_trgm; create extension if not exists pgcrypto;",
    );
    await db.exec(ENTORNO_SUPABASE);
    for (const archivo of migraciones) {
      await paso(db, archivo, "antes");
      await db.exec(resolverMigracion(archivo));
      await paso(db, archivo, "despues");
    }
  } finally {
    await db.close();
  }
}

async function abrirBase(migraciones: readonly string[], conSeeds: boolean): Promise<PGlite> {
  let archivo: string;
  try {
    archivo = path.join(CACHE_DIR, `${claveDeCache(migraciones, conSeeds)}.tar.gz`);
  } catch {
    // Si no se puede ni calcular la clave (una migración que falta, por
    // ejemplo), que reviente el camino normal con su mensaje, no la caché.
    return construir(migraciones, conSeeds);
  }

  if (existsSync(archivo)) {
    try {
      const bytes = readFileSync(archivo);
      return await PGlite.create({
        loadDataDir: new Blob([bytes]),
        extensions: { pg_trgm, pgcrypto },
      });
    } catch {
      // Una caché corrupta no puede tumbar la suite: se descarta y se construye.
      try {
        rmSync(archivo, { force: true });
      } catch {
        /* da lo mismo: igual se reconstruye */
      }
    }
  }

  const db = await construir(migraciones, conSeeds);
  try {
    const volcado = await db.dumpDataDir("gzip");
    mkdirSync(CACHE_DIR, { recursive: true });
    // Se escribe a un temporal y se renombra: si dos forks construyen a la vez,
    // nadie llega a leer un archivo a medio escribir.
    const temporal = `${archivo}.${process.pid}.tmp`;
    writeFileSync(temporal, Buffer.from(await volcado.arrayBuffer()));
    renameSync(temporal, archivo);
  } catch {
    /* sin caché igual funciona, solo más lento */
  }
  return db;
}

export async function levantarBase(
  opciones: {
    /**
     * Gate final §3: `false` levanta la base SOLO con migraciones — el schema
     * que Supabase puede reproducir. Los seeds son fixtures de demo, no schema.
     */
    conSeeds?: boolean;
    /**
     * `true` levanta la base con SOLO las migraciones que producción tiene
     * puestas, según `supabase/estado-produccion.json`.
     *
     * Es lo que le faltaba al gate de paridad: comparar la app contra la cadena
     * completa del repo responde "¿esto anda si aplicamos todo?", que no era la
     * pregunta. La pregunta es "¿esto anda HOY, contra la base que atiende a la
     * familia?", y esa se contesta solo con lo que está aplicado.
     *
     * Si el estado de producción no se puede saber, esto revienta con
     * `EstadoDeProduccionDesconocido` en vez de devolver una base a medias.
     */
    soloProduccion?: boolean;
  } = {},
): Promise<Harness> {
  const cadena = opciones.soloProduccion === true ? migracionesDeProduccion() : MIGRACIONES;
  const db = await abrirBase(cadena, opciones.conSeeds !== false);

  const filas = async <T,>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows;

  return {
    db,
    filas,
    fila: async <T,>(sql: string, params: unknown[] = []) => (await filas<T>(sql, params))[0] ?? null,
    async como(userId, fn) {
      await db.exec("set role authenticated;");
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
      try {
        return await fn();
      } finally {
        await db.exec("reset role;");
      }
    },
    async comoAdmin(fn) {
      await db.exec("reset role;");
      return fn();
    },
    cerrar: () => db.close(),
  };
}

/** Crea un usuario de auth y su hogar, y devuelve los ids. */
export async function crearHogar(
  h: Harness,
  userId: string,
  hogar: string,
  nombre: string,
): Promise<{ householdId: string; memberId: string }> {
  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `${nombre.toLowerCase()}@test.dev`,
    ]);
  });

  return h.como(userId, async () => {
    const creado = await h.fila<{ create_household: string }>(
      "select public.create_household($1, $2)",
      [hogar, nombre],
    );
    const householdId = creado!.create_household;
    const miembro = await h.fila<{ id: string }>(
      "select id from public.household_members where household_id = $1 and user_id = $2",
      [householdId, userId],
    );
    return { householdId, memberId: miembro!.id };
  });
}

/** Las columnas que la aplicación pide para armar un perfil. */
export const SELECT_PERFIL = {
  tracking: "select mode from public.member_tracking_settings where member_id = $1",
  goals: `select goal_type, scope, meal_type, minimum, preferred, maximum, priority
          from public.nutrition_goals where member_id = $1 and status = 'ACTIVE'`,
  preferences: `select preference_type, target_kind, target_id
                from public.member_preferences where member_id = $1`,
  cooking: `select ingredient_id, category_id, cooking_method, stance
            from public.member_cooking_preferences where member_id = $1`,
  fat: "select stance from public.member_added_fat_preferences where member_id = $1",
  snapshot: `select id, version from public.member_nutrition_profiles
             where member_id = $1 and is_current`,
};

/** Patrón de comidas con sus slots embebidos, como lo devolvería PostgREST. */
export async function patronDe(h: Harness, memberId: string): Promise<unknown> {
  const patron = await h.fila<Record<string, unknown>>(
    `select uses_fasting_pattern, first_meal_type, feeding_window_start, feeding_window_end, id
     from public.meal_patterns where member_id = $1`,
    [memberId],
  );
  if (!patron) return null;
  const slots = await h.filas(
    `select meal_type, availability, is_first_meal, salad_preference, priority, sort_order
     from public.meal_pattern_slots where pattern_id = $1`,
    [patron.id],
  );
  delete patron.id;
  return { ...patron, meal_pattern_slots: slots };
}

/** Componentes de una versión con sus embeds, como los pide la aplicación. */
export async function componentesDe(h: Harness, versionId: string) {
  const filas = await h.filas<Record<string, unknown>>(
    `select c.id, c.slot_id, c.ingredient_id, c.product_id, c.nested_version_id,
            c.quantity, c.unit, c.weight_basis, c.cooking_method, c.yield_factor,
            c.is_optional, c.sort_order, c.adjustability, c.role,
            c.min_quantity, c.max_quantity, c.frozen_nutrition, c.frozen_source,
            s.slot_type,
            case when i.id is null then null
                 else jsonb_build_object('display_name', i.display_name, 'category_id', i.category_id)
            end as ingredients,
            case when p.id is null then null
                 else jsonb_build_object('name', p.name, 'brand', p.brand)
            end as commercial_products,
            case when f.id is null then null
                 else jsonb_build_object(
                   'id', f.id, 'weight_basis', f.weight_basis, 'basis_unit', f.basis_unit,
                   'source_type', f.source_type, 'source_name', f.source_name, 'verified', f.verified,
                   'energy_kcal', f.energy_kcal, 'protein_g', f.protein_g,
                   'carbohydrates_g', f.carbohydrates_g, 'fat_g', f.fat_g, 'fiber_g', f.fiber_g,
                   'sugars_g', f.sugars_g, 'saturated_fat_g', f.saturated_fat_g,
                   'sodium_mg', f.sodium_mg, 'potassium_mg', f.potassium_mg,
                   'phosphorus_mg', f.phosphorus_mg)
            end as nutrition_facts
     from public.meal_slot_components c
     join public.meal_slots s on s.id = c.slot_id
     left join public.ingredients i on i.id = c.ingredient_id
     left join public.commercial_products p on p.id = c.product_id
     left join public.nutrition_facts f on f.id = c.nutrition_fact_id
     where s.version_id = $1
     order by s.sort_order, c.sort_order`,
    [versionId],
  );
  return filas;
}
