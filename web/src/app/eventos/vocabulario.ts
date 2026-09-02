/**
 * El vocabulario de la superficie de eventos: los valores que viajan a la base
 * y el texto con que se muestran.
 *
 * Vive en un archivo aparte —y no dentro de cada pantalla— porque el mismo
 * estado se nombra en la lista, en el detalle y en el modo del día del evento,
 * y cuando el texto está copiado tres veces se corrige en una sola. Es el mismo
 * motivo por el que `EVENT_LABELS` existe en el tablero de la semana; acá se
 * amplía sin tocar ese archivo, que es de otra pieza.
 *
 * REGLA QUE ATRAVIESA TODO ESTE ARCHIVO: UNKNOWN no es NORMAL y no es CERO.
 * Cada enum que tiene un valor UNKNOWN lo muestra con su propia palabra —"Sin
 * información"— y jamás con la palabra del valor neutro. Un invitado sin perfil
 * clínico se ve DESCONOCIDO, nunca "sin restricciones": lo segundo es una
 * afirmación que nadie hizo.
 */

export const ESTADOS_EVENTO = [
  "DRAFT",
  "PLANNED",
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export type EstadoEvento = (typeof ESTADOS_EVENTO)[number];

export const ETIQUETA_ESTADO: Record<EstadoEvento, string> = {
  DRAFT: "Borrador",
  PLANNED: "Planificado",
  CONFIRMED: "Confirmado",
  IN_PROGRESS: "En curso",
  COMPLETED: "Terminado",
  CANCELLED: "Cancelado",
};

/**
 * Los tipos de evento. `BARBECUE` es el asado: el valor ya está persistido y la
 * semana lo muestra como "Asado" desde el Sprint 7. No se agrega un alias `BBQ`
 * porque serían dos nombres para el mismo hecho.
 */
export const TIPOS_EVENTO = [
  "BARBECUE",
  "BIRTHDAY",
  "RESTAURANT",
  "WEDDING",
  "TRAVEL",
  "HOLIDAY",
  "FAMILY_GATHERING",
  "PARTY",
  "FREE_MEAL",
  "ILLNESS",
  "OTHER",
] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

export const ETIQUETA_TIPO: Record<TipoEvento, string> = {
  BARBECUE: "Asado",
  BIRTHDAY: "Cumpleaños",
  RESTAURANT: "Restaurante",
  WEDDING: "Matrimonio",
  TRAVEL: "Viaje",
  HOLIDAY: "Feriado",
  FAMILY_GATHERING: "Junta familiar",
  PARTY: "Fiesta",
  FREE_MEAL: "Comida libre",
  ILLNESS: "Enfermedad",
  OTHER: "Otro",
};

export const ICONO_TIPO: Record<TipoEvento, string> = {
  BARBECUE: "outdoor_grill",
  BIRTHDAY: "cake",
  RESTAURANT: "restaurant",
  WEDDING: "celebration",
  TRAVEL: "flight",
  HOLIDAY: "beach_access",
  FAMILY_GATHERING: "diversity_3",
  PARTY: "celebration",
  FREE_MEAL: "lunch_dining",
  ILLNESS: "sick",
  OTHER: "event",
};

export const ASISTENCIAS = [
  "INVITED",
  "CONFIRMED",
  "MAYBE",
  "DECLINED",
  "ATTENDED",
  "NO_SHOW",
] as const;
export type Asistencia = (typeof ASISTENCIAS)[number];

export const ETIQUETA_ASISTENCIA: Record<Asistencia, string> = {
  INVITED: "Invitado",
  CONFIRMED: "Confirmó",
  MAYBE: "Tal vez",
  DECLINED: "No viene",
  ATTENDED: "Llegó",
  NO_SHOW: "No llegó",
};

/** Las dos marcas que solo se ponen el día del evento (§42). */
export const ASISTENCIAS_DEL_DIA: Asistencia[] = ["ATTENDED", "NO_SHOW"];

export const GRUPOS_EDAD = [
  "CHILD_SMALL",
  "CHILD",
  "TEEN",
  "ADULT",
  "OLDER_ADULT",
  "UNKNOWN",
] as const;
export type GrupoEdad = (typeof GRUPOS_EDAD)[number];

export const ETIQUETA_EDAD: Record<GrupoEdad, string> = {
  CHILD_SMALL: "Niño chico",
  CHILD: "Niño",
  TEEN: "Adolescente",
  ADULT: "Adulto",
  OLDER_ADULT: "Adulto mayor",
  UNKNOWN: "Sin información",
};

/**
 * El atajo binario del alta rápida (§98: agregar invitado tiene que ser muy
 * rápido) y su mapeo EXPLÍCITO contra el enum real.
 *
 * Está escrito acá y no en la cabeza de nadie porque la diferencia entre
 * CHILD_SMALL y TEEN casi dobla la porción: un botón que dice "niño" y no dice
 * cuál de los tres es, decide medio kilo por evento sin que nadie lo sepa. El
 * atajo elige CHILD —el centro del tramo— y el mismo panel ofrece afinarlo.
 */
export const EDAD_DEL_ATAJO: Record<"ADULTO" | "NINO", GrupoEdad> = {
  ADULTO: "ADULT",
  NINO: "CHILD",
};

/** Los tres que ofrece el chip de afinar cuando el atajo dijo "niño". */
export const EDADES_INFANTILES: GrupoEdad[] = ["CHILD_SMALL", "CHILD", "TEEN"];

export const APETITOS = ["LOW", "NORMAL", "HIGH", "VERY_HIGH", "UNKNOWN"] as const;
export type Apetito = (typeof APETITOS)[number];

export const ETIQUETA_APETITO: Record<Apetito, string> = {
  LOW: "Come poco",
  NORMAL: "Come normal",
  HIGH: "Come harto",
  VERY_HIGH: "Come muchísimo",
  UNKNOWN: "Sin información",
};

/**
 * Las banderas dietarias del §6: lo que el invitado REPORTÓ, nada más. No hay
 * diagnósticos acá y no los va a haber — un invitado no se convierte en un
 * perfil clínico.
 */
export const BANDERAS_DIETARIAS = [
  "ALLERGY_REPORTED",
  "VEGETARIAN",
  "VEGAN",
  "NO_PORK",
  "NO_BEEF",
  "NO_FISH",
  "OTHER_DIETARY_NOTE",
] as const;
export type BanderaDietaria = (typeof BANDERAS_DIETARIAS)[number];

export const ETIQUETA_BANDERA: Record<BanderaDietaria, string> = {
  ALLERGY_REPORTED: "Reportó alergia",
  VEGETARIAN: "Vegetariano",
  VEGAN: "Vegano",
  NO_PORK: "No come cerdo",
  NO_BEEF: "No come vacuno",
  NO_FISH: "No come pescado",
  OTHER_DIETARY_NOTE: "Otra restricción",
};

export const CONTEXTOS_COMIDA = [
  "FIRST_MAJOR_MEAL",
  "AFTER_LUNCH",
  "EVENING_WITH_SNACKS",
  "FULL_DAY_EVENT",
  "OTHER",
] as const;
export type ContextoComida = (typeof CONTEXTOS_COMIDA)[number];

export const ETIQUETA_CONTEXTO: Record<ContextoComida, string> = {
  FIRST_MAJOR_MEAL: "Es la comida principal del día",
  AFTER_LUNCH: "Después de un almuerzo completo",
  EVENING_WITH_SNACKS: "De tarde, con picoteo",
  FULL_DAY_EVENT: "Todo el día",
  OTHER: "Otro",
};

export const NIVELES_ACOMPANAMIENTO = ["NONE", "LIGHT", "MEDIUM", "ABUNDANT"] as const;
export type NivelAcompanamiento = (typeof NIVELES_ACOMPANAMIENTO)[number];

export const ETIQUETA_ACOMPANAMIENTO: Record<NivelAcompanamiento, string> = {
  NONE: "Sin acompañamientos",
  LIGHT: "Livianos",
  MEDIUM: "Normales",
  ABUNDANT: "Abundantes",
};

export const SOBRANTES_DESEADOS = ["NONE", "SMALL_BUFFER", "ONE_EXTRA_MEAL", "CUSTOM"] as const;
export type SobranteDeseado = (typeof SOBRANTES_DESEADOS)[number];

export const ETIQUETA_SOBRANTE: Record<SobranteDeseado, string> = {
  NONE: "No quiero que sobre",
  SMALL_BUFFER: "Que sobre un poco",
  ONE_EXTRA_MEAL: "Que alcance para una comida más",
  CUSTOM: "Una cantidad que yo digo",
};

export const CATEGORIAS_MENU = [
  "VACUNO",
  "POLLO",
  "CERDO",
  "EMBUTIDOS",
  "PESCADO",
  "VEGETARIANO",
  "OTRO",
] as const;
export type CategoriaMenu = (typeof CATEGORIAS_MENU)[number];

export const ETIQUETA_CATEGORIA: Record<CategoriaMenu, string> = {
  VACUNO: "Vacuno",
  POLLO: "Pollo",
  CERDO: "Cerdo",
  EMBUTIDOS: "Embutidos",
  PESCADO: "Pescado",
  VEGETARIANO: "Vegetariano",
  OTRO: "Otro",
};

export const TIPOS_ITEM_MENU = ["MEAT", "SIDE", "BEVERAGE", "NON_FOOD"] as const;
export type TipoItemMenu = (typeof TIPOS_ITEM_MENU)[number];

export const ETIQUETA_ITEM_MENU: Record<TipoItemMenu, string> = {
  MEAT: "Carne",
  SIDE: "Acompañamiento",
  BEVERAGE: "Bebida",
  NON_FOOD: "No comestible",
};

/** El texto único de "no lo sabemos". Se escribe una vez para que no aparezca
 *  media docena de sinónimos que la gente lee como cosas distintas. */
export const SIN_INFORMACION = "Sin información";
