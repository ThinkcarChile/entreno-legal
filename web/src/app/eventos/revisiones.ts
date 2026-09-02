import type {
  BbqMenuItemInput,
  BbqParticipantInput,
  BbqRecordedBlocks,
} from "@/domain/events/bbq/types";
import type { EntradaEstimacion } from "./contrato-estimacion";
import type { ItemMenu, Participante } from "./queries";

/**
 * LAS REVISIONES CONGELADAS del plan del evento (§93-§95).
 *
 * Una revisión es un hecho: "con estos participantes, este menú, esta política
 * y estos rendimientos, el motor dijo esto". No se edita nunca. Cambiar la
 * política mañana no reescribe el asado del sábado pasado — igual que
 * `member_serving_projections.event_effect` congela `frozenEffectConfig` y que
 * `adaptive_nutrition_reviews.params` congela los parámetros del Sprint 12.
 *
 * LA FIRMA NO SE CALCULA ACÁ. La emite el motor (`salida.inputSignature`), que
 * es el único que ve TODOS sus insumos —participantes, menú, política,
 * rendimientos, inventario, equipos—. Una segunda firma escrita de este lado
 * cubriría menos cosas y terminaría diciendo "no cambió nada" cuando lo que
 * cambió fue un factor de rendimiento. Lo que sí es responsabilidad de acá es
 * que la entrada llegue ORDENADA: la firma del motor es sensible al orden y
 * PostgREST no promete ninguno.
 */

/**
 * La entrada, ordenada.
 *
 * Sin esto la firma dependería del orden en que PostgREST devolvió las filas, y
 * dos consultas idénticas producirían dos revisiones. Es exactamente lo que
 * hace `buildProfile` antes de firmar el perfil: ordenar primero, firmar
 * después.
 */
export function normalizarEntrada(entrada: EntradaEstimacion): EntradaEstimacion {
  return {
    ...entrada,
    participants: [...entrada.participants].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    menu: [...entrada.menu].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/**
 * El snapshot de participantes que se CONGELA en la revisión.
 *
 * Deja fuera nombre, sexo, peso, estatura y la nota de alergia a propósito.
 *
 * El invitado es un tercero que no consintió que sus datos queden guardados
 * para siempre: si mañana se borra su ficha, una revisión que hubiera copiado
 * su nombre lo conservaría igual, fosilizado, en cada asado en que estuvo. Y el
 * cálculo no los necesita — el motor estima con edad, apetito, asistencia y
 * banderas culinarias; el botón "¿por qué esta cantidad?" muestra CONTEOS, no
 * nombres.
 *
 * `dietaryFlags` viaja tal cual, incluido el `null`: perder la diferencia entre
 * "no sabemos" y "dijo que no tiene restricciones" acá dejaría al motor sin
 * manera de bajarle la confianza a la estimación.
 *
 * `recordedBlocks` es lo que la casa ya sabe (ver `cargarBloqueosDelMenu`), y
 * viaja SIN el motivo: ids de items del menú y una marca de alergia. Se congela
 * junto al resto porque el motor lo usó para repartir —una revisión que no lo
 * guardara no se podría explicar después—, y sigue sin ser mostrable: son ids
 * de plato, no diagnósticos, y ninguna pantalla los dibuja.
 *
 * Para un INVITADO es `null`: no tiene ficha en la casa, y lo único que se sabe
 * de él son sus banderas culinarias.
 */
const SIN_BLOQUEOS: BbqRecordedBlocks = { blockedItemIds: [], allergyItemIds: [] };

export function congelarParticipantes(
  participantes: Participante[],
  bloqueos: Map<string, BbqRecordedBlocks>,
): BbqParticipantInput[] {
  return participantes.map((p) => {
    if (p.asistencia === null) {
      // La base trae una marca de asistencia que esta versión no sabe leer.
      // Convertirla en INVITED o en CONFIRMED sumaría (o restaría) una persona
      // a la mesa por una decisión que nadie tomó, y quedaría fosilizada en la
      // revisión. Mejor no calcular y decir qué pasó.
      throw new AsistenciaDesconocida(p.asistenciaCruda);
    }
    // La ficha del hogar se consultó para TODOS los integrantes (la consulta
    // reventó si falló), así que "no aparece en el mapa" significa "se miró y
    // no hay nada bloqueado" — que no es lo mismo que el `null` del invitado,
    // de quien nadie tiene ficha.
    const registrado = bloqueos.get(p.id);
    return {
      id: p.id,
      kind: p.tipo,
      ageGroup: p.grupoEdad,
      appetite: p.apetitoEfectivo,
      attendance: p.asistencia,
      dietaryFlags: p.banderasDietarias,
      recordedBlocks:
        p.tipo === "HOUSEHOLD_MEMBER"
          ? registrado === undefined
            ? SIN_BLOQUEOS
            : registrado
          : null,
      // Esta superficie no lee peso ni estatura de nadie (§16/§78): la cantidad
      // de carne no se calcula con antropometría.
      approxWeightKg: null,
    };
  });
}

/** Una marca de asistencia que la app no conoce: no se adivina, se declara. */
export class AsistenciaDesconocida extends Error {
  constructor(readonly valorCrudo: string) {
    super(
      `Uno de los participantes tiene la asistencia en "${valorCrudo}", que esta versión de la ` +
        "aplicación no sabe leer. Actualiza la aplicación antes de calcular.",
    );
    this.name = "AsistenciaDesconocida";
  }
}

/**
 * El menú congelado. Mismo criterio: lo que el motor usa, nada más.
 *
 * `cutRef` es la llave con la que el motor busca el rendimiento del corte. Sale
 * del ingrediente o del producto del catálogo; si el item se escribió a mano y
 * no está enganchado a ninguno de los dos, queda `null` — y entonces el motor
 * no tiene con qué convertir crudo en servible y lo dice, en vez de suponer.
 */
export function congelarMenu(items: ItemMenu[]): BbqMenuItemInput[] {
  return items.map((i) => {
    if (i.tipo === null) {
      // Igual que con la asistencia: una clase de item que la app no conoce no
      // se convierte en "acompañamiento". Si fuera una carne, tratarla como
      // acompañamiento la sacaría del reparto y de la compra.
      throw new ClaseDeItemDesconocida(i.nombre, i.tipoCrudo);
    }
    return {
      id: i.id,
      kind: i.tipo,
    category: i.categoria,
      cutRef: i.ingredientId ?? i.productId,
      displayName: i.nombre,
      distributionPct: i.porcentaje,
      // Todavía no se preguntan en el armador: sin método de cocción declarado
      // el motor usa el factor genérico del corte, y sin equipo declarado las
      // tandas salen como desconocidas. Las dos cosas se DICEN en la pantalla.
      cookingMethod: null,
      equipmentId: null,
    };
  });
}

/** Una clase de item de menú que la app no conoce: no se adivina, se declara. */
export class ClaseDeItemDesconocida extends Error {
  constructor(
    readonly nombre: string,
    readonly valorCrudo: string,
  ) {
    super(
      `"${nombre}" está guardado como "${valorCrudo}", una clase de item que esta versión de la ` +
        "aplicación no sabe leer. Actualiza la aplicación antes de calcular.",
    );
    this.name = "ClaseDeItemDesconocida";
  }
}

/**
 * Los campos que JAMÁS pueden aparecer dentro de una revisión congelada.
 *
 * La lista existe para que un test la haga cumplir: agregar un campo al
 * snapshot es una línea de código, y darse cuenta seis meses después de que el
 * nombre de la tía María quedó guardado en catorce revisiones no se arregla con
 * un `git revert`.
 */
export const CAMPOS_PROHIBIDOS_EN_REVISION = [
  "name",
  "nombre",
  "sex",
  "sexo",
  "approx_weight_kg",
  "approx_height_cm",
  "pesoAproxKg",
  "estaturaAproxCm",
  "allergy_note",
  "notaAlergia",
  "notes",
  "notas",
] as const;

/** Busca recursivamente una clave prohibida. Devuelve la ruta donde apareció. */
export function buscarCampoProhibido(valor: unknown, ruta = ""): string | null {
  if (valor === null || typeof valor !== "object") return null;
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const hallazgo = buscarCampoProhibido(valor[i], `${ruta}[${i}]`);
      if (hallazgo) return hallazgo;
    }
    return null;
  }
  for (const [clave, contenido] of Object.entries(valor as Record<string, unknown>)) {
    if ((CAMPOS_PROHIBIDOS_EN_REVISION as readonly string[]).includes(clave)) {
      return ruta ? `${ruta}.${clave}` : clave;
    }
    const hallazgo = buscarCampoProhibido(contenido, ruta ? `${ruta}.${clave}` : clave);
    if (hallazgo) return hallazgo;
  }
  return null;
}
