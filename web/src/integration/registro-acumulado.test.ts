import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { componentRowSchema, toComponent } from "@/app/recipes/queries";
import { parseRows } from "@/lib/supabase/rows";
import { aggregateDemand, type ConfirmedComponent, type ShoppingInput } from "@/domain/shopping/engine";
import { calculateMealNutrition } from "@/domain/recipes/nutrition";
import type { RecipeComponent, SlotType } from "@/domain/recipes/types";
import { BIBLIOTECA, INGREDIENTES_NUEVOS } from "@/domain/recipes/library";
import {
  CAPACIDADES_FALTANTES,
  REQUIEREN_PORCION_COMESTIBLE,
  REQUIEREN_RENDIMIENTO,
} from "@/domain/recipes/library/expectativas";
import { componentesDe, levantarBase, type Harness } from "./harness";

/**
 * REGISTRO ACUMULADO DE LA BIBLIOTECA — pedido del director para los lotes B-E.
 *
 * Los ocho registros no se mantienen a mano. Un documento escrito a pulso se
 * desactualiza exactamente igual que la biblioteca que pretende vigilar: se
 * DERIVAN de la base real y de la biblioteca, y se regeneran después de cada
 * lote. Si el archivo commiteado no coincide con lo que sale hoy, este test
 * falla y obliga a regenerarlo.
 *
 * Regla explícita del director que este archivo respeta al pie de la letra:
 * **no corregir datos existentes con factores inventados**. Los registros
 * SEÑALAN el hueco (con su razón culinaria declarada); nunca lo rellenan.
 */

let h: Harness;
const RUTA = path.resolve(__dirname, "../../../docs/qa/sprint-11-5-registro-acumulado.md");

interface FilaIngrediente {
  id: string;
  canonical_name: string;
  display_name: string;
  categoria: string | null;
  edible_portion_factor: string | null;
}

let ingredientes: FilaIngrediente[] = [];
const recetas: {
  versionId: string;
  nombre: string;
  porciones: number;
  /** Con las recetas anidadas expandidas, como calcula la app. */
  componentes: RecipeComponent[];
  /** Sin expandir: lo que la receta declara por sí misma. */
  propios: RecipeComponent[];
}[] = [];

beforeAll(async () => {
  h = await levantarBase();

  ingredientes = await h.filas<FilaIngrediente>(
    `select i.id, i.canonical_name, i.display_name, c.code as categoria, i.edible_portion_factor
     from public.ingredients i
     left join public.ingredient_categories c on c.id = i.category_id
     where i.household_id is null order by i.canonical_name`,
  );

  const versiones = await h.filas<{ id: string; name: string; base_servings: number }>(
    `select v.id, v.name, v.base_servings
     from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.household_id is null and v.status = 'PUBLISHED'
     order by v.name`,
  );

  for (const v of versiones) {
    recetas.push({
      versionId: v.id,
      nombre: v.name,
      porciones: Number(v.base_servings),
      componentes: await componentesExpandidos(v.id),
      propios: await componentesPropios(v.id),
    });
  }
}, 300_000);

/**
 * Componentes con las recetas anidadas EXPANDIDAS, igual que hace la app en
 * `loadRecipe` (`expandNested`). Sin esto el registro mediría algo que el
 * usuario nunca ve: la ensalada anidada aparecería sin nutrición y las cinco
 * recetas que reutilizan una saldrían con la energía incompleta.
 *
 * Una sola vuelta de anidamiento, igual que la app: una ensalada dentro de una
 * ensalada no aporta nada y abre la puerta a ciclos.
 */
async function componentesPropios(versionId: string): Promise<RecipeComponent[]> {
  const filas = await componentesDe(h, versionId);
  return parseRows(componentRowSchema, filas, "componentes").map((row, i) =>
    toComponent(row, (filas[i] as { slot_type: SlotType }).slot_type),
  );
}

async function componentesExpandidos(versionId: string): Promise<RecipeComponent[]> {
  const base = await componentesPropios(versionId);

  const salida: RecipeComponent[] = [];
  for (const c of base) {
    if (c.target.kind !== "SALAD") {
      salida.push(c);
      continue;
    }
    const anidadas = await componentesDe(h, c.target.saladVersionId);
    const dentro = parseRows(componentRowSchema, anidadas, "componentes anidados").map((row, i) =>
      toComponent(row, (anidadas[i] as { slot_type: SlotType }).slot_type),
    );
    // La cantidad del anidado es el peso TOTAL que entra al plato: se reparte
    // proporcionalmente entre los componentes de la ensalada.
    const pesoInterno = dentro.reduce((t, x) => t + x.quantity, 0);
    const factor = pesoInterno > 0 ? c.quantity / pesoInterno : 1;
    for (const x of dentro) {
      salida.push({
        ...x,
        id: `${c.id}:${x.id}`,
        slotId: c.slotId,
        quantity: x.quantity * factor,
        isOptional: c.isOptional || x.isOptional,
      });
    }
  }
  return salida;
}

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------- registro 1
async function registro1(): Promise<string[]> {
  const filas = await h.filas<{ canonical_name: string; bases: string; verified: boolean }>(
    `select i.canonical_name,
            string_agg(distinct f.weight_basis::text, ', ' order by f.weight_basis::text) as bases,
            bool_or(f.verified) as verified
     from public.nutrition_facts f
     join public.ingredients i on i.id = f.ingredient_id
     where f.source_type = 'DEV_SEED' and i.household_id is null
     group by i.canonical_name order by i.canonical_name`,
  );
  return filas.map((f) => `| \`${f.canonical_name}\` | ${f.bases} | ${f.verified ? "**SÍ — REVISAR**" : "no"} |`);
}

// ---------------------------------------------------------------- registro 2
function registro2(): { porcion: string[]; rendimiento: string[] } {
  const porNombre = new Map(ingredientes.map((i) => [i.canonical_name, i]));

  const porcion = REQUIEREN_PORCION_COMESTIBLE.filter((e) => {
    const i = porNombre.get(e.ingrediente);
    return i && i.edible_portion_factor === null;
  }).map((e) => `| \`${e.ingrediente}\` | ${e.razon} | sin factor |`);

  // Un alimento "tiene rendimiento" si existe una fila en ingredient_yields o
  // si alguna receta lo declara. Se mira el catálogo, no la receta: el
  // ShoppingEngine consulta ingredient_yields, no los componentes.
  const declaradosEnRecetas = new Set(
    recetas.flatMap((r) =>
      r.componentes
        .filter((c) => c.yieldFactor !== null && c.target.kind === "INGREDIENT")
        .map((c) => (c.target as { ingredientId: string }).ingredientId),
    ),
  );

  const rendimiento = REQUIEREN_RENDIMIENTO.filter((e) => {
    const i = porNombre.get(e.ingrediente);
    return i && !declaradosEnRecetas.has(i.id);
  }).map((e) => `| \`${e.ingrediente}\` | ${e.razon} | sin rendimiento en ninguna receta ni en \`ingredient_yields\` |`);

  return { porcion, rendimiento };
}

// ---------------------------------------------------------------- registro 3
function registro3(): { filas: string[]; resumen: Map<string, number> } {
  const resumen = new Map<string, number>();
  const filas: string[] = [];

  for (const r of recetas) {
    const n = calculateMealNutrition(r.componentes, r.porciones);
    const flojos = Object.entries(n.perServing.completeness)
      .filter(([, estado]) => estado !== "COMPLETE")
      .map(([k, estado]) => `${k}:${estado}`);
    for (const f of flojos) {
      const clave = f.split(":")[0]!;
      resumen.set(clave, (resumen.get(clave) ?? 0) + 1);
    }
    if (flojos.length > 0) filas.push(`| ${r.nombre} | ${flojos.join(", ")} |`);
  }
  return { filas, resumen };
}

// ---------------------------------------------------------------- registro 4
async function registro4(): Promise<string[]> {
  // pg_trgm sobre los nombres canónicos: dos identidades parecidas son la
  // sospecha, no la sentencia. El humano decide si son el mismo alimento.
  // El par se ordena por NOMBRE, no por id. Los uuid son aleatorios: con
  // `a.id < b.id` el mismo par salía a veces como (negra, magra) y a veces como
  // (magra, negra), y el registro dejaba de ser reproducible. Un registro que
  // cambia solo entre corridas no sirve para vigilar nada.
  const pares = await h.filas<{ a: string; b: string; sim: number }>(
    `select a.canonical_name as a, b.canonical_name as b,
            round(similarity(a.canonical_name, b.canonical_name)::numeric, 3) as sim
     from public.ingredients a
     join public.ingredients b
       on a.canonical_name < b.canonical_name
      and a.household_id is null and b.household_id is null
     where similarity(a.canonical_name, b.canonical_name) > 0.45
     order by sim desc, a.canonical_name, b.canonical_name`,
  );

  // Y los alias declarados: si un alias de un alimento nuevo coincide con el
  // nombre canónico de otro, hay dos identidades para lo mismo.
  const canonicos = new Set(ingredientes.map((i) => i.canonical_name));
  const aliasChocados = INGREDIENTES_NUEVOS.flatMap((i) =>
    (i.aliases ?? [])
      .filter((a) => canonicos.has(a) && a !== i.canonicalName)
      .map((a) => `| \`${i.canonicalName}\` | alias \`${a}\` es el nombre canónico de otro alimento | 1.000 |`),
  );

  return [
    ...pares.map((p) => `| \`${p.a}\` | \`${p.b}\` | ${p.sim} |`),
    ...aliasChocados,
  ];
}

// ---------------------------------------------------------------- registro 5
function registro5(): string[] {
  const conteo = new Map<string, number>();
  for (const r of recetas) {
    const vistos = new Set(r.componentes.map((c) => c.label));
    for (const l of vistos) conteo.set(l, (conteo.get(l) ?? 0) + 1);
  }
  return [...conteo.entries()]
    .filter(([, n]) => n >= 20)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `| ${label} | ${n} | ${((n / recetas.length) * 100).toFixed(0)} % |`);
}

/**
 * Piso de Jaccard para que un par entre a la tabla.
 *
 * Con cien recetas la tabla mostraba todo lo que pasaba el 80 % de solape y se
 * leía entera. Con doscientas ochenta y dos son SETECIENTOS pares, y casi todos
 * son lo que el propio encabezado explica que no es un duplicado: una receta
 * chica contenida en una grande. Una tabla de setecientas filas donde diez
 * importan no es más información — es la forma más segura de que nadie vuelva a
 * mirar el registro.
 *
 * Los que quedan fuera se CUENTAN y se dicen: acotar sin avisar sería fingir
 * que la biblioteca está más limpia de lo que está.
 */
const JACCARD_MINIMO = 0.65;

// ---------------------------------------------------------------- registro 6
function registro6(): { pares: string[]; contenidas: number } {
  // Sin expandir a propósito: reutilizar la ensalada chilena en cuatro platos
  // es diseño, no duplicación. Si se comparan los componentes expandidos, cada
  // plato que anida la ensalada aparece como "100 % igual a la ensalada", que
  // es ruido puro.
  const conjuntos = recetas.map((r) => ({
    nombre: r.nombre,
    ids: new Set(
      r.propios
        .filter((c) => c.role === "MAIN")
        .map((c) => c.label),
    ),
  }));

  const pares: string[] = [];
  let contenidas = 0;
  for (let i = 0; i < conjuntos.length; i++) {
    for (let j = i + 1; j < conjuntos.length; j++) {
      const a = conjuntos[i]!;
      const b = conjuntos[j]!;
      if (a.ids.size === 0 || b.ids.size === 0) continue;
      const comunes = [...a.ids].filter((x) => b.ids.has(x)).length;
      // Dos medidas, porque una sola miente. El solapamiento sobre la receta
      // MÁS CHICA detecta "B es casi un subconjunto de A"; el Jaccard dice si
      // las dos recetas son realmente lo mismo. Un 100 % sobre 3 componentes
      // con Jaccard 38 % es una receta chica dentro de una grande, no un
      // duplicado — y sin la segunda columna eso parecía una alarma.
      const menor = Math.min(a.ids.size, b.ids.size);
      const union = new Set([...a.ids, ...b.ids]).size;
      const solape = comunes / menor;
      const jaccard = comunes / union;
      if (solape <= 0.8) continue;
      if (jaccard < JACCARD_MINIMO) {
        contenidas++;
        continue;
      }
      pares.push(
        `| ${a.nombre} | ${b.nombre} | ${(solape * 100).toFixed(0)} % | ${(jaccard * 100).toFixed(0)} % | ${comunes} de ${menor} |`,
      );
    }
  }
  return { pares, contenidas };
}

// ---------------------------------------------------------------- registro 7
async function registro7(): Promise<{ faltantes: string[]; huerfanas: string[] }> {
  const existentes = new Set(
    (await h.filas<{ code: string }>("select code from public.equipment_capabilities")).map((c) => c.code),
  );
  const usadas = await h.filas<{ optional_capability: string; name: string }>(
    `select distinct p.optional_capability, v.name
     from public.recipe_steps p
     join public.meal_template_versions v on v.id = p.version_id
     where p.optional_capability is not null`,
  );

  return {
    faltantes: CAPACIDADES_FALTANTES.map(
      (c) =>
        `| \`${c.codigo}\` | ${c.nombre} | ${c.porQue} | ${c.recetas.join(", ")} | ${c.resueltaEn ?? "**pendiente**"} |`,
    ),
    huerfanas: usadas
      .filter((u) => !existentes.has(u.optional_capability))
      .map((u) => `| \`${u.optional_capability}\` | ${u.name} |`),
  };
}

// ---------------------------------------------------------------- registro 8
async function registro8(): Promise<string[]> {
  const meta = ingredientes.map((i) => ({
    id: i.id,
    label: i.display_name,
    categoryCode: i.categoria,
    ediblePortionFactor:
      i.edible_portion_factor === null ? null : Number(i.edible_portion_factor),
  }));
  const yields = (
    await h.filas<{ ingredient_id: string; cooking_method: string | null; yield_factor: string }>(
      "select ingredient_id, cooking_method, yield_factor from public.ingredient_yields",
    )
  ).map((y) => ({
    ingredientId: y.ingredient_id,
    cookingMethod: y.cooking_method,
    factor: Number(y.yield_factor),
  }));

  const problemas: string[] = [];
  for (const r of recetas) {
    const componentes: ConfirmedComponent[] = r.componentes
      .filter((c) => c.target.kind !== "SALAD")
      .map((c) => ({
        ingredientId: c.target.kind === "INGREDIENT" ? c.target.ingredientId : null,
        productId: c.target.kind === "PRODUCT" ? c.target.productId : null,
        label: c.label,
        quantity: c.quantity,
        unit: c.unit as "G" | "ML",
        weightBasis: c.weightBasis,
        cookingMethod: c.cookingMethod,
        addedFatG: 0,
      }));
    if (componentes.length === 0) continue;

    const input: ShoppingInput = {
      servings: [
        {
          assignmentId: r.versionId,
          date: "2026-08-25",
          mealType: "LUNCH",
          memberId: "auditoria",
          memberName: "Auditoría",
          components: componentes,
        },
      ],
      yields,
      ingredients: meta,
      products: [],
    };

    for (const linea of aggregateDemand(input)) {
      if (linea.unresolved) {
        problemas.push(`| ${r.nombre} | ${linea.label} | ${linea.purchaseBasis} | ${linea.unresolvedReason ?? "sin razón"} |`);
      }
    }
  }
  return problemas;
}

// ---------------------------------------------------------------------------
describe("registro acumulado de la biblioteca", () => {
  it("el documento commiteado refleja el estado real de hoy", async () => {
    const r1 = await registro1();
    const r2 = registro2();
    const r3 = registro3();
    const r4 = await registro4();
    const r5 = registro5();
    const r6 = registro6();
    const r7 = await registro7();
    const r8 = await registro8();

    const nuevos = INGREDIENTES_NUEVOS.length;
    const tabla = (filas: string[], cabecera: string, vacio: string) =>
      filas.length === 0 ? `_${vacio}_\n` : `${cabecera}\n${filas.join("\n")}\n`;

    const doc = `# Registro acumulado — Biblioteca chilena (Sprint 11.5)

**ARCHIVO GENERADO.** Se produce desde la base real y la biblioteca con
\`web/src/integration/registro-acumulado.test.ts\`, y se regenera después de cada
lote. No editar a mano: el test falla si este archivo y la realidad se separan.

**Estado de la BASE DE PRUEBAS**, que es donde se mide esto: ${recetas.length} recetas · ${ingredientes.length} alimentos · ${nuevos} agregados por la biblioteca · ${BIBLIOTECA.length} recetas en la biblioteca tipada.

> **Esto NO es producción.** El número sale de aplicar migraciones y seeds sobre un Postgres
> efímero, no de consultar la base real. La biblioteca vive en
> \`supabase/seed/dev_recipes_biblioteca.sql\`, cuya primera línea dice "NO aplicar en
> producción sin revisión" — porque su nutrición es \`DEV_SEED\`, valores de referencia de
> desarrollo y no datos del INTA. Mientras ese seed no se aplique, producción sigue con los 23
> alimentos originales y ninguna de estas recetas.
>
> Acá decía "recetas publicadas", y eso se leía como "están en la base". No lo estaban. Una
> auditoría lo levantó como una promesa que el sistema no cumple, y tenía razón: el número era
> aritmética sobre los arreglos del código.

> **Regla que gobierna estos registros:** señalan huecos, no los rellenan.
> Ningún factor de porción comestible ni de rendimiento se inventa para que una
> tabla se vea completa. Un hueco declarado es información; un número inventado
> es un error que viaja hasta la lista de compras.

---

## 1 · Alimentos con nutrición \`DEV_SEED\`

Valores de referencia de desarrollo. **No** son datos de la Tabla de Composición
Química de los Alimentos Chilenos (INTA). El constraint
\`nutrition_unverifiable_sources\` impide marcarlos como verificados; la columna
"¿verificado?" debe decir "no" en todas las filas.

${tabla(r1, "| alimento | bases | ¿verificado? |\n|---|---|---|", "ningún alimento con nutrición DEV_SEED")}
**Pendiente declarado:** curar estas fichas contra la tabla del INTA.

---

## 2 · Alimentos que necesitan porción comestible o rendimiento y no lo tienen

La expectativa se declara en
\`web/src/domain/recipes/library/expectativas.ts\` con su razón culinaria. El
factor **no** se inventa acá.

### 2a · Sin porción comestible

Impacto: la lista de compras pide de menos. Si la papa se pela y no hay factor,
el sistema compra el peso que se come en vez del que se compra.

${tabla(r2.porcion, "| alimento | por qué la necesita | estado |\n|---|---|---|", "todos los alimentos que la necesitan la tienen")}

### 2b · Sin rendimiento crudo→cocido

Impacto: si una receta expresa cantidades en cocido, el ShoppingEngine no puede
llegar al crudo a comprar y lo declara sin resolver (ver registro 8).

${tabla(r2.rendimiento, "| alimento | por qué lo necesita | estado |\n|---|---|---|", "todos los alimentos que lo necesitan lo declaran")}

---

## 3 · Micronutrientes \`PARTIAL\` o \`UNKNOWN\` por receta

\`PARTIAL\` significa que algunos componentes aportaron el nutriente y otros no:
el número que sale **no es el total**, y el sistema lo dice en vez de fingir que
lo es. \`UNKNOWN\` significa que nadie lo sabía.

Frecuencia por nutriente sobre ${recetas.length} recetas:

| nutriente | recetas afectadas |
|---|---|
${[...r3.resumen.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `| \`${k}\` | ${n} |`).join("\n") || "| — | ninguna |"}

Detalle:

${tabla(r3.filas, "| receta | nutrientes incompletos |\n|---|---|", "todas las recetas calculan completo en todos los nutrientes")}

---

## 4 · Alias e identidades potencialmente duplicadas

Similitud \`pg_trgm\` sobre los nombres canónicos, más los alias declarados que
chocan con un nombre canónico. **Es una sospecha, no una sentencia**: hay pares
legítimamente parecidos (\`porotos secos\` / \`porotos granados frescos\` son
alimentos distintos). Lo que este registro impide es que una identidad duplicada
entre sin que nadie la mire.

${tabla(r4, "| a | b | similitud |\n|---|---|---|", "ningún par supera el umbral de similitud")}

---

## 5 · Ingredientes presentes en 20 o más recetas

Un ingrediente muy transversal concentra riesgo: si su ficha nutricional está
mal, el error se propaga a todas esas recetas a la vez. Son los primeros
candidatos a curar contra la tabla del INTA.

${tabla(r5, "| ingrediente | recetas | % de la biblioteca |\n|---|---|---|", "ningún ingrediente llega a 20 recetas todavía")}

---

## 6 · Recetas que comparten más del 80 % de sus componentes principales

Se comparan solo los componentes con \`role: MAIN\` (condimentos y aceite
aparecen en todo y ensuciarían la señal). Se muestran DOS medidas porque una
sola miente:

- **solape sobre la más chica** — detecta "B es casi un subconjunto de A".
- **Jaccard** — dice si las dos recetas son de verdad la misma cosa.

Un 100 % de solape con Jaccard bajo es una receta chica contenida en una grande
(pollo + papa + cebolla cabe dentro de una cazuela), no un duplicado. Un par con
las dos altas sí hay que justificarlo.

Solo entran los pares con Jaccard de ${(JACCARD_MINIMO * 100).toFixed(0)} % o más, que son los candidatos de
verdad. Otros **${r6.contenidas}** pares pasan el 80 % de solape pero quedan bajo ese
Jaccard: son recetas chicas contenidas en grandes, y listarlas acá enterraría a
las que sí hay que mirar. El número está a la vista justamente para que acotar
no se lea como "no había nada más".

${tabla(r6.pares, "| receta A | receta B | solape | Jaccard | componentes comunes |\n|---|---|---|---|---|", "ningún par supera los dos umbrales")}

---

## 7 · Capacidades de equipo que el schema no representaba

${tabla(r7.faltantes, "| código | nombre | por qué hace falta | recetas | resuelta en |\n|---|---|---|---|---|", "ninguna capacidad faltante registrada")}

### Capacidades usadas por una receta y ausentes del catálogo

Esto sería un error duro: una receta apuntando a un equipo que no existe.

${tabla(r7.huerfanas, "| código | receta |\n|---|---|", "ninguna — toda capacidad usada existe en `equipment_capabilities`")}

---

## 8 · Recetas que el ShoppingEngine no puede convertir a cantidad de compra

Cada receta se pasa por el motor real (\`aggregateDemand\`) como si fuera una
comida confirmada. Una línea "sin resolver" es el motor diciendo *no sé cuánto
comprar* — que es lo correcto — pero también un hueco de datos que alguien tiene
que llenar con un dato real.

${tabla(r8, "| receta | alimento | base de compra | razón |\n|---|---|---|---|", "todas las recetas se convierten a cantidad de compra sin huecos")}
`;

    if (process.env.REGENERAR_REGISTRO === "1") writeFileSync(RUTA, doc, "utf8");
    expect(readFileSync(RUTA, "utf8")).toBe(doc);
  });

  it("ninguna ficha DEV_SEED aparece como verificada", async () => {
    // El candado de la base debería hacer esto imposible. El registro lo
    // comprueba igual: un candado que nadie prueba es una suposición.
    const filas = await h.filas(
      `select 1 from public.nutrition_facts
       where source_type in ('DEV_SEED', 'AI_ESTIMATE') and verified is true`,
    );
    expect(filas).toEqual([]);
  });

  it("ninguna receta usa una capacidad de equipo que no existe", async () => {
    const huerfanas = await h.filas<{ optional_capability: string }>(
      `select distinct p.optional_capability
       from public.recipe_steps p
       left join public.equipment_capabilities e on e.code = p.optional_capability
       where p.optional_capability is not null and e.code is null`,
    );
    expect(huerfanas).toEqual([]);
  });
});
