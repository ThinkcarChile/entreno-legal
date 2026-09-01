/**
 * MOTOR `intake-extent/1.0.0` — traduce "cuánto comió, dicho como lo dice una
 * persona" a los renglones que esperan `log_intake` y `correct_intake_log`
 * (migración 0038).
 *
 * POR QUÉ VIVE ACÁ Y NO EN LA BASE
 *
 * La 0038 guarda en cada renglón la columna `extent_engine_version` justamente
 * para esto: "la mitad" no va a significar lo mismo dentro de un año, y si la
 * traducción viviera en una función de Postgres, cambiarla mañana reescribiría
 * en silencio lo que alguien leyó ayer. Acá se traduce, y el número queda
 * firmado con la versión que lo produjo.
 *
 * ES PURO: sin reloj, sin red, sin base, sin IA. La misma entrada produce el
 * mismo JSON byte a byte. Lo verifica `extent.test.ts`.
 *
 * LAS TRES REGLAS QUE NO SE NEGOCIAN (0038, cabecera)
 *
 *   · UNKNOWN != ZERO — "no sé cuánto" se escribe con `quantity` en null.
 *   · NADA != CERO GRAMOS — "no comió" (NONE) TAMPOCO lleva un 0: cero es un
 *     número calculado y "nada" es una afirmación de la persona. Escribir 0
 *     ahí le daría al motor un dato duro que nadie midió.
 *   · Un número que no dijo una persona se marca como no declarado y nombra su
 *     motor. Lo asumido jamás se disfraza de declarado.
 */

/** La versión que se estampa en cada número que produce este motor. */
export const VERSION_MOTOR_EXTENT = "intake-extent/1.0.0";

/**
 * Los tres valores del enum `public.intake_source` (0038:64).
 *
 * Vive acá —y no como literal suelto en cada archivo de la pantalla— porque es
 * la distinción que sostiene el sprint entero: lo ASUMIDO no es una
 * declaración, y el motor adaptativo tiene que poder distinguirlo SIEMPRE
 * (comentario de la columna, 0038:210). Escrito a mano en cada archivo, el día
 * que aparezca un cuarto origen hay tres lugares donde olvidarlo.
 */
export const ORIGENES_DECLARACION = [
  "DECLARED_SELF",
  "DECLARED_CAREGIVER",
  "ASSUMED_FROM_PLAN",
] as const;
export type OrigenDeclaracion = (typeof ORIGENES_DECLARACION)[number];

/** ¿Esta afirmación la hizo una PERSONA, o la dimos por hecha del plan? */
export function loDijoAlguien(origen: OrigenDeclaracion): boolean {
  return origen !== "ASSUMED_FROM_PLAN";
}

/** Los siete valores del enum `public.intake_extent` (0036:94). */
export const EXTENTS = [
  "ALL",
  "MOST",
  "HALF",
  "LITTLE",
  "NONE",
  "UNKNOWN",
  "EXACT",
] as const;
export type Extent = (typeof EXTENTS)[number];

/** Unidad física del renglón servido, el mismo dominio que el lote. */
export type Unidad = "G" | "ML" | "UNIT";

export type BaseFisica = "RAW" | "COOKED" | "DRAINED" | "EDIBLE_PORTION" | "AS_PACKAGED";

/**
 * El orden en que se ofrecen los botones. `EXACT` NO está: la cantidad exacta
 * es un campo opcional que aparece aparte, no una opción más de la fila. Pedir
 * un número al mismo nivel que "casi todo" empuja a inventarlo, y un número
 * inventado contamina el motor peor que un hueco honesto (0038, `quantity`).
 */
export const EXTENTS_DE_UN_TOQUE: Extent[] = ["ALL", "MOST", "HALF", "LITTLE", "NONE", "UNKNOWN"];

export const ETIQUETAS_EXTENT: Record<Extent, string> = {
  ALL: "Todo",
  MOST: "Casi todo",
  HALF: "La mitad",
  LITTLE: "Un poco",
  NONE: "Nada",
  UNKNOWN: "No sé",
  EXACT: "Cantidad exacta",
};

/**
 * La fracción con la que este motor traduce cada extent. `null` significa "acá
 * no se produce ningún número", y son tres casos distintos que NO se colapsan:
 * EXACT lo dice la persona, UNKNOWN es un hueco declarado, y NONE es una
 * afirmación —no un cero calculado—.
 */
export const FRACCION_EXTENT: Record<Extent, number | null> = {
  ALL: 1,
  MOST: 0.75,
  HALF: 0.5,
  LITTLE: 0.25,
  NONE: null,
  UNKNOWN: null,
  EXACT: null,
};

/** Un renglón que salió a la mesa, tal como lo guardó la 0036. */
export interface RenglonServido {
  servingRecordItemId: string;
  label: string;
  ingredientId: string | null;
  productId: string | null;
  /** Lo que el plan mandó al plato. */
  servido: number;
  /** Lo que la despensa entregó de verdad: si hubo faltante, es menos. */
  entregado: number;
  /** Lo que se declaró basura: esos gramos ya no se los comió nadie. */
  botado: number;
  unidad: Unidad;
  baseFisica: BaseFisica;
  sortOrder: number;
}

/** Renglón listo para el jsonb de `log_intake`. Las claves son las de la 0038. */
export interface ItemDeclarado {
  serving_record_item_id?: string;
  label: string;
  ingredient_id?: string;
  product_id?: string;
  extent: Extent;
  quantity?: number;
  unit?: Unidad;
  weight_basis?: BaseFisica;
  quantity_is_declared?: boolean;
  extent_engine_version?: string;
  sort_order: number;
}

export type Resultado =
  | { ok: true; items: ItemDeclarado[] }
  | { ok: false; problemas: string[] };

/** Lo que la persona marcó para un renglón servido. */
export interface EntradaServida {
  servido: RenglonServido;
  extent: Extent;
  /** Solo se mira con EXACT. `null` = no escribió ningún número. */
  cantidadExacta: number | null;
}

/** Lo que la persona escribió de una comida que no salió de esta despensa. */
export interface EntradaLibre {
  label: string;
  extent: Extent;
}

function redondear3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/**
 * CUÁNTO SE PUDO COMER DE ESE RENGLÓN, COMO MÁXIMO.
 *
 * Dos topes distintos y hay que respetar los dos:
 *   · lo ENTREGADO — si la despensa no tenía todo, esos gramos nunca llegaron
 *     al plato y suponer que se comieron sería inventar comida (mismo criterio
 *     que `assume_intake_from_plan`, que asume sobre `deducted_quantity`);
 *   · lo servido MENOS lo botado — es el techo que impone el trigger
 *     `app.intake_item_guard` (0038). Un número derivado que lo pase sería
 *     culpa de este motor y la persona vería un error que no provocó.
 */
export function topeComible(r: RenglonServido): number {
  const tope = Math.min(r.entregado, r.servido - r.botado);
  return tope > 0 ? tope : 0;
}

/**
 * EL MISMO UMBRAL DE MERMA QUE USA EL SERVIDOR.
 *
 * `assume_intake_from_plan` se niega a asumir cuando algún renglón tiene
 * `discarded_quantity > 0.001` (0038:1005). La pantalla escondía el botón con
 * `botado > 0`, que es OTRO umbral: con una merma de exactamente 0,001 —el
 * mínimo representable en `numeric(12,3)`— la interfaz escondía un botón que el
 * servidor sí habría aceptado. Dos dueños del mismo límite es cómo nace una
 * pantalla que le miente a la persona sobre lo que el sistema puede hacer.
 */
export const MERMA_QUE_IMPIDE_ASUMIR = 0.001;

export type MotivoNoAsumible = "MERMA_DECLARADA" | "DESPENSA_NO_ENTREGO" | "SIN_RENGLONES";

/**
 * Respuesta a "¿se puede dar por comida esta porción entera, sin que nadie mire
 * plato por plato?".
 */
export type Asumible =
  | { puede: true }
  | { puede: false; motivo: MotivoNoAsumible; renglones: string[]; texto: string };

/**
 * ¿SE PUEDE DAR POR COMIDA ESTA PORCIÓN?
 *
 * Un solo dueño de la pregunta, porque la pantalla tiene DOS caminos que la
 * contestan y hasta hoy contestaban distinto:
 *
 *   · el camino manual pasa por `renglonDesdeServido`, que con `tope <= 0`
 *     deja la cantidad en NULL — "no hay número que dar", porque un 0 es la
 *     afirmación "midieron y dio cero";
 *   · el camino de un toque llama a `assume_intake_from_plan`, que escribe
 *     `quantity = deducted_quantity` sin mirar el faltante (0038:1036). Con la
 *     despensa sin entregar nada eso es un CERO DURO en `intake_log_items`
 *     para el mismo renglón que el otro camino se niega a numerar.
 *
 * `deducted + shortfall = served` (invariante 0036), así que `deducted = 0` con
 * `served > 0` se alcanza con solo tener el ingrediente sin lote en la despensa:
 * no es un caso de laboratorio. Acá se corta antes: si de algún renglón no hay
 * nada que asumir, el botón no se ofrece y la persona va por el camino que sí
 * sabe decir "no sé".
 *
 * ES PURA: la misma porción da siempre la misma respuesta.
 */
export function puedeDarsePorComida(renglones: readonly RenglonServido[]): Asumible {
  if (renglones.length === 0) {
    return {
      puede: false,
      motivo: "SIN_RENGLONES",
      renglones: [],
      texto:
        "Esta porción no tiene renglones anotados, así que no hay nada que dar por comido: " +
        "dinos qué comió.",
    };
  }

  const conMerma = renglones.filter((r) => r.botado > MERMA_QUE_IMPIDE_ASUMIR);
  if (conMerma.length > 0) {
    return {
      puede: false,
      motivo: "MERMA_DECLARADA",
      renglones: conMerma.map((r) => r.label),
      texto:
        `De esta porción se botó comida (${conMerma.map((r) => r.label).join(", ")}), ` +
        "así que no se puede dar por comida entera: dinos cuánto comió.",
    };
  }

  const sinEntregar = renglones.filter((r) => topeComible(r) <= 0);
  if (sinEntregar.length > 0) {
    return {
      puede: false,
      motivo: "DESPENSA_NO_ENTREGO",
      renglones: sinEntregar.map((r) => r.label),
      texto:
        `De esta porción no salió nada de ${sinEntregar.map((r) => r.label).join(", ")}: ` +
        "la despensa no lo entregó. Darlo por comido anotaría un cero que nadie midió, " +
        "así que dinos cuánto comió.",
    };
  }

  return { puede: true };
}

/**
 * Traduce un renglón servido + lo que marcó la persona a un renglón declarado.
 *
 * El caso `tope <= 0` es el fino: la despensa no entregó nada, o todo lo que
 * salió se botó. Marcar "se lo comió todo" ahí NO puede producir un 0 —un 0 es
 * la afirmación "midieron y dio cero"—. Se conserva el extent, que es lo que
 * la persona efectivamente dijo, y el número queda en null: desconocido.
 */
function renglonDesdeServido(entrada: EntradaServida, orden: number): ItemDeclarado {
  const { servido: r, extent } = entrada;
  const base: ItemDeclarado = {
    serving_record_item_id: r.servingRecordItemId,
    label: r.label,
    ingredient_id: r.ingredientId ?? undefined,
    product_id: r.productId ?? undefined,
    extent,
    sort_order: orden,
  };

  // El número lo dijo una persona: se guarda tal cual, sin motor detrás
  // (`intake_item_declared_has_no_engine`). Que quepa en la porción lo decide
  // el servidor: el tope es suyo y su mensaje explica qué hacer si repitió.
  // Duplicar la regla acá sería tener dos dueños del mismo límite.
  const exacta = extent === "EXACT" ? entrada.cantidadExacta : null;
  if (exacta !== null) {
    return {
      ...base,
      quantity: redondear3(exacta),
      unit: r.unidad,
      weight_basis: r.baseFisica,
      quantity_is_declared: true,
    };
  }

  const fraccion = FRACCION_EXTENT[extent];
  const tope = topeComible(r);
  if (fraccion === null || tope <= 0) return base;

  return {
    ...base,
    quantity: redondear3(fraccion * tope),
    unit: r.unidad,
    weight_basis: r.baseFisica,
    quantity_is_declared: false,
    extent_engine_version: VERSION_MOTOR_EXTENT,
  };
}

/**
 * Arma la declaración de una porción que SÍ salió de esta despensa.
 *
 * Devuelve problemas en vez de arreglarlos solo: un renglón marcado "cantidad
 * exacta" sin número no se degrada en silencio a UNKNOWN, porque degradar en
 * silencio es exactamente cómo un dato que alguien creyó haber dado termina
 * siendo un hueco que nadie ve.
 */
export function construirDeclaracionServida(entradas: EntradaServida[]): Resultado {
  const problemas: string[] = [];
  if (entradas.length === 0) {
    problemas.push("Esta porción no tiene renglones que declarar.");
    return { ok: false, problemas };
  }

  for (const e of entradas) {
    if (e.extent !== "EXACT") continue;
    const n = e.cantidadExacta;
    if (n === null) {
      problemas.push(
        `Marcaste cantidad exacta en «${e.servido.label}» pero no escribiste el número. ` +
          "Si no lo sabes, dilo con «casi todo», «la mitad» o «no sé».",
      );
      continue;
    }
    if (!Number.isFinite(n) || n < 0) {
      problemas.push(`La cantidad de «${e.servido.label}» no es un número válido.`);
    }
  }
  if (problemas.length > 0) return { ok: false, problemas };

  const items = entradas
    .slice()
    .sort((a, b) => a.servido.sortOrder - b.servido.sortOrder)
    .map((e, i) => renglonDesdeServido(e, i + 1));
  return { ok: true, items };
}

/**
 * Arma la declaración de algo que NO salió de esta despensa: la torta del
 * cumpleaños, lo que trajo la vecina, el almuerzo del trabajo.
 *
 * Acá NO se aceptan gramos, y es a propósito. Un número necesita unidad y base
 * física para significar algo —si no, son "200 de algo" (0038)— y en una
 * comida de afuera nadie sabe si eran 200 crudos, cocidos o escurridos.
 * Pedirlos sería pedir que se inventen.
 */
export function construirDeclaracionLibre(entradas: EntradaLibre[]): Resultado {
  const problemas: string[] = [];
  const limpias = entradas.map((e) => ({ ...e, label: e.label.trim() }));
  const conNombre = limpias.filter((e) => e.label.length > 0);

  if (conNombre.length === 0) {
    problemas.push("Dinos qué comió: escribe al menos una cosa.");
  }
  for (const e of conNombre) {
    if (e.extent === "EXACT") {
      problemas.push(
        `De «${e.label}» no se pueden anotar gramos: no salió de la despensa y ` +
          "no hay cómo saber en qué unidad medirlo. Dilo con «todo», «la mitad» o «no sé».",
      );
    }
    if (e.label.length > 200) {
      problemas.push(`El nombre de «${e.label.slice(0, 40)}…» es demasiado largo.`);
    }
  }
  if (problemas.length > 0) return { ok: false, problemas };

  return {
    ok: true,
    items: conNombre.map((e, i) => ({ label: e.label, extent: e.extent, sort_order: i + 1 })),
  };
}

const UNIDADES: Record<Unidad, string> = { G: "g", ML: "ml", UNIT: "u" };

/**
 * Cómo se lee un renglón ya declarado. La procedencia del número va SIEMPRE
 * pegada al número: un gramaje estimado por el motor y uno que dijo una
 * persona no pueden verse igual en pantalla.
 */
export function textoCantidad(item: {
  extent: Extent;
  quantity: number | null;
  unit: Unidad | null;
  quantityIsDeclared: boolean;
}): string {
  if (item.quantity === null || item.unit === null) {
    if (item.extent === "NONE") return "no comió";
    // "Sin número" jamás se abrevia a un cero: el hueco se dice con todas sus
    // letras para que nadie lo lea como una medición.
    return "sin número anotado";
  }
  const cifra = `${redondear3(item.quantity)} ${UNIDADES[item.unit]}`;
  return item.quantityIsDeclared ? `${cifra} (lo dijo una persona)` : `${cifra} (estimado)`;
}

/** De dónde viene la afirmación (`public.intake_source`). */
export const ETIQUETAS_ORIGEN: Record<OrigenDeclaracion, string> = {
  DECLARED_SELF: "Lo dijo la persona",
  DECLARED_CAREGIVER: "Lo anotó quien la cuida",
  ASSUMED_FROM_PLAN: "Supuesto del plan",
};

/** Qué clase de comida fue (`consumption_logs.kind`). */
export const ETIQUETAS_CLASE: Record<string, string> = {
  PLANNED: "Del plan",
  OFF_PLAN: "Fuera del plan",
  AWAY: "Fuera de casa",
};
