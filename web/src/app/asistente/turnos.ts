import type { Unknown } from "@/domain/assistant/tool";

/**
 * QUÉ PASA CUANDO EL ASISTENTE NO PUEDE.
 *
 * El proveedor apagado es el modo de caída fácil. Los que duelen son los otros
 * cuatro, porque no fallan: empeoran. El que responde lento hasta el plazo, el
 * que devuelve algo que no valida, la cuota agotada a mitad de semana y el
 * consentimiento que nadie activó terminan todos en la misma pantalla vacía si
 * nadie los nombra.
 *
 * Regla de este archivo: cada caída tiene NOMBRE, frase propia y un atajo a la
 * pantalla que sí sirve. Nunca "algo salió mal". Y ninguna de estas frases
 * afirma nada sobre la casa: "no pude leer tu despensa" jamás se transforma en
 * "no tienes nada".
 */

/** Lo que se sabe ANTES de escribir. Decide si el composer sirve o no. */
export type EstadoAsistente =
  | { k: "LISTO" }
  | { k: "SIN_CONFIGURAR" }
  | { k: "SIN_CONSENTIMIENTO" }
  | { k: "CUOTA_AGOTADA" };

/** Lo que puede salir mal DESPUÉS de mandar el turno. */
export type CausaDeCaida =
  | "SIN_CONFIGURAR"
  | "SIN_CONSENTIMIENTO"
  | "CUOTA_AGOTADA"
  | "PROVEEDOR_CAIDO"
  | "TIEMPO_AGOTADO"
  | "RESPUESTA_INVALIDA";

export interface Degradacion {
  readonly titulo: string;
  readonly detalle: string;
  readonly atajo: { readonly href: string; readonly texto: string };
}

/**
 * El atajo importa tanto como la frase: quien preguntó "¿qué cocino hoy?"
 * necesita la respuesta, no una disculpa. Todas las pantallas que se ofrecen
 * acá funcionan sin proveedor.
 */
const DEGRADACIONES: Readonly<Record<CausaDeCaida, Degradacion>> = {
  SIN_CONFIGURAR: {
    titulo: "El asistente no está configurado en esta instalación.",
    detalle:
      "No es que no te entienda: no hay proveedor de IA conectado. Todo lo demás de la app funciona igual.",
    atajo: { href: "/inbox", texto: "Ver los pendientes" },
  },
  SIN_CONSENTIMIENTO: {
    titulo: "Falta activar el consentimiento para usar IA.",
    detalle:
      "Sin ese permiso no mando nada de la casa a un proveedor externo, y prefiero no responder antes que hacerlo a medias.",
    atajo: { href: "/health", texto: "Revisar los permisos" },
  },
  CUOTA_AGOTADA: {
    titulo: "Se acabó la cuota de IA de la casa por hoy.",
    detalle:
      "Vuelve mañana o pregúntale a las pantallas, que responden lo mismo sin gastar cuota.",
    atajo: { href: "/inbox", texto: "Ver los pendientes" },
  },
  PROVEEDOR_CAIDO: {
    titulo: "El proveedor de IA no respondió.",
    detalle:
      "No pude armar la respuesta. Eso no dice nada sobre tu despensa ni sobre tu plan: solo que no pude preguntar.",
    atajo: { href: "/inbox", texto: "Ver los pendientes" },
  },
  TIEMPO_AGOTADO: {
    titulo: "Me quedé sin tiempo antes de terminar.",
    detalle:
      "Corté a propósito en vez de dejarte esperando. Lo que alcancé a leer NO alcanza para responderte, así que no te respondo a medias.",
    atajo: { href: "/inbox", texto: "Ver los pendientes" },
  },
  RESPUESTA_INVALIDA: {
    titulo: "La respuesta del proveedor no vino con la forma que exijo.",
    detalle:
      "La descarté entera. Prefiero no decirte nada antes que pasarte algo que no pude verificar.",
    atajo: { href: "/inbox", texto: "Ver los pendientes" },
  },
};

export function degradacion(causa: CausaDeCaida): Degradacion {
  return DEGRADACIONES[causa];
}

/** La causa que corresponde a un estado que ya venía mal desde antes. */
export function causaDelEstado(estado: EstadoAsistente): CausaDeCaida | null {
  return estado.k === "LISTO" ? null : estado.k;
}

// ---------------------------------------------------------------------------
// Los turnos
// ---------------------------------------------------------------------------

export type Turno =
  | { readonly k: "PERSONA"; readonly id: string; readonly texto: string }
  | {
      readonly k: "ASISTENTE";
      readonly id: string;
      readonly texto: string;
      /**
       * Se pintan SIEMPRE, en bloque propio y compuestos por el dominio. No son
       * insumo del modelo para que los parafrasee: un motor que dice UNRESOLVED
       * y una respuesta que redacta alrededor es peor que no tener asistente.
       */
      readonly unknowns: readonly Unknown[];
      readonly procedencia: readonly string[];
      /** La tarjeta se muestra aparte; el turno solo la referencia. */
      readonly proposalId: string | null;
    }
  | { readonly k: "NO_PUDE"; readonly id: string; readonly causa: CausaDeCaida };

export type RespuestaTurno =
  | {
      ok: true;
      texto: string;
      unknowns: readonly Unknown[];
      procedencia: readonly string[];
      proposalId: string | null;
    }
  | { ok: false; causa: CausaDeCaida };
