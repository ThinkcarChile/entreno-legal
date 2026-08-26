import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BIBLIOTECA,
  IDENTIDADES_VALIDAS,
  INGREDIENTES_EXISTENTES,
  INGREDIENTES_NUEVOS,
  LOTE_A,
  MEDIDAS_POR_UNIDAD,
  RECETAS_ANIDADAS,
  RECETAS_EXISTENTES,
  cantidadNormalizada,
  generarSeedSQL,
} from ".";
import { ceroEsDefendible } from "./expectativas";

/**
 * GUARDIANES DE LA BIBLIOTECA (§28-§31).
 *
 * Estos tests no prueban código: prueban los DATOS. Una biblioteca de recetas
 * se degrada por acumulación silenciosa — un ingrediente escrito distinto, una
 * cantidad sin base física, un rendimiento inventado para que "cuadre" — y cada
 * una de esas pequeñas mentiras termina en un plato que el motor clínico declara
 * compatible sin serlo.
 *
 * Por eso la biblioteca vive como datos tipados: para que estas reglas se
 * puedan ejecutar en cada commit, no revisar a ojo cada 100 recetas.
 */

const componentes = BIBLIOTECA.flatMap((r) => r.components.map((c) => ({ receta: r, c })));

describe("§28 — toda cantidad tiene base física y significado", () => {
  it("ningún componente queda sin base física declarada", () => {
    const sinBase = componentes.filter(({ c }) => !c.basis);
    expect(sinBase.map(({ receta, c }) => `${receta.slug}/${c.ingredient}`)).toEqual([]);
  });

  it("ninguna cantidad es cero o negativa", () => {
    const malas = componentes.filter(({ c }) => !(c.quantity > 0));
    expect(malas.map(({ receta, c }) => `${receta.slug}/${c.ingredient}=${c.quantity}`)).toEqual([]);
  });

  it("lo que se cuenta por unidad tiene una medida doméstica real", () => {
    // "4 huevos" solo se puede convertir a gramos si alguien declaró cuánto pesa
    // un huevo. Sin eso, el generador tiene que fallar, no adivinar 50 g.
    const sinMedida = componentes
      .filter(({ c }) => c.unit === "UNIT" && !MEDIDAS_POR_UNIDAD[c.ingredient])
      .map(({ receta, c }) => `${receta.slug}/${c.ingredient}`);
    expect(sinMedida).toEqual([]);
  });

  it("la conversión por unidad conserva la cantidad original", () => {
    const huevos = LOTE_A.find((r) => r.slug === "tortilla-de-verduras")!.components.find(
      (c) => c.ingredient === "huevo de gallina",
    )!;
    expect(huevos.quantity).toBe(8);
    // 8 huevos × 55 g = 440 g. La receta sigue diciendo "8 huevos"; la base
    // guarda los gramos Y el measure_count original.
    expect(cantidadNormalizada(huevos)).toEqual({ cantidad: 440, unidad: "G" });
  });

  it("los límites de ajuste encierran la cantidad, nunca la contradicen", () => {
    const rotos = componentes.filter(
      ({ c }) =>
        (c.minQuantity !== undefined && c.minQuantity > c.quantity) ||
        (c.maxQuantity !== undefined && c.maxQuantity < c.quantity),
    );
    expect(rotos.map(({ receta, c }) => `${receta.slug}/${c.ingredient}`)).toEqual([]);
  });
});

describe("§29 — identidad resuelta, nunca inventada", () => {
  it("todo ingrediente de la biblioteca existe en el catálogo", () => {
    const desconocidos = [...new Set(componentes.map(({ c }) => c.ingredient))].filter(
      (n) => !IDENTIDADES_VALIDAS.has(n),
    );
    expect(desconocidos).toEqual([]);
  });

  it("toda alternativa apunta a un alimento que existe", () => {
    const desconocidos = BIBLIOTECA.flatMap((r) => r.alternatives ?? [])
      .map((a) => a.ingredient)
      .filter((n) => !IDENTIDADES_VALIDAS.has(n));
    expect([...new Set(desconocidos)]).toEqual([]);
  });

  it("ningún alimento nuevo duplica uno que ya existe", () => {
    // El error que casi cometo: llamar "cilantro fresco" a lo que el catálogo
    // ya tenía como "cilantro". Dos identidades para el mismo alimento son dos
    // stocks, dos precios y dos historiales que nunca vuelven a juntarse.
    const chocados = INGREDIENTES_NUEVOS.map((i) => i.canonicalName).filter((n) =>
      INGREDIENTES_EXISTENTES.includes(n),
    );
    expect(chocados).toEqual([]);
  });

  it("los alimentos nuevos no se repiten entre sí", () => {
    const nombres = INGREDIENTES_NUEVOS.map((i) => i.canonicalName);
    expect(nombres.length).toBe(new Set(nombres).size);
  });

  it("toda receta anidada apunta a una receta que existe", () => {
    // Dos orígenes válidos y ninguno se adivina: otra receta de esta misma
    // biblioteca (el generador la crea primero, por orden topológico) o una ya
    // publicada antes. El test miraba solo las externas y rechazaba el
    // anidamiento interno, que es justamente lo que el LOTE D necesita para
    // que las guatitas reutilicen la salsa de tomate en tanda.
    const propias = new Set(BIBLIOTECA.map((r) => r.slug));
    const malas = BIBLIOTECA.flatMap((r) => (r.nested ?? []).map((n) => n.slug)).filter(
      (s) => !propias.has(s) && !(s in RECETAS_ANIDADAS),
    );
    expect([...new Set(malas)]).toEqual([]);
  });

  it("toda alternativa se declara sobre un slot que la receta realmente tiene", () => {
    // Un slot puede venir de un componente propio O de una receta anidada. Las
    // empanadas fritas no declaran carne entre sus componentes: la proteína
    // entra por `nested` como pino de carne. Mirando solo `components`, este
    // guardián acusaba de huérfana a una alternativa de pollo perfectamente
    // válida y —lo que importa— habría dejado pasar la falla al revés el día que
    // alguien declare una alternativa sobre un slot que de verdad no existe,
    // porque el ruido enseña a ignorar el test.
    const slotsDe = (r: (typeof BIBLIOTECA)[number]) =>
      new Set([...r.components.map((c) => c.slot), ...(r.nested ?? []).map((n) => n.slot)]);
    const huerfanas = BIBLIOTECA.flatMap((r) => {
      const slots = slotsDe(r);
      return (r.alternatives ?? [])
        .filter((a) => !slots.has(a.slot))
        .map((a) => `${r.slug}/${a.slot}:${a.ingredient}`);
    });
    expect(huerfanas).toEqual([]);
  });

  it("una sustitución de equipo no corre en paralelo: reemplaza a un paso", () => {
    // Encontrado en mote-con-machas: el paso de olla a presión llevaba grupo
    // paralelo Y era una sustitución. Las dos cosas no caben juntas. Si el
    // lector no tiene la olla, el grupo se queda sin ese miembro; si la tiene,
    // cocina el mote DOS VECES, porque el paso base de 45 minutos sigue con su
    // propio grupo. Una sustitución reemplaza a un paso, no corre junto a otro.
    //
    // El filtro es por el texto y no por `optionalCapability`, a propósito: un
    // paso normal puede MENCIONAR un equipo que lo mejora ("calienta la plancha
    // o la sartén") y correr en paralelo sin ningún problema. Lo que no puede
    // es ser el camino alternativo, y eso lo dice el "En vez de".
    const mezclados = BIBLIOTECA.flatMap((r) =>
      r.steps
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => /^en vez de/i.test(p.instruction.trim()) && p.parallelGroup !== undefined)
        .map(({ p, i }) => `${r.slug}/paso ${i + 1}: sustitución con grupo ${p.parallelGroup}`),
    );
    expect(mezclados).toEqual([]);
  });

  it("todo paso que declara paralelismo declara cuánto dura", () => {
    // "Corre en paralelo" sin minutos no le sirve a nadie: el sentido de marcar
    // un paso como paralelo es poder descontarlo del total, y sin duración no
    // hay nada que descontar.
    const sinTiempo = BIBLIOTECA.flatMap((r) =>
      r.steps
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.parallelGroup !== undefined && !((p.minutes ?? 0) > 0))
        .map(({ i }) => `${r.slug}/paso ${i + 1}`),
    );
    expect(sinTiempo).toEqual([]);
  });
});

describe("§30 — nada se rellena con un valor cómodo", () => {
  it("ningún rendimiento se sale del rango que la base acepta", () => {
    // La migración 0031 subió el techo de 2 a 5 justamente por esta biblioteca:
    // el arroz rinde 2,5 y el viejo check lo negaba.
    const fuera = componentes.filter(
      ({ c }) => c.yieldFactor !== undefined && !(c.yieldFactor > 0 && c.yieldFactor <= 5),
    );
    expect(fuera.map(({ receta, c }) => `${receta.slug}/${c.ingredient}=${c.yieldFactor}`)).toEqual(
      [],
    );
  });

  it("las carnes NO declaran rendimiento: su merma no se conoce", () => {
    // Es tentador poner 0,75 y quedar bien. La merma real depende del corte, del
    // fuego y del tiempo; declararla sin dato es inventar. Ausente = desconocido,
    // y el sistema ya sabe tratar lo desconocido.
    const carnes = ["pollo", "vacuno", "reineta", "merluza", "salmon", "carne molida"];
    const inventados = componentes
      .filter(({ c }) => carnes.some((k) => c.ingredient.includes(k)) && c.yieldFactor !== undefined)
      .map(({ receta, c }) => `${receta.slug}/${c.ingredient}`);
    expect(inventados).toEqual([]);
  });

  it("todo lo marcado opcional también es opcional para el optimizador", () => {
    const incoherentes = componentes
      .filter(({ c }) => c.optional && c.adjustability !== "OPTIONAL")
      .map(({ receta, c }) => `${receta.slug}/${c.ingredient}`);
    expect(incoherentes).toEqual([]);
  });

  it("ADDED_FAT es solo la grasa añadida, no la comida que es grasa", () => {
    // ADR 0004: el optimizador puede quitar el chorro de aceite. La palta del
    // pan es comida, aunque sea grasa, y no se puede borrar por preferencia.
    const grasas = componentes.filter(({ c }) => c.role === "ADDED_FAT");
    expect(grasas.length).toBeGreaterThan(0);
    const noSonAceite = grasas
      .filter(({ c }) => !c.ingredient.startsWith("aceite"))
      .map(({ receta, c }) => `${receta.slug}/${c.ingredient}`);
    expect(noSonAceite).toEqual([]);
  });

  it("la sal se modela por su sodio y nunca como fuente de energía", () => {
    const sal = INGREDIENTES_NUEVOS.find((i) => i.canonicalName === "sal")!;
    const ficha = sal.nutrition[0]!;
    expect(ficha.energyKcal).toBe(0);
    expect(ficha.sodiumMg).toBeGreaterThan(30000);
    const comoCondimento = componentes
      .filter(({ c }) => c.ingredient === "sal")
      .every(({ c }) => c.role === "SEASONING");
    expect(comoCondimento).toBe(true);
  });

  it("el azúcar de un postre es componente, no condimento", () => {
    // En el arroz con leche el azúcar ES el plato; en el pastel de choclo es un
    // espolvoreo. La misma sustancia con dos roles distintos, declarados.
    const postre = LOTE_A.find((r) => r.slug === "arroz-con-leche")!;
    const azucarPostre = postre.components.find((c) => c.ingredient === "azucar granulada")!;
    expect(azucarPostre.role).toBe("MAIN");

    const pastel = LOTE_A.find((r) => r.slug === "pastel-de-choclo")!;
    const azucarPastel = pastel.components.find((c) => c.ingredient === "azucar granulada")!;
    expect(azucarPastel.role).toBe("SEASONING");
    expect(azucarPastel.optional).toBe(true);
  });

  it("ningún nutriente desconocido se escribe como cero para verse completo", () => {
    // El único cero legítimo es el que se DERIVA del alimento: el congrio no
    // tiene fibra, el aceite no tiene proteína. Lo que no se sabe no aparece.
    // La regla vive en  para que el script que carga las
    // fichas y este guardián no puedan discrepar.
    const MICROS = ["fiberG", "sugarsG", "saturatedFatG", "sodiumMg", "potassiumMg", "phosphorusMg"] as const;
    const sospechosos = INGREDIENTES_NUEVOS.flatMap((i) =>
      i.nutrition.flatMap((n) =>
        MICROS.filter((k) => n[k] === 0 && !ceroEsDefendible(i, n, k)).map(
          (k) => `${i.canonicalName} (${n.basis}): ${k}`,
        ),
      ),
    );
    expect(sospechosos).toEqual([]);
  });
});

describe("§31 — la biblioteca no se repite ni se pisa con lo que ya existe", () => {
  it("los slugs son únicos", () => {
    const slugs = BIBLIOTECA.map((r) => r.slug);
    const repetidos = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    expect(repetidos).toEqual([]);
  });

  it("los nombres son únicos", () => {
    const nombres = BIBLIOTECA.map((r) => r.name);
    expect(nombres.length).toBe(new Set(nombres).size);
  });

  it("ninguna receta repite una de las que la base ya tenía", () => {
    const normal = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
    const existentes = new Set(RECETAS_EXISTENTES.map(normal));
    const repetidas = BIBLIOTECA.filter((r) => existentes.has(normal(r.name))).map((r) => r.name);
    expect(repetidas).toEqual([]);
  });

  it("cada receta tiene al menos un paso y todos dicen algo", () => {
    const vacias = BIBLIOTECA.filter(
      (r) => r.steps.length === 0 || r.steps.some((p) => p.instruction.trim().length < 10),
    ).map((r) => r.slug);
    expect(vacias).toEqual([]);
  });

  it("todo paso que menciona un equipo opcional explica cómo hacerlo sin él", () => {
    // §13: nadie se queda afuera de una receta por no tener olla a presión.
    const sinSalida = BIBLIOTECA.flatMap((r) =>
      r.steps
        .filter((p) => p.optionalCapability && !p.manualAlternative)
        .map((p) => `${r.slug}: ${p.optionalCapability}`),
    );
    expect(sinSalida).toEqual([]);
  });

  it("ninguna nota de preparación por lotes promete plazos de seguridad", () => {
    // §25: cuánto dura algo en el refrigerador lo decide el motor de seguridad
    // con la fecha real del lote, no un texto escrito hace meses en una receta.
    const prohibido = /\b\d+\s*(d[ií]as?|semanas?|meses?|horas?)\b/i;
    const infractoras = BIBLIOTECA.filter(
      (r) => r.batchPrepNotes && prohibido.test(r.batchPrepNotes),
    ).map((r) => r.slug);
    expect(infractoras).toEqual([]);
  });
});

describe("completeness del LOTE A", () => {
  it("trae las 20 recetas con el reparto que pidió el director", () => {
    expect(LOTE_A.length).toBe(20);
    const porCategoria = LOTE_A.reduce<Record<string, number>>((acc, r) => {
      acc[r.category] = (acc[r.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(porCategoria).toEqual({
      POLLO: 4,
      VACUNO: 3,
      PESCADO: 3,
      LEGUMBRES: 3,
      TRADICIONAL: 3,
      DESAYUNO_ONCE: 2,
      ENSALADA: 1,
      POSTRE: 1,
    });
  });

  it("todo almuerzo y toda cena traen una proteína identificable", () => {
    // Deliberadamente acotado a almuerzo/cena. Una avena con leche de desayuno
    // no tiene slot PROTEIN y no debe tenerlo: su proteína viene de la leche,
    // que ahí es la BASE del plato. Exigirle un slot de proteína obligaría a
    // deformar la receta para satisfacer al test, que es justo al revés.
    const sinProteina = LOTE_A.filter(
      (r) =>
        r.kind === "MEAL" &&
        r.mealTypes.some((t) => t === "LUNCH" || t === "DINNER") &&
        !r.components.some((c) => c.slot === "PROTEIN"),
    ).map((r) => r.slug);
    expect(sinProteina).toEqual([]);
  });

  it("toda receta declara tiempos y porciones reales", () => {
    const malas = LOTE_A.filter(
      (r) => r.baseServings < 1 || r.prepMinutes < 0 || r.cookMinutes < 0,
    ).map((r) => r.slug);
    expect(malas).toEqual([]);
  });

  it("las etiquetas describen algo verdadero: lo rápido es rápido", () => {
    const mentirosas = LOTE_A.filter(
      (r) => r.tags.includes("RAPIDA") && r.prepMinutes + r.cookMinutes > 45,
    ).map((r) => r.slug);
    expect(mentirosas).toEqual([]);
  });
});

describe("§36 — el seed se deriva de la biblioteca, no se escribe a mano", () => {
  it("el archivo SQL commiteado es exactamente lo que produce el generador", () => {
    // BIBLIOTECA, no LOTE_A. Estuvo escrito con LOTE_A mientras solo existía un
    // lote, y al sumar el LOTE B el seed siguió saliendo con 20 recetas: el
    // guardián comparaba felizmente el archivo viejo con la generación vieja.
    // Un test que solo se compara consigo mismo no vigila nada.
    const ruta = path.resolve(__dirname, "../../../../../supabase/seed/dev_recipes_biblioteca.sql");
    const generado = generarSeedSQL(BIBLIOTECA);
    if (process.env.REGENERAR_SEED === "1") writeFileSync(ruta, generado, "utf8");
    expect(readFileSync(ruta, "utf8")).toBe(generado);
  });

  it("el SQL generado no deja comillas sueltas del español", () => {
    // "Cazuela de pollo" no tiene apóstrofes, pero "al jugo" y las notas sí
    // pueden traerlos. Un escape roto acá es una inyección en el seed.
    const sql = generarSeedSQL(BIBLIOTECA);
    const lineas = sql.split("\n").filter((l) => l.trim().startsWith("perform pg_temp."));
    for (const l of lineas) {
      const comillas = (l.match(/'/g) ?? []).length;
      expect(comillas % 2, `comillas impares en: ${l}`).toBe(0);
    }
  });
});
