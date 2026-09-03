import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAVES_PROHIBIDAS,
  CLAVES_PROHIBIDAS_EXACTAS,
  esFormaSegura,
  registrarError,
  sanear,
} from "./observabilidad";

/**
 * §51 — el embudo del log NO deja pasar contenido.
 *
 * Un módulo de observabilidad se escribe en diez minutos y se cree "obviamente
 * correcto" hasta el día en que alguien lee el archivo de log de un servidor
 * compartido y encuentra ahí el colesterol de una persona. Este archivo es lo
 * que hace que el filtro sea una afirmación y no una intención: cada caso es
 * uno de los tres tipos de dato que el §50 dice que jamás pueden salir —valores
 * de laboratorio, contenido de documentos, credenciales— más el mensaje crudo
 * de PostgreSQL, que es por donde entrarían sin que nadie lo note.
 */

/** Captura lo que se escribió en stderr durante la llamada. */
function capturar(fn: () => void): string[] {
  const lineas: string[] = [];
  const espia = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      lineas.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    espia.mockRestore();
  }
  return lineas;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("§51 — registrarError escribe una línea de JSON a stderr", () => {
  it("una sola línea, con el evento y la hora", () => {
    const lineas = capturar(() =>
      registrarError("finanzas.boleta.archivo_huerfano", {
        bucket: "boletas",
        ruta: "household/8c1f0f2e-0000-4000-8000-000000000001/ab12.jpg",
        codigo: "23505",
      }),
    );
    expect(lineas).toHaveLength(1);
    expect(lineas[0]!.endsWith("\n")).toBe(true);
    const json = JSON.parse(lineas[0]!) as Record<string, unknown>;
    expect(json.nivel).toBe("error");
    expect(json.evento).toBe("finanzas.boleta.archivo_huerfano");
    expect(typeof json.ts).toBe("string");
    // Lo que SÍ tiene que salir: dónde pasó y con qué código.
    expect(json.bucket).toBe("boletas");
    expect(json.codigo).toBe("23505");
    expect(json.ruta).toBe("household/8c1f0f2e-0000-4000-8000-000000000001/ab12.jpg");
  });

  it("no lanza aunque el contexto venga vacío", () => {
    expect(() => capturar(() => registrarError("prueba.sin.contexto"))).not.toThrow();
  });
});

describe("§51 — la lista negra de claves", () => {
  it("ninguna clave prohibida deja salir su valor", () => {
    // Se prueban TODAS las de la lista, no una de muestra: una lista negra con
    // una entrada que no filtra es peor que no tenerla, porque se le cree.
    for (const clave of [...CLAVES_PROHIBIDAS, ...CLAVES_PROHIBIDAS_EXACTAS]) {
      const salida = sanear({ [clave]: "Colesterol total 312 mg/dL" });
      expect(salida[clave], `la clave "${clave}" dejó pasar su valor`).toBe(
        "[omitido: la clave está en la lista negra]",
      );
    }
  });

  it("la clave se conserva aunque el valor se omita (no se miente por omisión)", () => {
    const salida = sanear({ mensaje: "lo que sea" });
    expect(Object.keys(salida)).toEqual(["mensaje"]);
  });

  it("atrapa la clave por subcadena y sin importar mayúsculas", () => {
    // Los tres sitios corregidos por §50 usaban `errorRegistro` y `errorBorrado`.
    for (const clave of ["errorRegistro", "errorBorrado", "ERROR_MESSAGE", "signedUrl"]) {
      expect(sanear({ [clave]: "x y z" })[clave]).toBe(
        "[omitido: la clave está en la lista negra]",
      );
    }
  });

  it("las palabras cortas se comparan COMPLETAS y no se comen a un localizador", () => {
    // El defecto que este test dejó rojo la primera vez: `rut` por subcadena
    // borraba `ruta`, y el log del archivo huérfano dejaba de decir dónde quedó
    // el archivo — que es lo único que ese log existe para decir.
    for (const [clave, valor] of [
      ["ruta", "household/8c1f0f2e-0000-4000-8000-000000000001/ab.jpg"],
      ["labelJobId", "8c1f0f2e-0000-4000-8000-000000000002"],
      ["lineas", "12"],
      ["contexto", "REVIEW"],
    ] as const) {
      expect(sanear({ [clave]: valor })[clave], `"${clave}" se omitió y no debía`).toBe(valor);
    }
  });
});

describe("§51 — la forma del valor: ids y estados, nunca contenido", () => {
  it("deja pasar lo que parece un identificador o un estado", () => {
    for (const seguro of [
      "8c1f0f2e-0000-4000-8000-000000000001",
      "23505",
      "FINANCE_UPLOAD_RECEIPTS",
      "2026-09-03T12:00:00.000Z",
      "/finanzas/boletas",
      "member/8c1f0f2e-0000-4000-8000-000000000001/ab.pdf",
      "purchase_receipts",
    ]) {
      expect(esFormaSegura(seguro), `"${seguro}" tendría que pasar`).toBe(true);
    }
  });

  it("NO deja pasar una frase, aunque la clave sea inocente", () => {
    // El caso real: un `error.message` de PostgreSQL trae la fila adentro.
    const salida = sanear({
      estado: 'duplicate key value violates unique constraint "lab_observations_pkey" Key (value_numeric)=(312.5)',
    });
    expect(salida.estado).toMatch(/^\[texto omitido: \d+ caracteres\]$/);
    expect(JSON.stringify(salida)).not.toContain("312.5");
  });

  it("NO deja pasar nada con espacios, tildes ni comillas", () => {
    for (const inseguro of [
      "Colesterol total",
      "María Fernanda",
      'no existe la fila "x"',
      "e".repeat(121),
    ]) {
      expect(esFormaSegura(inseguro), `"${inseguro.slice(0, 20)}" no tendría que pasar`).toBe(false);
    }
  });

  it("el filtro llega hasta stderr, no se queda en `sanear`", () => {
    // Sin esto, `registrarError` podría estar serializando el contexto crudo y
    // los tests de arriba pasarían igual, probando una función que nadie usa.
    const lineas = capturar(() =>
      registrarError("salud.examen.archivo_huerfano", {
        memberId: "8c1f0f2e-0000-4000-8000-000000000009",
        errorRegistro: "Key (value_numeric)=(312.5)",
        estado: "el borrado no retiró ningún objeto",
      }),
    );
    expect(lineas[0]).not.toContain("312.5");
    expect(lineas[0]).not.toContain("retiró");
    expect(lineas[0]).toContain("8c1f0f2e-0000-4000-8000-000000000009");
  });
});
