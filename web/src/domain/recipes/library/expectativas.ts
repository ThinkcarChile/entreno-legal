/**
 * EXPECTATIVAS DECLARADAS PARA LA AUDITORÍA (registros 2 y 7).
 *
 * Un registro de "alimentos que necesitan porción comestible y no la tienen"
 * exige decir primero cuáles la necesitan. Esa decisión es culinaria, no
 * algorítmica: la papa se pela, el arroz no.
 *
 * Este archivo declara la expectativa CON SU RAZÓN. Lo que NO hace —ni hará—
 * es inventar el factor. Declarar "la papa necesita porción comestible" es un
 * hecho verificable; escribir "0,85" sin fuente sería un número inventado
 * viajando por toda la lista de compras. El registro señala el hueco; llenarlo
 * es una decisión de Francisco con un dato real detrás.
 */

/** Alimento cuya forma comprada incluye partes que no se comen. */
export interface ExpectativaPorcionComestible {
  ingrediente: string;
  razon: string;
}

export const REQUIEREN_PORCION_COMESTIBLE: ExpectativaPorcionComestible[] = [
  { ingrediente: "papa", razon: "se pela" },
  { ingrediente: "limon", razon: "se usa el jugo; cáscara y semillas se botan" },
  { ingrediente: "zapallo camote", razon: "se pela y se le sacan las pepas" },
  { ingrediente: "pimiento rojo", razon: "se le quitan las semillas y el tronco" },
  { ingrediente: "ajo", razon: "se pela diente por diente" },
  { ingrediente: "pollo trutro entero con piel", razon: "se compra con hueso" },
  { ingrediente: "manzana", razon: "se le saca el corazón" },
  { ingrediente: "platano", razon: "se pela" },
  { ingrediente: "palta", razon: "cuesco y cáscara" },
  { ingrediente: "cebolla", razon: "se le quitan las capas de afuera y las puntas" },
  {
    ingrediente: "pan marraqueta",
    razon:
      "su ficha está en EDIBLE_PORTION y el ShoppingEngine necesita el factor para llegar a la cantidad de compra; el pan se come entero, así que el factor real es exactamente 1. RESUELTO: declarado en dev_catalog_seed.sql; esta entrada queda como el registro de por qué hizo falta",
  },
  { ingrediente: "zanahoria", razon: "se pela o se raspa" },
  {
    ingrediente: "yema de huevo",
    razon:
      "nadie compra yemas: se compran HUEVOS. El factor tiene que convertir gramos de yema a gramos de huevo entero (un huevo de 55 g da unos 18 g de yema, o sea ~0,33), RESUELTO: el 0,33 está declarado en la ficha de la biblioteca (catalog.ts) con su aritmética escrita; esta entrada queda como el registro de por qué hizo falta",
  },
  {
    ingrediente: "clara de huevo",
    razon:
      "mismo caso por el otro lado: un huevo de 55 g da unos 33 g de clara (~0,60). RESUELTO: el 0,60 está declarado en la ficha de la biblioteca con la misma aritmética del huevo de 55 g",
  },
];

/** Alimento cuyo peso cambia de forma predecible al cocinarse. */
export interface ExpectativaRendimiento {
  ingrediente: string;
  razon: string;
}

export const REQUIEREN_RENDIMIENTO: ExpectativaRendimiento[] = [
  { ingrediente: "arroz blanco", razon: "absorbe agua: ~2,5x" },
  { ingrediente: "fideos", razon: "absorben agua: ~2,4x" },
  { ingrediente: "avena tradicional", razon: "absorbe líquido al cocerse" },
  { ingrediente: "lentejas", razon: "legumbre seca que se hidrata" },
  { ingrediente: "porotos secos", razon: "legumbre seca que se hidrata: ~2,4x" },
  { ingrediente: "garbanzos secos", razon: "legumbre seca que se hidrata: ~2,4x" },
  {
    ingrediente: "pechuga de pollo sin piel",
    razon:
      "la biblioteca la usa en base COOKED (el sandwich de ave palta parte del pollo ya cocido) y sin rendimiento el ShoppingEngine no puede llegar al crudo que hay que comprar",
  },
  {
    ingrediente: "vacuno posta negra",
    razon: "mismo caso: las recetas que parten de carne ya cocida no se pueden convertir a cantidad de compra",
  },
  {
    ingrediente: "quinoa",
    razon:
      "el pescado con costra la declara COCIDA porque así entra al plato, y sin rendimiento el motor no llega al grano seco que hay que comprar. RESUELTO: el factor (2,7x, criterio DEV_SEED igual que el arroz) vive en RENDIMIENTOS_CONFIRMADOS del catálogo y el seed lo vuelca a ingredient_yields; esta entrada queda como el registro de por qué hizo falta",
  },
];

/**
 * Capacidades de equipo que la cocina chilena usa y el schema todavía no
 * representa (registro 7). Se llena DURANTE la escritura de los lotes: cuando
 * una receta necesita un equipo que `equipment_capabilities` no tiene, se
 * anota acá en vez de mapearlo a la fuerza a un código que significa otra cosa.
 *
 * `resueltaEn` apunta a la migración que la agregó, cuando ya se resolvió.
 */
export interface CapacidadFaltante {
  codigo: string;
  nombre: string;
  porQue: string;
  recetas: string[];
  resueltaEn: string | null;
}

export const CAPACIDADES_FALTANTES: CapacidadFaltante[] = [
  {
    codigo: "PRESSURE_COOKER",
    nombre: "Olla a presión",
    porQue:
      "Diferencia entre 60 y 25 minutos en cualquier legumbre seca. Sin el código había que mentir (mapearla a POT) o esconder el paso.",
    recetas: ["Porotos con riendas", "Garbanzos guisados", "Carne mechada"],
    resueltaEn: "0032_pressure_cooker_capability.sql",
  },
];

/**
 * ¿Un 0 en un micronutriente es un HECHO o es relleno?
 *
 * Regla única de la biblioteca. Vivía duplicada en el script que carga las
 * fichas y en el guardián §30, y las dos copias discreparon a la primera tanda:
 * una rechazaba la fibra 0 de la mantequilla —que es un hecho— y la otra la
 * aceptaba. Ahora está acá y el script apunta a este archivo.
 *
 * El sesgo es deliberado: ante la duda, se RECHAZA el cero. Un nutriente
 * ausente en la base significa desconocido y el motor clínico lo trata como tal;
 * un 0 inventado le diría a alguien con restricción de potasio que un alimento
 * cumple, cuando nadie lo sabe.
 */

/** Categorías sin tejido vegetal: no tienen fibra, y eso no es una suposición. */
const SIN_FIBRA = new Set(["MEAT", "POULTRY", "FISH", "EGGS", "DAIRY", "FATS_OILS"]);

/** Grasas y minerales puros donde el 0 en sodio o grasa saturada es real. */
const PUROS = /^(aceite|azucar|sal$|manteca|polvos de hornear)/;

/**
 * Líquidos filtrados y almidones refinados: adentro no quedó tejido vegetal.
 *
 * El vino, la cerveza y los destilados salen de una fruta o de un grano, así
 * que el catálogo los guarda en FRUITS o GRAINS —correcto para saber de dónde
 * vienen— y ahí la regla general dice, con razón, que un vegetal con fibra 0 es
 * sospechoso. Pero el sólido se quedó en el orujo y en el bagazo: la fibra 0 de
 * un vino es un HECHO medido, no un hueco disimulado con un cero.
 *
 * La maicena es lo mismo del otro lado: almidón aislado del grano, y el azúcar
 * 0 es justamente lo que la distingue de una harina.
 *
 * Va por NOMBRE y no por categoría a propósito. Abrir la excepción a "todo
 * GRAINS" dejaría pasar la fibra 0 de una harina integral, que sí sería un
 * hueco tapado.
 */
const FILTRADOS_O_REFINADOS = new Set([
  "vino blanco",
  "vino tinto",
  "cerveza",
  "pisco",
  "ron",
  "cognac",
  "esencia de vainilla",
  "maicena",
]);

export function ceroEsDefendible(
  alimento: { canonicalName: string; category: string },
  ficha: { carbohydratesG?: number; basis?: string },
  nutriente: string,
): boolean {
  // Sin carbohidratos no hay fibra ni azúcares: son un subconjunto de los carbos.
  if ((nutriente === "fiberG" || nutriente === "sugarsG") && ficha.carbohydratesG === 0) return true;
  // Un alimento de origen animal o una grasa pura no aporta fibra.
  if (nutriente === "fiberG" && SIN_FIBRA.has(alimento.category)) return true;
  if (PUROS.test(alimento.canonicalName)) return true;
  // Fibra y azúcares de un líquido filtrado o de un almidón aislado: el sólido
  // se quedó afuera, y el cero es lo medido.
  if (
    (nutriente === "fiberG" || nutriente === "sugarsG") &&
    FILTRADOS_O_REFINADOS.has(alimento.canonicalName)
  ) {
    return true;
  }
  // Una fruta o verdura FRESCA no tiene sodio, y las tablas lo reportan como 0.
  // Acotado a RAW y EDIBLE_PORTION a propósito: AS_PACKAGED y DRAINED implican
  // envase o salmuera, donde el sodio 0 dejaría de ser un hecho.
  //
  // Esta excepción se agregó por la naranja, y vale la pena decir por qué no es
  // una concesión: si toda fruta declarara el sodio como desconocido, TODA
  // receta que lleve fruta quedaría con el sodio incompleto para siempre, y la
  // restricción de sodio —que es de las más comunes— dejaría de servir. Negar un
  // hecho también tiene costo clínico.
  if (
    nutriente === "sodiumMg" &&
    (alimento.category === "FRUITS" || alimento.category === "VEGETABLES") &&
    (ficha.basis === "RAW" || ficha.basis === "EDIBLE_PORTION")
  ) {
    return true;
  }
  return false;
}
