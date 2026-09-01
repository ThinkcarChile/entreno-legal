import {
  INGREDIENTES_NUEVOS,
  RENDIMIENTOS_CONFIRMADOS,
  MEDIDAS_POR_UNIDAD,
  RECETAS_ANIDADAS,
} from "./catalog";

/**
 * Resuelve un slug anidado al NOMBRE de la receta que hay que buscar en la base.
 *
 * Dos orígenes posibles y ninguno se adivina:
 *  - otra receta de esta misma biblioteca (las sopaipillas pasadas anidan las
 *    sopaipillas, y las dos se crean en este mismo seed);
 *  - una receta ya publicada antes (las ensaladas del seed viejo).
 *
 * Si no está en ninguno de los dos, falla acá y no en la base.
 */
function nombreAnidado(slug: string, biblioteca: readonly LibraryRecipe[]): string {
  const propia = biblioteca.find((r) => r.slug === slug);
  if (propia) return propia.name;
  const externa = RECETAS_ANIDADAS[slug];
  if (externa) return externa;
  throw new Error(
    `receta anidada desconocida: "${slug}" no está en la biblioteca ni en RECETAS_ANIDADAS`,
  );
}

/**
 * Ordena las recetas para que una que anida a otra se cree DESPUÉS de ella.
 *
 * El seed publica en orden y `comp_anidada` busca la versión vigente por
 * nombre: si la sopaipilla pasada se creara antes que la sopaipilla, el SQL
 * reventaría. Un orden de archivo no es una garantía; un orden topológico sí.
 *
 * Un ciclo (A anida B, B anida A) no tiene orden posible y se declara como
 * error en vez de resolverse con un desempate arbitrario.
 */
export function ordenarPorDependencias(recetas: readonly LibraryRecipe[]): LibraryRecipe[] {
  const porSlug = new Map(recetas.map((r) => [r.slug, r]));
  const salida: LibraryRecipe[] = [];
  const estado = new Map<string, "visitando" | "listo">();

  const visitar = (r: LibraryRecipe, camino: string[]): void => {
    const previo = estado.get(r.slug);
    if (previo === "listo") return;
    if (previo === "visitando") {
      throw new Error(`ciclo de recetas anidadas: ${[...camino, r.slug].join(" → ")}`);
    }
    estado.set(r.slug, "visitando");
    for (const n of r.nested ?? []) {
      const dependencia = porSlug.get(n.slug);
      // Si no está en la biblioteca es externa: ya existe publicada, no hay
      // nada que ordenar.
      if (dependencia) visitar(dependencia, [...camino, r.slug]);
      else nombreAnidado(n.slug, recetas);
    }
    estado.set(r.slug, "listo");
    salida.push(r);
  };

  for (const r of recetas) visitar(r, []);
  return salida;
}
import type { LibraryComponent, LibraryIngredient, LibraryRecipe } from "./types";

/**
 * Generador de seed (§36).
 *
 * La biblioteca vive como datos tipados y el SQL se DERIVA de ella. Escribir el
 * SQL a mano y los tests contra otra cosa es exactamente cómo se deforman las
 * dos: acá hay una sola fuente, y un guardián verifica que el archivo commiteado
 * sea byte a byte lo que produce esta función.
 */

const literal = (t: string) => `'${t.replace(/'/g, "''")}'`;
const nulo = (v: unknown) => (v === undefined || v === null ? "null" : String(v));
const texto = (v: string | undefined) => (v === undefined ? "null" : literal(v));

/** Gramos reales de un componente contado por unidad, más su medida doméstica. */
function porUnidad(c: LibraryComponent): { gramos: number; medida: string } | null {
  if (c.unit !== "UNIT") return null;
  const m = MEDIDAS_POR_UNIDAD[c.ingredient];
  if (!m) {
    // Falla ruidosa a propósito: inventar cuánto pesa "una unidad" de algo es
    // exactamente el tipo de relleno silencioso que este sprint prohíbe.
    throw new Error(
      `"${c.ingredient}" se declara por unidad pero no tiene medida doméstica en MEDIDAS_POR_UNIDAD`,
    );
  }
  return { gramos: c.quantity * m.gramos, medida: m.medida };
}

/** Cantidad y unidad con las que el componente entra a la base. */
export function cantidadNormalizada(c: LibraryComponent): { cantidad: number; unidad: "G" | "ML" } {
  const u = porUnidad(c);
  if (u) return { cantidad: u.gramos, unidad: "G" };
  return { cantidad: c.quantity, unidad: c.unit === "ML" ? "ML" : "G" };
}

function sqlIngrediente(i: LibraryIngredient): string {
  const cols = [
    "canonical_name",
    "display_name",
    "category_id",
    ...(i.defaultMeasurementType ? ["default_measurement_type"] : []),
    ...(i.ediblePortionFactor !== undefined ? ["edible_portion_factor"] : []),
  ];
  const vals = [
    literal(i.canonicalName),
    literal(i.displayName),
    `(cats->>'${i.category}')::uuid`,
    ...(i.defaultMeasurementType ? [`'${i.defaultMeasurementType}'`] : []),
    ...(i.ediblePortionFactor !== undefined ? [String(i.ediblePortionFactor)] : []),
  ];

  const fichas = i.nutrition
    .map((n) => {
      const campos: [string, number | undefined][] = [
        ["energy_kcal", n.energyKcal],
        ["protein_g", n.proteinG],
        ["carbohydrates_g", n.carbohydratesG],
        ["fat_g", n.fatG],
        ["fiber_g", n.fiberG],
        ["sugars_g", n.sugarsG],
        ["saturated_fat_g", n.saturatedFatG],
        ["sodium_mg", n.sodiumMg],
        ["potassium_mg", n.potassiumMg],
        ["phosphorus_mg", n.phosphorusMg],
      ];
      // Solo se escriben los nutrientes CONOCIDOS. Los que no aparecen quedan
      // NULL en la base, que es como se dice "no lo sé" (§14).
      const presentes = campos.filter(([, v]) => v !== undefined);
      // NINGUN nutriente conocido es un caso REAL, y esta plantilla lo emitia
      // como SQL roto: `(..., basis_unit, , source_type)` — una columna vacia
      // que Postgres rechaza con "syntax error at or near ,".
      //
      // Pasa cuando el alimento NO SE COME: el maiz morado de la chicha se
      // hierve y se bota, la hoja de te se infusiona y se retira. La ficha
      // correcta ahi es una SIN macros —lo declara `nutritionUnknownReason`— y
      // el generador tiene que saber escribirla: las columnas de nutriente
      // quedan NULL, que es exactamente como se dice "no se sabe".
      const columnas = presentes.length === 0 ? "" : presentes.map(([k]) => k).join(", ") + ", ";
      const valores =
        presentes.length === 0 ? "" : presentes.map(([, v]) => String(v)).join(", ") + ", ";
      return (
        `    insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit, ${columnas}
` +
        `      source_type, source_name, notes)
` +
        `    values (v_ing, '${n.basis}', '${n.basisUnit}', ${valores}'DEV_SEED', src, ${texto(n.notes)});`
      );
    })
    .join("\n");

  const medida = MEDIDAS_POR_UNIDAD[i.canonicalName];
  const sqlMedida =
    medida && medida.crear
      ? `\n    insert into public.household_measures (ingredient_id, measure_name, quantity, unit)\n` +
        `    values (v_ing, ${literal(medida.medida)}, ${medida.gramos}, 'G');`
      : "";

  return (
    `  insert into public.ingredients (${cols.join(", ")})\n` +
    `  values (${vals.join(", ")})\n` +
    `  on conflict do nothing returning id into v_ing;\n` +
    `  if v_ing is not null then\n${fichas}${sqlMedida}\n  end if;\n`
  );
}

function sqlComponente(c: LibraryComponent, orden: number): string {
  const { cantidad, unidad } = cantidadNormalizada(c);
  const u = porUnidad(c);
  const args = [
    "s",
    literal(c.ingredient),
    `'${c.basis}'`,
    String(cantidad),
    `'${unidad}'`,
    c.cookingMethod ? `'${c.cookingMethod}'` : "null",
    c.optional ? "true" : "false",
    String(orden),
    nulo(c.yieldFactor),
    `'${c.role}'`,
    `'${c.adjustability}'`,
    nulo(c.minQuantity !== undefined ? cantidadDeLimite(c, c.minQuantity) : undefined),
    nulo(c.maxQuantity !== undefined ? cantidadDeLimite(c, c.maxQuantity) : undefined),
    texto(c.notes),
    u ? literal(u.medida) : "null",
    u ? String(c.quantity) : "null",
  ];
  return `  perform pg_temp.comp(${args.join(", ")});`;
}

/** Los límites se declaran en la misma unidad del componente: se convierten igual. */
function cantidadDeLimite(c: LibraryComponent, valor: number): number {
  const m = MEDIDAS_POR_UNIDAD[c.ingredient];
  return c.unit === "UNIT" && m ? valor * m.gramos : valor;
}

function sqlReceta(r: LibraryRecipe, biblioteca: readonly LibraryRecipe[]): string {
  const lineas: string[] = [];
  lineas.push(`  -- ${r.name}`);
  lineas.push(
    `  v_v := pg_temp.receta(${literal(r.name)}, '${r.kind}', ` +
      `array[${r.mealTypes.map((t) => `'${t}'`).join(", ")}]::public.meal_type[], ` +
      `${r.baseServings}, ${r.prepMinutes + r.cookMinutes}, ${literal(r.description)});`,
  );

  // Un slot por tipo, en el orden en que aparece el primer componente.
  const tipos: string[] = [];
  for (const c of r.components) if (!tipos.includes(c.slot)) tipos.push(c.slot);
  for (const n of r.nested ?? []) if (!tipos.includes(n.slot)) tipos.push(n.slot);

  tipos.forEach((tipo, i) => {
    const propios = r.components.filter((c) => c.slot === tipo);
    const anidados = (r.nested ?? []).filter((n) => n.slot === tipo);
    // El slot es obligatorio salvo que TODO lo que contiene sea opcional.
    const requerido = propios.some((c) => !c.optional) || anidados.length > 0;
    lineas.push(`  s := pg_temp.slot(v_v, '${tipo}', ${i + 1}, null, ${requerido});`);
    propios.forEach((c, j) => lineas.push(sqlComponente(c, j + 1)));
    anidados.forEach((n, j) => {
      const nombre = nombreAnidado(n.slug, biblioteca);
      lineas.push(
        `  perform pg_temp.comp_anidada(s, ${literal(nombre)}, ${n.servingsFactor ?? 1}, ${propios.length + j + 1});`,
      );
    });

    for (const a of r.alternatives ?? []) {
      if (a.slot !== tipo) continue;
      lineas.push(
        `  perform pg_temp.alt(s, ${literal(a.ingredient)}, '${a.compatibility}', ` +
          `${texto(a.notes)}, ${nulo(a.quantityEquivalence)});`,
      );
    }
  });

  r.steps.forEach((p, i) => {
    lineas.push(
      `  perform pg_temp.paso(v_v, ${i + 1}, ${literal(p.instruction)}, ${nulo(p.minutes)}, ` +
        `${nulo(p.temperatureC)}, ${texto(p.optionalCapability)}, ${texto(p.manualAlternative)}, ` +
        `${nulo(p.parallelGroup)});`,
    );
  });

  lineas.push(`  perform pg_temp.publicar(v_v);`);
  return lineas.join("\n");
}

const CABECERA = `-- SEED DE DESARROLLO — Sprint 11.5, biblioteca chilena (NO aplicar en producción sin revisión)
--
-- ARCHIVO GENERADO. No editar a mano: se produce desde
-- \`web/src/domain/recipes/library/\` con \`generarSeedSQL()\`, y el guardián
-- \`biblioteca.test.ts\` falla si este archivo y la biblioteca se separan.
--
-- Recetas chilenas reales en la biblioteca GLOBAL, más los alimentos que
-- faltaban para armarlas. Las recetas se emiten en orden topológico: una que
-- reutiliza otra se crea después de ella.
--
-- Toda la nutrición nueva es source_type='DEV_SEED': valores de referencia
-- razonables para que los motores tengan con qué trabajar. NO son datos de una
-- tabla oficial chilena, no son asesoramiento nutricional, y la base tiene un
-- candado (nutrition_unverifiable_sources) que impide marcarlos como
-- verificados. Curarlos contra la Tabla de Composición Química de los Alimentos
-- Chilenos (INTA) queda declarado como pendiente.
--
-- Un nutriente ausente en una ficha significa DESCONOCIDO, jamás cero.
--
-- Requiere: migraciones 0001→0031 y los seeds dev_catalog_seed.sql y
-- dev_recipes_seed.sql aplicados. La 0031 no es opcional: sin ella, el
-- rendimiento del arroz (2,5) rebota contra el check viejo.
`;

const HELPERS = `
-- ---------------------------------------------------------------------------
-- Ayudantes de sesión (pg_temp: desaparecen al cerrar la conexión).
-- Propios, no los de dev_recipes_seed.sql: aquel fija la ajustabilidad y los
-- límites por fórmula (0,6x–1,6x). Acá cada receta los declara, porque no es lo
-- mismo poder mover el arroz que poder mover el azúcar de un postre.
-- ---------------------------------------------------------------------------

create or replace function pg_temp.ing_a(p_name text)
returns uuid language sql stable as $$
  select id from public.ingredients where canonical_name = p_name and household_id is null limit 1;
$$;

create or replace function pg_temp.fact_a(p_name text, p_basis public.weight_basis)
returns uuid language sql stable as $$
  select f.id from public.nutrition_facts f
  join public.ingredients i on i.id = f.ingredient_id
  where i.canonical_name = p_name and i.household_id is null and f.weight_basis = p_basis
  limit 1;
$$;

create or replace function pg_temp.receta(
  p_name text, p_kind public.template_kind, p_types public.meal_type[],
  p_servings int, p_minutes int, p_description text
) returns uuid language plpgsql as $$
declare v_t uuid; v_v uuid;
begin
  insert into public.meal_templates (household_id, kind, name)
  values (null, p_kind, p_name) returning id into v_t;
  insert into public.meal_template_versions
    (template_id, version_number, status, name, description, meal_types, base_servings, base_time_minutes)
  values (v_t, 1, 'DRAFT', p_name, p_description, p_types, p_servings, p_minutes)
  returning id into v_v;
  return v_v;
end $$;

create or replace function pg_temp.slot(
  p_version uuid, p_type public.meal_slot_type, p_order int,
  p_label text default null, p_required boolean default true
) returns uuid language plpgsql as $$
declare v_s uuid;
begin
  insert into public.meal_slots (version_id, slot_type, label, is_required, sort_order)
  values (p_version, p_type, p_label, p_required, p_order) returning id into v_s;
  return v_s;
end $$;

/**
 * Componente. Si el ingrediente no tiene ficha para esa base física, revienta:
 * un componente sin base resoluble es una cantidad sin significado, y prefiero
 * que falle el seed a que el motor calcule sobre una suposición.
 */
create or replace function pg_temp.comp(
  p_slot uuid, p_ing text, p_basis public.weight_basis, p_qty numeric,
  p_unit public.nutrition_basis_unit, p_method public.cooking_method, p_optional boolean,
  p_order int, p_yield numeric, p_role public.component_role,
  p_adjust public.slot_adjustability, p_min numeric, p_max numeric, p_notes text,
  p_measure text, p_measure_count numeric
) returns void language plpgsql as $$
declare
  v_ing uuid; v_fact uuid; v_unit public.nutrition_basis_unit; v_measure uuid;
begin
  v_ing := pg_temp.ing_a(p_ing);
  if v_ing is null then
    raise exception 'Alimento desconocido en la biblioteca: %', p_ing;
  end if;
  v_fact := pg_temp.fact_a(p_ing, p_basis);
  if v_fact is null then
    raise exception 'El alimento % no tiene ficha nutricional en base %', p_ing, p_basis;
  end if;
  select basis_unit into v_unit from public.nutrition_facts where id = v_fact;
  if v_unit is distinct from p_unit then
    raise exception 'Unidad incompatible para %: la ficha está en % y la receta pide %',
      p_ing, v_unit, p_unit;
  end if;

  if p_measure is not null then
    select id into v_measure from public.household_measures
    where ingredient_id = v_ing and measure_name = p_measure and household_id is null limit 1;
  end if;

  insert into public.meal_slot_components
    (slot_id, ingredient_id, quantity, unit, weight_basis, nutrition_fact_id,
     cooking_method, is_optional, sort_order, yield_factor,
     adjustability, min_quantity, max_quantity, role, notes,
     measure_id, measure_count)
  values (p_slot, v_ing, p_qty, p_unit, p_basis, v_fact,
          p_method, p_optional, p_order, p_yield,
          p_adjust, p_min, p_max, p_role, p_notes,
          v_measure, p_measure_count);
end $$;

/**
 * Ensalada o postre reutilizable, referenciado por VERSIÓN publicada.
 *
 * La cantidad de un componente anidado es un PESO TOTAL, no un número de
 * porciones: al expandirlo, la app reparte ese peso entre los componentes de la
 * ensalada proporcionalmente. Por eso acá se suma el peso real de la versión
 * anidada y se multiplica por el factor. Poner el número de porciones dejaría
 * una ensalada de 4 gramos dentro del plato.
 */
create or replace function pg_temp.comp_anidada(
  p_slot uuid, p_receta text, p_factor numeric, p_order int
) returns void language plpgsql as $$
declare v_version uuid; v_peso numeric;
begin
  select t.current_version_id into v_version
  from public.meal_templates t
  where t.name = p_receta and t.household_id is null limit 1;
  if v_version is null then
    raise exception 'La receta anidada % no existe o no está publicada', p_receta;
  end if;

  select coalesce(sum(c.quantity), 0) into v_peso
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  where s.version_id = v_version;

  if v_peso <= 0 then
    raise exception 'La receta anidada % no tiene componentes con peso', p_receta;
  end if;

  insert into public.meal_slot_components
    (slot_id, nested_version_id, quantity, unit, weight_basis, sort_order,
     adjustability, min_quantity, max_quantity, role)
  values (p_slot, v_version, round(v_peso * p_factor, 3), 'G', 'RAW', p_order,
          'ADJUSTABLE', round(v_peso * p_factor * 0.5, 3), round(v_peso * p_factor * 1.5, 3), 'MAIN');
end $$;

create or replace function pg_temp.alt(
  p_slot uuid, p_ing text, p_compat public.culinary_compatibility,
  p_notes text, p_equiv numeric
) returns void language plpgsql as $$
declare v_ing uuid;
begin
  v_ing := pg_temp.ing_a(p_ing);
  if v_ing is null then
    raise exception 'Alternativa apunta a un alimento inexistente: %', p_ing;
  end if;
  insert into public.meal_slot_alternatives
    (slot_id, ingredient_id, culinary_compatibility, notes, quantity_equivalence)
  values (p_slot, v_ing, p_compat, p_notes, p_equiv);
end $$;

create or replace function pg_temp.paso(
  p_version uuid, p_n int, p_text text, p_min int, p_temp int,
  p_opt_cap text, p_manual text, p_parallel int
) returns void language plpgsql as $$
begin
  insert into public.recipe_steps
    (version_id, step_number, instruction, duration_minutes, temperature_c,
     optional_capability, manual_alternative, parallel_group)
  values (p_version, p_n, p_text, p_min, p_temp, p_opt_cap, p_manual, p_parallel);
end $$;

/** Congela la ficha de cada componente y recién entonces publica. */
create or replace function pg_temp.publicar(p_version uuid)
returns void language plpgsql as $$
begin
  update public.meal_slot_components c set
    frozen_nutrition = jsonb_build_object(
      'weight_basis', f.weight_basis,
      'basis_unit',   f.basis_unit,
      'values', jsonb_strip_nulls(jsonb_build_object(
        'energy_kcal', f.energy_kcal, 'protein_g', f.protein_g,
        'carbohydrates_g', f.carbohydrates_g, 'fat_g', f.fat_g,
        'fiber_g', f.fiber_g, 'sugars_g', f.sugars_g,
        'saturated_fat_g', f.saturated_fat_g, 'sodium_mg', f.sodium_mg,
        'potassium_mg', f.potassium_mg, 'phosphorus_mg', f.phosphorus_mg))),
    frozen_source = jsonb_build_object(
      'source_type', f.source_type, 'source_name', f.source_name,
      'verified', f.verified, 'nutrition_fact_id', f.id)
  from public.nutrition_facts f
  where f.id = c.nutrition_fact_id
    and c.slot_id in (select id from public.meal_slots where version_id = p_version);

  update public.meal_template_versions
  set status = 'PUBLISHED', published_at = now()
  where id = p_version;

  update public.meal_templates t
  set current_version_id = p_version
  where t.id = (select template_id from public.meal_template_versions where id = p_version);
end $$;
`;

/** SQL completo del lote, derivado de la biblioteca tipada. */
export function generarSeedSQL(recetas: LibraryRecipe[]): string {
  const ingredientes = INGREDIENTES_NUEVOS.map(sqlIngrediente).join("\n");
  const rendimientos = RENDIMIENTOS_CONFIRMADOS.map(
    (r) => `  (${texto(r.ingrediente)}, ${texto(r.metodo)}, ${r.factor}, ${texto(r.nota)})`,
  ).join(",\n");

  return (
    CABECERA +
    `
-- ---------------------------------------------------------------------------
-- Alimentos nuevos (${INGREDIENTES_NUEVOS.length})
-- ---------------------------------------------------------------------------

do $$
declare
  v_ing uuid;
  cats jsonb := '{}'::jsonb;
  cat record;
  src constant text := 'Seed de desarrollo — valores no oficiales';
begin
  for cat in select id, code from public.ingredient_categories loop
    cats := cats || jsonb_build_object(cat.code, cat.id::text);
  end loop;

${ingredientes}end $$;

-- ---------------------------------------------------------------------------
-- Rendimientos crudo→cocido confirmados (${RENDIMIENTOS_CONFIRMADOS.length})
-- ---------------------------------------------------------------------------
-- El ShoppingEngine consulta ingredient_yields; sin la fila, "no sé cuánto
-- comprar" (que es lo correcto) y la receta queda en el registro 8. Cada factor
-- de acá tiene su razón escrita en RENDIMIENTOS_CONFIRMADOS del catálogo tipado:
-- esta tabla es donde un hueco se CIERRA, nunca donde se tapa.

insert into public.ingredient_yields (ingredient_id, cooking_method, yield_factor, notes)
select i.id, r.metodo::public.cooking_method, r.factor, r.nota
from public.ingredients i
join (values
${rendimientos}
) as r(nombre, metodo, factor, nota) on i.canonical_name = r.nombre
where i.household_id is null
on conflict do nothing;
` +
    HELPERS +
    `
-- ---------------------------------------------------------------------------
-- Las ${recetas.length} recetas de la biblioteca
-- ---------------------------------------------------------------------------

do $$
declare
  v_v uuid;
  s uuid;
begin
${ordenarPorDependencias(recetas).map((r) => sqlReceta(r, recetas)).join("\n\n")}
end $$;
`
  );
}
