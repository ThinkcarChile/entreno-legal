import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profileFromRows } from "@/app/family/nutrition-queries";
import { componentRowSchema, toComponent } from "@/app/recipes/queries";
import { parseRows } from "@/lib/supabase/rows";
import type { MemberNutritionProfile } from "@/domain/nutrition/types";
import { projectFamilyServings } from "@/domain/portions/family";
import type { PortionComponent } from "@/domain/portions/optimizer";
import { calculateMealNutrition } from "@/domain/recipes/nutrition";
import { scaleMealTemplateVersion } from "@/domain/recipes/scaling";
import type { RecipeComponent, SlotType } from "@/domain/recipes/types";
import { LOTE_A } from "@/domain/recipes/library";
import {
  componentesDe,
  crearHogar,
  levantarBase,
  patronDe,
  SELECT_PERFIL,
  type Harness,
} from "./harness";

/**
 * CANARIOS DE LA BIBLIOTECA CHILENA — Sprint 11.5 §32.
 *
 * Los guardianes de `biblioteca.test.ts` revisan los datos en TypeScript. Estos
 * canarios revisan otra cosa: que esas 20 recetas, después de viajar a un
 * PostgreSQL real y volver, sigan funcionando con los motores que ya existían.
 *
 * La distinción importa. Una receta puede ser impecable como dato y aun así
 * romperse al pasar por la base — una base física que no calza con su ficha, un
 * rendimiento que un check rechaza, una identidad que no resuelve. Eso solo se
 * ve trayendo las filas de vuelta.
 */

const USER = "00000000-0000-0000-0000-00000000c001";

let h: Harness;
let hogar: { householdId: string; memberId: string };

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar Biblioteca", "Fran");
  await h.como(USER, async () => {
    await h.db.query("select public.seed_demo_family_profiles($1)", [hogar.householdId]);
  });
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

async function versionDe(nombre: string): Promise<string> {
  const fila = await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = $1 and v.status = 'PUBLISHED' and t.household_id is null`,
    [nombre],
  );
  if (!fila) throw new Error(`no existe versión publicada de "${nombre}"`);
  return fila.id;
}

/** Componentes mapeados con el MISMO código que usa la aplicación. */
async function componentesDeReceta(versionId: string): Promise<RecipeComponent[]> {
  const filas = await componentesDe(h, versionId);
  return parseRows(componentRowSchema, filas, "componentes").map((row, i) =>
    toComponent(row, (filas[i] as { slot_type: SlotType }).slot_type),
  );
}

function aPortionComponent(c: RecipeComponent): PortionComponent {
  return {
    id: c.id,
    slotId: c.slotId,
    label: c.label,
    slotType: c.slotType,
    quantity: c.quantity,
    unit: c.unit,
    weightBasis: c.weightBasis,
    nutrition: c.nutrition,
    cookingMethod: c.cookingMethod,
    adjustability: c.adjustability,
    role: c.role,
    minQuantity: c.minQuantity,
    maxQuantity: c.maxQuantity,
    productId: c.target.kind === "PRODUCT" ? c.target.productId : null,
    ingredientId: c.target.kind === "INGREDIENT" ? c.target.ingredientId : null,
    categoryId: c.categoryId,
    isOptional: c.isOptional,
  };
}

async function perfilDe(memberId: string, nombre: string): Promise<MemberNutritionProfile> {
  return profileFromRows(
    {
      tracking: await h.fila(SELECT_PERFIL.tracking, [memberId]),
      goals: await h.filas(SELECT_PERFIL.goals, [memberId]),
      pattern: await patronDe(h, memberId),
      preferences: await h.filas(SELECT_PERFIL.preferences, [memberId]),
      cooking: await h.filas(SELECT_PERFIL.cooking, [memberId]),
      fat: await h.fila(SELECT_PERFIL.fat, [memberId]),
      snapshot: await h.fila(SELECT_PERFIL.snapshot, [memberId]),
    },
    memberId,
    nombre,
  );
}

// ---------------------------------------------------------------------------
describe("canario 1 — las 20 recetas llegaron enteras a la base", () => {
  it("cada receta del lote existe, está publicada y es la versión vigente", async () => {
    const nombres = LOTE_A.map((r) => r.name);
    const filas = await h.filas<{ name: string; status: string; vigente: boolean }>(
      `select v.name, v.status, (t.current_version_id = v.id) as vigente
       from public.meal_template_versions v
       join public.meal_templates t on t.id = v.template_id
       where t.household_id is null and v.name = any($1)`,
      [nombres],
    );
    expect(filas.length).toBe(20);
    expect(filas.filter((f) => f.status !== "PUBLISHED")).toEqual([]);
    expect(filas.filter((f) => !f.vigente)).toEqual([]);
  });

  it("ninguna receta del lote quedó como borrador huérfano", async () => {
    const borradores = await h.filas(
      `select v.name from public.meal_template_versions v
       join public.meal_templates t on t.id = v.template_id
       where t.household_id is null and v.status = 'DRAFT'`,
    );
    expect(borradores).toEqual([]);
  });
});

describe("canario 2 — la nutrición quedó congelada con su fuente", () => {
  it("todo componente publicado tiene ficha congelada y procedencia", async () => {
    const sinCongelar = await h.filas<{ name: string; label: string }>(
      `select v.name, i.display_name as label
       from public.meal_slot_components c
       join public.meal_slots s on s.id = c.slot_id
       join public.meal_template_versions v on v.id = s.version_id
       join public.meal_templates t on t.id = v.template_id
       left join public.ingredients i on i.id = c.ingredient_id
       where t.household_id is null and v.status = 'PUBLISHED'
         and c.ingredient_id is not null
         and (c.frozen_nutrition is null or c.frozen_source is null)`,
    );
    expect(sinCongelar).toEqual([]);
  });

  it("nada de esta biblioteca se presenta como verificado", async () => {
    // Es la regla más importante de todo el lote: los números son de seed, y la
    // base tiene un candado que impide llamarlos verificados. Si algún día
    // alguien carga la tabla del INTA, este test cambia junto con la fuente.
    const verificados = await h.filas<{ name: string }>(
      `select distinct v.name
       from public.meal_slot_components c
       join public.meal_slots s on s.id = c.slot_id
       join public.meal_template_versions v on v.id = s.version_id
       join public.meal_templates t on t.id = v.template_id
       where t.household_id is null and v.name = any($1)
         and (c.frozen_source->>'verified')::boolean is true`,
      [LOTE_A.map((r) => r.name)],
    );
    expect(verificados).toEqual([]);
  });
});

describe("canario 3 — el motor de nutrición calcula sobre recetas reales", () => {
  it("la cazuela de pollo entrega nutrición por porción coherente", async () => {
    const componentes = await componentesDeReceta(await versionDe("Cazuela de pollo"));
    const n = calculateMealNutrition(componentes, 4);

    expect(n.baseServings).toBe(4);
    expect(n.perServing.values.energy_kcal).not.toBeNull();
    // Un almuerzo de olla para 4: la porción tiene que caer en un rango humano.
    expect(n.perServing.values.energy_kcal!).toBeGreaterThan(250);
    expect(n.perServing.values.energy_kcal!).toBeLessThan(900);
    expect(n.perServing.values.protein_g!).toBeGreaterThan(15);
    // Y el total tiene que ser exactamente cuatro veces la porción.
    expect(n.total.values.energy_kcal!).toBeCloseTo(n.perServing.values.energy_kcal! * 4, 6);
  });

  it("un nutriente desconocido llega como desconocido, no como cero", async () => {
    // Varias fichas del lote no declaran fósforo. Si el motor lo devolviera 0,
    // una restricción de fósforo diría "cumple" sobre un dato que no existe.
    const componentes = await componentesDeReceta(await versionDe("Charquicán"));
    const n = calculateMealNutrition(componentes, 4);
    // La energía sí se conoce entera; el fósforo NO, y el motor lo dice en vez
    // de sumar los que sabe y presentarlo como si fuera el total.
    expect(n.perServing.completeness.energy_kcal).toBe("COMPLETE");
    expect(n.perServing.completeness.phosphorus_mg).toBe("PARTIAL");
    expect(n.perServing.values.energy_kcal).not.toBeNull();
  });
});

describe("canario 4 — el rendimiento del arroz sobrevivió el viaje", () => {
  it("2,5 vuelve de la base tal cual (era imposible antes de la 0031)", async () => {
    const componentes = await componentesDeReceta(await versionDe("Arroz con leche"));
    const arroz = componentes.find((c) => c.label.toLowerCase().includes("arroz"));
    expect(arroz).toBeDefined();
    expect(arroz!.yieldFactor).toBe(2.5);
  });

  it("las carnes vuelven con rendimiento DESCONOCIDO, no con 1", async () => {
    const componentes = await componentesDeReceta(await versionDe("Carne mechada"));
    const carne = componentes.find((c) => c.label.toLowerCase().includes("posta"));
    expect(carne).toBeDefined();
    expect(carne!.yieldFactor).toBeNull();
  });
});

describe("canario 5 — lo que se cuenta por unidad conserva su forma original", () => {
  it("la tortilla guarda 440 g y además recuerda que eran 8 huevos", async () => {
    const version = await versionDe("Tortilla de verduras");
    const fila = await h.fila<{ quantity: string; measure_count: string; measure_name: string }>(
      `select c.quantity, c.measure_count, m.measure_name
       from public.meal_slot_components c
       join public.meal_slots s on s.id = c.slot_id
       join public.ingredients i on i.id = c.ingredient_id
       left join public.household_measures m on m.id = c.measure_id
       where s.version_id = $1 and i.canonical_name = 'huevo de gallina'`,
      [version],
    );
    expect(Number(fila!.quantity)).toBe(440);
    expect(Number(fila!.measure_count)).toBe(8);
    expect(fila!.measure_name).toBe("unidad");
  });
});

describe("canario 6 — las ensaladas anidadas apuntan a recetas de verdad", () => {
  it("la merluza frita reutiliza la ensalada chilena publicada", async () => {
    const version = await versionDe("Merluza frita con arroz");
    const anidado = await h.fila<{ nombre: string; status: string }>(
      `select nv.name as nombre, nv.status
       from public.meal_slot_components c
       join public.meal_slots s on s.id = c.slot_id
       join public.meal_template_versions nv on nv.id = c.nested_version_id
       where s.version_id = $1`,
      [version],
    );
    expect(anidado!.nombre).toBe("Ensalada chilena");
    expect(anidado!.status).toBe("PUBLISHED");
  });

  it("la ensalada anidada entra con su PESO real, no con su número de porciones", async () => {
    // El generador ponía acá el número de porciones (4). Como la app reparte
    // esa cantidad entre los componentes de la ensalada, la ensalada entera
    // terminaba pesando 4 gramos dentro del plato. Lo destapó el registro
    // acumulado, no un test: por eso el registro existe.
    const version = await versionDe("Merluza frita con arroz");
    const fila = await h.fila<{ quantity: string; peso_real: string }>(
      `select c.quantity,
              (select sum(ic.quantity) from public.meal_slot_components ic
               join public.meal_slots is2 on is2.id = ic.slot_id
               where is2.version_id = c.nested_version_id) as peso_real
       from public.meal_slot_components c
       join public.meal_slots s on s.id = c.slot_id
       where s.version_id = $1 and c.nested_version_id is not null`,
      [version],
    );
    expect(Number(fila!.quantity)).toBe(Number(fila!.peso_real));
    expect(Number(fila!.quantity)).toBeGreaterThan(300);
  });
});

describe("canario 7 — el equipamiento opcional nunca deja a nadie afuera", () => {
  it("todo paso con capacidad opcional trae su alternativa manual en la base", async () => {
    const sinSalida = await h.filas<{ name: string; optional_capability: string }>(
      `select v.name, p.optional_capability
       from public.recipe_steps p
       join public.meal_template_versions v on v.id = p.version_id
       join public.meal_templates t on t.id = v.template_id
       where t.household_id is null
         and p.optional_capability is not null
         and (p.manual_alternative is null or length(trim(p.manual_alternative)) = 0)`,
    );
    expect(sinSalida).toEqual([]);
  });

  it("la olla a presión existe como capacidad y los porotos la usan como opcional", async () => {
    const capacidad = await h.fila(
      "select code from public.equipment_capabilities where code = 'PRESSURE_COOKER'",
    );
    expect(capacidad).not.toBeNull();

    const paso = await h.fila<{ required_capability: string | null }>(
      `select p.required_capability from public.recipe_steps p
       join public.meal_template_versions v on v.id = p.version_id
       where v.name = 'Porotos con riendas' and p.optional_capability = 'PRESSURE_COOKER'`,
    );
    // Opcional, jamás requerida: sin olla a presión el plato igual se hace.
    expect(paso).not.toBeNull();
    expect(paso!.required_capability).toBeNull();
  });
});

describe("canario 8 — escalar una receta del lote no la deforma", () => {
  it("de 4 a 7 porciones todo crece en la misma proporción", async () => {
    const versionId = await versionDe("Pollo arvejado");
    const componentes = await componentesDeReceta(versionId);
    const escalada = scaleMealTemplateVersion(
      { baseServings: 4, components: componentes },
      7,
    );

    const factor = 7 / 4;
    for (const c of escalada.components) {
      const original = componentes.find((o) => o.id === c.id)!;
      expect(c.baseQuantity).toBe(original.quantity);
      expect(c.quantity).toBeCloseTo(original.quantity * factor, 3);
    }
    // Y la nutrición de 7 porciones se recalcula desde las cantidades nuevas.
    expect(escalada.nutrition.baseServings).toBe(7);
  });
});

describe("canario 9 (§34) — la misma olla, porciones distintas por persona", () => {
  it("la cazuela se reparte diferente entre integrantes con perfiles distintos", async () => {
    const versionId = await versionDe("Cazuela de pollo");
    const componentes = (await componentesDeReceta(versionId)).map(aPortionComponent);

    const miembros = await h.como(USER, () =>
      h.filas<{ id: string; display_name: string }>(
        `select id, display_name from public.household_members
         where household_id = $1 order by display_name`,
        [hogar.householdId],
      ),
    );
    expect(miembros.length).toBeGreaterThanOrEqual(2);

    const perfiles = await Promise.all(
      miembros.slice(0, 3).map(async (m) => ({
        profile: await perfilDe(m.id, m.display_name),
      })),
    );

    const proyeccion = projectFamilyServings({
      versionId,
      components: componentes,
      alternatives: [],
      baseServings: 4,
      mealType: "LUNCH",
      members: perfiles,
    });

    expect(proyeccion.servings.length).toBe(3);

    // El punto del §34: una sola olla, porciones que NO son idénticas. Lo que
    // se sirve vive en `proposedQuantity`; `quantity` sigue siendo la cantidad
    // de la receta base y por eso es igual para todos.
    const proteinas = proyeccion.servings.map((s) =>
      s.components
        .filter((c) => c.slotType === "PROTEIN")
        .reduce((t, c) => t + c.proposedQuantity, 0),
    );
    expect(new Set(proteinas.map((p) => Math.round(p))).size).toBeGreaterThan(1);

    // Y nadie recibe más de lo que hay en la olla.
    for (const s of proyeccion.servings) {
      for (const c of s.components) {
        const base = componentes.find((o) => o.id === c.id);
        if (base) expect(c.proposedQuantity).toBeLessThanOrEqual(base.quantity);
      }
    }
  });
});

describe("canario 10 (§35) — una alternativa culinaria no es una equivalencia nutricional", () => {
  it("cambiar reineta por salmón cambia los números, y el sistema los recalcula", async () => {
    const versionId = await versionDe("Reineta a la plancha con ensalada");
    const componentes = await componentesDeReceta(versionId);
    const original = calculateMealNutrition(componentes, 4);

    const alternativa = await h.fila<{
      culinary_compatibility: string;
      quantity_equivalence: string | null;
      canonical_name: string;
    }>(
      `select a.culinary_compatibility, a.quantity_equivalence, i.canonical_name
       from public.meal_slot_alternatives a
       join public.meal_slots s on s.id = a.slot_id
       join public.ingredients i on i.id = a.ingredient_id
       where s.version_id = $1 and i.canonical_name = 'salmon'`,
      [versionId],
    );
    expect(alternativa).not.toBeNull();
    expect(alternativa!.culinary_compatibility).toBe("GOOD");

    // La ficha del salmón, traída de la base como la traería la app.
    const salmon = await h.fila<Record<string, number | string>>(
      `select f.energy_kcal, f.protein_g, f.fat_g, f.basis_unit, f.weight_basis
       from public.nutrition_facts f
       join public.ingredients i on i.id = f.ingredient_id
       where i.canonical_name = 'salmon' and f.weight_basis = 'RAW'`,
    );

    const pescado = componentes.find((c) => c.label.toLowerCase().includes("reineta"))!;
    const equivalencia = Number(alternativa!.quantity_equivalence);
    const sustituido = componentes.map((c) =>
      c.id !== pescado.id
        ? c
        : {
            ...c,
            // La equivalencia SOLO ajusta la cantidad en la olla (§19).
            quantity: c.quantity * equivalencia,
            nutrition: {
              weightBasis: "RAW" as const,
              basisUnit: "G" as const,
              values: {
                energy_kcal: Number(salmon!.energy_kcal),
                protein_g: Number(salmon!.protein_g),
                fat_g: Number(salmon!.fat_g),
              },
            },
          },
    );
    const conSalmon = calculateMealNutrition(sustituido as RecipeComponent[], 4);

    // Lo que este canario protege: NADIE copió los nutrientes del original.
    expect(conSalmon.perServing.values.energy_kcal).not.toBe(
      original.perServing.values.energy_kcal,
    );
    expect(conSalmon.perServing.values.fat_g!).toBeGreaterThan(
      original.perServing.values.fat_g!,
    );
  });
});
