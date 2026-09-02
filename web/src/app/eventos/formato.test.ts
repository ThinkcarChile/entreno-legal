import { describe, expect, it } from "vitest";
import { BBQ_REASON_CODES } from "@/domain/events/bbq/types";
import {
  ANCHO_AMPLIO,
  anchoRelativo,
  contadorDelDia,
  formatearCantidad,
  formatearGramos,
  formatearInventario,
  formatearRango,
  personas,
  resumenAsistencia,
  TEXTO_MOTIVO,
  textoRestricciones,
} from "./formato";
import { ETIQUETA_BANDERA, SIN_INFORMACION } from "./vocabulario";

describe("cómo se escriben las cantidades del evento", () => {
  it("bajo el kilo muestra gramos y sobre el kilo un decimal", () => {
    expect(formatearGramos(850)).toBe("850 g");
    expect(formatearGramos(9400)).toBe("9,4 kg");
  });

  it("una estimación se muestra COMO RANGO, nunca como número seco", () => {
    // El texto completo y exacto. `toContain("8")` no afirmaba nada: se
    // satisface con el 8 que ya trae el "11,8 kg" del máximo, así que borrar el
    // mínimo de la salida dejaba los diecinueve tests en verde.
    expect(formatearRango({ min: 8000, base: 9400, max: 11800 })).toBe("8,0–11,8 kg (≈9,4 kg)");
  });

  it("el mínimo está, y está ANTES del guión", () => {
    // Escrito por posición y no por presencia: es la afirmación que se cae si
    // alguien deja la salida en "–11,8 kg (≈9,4 kg)".
    const texto = formatearRango({ min: 8000, base: 9400, max: 11800 });
    const guion = texto.indexOf("–");
    expect(guion).toBeGreaterThan(0);
    expect(texto.slice(0, guion)).toBe("8,0");
    // Y el centro va marcado como aproximación, no como el número a comprar.
    expect(texto).toContain("≈");
  });

  it("un rango que cruza el kilo muestra cada extremo en SU escala", () => {
    // La rama mixta —mínimo bajo el kilo, máximo sobre el kilo— no tenía test.
    // Mostrar "0,9–11,8 kg" escondería que el piso son ochocientos cincuenta
    // gramos, que en una lista de compras es un cuarto de kilo de diferencia.
    expect(formatearRango({ min: 850, base: 9400, max: 11800 })).toBe("850–11,8 kg (≈9,4 kg)");
    // Y con las dos puntas bajo el kilo se queda todo en gramos.
    expect(formatearRango({ min: 200, base: 400, max: 900 })).toBe("200–900 g (≈400 g)");
  });

  it("un rango de ancho cero se muestra como un solo número", () => {
    // Siempre con un decimal en los kilos: "2 kg" y "2,3 kg" alineados en una
    // lista se leen mucho peor que "2,0 kg" y "2,3 kg".
    expect(formatearRango({ min: 2000, base: 2000, max: 2000 })).toBe("2,0 kg");
  });
});

describe("una cantidad DESCONOCIDA no se rellena", () => {
  it("dice que no se puede estimar y muestra el motivo, no un cero ni un guión", () => {
    const texto = formatearCantidad({ known: false, reason: "YIELD_UNKNOWN" });
    expect(texto).toContain("No se puede estimar");
    expect(texto).toContain("rendimiento");
    expect(texto).not.toMatch(/^0/);
    expect(texto).not.toBe("—");
  });

  it("TODO código del motor tiene su texto: uno nuevo sin traducir sería un hueco", () => {
    // Sin esto, un código agregado al motor saldría en pantalla como
    // "undefined" — el "error genérico" que este proyecto no acepta.
    for (const codigo of BBQ_REASON_CODES) {
      expect(TEXTO_MOTIVO[codigo], `falta el texto de ${codigo}`).toBeTruthy();
    }
  });
});

describe("lo que ya tienes en la despensa", () => {
  it("con base física conocida muestra los gramos", () => {
    expect(formatearInventario({ known: true, grams: 2300, frozenGrams: 0, lotIds: [] })).toBe(
      "2,3 kg",
    );
  });

  it("un lote que existe pero no se puede descontar muestra LAS DOS cosas", () => {
    const texto = formatearInventario({
      known: false,
      reason: "INVENTORY_YIELD_UNKNOWN",
      faceValueGrams: 3000,
      lotIds: ["lote-1"],
    });
    // Los kilos existen: no se pueden esconder. Y tampoco se pueden restar:
    // nadie sabe cuántos de esos tres kilos llegan al plato.
    expect(texto).toContain("3,0 kg");
    expect(texto).toContain("no se pueden descontar");
  });
});

describe("el ancho del rango es información", () => {
  it("un rango angosto y uno ancho no dan el mismo número", () => {
    const angosto = anchoRelativo({ min: 9500, base: 10000, max: 10500 });
    const amplio = anchoRelativo({ min: 6000, base: 10000, max: 14000 });
    expect(angosto).not.toBeNull();
    expect(amplio).not.toBeNull();
    expect(angosto as number).toBeLessThan(ANCHO_AMPLIO);
    expect(amplio as number).toBeGreaterThan(ANCHO_AMPLIO);
  });

  it("con centro cero devuelve null en vez de dividir por cero", () => {
    expect(anchoRelativo({ min: 0, base: 0, max: 0 })).toBeNull();
  });
});

describe("asistencia: cero marcas NO es cero personas, y media lista no es una lista", () => {
  it("sin ninguna marca dice que no se registró y cae a los confirmados como ESTIMACIÓN", () => {
    const r = resumenAsistencia({ llegaron: 0, noLlegaron: 0, sinMarcar: 12 });
    expect(r.estado).toBe("NO_REGISTRADA");
    expect(r.texto).toBe("Asistencia no registrada");
    expect(r.personas).toBe(12);
    expect(r.esEstimacion).toBe(true);
    // Lo que NO puede pasar: contar cero asistentes sobre doce confirmados.
    expect(r.personas).not.toBe(0);
  });

  it("una sola marca de NO_SHOW, con nadie pendiente, es un conteo cerrado", () => {
    const r = resumenAsistencia({ llegaron: 0, noLlegaron: 1, sinMarcar: 0 });
    expect(r.estado).toBe("COMPLETA");
    expect(r.personas).toBe(0);
    expect(r.esEstimacion).toBe(false);
  });

  it("[ALTO] tres marcados de doce NO convierte a los otros nueve en ausentes", () => {
    // El anfitrión marcó a los tres primeros que llegaron y volvió a la
    // parrilla. Con el guardia viejo —a nivel de EVENTO: "¿hay alguna marca?"—
    // esto salía como "3 personas llegaron", esEstimacion false, y los nueve
    // que nadie miró desaparecían contados como no-shows.
    const r = resumenAsistencia({ llegaron: 3, noLlegaron: 0, sinMarcar: 9 });
    expect(r.estado).toBe("PARCIAL");
    expect(r.sinMarcar).toBe(9);
    expect(r.esEstimacion).toBe(true);
    expect(r.texto).toContain("al menos");
  });

  it("con todos marcados el conteo sí es un hecho", () => {
    const r = resumenAsistencia({ llegaron: 9, noLlegaron: 3, sinMarcar: 0 });
    expect(r.estado).toBe("COMPLETA");
    expect(r.personas).toBe(9);
    expect(r.esEstimacion).toBe(false);
    expect(r.sinMarcar).toBe(0);
  });
});

describe("el contador del día no resta entre bases distintas", () => {
  it("crudo menos cocido NO se resta: muestra los dos rotulados", () => {
    const c = contadorDelDia({
      preparado: { gramos: 6000, base: "RAW" },
      servido: { gramos: 3800, base: "COOKED" },
    });
    expect(c.estado).toBe("BASES_DISTINTAS");
    // El 2200 que saldría de la resta no puede existir en ninguna parte.
    expect(JSON.stringify(c)).not.toContain("2200");
    if (c.estado === "BASES_DISTINTAS") {
      expect(c.basePreparado).toBe("RAW");
      expect(c.baseServido).toBe("COOKED");
      expect(c.aviso).toContain("rendimiento");
    }
  });

  it("con la misma base sí resta", () => {
    const c = contadorDelDia({
      preparado: { gramos: 6000, base: "COOKED" },
      servido: { gramos: 3800, base: "COOKED" },
    });
    expect(c.estado).toBe("COMPARABLE");
    if (c.estado === "COMPARABLE") {
      expect(c.quedaG).toBe(2200);
      expect(c.base).toBe("COOKED");
    }
  });

  it("servir más de lo preparado no produce un negativo", () => {
    const c = contadorDelDia({
      preparado: { gramos: 1000, base: "COOKED" },
      servido: { gramos: 1500, base: "COOKED" },
    });
    expect(c.estado).toBe("COMPARABLE");
    if (c.estado === "COMPARABLE") expect(c.quedaG).toBe(0);
  });
});

describe("restricciones: sin información NUNCA es sin restricciones", () => {
  it("null se muestra como sin información", () => {
    expect(textoRestricciones(null, ETIQUETA_BANDERA)).toBe(SIN_INFORMACION);
  });

  it("un arreglo vacío es una DECLARACIÓN y se muestra distinto de null", () => {
    const vacio = textoRestricciones([], ETIQUETA_BANDERA);
    expect(vacio).toBe("Dijo que no tiene restricciones");
    expect(vacio).not.toBe(textoRestricciones(null, ETIQUETA_BANDERA));
  });

  it("con banderas las muestra con su nombre en chileno", () => {
    expect(textoRestricciones(["NO_PORK", "VEGETARIAN"], ETIQUETA_BANDERA)).toBe(
      "No come cerdo · Vegetariano",
    );
  });
});

describe("plurales", () => {
  it("una persona en singular, once en plural", () => {
    expect(personas(1)).toBe("1 persona");
    expect(personas(11)).toBe("11 personas");
  });
});
