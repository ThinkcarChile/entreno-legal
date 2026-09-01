import { describe, expect, it } from "vitest";
import {
  avance,
  derivarPasos,
  esencialesListos,
  noSabido,
  onboardingListo,
  proximoPaso,
  sabido,
  type ClavePaso,
  type HechosEsenciales,
  type HechosOnboarding,
  type PasoOnboarding,
} from "./pasos";

/**
 * Lo que se prueba acá es la promesa central del onboarding: que sepa dónde
 * quedó la persona MIRANDO LOS DATOS. Por eso cada caso arma hechos distintos y
 * revisa el estado resultante, nunca una bandera.
 *
 * La LECTURA (qué se le pregunta a la base y qué significa cada silencio) se
 * prueba aparte, contra un Postgres de verdad con RLS, en
 * `src/integration/onboarding-lectura.test.ts`. Antes no existía y por eso se
 * podía borrar el `NO_SE_SABE` de las invitaciones sin que un solo test se
 * pusiera rojo: estos doce casos alimentaban a mano los hechos ya interpretados.
 */

const SIN_NADA: HechosOnboarding = {
  hogarId: null,
  integrantes: [],
  seguimientoDeclarado: [],
  nombreHogar: null,
  invitaciones: noSabido("Todavía no hay hogar del cual leerlo."),
  comidasEstaSemana: noSabido("Todavía no hay hogar del cual leerlo."),
};

const HOGAR = "h1";
const yo = { id: "m1", nombre: "Francisco", esYo: true };
const paula = { id: "m2", nombre: "Paula", esYo: false };
const seba = { id: "m3", nombre: "Sebastián", esYo: false };

/** Hogar creado, con los adornos ya leídos y en cero (el caso más común). */
function conHogar(extra: Partial<HechosOnboarding> = {}): HechosOnboarding {
  return {
    ...SIN_NADA,
    hogarId: HOGAR,
    nombreHogar: "Los Vásquez",
    invitaciones: sabido({ vigentes: 0, aceptadas: 0 }),
    comidasEstaSemana: sabido(0),
    ...extra,
  };
}

function paso(pasos: PasoOnboarding[], clave: ClavePaso): PasoOnboarding {
  const encontrado = pasos.find((p) => p.clave === clave);
  if (!encontrado) throw new Error(`falta el paso ${clave}`);
  return encontrado;
}

describe("pasos del onboarding", () => {
  it("sin hogar solo se puede hacer el primer paso", () => {
    const pasos = derivarPasos(SIN_NADA);

    expect(pasos.map((p) => p.clave)).toEqual([
      "hogar",
      "integrantes",
      "perfiles",
      "invitaciones",
      "plan",
    ]);
    expect(paso(pasos, "hogar").estado).toBe("PENDIENTE");
    expect(paso(pasos, "hogar").disponible).toBe(true);
    expect(pasos.filter((p) => p.clave !== "hogar").every((p) => !p.disponible)).toBe(true);
    expect(onboardingListo(pasos)).toBe(false);
    expect(proximoPaso(pasos)?.clave).toBe("hogar");
  });

  it("con hogar creado el primer paso queda hecho sin que nadie lo marque", () => {
    const pasos = derivarPasos(conHogar({ integrantes: [yo] }));

    expect(paso(pasos, "hogar").estado).toBe("LISTO");
    expect(paso(pasos, "hogar").detalle).toContain("Los Vásquez");
    expect(paso(pasos, "integrantes").disponible).toBe(true);
  });

  it("si el nombre del hogar no volvió, la pantalla NO se inventa uno", () => {
    // Acá vivía un `?? "Mi hogar"`: la fila no volvía y el paso igual afirmaba
    // «Tu hogar se llama Mi hogar», un dato que nadie escribió nunca.
    const pasos = derivarPasos(conHogar({ integrantes: [yo], nombreHogar: null }));
    const hogar = paso(pasos, "hogar");

    expect(hogar.estado).toBe("LISTO"); // el hogar existe: eso sí lo sabemos
    // Ningún nombre entre comillas: eso es lo que la pantalla AFIRMA.
    expect(hogar.detalle).not.toMatch(/«.+»/);
    expect(hogar.detalle).toContain("no pudimos leer su ficha");
  });

  it("un hogar de una sola persona no finge tener la familia cargada NI la da por pendiente", () => {
    const pasos = derivarPasos(conHogar({ integrantes: [yo], seguimientoDeclarado: [yo.id] }));
    const integrantes = paso(pasos, "integrantes");

    // Con una sola ficha el dato no alcanza: puede ser alguien que vive solo o
    // una familia a medio cargar. Decir "pendiente" dejaba a quien vive solo con
    // la barra clavada y con "sigue: carga a tu gente" para siempre.
    expect(integrantes.estado).toBe("NO_SE_SABE");
    expect(integrantes.detalle).toContain("solo tú");
    expect(integrantes.esencial).toBe(false);
    expect(proximoPaso(pasos)?.clave).not.toBe("integrantes");
    expect(avance(pasos).sinRespuesta).toBeGreaterThan(0);
  });

  it("sin ninguna ficha activa el paso 2 sí queda pendiente, y lo dice", () => {
    const pasos = derivarPasos(conHogar({ integrantes: [] }));
    const integrantes = paso(pasos, "integrantes");

    expect(integrantes.estado).toBe("PENDIENTE");
    expect(integrantes.detalle).toContain("ni siquiera la tuya");
  });

  it("con dos o más fichas el paso 2 se da por hecho", () => {
    const pasos = derivarPasos(conHogar({ integrantes: [yo, paula] }));
    expect(paso(pasos, "integrantes").estado).toBe("LISTO");
  });

  it("el paso de perfiles apunta al integrante que falta, no a la lista", () => {
    const pasos = derivarPasos(
      conHogar({ integrantes: [yo, paula, seba], seguimientoDeclarado: [yo.id] }),
    );
    const perfiles = paso(pasos, "perfiles");

    expect(perfiles.estado).toBe("PENDIENTE");
    expect(perfiles.destino).toBe(`/family/${paula.id}`);
    expect(perfiles.accion).toBe("Configurar a Paula");
    expect(perfiles.detalle).toContain("Paula");
    expect(perfiles.detalle).toContain("Sebastián");
  });

  it("un seguimiento guardado en OFF cuenta como declarado: la ausencia de fila no", () => {
    // La distinción es la doctrina completa en una línea: "no llevo seguimiento"
    // es una respuesta; "nadie dijo nada" no lo es. Los hechos solo traen los
    // ids que TIENEN fila, sea cual sea su modo.
    const conRespuesta = derivarPasos(
      conHogar({ integrantes: [yo], seguimientoDeclarado: [yo.id] }),
    );
    const sinRespuesta = derivarPasos(conHogar({ integrantes: [yo] }));

    expect(paso(conRespuesta, "perfiles").estado).toBe("LISTO");
    expect(paso(sinRespuesta, "perfiles").estado).toBe("PENDIENTE");
  });

  it("agregar a alguien nuevo reabre el paso de perfiles (por eso no hay bandera)", () => {
    const antes = derivarPasos(
      conHogar({ integrantes: [yo, paula], seguimientoDeclarado: [yo.id, paula.id] }),
    );
    expect(onboardingListo(antes)).toBe(true);

    const despues = derivarPasos(
      conHogar({ integrantes: [yo, paula, seba], seguimientoDeclarado: [yo.id, paula.id] }),
    );
    expect(paso(despues, "perfiles").estado).toBe("PENDIENTE");
    expect(onboardingListo(despues)).toBe(false);
  });

  it("las invitaciones que no podemos ver se declaran con su motivo, no se cuentan como cero", () => {
    const motivo = "Las invitaciones las ve solo quien administra el hogar.";
    const pasos = derivarPasos(
      conHogar({ integrantes: [yo, paula], invitaciones: noSabido(motivo) }),
    );
    const invitaciones = paso(pasos, "invitaciones");

    expect(invitaciones.estado).toBe("NO_SE_SABE");
    // El motivo que trae el hecho es EL QUE SE MUESTRA: si la pantalla escribiera
    // su propia explicación, diría "solo el administrador" también cuando el
    // problema fue que la consulta falló.
    expect(invitaciones.detalle).toBe(motivo);
    // No se ofrece como "el siguiente": no sabemos si hace falta.
    expect(proximoPaso(pasos)?.clave).not.toBe("invitaciones");
  });

  it("una invitación aceptada cierra el paso; una vigente lo deja esperando", () => {
    const esperando = derivarPasos(
      conHogar({ integrantes: [yo], invitaciones: sabido({ vigentes: 2, aceptadas: 0 }) }),
    );
    expect(paso(esperando, "invitaciones").estado).toBe("PENDIENTE");
    expect(paso(esperando, "invitaciones").detalle).toContain("2 invitaciones");

    const aceptada = derivarPasos(
      conHogar({
        integrantes: [yo, paula],
        invitaciones: sabido({ vigentes: 0, aceptadas: 1 }),
      }),
    );
    expect(paso(aceptada, "invitaciones").estado).toBe("LISTO");
  });

  it("la semana que no se pudo leer se declara, no se cuenta como semana vacía", () => {
    const motivo = "No pudimos leer la semana en curso: la base respondió 42P01.";
    const pasos = derivarPasos(
      conHogar({
        integrantes: [yo, paula],
        seguimientoDeclarado: [yo.id, paula.id],
        comidasEstaSemana: noSabido(motivo),
      }),
    );
    const plan = paso(pasos, "plan");

    expect(plan.estado).toBe("NO_SE_SABE");
    expect(plan.detalle).toBe(motivo);
    // Y aun así lo esencial sigue estando listo: un adorno ilegible no puede
    // devolver a nadie a la pantalla de bienvenida.
    expect(onboardingListo(pasos)).toBe(true);
  });

  it("la semana vacía no impide dar la puesta en marcha por terminada", () => {
    // Si el plan contara como esencial, cada lunes la portada mandaría a la
    // persona de vuelta al onboarding con todo hecho.
    const pasos = derivarPasos(
      conHogar({
        integrantes: [yo, paula],
        seguimientoDeclarado: [yo.id, paula.id],
        comidasEstaSemana: sabido(0),
      }),
    );

    expect(paso(pasos, "plan").estado).toBe("PENDIENTE");
    expect(paso(pasos, "plan").esencial).toBe(false);
    expect(onboardingListo(pasos)).toBe(true);
  });

  it("con comidas planificadas el último paso se marca solo", () => {
    const pasos = derivarPasos(
      conHogar({
        integrantes: [yo, paula],
        seguimientoDeclarado: [yo.id, paula.id],
        invitaciones: sabido({ vigentes: 0, aceptadas: 1 }),
        comidasEstaSemana: sabido(9),
      }),
    );

    expect(paso(pasos, "plan").estado).toBe("LISTO");
    expect(paso(pasos, "plan").detalle).toContain("9 comidas planificadas");
    expect(avance(pasos)).toEqual({ listos: 5, total: 5, sinRespuesta: 0 });
    expect(proximoPaso(pasos)).toBeNull();
  });

  it("cada paso lleva a una pantalla que ya existe", () => {
    const pasos = derivarPasos(
      conHogar({ integrantes: [yo, paula], seguimientoDeclarado: [yo.id, paula.id] }),
    );

    expect(pasos.map((p) => p.destino)).toEqual([
      "/family",
      "/family",
      "/family",
      "/family#invitar",
      "/plan",
    ]);
  });

  it("los nombres largos no convierten el detalle en un párrafo", () => {
    const muchos = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      nombre: id.toUpperCase(),
      esYo: false,
    }));
    const pasos = derivarPasos(conHogar({ integrantes: muchos }));

    expect(paso(pasos, "perfiles").detalle).toContain("A, B y 3 más");
  });
});

/**
 * La portada decide con `esencialesListos` (tres consultas) y la pantalla de
 * pasos con `onboardingListo` (los cinco pasos armados). Son dos caminos a la
 * misma pregunta, y el día en que se separen la aplicación va a mandar a alguien
 * a `/family` mientras la lista le dice que le falta algo — o al revés, un bucle
 * entre `/` y `/onboarding`. Esta batería los amarra.
 */
describe("las dos vías para decidir si lo esencial está listo", () => {
  const esencialesPosibles: HechosEsenciales[] = [];
  for (const hogarId of [null, HOGAR]) {
    for (const integrantes of [[], [yo], [yo, paula], [yo, paula, seba]]) {
      for (const declarados of [[], [yo.id], [yo.id, paula.id], [yo.id, paula.id, seba.id]]) {
        esencialesPosibles.push({ hogarId, integrantes, seguimientoDeclarado: declarados });
      }
    }
  }

  const adornosPosibles: Pick<
    HechosOnboarding,
    "nombreHogar" | "invitaciones" | "comidasEstaSemana"
  >[] = [
    {
      nombreHogar: "Los Vásquez",
      invitaciones: sabido({ vigentes: 0, aceptadas: 0 }),
      comidasEstaSemana: sabido(0),
    },
    {
      nombreHogar: null,
      invitaciones: noSabido("no se pudo"),
      comidasEstaSemana: noSabido("no se pudo"),
    },
    {
      nombreHogar: "Los Vásquez",
      invitaciones: sabido({ vigentes: 3, aceptadas: 2 }),
      comidasEstaSemana: sabido(14),
    },
  ];

  it("dan siempre la misma respuesta", () => {
    for (const esenciales of esencialesPosibles) {
      for (const adornos of adornosPosibles) {
        const pasos = derivarPasos({ ...esenciales, ...adornos });
        expect(
          { caso: esenciales, listo: esencialesListos(esenciales) },
          `hogar=${esenciales.hogarId} fichas=${esenciales.integrantes.length} declarados=${esenciales.seguimientoDeclarado.length}`,
        ).toEqual({ caso: esenciales, listo: onboardingListo(pasos) });
      }
    }
  });

  it("ningún adorno cambia la decisión de la portada", () => {
    // La razón de existir de la separación: si un adorno pudiera mover la
    // decisión, la portada tendría que volver a pedirlos todos y volveríamos a
    // una puerta de entrada que se cae por la tabla de invitaciones.
    for (const esenciales of esencialesPosibles) {
      const respuestas = adornosPosibles.map((adornos) =>
        onboardingListo(derivarPasos({ ...esenciales, ...adornos })),
      );
      expect(new Set(respuestas).size).toBe(1);
    }
  });

  it("con hogar y todos los perfiles declarados, lo esencial está listo", () => {
    // Ancla del sentido: sin esto, las dos pruebas de arriba pasarían igual si
    // `esencialesListos` y `onboardingListo` devolvieran SIEMPRE false.
    expect(
      esencialesListos({
        hogarId: HOGAR,
        integrantes: [yo, paula],
        seguimientoDeclarado: [yo.id, paula.id],
      }),
    ).toBe(true);
    expect(
      esencialesListos({
        hogarId: HOGAR,
        integrantes: [yo, paula],
        seguimientoDeclarado: [yo.id],
      }),
    ).toBe(false);
    expect(
      esencialesListos({ hogarId: null, integrantes: [], seguimientoDeclarado: [] }),
    ).toBe(false);
  });
});
