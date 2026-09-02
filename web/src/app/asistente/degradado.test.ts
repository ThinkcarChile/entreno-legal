import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantShell } from "./AssistantShell";
import { degradacion } from "./turnos";
import type { CausaDeCaida, EstadoAsistente, RespuestaTurno, Turno } from "./turnos";

/**
 * LOS CINCO MODOS DE CAÍDA.
 *
 * "El proveedor apagado" es el fácil y es el único que se suele probar. Los que
 * duelen son los otros cuatro, porque no fallan: empeoran. Acá se prueban los
 * cinco contra el render de la pantalla, y en los cinco se exige lo mismo:
 *
 *  · queda contenido accionable en pantalla (los atajos que no pasan por IA),
 *  · el mensaje nombra la CAUSA real, no un error genérico de plataforma,
 *  · y ninguna caída se convierte en una afirmación sobre la casa.
 */

const nunca = async (): Promise<RespuestaTurno> => ({ ok: false, causa: "PROVEEDOR_CAIDO" });

function pintar(estado: EstadoAsistente, turnos: readonly Turno[] = []): string {
  return renderToStaticMarkup(
    createElement(AssistantShell, {
      estado,
      turnosIniciales: turnos,
      enviar: nunca,
    }),
  );
}

const ANTES: readonly { nombre: string; estado: EstadoAsistente; causa: CausaDeCaida }[] = [
  {
    nombre: "no hay proveedor configurado",
    estado: { k: "SIN_CONFIGURAR" },
    causa: "SIN_CONFIGURAR",
  },
  {
    nombre: "nadie activó el consentimiento",
    estado: { k: "SIN_CONSENTIMIENTO" },
    causa: "SIN_CONSENTIMIENTO",
  },
  {
    nombre: "se acabó la cuota",
    estado: { k: "CUOTA_AGOTADA" },
    causa: "CUOTA_AGOTADA",
  },
];

const DESPUES: readonly { nombre: string; causa: CausaDeCaida }[] = [
  { nombre: "el proveedor colgó hasta el plazo", causa: "TIEMPO_AGOTADO" },
  { nombre: "el proveedor devolvió basura", causa: "RESPUESTA_INVALIDA" },
  { nombre: "el proveedor se cayó", causa: "PROVEEDOR_CAIDO" },
];

describe("la pantalla del asistente aguanta las cinco caídas", () => {
  for (const caso of ANTES) {
    it(`${caso.nombre}: nombra la causa y deja algo que sirve`, () => {
      const html = pintar(caso.estado);
      const d = degradacion(caso.causa);
      expect(html).toContain(d.titulo);
      expect(html).toContain(d.atajo.href);
      // Contenido accionable que no pasa por la IA.
      expect(html).toContain("/inbox");
      expect(html).toContain("/plan");
      // Nada de errores genéricos de plataforma.
      expect(html).not.toContain("Application error");
      expect(html).not.toMatch(/algo salió mal/iu);
    });
  }

  for (const caso of DESPUES) {
    it(`${caso.nombre}: el turno queda dicho, con nombre y atajo`, () => {
      const html = pintar({ k: "LISTO" }, [
        { k: "PERSONA", id: "t1", texto: "¿cuánto pollo queda?" },
        { k: "NO_PUDE", id: "t2", causa: caso.causa },
      ]);
      const d = degradacion(caso.causa);
      expect(html).toContain(d.titulo);
      expect(html).toContain(d.atajo.texto);
      expect(html).toContain("¿cuánto pollo queda?");
    });
  }

  it("ninguna caída afirma nada sobre la casa", () => {
    const causas: CausaDeCaida[] = [
      "SIN_CONFIGURAR",
      "SIN_CONSENTIMIENTO",
      "CUOTA_AGOTADA",
      "PROVEEDOR_CAIDO",
      "TIEMPO_AGOTADO",
      "RESPUESTA_INVALIDA",
    ];
    for (const causa of causas) {
      const d = degradacion(causa);
      const texto = `${d.titulo} ${d.detalle}`.toLowerCase();
      expect(texto, causa).not.toMatch(/no tienes (nada|restricciones)/u);
      expect(texto, causa).not.toMatch(/todo (está )?en orden/u);
      expect(d.atajo.href.length, causa).toBeGreaterThan(0);
    }
  });
});

describe("el chat no es el botón", () => {
  it("la pantalla dice explícitamente que escribir 'sí, dale' no confirma", () => {
    const html = pintar({ k: "LISTO" });
    expect(html).toMatch(/no confirma nada/u);
    expect(html).toContain("tarjeta");
  });

  it("un turno del asistente con propuesta lleva a la tarjeta, no ejecuta", () => {
    const html = pintar({ k: "LISTO" }, [
      {
        k: "ASISTENTE",
        id: "t1",
        texto: "Puedo descontar el pollo del viernes.",
        unknowns: [],
        procedencia: ["stock/1.0.0"],
        proposalId: "66666666-6666-4666-8666-666666666666",
      },
    ]);
    expect(html).toContain("/asistente/propuesta/66666666-6666-4666-8666-666666666666");
    expect(html).toContain("Ver la propuesta y confirmar");
  });
});

describe("lo que no se sabe se pinta siempre, no solo en la tarjeta", () => {
  it("un turno de LECTURA con unknowns los muestra con su símbolo", () => {
    const html = pintar({ k: "LISTO" }, [
      {
        k: "ASISTENTE",
        id: "t1",
        texto: "Te queda arroz para varios días.",
        unknowns: [
          {
            campo: "cobertura",
            simbolo: "INSUFFICIENT_DATA",
            motivo: "tenemos pocos días de consumo registrados para proyectar",
          },
        ],
        procedencia: ["stock/1.0.0"],
        proposalId: null,
      },
    ]);
    expect(html).toContain("Lo que no sé");
    expect(html).toContain("INSUFFICIENT_DATA");
    expect(html).toContain("pocos días de consumo");
  });

  it("una respuesta sin procedencia se marca como tal, no se deja pasar", () => {
    const html = pintar({ k: "LISTO" }, [
      {
        k: "ASISTENTE",
        id: "t1",
        texto: "Te queda arroz.",
        unknowns: [],
        procedencia: [],
        proposalId: null,
      },
    ]);
    expect(html).toContain("Sin procedencia");
  });
});

describe("la conversación se anuncia sola", () => {
  it("la lista de turnos es una región viva para el lector de pantalla", () => {
    const html = pintar({ k: "LISTO" }, [{ k: "PERSONA", id: "t1", texto: "hola" }]);
    expect(html).toContain('aria-live="polite"');
  });
});
