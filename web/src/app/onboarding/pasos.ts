/**
 * Los pasos de la puesta en marcha, DERIVADOS de los datos del hogar.
 *
 * Este módulo es puro a propósito: recibe los hechos ya leídos y devuelve los
 * pasos. Es la costura donde se decide qué ve una persona que recién llega, y
 * se puede probar cada combinación —hogar recién creado, integrante sin perfil,
 * hogar de una sola persona— sin levantar la aplicación ni la base.
 *
 * Y sobre todo: acá NO hay ninguna bandera de "onboarding completado". Una
 * bandera se escribe una vez y después miente para siempre: la persona agrega a
 * la abuela y el onboarding sigue jurando que está todo listo. El estado sale de
 * los mismos datos con los que la aplicación trabaja todos los días, así que no
 * se puede desincronizar de la realidad — a lo más se atrasa lo que demora una
 * consulta.
 */

/**
 * `NO_SE_SABE` no es un tercer sabor de "pendiente": es que los datos que
 * tenemos a la vista no alcanzan para responder. Pasa de verdad — las
 * invitaciones solo las ve el administrador del hogar (RLS `invitations_admin`,
 * 0001), así que para un integrante común la lista vuelve vacía sin que eso
 * signifique que no hay ninguna. Pintarlo como "pendiente" sería inventar un
 * dato cómodo, que es exactamente lo que este proyecto no hace.
 */
export type EstadoPaso = "LISTO" | "PENDIENTE" | "NO_SE_SABE";

export type ClavePaso = "hogar" | "integrantes" | "perfiles" | "invitaciones" | "plan";

export interface IntegranteOnboarding {
  id: string;
  nombre: string;
  /** Su ficha EN ESTE hogar; en otra casa la misma persona es otro integrante. */
  esYo: boolean;
}

/**
 * Un dato que ADORNA la pantalla: o lo sabemos, o decimos por qué no.
 *
 * Nació de un problema concreto: la portada `/` se caía si fallaba cualquiera
 * de las diez consultas del onboarding, incluidas las que no deciden nada. Un
 * adorno que no se pudo leer no puede tumbar la puerta de entrada, pero tampoco
 * puede convertirse en un cero tranquilizador — así que viaja con su motivo y
 * la pantalla lo muestra tal cual, en el chip "no se sabe".
 */
export type Adorno<T> =
  | { readonly conocido: true; readonly valor: T }
  | { readonly conocido: false; readonly porque: string };

export const sabido = <T,>(valor: T): Adorno<T> => ({ conocido: true, valor });
export const noSabido = <T,>(porque: string): Adorno<T> => ({ conocido: false, porque });

/**
 * Lo MÍNIMO que hay que leer para saber dónde entra la persona.
 *
 * Está separado del resto porque la portada decide con esto y nada más: el
 * hogar y los perfiles son los únicos pasos esenciales, así que pedir roles,
 * invitaciones y la cadena del plan para elegir entre `/family` y `/onboarding`
 * era pagar —y arriesgar— siete consultas que la decisión descarta.
 */
export interface HechosEsenciales {
  /** Id del hogar propio (el determinista de `current-household`) o `null`. */
  hogarId: string | null;
  integrantes: readonly IntegranteOnboarding[];
  /**
   * Ids de los integrantes que YA declararon su modo de seguimiento.
   *
   * La distinción importa: no tener fila en `member_tracking_settings` no es
   * "seguimiento apagado", es que nadie dijo nada todavía. Un `mode = 'OFF'`
   * guardado sí es una respuesta —"no llevo seguimiento"— y por eso cuenta como
   * paso hecho.
   */
  seguimientoDeclarado: readonly string[];
}

/** Lo que la base sabe hoy del hogar. Nada interpretado todavía. */
export interface HechosOnboarding extends HechosEsenciales {
  /**
   * Cómo se llama el hogar, o `null` cuando su fila no volvió.
   *
   * Antes acá había un `?? "Mi hogar"` y la pantalla afirmaba ese nombre
   * inventado ("Tu hogar se llama «Mi hogar»") justo cuando MENOS sabíamos.
   * `null` significa "no lo pudimos leer" y el paso lo dice con esas palabras.
   */
  nombreHogar: string | null;
  invitaciones: Adorno<{ vigentes: number; aceptadas: number }>;
  /** Comidas ya planificadas en la semana en curso del hogar. */
  comidasEstaSemana: Adorno<number>;
}

export interface PasoOnboarding {
  clave: ClavePaso;
  numero: number;
  titulo: string;
  /** Para qué sirve el paso. Nadie llena un formulario que no entiende. */
  porQue: string;
  /** Lo que dicen los datos HOY. Cambia con el hogar; el `porQue` no. */
  detalle: string;
  estado: EstadoPaso;
  /** Siempre una pantalla que YA existe: el onboarding no duplica formularios. */
  destino: string;
  accion: string;
  icono: string;
  /** `false` mientras el paso todavía no se puede hacer (no hay hogar). */
  disponible: boolean;
  /**
   * Cuenta para decidir si la puesta en marcha terminó.
   *
   * Solo lo son "crear hogar" y "perfiles nutricionales": son de una vez y sin
   * ellos la aplicación no puede calcular nada. Planificar la semana NO es
   * esencial aunque sea el último paso —se rehace cada lunes, y si contara, todos
   * los lunes la persona volvería a caer en la pantalla de bienvenida— y cargar
   * o invitar gente tampoco, porque ningún dato prueba que una familia esté
   * completa: quien vive solo ya terminó con un integrante.
   */
  esencial: boolean;
}

const plural = (n: number, singular: string, plural: string): string =>
  `${n} ${n === 1 ? singular : plural}`;

/**
 * Nombres separados por coma, con "y N más" cuando son muchos. Un hogar de ocho
 * personas no puede convertir el detalle del paso en un párrafo.
 */
function listaCorta(nombres: readonly string[], tope = 2): string {
  if (nombres.length <= 1) return nombres[0] ?? "";
  if (nombres.length <= tope) {
    return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1] ?? ""}`;
  }
  const resto = nombres.length - tope;
  return `${nombres.slice(0, tope).join(", ")} y ${resto === 1 ? "uno más" : `${resto} más`}`;
}

/** Quiénes todavía no declararon su seguimiento. */
function sinPerfil(hechos: HechosEsenciales): readonly IntegranteOnboarding[] {
  const declarados = new Set(hechos.seguimientoDeclarado);
  return hechos.integrantes.filter((m) => !declarados.has(m.id));
}

// ---------------------------------------------------------------------------
// Los dos pasos esenciales, como funciones sueltas.
//
// Existen aparte para que la portada pueda contestar "¿ya está lo esencial?"
// sin armar los cinco pasos (y sin leer los adornos que no deciden nada), y
// `derivarPasos` usa EXACTAMENTE estas mismas funciones: un solo dueño por
// regla. Que las dos vías no se separen nunca lo vigila pasos.test.ts.
// ---------------------------------------------------------------------------

export function hogarListo(hechos: HechosEsenciales): boolean {
  return hechos.hogarId !== null;
}

export function perfilesListos(hechos: HechosEsenciales): boolean {
  return hogarListo(hechos) && hechos.integrantes.length > 0 && sinPerfil(hechos).length === 0;
}

/**
 * ¿Terminó la puesta en marcha? Solo los pasos esenciales mandan.
 *
 * Esto es lo que decide si la portada te deja en la bienvenida o te manda
 * directo al hogar, y por eso se contesta con los hechos esenciales: ni las
 * invitaciones ni la semana pueden opinar, así que tampoco se piden.
 */
export function esencialesListos(hechos: HechosEsenciales): boolean {
  return hogarListo(hechos) && perfilesListos(hechos);
}

/** Los cinco pasos en el orden en que alguien que parte de cero los necesita. */
export function derivarPasos(hechos: HechosOnboarding): PasoOnboarding[] {
  const hayHogar = hogarListo(hechos);
  const integrantes = hechos.integrantes;
  const faltantes = sinPerfil(hechos);
  const primeroSinPerfil = faltantes[0];
  const invitaciones = hechos.invitaciones;
  const comidas = hechos.comidasEstaSemana;

  return [
    {
      clave: "hogar",
      numero: 1,
      titulo: "Crea tu hogar",
      porQue:
        "Es la caja donde viven tu gente, tus recetas y tu semana. Sin hogar, el resto de la aplicación no tiene dónde guardar nada.",
      detalle: !hayHogar
        ? "Todavía no tienes hogar. Es lo primero: todo lo demás cuelga de acá."
        : hechos.nombreHogar !== null
          ? `Tu hogar se llama «${hechos.nombreHogar}».`
          : // Sabemos que existe (de ahí salió tu ficha), pero su fila no volvió.
            // Decirte un nombre acá sería inventarlo.
            "Tu hogar ya existe, pero no pudimos leer su ficha, así que no te podemos decir cómo se llama.",
      estado: hogarListo(hechos) ? "LISTO" : "PENDIENTE",
      destino: "/family",
      accion: hayHogar ? "Ver mi hogar" : "Crear hogar",
      icono: "add_home",
      disponible: true,
      esencial: true,
    },
    {
      clave: "integrantes",
      numero: 2,
      titulo: "Carga a tu gente",
      porQue:
        "Cada persona que se sienta a la mesa necesita su ficha: la porción se calcula por persona, no por familia.",
      detalle: !hayHogar
        ? "Se abre apenas tengas hogar."
        : integrantes.length === 0
          ? // Con hogar siempre deberías estar tú. Si no hay nadie, algo pasó
            // con las fichas (desactivadas, por ejemplo) y se dice tal cual en
            // vez de mostrar un cero tranquilizador.
            "No hay ninguna ficha activa en la lista, ni siquiera la tuya. Revisa el hogar."
          : integrantes.length === 1
            ? "En la lista estás solo tú. Si vives solo, esto ya está; si falta alguien, cárgalo cuando quieras."
            : `${plural(integrantes.length, "integrante cargado", "integrantes cargados")}.`,
      // Con una sola ficha el dato NO ALCANZA para responder: puede ser un hogar
      // de una persona (listo) o una familia a medio cargar (pendiente), y la
      // base no distingue las dos. Antes decía "pendiente" y dejaba a quien vive
      // solo con la barra clavada para siempre y con "sigue: carga a tu gente"
      // apuntando a algo que ya había hecho. Ahora se declara: no lo sabemos.
      estado: !hayHogar
        ? "PENDIENTE"
        : integrantes.length === 0
          ? "PENDIENTE"
          : integrantes.length === 1
            ? "NO_SE_SABE"
            : "LISTO",
      destino: "/family",
      accion: "Ver integrantes",
      icono: "group_add",
      disponible: hayHogar,
      esencial: false,
    },
    {
      clave: "perfiles",
      numero: 3,
      titulo: "Declara los perfiles nutricionales",
      porQue:
        "Sin perfil la aplicación no inventa una porción «normal»: te dice que no sabe. Declarar que no llevas seguimiento también es una respuesta válida.",
      detalle: !hayHogar
        ? "Se abre apenas tengas hogar."
        : integrantes.length === 0
          ? "Primero tiene que haber alguien en la lista."
          : faltantes.length === 0
            ? `Los ${integrantes.length} perfiles están declarados.`
            : `Falta declarar ${faltantes.length === 1 ? "el de" : "los de"} ${listaCorta(
                faltantes.map((m) => (m.esYo ? "ti" : m.nombre)),
              )}.`,
      estado: perfilesListos(hechos) ? "LISTO" : "PENDIENTE",
      // Al integrante que falta, no a la lista: el paso lleva a la pantalla donde
      // efectivamente se resuelve.
      destino: primeroSinPerfil ? `/family/${primeroSinPerfil.id}` : "/family",
      accion: primeroSinPerfil
        ? primeroSinPerfil.esYo
          ? "Configurar el tuyo"
          : `Configurar a ${primeroSinPerfil.nombre}`
        : "Revisar perfiles",
      icono: "nutrition",
      disponible: hayHogar && integrantes.length > 0,
      esencial: true,
    },
    {
      clave: "invitaciones",
      numero: 4,
      titulo: "Invita a la familia",
      porQue:
        "Un link de un solo uso para que cada uno entre con su cuenta y pueda cocinar, comprar o marcar lo que sirvió sin pedirte el teléfono.",
      detalle: !hayHogar
        ? "Se abre apenas tengas hogar."
        : !invitaciones.conocido
          ? invitaciones.porque
          : invitaciones.valor.aceptadas > 0
            ? `${plural(
                invitaciones.valor.aceptadas,
                "invitación aceptada",
                "invitaciones aceptadas",
              )}${
                invitaciones.valor.vigentes > 0
                  ? ` y ${invitaciones.valor.vigentes} esperando respuesta`
                  : ""
              }.`
            : invitaciones.valor.vigentes > 0
              ? `${plural(invitaciones.valor.vigentes, "invitación", "invitaciones")} esperando respuesta.`
              : "Todavía no generas ninguna invitación.",
      estado: !hayHogar
        ? "PENDIENTE"
        : !invitaciones.conocido
          ? "NO_SE_SABE"
          : invitaciones.valor.aceptadas > 0
            ? "LISTO"
            : "PENDIENTE",
      destino: "/family#invitar",
      accion:
        invitaciones.conocido && invitaciones.valor.vigentes > 0
          ? "Invitar a alguien más"
          : "Generar invitación",
      icono: "person_add",
      disponible: hayHogar,
      esencial: false,
    },
    {
      clave: "plan",
      numero: 5,
      titulo: "Planifica la semana",
      porQue:
        "Con la gente y los perfiles declarados, eliges la receta y la aplicación reparte la porción de cada uno.",
      detalle: !hayHogar
        ? "Se abre apenas tengas hogar."
        : !comidas.conocido
          ? comidas.porque
          : comidas.valor > 0
            ? `${plural(comidas.valor, "comida planificada", "comidas planificadas")} esta semana.`
            : "La semana en curso está vacía.",
      // A propósito mira SOLO la semana en curso: un plan de hace tres semanas no
      // le da de comer a nadie hoy.
      estado: !hayHogar
        ? "PENDIENTE"
        : !comidas.conocido
          ? "NO_SE_SABE"
          : comidas.valor > 0
            ? "LISTO"
            : "PENDIENTE",
      destino: "/plan",
      accion: comidas.conocido && comidas.valor > 0 ? "Ver la semana" : "Planificar la semana",
      icono: "calendar_month",
      disponible: hayHogar,
      esencial: false,
    },
  ];
}

/**
 * ¿Terminó la puesta en marcha, mirando los pasos ya armados?
 *
 * Es la misma pregunta que contesta `esencialesListos`, pero desde la pantalla,
 * que ya tiene los pasos en la mano. Un paso `NO_SE_SABE` jamás cuenta como
 * listo, pero tampoco bloquea: ninguno de los que no podemos ver es esencial.
 */
export function onboardingListo(pasos: readonly PasoOnboarding[]): boolean {
  return pasos.filter((p) => p.esencial).every((p) => p.estado === "LISTO");
}

/** El paso en el que conviene seguir: el primero que se puede hacer y falta. */
export function proximoPaso(pasos: readonly PasoOnboarding[]): PasoOnboarding | null {
  return pasos.find((p) => p.disponible && p.estado === "PENDIENTE") ?? null;
}

/**
 * Avance para mostrar. `sinRespuesta` se informa aparte: sumarlo a los listos
 * sería contar como hecho algo que no pudimos mirar.
 */
export function avance(pasos: readonly PasoOnboarding[]): {
  listos: number;
  total: number;
  sinRespuesta: number;
} {
  return {
    listos: pasos.filter((p) => p.estado === "LISTO").length,
    total: pasos.length,
    sinRespuesta: pasos.filter((p) => p.estado === "NO_SE_SABE").length,
  };
}
