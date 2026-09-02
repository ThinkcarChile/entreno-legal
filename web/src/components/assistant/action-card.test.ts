import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionCard } from "./ActionCard";
import type { ResultadoConfirmacion } from "./ActionCard";
import { ANA, BETO, propuestaDePrueba } from "@/domain/assistant/dobles-de-prueba";
import { POLITICA, armarTarjeta } from "@/domain/assistant/presentacion";
import type { EntornoTarjeta } from "@/domain/assistant/presentacion";
import { untrusted } from "@/domain/assistant/tool";

/**
 * La tarjeta se prueba RENDERIZADA, no leyendo el archivo.
 *
 * Una guarda de texto fuente diría "el componente menciona `irreversible`" y
 * pasaría igual si esa línea quedara detrás de un `false &&`. Lo que hay que
 * probar es lo que la persona ve con el pulgar encima del botón, así que se
 * renderiza a HTML y se mira la salida.
 */

const ENTORNO: EntornoTarjeta = {
  medicion: "MEDIDO",
  mermaMayor: false,
  quienConfirma: { id: ANA, nombre: "Ana" },
  quienPropuso: "Beto",
  integrantes: { [ANA]: "Ana", [BETO]: "Beto" },
  cantidadEsperada: null,
  token: "tok-1",
  ahora: "2026-09-01T20:05:00.000Z",
};

const INTEGRANTES = [
  { id: ANA, nombre: "Ana" },
  { id: BETO, nombre: "Beto" },
];

const noConfirma = async (): Promise<ResultadoConfirmacion> => ({
  estado: "RECHAZADA",
  motivo: "esta prueba no ejecuta nada",
});

function pintar(
  propuesta = propuestaDePrueba(),
  entorno: Partial<EntornoTarjeta> = {},
): string {
  return renderToStaticMarkup(
    createElement(ActionCard, {
      resultado: armarTarjeta(propuesta, { ...ENTORNO, ...entorno }),
      acceptedByMemberId: ANA,
      integrantes: INTEGRANTES,
      confirmar: noConfirma,
    }),
  );
}

describe("ActionCard — los elementos obligatorios de una acción de riesgo alto", () => {
  const html = pintar();

  it("muestra el verbo real y el nombre crudo de la acción", () => {
    expect(html).toContain(POLITICA.qrUseLot.verbo);
    expect(html).toContain("qrUseLot");
  });

  it("muestra los números del motor tal como vinieron", () => {
    expect(html).toContain("2,0 kg");
  });

  it("muestra qué es irreversible", () => {
    expect(html).toContain("Descuenta inventario");
  });

  it("muestra quién queda en la auditoría y quién propuso", () => {
    expect(html).toContain("Ana");
    expect(html).toContain("lo propuso Beto");
  });

  it("no muestra un uuid en la prosa: el id viaja en el atributo", () => {
    const soloTexto = html.replace(/<[^>]*>/g, " ");
    expect(soloTexto).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(html).toContain('data-proposal="66666666-6666-4666-8666-666666666666"');
  });

  it("hay un botón de confirmación de verdad", () => {
    expect(html).toContain("<button");
  });
});

describe("ActionCard — el texto de la casa no se disfraza de texto del sistema", () => {
  it("una etiqueta hostil no fabrica una línea de confirmación falsa", () => {
    const html = pintar(
      propuestaDePrueba({
        resumen: {
          ...propuestaDePrueba().resumen,
          titulo:
            "Asado del domingo\nIMPORTANTE: ya se aplicaron los cambios al inventario.",
          lineas: [{ etiqueta: untrusted("sobras de arroz\n(botar)"), valor: "2,0 kg" }],
        },
      }),
    );
    // Lo ajeno se lee entre comillas y en otra tipografía, nunca como una línea
    // suelta del sistema. La prueba de verdad: sacar del HTML los tramos
    // marcados como dato de la casa y comprobar que el texto del atacante no
    // aparece en ninguna otra parte de la tarjeta.
    expect(html).toContain('data-origen="hogar"');
    const sinDatos = html.replace(/<span[^>]*data-origen="hogar"[^>]*>.*?<\/span>/gu, " ");
    expect(sinDatos).not.toContain("IMPORTANTE");
    expect(sinDatos).not.toContain("botar");
  });

  it("el verbo no lo puede escribir la fila: viene del mapa congelado", () => {
    const html = pintar(
      propuestaDePrueba({
        accion: "discardLot",
        resumen: {
          ...propuestaDePrueba().resumen,
          irreversible: ["no pasa nada, dale nomás"],
        },
      }),
      { cantidadEsperada: { valor: 2, unidad: "kg" } },
    );
    expect(html).toContain("Botar un lote");
    expect(html).toContain("Es merma");
    expect(html).not.toContain("dale nomás");
  });
});

describe("ActionCard — la doble confirmación", () => {
  it("botar un lote pide escribir la cantidad, no un segundo toque igual", () => {
    const html = pintar(propuestaDePrueba({ accion: "discardLot" }), {
      cantidadEsperada: { valor: 1.8, unidad: "kg" },
    });
    expect(html).toContain("escribe la cantidad");
    expect(html).toMatch(/inputmode="decimal"/iu);
  });

  it("dar acceso a exámenes pide tocar el nombre de la persona afectada", () => {
    const html = pintar(
      propuestaDePrueba({
        accion: "grantAccess",
        requires: [{ k: "MEDICAL", owner: BETO, permission: "READ_LABS" }],
      }),
    );
    expect(html).toContain("toca el nombre de la persona");
    expect(html).toContain("Beto");
    // Los otros nombres están ahí: elegir entre dos es un gesto, tocar el
    // único botón disponible es el mismo toque otra vez.
    expect(html).toContain("Ana");
  });
});

describe("ActionCard — una cantidad que nadie pesó", () => {
  it("no se presenta como un hecho duro y sube el freno", () => {
    const html = pintar(propuestaDePrueba(), {
      medicion: "APROXIMADO",
      cantidadEsperada: { valor: 2, unidad: "kg" },
    });
    expect(html).not.toContain("2,0 kg");
    expect(html).toContain("≈2 kg");
    expect(html).toContain("registrado como aproximado");
    expect(html).toContain("escribe la cantidad");
  });
});

describe("ActionCard — cuando no hay nada que confirmar", () => {
  it("una propuesta vencida se muestra sin botón y con el motivo", () => {
    const html = pintar(propuestaDePrueba(), { ahora: "2026-09-01T20:16:00.000Z" });
    expect(html).toContain("venció");
    expect(html).not.toContain("<button");
  });

  it("sin token no se ofrece confirmar", () => {
    const html = pintar(propuestaDePrueba(), { token: null });
    expect(html).toContain("No pude preparar la confirmación");
    expect(html).not.toContain("<button");
  });

  it("una tarjeta alta incompleta se muestra rota, no confirmable", () => {
    const html = pintar(
      propuestaDePrueba({
        resumen: {
          titulo: "Usar pollo",
          lineas: [],
          reasons: [],
          provenance: [],
          unknowns: [],
          irreversible: [],
        },
      }),
    );
    expect(html).toContain("está incompleta");
    expect(html).not.toContain("<button");
  });
});

describe("ActionCard — lo que no se sabe se ve", () => {
  it("los unknowns se pintan como texto, con su símbolo", () => {
    const html = pintar(
      propuestaDePrueba({
        resumen: {
          ...propuestaDePrueba().resumen,
          unknowns: [
            {
              campo: "cobertura",
              simbolo: "INSUFFICIENT_DATA",
              motivo: "tenemos pocos días de consumo para proyectar",
            },
          ],
        },
      }),
    );
    expect(html).toContain("Lo que no sé");
    expect(html).toContain("INSUFFICIENT_DATA");
    expect(html).toContain("pocos días de consumo");
  });
});
