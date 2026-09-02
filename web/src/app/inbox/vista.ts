import type { Actor } from "@/lib/auth/actor";
import type { BadgeInbox } from "@/domain/assistant/presentacion";
import type { Unknown } from "@/domain/assistant/tool";

/**
 * EL CENTRO DE ACCIONES, EN REGLAS.
 *
 * El chat es efímero; esta bandeja no. Y hay dos cosas que se deciden acá y no
 * en el componente, porque son las que se pueden equivocar en silencio:
 *
 *  1. EL ORDEN. Severidad, después ventana real, después recencia. Nunca
 *     recencia sola: la sugerencia de receta de hace cinco minutos jamás sube
 *     sobre el aviso de seguridad de ayer.
 *
 *  2. LA DIFERENCIA ENTRE "no hay nada", "no hay nada PARA TI" y "no pude
 *     leer". Son tres pantallas distintas. La bandeja filtra por capacidad en
 *     la RLS, así que un cocinero sin permiso clínico ve una lista vacía que en
 *     realidad no lo está: decirle "no hay nada pendiente" es mentirle a quien
 *     va a cocinar en dos horas.
 */

export const INBOX_KINDS = [
  "SEGURIDAD_ALIMENTARIA",
  "CLINICO_BLOQUEANTE",
  "FALTANTE_CONFIRMADO",
  "VENCE_HOY",
  "ACCION_PENDIENTE",
  "PROPUESTA_VENCIDA",
  "REPOSICION",
  "DATO_FALTANTE",
  "SUGERENCIA",
] as const;

export type InboxKind = (typeof INBOX_KINDS)[number];

/** Congelada, igual que en `app.inbox_severidad` (0056). Un solo dueño, dos copias que no se pueden desincronizar sin que un test lo grite. */
export const SEVERIDAD: Readonly<Record<InboxKind, number>> = {
  SEGURIDAD_ALIMENTARIA: 1,
  CLINICO_BLOQUEANTE: 2,
  FALTANTE_CONFIRMADO: 3,
  VENCE_HOY: 4,
  ACCION_PENDIENTE: 5,
  PROPUESTA_VENCIDA: 6,
  REPOSICION: 7,
  DATO_FALTANTE: 8,
  SUGERENCIA: 9,
};

/** Lo que exige a una persona. El badge cuenta solo esto: un número que incluye sugerencias es un número que se aprende a ignorar. */
export const SEVERIDAD_QUE_EXIGE = 5;

export interface ItemInbox {
  readonly id: string;
  readonly kind: InboxKind;
  readonly severidad: number;
  /** Ya saneado al leer: el título lo compuso un motor con nombres de la casa. */
  readonly titulo: string;
  /** Frases compuestas acá desde `{code, params}`, nunca el texto guardado. */
  readonly detalle: readonly string[];
  readonly unknowns: readonly Unknown[];
  readonly procedencia: readonly string[];
  /** Hasta cuándo el aviso es accionable. `null` = no caduca por tiempo. */
  readonly ventana: string | null;
  readonly proposalId: string | null;
  readonly ref: { readonly tabla: string; readonly id: string } | null;
  readonly createdAt: string;
}

/**
 * Orden real de la bandeja. Está acá además de en el índice de la 0056 porque
 * la lista se arma también con items que llegan de otras fuentes (una propuesta
 * recién creada en el turno) y ordenar dos veces distinto es peor que no
 * ordenar.
 */
export function ordenarItems(items: readonly ItemInbox[]): ItemInbox[] {
  return [...items].sort((a, b) => {
    if (a.severidad !== b.severidad) return a.severidad - b.severidad;
    // Ventana nula al final: "sin fecha" no puede colarse antes que "vence hoy".
    if (a.ventana !== b.ventana) {
      if (a.ventana === null) return 1;
      if (b.ventana === null) return -1;
      return a.ventana < b.ventana ? -1 : 1;
    }
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Qué se muestra cuando la lista viene vacía
// ---------------------------------------------------------------------------

/**
 * Si el lector alcanza a ver TODAS las audiencias que la bandeja puede tener.
 *
 * `PARCIAL` es lo normal y no es un defecto: significa que hay avisos que este
 * actor no puede ver por diseño. Lo que cambia es la frase — "no hay nada
 * pendiente" frente a "no hay nada pendiente PARA TI" — y esa diferencia es la
 * que impide que el filtro de audiencia se lea como calma.
 */
export type Cobertura = "TOTAL" | "PARCIAL";

export function coberturaDelLector(
  actor: Actor,
  integrantesDelHogar: readonly string[],
): Cobertura {
  const rolesCompletos =
    actor.isAdmin && actor.canEditPlan && actor.canManageShopping && actor.canCook;
  if (!rolesCompletos) return "PARCIAL";
  for (const id of integrantesDelHogar) {
    const acceso = actor.medical[id];
    // Ausencia no es permiso: si no se consultó, la cobertura es parcial.
    if (acceso === undefined) return "PARCIAL";
    if (!acceso.readLabs || !acceso.restrictions) return "PARCIAL";
  }
  return "TOTAL";
}

/** Por qué no se pudo leer la bandeja. Nunca se convierte en una lista vacía. */
export type FalloBandeja = "LECTURA_FALLIDA" | "FORMA_INVALIDA";

export type LecturaBandeja =
  | { ok: true; items: readonly ItemInbox[] }
  | { ok: false; fallo: FalloBandeja };

export type EstadoBandeja =
  | { k: "ERROR"; fallo: FalloBandeja }
  | { k: "SIN_NADA" }
  | { k: "SIN_NADA_PARA_TI" }
  | { k: "CON_ITEMS"; items: readonly ItemInbox[] };

export function estadoDeBandeja(
  lectura: LecturaBandeja,
  cobertura: Cobertura,
): EstadoBandeja {
  if (!lectura.ok) return { k: "ERROR", fallo: lectura.fallo };
  if (lectura.items.length === 0) {
    return cobertura === "TOTAL" ? { k: "SIN_NADA" } : { k: "SIN_NADA_PARA_TI" };
  }
  return { k: "CON_ITEMS", items: ordenarItems(lectura.items) };
}

/**
 * El badge de la campanita a partir de la MISMA lectura que pinta la pantalla.
 *
 * Si se contara aparte, el badge y el cuerpo podrían discrepar; y si se contara
 * con un `?? 0`, un fallo de lectura se vería exactamente igual que "todo en
 * orden". Por eso el fallo tiene su propio valor y no un cero.
 */
export function badgeDeBandeja(lectura: LecturaBandeja): BadgeInbox {
  if (!lectura.ok) return { kind: "DESCONOCIDO" };
  const n = lectura.items.filter((i) => i.severidad <= SEVERIDAD_QUE_EXIGE).length;
  return { kind: "CONTEO", n };
}

/**
 * El enlace de "Pregúntale al asistente".
 *
 * Lleva SOLO la referencia del item: ni el título, ni el detalle, ni una sola
 * palabra del aviso. El texto del aviso lo compuso un motor con nombres que
 * escribió alguien de la casa —puede ser un adolescente con permiso de cocina—
 * y el que abre la bandeja puede ser el admin con acceso a los exámenes. Si el
 * texto viajara al turno, ese nombre entraría al prompt del admin: inyección
 * almacenada, con la RLS intacta y nadie escribiendo donde no debía.
 *
 * Con la referencia sola, el asistente vuelve a cargar el dato con las
 * capacidades DEL LECTOR.
 */
export function enlaceDePregunta(item: ItemInbox): string {
  const params = new URLSearchParams({ desde: "inbox", item: item.id });
  if (item.ref !== null) {
    params.set("tabla", item.ref.tabla);
    params.set("fila", item.ref.id);
  }
  return `/asistente?${params.toString()}`;
}
