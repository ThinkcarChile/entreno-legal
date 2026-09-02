import type { GrupoEdad } from "./vocabulario";

/**
 * De fecha de nacimiento a GRUPO DE EDAD.
 *
 * Es un mapeo demográfico, no una política de porciones: acá se decide que
 * alguien de siete años es CHILD; cuántos gramos come un CHILD lo decide el
 * motor con su política versionada (§76), y este archivo no lo sabe ni tiene
 * que saberlo. Se separan porque son dos cosas que cambian por motivos
 * distintos.
 *
 * `birth_date` es NULLABLE en `household_members` desde el Sprint 1. Un
 * integrante sin fecha NO hereda "adulto" en silencio: sale UNKNOWN, la
 * pantalla lo muestra como "Sin información" y el motor le baja la confianza
 * con su propia razón. Heredar adulto sería exactamente el error de contar a un
 * niño como un adulto sin que nadie lo haya dicho.
 */

/** Los cortes, en años cumplidos. Escritos acá y en ningún otro lugar. */
export const CORTES_DE_EDAD = {
  /** Menos de 5 → niño chico. */
  ninoChico: 5,
  /** Menos de 13 → niño. */
  nino: 13,
  /** Menos de 18 → adolescente. */
  adolescente: 18,
  /** 65 o más → adulto mayor. */
  adultoMayor: 65,
} as const;

/**
 * Años cumplidos entre dos fechas civiles `YYYY-MM-DD`.
 *
 * Se calcula con los COMPONENTES de la fecha, sin construir un `Date`: un
 * `new Date("2020-03-15")` se interpreta en UTC y en Chile eso corre el día,
 * que es como una persona que cumple años el sábado del asado queda con la edad
 * de la semana pasada. La fecha de hoy entra por parámetro porque acá no hay
 * reloj: el día civil del hogar lo pregunta quien llama.
 */
export function anosCumplidos(nacimiento: string, hoy: string): number | null {
  const n = descomponer(nacimiento);
  const h = descomponer(hoy);
  if (!n || !h) return null;
  let anos = h.ano - n.ano;
  if (h.mes < n.mes || (h.mes === n.mes && h.dia < n.dia)) anos -= 1;
  return anos;
}

function descomponer(fecha: string): { ano: number; mes: number; dia: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) return null;
  return { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) };
}

/**
 * El grupo de edad de un integrante del hogar en la fecha del evento.
 *
 * La fecha que se pasa es la DEL EVENTO, no la de hoy: si el asado es el sábado
 * y alguien cumple quince el viernes, en el asado ya tiene quince.
 */
export function grupoEdadDeMiembro(
  birthDate: string | null,
  fechaDelEvento: string,
): GrupoEdad {
  if (birthDate === null) return "UNKNOWN";
  const anos = anosCumplidos(birthDate, fechaDelEvento);
  if (anos === null || anos < 0) return "UNKNOWN";
  if (anos < CORTES_DE_EDAD.ninoChico) return "CHILD_SMALL";
  if (anos < CORTES_DE_EDAD.nino) return "CHILD";
  if (anos < CORTES_DE_EDAD.adolescente) return "TEEN";
  if (anos >= CORTES_DE_EDAD.adultoMayor) return "OLDER_ADULT";
  return "ADULT";
}
